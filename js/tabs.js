// ===== TAB NAVIGATION =====

function _setNavActive(id) {
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function switchTab(tab, { pushHash = true } = {}) {
  ['scan', 'summary', 'search', 'lottery'].forEach(t => {
    const el = document.getElementById('screen-' + t);
    if (!el) return;
    el.style.display = t === tab ? '' : 'none';
    if (t === tab) { el.classList.remove('section-anim'); void el.offsetWidth; el.classList.add('section-anim'); }
  });

  const locBar = document.getElementById('loc-bar');
  if (locBar) locBar.style.display = tab === 'scan' ? '' : 'none';

  if (tab !== 'lottery') _setNavActive('nav-' + tab);

  if (pushHash) location.hash = tab;

  if (tab === 'summary') loadSummary();
  if (tab === 'search') {
    const si = document.getElementById('search-input');
    if (si) { si.focus(); si.click(); }
  }
}

function switchLotterySection(section, { pushHash = true } = {}) {
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
    if (!sec) return;
    sec.style.display = s === section ? '' : 'none';
    if (s === section) { sec.classList.remove('section-anim'); void sec.offsetWidth; sec.classList.add('section-anim'); }
  });

  _setNavActive('nav-lottery-' + section);

  if (pushHash) location.hash = 'lottery-' + section;

  if (typeof _updateContextBar === 'function') _updateContextBar(null);

  if (section === 'dashboard') { loadDashboard(); _initDashAnalyticsDates(); }
  if (section === 'receive')   { initReceiveTab(); loadLocationView(); }
  if (section === 'catalog')   loadLotteryCatalog();
  if (section === 'reports')   loadLotteryReports();
  if (section === 'settings')  loadSettingsSection();
  if (section === 'inventory') loadInventorySection();
}

function _routeFromHash() {
  const hash = location.hash.replace('#', '') || 'lottery-dashboard';
  if (hash === 'scan' || hash === 'search' || hash === 'summary') {
    switchTab(hash, { pushHash: false });
  } else {
    const section = hash.startsWith('lottery-') ? hash.slice('lottery-'.length) : 'dashboard';
    switchLotterySection(section, { pushHash: false });
  }
}

window.addEventListener('hashchange', () => _routeFromHash());
