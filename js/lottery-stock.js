// ===== STOCK VIEW =====

let _stockStatusFilter = 'active';

function setStockFilter(filter) {
  _stockStatusFilter = filter;
  document.querySelectorAll('.stock-filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.filter === filter)
  );
  if ((filter === 'removed' || filter === 'soldout') && _stockViewMode === 'location') {
    _stockViewMode = 'game';
    document.getElementById('stock-view-game').classList.add('active');
    document.getElementById('stock-view-loc').classList.remove('active');
  }
  loadLotteryStock();
}

function setStockView(mode) {
  _stockViewMode = mode;
  document.getElementById('stock-view-game').classList.toggle('active', mode === 'game');
  document.getElementById('stock-view-loc').classList.toggle('active', mode === 'location');
  loadLotteryStock();
}

async function loadLotteryStock() {
  const el = document.getElementById('lottery-stock-container');
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  const select = _dbCaps.hasLoadingDirection
    ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,status,location,station_line,lottery_games(game_name,price,tickets_per_pack)`
    : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,status,location,station_line,lottery_games(game_name,price,tickets_per_pack)`;
  // By-location view always shows all non-soldout packs so every book appears under its location
  const statusQ = _stockViewMode === 'location'
    ? 'status=in.(received,activated)'
    : ({
        active:   'status=eq.activated',
        received: 'status=eq.received',
        soldout:  'status=eq.soldout',
        removed:  'status=eq.removed',
        all:      'status=in.(received,activated,soldout,removed)',
      }[_stockStatusFilter] || 'status=in.(received,activated,soldout)');
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${select}&${statusQ}&order=game_number.asc,status.asc,pack_number.asc`
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows?.message || `[${res.status}]`);
    _cachedStockRows = rows;
    renderLotteryStock(rows);
  } catch (e) {
    el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

function renderLotteryStock(rows) {
  _renderBulkMoveBar(rows);
  if (_stockViewMode === 'location') renderLotteryStockByLocation(rows);
  else renderLotteryStockByGame(rows);
}

function _renderBulkMoveBar(_rows) {
  const bar = document.getElementById('bulk-move-bar');
  if (!bar) return;
  if (!_currentDay) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = `<div class="bulk-move-row">
    <button class="pack-act-btn act-move-tva" style="font-size:12px;padding:6px 12px"
      onmousedown="openMoveBooksModal()" ontouchstart="openMoveBooksModal()">Move Books…</button>
    ${isAdmin() ? `<button class="pack-act-btn act-return-lottery" style="font-size:12px;padding:6px 12px"
      onmousedown="openReturnToLotteryModal(event)" ontouchstart="openReturnToLotteryModal(event)">Return to Lottery…</button>` : ''}
    <span class="bulk-move-sep"></span>
    <button class="pack-act-btn bulk-reset-btn" onmousedown="openResetModal()" ontouchstart="openResetModal()">⚠ Reset All</button>
  </div>`;
}

function renderLotteryStockByGame(rows) {
  const el = document.getElementById('lottery-stock-container');
  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No packs in stock</div>'; return;
  }
  const games = {};
  for (const row of rows) {
    const gn = row.game_number;
    if (!games[gn]) games[gn] = {
      gn, gameName: row.lottery_games?.game_name || `Game #${gn}`,
      price: row.lottery_games?.price || 0,
      ticketsPerPack: row.lottery_games?.tickets_per_pack || 0, packs: [],
    };
    games[gn].packs.push(row);
  }
  const sorted = Object.values(games).sort((a, b) => {
    if (_stockSortBy === 'price-desc') return parseFloat(b.price) - parseFloat(a.price);
    if (_stockSortBy === 'game')       return String(a.gn).localeCompare(String(b.gn));
    return parseFloat(a.price) - parseFloat(b.price); // price-asc default
  });
  const _pills = (activated, received, soldOut) => [
    activated.length ? `<span class="cat-cnt-pill cp-active"><span class="cat-cnt-dot"></span>${activated.length} active</span>` : '',
    received.length  ? `<span class="cat-cnt-pill cp-received"><span class="cat-cnt-dot"></span>${received.length} received</span>` : '',
    soldOut.length   ? `<span class="cat-cnt-pill cp-soldout"><span class="cat-cnt-dot"></span>${soldOut.length} sold out</span>` : '',
  ].filter(Boolean).join('');

  el.innerHTML = '<div class="catalog-grid">' + sorted.map(g => {
    const color     = _gameColor(g.gn);
    const emoji     = _gameEmoji(g.gn);
    const activated = g.packs.filter(p => p.status === 'activated');
    const received  = g.packs.filter(p => p.status === 'received');
    const soldOut   = g.packs.filter(p => p.status === 'soldout');
    const removed   = g.packs.filter(p => p.status === 'removed');
    const visible   = [...activated, ...received, ...soldOut, ...removed];
    return `
      <div class="cat-card">
        <div class="cat-card-bar" style="background:${color}"></div>
        <div class="cat-card-hdr">
          <div class="cat-game-dot" style="background:${color}1a">${emoji}</div>
          <div class="cat-game-identity">
            <div class="cat-game-name">${g.gameName}</div>
            <div class="cat-game-num">#${g.gn} · $${parseFloat(g.price).toFixed(2)}/ticket</div>
          </div>
        </div>
        <div class="cat-stock">${_pills(activated, received, soldOut) || '<span class="cat-stock-empty">No books</span>'}</div>
        <div class="stk-packs">${visible.map(p => renderPackRow(p, g.ticketsPerPack, g.gameName, g.price)).join('')}</div>
      </div>`;
  }).join('') + '</div>';
}

function renderLotteryStockByLocation(rows) {
  const el = document.getElementById('lottery-stock-container');
  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No packs in stock</div>'; return;
  }
  const byLoc = {};
  for (const row of rows) {
    const loc = row.location || 'Office';
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(row);
  }

  const allLocs = _sortedAllLocs(byLoc);

  el.innerHTML = '<div class="catalog-grid">' + allLocs.map(loc => {
    const packs = byLoc[loc];
    if (!packs || !packs.length) return '';
    const activatedCt = packs.filter(p => p.status === 'activated').length;
    const receivedCt  = packs.filter(p => p.status === 'received').length;
    const soldOutCt   = packs.filter(p => p.status === 'soldout').length;
    const isStn       = _isStation(loc);
    const isOffice    = loc === 'Office';
    const adminLocked = isOffice && !isAdmin();
    const barColor    = activatedCt ? 'var(--design-green)' : receivedCt ? '#d4a000' : 'var(--ink-30)';
    const recvPill    = adminLocked
      ? `<span class="cat-cnt-pill cp-received" style="filter:blur(4px);user-select:none" aria-hidden="true"><span class="cat-cnt-dot"></span>${receivedCt} received</span>`
      : (receivedCt ? `<span class="cat-cnt-pill cp-received"><span class="cat-cnt-dot"></span>${receivedCt} received</span>` : '');
    const slotCount   = isStn ? _getStationSlotCount(loc) : null;
    const slotPill    = slotCount ? `<span class="cat-cnt-pill" style="background:rgba(99,102,241,.08);color:#4338ca;border:1px solid rgba(99,102,241,.18)"><span class="cat-cnt-dot" style="background:#6366f1"></span>${slotCount} lines</span>` : '';
    const stockHtml   = [
      activatedCt ? `<span class="cat-cnt-pill cp-active"><span class="cat-cnt-dot"></span>${activatedCt} active</span>` : '',
      recvPill,
      soldOutCt   ? `<span class="cat-cnt-pill cp-soldout"><span class="cat-cnt-dot"></span>${soldOutCt} sold out</span>` : '',
      slotPill,
    ].filter(Boolean).join('') || '<span class="cat-stock-empty">Empty</span>';

    const packsHtml = slotCount
      ? _renderStationSlots(loc, packs, slotCount)
      : packs.filter(p => p.status !== 'soldout').sort((a, b) => {
          if (a.station_line == null && b.station_line == null) return 0;
          if (a.station_line == null) return -1;
          if (b.station_line == null) return 1;
          return a.station_line - b.station_line;
        }).map(p => renderPackRowByLoc(p)).join('') +
        (soldOutCt ? `<div class="lottery-soldout-note">${soldOutCt} sold out</div>` : '');

    return `
      <div class="cat-card">
        <div class="cat-card-bar" style="background:${barColor}"></div>
        <div class="cat-card-hdr">
          <div class="cat-game-dot" style="background:${barColor}1a">${isStn ? '🏪' : '📦'}</div>
          <div class="cat-game-identity">
            <div class="cat-game-name">${loc}</div>
            <div class="cat-game-num"><span class="stk-type-tag">${isStn ? 'Station' : 'Staging'}</span></div>
          </div>
        </div>
        <div class="cat-stock">${stockHtml}</div>
        <div class="stk-packs">${packsHtml}</div>
      </div>`;
  }).join('') + '</div>';
}

function _renderStationSlots(loc, packs, slotCount) {
  const activated = packs.filter(p => p.status === 'activated');
  const received  = packs.filter(p => p.status === 'received');

  // Map assigned lines → pack; collect unslotted activated books separately
  const packByLine = {};
  const unslotted  = [];
  for (const p of activated) {
    if (p.station_line != null) packByLine[p.station_line] = p;
    else unslotted.push(p);
  }

  let html = '';
  for (let i = 1; i <= slotCount; i++) {
    const p = packByLine[i];
    if (p) {
      html += renderPackRowByLoc(p);
    } else {
      html += `
        <div class="lottery-stock-book slot-empty-row">
          <div class="pack-line-btn pack-line-slot-empty">${i}</div>
          <div class="lottery-book-body" style="flex:1">
            <div class="lottery-book-info"><span class="slot-empty-text">— Unassigned</span></div>
          </div>
        </div>`;
    }
  }

  if (unslotted.length) {
    html += `<div class="slot-section-header">No line assigned</div>`;
    for (const p of unslotted) html += renderPackRowByLoc(p);
  }

  if (received.length) {
    html += `<div class="slot-section-header">In stock</div>`;
    for (const p of received) html += renderPackRowByLoc(p);
  }

  return html;
}

// ===== SHIFT CLOSE MODAL =====

async function openShiftClose(type) {
  _pendingShiftType = type;

  if (_dbCaps.hasFullDayTracking) {
    if (!_currentDay) { showError('No day open', 'Open a day before closing.'); return; }
    if (type === 'shift' && !_currentShift) { showError('No shift open', 'Open a shift first.'); return; }
  }

  const isDay = type === 'day';
  document.getElementById('shift-modal-title').textContent = isDay ? 'Day Close' : 'Shift Close';
  const confirmBtn = document.getElementById('shift-confirm-btn');
  if (confirmBtn) {
    confirmBtn.textContent   = isDay ? 'Confirm Day Close' : 'Confirm Shift Close';
    confirmBtn.style.background  = isDay ? 'var(--amber-text)'   : '';
    confirmBtn.style.borderColor = isDay ? 'var(--amber-border)' : '';
  }
  // Show open time
  const timeEl = document.getElementById('shift-modal-time');
  if (timeEl) {
    const ref = isDay ? _currentDay : _currentShift;
    if (ref?.opened_at) {
      const d = new Date(ref.opened_at);
      const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      timeEl.textContent = `Opened ${date} · ${time}`;
    } else {
      timeEl.textContent = '';
    }
  }
  // Clear notes
  const notesEl = document.getElementById('shift-notes-input');
  if (notesEl) notesEl.value = '';

  const select = _dbCaps.hasLoadingDirection
    ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,station_line,lottery_games(game_name,price,tickets_per_pack)`
    : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,station_line,lottery_games(game_name,price,tickets_per_pack)`;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${select}&status=eq.activated&order=location.asc,pack_number.asc`
    );
    const rows = await res.json();
    _shiftCloseEntries = rows;
    renderShiftCloseModal(rows);
    document.getElementById('shift-modal').classList.add('open');
  } catch (e) { showError('Load failed', e.message); }
}

function closeShiftModal() {
  document.getElementById('shift-modal').classList.remove('open');
}

function renderShiftCloseModal(rows) {
  const bodyEl = document.getElementById('shift-modal-body');
  if (!rows.length) {
    bodyEl.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No active books to close</div>'; return;
  }
  const byLoc = {};
  for (const r of rows) { const loc = r.location || 'Office'; if (!byLoc[loc]) byLoc[loc] = []; byLoc[loc].push(r); }
  let html = '';
  for (const loc of _sortedAllLocs(byLoc)) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;
    html += `<div class="shift-loc-section"><div class="shift-loc-header">${loc}</div>`;
    for (const p of packs) {
      const game       = p.lottery_games || {};
      const price      = parseFloat(game.price || 0);
      const tpp        = game.tickets_per_pack || 0;
      const lastTicket = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const dir        = (p.loading_direction || 'asc').toLowerCase();
      html += `
        <div class="shift-entry-row" data-id="${p.id}">
          <div class="shift-entry-name">
            ${game.game_name || `Game #${p.game_number}`}
            <span class="item-badge lottery-price-badge" style="font-size:10px">$${price.toFixed(2)}</span>
            <span style="font-size:11px;font-weight:400;color:var(--text-muted)">#${p.pack_number}</span>
            ${_dirPill(dir)}
          </div>
          <div class="shift-entry-inputs">
            <span class="shift-entry-open-lbl">At #${lastTicket}</span>
            <span class="shift-entry-arrow">→</span>
            <label class="shift-entry-open-lbl">Now #<input type="number" class="shift-ticket-input"
              id="shift-ticket-${p.id}" value="${p.start_ticket}" min="0" max="${tpp}"
              oninput="updateShiftCalc('${p.id}',${price},${lastTicket},'${dir}')" /></label>
          </div>
          <div id="shift-calc-${p.id}" class="shift-entry-calc"></div>
        </div>`;
    }
    html += '</div>';
  }
  html += `<div class="shift-total-row"><span>Total: <strong id="shift-total-tickets">0</strong> tickets sold</span><span class="shift-total-rev" id="shift-total-revenue">$0.00</span></div>`;
  bodyEl.innerHTML = html;
  for (const p of rows) {
    const price      = parseFloat(p.lottery_games?.price || 0);
    const lastTicket = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const dir        = (p.loading_direction || 'asc').toLowerCase();
    updateShiftCalc(p.id, price, lastTicket, dir);
  }
}

function _soldTickets(current, last, dir) {
  return (dir || 'asc') === 'desc' ? Math.max(0, last - current) : Math.max(0, current - last);
}

function updateShiftCalc(id, price, lastTicket, dir) {
  const inp    = document.getElementById(`shift-ticket-${id}`);
  const calcEl = document.getElementById(`shift-calc-${id}`);
  if (!inp || !calcEl) return;
  const sold = _soldTickets(parseInt(inp.value, 10) || 0, lastTicket, dir);
  calcEl.textContent = sold > 0 ? `${sold} tickets · $${(sold * price).toFixed(2)}` : '—';
  recalcShiftTotals();
}

function recalcShiftTotals() {
  let totalSold = 0, totalRev = 0;
  for (const p of _shiftCloseEntries) {
    const inp = document.getElementById(`shift-ticket-${p.id}`);
    if (!inp) continue;
    const last  = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const dir   = (p.loading_direction || 'asc').toLowerCase();
    const sold  = _soldTickets(parseInt(inp.value, 10) || 0, last, dir);
    totalSold  += sold;
    totalRev   += sold * parseFloat(p.lottery_games?.price || 0);
  }
  const tEl = document.getElementById('shift-total-tickets');
  const rEl = document.getElementById('shift-total-revenue');
  if (tEl) tEl.textContent = totalSold;
  if (rEl) rEl.textContent = `$${totalRev.toFixed(2)}`;
}

async function confirmShiftClose(e) {
  if (e) e.preventDefault();
  if (_shiftOpInProgress) { showError('Busy', 'A shift operation is already in progress. Please wait and try again.'); return; }
  _shiftOpInProgress = true;
  const confirmBtn = document.getElementById('shift-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    // Build entries from modal inputs
    const notes = (document.getElementById('shift-notes-input')?.value || '').trim() || null;
    const entries = [];
    let totalSold = 0, totalRev = 0;
    for (const p of _shiftCloseEntries) {
      const inp         = document.getElementById(`shift-ticket-${p.id}`);
      const currentTick = inp ? (parseInt(inp.value, 10) || p.start_ticket) : p.start_ticket;
      const lastTicket  = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const price       = parseFloat(p.lottery_games?.price || 0);
      const dir         = (p.loading_direction || 'asc').toLowerCase();
      const sold        = _soldTickets(currentTick, lastTicket, dir);
      const revenue     = sold * price;
      totalSold += sold; totalRev += revenue;
      entries.push({ pack_id: p.id, tickets_sold: sold, revenue, ticket_at_open: lastTicket, ticket_at_close: currentTick, station_line: p.station_line ?? null });
    }

    // Create or update shift record
    let shiftId;
    if (_dbCaps.hasFullDayTracking && _currentShift) {
      shiftId = _currentShift.id;
      await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?id=eq.${shiftId}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'closed', closed_at: new Date().toISOString(),
            total_tickets_sold: totalSold, total_revenue: totalRev,
            ...(notes ? { notes } : {}) }) });
    } else {
      // Legacy mode: create shift record on close (auto-ensure means this is only
      // reached in non-day-tracking mode; opened_at uses the day open time as a fallback).
      const extraFields = (_dbCaps.hasFullDayTracking && _currentDay) ? { day_id: _currentDay.id } : {};
      const fallbackOpenedAt = _currentDay?.opened_at || new Date().toISOString();
      const shiftRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ shift_type: _pendingShiftType,
            opened_at: fallbackOpenedAt, closed_at: new Date().toISOString(), status: 'closed',
            total_tickets_sold: totalSold, total_revenue: totalRev,
            ...(notes ? { notes } : {}), ...extraFields }) });
      const shifts = await shiftRes.json();
      shiftId = Array.isArray(shifts) && shifts[0] ? shifts[0].id : null;
    }

    // Insert entries
    if (shiftId && entries.length) {
      await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(entries.map(en => ({ ...en, shift_id: shiftId }))) });
    }

    // Update pack baselines
    await Promise.all(_shiftCloseEntries.map(p => {
      const inp         = document.getElementById(`shift-ticket-${p.id}`);
      const currentTick = inp ? (parseInt(inp.value, 10) || p.start_ticket) : p.start_ticket;
      return sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(p.id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ start_ticket: currentTick, last_shift_ticket: currentTick }) });
    }));

    // Update day/shift state
    if (_dbCaps.hasFullDayTracking) {
      _currentShift = null;
      if (_pendingShiftType === 'day' && _currentDay) {
        // Sum all OTHER closed shifts (exclude the just-closed one, already in totalSold/totalRev)
        const dShiftsRes = await sbFetch(
          `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${_currentDay.id}&id=neq.${shiftId}&status=eq.closed&select=total_tickets_sold,total_revenue`
        );
        const dShifts  = await dShiftsRes.json();
        const otherTotals = (Array.isArray(dShifts) ? dShifts : []).reduce(
          (acc, s) => ({ tickets: acc.tickets + (s.total_tickets_sold || 0), revenue: acc.revenue + parseFloat(s.total_revenue || 0) }),
          { tickets: 0, revenue: 0 }
        );
        const dayTotals = { tickets: otherTotals.tickets + totalSold, revenue: otherTotals.revenue + totalRev };
        await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days?id=eq.${_currentDay.id}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'closed', closed_at: new Date().toISOString(),
              total_tickets_sold: dayTotals.tickets, total_revenue: dayTotals.revenue }) });
        _currentDay = null;
      }
    }

    closeShiftModal();
    updateDayShiftButtons();
    await Promise.all([loadLotteryStock(), loadShiftHistory()]);
    loadLotteryDbStats();
  } catch (err) {
    showError('Close failed', err.message);
    _logSystemEvent('error', { notes: `Shift close failed: ${err.message}` });
  } finally { if (confirmBtn) confirmBtn.disabled = false; _shiftOpInProgress = false; }
}

