/* Browser rPPG estimator (ensemble).
 *
 * Pipeline:
 *   1. Buffer mean R,G,B per frame (12-sec rolling window).
 *   2. Resample to uniform fs (30 Hz) via linear interpolation.
 *   3. Motion-gate: detect frames with abrupt luma change, replace via
 *      linear interpolation through the dirty region.
 *   4. Compute THREE candidate pulse signals:
 *        - POS  (Wang 2017)
 *        - CHROM (de Haan 2013)
 *        - Green / luma-normalized
 *   5. Detrend (centered MA HP) + 3-tap LP + z-score per candidate.
 *   6. Welch PSD: 3 Hann-windowed 50%-overlapping segments, averaged.
 *   7. Peak pick with symmetric super/sub-harmonic preference.
 *   8. Pick the candidate with highest peak-power fraction.
 *   9. Parabolic interpolation for sub-bin frequency precision.
 *  10. Return chosen bpm + top-3 candidates for downstream Viterbi tracker.
 */
export class BrowserRPPG {
  constructor(targetFs = 30, windowSec = 12) {
    this.fs = targetFs;
    this.windowSec = windowSec;
    this.r = []; this.g = []; this.b = []; this.t = [];
  }

  addSample(R, G, B, tSeconds) {
    // Reject NaN/Inf only. Do NOT range-gate on R,G,B: after sRGB->linear
    // rescaling, mid-tone skin can fall well below sRGB-style thresholds.
    if (!Number.isFinite(R) || !Number.isFinite(G) || !Number.isFinite(B)) return;
    if (!Number.isFinite(tSeconds)) return;
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

    let r = this.#resample(this.r);
    let g = this.#resample(this.g);
    let b = this.#resample(this.b);
    if (!r || r.length < this.fs * 5) return null;

    // Motion gating via |dG/dt|. Mark abrupt jumps as dirty, dilate, then
    // linearly interpolate ALL channels through dirty regions.
    const N0 = g.length;
    const dy = new Array(N0).fill(0);
    for (let i = 1; i < N0; i++) dy[i] = Math.abs(g[i] - g[i - 1]);
    let baseSum = 0; for (const v of dy) baseSum += v;
    const baseline = baseSum / N0;
    const thresh = 4.0 * baseline + 0.5;
    const clean = new Array(N0).fill(true);
    for (let i = 0; i < N0; i++) if (dy[i] > thresh) clean[i] = false;
    // dilate dirty regions by +/-3 samples
    const cleanD = clean.slice();
    for (let i = 0; i < N0; i++) if (!clean[i]) {
      for (let k = -3; k <= 3; k++) {
        const j = i + k; if (j >= 0 && j < N0) cleanD[j] = false;
      }
    }
    const fix = (arr) => {
      const out = arr.slice();
      let i = 0;
      while (i < N0) {
        if (cleanD[i]) { i++; continue; }
        let j = i;
        while (j < N0 && !cleanD[j]) j++;
        const lo = i - 1, hi = j;
        const vlo = lo >= 0 ? out[lo] : (hi < N0 ? out[hi] : 0);
        const vhi = hi < N0 ? out[hi] : vlo;
        for (let k = i; k < j; k++) {
          const a = (k - lo) / Math.max(1, hi - lo);
          out[k] = vlo + (vhi - vlo) * a;
        }
        i = j + 1;
      }
      return out;
    };
    r = fix(r); g = fix(g); b = fix(b);

    // Three candidate pulse signals
    const warm = Math.round(this.fs * 1.0);
    const candPulses = [
      { name: "POS",   sig: this.#pos(r, g, b).slice(warm)  },
      { name: "CHROM", sig: this.#chrom(r, g, b).slice(warm) },
      { name: "GREEN", sig: this.#greenLuma(r, g, b).slice(warm) }
    ];

    const minHz = 0.75, maxHz = 3.3, STEPS = 320;
    const hzs = new Array(STEPS);
    for (let k = 0; k < STEPS; k++) hzs[k] = minHz + (maxHz - minHz) * (k / (STEPS - 1));

    let best = null;
    for (const c of candPulses) {
      const z = this.#postProcess(c.sig);
      if (!z || z.length < this.fs * 3) continue;
      const psd = this.#welchPsd(z, hzs);
      const pick = this.#pickPeak(psd, hzs, minHz, maxHz);
      if (!best || pick.score > best.score) {
        const top3 = this.#topPeaks(psd, hzs, 3);
        best = { ...pick, top3, z, channel: c.name };
      }
    }
    if (!best) return null;
    return {
      bpm: best.bpm,
      conf: best.conf,
      top3: best.top3,
      channel: best.channel,
      wave: best.z.slice(-Math.round(this.fs * 4))
    };
  }

  #postProcess(x) {
    if (!x || x.length < 30) return null;
    const hp = this.#detrend(x, Math.round(this.fs * 1.2));
    const lp = this.#movingAverage(hp, 3);
    return this.#zscore(lp);
  }

  #welchPsd(z, hzs) {
    const N = z.length;
    const segLen = Math.floor(N / 2);          // 3 segments at 50% overlap
    const step   = Math.max(1, Math.floor(segLen / 2));
    const STEPS  = hzs.length;
    const psd    = new Array(STEPS).fill(0);
    let segCount = 0;
    for (let start = 0; start + segLen <= N; start += step) {
      segCount++;
      const win = new Array(segLen);
      for (let i = 0; i < segLen; i++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (segLen - 1));
        win[i] = z[start + i] * w;
      }
      for (let k = 0; k < STEPS; k++) {
        let re = 0, im = 0;
        const w = 2 * Math.PI * hzs[k] / this.fs;
        for (let i = 0; i < segLen; i++) {
          re += win[i] * Math.cos(w * i);
          im -= win[i] * Math.sin(w * i);
        }
        psd[k] += (re * re + im * im) / segLen;
      }
    }
    if (segCount > 0) for (let k = 0; k < STEPS; k++) psd[k] /= segCount;
    return psd;
  }

  #pickPeak(psd, hzs, minHz, maxHz) {
    const STEPS = psd.length;
    let primary = 1;
    for (let k = 1; k < STEPS - 1; k++) {
      if (psd[k] > psd[k-1] && psd[k] > psd[k+1] && psd[k] > psd[primary]) primary = k;
    }
    // Median for prominence comparisons
    const sorted = psd.slice().sort((a,b) => a - b);
    const median = sorted[Math.floor(STEPS / 2)] || 1e-9;

    // Subharmonic switch DOWN: if peak at f/2 is dominant AND prominent.
    const halfHz = hzs[primary] / 2;
    if (halfHz >= 0.83) {
      let halfIdx = -1, halfBest = -Infinity;
      for (let k = 1; k < STEPS - 1; k++) {
        if (Math.abs(hzs[k] - halfHz) > 0.10) continue;
        if (psd[k] > psd[k-1] && psd[k] > psd[k+1] && psd[k] > halfBest) {
          halfBest = psd[k]; halfIdx = k;
        }
      }
      if (halfIdx >= 0 && halfBest >= 0.85 * psd[primary] && halfBest > 1.5 * median) {
        primary = halfIdx;
      }
    }
    // Superharmonic switch UP: if peak at 2f is much stronger, current was a sub.
    const dblHz = hzs[primary] * 2;
    if (dblHz <= maxHz) {
      let dblIdx = -1, dblBest = -Infinity;
      for (let k = 1; k < STEPS - 1; k++) {
        if (Math.abs(hzs[k] - dblHz) > 0.12) continue;
        if (psd[k] > psd[k-1] && psd[k] > psd[k+1] && psd[k] > dblBest) {
          dblBest = psd[k]; dblIdx = k;
        }
      }
      if (dblIdx >= 0 && dblBest >= 1.5 * psd[primary] && dblBest > 1.5 * median) {
        primary = dblIdx;
      }
    }

    // Parabolic interpolation
    const k0 = primary;
    const y0 = psd[Math.max(0, k0-1)], y1 = psd[k0], y2 = psd[Math.min(STEPS-1, k0+1)];
    const denom = (y0 - 2 * y1 + y2);
    const offset = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    const dHz = hzs[1] - hzs[0];
    const peakHz = hzs[k0] + offset * dHz;
    const bpm = peakHz * 60;

    let total = 0; for (const p of psd) total += p;
    const peakFrac = psd[k0] / (total + 1e-9);
    const conf  = Math.max(0, Math.min(1, peakFrac * 25));
    const score = peakFrac;
    return { bpm, conf, score };
  }

  #topPeaks(psd, hzs, n) {
    let total = 0; for (const p of psd) total += p;
    const STEPS = psd.length;
    const dHz = hzs[1] - hzs[0];
    const peaks = [];
    for (let k = 1; k < STEPS - 1; k++) {
      if (psd[k] > psd[k-1] && psd[k] > psd[k+1]) {
        const y0 = psd[k-1], y1 = psd[k], y2 = psd[k+1];
        const denom = (y0 - 2*y1 + y2);
        const offset = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
        peaks.push({ hz: hzs[k] + offset * dHz, pwr: y1 });
      }
    }
    peaks.sort((a,b) => b.pwr - a.pwr);
    return peaks.slice(0, n).map(p => ({
      bpm: p.hz * 60,
      conf: Math.max(0, Math.min(1, (p.pwr / (total + 1e-9)) * 25))
    }));
  }

  #resample(arr) {
    const t = this.t;
    const t0 = t[0], t1 = t[t.length - 1];
    const n = Math.floor((t1 - t0) * this.fs);
    if (n < 2) return null;
    const out = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const tt = t0 + i / this.fs;
      while (j < t.length - 2 && t[j+1] < tt) j++;
      const a = (tt - t[j]) / Math.max(1e-6, t[j+1] - t[j]);
      out[i] = arr[j] + (arr[j+1] - arr[j]) * a;
    }
    return out;
  }

  /* POS (Wang 2017) overlap-add. */
  #pos(r, g, b) {
    const N = r.length;
    const L = Math.round(this.fs * 1.6);
    const H = new Array(N).fill(0);
    if (N < L + 2) return H;
    for (let n = L; n < N; n++) {
      let mr = 0, mg = 0, mb = 0;
      for (let k = n - L; k < n; k++) { mr += r[k]; mg += g[k]; mb += b[k]; }
      mr /= L; mg /= L; mb /= L;
      if (mr < 1e-3 || mg < 1e-3 || mb < 1e-3) continue;
      const X1 = new Array(L), X2 = new Array(L);
      let s1 = 0, s2 = 0, s1s = 0, s2s = 0;
      for (let k = 0; k < L; k++) {
        const j = n - L + k;
        const Cr = r[j]/mr - 1, Cg = g[j]/mg - 1, Cb = b[j]/mb - 1;
        const x1 = Cg - Cb, x2 = -2*Cr + Cg + Cb;
        X1[k] = x1; X2[k] = x2;
        s1 += x1; s2 += x2; s1s += x1*x1; s2s += x2*x2;
      }
      const m1 = s1/L, m2 = s2/L;
      const std1 = Math.sqrt(Math.max(1e-12, s1s/L - m1*m1));
      const std2 = Math.sqrt(Math.max(1e-12, s2s/L - m2*m2));
      const alpha = std1 / std2;
      let hMean = 0;
      const h = new Array(L);
      for (let k = 0; k < L; k++) { h[k] = X1[k] + alpha*X2[k]; hMean += h[k]; }
      hMean /= L;
      for (let k = 0; k < L; k++) H[n - L + k] += h[k] - hMean;
    }
    return H;
  }

  /* CHROM (de Haan 2013) overlap-add.
   *   Xs = 3R - 2G
   *   Ys = 1.5R + G - 1.5B   (after temporal normalization C/mean(C))
   *   alpha = std(Xs)/std(Ys);  pulse = Xs - alpha*Ys
   */
  #chrom(r, g, b) {
    const N = r.length;
    const L = Math.round(this.fs * 1.6);
    const H = new Array(N).fill(0);
    if (N < L + 2) return H;
    for (let n = L; n < N; n++) {
      let mr = 0, mg = 0, mb = 0;
      for (let k = n - L; k < n; k++) { mr += r[k]; mg += g[k]; mb += b[k]; }
      mr /= L; mg /= L; mb /= L;
      if (mr < 1e-3 || mg < 1e-3 || mb < 1e-3) continue;
      const Xs = new Array(L), Ys = new Array(L);
      let sX = 0, sY = 0, sXX = 0, sYY = 0;
      for (let k = 0; k < L; k++) {
        const j = n - L + k;
        const Rn = r[j]/mr, Gn = g[j]/mg, Bn = b[j]/mb;
        const x = 3*Rn - 2*Gn;
        const y = 1.5*Rn + Gn - 1.5*Bn;
        Xs[k] = x; Ys[k] = y;
        sX += x; sY += y; sXX += x*x; sYY += y*y;
      }
      const mX = sX/L, mY = sY/L;
      const stdX = Math.sqrt(Math.max(1e-12, sXX/L - mX*mX));
      const stdY = Math.sqrt(Math.max(1e-12, sYY/L - mY*mY));
      const alpha = stdX / stdY;
      let hMean = 0;
      const h = new Array(L);
      for (let k = 0; k < L; k++) { h[k] = Xs[k] - alpha*Ys[k]; hMean += h[k]; }
      hMean /= L;
      for (let k = 0; k < L; k++) H[n - L + k] += h[k] - hMean;
    }
    return H;
  }

  /* Green channel divided by red+blue luma. Robust when POS/CHROM alpha
   * collapses on very still / flat-lit faces. */
  #greenLuma(r, g, b) {
    const N = g.length;
    const out = new Array(N);
    for (let i = 0; i < N; i++) out[i] = g[i] / (0.5 * (r[i] + b[i]) + 1e-6);
    return out;
  }

  #detrend(x, win) {
    // Centered MA via cumulative sum (O(N))
    const w = Math.max(3, win | 1);
    const half = (w - 1) >> 1;
    const n = x.length;
    const cs = new Array(n + 1); cs[0] = 0;
    for (let i = 0; i < n; i++) cs[i+1] = cs[i] + x[i];
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      const sum = cs[hi+1] - cs[lo];
      out[i] = x[i] - sum / (hi - lo + 1);
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
    const m = x.reduce((a,b) => a + b, 0) / x.length;
    const c = x.map(v => v - m);
    const s = Math.sqrt(c.reduce((a,b) => a + b*b, 0) / c.length) || 1;
    return c.map(v => v / s);
  }
}

/* 1D Viterbi tracker over the last K rPPG estimates.
 * Each estimate yields up to 3 candidate BPMs. We pick the path through time
 * that minimizes  sum_t [ (delta_bpm)^2 / 200  +  -log(conf+0.05) ].
 * Eliminates large single-window outliers without lagging exercise transitions. */
export class ViterbiTracker {
  constructor(maxHistory = 10) {
    this.maxHistory = maxHistory;
    this.history = [];
  }
  push(candidates) {
    if (!candidates || !candidates.length) return;
    this.history.push(candidates);
    while (this.history.length > this.maxHistory) this.history.shift();
  }
  best() {
    const H = this.history;
    if (!H.length) return null;
    const dp = H.map(layer => layer.map(() => Infinity));
    const parent = H.map(layer => layer.map(() => -1));
    for (let i = 0; i < H[0].length; i++) {
      dp[0][i] = -Math.log(Math.max(1e-3, H[0][i].conf + 0.05));
    }
    for (let t = 1; t < H.length; t++) {
      for (let i = 0; i < H[t].length; i++) {
        const e = -Math.log(Math.max(1e-3, H[t][i].conf + 0.05));
        let bestCost = Infinity, bestP = -1;
        for (let j = 0; j < H[t-1].length; j++) {
          const d = H[t][i].bpm - H[t-1][j].bpm;
          const trans = (d * d) / 200.0;
          const c = dp[t-1][j] + trans + e;
          if (c < bestCost) { bestCost = c; bestP = j; }
        }
        dp[t][i] = bestCost;
        parent[t][i] = bestP;
      }
    }
    const last = dp[H.length - 1];
    let argmin = 0;
    for (let i = 1; i < last.length; i++) if (last[i] < last[argmin]) argmin = i;
    return H[H.length - 1][argmin].bpm;
  }
  reset() { this.history = []; }
}