// ===== EXTRA BOOKS AUDIT SECTION =====

function _extraExpectedPos(p) {
  const dir = (p.loading_direction || 'asc').toLowerCase();
  if (p.last_shift_ticket != null) return p.last_shift_ticket;
  if (p.start_ticket != null)      return p.start_ticket;
  const tpp = p.lottery_games?.tickets_per_pack || 0;
  return dir === 'desc' ? (p.end_ticket ?? Math.max(0, tpp - 1)) : 0;
}

function _renderExtraSection() {
  if (!_invExtraPacks.length) return '';

  const total    = _invExtraPacks.length;
  const verified = _invExtraPacks.filter(p => {
    const s = _invExtraState[p.id];
    return s && (s.verified || s.bypassed || s.movedTo);
  }).length;
  const allDone  = verified === total;

  const toggle   = _extraCollapsed ? '▶' : '▼';
  const pillHtml = allDone
    ? `<span class="extra-status-pill extra-pill-done">All verified ✓</span>`
    : `<span class="extra-status-pill extra-pill-pending">${verified}/${total} verified</span>`;
  const reqBadge = allDone ? '' : `<span class="extra-required-badge">Required</span>`;

  let html = `
    <div class="extra-section" id="extra-section">
      <div class="extra-section-hdr" onmousedown="toggleExtraSection()" ontouchstart="toggleExtraSection()">
        <span class="extra-toggle-icon">${toggle}</span>
        <span class="extra-section-title">Staging / Extra Books</span>
        ${pillHtml}
        ${reqBadge}
      </div>`;

  if (!_extraCollapsed) {
    html += `<div class="extra-section-body">`;
    for (const p of _invExtraPacks) html += _renderExtraBookCard(p);
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function _renderExtraBookCard(p) {
  const state    = _invExtraState[p.id] || {};
  const game     = p.lottery_games || {};
  const dotColor = _gameColor(p.game_number);
  const tpp      = game.tickets_per_pack || 0;
  const dir      = (p.loading_direction || 'asc').toLowerCase();
  const expected = _extraExpectedPos(p);
  const id       = p.id;

  let cardClass   = 'audit-book-extra-pending';
  let statusIcon  = '○';
  let statusClass = 'audit-status-pending';
  let bodyExtra   = '';
  let showInput   = true;

  if (state.movedTo) {
    cardClass   = 'audit-book-extra-moved';
    statusIcon  = '→';
    statusClass = 'audit-status-ok';
    bodyExtra   = `<div class="extra-state-note extra-note-moved">Moved to ${state.movedTo} · starting at ticket #${state.ticket}</div>`;
    showInput   = false;
  } else if (state.bypassed) {
    cardClass   = 'audit-book-extra-bypassed';
    statusIcon  = '!';
    statusClass = 'audit-status-flag';
    bodyExtra   = `<div class="extra-state-note extra-note-bypass">⚠ Bypassed — ${state.bypassReason}</div>`;
    showInput   = false;
  } else if (state.verified) {
    cardClass   = 'audit-book-matched';
    statusIcon  = '✓';
    statusClass = 'audit-status-ok';
    const atExpected = state.ticket === expected;
    bodyExtra = atExpected
      ? `<div class="extra-state-note extra-note-ok">Clean ✓ — at expected ticket #${state.ticket}</div>`
      : `<div class="extra-state-note extra-note-disc">Noted at #${state.ticket} (expected #${expected}) — kept at Extra</div>`;
    showInput = false;
  } else if (state.ticket != null) {
    // Scanned but awaiting station-or-keep decision
    cardClass   = 'audit-book-extra-warn';
    statusIcon  = '?';
    statusClass = 'audit-status-flag';
    bodyExtra   = `
      <div class="extra-miduse-prompt">
        <div class="extra-miduse-msg">Ticket #${state.ticket} — not at expected position (#${expected}). Was this book brought to a station for selling?</div>
        <div class="extra-prompt-btns">
          <button class="pack-act-btn act-station" style="font-size:11px;padding:5px 12px"
            onmousedown="openExtraStationModal('${id}')" ontouchstart="openExtraStationModal('${id}')">Yes — pick station</button>
          <button class="pack-act-btn" style="font-size:11px;padding:5px 12px;background:rgba(0,0,0,.06);color:var(--ink)"
            onmousedown="_extraKeepHere('${id}')" ontouchstart="_extraKeepHere('${id}')">No — keep at Extra</button>
        </div>
      </div>`;
    showInput = false; // ticket already entered, awaiting decision
  }

  const isNewBook  = p.status === 'received';
  const newBadge   = isNewBook ? `<span class="audit-badge" style="background:rgba(14,93,216,.1);color:#1d4ed8;border:1px solid rgba(14,93,216,.25);font-size:9.5px">New</span>` : '';

  const inputHtml = showInput ? `
    <button class="extra-bypass-btn"
      onmousedown="openExtraBypassModal('${id}')" ontouchstart="openExtraBypassModal('${id}')">Bypass</button>` : '';

  return `
    <div class="audit-book-card ${cardClass}" id="extra-row-${id}">
      <div class="audit-book-dot" style="background:${dotColor}">${String(p.game_number).slice(-2)}</div>
      <div class="audit-book-body">
        <div class="audit-book-hdr">
          <span class="audit-book-name">${game.game_name || `Game #${p.game_number}`}</span>
          <span class="audit-book-num">#${p.pack_number}</span>
          ${newBadge}
        </div>
        <div class="audit-book-meta" style="font-size:11.5px">${p.location || 'Extra'} · ${tpp > 0 ? `${tpp} tickets` : 'size unknown'} · expected #${expected}</div>
        ${bodyExtra}
      </div>
      <div class="audit-book-right">${inputHtml}</div>
      <div class="audit-book-status ${statusClass}" id="extra-status-${id}">${statusIcon}</div>
    </div>`;
}

function toggleExtraSection() {
  _extraCollapsed = !_extraCollapsed;
  const sec = document.getElementById('extra-section');
  if (sec) sec.outerHTML = _renderExtraSection();
}

function _handleExtraScan(pack, ticket) {
  const id       = pack.id;
  const expected = _extraExpectedPos(pack);
  const isClean  = ticket === expected;

  _invExtraState[id] = { ...(_invExtraState[id] || {}), ticket };

  if (isClean) {
    // Clean position — auto-verify immediately
    _invExtraState[id].verified = true;
  }
  // If not clean and open-day context: leave as pending-decision (renders miduse prompt)
  // If not clean and close context: auto-verify with noted discrepancy
  if (!isClean && _invContext !== 'open-day') {
    _invExtraState[id].verified = true;
  }

  _logPackEvent(id, 'extra_scan', {
    ticket_before: pack.last_shift_ticket ?? pack.start_ticket ?? null,
    ticket_after:  ticket,
    notes: `${_invContext} · Extra audit scan — ${pack.lottery_games?.game_name || 'Game ' + pack.game_number} #${pack.pack_number} at #${ticket}`,
  });

  _refreshExtraCard(id);
  _updateInvProgress();
  beepSuccess();
  if (navigator.vibrate) navigator.vibrate(30);
}

function _handleExtraManual(packId) {
  const inp  = document.getElementById(`extra-inp-${packId}`);
  if (!inp) return;
  const val  = parseInt(inp.value, 10);
  const pack = _invExtraPacks.find(x => x.id === packId);
  if (!pack) return;
  if (!isNaN(val) && val >= 0) {
    _handleExtraScan(pack, val);
  } else {
    delete (_invExtraState[packId] || {}).ticket;
    delete (_invExtraState[packId] || {}).verified;
    _refreshExtraCard(packId);
    _updateInvProgress();
  }
}

function _extraKeepHere(packId) {
  if (!_invExtraState[packId]) return;
  _invExtraState[packId].verified = true;
  _refreshExtraCard(packId);
  _updateInvProgress();
}

function _refreshExtraCard(packId) {
  const pack = _invExtraPacks.find(p => p.id === packId);
  if (!pack) return;
  const row = document.getElementById(`extra-row-${packId}`);
  if (!row) return;
  const newHtml = _renderExtraBookCard(pack);
  const tmp = document.createElement('div');
  tmp.innerHTML = newHtml.trim();
  row.replaceWith(tmp.firstElementChild);
  // Refresh section header progress
  const sec = document.getElementById('extra-section');
  if (sec) {
    const hdr = sec.querySelector('.extra-section-hdr');
    if (hdr) {
      const total    = _invExtraPacks.length;
      const verified = _invExtraPacks.filter(p => {
        const s = _invExtraState[p.id];
        return s && (s.verified || s.bypassed || s.movedTo);
      }).length;
      const allDone  = verified === total;
      const pill     = sec.querySelector('.extra-status-pill');
      const reqBadge = sec.querySelector('.extra-required-badge');
      if (pill) {
        pill.className = `extra-status-pill ${allDone ? 'extra-pill-done' : 'extra-pill-pending'}`;
        pill.textContent = allDone ? 'All verified ✓' : `${verified}/${total} verified`;
      }
      if (reqBadge) reqBadge.style.display = allDone ? 'none' : '';
    }
  }
}

// ===== EXTRA → STATION MOVE =====

function openExtraStationModal(packId) {
  _extraStationTarget = packId;
  const pack    = _invExtraPacks.find(p => p.id === packId);
  const state   = _invExtraState[packId] || {};
  const game    = pack?.lottery_games || {};
  const descEl  = document.getElementById('extra-station-modal-desc');
  const listEl  = document.getElementById('extra-station-btn-list');
  if (descEl) descEl.innerHTML = `
    <strong>${game.game_name || `Game #${pack?.game_number}`} #${pack?.pack_number}</strong>
    scanned at ticket <strong>#${state.ticket}</strong>.
    Select the station where this book was being sold:`;
  if (listEl) {
    listEl.innerHTML = _getStations().map(st => `
      <button class="modal-add-btn" style="margin:0;font-size:13px"
        onmousedown="_confirmExtraToStation('${packId}','${st}')"
        ontouchstart="_confirmExtraToStation('${packId}','${st}')">${st}</button>`).join('');
  }
  document.getElementById('extra-station-modal').classList.add('open');
}

function closeExtraStationModal() {
  document.getElementById('extra-station-modal').classList.remove('open');
  _extraStationTarget = null;
}

async function _confirmExtraToStation(packId, station) {
  const pack   = _invExtraPacks.find(p => p.id === packId);
  if (!pack) { closeExtraStationModal(); return; }
  const ticket = _invExtraState[packId]?.ticket ?? null;
  closeExtraStationModal();
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(packId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ location: station, start_ticket: ticket, last_shift_ticket: ticket })
    });
    _logPackEvent(packId, 'extra_to_station', {
      location_from: pack.location || 'Extra',
      location_to:   station,
      ticket_before: pack.last_shift_ticket ?? pack.start_ticket ?? null,
      ticket_after:  ticket,
      notes: `Moved from Extra to ${station} during audit at ticket #${ticket}`,
    });
    // Move book from Extra list into station list so it shows in the main audit (pre-scanned)
    pack.location          = station;
    pack.start_ticket      = ticket;
    pack.last_shift_ticket = ticket;
    _invExtraPacks         = _invExtraPacks.filter(x => x.id !== packId);
    _invPacks.push(pack);
    if (ticket != null) _invData[packId] = ticket;
    _invExtraState[packId] = { ticket, verified: true, movedTo: station };
    _renderInvList();
    _updateInvProgress();
  } catch (err) {
    showError('Move failed', err.message);
  }
}

// ===== EXTRA BYPASS =====

function openExtraBypassModal(packId) {
  _extraBypassTarget = packId;
  const pack    = _invExtraPacks.find(p => p.id === packId);
  const game    = pack?.lottery_games || {};
  const infoEl  = document.getElementById('extra-bypass-book-info');
  const reasonEl = document.getElementById('extra-bypass-reason');
  if (infoEl) infoEl.textContent = `${game.game_name || `Game #${pack?.game_number}`} · Book #${pack?.pack_number}`;
  if (reasonEl) reasonEl.value = '';
  document.getElementById('extra-bypass-modal').classList.add('open');
  setTimeout(() => reasonEl?.focus(), 100);
}

function closeExtraBypassModal() {
  document.getElementById('extra-bypass-modal').classList.remove('open');
  _extraBypassTarget = null;
}

function confirmExtraBypass(e) {
  if (e) e.preventDefault();
  const packId = _extraBypassTarget;
  if (!packId) return;
  const reasonEl = document.getElementById('extra-bypass-reason');
  const reason   = (reasonEl?.value || '').trim();
  if (!reason) {
    reasonEl?.classList.add('inv-input-error');
    setTimeout(() => reasonEl?.classList.remove('inv-input-error'), 1000);
    return;
  }
  _invExtraState[packId] = { ...(_invExtraState[packId] || {}), bypassed: true, bypassReason: reason };
  _logPackEvent(packId, 'extra_bypassed', {
    notes: `Extra bypass during ${_invContext}: ${reason}`,
  });
  closeExtraBypassModal();
  _refreshExtraCard(packId);
  _updateInvProgress();
}

function _handleInvBarcode(raw) {
  const scanInp = document.getElementById('inv-scan-input');
  if (scanInp) scanInp.value = '';
  const result = parseLotteryBarcode(raw);
  if (!result) { _flashInvScanError(); return; }

  let parsed, pack;
  let isExtraPack = false;
  if (result.ambiguous) {
    // Resolve by matching against loaded pack list, then Extra packs
    for (const candidate of result.candidates) {
      pack = _invPacks.find(p => p.game_number === candidate.gameNumber && p.pack_number === candidate.packNumber);
      if (pack) { parsed = candidate; break; }
    }
    if (!pack) {
      for (const candidate of result.candidates) {
        pack = _invExtraPacks.find(p => p.game_number === candidate.gameNumber && p.pack_number === candidate.packNumber);
        if (pack) { parsed = candidate; isExtraPack = true; break; }
      }
    }
    if (!pack) { _flashInvScanError('Book not in active list'); return; }
  } else {
    parsed = result;
    pack = _invPacks.find(p => p.game_number === parsed.gameNumber && p.pack_number === parsed.packNumber);
    if (!pack) {
      pack = _invExtraPacks.find(p => p.game_number === parsed.gameNumber && p.pack_number === parsed.packNumber);
      if (pack) isExtraPack = true;
    }
    if (!pack) { _flashInvScanError('Book not in active list'); return; }
  }

  // Route Extra book scans to the dedicated Extra handler
  if (isExtraPack) {
    const scanInp2 = document.getElementById('inv-scan-input');
    if (scanInp2) scanInp2.value = '';
    _handleExtraScan(pack, parsed.ticketPosition);
    // Update last-scan feedback panel
    const lastScanEl = document.getElementById('inv-last-scan');
    if (lastScanEl) {
      lastScanEl.style.display = '';
      lastScanEl.innerHTML = `
        <div class="audit-last-scan als-ok">
          <div class="als-station">Extra</div>
          <div class="als-book">${pack.lottery_games?.game_name || `Game #${pack.game_number}`} · #${pack.pack_number}</div>
          <div class="als-ticket"><strong>#${parsed.ticketPosition}</strong> <span class="als-good">✓ Extra verified</span></div>
        </div>`;
    }
    // Scroll the Extra card into view
    setTimeout(() => {
      const row = document.getElementById(`extra-row-${pack.id}`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
    const scanInpFocus = document.getElementById('inv-scan-input');
    if (scanInpFocus) scanInpFocus.focus();
    return;
  }

  _invData[pack.id] = parsed.ticketPosition;

  // Fire-and-forget audit scan log — records game, book, ticket, station, and exact scan time
  _logPackEvent(pack.id, 'audit_scan', {
    ticket_before: pack.last_shift_ticket ?? pack.start_ticket ?? null,
    ticket_after:  parsed.ticketPosition,
    location_to:   pack.location || null,
    created_at:    new Date().toISOString(),
    notes:         `${_invContext} · ${pack.lottery_games?.game_name || 'Game ' + pack.game_number} #${pack.pack_number} scanned at ticket #${parsed.ticketPosition}`,
  });

  const inp = document.getElementById(`inv-inp-${pack.id}`);
  if (inp) inp.value = parsed.ticketPosition;

  const isClose   = _invContext && _invContext.startsWith('close');
  const isOpenDay = _invContext === 'open-day';
  const row = document.getElementById(`inv-row-${pack.id}`);
  const st  = document.getElementById(`inv-status-${pack.id}`);
  if (row) { row.classList.add('inv-scanned'); row.classList.remove('audit-book-lined-pending', 'audit-book-pending'); }

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
  if (hasViolation) beepViolation(); else beepSuccess();

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

async function fillAuditFromLog() {
  if (!_dbCaps.hasPackEvents || !_invPacks.length) return;
  const statusEl  = document.getElementById('inv-fill-log-status');
  const windowSel = document.getElementById('inv-fill-log-window');
  const minutes   = parseInt(windowSel?.value || '15', 10);

  if (statusEl) statusEl.textContent = 'Looking up scan log…';

  try {
    const since   = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const packIds = _invPacks.map(p => p.id).join(',');
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events` +
      `?select=pack_id,ticket_after,created_at` +
      `&action=eq.audit_scan&pack_id=in.(${packIds})` +
      `&created_at=gte.${encodeURIComponent(since)}` +
      `&order=created_at.desc`
    );
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
      if (statusEl) statusEl.textContent = `No scan events found in the last ${minutes} min.`;
      return;
    }

    // Most recent scan per pack — skip already-staged sold-outs
    let filled = 0;
    const seen = new Set();
    for (const ev of rows) {
      if (seen.has(ev.pack_id) || ev.ticket_after == null) continue;
      if (ev.pack_id in _invSoldOut) continue;
      seen.add(ev.pack_id);
      _invData[ev.pack_id] = ev.ticket_after;
      filled++;
    }

    _renderInvList();
    _updateInvProgress();
    if (statusEl) statusEl.textContent = filled
      ? `${filled} of ${_invPacks.length} books filled from the last ${minutes} min.`
      : `No matching scans found in the last ${minutes} min.`;
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed to load scan log.';
    showError('Fill from log failed', err.message);
  }
}

function _flashInvScanError(msg) {
  beepNotFound();
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
    if (row) { row.classList.toggle('inv-scanned', !violation); row.classList.toggle('inv-row-violation', violation); row.classList.remove('audit-book-pending', 'audit-book-lined-pending'); }
    if (st)  st.textContent = violation ? '⚠' : '✓';
  } else {
    delete _invData[packId];
    inp.classList.remove('inv-input-error');
    const p = _invPacks.find(x => x.id === packId);
    if (row) { row.classList.remove('inv-scanned', 'inv-row-violation'); row.classList.add(p?.station_line != null ? 'audit-book-lined-pending' : 'audit-book-pending'); }
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

  // Extra books must all be verified (scanned+confirmed) or bypassed before confirming,
  // for all three contexts: open-day, close-shift, and close-day.
  const extraTotal    = _invExtraPacks.length;
  const extraVerified = _invExtraPacks.filter(p => {
    const s = _invExtraState[p.id];
    return s && (s.verified || s.bypassed || s.movedTo);
  }).length;
  const extraBlocking = extraTotal > 0 && extraVerified < extraTotal;

  const confirmBtn = document.getElementById('inv-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = (!_INV_OPTIONAL.has(_invContext) && done < total && total > 0) || hasViolation || extraBlocking;

  // Show/hide extra books reminder in scanner panel so it's always in view
  const extraReminder = document.getElementById('inv-extra-reminder');
  if (extraReminder) {
    if (extraBlocking) {
      const remaining = extraTotal - extraVerified;
      extraReminder.style.display = '';
      extraReminder.innerHTML = `<div style="margin-top:10px;padding:8px 10px;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.35);border-radius:8px;font-size:12px;color:#c7d2fe;line-height:1.5">
        ↓ <strong>${remaining} staging book${remaining !== 1 ? 's' : ''}</strong> still need verification — scroll right to verify</div>`;
    } else {
      extraReminder.style.display = 'none';
    }
  }
}

async function confirmInventory(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('inv-confirm-btn');

  // Open-day: gate on discrepancies before committing
  if (_invContext === 'open-day') {
    const mismatches = _getOpenDayDiscrepancies();
    if (mismatches.length) {
      _showOpenDayDiscrepancyModal(mismatches);
      return;
    }
  }

  if (btn) btn.disabled = true;
  try {
    if (_invContext === 'open-day')         await _invCommitOpenDay();
    else if (_invContext === 'close-shift') await _invCommitClose('shift');
    else if (_invContext === 'close-day')   await _invCommitClose('day');
    closeInventoryModal();
  } catch (err) {
    showError('Failed', err.message);
    _logSystemEvent('error', { notes: `Audit failed (${_invContext}): ${err.message}` });
    if (btn) btn.disabled = false;
  }
}

function _getOpenDayDiscrepancies() {
  return _invPacks.filter(p => {
    if (!(p.id in _invData) || (p.id in _invSoldOut)) return false;
    const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    return baseline != null && _invData[p.id] !== baseline;
  });
}

function _showOpenDayDiscrepancyModal(mismatches) {
  const rows = mismatches.map(p => {
    const game     = p.lottery_games || {};
    const info     = _packInfoCache[p.id] || {};
    const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const scanned  = _invData[p.id];
    const dir      = (p.loading_direction || 'asc').toLowerCase();
    const diff     = Math.abs(dir === 'desc' ? baseline - scanned : scanned - baseline);
    const lineBadge = info.stationLine != null
      ? `<span class="audit-line-badge" style="font-size:10px">LINE ${info.stationLine}</span> `
      : '';
    return `<div class="open-day-disc-row">
      <div class="open-day-disc-book">
        ${lineBadge}<strong>${game.game_name || `Game #${p.game_number}`}</strong>
        <span style="font-family:monospace;font-size:12px;color:var(--text-muted)"> #${p.pack_number}</span>
      </div>
      <div class="open-day-disc-detail">
        Last close <strong>#${baseline}</strong>
        &nbsp;→&nbsp;
        Scanned <strong>#${scanned}</strong>
        &nbsp;·&nbsp;
        <span style="color:var(--red-text)">⚠ ${diff} ticket${diff !== 1 ? 's' : ''} unaccounted</span>
      </div>
    </div>`;
  }).join('');

  const listEl = document.getElementById('open-day-disc-list');
  const cntEl  = document.getElementById('open-day-disc-count');
  if (listEl) listEl.innerHTML = rows;
  if (cntEl)  cntEl.textContent = mismatches.length;

  document.getElementById('open-day-disc-modal').classList.add('open');
}

async function confirmOpenDayAnyway() {
  document.getElementById('open-day-disc-modal').classList.remove('open');
  const btn = document.getElementById('inv-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    await _invCommitOpenDay();
    closeInventoryModal();
  } catch (err) {
    showError('Failed', err.message);
    if (btn) btn.disabled = false;
  }
}

function closeOpenDayDiscModal() {
  document.getElementById('open-day-disc-modal').classList.remove('open');
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
  // Snapshot globals immediately — closeInventoryModal() can clear them during async awaits.
  const _packs      = [..._invPacks];
  const _scanData   = { ..._invData };
  const _soldOuts   = { ..._invSoldOut };
  const _packCache  = { ..._packInfoCache };
  const _extraPacks = [..._invExtraPacks];
  const _extraState = { ..._invExtraState };
  const openNotes = (document.getElementById('inv-notes-input')?.value || '').trim() || null;
  // Create day
  const dayRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'open', ...(openNotes ? { notes: openNotes } : {}) }) });
  const days = await dayRes.json();
  _currentDay = Array.isArray(days) && days[0] ? days[0] : null;
  _currentShift = null;

  // Log discrepancies (scanned ticket ≠ last close baseline) before updating baselines
  for (const p of _packs) {
    if (!(p.id in _scanData) || (p.id in _soldOuts)) continue;
    const baseline = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    if (baseline != null && _scanData[p.id] !== baseline) {
      _logPackEvent(p.id, 'discrepancy', {
        ticket_before: baseline,
        ticket_after:  _scanData[p.id],
        notes: `open-day mismatch: expected #${baseline}, scanned #${_scanData[p.id]}`,
      });
    }
  }

  // Update baselines from inventory scan (skip staged sold-outs — handled separately below)
  const nonSoldOutEntries = Object.entries(_scanData).filter(([id]) => !(id in _soldOuts));
  if (nonSoldOutEntries.length) {
    await Promise.all(nonSoldOutEntries.map(([id, ticket]) =>
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ start_ticket: ticket, last_shift_ticket: ticket }) })));
  }

  // Commit staged sold-outs
  if (Object.keys(_soldOuts).length) {
    await Promise.all(Object.entries(_soldOuts).map(([id, finalTicket]) => {
      _logPackEvent(id, 'soldout', {
        ticket_before: (_packCache[id] || {}).lastShiftTicket ?? (_packCache[id] || {}).startTicket ?? null,
        ticket_after: finalTicket, context: 'open-day',
      });
      return sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'soldout', start_ticket: finalTicket, last_shift_ticket: finalTicket }) });
    }));
  }

  // Commit Extra book audit results — update checkpoint tickets and log events
  if (_extraPacks.length) {
    await Promise.all(_extraPacks.map(p => {
      const state = _extraState[p.id];
      if (!state) return Promise.resolve();
      if (state.movedTo) return Promise.resolve(); // already patched when move was confirmed
      if (state.bypassed) {
        // Bypass was already logged at bypass-time; nothing to patch
        return Promise.resolve();
      }
      if (state.verified && state.ticket != null) {
        // Update last_shift_ticket as a checkpoint so future audits detect tampering
        return sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(p.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_shift_ticket: state.ticket }),
        });
      }
      return Promise.resolve();
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

  _logSystemEvent('day_opened', {
    day_id:   _currentDay?.id || null,
    shift_id: _currentShift?.id || null,
    notes:    `Day opened — ${_packs.length} book${_packs.length !== 1 ? 's' : ''} audited`,
  });
  updateDayShiftButtons();
  await loadLotteryStock();
}

async function _invCommitOpenShift() {
  // No longer used — shift opens automatically after day open and after each shift close.
}

async function _invCommitClose(type) {
  if (_shiftOpInProgress) {
    throw new Error('Another close operation is already in progress. Please wait and try again.');
  }
  _shiftOpInProgress = true;
  // Snapshot globals immediately — closeInventoryModal() can clear them during async awaits,
  // which would cause the pack-position PATCHes to silently iterate over an empty array.
  const _packs      = [..._invPacks];
  const _scanData   = { ..._invData };
  const _soldOuts   = { ..._invSoldOut };
  const _packCache  = { ..._packInfoCache };
  const _ctx        = _invContext;
  try {
  const entries = [];
  let totalSold = 0, totalRev = 0;
  for (const p of _packs) {
    const currentTick = _scanData[p.id] != null ? _scanData[p.id] : p.start_ticket;
    const lastTicket  = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const price       = parseFloat(p.lottery_games?.price || 0);
    const dir         = (p.loading_direction || 'asc').toLowerCase();
    // Sold-out via button: finalTicket is the last real ticket (#tpp-1 or #0),
    // so add 1 to include that final ticket in the sold count.
    const baseSold    = _soldTickets(currentTick, lastTicket, dir);
    const sold        = (p.id in _soldOuts) ? baseSold + 1 : baseSold;
    const revenue     = sold * price;
    totalSold += sold; totalRev += revenue;
    const stationLine = (_packCache[p.id] || {}).stationLine ?? null;
    entries.push({ pack_id: p.id, tickets_sold: sold, revenue, ticket_at_open: lastTicket, ticket_at_close: currentTick, station_line: stationLine });
  }

  // Add any tickets sold on packs that were removed mid-shift (logged at removal time)
  if (_dbCaps.hasFullDayTracking && _currentShift) {
    const activeIds  = new Set(_packs.map(p => p.id));
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
  for (const [id, finalTicket] of Object.entries(_soldOuts)) {
    _logPackEvent(id, 'soldout', {
      ticket_before: (_packCache[id] || {}).lastShiftTicket ?? (_packCache[id] || {}).startTicket ?? null,
      ticket_after: finalTicket, context: _ctx,
    });
  }
  await Promise.all(_packs.map(p => {
    const tick      = _scanData[p.id] != null ? _scanData[p.id] : p.start_ticket;
    const isSoldOut = p.id in _soldOuts;
    const extra     = isSoldOut ? { status: 'soldout' } : {};
    return sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(p.id)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ start_ticket: tick, last_shift_ticket: tick, ...extra }) });
  }));

  _logSystemEvent('shift_closed', {
    shift_id: shiftId,
    day_id:   _currentDay?.id || null,
    notes:    `Shift closed — ${totalSold} ticket${totalSold !== 1 ? 's' : ''}, $${totalRev.toFixed(2)} revenue`,
  });
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
    _logSystemEvent('day_closed', {
      shift_id: shiftId,
      day_id:   _currentDay.id,
      notes:    `Day closed — ${dayTotals.tickets} ticket${dayTotals.tickets !== 1 ? 's' : ''}, $${dayTotals.revenue.toFixed(2)} revenue`,
    });
    _currentDay = null;
  }
  updateDayShiftButtons();
  await Promise.all([loadLotteryStock(), loadShiftHistory()]);
  loadLotteryDbStats();
  } finally {
    _shiftOpInProgress = false;
  }
}

