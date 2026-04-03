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

  document.getElementById('barcode-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim();
      if (v) lookupBarcode(v);
    }
  });

  // Click outside scan card / loc bar / modals → refocus barcode
  document.addEventListener('click', e => {
    const card   = document.querySelector('.scan-card');
    const modal  = document.getElementById('loc-modal');
    const locBar = document.querySelector('.loc-bar');
    if (!card.contains(e.target) && !modal.contains(e.target) && !locBar.contains(e.target)) {
      refocusBarcode();
    }
  });

  refocusBarcode();

  const start = Date.now();
  setInterval(() => {
    const m = Math.floor((Date.now() - start) / 60000);
    document.getElementById('session-time').textContent = m < 1 ? 'Just started' : `${m}m`;
  }, 10000);

  checkDBConnection();
}

init();
