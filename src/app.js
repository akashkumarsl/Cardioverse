import * as THREE from "three";
import { createScene }   from "./modules/scene.js";
import { Heart }         from "./modules/heart.js";
import { BrowserRPPG, ViterbiTracker } from "./modules/rppg.js";
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

const rppg    = new BrowserRPPG(30, 12);
const tracker = new ViterbiTracker(10);
const face    = new FaceROI();

let displayBpm    = 0;
let lastEst       = null;
let lastProcess   = 0;
let lastEstimateAt = 0;
let lowConfStreak = 0;

function setStatus(m) { statusEl.textContent = m; }

/* sRGB â†’ linear-light, returns [0..1]. Pulse modulation is linear in the
 * absorption coefficient, NOT in gamma-encoded sRGB. */
function srgbToLinear(v) {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/* Dense linear-light per-pixel mean of an ROI rectangle.
 * sRGB->linear is essential because the pulse modulation is linear in
 * absorption, not in gamma-encoded sRGB. We DO NOT skin-gate here; on many
 * webcams (cool/LED lighting) skin pixels can have B>R, and an over-strict
 * gate empties the ROI. Trust MediaPipe's landmarks for the spatial gating. */
function meanRgbFromRect(r) {
  const d = hctx.getImageData(r.x, r.y, r.w, r.h).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    R += srgbToLinear(d[i]);
    G += srgbToLinear(d[i+1]);
    B += srgbToLinear(d[i+2]);
    n++;
  }
  if (n === 0) return [0, 0, 0, 0];
  // Scale linear means back to ~[0..255] so downstream gates remain valid.
  return [R / n * 255, G / n * 255, B / n * 255, n];
}
function meanRgbFromRects(rects) {
  let R = 0, G = 0, B = 0, W = 0;
  for (const r of rects) {
    const [r0, g0, b0, npx] = meanRgbFromRect(r);
    if (npx === 0) continue;
    R += r0 * npx; G += g0 * npx; B += b0 * npx; W += npx;
  }
  if (W === 0) return [NaN, NaN, NaN];
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
    // Manual exposure / WB / focus where supported (Chrome desktop on some
    // cameras). Browsers ignore unsupported constraints silently.
    const constraints = {
      video: {
        facingMode: "user",
        width:     { ideal: 640 },
        height:    { ideal: 480 },
        frameRate: { ideal: 30, max: 30 },
        advanced: [
          { exposureMode:     "manual" },
          { whiteBalanceMode: "manual" },
          { focusMode:        "manual" }
        ]
      },
      audio: false
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (_e) {
      // Some browsers reject the whole request if `advanced` is unsupported.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      });
    }
    video.srcObject = stream;
    await video.play();
    hidden.width  = video.videoWidth;
    hidden.height = video.videoHeight;

    setStatus("Loading FaceMesh...");
    const ok = await face.init();
    setStatus(ok ? "Calibrating 0.0s / 5.0s ..." : "Calibrating (fallback ROI) 0.0s / 5.0s ...");
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

  const [R, G, B] = meshRects ? meanRgbFromRects(rects) : meanRgbFromRects([rects[0]]);
  rppg.addSample(R, G, B, ts * 0.001);

  // Throttle PSD computation to ~2 Hz to give Welch more averaging budget.
  if (ts - lastEstimateAt < 500) return;
  lastEstimateAt = ts;

  const est = rppg.estimate();
  if (!est) {
    const have = rppg.bufferSeconds();
    if (have < 5.0) setStatus(`Calibrating ${have.toFixed(1)}s / 5.0s ...`);
    else            setStatus(`Processing... (buffer ${have.toFixed(1)}s, samples ${rppg.t.length})`);
    return;
  }
  lastEst = est;
  // Push top-3 candidates into Viterbi; tracker picks smooth path.
  const cands = (est.top3 && est.top3.length) ? est.top3
              : [{ bpm: est.bpm, conf: est.conf }];
  tracker.push(cands);
  const tracked = tracker.best() ?? est.bpm;
  displayBpm = tracked;

  bpmEl.textContent  = displayBpm.toFixed(1);
  confEl.textContent = Math.round(est.conf * 100) + "%";

  if (est.conf < 0.10) lowConfStreak++; else lowConfStreak = 0;
  if      (lowConfStreak >= 3)        setStatus("Signal lost \u2014 re-center face, improve light.");
  else if (est.conf < 0.20)           setStatus(`Low confidence (${est.channel}). Tracking \u2026`);
  else                                setStatus(`Live (\u200a${est.channel}\u200a)`);
}

const clock = new THREE.Clock();
function tick(ts) {
  processFrame(ts);
  const dt = clock.getDelta();
  const showBpm = displayBpm > 0 ? displayBpm : 70;
  const color = colorFor(showBpm);
  const s = stress(showBpm);
  zoneEl.textContent = zoneFor(showBpm).name;
  heart.update(dt, showBpm, color, s);
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