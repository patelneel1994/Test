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
let _receiveLocation     = 'Office';
let _pendingMoveId       = null;
let _showInactiveGames   = false;
let _pendingEditPackId   = null;
let _currentDay          = null;
let _currentShift        = null;
let _dbCapsChecked       = false;
const _dbCaps            = { hasLoadingDirection: false, hasFullDayTracking: false, hasPackEvents: false };
const _packInfoCache     = {};

// ---- Inventory state ----
let _invContext       = null;
let _invPacks         = [];     // active packs
let _invReceivedPacks = [];     // received (not yet activated) packs — shown in open-day/shift
let _invData          = {};     // pack_id → ticket number
let _invSoldOut       = {};     // pack_id → finalTicket — staged sold-outs, committed on confirm
let _invScanCleanup   = null;

// ---- DB-state load guard ----
let _lotteryDbStateReady = false;

// ===== DB CAPABILITIES CHECK =====
// Run once; determines which columns/tables exist so queries don't crash.
async function checkDbCapabilities() {
  if (_dbCapsChecked) return;
  _dbCapsChecked = true;
  try {
    const [lRes, dRes, sRes, eRes] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=loading_direction&limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days?limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?select=day_id,opened_at,status&limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?limit=0`),
    ]);
    _dbCaps.hasLoadingDirection = lRes.ok;
    _dbCaps.hasFullDayTracking  = dRes.ok && sRes.ok;
    _dbCaps.hasPackEvents       = eRes.ok;
  } catch (_) {}
}

// ===== PACK EVENT LOGGER =====

function _logPackEvent(packId, action, details = {}) {
  if (!_dbCaps.hasPackEvents || !packId) return;
  const event = {
    pack_id: packId,
    action,
    ...(_currentShift?.id ? { shift_id: _currentShift.id } : {}),
    ...(_currentDay?.id   ? { day_id:   _currentDay.id   } : {}),
    ...details,
  };
  // fire-and-forget — does not block the main action
  sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(event) }).catch(() => {});
}

// ===== INVENTORY SCAN =====

const _INV_OPTIONAL = new Set(['open-day']);
const _INV_TITLES   = {
  'open-day':    'Day Open — Inventory Check',
  'close-shift': 'Change Shift — Inventory (Required)',
  'close-day':   'Day Close — Inventory (Required)',
};

async function openInventory(context, skipPrompt = false) {
  if (_dbCaps.hasFullDayTracking) {
    if (context.startsWith('close') && !_currentDay) {
      showError('No day open', 'Open a day first.'); return;
    }
    if (context === 'close-shift' && !skipPrompt) {
      if (!_currentShift) {
        showError('No active shift', 'No shift is open for this day. Close and reopen the day to start a fresh shift.');
        return;
      }
      // Prompt user whether to audit inventory first
      document.getElementById('shift-audit-modal').classList.add('open');
      return;
    }
  }

  _invContext = context;
  _invData    = {};
  _invSoldOut = {};
  const isClose    = context.startsWith('close');
  const isOptional = _INV_OPTIONAL.has(context);

  document.getElementById('inv-modal-title').textContent     = _INV_TITLES[context] || 'Inventory';
  document.getElementById('inv-skip-btn').style.display      = isOptional ? '' : 'none';
  document.getElementById('inv-totals-row').style.display    = isClose    ? '' : 'none';
  const confirmLbl = { 'open-day':'Open Day', 'close-shift':'Confirm & Change Shift', 'close-day':'Confirm Day Close' };
  document.getElementById('inv-confirm-btn').textContent = confirmLbl[context] || 'Confirm';

  const listEl = document.getElementById('inv-book-list');

  try {
    const sel = _dbCaps.hasLoadingDirection
      ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)`
      : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)`;
    const base = `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&order=location.asc,pack_number.asc&limit=200`;
    const isOpenDay = context === 'open-day';
    const fetches = [sbFetch(`${base}&status=eq.activated`)];
    if (isOpenDay) fetches.push(sbFetch(`${base}&status=eq.received`));
    const results = await Promise.all(fetches);
    const jsons   = await Promise.all(results.map(r => r.json()));
    _invPacks         = Array.isArray(jsons[0]) ? jsons[0] : [];
    _invReceivedPacks = isOpenDay && Array.isArray(jsons[1]) ? jsons[1] : [];

    // Auto-commit when nothing to audit
    if (!_invPacks.length && !_invReceivedPacks.length) {
      if (context === 'open-day')           await _invCommitOpenDay();
      else if (context.startsWith('close')) await _invCommitClose(context === 'close-day' ? 'day' : 'shift');
      return;
    }

    // Only open the modal once we know there's something to show
    listEl.innerHTML = '';
    document.getElementById('inventory-modal').classList.add('open');
    _renderInvList();
    _updateInvProgress();
  } catch (err) {
    document.getElementById('inventory-modal').classList.add('open');
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

// Opens activation modal for a received pack while the inventory modal is open.
// After activation the inventory list refreshes automatically.
function loadReceivedPack(packId, location, e) {
  if (e) e.preventDefault();
  openActivationForm(packId, location, e);
}

async function _refreshInvAfterLoad() {
  if (!document.getElementById('inventory-modal').classList.contains('open')) return;
  const sel     = _dbCaps.hasLoadingDirection
    ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)`
    : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)`;
  const base    = `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&order=location.asc,pack_number.asc&limit=200`;
  const isOpenDay = _invContext === 'open-day';
  const fetches = [sbFetch(`${base}&status=eq.activated`)];
  if (isOpenDay) fetches.push(sbFetch(`${base}&status=eq.received`));
  const results = await Promise.all(fetches);
  const jsons   = await Promise.all(results.map(r => r.json()));
  _invPacks         = Array.isArray(jsons[0]) ? jsons[0] : [];
  _invReceivedPacks = isOpenDay && Array.isArray(jsons[1]) ? jsons[1] : [];
  _renderInvList();
  _updateInvProgress();
}

function closeInventoryModal() {
  document.getElementById('inventory-modal').classList.remove('open');
  if (_invScanCleanup) { _invScanCleanup(); _invScanCleanup = null; }
  _invContext = null; _invPacks = []; _invReceivedPacks = []; _invData = {}; _invSoldOut = {};
}

// ===== AUDIT SOLD-OUT STAGING =====

function _invMarkSoldOut(packId) {
  const info = _packInfoCache[packId] || {};
  const finalTicket = _calcSoldOutFinalTicket(info);
  if (finalTicket == null) { showError('Cannot mark sold out', 'Ticket count unknown for this book.'); return; }
  _invSoldOut[packId] = finalTicket;
  _invData[packId]    = finalTicket;
  _renderInvList();
  _updateInvProgress();
}

function _invUnmarkSoldOut(packId) {
  delete _invSoldOut[packId];
  delete _invData[packId];
  _renderInvList();
  _updateInvProgress();
}

// ===== SHIFT AUDIT PROMPT =====
function closeShiftAuditModal() {
  document.getElementById('shift-audit-modal').classList.remove('open');
}

function doAuditShiftChange(e) {
  if (e) e.preventDefault();
  closeShiftAuditModal();
  openInventory('close-shift', true);
}

async function doSkipShiftChange(e) {
  if (e) e.preventDefault();
  const btn = e && e.currentTarget;
  if (btn) btn.disabled = true;
  closeShiftAuditModal();
  try {
    _invContext = 'close-shift';
    _invPacks   = [];
    _invData    = {};
    await _invCommitClose('shift');
  } catch (err) {
    showError('Shift change failed', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ===== RESET DATA =====
async function openResetModal() {
  document.getElementById('reset-data-modal').classList.add('open');
  const el = document.getElementById('reset-current-counts');
  if (!el) return;
  el.textContent = 'Loading…';
  try {
    const base = CONFIG.supabaseUrl + '/rest/v1/';
    const cnt  = url => sbFetch(`${base}${url}&limit=1`, { headers: { 'Prefer': 'count=exact' } })
      .then(r => parseInt((r.headers.get('content-range') || '0/0').split('/')[1] || '0', 10));
    const [shifts, entries, events, books, games] = await Promise.all([
      cnt('lottery_shifts?select=id'),
      cnt('lottery_shift_entries?select=id'),
      _dbCaps.hasPackEvents ? cnt('lottery_pack_events?select=id') : Promise.resolve(0),
      cnt('lottery_packs?select=id'),
      cnt('lottery_games?select=game_number'),
    ]);
    const item = (n, label) => n > 0
      ? `<span class="reset-count-item reset-count-has">${n} ${label}</span>`
      : `<span class="reset-count-item reset-count-none">0 ${label}</span>`;
    el.innerHTML =
      `<span class="reset-count-label">Currently:</span>` +
      item(shifts,  shifts  === 1 ? 'shift'  : 'shifts')  +
      item(entries, entries === 1 ? 'entry'  : 'entries') +
      item(events,  events  === 1 ? 'event'  : 'events')  +
      item(books,   books   === 1 ? 'book'   : 'books')   +
      item(games,   games   === 1 ? 'game'   : 'games');
  } catch (_) {
    el.textContent = '';
  }
}
function closeResetModal() {
  document.getElementById('reset-data-modal').classList.remove('open');
}

async function confirmReset(mode, e) {
  if (e) e.preventDefault();
  const btn = e && e.currentTarget;
  if (btn) btn.disabled = true;
  closeResetModal();
  try {
    const base = CONFIG.supabaseUrl + '/rest/v1/';

    // Step 1 — reset all non-received packs back to received (books/catalog modes delete packs entirely instead)
    if (mode !== 'catalog' && mode !== 'books') {
      await sbFetch(`${base}lottery_packs?status=in.(activated,soldout,removed)`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'received', location: null, start_ticket: null,
            last_shift_ticket: null, loading_direction: null }) });
    }

    // Step 2 — fetch all shift IDs (needed to cascade-delete entries)
    const allShiftsRes = await sbFetch(`${base}lottery_shifts?select=id&limit=1000`);
    const allShifts    = await allShiftsRes.json();
    const allShiftIds  = Array.isArray(allShifts) ? allShifts.map(s => s.id).filter(Boolean) : [];

    // Step 3 — delete shift entries + pack events (all/books/catalog modes) in parallel
    const childDeletes = [];
    if (allShiftIds.length) {
      childDeletes.push(
        sbFetch(`${base}lottery_shift_entries?shift_id=in.(${allShiftIds.join(',')})`, { method: 'DELETE' })
      );
    }
    if ((mode === 'all' || mode === 'books' || mode === 'catalog') && _dbCaps.hasPackEvents) {
      childDeletes.push(sbFetch(`${base}lottery_pack_events?id=not.is.null`, { method: 'DELETE' }));
    }
    if (childDeletes.length) await Promise.all(childDeletes);

    // Step 4 — delete shifts then days
    if (allShiftIds.length) {
      await sbFetch(`${base}lottery_shifts?id=in.(${allShiftIds.join(',')})`, { method: 'DELETE' });
    }
    await sbFetch(`${base}lottery_days?id=not.is.null`, { method: 'DELETE' });

    // Step 5 — books: delete all packs but keep game catalog
    if (mode === 'books') {
      await sbFetch(`${base}lottery_packs?id=not.is.null`, { method: 'DELETE' });
    }

    // Step 6 — catalog: delete all packs then all games
    if (mode === 'catalog') {
      await sbFetch(`${base}lottery_packs?id=not.is.null`, { method: 'DELETE' });
      await sbFetch(`${base}lottery_games?game_number=not.is.null`, { method: 'DELETE' });
    }

    _currentDay   = null;
    _currentShift = null;
    updateDayShiftButtons();
    await Promise.all([loadLotteryStock(), loadShiftHistory()]);
    loadLotteryDbStats();
    loadReceiveQueue();
    if (mode === 'books' || mode === 'catalog') loadLotteryCatalog();
  } catch (err) {
    showError('Reset failed', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _renderInvList() {
  const el      = document.getElementById('inv-book-list');
  const isClose = _invContext && _invContext.startsWith('close');
  const isOpenDay = _invContext === 'open-day';

  if (!_invPacks.length && !_invReceivedPacks.length) {
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

  let html = !_invPacks.length
    ? '<div class="log-empty" style="border:none;padding:4px 0 8px">No active books.</div>'
    : '';
  for (const loc of locOrder) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;
    html += `<div class="shift-loc-section"><div class="shift-loc-header">${loc}</div>`;
    for (const p of packs) {
      const game     = p.lottery_games || {};
      const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const hasVal   = p.id in _invData;
      const scanned  = _invData[p.id];
      const dir      = (p.loading_direction || 'asc').toLowerCase();
      // Populate cache so remove/soldout modals have game name + pack info
      _packInfoCache[p.id] = {
        ticketsPerPack:    game.tickets_per_pack || 0,
        gameName:          game.game_name || '',
        packNumber:        p.pack_number,
        startTicket:       p.start_ticket,
        endTicket:         p.end_ticket ?? null,
        lastShiftTicket:   p.last_shift_ticket ?? null,
        loadingDirection:  (p.loading_direction || 'asc').toLowerCase(),
        location:          p.location,
      };
      const dirPill   = `<span class="pack-dir-pill ${dir === 'desc' ? 'dir-desc' : 'dir-asc'}">${dir === 'desc' ? '↓ DESC' : '↑ ASC'}</span>`;
      const baseLabel = isClose ? 'Last close' : 'Last at';

      // ── Sold-out staged in this audit session ──
      if (p.id in _invSoldOut) {
        const finalTicket = _invSoldOut[p.id];
        const sold = _soldTickets(finalTicket, baseline, dir);
        html += `
          <div class="inv-book-row inv-scanned inv-row-soldout" id="inv-row-${p.id}">
            <div class="inv-status" id="inv-status-${p.id}">✓</div>
            <div class="inv-book-main">
              <div class="inv-book-name">${game.game_name || `Game #${p.game_number}`}
                <span class="inv-book-num">#${p.pack_number}</span>
                <span class="pack-status-pill status-soldout">Sold Out</span>
                ${dirPill}
              </div>
              <div class="inv-book-meta">${baseLabel} <strong>#${baseline}</strong> → Final <strong>#${finalTicket}</strong> · ${sold} ticket${sold !== 1 ? 's' : ''} sold</div>
            </div>
            <div class="inv-row-right">
              <button class="pack-act-btn"
                onmousedown="_invUnmarkSoldOut('${p.id}')"
                ontouchstart="_invUnmarkSoldOut('${p.id}')">Undo</button>
            </div>
          </div>`;
        continue;
      }

      // ── Normal row ──
      const constraint = dir === 'desc' ? `enter ≤ ${baseline}` : `enter ≥ ${baseline}`;
      let discHtml = '';
      if (isOpenDay && hasVal && scanned !== baseline) {
        const diff   = dir === 'desc' ? (baseline - scanned) : (scanned - baseline);
        const isLoss = diff > 0;
        discHtml = `<div class="inv-disc ${isLoss ? 'inv-disc-warn' : 'inv-disc-ok'}">
          Expected #${baseline} — got #${scanned}${isLoss ? ` · ⚠ ${diff} ticket${diff !== 1 ? 's' : ''} unaccounted` : ' · OK'}
        </div>`;
      }
      const soldOutBtn = `<button class="pack-act-btn act-soldout"
            onmousedown="_invMarkSoldOut('${p.id}')"
            ontouchstart="_invMarkSoldOut('${p.id}')">Sold Out</button>`;
      const removeBtn = isOpenDay ? `<button class="pack-remove-btn"
            onmousedown="removePackAtTicket('${p.id}',${p.start_ticket ?? 0},event)"
            ontouchstart="removePackAtTicket('${p.id}',${p.start_ticket ?? 0},event)" title="Remove">✕</button>` : '';
      const actionsHtml = `<div class="inv-row-actions">${soldOutBtn}${removeBtn}</div>`;
      html += `
        <div class="inv-book-row${hasVal ? ' inv-scanned' : ''}" id="inv-row-${p.id}">
          <div class="inv-status" id="inv-status-${p.id}">${hasVal ? '✓' : '○'}</div>
          <div class="inv-book-main">
            <div class="inv-book-name">${game.game_name || `Game #${p.game_number}`}
              <span class="inv-book-num">#${p.pack_number}</span>
              ${dirPill}
            </div>
            <div class="inv-book-meta">${baseLabel} <strong>#${baseline}</strong> · <span class="inv-constraint">${constraint}</span></div>
            ${discHtml}
            <div class="inv-book-calc" id="inv-calc-${p.id}"></div>
          </div>
          <div class="inv-row-right">
            <input type="number" class="shift-ticket-input" id="inv-inp-${p.id}"
              value="${hasVal ? scanned : ''}" placeholder="#"
              min="0" oninput="_handleInvManual('${p.id}')" />
            ${actionsHtml}
          </div>
        </div>`;
    }
    html += '</div>';
  }
  // ── Received books section (open-day only — load during shift via Receive tab) ──
  if (isOpenDay && _invReceivedPacks.length) {
    const recLabel = 'Load received books into this day';
    html += `<div class="inv-rec-section">
      <div class="inv-rec-header">${recLabel}</div>`;
    for (const p of _invReceivedPacks) {
      const game = p.lottery_games || {};
      _packInfoCache[p.id] = {
        ticketsPerPack:   game.tickets_per_pack || 0,
        gameName:         game.game_name || '',
        packNumber:       p.pack_number,
        startTicket:      p.start_ticket ?? null,
        endTicket:        p.end_ticket ?? null,
        lastShiftTicket:  p.last_shift_ticket ?? null,
        loadingDirection: (p.loading_direction || 'asc').toLowerCase(),
        location:         null,
      };
      html += `
        <div class="inv-rec-row" id="inv-rec-${p.id}">
          <div class="inv-book-main">
            <div class="inv-book-name">${game.game_name || `Game #${p.game_number}`}
              <span class="inv-book-num">#${p.pack_number}</span>
            </div>
            <div class="inv-book-meta">Received · not yet active</div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0">
            <button class="pack-act-btn act-station"
              onmousedown="loadReceivedPack('${p.id}','Station Booth',event)"
              ontouchstart="loadReceivedPack('${p.id}','Station Booth',event)">Load to Station</button>
          </div>
        </div>`;
    }
    html += `</div>`;
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
  const result = parseLotteryBarcode(raw);
  if (!result) { _flashInvScanError(); return; }

  let parsed, pack;
  if (result.ambiguous) {
    // Resolve by matching against loaded pack list
    for (const candidate of result.candidates) {
      pack = _invPacks.find(p => p.game_number === candidate.gameNumber && p.pack_number === candidate.packNumber);
      if (pack) { parsed = candidate; break; }
    }
    if (!pack) { _flashInvScanError('Book not in active list'); return; }
  } else {
    parsed = result;
    pack = _invPacks.find(p => p.game_number === parsed.gameNumber && p.pack_number === parsed.packNumber);
    if (!pack) { _flashInvScanError('Book not in active list'); return; }
  }

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
  const row = document.getElementById(`inv-row-${packId}`);
  const st  = document.getElementById(`inv-status-${packId}`);
  if (!isNaN(val) && val >= 0) {
    _invData[packId] = val;
    const isClose = _invContext && _invContext.startsWith('close');
    const violation = isClose ? _invDirectionViolation(packId, val) : false;
    inp.classList.toggle('inv-input-error', violation);
    if (row) { row.classList.toggle('inv-scanned', !violation); row.classList.toggle('inv-row-violation', violation); }
    if (st)  st.textContent = violation ? '⚠' : '✓';
  } else {
    delete _invData[packId];
    inp.classList.remove('inv-input-error');
    if (row) { row.classList.remove('inv-scanned'); row.classList.remove('inv-row-violation'); }
    if (st)  st.textContent = '○';
  }
  if (_invContext && _invContext.startsWith('close')) { _updateInvCalc(packId); _updateInvTotals(); }
  _updateInvProgress();
}

function _invDirectionViolation(packId, val) {
  const p = _invPacks.find(x => x.id === packId);
  if (!p) return false;
  const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
  if (baseline == null) return false;
  const dir = (p.loading_direction || 'asc').toLowerCase();
  return dir === 'desc' ? val > baseline : val < baseline;
}

function _updateInvCalc(packId) {
  const p      = _invPacks.find(x => x.id === packId);
  const calcEl = document.getElementById(`inv-calc-${packId}`);
  if (!p || !calcEl || !(packId in _invData)) { if (calcEl) calcEl.textContent = ''; return; }
  const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
  const dir      = (p.loading_direction || 'asc').toLowerCase();
  const val      = _invData[packId];
  if (_invDirectionViolation(packId, val)) {
    const expected = dir === 'desc' ? `≤ ${baseline}` : `≥ ${baseline}`;
    calcEl.innerHTML = `<span class="inv-dir-error">⚠ Ticket must be ${expected} (${dir.toUpperCase()})</span>`;
    return;
  }
  const price = parseFloat(p.lottery_games?.price || 0);
  const sold  = _soldTickets(val, baseline, dir);
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

  const isClose   = _invContext && _invContext.startsWith('close');
  const isOpenDay = _invContext === 'open-day';

  // Violation check (close contexts)
  let hasViolation = false;
  if (isClose) {
    for (const p of _invPacks) {
      if (!(p.id in _invData) || (p.id in _invSoldOut)) continue;
      if (_invDirectionViolation(p.id, _invData[p.id])) { hasViolation = true; break; }
    }
  }

  // Discrepancy panel (open-day only)
  const discEl = document.getElementById('inv-disc-summary');
  if (discEl) {
    if (isOpenDay) {
      const mismatches = _invPacks.filter(p => {
        if (!(p.id in _invData) || (p.id in _invSoldOut)) return false;
        const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
        return baseline != null && _invData[p.id] !== baseline;
      });
      if (mismatches.length) {
        const rows = mismatches.map(p => {
          const game     = p.lottery_games || {};
          const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
          const scanned  = _invData[p.id];
          const dir      = (p.loading_direction || 'asc').toLowerCase();
          const diff     = dir === 'desc' ? baseline - scanned : scanned - baseline;
          return `<div class="inv-disc-row">
            <span><strong>${game.game_name || `Game #${p.game_number}`}</strong> #${p.pack_number}</span>
            <span>Expected <strong>#${baseline}</strong> · Got <strong>#${scanned}</strong> · ⚠ ${Math.abs(diff)} ticket${Math.abs(diff) !== 1 ? 's' : ''} unaccounted</span>
          </div>`;
        }).join('');
        discEl.style.display = '';
        discEl.innerHTML = `<div class="inv-disc-summary-box">
          <div class="inv-disc-summary-hdr">⚠ ${mismatches.length} discrepanc${mismatches.length !== 1 ? 'ies' : 'y'} — numbers don't match last close</div>
          ${rows}
        </div>`;
      } else {
        discEl.style.display = 'none';
        discEl.innerHTML = '';
      }
    } else {
      discEl.style.display = 'none';
      discEl.innerHTML = '';
    }
  }

  const confirmBtn = document.getElementById('inv-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = (!_INV_OPTIONAL.has(_invContext) && done < total && total > 0) || hasViolation;
}

async function confirmInventory(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('inv-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    if (_invContext === 'open-day')         await _invCommitOpenDay();
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
  // Create day
  const dayRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'open' }) });
  const days = await dayRes.json();
  _currentDay = Array.isArray(days) && days[0] ? days[0] : null;
  _currentShift = null;

  // Log discrepancies (scanned ticket ≠ last close baseline) before updating baselines
  for (const p of _invPacks) {
    if (!(p.id in _invData) || (p.id in _invSoldOut)) continue;
    const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    if (baseline != null && _invData[p.id] !== baseline) {
      _logPackEvent(p.id, 'discrepancy', {
        ticket_before: baseline,
        ticket_after:  _invData[p.id],
        notes: `open-day mismatch: expected #${baseline}, scanned #${_invData[p.id]}`,
      });
    }
  }

  // Update baselines from inventory scan (skip staged sold-outs — handled separately below)
  const nonSoldOutEntries = Object.entries(_invData).filter(([id]) => !(id in _invSoldOut));
  if (nonSoldOutEntries.length) {
    await Promise.all(nonSoldOutEntries.map(([id, ticket]) =>
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ start_ticket: ticket, last_shift_ticket: ticket }) })));
  }

  // Commit staged sold-outs
  if (Object.keys(_invSoldOut).length) {
    await Promise.all(Object.entries(_invSoldOut).map(([id, finalTicket]) => {
      _logPackEvent(id, 'soldout', {
        ticket_before: (_packInfoCache[id] || {}).lastShiftTicket ?? (_packInfoCache[id] || {}).startTicket ?? null,
        ticket_after: finalTicket, context: 'open-day',
      });
      return sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'soldout', start_ticket: finalTicket, last_shift_ticket: finalTicket }) });
    }));
  }

  // Auto-open first shift
  if (_currentDay) {
    const shiftRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ day_id: _currentDay.id, shift_type: 'shift',
          opened_at: new Date().toISOString(), status: 'open', total_tickets_sold: 0, total_revenue: 0 }) });
    const shifts = await shiftRes.json();
    _currentShift = Array.isArray(shifts) && shifts[0] ? shifts[0] : null;
  }

  updateDayShiftButtons();
  await loadLotteryStock();
}

async function _invCommitOpenShift() {
  // No longer used — shift opens automatically after day open and after each shift close.
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

  // Log and commit sold-out packs, update ticket position for all others
  for (const [id, finalTicket] of Object.entries(_invSoldOut)) {
    _logPackEvent(id, 'soldout', {
      ticket_before: (_packInfoCache[id] || {}).lastShiftTicket ?? (_packInfoCache[id] || {}).startTicket ?? null,
      ticket_after: finalTicket, context: _invContext,
    });
  }
  await Promise.all(_invPacks.map(p => {
    const tick      = _invData[p.id] != null ? _invData[p.id] : p.start_ticket;
    const isSoldOut = p.id in _invSoldOut;
    const extra     = isSoldOut ? { status: 'soldout' } : {};
    return sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(p.id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ start_ticket: tick, last_shift_ticket: tick, ...extra }) });
  }));

  _currentShift = null;

  // Change Shift: auto-open next shift immediately after closing
  if (type === 'shift' && _currentDay) {
    const newShiftRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ day_id: _currentDay.id, shift_type: 'shift',
          opened_at: new Date().toISOString(), status: 'open', total_tickets_sold: 0, total_revenue: 0 }) });
    const newShifts = await newShiftRes.json();
    _currentShift = Array.isArray(newShifts) && newShifts[0] ? newShifts[0] : null;
  }

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
  } else {
    el.innerHTML = `
      <span class="day-status-badge day-status-day">Day Open</span>
      <button class="log-act-btn" onclick="openInventory('close-shift')">Change Shift</button>
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
function _parseSingleBarcode(raw, clean, gameDigits) {
  const g = gameDigits, packEnd = g + 6, tickEnd = packEnd + 3;
  if (clean.length < tickEnd) return null;
  return {
    raw, clean,
    gameNumber:     clean.slice(0, g),
    packNumber:     clean.slice(g, packEnd),
    ticketPosition: parseInt(clean.slice(packEnd, tickEnd), 10),
    formatted:      `${clean.slice(0, g)}-${clean.slice(g, packEnd)}-${clean.slice(packEnd, tickEnd)}`,
  };
}

function parseLotteryBarcode(raw) {
  const clean = raw.replace(/[^0-9]/g, '');

  // Unambiguous lengths: 12 → 3-digit game; 13–14 → 4-digit game
  if (clean.length === 12) return _parseSingleBarcode(raw, clean, 3);
  if (clean.length === 13 || clean.length === 14) return _parseSingleBarcode(raw, clean, 4);

  // Long barcodes (≥15 digits, e.g. 22-digit scanner output):
  // Legacy tickets use 3-digit game numbers, newer ones use 4-digit.
  // Return both candidates — caller must resolve via DB or pack list.
  if (clean.length > 14) {
    return {
      raw, clean, ambiguous: true,
      candidates: [
        _parseSingleBarcode(raw, clean, 3),  // legacy
        _parseSingleBarcode(raw, clean, 4),  // new
      ].filter(Boolean),
    };
  }
  return null;
}

// ===== RECEIVE =====

function submitLotteryInput() {
  const v = document.getElementById('lottery-input').value.trim();
  if (v) lookupLotteryTicket(v);
}

async function _resolveAmbiguousBarcode(result) {
  // Try both candidates against DB; prefer 4-digit (new) if both exist, fall back to 3-digit (legacy)
  const games = await Promise.all(result.candidates.map(c => fetchLotteryGame(c.gameNumber).catch(() => null)));
  for (let i = games.length - 1; i >= 0; i--) {
    if (games[i]) return result.candidates[i];
  }
  // Neither game exists — return 3-digit candidate so "no-game" flow can offer to create it
  return result.candidates[0];
}

async function lookupLotteryTicket(raw) {
  const inp = document.getElementById('lottery-input');
  inp.value = '';
  const result = parseLotteryBarcode(raw);
  if (!result) {
    renderLotteryResult({ type: 'error', msg: `Cannot parse "${raw}" — expected 12+ digits.` });
    refocusLottery(); return;
  }
  renderLotteryResult({ type: 'loading' });
  try {
    const parsed = result.ambiguous ? await _resolveAmbiguousBarcode(result) : result;
    _currentLotteryParse = parsed;
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

function setReceiveLocation(loc) {
  _receiveLocation = loc;
  document.getElementById('recv-loc-office').classList.toggle('active', loc === 'Office');
  document.getElementById('recv-loc-front').classList.toggle('active',  loc === 'Front - Extra');
}

async function doReceivePack(parsed, game) {
  renderLotteryResult({ type: 'loading' });
  try {
    const newPackRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({
          game_number: parsed.gameNumber, pack_number: parsed.packNumber,
          raw_barcode: parsed.raw, start_ticket: parsed.ticketPosition,
          end_ticket: game.tickets_per_pack - 1, last_shift_ticket: parsed.ticketPosition,
          status: 'received', location: _receiveLocation,
        }) });
    const newPacks = await newPackRes.json();
    const newPackId = Array.isArray(newPacks) && newPacks[0] ? newPacks[0].id : null;
    _logPackEvent(newPackId, 'received', { location_to: _receiveLocation, ticket_after: parsed.ticketPosition });
    _lotterySession.unshift({
      gameNumber: parsed.gameNumber, packNumber: parsed.packNumber,
      gameName: game.game_name, price: game.price, ticketsPerPack: game.tickets_per_pack,
      startTicket: parsed.ticketPosition, formatted: parsed.formatted, receivedAt: new Date(),
    });
    renderLotteryResult({ type: 'success', parsed, game });
    renderLotteryLog(); renderLotteryStats(); loadLotteryDbStats();
    loadReceiveQueue();
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
  const s = document.getElementById('lottery-stat-session');
  const t = document.getElementById('lottery-stat-tickets');
  if (s) s.textContent = _lotterySession.length;
  if (t) t.textContent = _lotterySession.reduce((sum, e) => sum + e.ticketsPerPack, 0);
}

async function loadLotteryDbStats() {
  try {
    const cnt = url => sbFetch(`${CONFIG.supabaseUrl}/rest/v1/${url}&limit=1`, { headers: { 'Prefer': 'count=exact' } })
      .then(r => (r.headers.get('content-range') || '').split('/')[1] || '0');
    const [active, received, soldout, total, recPacks] = await Promise.all([
      cnt('lottery_packs?select=id&status=eq.activated'),
      cnt('lottery_packs?select=id&status=eq.received'),
      cnt('lottery_packs?select=id&status=eq.soldout'),
      cnt('lottery_packs?select=id'),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id,location&status=eq.received&order=location.asc&limit=200`)
        .then(r => r.json()).catch(() => []),
    ]);
    document.getElementById('lottery-stat-db-packs').textContent = active;
    document.getElementById('lottery-stat-games').textContent    = received;
    const soEl = document.getElementById('lottery-stat-soldout');
    const totEl = document.getElementById('lottery-stat-total');
    if (soEl)  soEl.textContent  = soldout;
    if (totEl) totEl.textContent = total;
    // Update filter badge counts
    const sfA = document.getElementById('sf-active');
    const sfR = document.getElementById('sf-received');
    const sfS = document.getElementById('sf-soldout');
    if (sfA) sfA.textContent = active;
    if (sfR) sfR.textContent = received;
    if (sfS) sfS.textContent = soldout;
    // Received stock by location
    _renderReceivedStockBar(Array.isArray(recPacks) ? recPacks : []);
  } catch (_) {}
}

function _renderReceivedStockBar(packs) {
  const el = document.getElementById('received-stock-bar');
  if (!el) return;
  if (!packs.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const byLoc = {};
  for (const p of packs) {
    const loc = p.location || 'Unassigned';
    byLoc[loc] = (byLoc[loc] || 0) + 1;
  }
  const locOrder = ['Station Booth', 'Front - Extra', 'Office', 'Unassigned'];
  const pills = locOrder
    .filter(l => byLoc[l])
    .map(l => `<span class="recv-loc-pill">${l}<strong>${byLoc[l]}</strong></span>`)
    .join('');
  // Any locations not in locOrder
  const extra = Object.entries(byLoc)
    .filter(([l]) => !locOrder.includes(l))
    .map(([l, n]) => `<span class="recv-loc-pill">${l}<strong>${n}</strong></span>`)
    .join('');
  el.innerHTML = `<span class="recv-stock-label">In Stock</span>${pills}${extra}`;
  el.style.display = 'flex';
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

let _pendingRemoveId = null;

function removePackAtTicket(id, currentTicket, e) {
  if (e) e.preventDefault();
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
    closeRemoveModal();
    await loadLotteryStock(); loadLotteryDbStats();
    await _refreshInvAfterLoad(); loadReceiveQueue();
  } catch (err) {
    showError('Remove failed', err.message);
  } finally { if (btn) btn.disabled = false; }
}

let _pendingSoldOutId = null;

let _pendingSoldOutFinalTicket = null;

function _calcSoldOutFinalTicket(info) {
  const dir = info.loadingDirection || 'asc';
  const tpp = info.ticketsPerPack || 0;
  if (tpp <= 0) return null;
  // Use game's tickets_per_pack as the source of truth for the absolute end of the book.
  // ASC books run 0 → tpp-1; DESC books run tpp-1 → 0.
  return dir === 'desc' ? 0 : tpp - 1;
}

function openSoldOutModal(id, _unused, e) {
  if (e) e.preventDefault();
  _pendingSoldOutId = id;
  const info = _packInfoCache[id] || {};
  const dir  = info.loadingDirection || 'asc';

  const finalTicket = _calcSoldOutFinalTicket(info);
  _pendingSoldOutFinalTicket = finalTicket;

  const baseline  = info.lastShiftTicket != null ? info.lastShiftTicket : info.startTicket;
  const sold      = (finalTicket != null && baseline != null) ? _soldTickets(finalTicket, baseline, dir) : null;
  const dirLabel  = dir === 'desc' ? '↓ DESC' : '↑ ASC';

  const infoEl = document.getElementById('soldout-book-info');
  if (infoEl) infoEl.textContent = info.gameName ? `${info.gameName} · Book #${info.packNumber}` : `Book ID: ${id}`;

  const detailEl = document.getElementById('soldout-detail');
  if (detailEl) {
    if (finalTicket != null) {
      const soldLine = sold != null ? `${sold} ticket${sold !== 1 ? 's' : ''} sold` : '';
      detailEl.innerHTML = `
        <div class="soldout-calc-row">
          <span class="pack-dir-pill ${dir === 'desc' ? 'dir-desc' : 'dir-asc'}">${dirLabel}</span>
          ${baseline != null ? `Last at <strong>#${baseline}</strong> →` : ''}
          Final ticket <strong>#${finalTicket}</strong>
        </div>
        ${soldLine ? `<div class="soldout-sold-line">${soldLine}</div>` : ''}`;
    } else {
      detailEl.innerHTML = `<div class="soldout-calc-row" style="color:var(--text-hint)">End ticket unknown — cannot auto-calculate</div>`;
    }
  }

  document.getElementById('soldout-modal').classList.add('open');
}

function closeSoldOutModal() {
  document.getElementById('soldout-modal').classList.remove('open');
  _pendingSoldOutId = null;
  _pendingSoldOutFinalTicket = null;
}

async function confirmSoldOut(e) {
  if (e) e.preventDefault();
  if (!_pendingSoldOutId) return;
  const finalTicket = _pendingSoldOutFinalTicket;
  if (finalTicket == null) { showError('Cannot mark sold out', 'End ticket is unknown for this pack.'); return; }
  const btn = document.getElementById('soldout-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    const prevTicket = (_packInfoCache[_pendingSoldOutId] || {}).startTicket;
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(_pendingSoldOutId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'soldout', start_ticket: finalTicket, last_shift_ticket: finalTicket }) });
    _logPackEvent(_pendingSoldOutId, 'soldout', { ticket_before: prevTicket ?? null, ticket_after: finalTicket });
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
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(_pendingMoveId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ location: newLocation }) });
    _logPackEvent(_pendingMoveId, 'moved', { location_from: prevLocation || null, location_to: newLocation });
    closeMovePackModal();
    await loadLotteryStock();
  } catch (err) { showError('Move failed', err.message); }
}

// ===== ACTIVATION MODAL =====

// ===== EDIT PACK POSITION / END =====

function openEditPackModal(id, startTicket, endTicket, e) {
  if (e) e.preventDefault();
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

function _packActionHtml(p) {
  if (!_currentDay) return '';
  if (p.status === 'received') return `
    <button class="pack-act-btn act-station"
      onmousedown="openActivationForm('${p.id}','Station Booth',event)"
      ontouchstart="openActivationForm('${p.id}','Station Booth',event)">Load to Station</button>`;
  if (p.status === 'activated') {
    const atStation = p.location === 'Station Booth';
    const moveBtn = atStation ? '' : `
    <button class="pack-act-btn"
      onmousedown="openMovePackModal('${p.id}',event)"
      ontouchstart="openMovePackModal('${p.id}',event)">Move</button>`;
    return `${moveBtn}
    <button class="pack-act-btn act-soldout"
      onmousedown="openSoldOutModal('${p.id}',${p.start_ticket},event)"
      ontouchstart="openSoldOutModal('${p.id}',${p.start_ticket},event)">Sold Out</button>`;
  }
  // Removed packs can be re-activated at station only
  if (p.status === 'removed') return `
    <button class="pack-act-btn act-station"
      onmousedown="openActivationForm('${p.id}','Station Booth',event)"
      ontouchstart="openActivationForm('${p.id}','Station Booth',event)">Load to Station</button>`;
  return '';
}

function _packRemoveBtn(p) {
  if (!_currentDay) return '';
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

function _packEditBtn(_p) {
  return '';
}

function renderPackRow(p, ticketsPerPack, gameName) {
  _packInfoCache[p.id] = { ticketsPerPack, gameName: gameName || '', packNumber: p.pack_number, startTicket: p.start_ticket, endTicket: p.end_ticket ?? null, lastShiftTicket: p.last_shift_ticket ?? null, loadingDirection: (p.loading_direction || 'asc').toLowerCase(), location: p.location };
  const st       = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const locCss   = PACK_LOC_CSS[p.location] || 'loc-office';
  const isActive = p.status === 'activated';
  const dir      = p.loading_direction;
  const pct      = (isActive && ticketsPerPack > 0) ? Math.round((p.start_ticket / ticketsPerPack) * 100) : 0;
  const dirPill  = (isActive && dir) ? `<span class="pack-dir-pill ${dir === 'desc' ? 'dir-desc' : 'dir-asc'}">${dir === 'desc' ? '↓' : '↑'}</span>` : '';
  const ticketInfo = (p.status === 'activated')
    ? `<span class="lottery-book-at">Ticket #${p.start_ticket}</span>`
    : (p.status === 'soldout' || p.status === 'removed')
      ? `<span class="lottery-book-at" style="color:var(--text-hint)">At #${p.start_ticket}</span>`
      : '';
  return `
    <div class="lottery-stock-book">
      <div class="lottery-book-info">
        <span class="lottery-book-label">#${p.pack_number}</span>
        <span class="pack-status-pill ${st.css}">${st.label}</span>
        ${p.location && isActive ? `<span class="pack-loc-pill ${locCss}">${p.location}</span>` : ''}
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
  _packInfoCache[p.id] = { ticketsPerPack: tpp, gameName: gName, packNumber: p.pack_number, startTicket: p.start_ticket, endTicket: p.end_ticket ?? null, lastShiftTicket: p.last_shift_ticket ?? null, loadingDirection: (p.loading_direction || 'asc').toLowerCase(), location: p.location };
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
      <div class="lottery-book-actions">${_packActionHtml(p)}${_packEditBtn(p)}${_packRemoveBtn(p)}</div>
    </div>`;
}

// ===== LOTTERY CATALOG (game definitions) =====

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig; }, 1500); }
  }).catch(() => { if (btn) btn.textContent = 'Failed'; });
}

function _renderBarcodeBreakdown(raw) {
  if (!raw) return '<div class="bc-none">No barcode on file</div>';
  const clean = raw.replace(/[^0-9]/g, '');
  let segments;
  if (clean.length === 14) {
    segments = [
      { val: clean.slice(0, 4),  label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(4, 10), label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(10,13), label: 'Ticket #', cls: 'bc-ticket' },
      { val: clean.slice(13),    label: 'Check',    cls: 'bc-check'  },
    ];
  } else if (clean.length === 13) {
    segments = [
      { val: clean.slice(0, 4),  label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(4, 10), label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(10),    label: 'Ticket #', cls: 'bc-ticket' },
    ];
  } else if (clean.length === 12) {
    segments = [
      { val: clean.slice(0, 3),  label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(3, 9),  label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(9),     label: 'Ticket #', cls: 'bc-ticket' },
    ];
  } else {
    return `<div class="bc-raw">${raw}</div><div class="bc-none">Unrecognized format (${clean.length} digits)</div>`;
  }

  const fullDisplay = segments.map(s => `<span class="bc-seg ${s.cls}">${s.val}</span>`).join('<span class="bc-sep">-</span>');
  const legend = segments.map(s =>
    `<div class="bc-legend-item"><span class="bc-legend-dot ${s.cls}"></span><span class="bc-legend-label">${s.label}</span><span class="bc-legend-val">${s.val}</span></div>`
  ).join('');
  // raw is all-digits so safe in onclick attribute
  return `
    <div class="bc-full-row">
      <div class="bc-full">${fullDisplay}</div>
      <button class="bc-copy-btn" onclick="copyToClipboard('${clean}',this)" title="Copy barcode">Copy</button>
    </div>
    <div class="bc-legend">${legend}</div>`;
}

const _catalogGameCache = {};

function toggleInactiveGames() {
  _showInactiveGames = !_showInactiveGames;
  const btn = document.getElementById('catalog-inactive-btn');
  if (btn) btn.classList.toggle('active', _showInactiveGames);
  loadLotteryCatalog();
}

async function loadLotteryCatalog() {
  const el = document.getElementById('lottery-catalog-container');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  const activeFilter = _showInactiveGames ? '' : '&active=eq.true';
  try {
    const [gRes, pRes] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games?select=game_number,game_name,price,tickets_per_pack,active&order=game_number.asc${activeFilter}&limit=200`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=game_number,status,raw_barcode&order=game_number.asc,id.asc&limit=1000`),
    ]);
    const games = await gRes.json();
    const packs = await pRes.json();
    if (!gRes.ok) throw new Error(games?.message || `[${gRes.status}]`);

    if (!Array.isArray(games) || !games.length) {
      el.innerHTML = '<div class="log-empty">No games in catalog yet.</div>';
      return;
    }

    // Count packs per game by status; grab first raw_barcode seen per game
    const packCounts  = {};
    const sampleBarcode = {};
    for (const p of (Array.isArray(packs) ? packs : [])) {
      const gn = p.game_number;
      if (!packCounts[gn]) packCounts[gn] = { activated: 0, received: 0, soldout: 0, removed: 0, total: 0 };
      packCounts[gn].total++;
      if (packCounts[gn][p.status] !== undefined) packCounts[gn][p.status]++;
      if (!sampleBarcode[gn] && p.raw_barcode) sampleBarcode[gn] = p.raw_barcode;
    }

    // Cache game data for edit modal lookup (avoids encoding in onclick)
    for (const g of games) _catalogGameCache[g.game_number] = g;

    let html = '<div class="catalog-table">';
    for (const g of games) {
      const price    = parseFloat(g.price || 0);
      const tpp      = parseInt(g.tickets_per_pack || 0, 10);
      const bookCost = price * tpp;
      const cnts     = packCounts[g.game_number] || {};
      const active   = cnts.activated || 0;
      const received = cnts.received  || 0;
      const soldout  = cnts.soldout   || 0;
      const total    = cnts.total     || 0;
      const stockParts = [
        total ? `${total} total` : '0',
        active   ? `<span class="catalog-cnt-active">${active} active</span>`   : '',
        received ? `<span class="catalog-cnt-rcvd">${received} received</span>` : '',
        soldout  ? `<span class="catalog-cnt-sold">${soldout} sold out</span>`  : '',
      ].filter(Boolean).join(' · ');

      const canEdit = total === 0;
      const gn = g.game_number;
      const editBtns = canEdit
        ? `<button class="catalog-edit-btn" onclick="openEditGame('${gn}')">Edit</button>
           ${g.active
             ? `<button class="catalog-del-btn" onclick="softDeleteGame('${gn}')">Deactivate</button>`
             : `<button class="catalog-edit-btn" onclick="reactivateGame('${gn}')">Reactivate</button>`}`
        : `<span class="catalog-in-use">In use — ${total} book${total !== 1 ? 's' : ''}</span>`;

      html += `
        <div class="catalog-row" id="catalog-row-${g.game_number}">
          <div class="catalog-row-top">
            <div class="catalog-game-num">#${g.game_number}</div>
            <div class="catalog-game-name">${g.game_name || '—'}</div>
            ${g.active ? '<span class="pack-status-pill st-activated">Active</span>' : '<span class="pack-status-pill st-removed">Inactive</span>'}
            <div class="catalog-row-actions">${editBtns}</div>
          </div>
          <div class="catalog-meta-grid">
            <div class="catalog-meta-cell">
              <div class="catalog-meta-label">Ticket Price</div>
              <div class="catalog-meta-val">$${price.toFixed(2)}</div>
            </div>
            <div class="catalog-meta-cell">
              <div class="catalog-meta-label">Tickets / Roll</div>
              <div class="catalog-meta-val">${tpp > 0 ? tpp.toLocaleString() : '—'}</div>
            </div>
            <div class="catalog-meta-cell">
              <div class="catalog-meta-label">Book Cost</div>
              <div class="catalog-meta-val">$${bookCost > 0 ? bookCost.toFixed(2) : '—'}</div>
            </div>
            <div class="catalog-meta-cell">
              <div class="catalog-meta-label">Books in Stock</div>
              <div class="catalog-meta-val" style="font-size:13px">${stockParts || '0'}</div>
            </div>
          </div>
          <div class="catalog-barcode-section">
            <div class="catalog-meta-label" style="margin-bottom:6px">Barcode</div>
            ${_renderBarcodeBreakdown(sampleBarcode[g.game_number])}
          </div>
        </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

// ===== CATALOG EDIT / SOFT DELETE =====

let _editGameNumber = null;

function openEditGame(gameNumber) {
  const g = _catalogGameCache[gameNumber];
  if (!g) return;
  _editGameNumber = g.game_number;
  document.getElementById('edit-game-info').textContent = `Game #${g.game_number}`;
  document.getElementById('edit-game-name').value  = g.game_name  || '';
  document.getElementById('edit-game-price').value = g.price      != null ? g.price : '';
  document.getElementById('edit-game-tpp').value   = g.tickets_per_pack > 0 ? g.tickets_per_pack : '';
  document.getElementById('edit-game-modal').classList.add('open');
  setTimeout(() => document.getElementById('edit-game-name').focus(), 120);
}

function closeEditGameModal() {
  document.getElementById('edit-game-modal').classList.remove('open');
  _editGameNumber = null;
}

async function confirmEditGame(e) {
  if (e) e.preventDefault();
  if (!_editGameNumber) return;
  const name  = (document.getElementById('edit-game-name').value || '').trim();
  const price = parseFloat(document.getElementById('edit-game-price').value);
  const tpp   = parseInt(document.getElementById('edit-game-tpp').value, 10);
  if (!name)               { showError('Missing field', 'Game name is required.'); return; }
  if (isNaN(price) || price <= 0) { showError('Missing field', 'Enter a valid ticket price.'); return; }
  if (isNaN(tpp)   || tpp <= 0)   { showError('Missing field', 'Enter tickets per roll.'); return; }
  const btn = document.getElementById('edit-game-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(_editGameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ game_name: name, price, tickets_per_pack: tpp }) }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    closeEditGameModal();
    loadLotteryCatalog();
  } catch (err) {
    showError('Save failed', err.message);
    if (btn) btn.disabled = false;
  }
}

async function softDeleteGame(gameNumber) {
  if (!confirm(`Deactivate game #${gameNumber}? It will be hidden from active games but kept in history.`)) return;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(gameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ active: false }) }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    loadLotteryCatalog();
  } catch (err) {
    showError('Deactivate failed', err.message);
  }
}

async function reactivateGame(gameNumber) {
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(gameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ active: true }) }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    loadLotteryCatalog();
  } catch (err) {
    showError('Reactivate failed', err.message);
  }
}

// ===== STOCK VIEW =====

let _stockStatusFilter = 'active';

function setStockFilter(filter) {
  _stockStatusFilter = filter;
  document.querySelectorAll('.stock-filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.filter === filter)
  );
  loadLotteryStock();
}

function setStockView(mode) {
  _stockViewMode = mode;
  document.getElementById('stock-view-game').classList.toggle('active', mode === 'game');
  document.getElementById('stock-view-loc').classList.toggle('active', mode === 'location');
  if (_cachedStockRows) renderLotteryStock(_cachedStockRows);
}

async function loadLotteryStock() {
  const el = document.getElementById('lottery-stock-container');
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  const select = _dbCaps.hasLoadingDirection
    ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,status,location,lottery_games(game_name,price,tickets_per_pack)`
    : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,status,location,lottery_games(game_name,price,tickets_per_pack)`;
  const statusQ = {
    active:   'status=eq.activated',
    received: 'status=eq.received',
    soldout:  'status=eq.soldout',
    removed:  'status=eq.removed',
    all:      'status=in.(received,activated,soldout,removed)',
  }[_stockStatusFilter] || 'status=in.(received,activated,soldout)';
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${select}&${statusQ}&order=game_number.asc,status.asc,pack_number.asc&limit=500`
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
  const totActive    = sorted.reduce((s, g) => s + g.packs.filter(p => p.status === 'activated').length, 0);
  const totAll       = sorted.reduce((s, g) => s + g.packs.length, 0);
  el.innerHTML = `
    <div class="lottery-stock-table">
      ${sorted.map(g => {
        const activated = g.packs.filter(p => p.status === 'activated');
        const received  = g.packs.filter(p => p.status === 'received');
        const soldOut   = g.packs.filter(p => p.status === 'soldout');
        const removed   = g.packs.filter(p => p.status === 'removed');
        const visible   = [...activated, ...received, ...soldOut, ...removed];
        return `
          <div class="lottery-stock-game">
            <div class="lottery-stock-row">
              <div class="lottery-stock-name">${g.gameName}
                <span class="item-badge lottery-price-badge">$${parseFloat(g.price).toFixed(2)}</span>
              </div>
              <div class="lottery-stock-packs">${visible.length} book${visible.length !== 1 ? 's' : ''}</div>
              <div class="lottery-stock-open-pill ${activated.length > 0 ? 'is-open' : ''}">${activated.length} active</div>
            </div>
            <div class="lottery-stock-books">
              ${visible.map(p => renderPackRow(p, g.ticketsPerPack, g.gameName)).join('')}
            </div>
          </div>`;
      }).join('')}
      <div class="lottery-stock-total"><span>${totAll} book${totAll !== 1 ? 's' : ''}</span><span>${totActive} active</span></div>
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

function _historyDateFilters() {
  const from = document.getElementById('history-date-from')?.value;
  const to   = document.getElementById('history-date-to')?.value;
  const parts = [];
  if (from) parts.push(`opened_at=gte.${from}T00:00:00`);
  if (to)   parts.push(`opened_at=lte.${to}T23:59:59`);
  return parts.length ? '&' + parts.join('&') : '';
}

function _initHistoryFilter() {
  // Only initialize once (inputs already have values → already set)
  const fromEl = document.getElementById('history-date-from');
  if (!fromEl || fromEl.value) return;
  setHistoryPreset('month');
}

function _onHistoryDateChange() {
  // Clear preset highlight when user manually edits dates
  ['month', 'lastmonth', 'all'].forEach(p => {
    document.getElementById(`hpreset-${p}`)?.classList.remove('active');
  });
  loadShiftHistory();
}

function setHistoryPreset(preset) {
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = now.getMonth(); // 0-based
  let from, to;

  if (preset === 'month') {
    from = new Date(y, m, 1);
    to   = new Date(y, m + 1, 0); // last day of this month
  } else if (preset === 'lastmonth') {
    from = new Date(y, m - 1, 1);
    to   = new Date(y, m, 0); // last day of last month
  } else {
    from = null; to = null; // all time
  }

  const fmt = d => d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : '';
  const fromEl = document.getElementById('history-date-from');
  const toEl   = document.getElementById('history-date-to');
  if (fromEl) fromEl.value = fmt(from);
  if (toEl)   toEl.value   = fmt(to);

  ['month', 'lastmonth', 'all'].forEach(p => {
    document.getElementById(`hpreset-${p}`)?.classList.toggle('active', p === preset);
  });
  loadShiftHistory();
}

async function loadShiftHistory() {
  const el = document.getElementById('shift-history-container');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  const dateFilter = _historyDateFilters();
  try {
    if (_dbCaps.hasFullDayTracking) {
      const eventsSelect = _dbCaps.hasPackEvents
        ? `,lottery_pack_events(id,action,location_from,location_to,ticket_before,ticket_after,notes,created_at,lottery_packs(pack_number,game_number,lottery_games(game_name)))`
        : '';
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_days` +
        `?select=id,opened_at,closed_at,status,total_tickets_sold,total_revenue,lottery_shifts(id,opened_at,closed_at,total_tickets_sold,total_revenue,status,lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,lottery_packs(pack_number,game_number,lottery_games(game_name)))${eventsSelect})` +
        `&order=opened_at.desc&limit=60${dateFilter}`
      );
      const days = await res.json();
      renderDayHistory(Array.isArray(days) ? days : []);
    } else {
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
        `?select=id,shift_type,closed_at,total_tickets_sold,total_revenue,lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,lottery_packs(pack_number,game_number,lottery_games(game_name,price)))` +
        `&order=closed_at.desc&limit=60${dateFilter.replace(/opened_at/g, 'closed_at')}`
      );
      const shifts = await res.json();
      renderShiftHistory(Array.isArray(shifts) ? shifts : []);
    }
  } catch (e) {
    if (el) el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

function _packEventDetail(ev) {
  switch (ev.action) {
    case 'received':  return `received → ${ev.location_to || ''}${ev.ticket_after != null ? ` at #${ev.ticket_after}` : ''}`;
    case 'activated': return `loaded to ${ev.location_to || '?'}${ev.ticket_after != null ? ` from #${ev.ticket_after}` : ''}${ev.notes ? ` (${ev.notes})` : ''}`;
    case 'moved':     return `${ev.location_from || '?'} → ${ev.location_to || '?'}`;
    case 'removed':   return `removed at #${ev.ticket_after ?? '?'}`;
    case 'soldout':   return `sold out at #${ev.ticket_after ?? '?'}`;
    case 'adjusted':  return `position ${ev.ticket_before ?? '?'} → ${ev.ticket_after ?? '?'}${ev.notes ? ` · ${ev.notes}` : ''}`;
    default:          return ev.notes || '';
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
      const events    = (s.lottery_pack_events  || []).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));

      const entriesHtml = entries.map(en => {
        const pack = en.lottery_packs || {}, game = pack.lottery_games || {};
        return `<div class="shift-history-entry">
          <span class="shift-history-entry-game">${game.game_name || `#${pack.game_number}`} #${pack.pack_number}</span>
          <span class="shift-history-entry-detail">#${en.ticket_at_open}→#${en.ticket_at_close} · ${en.tickets_sold} sold · $${parseFloat(en.revenue).toFixed(2)}</span>
        </div>`;
      }).join('');

      const eventsHtml = events.map(ev => {
        const pack = ev.lottery_packs || {}, game = pack.lottery_games || {};
        const packLabel = game.game_name ? `${game.game_name} #${pack.pack_number}` : (pack.pack_number ? `#${pack.pack_number}` : '');
        const detail = _packEventDetail(ev);
        const t = new Date(ev.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="shift-event-row ev-${ev.action}">
          <span class="shift-event-badge ev-badge-${ev.action}">${ev.action}</span>
          <span class="shift-event-pack">${packLabel}</span>
          <span class="shift-event-detail">${detail}</span>
          <span class="shift-event-time">${t}</span>
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
          ${eventsHtml  ? `<div class="shift-events-list">${eventsHtml}</div>` : ''}
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

async function _ensureLotteryDbState() {
  if (_lotteryDbStateReady) return;
  _lotteryDbStateReady = true;
  await checkDbCapabilities();
  await loadCurrentDayShift();
}

// Receive sub-section — called when switching to receive sub-tab
function initReceiveTab() {
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
      `?select=id,pack_number,location,lottery_games(game_name,price,tickets_per_pack)` +
      `&status=eq.received&order=location.asc,pack_number.asc&limit=200`
    );
    const packs = await res.json();
    if (!Array.isArray(packs) || !packs.length) {
      el.innerHTML = '<div class="log-empty" style="border:none">No received packs — scan a barcode above to receive one.</div>';
      return;
    }
    const locOrder = ['Station Booth', 'Front - Extra', 'Office'];
    const byLoc = {};
    for (const p of packs) {
      const loc = p.location || 'Unassigned';
      if (!byLoc[loc]) byLoc[loc] = [];
      byLoc[loc].push(p);
    }
    const allLocs = [...locOrder, ...Object.keys(byLoc).filter(l => !locOrder.includes(l))];
    const canLoad = !!_currentDay && !!_currentShift;
    let html = '';
    for (const loc of allLocs) {
      const ps = byLoc[loc];
      if (!ps) continue;
      html += `<div class="shift-loc-section"><div class="shift-loc-header">${loc} <span style="font-weight:400;opacity:.55">(${ps.length})</span></div>`;
      for (const p of ps) {
        const game = p.lottery_games || {};
        html += `
          <div class="inv-rec-row">
            <div class="inv-book-main">
              <div class="inv-book-name">${game.game_name || `Pack #${p.pack_number}`}
                <span class="inv-book-num">#${p.pack_number}</span>
              </div>
              <div class="inv-book-meta">$${parseFloat(game.price || 0).toFixed(2)} · ${game.tickets_per_pack || '?'} tickets</div>
            </div>
            ${canLoad ? `
              <div style="display:flex;gap:5px;flex-shrink:0">
                <button class="pack-act-btn act-station"
                  onmousedown="openActivationForm('${p.id}','Station Booth',event)"
                  ontouchstart="openActivationForm('${p.id}','Station Booth',event)">Load to Station</button>
              </div>` : `<span style="font-size:11px;color:var(--text-hint);flex-shrink:0">${_currentDay ? 'Open a shift to load' : 'Open day to load'}</span>`}
          </div>`;
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<div class="item-nf-sub">Load failed: ${err.message}</div>`;
  }
}

// Lottery tab — inventory management + day/shift
async function initLotteryTab() {
  await _ensureLotteryDbState();
  loadLotteryDbStats();
  loadLotteryStock();
  _initHistoryFilter();
  loadShiftHistory();
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
