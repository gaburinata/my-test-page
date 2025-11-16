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
const startBtn = document.getElementById('start');

let w = 0, h = 0;
let gains = { r:1, g:1, b:1 };
let currentFacingMode = cameraSelect.value;
let countdownTimer = null;
let livePreview = false;
let initialized = false;

const CCM = [
  [1.02, -0.03,  0.01],
  [-0.02,  1.01, 0.01],
  [0.01, -0.01,  1.02]
];

// Auto-start camera on load
init();

async function init() {
  stopStream();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode },
      audio: false
    });
    video.srcObject = stream;
    await video.play().catch(()=>{});

    await new Promise(res => {
      if (video.readyState >= 1) return res();
      video.addEventListener('loadedmetadata', () => res(), { once: true });
    });

    w = video.videoWidth || 1280;
    h = video.videoHeight || 720;

    previewCanvas.width = w; previewCanvas.height = h;
    original.width = w; original.height = h;
    corrected.width = w; corrected.height = h;

    activeCamLabel.textContent = `Active: ${currentFacingMode === 'user' ? 'Front' : 'Rear'}`;
    statusBanner.textContent = 'Tap a white patch or press Auto Start';
    initialized = true;
    requestAnimationFrame(drawPreview);
  } catch (err) {
    statusBanner.textContent = 'Camera access error. Ensure HTTPS and allow permissions.';
  }
}

function stopStream() {
  if (video.srcObject) {
    video.srcObject.getTracks
