// ===== APP INIT =====
function init() {
  const saved = localStorage.getItem('inv_log');
  if (saved) scanLog = JSON.parse(saved);

  loadLocations();
  renderLog();
  updateStats();

  document.getElementById('loc-select').addEventListener('change', e => {
    localStorage.setItem('inv_location', e.target.value);
  });

  const barcodeInput = document.getElementById('barcode-input');
  barcodeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim();
      if (v) lookupBarcode(v);
    }
  });
  // Auto-trigger lookup when a barcode is pasted (e.g. from iPhone clipboard)
  barcodeInput.addEventListener('paste', e => {
    setTimeout(() => {
      const v = barcodeInput.value.trim();
      if (v) lookupBarcode(v);
    }, 50);
  });

  // Click outside scan card → refocus barcode (only when scan section is visible)
  document.addEventListener('click', e => {
    const scanScreen = document.getElementById('screen-scan');
    if (!scanScreen || scanScreen.style.display === 'none') return;
    const card   = document.querySelector('.scan-card');
    const modal  = document.getElementById('loc-modal');
    const locBar = document.querySelector('.loc-bar');
    if (card && !card.contains(e.target) && (!modal || !modal.contains(e.target)) && (!locBar || !locBar.contains(e.target))) {
      refocusBarcode();
    }
  });

  // Route to the tab matching the URL hash, or default to lottery dashboard
  _routeFromHash();
  initLotteryTab();

  const start = Date.now();
  setInterval(() => {
    const m = Math.floor((Date.now() - start) / 60000);
    document.getElementById('session-time').textContent = m < 1 ? 'Just started' : `${m}m`;
  }, 10000);

  checkDBConnection();
}

init();
