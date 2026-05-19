// ===== TAB NAVIGATION =====

function _setNavActive(id) {
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function switchTab(tab) {
  ['scan', 'summary', 'search', 'lottery'].forEach(t => {
    const el = document.getElementById('screen-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });

  const locBar = document.getElementById('loc-bar');
  if (locBar) locBar.style.display = tab === 'scan' ? '' : 'none';

  if (tab !== 'lottery') _setNavActive('nav-' + tab);

  if (tab === 'summary') loadSummary();
  if (tab === 'search') {
    const si = document.getElementById('search-input');
    if (si) { si.focus(); si.click(); }
  }
}

function switchLotterySection(section) {
  // Show the lottery screen, hide others
  ['scan', 'summary', 'search', 'lottery'].forEach(t => {
    const el = document.getElementById('screen-' + t);
    if (el) el.style.display = t === 'lottery' ? '' : 'none';
  });
  const locBar = document.getElementById('loc-bar');
  if (locBar) locBar.style.display = 'none';

  // Show the correct sub-section
  ['dashboard', 'tracking', 'catalog', 'receive', 'reports', 'settings', 'inventory'].forEach(s => {
    const sec = document.getElementById('lsection-' + s);
    if (sec) sec.style.display = s === section ? '' : 'none';
  });

  _setNavActive('nav-lottery-' + section);

  if (typeof _updateContextBar === 'function') _updateContextBar(null);

  if (section === 'dashboard') loadDashboard();
  if (section === 'receive')   { initReceiveTab(); loadLocationView(); }
  if (section === 'catalog')   loadLotteryCatalog();
  if (section === 'reports')   loadLotteryReports();
  if (section === 'settings')  loadSettingsSection();
  if (section === 'inventory') loadInventorySection();
}
