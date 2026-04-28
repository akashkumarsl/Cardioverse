/* MediaPipe FaceLandmarker wrapper.
 * Returns three rectangles per frame: forehead, left cheek, right cheek.
 * Falls back to a fixed forehead band if MediaPipe fails to load.
 */
const FOREHEAD = [10, 67, 109, 338, 297, 151];
const LCHEEK   = [50, 101, 118, 117, 123, 147];
const RCHEEK   = [280, 330, 347, 346, 352, 376];

export class FaceROI {
  constructor() {
    this.landmarker = null;
    this.ready = false;
  }

  async init() {
    try {
      const vision = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm"
      );
      const fileset = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
        },
        runningMode: "VIDEO",
        numFaces: 1
      });
      this.ready = true;
      return true;
    } catch (_e) {
      this.ready = false;
      return false;
    }
  }

  rects(video, w, h, ts) {
    if (!this.ready || !this.landmarker) return null;
    const out = this.landmarker.detectForVideo(video, ts);
    const lm = out.faceLandmarks && out.faceLandmarks[0];
    if (!lm) return null;
    const r = [
      this.#rectFrom(lm, FOREHEAD, w, h),
      this.#rectFrom(lm, LCHEEK,  w, h),
      this.#rectFrom(lm, RCHEEK,  w, h)
    ].filter(Boolean);
    return r.length ? r : null;
  }

  fallback(w, h) {
    const rw = (w * 0.24) | 0, rh = (h * 0.18) | 0;
    return [{ x: ((w - rw) / 2) | 0, y: (h * 0.18) | 0, w: rw, h: rh }];
  }

  #rectFrom(lm, ids, w, h, pad = 0.08) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const i of ids) {
      const p = lm[i]; if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxX <= minX || maxY <= minY) return null;
    const x0 = Math.max(0, Math.floor((minX - pad * (maxX - minX)) * w));
    const y0 = Math.max(0, Math.floor((minY - pad * (maxY - minY)) * h));
    const x1 = Math.min(w - 1, Math.ceil((maxX + pad * (maxX - minX)) * w));
    const y1 = Math.min(h - 1, Math.ceil((maxY + pad * (maxY - minY)) * h));
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 8 || rh < 8) return null;
    return { x: x0, y: y0, w: rw, h: rh };
  }
}