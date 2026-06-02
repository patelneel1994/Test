// ===== DASHBOARD =====

const _GAME_COLORS  = ['#E13B3B','#1E5DD8','#0E8F5A','#8B5CF6','#F97316','#0F8C8C','#B8002E','#D44A8B'];
const _GAME_EMOJIS  = ['🍀','💎','💵','👑','🎰','🧩','♛','🎯'];
const _ACT_COLORS = {
  received:            '#8A6A00',
  activated:           '#0E8F5A',
  moved:               '#8B5CF6',
  soldout:             '#E13B3B',
  discrepancy:         '#B91C1C',
  adjusted:            '#6B7280',
  removed:             '#B91C1C',
  restored:            '#0E8F5A',
  returned_to_lottery: '#D97706',
  line_cleared:        '#6B7280',
  audit_scan:          '#0F8C8C',
  // Extra book events — indigo
  extra_scan:          '#6366F1',
  extra_bypassed:      '#7C3AED',
  extra_to_station:    '#4F46E5',
  // System events
  day_opened:          '#059669',
  day_closed:          '#1D4ED8',
  shift_closed:        '#2563EB',
  shift_opened:        '#10B981',
  error:               '#DC2626',
};
const _ACT_LABELS = {
  received:            'Received',
  activated:           'Activated',
  moved:               'Moved',
  soldout:             'Sold out',
  discrepancy:         'Discrepancy',
  adjusted:            'Adjusted',
  removed:             'Removed',
  restored:            'Restored',
  returned_to_lottery: 'Returned to Lottery',
  line_cleared:        'Line cleared',
  audit_scan:          'Audit scan',
  extra_scan:          'Extra book scan',
  extra_bypassed:      'Extra bypassed',
  extra_to_station:    'Extra → station',
  day_opened:          'Day opened',
  day_closed:          'Day closed',
  shift_closed:        'Shift closed',
  shift_opened:        'Shift opened',
  error:               'Error',
};

let _activityOffset  = 0;
let _activityHasMore = false;
const ACTIVITY_PAGE  = 10;

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
  _dashAnalyticsLoaded = false;
  document.getElementById('dash-analytics-card')?.classList.add('da-collapsed');

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

    const adminOk = isAdmin();
    const sel = adminOk
      ? (_dbCaps.hasLoadingDirection
          ? 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,loading_direction,location,lottery_games(game_name,price,tickets_per_pack)'
          : 'id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)')
      : 'id,game_number,pack_number,location,lottery_games(game_name)';

    const fetches = [
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=${sel}&status=eq.activated&order=location.asc`),
    ];
    if (adminOk) {
      fetches.push(sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id&status=eq.received&limit=1`, { headers: { 'Prefer': 'count=exact' } }));
      if (snapDay && snapHasShifts) {
        fetches.push(sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${snapDay.id}&select=total_revenue,total_tickets_sold&order=opened_at.asc`));
      }
      if (snapHasEvents) {
        // Discrepancy-only fetch — used for attention panel + flag count
        // Activity feed loaded separately via loadDashActivity()
        fetches.push(sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?select=id,action,pack_id,created_at,notes,lottery_packs(pack_number,game_number,location,lottery_games(game_name))&action=eq.discrepancy&order=created_at.desc`));
      }
    }

    const results = await Promise.all(fetches);
    const packs   = await results[0].json();
    let officeCount = 0, shifts = [], events = [];
    if (adminOk) {
      officeCount = parseInt((results[1].headers.get('content-range') || '').split('/')[1], 10) || 0;
      let ri = 2;
      if (snapDay && snapHasShifts) { shifts = await results[ri++].json(); }
      if (snapHasEvents) { events = await results[ri].json(); }
    }

    const activePacks = Array.isArray(packs) ? packs : [];
    const shiftArr    = Array.isArray(shifts) ? shifts : [];
    const eventArr    = Array.isArray(events) ? events : [];

    const actEl2 = document.getElementById('dash-stat-active');
    if (actEl2) actEl2.textContent = activePacks.length;
    // Update live context bar with real active count
    _updateContextBar(activePacks.length);

    // Group active packs by location (needed for station cards)
    const byLoc = {};
    for (const p of activePacks) {
      if (!byLoc[p.location]) byLoc[p.location] = [];
      byLoc[p.location].push(p);
    }

    if (adminOk) {
      // Revenue
      const todayRev     = shiftArr.reduce((s, sh) => s + (parseFloat(sh.total_revenue) || 0), 0);
      const todayTickets = shiftArr.reduce((s, sh) => s + (parseInt(sh.total_tickets_sold) || 0), 0);
      const revEl  = document.getElementById('dash-stat-revenue');
      const revSub = document.getElementById('dash-stat-rev-sub');
      const offEl  = document.getElementById('dash-stat-office');
      if (revEl)  revEl.textContent  = snapDay ? `$${todayRev.toFixed(2)}` : '$—';
      if (revSub) revSub.textContent = snapDay ? `${todayTickets} tickets sold today` : 'open a day first';
      if (offEl)  offEl.textContent  = officeCount;

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
    }

    const actSubEl = document.getElementById('dash-stat-active-sub');
    if (actSubEl) {
      const stationNames = [...new Set(activePacks.map(p => p.location))].filter(Boolean);
      actSubEl.textContent = stationNames.length ? `across ${stationNames.length} location${stationNames.length > 1 ? 's' : ''}` : 'no active books';
    }

    // Station cards
    _renderDashStations(byLoc, stationsEl);

    // Attention panel (admin only)
    if (adminOk) {
      _renderDashAttention(discEvents, activePacks, attentionEl);
    } else if (attentionEl) {
      attentionEl.innerHTML = '';
    }

    // Activity feed (non-blocking — loads independently with pagination)
    loadDashActivity();

    // Analytics: deferred — loaded when user expands the card

  } catch (err) {
    if (stationsEl) stationsEl.innerHTML = `<div class="item-nf-sub">Load error: ${err.message}</div>`;
    if (attentionEl) attentionEl.innerHTML = '';
    if (activityEl)  activityEl.innerHTML = '';
  }
}

// ===== DASHBOARD ANALYTICS =====

let _dashAnalyticsPreset = 'month';
let _dashAnalyticsInited = false;
let _dashAnalyticsLoaded = false;
let _daWeekDays = {};

const _MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _WDAYS_SHORT  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function _daFmtDate(str) {
  const d = new Date(str);
  return `${_WDAYS_SHORT[d.getDay()]}, ${_MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}
function _daFmtMoney(n) {
  return `$${parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function _renderDaWeekDayRows(wDays, shiftsByDayId) {
  let html = '';
  for (const d of wDays) {
    const closed  = d.status === 'closed';
    const dRev    = parseFloat(d.total_revenue || 0);
    const dTix    = d.total_tickets_sold || 0;
    const dShifts = (d.lottery_shifts || []).filter(sh => sh.status === 'closed');
    const openT   = d.opened_at ? new Date(d.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const closeT  = d.closed_at ? new Date(d.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    let gameRows = '';
    if (shiftsByDayId) {
      const gameTotals = {};
      for (const sh of (shiftsByDayId[d.id] || [])) {
        for (const en of (sh.lottery_shift_entries || [])) {
          const gn    = en.lottery_packs?.game_number || '?';
          const gName = en.lottery_packs?.lottery_games?.game_name || `Game #${gn}`;
          const price = parseFloat(en.lottery_packs?.lottery_games?.price || 0);
          if (!gameTotals[gn]) gameTotals[gn] = { name: gName, price, tickets: 0, revenue: 0 };
          gameTotals[gn].tickets += en.tickets_sold || 0;
          gameTotals[gn].revenue += parseFloat(en.revenue || 0);
        }
      }
      gameRows = Object.values(gameTotals)
        .sort((a, b) => b.revenue - a.revenue)
        .map(g => `<div class="da-game-row">
          <span class="da-game-name">${g.name}</span>
          <span class="da-game-meta">${g.tickets} tickets</span>
          <span class="da-game-rev">${_daFmtMoney(g.revenue)}</span>
        </div>`).join('');
    }
    html += `
      <div class="da-day-row${closed ? '' : ' da-day-open'}">
        <div class="da-day-main">
          <div class="da-day-info">
            <span class="da-day-date">${_daFmtDate(d.opened_at)}</span>
            ${closed ? '' : '<span class="da-open-pill">Open</span>'}
            <span class="da-day-time">${openT}${closeT ? ` – ${closeT}` : ''}</span>
          </div>
          <div class="da-day-stats">
            <span class="da-day-tix">${dTix} tickets · ${dShifts.length} shift${dShifts.length !== 1 ? 's' : ''}</span>
            <span class="da-day-rev">${closed ? _daFmtMoney(dRev) : '—'}</span>
          </div>
        </div>
        ${gameRows ? `<div class="da-game-list">${gameRows}</div>` : ''}
      </div>`;
  }
  return html;
}

function _toggleDashAnalytics() {
  const card = document.getElementById('dash-analytics-card');
  if (!card) return;
  const wasCollapsed = card.classList.toggle('da-collapsed');
  if (!wasCollapsed && !_dashAnalyticsLoaded) {
    _initDashAnalyticsDates();
    loadDashAnalytics();
  }
}

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
  if (!document.getElementById('dash-analytics-card')?.classList.contains('da-collapsed')) loadDashAnalytics();
}

function _onDashAnalyticsDateChange() {
  _dashAnalyticsPreset = 'custom';
  ['month', 'lastmonth', '3months'].forEach(p => {
    const btn = document.getElementById(`dapreset-${p}`);
    if (btn) btn.classList.remove('active');
  });
  if (!document.getElementById('dash-analytics-card')?.classList.contains('da-collapsed')) loadDashAnalytics();
}

async function loadDashAnalytics() {
  if (!isAdmin()) return;
  const container = document.getElementById('dash-analytics-container');
  const summaryEl = document.getElementById('dash-analytics-summary');
  if (!container) return;
  _dashAnalyticsLoaded = true;
  container.innerHTML = '<div class="summary-loading">Loading…</div>';
  if (summaryEl) summaryEl.innerHTML = '';

  const { from, to } = _dashAnalyticsDates();
  if (!from || !to) { container.innerHTML = '<div class="log-empty" style="border:none;padding:8px 0">Select a date range.</div>'; return; }

  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_days` +
      `?select=id,opened_at,closed_at,status,total_revenue,total_tickets_sold,` +
      `lottery_shifts(id,status)` +
      `&opened_at=gte.${from}T00:00:00&opened_at=lte.${to}T23:59:59&order=opened_at.desc`
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

  _daWeekDays = {};
  let html = '';
  weekKeys.forEach((wk, wi) => {
    const wDays   = weeks[wk];
    const wClosed = wDays.filter(d => d.status === 'closed');
    const wRev    = wClosed.reduce((s, d) => s + parseFloat(d.total_revenue || 0), 0);
    const wTix    = wClosed.reduce((s, d) => s + (d.total_tickets_sold || 0), 0);
    const wShifts = wClosed.reduce((s, d) => s + (d.lottery_shifts || []).filter(sh => sh.status === 'closed').length, 0);
    const groupId = `da-week-${wi}`;

    const monDate = new Date(wk);
    const sunDate = new Date(wk); sunDate.setDate(monDate.getDate() + 6);
    const wLabel  = `${_MONTHS_SHORT[monDate.getMonth()]} ${monDate.getDate()} – ${_MONTHS_SHORT[sunDate.getMonth()]} ${sunDate.getDate()}`;

    _daWeekDays[groupId] = wDays;
    const dayIds = wDays.map(d => d.id).join(',');

    html += `
      <div class="da-week-group da-collapsed" id="${groupId}" data-day-ids="${dayIds}" data-loaded="0">
        <div class="da-week-header" onclick="_toggleDaWeek('${groupId}')">
          <div class="da-week-left">
            <span class="da-week-label">Week of ${wLabel}</span>
            <span class="da-week-meta">${wClosed.length} day${wClosed.length !== 1 ? 's' : ''} · ${wShifts} shift${wShifts !== 1 ? 's' : ''} · ${wTix.toLocaleString()} tickets</span>
          </div>
          <div class="da-week-right">
            <span class="da-week-rev">${_daFmtMoney(wRev)}</span>
            ${_chevronSvg}
          </div>
        </div>
        <div class="da-week-body"></div>
      </div>`;
  });

  container.innerHTML = html;
}

async function _toggleDaWeek(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const wasCollapsed = el.classList.contains('da-collapsed');
  el.classList.toggle('da-collapsed');
  if (wasCollapsed && el.dataset.loaded !== '1') {
    const body   = el.querySelector('.da-week-body');
    const dayIds = el.dataset.dayIds;
    if (!dayIds || !body) { el.dataset.loaded = '1'; return; }
    body.innerHTML = '<div class="summary-loading" style="padding:8px 0;font-size:12px">Loading…</div>';
    try {
      const r = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
        `?day_id=in.(${dayIds})&select=day_id,status,lottery_shift_entries(pack_id,tickets_sold,revenue,lottery_packs(game_number,lottery_games(game_name,price)))` +
        `&order=opened_at.asc`
      );
      const shifts = await r.json();
      const shiftsByDayId = {};
      if (Array.isArray(shifts)) {
        for (const sh of shifts) {
          if (!shiftsByDayId[sh.day_id]) shiftsByDayId[sh.day_id] = [];
          shiftsByDayId[sh.day_id].push(sh);
        }
      }
      el.dataset.loaded = '1';
      body.innerHTML = _renderDaWeekDayRows(_daWeekDays[id] || [], shiftsByDayId);
    } catch (_) {
      body.innerHTML = '<div class="item-nf-sub" style="padding:8px 0;font-size:12px">Load failed</div>';
    }
  }
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
  const adminOk = isAdmin();
  const cards = locations.map(loc => {
    const packs = byLoc[loc];
    let stationRev = 0;
    const chips = packs.slice(0, 6).map(p => {
      const gName = p.lottery_games?.game_name || '';
      const color = _gameColor(p.game_number);
      const emoji = _gameEmoji(p.game_number);
      if (adminOk) {
        const price = parseFloat(p.lottery_games?.price || 0);
        const tpp   = parseInt(p.lottery_games?.tickets_per_pack || 0, 10);
        const dir   = p.loading_direction || 'asc';
        const start = p.start_ticket ?? 0;
        if (price && tpp) {
          const sold = dir === 'asc' ? start : Math.max(0, tpp - 1 - start);
          stationRev += sold * price;
        }
        return `<div class="station-book-chip" style="background:${color}" title="${gName} · Book #${p.pack_number} · $${price}">${emoji}</div>`;
      }
      return `<div class="station-book-chip" style="background:${color}" title="${gName} · Book #${p.pack_number}">${emoji}</div>`;
    }).join('');
    const extra = packs.length > 6 ? `<div class="station-chip-more">+${packs.length - 6}</div>` : '';
    const revStr = adminOk && stationRev > 0 ? `$${stationRev.toFixed(0)} today` : '—';
    return `<div class="station-card" onclick="switchLotterySection('tracking')">
      <div class="station-card-accent"></div>
      <div class="station-card-hdr">${locIcon}<span class="station-card-name">${loc}</span></div>
      <div class="station-card-val">${packs.length}<span class="station-card-val-unit">books</span></div>
      <div class="station-card-rev">${revStr}</div>
      <div class="station-card-chips">${chips}${extra}</div>
    </div>`;
  }).join('');
  const maxCols = window.innerWidth < 600 ? 2 : 4;
  const cols = Math.min(locations.length, maxCols);
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
      const whenStr = _fmtAttentionDate(e.created_at);
      return `<div class="att-item">
        <div class="att-dot" style="background:${color};font-size:15px">${emoji}</div>
        <div class="att-info">
          <div class="att-name">${name} <span class="att-bc">${bc}</span></div>
          ${note}
          <div class="att-loc">${p.location || '—'}</div>
          ${whenStr ? `<div class="att-when"><span class="att-when-label">Logged</span><span class="att-when-val">${whenStr}</span></div>` : ''}
        </div>
      </div>`;
    }).join('');
  el.innerHTML = rows;
}

async function loadDashActivity(append = false) {
  if (!_dbCaps.hasPackEvents) return;
  const el = document.getElementById('dashboard-activity');
  if (!el) return;

  if (!append) {
    _activityOffset = 0;
    el.innerHTML = '<div class="summary-loading" style="font-size:13px;padding:8px 0">Loading…</div>';
  } else {
    const btn = el.querySelector('.act-load-more');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  }

  try {
    const sel = 'id,action,pack_id,created_at,ticket_before,ticket_after,notes,location_from,location_to,lottery_packs(pack_number,game_number,location,lottery_games(game_name))';
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?select=${sel}&order=created_at.desc&limit=${ACTIVITY_PAGE + 1}&offset=${_activityOffset}`
    );
    const rows = await res.json();
    if (!Array.isArray(rows)) return;

    const hasMore = rows.length > ACTIVITY_PAGE;
    const page    = rows.slice(0, ACTIVITY_PAGE);
    _activityOffset += page.length;

    _renderDashActivity(page, el, append, hasMore);
  } catch (err) {
    if (!append) {
      el.innerHTML = `<div style="font-size:13px;color:var(--text-hint);padding:8px 0">Could not load activity.</div>`;
    } else {
      const btn = el.querySelector('.act-load-more');
      if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
    }
  }
}

function _renderDashActivity(events, el, append = false, hasMore = false) {
  if (!el) return;

  if (!append && !events.length) {
    el.innerHTML = `<div class="dash-empty-state" style="color:var(--text-hint);font-size:13px">No recent activity recorded.</div>`;
    return;
  }

  const _SYS_EVENTS = new Set(['day_opened','day_closed','shift_closed','shift_opened','error']);

  const rows = events.map(e => {
    const action  = _ACT_LABELS[e.action] || e.action;
    const color   = _ACT_COLORS[e.action] || 'var(--ink-60)';
    const timeStr = e.created_at ? _fmtActivityTime(e.created_at) : '';

    // ── System event (no pack_id): day/shift open/close, errors ──
    if (!e.pack_id || _SYS_EVENTS.has(e.action)) {
      const sysIcon = e.action === 'error' ? '!' : e.action.includes('closed') ? '✓' : '▶';
      return `<div class="act-item act-item-sys">
        <div class="act-icon act-icon-sys" style="background:${color}18;color:${color};font-size:13px;font-weight:800">${sysIcon}</div>
        <div class="act-body">
          <div class="act-line"><strong style="color:${color}">${action}</strong></div>
          ${e.notes ? `<div class="act-notes">${e.notes}</div>` : ''}
        </div>
        <div class="act-time">${timeStr}</div>
      </div>`;
    }

    const p       = e.lottery_packs || {};
    const g       = p.lottery_games || {};
    const name    = g.game_name || `Game ${p.game_number || '?'}`;
    const packNum = p.pack_number ? ` #${p.pack_number}` : '';
    const initial = (name[0] || '?').toUpperCase();

    // ── Ticket / location detail ──
    let detail = '';
    let stationPill = '';

    if (e.action === 'moved' && (e.location_from || e.location_to)) {
      detail = `<span class="act-move">${e.location_from || '?'} → ${e.location_to || '?'}</span>`;
    } else if (e.action === 'audit_scan' || e.action === 'extra_scan') {
      // Show station prominently for scan events
      const station = e.location_to || p.location || '';
      if (station) stationPill = `<span class="act-station-pill">${station}</span>`;
      if (e.ticket_before != null && e.ticket_after != null) {
        detail = `<span class="act-tickets">#${e.ticket_before} → #${e.ticket_after}</span>`;
      } else if (e.ticket_after != null) {
        detail = `<span class="act-tickets">ticket #${e.ticket_after}</span>`;
      }
    } else if (e.ticket_before != null && e.ticket_after != null) {
      detail = `<span class="act-tickets">#${e.ticket_before} → #${e.ticket_after}</span>`;
    } else if (e.ticket_after != null) {
      detail = `<span class="act-tickets">ticket #${e.ticket_after}</span>`;
    }

    // Location pill for non-scan, non-move events
    const locStr  = (!stationPill && e.action !== 'moved') ? (e.location_to || p.location || '') : '';
    const locPill = locStr ? `<span class="act-loc-pill">${locStr}</span>` : '';

    const notesText = e.notes && e.action !== 'moved' ? e.notes.slice(0, 60) : '';
    const notesHtml = notesText ? `<div class="act-notes">${notesText}</div>` : '';

    const subParts = [stationPill, detail, locPill].filter(Boolean).join(' · ');

    return `<div class="act-item">
      <div class="act-icon" style="background:${color}22;color:${color}">${initial}</div>
      <div class="act-body">
        <div class="act-line"><strong style="color:${color}">${action}</strong><span class="act-detail"> · ${name}${packNum}</span></div>
        ${subParts ? `<div class="act-sub">${subParts}</div>` : ''}
        ${notesHtml}
      </div>
      <div class="act-time">${timeStr}</div>
    </div>`;
  }).join('');

  if (append) {
    const existing = el.querySelector('.act-load-more-wrap');
    if (existing) existing.remove();
    el.insertAdjacentHTML('beforeend', rows);
  } else {
    el.innerHTML = rows;
  }

  if (hasMore) {
    el.insertAdjacentHTML('beforeend', `<div class="act-load-more-wrap">
      <button class="act-load-more" onclick="loadDashActivity(true)">Load more</button>
    </div>`);
  }
}

function _fmtAttentionDate(isoStr) {
  if (!isoStr) return '';
  const d       = new Date(isoStr);
  const now     = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString())       return `Today ${timeStr}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${timeStr}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${timeStr}`;
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

// ===== FLOATING JUMP NAV =====

function jumpTo(target) {
  let el = null;
  if (target === 'top') {
    const scroller = document.querySelector('.app-content') || window;
    scroller.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (target === 'shift-history') {
    // Scroll to the shift history card header
    el = document.getElementById('shift-history-container')?.closest('.scan-card');
  }
  if (target === 'last-day') {
    // First day-group rendered = most recent day (history is desc order)
    el = document.querySelector('#shift-history-container .shift-day-group');
    if (!el) {
      // History not loaded yet — load it then jump
      loadShiftHistory().then(() => {
        const g = document.querySelector('#shift-history-container .shift-day-group');
        if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return;
    }
  }
  if (el) {
    const scroller = document.querySelector('.app-content');
    if (scroller) {
      const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
      scroller.scrollTo({ top: offset, behavior: 'smooth' });
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

