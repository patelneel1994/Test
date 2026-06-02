// ===== LOTTERY MODULE =====
function _capWords(el) { el.value = el.value.replace(/\b\w/g, c => c.toUpperCase()); }

// ===== LOCATION CONFIG =====
// Stations   = places where books get activated & audited (configurable)
// Office     = fixed staging location (always present)
// Extra      = fixed secondary staging location (always present, presence-audited on open-day)
// Extra locs = optional extra staging areas (configurable)
// All stored in Supabase `lottery_locations` table; cached in memory after load.

let _locationsCache    = null; // { stations: string[], extras: string[] }
let _stationSlotCounts = {};   // { 'Station 1': 8, 'Station 2': 6, ... } — null means unconfigured

function _getStations() {
  return _locationsCache ? _locationsCache.stations : ['Station 1'];
}

function _getExtraLocs() {
  return _locationsCache ? _locationsCache.extras : [];
}

function _getStationSlotCount(name) {
  return _stationSlotCounts[name] ?? null; // null = no slot count configured for this station
}

async function _loadLotteryLocations() {
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_locations?select=name,type,slot_count&order=sort_order.asc,id.asc`
    );
    const rows = await res.json();
    if (Array.isArray(rows)) {
      _locationsCache = {
        stations: rows.filter(r => r.type === 'station').map(r => r.name),
        extras:   rows.filter(r => r.type === 'extra').map(r => r.name),
      };
      if (!_locationsCache.stations.length) _locationsCache.stations = ['Station 1'];
      // Rebuild slot count map — keys are full station name strings e.g. 'Station 1'
      _stationSlotCounts = {};
      for (const r of rows) {
        if (r.type === 'station' && r.slot_count != null) {
          _stationSlotCounts[r.name] = r.slot_count;
        }
      }
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

// Builds a display-ordered location list from a byLoc map.
// Stations (known + unknown Station-N names) come first in numerical order,
// then Extra/Office fixed staging — so a station missing from _locationsCache
// never gets pushed past Office.
function _sortedAllLocs(byLoc) {
  const locOrder = _getLocOrderAll();
  const fixedSet = new Set(_FIXED_STAGING);
  const unknown  = Object.keys(byLoc).filter(l => !locOrder.includes(l));
  unknown.sort((a, b) => {
    const na = a.match(/^station\s*(\d+)$/i), nb = b.match(/^station\s*(\d+)$/i);
    if (na && nb) return +na[1] - +nb[1];
    return a.localeCompare(b);
  });
  return [
    ...locOrder.filter(l => !fixedSet.has(l)),   // known stations / extra locs
    ...unknown.filter(l => !fixedSet.has(l)),    // unknown station-like locs, sorted numerically
    ...locOrder.filter(l => fixedSet.has(l)),    // Extra, Office
    ...unknown.filter(l => fixedSet.has(l)),     // edge-case: unknown fixed names
  ];
}

// Is this location a "station" (audit-eligible)?
function _isStation(loc) { return _getStations().includes(loc); }

// Is this location a full-audit staging area (Extra / configurable extra locs)?
// These books are verified by scan during audit but don't contribute to shift revenue.
function _isFullAuditStaging(loc) {
  return loc === 'Extra' || _getExtraLocs().includes(loc);
}

// ---- State ----
let _lotterySession      = [];
let _currentLotteryParse = null;
let _lotteryEventsReady  = false;
let _stockViewMode       = 'location';
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
let _invPacks         = [];     // active packs (stations only — Extra packs separated below)
let _invReceivedPacks = [];     // received (not yet activated) packs — shown in open-day/shift
let _invData          = {};     // pack_id → ticket number
let _invSoldOut       = {};     // pack_id → finalTicket — staged sold-outs, committed on confirm
let _invScanCleanup   = null;

// ---- Extra books audit state ----
let _invExtraPacks   = [];  // packs at Extra / extra-locs (separated from _invPacks at load time)
let _invExtraState   = {};  // pack_id → { ticket, verified, bypassed, bypassReason, movedTo }
let _extraCollapsed  = false;
let _extraBypassTarget  = null;  // pack_id currently in bypass confirmation modal
let _extraStationTarget = null;  // pack_id currently in station-pick modal

// ---- Move books modal ----
let _moveBooksQueue = []; // { id, packNumber, gameName, location }
let _movePendingDest = null;
let _movePendingHasActive = false;
let _moveUndoBooksRef = null;
let _moveUndoDestRef  = null;
let _moveUndoTimer    = null;

// ---- DB-state load guard ----
let _lotteryDbStateReady = false;

