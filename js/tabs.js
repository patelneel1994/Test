// ===== TAB NAVIGATION =====
function switchTab(tab) {
  const tabs    = ['scan', 'summary', 'search', 'lottery'];
  const screens = {
    scan:    document.getElementById('screen-scan'),
    summary: document.getElementById('screen-summary'),
    search:  document.getElementById('screen-search'),
    lottery: document.getElementById('screen-lottery'),
  };
  const locBar = document.getElementById('loc-bar');

  tabs.forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
    screens[t].style.display = t === tab ? '' : 'none';
  });

  locBar.style.display = tab === 'scan' ? '' : 'none';

  if (tab === 'summary') loadSummary();
  if (tab === 'search') {
    const si = document.getElementById('search-input');
    si.focus();
    si.click();
  }
  if (tab === 'lottery') initLotteryTab();
}

function switchLotterySection(section) {
  ['tracking', 'catalog', 'receive'].forEach(s => {
    document.getElementById('lsub-' + s).classList.toggle('active', s === section);
    document.getElementById('lsection-' + s).style.display = s === section ? '' : 'none';
  });
  if (section === 'receive') { initReceiveTab(); loadLocationView(); }
  if (section === 'catalog') loadLotteryCatalog();
}
