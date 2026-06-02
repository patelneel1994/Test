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
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=location,status`
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
    const nameRow = `
      <div class="settings-loc-row">
        <input class="settings-loc-input" value="${eName}" data-orig="${eName}" data-type="${type}"
          onchange="settingsRenameLocation(this.dataset.type,this.dataset.orig,this.value);this.dataset.orig=this.value.trim()"
          onblur="settingsRenameLocation(this.dataset.type,this.dataset.orig,this.value);this.dataset.orig=this.value.trim()" />
        ${_badge(name)}
        ${delBtn}
      </div>`;
    if (type !== 'station') return nameRow;
    // Station-only: show slot count field below the name row
    const slotCount = _getStationSlotCount(name);
    const slotVal   = slotCount != null ? slotCount : '';
    return `<div class="settings-station-item">
      ${nameRow}
      <div class="settings-slots-row">
        <span class="settings-slots-label">Display slots</span>
        <input class="settings-slots-input" type="number" min="1" max="99"
          value="${slotVal}" placeholder="—"
          onchange="saveStationSlotCount('${eName}', this.value, this)"
          onblur="saveStationSlotCount('${eName}', this.value, this)" />
        <span class="settings-slots-hint">physical slots at this station</span>
      </div>
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

let _pendingClearSlots = null; // { name, inputEl, packs[] }

async function saveStationSlotCount(name, rawVal, inputEl) {
  const n = parseInt(rawVal, 10);
  const slot_count = (!rawVal || rawVal === '' || isNaN(n) || n < 1) ? null : n;

  // Skip if nothing changed
  if (_stationSlotCounts[name] === slot_count) return;
  if (slot_count === null && _stationSlotCounts[name] == null) return;

  const current = _stationSlotCounts[name] ?? null;

  // ── Clearing the slot count ──────────────────────────────────────────────
  // Warn first; if any packs have line numbers assigned they must be unassigned
  // and the action logged before the slot structure is removed.
  if (slot_count === null) {
    try {
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?location=eq.${encodeURIComponent(name)}&station_line=not.is.null` +
        `&select=id,pack_number,game_number,station_line,lottery_games(game_name)&order=station_line.asc`
      );
      const packs = await res.json();
      if (Array.isArray(packs) && packs.length > 0) {
        // Packs are assigned — show confirmation modal before proceeding
        _pendingClearSlots = { name, inputEl, packs };
        const listHtml = packs.map(p => {
          const gameName = p.lottery_games?.game_name || `Game ${p.game_number}`;
          return `<div class="clear-slots-pack-row">
            <span class="clear-slots-line">Line ${p.station_line}</span>
            <span class="clear-slots-book">${gameName} <span style="font-family:monospace">#${p.pack_number}</span></span>
          </div>`;
        }).join('');
        document.getElementById('clear-slots-station-name').textContent = name;
        document.getElementById('clear-slots-list').innerHTML = listHtml;
        document.getElementById('clear-slots-modal').classList.add('open');
        return; // wait for confirm/cancel
      }
      // No assigned packs — safe to clear silently
    } catch (e) {
      showError('Slot check failed', e.message);
      if (inputEl) inputEl.value = current ?? '';
      return;
    }
  }

  // ── Decreasing to a specific number ─────────────────────────────────────
  // Block if any pack sits above the new ceiling.
  if (slot_count !== null && (current === null || slot_count < current)) {
    try {
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?location=eq.${encodeURIComponent(name)}&station_line=not.is.null&select=station_line&order=station_line.desc&limit=1`
      );
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const maxLine = rows[0].station_line;
        if (maxLine > slot_count) {
          showError(
            `Cannot reduce to ${slot_count} slot${slot_count === 1 ? '' : 's'}`,
            `${name} has a book assigned to Line ${maxLine}. Unassign Line ${maxLine} before reducing the slot count below ${maxLine}.`
          );
          if (inputEl) inputEl.value = current ?? '';
          return;
        }
      }
    } catch (e) {
      showError('Slot count check failed', e.message);
      if (inputEl) inputEl.value = current ?? '';
      return;
    }
  }

  await _applyStationSlotCount(name, slot_count, inputEl, current);
}

async function _applyStationSlotCount(name, slot_count, inputEl, current) {
  try {
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_locations?name=eq.${encodeURIComponent(name)}&type=eq.station`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ slot_count }) }
    );
    if (slot_count == null) delete _stationSlotCounts[name];
    else _stationSlotCounts[name] = slot_count;
  } catch (e) {
    showError('Failed to save slot count', e.message);
    if (inputEl) inputEl.value = current ?? '';
  }
}

async function confirmClearSlots() {
  if (!_pendingClearSlots) return;
  const { name, inputEl, packs } = _pendingClearSlots;
  _pendingClearSlots = null;
  document.getElementById('clear-slots-modal').classList.remove('open');

  const current = _stationSlotCounts[name] ?? null;
  try {
    // Bulk-clear all station_line values for this station
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?location=eq.${encodeURIComponent(name)}&station_line=not.is.null`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ station_line: null }) }
    );
    // Log each unassignment individually so the activity feed shows full context
    for (const p of packs) {
      _logPackEvent(p.id, 'line_cleared', {
        location_to: name,
        notes: `Line ${p.station_line} at ${name} cleared when slot structure was removed`,
      });
    }
    // Now clear the slot count itself
    await _applyStationSlotCount(name, null, inputEl, current);
    // Refresh stock view if open so line badges disappear
    if (document.getElementById('lottery-stock-section')?.style.display !== 'none') {
      loadLotteryStock();
    }
  } catch (e) {
    showError('Failed to clear slots', e.message);
    if (inputEl) inputEl.value = current ?? '';
  }
}

function cancelClearSlots() {
  if (!_pendingClearSlots) return;
  const { inputEl } = _pendingClearSlots;
  const current = _stationSlotCounts[_pendingClearSlots.name] ?? null;
  _pendingClearSlots = null;
  document.getElementById('clear-slots-modal').classList.remove('open');
  if (inputEl) inputEl.value = current ?? '';
}

