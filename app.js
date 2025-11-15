// Elements
const video = document.getElementById('video');
const previewCanvas = document.getElementById('previewCanvas');
const pctx = previewCanvas.getContext('2d', { willReadFrequently: true });

const original = document.getElementById('original');
const corrected = document.getElementById('corrected');
const octx = original.getContext('2d');
const cctx = corrected.getContext('2d');

const captureBtn = document.getElementById('capture');
const downloadBtn = document.getElementById('download');
const lockIndicator = document.getElementById('lockIndicator');
const cameraSelect = document.getElementById('cameraSelect');
const activeCamLabel = document.getElementById('activeCam');
const statusBanner = document.getElementById('statusBanner');
const sampleBox = document.getElementById('sampleBox');
const warnBox = document.getElementById('warnBox');
const focusWarn = document.getElementById('focusWarn');
const previewToggle = document.getElementById('previewToggle');

let w = 0, h = 0;
let gains = { r:1, g:1, b:1 };
let currentFacingMode = cameraSelect.value; // 'user' or 'environment'
let countdownTimer = null;
let livePreview = false;

// Gentle CCM (replace later with fitted matrix from your colorimeter pairs)
const CCM = [
  [1.02, -0.03,  0.01],
  [-0.02,  1.01, 0.01],
  [0.01, -0.01,  1.02]
];

init();

// Initialize camera with chosen facing mode
async function init() {
  stopStream();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    w = video.videoWidth;
    h = video.videoHeight;

    // Canvas sizes
    previewCanvas.width = w; previewCanvas.height = h;
    original.width = w; original.height = h;
    corrected.width = w; corrected.height = h;

    // Labels and prompts
    activeCamLabel.textContent = `Active: ${currentFacingMode === 'user' ? 'Front' : 'Rear'}`;
    statusBanner.textContent = 'Tap the white patch to calibrate';

    // Reset state
    gains = { r:1, g:1, b:1 };
    lockIndicator.style.display = 'none';
    sampleBox.style.display = 'none';
    warnBox.style.display = 'none';
    focusWarn.style.display = 'none';
    clearCountdown();

    requestAnimationFrame(drawPreview);
  } catch (err) {
    console.error('Camera init error:', err);
    activeCamLabel.textContent = 'Camera access error';
    statusBanner.textContent = 'Camera access error';
  }
}

function stopStream() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
}

// Live draw from video to preview canvas
function drawPreview() {
  if (!livePreview) {
    pctx.drawImage(video, 0, 0, w, h);
  } else {
    // live calibrated preview
    pctx.drawImage(video, 0, 0, w, h);
    const frame = pctx.getImageData(0, 0, w, h);
    const out = new ImageData(w, h);
    processPixels(frame.data, out.data);
    pctx.putImageData(out, 0, 0);
  }
  requestAnimationFrame(drawPreview);
}

// sRGB <-> linear helpers
function toLin(c) {
  c = c / 255;
  return (c <= 0.04045) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
}
function toSRGB(l) {
  return (l <= 0.0031308) ? (l * 12.92) : (1.055 * Math.pow(l, 1 / 2.4) - 0.055);
}

// Tone shaping to maintain skin clarity
// 1) Gentle highlight compression (Reinhard)
// 2) Mild contrast curve (S-curve in linear)
function compressHighlights(rl, gl, bl) {
  const L = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  const Lc = L / (1 + L);
  const scale = (L > 0) ? (Lc / L) : 1.0;
  return [rl * scale, gl * scale, bl * scale];
}
function contrastCurve(l) {
  // midtone pivot ~0.18 (linear), gentle S-curve
  const a = 0.20; // contrast amount (tune 0.15–0.25)
  const pivot = 0.18;
  return (l - pivot) * (1 + a) + pivot;
}

// Patch brightness validation: accept only within safe luminance range
function validatePatchBrightness(rMean, gMean, bMean) {
  const L = 0.2126 * rMean + 0.7152 * gMean + 0.0722 * bMean; // linear luminance
  // Accept range ~0.55–0.85 (white paper that isn't glowing; gray cards also ok)
  if (L < 0.55) return { ok:false, msg:'Patch too dim. Move to brighter light or use a cleaner white/gray.' };
  if (L > 0.85) return { ok:false, msg:'Patch overexposed. Step away from direct light or reduce brightness.' };
  return { ok:true, msg:'' };
}

// Basic focus check: variance of Laplacian on a small center crop
function isBlurry() {
  const cw = Math.round(w * 0.25);
  const ch = Math.round(h * 0.25);
  const cx = Math.round((w - cw) / 2);
  const cy = Math.round((h - ch) / 2);
  const img = pctx.getImageData(cx, cy, cw, ch);
  // grayscale
  const gray = new Float32Array(cw * ch);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
    gray[j] = 0.2126 * img.data[i] + 0.7152 * img.data[i+1] + 0.0722 * img.data[i+2];
  }
  // Laplacian variance (simple 3x3)
  let sum = 0, sumSq = 0, n = 0;
  const idx = (x,y) => y * cw + x;
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const lap =
        -1*gray[idx(x-1,y-1)] + -1*gray[idx(x,y-1)] + -1*gray[idx(x+1,y-1)] +
        -1*gray[idx(x-1,y)]   +  8*gray[idx(x,y)]   + -1*gray[idx(x+1,y)]   +
        -1*gray[idx(x-1,y+1)] + -1*gray[idx(x,y+1)] + -1*gray[idx(x+1,y+1)];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  const varL = (sumSq / n) - mean * mean;
  return varL < 2500; // tweak threshold if needed
}

// Process pixels: white balance + CCM + tone shaping
function processPixels(src, dst) {
  for (let i = 0; i < src.length; i += 4) {
    let rl = toLin(src[i])     * gains.r;
    let gl = toLin(src[i + 1]) * gains.g;
    let bl = toLin(src[i + 2]) * gains.b;

    // CCM
    let r2 = CCM[0][0] * rl + CCM[0][1] * gl + CCM[0][2] * bl;
    let g2 = CCM[1][0] * rl + CCM[1][1] * gl + CCM[1][2] * bl;
    let b2 = CCM[2][0] * rl + CCM[2][1] * gl + CCM[2][2] * bl;

    // highlight compression
    [r2, g2, b2] = compressHighlights(r2, g2, b2);

    // gentle contrast
    r2 = contrastCurve(r2);
    g2 = contrastCurve(g2);
    b2 = contrastCurve(b2);

    // back to sRGB + clamp
    dst[i]   = Math.min(255, Math.max(0, Math.round(toSRGB(r2) * 255)));
    dst[i+1] = Math.min(255, Math.max(0, Math.round(toSRGB(g2) * 255)));
    dst[i+2] = Math.min(255, Math.max(0, Math.round(toSRGB(b2) * 255)));
    dst[i+3] = src[i+3];
  }
}

// Tap anywhere to sample the white/neutral patch and auto-capture
previewCanvas.addEventListener('click', (e) => {
  const rect = previewCanvas.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) * (w / rect.width));
  const y = Math.round((e.clientY - rect.top) * (h / rect.height));

  // Visual ROI box near tap
  const size = Math.floor(Math.min(w, h) * 0.14); // larger patch for stability
  const sx = Math.max(0, Math.min(w - size, x - size / 2));
  const sy = Math.max(0, Math.min(h - size, y - size / 2));

  // Show sample box aligned to the tap
  sampleBox.style.display = 'block';
  sampleBox.style.left = `${(sx / w) * 100}%`;
  sampleBox.style.top = `${(sy / h) * 100}%`;
  sampleBox.style.width = `${(size / w) * 100}%`;
  sampleBox.style.height = `${(size / h) * 100}%`;

  // Sample and compute gains
  const img = pctx.getImageData(sx, sy, size, size);
  const { rMean, gMean, bMean } = meanRGBLinear(img);

  // Patch brightness validation
  const val = validatePatchBrightness(rMean, gMean, bMean);
  if (!val.ok) {
    warnBox.style.display = 'block';
    warnBox.textContent = val.msg;
    lockIndicator.style.display = 'none';
    statusBanner.textContent = 'Adjust patch brightness, then tap again';
    return;
  } else {
    warnBox.style.display = 'none';
  }

  const t = (rMean + gMean + bMean) / 3;
  gains = { r: t / rMean, g: t / gMean, b: t / bMean };

  // Feedback + countdown auto-capture
  lockIndicator.style.display = 'block';
  statusBanner.textContent = 'Locked: capturing in 3…';
  startCountdown(3);
});

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

function startCountdown(seconds) {
  clearCountdown();
  let remaining = seconds;
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      statusBanner.textContent = `Locked: capturing in ${remaining}…`;
    } else {
      clearCountdown();
      autoCapture();
    }
  }, 1000);
}
function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function autoCapture() {
  statusBanner.textContent = 'Capturing…';
  captureFrame();
}

// Manual capture (bottom shutter)
captureBtn.addEventListener('click', captureFrame);

// Capture, crop to head + lower neck, correct, and show results
function captureFrame() {
  // Focus check (warn only; still capture)
  const blurry = isBlurry();
  focusWarn.style.display = blurry ? 'block' : 'none';
  focusWarn.textContent = blurry ? 'Image looks out of focus. Hold steady or adjust distance.' : '';

  // Draw frame to original temp canvas
  octx.drawImage(video, 0, 0, w, h);

  // Crop rectangle: tight head + hair + full neck (down to clavicle)
  // Centered crop vertically, slightly biased downward for lower neck inclusion.
  const crop = {
    x: Math.round(w * 0.10),
    y: Math.round(h * 0.12),
    width: Math.round(w * 0.80),
    height: Math.round(h * 0.64)
  };

  // Clamp crop bounds
  crop.x = Math.max(0, crop.x);
  crop.y = Math.max(0, crop.y);
  crop.width = Math.min(w - crop.x, crop.width);
  crop.height = Math.min(h - crop.y, crop.height);

  const imgCropped = octx.getImageData(crop.x, crop.y, crop.width, crop.height);

  // Prepare visible canvases to crop size
  original.width = crop.width; original.height = crop.height;
  corrected.width = crop.width; corrected.height = crop.height;

  // Draw original (cropped)
  octx.putImageData(imgCropped, 0, 0);

  // Process calibrated output on cropped data
  const out = new ImageData(crop.width, crop.height);
  processPixels(imgCropped.data, out.data);
  cctx.putImageData(out, 0, 0);

  // Show results strip
  document.getElementById('result').style.display = 'grid';
  statusBanner.textContent = 'Captured';
  sampleBox.style.display = 'none';
  lockIndicator.style.display = 'none';
}

// Download calibrated image
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
  init(); // restart with selected camera
});

// Live preview toggle
previewToggle.addEventListener('change', (e) => {
  livePreview = e.target.checked;
  statusBanner.textContent = livePreview ? 'Live preview ON (calibrated)' : 'Tap the white patch to calibrate';
});
