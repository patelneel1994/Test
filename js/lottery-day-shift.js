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
      `&status=eq.activated&order=location.asc`
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

