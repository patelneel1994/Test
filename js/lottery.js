// ===== LOTTERY MODULE =====

// ---- State ----
let _lotterySession      = [];
let _currentLotteryParse = null;
let _lotteryEventsReady  = false;
let _stockViewMode       = 'game';
let _cachedStockRows     = null;
let _shiftCloseEntries   = [];
let _pendingActivation   = null;
let _actDir              = 'asc';
let _actType             = 'full';
let _pendingShiftType    = 'shift';
let _currentDay          = null;
let _currentShift        = null;
let _dbCapsChecked       = false;
const _dbCaps            = { hasLoadingDirection: false, hasFullDayTracking: false };
const _packInfoCache     = {};

// ---- Inventory state ----
let _invContext     = null;   // 'open-day' | 'open-shift' | 'close-shift' | 'close-day'
let _invPacks       = [];     // active packs for this inventory session
let _invData        = {};     // pack_id → ticket number
let _invScanCleanup = null;   // teardown function for scan input listeners

// ===== DB CAPABILITIES CHECK =====
// Run once; determines which columns/tables exist so queries don't crash.
async function checkDbCapabilities() {
  if (_dbCapsChecked) return;
  _dbCapsChecked = true;
  try {
    const [lRes, dRes, sRes] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=loading_direction&limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days?limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?select=day_id,opened_at,status&limit=0`),
    ]);
    _dbCaps.hasLoadingDirection = lRes.ok;
    _dbCaps.hasFullDayTracking  = dRes.ok && sRes.ok;
  } catch (_) {}
}

// ===== INVENTORY SCAN =====

const _INV_OPTIONAL = new Set(['open-day']);
const _INV_TITLES   = {
  'open-day':    'Day Open — Inventory Check',
  'open-shift':  'Shift Start — Inventory (Required)',
  'close-shift': 'Shift End — Inventory (Required)',
  'close-day':   'Day Close — Inventory (Required)',
};

async function openInventory(context) {
  if (_dbCaps.hasFullDayTracking) {
    if ((context === 'open-shift' || context.startsWith('close')) && !_currentDay) {
      showError('No day open', 'Open a day first.'); return;
    }
    if (context === 'open-shift' && _currentShift)  { showError('Shift already open', 'Close the current shift first.'); return; }
    if (context === 'close-shift' && !_currentShift) { showError('No shift open', 'Open a shift first.'); return; }
  }

  _invContext = context;
  _invData    = {};
  const isClose    = context.startsWith('close');
  const isOptional = _INV_OPTIONAL.has(context);

  document.getElementById('inv-modal-title').textContent     = _INV_TITLES[context] || 'Inventory';
  document.getElementById('inv-skip-btn').style.display      = isOptional ? '' : 'none';
  document.getElementById('inv-totals-row').style.display    = isClose    ? '' : 'none';
  const confirmLbl = { 'open-day':'Open Day', 'open-shift':'Open Shift', 'close-shift':'Confirm Shift Close', 'close-day':'Confirm Day Close' };
  document.getElementById('inv-confirm-btn').textContent = confirmLbl[context] || 'Confirm';

  const listEl = document.getElementById('inv-book-list');
  listEl.innerHTML = '<div class="summary-loading">Loading…</div>';
  document.getElementById('inventory-modal').classList.add('open');

  try {
    const sel = _dbCaps.hasLoadingDirection
      ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)`
      : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)`;
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&status=eq.activated&order=location.asc,pack_number.asc&limit=200`
    );
    const packs = await res.json();
    _invPacks = Array.isArray(packs) ? packs : [];
    _renderInvList();
    _updateInvProgress();
  } catch (err) {
    listEl.innerHTML = `<div class="item-nf-sub">Load failed: ${err.message}</div>`;
  }

  // Wire up scan input
  const scanInp = document.getElementById('inv-scan-input');
  scanInp.value = '';
  if (_invScanCleanup) _invScanCleanup();
  const onKey   = e => { if (e.key === 'Enter') { e.preventDefault(); const v = scanInp.value.trim(); if (v) _handleInvBarcode(v); } };
  const onPaste = () => setTimeout(() => { const v = scanInp.value.trim(); if (v) _handleInvBarcode(v); }, 50);
  scanInp.addEventListener('keydown', onKey);
  scanInp.addEventListener('paste', onPaste);
  _invScanCleanup = () => { scanInp.removeEventListener('keydown', onKey); scanInp.removeEventListener('paste', onPaste); };
  setTimeout(() => scanInp.focus(), 120);
}

function closeInventoryModal() {
  document.getElementById('inventory-modal').classList.remove('open');
  if (_invScanCleanup) { _invScanCleanup(); _invScanCleanup = null; }
  _invContext = null; _invPacks = []; _invData = {};
}

function _renderInvList() {
  const el      = document.getElementById('inv-book-list');
  const isClose = _invContext && _invContext.startsWith('close');
  const isOpenDay = _invContext === 'open-day';

  if (!_invPacks.length) {
    el.innerHTML = '<div class="log-empty" style="border:none;padding:8px 0">No active books — proceed.</div>';
    return;
  }

  const locOrder = ['Station Booth', 'Front - Extra', 'Office'];
  const byLoc = {};
  for (const p of _invPacks) {
    const loc = p.location || 'Office';
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(p);
  }

  let html = '';
  for (const loc of locOrder) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;
    html += `<div class="shift-loc-section"><div class="shift-loc-header">${loc}</div>`;
    for (const p of packs) {
      const game     = p.lottery_games || {};
      const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const hasVal   = p.id in _invData;
      const scanned  = _invData[p.id];
      // Discrepancy for open-day: scanned ticket differs from baseline
      let discHtml = '';
      if (isOpenDay && hasVal && scanned !== baseline) {
        const dir  = (p.loading_direction || 'asc').toLowerCase();
        const diff = dir === 'desc' ? (baseline - scanned) : (scanned - baseline);
        const isLoss = diff > 0;
        discHtml = `<div class="inv-disc ${isLoss ? 'inv-disc-warn' : 'inv-disc-ok'}">
          Expected #${baseline} — got #${scanned}${isLoss ? ` · ⚠ ${diff} ticket${diff !== 1 ? 's' : ''} unaccounted` : ' · OK'}
        </div>`;
      }
      html += `
        <div class="inv-book-row${hasVal ? ' inv-scanned' : ''}" id="inv-row-${p.id}">
          <div class="inv-status" id="inv-status-${p.id}">${hasVal ? '✓' : '○'}</div>
          <div class="inv-book-main">
            <div class="inv-book-name">${game.game_name || `Game #${p.game_number}`}
              <span class="inv-book-num">#${p.pack_number}</span>
            </div>
            <div class="inv-book-meta">${isClose ? `Was #${baseline}` : `Last at #${baseline}`}</div>
            ${discHtml}
            <div class="inv-book-calc" id="inv-calc-${p.id}"></div>
          </div>
          <input type="number" class="shift-ticket-input" id="inv-inp-${p.id}"
            value="${hasVal ? scanned : ''}" placeholder="#"
            min="0" oninput="_handleInvManual('${p.id}')" />
        </div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;

  if (isClose) {
    for (const p of _invPacks) { if (p.id in _invData) _updateInvCalc(p.id); }
    _updateInvTotals();
  }
}

function _handleInvBarcode(raw) {
  const scanInp = document.getElementById('inv-scan-input');
  if (scanInp) scanInp.value = '';
  const parsed = parseLotteryBarcode(raw);
  if (!parsed) {
    _flashInvScanError(); return;
  }
  const pack = _invPacks.find(p => p.game_number === parsed.gameNumber && p.pack_number === parsed.packNumber);
  if (!pack) { _flashInvScanError('Book not in active list'); return; }

  _invData[pack.id] = parsed.ticketPosition;
  const inp = document.getElementById(`inv-inp-${pack.id}`);
  if (inp) inp.value = parsed.ticketPosition;

  // Re-render row to pick up discrepancy display
  const isClose   = _invContext && _invContext.startsWith('close');
  const isOpenDay = _invContext === 'open-day';
  const row = document.getElementById(`inv-row-${pack.id}`);
  const st  = document.getElementById(`inv-status-${pack.id}`);
  if (row) row.classList.add('inv-scanned');
  if (st)  st.textContent = '✓';

  // Show discrepancy inline
  if (isOpenDay) {
    const baseline = pack.last_shift_ticket != null ? pack.last_shift_ticket : pack.start_ticket;
    const calcEl   = document.getElementById(`inv-calc-${pack.id}`);
    const dir      = (pack.loading_direction || 'asc').toLowerCase();
    const diff     = dir === 'desc' ? (baseline - parsed.ticketPosition) : (parsed.ticketPosition - baseline);
    // Find/create disc element inside row
    let discEl = row ? row.querySelector('.inv-disc') : null;
    if (!discEl && row) {
      discEl = document.createElement('div');
      const mainDiv = row.querySelector('.inv-book-main');
      if (mainDiv && calcEl) mainDiv.insertBefore(discEl, calcEl);
    }
    if (discEl) {
      if (parsed.ticketPosition !== baseline) {
        const isLoss = diff > 0;
        discEl.className = `inv-disc ${isLoss ? 'inv-disc-warn' : 'inv-disc-ok'}`;
        discEl.textContent = isLoss
          ? `Expected #${baseline} — got #${parsed.ticketPosition} · ⚠ ${diff} ticket${diff !== 1 ? 's' : ''} unaccounted`
          : `Expected #${baseline} — got #${parsed.ticketPosition} · OK`;
      } else {
        discEl.className = 'inv-disc inv-disc-ok';
        discEl.textContent = `Matches last close ✓`;
      }
    }
  }

  if (isClose) _updateInvCalc(pack.id);
  _updateInvProgress();
  if (navigator.vibrate) navigator.vibrate(30);

  const next = document.querySelector('.inv-book-row:not(.inv-scanned)');
  if (next) next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (scanInp) scanInp.focus();
}

function _flashInvScanError(msg) {
  const scanInp = document.getElementById('inv-scan-input');
  if (scanInp) {
    scanInp.placeholder = msg || 'Not found — try again';
    scanInp.classList.add('inv-scan-err');
    setTimeout(() => {
      scanInp.classList.remove('inv-scan-err');
      scanInp.placeholder = 'Scan a ticket to record its position…';
    }, 700);
  }
  if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
}

function _handleInvManual(packId) {
  const inp = document.getElementById(`inv-inp-${packId}`);
  if (!inp) return;
  const val = parseInt(inp.value, 10);
  if (!isNaN(val) && val >= 0) {
    _invData[packId] = val;
    const row = document.getElementById(`inv-row-${packId}`);
    const st  = document.getElementById(`inv-status-${packId}`);
    if (row) row.classList.add('inv-scanned');
    if (st)  st.textContent = '✓';
  } else {
    delete _invData[packId];
    const row = document.getElementById(`inv-row-${packId}`);
    const st  = document.getElementById(`inv-status-${packId}`);
    if (row) row.classList.remove('inv-scanned');
    if (st)  st.textContent = '○';
  }
  if (_invContext && _invContext.startsWith('close')) { _updateInvCalc(packId); _updateInvTotals(); }
  _updateInvProgress();
}

function _updateInvCalc(packId) {
  const p      = _invPacks.find(x => x.id === packId);
  const calcEl = document.getElementById(`inv-calc-${packId}`);
  if (!p || !calcEl || !(packId in _invData)) { if (calcEl) calcEl.textContent = ''; return; }
  const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
  const dir      = (p.loading_direction || 'asc').toLowerCase();
  const price    = parseFloat(p.lottery_games?.price || 0);
  const sold     = _soldTickets(_invData[packId], baseline, dir);
  calcEl.textContent = sold > 0 ? `→ ${sold} sold · $${(sold * price).toFixed(2)}` : '→ no change';
}

function _updateInvTotals() {
  let totalSold = 0, totalRev = 0;
  for (const p of _invPacks) {
    if (!(p.id in _invData)) continue;
    const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const dir      = (p.loading_direction || 'asc').toLowerCase();
    const price    = parseFloat(p.lottery_games?.price || 0);
    const sold = _soldTickets(_invData[p.id], baseline, dir);
    totalSold += sold;
    totalRev  += sold * price;
  }
  const tEl = document.getElementById('inv-total-tickets');
  const rEl = document.getElementById('inv-total-revenue');
  if (tEl) tEl.textContent = totalSold;
  if (rEl) rEl.textContent = `$${totalRev.toFixed(2)}`;
}

function _updateInvProgress() {
  const total = _invPacks.length;
  const done  = Object.keys(_invData).length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 100;

  const fillEl  = document.getElementById('inv-progress-fill');
  const doneEl  = document.getElementById('inv-done-count');
  const totEl   = document.getElementById('inv-total-count');
  const todoLbl = document.getElementById('inv-todo-label');
  const todoCt  = document.getElementById('inv-todo-count');
  if (fillEl)  fillEl.style.width   = pct + '%';
  if (doneEl)  doneEl.textContent   = done;
  if (totEl)   totEl.textContent    = total;
  if (todoLbl) todoLbl.style.display = done >= total ? 'none' : '';
  if (todoCt)  todoCt.textContent   = total - done;

  const confirmBtn = document.getElementById('inv-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = !_INV_OPTIONAL.has(_invContext) && done < total && total > 0;
}

async function confirmInventory(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('inv-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    if (_invContext === 'open-day')    await _invCommitOpenDay();
    else if (_invContext === 'open-shift')  await _invCommitOpenShift();
    else if (_invContext === 'close-shift') await _invCommitClose('shift');
    else if (_invContext === 'close-day')   await _invCommitClose('day');
    closeInventoryModal();
  } catch (err) {
    showError('Failed', err.message);
    if (btn) btn.disabled = false;
  }
}

function skipInventory() {
  // Optional only (open-day). Proceed with whatever was scanned so far.
  const ctx   = _invContext;
  const packs = [..._invPacks];
  const data  = { ..._invData };
  closeInventoryModal();
  if (ctx === 'open-day') {
    _invContext = ctx; _invPacks = packs; _invData = data;
    _invCommitOpenDay().finally(() => { _invContext = null; _invPacks = []; _invData = {}; });
  }
}

async function _invCommitOpenDay() {
  const dayRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'open' }) });
  const days = await dayRes.json();
  _currentDay = Array.isArray(days) && days[0] ? days[0] : null;
  _currentShift = null;
  if (Object.keys(_invData).length) {
    await Promise.all(Object.entries(_invData).map(([id, ticket]) =>
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ start_ticket: ticket, last_shift_ticket: ticket }) })));
  }
  updateDayShiftButtons();
  await loadLotteryStock();
}

async function _invCommitOpenShift() {
  if (!_currentDay) { showError('No day open', 'Open a day first.'); return; }
  if (Object.keys(_invData).length) {
    await Promise.all(Object.entries(_invData).map(([id, ticket]) =>
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ start_ticket: ticket, last_shift_ticket: ticket }) })));
  }
  const res = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ day_id: _currentDay.id, shift_type: 'shift',
        opened_at: new Date().toISOString(), status: 'open', total_tickets_sold: 0, total_revenue: 0 }) });
  const shifts = await res.json();
  _currentShift = Array.isArray(shifts) && shifts[0] ? shifts[0] : null;
  updateDayShiftButtons();
  await loadLotteryStock();
}

async function _invCommitClose(type) {
  const entries = [];
  let totalSold = 0, totalRev = 0;
  for (const p of _invPacks) {
    const currentTick = _invData[p.id] != null ? _invData[p.id] : p.start_ticket;
    const lastTicket  = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const price       = parseFloat(p.lottery_games?.price || 0);
    const dir         = (p.loading_direction || 'asc').toLowerCase();
    const sold        = _soldTickets(currentTick, lastTicket, dir);
    const revenue     = sold * price;
    totalSold += sold; totalRev += revenue;
    entries.push({ pack_id: p.id, tickets_sold: sold, revenue, ticket_at_open: lastTicket, ticket_at_close: currentTick });
  }

  let shiftId;
  if (_dbCaps.hasFullDayTracking && _currentShift) {
    shiftId = _currentShift.id;
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?id=eq.${shiftId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'closed', closed_at: new Date().toISOString(),
          total_tickets_sold: totalSold, total_revenue: totalRev }) });
  } else {
    const extraFields = (_dbCaps.hasFullDayTracking && _currentDay) ? { day_id: _currentDay.id } : {};
    const shiftRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ shift_type: type, status: 'closed', closed_at: new Date().toISOString(),
          total_tickets_sold: totalSold, total_revenue: totalRev, ...extraFields }) });
    const shifts = await shiftRes.json();
    shiftId = Array.isArray(shifts) && shifts[0] ? shifts[0].id : null;
  }

  if (shiftId && entries.length) {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(entries.map(en => ({ ...en, shift_id: shiftId }))) });
  }

  await Promise.all(_invPacks.map(p => {
    const tick = _invData[p.id] != null ? _invData[p.id] : p.start_ticket;
    return sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(p.id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ start_ticket: tick, last_shift_ticket: tick }) });
  }));

  _currentShift = null;
  if (type === 'day' && _currentDay) {
    const dShiftsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${_currentDay.id}&select=total_tickets_sold,total_revenue`
    );
    const dShifts   = await dShiftsRes.json();
    const dayTotals = (Array.isArray(dShifts) ? dShifts : []).reduce(
      (acc, s) => ({ tickets: acc.tickets + (s.total_tickets_sold || 0), revenue: acc.revenue + parseFloat(s.total_revenue || 0) }),
      { tickets: 0, revenue: 0 }
    );
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days?id=eq.${_currentDay.id}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'closed', closed_at: new Date().toISOString(),
          total_tickets_sold: dayTotals.tickets, total_revenue: dayTotals.revenue }) });
    _currentDay = null;
  }
  updateDayShiftButtons();
  await Promise.all([loadLotteryStock(), loadShiftHistory()]);
  loadLotteryDbStats();
}

// ===== DAY / SHIFT STATE =====

async function loadCurrentDayShift() {
  if (!_dbCaps.hasFullDayTracking) { updateDayShiftButtons(); return; }
  try {
    const dRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_days?status=eq.open&order=opened_at.desc&limit=1`
    );
    const days = await dRes.json();
    _currentDay = Array.isArray(days) && days[0] ? days[0] : null;

    if (_currentDay) {
      const sRes = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${_currentDay.id}&status=eq.open&order=opened_at.desc&limit=1`
      );
      const shifts = await sRes.json();
      _currentShift = Array.isArray(shifts) && shifts[0] ? shifts[0] : null;
    } else {
      _currentShift = null;
    }
  } catch (_) { _currentDay = null; _currentShift = null; }
  updateDayShiftButtons();
}

function updateDayShiftButtons() {
  const el = document.getElementById('day-shift-btns');
  if (!el) return;

  if (!_dbCaps.hasFullDayTracking) {
    // Legacy: DB migration not yet run — just show close buttons
    el.innerHTML = `
      <button class="log-act-btn" onclick="openShiftClose('shift')">Shift Close</button>
      <button class="log-act-btn log-act-day" onclick="openShiftClose('day')">Day Close</button>`;
    return;
  }

  if (!_currentDay) {
    el.innerHTML = `<button class="log-act-btn log-act-day" onclick="openInventory('open-day')">Open Day</button>`;
  } else if (!_currentShift) {
    el.innerHTML = `
      <span class="day-status-badge day-status-day">Day Open</span>
      <button class="log-act-btn" onclick="openInventory('open-shift')">Open Shift</button>
      <button class="log-act-btn log-act-day" onclick="openInventory('close-day')">Close Day</button>`;
  } else {
    el.innerHTML = `
      <span class="day-status-badge day-status-shift">Shift Open</span>
      <button class="log-act-btn" onclick="openInventory('close-shift')">Close Shift</button>
      <button class="log-act-btn log-act-day" onclick="openInventory('close-day')">Close Day</button>`;
  }
}

// ===== OPEN DAY =====

async function showOpenDayModal() {
  const body = document.getElementById('day-open-body');
  body.innerHTML = '<div class="summary-loading">Loading…</div>';
  document.getElementById('day-open-modal').classList.add('open');

  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs` +
      `?select=id,pack_number,start_ticket,last_shift_ticket,location,lottery_games(game_name,price)` +
      `&status=eq.activated&order=location.asc&limit=200`
    );
    const packs = await res.json();
    _dayOpenPacks = Array.isArray(packs) ? packs : [];

    if (!_dayOpenPacks.length) {
      body.innerHTML = '<div class="log-empty" style="border:none;padding:8px 0">No active books — day will open immediately.</div>';
      return;
    }

    const locOrder = ['Station Booth', 'Front - Extra', 'Office'];
    const byLoc    = {};
    for (const p of _dayOpenPacks) {
      const loc = p.location || 'Office';
      if (!byLoc[loc]) byLoc[loc] = [];
      byLoc[loc].push(p);
    }

    let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Confirm starting ticket # for each active book (pre-filled from last close).</div>';
    for (const loc of locOrder) {
      const ps = byLoc[loc];
      if (!ps || !ps.length) continue;
      html += `<div class="shift-loc-section"><div class="shift-loc-header">${loc}</div>`;
      for (const p of ps) {
        const game     = p.lottery_games || {};
        const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
        html += `
          <div class="shift-entry-row">
            <div class="shift-entry-name">
              ${game.game_name || `Book`}
              <span style="font-size:11px;font-weight:400;color:var(--text-muted)">#${p.pack_number}</span>
            </div>
            <div class="shift-entry-inputs">
              <span class="shift-entry-open-lbl">Opening at #</span>
              <input type="number" class="shift-ticket-input" id="day-open-ticket-${p.id}"
                value="${baseline}" min="0" />
            </div>
          </div>`;
      }
      html += '</div>';
    }
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="item-nf-sub">Load failed: ${err.message}</div>`;
  }
}

function closeOpenDayModal() {
  document.getElementById('day-open-modal').classList.remove('open');
}

async function confirmOpenDay(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('day-open-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    // Create the day record
    const dayRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_days`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ status: 'open' }) }
    );
    const days = await dayRes.json();
    _currentDay   = Array.isArray(days) && days[0] ? days[0] : null;
    _currentShift = null;

    // Update each pack's baseline to the entered starting position
    if (_dayOpenPacks.length) {
      await Promise.all(_dayOpenPacks.map(p => {
        const inp = document.getElementById(`day-open-ticket-${p.id}`);
        const val = inp ? (parseInt(inp.value, 10) || p.start_ticket) : p.start_ticket;
        return sbFetch(
          `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(p.id)}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ start_ticket: val, last_shift_ticket: val }) }
        );
      }));
    }
    closeOpenDayModal();
    updateDayShiftButtons();
    await loadLotteryStock();
  } catch (err) {
    showError('Open day failed', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ===== OPEN SHIFT =====

async function doOpenShift() {
  if (!_currentDay) { showError('No day open', 'Please open a day first.'); return; }
  if (_currentShift) { showError('Shift already open', 'Close the current shift first.'); return; }
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ day_id: _currentDay.id, shift_type: 'shift',
          opened_at: new Date().toISOString(), status: 'open', total_tickets_sold: 0, total_revenue: 0 }) }
    );
    const shifts = await res.json();
    _currentShift = Array.isArray(shifts) && shifts[0] ? shifts[0] : null;
    updateDayShiftButtons();
  } catch (err) { showError('Open shift failed', err.message); }
}

// ===== BARCODE PARSER =====
// TN Lottery ITF-14: 14 digits = 13-digit ticket + check digit (discarded).
function parseLotteryBarcode(raw) {
  const clean = raw.replace(/[^0-9]/g, '');
  if (clean.length === 14) {
    return { raw, clean,
      gameNumber: clean.slice(0,4), packNumber: clean.slice(4,10),
      ticketPosition: parseInt(clean.slice(10,13),10),
      formatted: `${clean.slice(0,4)}-${clean.slice(4,10)}-${clean.slice(10,13)}` };
  }
  if (clean.length === 13) {
    return { raw, clean,
      gameNumber: clean.slice(0,4), packNumber: clean.slice(4,10),
      ticketPosition: parseInt(clean.slice(10),10),
      formatted: `${clean.slice(0,4)}-${clean.slice(4,10)}-${clean.slice(10)}` };
  }
  if (clean.length === 12) {
    return { raw, clean,
      gameNumber: clean.slice(0,3), packNumber: clean.slice(3,9),
      ticketPosition: parseInt(clean.slice(9),10),
      formatted: `${clean.slice(0,3)}-${clean.slice(3,9)}-${clean.slice(9)}` };
  }
  return null;
}

// ===== RECEIVE =====

function submitLotteryInput() {
  const v = document.getElementById('lottery-input').value.trim();
  if (v) lookupLotteryTicket(v);
}

async function lookupLotteryTicket(raw) {
  const inp = document.getElementById('lottery-input');
  inp.value = '';
  const parsed = parseLotteryBarcode(raw);
  if (!parsed) {
    renderLotteryResult({ type: 'error', msg: `Cannot parse "${raw}" — expected 12–14 digits.` });
    refocusLottery(); return;
  }
  _currentLotteryParse = parsed;
  renderLotteryResult({ type: 'loading' });
  try {
    const game = await fetchLotteryGame(parsed.gameNumber);
    if (!game) { renderLotteryResult({ type: 'no-game', parsed }); return; }
    const pack = await fetchLotteryPack(parsed.gameNumber, parsed.packNumber);
    if (pack) { renderLotteryResult({ type: 'pack-exists', parsed, game, pack }); beepDuplicate(); }
    else       { await doReceivePack(parsed, game); }
  } catch (e) { renderLotteryResult({ type: 'error', msg: e.message }); }
  refocusLottery();
}

async function fetchLotteryGame(gameNumber) {
  const res = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(gameNumber)}&limit=1`);
  const d = await res.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function fetchLotteryPack(gameNumber, packNumber) {
  const res = await sbFetch(
    `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?game_number=eq.${encodeURIComponent(gameNumber)}&pack_number=eq.${encodeURIComponent(packNumber)}&limit=1`
  );
  const d = await res.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function doReceivePack(parsed, game) {
  renderLotteryResult({ type: 'loading' });
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          game_number: parsed.gameNumber, pack_number: parsed.packNumber,
          raw_barcode: parsed.raw, start_ticket: parsed.ticketPosition,
          end_ticket: game.tickets_per_pack - 1, last_shift_ticket: parsed.ticketPosition,
          status: 'received', location: 'Office',
        }) });
    _lotterySession.unshift({
      gameNumber: parsed.gameNumber, packNumber: parsed.packNumber,
      gameName: game.game_name, price: game.price, ticketsPerPack: game.tickets_per_pack,
      startTicket: parsed.ticketPosition, formatted: parsed.formatted, receivedAt: new Date(),
    });
    renderLotteryResult({ type: 'success', parsed, game });
    renderLotteryLog(); renderLotteryStats(); loadLotteryDbStats();
    beepSuccess();
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (e) { renderLotteryResult({ type: 'error', msg: e.message }); }
}

async function submitAddGame(e) {
  if (e) e.preventDefault();
  const name  = (document.getElementById('lg-name').value || '').trim();
  const price = parseFloat(document.getElementById('lg-price').value);
  const tpp   = parseInt(document.getElementById('lg-tpp').value, 10);
  if (!name)                      { showError('Missing field', 'Please enter a game name.'); return; }
  if (isNaN(price) || price <= 0) { showError('Missing field', 'Please enter a valid price.'); return; }
  if (isNaN(tpp)   || tpp   <= 0) { showError('Missing field', 'Please enter tickets per pack.'); return; }
  const parsed = _currentLotteryParse;
  if (!parsed) return;
  renderLotteryResult({ type: 'loading' });
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ game_number: parsed.gameNumber, game_name: name, price, tickets_per_pack: tpp, active: true }) });
    await doReceivePack(parsed, { game_name: name, price, tickets_per_pack: tpp });
  } catch (e) { renderLotteryResult({ type: 'error', msg: e.message }); }
  refocusLottery();
}

function renderLotteryResult(state) {
  const el = document.getElementById('lottery-result');
  if (state.type === 'loading') { el.innerHTML = '<div class="summary-loading" style="padding:16px 0">Looking up…</div>'; return; }
  if (state.type === 'error')   { el.innerHTML = `<div class="item-not-found-card" style="margin-top:12px"><div class="item-nf-title">Error</div><div class="item-nf-sub">${state.msg}</div></div>`; return; }
  if (state.type === 'no-game') {
    const p = state.parsed;
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Game #${p.gameNumber} not in catalog</div>
        <div class="lottery-card-sub">Add this game to receive the pack</div>
        <div class="lottery-card-meta" style="margin-bottom:2px">
          <div><span class="sub-lbl">Pack</span> #${p.packNumber}</div>
          <div style="font-family:monospace">${p.formatted}</div>
        </div>
        <div class="lottery-form">
          <label class="lottery-form-label">Game name</label>
          <input class="modal-input lottery-form-input" id="lg-name" placeholder="e.g. Cashword $1" />
          <div style="display:flex;gap:8px">
            <div style="flex:1"><label class="lottery-form-label">Ticket price ($)</label>
              <input class="modal-input lottery-form-input" id="lg-price" type="number" min="0" step="0.01" placeholder="1.00" /></div>
            <div style="flex:1"><label class="lottery-form-label">Tickets / pack</label>
              <input class="modal-input lottery-form-input" id="lg-tpp" type="number" min="1" placeholder="300" /></div>
          </div>
          <button class="modal-add-btn" style="margin-bottom:0"
            onmousedown="submitAddGame(event)" ontouchstart="submitAddGame(event)">Add Game &amp; Receive Pack</button>
        </div>
      </div>`;
    return;
  }
  if (state.type === 'pack-exists') {
    const { parsed: p, game: g, pack: pk } = state;
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Pack already in system</div>
        <div class="lottery-card-sub">${g.game_name}</div>
        <div class="lottery-card-meta">
          <div><span class="sub-lbl">Pack</span> #${p.packNumber}</div>
          <div><span class="sub-lbl">Status</span> ${pk.status}</div>
          <div><span class="sub-lbl">Received</span> ${new Date(pk.received_at).toLocaleDateString()}</div>
        </div>
      </div>`;
    return;
  }
  if (state.type === 'success') {
    const { parsed: p, game: g } = state;
    const remaining = g.tickets_per_pack - p.ticketPosition;
    const isPartial = p.ticketPosition > 0;
    el.innerHTML = `
      <div class="lottery-card lottery-success" style="margin-top:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div class="success-icon"><svg viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="2 7 6 11 12 3"/></svg></div>
          <div class="lottery-card-title" style="color:var(--green-text)">${isPartial ? 'Partial book received!' : 'Book received!'}</div>
        </div>
        <div class="lottery-card-sub">${g.game_name}</div>
        <div class="lottery-card-meta">
          <div><span class="sub-lbl">Book</span> #${p.packNumber}</div>
          <div><span class="sub-lbl">Starts at</span> #${p.ticketPosition}</div>
          <div><span class="sub-lbl">Remaining</span> ${remaining} tickets</div>
        </div>
      </div>`;
  }
}

function renderLotteryLog() {
  const el = document.getElementById('lottery-log-container');
  if (!_lotterySession.length) { el.innerHTML = '<div class="log-empty">No packs received this session</div>'; return; }
  el.innerHTML = `<div class="log-list">${_lotterySession.map(e => `
    <div class="log-item">
      <div>
        <div class="log-item-name">${e.gameName}</div>
        <div class="log-item-meta">Book #${e.packNumber} · ${e.ticketsPerPack - e.startTicket} tickets (#${e.startTicket}–${e.ticketsPerPack - 1})${e.startTicket > 0 ? ' · partial' : ''}</div>
        <div class="log-item-time">${e.receivedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      <div class="log-right"><span class="item-badge lottery-price-badge">$${parseFloat(e.price).toFixed(2)}</span></div>
    </div>`).join('')}</div>`;
}

function renderLotteryStats() {
  document.getElementById('lottery-stat-session').textContent = _lotterySession.length;
  document.getElementById('lottery-stat-tickets').textContent = _lotterySession.reduce((s, e) => s + e.ticketsPerPack, 0);
}

async function loadLotteryDbStats() {
  try {
    const [pr, ar] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id&limit=1`, { headers: { 'Prefer': 'count=exact' } }),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id&status=eq.activated&limit=1`, { headers: { 'Prefer': 'count=exact' } }),
    ]);
    document.getElementById('lottery-stat-db-packs').textContent = (pr.headers.get('content-range') || '').split('/')[1] || '0';
    document.getElementById('lottery-stat-games').textContent    = (ar.headers.get('content-range') || '').split('/')[1] || '0';
  } catch (_) {}
}

function refocusLottery() {
  setTimeout(() => { const inp = document.getElementById('lottery-input'); if (inp) inp.focus(); }, 50);
}

// ===== STATUS / LOCATION CONFIG =====

const PACK_STATUS = {
  received:  { label: 'Received',  css: 'status-received'  },
  activated: { label: 'Activated', css: 'status-activated' },
  soldout:   { label: 'Sold Out',  css: 'status-soldout'   },
  removed:   { label: 'Removed',   css: 'status-removed'   },
};
const PACK_LOC_CSS = {
  'Office':        'loc-office',
  'Station Booth': 'loc-station',
  'Front - Extra': 'loc-front',
};

async function removePackAtTicket(id, currentTicket, e) {
  if (e) e.preventDefault();
  const val = window.prompt('Remove at ticket #:', String(currentTicket));
  if (val === null) return;
  const ticketNum = parseInt(val, 10);
  if (isNaN(ticketNum) || ticketNum < 0) { showError('Invalid input', 'Enter a valid ticket number.'); return; }
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'removed', start_ticket: ticketNum }) });
    await loadLotteryStock(); loadLotteryDbStats();
  } catch (err) { showError('Remove failed', err.message); }
}

async function updatePackStatus(id, status, location, e) {
  if (e) e.preventDefault();
  const update = { status };
  if (location != null) update.location = location;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(update) });
    await loadLotteryStock(); loadLotteryDbStats();
  } catch (err) { showError('Status update failed', err.message); }
}

// ===== ACTIVATION MODAL =====

function openActivationForm(id, location, e) {
  if (e) e.preventDefault();
  const info = _packInfoCache[id] || {};
  _pendingActivation = { id, location, ticketsPerPack: info.ticketsPerPack || 0 };
  document.getElementById('activation-modal-title').textContent = `Activate → ${location}`;
  const infoEl = document.getElementById('activation-book-info');
  infoEl.innerHTML = info.gameName
    ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">${info.gameName} · Book #${info.packNumber}</div>` : '';
  setActDir('asc');
  if ((info.startTicket || 0) > 0) {
    setActType('partial');
    document.getElementById('act-start-input').value = info.startTicket;
  } else {
    setActType('full');
    document.getElementById('act-start-input').value = '';
  }
  document.getElementById('activation-modal').classList.add('open');
}

function closeActivationModal() {
  document.getElementById('activation-modal').classList.remove('open');
  _pendingActivation = null;
}

function setActDir(dir) {
  _actDir = dir;
  document.getElementById('act-dir-asc-btn').classList.toggle('active', dir === 'asc');
  document.getElementById('act-dir-desc-btn').classList.toggle('active', dir === 'desc');
}

function setActType(type) {
  _actType = type;
  document.getElementById('act-type-full-btn').classList.toggle('active', type === 'full');
  document.getElementById('act-type-partial-btn').classList.toggle('active', type === 'partial');
  document.getElementById('act-start-wrap').style.display = type === 'partial' ? 'block' : 'none';
}

async function confirmActivation(e) {
  if (e) e.preventDefault();
  if (!_pendingActivation) return;
  const { id, location, ticketsPerPack } = _pendingActivation;
  let startTicket;
  if (_actType === 'partial') {
    const val = parseInt(document.getElementById('act-start-input').value, 10);
    if (isNaN(val) || val < 0) { showError('Invalid', 'Enter a valid ticket number.'); return; }
    startTicket = val;
  } else {
    startTicket = _actDir === 'desc' ? Math.max(0, ticketsPerPack - 1) : 0;
  }
  const update = { status: 'activated', location, start_ticket: startTicket, last_shift_ticket: startTicket };
  if (_dbCaps.hasLoadingDirection) update.loading_direction = _actDir;
  const btn = document.getElementById('activation-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(update) });
    closeActivationModal();
    await loadLotteryStock(); loadLotteryDbStats();
  } catch (err) { showError('Activation failed', err.message); }
  finally { if (btn) btn.disabled = false; }
}

// ===== PACK ROW RENDERERS =====

function _packActionHtml(p) {
  if (p.status === 'received') return `
    <button class="pack-act-btn act-station"
      onmousedown="openActivationForm('${p.id}','Station Booth',event)"
      ontouchstart="openActivationForm('${p.id}','Station Booth',event)">Station</button>
    <button class="pack-act-btn act-front"
      onmousedown="openActivationForm('${p.id}','Front - Extra',event)"
      ontouchstart="openActivationForm('${p.id}','Front - Extra',event)">Front</button>`;
  if (p.status === 'activated') return `
    <button class="pack-act-btn act-soldout"
      onmousedown="updatePackStatus('${p.id}','soldout',null,event)"
      ontouchstart="updatePackStatus('${p.id}','soldout',null,event)">Sold Out</button>`;
  return '';
}

function _packRemoveBtn(p) {
  if (p.status === 'activated') return `
    <button class="pack-remove-btn"
      onmousedown="removePackAtTicket('${p.id}',${p.start_ticket},event)"
      ontouchstart="removePackAtTicket('${p.id}',${p.start_ticket},event)" title="Remove">✕</button>`;
  if (p.status === 'received') return `
    <button class="pack-remove-btn"
      onmousedown="updatePackStatus('${p.id}','removed',null,event)"
      ontouchstart="updatePackStatus('${p.id}','removed',null,event)" title="Remove">✕</button>`;
  return '';
}

function renderPackRow(p, ticketsPerPack, gameName) {
  _packInfoCache[p.id] = { ticketsPerPack, gameName: gameName || '', packNumber: p.pack_number, startTicket: p.start_ticket };
  const st      = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const locCss  = PACK_LOC_CSS[p.location] || 'loc-office';
  const isActive = p.status === 'activated';
  const dir     = p.loading_direction;
  const pct     = (isActive && ticketsPerPack > 0) ? Math.round((p.start_ticket / ticketsPerPack) * 100) : 0;
  const dirPill = (isActive && dir) ? `<span class="pack-dir-pill ${dir === 'desc' ? 'dir-desc' : 'dir-asc'}">${dir === 'desc' ? '↓' : '↑'}</span>` : '';
  return `
    <div class="lottery-stock-book">
      <div class="lottery-book-info">
        <span class="lottery-book-label">#${p.pack_number}</span>
        <span class="pack-status-pill ${st.css}">${st.label}</span>
        ${p.location ? `<span class="pack-loc-pill ${locCss}">${p.location}</span>` : ''}
        ${dirPill}
        ${isActive ? `<span class="lottery-book-at">Ticket #${p.start_ticket}</span>` : ''}
      </div>
      ${isActive && ticketsPerPack > 0 ? `<div class="lottery-book-bar-wrap"><div class="lottery-book-bar" style="width:${pct}%"></div></div>` : ''}
      <div class="lottery-book-actions">${_packActionHtml(p)}${_packRemoveBtn(p)}</div>
    </div>`;
}

function renderPackRowByLoc(p) {
  const game   = p.lottery_games || {};
  const gName  = game.game_name || `Game #${p.game_number}`;
  const price  = parseFloat(game.price || 0);
  const tpp    = game.tickets_per_pack || 0;
  _packInfoCache[p.id] = { ticketsPerPack: tpp, gameName: gName, packNumber: p.pack_number, startTicket: p.start_ticket };
  const st      = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const isActive = p.status === 'activated';
  const dir     = p.loading_direction;
  const pct     = (isActive && tpp > 0) ? Math.round((p.start_ticket / tpp) * 100) : 0;
  const dirPill = (isActive && dir) ? `<span class="pack-dir-pill ${dir === 'desc' ? 'dir-desc' : 'dir-asc'}">${dir === 'desc' ? '↓' : '↑'}</span>` : '';
  return `
    <div class="lottery-stock-book">
      <div class="lottery-book-info">
        <span class="lottery-book-label">#${p.pack_number}</span>
        <span class="item-badge lottery-price-badge" style="font-size:10px">$${price.toFixed(2)}</span>
        <span class="pack-status-pill ${st.css}">${st.label}</span>
        ${dirPill}
        ${isActive ? `<span class="lottery-book-at">Ticket #${p.start_ticket}</span>` : ''}
        <span style="font-size:11px;color:var(--text-muted)">${gName}</span>
      </div>
      ${isActive && tpp > 0 ? `<div class="lottery-book-bar-wrap"><div class="lottery-book-bar" style="width:${pct}%"></div></div>` : ''}
      <div class="lottery-book-actions">${_packActionHtml(p)}${_packRemoveBtn(p)}</div>
    </div>`;
}

// ===== STOCK VIEW =====

function setStockView(mode) {
  _stockViewMode = mode;
  document.getElementById('stock-view-game').classList.toggle('active', mode === 'game');
  document.getElementById('stock-view-loc').classList.toggle('active', mode === 'location');
  if (_cachedStockRows) renderLotteryStock(_cachedStockRows);
}

async function loadLotteryStock() {
  const el = document.getElementById('lottery-stock-container');
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  // Only include loading_direction if the column exists
  const select = _dbCaps.hasLoadingDirection
    ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,status,location,lottery_games(game_name,price,tickets_per_pack)`
    : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,status,location,lottery_games(game_name,price,tickets_per_pack)`;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${select}&status=in.(received,activated,soldout)&order=game_number.asc,status.asc,pack_number.asc&limit=500`
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
  if (_stockViewMode === 'location') renderLotteryStockByLocation(rows);
  else renderLotteryStockByGame(rows);
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
      gameName: row.lottery_games?.game_name || `Game #${gn}`,
      price: row.lottery_games?.price || 0,
      ticketsPerPack: row.lottery_games?.tickets_per_pack || 0, packs: [],
    };
    games[gn].packs.push(row);
  }
  const sorted       = Object.values(games).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  const totInStock   = sorted.reduce((s, g) => s + g.packs.filter(p => p.status !== 'soldout').length, 0);
  const totActivated = sorted.reduce((s, g) => s + g.packs.filter(p => p.status === 'activated').length, 0);
  el.innerHTML = `
    <div class="lottery-stock-table">
      ${sorted.map(g => {
        const activated  = g.packs.filter(p => p.status === 'activated');
        const received   = g.packs.filter(p => p.status === 'received');
        const soldOut    = g.packs.filter(p => p.status === 'soldout').length;
        const inStock    = activated.length + received.length;
        return `
          <div class="lottery-stock-game">
            <div class="lottery-stock-row">
              <div class="lottery-stock-name">${g.gameName}
                <span class="item-badge lottery-price-badge">$${parseFloat(g.price).toFixed(2)}</span>
              </div>
              <div class="lottery-stock-packs">${inStock} book${inStock !== 1 ? 's' : ''}</div>
              <div class="lottery-stock-open-pill ${activated.length > 0 ? 'is-open' : ''}">${activated.length} activated</div>
            </div>
            <div class="lottery-stock-books">
              ${[...activated, ...received].map(p => renderPackRow(p, g.ticketsPerPack, g.gameName)).join('')}
              ${soldOut > 0 ? `<div class="lottery-soldout-note">${soldOut} sold out</div>` : ''}
            </div>
          </div>`;
      }).join('')}
      <div class="lottery-stock-total"><span>${totInStock} book${totInStock !== 1 ? 's' : ''} in stock</span><span>${totActivated} activated</span></div>
    </div>`;
}

function renderLotteryStockByLocation(rows) {
  const el = document.getElementById('lottery-stock-container');
  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No packs in stock</div>'; return;
  }
  const locOrder = ['Station Booth', 'Front - Extra', 'Office'];
  const byLoc = {};
  for (const row of rows) {
    const loc = row.location || 'Office';
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(row);
  }
  const totInStock   = rows.filter(r => r.status !== 'soldout').length;
  const totActivated = rows.filter(r => r.status === 'activated').length;
  let sections = '';
  for (const loc of locOrder) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;
    const activated = packs.filter(p => p.status === 'activated').length;
    const inStock   = packs.filter(p => p.status !== 'soldout').length;
    const soldOut   = packs.filter(p => p.status === 'soldout').length;
    sections += `
      <div class="lottery-stock-game">
        <div class="lottery-stock-row">
          <div class="lottery-stock-name"><span class="pack-loc-pill ${PACK_LOC_CSS[loc] || 'loc-office'}">${loc}</span></div>
          <div class="lottery-stock-packs">${inStock} book${inStock !== 1 ? 's' : ''}</div>
          <div class="lottery-stock-open-pill ${activated > 0 ? 'is-open' : ''}">${activated} activated</div>
        </div>
        <div class="lottery-stock-books">
          ${packs.filter(p => p.status !== 'soldout').map(p => renderPackRowByLoc(p)).join('')}
          ${soldOut > 0 ? `<div class="lottery-soldout-note">${soldOut} sold out</div>` : ''}
        </div>
      </div>`;
  }
  el.innerHTML = `<div class="lottery-stock-table">${sections}<div class="lottery-stock-total"><span>${totInStock} in stock</span><span>${totActivated} activated</span></div></div>`;
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

  const select = _dbCaps.hasLoadingDirection
    ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)`
    : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)`;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${select}&status=eq.activated&order=location.asc,pack_number.asc&limit=200`
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
  const locOrder = ['Station Booth', 'Front - Extra', 'Office'];
  const byLoc = {};
  for (const r of rows) { const loc = r.location || 'Office'; if (!byLoc[loc]) byLoc[loc] = []; byLoc[loc].push(r); }
  let html = '';
  for (const loc of locOrder) {
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
            <span class="pack-dir-pill ${dir === 'desc' ? 'dir-desc' : 'dir-asc'}">${dir === 'desc' ? '↓' : '↑'} ${dir.toUpperCase()}</span>
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
  const confirmBtn = document.getElementById('shift-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    // Build entries from modal inputs
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
      entries.push({ pack_id: p.id, tickets_sold: sold, revenue, ticket_at_open: lastTicket, ticket_at_close: currentTick });
    }

    // Create or update shift record
    let shiftId;
    if (_dbCaps.hasFullDayTracking && _currentShift) {
      shiftId = _currentShift.id;
      await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?id=eq.${shiftId}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'closed', closed_at: new Date().toISOString(),
            total_tickets_sold: totalSold, total_revenue: totalRev }) });
    } else {
      // Legacy mode: create shift record on close
      const extraFields = (_dbCaps.hasFullDayTracking && _currentDay) ? { day_id: _currentDay.id } : {};
      const shiftRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ shift_type: _pendingShiftType,
            total_tickets_sold: totalSold, total_revenue: totalRev, ...extraFields }) });
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
        // Sum all shifts for this day to compute day totals
        const dShiftsRes = await sbFetch(
          `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${_currentDay.id}&select=total_tickets_sold,total_revenue`
        );
        const dShifts  = await dShiftsRes.json();
        const dayTotals = (Array.isArray(dShifts) ? dShifts : []).reduce(
          (acc, s) => ({ tickets: acc.tickets + (s.total_tickets_sold || 0), revenue: acc.revenue + parseFloat(s.total_revenue || 0) }),
          { tickets: 0, revenue: 0 }
        );
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
  } catch (err) { showError('Close failed', err.message); }
  finally { if (confirmBtn) confirmBtn.disabled = false; }
}

// ===== SHIFT / DAY HISTORY =====

async function loadShiftHistory() {
  const el = document.getElementById('shift-history-container');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  try {
    if (_dbCaps.hasFullDayTracking) {
      // Query days with nested shifts and entries
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_days` +
        `?select=id,opened_at,closed_at,status,total_tickets_sold,total_revenue,lottery_shifts(id,opened_at,closed_at,total_tickets_sold,total_revenue,status,lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,lottery_packs(pack_number,game_number,lottery_games(game_name))))` +
        `&order=opened_at.desc&limit=20`
      );
      const days = await res.json();
      renderDayHistory(Array.isArray(days) ? days : []);
    } else {
      // Legacy: flat shift list
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
        `?select=id,shift_type,closed_at,total_tickets_sold,total_revenue,lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,lottery_packs(pack_number,game_number,lottery_games(game_name,price)))` +
        `&order=closed_at.desc&limit=30`
      );
      const shifts = await res.json();
      renderShiftHistory(Array.isArray(shifts) ? shifts : []);
    }
  } catch (e) {
    if (el) el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

// Full day-tracking view: days → shifts → entries
function renderDayHistory(days) {
  const el = document.getElementById('shift-history-container');
  if (!el) return;
  if (!days.length) { el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No history yet</div>'; return; }

  const openDay    = days.find(d => d.status === 'open');
  const closedDays = days.filter(d => d.status === 'closed');
  const lastDay    = closedDays[0] || null;

  // Find most recent closed shift across all days
  let lastShift = null, lastShiftDay = null;
  for (const day of days) {
    const closed = (day.lottery_shifts || [])
      .filter(s => s.status === 'closed')
      .sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
    if (closed.length) { lastShift = closed[0]; lastShiftDay = day; break; }
  }

  let html = '';

  // ── Today status banner ───────────────────────────────────────────────────
  if (openDay) {
    const hasOpenShift = (openDay.lottery_shifts || []).some(s => s.status === 'open');
    const closedShifts = (openDay.lottery_shifts || []).filter(s => s.status === 'closed');
    const liveRev      = closedShifts.reduce((s, sh) => s + parseFloat(sh.total_revenue || 0), 0);
    const liveTix      = closedShifts.reduce((s, sh) => s + (sh.total_tickets_sold || 0), 0);
    const statusLabel  = hasOpenShift ? 'Shift Open' : 'No Active Shift';
    html += `
      <div class="shift-today-banner">
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--green-text);margin-bottom:2px">Today — Day Open · ${statusLabel}</div>
          <div style="font-size:11px;color:var(--green-text)">${closedShifts.length} shift${closedShifts.length !== 1 ? 's' : ''} closed · ${liveTix} tickets</div>
        </div>
        <span class="shift-day-total-rev">$${liveRev.toFixed(2)}</span>
      </div>`;
  }

  // ── Last close summary cards ──────────────────────────────────────────────
  html += `<div class="last-close-grid">`;

  if (lastDay) {
    const dateStr   = new Date(lastDay.opened_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const openT     = new Date(lastDay.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const closeT    = lastDay.closed_at ? new Date(lastDay.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const nShifts   = (lastDay.lottery_shifts || []).filter(s => s.status === 'closed').length;
    html += `
      <div class="last-close-card">
        <div class="last-close-label">Last Day Close</div>
        <div class="last-close-date">${dateStr}</div>
        <div class="last-close-time">${openT} – ${closeT}</div>
        <div class="last-close-rev">$${parseFloat(lastDay.total_revenue || 0).toFixed(2)}</div>
        <div class="last-close-sub">${lastDay.total_tickets_sold || 0} tickets · ${nShifts} shift${nShifts !== 1 ? 's' : ''}</div>
      </div>`;
  } else {
    html += `<div class="last-close-card last-close-empty"><div class="last-close-label">Last Day Close</div><div class="last-close-sub" style="margin-top:8px">None yet</div></div>`;
  }

  if (lastShift) {
    const dateStr = new Date(lastShiftDay.opened_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const openT   = lastShift.opened_at ? new Date(lastShift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const closeT  = lastShift.closed_at ? new Date(lastShift.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const entries = (lastShift.lottery_shift_entries || []);
    const entriesHtml = entries.map(en => {
      const pack = en.lottery_packs || {}, game = pack.lottery_games || {};
      return `<div class="last-close-entry">
        <span>${game.game_name || `#${pack.game_number}`} #${pack.pack_number}</span>
        <span>#${en.ticket_at_open}→#${en.ticket_at_close} · ${en.tickets_sold}t · $${parseFloat(en.revenue).toFixed(2)}</span>
      </div>`;
    }).join('');
    html += `
      <div class="last-close-card">
        <div class="last-close-label">Last Shift Close</div>
        <div class="last-close-date">${dateStr}</div>
        <div class="last-close-time">${openT} – ${closeT}</div>
        <div class="last-close-rev">$${parseFloat(lastShift.total_revenue || 0).toFixed(2)}</div>
        <div class="last-close-sub">${lastShift.total_tickets_sold || 0} tickets sold</div>
        ${entriesHtml ? `<div class="last-close-entries">${entriesHtml}</div>` : ''}
      </div>`;
  } else {
    html += `<div class="last-close-card last-close-empty"><div class="last-close-label">Last Shift Close</div><div class="last-close-sub" style="margin-top:8px">None yet</div></div>`;
  }

  html += `</div>`;

  // ── Full history list ─────────────────────────────────────────────────────
  for (const day of days) {
    const dateStr      = new Date(day.opened_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const dayRev       = parseFloat(day.total_revenue || 0);
    const dayTix       = day.total_tickets_sold || 0;
    const isOpen       = day.status === 'open';
    const closedShifts = (day.lottery_shifts || []).filter(s => s.status === 'closed');

    html += `
      <div class="shift-day-group">
        <div class="shift-day-header">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="shift-day-label">${dateStr}</span>
            <span class="shift-day-closed-badge" style="${isOpen ? 'background:var(--amber-bg);color:var(--amber-text);border-color:var(--amber-border)' : ''}">${isOpen ? 'Open' : 'Closed'}</span>
          </div>
          <span class="shift-day-rev">$${dayRev.toFixed(2)}</span>
        </div>`;

    for (const s of closedShifts) {
      const openTime  = s.opened_at ? new Date(s.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
      const closeTime = s.closed_at ? new Date(s.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
      const entries   = s.lottery_shift_entries || [];
      const entriesHtml = entries.map(en => {
        const pack = en.lottery_packs || {}, game = pack.lottery_games || {};
        return `<div class="shift-history-entry">
          <span class="shift-history-entry-game">${game.game_name || `#${pack.game_number}`} #${pack.pack_number}</span>
          <span class="shift-history-entry-detail">#${en.ticket_at_open}→#${en.ticket_at_close} · ${en.tickets_sold} sold · $${parseFloat(en.revenue).toFixed(2)}</span>
        </div>`;
      }).join('');
      html += `
        <div class="shift-history-item">
          <div class="shift-history-hdr">
            <div style="display:flex;align-items:center;gap:6px">
              <span class="shift-history-type shift-type-shift">Shift</span>
              <span class="shift-history-date">${openTime} – ${closeTime}</span>
            </div>
            <span class="shift-history-rev">$${parseFloat(s.total_revenue || 0).toFixed(2)}</span>
          </div>
          <div class="shift-history-sub">${s.total_tickets_sold || 0} tickets sold</div>
          ${entriesHtml ? `<div class="shift-history-entries">${entriesHtml}</div>` : ''}
        </div>`;
    }

    html += `
        <div class="shift-day-total">
          <span>${dayTix} tickets · ${closedShifts.length} shift${closedShifts.length !== 1 ? 's' : ''}</span>
          <span class="shift-day-total-rev">$${dayRev.toFixed(2)}</span>
        </div>
      </div>`;
  }

  el.innerHTML = html;
}

// Legacy shift-only view (no day tracking)
function renderShiftHistory(shifts) {
  const el = document.getElementById('shift-history-container');
  if (!el) return;
  if (!shifts.length) { el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No shift history yet</div>'; return; }

  const todayKey    = new Date().toLocaleDateString();
  const todayShifts = shifts.filter(s => new Date(s.closed_at).toLocaleDateString() === todayKey);
  const todayRev    = todayShifts.reduce((s, sh) => s + parseFloat(sh.total_revenue), 0);
  const todayTix    = todayShifts.reduce((s, sh) => s + sh.total_tickets_sold, 0);

  let html = '';

  // ── Today banner ─────────────────────────────────────────────────────────
  if (todayShifts.length) {
    html += `
      <div class="shift-today-banner">
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--green-text);margin-bottom:2px">Today · ${todayShifts.length} close${todayShifts.length !== 1 ? 's' : ''}</div>
          <div style="font-size:11px;color:var(--green-text)">${todayTix} tickets</div>
        </div>
        <span class="shift-day-total-rev">$${todayRev.toFixed(2)}</span>
      </div>`;
  }

  // ── Last close summary cards ──────────────────────────────────────────────
  const lastDayClose   = shifts.find(s => s.shift_type === 'day')   || null;
  const lastShiftClose = shifts.find(s => s.shift_type !== 'day')   || null;
  html += `<div class="last-close-grid">`;

  for (const [label, s] of [['Last Day Close', lastDayClose], ['Last Shift Close', lastShiftClose]]) {
    if (s) {
      const dateStr = new Date(s.closed_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = new Date(s.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const entries = (s.lottery_shift_entries || []);
      const entriesHtml = entries.map(en => {
        const pack = en.lottery_packs || {}, game = pack.lottery_games || {};
        return `<div class="last-close-entry">
          <span>${game.game_name || `#${pack.game_number}`} #${pack.pack_number}</span>
          <span>${en.tickets_sold}t · $${parseFloat(en.revenue).toFixed(2)}</span>
        </div>`;
      }).join('');
      html += `
        <div class="last-close-card">
          <div class="last-close-label">${label}</div>
          <div class="last-close-date">${dateStr}</div>
          <div class="last-close-time">${timeStr}</div>
          <div class="last-close-rev">$${parseFloat(s.total_revenue).toFixed(2)}</div>
          <div class="last-close-sub">${s.total_tickets_sold} tickets sold</div>
          ${entriesHtml ? `<div class="last-close-entries">${entriesHtml}</div>` : ''}
        </div>`;
    } else {
      html += `<div class="last-close-card last-close-empty"><div class="last-close-label">${label}</div><div class="last-close-sub" style="margin-top:8px">None yet</div></div>`;
    }
  }
  html += `</div>`;

  // ── Full history ──────────────────────────────────────────────────────────
  const byDate = new Map();
  for (const s of shifts) {
    const key = new Date(s.closed_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(s);
  }
  for (const [dateStr, dayShifts] of byDate) {
    const dayRev = dayShifts.reduce((s, sh) => s + parseFloat(sh.total_revenue), 0);
    const dayTix = dayShifts.reduce((s, sh) => s + sh.total_tickets_sold, 0);
    html += `
      <div class="shift-day-group">
        <div class="shift-day-header">
          <span class="shift-day-label">${dateStr}</span>
          <span class="shift-day-rev">$${dayRev.toFixed(2)}</span>
        </div>`;
    for (const s of dayShifts) {
      const typeCss   = s.shift_type === 'day' ? 'shift-type-day' : 'shift-type-shift';
      const typeLabel = s.shift_type === 'day' ? 'Day Close' : 'Shift';
      const timeStr   = new Date(s.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const entries   = s.lottery_shift_entries || [];
      const entriesHtml = entries.map(en => {
        const pack = en.lottery_packs || {}, game = pack.lottery_games || {};
        return `<div class="shift-history-entry">
          <span class="shift-history-entry-game">${game.game_name || `#${pack.game_number}`} #${pack.pack_number}</span>
          <span class="shift-history-entry-detail">#${en.ticket_at_open}→#${en.ticket_at_close} · ${en.tickets_sold} sold · $${parseFloat(en.revenue).toFixed(2)}</span>
        </div>`;
      }).join('');
      html += `
        <div class="shift-history-item">
          <div class="shift-history-hdr">
            <div style="display:flex;align-items:center;gap:6px"><span class="shift-history-type ${typeCss}">${typeLabel}</span><span class="shift-history-date">${timeStr}</span></div>
            <span class="shift-history-rev">$${parseFloat(s.total_revenue).toFixed(2)}</span>
          </div>
          <div class="shift-history-sub">${s.total_tickets_sold} tickets sold</div>
          ${entriesHtml ? `<div class="shift-history-entries">${entriesHtml}</div>` : ''}
        </div>`;
    }
    html += `
        <div class="shift-day-total"><span>${dayTix} tickets · ${dayShifts.length} close${dayShifts.length !== 1 ? 's' : ''}</span><span class="shift-day-total-rev">$${dayRev.toFixed(2)}</span></div>
      </div>`;
  }
  el.innerHTML = html;
}

// ===== TAB INIT =====

async function initLotteryTab() {
  if (!_lotteryEventsReady) {
    _lotteryEventsReady = true;
    const inp = document.getElementById('lottery-input');
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitLotteryInput(); } });
    inp.addEventListener('paste',   () => { setTimeout(() => { const v = inp.value.trim(); if (v) lookupLotteryTicket(v); }, 50); });

    // One-time capability check + load current day state
    await checkDbCapabilities();
    await loadCurrentDayShift();
  }
  renderLotteryLog();
  renderLotteryStats();
  loadLotteryDbStats();
  loadLotteryStock();
  loadShiftHistory();
  refocusLottery();
}
