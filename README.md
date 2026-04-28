# rPPG Digital Twin (Browser, Vercel-ready)

Single-page app:
- Webcam capture in browser (`getUserMedia`)
- MediaPipe FaceLandmarker ROI (forehead + both cheeks)
- POS-like rPPG signal pipeline + autocorrelation BPM with SNR confidence
- Interactive Three.js scene with OrbitControls + bloom postprocessing
- Procedural anatomical heart with two-phase systole / diastole envelope
- Zone-based color mapping and ECG-style waveform display

## Local run

Use the included `serve.py` (forces correct JS module MIME types on Windows):

```powershell
python serve.py 5600
```

Open http://localhost:5600

## Deploy to Vercel

1. Push this folder to GitHub.
2. Vercel: New Project -> Import the repo.
3. Root Directory: this folder.
4. Framework: Other.
5. Build Command: empty.
6. Output Directory: empty.
7. Deploy.

Camera requires HTTPS in production (Vercel provides it automatically).

## Tips for best accuracy

- Bright, even, frontal light (avoid backlight).
- Keep face still and centered.
- Exposed forehead and cheeks (no hair/glasses obstructions).
- 5-10 seconds to stabilize after Start Camera.