export class ECG {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }
  draw(wave, color = "#8eea7d") {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!wave || wave.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath();
    const n = wave.length;
    let mn = Infinity, mx = -Infinity;
    for (const v of wave) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const span = (mx - mn) || 1;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - ((wave[i] - mn) / span) * (h * 0.85) - h * 0.075;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}