// ===== REPORTS =====

let _reportRange = 'today';
let _rptStatus   = 'all'; // all | activated | soldout | removed
let _rptCache    = {};     // { entries, activations, activePacks } — undefined = not yet loaded
let _rptStatusCache = {};  // { [status]: Set<pack_id> } — pack_ids whose status changed in period
let _rptSF = '', _rptCF = '', _rptEF = '';

// Sort preferences — persists across range/status changes
let _rptSort = {
  activations:     'date-desc',    // date-desc | date-asc | count-desc
  activationsRows: 'time-desc',    // time-desc | time-asc | station | game
  bygame:          'revenue-desc', // revenue-desc | revenue-asc | tickets-desc | name-asc
  bystation:       'revenue-desc', // revenue-desc | revenue-asc | tickets-desc | name-asc
  activebooks:     'station',      // station | game-asc | price-desc | usage-desc
};

// ── Status action mapping ─────────────────────────────────────────────────────

const _STATUS_ACTIONS = {
  activated: ['activated'],
  soldout:   ['soldout'],
  removed:   ['removed', 'returned_to_lottery'],
};
const _STATUS_TITLES = {
  all:       'Book Activity by Date',
  activated: 'Book Activations by Date',
  soldout:   'Books Sold Out by Date',
  removed:   'Books Removed by Date',
};
const _STATUS_LABELS = {
  activated:           { icon: '→', label: 'Loaded',   color: '#0E8F5A' },
  soldout:             { icon: '✓', label: 'Sold Out',  color: '#E13B3B' },
  removed:             { icon: '✕', label: 'Removed',   color: '#B91C1C' },
  returned_to_lottery: { icon: '↩', label: 'Returned',  color: '#D97706' },
};

// ── Public entry points ───────────────────────────────────────────────────────

function setReportRange(range) {
  _reportRange = range;
  ['today', 'week', 'all'].forEach(r =>
    document.getElementById(`report-range-${r}`)?.classList.toggle('active', r === range)
  );
  loadLotteryReports();
}

async function setReportStatus(status) {
  if (!_dbCaps.hasPackEvents && status !== 'all') {
    showError('Not available', 'Pack event tracking is not enabled — status filtering requires it.');
    return;
  }
  _rptStatus = status;
  ['all', 'activated', 'soldout', 'removed'].forEach(s =>
    document.getElementById(`report-status-${s}`)?.classList.toggle('active', s === status)
  );
  // Update activations section title
  const titleEl = document.getElementById('rpt-activations-title');
  if (titleEl) titleEl.textContent = _STATUS_TITLES[status] || _STATUS_TITLES.all;

  // Fetch the pack_id set for this status if not yet cached
  if (status !== 'all' && !_rptStatusCache[status]) {
    await _fetchStatusPackIds(status);
  }

  // Activations must re-fetch because the action filter changes
  _rptCache.activations = undefined;
  const actBody = document.getElementById('rpt-body-activations');
  if (actBody && actBody.style.display !== 'none') {
    _loadRptSection('activations');
  }

  // Re-render other open sections from existing cache (no re-fetch)
  const rerender = (name, fn) => {
    const el = document.getElementById(`rpt-body-${name}`);
    if (el && el.style.display !== 'none') fn(el);
  };
  rerender('bygame',    el => _renderRptByGame(_rptCache.entries    || [], el));
  rerender('bystation', el => _renderRptByStation(_rptCache.entries || [], el));
  rerender('activebooks', el => _renderActiveBooksReport(_rptCache.activePacks || [], el));
}

async function loadLotteryReports() {
  if (!isAdmin()) return;
  _rptCache       = {};
  _rptStatusCache = {};
  _buildRptFilters();
  _collapseAllRptSections();
  // Reset status to All on full reload
  if (_rptStatus !== 'all') {
    _rptStatus = 'all';
    ['all', 'activated', 'soldout', 'removed'].forEach(s =>
      document.getElementById(`report-status-${s}`)?.classList.toggle('active', s === 'all')
    );
    const titleEl = document.getElementById('rpt-activations-title');
    if (titleEl) titleEl.textContent = _STATUS_TITLES.all;
  }
  await _loadRptKpi();
}

// ── Date filters ──────────────────────────────────────────────────────────────

function _buildRptFilters() {
  _rptSF = ''; _rptCF = ''; _rptEF = '';
  if (_reportRange === 'all') return;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (_reportRange === 'week') d.setDate(d.getDate() - 7);
  const iso = d.toISOString();
  _rptSF = `&opened_at=gte.${iso}`;
  _rptCF = `&created_at=gte.${iso}`;
  _rptEF = `&lottery_shifts.opened_at=gte.${iso}`;
}

function _rptPeriodLabel() {
  return _reportRange === 'today' ? 'today' : _reportRange === 'week' ? 'this week' : 'all time';
}

// ── Status pack_id cache ──────────────────────────────────────────────────────
// Fetches pack_ids whose status changed to `status` within the current date range.
// Results are cached in _rptStatusCache[status] as a Set<pack_id>.

async function _fetchStatusPackIds(status) {
  const actions = _STATUS_ACTIONS[status];
  if (!actions) return;
  const actionQ = actions.length === 1
    ? `action=eq.${actions[0]}`
    : `action=in.(${actions.join(',')})`;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?select=pack_id&${actionQ}${_rptCF}&limit=2000`
    );
    const arr = await res.json();
    _rptStatusCache[status] = new Set(
      Array.isArray(arr) ? arr.map(e => e.pack_id).filter(Boolean) : []
    );
  } catch (_) {
    _rptStatusCache[status] = new Set();
  }
}

// Returns the active pack_id filter Set, or null if no filtering needed.
function _getStatusPackIds() {
  if (_rptStatus === 'all') return null;
  return _rptStatusCache[_rptStatus] || null;
}

// ── Sort bar helper ───────────────────────────────────────────────────────────

function _rptSortBar(section, options) {
  const cur = _rptSort[section];
  return `<div class="rpt-sort-bar">${options.map(([key, label]) =>
    `<button class="rpt-sort-btn${cur === key ? ' active' : ''}"
      onclick="setRptSort('${section}','${key}',event)">${label}</button>`
  ).join('')}</div>`;
}

// ── KPI ───────────────────────────────────────────────────────────────────────

async function _loadRptKpi() {
  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  setEl('rpt-gross', '…'); setEl('rpt-tickets', '…');
  setEl('rpt-avg',   '…'); setEl('rpt-books-closed', '…');

  const base = CONFIG.supabaseUrl + '/rest/v1/';
  try {
    const [shiftsRes, activeCountRes, closedRes] = await Promise.all([
      sbFetch(`${base}lottery_shifts?select=total_revenue,total_tickets_sold${_rptSF}`),
      sbFetch(`${base}lottery_packs?select=id&status=eq.activated&limit=1`, { headers: { 'Prefer': 'count=exact' } }),
      _dbCaps.hasPackEvents
        ? sbFetch(`${base}lottery_pack_events?select=id&action=in.(soldout,removed)${_rptCF}&limit=1`, { headers: { 'Prefer': 'count=exact' } })
        : sbFetch(`${base}lottery_packs?select=id&status=in.(soldout,removed)&limit=1`,                { headers: { 'Prefer': 'count=exact' } }),
    ]);
    const shifts      = (await shiftsRes.json()) || [];
    const shiftArr    = Array.isArray(shifts) ? shifts : [];
    const activeCount = parseInt((activeCountRes.headers.get('content-range') || '').split('/')[1], 10) || 0;
    const closedCount = parseInt((closedRes.headers.get('content-range')      || '').split('/')[1], 10) || 0;
    const totalRev     = shiftArr.reduce((s, sh) => s + parseFloat(sh.total_revenue    || 0), 0);
    const totalTickets = shiftArr.reduce((s, sh) => s + parseInt(sh.total_tickets_sold || 0), 0);
    const avgTicket    = totalTickets > 0 ? totalRev / totalTickets : 0;
    const closedLabel  = (!_dbCaps.hasPackEvents || !_rptSF) ? 'all time' : 'in period';

    setEl('rpt-gross',        `$${totalRev.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    setEl('rpt-gross-sub',    `${shiftArr.length} shift${shiftArr.length !== 1 ? 's' : ''} ${_rptPeriodLabel()}`);
    setEl('rpt-tickets',      totalTickets.toLocaleString());
    setEl('rpt-tickets-sub',  `${shiftArr.length} shift${shiftArr.length !== 1 ? 's' : ''} ${_rptPeriodLabel()}`);
    setEl('rpt-avg',          `$${avgTicket.toFixed(2)}`);
    setEl('rpt-books-closed', closedCount);
    setEl('rpt-books-active', `${activeCount} on floor · closed ${closedLabel}`);
  } catch (_) {
    setEl('rpt-gross', 'Error');
  }
}

// ── Section collapse / toggle ─────────────────────────────────────────────────

function _collapseAllRptSections() {
  ['activations', 'bygame', 'bystation', 'activebooks'].forEach(name => {
    const body = document.getElementById(`rpt-body-${name}`);
    const chev = document.getElementById(`rpt-chev-${name}`);
    if (body) { body.style.display = 'none'; body.innerHTML = ''; }
    if (chev)   chev.style.transform = '';
  });
}

function toggleRptSection(name) {
  const body = document.getElementById(`rpt-body-${name}`);
  const chev = document.getElementById(`rpt-chev-${name}`);
  if (!body) return;
  const opening = body.style.display === 'none';
  body.style.display = opening ? '' : 'none';
  if (chev) chev.style.transform = opening ? 'rotate(90deg)' : '';
  if (opening) _loadRptSection(name);
}

// ── Sort ──────────────────────────────────────────────────────────────────────

function setRptSort(section, key, e) {
  if (e) e.stopPropagation();
  _rptSort[section] = key;
  const bodyEl = document.getElementById(`rpt-body-${section}`);
  if (!bodyEl || bodyEl.style.display === 'none') return;
  if (section === 'bygame')      _renderRptByGame(_rptCache.entries    || [], bodyEl);
  if (section === 'bystation')   _renderRptByStation(_rptCache.entries || [], bodyEl);
  if (section === 'activations') _rerenderActivations(bodyEl);
  if (section === 'activebooks') _renderActiveBooksReport(_rptCache.activePacks || [], bodyEl);
}

function setRptRowSort(key, e) {
  if (e) e.stopPropagation();
  _rptSort.activationsRows = key;
  const bodyEl = document.getElementById('rpt-body-activations');
  if (!bodyEl || bodyEl.style.display === 'none') return;
  _rerenderActivations(bodyEl);
}

function _rerenderActivations(bodyEl) {
  const openIds = _getOpenActIds(bodyEl);
  bodyEl.innerHTML = _rptSortBar('activations', [
    ['date-desc', 'Newest first'], ['date-asc', 'Oldest first'], ['count-desc', 'Most per day'],
  ]) + _renderActivationsByDate(_rptCache.activations || []);
  _restoreOpenActIds(bodyEl, openIds);
}
function _getOpenActIds(bodyEl) {
  const ids = new Set();
  bodyEl?.querySelectorAll('.rpt-act-body').forEach(el => {
    if (el.style.display !== 'none') ids.add(el.id);
  });
  return ids;
}
function _restoreOpenActIds(bodyEl, ids) {
  ids.forEach(id => {
    const body = document.getElementById(id);
    const chev = document.getElementById(`${id}-chev`);
    if (body) body.style.display = '';
    if (chev) chev.style.transform = 'rotate(90deg)';
  });
}

// ── Lazy loaders ──────────────────────────────────────────────────────────────

async function _loadRptSection(name) {
  const bodyEl = document.getElementById(`rpt-body-${name}`);
  if (!bodyEl) return;

  if (name === 'activations') {
    if (_rptCache.activations === undefined) {
      bodyEl.innerHTML = '<div class="summary-loading">Loading…</div>';
      try {
        if (!_dbCaps.hasPackEvents) throw new Error('no-events');
        // Fetch events whose action matches the active status filter
        const actions = _rptStatus === 'all'
          ? ['activated', 'soldout', 'removed', 'returned_to_lottery']
          : (_STATUS_ACTIONS[_rptStatus] || ['activated']);
        const actionQ = actions.length === 1
          ? `action=eq.${actions[0]}`
          : `action=in.(${actions.join(',')})`;
        const sel = 'id,pack_id,action,created_at,location_to,lottery_packs(pack_number,game_number,lottery_games(game_name))';
        const res = await sbFetch(
          `${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?select=${sel}&${actionQ}${_rptCF}&order=created_at.desc&limit=500`
        );
        const arr = await res.json();
        _rptCache.activations = Array.isArray(arr) ? arr : [];
      } catch (err) {
        _rptCache.activations = err?.message === 'no-events' ? null : [];
      }
    }
    if (_rptCache.activations === null) {
      bodyEl.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none;color:var(--text-hint)">Pack event tracking not enabled.</div>';
    } else {
      _rerenderActivations(bodyEl);
    }

  } else if (name === 'bygame' || name === 'bystation') {
    if (_rptCache.entries === undefined) {
      bodyEl.innerHTML = '<div class="summary-loading">Loading…</div>';
      try {
        const join     = _rptEF ? 'lottery_shifts!inner(opened_at),' : '';
        const entrySel = `pack_id,tickets_sold,revenue,${join}lottery_packs(game_number,location,lottery_games(game_name,price))`;
        const res = await sbFetch(
          `${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries?select=${entrySel}${_rptEF}`
        );
        const arr = await res.json();
        _rptCache.entries = Array.isArray(arr) ? arr : [];
      } catch (_) { _rptCache.entries = []; }
    }
    // Ensure pack_ids are ready if a status filter is active
    if (_rptStatus !== 'all' && !_rptStatusCache[_rptStatus]) {
      bodyEl.innerHTML = '<div class="summary-loading">Filtering…</div>';
      await _fetchStatusPackIds(_rptStatus);
    }
    if (name === 'bygame')    _renderRptByGame(_rptCache.entries, bodyEl);
    if (name === 'bystation') _renderRptByStation(_rptCache.entries, bodyEl);

  } else if (name === 'activebooks') {
    if (_rptCache.activePacks === undefined) {
      bodyEl.innerHTML = '<div class="summary-loading">Loading…</div>';
      try {
        const sel = _dbCaps.hasLoadingDirection
          ? 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,station_line,status,lottery_games(game_name,price,tickets_per_pack)'
          : 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,station_line,status,lottery_games(game_name,price,tickets_per_pack)';
        const res = await sbFetch(
          `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&status=in.(activated,soldout,removed)&order=location.asc`
        );
        const arr = await res.json();
        _rptCache.activePacks = Array.isArray(arr) ? arr : [];
      } catch (_) { _rptCache.activePacks = []; }
    }
    if (_rptStatus !== 'all' && !_rptStatusCache[_rptStatus]) {
      bodyEl.innerHTML = '<div class="summary-loading">Filtering…</div>';
      await _fetchStatusPackIds(_rptStatus);
    }
    _renderActiveBooksReport(_rptCache.activePacks, bodyEl);
  }
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function _renderRptByGame(entries, el) {
  const sortBar = _rptSortBar('bygame', [
    ['revenue-desc', 'Revenue ↓'], ['revenue-asc', 'Revenue ↑'],
    ['tickets-desc', 'Tickets'],   ['name-asc',    'A–Z'],
  ]);

  const packIds  = _getStatusPackIds();
  const filtered = packIds ? entries.filter(en => packIds.has(en.pack_id)) : entries;

  const gameMap = {};
  for (const en of filtered) {
    const p    = en.lottery_packs || {};
    const g    = p.lottery_games  || {};
    const gn   = String(p.game_number || 'unknown');
    const sold = parseInt(en.tickets_sold || 0);
    const rev  = parseFloat(en.revenue   || 0);
    if (!sold && !rev) continue;
    if (!gameMap[gn]) gameMap[gn] = { gn, name: g.game_name || `Game ${gn}`, price: parseFloat(g.price || 0), sold: 0, revenue: 0 };
    gameMap[gn].sold    += sold;
    gameMap[gn].revenue += rev;
  }
  const sort   = _rptSort.bygame;
  const byGame = Object.values(gameMap).sort((a, b) => {
    if (sort === 'revenue-asc')  return a.revenue - b.revenue;
    if (sort === 'tickets-desc') return b.sold - a.sold;
    if (sort === 'name-asc')     return a.name.localeCompare(b.name);
    return b.revenue - a.revenue;
  });

  if (!byGame.length) {
    el.innerHTML = sortBar + `<div class="log-empty" style="padding:12px 0;border:none">No sales ${_rptPeriodLabel()}</div>`;
    return;
  }
  const maxRef = sort === 'tickets-desc' ? (byGame[0].sold || 1) : (byGame[0].revenue || 1);
  el.innerHTML = sortBar + byGame.map(r => {
    const pct = Math.round(((sort === 'tickets-desc' ? r.sold : r.revenue) / maxRef) * 100);
    const clr = _gameColor(r.gn);
    return `
      <div class="rpt-game-row">
        <div class="rpt-game-dot" style="background:${clr}">${String(r.gn).slice(-2)}</div>
        <div class="rpt-game-info">
          <div class="rpt-game-name">${r.name}</div>
          <div class="rpt-game-meta">$${r.price.toFixed(2)}/ticket · ${r.sold.toLocaleString()} sold</div>
          <div class="rpt-game-bar-wrap"><div class="rpt-game-bar" style="width:${pct}%;background:${clr}"></div></div>
        </div>
        <div class="rpt-game-rev">$${r.revenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}</div>
      </div>`;
  }).join('');
}

function _renderRptByStation(entries, el) {
  const sortBar = _rptSortBar('bystation', [
    ['revenue-desc', 'Revenue ↓'], ['revenue-asc', 'Revenue ↑'],
    ['tickets-desc', 'Tickets'],   ['name-asc',    'A–Z'],
  ]);

  const packIds  = _getStatusPackIds();
  const filtered = packIds ? entries.filter(en => packIds.has(en.pack_id)) : entries;

  const locMap = {};
  for (const en of filtered) {
    const p   = en.lottery_packs || {};
    const loc = p.location || '—';
    const sold = parseInt(en.tickets_sold || 0);
    const rev  = parseFloat(en.revenue   || 0);
    if (!sold && !rev) continue;
    if (!locMap[loc]) locMap[loc] = { tickets: 0, revenue: 0 };
    locMap[loc].tickets += sold;
    locMap[loc].revenue += rev;
  }
  const sort      = _rptSort.bystation;
  const byStation = Object.entries(locMap).sort((a, b) => {
    if (sort === 'revenue-asc')  return a[1].revenue - b[1].revenue;
    if (sort === 'tickets-desc') return b[1].tickets - a[1].tickets;
    if (sort === 'name-asc')     return a[0].localeCompare(b[0]);
    return b[1].revenue - a[1].revenue;
  });

  if (!byStation.length) {
    el.innerHTML = sortBar + `<div class="log-empty" style="padding:12px 0;border:none">No sales ${_rptPeriodLabel()}</div>`;
    return;
  }
  el.innerHTML = sortBar + byStation.map(([loc, r], i) => `
    <div class="rpt-station-row"${i > 0 ? ' style="border-top:1px solid var(--border)"' : ''}>
      <div class="rpt-station-name">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--brand-red)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
        ${loc.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
      </div>
      <div class="rpt-station-rev">$${r.revenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}</div>
      <div class="rpt-station-meta">${r.tickets.toLocaleString()} tickets</div>
    </div>`).join('');
}

function _renderActiveBooksReport(packs, bodyEl) {
  const sortBar = _rptSortBar('activebooks', [
    ['station',    'Station'], ['game-asc',   'Game A–Z'],
    ['price-desc', 'Price ↓'], ['usage-desc', 'Most used'],
  ]);
  const countEl  = document.getElementById('rpt-hdr-activebooks-count');
  const allPacks = Array.isArray(packs) ? packs : [];
  const packIds  = _getStatusPackIds();

  // Filter by status-change events if a filter is active; otherwise show all non-received
  const active   = packIds ? allPacks.filter(p => packIds.has(p.id)) : allPacks;
  const statusLbl = { activated: 'active', soldout: 'sold out', removed: 'removed' }[_rptStatus] || '';
  if (countEl) countEl.textContent = `${active.length} ${statusLbl} book${active.length !== 1 ? 's' : ''}`.trim();

  if (!active.length) {
    const emptyMsg = _rptStatus === 'soldout'   ? 'No books sold out in this period'
                   : _rptStatus === 'removed'   ? 'No books removed in this period'
                   : _rptStatus === 'activated' ? 'No books activated in this period'
                   : 'No books found';
    bodyEl.innerHTML = sortBar + `<div class="log-empty" style="padding:12px 0;border:none">${emptyMsg}</div>`;
    return;
  }

  const sort = _rptSort.activebooks;
  if (sort !== 'station') {
    const sorted = active.slice().sort((a, b) => {
      const ga = a.lottery_games || {}, gb = b.lottery_games || {};
      if (sort === 'game-asc')   return (ga.game_name || '').localeCompare(gb.game_name || '');
      if (sort === 'price-desc') return parseFloat(gb.price || 0) - parseFloat(ga.price || 0);
      if (sort === 'usage-desc') {
        const pct = p => {
          const g = p.lottery_games || {};
          const dir = (p.loading_direction || 'asc').toLowerCase();
          const tpp = parseInt(g.tickets_per_pack || 0);
          if (!tpp) return 0;
          const t = p.start_ticket ?? (dir === 'desc' ? tpp - 1 : 0);
          return _soldTickets(t, dir === 'desc' ? tpp - 1 : 0, dir) / tpp;
        };
        return pct(b) - pct(a);
      }
      return 0;
    });
    const rows = sorted.map(p => _activeBookRow(p, true)).join('');
    bodyEl.innerHTML = sortBar + `
      <table class="rpt-books-table">
        <thead><tr><th>Station</th><th>Status</th><th>Line</th><th>Game</th><th>Game #</th><th>Book #</th><th>Ticket</th><th>Price</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    return;
  }

  // Grouped by station
  const byLoc = {};
  for (const p of active) { const l = p.location || '—'; if (!byLoc[l]) byLoc[l] = []; byLoc[l].push(p); }
  const stations = _sortedAllLocs(byLoc).filter(l => byLoc[l]?.length);
  bodyEl.innerHTML = sortBar + stations.map(station => {
    const ps = byLoc[station].slice().sort((a, b) => {
      if (a.station_line == null && b.station_line == null) return 0;
      if (a.station_line == null) return 1;
      if (b.station_line == null) return -1;
      return a.station_line - b.station_line;
    });
    return `
      <div class="rpt-books-station">
        <div class="rpt-books-station-hdr">
          <span>🏪 ${station}</span>
          <span class="rpt-books-station-count">${ps.length} book${ps.length !== 1 ? 's' : ''}</span>
        </div>
        <table class="rpt-books-table">
          <thead><tr><th>Line</th><th>Status</th><th>Game</th><th>Game #</th><th>Book #</th><th>Ticket</th><th>Price</th></tr></thead>
          <tbody>${ps.map(p => _activeBookRow(p, false)).join('')}</tbody>
        </table>
      </div>`;
  }).join('');
}

function _activeBookRow(p, showStation) {
  const game   = p.lottery_games || {};
  const dir    = (p.loading_direction || 'asc').toLowerCase();
  const tpp    = parseInt(game.tickets_per_pack || 0);
  const ticket = p.start_ticket ?? (dir === 'desc' ? tpp - 1 : 0);
  const sold   = _soldTickets(ticket, dir === 'desc' ? tpp - 1 : 0, dir);
  const pct    = tpp > 0 ? Math.min(100, Math.round((sold / tpp) * 100)) : 0;
  const color  = _gameColor(p.game_number);
  const lineBadge = p.station_line != null
    ? `<span class="rpt-line-badge">${p.station_line}</span>`
    : `<span class="rpt-line-badge rpt-line-unset">—</span>`;
  const statusPill = p.status === 'soldout' ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(225,59,59,.1);color:#E13B3B;border:1px solid rgba(225,59,59,.25)">Sold Out</span>`
    : p.status === 'removed' ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(185,28,28,.1);color:#B91C1C;border:1px solid rgba(185,28,28,.25)">Removed</span>`
    : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(14,143,90,.1);color:#0E8F5A;border:1px solid rgba(14,143,90,.25)">Active</span>`;
  const stationCell = showStation ? `<td class="rpt-act-station">${p.location || '—'}</td>` : '';
  return `
    <tr class="rpt-books-row">
      ${stationCell}
      <td>${statusPill}</td>
      <td class="rpt-books-line">${lineBadge}</td>
      <td class="rpt-books-name">
        <span class="rpt-books-dot" style="background:${color}">${String(p.game_number).slice(-2)}</span>
        ${game.game_name || `Game #${p.game_number}`}
      </td>
      <td class="rpt-books-gamenum">${p.game_number}</td>
      <td class="rpt-books-packnum">#${p.pack_number}</td>
      <td class="rpt-books-ticket">
        <span class="rpt-ticket-val">#${ticket}</span>
        ${tpp > 0 ? `<span class="rpt-ticket-bar-wrap"><span class="rpt-ticket-bar" style="width:${pct}%;background:${color}"></span></span>` : ''}
      </td>
      <td class="rpt-books-price">$${parseFloat(game.price || 0).toFixed(2)}</td>
    </tr>`;
}

function _renderActivationsByDate(events) {
  if (!events.length) {
    return '<div class="log-empty" style="padding:12px 0;border:none">No events in this period</div>';
  }

  const byDate = {}, dateOrder = [];
  for (const ev of events) {
    const key = new Date(ev.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    if (!byDate[key]) { byDate[key] = []; dateOrder.push(key); }
    byDate[key].push(ev);
  }

  const groupSort = _rptSort.activations;
  if (groupSort === 'date-asc')        dateOrder.reverse();
  else if (groupSort === 'count-desc') dateOrder.sort((a, b) => byDate[b].length - byDate[a].length);

  const rowSortBar = _rptSortBar('activationsRows', [
    ['time-desc', 'Time ↓'], ['time-asc', 'Time ↑'], ['station', 'Station'], ['game', 'Game'],
  ]);

  return dateOrder.map(dateStr => {
    const evs = byDate[dateStr];
    const id  = `rpt-act-date-${dateStr.replace(/[^a-zA-Z0-9]/g, '-')}`;

    // Collapsed header: station/action pill counts
    const stnCounts = {};
    for (const ev of evs) {
      const key = ev.location_to || '—';
      stnCounts[key] = (stnCounts[key] || 0) + 1;
    }
    const stnSummary = Object.entries(stnCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([st, n]) => `<span class="rpt-act-stn-pill">${st} <strong>${n}</strong></span>`)
      .join('');

    // Row sort
    const rowSort = _rptSort.activationsRows;
    let sortedEvs = [...evs];
    if      (rowSort === 'time-asc') sortedEvs.reverse();
    else if (rowSort === 'station')  sortedEvs.sort((a, b) => (a.location_to || '').localeCompare(b.location_to || ''));
    else if (rowSort === 'game')     sortedEvs.sort((a, b) => {
      const ga = a.lottery_packs?.lottery_games?.game_name || '';
      const gb = b.lottery_packs?.lottery_games?.game_name || '';
      return ga.localeCompare(gb);
    });

    const detailRows = sortedEvs.map(ev => {
      const p     = ev.lottery_packs || {};
      const g     = p.lottery_games  || {};
      const d     = new Date(ev.created_at);
      const time  = ev.created_at ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
      const meta  = _STATUS_LABELS[ev.action] || { icon: '·', label: ev.action, color: 'var(--ink-60)' };
      const color = _gameColor(p.game_number);
      const actionCell = `<td style="white-space:nowrap">
        <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${meta.color}18;color:${meta.color};border:1px solid ${meta.color}30">${meta.icon} ${meta.label}</span>
      </td>`;
      return `
        <tr class="rpt-books-row">
          <td class="rpt-act-time">${time}</td>
          ${actionCell}
          <td class="rpt-act-station">${ev.location_to || '—'}</td>
          <td class="rpt-books-name">
            <span class="rpt-books-dot" style="background:${color}">${String(p.game_number || '?').slice(-2)}</span>
            ${g.game_name || `Game #${p.game_number || '?'}`}
          </td>
          <td class="rpt-books-gamenum">${p.game_number || '—'}</td>
          <td class="rpt-books-packnum">#${p.pack_number || '—'}</td>
        </tr>`;
    }).join('');

    // Table header includes Action column when showing all types
    const actionTh = _rptStatus === 'all' ? '<th>Action</th>' : '';

    return `
      <div class="rpt-act-group">
        <div class="rpt-act-hdr" onclick="_toggleActDateGroup('${id}')">
          <svg class="rpt-act-chevron" id="${id}-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          <div class="rpt-act-hdr-left">
            <span class="rpt-act-date">${dateStr}</span>
            <span class="rpt-act-stns">${stnSummary}</span>
          </div>
          <span class="rpt-act-count">${evs.length} event${evs.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="rpt-act-body" id="${id}" style="display:none">
          ${rowSortBar}
          <table class="rpt-books-table">
            <thead><tr><th>Time</th>${actionTh}<th>Station</th><th>Game</th><th>Game #</th><th>Book #</th></tr></thead>
            <tbody>${detailRows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

function _toggleActDateGroup(id) {
  const body = document.getElementById(id);
  const chev = document.getElementById(`${id}-chev`);
  if (!body) return;
  const opening = body.style.display === 'none';
  body.style.display = opening ? '' : 'none';
  if (chev) chev.style.transform = opening ? 'rotate(90deg)' : '';
}
