// ===== SHIFT ENTRY HELPERS =====
// Core: writes a lottery_shift_entries row for a mid-shift action.
// countFinalTicket=true for sold-out (last ticket itself was dispensed).
async function _writeShiftEntry(packId, atTicket, countFinalTicket) {
  if (!_currentShift || !_dbCaps.hasFullDayTracking) return 0;
  if (atTicket == null) return 0;
  const info     = _packInfoCache[packId] || {};
  const baseline = info.lastShiftTicket ?? info.startTicket;
  if (baseline == null) return 0;
  const dir   = (info.loadingDirection || 'asc').toLowerCase();
  const price = parseFloat(info.price || 0);
  const sold  = _soldTickets(atTicket, baseline, dir) + (countFinalTicket ? 1 : 0);
  if (sold <= 0) return 0;
  await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify([{ pack_id: packId, shift_id: _currentShift.id,
        tickets_sold: sold, revenue: sold * price,
        ticket_at_open: baseline, ticket_at_close: atTicket,
        station_line: info.stationLine ?? null }]) });
  return sold;
}

// Public helpers — call these at each action site.
async function commitRemoveEntry(packId, atTicket)  { return _writeShiftEntry(packId, atTicket, false); }
async function commitSoldOutEntry(packId, atTicket) { return _writeShiftEntry(packId, atTicket, true);  }

// ===== STATUS / LOCATION CONFIG =====

const PACK_STATUS = {
  received:  { label: 'Received',  css: 'status-received'  },
  activated: { label: 'Activated', css: 'status-activated' },
  soldout:   { label: 'Sold Out',  css: 'status-soldout'   },
  removed:   { label: 'Removed',   css: 'status-removed'   },
};
const PACK_LOC_CSS = {
  'Office':        'loc-office',
  'Extra':         'loc-extra',
  'Station Booth': 'loc-station',
  'Front - Extra': 'loc-front',
};

let _pendingRemoveId = null;

function removePackAtTicket(id, currentTicket, e) {
  if (e) e.preventDefault();
  requireAdmin(() => _doRemovePackAtTicket(id, currentTicket));
}

function _doRemovePackAtTicket(id, currentTicket) {
  _pendingRemoveId = id;
  const info = _packInfoCache[id] || {};
  const infoEl = document.getElementById('remove-book-info');
  if (infoEl) infoEl.textContent = info.gameName ? `${info.gameName} · Book #${info.packNumber}` : `Book ID: ${id}`;
  const inp   = document.getElementById('remove-ticket-input');
  const label = document.querySelector('#remove-modal .lottery-form-label');
  const hasTicket = currentTicket != null;
  if (inp) {
    inp.value = hasTicket ? String(currentTicket) : '';
    inp.style.display = hasTicket ? '' : 'none';
  }
  if (label) label.style.display = hasTicket ? '' : 'none';
  document.getElementById('remove-modal').classList.add('open');
  setTimeout(() => { if (inp && hasTicket) { inp.focus(); inp.select(); } }, 120);
}

function closeRemoveModal() {
  document.getElementById('remove-modal').classList.remove('open');
  _pendingRemoveId = null;
}

async function confirmRemovePack(e) {
  if (e) e.preventDefault();
  if (!_pendingRemoveId) return;
  const inp = document.getElementById('remove-ticket-input');
  const btn = document.getElementById('remove-confirm-btn');
  const update = { status: 'removed' };
  const prevTicket = (_packInfoCache[_pendingRemoveId] || {}).startTicket;
  let removedAtTicket = null;
  if (inp && inp.style.display !== 'none') {
    const ticketNum = parseInt(inp.value, 10);
    if (isNaN(ticketNum) || ticketNum < 0) { showError('Invalid input', 'Enter a valid ticket number.'); return; }
    update.start_ticket = ticketNum;
    update.last_shift_ticket = ticketNum;
    removedAtTicket = ticketNum;
  }
  if (btn) btn.disabled = true;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(_pendingRemoveId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(update) });
    _logPackEvent(_pendingRemoveId, 'removed', { ticket_before: prevTicket ?? null, ticket_after: removedAtTicket });
    await commitRemoveEntry(_pendingRemoveId, removedAtTicket);
    closeRemoveModal();
    await loadLotteryStock(); loadLotteryDbStats();
    await _refreshInvAfterLoad(); loadReceiveQueue();
  } catch (err) {
    showError('Remove failed', err.message);
  } finally { if (btn) btn.disabled = false; }
}

// ===== RETURN TO LOTTERY =====

let _rltPacks       = [];
let _rltList        = [];
let _rltScanCleanup = null;

async function openReturnToLotteryModal(e) {
  if (e) e.preventDefault();
  if (!isAdmin()) { showError('Access denied', 'Return to Lottery is restricted to admins.'); return; }
  _rltList = [];
  const scanInp  = document.getElementById('rlt-scan-input');
  const errEl    = document.getElementById('rlt-scan-error');
  const listEl   = document.getElementById('rlt-book-list');
  const btn      = document.getElementById('rlt-confirm-btn');
  const countEl  = document.getElementById('rlt-count');
  if (scanInp)  scanInp.value = '';
  if (errEl)    errEl.style.display = 'none';
  if (listEl)   listEl.innerHTML = '<div class="rlt-empty">Scan a book to add it to the return list</div>';
  if (btn)      btn.disabled = true;
  if (countEl)  countEl.style.display = 'none';
  document.getElementById('return-lottery-modal').classList.add('open');

  try {
    const sel = _dbCaps.hasLoadingDirection
      ? 'id,game_number,pack_number,start_ticket,last_shift_ticket,loading_direction,status,lottery_games(game_name,price,tickets_per_pack)'
      : 'id,game_number,pack_number,start_ticket,last_shift_ticket,status,lottery_games(game_name,price,tickets_per_pack)';
    const res  = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?status=in.(activated,received)&select=${sel}&order=game_number.asc,pack_number.asc`);
    const data = await res.json();
    _rltPacks  = Array.isArray(data) ? data : [];
  } catch { _rltPacks = []; }

  if (scanInp) {
    const onKey   = e => { if (e.key === 'Enter') _rltHandleScan(scanInp.value.trim()); };
    const onPaste = () => { setTimeout(() => _rltHandleScan(scanInp.value.trim()), 50); };
    scanInp.addEventListener('keydown', onKey);
    scanInp.addEventListener('paste', onPaste);
    _rltScanCleanup = () => { scanInp.removeEventListener('keydown', onKey); scanInp.removeEventListener('paste', onPaste); };
    setTimeout(() => scanInp.focus(), 120);
  }
}

function closeReturnToLotteryModal() {
  if (_rltScanCleanup) { _rltScanCleanup(); _rltScanCleanup = null; }
  document.getElementById('return-lottery-modal').classList.remove('open');
  _rltPacks = []; _rltList = [];
}

function _rltFlashError(msg) {
  const el = document.getElementById('rlt-scan-error');
  if (!el) return;
  el.textContent = msg || 'Unrecognized barcode';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}

function _rltHandleScan(raw) {
  const scanInp = document.getElementById('rlt-scan-input');
  if (scanInp) scanInp.value = '';
  if (!raw) return;
  const result = parseLotteryBarcode(raw);
  if (!result) { beepNotFound(); _rltFlashError('Could not read barcode'); return; }

  let parsed, pack;
  if (result.ambiguous) {
    for (const candidate of result.candidates) {
      pack = _rltPacks.find(p => p.game_number === candidate.gameNumber && p.pack_number === candidate.packNumber);
      if (pack) { parsed = candidate; break; }
    }
  } else {
    parsed = result;
    pack = _rltPacks.find(p => p.game_number === parsed.gameNumber && p.pack_number === parsed.packNumber);
  }
  if (!pack) { beepNotFound(); _rltFlashError('Book not found in active or received list'); return; }
  if (_rltList.some(b => b.id === pack.id)) { beepDuplicate(); _rltFlashError('Book already added'); return; }

  const game = pack.lottery_games || {};
  _rltList.push({
    id:              pack.id,
    gameName:        game.game_name || `Game #${pack.game_number}`,
    packNumber:      pack.pack_number,
    status:          pack.status,
    lastShiftTicket: pack.last_shift_ticket ?? pack.start_ticket,
    scannedTicket:   parsed ? parsed.ticketPosition : null,
    dir:             (pack.loading_direction || 'asc').toLowerCase(),
    price:           parseFloat(game.price || 0),
  });
  beepSuccess();
  _renderRltList();
  setTimeout(() => { if (scanInp) scanInp.focus(); }, 80);
}

function _rltRemoveItem(id) {
  _rltList = _rltList.filter(b => b.id !== id);
  _renderRltList();
}

function _renderRltList() {
  const listEl   = document.getElementById('rlt-book-list');
  const btn      = document.getElementById('rlt-confirm-btn');
  const countEl  = document.getElementById('rlt-count');
  if (!listEl) return;
  if (countEl) {
    if (_rltList.length) {
      countEl.textContent = `${_rltList.length} book${_rltList.length !== 1 ? 's' : ''}`;
      countEl.style.display = '';
    } else {
      countEl.style.display = 'none';
    }
  }
  if (!_rltList.length) {
    listEl.innerHTML = '<div class="rlt-empty">Scan a book to add it to the return list</div>';
    if (btn) btn.disabled = true;
    return;
  }
  if (btn) btn.disabled = false;
  listEl.innerHTML = _rltList.map(b => {
    const isActive = b.status === 'activated';
    return `<div class="rlt-book-row" id="rlt-row-${b.id}">
      <div class="rlt-book-info">
        <span class="rlt-book-name">${b.gameName} <span class="rlt-pack-num">#${b.packNumber}</span></span>
        <span class="rlt-status-pill ${isActive ? 'rlt-active' : 'rlt-received'}">${isActive ? 'Active' : 'Received'}</span>
      </div>
      ${isActive ? `<div class="rlt-ticket-row">
        <span class="rlt-ticket-label">At ticket #</span>
        <span class="rlt-ticket-val">${b.scannedTicket ?? '—'}</span>
      </div>` : '<div class="rlt-ticket-row"><span class="rlt-ticket-label" style="font-style:italic">No tickets sold — full book</span></div>'}
      <button class="rlt-remove-btn" onmousedown="_rltRemoveItem('${b.id}')" ontouchstart="_rltRemoveItem('${b.id}')">✕</button>
    </div>`;
  }).join('');
}

async function confirmReturnToLottery(e) {
  if (e) e.preventDefault();
  if (!_rltList.length) return;
  const btn = document.getElementById('rlt-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    await Promise.all(_rltList.map(async b => {
      const update = { status: 'removed' };
      let returnedAtTicket = null;
      if (b.status === 'activated') {
        const ticketNum = b.scannedTicket;
        if (ticketNum == null || isNaN(ticketNum) || ticketNum < 0) throw new Error(`No ticket position for book #${b.packNumber} — rescan the book`);
        update.start_ticket      = ticketNum;
        update.last_shift_ticket = ticketNum;
        returnedAtTicket         = ticketNum;
      }
      await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(b.id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(update) });
      _logPackEvent(b.id, 'returned_to_lottery', { ticket_before: b.lastShiftTicket ?? null, ticket_after: returnedAtTicket, notes: 'Returned to lottery warehouse' });
      if (returnedAtTicket != null && _currentShift && b.lastShiftTicket != null) {
        const sold = _soldTickets(returnedAtTicket, b.lastShiftTicket, b.dir);
        if (sold > 0) {
          await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
              body: JSON.stringify([{ pack_id: b.id, shift_id: _currentShift.id,
                tickets_sold: sold, revenue: sold * b.price,
                ticket_at_open: b.lastShiftTicket, ticket_at_close: returnedAtTicket,
                station_line: (_packInfoCache[b.id] || {}).stationLine ?? null }]) });
        }
      }
    }));
    closeReturnToLotteryModal();
    await loadLotteryStock(); loadLotteryDbStats();
    await _refreshInvAfterLoad(); loadReceiveQueue();
  } catch (err) {
    showError('Return failed', err.message);
    if (btn) btn.disabled = false;
  }
}

let _pendingSoldOutId         = null;
let _pendingSoldOutFinalTicket = null;
let _pendingSoldOutStage       = false; // true when called from inside an audit (stages; no immediate DB write)
let _soldOutTimerId            = null;

function _calcSoldOutFinalTicket(info) {
  const dir = info.loadingDirection || 'asc';
  const tpp = info.ticketsPerPack || 0;
  if (tpp <= 0) return null;
  // Use game's tickets_per_pack as the source of truth for the absolute end of the book.
  // ASC books run 0 → tpp-1; DESC books run tpp-1 → 0.
  return dir === 'desc' ? 0 : tpp - 1;
}

// Returns true if the pack appears to have no tickets sold yet.
// ASC: still at ticket #0. DESC: still at tickets_per_pack - 1.
function _packNoSalesYet(info) {
  const dir     = (info.loadingDirection || 'asc').toLowerCase();
  const current = info.startTicket ?? 0;
  if (dir === 'desc') {
    const maxTick = info.ticketsPerPack > 0 ? info.ticketsPerPack - 1 : null;
    return maxTick !== null && current >= maxTick;
  }
  return current === 0;
}

function _startSoldOutTimer() {
  const btn = document.getElementById('soldout-confirm-btn');
  if (!btn) return;
  if (_soldOutTimerId) { clearTimeout(_soldOutTimerId); _soldOutTimerId = null; }
  const DURATION = 3000;
  const TICK     = 50;
  const start    = Date.now();
  btn.disabled   = true;

  function tick() {
    const elapsed   = Date.now() - start;
    const pct       = Math.min(elapsed / DURATION * 100, 100);
    const remaining = Math.ceil((DURATION - elapsed) / 1000);

    if (elapsed >= DURATION) {
      btn.style.background = '';
      btn.textContent      = 'Mark Sold Out';
      btn.disabled         = false;
      _soldOutTimerId      = null;
      return;
    }

    btn.style.background = `linear-gradient(to right, #1A1612 ${pct}%, rgba(26,22,18,.3) ${pct}%)`;
    btn.textContent      = `Mark Sold Out · ${remaining}`;
    _soldOutTimerId      = setTimeout(tick, TICK);
  }

  tick();
}

function openSoldOutModal(id, _unused, e) {
  if (e) e.preventDefault();
  _pendingSoldOutId    = id;
  // Auto-detect audit context: stage locally when inside a close audit; commit to DB otherwise
  _pendingSoldOutStage = !!(_invContext && _invContext.startsWith('close'));
  const info = _packInfoCache[id] || {};
  const dir  = info.loadingDirection || 'asc';

  const finalTicket = _calcSoldOutFinalTicket(info);
  _pendingSoldOutFinalTicket = finalTicket;

  const baseline  = info.lastShiftTicket != null ? info.lastShiftTicket : info.startTicket;
  const sold      = (finalTicket != null && baseline != null) ? _soldTickets(finalTicket, baseline, dir) + 1 : null;
  const noSales   = _packNoSalesYet(info);

  // Formatted book identifier: GAME_NUMBER-PACK_NUMBER
  const bookId = (info.gameNumber && info.packNumber)
    ? `${info.gameNumber}-${info.packNumber}`
    : info.packNumber ? `Book #${info.packNumber}` : id;

  const infoEl = document.getElementById('soldout-book-info');
  if (infoEl) {
    const chips = [];
    if (info.packNumber != null)  chips.push(`<span style="background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:11.5px;color:var(--text-muted)">Book #${info.packNumber}</span>`);
    if (info.location)            chips.push(`<span style="background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:11.5px;color:var(--text-muted)">${info.location}</span>`);
    if (info.stationLine != null) chips.push(`<span style="background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:2px 8px;font-size:11.5px;color:var(--text-muted)">Line ${info.stationLine}</span>`);
    infoEl.innerHTML = `<div style="background:var(--ink-10);border:1px solid var(--border);border-radius:9px;padding:10px 12px;margin-bottom:2px">
      <div style="font-size:15px;font-weight:700;color:var(--ink);line-height:1.3;margin-bottom:6px">${info.gameName || id}</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px">${chips.join('')}</div>
    </div>`;
  }

  const detailEl = document.getElementById('soldout-detail');
  if (detailEl) {
    // Ticket calculation row
    let calcRow = '';
    if (finalTicket != null) {
      const soldLine = sold != null ? `<span style="font-size:11.5px;color:var(--text-muted)">${sold} ticket${sold !== 1 ? 's' : ''} sold this shift</span>` : '';
      calcRow = `<div class="soldout-calc-row">
          ${_dirPill(dir)}
          ${baseline != null ? `Last at ${_ticketAt(baseline, 'soldout')} →` : ''}
          Final ${_ticketAt(finalTicket, 'activated')}
        </div>
        ${soldLine}`;
    } else {
      calcRow = `<div class="soldout-calc-row" style="color:var(--text-hint)">End ticket unknown — cannot auto-calculate</div>`;
    }

    // Formatted barcode line
    const barcodeRow = `<div style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.04em;color:var(--ink);background:var(--ink-10);border-radius:6px;padding:6px 10px;margin:8px 0 6px;text-align:center">${bookId}</div>`;

    // Caution banner when no tickets appear sold
    const cautionBanner = noSales
      ? `<div style="background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:8px;padding:9px 12px;margin-top:8px;font-size:12px;line-height:1.55;color:var(--ink)">
           <strong>⚠ No tickets appear to have been sold from this book.</strong><br>
           Check <strong>Extra storage</strong> before marking sold out — this book may still be in use.
         </div>`
      : '';

    const openDayWarning = (_invContext === 'open-day')
      ? `<div style="background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:8px;padding:9px 12px;margin-top:8px;font-size:12px;line-height:1.55;color:var(--ink)">
           <strong>⚠ You are in Day Open audit.</strong><br>
           Only mark sold out if tickets were sold after the previous day was closed. This action is admin-gated.
         </div>`
      : '';

    detailEl.innerHTML = barcodeRow + calcRow + cautionBanner + openDayWarning;
  }

  document.getElementById('soldout-modal').classList.add('open');
  _startSoldOutTimer();
}

function closeSoldOutModal() {
  document.getElementById('soldout-modal').classList.remove('open');
  _pendingSoldOutId = null;
  _pendingSoldOutFinalTicket = null;
  if (_soldOutTimerId) { clearTimeout(_soldOutTimerId); _soldOutTimerId = null; }
  const btn = document.getElementById('soldout-confirm-btn');
  if (btn) { btn.disabled = false; btn.style.background = ''; btn.textContent = 'Mark Sold Out'; }
}

async function confirmSoldOut(e) {
  if (e) e.preventDefault();
  if (!_pendingSoldOutId) return;
  const finalTicket = _pendingSoldOutFinalTicket;
  if (finalTicket == null) { showError('Cannot mark sold out', 'End ticket is unknown for this pack.'); return; }

  if (_pendingSoldOutStage) {
    // ── Audit path — stage locally, no DB write until shift is confirmed ──
    const packId = _pendingSoldOutId;
    closeSoldOutModal();
    _invSoldOut[packId] = finalTicket;
    _invData[packId]    = finalTicket;
    _renderInvList();
    _updateInvProgress();
    return;
  }

  // ── Stock view path — commit immediately to DB ──
  const btn = document.getElementById('soldout-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    const _soc        = _packInfoCache[_pendingSoldOutId] || {};
    const prevTicket  = _soc.lastShiftTicket ?? _soc.startTicket ?? null;
    // Settle the pack: set last_shift_ticket = finalTicket so the unsettled-detection
    // filter (start_ticket != last_shift_ticket) correctly skips it at the next close.
    // Only do this when a current shift exists; without one the close audit must still
    // detect and count this pack, so leave last_shift_ticket unchanged.
    const hasShift  = _dbCaps.hasFullDayTracking && !!_currentShift;
    const patchBody = { status: 'soldout', start_ticket: finalTicket, station_line: null,
                        ...(hasShift ? { last_shift_ticket: finalTicket } : {}) };
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(_pendingSoldOutId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(patchBody) });
    _logPackEvent(_pendingSoldOutId, 'soldout', { ticket_before: prevTicket ?? null, ticket_after: finalTicket });
    await commitSoldOutEntry(_pendingSoldOutId, finalTicket);

    delete _packInfoCache[_pendingSoldOutId];
    closeSoldOutModal();
    await loadLotteryStock(); loadLotteryDbStats();
    await _refreshInvAfterLoad(); loadReceiveQueue();
  } catch (err) {
    showError('Sold out failed', err.message);
  } finally { if (btn) btn.disabled = false; }
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

// ===== MOVE PACK LOCATION =====

function openMovePackModal(id, e) {
  if (e) e.preventDefault();
  _pendingMoveId = id;
  const info  = _packInfoCache[id] || {};
  const infoEl = document.getElementById('move-pack-info');
  if (infoEl) infoEl.textContent = info.gameName ? `${info.gameName} · Book #${info.packNumber}` : `Book ID: ${id}`;
  document.getElementById('move-pack-modal').classList.add('open');
}

function closeMovePackModal() {
  document.getElementById('move-pack-modal').classList.remove('open');
  _pendingMoveId = null;
}

async function confirmMovePack(newLocation, e) {
  if (e) e.preventDefault();
  if (!_pendingMoveId) return;
  const prevLocation = (_packInfoCache[_pendingMoveId] || {}).location;
  try {
    await _commitMovePack(_pendingMoveId, newLocation, prevLocation);
    closeMovePackModal();
    await loadLotteryStock();
  } catch (err) { showError('Move failed', err.message); }
}

// ===== MOVE RECEIVED PACKS =====

async function _commitMovePack(packId, newLocation, prevLocation) {
  const toStation = _isStation(newLocation);
  const patchBody = toStation ? { location: newLocation, status: 'activated', station_line: null } : { location: newLocation, station_line: null };
  await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(patchBody) });
  _logPackEvent(packId, toStation ? 'activated' : 'moved', { location_from: prevLocation || null, location_to: newLocation });
}

async function _adminMoveActivePack(packId, newStation) {
  const prevLocation = (_packInfoCache[packId] || {}).location || null;
  if (prevLocation === newStation) return;
  try {
    await _commitMovePack(packId, newStation, prevLocation);
    await loadLotteryStock();
  } catch (err) { showError('Move failed', err.message); }
}

// ===== MOVE BOOKS MODAL =====

function openMoveBooksModal() {
  _moveBooksQueue = [];
  document.getElementById('move-books-modal').classList.add('open');
  _renderMoveBooksQueue();
  document.getElementById('move-books-status').textContent = '';
  const countEl = document.getElementById('move-books-count');
  if (countEl) countEl.style.display = 'none';
  // Render dynamic destination buttons from configured locations
  const destEl = document.getElementById('move-books-dest-btns');
  if (destEl) {
    const locs = _getLocOrderAll(); // stations + extra locs + Office
    destEl.innerHTML = locs.map(loc => {
      const isStn = _isStation(loc);
      const isOff = loc === 'Office';
      const cls   = isStn ? 'dest-station' : isOff ? 'dest-office' : '';
      return `<button class="move-dest-btn ${cls}"
        onmousedown="confirmMoveBooks('${loc}',event)"
        ontouchstart="confirmMoveBooks('${loc}',event)">${loc}</button>`;
    }).join('');
  }
  const inp = document.getElementById('move-books-input');
  inp.value = '';
  inp.focus();
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); _scanMoveBook(inp.value.trim()); inp.value = ''; } };
  inp.onpaste   = () => setTimeout(() => { _scanMoveBook(inp.value.trim()); inp.value = ''; }, 50);
}

function closeMoveBooksModal() {
  document.getElementById('move-books-modal').classList.remove('open');
  _moveBooksQueue = [];
}

async function _scanMoveBook(raw) {
  if (!raw) return;
  const statusEl = document.getElementById('move-books-status');
  const parsed = parseLotteryBarcode(raw);
  if (!parsed) { beepNotFound(); _setMoveStatus('Could not read barcode', 'error'); return; }
  let candidate = parsed.ambiguous ? (await _resolveAmbiguousBarcode(parsed)) : parsed;
  if (!candidate) { beepNotFound(); _setMoveStatus('Could not resolve barcode', 'error'); return; }
  statusEl.textContent = 'Looking up…';
  try {
    const res  = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id,pack_number,status,location,lottery_games(game_name)` +
      `&game_number=eq.${encodeURIComponent(candidate.gameNumber)}&pack_number=eq.${encodeURIComponent(candidate.packNumber)}&limit=1`
    );
    const rows = await res.json();
    const pack = Array.isArray(rows) && rows[0];
    if (!pack) { beepNotFound(); _setMoveStatus(`Pack #${candidate.packNumber} not found — receive it first`, 'error'); return; }
    if (pack.status !== 'received' && pack.status !== 'activated') {
      beepNotFound(); _setMoveStatus(`Pack #${pack.pack_number} is ${pack.status} — can only move received or active books`, 'error'); return;
    }
    if (_moveBooksQueue.find(q => q.id === pack.id)) { beepDuplicate(); _setMoveStatus(`Pack #${pack.pack_number} already in list`, 'warn'); return; }
    // Enforce mode consistency — can't mix received and activated in one move
    const queueMode = _moveBooksQueue.length ? _moveBooksQueue[0].status : null;
    if (queueMode && queueMode !== pack.status) {
      beepNotFound(); _setMoveStatus(`Can't mix received and active books — clear the list first`, 'error'); return;
    }
    _moveBooksQueue.push({ id: pack.id, packNumber: pack.pack_number, status: pack.status,
      gameNumber: candidate.gameNumber,
      gameName: pack.lottery_games?.game_name || `Game #${candidate.gameNumber}`, location: pack.location || 'Office' });
    beepSuccess();
    _setMoveStatus(`Added: ${pack.lottery_games?.game_name || `Game #${candidate.gameNumber}`} #${pack.pack_number}`, 'ok');
    _renderMoveBooksQueue();
    _updateMoveDestButtons();
  } catch (err) { beepNotFound(); _setMoveStatus('Lookup failed: ' + err.message, 'error'); }
}

function _setMoveStatus(msg, type) {
  const el = document.getElementById('move-books-status');
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red-text)' : type === 'warn' ? 'var(--amber-text)' : 'var(--green-text)';
}

function _renderMoveBooksQueue() {
  const el      = document.getElementById('move-books-list');
  const countEl = document.getElementById('move-books-count');
  if (!el) return;
  if (countEl) {
    if (_moveBooksQueue.length) {
      countEl.textContent  = `${_moveBooksQueue.length} book${_moveBooksQueue.length !== 1 ? 's' : ''}`;
      countEl.style.display = '';
    } else {
      countEl.style.display = 'none';
    }
  }
  if (!_moveBooksQueue.length) {
    el.innerHTML = '<div class="move-books-empty">Scan a book to add it…</div>';
    _updateMoveDestButtons();
    return;
  }
  el.innerHTML = _moveBooksQueue.map((q, i) => {
    const color = _gameColor(q.gameNumber || '0');
    const emoji = _gameEmoji(q.gameNumber || '0');
    return `
    <div class="move-queue-row">
      <div class="move-queue-dot" style="background:${color}1a">${emoji}</div>
      <div class="move-queue-info">
        <span class="move-queue-name">${q.gameName}</span>
        <span class="move-queue-sub">#${q.packNumber} · from ${q.location}</span>
      </div>
      <button class="sloc-del" onmousedown="_removeMoveQueueItem(${i},event)" ontouchstart="_removeMoveQueueItem(${i},event)" title="Remove">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
}

function _removeMoveQueueItem(i, e) {
  if (e) e.preventDefault();
  _moveBooksQueue.splice(i, 1);
  _renderMoveBooksQueue();
  _updateMoveDestButtons();
}

function _updateMoveDestButtons() {
  const destEl = document.getElementById('move-books-dest-btns');
  if (!destEl) return;
  const mode = _moveBooksQueue.length ? _moveBooksQueue[0].status : null;
  // Activated books: stations only. Received or empty: all locations.
  const locs = (mode === 'activated') ? _getStations() : _getLocOrderAll();
  const noteEl = document.getElementById('move-books-admin-note');
  if (noteEl) noteEl.style.display = 'none';
  destEl.innerHTML = locs.map(loc => {
    const isStn = _isStation(loc);
    const isOff = loc === 'Office';
    const cls   = isStn ? 'dest-station' : isOff ? 'dest-office' : '';
    return `<button class="move-dest-btn ${cls}"
      onmousedown="confirmMoveBooks('${loc}',event)"
      ontouchstart="confirmMoveBooks('${loc}',event)">${loc}</button>`;
  }).join('');
}

function confirmMoveBooks(newLocation, e) {
  if (e) e.preventDefault();
  if (!_moveBooksQueue.length) { _setMoveStatus('Scan at least one book first', 'error'); return; }
  const hasActive = _moveBooksQueue.some(q => q.status === 'activated');
  if (hasActive && !_isStation(newLocation)) {
    _setMoveStatus('Active books can only move to a station', 'error'); return;
  }
  _showMoveConfirmPanel(newLocation, hasActive);
}

function _showMoveConfirmPanel(newLocation, hasActive) {
  _movePendingDest = newLocation;
  _movePendingHasActive = hasActive;
  const n = _moveBooksQueue.length;
  const labelEl = document.getElementById('move-dest-label');
  const destEl  = document.getElementById('move-books-dest-btns');
  if (labelEl) labelEl.style.display = 'none';
  if (!destEl) return;
  destEl.innerHTML = `
    <div class="move-confirm-panel">
      <div class="move-confirm-summary">Moving <strong>${n} book${n !== 1 ? 's' : ''}</strong> to <strong>${newLocation}</strong></div>
      <div class="move-confirm-actions">
        <button class="move-confirm-back"
          onmousedown="_cancelMoveConfirm(event)"
          ontouchstart="_cancelMoveConfirm(event)">← Change</button>
        <button class="move-confirm-btn"
          onmousedown="_executeConfirmedMove(event)"
          ontouchstart="_executeConfirmedMove(event)">Confirm move</button>
      </div>
    </div>`;
}

function _cancelMoveConfirm(e) {
  if (e) e.preventDefault();
  _movePendingDest = null;
  _movePendingHasActive = false;
  const labelEl = document.getElementById('move-dest-label');
  if (labelEl) labelEl.style.display = '';
  _updateMoveDestButtons();
}

function _executeConfirmedMove(e) {
  if (e) e.preventDefault();
  if (!_movePendingDest) return;
  const dest = _movePendingDest;
  const hasActive = _movePendingHasActive;
  _movePendingDest = null;
  _movePendingHasActive = false;
  _doMoveBooks(dest);
}

async function _doMoveBooks(newLocation) {
  try {
    const snapshot = [..._moveBooksQueue];
    await Promise.all(_moveBooksQueue.map(q => _commitMovePack(q.id, newLocation, q.location)));
    closeMoveBooksModal();
    await Promise.all([loadLotteryStock(), loadLocationView()]);
    _showMoveUndoToast(snapshot, newLocation);
  } catch (err) { showError('Move failed', err.message); }
}

function _showMoveUndoToast(movedBooks, newLocation) {
  const prev = document.getElementById('move-undo-toast');
  if (prev) prev.remove();
  if (_moveUndoTimer) { clearTimeout(_moveUndoTimer); _moveUndoTimer = null; }

  const n = movedBooks.length;
  const toast = document.createElement('div');
  toast.id = 'move-undo-toast';
  toast.className = 'move-undo-toast';
  toast.innerHTML = `<span>Moved ${n} book${n !== 1 ? 's' : ''} to ${newLocation}</span>
    <button class="move-undo-btn" onmousedown="_undoMoveBooks(event)" ontouchstart="_undoMoveBooks(event)">Undo</button>`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('move-undo-toast--visible'));

  _moveUndoBooksRef = movedBooks;
  _moveUndoDestRef  = newLocation;
  _moveUndoTimer = setTimeout(_dismissMoveUndoToast, 6000);
}

function _dismissMoveUndoToast() {
  const t = document.getElementById('move-undo-toast');
  if (t) { t.classList.remove('move-undo-toast--visible'); setTimeout(() => t.remove(), 220); }
  if (_moveUndoTimer) { clearTimeout(_moveUndoTimer); _moveUndoTimer = null; }
}

async function _undoMoveBooks(e) {
  if (e) e.preventDefault();
  _dismissMoveUndoToast();
  if (!_moveUndoBooksRef) return;
  const books = _moveUndoBooksRef;
  const fromDest = _moveUndoDestRef;
  _moveUndoBooksRef = null;
  _moveUndoDestRef  = null;
  try {
    await Promise.all(books.map(q => _commitMovePack(q.id, q.location, fromDest)));
    await Promise.all([loadLotteryStock(), loadLocationView()]);
  } catch (err) { showError('Undo failed', err.message); }
}

async function moveReceivedPack(packId, newLocation, e) {
  if (e) e.preventDefault();
  if (_isStation(newLocation) && !_canMoveOrActivate()) { showError('No day open', 'Open a day first.'); return; }
  const prevLocation = (_packInfoCache[packId] || {}).location || null;
  if (prevLocation === newLocation) return;
  try {
    await _commitMovePack(packId, newLocation, prevLocation);
    await Promise.all([loadLotteryStock(), loadLocationView()]);
  } catch (err) { showError('Move failed', err.message); }
}

async function restoreRemovedPack(packId, location, e) {
  if (e) e.preventDefault();
  if (_isStation(location) && !_canMoveOrActivate()) { showError('No day open', 'Open a day first.'); return; }
  requireAdmin(() => _doRestoreRemovedPack(packId, location));
}

function _doRestoreRemovedPack(packId, location) {
  _pendingRestorePackId   = packId;
  _pendingRestoreLocation = location;
  _pendingRestoreType     = 'removed';

  const info = _packInfoCache[packId] || {};
  const infoEl = document.getElementById('restore-soldout-info');
  if (infoEl) infoEl.textContent = info.gameName
    ? `${info.gameName} · Book #${info.packNumber}`
    : `Book ID: ${packId}`;

  const detailEl = document.getElementById('restore-soldout-detail');
  if (detailEl) {
    const newStatus = _isStation(location) ? 'Activated' : 'Received';
    detailEl.innerHTML =
      `<div style="margin-bottom:8px">` +
      `<span style="background:var(--green-bg);color:var(--green-text);border:1px solid var(--green-border);border-radius:999px;padding:2px 10px;font-size:11px;font-weight:700">${newStatus}</span>` +
      `<span style="color:var(--text-muted)"> at </span><strong>${location}</strong></div>` +
      `<div style="font-size:12px;color:var(--text-muted)">This book was removed. Default is ticket #0 (full book). Enter a higher number if it was partially used before removal.</div>`;
  }

  const titleEl = document.querySelector('#restore-soldout-modal .modal-title');
  if (titleEl) titleEl.textContent = 'Restore Removed Book';

  const hintEl = document.querySelector('#restore-soldout-modal .modal-ticket-hint');
  if (hintEl) hintEl.textContent = 'The next shift will count from this ticket onward.';

  const ticketInp = document.getElementById('restore-soldout-ticket');
  if (ticketInp) { ticketInp.value = 0; ticketInp.focus(); }

  document.getElementById('restore-soldout-modal').classList.add('open');
}

let _pendingRestorePackId   = null;
let _pendingRestoreLocation = null;
let _pendingRestoreType     = null; // 'soldout' | 'removed'

function restoreSoldOutPack(packId, location, currentTicket, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (_isStation(location) && !_canMoveOrActivate()) { showError('No day open', 'Open a day first.'); return; }
  requireAdmin(() => _doRestoreSoldOutPack(packId, location, currentTicket));
}

function _doRestoreSoldOutPack(packId, location, currentTicket) {
  _pendingRestorePackId   = packId;
  _pendingRestoreLocation = location;
  _pendingRestoreType     = 'soldout';

  const titleEl = document.querySelector('#restore-soldout-modal .modal-title');
  if (titleEl) titleEl.textContent = 'Restore Book';

  const info = _packInfoCache[packId] || {};
  const infoEl = document.getElementById('restore-soldout-info');
  if (infoEl) infoEl.textContent = info.gameName
    ? `${info.gameName} · Book #${info.packNumber}`
    : `Book ID: ${packId}`;

  // last_shift_ticket = position at last legit shift close (unchanged by soldout modal action).
  // start_ticket = overwritten by soldout to the theoretical final ticket — usually wrong.
  // Default to last_shift_ticket as the resume point; fall back to currentTicket.
  const lastShift   = info.lastShiftTicket ?? null;
  const soldoutAt   = info.startTicket ?? currentTicket;
  const resumeDefault = lastShift ?? currentTicket;

  const detailEl = document.getElementById('restore-soldout-detail');
  if (detailEl) {
    const newStatus = _isStation(location) ? 'Activated' : 'Received';
    const locationLine =
      `<div style="margin-bottom:8px">` +
      `<span style="background:var(--green-bg);color:var(--green-text);border:1px solid var(--green-border);border-radius:999px;padding:2px 10px;font-size:11px;font-weight:700">${newStatus}</span>` +
      `<span style="color:var(--text-muted)"> at </span><strong>${location}</strong></div>`;
    // Show the discrepancy when soldout overwrote the position
    const ticketNote = (lastShift != null && lastShift !== soldoutAt)
      ? `<div style="font-size:12px;color:var(--text-muted);background:var(--amber-bg);border:1px solid var(--amber-border);border-radius:6px;padding:6px 10px;line-height:1.5">
           Last shift close: <strong>#${lastShift}</strong> &nbsp;·&nbsp; Soldout recorded at: <span style="color:var(--accent)">#${soldoutAt}</span><br>
           <span style="font-size:11px">Resuming from last shift close — adjust below if needed.</span>
         </div>`
      : `<div style="font-size:12px;color:var(--text-muted)">Was at ticket <strong>#${resumeDefault}</strong></div>`;
    detailEl.innerHTML = locationLine + ticketNote;
  }

  const ticketInp = document.getElementById('restore-soldout-ticket');
  if (ticketInp) { ticketInp.value = resumeDefault; ticketInp.focus(); }

  document.getElementById('restore-soldout-modal').classList.add('open');
}

function closeRestoreSoldOutModal() {
  document.getElementById('restore-soldout-modal').classList.remove('open');
  _pendingRestorePackId   = null;
  _pendingRestoreLocation = null;
}

async function confirmRestoreSoldOut(e) {
  if (e) e.preventDefault();
  if (!_pendingRestorePackId || !_pendingRestoreLocation) return;
  const ticketInp = document.getElementById('restore-soldout-ticket');
  const ticket = ticketInp ? (parseInt(ticketInp.value, 10) || 0) : 0;
  const btn = document.getElementById('restore-soldout-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    const packId   = _pendingRestorePackId;
    const location = _pendingRestoreLocation;
    const newStatus = _isStation(location) ? 'activated' : 'received';
    // Preserve start_ticket as-is; re-anchor last_shift_ticket so the next audit
    // computes sold tickets correctly from the confirmed resume position.
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: newStatus, location, start_ticket: ticket, last_shift_ticket: ticket, station_line: null }) });
    const note = _pendingRestoreType === 'removed'
      ? `Restored from removed — ${newStatus} at ${location}, starting ticket #${ticket}`
      : `Restored from accidental soldout → ${newStatus} at ${location}`;
    _logPackEvent(packId, 'restored', { location_to: location, ticket_after: ticket, notes: note });
    _pendingRestoreType = null;
    closeRestoreSoldOutModal();
    await loadLotteryStock(); loadLotteryDbStats();
  } catch (err) { showError('Restore failed', err.message); }
  finally { if (btn) btn.disabled = false; }
}

// ===== ACTIVATION MODAL =====

// ===== EDIT PACK POSITION / END =====

function openEditPackModal(id, startTicket, endTicket, e) {
  if (e) e.preventDefault();
  requireAdmin(() => _doOpenEditPackModal(id, startTicket, endTicket));
}

function _doOpenEditPackModal(id, startTicket, endTicket) {
  _pendingEditPackId = id;
  const info = _packInfoCache[id] || {};
  const infoEl = document.getElementById('edit-pack-info');
  if (infoEl) infoEl.textContent = info.gameName ? `${info.gameName} · Book #${info.packNumber}` : `Book ID: ${id}`;
  const sInp = document.getElementById('edit-pack-start');
  const eInp = document.getElementById('edit-pack-end');
  if (sInp) sInp.value = startTicket != null ? String(startTicket) : '';
  if (eInp) eInp.value = endTicket   != null ? String(endTicket)   : '';
  document.getElementById('edit-pack-modal').classList.add('open');
  setTimeout(() => sInp?.focus(), 120);
}

function closeEditPackModal() {
  document.getElementById('edit-pack-modal').classList.remove('open');
  _pendingEditPackId = null;
}

async function confirmEditPack(e) {
  if (e) e.preventDefault();
  if (!_pendingEditPackId) return;
  const sVal = document.getElementById('edit-pack-start').value;
  const eVal = document.getElementById('edit-pack-end').value;
  const update = {};
  if (sVal !== '') {
    const s = parseInt(sVal, 10);
    if (isNaN(s) || s < 0) { showError('Invalid', 'Enter a valid current position.'); return; }
    update.start_ticket = s;
    update.last_shift_ticket = s;
  }
  if (eVal !== '') {
    const en = parseInt(eVal, 10);
    if (isNaN(en) || en < 0) { showError('Invalid', 'Enter a valid end ticket number.'); return; }
    update.end_ticket = en;
  }
  if (!Object.keys(update).length) { closeEditPackModal(); return; }
  const btn = document.getElementById('edit-pack-confirm-btn');
  if (btn) btn.disabled = true;
  const prevTicket = (_packInfoCache[_pendingEditPackId] || {}).startTicket;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(_pendingEditPackId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(update) });
    _logPackEvent(_pendingEditPackId, 'adjusted', {
      ticket_before: prevTicket ?? null,
      ticket_after:  update.start_ticket ?? null,
      notes: update.end_ticket != null ? `end set to ${update.end_ticket}` : null,
    });
    closeEditPackModal();
    await loadLotteryStock();
  } catch (err) {
    showError('Save failed', err.message);
  } finally { if (btn) btn.disabled = false; }
}

function openActivationForm(id, location, e) {
  if (e) e.preventDefault();
  if (!_canMoveOrActivate()) { showError('No day open', 'Open a day first.'); return; }
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
    if (_actDir === 'desc' && ticketsPerPack === 0) {
      showError('Tickets per pack unknown', 'Cannot activate in descending order — the game\'s ticket count is not loaded. Go to the Catalog tab and verify the game exists, then try again.');
      if (btn) btn.disabled = false;
      return;
    }
    startTicket = _actDir === 'desc' ? ticketsPerPack - 1 : 0;
  }
  const update = { status: 'activated', location, start_ticket: startTicket, last_shift_ticket: startTicket };
  if (_dbCaps.hasLoadingDirection) update.loading_direction = _actDir;
  const btn = document.getElementById('activation-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(update) });
    _logPackEvent(id, 'activated', { location_to: location, ticket_after: startTicket,
      notes: `${_actType} · ${_actDir}` });
    closeActivationModal();
    await loadLotteryStock(); loadLotteryDbStats();
    await _refreshInvAfterLoad();
    loadReceiveQueue();
  } catch (err) { showError('Activation failed', err.message); }
  finally { if (btn) btn.disabled = false; }
}

// ===== PACK ROW RENDERERS =====

// Single source of truth: can packs be moved or activated right now?
function _canMoveOrActivate() {
  return _dbCaps.hasFullDayTracking ? !!_currentDay : true;
}

function _packActionHtml(p) {
  if (!_canMoveOrActivate()) return '';
  if (p.status === 'received') {
    const loc      = p.location || 'Office';
    const stations = _getStations();
    const extras   = _getExtraLocs();
    const stagingLocs = [..._FIXED_STAGING, ...extras].filter(l => l !== loc);
    const moveButtons = stagingLocs.map(dest =>
      `<button class="pack-act-btn act-move-office${loc === dest ? ' act-move-active' : ''}"
        onmousedown="moveReceivedPack('${p.id}','${dest}',event)"
        ontouchstart="moveReceivedPack('${p.id}','${dest}',event)">${dest}</button>`
    ).join('');
    const stationButtons = stations.map(st =>
      `<button class="pack-act-btn act-station"
        onmousedown="openActivationForm('${p.id}','${st}',event)"
        ontouchstart="openActivationForm('${p.id}','${st}',event)">${st}</button>`
    ).join('');
    return `<div class="pack-move-row">
      <span class="pack-move-label">Move to</span>
      ${moveButtons}
      ${stationButtons}
    </div>`;
  }
  if (p.status === 'activated') {
    if (_dbCaps.hasFullDayTracking && !_currentDay && !_currentShift) return '';
    return `<button class="pack-act-btn act-soldout"
      onmousedown="openSoldOutModal('${p.id}',${p.start_ticket},event)"
      ontouchstart="openSoldOutModal('${p.id}',${p.start_ticket},event)">Sold Out</button>`;
  }
  if (p.status === 'removed') {
    const locs = [..._getStations(), ..._getExtraLocs(), 'Extra'];
    const btns = locs.map(loc =>
      `<button class="pack-act-btn act-station"
        onmousedown="restoreRemovedPack('${p.id}','${loc}',event)"
        ontouchstart="restoreRemovedPack('${p.id}','${loc}',event)">${loc}</button>`
    ).join('');
    return `<div class="pack-move-row"><span class="pack-move-label">Bring back to</span>${btns}</div>`;
  }
  if (p.status === 'soldout') {
    const locs = [..._getStations(), 'Office'];
    const btns = locs.map(loc =>
      `<button class="pack-act-btn act-station" style="font-size:11px;padding:5px 10px"
        onmousedown="restoreSoldOutPack('${p.id}','${loc}',${p.start_ticket ?? 0},event)"
        ontouchstart="restoreSoldOutPack('${p.id}','${loc}',${p.start_ticket ?? 0},event)">↩ ${loc}</button>`
    ).join('');
    return `<div class="pack-move-row"><span class="pack-move-label">Restore to</span>${btns}</div>`;
  }
  return '';
}

function _packRemoveBtn(p) {
  if (!_canMoveOrActivate()) return '';
  if (p.status === 'activated') return `
    <button class="pack-remove-btn"
      onmousedown="removePackAtTicket('${p.id}',${p.start_ticket},event)"
      ontouchstart="removePackAtTicket('${p.id}',${p.start_ticket},event)" title="Remove at ticket #">✕</button>`;
  if (p.status === 'received') return `
    <button class="pack-remove-btn"
      onmousedown="removePackAtTicket('${p.id}',null,event)"
      ontouchstart="removePackAtTicket('${p.id}',null,event)" title="Remove">✕</button>`;
  return '';
}

function _packEditBtn(p) {
  if (p.status !== 'activated') return '';
  return `<button class="pack-remove-btn" style="color:var(--ink-60);font-size:13px" title="Edit ticket position"
    onmousedown="openEditPackModal('${p.id}',${p.start_ticket ?? 0},${p.end_ticket ?? 'null'},event)"
    ontouchstart="openEditPackModal('${p.id}',${p.start_ticket ?? 0},${p.end_ticket ?? 'null'},event)">✎</button>`;
}

function renderPackRow(p, ticketsPerPack, gameName, price) {
  _packInfoCache[p.id] = { ticketsPerPack, gameName: gameName || '', gameNumber: p.game_number, packNumber: p.pack_number, startTicket: p.start_ticket, endTicket: p.end_ticket ?? null, lastShiftTicket: p.last_shift_ticket ?? null, loadingDirection: (p.loading_direction || 'asc').toLowerCase(), location: p.location, price: parseFloat(price || 0) };
  const st       = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const locCss   = PACK_LOC_CSS[p.location] || 'loc-office';
  const isActive = p.status === 'activated';
  const dir      = p.loading_direction;
  const pct      = (isActive && ticketsPerPack > 0)
    ? ((dir || 'asc') === 'desc'
        ? Math.round(((ticketsPerPack - 1 - p.start_ticket) / (ticketsPerPack - 1 || 1)) * 100)
        : Math.round((p.start_ticket / ticketsPerPack) * 100))
    : 0;
  const dirPill   = dir ? _dirPill(dir) : '';
  const ticketInfo = (p.status !== 'received') ? _ticketAt(p.start_ticket, p.status) : '';
  return `
    <div class="lottery-stock-book" id="stock-row-${p.id}">
      <div class="lottery-book-info">
        <span class="lottery-book-label">#${p.pack_number}</span>
        <span class="pack-status-pill ${st.css}">${st.label}</span>
        ${p.location && (isActive || p.status === 'received') ? `<span class="pack-loc-pill ${locCss}">${p.location}</span>` : ''}
        ${dirPill}${ticketInfo}
      </div>
      ${isActive && ticketsPerPack > 0 ? `<div class="lottery-book-bar-wrap"><div class="lottery-book-bar" style="width:${pct}%"></div></div>` : ''}
      <div class="lottery-book-actions">${_packActionHtml(p)}${_packEditBtn(p)}${_packRemoveBtn(p)}</div>
    </div>`;
}

function renderPackRowByLoc(p) {
  const game   = p.lottery_games || {};
  const gName  = game.game_name || `Game #${p.game_number}`;
  const price  = parseFloat(game.price || 0);
  const tpp    = game.tickets_per_pack || 0;
  _packInfoCache[p.id] = { ticketsPerPack: tpp, gameName: gName, gameNumber: p.game_number, packNumber: p.pack_number, startTicket: p.start_ticket, endTicket: p.end_ticket ?? null, lastShiftTicket: p.last_shift_ticket ?? null, loadingDirection: (p.loading_direction || 'asc').toLowerCase(), location: p.location, price, stationLine: p.station_line ?? null };
  const st      = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const isActive = p.status === 'activated';
  const dir     = p.loading_direction;
  const pct     = (isActive && tpp > 0)
    ? ((dir || 'asc') === 'desc'
        ? Math.round(((tpp - 1 - p.start_ticket) / (tpp - 1 || 1)) * 100)
        : Math.round((p.start_ticket / tpp) * 100))
    : 0;
  // Slot button — prominent left column for activated station books
  const slotBtn = (isActive && _isStation(p.location))
    ? (p.station_line != null
        ? `<button class="pack-line-btn" onclick="openSlotPicker('${p.id}','${p.location}')" title="Line ${p.station_line} — tap to change">${p.station_line}</button>`
        : `<button class="pack-line-btn pack-line-unset" onclick="openSlotPicker('${p.id}','${p.location}')" title="Assign line slot">+</button>`)
    : '';
  return `
    <div class="lottery-stock-book">
      ${slotBtn}
      <div class="lottery-book-body">
        <div class="lottery-book-info">
          <span class="lottery-book-label">#${p.pack_number}</span>
          <span class="item-badge lottery-price-badge" style="font-size:10px">$${price.toFixed(2)}</span>
          <span class="pack-status-pill ${st.css}">${st.label}</span>
          ${dir ? _dirPill(dir) : ''}
          ${p.status !== 'received' ? _ticketAt(p.start_ticket, p.status) : ''}
          <span style="font-size:11px;color:var(--text-muted)">${gName}</span>
        </div>
        ${isActive && tpp > 0 ? `<div class="lottery-book-bar-wrap"><div class="lottery-book-bar" style="width:${pct}%"></div></div>` : ''}
      </div>
      <div class="lottery-book-actions">${_packActionHtml(p)}${_packEditBtn(p)}${_packRemoveBtn(p)}</div>
    </div>`;
}

// ===== SLOT PICKER =====

let _pendingSlotPackId   = null;
let _pendingSlotLocation = null;

function openSlotPicker(packId, location) {
  _pendingSlotPackId   = packId;
  _pendingSlotLocation = location;

  const slotCount  = _getStationSlotCount(location);
  const info       = _packInfoCache[packId] || {};
  const currentSlot = info.stationLine ?? null;

  // Build occupancy map from cache — skip the pack being reassigned
  const occupied = {}; // { slotNum: { gameName, packNumber } }
  for (const [pid, pi] of Object.entries(_packInfoCache)) {
    if (pi.location === location && pi.stationLine != null && pid !== packId) {
      occupied[pi.stationLine] = pi;
    }
  }

  document.getElementById('slot-picker-title').textContent = `${location} — assign line`;
  const bookEl = document.getElementById('slot-picker-book');
  if (bookEl) bookEl.textContent = info.gameName ? `${info.gameName} · #${info.packNumber}` : '';

  const gridEl = document.getElementById('slot-picker-grid');
  if (slotCount) {
    let html = '<div class="slot-picker-grid">';
    for (let i = 1; i <= slotCount; i++) {
      const isCurrent = i === currentSlot;
      const takenBy   = occupied[i];
      const cls = isCurrent ? 'slot-btn slot-btn-current'
                : takenBy   ? 'slot-btn slot-btn-taken'
                : 'slot-btn';
      const title = takenBy
        ? `Taken by ${takenBy.gameName} #${takenBy.packNumber}`
        : isCurrent ? 'Currently assigned' : `Assign to Line ${i}`;
      const takenLbl = takenBy
        ? `<span class="slot-btn-taken-lbl">#${String(takenBy.packNumber).slice(-3)}</span>`
        : '';
      html += `<button class="${cls}" title="${title}" onclick="confirmSlotAssignment(${i})"><span>${i}</span>${takenLbl}</button>`;
    }
    html += '</div>';
    gridEl.innerHTML = html;
  } else {
    // No slot count configured — free-form number input
    gridEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0">
        <span style="font-size:13px;color:var(--text-muted)">Line</span>
        <input id="slot-picker-free-input" type="number" min="1"
          class="settings-slots-input" style="width:72px"
          value="${currentSlot ?? ''}" placeholder="—" />
        <button class="modal-add-btn" style="margin:0;padding:8px 16px"
          onclick="confirmSlotAssignment(parseInt(document.getElementById('slot-picker-free-input').value,10))">Assign</button>
      </div>`;
  }

  const clearBtn = document.getElementById('slot-picker-clear');
  if (clearBtn) clearBtn.style.display = currentSlot != null ? '' : 'none';

  document.getElementById('slot-picker-modal').classList.add('open');
}

async function confirmSlotAssignment(slotNum) {
  if (!_pendingSlotPackId || !slotNum || isNaN(slotNum) || slotNum < 1) return;
  const packId   = _pendingSlotPackId;
  const location = _pendingSlotLocation;

  // Double-check occupancy (cache may have been stale)
  for (const [pid, pi] of Object.entries(_packInfoCache)) {
    if (pi.location === location && pi.stationLine === slotNum && pid !== packId) {
      showError(`Slot ${slotNum} is taken`,
        `${location} Line ${slotNum} is occupied by ${pi.gameName} #${pi.packNumber}. Unassign it first.`);
      return;
    }
  }

  document.getElementById('slot-picker-modal').classList.remove('open');
  _pendingSlotPackId = null;
  _pendingSlotLocation = null;

  try {
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ station_line: slotNum }) }
    );
    await loadLotteryStock();
  } catch (e) {
    showError('Failed to assign slot', e.message);
  }
}

async function clearPackSlot(packId) {
  document.getElementById('slot-picker-modal').classList.remove('open');
  _pendingSlotPackId   = null;
  _pendingSlotLocation = null;

  try {
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ station_line: null }) }
    );
    await loadLotteryStock();
  } catch (e) {
    showError('Failed to clear slot', e.message);
  }
}

function closeSlotPicker() {
  _pendingSlotPackId   = null;
  _pendingSlotLocation = null;
  document.getElementById('slot-picker-modal').classList.remove('open');
}

