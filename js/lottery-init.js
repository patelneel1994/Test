// ===== TAB INIT =====

async function _ensureLotteryDbState() {
  if (_lotteryDbStateReady) return;
  _lotteryDbStateReady = true;
  await checkDbCapabilities();
  await Promise.all([loadCurrentDayShift(), _loadLotteryLocations()]);
}

// Receive sub-section — called when switching to receive sub-tab
let _locViewSortBy = 'pack';  // 'pack' | 'price-asc' | 'price-desc' | 'name'
let _locViewSearch = '';
let _locViewCache  = null;

function setLocSort(sort) {
  _locViewSortBy = sort;
  document.querySelectorAll('.loc-sort-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === sort)
  );
  _renderLocationView();
}

function setLocSearch(q) {
  _locViewSearch = q;
  _renderLocationView();
}

async function loadLocationView() {
  const el = document.getElementById('location-view-container');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs` +
      `?select=id,game_number,pack_number,status,location,raw_barcode,lottery_games(game_name,price,tickets_per_pack)` +
      `&status=in.(received,activated)&order=location.asc,pack_number.asc`
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows?.message || `[${res.status}]`);
    _locViewCache = rows;
    _renderLocationView();
  } catch (err) {
    document.getElementById('location-view-container').innerHTML =
      `<div class="item-nf-sub">Load failed: ${err.message}</div>`;
  }
}

function _renderLocationView() {
  const el = document.getElementById('location-view-container');
  if (!el || !_locViewCache) return;
  const rows = _locViewCache;

  if (!rows.length) {
    el.innerHTML = '<div class="log-empty" style="padding:10px 0;border:none">No books in system</div>';
    return;
  }

  // Filter
  const q = _locViewSearch.trim().toLowerCase();
  const filtered = q
    ? rows.filter(p =>
        (p.lottery_games?.game_name || '').toLowerCase().includes(q) ||
        String(p.game_number).includes(q) ||
        String(p.pack_number).includes(q)
      )
    : rows;

  if (!filtered.length) {
    el.innerHTML = `<div class="log-empty" style="padding:10px 0;border:none">No books match "${_locViewSearch}"</div>`;
    return;
  }

  // Group by location
  const byLoc = {};
  for (const r of filtered) {
    const loc = r.location || 'Office';
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(r);
  }

  // Sort within each location
  const sortFn = (a, b) => {
    if (_locViewSortBy === 'price-asc')  return parseFloat(a.lottery_games?.price || 0) - parseFloat(b.lottery_games?.price || 0);
    if (_locViewSortBy === 'price-desc') return parseFloat(b.lottery_games?.price || 0) - parseFloat(a.lottery_games?.price || 0);
    if (_locViewSortBy === 'name')       return (a.lottery_games?.game_name || '').localeCompare(b.lottery_games?.game_name || '');
    return a.pack_number - b.pack_number; // 'pack' default
  };
  for (const loc of Object.keys(byLoc)) byLoc[loc].sort(sortFn);

  // Price count summary
  const locPriceCounts = {};
  for (const p of filtered) {
    const price = parseFloat(p.lottery_games?.price || 0);
    if (price > 0) locPriceCounts[price] = (locPriceCounts[price] || 0) + 1;
  }

  const allLocs = _sortedAllLocs(byLoc);
  let html = _priceSummaryHtml(locPriceCounts);
  for (const loc of allLocs) {
    const packs = byLoc[loc];
    if (!packs?.length) continue;
    const isOffice    = loc === 'Office';
    const adminLocked = isOffice && !isAdmin();
    const locCss      = PACK_LOC_CSS[loc] || 'loc-office';
    const totalVal    = packs.reduce((sum, p) => {
      const price = parseFloat(p.lottery_games?.price || 0);
      const tpp   = parseInt(p.lottery_games?.tickets_per_pack || 0, 10);
      return sum + price * tpp;
    }, 0);
    const receivedCount = packs.filter(p => p.status === 'received').length;
    const countHtml  = adminLocked && receivedCount
      ? `<span class="loc-view-count" style="filter:blur(4px);user-select:none" aria-hidden="true">${packs.length} book${packs.length !== 1 ? 's' : ''}</span>`
      : `<span class="loc-view-count">${packs.length} book${packs.length !== 1 ? 's' : ''}</span>`;
    const totalHtml  = adminLocked
      ? `<span class="loc-view-total" style="filter:blur(4px);user-select:none" aria-hidden="true">$${totalVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      : `<span class="loc-view-total">$${totalVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
    html += `<div class="loc-view-section">
      <div class="loc-view-header">
        <span class="pack-loc-pill ${locCss}">${loc}</span>
        ${countHtml}${totalHtml}
      </div>
      <div class="loc-view-books">
        ${packs.map(p => {
          const st    = PACK_STATUS[p.status] || { label: p.status, css: '' };
          const name  = p.lottery_games?.game_name || `Game #${p.game_number}`;
          const price = parseFloat(p.lottery_games?.price || 0);
          const tpp   = parseInt(p.lottery_games?.tickets_per_pack || 0, 10);
          const val   = price && tpp ? `$${(price * tpp).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
          const showVal = val && !adminLocked;
          const priceSub = price && !adminLocked ? ` · $${price.toFixed(2)}/ticket` : '';
          return `<div class="loc-view-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;gap:8px">
              <div class="loc-view-info">
                <span class="loc-view-name">${name}</span>
                <span class="loc-view-sub">#${p.pack_number}${priceSub}</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                ${showVal ? `<span class="loc-view-val">${val}</span>` : ''}
                <span class="pack-status-pill ${st.css}">${st.label}</span>
              </div>
            </div>
            ${p.raw_barcode ? `<div style="margin-top:8px">${_renderBarcodeBreakdown(p.raw_barcode, p.game_number)}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

function initReceiveTab() {
  renderReceiveLocationButtons();
  renderLotteryLog();
  renderLotteryStats();
  refocusLottery();
  loadReceiveQueue();
}

async function loadReceiveQueue() {
  const el = document.getElementById('receive-queue-container');
  if (!el) return;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs` +
      `?select=id,game_number,pack_number,raw_barcode,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)` +
      `&status=eq.received&order=location.asc,pack_number.asc`
    );
    const packs = await res.json();
    if (!Array.isArray(packs) || !packs.length) {
      el.innerHTML = '<div class="log-empty" style="border:none">No received packs — scan a barcode above to receive one.</div>';
      return;
    }
    const locOrder = _getLocOrderAll();
    const byLoc = {};
    for (const p of packs) {
      const loc = p.location || 'Unassigned';
      if (!byLoc[loc]) byLoc[loc] = [];
      byLoc[loc].push(p);
    }
    const allLocs = [...locOrder, ...Object.keys(byLoc).filter(l => !locOrder.includes(l))];
    const canLoad = _canMoveOrActivate();
    let html = '';
    for (const loc of allLocs) {
      const ps = byLoc[loc];
      if (!ps) continue;
      html += `<div class="shift-loc-section">
        <div class="shift-loc-header">${loc} <span style="font-weight:400;opacity:.55">(${ps.length})</span></div>
        <div class="catalog-grid">`;
      for (const p of ps) {
        const game  = p.lottery_games || {};
        const tpp   = parseInt(game.tickets_per_pack || 0);
        const price = parseFloat(game.price || 0);
        const gn    = p.game_number;
        const color = _gameColor(gn);
        const emoji = _gameEmoji(gn);
        _packInfoCache[p.id] = {
          ticketsPerPack:   tpp,
          gameName:         game.game_name || '',
          packNumber:       p.pack_number,
          startTicket:      p.start_ticket ?? null,
          endTicket:        p.end_ticket   ?? null,
          lastShiftTicket:  p.last_shift_ticket ?? null,
          loadingDirection: (p.loading_direction || 'asc').toLowerCase(),
          location:         p.location,
        };
        const delBtn = `<button class="catalog-del-btn" style="margin-left:auto"
          onmousedown="deleteReceivedPack('${p.id}','${(game.game_name || `Game #${gn}`).replace(/'/g,"\\'")}',event)"
          ontouchstart="deleteReceivedPack('${p.id}','${(game.game_name || `Game #${gn}`).replace(/'/g,"\\'")}',event)">Delete</button>`;
        const loadBtns = canLoad
          ? _getStations().map(st => `<button class="pack-act-btn act-station"
              onmousedown="openActivationForm('${p.id}','${st}',event)"
              ontouchstart="openActivationForm('${p.id}','${st}',event)">${st}</button>`).join('') + delBtn
          : `<span class="cat-in-use">${_currentDay ? 'Open a shift to load' : 'Open a day to load'}</span>${delBtn}`;
        html += `
          <div class="cat-card">
            <div class="cat-card-bar" style="background:${color}"></div>
            <div class="cat-card-hdr">
              <div class="cat-game-dot" style="background:${color}1a">${emoji}</div>
              <div class="cat-game-identity">
                <div class="cat-game-name">${game.game_name || `Game #${gn}`}</div>
                <div class="cat-game-num">#${gn} · Book #${p.pack_number}</div>
              </div>
            </div>
            <div class="cat-stats">
              <div class="cat-stat">
                <div class="cat-stat-val">$${price.toFixed(2)}</div>
                <div class="cat-stat-lbl">Per ticket</div>
              </div>
              <div class="cat-stat">
                <div class="cat-stat-val">${tpp > 0 ? tpp.toLocaleString() : '—'}</div>
                <div class="cat-stat-lbl">Per roll</div>
              </div>
              <div class="cat-stat">
                <div class="cat-stat-val">${p.start_ticket > 0 ? p.start_ticket : 'Full'}</div>
                <div class="cat-stat-lbl">Starts at</div>
              </div>
            </div>
            <div class="cat-bc">
              <div class="cat-bc-lbl">Barcode</div>
              ${_renderBarcodeBreakdown(p.raw_barcode, gn)}
            </div>
            <div class="cat-footer" style="gap:6px;flex-wrap:wrap">${loadBtns}</div>
          </div>`;
      }
      html += '</div></div>';
    }
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<div class="item-nf-sub">Load failed: ${err.message}</div>`;
  }
}

async function deleteReceivedPack(packId, gameName, e) {
  if (e) e.preventDefault();
  if (!confirm(`Delete received pack for ${gameName}?\n\nThis removes it from the queue permanently.`)) return;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}&status=eq.received`,
      { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    loadReceiveQueue();
    loadLotteryDbStats();
  } catch (err) {
    showError('Delete failed', err.message);
  }
}

