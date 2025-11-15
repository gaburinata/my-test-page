// Elements
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const original = document.getElementById('original');
const corrected = document.getElementById('corrected');
const octx = original.getContext('2d');
const cctx = corrected.getContext('2d');

const captureBtn = document.getElementById('capture');
const downloadBtn = document.getElementById('download');
const lockIndicator = document.getElementById('lockIndicator');
const cameraSelect = document.getElementById('cameraSelect');
const activeCamLabel = document.getElementById('activeCam');

let w = 0, h = 0;
let locked = false;
let gains = { r:1, g:1, b:1 };
let currentFacingMode = cameraSelect.value; // 'user' or 'environment'

// Optional: starter CCM tuned gently toward skin neutrality.
// You can later replace this with a matrix fitted from your colorimeter pairs.
const CCM = [
  [1.02, -0.03,  0.01],
  [-0.02,  1.01, 0.01],
  [0.01, -0.01,  1.02]
];

init();

// Initialize camera with chosen facing mode
async function init() {
  // Stop previous stream if any
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: currentFacingMode,
        focusMode: 'continuous' // may be ignored by some browsers
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    w = video.videoWidth;
    h = video.videoHeight;

    // Size canvases to video
    canvas.width = w; canvas.height = h;
    original.width = w; original.height = h;
    corrected.width = w; corrected.height = h;

    // Update active camera label
    activeCamLabel.textContent = `Active: ${currentFacingMode === 'user' ? 'Front' : 'Rear'}`;

    // Reset lock state when switching cameras
    locked = false;
    lockIndicator.style.display = 'none';
    gains = { r:1, g:1, b:1 };

    requestAnimationFrame(draw);
  } catch (err) {
    console.error('Camera init error:', err);
    activeCamLabel.textContent = 'Camera access error';
  }
}

// Live draw from video to canvas
function draw() {
  ctx.drawImage(video, 0, 0, w, h);
  requestAnimationFrame(draw);
}

// sRGB <-> linear helpers
function toLin(c) {
  c = c / 255;
  return (c <= 0.04045) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
}
function toSRGB(l) {
  return (l <= 0.0031308) ? (l * 12.92) : (1.055 * Math.pow(l, 1 / 2.4) - 0.055);
}

// Tap anywhere on preview to sample the white/neutral reference and lock
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  // Map click to video pixel coordinates
  const x = Math.round((e.clientX - rect.left) * (w / rect.width));
  const y = Math.round((e.clientY - rect.top) * (h / rect.height));

  const size = Math.floor(Math.min(w, h) * 0.1); // 10% patch around tap
  const sx = Math.max(0, Math.min(w - size, x - size / 2));
  const sy = Math.max(0, Math.min(h - size, y - size / 2));

  const img = ctx.getImageData(sx, sy, size, size);
  const { rMean, gMean, bMean } = meanRGBLinear(img);

  // Per-channel white balance to neutralize the patch
  const t = (rMean + gMean + bMean) / 3;
  gains = { r: t / rMean, g: t / gMean, b: t / bMean };

  // Immediate lock with clear UI feedback
  locked = true;
  lockIndicator.style.display = 'block';
});

// Mean RGB in linear space over a patch
function meanRGBLinear(img) {
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += toLin(d[i]);
    g += toLin(d[i + 1]);
    b += toLin(d[i + 2]);
    n++;
  }
  return { rMean: r / n, gMean: g / n, bMean: b / n };
}

// Capture original and produce calibrated output
captureBtn.addEventListener('click', () => {
  // Draw the current frame into original canvas
  octx.drawImage(video, 0, 0, w, h);

  // Get image data
  const img = octx.getImageData(0, 0, w, h);
  const out = new ImageData(w, h);

  // Process pixel-by-pixel: white balance + optional CCM
  for (let i = 0; i < img.data.length; i += 4) {
    // to linear
    let rl = toLin(img.data[i]);
    let gl = toLin(img.data[i + 1]);
    let bl = toLin(img.data[i + 2]);

    // per-channel white balance gains (from tapped patch)
    rl *= gains.r;
    gl *= gains.g;
    bl *= gains.b;

    // 3x3 Color Correction Matrix (gentle refinement)
    const r2 = CCM[0][0] * rl + CCM[0][1] * gl + CCM[0][2] * bl;
    const g2 = CCM[1][0] * rl + CCM[1][1] * gl + CCM[1][2] * bl;
    const b2 = CCM[2][0] * rl + CCM[2][1] * gl + CCM[2][2] * bl;

    // back to sRGB + clamp
    const rs = Math.min(255, Math.max(0, Math.round(toSRGB(r2) * 255)));
    const gs = Math.min(255, Math.max(0, Math.round(toSRGB(g2) * 255)));
    const bs = Math.min(255, Math.max(0, Math.round(toSRGB(b2) * 255)));

    out.data[i] = rs;
    out.data[i + 1] = gs;
    out.data[i + 2] = bs;
    out.data[i + 3] = img.data[i + 3];
  }

  // Show corrected image
  cctx.putImageData(out, 0, 0);
  document.getElementById('result').style.display = 'grid';
});

// Download corrected image
downloadBtn.addEventListener('click', () => {
  corrected.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'calibrated.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png', 1.0);
});

// Camera selector change
cameraSelect.addEventListener('change', (e) => {
  currentFacingMode = e.target.value; // 'user' or 'environment'
  init(); // restart stream with new camera
});
