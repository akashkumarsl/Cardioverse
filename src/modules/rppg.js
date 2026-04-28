/* Browser rPPG estimator.
 *
 * Pipeline:
 *   1. Buffer mean R,G,B per frame with timestamps (10-sec rolling window).
 *   2. Resample to uniform fs (30 Hz) via linear interpolation.
 *   3. POS algorithm (Wang et al. 2017) with proper overlap-add to get pulse.
 *   4. Bandpass-style filter: subtract slow trend (~0.67 Hz HP), light LP.
 *   5. Z-score, Hann-window, compute PSD via direct DFT in [0.7..3.0] Hz.
 *   6. Pick spectral peak with subharmonic preference (prefer fundamental).
 *   7. Parabolic interpolation in PSD for sub-bin BPM precision.
 *   8. Confidence = peak energy fraction in physiological band.
 *
 * Why PSD instead of autocorrelation: autocorrelation always has self-peaks at
 * the smallest lag for noisy weak signals, biasing toward 180 BPM. PSD with a
 * proper bandpass+window gives a clean single peak when the pulse is present.
 */
export class BrowserRPPG {
  constructor(targetFs = 30, windowSec = 10) {
    this.fs = targetFs;
    this.windowSec = windowSec;
    this.r = []; this.g = []; this.b = []; this.t = [];
  }

  addSample(R, G, B, tSeconds) {
    // Reject only fully-black or fully-saturated frames.
    if (G < 5 || G > 252) return;
    this.r.push(R); this.g.push(G); this.b.push(B); this.t.push(tSeconds);
    const cutoff = tSeconds - this.windowSec;
    while (this.t.length && this.t[0] < cutoff) {
      this.t.shift(); this.r.shift(); this.g.shift(); this.b.shift();
    }
  }

  bufferSeconds() {
    if (this.t.length < 2) return 0;
    return this.t[this.t.length - 1] - this.t[0];
  }

  estimate() {
    if (this.t.length < this.fs * 5) return null;
    const dur = this.t[this.t.length - 1] - this.t[0];
    if (dur < 5) return null;

    const r = this.#resample(this.r);
    const g = this.#resample(this.g);
    const b = this.#resample(this.b);
    if (!r || r.length < this.fs * 5) return null;

    // POS pulse signal
    const pulse = this.#pos(r, g, b);

    // Trim POS warm-up (first L samples are zeros from overlap-add ramp-in).
    const warm = Math.round(this.fs * 1.6);
    const trimmed = pulse.slice(warm);
    if (trimmed.length < this.fs * 4) return null;

    // Bandpass: HP at ~0.67 Hz (subtract 1.5s trend), LP via 3-tap MA.
    const hp = this.#detrend(trimmed, Math.round(this.fs * 1.5));
    const lp = this.#movingAverage(hp, 3);
    const z  = this.#zscore(lp);

    // Hann window for clean spectrum.
    const N = z.length;
    const win = new Array(N);
    for (let i = 0; i < N; i++) {
      win[i] = z[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    }

    // PSD via direct DFT at densely-sampled frequency points in [0.65..3.3] Hz
    // (i.e. 39..198 BPM, covers resting through post-exercise). 280 bins.
    const minHz = 0.65, maxHz = 3.3;
    const STEPS = 280;
    const hzs = new Array(STEPS);
    const psd = new Array(STEPS);
    for (let k = 0; k < STEPS; k++) {
      const hz = minHz + (maxHz - minHz) * (k / (STEPS - 1));
      hzs[k] = hz;
      let re = 0, im = 0;
      const w = 2 * Math.PI * hz / this.fs;
      for (let i = 0; i < N; i++) {
        re += win[i] * Math.cos(w * i);
        im -= win[i] * Math.sin(w * i);
      }
      psd[k] = (re * re + im * im) / N;
    }

    // Find primary peak
    let primary = 1;
    for (let k = 1; k < STEPS - 1; k++) {
      if (psd[k] > psd[k - 1] && psd[k] > psd[k + 1] && psd[k] > psd[primary]) {
        primary = k;
      }
    }

    // Subharmonic preference: if a peak exists near primary/2 with at least
    // 50% the power of the primary, prefer it (avoids picking 2nd harmonic).
    const halfHz = hzs[primary] / 2;
    if (halfHz >= minHz) {
      let halfIdx = -1;
      let halfBest = -Infinity;
      for (let k = 1; k < STEPS - 1; k++) {
        if (Math.abs(hzs[k] - halfHz) > 0.08) continue;
        if (psd[k] > psd[k - 1] && psd[k] > psd[k + 1] && psd[k] > halfBest) {
          halfBest = psd[k]; halfIdx = k;
        }
      }
      if (halfIdx >= 0 && halfBest >= 0.5 * psd[primary]) {
        primary = halfIdx;
      }
    }

    // Parabolic interpolation around chosen peak for sub-bin frequency.
    const k0 = primary;
    const y0 = psd[k0 - 1], y1 = psd[k0], y2 = psd[k0 + 1];
    const denom = (y0 - 2 * y1 + y2);
    const offset = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    const dHz = hzs[1] - hzs[0];
    const peakHz = hzs[k0] + offset * dHz;
    const bpm = peakHz * 60;

    // Confidence: ratio of peak power to total band power, plus prominence.
    let total = 0;
    for (const p of psd) total += p;
    const peakFrac = psd[k0] / (total + 1e-9);
    // Map [0..0.05] -> [0..1] approximately
    const conf = Math.max(0, Math.min(1, peakFrac * 30));

    return { bpm, conf, wave: z.slice(-Math.round(this.fs * 4)) };
  }

  #resample(arr) {
    const t = this.t;
    const t0 = t[0];
    const t1 = t[t.length - 1];
    const n = Math.floor((t1 - t0) * this.fs);
    if (n < 2) return null;
    const out = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const tt = t0 + i / this.fs;
      while (j < t.length - 2 && t[j + 1] < tt) j++;
      const a = (tt - t[j]) / Math.max(1e-6, t[j + 1] - t[j]);
      out[i] = arr[j] + (arr[j + 1] - arr[j]) * a;
    }
    return out;
  }

  /* POS (Plane-Orthogonal-to-Skin) with overlap-add.
   * For each sliding window of length L = 1.6s:
   *   - temporally normalize C = C / mean(C) - 1
   *   - X1 = G - B,   X2 = -2R + G + B
   *   - alpha = std(X1) / std(X2)
   *   - h = X1 + alpha * X2,   h <- h - mean(h)
   *   - add h into the output buffer (overlap-add)
   */
  #pos(r, g, b) {
    const N = r.length;
    const L = Math.round(this.fs * 1.6);
    const H = new Array(N).fill(0);
    if (N < L + 2) return H;

    const X1 = new Array(L);
    const X2 = new Array(L);

    for (let n = L; n < N; n++) {
      let mr = 0, mg = 0, mb = 0;
      for (let k = n - L; k < n; k++) { mr += r[k]; mg += g[k]; mb += b[k]; }
      mr /= L; mg /= L; mb /= L;
      if (mr < 1e-3 || mg < 1e-3 || mb < 1e-3) continue;

      let s1 = 0, s2 = 0, s1s = 0, s2s = 0;
      for (let k = 0; k < L; k++) {
        const j = n - L + k;
        const Cr = r[j] / mr - 1;
        const Cg = g[j] / mg - 1;
        const Cb = b[j] / mb - 1;
        const x1 = Cg - Cb;
        const x2 = -2 * Cr + Cg + Cb;
        X1[k] = x1; X2[k] = x2;
        s1 += x1; s2 += x2; s1s += x1 * x1; s2s += x2 * x2;
      }
      const m1 = s1 / L, m2 = s2 / L;
      const std1 = Math.sqrt(Math.max(1e-12, s1s / L - m1 * m1));
      const std2 = Math.sqrt(Math.max(1e-12, s2s / L - m2 * m2));
      const alpha = std1 / std2;

      let hMean = 0;
      const h = new Array(L);
      for (let k = 0; k < L; k++) { h[k] = X1[k] + alpha * X2[k]; hMean += h[k]; }
      hMean /= L;
      for (let k = 0; k < L; k++) H[n - L + k] += h[k] - hMean;
    }
    return H;
  }

  #detrend(x, win) {
    // Centered moving-average high-pass (less edge bias than trailing MA).
    const w = Math.max(3, win | 1);
    const half = (w - 1) >> 1;
    const n = x.length;
    const out = new Array(n);
    let acc = 0;
    for (let i = 0; i < Math.min(w, n); i++) acc += x[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      let s = 0;
      for (let k = lo; k <= hi; k++) s += x[k];
      out[i] = x[i] - s / (hi - lo + 1);
    }
    return out;
  }

  #movingAverage(x, win) {
    if (win <= 1) return x.slice();
    const out = new Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i++) {
      acc += x[i];
      if (i >= win) acc -= x[i - win];
      out[i] = acc / Math.min(i + 1, win);
    }
    return out;
  }

  #zscore(x) {
    const m = x.reduce((a, b) => a + b, 0) / x.length;
    const c = x.map(v => v - m);
    const s = Math.sqrt(c.reduce((a, b) => a + b * b, 0) / c.length) || 1;
    return c.map(v => v / s);
  }
}