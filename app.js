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
const startBtn = document.getElementById('start');

let w = 0, h = 0;
let gains = { r:1, g:1, b:1 };
let currentFacingMode = cameraSelect.value; // 'user' or 'environment'
let countdownTimer = null;
let livePreview = false;
let initialized = false;

// Gentle CCM (replace with fitted matrix from your colorimeter pairs)
const CCM = [
  [1.02, -0.03,  0.01],
  [-0.02,  1.01, 0.01],
  [0.01, -0.01,  1.02]
];

init();

// Initialize camera correctly and wait for metadata to avoid black screen
async function init() {
  stopStream();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode },
      audio: false
    });
    video.srcObject = stream;

    // Ensure iOS autoplay works: muted + play after user gesture fallback
    await video.play().catch(() => { /* some browsers need a gesture; we keep UI visible */ });

    // Wait for actual dimensions
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
    statusBanner.textContent = 'Press Start or tap a white patch to calibrate';
    lockIndicator.style.display = 'none';
    sampleBox.style.display = 'none';
    warnBox.style.display = 'none';
    focusWarn.style.display = 'none';
    clearCountdown();

    initialized = true;
    requestAnimationFrame(drawPreview);

    // Best-effort focus/zoom constraints
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    const settings = {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) settings.focusMode = 'continuous';
    if (caps.zoom) settings.zoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, (caps.zoom.min + caps.zoom.max) / 2));
    if (caps.focusDistance) settings.focusDistance = Math.min(caps.focusDistance.max, Math.max(caps.focusDistance.min, (caps.focusDistance.min + caps.focusDistance.max) / 2));
    if (Object.keys(settings).length) {
      track.applyConstraints({ advanced: [settings] }).catch(()=>{});
    }
  } catch (err) {
    statusBanner.textContent = 'Camera access error. Check permissions and HTTPS.';
  }
}

function stopStream() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
}

// Live preview
function drawPreview() {
  if (!initialized) return requestAnimationFrame(drawPreview);
  if (!livePreview) {
    pctx.drawImage(video, 0, 0, w, h);
  } else {
    pctx.drawImage(video, 0, 0, w, h);
    const frame = pctx.getImageData(0, 0, w, h);
    const out = new ImageData(w, h);
    processPixels(frame.data, out.data);
    pctx.putImageData(out, 0, 0);
  }
  requestAnimationFrame(drawPreview);
}

// sRGB <-> linear
function toLin(c) { c = c/255; return c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); }
function toSRGB(l){ return l<=0.0031308 ? l*12.92 : 1.055*Math.pow(l,1/2.4)-0.055; }

// Tone shaping
function compressHighlights(rl, gl, bl) {
  const L = 0.2126*rl + 0.7152*gl + 0.0722*bl;
  const Lc = L / (1 + L);
  const scale = L > 0 ? (Lc / L) : 1;
  return [rl*scale, gl*scale, bl*scale];
}
function contrastCurve(l) {
  const a = 0.20, pivot = 0.20;
  return (l - pivot) * (1 + a) + pivot;
}

// Blur check (variance of Laplacian on center crop)
function isBlurry() {
  const cw = Math.round(w * 0.25);
  const ch = Math.round(h * 0.25);
  const cx = Math.round((w - cw) / 2);
  const cy = Math.round((h - ch) / 2);
  const img = pctx.getImageData(cx, cy, cw, ch);
  const gray = new Float32Array(cw * ch);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
    gray[j] = 0.2126 * img.data[i] + 0.7152 * img.data[i+1] + 0.0722 * img.data[i+2];
  }
  let sum = 0, sumSq = 0, n = 0;
  const idx = (x,y) => y * cw + x;
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const lap =
        -1*gray[idx(x-1,y-1)] + -1*gray[idx(x,y-1)] + -1*gray[idx(x+1,y-1)] +
        -1*gray[idx(x-1,y)]   +  8*gray[idx(x,y)]   + -1*gray[idx(x+1,y)]   +
        -1*gray[idx(x-1,y+1)] + -1*gray[idx(x,y+1)] + -1*gray[idx(x+1,y+1)];
      sum += lap; sumSq += lap*lap; n++;
    }
  }
  const mean = sum / n;
  const varL = (sumSq / n) - mean * mean;
  return varL < 2500;
}

// Patch validation
function validatePatch(rMean, gMean, bMean, rVar, gVar, bVar) {
  const L = 0.2126*rMean + 0.7152*gMean + 0.0722*bMean;
  if (L < 0.60) return { ok:false, msg:'Patch too dim. Use brighter, even light.' };
  if (L > 0.80) return { ok:false, msg:'Patch overexposed. Reduce glare or move slightly.' };
  // Neutrality: chroma vs luminance
  const chroma = Math.abs(rMean - gMean) + Math.abs(gMean - bMean) + Math.abs(bMean - rMean);
  if (chroma > 0.06) return { ok:false, msg:'Patch not neutral. Use matte white or 18% gray.' };
  const varAvg = (rVar + gVar + bVar)/3;
  if (varAvg > 0.015) return { ok:false, msg:'Patch has glare/texture. Tilt card or use matte.' };
  return { ok:true, msg:'' };
}

function meanVarRGBLinear(img) {
  const d = img.data;
  let r=0,g=0,b=0,n=0;
  for (let i=0;i<d.length;i+=4){ r+=toLin(d[i]); g+=toLin(d[i+1]); b+=toLin(d[i+2]); n++; }
  const rm=r/n, gm=g/n, bm=b/n;
  let rv=0, gv=0, bv=0;
  for (let i=0;i<d.length;i+=4){
    const rl=toLin(d[i]), gl=toLin(d[i+1]), bl=toLin(d[i+2]);
    rv += (rl-rm)*(rl-rm); gv += (gl-gm)*(gl-gm); bv += (bl-bm)*(bl-bm);
  }
  rv/=n; gv/=n; bv/=n;
  return { rMean:rm, gMean:gm, bMean:bm, rVar:rv, gVar:gv, bVar:bv };
}

// Process pixels: WB + CCM + tone shaping + red taming
function processPixels(src, dst) {
  for (let i=0; i<src.length; i+=4) {
    let rl = toLin(src[i])     * gains.r;
    let gl = toLin(src[i+1])   * gains.g;
    let bl = toLin(src[i+2])   * gains.b;

    let r2 = CCM[0][0]*rl + CCM[0][1]*gl + CCM[0][2]*bl;
    let g2 = CCM[1][0]*rl + CCM[1][1]*gl + CCM[1][2]*bl;
    let b2 = CCM[2][0]*rl + CCM[2][1]*gl + CCM[2][2]*bl;

    [r2, g2, b2] = compressHighlights(r2, g2, b2);
    r2 = contrastCurve(r2); g2 = contrastCurve(g2); b2 = contrastCurve(b2);

    const L = 0.2126*r2 + 0.7152*g2 + 0.0722*b2;
    const chromaR = r2 - L;
    const maxSat = 1.10;
    r2 = L + Math.max(Math.min(chromaR, L*(maxSat-1)), -L*(maxSat-1));

    dst[i]   = Math.min(255, Math.max(0, Math.round(toSRGB(r2) * 255)));
    dst[i+1] = Math.min(255, Math.max(0, Math.round(toSRGB(g2) * 255)));
    dst[i+2] = Math.min(255, Math.max(0, Math.round(toSRGB(b2) * 255)));
    dst[i+3] = src[i+3];
  }
}

// Auto mode: start -> 3s -> auto-detect neutral patch -> calibrate -> capture
startBtn.addEventListener('click', async () => {
  if (!initialized) return;
  statusBanner.textContent = 'Position phone. Capturing in 3…';
  let remaining = 3;
  const t = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(t);
      autoCalibrateAndCapture();
    } else {
      statusBanner.textContent = `Position phone. Capturing in ${remaining}…`;
    }
  }, 1000);
});

async function autoCalibrateAndCapture() {
  // Downsample and scan for neutral bright patches
  const gridW = 40, gridH = 40;
  const small = new OffscreenCanvas(gridW, gridH);
  const sctx = small.getContext('2d');
  sctx.drawImage(video, 0, 0, gridW, gridH);
  const data = sctx.getImageData(0,0,gridW,gridH).data;

  // Evaluate candidate 6x6 patches across grid
  let best = null;
  const patchSize = 6;
  for (let y=0; y<=gridH-patchSize; y+=3) {
    for (let x=0; x<=gridW-patchSize; x+=3) {
      // compute mean/var over patch
      let r=0,g=0,b=0,n=0;
      for (let py=0; py<patchSize; py++){
        for (let px=0; px<patchSize; px++){
          const ix = ((y+py)*gridW + (x+px)) * 4;
          r += toLin(data[ix]); g += toLin(data[ix+1]); b += toLin(data[ix+2]); n++;
        }
      }
      r/=n; g/=n; b/=n;
      let rv=0, gv=0, bv=0;
      for (let py=0; py<patchSize; py++){
        for (let px=0; px<patchSize; px++){
          const ix = ((y+py)*gridW + (x+px)) * 4;
          const rl = toLin(data[ix]), gl = toLin(data[ix+1]), bl = toLin(data[ix+2]);
          rv += (rl-r)*(rl-r); gv += (gl-g)*(gl-g); bv += (bl-b)*(bl-b);
        }
      }
      rv/=n; gv/=n; bv/=n;

      const val = validatePatch(r, g, b, rv, gv, bv);
      if (val.ok) {
        const L = 0.2126*r + 0.7152*g + 0.0722*b;
        // prefer brighter within range and lowest variance
        const score = L - (rv+gv+bv);
        if (!best || score > best.score) {
          best = { x, y, r, g, b, score };
        }
      }
    }
  }

  if (!best) {
    warnBox.style.display = 'block';
    warnBox.textContent = 'No neutral white found. Tap your white patch to calibrate or adjust lighting.';
    statusBanner.textContent = 'Tap a white patch to calibrate';
    return;
  }

  const t = (best.r + best.g + best.b) / 3;
  gains = { r: t/best.r, g: t/best.g, b: t/best.b };
  lockIndicator.style.display = 'block';
  statusBanner.textContent = 'Locked. Capturing…';

  captureFrame();
}

// Tap-to-calibrate fallback
previewCanvas.addEventListener('click', (e) => {
  if (!initialized) return;
  const rect = previewCanvas.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) * (w / rect.width));
  const y = Math.round((e.clientY - rect.top) * (h / rect.height));

  const size = Math.floor(Math.min(w, h) * 0.14);
  const sx = Math.max(0, Math.min(w - size, x - size / 2));
  const sy = Math.max(0, Math.min(h - size, y - size / 2));

  sampleBox.style.display = 'block';
  sampleBox.style.left = `${(sx / w) * 100}%`;
  sampleBox.style.top = `${(sy / h) * 100}%`;
  sampleBox.style.width = `${(size / w) * 100}%`;
  sampleBox.style.height = `${(size / h) * 100}%`;

  const img = pctx.getImageData(sx, sy, size, size);
  const { rMean, gMean, bMean, rVar, gVar, bVar } = meanVarRGBLinear(img);
  const val = validatePatch(rMean, gMean, bMean, rVar, gVar, bVar);
  if (!val.ok) {
    warnBox.style.display = 'block';
    warnBox.textContent = val.msg;
    lockIndicator.style.display = 'none';
    statusBanner.textContent = 'Adjust patch, then tap again';
    return;
  } else {
    warnBox.style.display = 'none';
  }

  const t = (rMean + gMean + bMean)/3;
  gains = { r: t/rMean, g: t/gMean, b: t/bMean };

  lockIndicator.style.display = 'block';
  statusBanner.textContent = 'Locked: capturing in 4…';
  startCountdown(4);
});

function startCountdown(seconds) {
  clearCountdown();
  let remaining = seconds;
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      statusBanner.textContent = `Locked: capturing in ${remaining}…`;
    } else {
      clearCountdown();
      captureFrame();
    }
  }, 1000);
}
function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// Capture, crop, correct, show
function captureFrame() {
  // Blur warning (still capture)
  const blurry = isBlurry();
  focusWarn.style.display = blurry ? 'block' : 'none';
  focusWarn.textContent = blurry ? 'Focus soft. Adjust distance or hold steadier.' : '';

  octx.drawImage(video, 0, 0, w, h);

  // Crop: tight head + hair + lower neck/clavicle
  const crop = {
    x: Math.round(w * 0.10),
    y: Math.round(h * 0.12),
    width: Math.round(w * 0.80),
    height: Math.round(h * 0.64)
  };
  crop.x = Math.max(0, crop.x);
  crop.y = Math.max(0, crop.y);
  crop.width = Math.min(w - crop.x, crop.width);
  crop.height = Math.min(h - crop.y, crop.height);

  const imgCropped = octx.getImageData(crop.x, crop.y, crop.width, crop.height);

  original.width = crop.width; original.height = crop.height;
  corrected.width = crop.width; corrected.height = crop.height;

  octx.putImageData(imgCropped, 0, 0);

  const out = new ImageData(crop.width, crop.height);
  processPixels(imgCropped.data, out.data);
  cctx.putImageData(out, 0, 0);

  document.getElementById('result').style.display = 'grid';
  statusBanner.textContent = 'Captured';
  sampleBox.style.display = 'none';
  lockIndicator.style.display = 'none';
}

// Manual capture
captureBtn.addEventListener('click', captureFrame);

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

// Camera selector
cameraSelect.addEventListener('change', (e) => {
  currentFacingMode = e.target.value;
  activeCamLabel.textContent = `Active: ${currentFacingMode === 'user' ? 'Front' : 'Rear'}`;
  init();
});

// Live preview toggle
previewToggle.addEventListener('change', (e) => {
  livePreview = e.target.checked;
  statusBanner.textContent = livePreview ? 'Live preview ON (calibrated)' : 'Press Start or tap a white patch to calibrate';
});
