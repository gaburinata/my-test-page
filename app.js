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
let currentFacingMode = cameraSelect.value;
let countdownTimer = null;
let livePreview = false;

const CCM = [
  [1.02, -0.03,  0.01],
  [-0.02,  1.01, 0.01],
  [0.01, -0.01,  1.02]
];

init();

async function init() {
  stopStream();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: false
  });
  video.srcObject = stream;
  await video.play();

  w = video.videoWidth;
  h = video.videoHeight;

  previewCanvas.width = w; previewCanvas.height = h;
  original.width = w; original.height = h;
  corrected.width = w; corrected.height = h;

  activeCamLabel.textContent = `Active: ${currentFacingMode === 'user' ? 'Front' : 'Rear'}`;
  statusBanner.textContent = 'Tap the white patch to calibrate';
  lockIndicator.style.display = 'none';
  sampleBox.style.display = 'none';
  warnBox.style.display = 'none';
  focusWarn.style.display = 'none';
  clearCountdown();

  requestAnimationFrame(drawPreview);
}

function stopStream() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
}

function drawPreview() {
  if (!livePreview) {
    pctx.drawImage(video, 0, 0, w, h);
  } else {
    pctx.draw
