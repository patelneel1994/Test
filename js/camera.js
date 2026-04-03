// ===== CAMERA =====
function toggleCamera() {
  if (cameraRunning) { stopCamera(); return; }
  document.getElementById('camera-scanner').classList.add('active');
  cameraRunning = true;
  html5QrScanner = new Html5Qrcode('qr-reader');
  html5QrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 150 } },
    decoded => { stopCamera(); lookupBarcode(decoded); },
    () => {}
  ).catch(err => { showError('Camera access denied', err.message); stopCamera(); });
}

function stopCamera() {
  if (html5QrScanner) html5QrScanner.stop().catch(() => {}).finally(() => { html5QrScanner = null; });
  document.getElementById('camera-scanner').classList.remove('active');
  cameraRunning = false;
  refocusBarcode();
}
