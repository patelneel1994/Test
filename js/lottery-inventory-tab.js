// ===== INVENTORY TAB =====
let _invTabFilter = 'all';
let _invTabAllPacks = [];

async function loadInventorySection() {
  const listEl = document.getElementById('inv-tab-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="summary-loading" style="padding:20px">Loading…</div>';

  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id,game_number,pack_number,status,location,start_ticket,end_ticket,loading_direction,created_at,lottery_games(game_name,price,tickets_per_pack)&order=created_at.desc`
    );
    const json = await res.json();
    _invTabAllPacks = Array.isArray(json) ? json : [];
    _renderInventoryList();
  } catch (e) {
    listEl.innerHTML = `<div class="itab-empty">Load failed: ${e.message}</div>`;
  }
}

function setInventoryFilter(filter) {
  _invTabFilter = filter;
  document.querySelectorAll('#inv-tab-filter-row .inv-tab-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  _renderInventoryList();
}

function filterInventoryRows() {
  _renderInventoryList();
}

function _renderInventoryList() {
  const listEl = document.getElementById('inv-tab-list');
  if (!listEl) return;

  const search = (document.getElementById('inv-tab-search')?.value || '').trim().toLowerCase();
  let packs = _invTabAllPacks;

  if (_invTabFilter !== 'all') {
    packs = packs.filter(p => p.status === _invTabFilter);
  }

  if (search) {
    packs = packs.filter(p => {
      const gameName = (p.lottery_games?.game_name || '').toLowerCase();
      const packNum  = (p.pack_number || '').toLowerCase();
      const gameNum  = (p.game_number || '').toLowerCase();
      return gameName.includes(search) || packNum.includes(search) || gameNum.includes(search);
    });
  }

  if (!packs.length) {
    listEl.innerHTML = `<div class="itab-empty">No books match this filter.</div>`;
    return;
  }

  const header = `<div class="itab-tbl-hdr">
    <div>Game / Book</div><div>Barcode</div><div>Location</div><div>Status</div><div>Progress</div>
    <div style="text-align:right">Actions</div>
  </div>`;

  listEl.innerHTML = header + packs.map(p => _renderItabRow(p)).join('');
}

function _renderItabRow(p) {
  const g        = p.lottery_games || {};
  const gameName = g.game_name  || `Game ${p.game_number}`;
  const price    = g.price      != null ? `$${Number(g.price).toFixed(2)}` : '';
  const tpp      = g.tickets_per_pack || 0;
  const color    = _gameColor(p.game_number);
  const emoji    = _gameEmoji(p.game_number);

  const dir      = p.loading_direction || 'asc';
  const start    = p.start_ticket ?? 0;
  const totalTix = tpp || Math.max(0, (p.end_ticket ?? 0) + 1);

  let soldCount = 0, soldPct = 0;
  if (totalTix > 0 && p.status === 'activated') {
    soldCount = dir === 'asc' ? start : Math.max(0, totalTix - 1 - start);
    soldPct   = Math.min(100, Math.round((soldCount / totalTix) * 100));
  } else if (p.status === 'soldout') {
    soldCount = totalTix;
    soldPct   = 100;
  }
  const remaining = totalTix - soldCount;

  const statusCls = { activated:'itab-status-activated', received:'itab-status-received', soldout:'itab-status-soldout', removed:'itab-status-removed' }[p.status] || 'itab-status-received';
  const statusLabel = { activated:'Active', received:'Received', soldout:'Sold Out', removed:'Removed' }[p.status] || p.status;

  const locIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s-7-7.5-7-13a7 7 0 1 1 14 0c0 5.5-7 13-7 13Z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
  const dirPill  = p.loading_direction === 'desc' ? `<span class="itab-desc-pill">DESC</span>` : '';

  let progressHtml = '';
  if (p.status === 'activated' || p.status === 'soldout') {
    progressHtml = `
      <div class="itab-row-progress-info">
        <span class="itab-row-mono">${soldCount} / ${totalTix}</span>
        ${remaining > 0 ? `<span class="itab-row-rem">· ${remaining} left</span>` : ''}
        ${dirPill}
      </div>
      <div class="itab-row-bar-wrap"><div class="itab-row-bar-fill" style="width:${soldPct}%;background:${color}"></div></div>`;
  } else if (p.status === 'received') {
    progressHtml = `<span class="itab-row-rem">${totalTix || '—'} tickets/book</span>`;
  }

  return `
  <div class="itab-tbl-row">
    <div class="itab-tbl-cell-game">
      <div class="itab-dot32" style="background:${color}">${emoji}</div>
      <div class="itab-tbl-name-col">
        <div class="itab-tbl-game-name">${gameName}</div>
        <div class="itab-tbl-book-sub">${price ? price + ' · ' : ''}#${p.pack_number || (p.id || '').slice(-6)}</div>
      </div>
    </div>
    <div class="itab-tbl-cell itab-bc-wrap">${_formatBarcode(p.game_number, p.pack_number)}</div>
    <div class="itab-tbl-cell itab-tbl-loc">${locIcon}<span>${p.location || 'Office'}</span></div>
    <div class="itab-tbl-cell"><span class="itab-status ${statusCls}">${statusLabel}</span></div>
    <div class="itab-tbl-cell-progress">${progressHtml}</div>
    <div class="itab-tbl-cell-actions"><button class="itab-open-btn">Open</button></div>
  </div>`;
}

// Lottery tab — inventory management + day/shift
async function initLotteryTab() {
  await _ensureLotteryDbState();
  _initHistoryFilter();
  _syncAdminStats();
  loadDashboard();
  // Wire receive input events eagerly so they work without clicking sub-tab first
  if (!_lotteryEventsReady) {
    _lotteryEventsReady = true;
    const inp = document.getElementById('lottery-input');
    if (inp) {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitLotteryInput(); } });
      inp.addEventListener('paste',   () => { setTimeout(() => { const v = inp.value.trim(); if (v) lookupLotteryTicket(v); }, 50); });
    }
  }
}
