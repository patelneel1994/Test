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
  if (!isAdmin()) return;
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
      sbFetch(`${base}lottery_shifts?select=total_revenue,total_tickets_sold${shiftFilter}`),
      sbFetch(`${base}lottery_packs?select=${packSel}&status=in.(activated,soldout,removed)`),
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

