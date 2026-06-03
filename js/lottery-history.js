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
  if (!isAdmin()) return;
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
        `&order=opened_at.desc${dateFilter}`
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
          `lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,station_line,` +
            `lottery_packs(pack_number,game_number,location,station_line,status,lottery_games(game_name,price)))` +
          eventsSelect;
        const sumSel =
          `id,day_id,opened_at,closed_at,status,shift_type,total_tickets_sold,total_revenue,notes`;

        // ── Full detail: first 2 days
        try {
          const recentN   = Math.min(2, daysArr.length);
          const recentIds = daysArr.slice(0, recentN).map(d => d.id).join(',');
          const r1 = await sbFetch(
            `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
            `?day_id=in.(${recentIds})&select=${fullSel}&order=opened_at.asc`
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
              `?day_id=in.(${olderIds})&select=${sumSel}&order=opened_at.asc`
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
            `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?status=eq.activated&select=${packSel}&order=location.asc,pack_number.asc`
          );
          const ap = await apRes.json();
          if (Array.isArray(ap)) activePacks = ap;
        } catch (_) {}
      }

      renderDayHistory(daysArr, activePacks);
    } else {
      const res = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
        `?select=id,shift_type,closed_at,total_tickets_sold,total_revenue,notes,lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,station_line,lottery_packs(pack_number,game_number,location,station_line,status,lottery_games(game_name,price)))` +
        `&order=closed_at.desc${dateFilter.replace(/opened_at/g, 'closed_at')}`
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

function _priceBreakdownHtml(rows, parentLevel = false, label = '') {
  const tiers = {};
  for (const row of rows) {
    const price = parseFloat(row.pack?.lottery_games?.price || 0);
    if (!tiers[price]) tiers[price] = { sold: 0, rev: 0 };
    tiers[price].sold += row.sold;
    tiers[price].rev  += row.rev;
  }
  const sorted = Object.keys(tiers).map(Number).sort((a, b) => a - b).filter(p => tiers[p].sold > 0);
  if (!sorted.length) return '';
  const totalSold = sorted.reduce((s, p) => s + tiers[p].sold, 0);
  const totalRev  = sorted.reduce((s, p) => s + tiers[p].rev,  0);
  const chips = sorted.map(price => {
    const { bg } = _priceColor(price);
    const t = tiers[price];
    return `<span class="pb-chip" style="background:${bg}">$${price} · ${t.sold} · $${t.rev.toFixed(2)}</span>`;
  }).join('');
  const labelHtml = label ? `<span class="pb-label">${label}</span>` : '';
  const total = `<span class="pb-chip-total">${totalSold} · $${totalRev.toFixed(2)}</span>`;
  const cls = parentLevel ? 'price-breakdown-bar-parent' : 'price-breakdown-bar';
  return `<div class="${cls}">${labelHtml}${chips}${total}</div>`;
}

function _buildPackTicketRows(entries, events) {
  const byPack = new Map(); // pack_id → { pack, openTick, closeTick, sold, rev, statusEvents[] }

  for (const en of (entries || [])) {
    const id   = en.pack_id;
    if (!id) continue;
    const pack = en.lottery_packs || {};
    if (!byPack.has(id)) byPack.set(id, { pack, openTick: null, closeTick: null, sold: 0, rev: 0, statusEvents: [], stationLine: null, loc: null });
    const row = byPack.get(id);
    if (!row.pack.game_number && pack.game_number) row.pack = pack;
    // openTick: keep first seen (earliest shift = day start for that pack)
    if (en.ticket_at_open  != null && row.openTick  === null) row.openTick  = en.ticket_at_open;
    // closeTick: always overwrite so last shift wins (= day end for that pack)
    if (en.ticket_at_close != null) row.closeTick = en.ticket_at_close;
    row.sold += en.tickets_sold    || 0;
    row.rev  += parseFloat(en.revenue || 0);
    // station_line: prefer shift entry value; fall back to pack's current value (preserved for soldout)
    const entryLine = en.station_line ?? pack.station_line ?? null;
    if (entryLine != null) row.stationLine = entryLine;
    if (!row.loc && pack.location) row.loc = pack.location;
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

  const _BADGE_LABEL = { removed: 'Removed', returned_to_lottery: 'Returned', soldout: 'Sold Out', restored: 'Restored' };

  const _rowHtml = ({ pack, openTick, closeTick, sold, rev, statusEvents, stationLine, loc }) => {
    const game      = pack.lottery_games || {};
    const name      = game.game_name || (pack.game_number ? `Game #${pack.game_number}` : '?');
    const packNum   = pack.pack_number || '?';
    const price     = parseFloat(game.price || 0);
    const dotBg     = _priceColor(price).bg;
    const abbr      = String(pack.game_number || '').slice(-2).padStart(2, '0');
    const isSoldOut = statusEvents.some(ev => ev.action === 'soldout') || pack.status === 'soldout';
    const lineTag   = _isStation(loc)
      ? (stationLine != null
          ? `<span class="line-num-badge${isSoldOut ? ' lnb-soldout' : ''}">${stationLine}</span>`
          : `<span class="line-num-empty"></span>`)
      : '';
    const tickRange = (openTick != null && closeTick != null)
      ? `<span class="spt-range"><span class="spt-tick">#${openTick}</span><span class="spt-arrow">→</span><span class="spt-tick">#${closeTick}</span></span>`
      : openTick != null ? `<span class="spt-range"><span class="spt-tick">#${openTick}</span></span>`
      : closeTick != null ? `<span class="spt-range"><span class="spt-tick">#${closeTick}</span></span>` : '';
    const badges = statusEvents.map(ev => {
      const tick  = ev.ticket_after ?? ev.ticket_before;
      const label = _BADGE_LABEL[ev.action] || ev.action;
      return `<span class="spt-badge spt-${ev.action.replace(/_/g,'-')}">${label}${tick != null ? ` #${tick}` : ''}</span>`;
    }).join('');
    return `<div class="shift-pack-tick-row${isSoldOut ? ' spt-row-soldout' : ''}">
      <div class="spt-dot" style="background:${dotBg}">${abbr}</div>
      <div class="spt-info">
        <div class="spt-top">${lineTag}<span class="spt-name">${name}</span><span class="spt-packnum">#${packNum}</span>${badges}</div>
        ${tickRange ? `<div class="spt-bottom">${tickRange}</div>` : ''}
      </div>
      <div class="spt-stat">
        <span class="spt-stat-rev" ${rev === 0 ? 'style="color:var(--text-hint)"' : ''}>$${rev.toFixed(2)}</span>
        <span class="spt-stat-sold">${sold} sold</span>
      </div>
    </div>`;
  };

  // Group by station location, sort stations in configured order
  const groups = {};
  for (const row of byPack.values()) {
    const loc = row.loc || 'Unknown';
    if (!groups[loc]) groups[loc] = [];
    groups[loc].push(row);
  }
  const stationOrder = _getStations();
  const locKeys = Object.keys(groups).sort((a, b) => {
    const ai = stationOrder.indexOf(a), bi = stationOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1; if (bi === -1) return -1;
    return ai - bi;
  });

  const allRows = [];
  const stationHtml = locKeys.map(loc => {
    const rows = groups[loc].sort((a, b) => {
      if (a.stationLine == null && b.stationLine == null) return 0;
      if (a.stationLine == null) return -1; if (b.stationLine == null) return 1;
      return a.stationLine - b.stationLine;
    });
    // Skip "Unknown" groups that have no sold tickets — they're locationless noise
    if (loc === 'Unknown' && rows.every(r => r.sold === 0)) return '';
    allRows.push(...rows);
    const multiStation = locKeys.length > 1;
    const header = multiStation
      ? `<div class="shift-station-hdr" style="margin-bottom:5px">${loc}</div>`
      : '';
    const stationBreakdown = _priceBreakdownHtml(rows, false);
    return `<div class="shift-station-group">${header}${stationBreakdown}<div class="shift-station-entries">${rows.map(_rowHtml).join('')}</div>${stationBreakdown}</div>`;
  }).join('');

  const parentLabel = locKeys.filter(l => !(l === 'Unknown' && groups[l].every(r => r.sold === 0))).length > 1 ? 'All Stations' : '';
  const parentBreakdown = _priceBreakdownHtml(allRows, true, parentLabel);
  return parentBreakdown + stationHtml + parentBreakdown;
}

// ── Audit entry card renderer (shared across all shift/history views) ──────
function _sortShiftEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.station_line == null && b.station_line == null) return 0;
    if (a.station_line == null) return -1;
    if (b.station_line == null) return 1;
    return a.station_line - b.station_line;
  });
}

function _renderShiftEntriesGrouped(entries) {
  if (!entries.length) return '';

  // Group by location
  const groups = {};
  for (const en of entries) {
    const loc = en.lottery_packs?.location || 'Unknown';
    if (!groups[loc]) groups[loc] = [];
    groups[loc].push(en);
  }

  // Sort stations in configured order, unknowns last
  const stationOrder = _getStations();
  const locKeys = Object.keys(groups).sort((a, b) => {
    const ai = stationOrder.indexOf(a), bi = stationOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return locKeys.map(loc => {
    const sorted = _sortShiftEntries(groups[loc]);
    const cards  = sorted.map(_renderShiftEntryCard).join('');
    return `<div class="shift-station-group">
      <div class="shift-station-hdr">${loc}</div>
      <div class="shift-station-entries">${cards}</div>
    </div>`;
  }).join('');
}

function _renderShiftEntryCard(en) {
  const pack      = en.lottery_packs || {}, game = pack.lottery_games || {};
  const name      = game.game_name || `Game #${pack.game_number}`;
  const price     = parseFloat(game.price || 0);
  const dotBg     = price > 0 ? (_priceColor(price).bg || 'linear-gradient(135deg,#a8a29e,#78716c)') : 'linear-gradient(135deg,#a8a29e,#78716c)';
  const abbr      = String(pack.game_number || '').slice(-2).padStart(2, '0');
  const rev       = parseFloat(en.revenue || 0);
  const sold      = en.tickets_sold || 0;
  const isSuspect = sold === 0 && en.ticket_at_open != null;
  const isSoldOut = pack.status === 'soldout';
  const tickRange = (en.ticket_at_open != null && en.ticket_at_close != null)
    ? `<span class="aec-range">#${en.ticket_at_open}<span class="aec-arrow">→</span>#${en.ticket_at_close}</span>` : '';
  const loc = pack.location || '';
  const lineBadge = _isStation(loc)
    ? (en.station_line != null
        ? `<span class="line-num-badge${isSoldOut ? ' lnb-soldout' : ''}">${en.station_line}</span>`
        : `<span class="line-num-empty"></span>`)
    : '';
  const soldOutBadge = isSoldOut ? `<span class="aec-soldout-badge">Sold Out</span>` : '';
  return `<div class="audit-entry-card${isSuspect ? ' aec-flag' : ''}${isSoldOut ? ' aec-soldout' : ''}">
    <div class="aec-dot" style="background:${dotBg}">${abbr}</div>
    <div class="aec-body">
      <div class="aec-top">
        ${lineBadge}<span class="aec-name">${name}</span>
        <span class="aec-book">#${pack.pack_number || '?'}</span>
        ${soldOutBadge}
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

function _toggleTodayBanner() {
  const el = document.getElementById('shift-today-banner');
  if (el) el.classList.toggle('today-collapsed');
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
      `lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,station_line,` +
        `lottery_packs(pack_number,game_number,location,station_line,status,lottery_games(game_name,price)))` +
      evSel;
    const r = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${dayId}&select=${shiftSel}&order=opened_at.asc`
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

    const todayChevron = `<svg class="today-banner-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    html += `
      <div class="shift-today-banner today-collapsed" id="shift-today-banner">
        <div class="today-banner-hdr" onclick="_toggleTodayBanner()">
          <div>
            <div class="today-banner-title">Today · Day Open since ${dayOpenTime}</div>
            <div class="today-banner-sub">${closedShifts.length} shift${closedShifts.length !== 1 ? 's' : ''} closed · ${liveTix} tickets · $${liveRev.toFixed(2)}</div>
          </div>
          ${todayChevron}
        </div>
        <div class="today-live-content">
          <div class="today-live-grid">
            <div class="today-live-col">${activePacksHtml}</div>
            ${openShift ? `<div class="today-live-col">${shiftActivityHtml}</div>` : ''}
          </div>
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
  // Only the last closed day starts expanded (full detail preloaded).
  // Today (open day) and all older days start collapsed; full detail fetched on expand.
  displayDays.forEach((day, idx) => {
    const groupId      = `day-group-${day.id}`;
    const isLastClosed = !day.status || day.status === 'closed' ? day === lastDay : false;
    const collapsed    = isLastClosed ? '' : ' collapsed';
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
      const entriesHtml = _renderShiftEntriesGrouped(s.lottery_shift_entries || []);
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
      const entriesHtml = _renderShiftEntriesGrouped(s.lottery_shift_entries || []);
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

