import * as THREE from "three";
import { createScene }   from "./modules/scene.js";
import { Heart }         from "./modules/heart.js";
import { BrowserRPPG }   from "./modules/rppg.js";
import { FaceROI }       from "./modules/face.js";
import { zoneFor, colorFor, stress } from "./modules/zones.js";
import { ECG }           from "./modules/ecg.js";

const $ = (id) => document.getElementById(id);
const video    = $("video");
const overlay  = $("overlay");
const startBtn = $("startBtn");
const statusEl = $("status");
const bpmEl    = $("bpm");
const confEl   = $("conf");
const zoneEl   = $("zone");
const ecg      = new ECG($("ecg"));

const ctx = createScene($("scene"));
const heart = new Heart(ctx.scene);

const hidden = document.createElement("canvas");
const hctx = hidden.getContext("2d", { willReadFrequently: true });
const ovctx = overlay.getContext("2d");

const rppg = new BrowserRPPG(30, 10);
const face = new FaceROI();

let smoothBpm = 0;     // 0 = uninitialized; first CONFIDENT estimate seeds it
let lastEst = null;
let lastProcess = 0;
let lastEstimateAt = 0;

function setStatus(m) { statusEl.textContent = m; }

function meanRgbFromRect(r) {
  const d = hctx.getImageData(r.x, r.y, r.w, r.h).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  return [R / n, G / n, B / n];
}
function meanRgbFromRects(rects) {
  let R = 0, G = 0, B = 0, W = 0;
  for (const r of rects) {
    const [r0, g0, b0] = meanRgbFromRect(r);
    const a = r.w * r.h;
    R += r0 * a; G += g0 * a; B += b0 * a; W += a;
  }
  return [R / W, G / W, B / W];
}
function drawOverlay(w, h, rects) {
  overlay.width = w; overlay.height = h;
  ovctx.clearRect(0, 0, w, h);
  ovctx.strokeStyle = "#8eea7d"; ovctx.lineWidth = 3;
  for (const r of rects) ovctx.strokeRect(r.x, r.y, r.w, r.h);
}

async function startCamera() {
  startBtn.disabled = true;
  setStatus("Requesting camera...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    hidden.width = video.videoWidth;
    hidden.height = video.videoHeight;

    setStatus("Loading FaceMesh...");
    const ok = await face.init();
    setStatus(ok ? "Live (FaceMesh active)" : "Live (fallback ROI)");
  } catch (e) {
    setStatus("Camera error: " + e.message);
    startBtn.disabled = false;
  }
}

function processFrame(ts) {
  if (video.readyState < 2) return;
  if (ts - lastProcess < 33) return;
  lastProcess = ts;

  const w = hidden.width, h = hidden.height;
  hctx.drawImage(video, 0, 0, w, h);

  const meshRects = face.rects(video, w, h, ts);
  const rects = meshRects ?? face.fallback(w, h);
  drawOverlay(w, h, rects);

  const [R, G, B] = meshRects ? meanRgbFromRects(rects) : meanRgbFromRect(rects[0]);
  rppg.addSample(R, G, B, ts * 0.001);

  // Throttle PSD computation to ~3 Hz; cheaper than per-frame.
  if (ts - lastEstimateAt < 333) return;
  lastEstimateAt = ts;

  const est = rppg.estimate();
  if (!est) {
    const have = rppg.bufferSeconds();
    setStatus(`Buffering ${have.toFixed(1)}s / 5.0s ...`);
    return;
  }
  lastEst = est;
  // Always seed on first estimate so the user sees a number immediately.
  if (smoothBpm === 0) {
    smoothBpm = est.bpm;
  } else {
    // Adaptive smoothing: trust high-confidence estimates more, reject huge jumps.
    const delta = Math.abs(est.bpm - smoothBpm);
    if (delta < 30 || est.conf > 0.5) {
      const a = Math.min(0.35, 0.08 + 0.30 * est.conf);
      smoothBpm = (1 - a) * smoothBpm + a * est.bpm;
    }
  }
  bpmEl.textContent  = smoothBpm.toFixed(1);
  confEl.textContent = Math.round(est.conf * 100) + "%";
  if      (est.conf < 0.10) setStatus("Very low signal. Improve light, hold still.");
  else if (est.conf < 0.25) setStatus("Low confidence. Tracking ...");
  else                      setStatus("Live (FaceMesh + POS)");
}

const clock = new THREE.Clock();
function tick(ts) {
  processFrame(ts);
  const dt = clock.getDelta();
  const displayBpm = smoothBpm > 0 ? smoothBpm : 70;
  const color = colorFor(displayBpm);
  const s = stress(displayBpm);
  zoneEl.textContent = zoneFor(displayBpm).name;
  heart.update(dt, displayBpm, color, s);
  if (lastEst) ecg.draw(lastEst.wave, "#8eea7d");
  ctx.controls.update();
  ctx.composer.render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

startBtn.addEventListener("click", startCamera);
if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
  setStatus("Browser does not support webcam capture.");
  startBtn.disabled = true;
}