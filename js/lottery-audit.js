// ===== INVENTORY SCAN =====

const _INV_OPTIONAL = new Set(); // nothing is optional — open-day now requires full scan
const _INV_TITLES   = {
  'open-day':    'Day Open — Inventory Check',
  'close-shift': 'Change Shift — Inventory (Required)',
  'close-day':   'Day Close — Inventory (Required)',
};

async function openInventory(context, skipPrompt = false) {
  if (_invBusy) { showError('Busy', 'An audit is already in progress.'); return; }
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
    // Refresh locations cache so extra-loc names are always current when separating books.
    await _loadLotteryLocations();

    const sel = _dbCaps.hasLoadingDirection
      ? `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,station_line,lottery_games(game_name,price,tickets_per_pack)`
      : `id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,station_line,lottery_games(game_name,price,tickets_per_pack)`;
    const base = `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&order=location.asc,pack_number.asc`;
    const isOpenDay = context === 'open-day';
    const isClose   = !isOpenDay && context.startsWith('close');
    // Always fetch received — extra-loc books have status=received (not activated) because
    // moving a book to a non-station location sets status='received' (see _isStation check).
    const fetches = [sbFetch(`${base}&status=eq.activated`), sbFetch(`${base}&status=eq.received`)];
    if (isClose) fetches.push(sbFetch(`${base}&status=eq.soldout`));
    const results = await Promise.all(fetches);
    const jsons   = await Promise.all(results.map(r => r.json()));
    _invPacks         = Array.isArray(jsons[0]) ? jsons[0] : [];
    const allReceived = Array.isArray(jsons[1]) ? jsons[1] : [];

    // Separate Extra / extra-loc books from station books immediately after fetch.
    // Extra books get their own audit section and don't affect shift revenue.
    _invExtraPacks  = _invPacks.filter(p => _isFullAuditStaging(p.location));
    _invPacks       = _invPacks.filter(p => !_isFullAuditStaging(p.location));
    _invExtraState  = {};
    _extraCollapsed = false;

    // Received books at extra locations go into the Extra audit section for ALL contexts.
    // For open-day, remaining received books (at stations) stay in _invReceivedPacks.
    const recAtExtra  = allReceived.filter(p => _isFullAuditStaging(p.location));
    _invExtraPacks    = [..._invExtraPacks, ...recAtExtra];
    _invReceivedPacks = isOpenDay ? allReceived.filter(p => !_isFullAuditStaging(p.location)) : [];

    // Include soldout packs whose last_shift_ticket hasn't been settled yet —
    // these were marked sold-out mid-shift and need their revenue counted.
    if (isClose) {
      const soldoutPacks = Array.isArray(jsons[2]) ? jsons[2] : [];
      const unsettled = soldoutPacks.filter(p =>
        p.start_ticket != null && p.last_shift_ticket != null && p.start_ticket !== p.last_shift_ticket
      );
      for (const p of unsettled) {
        _invData[p.id]    = p.start_ticket;
        _invSoldOut[p.id] = p.start_ticket;
      }
      _invPacks = [..._invPacks, ...unsettled];
    }

    // Auto-commit only when there is truly nothing to audit (no station books AND no Extra books)
    if (!_invPacks.length && !_invReceivedPacks.length && !_invExtraPacks.length) {
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
  // Extra books notice — shown when extra-location books also need verification
  if (_invExtraPacks.length) {
    html += `<div style="margin-top:10px;padding:8px 10px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:8px;font-size:12px;color:#4338ca;line-height:1.5">
      <strong>Extra Books</strong> — ${_invExtraPacks.length} book${_invExtraPacks.length !== 1 ? 's' : ''} in extra location${_invExtraPacks.length !== 1 ? 's' : ''} also need verification.<br>
      <span style="opacity:.8">Shown below the station books after you select a station above.</span>
    </div>`;
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

  // Show recovery button for all audit contexts
  const fillWrap = document.getElementById('inv-fill-from-log-wrap');
  if (fillWrap) fillWrap.style.display = '';
  const fillStatus = document.getElementById('inv-fill-log-status');
  if (fillStatus) fillStatus.textContent = '';

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
  const base    = `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&order=location.asc,pack_number.asc`;
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
  _invExtraPacks = []; _invExtraState = {};
  _invSelectedStation = null;
}

// ===== AUDIT SOLD-OUT STAGING =====

function _invMarkSoldOut(packId) {
  // Kept for any legacy callers — routes through the shared openSoldOutModal
  openSoldOutModal(packId, null, null);
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
    const allShiftsRes = await sbFetch(`${base}lottery_shifts?select=id`);
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
    if (!_invExtraPacks.length) {
      el.innerHTML = '<div class="audit-empty">No active books — press Confirm to proceed.</div>';
      return;
    }
    // Only Extra-location books exist — skip station list, show Extra section directly
    el.innerHTML = _renderExtraSection();
    if (isClose) _updateInvTotals();
    return;
  }

  const locOrder = _getLocOrderAll();
  const locOrderSet = new Set(locOrder);
  const byLoc = {};       // filtered by selected station — for normal rendering
  const byLocAll = {};    // unfiltered — for catch-all of unrecognized locations
  for (const p of _invPacks) {
    const loc = p.location || 'Office';
    if (!locOrderSet.has(loc)) {
      if (!byLocAll[loc]) byLocAll[loc] = [];
      byLocAll[loc].push(p);
    }
    if (_invSelectedStation && loc !== _invSelectedStation) continue;
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(p);
  }

  let html = '';
  for (const loc of locOrder) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;
    // Sort by station_line ascending — nulls (unassigned) appear before numbered slots
    packs.sort((a, b) => {
      if (a.station_line == null && b.station_line == null) return 0;
      if (a.station_line == null) return -1;
      if (b.station_line == null) return 1;
      return a.station_line - b.station_line;
    });
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
        stationLine:       p.station_line ?? null,
      };

      // ── Sold-out staged ──
      if (p.id in _invSoldOut) {
        const finalTicket = _invSoldOut[p.id];
        const sold = _soldTickets(finalTicket, baseline, dir) + 1;
        const pct  = 100;
        const price = parseFloat(game.price || 0);
        const rev   = sold * price;
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
              <div class="audit-book-meta">Last #${baseline} → Final #${finalTicket} · <strong>${sold}</strong> sold${price > 0 ? ` · <strong>$${rev.toFixed(2)}</strong>` : ''}</div>
              <div class="audit-book-bar-wrap"><div class="audit-book-bar" style="width:${pct}%;background:${dotColor}"></div></div>
            </div>
            <div class="audit-book-actions">
              <button class="pack-act-btn" style="font-size:11px;padding:5px 10px"
                onmousedown="_invUnmarkSoldOut('${p.id}')">Undo</button>
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

      // Close-shift / close-day: any staff. Open-day: admin gate + extra warning in modal.
      const soldOutBtn = isClose
        ? `<button class="pack-act-btn act-soldout" style="font-size:11px;padding:5px 10px"
            onmousedown="openSoldOutModal('${p.id}',null,event)">Sold Out</button>`
        : `<button class="pack-act-btn act-soldout" style="font-size:11px;padding:5px 10px;opacity:.7"
            onmousedown="requireAdmin(()=>openSoldOutModal('${p.id}',null,null));event.preventDefault()">Sold Out</button>`;
      const removeBtn = isOpenDay ? `<button class="pack-remove-btn"
            onmousedown="removePackAtTicket('${p.id}',${p.start_ticket ?? 0},event)" title="Remove">✕</button>` : '';

      html += `
        <div class="audit-book-card${hasVal ? (hasViolation ? ' audit-book-flagged' : ' audit-book-matched') : (p.station_line != null ? ' audit-book-lined-pending' : ' audit-book-pending')}" id="inv-row-${p.id}">
          <div class="audit-book-dot" style="background:${dotColor}">${String(p.game_number).slice(-2)}</div>
          <div class="audit-book-body">
            <div class="audit-book-hdr">
              ${p.station_line != null ? `<span class="audit-line-badge">LINE ${p.station_line}</span>` : ''}
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

  // Render any locations not in locOrder (e.g. custom extra location with stale/mismatched cache)
  // Uses byLocAll (unfiltered) so these always appear regardless of station selection.
  for (const loc of Object.keys(byLocAll)) {
    if (!byLocAll[loc].length) continue;
    html += `<div class="audit-loc-group"><div class="audit-loc-label">${loc}</div>`;
    for (const p of byLocAll[loc]) {
      const game     = p.lottery_games || {};
      const tpp      = game.tickets_per_pack || 0;
      const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const hasVal   = p.id in _invData;
      const scanned  = _invData[p.id];
      const dir      = (p.loading_direction || 'asc').toLowerCase();
      const dotColor = _gameColor(p.game_number);
      _packInfoCache[p.id] = {
        ticketsPerPack: tpp, gameName: game.game_name || '', packNumber: p.pack_number,
        startTicket: p.start_ticket, endTicket: p.end_ticket ?? null,
        lastShiftTicket: p.last_shift_ticket ?? null, loadingDirection: dir,
        location: p.location, stationLine: p.station_line ?? null,
      };
      const hasViolation = hasVal && _invDirectionViolation(p.id, scanned);
      html += `
        <div class="audit-book-card ${hasViolation ? 'audit-book-flag' : (hasVal ? 'audit-book-ok' : 'audit-book-pending')}" id="inv-row-${p.id}">
          <div class="audit-book-dot" style="background:${dotColor}">${String(p.game_number).slice(-2)}</div>
          <div class="audit-book-body">
            <div class="audit-book-hdr">
              <span class="audit-book-name">${game.game_name || `Game #${p.game_number}`}</span>
              <span class="audit-book-num">#${p.pack_number}</span>
            </div>
            <div class="audit-book-meta">${loc} · expected #${baseline ?? '?'}</div>
          </div>
          <div class="audit-book-actions">
            <input type="number" class="audit-ticket-input" id="inv-inp-${p.id}"
              value="${hasVal ? scanned : ''}" placeholder="#" min="0"
              oninput="_handleInvManual('${p.id}')" />
          </div>
          <div class="audit-book-status ${hasViolation ? 'audit-status-flag' : (hasVal ? 'audit-status-ok' : 'audit-status-pending')}" id="inv-status-${p.id}">${hasViolation ? '!' : (hasVal ? '✓' : '○')}</div>
        </div>`;
    }
    html += '</div>';
  }

  // ── Received books (open-day only) ──
  // "Load Received Books" section removed — was shown during open-day audit to activate
  // received packs directly from the audit screen. Removed to simplify the open-day flow.
  // To restore: uncomment the block below and remove this comment.
  /*
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
              onmousedown="loadReceivedPack('${p.id}','${st}',event)">${st}</button>`).join('')}
          </div>
        </div>`;
    }
    html += '</div>';
  }
  */

  // Append Extra books section below station list
  html += _renderExtraSection();
  el.innerHTML = html;

  if (isClose) {
    for (const p of _invPacks) { if (p.id in _invData) _updateInvCalc(p.id); }
    _updateInvTotals();
  }
}

