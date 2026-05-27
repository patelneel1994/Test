// ===== LOTTERY MODULE =====
function _capWords(el) { el.value = el.value.replace(/\b\w/g, c => c.toUpperCase()); }

// ===== LOCATION CONFIG =====
// Stations   = places where books get activated & audited (configurable)
// Office     = fixed staging location (always present)
// Extra      = fixed secondary staging location (always present, presence-audited on open-day)
// Extra locs = optional extra staging areas (configurable)
// All stored in Supabase `lottery_locations` table; cached in memory after load.

let _locationsCache = null; // { stations: string[], extras: string[] }

function _getStations() {
  return _locationsCache ? _locationsCache.stations : ['Station 1'];
}

function _getExtraLocs() {
  return _locationsCache ? _locationsCache.extras : [];
}

async function _loadLotteryLocations() {
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_locations?select=name,type&order=sort_order.asc,id.asc`
    );
    const rows = await res.json();
    if (Array.isArray(rows)) {
      _locationsCache = {
        stations: rows.filter(r => r.type === 'station').map(r => r.name),
        extras:   rows.filter(r => r.type === 'extra').map(r => r.name),
      };
      if (!_locationsCache.stations.length) _locationsCache.stations = ['Station 1'];
    }
  } catch (_) {
    // Fallback to localStorage if table doesn't exist yet
    try {
      const s = localStorage.getItem('lottery_stations');
      const e = localStorage.getItem('lottery_extra_locs');
      _locationsCache = {
        stations: (s ? JSON.parse(s) : null) || ['Station 1'],
        extras:   (e ? JSON.parse(e) : null) || [],
      };
    } catch (_2) {
      _locationsCache = { stations: ['Station 1'], extras: [] };
    }
  }
}

// Ordered list for display: stations → extra staging → Extra → Office
function _getLocOrderAll() {
  return [..._getStations(), ..._getExtraLocs(), 'Extra', 'Office'];
}

// Fixed staging locations (hardcoded, always present)
const _FIXED_STAGING = ['Extra', 'Office'];

// Is this location a "station" (audit-eligible)?
function _isStation(loc) { return _getStations().includes(loc); }

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
let _invSelectedStation  = null;   // null = all stations
let _pendingMoveId       = null;
let _showInactiveGames   = false;
let _pendingEditPackId   = null;
let _currentDay          = null;
let _currentShift        = null;
let _shiftOpInProgress   = false;  // semaphore — blocks concurrent close/open operations
let _dayHistoryData      = [];     // cached days array — used by lazy shift-detail loader
let _dbCapsChecked       = false;
const _dbCaps            = { hasLoadingDirection: false, hasFullDayTracking: false, hasPackEvents: false };
const _packInfoCache     = {};

// ---- Inventory state ----
let _invContext       = null;
let _invBusy          = false;  // re-entry guard — prevents double-tap creating duplicate days
let _invPacks         = [];     // active packs
let _invReceivedPacks = [];     // received (not yet activated) packs — shown in open-day/shift
let _invData          = {};     // pack_id → ticket number
let _invSoldOut       = {};     // pack_id → finalTicket — staged sold-outs, committed on confirm
let _invScanCleanup   = null;

// ---- Move books modal ----
let _moveBooksQueue = []; // { id, packNumber, gameName, location }

// ---- DB-state load guard ----
let _lotteryDbStateReady = false;

// ===== ADMIN CHECK =====
// Session-level admin unlock. Expires after ADMIN_SESSION_MS of inactivity.
// Replace _adminUnlocked with a real auth lookup when a user/role system is added.
const ADMIN_SESSION_MS = 2 * 60 * 1000;  // 2 minutes
let _adminUnlocked  = false;
let _adminCallback  = null;   // pending action waiting for admin auth
let _adminExpireTimer = null; // auto-lock timer

function isAdmin() { return _adminUnlocked; }

function _lockAdmin() {
  _adminUnlocked = false;
  if (_adminExpireTimer) { clearTimeout(_adminExpireTimer); _adminExpireTimer = null; }
}

function _resetAdminTimer() {
  if (_adminExpireTimer) clearTimeout(_adminExpireTimer);
  _adminExpireTimer = setTimeout(_lockAdmin, ADMIN_SESSION_MS);
}

// Gate any action behind admin auth.
// If already unlocked, resets the expiry timer and runs callback immediately.
// Otherwise shows the admin-auth modal; callback fires on successful unlock.
function requireAdmin(callback) {
  if (_adminUnlocked) { _resetAdminTimer(); callback(); return; }
  _adminCallback = callback;
  const inp = document.getElementById('admin-auth-input');
  if (inp) inp.value = '';
  const btn = document.getElementById('admin-auth-btn');
  if (btn) btn.disabled = true;
  document.getElementById('admin-auth-modal').classList.add('open');
  setTimeout(() => inp?.focus(), 120);
}

function _onAdminAuthInput() {
  const val = (document.getElementById('admin-auth-input')?.value || '');
  const btn = document.getElementById('admin-auth-btn');
  if (btn) btn.disabled = (val !== 'Neel');
}

function confirmAdminAuth(e) {
  if (e) e.preventDefault();
  const val = (document.getElementById('admin-auth-input')?.value || '');
  if (val !== 'Neel') return;
  _adminUnlocked = true;
  _resetAdminTimer();
  closeAdminAuthModal();
  if (_adminCallback) { const cb = _adminCallback; _adminCallback = null; cb(); }
}

function closeAdminAuthModal() {
  document.getElementById('admin-auth-modal').classList.remove('open');
  _adminCallback = null;
}

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

const _INV_OPTIONAL = new Set(); // nothing is optional — open-day now requires full scan
const _INV_TITLES   = {
  'open-day':    'Day Open — Inventory Check',
  'close-shift': 'Change Shift — Inventory (Required)',
  'close-day':   'Day Close — Inventory (Required)',
};

async function openInventory(context, skipPrompt = false) {
  if (_invBusy) return;
  if (_dbCaps.hasFullDayTracking) {
    if (context === 'open-day' && _currentDay) {
      showError('Day already open', 'A day is already open. Close it before opening a new one.'); return;
    }
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

  _invBusy           = true;
  _invContext        = context;
  _invData           = {};
  _invSoldOut        = {};
  _invSelectedStation = null;

  try {
    const sel = _dbCaps.hasLoadingDirection
      ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)`
      : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)`;
    const base = `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&order=location.asc,pack_number.asc&limit=200`;
    const isOpenDay = context === 'open-day';
    const isClose   = !isOpenDay && context.startsWith('close');
    const fetches = [sbFetch(`${base}&status=eq.activated`)];
    if (isOpenDay) fetches.push(sbFetch(`${base}&status=eq.received`));
    if (isClose)   fetches.push(sbFetch(`${base}&status=eq.soldout`));
    const results = await Promise.all(fetches);
    const jsons   = await Promise.all(results.map(r => r.json()));
    _invPacks         = Array.isArray(jsons[0]) ? jsons[0] : [];
    _invReceivedPacks = isOpenDay ? (Array.isArray(jsons[1]) ? jsons[1] : []) : [];

    // Include soldout packs whose last_shift_ticket hasn't been settled yet —
    // these were marked sold-out mid-shift and need their revenue counted.
    if (isClose) {
      const soldoutPacks = Array.isArray(jsons[1]) ? jsons[1] : [];
      const unsettled = soldoutPacks.filter(p =>
        p.start_ticket != null && p.last_shift_ticket != null && p.start_ticket !== p.last_shift_ticket
      );
      for (const p of unsettled) {
        _invData[p.id]    = p.start_ticket;
        _invSoldOut[p.id] = p.start_ticket;
      }
      _invPacks = [..._invPacks, ...unsettled];
    }

    // Auto-commit when nothing to audit
    if (!_invPacks.length && !_invReceivedPacks.length) {
      if (context === 'open-day')           await _invCommitOpenDay();
      else if (context.startsWith('close')) await _invCommitClose(context === 'close-day' ? 'day' : 'shift');
      return;
    }

    // Show station picker first
    document.getElementById('inventory-modal').classList.add('open');
    _renderStationPicker();
  } catch (err) {
    document.getElementById('inventory-modal').classList.add('open');
    document.getElementById('inv-book-list').innerHTML = `<div class="item-nf-sub">Load failed: ${err.message}</div>`;
    _showAuditScanPanel();
  } finally {
    _invBusy = false;
  }
}

function _renderStationPicker() {
  const picker    = document.getElementById('audit-station-picker');
  const scanner   = document.getElementById('audit-scanner-panel');
  if (picker)  picker.style.display  = '';
  if (scanner) scanner.style.display = 'none';

  // Build list of stations that actually have active books
  const activeLocs = new Set(_invPacks.map(p => p.location).filter(Boolean));
  const stations   = _getStations().filter(s => activeLocs.has(s));

  const titleEl = document.getElementById('inv-modal-title-picker');
  if (titleEl) titleEl.textContent = _INV_TITLES[_invContext] || 'Select Station';

  const btnList = document.getElementById('audit-station-btn-list');
  if (!btnList) return;

  let html = '';
  if (stations.length === 0) {
    // No station-specific books — go straight to all
    _selectAuditStation(null);
    return;
  }
  // One button per station with active books
  for (const st of stations) {
    const count = _invPacks.filter(p => p.location === st).length;
    html += `
      <button class="audit-station-pick-btn" onclick="_selectAuditStation('${st}')">
        <div class="aspb-name">${st}</div>
        <div class="aspb-count">${count} book${count !== 1 ? 's' : ''}</div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }
  // "All stations" option (only show if more than one station has books)
  if (stations.length > 1) {
    const total = _invPacks.length;
    html += `
      <button class="audit-station-pick-btn audit-station-pick-all" onclick="_selectAuditStation(null)">
        <div class="aspb-name">All Stations</div>
        <div class="aspb-count">${total} books total</div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }
  btnList.innerHTML = html;
}

function _selectAuditStation(station) {
  _invSelectedStation = station;
  _showAuditScanPanel();
}

function _auditBackToStationPicker() {
  const picker  = document.getElementById('audit-station-picker');
  const scanner = document.getElementById('audit-scanner-panel');
  if (picker)  picker.style.display  = '';
  if (scanner) scanner.style.display = 'none';
  if (_invScanCleanup) { _invScanCleanup(); _invScanCleanup = null; }
}

function _showAuditScanPanel() {
  const picker  = document.getElementById('audit-station-picker');
  const scanner = document.getElementById('audit-scanner-panel');
  if (picker)  picker.style.display  = 'none';
  if (scanner) scanner.style.display = '';

  const context    = _invContext;
  const isClose    = context.startsWith('close');
  const isOptional = _INV_OPTIONAL.has(context);
  const stLabel    = _invSelectedStation || 'All Stations';

  const titleEl = document.getElementById('inv-modal-title');
  if (titleEl) titleEl.textContent = _INV_TITLES[context] || 'Inventory';

  const stationLabelEl = document.getElementById('audit-active-station-label');
  if (stationLabelEl) stationLabelEl.textContent = stLabel;

  document.getElementById('inv-skip-btn').style.display   = isOptional ? '' : 'none';
  document.getElementById('inv-totals-row').style.display = isClose    ? '' : 'none';
  const confirmLbl = { 'open-day': 'Open Day', 'close-shift': 'Confirm & Change Shift', 'close-day': 'Confirm Day Close' };
  document.getElementById('inv-confirm-btn').textContent = confirmLbl[context] || 'Confirm';
  const notesInp = document.getElementById('inv-notes-input');
  if (notesInp) notesInp.value = '';

  document.getElementById('inv-book-list').innerHTML = '';
  _renderInvList();
  _updateInvProgress();

  // Wire scan input
  const scanInp = document.getElementById('inv-scan-input');
  if (!scanInp) return;
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
  _invSelectedStation = null;
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
function _onResetConfirmInput() {
  const val = (document.getElementById('reset-confirm-input')?.value || '');
  const unlocked = val === 'Neel';
  document.querySelectorAll('#reset-data-modal .reset-opt').forEach(btn => {
    btn.disabled = !unlocked;
  });
}

async function openResetModal() {
  const inp = document.getElementById('reset-confirm-input');
  if (inp) inp.value = '';
  document.querySelectorAll('#reset-data-modal .reset-opt').forEach(btn => { btn.disabled = true; });
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
  const inp = document.getElementById('reset-confirm-input');
  if (inp) inp.value = '';
  document.querySelectorAll('#reset-data-modal .reset-opt').forEach(btn => { btn.disabled = true; });
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
  const el        = document.getElementById('inv-book-list');
  const isClose   = _invContext && _invContext.startsWith('close');
  const isOpenDay = _invContext === 'open-day';

  if (!_invPacks.length && !_invReceivedPacks.length) {
    el.innerHTML = '<div class="audit-empty">No active books — press Confirm to proceed.</div>';
    return;
  }

  const locOrder = _getLocOrderAll();
  const byLoc = {};
  for (const p of _invPacks) {
    const loc = p.location || 'Office';
    if (_invSelectedStation && loc !== _invSelectedStation) continue;
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(p);
  }

  let html = '';
  for (const loc of locOrder) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;
    html += `<div class="audit-loc-group"><div class="audit-loc-label">${loc}</div>`;
    for (const p of packs) {
      const game     = p.lottery_games || {};
      const tpp      = game.tickets_per_pack || 0;
      const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const hasVal   = p.id in _invData;
      const scanned  = _invData[p.id];
      const dir      = (p.loading_direction || 'asc').toLowerCase();
      const dotColor = _gameColor(p.game_number);
      _packInfoCache[p.id] = {
        ticketsPerPack:    tpp,
        gameName:          game.game_name || '',
        packNumber:        p.pack_number,
        startTicket:       p.start_ticket,
        endTicket:         p.end_ticket ?? null,
        lastShiftTicket:   p.last_shift_ticket ?? null,
        loadingDirection:  dir,
        location:          p.location,
      };

      // ── Sold-out staged ──
      if (p.id in _invSoldOut) {
        const finalTicket = _invSoldOut[p.id];
        const sold = _soldTickets(finalTicket, baseline, dir) + 1;
        const pct  = 100;
        html += `
          <div class="audit-book-card audit-book-soldout" id="inv-row-${p.id}">
            <div class="audit-book-dot" style="background:${dotColor}">${String(p.game_number).slice(-2)}</div>
            <div class="audit-book-body">
              <div class="audit-book-hdr">
                <span class="audit-book-name">${game.game_name || `Game #${p.game_number}`}</span>
                <span class="audit-book-num">#${p.pack_number}</span>
                ${_dirPill(dir)}
                <span class="audit-badge audit-badge-soldout">Sold Out</span>
              </div>
              <div class="audit-book-meta">Last #${baseline} → Final #${finalTicket} · <strong>${sold}</strong> tickets sold</div>
              <div class="audit-book-bar-wrap"><div class="audit-book-bar" style="width:${pct}%;background:${dotColor}"></div></div>
            </div>
            <div class="audit-book-actions">
              <button class="pack-act-btn" style="font-size:11px;padding:5px 10px"
                onmousedown="_invUnmarkSoldOut('${p.id}')"
                ontouchstart="_invUnmarkSoldOut('${p.id}')">Undo</button>
            </div>
            <div class="audit-book-status audit-status-ok" id="inv-status-${p.id}">✓</div>
          </div>`;
        continue;
      }

      // ── Normal card ──
      const hasViolation = hasVal && _invDirectionViolation(p.id, scanned);
      let discHtml = '';
      if (isOpenDay && hasVal && scanned !== baseline) {
        const diff   = dir === 'desc' ? (baseline - scanned) : (scanned - baseline);
        const isLoss = diff > 0;
        discHtml = `<div class="inv-disc ${isLoss ? 'inv-disc-warn' : 'inv-disc-ok'}" style="margin-top:4px">
          ${isLoss ? `⚠ ${diff} ticket${diff !== 1 ? 's' : ''} unaccounted (expected #${baseline})` : `Matches last close ✓`}
        </div>`;
      }
      // Progress along the book
      const pct = (!hasVal || baseline == null || tpp === 0) ? (dir === 'desc'
        ? Math.round(((tpp - 1 - (p.start_ticket ?? 0)) / (tpp - 1 || 1)) * 100)
        : Math.round(((p.start_ticket ?? 0) / tpp) * 100)) : 0;

      const statusClass = !hasVal ? 'audit-status-pending'
        : hasViolation ? 'audit-status-flag'
        : 'audit-status-ok';
      const statusIcon = !hasVal ? '○' : hasViolation ? '!' : '✓';
      const badgeHtml = !hasVal
        ? `<span class="audit-badge audit-badge-pending">Pending</span>`
        : hasViolation
        ? `<span class="audit-badge audit-badge-flag">Flag</span>`
        : `<span class="audit-badge audit-badge-ok">Match</span>`;

      const soldOutBtn = `<button class="pack-act-btn act-soldout" style="font-size:11px;padding:5px 10px"
            onmousedown="_invMarkSoldOut('${p.id}')"
            ontouchstart="_invMarkSoldOut('${p.id}')">Sold Out</button>`;
      const removeBtn = isOpenDay ? `<button class="pack-remove-btn"
            onmousedown="removePackAtTicket('${p.id}',${p.start_ticket ?? 0},event)"
            ontouchstart="removePackAtTicket('${p.id}',${p.start_ticket ?? 0},event)" title="Remove">✕</button>` : '';

      html += `
        <div class="audit-book-card${hasVal ? (hasViolation ? ' audit-book-flagged' : ' audit-book-matched') : ''}" id="inv-row-${p.id}">
          <div class="audit-book-dot" style="background:${dotColor}">${String(p.game_number).slice(-2)}</div>
          <div class="audit-book-body">
            <div class="audit-book-hdr">
              <span class="audit-book-name">${game.game_name || `Game #${p.game_number}`}</span>
              <span class="audit-book-num">#${p.pack_number}</span>
              ${_dirPill(dir)}
              ${badgeHtml}
            </div>
            <div class="audit-book-meta">${isClose ? 'Last close' : 'Last at'} <strong>#${baseline ?? '—'}</strong>${hasVal ? ` · entered <strong>#${scanned}</strong>` : ` · <span class="inv-constraint">${dir === 'desc' ? `enter ≤ ${baseline}` : `enter ≥ ${baseline}`}</span>`}</div>
            ${discHtml}
            <div class="audit-book-calc inv-book-calc" id="inv-calc-${p.id}"></div>
            <div class="audit-book-bar-wrap"><div class="audit-book-bar" style="width:${pct}%;background:${dotColor}"></div></div>
          </div>
          <div class="audit-book-right">
            <input type="number" class="audit-ticket-input shift-ticket-input" id="inv-inp-${p.id}"
              value="${hasVal ? scanned : ''}" placeholder="#"
              min="0" oninput="_handleInvManual('${p.id}')" />
            <div class="audit-book-actions">${soldOutBtn}${removeBtn}</div>
          </div>
          <div class="audit-book-status ${statusClass}" id="inv-status-${p.id}">${statusIcon}</div>
        </div>`;
    }
    html += '</div>';
  }

  // ── Received books (open-day only) ──
  if (isOpenDay && _invReceivedPacks.length) {
    html += `<div class="audit-loc-group"><div class="audit-loc-label">Load Received Books</div>`;
    for (const p of _invReceivedPacks) {
      const game = p.lottery_games || {};
      const dotColor = _gameColor(p.game_number);
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
        <div class="audit-book-card" id="inv-rec-${p.id}">
          <div class="audit-book-dot" style="background:${dotColor}">${String(p.game_number).slice(-2)}</div>
          <div class="audit-book-body">
            <div class="audit-book-hdr">
              <span class="audit-book-name">${game.game_name || `Game #${p.game_number}`}</span>
              <span class="audit-book-num">#${p.pack_number}</span>
            </div>
            <div class="audit-book-meta">Received · not yet active</div>
          </div>
          <div class="audit-book-actions">
            ${_getStations().map(st => `<button class="pack-act-btn act-station" style="font-size:11px;padding:5px 10px"
              onmousedown="loadReceivedPack('${p.id}','${st}',event)"
              ontouchstart="loadReceivedPack('${p.id}','${st}',event)">${st}</button>`).join('')}
          </div>
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

  const isClose   = _invContext && _invContext.startsWith('close');
  const isOpenDay = _invContext === 'open-day';
  const row = document.getElementById(`inv-row-${pack.id}`);
  const st  = document.getElementById(`inv-status-${pack.id}`);
  if (row) row.classList.add('inv-scanned');

  // Last-scan feedback in left panel
  const hasViolation = _invDirectionViolation(pack.id, parsed.ticketPosition);
  const lastScanEl = document.getElementById('inv-last-scan');
  if (lastScanEl) {
    const game = pack.lottery_games || {};
    const dir  = (pack.loading_direction || 'asc').toLowerCase();
    lastScanEl.style.display = '';
    lastScanEl.innerHTML = `
      <div class="audit-last-scan ${hasViolation ? 'als-flag' : 'als-ok'}">
        <div class="als-station">${pack.location || '—'}</div>
        <div class="als-book">${game.game_name || `Game #${pack.game_number}`} · #${pack.pack_number}</div>
        <div class="als-ticket">${_dirPill(dir)} <strong>#${parsed.ticketPosition}</strong>
          ${hasViolation ? '<span class="als-warn">⚠ Direction mismatch</span>' : '<span class="als-good">✓ OK</span>'}
        </div>
      </div>`;
  }
  if (st) st.textContent = hasViolation ? '!' : '✓';

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

  // Scroll scanned row into view, then advance to next pending book
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const next = document.querySelector('#inv-book-list .audit-book-card:not(.inv-scanned):not(.audit-book-soldout)');
  if (next) setTimeout(() => next.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 400);
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
    const base = _soldTickets(_invData[p.id], baseline, dir);
    const sold = (p.id in _invSoldOut) ? base + 1 : base;
    totalSold += sold;
    totalRev  += sold * price;
  }
  const tEl = document.getElementById('inv-total-tickets');
  const rEl = document.getElementById('inv-total-revenue');
  if (tEl) tEl.textContent = totalSold;
  if (rEl) rEl.textContent = `$${totalRev.toFixed(2)}`;
}

function _updateInvProgress() {
  const visiblePacks = _invSelectedStation
    ? _invPacks.filter(p => p.location === _invSelectedStation)
    : _invPacks;
  const total = visiblePacks.length;
  const done  = visiblePacks.filter(p => p.id in _invData).length;
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

  // Violation check (close contexts) — only for visible station
  let hasViolation = false;
  if (isClose) {
    for (const p of visiblePacks) {
      if (!(p.id in _invData) || (p.id in _invSoldOut)) continue;
      if (_invDirectionViolation(p.id, _invData[p.id])) { hasViolation = true; break; }
    }
  }

  // Stats: scanned / ok / flagged for visible station
  let okCount = 0, flagCount = 0;
  for (const p of visiblePacks) {
    if (!(p.id in _invData)) continue;
    if (p.id in _invSoldOut || !_invDirectionViolation(p.id, _invData[p.id])) okCount++;
    else flagCount++;
  }
  const scannedEl = document.getElementById('inv-stat-scanned');
  const okEl      = document.getElementById('inv-stat-ok');
  const flagEl    = document.getElementById('inv-stat-flagged');
  if (scannedEl) scannedEl.textContent = done;
  if (okEl)      okEl.textContent      = okCount;
  if (flagEl)    flagEl.textContent    = flagCount;

  // Discrepancy panel (open-day only)
  const discEl = document.getElementById('inv-disc-summary');
  if (discEl) {
    if (isOpenDay) {
      const mismatches = visiblePacks.filter(p => {
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
  const openNotes = (document.getElementById('inv-notes-input')?.value || '').trim() || null;
  // Create day
  const dayRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'open', ...(openNotes ? { notes: openNotes } : {}) }) });
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
  if (_shiftOpInProgress) {
    console.warn('_invCommitClose: operation already in progress, ignoring duplicate call');
    return;
  }
  _shiftOpInProgress = true;
  const entries = [];
  let totalSold = 0, totalRev = 0;
  for (const p of _invPacks) {
    const currentTick = _invData[p.id] != null ? _invData[p.id] : p.start_ticket;
    const lastTicket  = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const price       = parseFloat(p.lottery_games?.price || 0);
    const dir         = (p.loading_direction || 'asc').toLowerCase();
    // Sold-out via button: finalTicket is the last real ticket (#tpp-1 or #0),
    // so add 1 to include that final ticket in the sold count.
    const baseSold    = _soldTickets(currentTick, lastTicket, dir);
    const sold        = (p.id in _invSoldOut) ? baseSold + 1 : baseSold;
    const revenue     = sold * price;
    totalSold += sold; totalRev += revenue;
    entries.push({ pack_id: p.id, tickets_sold: sold, revenue, ticket_at_open: lastTicket, ticket_at_close: currentTick });
  }

  // Add any tickets sold on packs that were removed mid-shift (logged at removal time)
  if (_dbCaps.hasFullDayTracking && _currentShift) {
    const activeIds  = new Set(_invPacks.map(p => p.id));
    const existRes   = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries?shift_id=eq.${_currentShift.id}&select=pack_id,tickets_sold,revenue`);
    const existEntries = await existRes.json();
    for (const en of (Array.isArray(existEntries) ? existEntries : [])) {
      if (!activeIds.has(en.pack_id)) {
        totalSold += parseInt(en.tickets_sold || 0, 10);
        totalRev  += parseFloat(en.revenue || 0);
      }
    }
  }

  const invNotes = (document.getElementById('inv-notes-input')?.value || '').trim() || null;
  let shiftId;
  if (_dbCaps.hasFullDayTracking && _currentShift) {
    shiftId = _currentShift.id;
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?id=eq.${shiftId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'closed', closed_at: new Date().toISOString(),
          total_tickets_sold: totalSold, total_revenue: totalRev,
          ...(invNotes ? { notes: invNotes } : {}) }) });
  } else {
    // Legacy path: no current open shift record exists, create one at close time.
    // Include opened_at so history never shows "?" — use day's opened_at as the best
    // available estimate (the shift started when the day or the last shift-change started).
    const extraFields = (_dbCaps.hasFullDayTracking && _currentDay) ? { day_id: _currentDay.id } : {};
    const fallbackOpenedAt = _currentDay?.opened_at || new Date().toISOString();
    const shiftRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ shift_type: type, status: 'closed',
          opened_at: fallbackOpenedAt, closed_at: new Date().toISOString(),
          total_tickets_sold: totalSold, total_revenue: totalRev,
          ...(invNotes ? { notes: invNotes } : {}), ...extraFields }) });
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
    // Exclude the just-closed shift (already captured in totalSold/totalRev above)
    // and only sum other closed shifts — avoids double-count or missed-row if the
    // PATCH hasn't propagated before this SELECT fires.
    const dShiftsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${_currentDay.id}&id=neq.${shiftId}&status=eq.closed&select=total_tickets_sold,total_revenue`
    );
    const dShifts   = await dShiftsRes.json();
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
  updateDayShiftButtons();
  await Promise.all([loadLotteryStock(), loadShiftHistory()]);
  loadLotteryDbStats();
  _shiftOpInProgress = false;
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

      // Day is open but no open shift — auto-open one so the next shift-close
      // doesn't fall into the legacy path (which records no opened_at → "?" in history).
      // Skip if a shift operation is already in progress to avoid racing with a close.
      if (!_currentShift && !_shiftOpInProgress) {
        try {
          const newRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
              body: JSON.stringify({ day_id: _currentDay.id, shift_type: 'shift',
                opened_at: new Date().toISOString(), status: 'open',
                total_tickets_sold: 0, total_revenue: 0 }) });
          const newShifts = await newRes.json();
          _currentShift = Array.isArray(newShifts) && newShifts[0] ? newShifts[0] : null;
        } catch (_) { /* non-fatal — will fall back to legacy path */ }
      }
    } else {
      _currentShift = null;
    }
  } catch (_) { _currentDay = null; _currentShift = null; }
  updateDayShiftButtons();
}

function updateDayShiftButtons() {
  const els = document.querySelectorAll('.day-shift-btns');
  if (!els.length) return;

  const shiftIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M3 12h18"/><path d="m15 6 6 6-6 6"/><path d="m9 18-6-6 6-6"/></svg>`;
  const closeIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M3 3v18h18"/><path d="m7 15 3-4 3 3 5-7"/></svg>`;
  const sunIcon   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>`;

  let html;
  if (!_dbCaps.hasFullDayTracking) {
    html = `
      <button class="pack-act-btn act-soldout" style="font-size:12px;padding:6px 14px" onclick="openShiftClose('shift')">${shiftIcon}Change Shift</button>
      <button class="pack-act-btn" style="font-size:12px;padding:6px 14px;background:var(--accent-10);color:var(--accent-dk);border-color:var(--amber-border)" onclick="openShiftClose('day')">${closeIcon}Close Day</button>`;
  } else if (!_currentDay) {
    html = `<button class="pack-act-btn act-station" style="font-size:12px;padding:7px 16px;font-family:'Space Grotesk',sans-serif;font-weight:700" onclick="openInventory('open-day')">${sunIcon}Open Day</button>`;
  } else {
    html = `
      <span class="day-status-badge day-status-shift">${sunIcon}Day Open</span>
      <button class="pack-act-btn act-soldout" style="font-size:12px;padding:6px 14px" onclick="openInventory('close-shift')">${shiftIcon}Change Shift</button>
      <button class="pack-act-btn" style="font-size:12px;padding:6px 14px;background:var(--accent-10);color:var(--accent-dk);border-color:var(--amber-border)" onclick="openInventory('close-day')">${closeIcon}Close Day</button>`;
  }

  els.forEach(el => { el.innerHTML = html; });
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

    const locOrder = _getLocOrderAll();
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
    if (!game) { renderLotteryResult({ type: 'no-game', parsed }); beepNotFound(); if (navigator.vibrate) navigator.vibrate([80, 40, 80]); return; }
    if (game.active === false) { renderLotteryResult({ type: 'inactive-game', parsed, game }); beepNotFound(); if (navigator.vibrate) navigator.vibrate([80, 40, 80]); return; }
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
  document.querySelectorAll('#recv-loc-btns .recv-loc-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.loc === loc);
  });
}

function renderReceiveLocationButtons() {
  const el = document.getElementById('recv-loc-btns');
  if (!el) return;
  const locs = ['Office', 'Extra', ..._getExtraLocs(), ..._getStations()];
  el.innerHTML = locs.map(loc =>
    `<button class="recv-loc-pill-btn${loc === _receiveLocation ? ' active' : ''}"
      data-loc="${loc}" onclick="setReceiveLocation('${loc}')">${loc}</button>`
  ).join('');
}

async function doReceivePack(parsed, game) {
  renderLotteryResult({ type: 'loading' });
  try {
    const newPackRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({
          game_number: parsed.gameNumber, pack_number: parsed.packNumber,
          raw_barcode: parsed.raw, start_ticket: 0,
          end_ticket: game.tickets_per_pack - 1, last_shift_ticket: 0,
          status: 'received', location: _receiveLocation,
        }) });
    const newPacks = await newPackRes.json();
    const newPackId = Array.isArray(newPacks) && newPacks[0] ? newPacks[0].id : null;
    _logPackEvent(newPackId, 'received', { location_to: _receiveLocation, ticket_after: 0 });
    _lotterySession.unshift({
      gameNumber: parsed.gameNumber, packNumber: parsed.packNumber,
      gameName: game.game_name, price: game.price, ticketsPerPack: game.tickets_per_pack,
      startTicket: 0, formatted: parsed.formatted, receivedAt: new Date(),
    });
    renderLotteryResult({ type: 'success', parsed, game });
    renderLotteryLog(); renderLotteryStats(); loadLotteryDbStats();
    loadReceiveQueue();
    beepSuccess();
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (e) { renderLotteryResult({ type: 'error', msg: e.message }); }
}

async function reactivateAndReceivePack(e) {
  if (e) e.preventDefault();
  const parsed = _currentLotteryParse;
  if (!parsed) return;
  renderLotteryResult({ type: 'loading' });
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(parsed.gameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ active: true }) }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    const game = await fetchLotteryGame(parsed.gameNumber);
    await doReceivePack(parsed, game);
  } catch (err) { renderLotteryResult({ type: 'error', msg: err.message }); }
  refocusLottery();
}

function _lgAutoTpp(price) {
  const tppEl = document.getElementById('lg-tpp');
  if (!tppEl || tppEl.value) return;
  if (price > 0 && price < 20) tppEl.value = Math.round(300 / price);
}

function _lgSetPrice(val) {
  const priceEl = document.getElementById('lg-price');
  if (priceEl) { priceEl.value = val; }
  document.querySelectorAll('.lg-price-pill').forEach(b =>
    b.classList.toggle('lg-price-pill-active', Number(b.dataset.val) === val)
  );
  _lgAutoTpp(val);
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
          <label class="lottery-form-label">Ticket price ($)</label>
          <div class="lg-price-pills">
            ${[1,2,3,5,10,20,25,30,50].map(v =>
              `<button type="button" class="lg-price-pill" data-val="${v}" onclick="_lgSetPrice(${v})">$${v}</button>`
            ).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <div style="flex:1">
              <input class="modal-input lottery-form-input" id="lg-price" type="number" min="0" step="0.01" placeholder="or enter price" />
            </div>
            <div style="flex:1"><label class="lottery-form-label">Tickets / pack</label>
              <input class="modal-input lottery-form-input" id="lg-tpp" type="number" min="1" placeholder="300" /></div>
          </div>
          <button class="modal-add-btn" style="margin-bottom:0"
            onmousedown="submitAddGame(event)" ontouchstart="submitAddGame(event)">Add Game &amp; Receive Pack</button>
        </div>
      </div>`;
    const lgNameEl = document.getElementById('lg-name');
    if (lgNameEl) lgNameEl.addEventListener('input', () => _capWords(lgNameEl));
    const lgPriceEl = document.getElementById('lg-price');
    if (lgPriceEl) lgPriceEl.addEventListener('input', () => _lgAutoTpp(parseFloat(lgPriceEl.value)));
    return;
  }
  if (state.type === 'inactive-game') {
    const { parsed: p, game: g } = state;
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Game #${p.gameNumber} is deactivated</div>
        <div class="lottery-card-sub">${g.game_name} · $${parseFloat(g.price).toFixed(2)} · ${g.tickets_per_pack} tickets/pack</div>
        <div class="lottery-card-meta" style="margin-bottom:2px">
          <div><span class="sub-lbl">Pack</span> #${p.packNumber}</div>
          <div style="font-family:monospace">${p.formatted}</div>
        </div>
        <button class="modal-add-btn" style="margin-bottom:0"
          onmousedown="reactivateAndReceivePack(event)" ontouchstart="reactivateAndReceivePack(event)">Bring Back &amp; Receive Pack</button>
      </div>`;
    return;
  }
  if (state.type === 'pack-exists') {
    const { parsed: p, game: g, pack: pk } = state;
    const tpp = parseInt(g.tickets_per_pack, 10);
    // Populate cache so openActivationForm works from here
    if (pk.id) {
      _packInfoCache[pk.id] = {
        ticketsPerPack:   tpp,
        gameName:         g.game_name || '',
        packNumber:       pk.pack_number,
        startTicket:      pk.start_ticket ?? 0,
        endTicket:        pk.end_ticket   ?? (tpp - 1),
        lastShiftTicket:  pk.last_shift_ticket ?? 0,
        loadingDirection: (pk.loading_direction || 'asc').toLowerCase(),
        location:         pk.location,
      };
    }
    const canLoad = _canMoveOrActivate();
    const statusLine = pk.status === 'received'
      ? (canLoad
          ? `<div class="lottery-card-sub" style="margin-bottom:8px">Ready to load — pick a station:</div>
             <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
               ${_getStations().map(st => `<button class="pack-act-btn act-station"
                 onmousedown="openActivationForm('${pk.id}','${st}',event)"
                 ontouchstart="openActivationForm('${pk.id}','${st}',event)">${st}</button>`).join('')}
             </div>`
          : `<div class="lottery-card-sub">${_currentDay ? 'Open a shift to load' : 'Open a day to load'}</div>`)
      : pk.status === 'activated'
        ? `<div class="lottery-card-sub">Currently active at <strong>${pk.location || '—'}</strong></div>`
        : `<div class="lottery-card-sub">Status: ${pk.status}</div>`;
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Pack already in system</div>
        <div class="lottery-card-sub">${g.game_name} · Book #${p.packNumber}</div>
        <div class="lottery-card-meta" style="margin-bottom:8px">
          <div><span class="sub-lbl">Game</span> #${p.gameNumber}</div>
          <div><span class="sub-lbl">Tickets</span> ${tpp > 0 ? tpp.toLocaleString() : '—'}</div>
        </div>
        ${statusLine}
      </div>`;
    return;
  }
  if (state.type === 'success') {
    const { parsed: p, game: g } = state;
    const tpp = parseInt(g.tickets_per_pack, 10);
    const bcHtml = p.raw ? `<div style="margin-top:10px">${_renderBarcodeBreakdown(p.raw, p.gameNumber)}</div>` : '';
    el.innerHTML = `
      <div class="lottery-card lottery-success" style="margin-top:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div class="success-icon"><svg viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="2 7 6 11 12 3"/></svg></div>
          <div class="lottery-card-title" style="color:var(--green-text)">Book received!</div>
        </div>
        <div class="lottery-card-sub">${g.game_name}</div>
        <div class="lottery-card-meta">
          <div><span class="sub-lbl">Book</span> #${p.packNumber}</div>
          <div><span class="sub-lbl">Tickets</span> ${tpp > 0 ? tpp.toLocaleString() : '—'}</div>
        </div>
        ${bcHtml}
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
        <div class="log-item-meta">Book #${e.packNumber} · ${e.ticketsPerPack} tickets</div>
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
  const locOrder = [..._getLocOrderAll(), 'Unassigned'];
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
  'Extra':         'loc-extra',
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
    if (removedAtTicket != null && _currentShift) {
      const info = _packInfoCache[_pendingRemoveId] || {};
      const shiftBaseline = info.lastShiftTicket ?? info.startTicket;
      const dir   = info.loadingDirection || 'asc';
      const price = info.price || 0;
      if (shiftBaseline != null) {
        const sold = _soldTickets(removedAtTicket, shiftBaseline, dir);
        if (sold > 0) {
          await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
              body: JSON.stringify([{ pack_id: _pendingRemoveId, shift_id: _currentShift.id,
                tickets_sold: sold, revenue: sold * price,
                ticket_at_open: shiftBaseline, ticket_at_close: removedAtTicket }]) });
        }
      }
    }
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
    const res  = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?status=in.(activated,received)&select=${sel}&order=game_number.asc,pack_number.asc&limit=200`);
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
  if (!result) { _rltFlashError('Could not read barcode'); return; }

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
  if (!pack) { _rltFlashError('Book not found in active or received list'); return; }
  if (_rltList.some(b => b.id === pack.id)) { _rltFlashError('Book already added'); return; }

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
                ticket_at_open: b.lastShiftTicket, ticket_at_close: returnedAtTicket }]) });
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
  const sold      = (finalTicket != null && baseline != null) ? _soldTickets(finalTicket, baseline, dir) + 1 : null;

  const infoEl = document.getElementById('soldout-book-info');
  if (infoEl) infoEl.textContent = info.gameName ? `${info.gameName} · Book #${info.packNumber}` : `Book ID: ${id}`;

  const detailEl = document.getElementById('soldout-detail');
  if (detailEl) {
    if (finalTicket != null) {
      const soldLine = sold != null ? `${sold} ticket${sold !== 1 ? 's' : ''} sold` : '';
      detailEl.innerHTML = `
        <div class="soldout-calc-row">
          ${_dirPill(dir)}
          ${baseline != null ? `Last at ${_ticketAt(baseline, 'soldout')} →` : ''}
          Final ${_ticketAt(finalTicket, 'activated')}
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
        body: JSON.stringify({ status: 'soldout', start_ticket: finalTicket }) });
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
    await _commitMovePack(_pendingMoveId, newLocation, prevLocation);
    closeMovePackModal();
    await loadLotteryStock();
  } catch (err) { showError('Move failed', err.message); }
}

// ===== MOVE RECEIVED PACKS =====

async function _commitMovePack(packId, newLocation, prevLocation) {
  const toStation = _isStation(newLocation);
  const patchBody = toStation ? { location: newLocation, status: 'activated' } : { location: newLocation };
  await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(patchBody) });
  _logPackEvent(packId, toStation ? 'activated' : 'moved', { location_from: prevLocation || null, location_to: newLocation });
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
  if (!parsed) { _setMoveStatus('Could not read barcode', 'error'); return; }
  let candidate = parsed.ambiguous ? (await _resolveAmbiguousBarcode(parsed)) : parsed;
  if (!candidate) { _setMoveStatus('Could not resolve barcode', 'error'); return; }
  statusEl.textContent = 'Looking up…';
  try {
    const res  = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id,pack_number,status,location,lottery_games(game_name)` +
      `&game_number=eq.${encodeURIComponent(candidate.gameNumber)}&pack_number=eq.${encodeURIComponent(candidate.packNumber)}&limit=1`
    );
    const rows = await res.json();
    const pack = Array.isArray(rows) && rows[0];
    if (!pack) { _setMoveStatus(`Pack #${candidate.packNumber} not found — receive it first`, 'error'); return; }
    if (pack.status !== 'received') { _setMoveStatus(`Pack #${pack.pack_number} is ${pack.status}, not received`, 'error'); return; }
    if (_moveBooksQueue.find(q => q.id === pack.id)) { _setMoveStatus(`Pack #${pack.pack_number} already in list`, 'warn'); return; }
    _moveBooksQueue.push({ id: pack.id, packNumber: pack.pack_number,
      gameNumber: candidate.gameNumber,
      gameName: pack.lottery_games?.game_name || `Game #${candidate.gameNumber}`, location: pack.location || 'Office' });
    _setMoveStatus(`Added: ${pack.lottery_games?.game_name || `Game #${candidate.gameNumber}`} #${pack.pack_number}`, 'ok');
    _renderMoveBooksQueue();
  } catch (err) { _setMoveStatus('Lookup failed: ' + err.message, 'error'); }
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
    el.innerHTML = '<div class="move-books-empty">Scan a received book to add it…</div>'; return;
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
}

async function confirmMoveBooks(newLocation, e) {
  if (e) e.preventDefault();
  if (!_moveBooksQueue.length) { _setMoveStatus('Scan at least one book first', 'error'); return; }
  try {
    await Promise.all(_moveBooksQueue.map(q => _commitMovePack(q.id, newLocation, q.location)));
    closeMoveBooksModal();
    await Promise.all([loadLotteryStock(), loadLocationView()]);
  } catch (err) { showError('Move failed', err.message); }
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
  try {
    const newStatus = _isStation(location) ? 'activated' : 'received';
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: newStatus, location, start_ticket: 0, last_shift_ticket: 0 }) });
    _logPackEvent(packId, 'restored', { location_to: location, notes: `Brought back from removed — ${newStatus} at ${location}` });
    await loadLotteryStock(); loadLotteryDbStats();
  } catch (err) { showError('Restore failed', err.message); }
}

let _pendingRestorePackId   = null;
let _pendingRestoreLocation = null;

function restoreSoldOutPack(packId, location, currentTicket, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (_isStation(location) && !_canMoveOrActivate()) { showError('No day open', 'Open a day first.'); return; }

  _pendingRestorePackId   = packId;
  _pendingRestoreLocation = location;

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
        body: JSON.stringify({ status: newStatus, location, start_ticket: ticket, last_shift_ticket: ticket }) });
    _logPackEvent(packId, 'restored', { location_to: location, ticket_after: ticket, notes: `Restored from accidental soldout → ${newStatus} at ${location}` });
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
    const atStation = _isStation(p.location);
    const moveBtn = atStation ? '' : `
    <button class="pack-act-btn"
      onmousedown="openMovePackModal('${p.id}',event)"
      ontouchstart="openMovePackModal('${p.id}',event)">Move</button>`;
    return `${moveBtn}
    <button class="pack-act-btn act-soldout"
      onmousedown="openSoldOutModal('${p.id}',${p.start_ticket},event)"
      ontouchstart="openSoldOutModal('${p.id}',${p.start_ticket},event)">Sold Out</button>`;
  }
  if (p.status === 'removed') {
    const stationBtns = _getStations().map(st =>
      `<button class="pack-act-btn act-station"
        onmousedown="restoreRemovedPack('${p.id}','${st}',event)"
        ontouchstart="restoreRemovedPack('${p.id}','${st}',event)">${st}</button>`
    ).join('');
    return `<div class="pack-move-row"><span class="pack-move-label">Bring back to</span>${stationBtns}</div>`;
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
  _packInfoCache[p.id] = { ticketsPerPack, gameName: gameName || '', packNumber: p.pack_number, startTicket: p.start_ticket, endTicket: p.end_ticket ?? null, lastShiftTicket: p.last_shift_ticket ?? null, loadingDirection: (p.loading_direction || 'asc').toLowerCase(), location: p.location, price: parseFloat(price || 0) };
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
  _packInfoCache[p.id] = { ticketsPerPack: tpp, gameName: gName, packNumber: p.pack_number, startTicket: p.start_ticket, endTicket: p.end_ticket ?? null, lastShiftTicket: p.last_shift_ticket ?? null, loadingDirection: (p.loading_direction || 'asc').toLowerCase(), location: p.location, price };
  const st      = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const isActive = p.status === 'activated';
  const dir     = p.loading_direction;
  const pct     = (isActive && tpp > 0)
    ? ((dir || 'asc') === 'desc'
        ? Math.round(((tpp - 1 - p.start_ticket) / (tpp - 1 || 1)) * 100)
        : Math.round((p.start_ticket / tpp) * 100))
    : 0;
  return `
    <div class="lottery-stock-book">
      <div class="lottery-book-info">
        <span class="lottery-book-label">#${p.pack_number}</span>
        <span class="item-badge lottery-price-badge" style="font-size:10px">$${price.toFixed(2)}</span>
        <span class="pack-status-pill ${st.css}">${st.label}</span>
        ${dir ? _dirPill(dir) : ''}
        ${p.status !== 'received' ? _ticketAt(p.start_ticket, p.status) : ''}
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

function _renderBarcodeBreakdown(raw, knownGameNumber) {
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
  } else if (clean.length > 14) {
    // Long barcode — determine game digit count from the known game number,
    // falling back to 3-digit (legacy) if unknown.
    const gd  = knownGameNumber && String(knownGameNumber).replace(/\D/g,'').length === 4 ? 4 : 3;
    const pe  = gd + 6;   // pack end
    const te  = pe + 3;   // ticket end
    segments = [
      { val: clean.slice(0, gd), label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(gd, pe),label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(pe, te),label: 'Ticket #', cls: 'bc-ticket' },
      { val: clean.slice(te),    label: 'Scanner suffix', cls: 'bc-check' },
    ];
  } else {
    return `<div class="bc-raw">${raw}</div><div class="bc-none">Unrecognized format (${clean.length} digits)</div>`;
  }

  const fullDisplay = segments.map(s => `<span class="bc-seg ${s.cls}">${s.val}</span>`).join('<span class="bc-sep">-</span>');
  const legend = segments.map(s =>
    `<div class="bc-legend-item"><span class="bc-legend-dot ${s.cls}"></span><span class="bc-legend-label">${s.label}</span><span class="bc-legend-val">${s.val}</span></div>`
  ).join('');
  return `
    <div class="bc-full-row">
      <div class="bc-full">${fullDisplay}</div>
      <button class="bc-copy-btn" onclick="copyToClipboard('${clean}',this)" title="Copy barcode">Copy</button>
    </div>
    <div class="bc-legend">${legend}</div>`;
}

// Shows barcode structure for a game with only the game # filled in; pack/ticket marked as variable.
// Used in catalog where a sample barcode would imply a specific pack number.
function _renderGameNumberTemplate(gameNumber) {
  const gn  = String(gameNumber).replace(/\D/g, '');
  const segments = [
    { val: gn,      label: 'Game #',   cls: 'bc-game',   dim: false },
    { val: '######', label: 'Pack #',  cls: 'bc-pack',   dim: true  },
    { val: '###',    label: 'Ticket #', cls: 'bc-ticket', dim: true  },
  ];
  const fullDisplay = segments.map(s =>
    `<span class="bc-seg ${s.cls}"${s.dim ? ' style="opacity:0.28"' : ''}>${s.val}</span>`
  ).join('<span class="bc-sep">-</span>');
  const legend = segments.map(s =>
    `<div class="bc-legend-item"${s.dim ? ' style="opacity:0.4"' : ''}>` +
    `<span class="bc-legend-dot ${s.cls}"></span>` +
    `<span class="bc-legend-label">${s.label}</span>` +
    `<span class="bc-legend-val">${s.dim ? 'varies' : s.val}</span></div>`
  ).join('');
  return `<div class="bc-full-row"><div class="bc-full">${fullDisplay}</div></div><div class="bc-legend">${legend}</div>`;
}

const _catalogGameCache = {};
let _catalogSortBy = 'game';   // 'game' | 'price-asc' | 'price-desc'
let _catalogSearch = '';
let _catalogCache  = null;
let _stockSortBy   = 'price-asc'; // 'game' | 'price-asc' | 'price-desc'

function toggleInactiveGames() {
  _showInactiveGames = !_showInactiveGames;
  const btn = document.getElementById('catalog-inactive-btn');
  if (btn) btn.classList.toggle('active', _showInactiveGames);
  loadLotteryCatalog();
}

function setCatalogSort(sort) {
  _catalogSortBy = sort;
  document.querySelectorAll('.cat-sort-pill').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === sort)
  );
  _renderLotteryCatalog();
}

function setCatalogSearch(q) {
  _catalogSearch = q;
  _renderLotteryCatalog();
}

function setStockSort(sort) {
  _stockSortBy = sort;
  document.querySelectorAll('.stock-sort-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === sort)
  );
  if (_cachedStockRows) renderLotteryStock(_cachedStockRows);
}

async function loadLotteryCatalog() {
  const el = document.getElementById('lottery-catalog-container');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  await checkDbCapabilities();
  const activeFilter = _showInactiveGames ? '' : '&or=(active.eq.true,active.is.null)';
  try {
    const [gRes, pRes, eRes] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games?select=game_number,game_name,price,tickets_per_pack,active&order=game_number.asc${activeFilter}&limit=1000`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=game_number,pack_number,status,raw_barcode&order=game_number.asc,id.asc&limit=1000`),
      _dbCaps.hasPackEvents
        ? sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?select=action,created_at,ticket_before,ticket_after,location_to,shift_id,lottery_shifts(opened_at),lottery_packs(game_number,pack_number)&order=created_at.asc&limit=5000`)
        : Promise.resolve(null),
    ]);
    const games  = await gRes.json();
    const packs  = await pRes.json();
    const evtRaw = eRes ? await eRes.json() : null;
    if (!gRes.ok) throw new Error(games?.message || `[${gRes.status}]`);

    if (!Array.isArray(games) || !games.length) {
      el.innerHTML = '<div class="log-empty">No games in catalog yet.</div>';
      return;
    }

    const packCounts    = {};
    const packLists     = {};
    const sampleBarcode = {};
    const packBarcodes  = {};
    for (const p of (Array.isArray(packs) ? packs : [])) {
      const gn = p.game_number;
      if (!packCounts[gn]) {
        packCounts[gn] = { activated: 0, received: 0, soldout: 0, removed: 0, total: 0 };
        packLists[gn]  = { activated: [], received: [], soldout: [], removed: [] };
      }
      packCounts[gn].total++;
      if (packCounts[gn][p.status] !== undefined) {
        packCounts[gn][p.status]++;
        packLists[gn][p.status].push(p.pack_number);
      }
      if (!sampleBarcode[gn] && p.raw_barcode) sampleBarcode[gn] = p.raw_barcode;
      if (p.raw_barcode) {
        if (!packBarcodes[gn]) packBarcodes[gn] = {};
        packBarcodes[gn][p.pack_number] = p.raw_barcode;
      }
    }

    const packHistory = {};
    const _EVT_LABELS = {
      received: 'Received', activated: 'Loaded', soldout: 'Sold Out',
      removed: 'Removed', moved: 'Moved', adjusted: 'Adjusted', discrepancy: 'Discrepancy',
      restored: 'Restored', returned_to_lottery: 'Returned to Lottery',
    };
    for (const ev of (Array.isArray(evtRaw) ? evtRaw : [])) {
      const gn = ev.lottery_packs?.game_number;
      const pn = ev.lottery_packs?.pack_number;
      if (!gn || pn == null) continue;
      if (!packHistory[gn]) packHistory[gn] = {};
      if (!packHistory[gn][pn]) packHistory[gn][pn] = [];
      const isPartialLoad = ev.action === 'activated' && ev.ticket_after > 0;
      const shiftTime = ev.lottery_shifts?.opened_at
        ? new Date(ev.lottery_shifts.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;
      packHistory[gn][pn].push({
        action:      ev.action,
        label:       isPartialLoad ? 'Partial Load' : (_EVT_LABELS[ev.action] || ev.action),
        cls:         `ph-evt-${ev.action}`,
        date:        ev.created_at,
        ticketAfter: ev.ticket_after ?? null,
        shiftTime,
      });
    }

    _catalogCache = { games, packCounts, packLists, packBarcodes, packHistory, sampleBarcode };
    _renderLotteryCatalog();
  } catch (e) {
    el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

function _renderLotteryCatalog() {
  const el = document.getElementById('lottery-catalog-container');
  if (!el || !_catalogCache) return;
  const { games, packCounts, packLists, packBarcodes, packHistory } = _catalogCache;

  // Filter
  const q = _catalogSearch.trim().toLowerCase();
  let visible = games;
  if (q) {
    visible = games.filter(g => {
      if (String(g.game_number).includes(q)) return true;
      if ((g.game_name || '').toLowerCase().includes(q)) return true;
      const allPacks = [
        ...(packLists[g.game_number]?.activated || []),
        ...(packLists[g.game_number]?.received  || []),
        ...(packLists[g.game_number]?.soldout   || []),
        ...(packLists[g.game_number]?.removed   || []),
      ];
      return allPacks.some(pn => String(pn).includes(q));
    });
  }

  // Sort
  if (_catalogSortBy === 'price-asc')  visible = [...visible].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  if (_catalogSortBy === 'price-desc') visible = [...visible].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));

  if (!visible.length) {
    el.innerHTML = q
      ? `<div class="log-empty">No games match "${_catalogSearch}"</div>`
      : '<div class="log-empty">No games in catalog yet.</div>';
    return;
  }

  for (const g of visible) _catalogGameCache[g.game_number] = g;

  // Price count summary — unique game types + total active/received books per price
  const catPriceCounts = {};
  for (const g of visible) {
    const price = parseFloat(g.price || 0);
    if (!price) continue;
    const cnt = packCounts[g.game_number] || {};
    if (!catPriceCounts[price]) catPriceCounts[price] = { games: 0, books: 0 };
    catPriceCounts[price].games++;
    catPriceCounts[price].books += (cnt.activated || 0) + (cnt.received || 0);
  }
  let html = _priceSummaryHtml(catPriceCounts) + '<div class="catalog-grid">';
  for (const g of visible) {
    const price    = parseFloat(g.price || 0);
    const tpp      = parseInt(g.tickets_per_pack || 0, 10);
    const bookCost = price * tpp;
    const cnts     = packCounts[g.game_number] || {};
    const active   = cnts.activated || 0;
    const received = cnts.received  || 0;
    const soldout  = cnts.soldout   || 0;
    const total    = cnts.total     || 0;
    const gn       = g.game_number;
    const color    = _gameColor(gn);
    const emoji    = _gameEmoji(gn);

    const stockHTML = (() => {
      const pills = [
        active   ? `<span class="cat-cnt-pill cp-active"><span class="cat-cnt-dot"></span>${active} active</span>`     : '',
        received ? `<span class="cat-cnt-pill cp-received"><span class="cat-cnt-dot"></span>${received} received</span>` : '',
        soldout  ? `<span class="cat-cnt-pill cp-soldout"><span class="cat-cnt-dot"></span>${soldout} sold out</span>`   : '',
      ].filter(Boolean).join('');
      return `<div class="cat-stock">${pills || '<span class="cat-stock-empty">No books recorded</span>'}</div>`;
    })();

    const canEdit = total === 0;
    const editBtns = canEdit
      ? `<button class="catalog-edit-btn" onclick="openEditGame('${gn}')">Edit</button>
         ${g.active
           ? `<button class="catalog-del-btn" onclick="softDeleteGame('${gn}')">Deactivate</button>`
           : `<button class="catalog-edit-btn" onclick="reactivateGame('${gn}')">Reactivate</button>`}`
      : `<button class="catalog-edit-btn" onclick="openEditGame('${gn}')">Edit</button>
         <span class="cat-in-use">${total} book${total !== 1 ? 's' : ''} recorded</span>
         ${!g.active ? `<button class="catalog-edit-btn" onclick="reactivateGame('${gn}')">Reactivate</button>` : ''}`;

    const historyHTML = (() => {
      const gameEvts     = packHistory[g.game_number];
      const gameBarcodes = packBarcodes[gn] || {};
      if (!gameEvts || !Object.keys(gameEvts).length) return { panel: '', hasHistory: false };
      const packCount = Object.keys(gameEvts).length;
      const rows = Object.entries(gameEvts).map(([pn, evts]) => {
        const steps = evts.map((e, i) => {
          const d = new Date(e.date);
          const dateFmt = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const timeFmt = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const ticketStr = e.ticketAfter != null ? `<span class="ph-ticket-tag">#${e.ticketAfter}</span>` : '';
          const shiftStr  = e.shiftTime ? `<span class="ph-shift-tag">Shift ${e.shiftTime}</span>` : '';
          return `${i > 0 ? '<span class="ph-arrow">→</span>' : ''}<span class="ph-step"><span class="ph-evt ${e.cls}">${e.label}${ticketStr}</span>${shiftStr}<span class="ph-date">${dateFmt} ${timeFmt}</span></span>`;
        }).join('');
        const bc = gameBarcodes[pn];
        const bcRow = bc
          ? `<div class="ph-barcode-row"><span class="ph-barcode-val">${bc}</span><button class="ph-copy-btn" onclick="_copyBarcode(this,'${bc}')">Copy</button></div>`
          : `<div class="ph-barcode-row"><span class="ph-barcode-none">No barcode on file</span></div>`;
        return `<div class="ph-pack-row"><span class="ph-pack-num">#${pn}</span><div class="ph-timeline">${steps}</div>${bcRow}</div>`;
      }).join('');
      const panel = `
        <div class="cat-hist-panel">
          <div class="cat-hist-panel-hdr">
            <span class="cat-hist-panel-title">Pack history (${packCount})</span>
            <button class="cat-bc-toggle" onclick="_toggleCatBarcode(event,'${gn}')">Show Barcodes</button>
          </div>
          <div class="ph-list">${rows}</div>
        </div>`;
      return { panel, hasHistory: true };
    })();

    html += `
      <div class="cat-card" id="catalog-row-${gn}">
        <div class="cat-card-bar" style="background:${color}"></div>
        <div class="cat-card-hdr">
          <div class="cat-game-dot" style="background:${color}1a">${emoji}</div>
          <div class="cat-game-identity">
            <div class="cat-game-name">${g.game_name || '—'}</div>
            <div class="cat-game-num">#${gn}</div>
          </div>
          ${g.active ? '<span class="pack-status-pill st-activated">Active</span>' : '<span class="pack-status-pill st-removed">Inactive</span>'}
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
            <div class="cat-stat-val">${bookCost > 0 ? '$' + bookCost.toFixed(0) : '—'}</div>
            <div class="cat-stat-lbl">Book cost</div>
          </div>
        </div>
        ${stockHTML}
        <div class="cat-bc">
          <div class="cat-bc-lbl">Barcode format</div>
          ${_renderGameNumberTemplate(gn)}
        </div>
        <div class="cat-footer">
          ${editBtns}
          ${historyHTML.hasHistory ? `<button class="cat-hist-toggle" onclick="_toggleCatHistory('${gn}')">History <i class="cat-hist-chev">▶</i></button>` : ''}
        </div>
        ${historyHTML.panel || ''}
      </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ===== CATALOG EDIT / SOFT DELETE =====

let _editGameNumber = null;


function openEditGame(gameNumber) {
  const g = _catalogGameCache[gameNumber];
  if (!g) return;
  _editGameNumber = g.game_number;
  document.getElementById('edit-game-info').textContent = `Game #${g.game_number}`;
  const editNameEl = document.getElementById('edit-game-name');
  editNameEl.value = g.game_name || '';
  _capWords(editNameEl);
  editNameEl.oninput = () => _capWords(editNameEl);
  document.getElementById('edit-game-price').value = g.price      != null ? g.price : '';
  document.getElementById('edit-game-tpp').value   = g.tickets_per_pack > 0 ? g.tickets_per_pack : '';
  document.getElementById('edit-game-modal').classList.add('open');
  setTimeout(() => editNameEl.focus(), 120);
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
        body: JSON.stringify({ game_name: name, price, tickets_per_pack: tpp }) });
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
  loadLotteryStock();
}

async function loadLotteryStock() {
  const el = document.getElementById('lottery-stock-container');
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  const select = _dbCaps.hasLoadingDirection
    ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,status,location,lottery_games(game_name,price,tickets_per_pack)`
    : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,status,location,lottery_games(game_name,price,tickets_per_pack)`;
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
  const locOrder = _getLocOrderAll();
  const byLoc = {};
  for (const row of rows) {
    const loc = row.location || 'Office';
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(row);
  }
  const _pills = (act, recv, sold) => [
    act  ? `<span class="cat-cnt-pill cp-active"><span class="cat-cnt-dot"></span>${act} active</span>`     : '',
    recv ? `<span class="cat-cnt-pill cp-received"><span class="cat-cnt-dot"></span>${recv} received</span>` : '',
    sold ? `<span class="cat-cnt-pill cp-soldout"><span class="cat-cnt-dot"></span>${sold} sold out</span>`  : '',
  ].filter(Boolean).join('');

  const allLocs = [...locOrder, ...Object.keys(byLoc).filter(l => !locOrder.includes(l))];

  el.innerHTML = '<div class="catalog-grid">' + allLocs.map(loc => {
    const packs = byLoc[loc];
    if (!packs || !packs.length) return '';
    const activated = packs.filter(p => p.status === 'activated').length;
    const received  = packs.filter(p => p.status === 'received').length;
    const soldOut   = packs.filter(p => p.status === 'soldout').length;
    const isStn     = _isStation(loc);
    const barColor  = activated ? 'var(--design-green)' : received ? '#d4a000' : 'var(--ink-30)';
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
        <div class="cat-stock">${_pills(activated, received, soldOut) || '<span class="cat-stock-empty">Empty</span>'}</div>
        <div class="stk-packs">
          ${packs.filter(p => p.status !== 'soldout').map(p => renderPackRowByLoc(p)).join('')}
          ${soldOut ? `<div class="lottery-soldout-note">${soldOut} sold out</div>` : ''}
        </div>
      </div>`;
  }).join('') + '</div>';
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
  const locOrder = _getLocOrderAll();
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
  if (_shiftOpInProgress) return;
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
      entries.push({ pack_id: p.id, tickets_sold: sold, revenue, ticket_at_open: lastTicket, ticket_at_close: currentTick });
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
  } catch (err) { showError('Close failed', err.message); }
  finally { if (confirmBtn) confirmBtn.disabled = false; _shiftOpInProgress = false; }
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
        ? `,lottery_pack_events(id,pack_id,action,location_from,location_to,ticket_before,ticket_after,notes,created_at,lottery_packs(pack_number,game_number,raw_barcode,lottery_games(game_name,price)))`
        : '';

      // ── Query 1: days (no embedded shifts — PostgREST embedding silently caps
      //            nested collections which caused only the last shift to appear)
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_days` +
        `?select=id,opened_at,closed_at,status,total_tickets_sold,total_revenue,notes` +
        `&order=opened_at.desc&limit=60${dateFilter}`
      );
      const days = await res.json();
      const daysArr = Array.isArray(days) ? days : [];

      // ── Query 2a: Full detail for the first 2 days (most recent + previous).
      //             Covers the open day + last closed day for the summary cards.
      // ── Query 2b: Shift summaries only (no entries/events) for older days.
      //             Full detail is lazy-loaded when the user expands a group.
      if (daysArr.length) {
        const fullSel =
          `id,day_id,opened_at,closed_at,status,shift_type,total_tickets_sold,total_revenue,notes,` +
          `lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,` +
            `lottery_packs(pack_number,game_number,lottery_games(game_name,price)))` +
          eventsSelect;
        const sumSel =
          `id,day_id,opened_at,closed_at,status,shift_type,total_tickets_sold,total_revenue,notes`;

        // ── Full detail: first 2 days
        try {
          const recentN   = Math.min(2, daysArr.length);
          const recentIds = daysArr.slice(0, recentN).map(d => d.id).join(',');
          const r1 = await sbFetch(
            `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
            `?day_id=in.(${recentIds})&select=${fullSel}&order=opened_at.asc&limit=200`
          );
          const recent = await r1.json();
          if (Array.isArray(recent)) {
            const byDay = {};
            for (const s of recent) { if (!byDay[s.day_id]) byDay[s.day_id] = []; byDay[s.day_id].push(s); }
            for (const d of daysArr.slice(0, recentN)) { d.lottery_shifts = byDay[d.id] || []; d._shiftsDetailed = true; }
          }
        } catch (_) {}

        // ── Summaries only: remaining days (full detail fetched on demand when expanded)
        if (daysArr.length > 2) {
          try {
            const olderIds = daysArr.slice(2).map(d => d.id).join(',');
            const r2 = await sbFetch(
              `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
              `?day_id=in.(${olderIds})&select=${sumSel}&order=opened_at.asc&limit=500`
            );
            const older = await r2.json();
            if (Array.isArray(older)) {
              const byDay = {};
              for (const s of older) { if (!byDay[s.day_id]) byDay[s.day_id] = []; byDay[s.day_id].push(s); }
              for (const d of daysArr.slice(2)) { d.lottery_shifts = byDay[d.id] || []; d._shiftsDetailed = false; }
            }
          } catch (_) {}
        }
      }
      _dayHistoryData = daysArr; // cache for lazy detail loading

      // ── Query 3: live active packs when a day is currently open
      let activePacks = [];
      if (daysArr.some(d => d.status === 'open')) {
        try {
          const packSel = _dbCaps.hasLoadingDirection
            ? 'game_number,pack_number,location,start_ticket,last_shift_ticket,loading_direction,lottery_games(game_name,price,tickets_per_pack)'
            : 'game_number,pack_number,location,start_ticket,last_shift_ticket,lottery_games(game_name,price,tickets_per_pack)';
          const apRes = await sbFetch(
            `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?status=eq.activated&select=${packSel}&order=location.asc,pack_number.asc&limit=100`
          );
          const ap = await apRes.json();
          if (Array.isArray(ap)) activePacks = ap;
        } catch (_) {}
      }

      renderDayHistory(daysArr, activePacks);
    } else {
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
        `?select=id,shift_type,closed_at,total_tickets_sold,total_revenue,notes,lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,lottery_packs(pack_number,game_number,lottery_games(game_name,price)))` +
        `&order=closed_at.desc&limit=60${dateFilter.replace(/opened_at/g, 'closed_at')}`
      );
      const shifts = await res.json();
      renderShiftHistory(Array.isArray(shifts) ? shifts : []);
    }
  } catch (e) {
    if (el) el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

function _evBarcodeInline(raw, gameNumber) {
  if (!raw) return '';
  const clean = raw.replace(/[^0-9]/g, '');
  let segs;
  if (clean.length === 14) {
    segs = [clean.slice(0, 4), clean.slice(4, 10), clean.slice(10, 13)];
  } else if (clean.length === 13) {
    segs = [clean.slice(0, 4), clean.slice(4, 10), clean.slice(10)];
  } else if (clean.length === 12) {
    segs = [clean.slice(0, 3), clean.slice(3, 9), clean.slice(9)];
  } else if (clean.length > 14) {
    const gd = gameNumber && String(gameNumber).replace(/\D/g,'').length === 4 ? 4 : 3;
    const pe = gd + 6, te = pe + 3;
    segs = [clean.slice(0, gd), clean.slice(gd, pe), clean.slice(pe, te)];
  } else {
    return `<span class="sev-bc-raw">${clean}</span>`;
  }
  return `<span class="sev-bc-game">${segs[0]}</span><span class="sev-bc-sep">·</span><span class="sev-bc-pack">${segs[1]}</span><span class="sev-bc-sep">·</span><span class="sev-bc-ticket">${segs[2]}</span>`;
}

function _packEventDetail(ev) {
  switch (ev.action) {
    case 'received':  return `received → ${ev.location_to || ''}${ev.ticket_after != null ? ` at #${ev.ticket_after}` : ''}`;
    case 'activated': return `loaded to ${ev.location_to || '?'}${ev.ticket_after != null ? ` from #${ev.ticket_after}` : ''}${ev.notes ? ` (${ev.notes})` : ''}`;
    case 'moved':     return `${ev.location_from || '?'} → ${ev.location_to || '?'}`;
    case 'removed':             return `removed at #${ev.ticket_after ?? '?'}`;
    case 'returned_to_lottery': return `returned to lottery${ev.ticket_after != null ? ` at #${ev.ticket_after}` : ''}`;
    case 'restored':            return ev.notes || 'brought back from removed';
    case 'soldout':   return `sold out at #${ev.ticket_after ?? '?'}`;
    case 'adjusted':  return `position ${ev.ticket_before ?? '?'} → ${ev.ticket_after ?? '?'}${ev.notes ? ` · ${ev.notes}` : ''}`;
    default:          return ev.notes || '';
  }
}

// ── Per-pack ticket summary (shared by day-level and shift-level views) ─────
// entries = lottery_shift_entries[]  (may be from multiple shifts when building day summary)
// events  = lottery_pack_events[]    (same)
// Returns inner HTML rows for a .shift-pack-tick-list, or '' if nothing to show.
const _PACK_STATUS_ACTIONS = new Set(['removed', 'returned_to_lottery', 'soldout', 'restored']);

function _buildPackTicketRows(entries, events) {
  const byPack = new Map(); // pack_id → { pack, openTick, closeTick, sold, rev, statusEvents[] }

  for (const en of (entries || [])) {
    const id   = en.pack_id;
    if (!id) continue;
    const pack = en.lottery_packs || {};
    if (!byPack.has(id)) byPack.set(id, { pack, openTick: null, closeTick: null, sold: 0, rev: 0, statusEvents: [] });
    const row = byPack.get(id);
    if (!row.pack.game_number && pack.game_number) row.pack = pack;
    // openTick: keep first seen (earliest shift = day start for that pack)
    if (en.ticket_at_open  != null && row.openTick  === null) row.openTick  = en.ticket_at_open;
    // closeTick: always overwrite so last shift wins (= day end for that pack)
    if (en.ticket_at_close != null) row.closeTick = en.ticket_at_close;
    row.sold += en.tickets_sold    || 0;
    row.rev  += parseFloat(en.revenue || 0);
  }

  for (const ev of (events || [])) {
    if (!_PACK_STATUS_ACTIONS.has(ev.action)) continue;
    const id = ev.pack_id;
    if (!id) continue;
    const pack = ev.lottery_packs || {};
    if (!byPack.has(id)) byPack.set(id, { pack, openTick: null, closeTick: null, sold: 0, rev: 0, statusEvents: [] });
    const row = byPack.get(id);
    if (!row.pack.game_number && pack.game_number) row.pack = pack;
    row.statusEvents.push(ev);
  }

  if (!byPack.size) return '';

  const sorted = [...byPack.values()].sort((a, b) => {
    const ga = parseInt(a.pack.game_number || 0), gb = parseInt(b.pack.game_number || 0);
    return ga !== gb ? ga - gb : parseInt(a.pack.pack_number || 0) - parseInt(b.pack.pack_number || 0);
  });

  return sorted.map(({ pack, openTick, closeTick, sold, rev, statusEvents }) => {
    const game    = pack.lottery_games || {};
    const name    = game.game_name || (pack.game_number ? `Game #${pack.game_number}` : '?');
    const packNum = pack.pack_number || '?';
    const price   = parseFloat(game.price || 0);
    const dotBg   = _priceColor(price).bg;
    const abbr    = String(pack.game_number || '').slice(-2).padStart(2, '0');

    const tickRange = (openTick != null && closeTick != null)
      ? `<span class="spt-range">#${openTick}<span class="spt-arrow">→</span>#${closeTick}</span>`
      : openTick != null ? `<span class="spt-range">from #${openTick}</span>`
      : closeTick != null ? `<span class="spt-range">to #${closeTick}</span>` : '';

    const _BADGE_LABEL = { removed: 'Removed', returned_to_lottery: 'Returned', soldout: 'Sold Out', restored: 'Restored' };
    const badges = statusEvents.map(ev => {
      const tick  = ev.ticket_after ?? ev.ticket_before;
      const label = _BADGE_LABEL[ev.action] || ev.action;
      return `<span class="spt-badge spt-${ev.action.replace(/_/g,'-')}">${label}${tick != null ? ` #${tick}` : ''}</span>`;
    }).join('');

    return `<div class="shift-pack-tick-row">
      <div class="spt-dot" style="background:${dotBg}">${abbr}</div>
      <div class="spt-info">
        <div class="spt-top">
          <span class="spt-name">${name}</span>
          <span class="spt-packnum">#${packNum}</span>
          ${badges}
        </div>
        <div class="spt-bottom">
          ${tickRange}
          ${sold > 0 ? `<span class="spt-sold">${sold} sold</span>` : ''}
          ${rev  > 0 ? `<span class="spt-rev">$${rev.toFixed(2)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Audit entry card renderer (shared across all shift/history views) ──────
function _renderShiftEntryCard(en) {
  const pack      = en.lottery_packs || {}, game = pack.lottery_games || {};
  const name      = game.game_name || `Game #${pack.game_number}`;
  const price     = parseFloat(game.price || 0);
  const dotBg     = price > 0 ? (_priceColor(price).bg || 'linear-gradient(135deg,#a8a29e,#78716c)') : 'linear-gradient(135deg,#a8a29e,#78716c)';
  const abbr      = String(pack.game_number || '').slice(-2).padStart(2, '0');
  const rev       = parseFloat(en.revenue || 0);
  const sold      = en.tickets_sold || 0;
  const isSuspect = sold === 0 && en.ticket_at_open != null;
  const tickRange = (en.ticket_at_open != null && en.ticket_at_close != null)
    ? `<span class="aec-range">#${en.ticket_at_open}<span class="aec-arrow">→</span>#${en.ticket_at_close}</span>` : '';
  return `<div class="audit-entry-card${isSuspect ? ' aec-flag' : ''}">
    <div class="aec-dot" style="background:${dotBg}">${abbr}</div>
    <div class="aec-body">
      <div class="aec-top">
        <span class="aec-name">${name}</span>
        <span class="aec-book">#${pack.pack_number || '?'}</span>
      </div>
      <div class="aec-bottom">
        ${tickRange}
        <span class="aec-sold">${sold} sold</span>
        <span class="aec-rev">$${rev.toFixed(2)}</span>
      </div>
    </div>
  </div>`;
}

// Full day-tracking view: days → shifts → entries
const _PRICE_COLORS = {
  1:  { bg: 'linear-gradient(135deg,#22c55e,#16a34a)', shadow: '#16a34a40' },
  2:  { bg: 'linear-gradient(135deg,#06b6d4,#0891b2)', shadow: '#0891b240' },
  3:  { bg: 'linear-gradient(135deg,#818cf8,#6366f1)', shadow: '#6366f140' },
  5:  { bg: 'linear-gradient(135deg,#a78bfa,#7c3aed)', shadow: '#7c3aed40' },
  10: { bg: 'linear-gradient(135deg,#fb923c,#ea580c)', shadow: '#ea580c40' },
  20: { bg: 'linear-gradient(135deg,#f43f5e,#e11d48)', shadow: '#e11d4840' },
  25: { bg: 'linear-gradient(135deg,#f43f5e,#be123c)', shadow: '#be123c40' },
  30: { bg: 'linear-gradient(135deg,#ec4899,#be185d)', shadow: '#be185d40' },
  50: { bg: 'linear-gradient(135deg,#1A1612,#44403c)',  shadow: '#1A161240' },
};
function _priceColor(price) {
  return _PRICE_COLORS[price] || { bg: 'linear-gradient(135deg,#94a3b8,#64748b)', shadow: '#64748b40' };
}

function _priceSummaryHtml(priceCounts) {
  const sorted = Object.entries(priceCounts)
    .map(([p, c]) => ({ price: parseFloat(p), data: c }))
    .sort((a, b) => a.price - b.price);
  if (!sorted.length) return '';
  const pills = sorted.map(({ price, data }) => {
    const { bg, shadow } = _priceColor(price);
    const label = price % 1 === 0 ? `$${price}` : `$${price.toFixed(2)}`;
    const badge = typeof data === 'object'
      ? `<span class="price-sum-badge">${data.games} type${data.games !== 1 ? 's' : ''}</span><span class="price-sum-badge">${data.books} book${data.books !== 1 ? 's' : ''}</span>`
      : `<span class="price-sum-badge">${data} book${data !== 1 ? 's' : ''}</span>`;
    return `<span class="price-sum-pill" style="background:${bg};box-shadow:0 3px 10px ${shadow}"><span class="price-sum-val">${label}</span>${badge}</span>`;
  }).join('');
  return `<div class="price-summary-bar">${pills}</div>`;
}

function _toggleCatHistory(gn) {
  const card = document.getElementById('catalog-row-' + gn);
  const isOpen = card.classList.toggle('cat-hist-open');
  if (!isOpen) {
    card.classList.remove('cat-bc-open');
    const bcBtn = card.querySelector('.cat-bc-toggle');
    if (bcBtn) bcBtn.textContent = 'Show Barcodes';
  }
}

function _toggleCatBarcode(e, gn) {
  e.stopPropagation();
  const card = document.getElementById('catalog-row-' + gn);
  const isOn = card.classList.toggle('cat-bc-open');
  e.currentTarget.textContent = isOn ? 'Show Timeline' : 'Show Barcodes';
}

function _copyBarcode(btn, barcode) {
  navigator.clipboard.writeText(barcode).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => btn.textContent = orig, 1500);
  }).catch(() => {
    btn.textContent = 'Error';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  });
}

async function _toggleDayGroup(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // If expanding a summary-only group, lazy-load full detail first
  if (el.classList.contains('collapsed') && el.dataset.detailed === '0') {
    await _loadDayDetail(el.dataset.dayId, id);
    return;
  }
  el.classList.toggle('collapsed');
}

function _toggleShiftGroup(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('collapsed');
}

function _toggleLastCloseCard(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('lsc-open');
}

// Fetch full shift detail for one day, update the cached entry, re-render body in place.
async function _loadDayDetail(dayId, groupId) {
  const el = document.getElementById(groupId);
  if (!el || el.dataset.loading === '1') return;
  el.dataset.loading = '1';

  const body = el.querySelector('.shift-day-body');
  if (body) body.innerHTML = '<div class="summary-loading" style="padding:12px 0;text-align:center">Loading shifts…</div>';
  el.classList.remove('collapsed');

  try {
    const evSel = _dbCaps.hasPackEvents
      ? `,lottery_pack_events(id,pack_id,action,location_from,location_to,ticket_before,ticket_after,notes,created_at,lottery_packs(pack_number,game_number,raw_barcode,lottery_games(game_name,price)))`
      : '';
    const shiftSel =
      `id,day_id,opened_at,closed_at,status,shift_type,total_tickets_sold,total_revenue,notes,` +
      `lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,` +
        `lottery_packs(pack_number,game_number,lottery_games(game_name,price)))` +
      evSel;
    const r = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${dayId}&select=${shiftSel}&order=opened_at.asc&limit=100`
    );
    const shifts = await r.json();
    const day = _dayHistoryData.find(d => d.id === dayId);
    if (day && Array.isArray(shifts)) {
      day.lottery_shifts   = shifts;
      day._shiftsDetailed  = true;
    }
    el.dataset.detailed = '1';
    if (body && day) body.innerHTML = _renderDayBodyHtml(day);
  } catch (err) {
    if (body) body.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${err.message}</div>`;
    el.classList.add('collapsed');
  }
  delete el.dataset.loading;
}

// Lightweight body for collapsed summary-only days (no entries/events loaded yet).
function _renderDayBodyStub(day) {
  const all      = day.lottery_shifts || [];
  const isOpen   = day.status === 'open';
  const activeId = isOpen ? (all.find(s => s.status === 'open' && !s.closed_at)?.id ?? null) : null;
  const display  = all.filter(s => s.id !== activeId).sort((a, b) => new Date(a.opened_at || 0) - new Date(b.opened_at || 0));
  const rows     = display.map(s => {
    const openT  = s.opened_at ? new Date(s.opened_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : '?';
    const closeT = s.closed_at ? new Date(s.closed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : null;
    const range  = closeT ? `${openT} – ${closeT}` : `${openT} – …`;
    const tix    = s.total_tickets_sold || 0;
    const rev    = parseFloat(s.total_revenue || 0);
    return `<div class="shift-stub-row">
      <div class="shift-stub-left">
        <span class="shift-history-type shift-type-shift">Shift</span>
        <span class="shift-history-date">${range}</span>
      </div>
      <span class="shift-stub-rev">$${rev.toFixed(2)} · ${tix} tickets</span>
    </div>`;
  }).join('');
  const totalTix = day.total_tickets_sold || 0;
  const totalRev = parseFloat(day.total_revenue || 0);
  return `
    <div class="shift-stub-hint">Expand to load shift details</div>
    ${rows || '<div class="log-empty" style="padding:8px 0;border:none;font-size:12px">No shifts</div>'}
    <div class="shift-day-total">
      <span>${totalTix} tickets · ${display.length} shift${display.length !== 1 ? 's' : ''}</span>
      <span class="shift-day-total-rev">$${totalRev.toFixed(2)}</span>
    </div>`;
}

// Full detailed body — extracted from renderDayHistory so _loadDayDetail can re-render in place.
function _renderDayBodyHtml(day) {
  const allDayShifts = day.lottery_shifts || [];
  // Self-heal null opened_at
  const _byId = allDayShifts.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  _byId.forEach((s, i) => {
    if (!s.opened_at) {
      const prev = _byId[i - 1];
      const estimate = prev?.closed_at || day.opened_at || null;
      if (estimate) {
        s.opened_at = estimate;
        sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?id=eq.${s.id}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ opened_at: estimate }) }).catch(() => {});
      }
    }
  });
  const isOpen       = day.status === 'open';
  const activeOpenId = isOpen ? (allDayShifts.find(s => s.status === 'open' && !s.closed_at)?.id ?? null) : null;
  const displayShifts = allDayShifts
    .filter(s => s.id !== activeOpenId)
    .sort((a, b) => new Date(a.opened_at || 0) - new Date(b.opened_at || 0));

  const allDayEntries    = displayShifts.flatMap(s => s.lottery_shift_entries || []);
  const allDayEvents     = displayShifts.flatMap(s => s.lottery_pack_events   || []);
  const dayPackRows      = _buildPackTicketRows(allDayEntries, allDayEvents);
  const dayTicketSummary = dayPackRows
    ? `<div class="shift-section-label day-tick-label">Day Ticket Summary</div><div class="shift-pack-tick-list day-tick-summary">${dayPackRows}</div>`
    : '';

  const shiftChevron = `<svg class="shift-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  let shiftsHtml = '';
  displayShifts.forEach((s, sIdx) => {
    const shiftGroupId = `shift-group-${day.id}-${sIdx}`;
    const isOpenShift  = s.status !== 'closed';
    const openTime     = s.opened_at ? new Date(s.opened_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : '?';
    const closeTime    = (!isOpenShift && s.closed_at) ? new Date(s.closed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : null;
    const entries      = s.lottery_shift_entries || [];
    const events       = (s.lottery_pack_events  || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const shiftTix     = s.total_tickets_sold || 0;
    const isEmpty      = !isOpenShift && shiftTix === 0 && !entries.length && !events.length;
    const shiftPackRows = _buildPackTicketRows(entries, events);
    const eventsHtml = events.map(ev => {
      const pack = ev.lottery_packs || {}, game = pack.lottery_games || {};
      const gameName  = game.game_name || (pack.game_number ? `#${pack.game_number}` : '');
      const detail    = _packEventDetail(ev);
      const t         = new Date(ev.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      const bcHtml    = _evBarcodeInline(pack.raw_barcode, pack.game_number);
      const soldCount = (ev.ticket_before != null && ev.ticket_after != null && ev.ticket_before !== ev.ticket_after)
        ? Math.abs(ev.ticket_after - ev.ticket_before) : 0;
      const price     = parseFloat(game.price || 0);
      const soldPill  = soldCount > 0 ? `<span class="sev-sold">${soldCount} sold${price > 0 ? ` · $${(soldCount * price).toFixed(2)}` : ''}</span>` : '';
      return `<div class="shift-event-row ev-${ev.action}">
        <div class="sev-top">
          <span class="shift-event-badge ev-badge-${ev.action}">${ev.action}</span>
          ${gameName ? `<span class="shift-event-pack">${gameName}</span>` : ''}
          <span class="shift-event-time">${t}</span>
        </div>
        <div class="sev-bottom">
          ${bcHtml ? `<span class="sev-bc">${bcHtml}</span>` : ''}
          ${detail ? `<span class="shift-event-detail">${detail}</span>` : ''}
          ${soldPill}
        </div>
      </div>`;
    }).join('');
    const timeRange   = closeTime ? `${openTime} – ${closeTime}` : `${openTime} – …`;
    const statusBadge = isOpenShift
      ? `<span class="shift-empty-badge" style="background:var(--amber-bg);color:var(--amber-text);border-color:var(--amber-border)">In Progress</span>`
      : (isEmpty ? '<span class="shift-empty-badge">No audit</span>' : '');
    const hasDetail   = !!(shiftPackRows || eventsHtml || s.notes);
    shiftsHtml += `
      <div class="shift-group collapsed${isEmpty ? ' shift-empty' : ''}" id="${shiftGroupId}">
        <div class="shift-group-header" onclick="_toggleShiftGroup('${shiftGroupId}')">
          <div class="shift-group-header-left">
            <span class="shift-history-type shift-type-shift">Shift</span>
            <span class="shift-history-date">${timeRange}</span>
            ${statusBadge}
          </div>
          <div class="shift-group-header-right">
            <span class="shift-history-rev">$${parseFloat(s.total_revenue || 0).toFixed(2)}</span>
            <span class="shift-group-sub">${shiftTix} tickets</span>
            ${hasDetail ? shiftChevron : ''}
          </div>
        </div>
        ${hasDetail ? `
        <div class="shift-group-body">
          ${s.notes ? `<div class="shift-history-notes"><span class="shift-note-icon">📝</span>${s.notes}</div>` : ''}
          ${shiftPackRows ? `<div class="shift-section-label">Tickets</div><div class="shift-pack-tick-list">${shiftPackRows}</div>` : ''}
          ${eventsHtml    ? `<div class="shift-section-label">Pack Events</div><div class="shift-events-list">${eventsHtml}</div>` : ''}
        </div>` : ''}
      </div>`;
  });

  const totalCount   = displayShifts.length;
  const closedShifts = allDayShifts.filter(s => s.status === 'closed');
  const compTix      = closedShifts.reduce((sum, s) => sum + (s.total_tickets_sold || 0), 0);
  const compRev      = closedShifts.reduce((sum, s) => sum + parseFloat(s.total_revenue || 0), 0);
  const dayTix       = compTix || (day.total_tickets_sold || 0);
  const dayRev       = compRev || parseFloat(day.total_revenue || 0);

  return `
    ${dayTicketSummary}
    ${displayShifts.length ? `<div class="shift-section-label" style="margin-top:${dayPackRows ? '10px' : '0'}">Shifts</div>` : ''}
    ${shiftsHtml || '<div class="log-empty" style="padding:8px 0;border:none;font-size:12px">No shifts</div>'}
    <div class="shift-day-total">
      <span>${dayTix} tickets · ${totalCount} shift${totalCount !== 1 ? 's' : ''}</span>
      <span class="shift-day-total-rev">$${dayRev.toFixed(2)}</span>
    </div>`;
}

const _chevronSvg = `<svg class="shift-day-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

function renderDayHistory(days, activePacks = []) {
  const el = document.getElementById('shift-history-container');
  if (!el) return;
  if (!days.length) { el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No history yet</div>'; return; }

  // Only the most recent open day — extras are duplicate artifacts
  const openDay    = days.find(d => d.status === 'open') || null;
  const closedDays = days.filter(d => d.status === 'closed');
  const displayDays = [...(openDay ? [openDay] : []), ...closedDays];
  const lastDay    = closedDays[0] || null;

  // Find most recent closed shift
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
    const openShift    = (openDay.lottery_shifts || []).find(s => s.status === 'open');
    const closedShifts = (openDay.lottery_shifts || []).filter(s => s.status === 'closed');
    const liveRev      = closedShifts.reduce((s, sh) => s + parseFloat(sh.total_revenue || 0), 0);
    const liveTix      = closedShifts.reduce((s, sh) => s + (sh.total_tickets_sold || 0), 0);
    const dayOpenTime  = new Date(openDay.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // ── Active packs (live scan state) ──
    let activePacksHtml = '';
    if (activePacks.length) {
      const byLoc = {};
      for (const p of activePacks) {
        const loc = p.location || 'Unknown';
        if (!byLoc[loc]) byLoc[loc] = [];
        byLoc[loc].push(p);
      }
      const locRows = Object.entries(byLoc).map(([loc, packs]) => {
        const packRows = packs.map(p => {
          const game = p.lottery_games || {};
          const name = game.game_name || `#${p.game_number}`;
          const pos  = p.last_shift_ticket != null ? `#${p.last_shift_ticket}` : 'not scanned';
          const tpp  = game.tickets_per_pack || 0;
          const sold = (p.loading_direction === 'desc' && p.start_ticket != null && p.last_shift_ticket != null)
            ? p.start_ticket - p.last_shift_ticket
            : (p.loading_direction !== 'desc' && p.start_ticket != null && p.last_shift_ticket != null)
              ? p.last_shift_ticket - p.start_ticket : null;
          const soldStr = sold != null && sold >= 0
            ? `${sold} sold${game.price > 0 ? ` · $${(sold * parseFloat(game.price)).toFixed(2)}` : ''}`
            : '';
          const progress = tpp > 0 && sold != null && sold >= 0
            ? `<div class="cpb-bar"><div class="cpb-fill" style="width:${Math.min(100, (sold/tpp)*100).toFixed(1)}%"></div></div>` : '';
          return `<div class="cp-pack-row">
            <span class="cp-pack-name">${name} <span class="cp-pack-num">#${p.pack_number}</span></span>
            <span class="cp-pack-pos">${pos}</span>
            ${soldStr ? `<span class="cp-pack-sold">${soldStr}</span>` : ''}
            ${progress}
          </div>`;
        }).join('');
        return `<div class="cp-loc-group"><div class="cp-loc-label">${loc}</div>${packRows}</div>`;
      }).join('');
      activePacksHtml = `<div class="cp-section-title">Active Packs <span class="cp-count">${activePacks.length}</span></div><div class="cp-packs">${locRows}</div>`;
    } else {
      activePacksHtml = `<div class="cp-section-title">Active Packs</div><div class="cp-empty">No active packs at stations</div>`;
    }

    // ── Current shift activity (pack events) ──
    let shiftActivityHtml = '';
    if (openShift) {
      const shiftTime = new Date(openShift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const events = ((openShift.lottery_pack_events || [])
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)))
        .slice(0, 15);
      const evRows = events.map(ev => {
        const pack = ev.lottery_packs || {}, game = pack.lottery_games || {};
        const name = game.game_name || (pack.game_number ? `#${pack.game_number}` : '');
        const detail = _packEventDetail(ev);
        const t = new Date(ev.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="cp-event-row ev-${ev.action}">
          <span class="cp-ev-badge ev-badge-${ev.action}">${ev.action}</span>
          ${name ? `<span class="cp-ev-name">${name}</span>` : ''}
          <span class="cp-ev-detail">${detail}</span>
          <span class="cp-ev-time">${t}</span>
        </div>`;
      }).join('');
      shiftActivityHtml = `
        <div class="cp-section-title">Current Shift <span class="cp-shift-since">since ${shiftTime}</span></div>
        <div class="cp-events">${evRows || '<div class="cp-empty">No activity logged yet this shift</div>'}</div>`;
    }

    html += `
      <div class="shift-today-banner">
        <div class="today-banner-hdr">
          <div>
            <div class="today-banner-title">Today · Day Open since ${dayOpenTime}</div>
            <div class="today-banner-sub">${closedShifts.length} shift${closedShifts.length !== 1 ? 's' : ''} closed · ${liveTix} tickets · $${liveRev.toFixed(2)}</div>
          </div>
        </div>
        <div class="today-live-grid">
          <div class="today-live-col">${activePacksHtml}</div>
          ${openShift ? `<div class="today-live-col">${shiftActivityHtml}</div>` : ''}
        </div>
      </div>`;
  }

  // ── Last close summary cards (collapsible — summary always shown, detail on expand) ──
  const _lscChevron = `<svg class="lsc-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  html += `<div class="last-close-grid">`;
  if (lastDay) {
    const dateStr    = new Date(lastDay.opened_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const openT      = new Date(lastDay.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const closeT     = lastDay.closed_at ? new Date(lastDay.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const dayShifts  = (lastDay.lottery_shifts || []).filter(s => s.status === 'closed');
    const nShifts    = dayShifts.length;
    const shiftRows  = dayShifts.map(s => {
      const sOpenT  = s.opened_at ? new Date(s.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
      const sCloseT = s.closed_at ? new Date(s.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
      const tix = s.total_tickets_sold || 0;
      const rev = parseFloat(s.total_revenue || 0);
      return `<div class="lsc-shift-row">
        <span class="shift-history-type shift-type-shift">Shift</span>
        <span class="lsc-shift-time">${sOpenT} – ${sCloseT}</span>
        <span class="lsc-shift-stats">${tix} tickets · $${rev.toFixed(2)}</span>
      </div>`;
    }).join('');
    html += `
      <div class="last-close-card lsc-collapsible" id="lsc-day">
        <div class="lsc-summary" onclick="_toggleLastCloseCard('lsc-day')">
          <div>
            <div class="last-close-label">Last Day Close</div>
            <div class="last-close-date">${dateStr}</div>
            <div class="last-close-time">${openT} – ${closeT}</div>
          </div>
          <div class="lsc-summary-right">
            <div class="last-close-rev">$${parseFloat(lastDay.total_revenue || 0).toFixed(2)}</div>
            <div class="last-close-sub">${lastDay.total_tickets_sold || 0} tickets · ${nShifts} shift${nShifts !== 1 ? 's' : ''}</div>
            ${shiftRows ? _lscChevron : ''}
          </div>
        </div>
        ${shiftRows ? `<div class="lsc-detail">${shiftRows}</div>` : ''}
      </div>`;
  } else {
    html += `<div class="last-close-card last-close-empty"><div class="last-close-label">Last Day Close</div><div class="last-close-sub" style="margin-top:8px">None yet</div></div>`;
  }

  if (lastShift) {
    const dateStr    = new Date(lastShiftDay.opened_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const openT      = lastShift.opened_at ? new Date(lastShift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const closeT     = lastShift.closed_at ? new Date(lastShift.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const entries    = lastShift.lottery_shift_entries || [];
    const tickRows   = _buildPackTicketRows(entries, []);
    html += `
      <div class="last-close-card lsc-collapsible" id="lsc-shift">
        <div class="lsc-summary" onclick="_toggleLastCloseCard('lsc-shift')">
          <div>
            <div class="last-close-label">Last Shift Close</div>
            <div class="last-close-date">${dateStr}</div>
            <div class="last-close-time">${openT} – ${closeT}</div>
          </div>
          <div class="lsc-summary-right">
            <div class="last-close-rev">$${parseFloat(lastShift.total_revenue || 0).toFixed(2)}</div>
            <div class="last-close-sub">${lastShift.total_tickets_sold || 0} tickets sold</div>
            ${tickRows ? _lscChevron : ''}
          </div>
        </div>
        ${tickRows ? `<div class="lsc-detail"><div class="shift-pack-tick-list">${tickRows}</div></div>` : ''}
      </div>`;
  } else {
    html += `<div class="last-close-card last-close-empty"><div class="last-close-label">Last Shift Close</div><div class="last-close-sub" style="margin-top:8px">None yet</div></div>`;
  }
  html += `</div>`;

  // ── Collapsible day groups ────────────────────────────────────────────────
  // First 2 days start expanded (they have full detail preloaded).
  // Older days start collapsed with summary-only data; full detail fetched on expand.
  displayDays.forEach((day, idx) => {
    const groupId      = `day-group-${day.id}`;
    const collapsed    = idx < 2 ? '' : ' collapsed';
    const dateStr      = new Date(day.opened_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    const allDayShifts = day.lottery_shifts || [];
    const closedShifts = allDayShifts.filter(s => s.status === 'closed');
    const computedRev  = closedShifts.reduce((sum, s) => sum + parseFloat(s.total_revenue || 0), 0);
    const computedTix  = closedShifts.reduce((sum, s) => sum + (s.total_tickets_sold || 0), 0);
    const dayRev       = computedRev || parseFloat(day.total_revenue || 0);
    const dayTix       = computedTix || (day.total_tickets_sold || 0);
    const isOpen       = day.status === 'open';
    const dayOpenTime  = day.opened_at ? new Date(day.opened_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : null;
    const dayCloseTime = day.closed_at ? new Date(day.closed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : null;
    const badgeStyle   = isOpen ? 'background:var(--amber-bg);color:var(--amber-text);border-color:var(--amber-border)' : '';
    const activeOpenId = isOpen ? (allDayShifts.find(s => s.status === 'open' && !s.closed_at)?.id ?? null) : null;
    const displayCount = allDayShifts.filter(s => s.id !== activeOpenId).length;
    const shiftSummary = `${displayCount} shift${displayCount !== 1 ? 's' : ''}`;
    const bodyHtml     = day._shiftsDetailed ? _renderDayBodyHtml(day) : _renderDayBodyStub(day);

    html += `
      <div class="shift-day-group${collapsed}" id="${groupId}" data-day-id="${day.id}" data-detailed="${day._shiftsDetailed ? '1' : '0'}">
        <div class="shift-day-header" onclick="_toggleDayGroup('${groupId}')">
          <div class="shift-day-header-left">
            <div style="display:flex;align-items:center;gap:7px">
              <span class="shift-day-label">${dateStr}</span>
              <span class="shift-day-closed-badge" style="${badgeStyle}">${isOpen ? 'Open' : 'Closed'}</span>
            </div>
            <div class="shift-day-times">${dayOpenTime ? `Opened ${dayOpenTime}` : ''}${dayCloseTime ? ` · Closed ${dayCloseTime}` : ''} · ${shiftSummary} · ${dayTix} tickets</div>
            ${day.notes ? `<div class="shift-history-notes" style="margin-top:3px"><span class="shift-note-icon">📝</span>${day.notes}</div>` : ''}
          </div>
          <div class="shift-day-header-right">
            <span class="shift-day-rev">$${dayRev.toFixed(2)}</span>
            ${_chevronSvg}
          </div>
        </div>
        <div class="shift-day-body">${bodyHtml}</div>
      </div>`;
  });

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
      const entriesHtml = entries.map(_renderShiftEntryCard).join('');
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

  // ── Collapsible date groups ───────────────────────────────────────────────
  const byDate = new Map();
  for (const s of shifts) {
    const key = new Date(s.closed_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(s);
  }
  let dateIdx = 0;
  for (const [dateStr, dayShifts] of byDate) {
    const groupId   = `legacy-day-group-${dateIdx}`;
    const collapsed = dateIdx >= 2 ? ' collapsed' : '';
    const dayRev    = dayShifts.reduce((s, sh) => s + parseFloat(sh.total_revenue), 0);
    const dayTix    = dayShifts.reduce((s, sh) => s + sh.total_tickets_sold, 0);
    let shiftsHtml  = '';
    for (const s of dayShifts) {
      const typeCss     = s.shift_type === 'day' ? 'shift-type-day' : 'shift-type-shift';
      const typeLabel   = s.shift_type === 'day' ? 'Day Close' : 'Shift';
      const timeStr     = new Date(s.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const entriesHtml = (s.lottery_shift_entries || []).map(_renderShiftEntryCard).join('');
      shiftsHtml += `
        <div class="shift-history-item">
          <div class="shift-history-hdr">
            <div style="display:flex;align-items:center;gap:6px"><span class="shift-history-type ${typeCss}">${typeLabel}</span><span class="shift-history-date">${timeStr}</span></div>
            <span class="shift-history-rev">$${parseFloat(s.total_revenue).toFixed(2)}</span>
          </div>
          <div class="shift-history-sub">${s.total_tickets_sold} tickets sold</div>
          ${s.notes ? `<div class="shift-history-notes"><span class="shift-note-icon">📝</span>${s.notes}</div>` : ''}
          ${entriesHtml ? `<div class="shift-history-entries">${entriesHtml}</div>` : ''}
        </div>`;
    }
    html += `
      <div class="shift-day-group${collapsed}" id="${groupId}">
        <div class="shift-day-header" onclick="_toggleDayGroup('${groupId}')">
          <div class="shift-day-header-left">
            <span class="shift-day-label">${dateStr}</span>
            <div class="shift-day-times">${dayShifts.length} close${dayShifts.length !== 1 ? 's' : ''} · ${dayTix} tickets</div>
          </div>
          <div class="shift-day-header-right">
            <span class="shift-day-rev">$${dayRev.toFixed(2)}</span>
            ${_chevronSvg}
          </div>
        </div>
        <div class="shift-day-body">
          ${shiftsHtml}
          <div class="shift-day-total"><span>${dayTix} tickets · ${dayShifts.length} close${dayShifts.length !== 1 ? 's' : ''}</span><span class="shift-day-total-rev">$${dayRev.toFixed(2)}</span></div>
        </div>
      </div>`;
    dateIdx++;
  }
  el.innerHTML = html;
}

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
      `&status=in.(received,activated)&order=location.asc,pack_number.asc&limit=500`
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
  const locOrder = _getLocOrderAll();
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

  const allLocs = [...locOrder, ...Object.keys(byLoc).filter(l => !locOrder.includes(l))];
  let html = _priceSummaryHtml(locPriceCounts);
  for (const loc of allLocs) {
    const packs = byLoc[loc];
    if (!packs?.length) continue;
    const locCss   = PACK_LOC_CSS[loc] || 'loc-office';
    const totalVal = packs.reduce((sum, p) => {
      const price = parseFloat(p.lottery_games?.price || 0);
      const tpp   = parseInt(p.lottery_games?.tickets_per_pack || 0, 10);
      return sum + price * tpp;
    }, 0);
    html += `<div class="loc-view-section">
      <div class="loc-view-header">
        <span class="pack-loc-pill ${locCss}">${loc}</span>
        <span class="loc-view-count">${packs.length} book${packs.length !== 1 ? 's' : ''}</span>
        <span class="loc-view-total">$${totalVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>
      <div class="loc-view-books">
        ${packs.map(p => {
          const st    = PACK_STATUS[p.status] || { label: p.status, css: '' };
          const name  = p.lottery_games?.game_name || `Game #${p.game_number}`;
          const price = parseFloat(p.lottery_games?.price || 0);
          const tpp   = parseInt(p.lottery_games?.tickets_per_pack || 0, 10);
          const val   = price && tpp ? `$${(price * tpp).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
          return `<div class="loc-view-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;gap:8px">
              <div class="loc-view-info">
                <span class="loc-view-name">${name}</span>
                <span class="loc-view-sub">#${p.pack_number}${price ? ` · $${price.toFixed(2)}/ticket` : ''}</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                ${val ? `<span class="loc-view-val">${val}</span>` : ''}
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
      `&status=eq.received&order=location.asc,pack_number.asc&limit=200`
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

// ===== DASHBOARD =====

const _GAME_COLORS  = ['#E13B3B','#1E5DD8','#0E8F5A','#8B5CF6','#F97316','#0F8C8C','#B8002E','#D44A8B'];
const _GAME_EMOJIS  = ['🍀','💎','💵','👑','🎰','🧩','♛','🎯'];
const _ACT_COLORS   = { received:'#8A6A00', activated:'#0E8F5A', moved:'#8B5CF6', soldout:'#E13B3B', discrepancy:'#B91C1C', adjusted:'#6B7280', removed:'#B91C1C', restored:'#0E8F5A', returned_to_lottery:'#D97706' };
const _ACT_LABELS   = { received:'Received', activated:'Activated', moved:'Moved', soldout:'Sold out', discrepancy:'Discrepancy', adjusted:'Adjusted', removed:'Removed', restored:'Restored', returned_to_lottery:'Returned to Lottery' };

// ── Shared ticket-info helpers (used everywhere a pack row is rendered) ──
function _dirPill(dir) {
  if (!dir) return '';
  const desc = (dir === 'desc');
  return `<span class="pack-dir-pill ${desc ? 'dir-desc' : 'dir-asc'}">${desc ? '↓' : '↑'} ${dir.toUpperCase()}</span>`;
}
function _ticketAt(num, status) {
  if (num == null) return '';
  const done = status !== 'activated';
  return `<span class="lottery-book-at${done ? ' lottery-book-at-done' : ''}">#${num}</span>`;
}

function _gameColor(gameNumber) {
  const n = parseInt(String(gameNumber || 0).replace(/\D/g,'').slice(-2), 10) || 0;
  return _GAME_COLORS[n % _GAME_COLORS.length];
}

function _gameEmoji(gameNumber) {
  const n = parseInt(String(gameNumber || 0).replace(/\D/g,'').slice(-2), 10) || 0;
  return _GAME_EMOJIS[n % _GAME_EMOJIS.length];
}

function _formatBarcode(gameNum, packNum) {
  const g = String(gameNum || '').padStart(4, '0');
  const b = String(packNum || '').padStart(7, '0');
  return `<span class="itab-bc-game">${g}</span><span class="itab-bc-dot">·</span><span class="itab-bc-book">${b}</span><span class="itab-bc-dot">·</span><span class="itab-bc-ticket">000</span>`;
}

function _updateContextBar(activeCount) {
  const dateEl  = document.getElementById('ctx-date-text');
  const countEl = document.getElementById('ctx-active-count');
  if (dateEl) {
    const d = new Date();
    const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let shift = '';
    if (_currentShift) shift = ' · Shift open';
    else if (_currentDay) shift = ' · Day open';
    else shift = ' · No open day';
    dateEl.textContent = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${shift}`;
  }
  if (countEl && activeCount != null) countEl.textContent = activeCount;
}

async function loadDashboard() {
  const stationsEl  = document.getElementById('dashboard-stations');
  const attentionEl = document.getElementById('dashboard-attention');
  const activityEl  = document.getElementById('dashboard-activity');
  if (!stationsEl) return;

  // Update context bar date immediately (count updated after fetch)
  _updateContextBar(null);

  // Update greeting
  const greetEl = document.getElementById('dash-greeting');
  if (greetEl) {
    const h = new Date().getHours();
    greetEl.textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  try {
    // Snapshot mutable state before the first await to avoid race conditions
    // with initLotteryTab() updating _dbCaps/_currentDay concurrently.
    const snapDay       = _currentDay;
    const snapHasShifts = _dbCaps.hasFullDayTracking;
    const snapHasEvents = _dbCaps.hasPackEvents;

    const sel = _dbCaps.hasLoadingDirection
      ? 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)'
      : 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)';

    const fetches = [
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&status=eq.activated&order=location.asc&limit=300`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id&status=eq.received&limit=1`, { headers: { 'Prefer': 'count=exact' } }),
    ];
    if (snapDay && snapHasShifts) {
      fetches.push(sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${snapDay.id}&select=total_revenue,total_tickets_sold&order=opened_at.asc`));
    }
    if (snapHasEvents) {
      fetches.push(sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?select=id,action,pack_id,created_at,ticket_before,ticket_after,notes,lottery_packs(pack_number,game_number,location,lottery_games(game_name))&order=created_at.desc&limit=20`));
    }

    const results = await Promise.all(fetches);
    const packs   = await results[0].json();
    const officeCount = parseInt((results[1].headers.get('content-range') || '').split('/')[1], 10) || 0;
    let shifts = [], events = [];
    let ri = 2;
    if (snapDay && snapHasShifts) { shifts = await results[ri++].json(); }
    if (snapHasEvents) { events = await results[ri].json(); }

    const activePacks = Array.isArray(packs) ? packs : [];
    const shiftArr    = Array.isArray(shifts) ? shifts : [];
    const eventArr    = Array.isArray(events) ? events : [];

    // Revenue
    const todayRev     = shiftArr.reduce((s, sh) => s + (parseFloat(sh.total_revenue) || 0), 0);
    const todayTickets = shiftArr.reduce((s, sh) => s + (parseInt(sh.total_tickets_sold) || 0), 0);
    const revEl  = document.getElementById('dash-stat-revenue');
    const revSub = document.getElementById('dash-stat-rev-sub');
    const actEl2 = document.getElementById('dash-stat-active');
    const offEl  = document.getElementById('dash-stat-office');
    if (revEl)  revEl.textContent  = snapDay ? `$${todayRev.toFixed(2)}` : '$—';
    if (revSub) revSub.textContent = snapDay ? `${todayTickets} tickets sold today` : 'open a day first';
    if (actEl2) actEl2.textContent = activePacks.length;
    if (offEl)  offEl.textContent  = officeCount;
    // Update live context bar with real active count
    _updateContextBar(activePacks.length);

    // Group active packs by location
    const byLoc = {};
    for (const p of activePacks) {
      if (!byLoc[p.location]) byLoc[p.location] = [];
      byLoc[p.location].push(p);
    }

    // Flagged = discrepancy events
    const discEvents = eventArr.filter(e => e.action === 'discrepancy');
    const discPackIds = new Set(discEvents.map(e => e.pack_id));
    const flagCount = discPackIds.size;
    const flagEl   = document.getElementById('dash-stat-flagged');
    const flagSub  = document.getElementById('dash-stat-flagged-sub');
    const flagIcon = document.getElementById('dash-flag-icon');
    const flagPill = document.getElementById('dash-flag-pill');
    if (flagEl)  flagEl.textContent  = flagCount;
    if (flagSub) flagSub.textContent = flagCount ? `${flagCount} book${flagCount > 1 ? 's' : ''} flagged` : 'nothing to review';
    if (flagIcon) {
      flagIcon.style.background = flagCount ? 'rgba(185,28,28,.12)' : 'rgba(26,22,18,.07)';
      const svg = document.getElementById('dash-flag-svg');
      if (svg) svg.setAttribute('stroke', flagCount ? '#B91C1C' : '#1A1612');
    }
    if (flagPill) {
      flagPill.style.display = flagCount ? '' : 'none';
      flagPill.textContent   = `${flagCount} flagged`;
    }
    const actSubEl = document.getElementById('dash-stat-active-sub');
    if (actSubEl) {
      const stationNames = [...new Set(activePacks.map(p => p.location))].filter(Boolean);
      actSubEl.textContent = stationNames.length ? `across ${stationNames.length} location${stationNames.length > 1 ? 's' : ''}` : 'no active books';
    }

    // Station cards
    _renderDashStations(byLoc, stationsEl);

    // Attention panel
    _renderDashAttention(discEvents, activePacks, attentionEl);

    // Activity feed
    _renderDashActivity(eventArr, activityEl);

    // Analytics (non-blocking — loads independently)
    loadDashAnalytics();

  } catch (err) {
    if (stationsEl) stationsEl.innerHTML = `<div class="item-nf-sub">Load error: ${err.message}</div>`;
    if (attentionEl) attentionEl.innerHTML = '';
    if (activityEl)  activityEl.innerHTML = '';
  }
}

// ===== DASHBOARD ANALYTICS =====

let _dashAnalyticsPreset = 'month';
let _dashAnalyticsInited = false;

function _initDashAnalyticsDates() {
  if (_dashAnalyticsInited) return;
  _dashAnalyticsInited = true;
  const { from, to } = _dashAnalyticsDates();
  const fEl = document.getElementById('da-date-from');
  const tEl = document.getElementById('da-date-to');
  if (fEl) fEl.value = from;
  if (tEl) tEl.value = to;
}

function _dashAnalyticsDates() {
  const now   = new Date();
  const y     = now.getFullYear(), m = now.getMonth();
  if (_dashAnalyticsPreset === 'month') {
    return {
      from: new Date(y, m, 1).toISOString().slice(0, 10),
      to:   new Date(y, m + 1, 0).toISOString().slice(0, 10),
    };
  }
  if (_dashAnalyticsPreset === 'lastmonth') {
    return {
      from: new Date(y, m - 1, 1).toISOString().slice(0, 10),
      to:   new Date(y, m, 0).toISOString().slice(0, 10),
    };
  }
  if (_dashAnalyticsPreset === '3months') {
    return {
      from: new Date(y, m - 2, 1).toISOString().slice(0, 10),
      to:   new Date(y, m + 1, 0).toISOString().slice(0, 10),
    };
  }
  // custom — read from inputs
  const f = document.getElementById('da-date-from')?.value;
  const t = document.getElementById('da-date-to')?.value;
  return { from: f || '', to: t || '' };
}

function setDashAnalyticsPreset(preset) {
  _dashAnalyticsPreset = preset;
  ['month', 'lastmonth', '3months'].forEach(p => {
    const btn = document.getElementById(`dapreset-${p}`);
    if (btn) btn.classList.toggle('active', p === preset);
  });
  const { from, to } = _dashAnalyticsDates();
  const fEl = document.getElementById('da-date-from');
  const tEl = document.getElementById('da-date-to');
  if (fEl) fEl.value = from;
  if (tEl) tEl.value = to;
  loadDashAnalytics();
}

function _onDashAnalyticsDateChange() {
  _dashAnalyticsPreset = 'custom';
  ['month', 'lastmonth', '3months'].forEach(p => {
    const btn = document.getElementById(`dapreset-${p}`);
    if (btn) btn.classList.remove('active');
  });
  loadDashAnalytics();
}

async function loadDashAnalytics() {
  const container = document.getElementById('dash-analytics-container');
  const summaryEl = document.getElementById('dash-analytics-summary');
  if (!container) return;
  container.innerHTML = '<div class="summary-loading">Loading…</div>';
  if (summaryEl) summaryEl.innerHTML = '';

  const { from, to } = _dashAnalyticsDates();
  if (!from || !to) { container.innerHTML = '<div class="log-empty" style="border:none;padding:8px 0">Select a date range.</div>'; return; }

  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_days` +
      `?select=id,opened_at,closed_at,status,total_revenue,total_tickets_sold,` +
      `lottery_shifts(id,opened_at,closed_at,status,total_revenue,total_tickets_sold,` +
      `lottery_shift_entries(pack_id,tickets_sold,revenue,lottery_packs(game_number,lottery_games(game_name,price))))` +
      `&opened_at=gte.${from}T00:00:00&opened_at=lte.${to}T23:59:59&order=opened_at.desc&limit=120`
    );
    const days = await res.json();
    if (!res.ok) throw new Error(days?.message || `[${res.status}]`);
    _renderDashAnalytics(Array.isArray(days) ? days : [], summaryEl, container);
  } catch (e) {
    container.innerHTML = `<div class="item-nf-sub" style="padding:8px 0">Load failed: ${e.message}</div>`;
  }
}

function _renderDashAnalytics(days, summaryEl, container) {
  if (!days.length) {
    container.innerHTML = '<div class="log-empty" style="border:none;padding:8px 0">No closed days in this range.</div>';
    const periodEl = document.getElementById('dash-period-rev');
    if (periodEl) periodEl.style.display = 'none';
    return;
  }

  // --- Summary row ---
  const closedDays = days.filter(d => d.status === 'closed');
  const totalRev  = closedDays.reduce((s, d) => s + parseFloat(d.total_revenue || 0), 0);
  const totalTix  = closedDays.reduce((s, d) => s + (d.total_tickets_sold || 0), 0);
  const avgRev    = closedDays.length ? totalRev / closedDays.length : 0;

  // Update period revenue in the top stats card
  const periodEl = document.getElementById('dash-period-rev');
  if (periodEl) {
    const presetLabel = { month: 'This month', lastmonth: 'Last month', '3months': '3 months', custom: 'Selected range' }[_dashAnalyticsPreset] || 'Period';
    periodEl.textContent = `${presetLabel}: $${totalRev.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${closedDays.length} day${closedDays.length !== 1 ? 's' : ''}`;
    periodEl.style.display = '';
  }

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="da-summary-row">
        <div class="da-summary-stat">
          <div class="da-summary-val">$${totalRev.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="da-summary-lbl">Total revenue</div>
        </div>
        <div class="da-summary-stat">
          <div class="da-summary-val">${totalTix.toLocaleString()}</div>
          <div class="da-summary-lbl">Tickets sold</div>
        </div>
        <div class="da-summary-stat">
          <div class="da-summary-val">$${avgRev.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="da-summary-lbl">Avg per day</div>
        </div>
        <div class="da-summary-stat">
          <div class="da-summary-val">${closedDays.length}</div>
          <div class="da-summary-lbl">Days closed</div>
        </div>
      </div>`;
  }

  // --- Group days into ISO weeks (Mon–Sun) ---
  function isoWeekKey(dateStr) {
    const d = new Date(dateStr);
    const day = d.getDay() === 0 ? 7 : d.getDay(); // Mon=1…Sun=7
    const mon = new Date(d); mon.setDate(d.getDate() - day + 1);
    return mon.toISOString().slice(0, 10);
  }

  const weeks = {};
  for (const day of days) {
    const wk = isoWeekKey(day.opened_at);
    if (!weeks[wk]) weeks[wk] = [];
    weeks[wk].push(day);
  }
  const weekKeys = Object.keys(weeks).sort((a, b) => b.localeCompare(a)); // newest first

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const WDAYS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function fmtDate(str) {
    const d = new Date(str);
    return `${WDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  function fmtMoney(n) {
    return `$${parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  let html = '';
  weekKeys.forEach((wk, wi) => {
    const wDays      = weeks[wk];
    const wClosed    = wDays.filter(d => d.status === 'closed');
    const wRev       = wClosed.reduce((s, d) => s + parseFloat(d.total_revenue || 0), 0);
    const wTix       = wClosed.reduce((s, d) => s + (d.total_tickets_sold || 0), 0);
    const wShifts    = wClosed.reduce((s, d) => s + (d.lottery_shifts || []).filter(sh => sh.status === 'closed').length, 0);
    const groupId    = `da-week-${wi}`;
    const collapsed  = wi >= 2 ? ' da-collapsed' : '';

    // Week label: "May 19 – May 25"
    const monDate = new Date(wk);
    const sunDate = new Date(wk); sunDate.setDate(monDate.getDate() + 6);
    const wLabel  = `${MONTHS[monDate.getMonth()]} ${monDate.getDate()} – ${MONTHS[sunDate.getMonth()]} ${sunDate.getDate()}`;

    // Per-day rows
    let dayRows = '';
    for (const d of wDays) {
      const closed  = d.status === 'closed';
      const dRev    = parseFloat(d.total_revenue || 0);
      const dTix    = d.total_tickets_sold || 0;
      const dShifts = (d.lottery_shifts || []).filter(sh => sh.status === 'closed');
      const openT   = d.opened_at  ? new Date(d.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
      const closeT  = d.closed_at  ? new Date(d.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

      // Per-game breakdown from shift entries
      const gameTotals = {};
      for (const sh of dShifts) {
        for (const en of (sh.lottery_shift_entries || [])) {
          const gn    = en.lottery_packs?.game_number || '?';
          const gName = en.lottery_packs?.lottery_games?.game_name || `Game #${gn}`;
          const price = parseFloat(en.lottery_packs?.lottery_games?.price || 0);
          if (!gameTotals[gn]) gameTotals[gn] = { name: gName, price, tickets: 0, revenue: 0 };
          gameTotals[gn].tickets += en.tickets_sold || 0;
          gameTotals[gn].revenue += parseFloat(en.revenue || 0);
        }
      }
      const gameRows = Object.values(gameTotals)
        .sort((a, b) => b.revenue - a.revenue)
        .map(g => `<div class="da-game-row">
          <span class="da-game-name">${g.name}</span>
          <span class="da-game-meta">${g.tickets} tickets</span>
          <span class="da-game-rev">${fmtMoney(g.revenue)}</span>
        </div>`).join('');

      dayRows += `
        <div class="da-day-row${closed ? '' : ' da-day-open'}">
          <div class="da-day-main">
            <div class="da-day-info">
              <span class="da-day-date">${fmtDate(d.opened_at)}</span>
              ${closed ? '' : '<span class="da-open-pill">Open</span>'}
              <span class="da-day-time">${openT}${closeT ? ` – ${closeT}` : ''}</span>
            </div>
            <div class="da-day-stats">
              <span class="da-day-tix">${dTix} tickets · ${dShifts.length} shift${dShifts.length !== 1 ? 's' : ''}</span>
              <span class="da-day-rev">${closed ? fmtMoney(dRev) : '—'}</span>
            </div>
          </div>
          ${gameRows ? `<div class="da-game-list">${gameRows}</div>` : ''}
        </div>`;
    }

    html += `
      <div class="da-week-group${collapsed}" id="${groupId}">
        <div class="da-week-header" onclick="_toggleDaWeek('${groupId}')">
          <div class="da-week-left">
            <span class="da-week-label">Week of ${wLabel}</span>
            <span class="da-week-meta">${wClosed.length} day${wClosed.length !== 1 ? 's' : ''} · ${wShifts} shift${wShifts !== 1 ? 's' : ''} · ${wTix.toLocaleString()} tickets</span>
          </div>
          <div class="da-week-right">
            <span class="da-week-rev">${fmtMoney(wRev)}</span>
            ${_chevronSvg}
          </div>
        </div>
        <div class="da-week-body">${dayRows}</div>
      </div>`;
  });

  container.innerHTML = html;
}

function _toggleDaWeek(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('da-collapsed');
}

function _renderDashStations(byLoc, el) {
  if (!el) return;
  const locations = Object.keys(byLoc);
  if (!locations.length) {
    el.innerHTML = `<div class="dash-no-stations">
      <div style="font-size:32px;margin-bottom:8px;opacity:.3">📍</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:600;color:var(--text-muted)">No active books at any station</div>
      <div style="font-size:12px;color:var(--text-hint);margin-top:4px">Activate books from the Stock tab to get started</div>
    </div>`;
    return;
  }
  const locIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--brand-red)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s-7-7.5-7-13a7 7 0 1 1 14 0c0 5.5-7 13-7 13Z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
  const cards = locations.map(loc => {
    const packs = byLoc[loc];
    let stationRev = 0;
    const chips = packs.slice(0, 6).map(p => {
      const gName = p.lottery_games?.game_name || '';
      const color = _gameColor(p.game_number);
      const emoji = _gameEmoji(p.game_number);
      const price = parseFloat(p.lottery_games?.price || 0);
      const tpp   = parseInt(p.lottery_games?.tickets_per_pack || 0, 10);
      const dir   = p.loading_direction || 'asc';
      const start = p.start_ticket ?? 0;
      if (price && tpp) {
        const sold = dir === 'asc' ? start : Math.max(0, tpp - 1 - start);
        stationRev += sold * price;
      }
      return `<div class="station-book-chip" style="background:${color}" title="${gName} · Book #${p.pack_number}${price ? ` · $${price}` : ''}">${emoji}</div>`;
    }).join('');
    const extra = packs.length > 6 ? `<div class="station-chip-more">+${packs.length - 6}</div>` : '';
    const revStr = stationRev > 0 ? `$${stationRev.toFixed(0)} today` : '—';
    return `<div class="station-card" onclick="switchLotterySection('tracking')">
      <div class="station-card-accent"></div>
      <div class="station-card-hdr">${locIcon}<span class="station-card-name">${loc}</span></div>
      <div class="station-card-val">${packs.length}<span class="station-card-val-unit">books</span></div>
      <div class="station-card-rev">${revStr}</div>
      <div class="station-card-chips">${chips}${extra}</div>
    </div>`;
  }).join('');
  const cols = Math.min(locations.length, 4);
  el.innerHTML = `<div class="dash-stations-grid" style="grid-template-columns:repeat(${cols},1fr)">${cards}</div>`;
}

function _renderDashAttention(discEvents, _activePacks, el) {
  if (!el) return;
  if (!_dbCaps.hasPackEvents) {
    el.innerHTML = `<div class="dash-empty-state">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--design-green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 6"/></svg>
      <div style="margin-top:8px;font-size:13px;color:var(--text-muted)">Pack event tracking not enabled.</div>
    </div>`;
    return;
  }
  if (!discEvents.length) {
    el.innerHTML = `<div class="dash-empty-state">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--design-green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 6"/></svg>
      <div style="margin-top:8px;font-size:13px;color:var(--text-muted)">All books are clean. Nice work.</div>
    </div>`;
    return;
  }
  const seen = new Set();
  const rows = discEvents.filter(e => { if (seen.has(e.pack_id)) return false; seen.add(e.pack_id); return true; })
    .slice(0, 8)
    .map(e => {
      const p    = e.lottery_packs || {};
      const g    = p.lottery_games || {};
      const name = g.game_name || `Game ${p.game_number || '?'}`;
      const bc   = `${p.game_number || ''}·${p.pack_number || ''}`;
      const note = e.notes ? `<div class="att-note">⚠ ${e.notes}</div>` : `<div class="att-note">⚠ Scan discrepancy recorded</div>`;
      const color = _gameColor(p.game_number);
      const emoji = _gameEmoji(p.game_number);
      return `<div class="att-item">
        <div class="att-dot" style="background:${color};font-size:15px">${emoji}</div>
        <div class="att-info">
          <div class="att-name">${name} <span class="att-bc">${bc}</span></div>
          ${note}
          <div class="att-loc">${p.location || '—'}</div>
        </div>
      </div>`;
    }).join('');
  el.innerHTML = rows;
}

function _renderDashActivity(events, el) {
  if (!el) return;
  if (!events.length) {
    el.innerHTML = `<div class="dash-empty-state" style="color:var(--text-hint);font-size:13px">No recent activity recorded.</div>`;
    return;
  }
  const rows = events.slice(0, 12).map(e => {
    const p      = e.lottery_packs || {};
    const g      = p.lottery_games || {};
    const name   = g.game_name || `Game ${p.game_number || '?'}`;
    const action = _ACT_LABELS[e.action] || e.action;
    const color  = _ACT_COLORS[e.action]  || 'var(--ink-60)';
    const loc    = p.location || '';
    const timeStr = e.created_at ? _fmtActivityTime(e.created_at) : '';
    const detail = e.ticket_after != null ? `#${e.ticket_after}` : (e.notes ? e.notes.slice(0, 40) : `Book #${p.pack_number || '?'}`);
    const initial = (name[0] || '?').toUpperCase();
    return `<div class="act-item">
      <div class="act-icon" style="background:${color}22;color:${color}">${initial}</div>
      <div class="act-body">
        <div class="act-line"><strong>${action}</strong> · <span class="act-detail">${name} ${detail}</span></div>
        <div class="act-sub">${loc}</div>
      </div>
      <div class="act-time">${timeStr}</div>
    </div>`;
  }).join('');
  el.innerHTML = rows;
}

function _fmtActivityTime(isoStr) {
  if (!isoStr) return '';
  const d   = new Date(isoStr);
  const now = new Date();
  const diffMs  = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH   = Math.floor(diffMs / 3600000);
  const diffD   = Math.floor(diffMs / 86400000);
  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffH   < 24) return `${diffH}h ago`;
  if (diffD   < 2)  return 'yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ===== SETTINGS =====

async function loadSettingsSection() {
  const el = document.getElementById('settings-content');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  await _loadLotteryLocations();
  let counts = {}, totals = {};
  try {
    // Fetch all packs (all statuses) so we can show active badges AND guard deletes
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=location,status&limit=5000`
    );
    const packs = await res.json();
    if (Array.isArray(packs)) {
      for (const p of packs) {
        const loc = p.location || 'Office';
        if (!counts[loc]) counts[loc] = { activated: 0, received: 0 };
        totals[loc] = (totals[loc] || 0) + 1;
        if (p.status === 'activated') counts[loc].activated++;
        else if (p.status === 'received') counts[loc].received++;
      }
    }
  } catch (_) {}
  renderSettingsUI(counts, totals);
}

function renderSettingsUI(counts = {}, totals = {}) {
  const el = document.getElementById('settings-content');
  if (!el) return;
  const stations  = _getStations();
  const extraLocs = _getExtraLocs();

  const _badge = (loc) => {
    const c = counts[loc] || {};
    const parts = [];
    if (c.activated) parts.push(`<span class="sloc-badge sloc-active">${c.activated} active</span>`);
    if (c.received)  parts.push(`<span class="sloc-badge sloc-recv">${c.received} received</span>`);
    return parts.length
      ? `<div class="sloc-badges">${parts.join('')}</div>`
      : `<div class="sloc-badges"><span class="sloc-badge sloc-empty">empty</span></div>`;
  };

  const _row = (name, type) => {
    const hasRefs = (totals[name] || 0) > 0;
    const eName = name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const delBtn = hasRefs
      ? `<div class="settings-loc-del" style="opacity:0.25;cursor:default;pointer-events:none" title="Has pack history — rename only">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
         </div>`
      : `<button class="settings-loc-del" onclick="settingsRemoveLocation('${type}',this.closest('.settings-loc-row').querySelector('input').dataset.orig)" title="Remove ${eName}">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
         </button>`;
    return `
      <div class="settings-loc-row">
        <input class="settings-loc-input" value="${eName}" data-orig="${eName}" data-type="${type}"
          onchange="settingsRenameLocation(this.dataset.type,this.dataset.orig,this.value);this.dataset.orig=this.value.trim()"
          onblur="settingsRenameLocation(this.dataset.type,this.dataset.orig,this.value);this.dataset.orig=this.value.trim()" />
        ${_badge(name)}
        ${delBtn}
      </div>`;
  };

  el.innerHTML = `
    <div class="scan-card" style="margin-bottom:16px">
      <div class="card-section-hdr">
        <div>
          <div class="page-eyebrow" style="margin-bottom:2px">Audit-eligible</div>
          <div class="card-section-title">Stations</div>
        </div>
        <button class="log-act-btn" onclick="settingsAddStation()">+ Add Station</button>
      </div>
      <div class="settings-loc-hint">Books here can be audited. Use for registers and active sell points.</div>
      <div class="settings-loc-list">${stations.map(s => _row(s, 'station')).join('')}</div>
    </div>

    <div class="scan-card" style="margin-bottom:16px">
      <div class="card-section-hdr">
        <div>
          <div class="page-eyebrow" style="margin-bottom:2px">Storage only</div>
          <div class="card-section-title">Staging locations</div>
        </div>
        <button class="log-act-btn" onclick="settingsAddExtraLoc()">+ Add Location</button>
      </div>
      <div class="settings-loc-hint">Books here cannot be audited. Use for stock rooms, back office, or overflow.</div>
      <div class="settings-loc-list">
        <div class="settings-loc-row settings-loc-fixed">
          <div class="settings-loc-name">Office</div>
          ${_badge('Office')}
          <div class="settings-loc-tag">Fixed</div>
        </div>
        <div class="settings-loc-row settings-loc-fixed">
          <div class="settings-loc-name">Extra</div>
          ${_badge('Extra')}
          <div class="settings-loc-tag">Fixed</div>
        </div>
        ${extraLocs.map(s => _row(s, 'extra')).join('')}
      </div>
    </div>`;
}

async function settingsAddStation() {
  const stations = _getStations();
  const name = `Station ${stations.length + 1}`;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name, type: 'station', sort_order: stations.length })
    });
    await _loadLotteryLocations();
    await loadSettingsSection();
    renderReceiveLocationButtons();
  } catch (e) {
    showError('Failed to add station', e.message);
  }
}

async function settingsAddExtraLoc() {
  const extras = _getExtraLocs();
  const name = `Location ${extras.length + 1}`;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name, type: 'extra', sort_order: extras.length })
    });
    await _loadLotteryLocations();
    await loadSettingsSection();
    renderReceiveLocationButtons();
  } catch (e) {
    showError('Failed to add location', e.message);
  }
}

async function settingsRemoveLocation(type, name) {
  if (type === 'station' && _getStations().length <= 1) {
    showError('Cannot remove', 'At least one station is required.');
    return;
  }
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?location=eq.${encodeURIComponent(name)}&limit=1`,
      { headers: { 'Prefer': 'count=exact' } }
    );
    const count = parseInt((res.headers.get('content-range') || '').split('/')[1], 10) || 0;
    if (count > 0) {
      showError(`Cannot remove "${name}"`, `${count} pack${count !== 1 ? 's have' : ' has'} been at this location. Rename it instead.`);
      return;
    }
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_locations?name=eq.${encodeURIComponent(name)}&type=eq.${encodeURIComponent(type)}`,
      { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
    );
    await _loadLotteryLocations();
    await loadSettingsSection();
    renderReceiveLocationButtons();
  } catch (e) {
    showError('Failed to remove location', e.message);
  }
}

async function settingsRenameLocation(type, oldName, newName) {
  const name = (newName || '').trim();
  if (!name || name === oldName) return;
  try {
    await Promise.all([
      sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_locations?name=eq.${encodeURIComponent(oldName)}&type=eq.${encodeURIComponent(type)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ name }) }
      ),
      sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?location=eq.${encodeURIComponent(oldName)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ location: name }) }
      ),
    ]);
    await _loadLotteryLocations();
    renderReceiveLocationButtons();
  } catch (e) {
    showError('Failed to rename location', e.message);
  }
}

// ===== REPORTS =====

let _reportRange = 'today';

function setReportRange(range) {
  _reportRange = range;
  ['today', 'week', 'all'].forEach(r => {
    const btn = document.getElementById(`report-range-${r}`);
    if (btn) btn.classList.toggle('active', r === range);
  });
  loadLotteryReports();
}

async function loadLotteryReports() {
  const byGameEl    = document.getElementById('rpt-by-game');
  const byStationEl = document.getElementById('rpt-by-station');
  if (byGameEl)    byGameEl.innerHTML    = '<div class="summary-loading">Loading…</div>';
  if (byStationEl) byStationEl.innerHTML = '<div class="summary-loading">Loading…</div>';

  let shiftFilter = '';
  if (_reportRange === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    shiftFilter = `&opened_at=gte.${d.toISOString()}`;
  } else if (_reportRange === 'week') {
    const d = new Date(); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0);
    shiftFilter = `&opened_at=gte.${d.toISOString()}`;
  }

  try {
    const packSel = _dbCaps.hasLoadingDirection
      ? 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,status,lottery_games(game_name,price,tickets_per_pack)'
      : 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,status,lottery_games(game_name,price,tickets_per_pack)';
    const base = CONFIG.supabaseUrl + '/rest/v1/';

    const [shiftsRes, packsRes, activeRes] = await Promise.all([
      sbFetch(`${base}lottery_shifts?select=total_revenue,total_tickets_sold${shiftFilter}&limit=1000`),
      sbFetch(`${base}lottery_packs?select=${packSel}&status=in.(activated,soldout,removed)&limit=1000`),
      sbFetch(`${base}lottery_packs?select=id&status=eq.activated&limit=1`, { headers: { 'Prefer': 'count=exact' } }),
    ]);

    const shiftsJson = await shiftsRes.json();
    const packsJson  = await packsRes.json();
    const shiftArr   = Array.isArray(shiftsJson) ? shiftsJson : [];
    const packArr    = Array.isArray(packsJson)  ? packsJson  : [];
    const activeCount = parseInt((activeRes.headers.get('content-range') || '').split('/')[1], 10) || 0;

    // KPI totals from shifts
    const totalRev     = shiftArr.reduce((s, sh) => s + (parseFloat(sh.total_revenue) || 0), 0);
    const totalTickets = shiftArr.reduce((s, sh) => s + (parseInt(sh.total_tickets_sold) || 0), 0);
    const avgTicket    = totalTickets > 0 ? totalRev / totalTickets : 0;
    const closedBooks  = packArr.filter(p => p.status === 'soldout' || p.status === 'removed').length;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('rpt-gross',        `$${totalRev.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    setEl('rpt-gross-sub',    `${shiftArr.length} shift${shiftArr.length !== 1 ? 's' : ''} in period`);
    setEl('rpt-tickets',      totalTickets.toLocaleString());
    setEl('rpt-tickets-sub',  `across ${packArr.length} books`);
    setEl('rpt-avg',          `$${avgTicket.toFixed(2)}`);
    setEl('rpt-books-closed', closedBooks);
    setEl('rpt-books-active', `${activeCount} active`);

    // Compute sold per pack from ticket positions
    const _packSold = (p) => {
      const tpp = parseInt(p.lottery_games?.tickets_per_pack || 0);
      const dir = (_dbCaps.hasLoadingDirection ? (p.loading_direction || 'asc') : 'asc').toLowerCase();
      if (p.status === 'soldout') return tpp;
      const cur  = p.start_ticket ?? (dir === 'desc' ? tpp - 1 : 0);
      const base = dir === 'desc' ? tpp - 1 : 0;
      return _soldTickets(cur, base, dir);
    };

    // By game
    const gameMap = {};
    for (const p of packArr) {
      const gn    = p.game_number || 'unknown';
      const gName = p.lottery_games?.game_name || `Game ${gn}`;
      const price = parseFloat(p.lottery_games?.price || 0);
      const sold  = _packSold(p);
      if (!gameMap[gn]) gameMap[gn] = { name: gName, price, sold: 0, revenue: 0, books: 0 };
      gameMap[gn].sold    += sold;
      gameMap[gn].revenue += sold * price;
      gameMap[gn].books   += 1;
    }
    const byGame = Object.entries(gameMap)
      .map(([gn, r]) => ({ gn, ...r }))
      .filter(r => r.sold > 0)
      .sort((a, b) => b.revenue - a.revenue);

    if (byGameEl) {
      if (!byGame.length) {
        byGameEl.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No data yet</div>';
      } else {
        const maxRev = byGame[0].revenue || 1;
        byGameEl.innerHTML = byGame.map(r => {
          const pct   = Math.round((r.revenue / maxRev) * 100);
          const color = _gameColor(r.gn);
          return `
            <div class="rpt-game-row">
              <div class="rpt-game-dot" style="background:${color}">${String(r.gn).slice(-2)}</div>
              <div class="rpt-game-info">
                <div class="rpt-game-name">${r.name}</div>
                <div class="rpt-game-meta">$${r.price} · ${r.sold.toLocaleString()} tickets · ${r.books} book${r.books !== 1 ? 's' : ''}</div>
                <div class="rpt-game-bar-wrap"><div class="rpt-game-bar" style="width:${pct}%;background:${color}"></div></div>
              </div>
              <div class="rpt-game-rev">$${r.revenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}</div>
            </div>`;
        }).join('');
      }
    }

    // By station
    const locMap = {};
    for (const p of packArr) {
      const loc  = p.location || 'unknown';
      const price = parseFloat(p.lottery_games?.price || 0);
      const sold  = _packSold(p);
      if (!locMap[loc]) locMap[loc] = { books: 0, tickets: 0, revenue: 0 };
      locMap[loc].books   += 1;
      locMap[loc].tickets += sold;
      locMap[loc].revenue += sold * price;
    }
    const byStation = Object.entries(locMap).sort((a, b) => b[1].revenue - a[1].revenue);

    if (byStationEl) {
      if (!byStation.length) {
        byStationEl.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No data yet</div>';
      } else {
        byStationEl.innerHTML = byStation.map(([loc, r], i) => `
          <div class="rpt-station-row"${i > 0 ? ' style="border-top:1px solid var(--border)"' : ''}>
            <div class="rpt-station-name">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--brand-red)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
              ${loc.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase())}
            </div>
            <div class="rpt-station-rev">$${r.revenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}</div>
            <div class="rpt-station-meta">${r.books} book${r.books !== 1 ? 's' : ''} · ${r.tickets.toLocaleString()} tickets</div>
          </div>`).join('');
      }
    }

  } catch (e) {
    if (byGameEl)    byGameEl.innerHTML    = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
    if (byStationEl) byStationEl.innerHTML = '';
  }
}

// ===== INVENTORY TAB =====
let _invTabFilter = 'all';
let _invTabAllPacks = [];

async function loadInventorySection() {
  const listEl = document.getElementById('inv-tab-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="summary-loading" style="padding:20px">Loading…</div>';

  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id,game_number,pack_number,status,location,start_ticket,end_ticket,loading_direction,created_at,lottery_games(game_name,price,tickets_per_pack)&order=created_at.desc&limit=500`
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
  loadLotteryDbStats();
  loadLotteryStock();
  _initHistoryFilter();
  loadShiftHistory();
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
