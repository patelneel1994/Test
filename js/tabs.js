// ===== TAB NAVIGATION =====
function switchTab(tab) {
  const tabs    = ['scan', 'summary', 'search'];
  const screens = {
    scan:    document.getElementById('screen-scan'),
    summary: document.getElementById('screen-summary'),
    search:  document.getElementById('screen-search'),
  };
  const locBar = document.getElementById('loc-bar');

  tabs.forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
    screens[t].style.display = t === tab ? '' : 'none';
  });

  locBar.style.display = tab === 'scan' ? '' : 'none';

  if (tab === 'summary') loadSummary();
  if (tab === 'search')  document.getElementById('search-input').focus();
}
