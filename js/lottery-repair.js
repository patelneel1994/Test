// ===== LOTTERY REPAIR UTILITIES =====
// Run from the browser console while admin is unlocked.
//
//   repairGameEntries(1858)          — recalculate one game
//   repairGameEntries([1858, 2045])  — recalculate multiple games at once

async function repairGameEntries(gameNumberOrArray) {
  if (!isAdmin()) { showError('Access denied', 'This repair is restricted to admins.'); return; }

  const gameNumbers = Array.isArray(gameNumberOrArray)
    ? gameNumberOrArray.map(String)
    : [String(gameNumberOrArray)];

  if (!gameNumbers.length) { showError('Repair failed', 'No game number(s) provided.'); return; }

  const label = gameNumbers.map(n => `#${n}`).join(', ');
  if (!confirm(`Recalculate all shift entries for game ${label} and update shift/day revenue totals?\n\nThis cannot be undone.`)) return;

  try {
    // 1. Fetch correct price for every requested game
    const gamesRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games` +
      `?game_number=in.(${gameNumbers.join(',')})&select=game_number,game_name,price`
    );
    const games = await gamesRes.json();
    if (!Array.isArray(games) || !games.length) {
      showError('Repair failed', `None of the game numbers (${label}) were found in the catalog.`); return;
    }

    const priceByGame = {};
    const missingPrice = [];
    for (const g of games) {
      const p = parseFloat(g.price || 0);
      if (p <= 0) { missingPrice.push(g.game_number); continue; }
      priceByGame[String(g.game_number)] = p;
    }
    if (missingPrice.length) {
      showError('Repair failed', `Game(s) ${missingPrice.map(n => '#' + n).join(', ')} have no valid price in the catalog.`); return;
    }

    const foundNumbers = Object.keys(priceByGame);

    // 2. All packs for these games (for loading_direction)
    const packsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs` +
      `?game_number=in.(${foundNumbers.join(',')})&select=id,game_number,loading_direction`
    );
    const packs = await packsRes.json();
    if (!Array.isArray(packs) || !packs.length) {
      showError('Repair failed', `No packs found for game ${label}.`); return;
    }

    const packDirById  = {};
    const packGameById = {};
    for (const p of packs) {
      packDirById[p.id]  = (p.loading_direction || 'asc').toLowerCase();
      packGameById[p.id] = String(p.game_number);
    }
    const packIds = packs.map(p => p.id);

    // 3. All shift entries for those packs (embed shift for day_id)
    const entriesRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries` +
      `?pack_id=in.(${packIds.join(',')})` +
      `&select=id,shift_id,pack_id,ticket_at_open,ticket_at_close,tickets_sold,revenue,lottery_shifts(day_id)`
    );
    const entries = await entriesRes.json();
    if (!Array.isArray(entries) || !entries.length) {
      alert(`No shift entries found for game ${label} — nothing to repair.`); return;
    }

    // 4. Update each entry where values differ
    let changedCount = 0;
    const affectedShiftIds = new Set();
    const shiftDayMap      = {};

    for (const en of entries) {
      const gameNum    = packGameById[en.pack_id];
      const price      = priceByGame[gameNum] ?? 0;
      const dir        = packDirById[en.pack_id] || 'asc';
      const open       = en.ticket_at_open  != null ? parseInt(en.ticket_at_open,  10) : 0;
      const close      = en.ticket_at_close != null ? parseInt(en.ticket_at_close, 10) : 0;
      const newSold    = dir === 'desc' ? Math.max(0, open - close) : Math.max(0, close - open);
      const newRevenue = newSold * price;
      const oldSold    = parseInt(en.tickets_sold || 0, 10);
      const oldRev     = parseFloat(en.revenue    || 0);

      if (newSold !== oldSold || Math.abs(newRevenue - oldRev) > 0.001) {
        await sbFetch(
          `${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries?id=eq.${en.id}`,
          { method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ tickets_sold: newSold, revenue: newRevenue }) }
        );
        changedCount++;
      }

      affectedShiftIds.add(en.shift_id);
      if (en.lottery_shifts?.day_id) shiftDayMap[en.shift_id] = en.lottery_shifts.day_id;
    }

    // 5. Rebuild totals for each affected shift (sum ALL entries, not just repaired ones)
    for (const shiftId of affectedShiftIds) {
      const shiftEntriesRes = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries?shift_id=eq.${shiftId}&select=tickets_sold,revenue`
      );
      const shiftEntries = await shiftEntriesRes.json();
      let totalSold = 0, totalRev = 0;
      for (const e of (Array.isArray(shiftEntries) ? shiftEntries : [])) {
        totalSold += parseInt(e.tickets_sold || 0, 10);
        totalRev  += parseFloat(e.revenue    || 0);
      }
      await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?id=eq.${shiftId}`,
        { method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ total_tickets_sold: totalSold, total_revenue: totalRev }) }
      );
    }

    // 6. Rebuild totals for each affected day (sum of all closed shifts)
    const affectedDayIds = new Set(Object.values(shiftDayMap));
    for (const dayId of affectedDayIds) {
      const dayShiftsRes = await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=eq.${dayId}&status=eq.closed&select=total_tickets_sold,total_revenue`
      );
      const dayShifts = await dayShiftsRes.json();
      const { tickets, revenue } = (Array.isArray(dayShifts) ? dayShifts : []).reduce(
        (acc, s) => ({
          tickets: acc.tickets + (s.total_tickets_sold || 0),
          revenue: acc.revenue + parseFloat(s.total_revenue || 0)
        }),
        { tickets: 0, revenue: 0 }
      );
      await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_days?id=eq.${dayId}`,
        { method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ total_tickets_sold: tickets, total_revenue: revenue }) }
      );
    }

    const priceLines = foundNumbers.map(n => `  Game #${n}: $${priceByGame[n].toFixed(2)}`).join('\n');
    alert(
      `Repair complete!\n\n` +
      `Prices used:\n${priceLines}\n\n` +
      `Entries updated:       ${changedCount} of ${entries.length}\n` +
      `Shifts recalculated:   ${affectedShiftIds.size}\n` +
      `Days recalculated:     ${affectedDayIds.size}`
    );
  } catch (err) {
    showError('Repair error', err?.message || String(err));
  }
}

// ===== DELETE ZERO-REVENUE DAYS =====
// Finds closed lottery_days with total_revenue = 0 (and no shift revenue),
// shows a preview, and deletes them along with their shifts and shift entries.
//
//   deleteZeroRevenueDays()               — all zero-revenue closed days
//   deleteZeroRevenueDays('2026-06-01')   — only that date
//
async function deleteZeroRevenueDays(date) {
  if (!isAdmin()) { showError('Access denied', 'This repair is restricted to admins.'); return; }

  try {
    // 1. Fetch closed days with zero revenue, optionally filtered to one date
    let url = `${CONFIG.supabaseUrl}/rest/v1/lottery_days` +
      `?status=eq.closed&total_revenue=eq.0&select=id,opened_at,closed_at,total_tickets_sold,total_revenue&order=opened_at.asc`;
    if (date) {
      // Match any day whose opened_at falls within the given date (local midnight → next midnight UTC range)
      const start = new Date(date + 'T00:00:00').toISOString();
      const end   = new Date(date + 'T23:59:59').toISOString();
      url += `&opened_at=gte.${start}&opened_at=lte.${end}`;
    }
    const daysRes = await sbFetch(url);
    let days = await daysRes.json();
    if (!Array.isArray(days) || !days.length) {
      alert('No closed zero-revenue days found.'); return;
    }

    // 2. Cross-check: confirm their shifts also sum to zero (guard against stale day totals)
    const dayIds = days.map(d => d.id);
    const shiftsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
      `?day_id=in.(${dayIds.join(',')})&select=id,day_id,total_revenue`
    );
    const shifts = await shiftsRes.json();
    const shiftRevByDay = {};
    for (const s of (Array.isArray(shifts) ? shifts : [])) {
      shiftRevByDay[s.day_id] = (shiftRevByDay[s.day_id] || 0) + parseFloat(s.total_revenue || 0);
    }
    // Keep only days where shift revenue also rounds to zero
    days = days.filter(d => (shiftRevByDay[d.id] || 0) < 0.01);
    if (!days.length) {
      alert('No zero-revenue days confirmed (shift totals had revenue — skipping all).'); return;
    }

    const fmt = d =>
      `  ${new Date(d.opened_at).toLocaleString()} → ${d.closed_at ? new Date(d.closed_at).toLocaleString() : 'open'}  (id ${d.id})`;
    if (!confirm(
      `Delete ${days.length} zero-revenue day${days.length !== 1 ? 's' : ''} and all their shifts/entries?\n\n` +
      days.map(fmt).join('\n') +
      `\n\nThis cannot be undone.`
    )) return;

    // 3. Delete shift entries for those shifts
    const shiftIds = (Array.isArray(shifts) ? shifts : [])
      .filter(s => days.some(d => d.id === s.day_id))
      .map(s => s.id);
    if (shiftIds.length) {
      await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries?shift_id=in.(${shiftIds.join(',')})`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
      );
    }

    // 4. Delete the shifts
    const deleteDayIds = days.map(d => d.id);
    if (shiftIds.length) {
      await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?day_id=in.(${deleteDayIds.join(',')})`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
      );
    }

    // 5. Delete the days
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_days?id=in.(${deleteDayIds.join(',')})`,
      { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
    );

    alert(`Done! Deleted ${days.length} zero-revenue day${days.length !== 1 ? 's' : ''} and ${shiftIds.length} associated shift${shiftIds.length !== 1 ? 's' : ''}.`);
  } catch (err) {
    showError('Repair error', err?.message || String(err));
  }
}
