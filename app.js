// ... (initialization code unchanged)

function captureFrame() {
  const blurry = isBlurry();
  focusWarn.style.display = blurry ? 'block' : 'none';
  focusWarn.textContent = blurry ? 'Focus soft. Adjust distance or hold steadier.' : '';

  // Draw full frame
  octx.drawImage(video, 0, 0, w, h);

  // Use full frame (no crop)
  const imgFull = octx.getImageData(0, 0, w, h);

  original.width = w; original.height = h;
  corrected.width = w; corrected.height = h;

  octx.putImageData(imgFull, 0, 0);

  const out = new ImageData(w, h);
  processPixels(imgFull.data, out.data);
  cctx.putImageData(out, 0, 0);

  document.getElementById('result').style.display = 'grid';
  statusBanner.textContent = 'Captured';
  sampleBox.style.display = 'none';
  lockIndicator.style.display = 'none';
}
