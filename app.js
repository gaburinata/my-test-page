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

let w = 0, h = 0;
let gains = { r:1, g:1, b:1 };
let currentFacingMode = cameraSelect.value; // 'user' or 'environment'
let countdownTimer = null;

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
      video: {
        facingMode: currentFacingMode,
        focusMode: 'continuous' // may be ignored
      },
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
    statusBanner.textContent = 'Tap the white patch to lock';

    // Reset state
    gains = { r:1, g:1, b:1 };
    lockIndicator.style.display = 'none';
    sampleBox.style.display = 'none';
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
  pctx.drawImage(video, 0, 0, w, h);
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

// Tap anywhere to sample the white/neutral patch and auto-capture
previewCanvas.addEventListener('click', (e) => {
  const rect = previewCanvas.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) * (w / rect.width));
  const y = Math.round((e.clientY - rect.top) * (h / rect.height));

  // Visual ROI box near tap
  const size = Math.floor(Math.min(w, h) * 0.12); // 12% patch
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
  // Draw frame to original temp canvas
  octx.drawImage(video, 0, 0, w, h);

  // Compute crop rectangle using guide percentages:
  // Centered crop that includes hair and the lower neck/clavicle.
  // Derived from faceBox position in CSS (top:22%, left:16%, width:68%, height:50%).
  // We'll extend downward to include clavicle: add 18% height below faceBox.
  const crop = {
    x: Math.round(w * 0.10),                 // a bit tighter than left:16%
    y: Math.round(h * 0.14),                 // above face top to include hair
    width: Math.round(w * 0.80),             // tighter crop around the face area
    height: Math.round(h * (0.50 + 0.22))    // face height + extra 22% for lower neck/clavicle
  };

  // Clamp crop bounds
  crop.x = Math.max(0, crop.x);
  crop.y = Math.max(0, crop.y);
  crop.width = Math.min(w - crop.x, crop.width);
  crop.height = Math.min(h - crop.y, crop.height);

  const imgFull = octx.getImageData(0, 0, w, h);
  const imgCropped = octx.getImageData(crop.x, crop.y, crop.width, crop.height);

  // Prepare visible canvases to crop size
  original.width = crop.width; original.height = crop.height;
  corrected.width = crop.width; corrected.height = crop.height;

  // Draw original (cropped)
  octx.putImageData(imgCropped, 0, 0);

  // Process calibrated output on cropped data
  const out = new ImageData(crop.width, crop.height);
  const d = imgCropped.data;
  for (let i = 0; i < d.length; i += 4) {
    let rl = toLin(d[i])     * gains.r;
    let gl = toLin(d[i + 1]) * gains.g;
    let bl = toLin(d[i + 2]) * gains.b;

    const r2 = CCM[0][0] * rl + CCM[0][1] * gl + CCM[0][2] * bl;
    const g2 = CCM[1][0] * rl + CCM[1][1] * gl + CCM[1][2] * bl;
    const b2 = CCM[2][0] * rl + CCM[2][1] * gl + CCM[2][2] * bl;

    const rs = Math.min(255, Math.max(0, Math.round(toSRGB(r2) * 255)));
    const gs = Math.min(255, Math.max(0, Math.round(toSRGB(g2) * 255)));
    const bs = Math.min(255, Math.max(0, Math.round(toSRGB(b2) * 255)));

    out.data[i] = rs;
    out.data[i + 1] = gs;
    out.data[i + 2] = bs;
    out.data[i + 3] = d[i + 3];
  }
  cctx.putImageData(out, 0, 0);

  // Show results strip
  document.getElementById('result').style.display = 'grid';
  statusBanner.textContent = 'Captured';
  // Hide sample box after capture
  sampleBox.style.display = 'none';
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
