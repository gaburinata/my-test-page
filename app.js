const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const original = document.getElementById('original');
const corrected = document.getElementById('corrected');
const octx = original.getContext('2d');
const cctx = corrected.getContext('2d');

const sampleBtn = document.getElementById('sample');
const shutterBtn = document.getElementById('shutter');
const lockIndicator = document.getElementById('lockIndicator');
const downloadBtn = document.getElementById('download');

let stream, w=0, h=0;
let gains = { r:1, g:1, b:1 };
let locked = false;

(async function init(){
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' }
  });
  video.srcObject = stream;
  await video.play();
  w = video.videoWidth; h = video.videoHeight;
  canvas.width = w; canvas.height = h;
  original.width = w; original.height = h;
  corrected.width = w; corrected.height = h;
  requestAnimationFrame(draw);
})();

function toLin(c){ // sRGB to linear
  c = c/255;
  return (c <= 0.04045) ? (c/12.92) : Math.pow((c+0.055)/1.055, 2.4);
}
function toSRGB(lin){
  return (lin <= 0.0031308) ? (lin*12.92) : (1.055*Math.pow(lin,1/2.4)-0.055);
}

function draw(){
  ctx.drawImage(video, 0, 0, w, h);
  if (!locked) {
    // live preview, no correction
  }
  requestAnimationFrame(draw);
}

// Sample ROI around bottom-right thumb area or tap coordinate
sampleBtn.addEventListener('click', () => {
  const roi = { x: Math.floor(w*0.65), y: Math.floor(h*0.65), size: Math.floor(Math.min(w,h)*0.1) };
  const img = ctx.getImageData(roi.x, roi.y, roi.size, roi.size);
  const { rMean, gMean, bMean } = meanRGBLinear(img);
  const t = (rMean + gMean + bMean)/3;
  gains = { r: t/rMean, g: t/gMean, b: t/bMean };
  // Stability check: sample a few frames
  stabilityCheck(roi).then(ok => {
    locked = ok;
    lockIndicator.style.display = ok ? 'inline-block' : 'none';
  });
});

function meanRGBLinear(img){
  const d = img.data;
  let r=0,g=0,b=0,n=0;
  for (let i=0;i<d.length;i+=4){
    r += toLin(d[i]); g += toLin(d[i+1]); b += toLin(d[i+2]); n++;
  }
  return { rMean:r/n, gMean:g/n, bMean:b/n };
}

async function stabilityCheck(roi){
  const samples = [];
  for(let i=0;i<6;i++){
    await new Promise(r => setTimeout(r, 80));
    const img = ctx.getImageData(roi.x, roi.y, roi.size, roi.size);
    samples.push(meanRGBLinear(img));
  }
  // Stddev threshold
  const sd = (arr, key) => {
    const mean = arr.reduce((s,a)=>s+a[key],0)/arr.length;
    const varr = arr.reduce((s,a)=>s+Math.pow(a[key]-mean,2),0)/arr.length;
    return Math.sqrt(varr);
  };
  const ok = sd(samples,'rMean')<0.01 && sd(samples,'gMean')<0.01 && sd(samples,'bMean')<0.01;
  return ok;
}

shutterBtn.addEventListener('click', () => {
  // Capture original
  octx.drawImage(video, 0, 0, w, h);
  // Correct
  const img = octx.getImageData(0,0,w,h);
  const out = new ImageData(w,h);
  for(let i=0;i<img.data.length;i+=4){
    const rl = toLin(img.data[i])   * gains.r;
    const gl = toLin(img.data[i+1]) * gains.g;
    const bl = toLin(img.data[i+2]) * gains.b;
    // Optional: apply CAT + CCM here (placeholder)
    const rs = Math.min(255, Math.max(0, Math.round(toSRGB(rl)*255)));
    const gs = Math.min(255, Math.max(0, Math.round(toSRGB(gl)*255)));
    const bs = Math.min(255, Math.max(0, Math.round(toSRGB(bl)*255)));
    out.data[i]   = rs;
    out.data[i+1] = gs;
    out.data[i+2] = bs;
    out.data[i+3] = img.data[i+3];
  }
  cctx.putImageData(out,0,0);
});

downloadBtn.addEventListener('click', () => {
  corrected.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'calibrated.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png', 1.0);
});
