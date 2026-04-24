// ===== LOTTERY RECEIVING =====

let _lotterySession      = [];   // packs received this session
let _currentLotteryParse = null; // last parsed barcode (used by add-game form)
let _lotteryEventsReady  = false;
let _stockViewMode       = 'game'; // 'game' | 'location'
let _cachedStockRows     = null;   // cached for view toggle without refetch
let _shiftCloseEntries   = [];     // activated packs loaded for shift close modal

// ---- Barcode parser ----
// TN Lottery format: XXXX-XXXXXX-XXX (13 digits) or XXX-XXXXXX-XXX (12 digits).
// Scanners print ITF-14 which appends a 1-digit check, so scanned codes are
// 14 digits (13-digit ticket) or 13 digits (12-digit ticket).
// The check digit satisfies: (weighted_sum + check) ≡ 2 (mod 10).
function parseLotteryBarcode(raw) {
  const clean = raw.replace(/[^0-9]/g, '');

  if (clean.length === 14) {
    // 13-digit ticket XXXX-XXXXXX-XXX + 1 check digit (discarded)
    return {
      raw, clean,
      gameNumber:     clean.slice(0, 4),
      packNumber:     clean.slice(4, 10),
      ticketPosition: parseInt(clean.slice(10, 13), 10),
      formatted:      `${clean.slice(0,4)}-${clean.slice(4,10)}-${clean.slice(10,13)}`
    };
  }
  if (clean.length === 13) {
    // Either: 13-digit ticket without check, OR 12-digit ticket + check.
    // Treat as 13-digit ticket (game 4 digits) — adjust if 12-digit games appear.
    return {
      raw, clean,
      gameNumber:     clean.slice(0, 4),
      packNumber:     clean.slice(4, 10),
      ticketPosition: parseInt(clean.slice(10), 10),
      formatted:      `${clean.slice(0,4)}-${clean.slice(4,10)}-${clean.slice(10)}`
    };
  }
  if (clean.length === 12) {
    // 12-digit ticket XXX-XXXXXX-XXX without check
    return {
      raw, clean,
      gameNumber:     clean.slice(0, 3),
      packNumber:     clean.slice(3, 9),
      ticketPosition: parseInt(clean.slice(9), 10),
      formatted:      `${clean.slice(0,3)}-${clean.slice(3,9)}-${clean.slice(9)}`
    };
  }
  return null;
}

// ---- Input handler ----
function submitLotteryInput() {
  const v = document.getElementById('lottery-input').value.trim();
  if (v) lookupLotteryTicket(v);
}

async function lookupLotteryTicket(raw) {
  const inp = document.getElementById('lottery-input');
  inp.value = '';

  const parsed = parseLotteryBarcode(raw);
  if (!parsed) {
    renderLotteryResult({ type: 'error', msg: `Cannot parse "${raw}" — expected 12–14 digits (got ${raw.replace(/[^0-9]/g,'').length}).` });
    refocusLottery();
    return;
  }

  _currentLotteryParse = parsed;
  renderLotteryResult({ type: 'loading' });

  try {
    const game = await fetchLotteryGame(parsed.gameNumber);
    if (!game) {
      // Show add-game form; receipt happens after user submits it
      renderLotteryResult({ type: 'no-game', parsed });
      return;
    }
    const pack = await fetchLotteryPack(parsed.gameNumber, parsed.packNumber);
    if (pack) {
      renderLotteryResult({ type: 'pack-exists', parsed, game, pack });
      beepDuplicate();
    } else {
      // Auto-receive immediately
      await doReceivePack(parsed, game);
    }
  } catch (e) {
    renderLotteryResult({ type: 'error', msg: e.message });
  }
  refocusLottery();
}

// ---- DB helpers ----
async function fetchLotteryGame(gameNumber) {
  const res = await sbFetch(
    `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(gameNumber)}&limit=1`
  );
  const d = await res.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function fetchLotteryPack(gameNumber, packNumber) {
  const res = await sbFetch(
    `${CONFIG.supabaseUrl}/rest/v1/lottery_packs` +
    `?game_number=eq.${encodeURIComponent(gameNumber)}` +
    `&pack_number=eq.${encodeURIComponent(packNumber)}&limit=1`
  );
  const d = await res.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

// ---- Core receive ----
async function doReceivePack(parsed, game) {
  renderLotteryResult({ type: 'loading' });
  try {
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          game_number:       parsed.gameNumber,
          pack_number:       parsed.packNumber,
          raw_barcode:       parsed.raw,
          start_ticket:      parsed.ticketPosition,
          end_ticket:        game.tickets_per_pack - 1,
          last_shift_ticket: parsed.ticketPosition,
          status:            'received',
          location:          'Office',
        })
      }
    );

    _lotterySession.unshift({
      gameNumber:     parsed.gameNumber,
      packNumber:     parsed.packNumber,
      gameName:       game.game_name,
      price:          game.price,
      ticketsPerPack: game.tickets_per_pack,
      startTicket:    parsed.ticketPosition,
      formatted:      parsed.formatted,
      receivedAt:     new Date(),
    });

    renderLotteryResult({ type: 'success', parsed, game });
    renderLotteryLog();
    renderLotteryStats();
    loadLotteryDbStats();
    beepSuccess();
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (e) {
    renderLotteryResult({ type: 'error', msg: e.message });
  }
}

// ---- Add new game then auto-receive ----
async function submitAddGame(e) {
  if (e) e.preventDefault();
  const name  = (document.getElementById('lg-name').value || '').trim();
  const price = parseFloat(document.getElementById('lg-price').value);
  const tpp   = parseInt(document.getElementById('lg-tpp').value, 10);

  if (!name)                      { showError('Missing field', 'Please enter a game name.'); return; }
  if (isNaN(price) || price <= 0) { showError('Missing field', 'Please enter a valid price.'); return; }
  if (isNaN(tpp)   || tpp   <= 0) { showError('Missing field', 'Please enter tickets per pack.'); return; }

  const parsed = _currentLotteryParse;
  if (!parsed) return;

  renderLotteryResult({ type: 'loading' });
  try {
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          game_number:      parsed.gameNumber,
          game_name:        name,
          price:            price,
          tickets_per_pack: tpp,
          active:           true,
        })
      }
    );
    await doReceivePack(parsed, { game_name: name, price, tickets_per_pack: tpp });
  } catch (e) {
    renderLotteryResult({ type: 'error', msg: e.message });
  }
  refocusLottery();
}

// ---- Render result cards ----
function renderLotteryResult(state) {
  const el = document.getElementById('lottery-result');

  if (state.type === 'loading') {
    el.innerHTML = '<div class="summary-loading" style="padding:16px 0">Looking up…</div>';
    return;
  }

  if (state.type === 'error') {
    el.innerHTML = `
      <div class="item-not-found-card" style="margin-top:12px">
        <div class="item-nf-title">Error</div>
        <div class="item-nf-sub">${state.msg}</div>
      </div>`;
    return;
  }

  if (state.type === 'no-game') {
    const p = state.parsed;
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Game #${p.gameNumber} not in catalog</div>
        <div class="lottery-card-sub">Add this game to receive the pack</div>
        <div class="lottery-card-meta" style="margin-bottom:2px">
          <div><span class="sub-lbl">Pack</span> #${p.packNumber}</div>
          <div style="font-family:monospace">${p.formatted}</div>
        </div>
        <div class="lottery-form">
          <label class="lottery-form-label">Game name</label>
          <input class="modal-input lottery-form-input" id="lg-name" placeholder="e.g. Cashword $1" />
          <div style="display:flex;gap:8px">
            <div style="flex:1">
              <label class="lottery-form-label">Ticket price ($)</label>
              <input class="modal-input lottery-form-input" id="lg-price" type="number" min="0" step="0.01" placeholder="1.00" />
            </div>
            <div style="flex:1">
              <label class="lottery-form-label">Tickets / pack</label>
              <input class="modal-input lottery-form-input" id="lg-tpp" type="number" min="1" placeholder="300" />
            </div>
          </div>
          <button class="modal-add-btn" style="margin-bottom:0"
            onmousedown="submitAddGame(event)" ontouchstart="submitAddGame(event)">
            Add Game &amp; Receive Pack
          </button>
        </div>
      </div>`;
    return;
  }

  if (state.type === 'pack-exists') {
    const p  = state.parsed;
    const g  = state.game;
    const pk = state.pack;
    const recvDate = new Date(pk.received_at).toLocaleDateString();
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Pack already in system</div>
        <div class="lottery-card-sub">${g.game_name}</div>
        <div class="lottery-card-meta">
          <div><span class="sub-lbl">Pack</span> #${p.packNumber}</div>
          <div><span class="sub-lbl">Game</span> #${p.gameNumber}</div>
          <div><span class="sub-lbl">Received</span> ${recvDate}</div>
          <div><span class="sub-lbl">Status</span> ${pk.status}</div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);font-family:monospace;margin-top:6px">${p.formatted}</div>
      </div>`;
    return;
  }

  if (state.type === 'success') {
    const p = state.parsed;
    const g = state.game;
    const remaining = g.tickets_per_pack - p.ticketPosition;
    const isPartial  = p.ticketPosition > 0;
    el.innerHTML = `
      <div class="lottery-card lottery-success" style="margin-top:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div class="success-icon">
            <svg viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="2 7 6 11 12 3"/></svg>
          </div>
          <div class="lottery-card-title" style="color:var(--green-text)">${isPartial ? 'Partial book received!' : 'Book received!'}</div>
        </div>
        <div class="lottery-card-sub">${g.game_name}</div>
        <div class="lottery-card-meta">
          <div><span class="sub-lbl">Book</span> #${p.packNumber}</div>
          <div><span class="sub-lbl">Starts at</span> Ticket #${p.ticketPosition}</div>
          <div><span class="sub-lbl">Remaining</span> ${remaining} ticket${remaining !== 1 ? 's' : ''}</div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);font-family:monospace;margin-top:6px">${p.formatted}</div>
      </div>`;
    return;
  }
}

// ---- Session log ----
function renderLotteryLog() {
  const el = document.getElementById('lottery-log-container');
  if (!_lotterySession.length) {
    el.innerHTML = '<div class="log-empty">No packs received this session</div>';
    return;
  }
  el.innerHTML = `<div class="log-list">${
    _lotterySession.map(e => `
      <div class="log-item">
        <div>
          <div class="log-item-name">${e.gameName}</div>
          <div class="log-item-meta">Book #${e.packNumber} · ${e.ticketsPerPack - e.startTicket} tickets (#${e.startTicket}–${e.ticketsPerPack - 1})${e.startTicket > 0 ? ' · partial' : ''}</div>
          <div class="log-item-time">${e.receivedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <div class="log-right">
          <span class="item-badge lottery-price-badge">$${parseFloat(e.price).toFixed(2)}</span>
        </div>
      </div>
    `).join('')
  }</div>`;
}

// ---- Stats ----
function renderLotteryStats() {
  document.getElementById('lottery-stat-session').textContent  = _lotterySession.length;
  const tickets = _lotterySession.reduce((s, e) => s + e.ticketsPerPack, 0);
  document.getElementById('lottery-stat-tickets').textContent  = tickets;
}

async function loadLotteryDbStats() {
  try {
    const [pr, gr] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id&limit=1`,
        { headers: { 'Prefer': 'count=exact' } }),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games?select=game_number&active=eq.true&limit=1`,
        { headers: { 'Prefer': 'count=exact' } }),
    ]);
    document.getElementById('lottery-stat-db-packs').textContent =
      (pr.headers.get('content-range') || '').split('/')[1] || '0';
    document.getElementById('lottery-stat-games').textContent =
      (gr.headers.get('content-range') || '').split('/')[1] || '0';
  } catch (_) {}
}

function refocusLottery() {
  setTimeout(() => {
    const inp = document.getElementById('lottery-input');
    if (inp) inp.focus();
  }, 50);
}

// ---- Status + location config ----
const PACK_STATUS = {
  received:  { label: 'Received',  css: 'status-received'  },
  activated: { label: 'Activated', css: 'status-activated' },
  soldout:   { label: 'Sold Out',  css: 'status-soldout'   },
  removed:   { label: 'Removed',   css: 'status-removed'   },
};
const PACK_LOC_CSS = {
  'Office':        'loc-office',
  'Station Booth': 'loc-station',
  'Front - Extra': 'loc-front',
};

// ---- Remove activated book at a specific ticket number ----
async function removePackAtTicket(id, currentTicket, e) {
  if (e) e.preventDefault();
  const val = window.prompt('Remove at ticket #:', String(currentTicket));
  if (val === null) return; // cancelled
  const ticketNum = parseInt(val, 10);
  if (isNaN(ticketNum) || ticketNum < 0) { showError('Invalid input', 'Enter a valid ticket number.'); return; }
  try {
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'removed', start_ticket: ticketNum })
      }
    );
    await loadLotteryStock();
    loadLotteryDbStats();
  } catch (err) {
    showError('Remove failed', err.message);
  }
}

// ---- Status / location update ----
async function updatePackStatus(id, status, location, e) {
  if (e) e.preventDefault();
  const update = { status };
  if (location != null) update.location = location;
  try {
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(update)
      }
    );
    await loadLotteryStock();
    loadLotteryDbStats();
  } catch (err) {
    showError('Status update failed', err.message);
  }
}

// ---- Single pack row (by-game view: shows location pill) ----
function renderPackRow(p, ticketsPerPack) {
  const st     = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const locCss = PACK_LOC_CSS[p.location] || 'loc-office';
  const isActivated = p.status === 'activated';
  const pct = (isActivated && ticketsPerPack > 0)
    ? Math.round((p.start_ticket / ticketsPerPack) * 100) : 0;

  let actionHtml = '';
  if (p.status === 'received') {
    actionHtml = `
      <button class="pack-act-btn act-station"
        onmousedown="updatePackStatus('${p.id}','activated','Station Booth',event)"
        ontouchstart="updatePackStatus('${p.id}','activated','Station Booth',event)">Station</button>
      <button class="pack-act-btn act-front"
        onmousedown="updatePackStatus('${p.id}','activated','Front - Extra',event)"
        ontouchstart="updatePackStatus('${p.id}','activated','Front - Extra',event)">Front</button>`;
  } else if (p.status === 'activated') {
    actionHtml = `
      <button class="pack-act-btn act-soldout"
        onmousedown="updatePackStatus('${p.id}','soldout',null,event)"
        ontouchstart="updatePackStatus('${p.id}','soldout',null,event)">Sold Out</button>`;
  }

  const removeBtn = p.status === 'activated' ? `
    <button class="pack-remove-btn"
      onmousedown="removePackAtTicket('${p.id}',${p.start_ticket},event)"
      ontouchstart="removePackAtTicket('${p.id}',${p.start_ticket},event)" title="Remove">✕</button>`
  : p.status === 'received' ? `
    <button class="pack-remove-btn"
      onmousedown="updatePackStatus('${p.id}','removed',null,event)"
      ontouchstart="updatePackStatus('${p.id}','removed',null,event)" title="Remove">✕</button>` : '';

  return `
    <div class="lottery-stock-book">
      <div class="lottery-book-info">
        <span class="lottery-book-label">#${p.pack_number}</span>
        <span class="pack-status-pill ${st.css}">${st.label}</span>
        ${p.location ? `<span class="pack-loc-pill ${locCss}">${p.location}</span>` : ''}
        ${isActivated ? `<span class="lottery-book-at">Ticket #${p.start_ticket}</span>` : ''}
      </div>
      ${isActivated && ticketsPerPack > 0 ? `
        <div class="lottery-book-bar-wrap">
          <div class="lottery-book-bar" style="width:${pct}%"></div>
        </div>` : ''}
      <div class="lottery-book-actions">
        ${actionHtml}
        ${removeBtn}
      </div>
    </div>`;
}

// ---- Single pack row (by-location view: shows game name instead of location) ----
function renderPackRowByLoc(p) {
  const game    = p.lottery_games || {};
  const gameName    = game.game_name || `Game #${p.game_number}`;
  const price       = parseFloat(game.price || 0);
  const ticketsPerPack = game.tickets_per_pack || 0;
  const st      = PACK_STATUS[p.status] || { label: p.status, css: '' };
  const isActivated = p.status === 'activated';
  const pct = (isActivated && ticketsPerPack > 0)
    ? Math.round((p.start_ticket / ticketsPerPack) * 100) : 0;

  let actionHtml = '';
  if (p.status === 'received') {
    actionHtml = `
      <button class="pack-act-btn act-station"
        onmousedown="updatePackStatus('${p.id}','activated','Station Booth',event)"
        ontouchstart="updatePackStatus('${p.id}','activated','Station Booth',event)">Station</button>
      <button class="pack-act-btn act-front"
        onmousedown="updatePackStatus('${p.id}','activated','Front - Extra',event)"
        ontouchstart="updatePackStatus('${p.id}','activated','Front - Extra',event)">Front</button>`;
  } else if (p.status === 'activated') {
    actionHtml = `
      <button class="pack-act-btn act-soldout"
        onmousedown="updatePackStatus('${p.id}','soldout',null,event)"
        ontouchstart="updatePackStatus('${p.id}','soldout',null,event)">Sold Out</button>`;
  }

  const removeBtn = p.status === 'activated' ? `
    <button class="pack-remove-btn"
      onmousedown="removePackAtTicket('${p.id}',${p.start_ticket},event)"
      ontouchstart="removePackAtTicket('${p.id}',${p.start_ticket},event)" title="Remove">✕</button>`
  : p.status === 'received' ? `
    <button class="pack-remove-btn"
      onmousedown="updatePackStatus('${p.id}','removed',null,event)"
      ontouchstart="updatePackStatus('${p.id}','removed',null,event)" title="Remove">✕</button>` : '';

  return `
    <div class="lottery-stock-book">
      <div class="lottery-book-info">
        <span class="lottery-book-label">#${p.pack_number}</span>
        <span class="item-badge lottery-price-badge" style="font-size:10px">$${price.toFixed(2)}</span>
        <span class="pack-status-pill ${st.css}">${st.label}</span>
        ${isActivated ? `<span class="lottery-book-at">Ticket #${p.start_ticket}</span>` : ''}
        <span style="font-size:11px;color:var(--text-muted)">${gameName}</span>
      </div>
      ${isActivated && ticketsPerPack > 0 ? `
        <div class="lottery-book-bar-wrap">
          <div class="lottery-book-bar" style="width:${pct}%"></div>
        </div>` : ''}
      <div class="lottery-book-actions">
        ${actionHtml}
        ${removeBtn}
      </div>
    </div>`;
}

// ---- Stock view toggle ----
function setStockView(mode) {
  _stockViewMode = mode;
  document.getElementById('stock-view-game').classList.toggle('active', mode === 'game');
  document.getElementById('stock-view-loc').classList.toggle('active', mode === 'location');
  if (_cachedStockRows) renderLotteryStock(_cachedStockRows);
}

// ---- Stock overview ----
async function loadLotteryStock() {
  const el = document.getElementById('lottery-stock-container');
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs` +
      `?select=id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,status,location,lottery_games(game_name,price,tickets_per_pack)` +
      `&status=in.(received,activated,soldout)` +
      `&order=game_number.asc,status.asc,pack_number.asc` +
      `&limit=500`
    );
    const rows = await res.json();
    _cachedStockRows = rows;
    renderLotteryStock(rows);
  } catch (e) {
    el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

function renderLotteryStock(rows) {
  if (_stockViewMode === 'location') {
    renderLotteryStockByLocation(rows);
  } else {
    renderLotteryStockByGame(rows);
  }
}

function renderLotteryStockByGame(rows) {
  const el = document.getElementById('lottery-stock-container');

  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No packs in stock</div>';
    return;
  }

  // Group by game
  const games = {};
  for (const row of rows) {
    const gn = row.game_number;
    if (!games[gn]) {
      games[gn] = {
        gameName:       row.lottery_games?.game_name        || `Game #${gn}`,
        price:          row.lottery_games?.price            || 0,
        ticketsPerPack: row.lottery_games?.tickets_per_pack || 0,
        packs: [],
      };
    }
    games[gn].packs.push(row);
  }

  const sorted      = Object.values(games).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  const totInStock  = sorted.reduce((s, g) => s + g.packs.filter(p => p.status !== 'soldout').length, 0);
  const totActivated = sorted.reduce((s, g) => s + g.packs.filter(p => p.status === 'activated').length, 0);

  el.innerHTML = `
    <div class="lottery-stock-table">
      ${sorted.map(g => {
        const activated  = g.packs.filter(p => p.status === 'activated');
        const received   = g.packs.filter(p => p.status === 'received');
        const soldOut    = g.packs.filter(p => p.status === 'soldout').length;
        const actionable = [...activated, ...received];
        const inStock    = activated.length + received.length;

        return `
          <div class="lottery-stock-game">
            <div class="lottery-stock-row">
              <div class="lottery-stock-name">
                ${g.gameName}
                <span class="item-badge lottery-price-badge">$${parseFloat(g.price).toFixed(2)}</span>
              </div>
              <div class="lottery-stock-packs">${inStock} book${inStock !== 1 ? 's' : ''}</div>
              <div class="lottery-stock-open-pill ${activated.length > 0 ? 'is-open' : ''}">
                ${activated.length} activated
              </div>
            </div>
            <div class="lottery-stock-books">
              ${actionable.map(p => renderPackRow(p, g.ticketsPerPack)).join('')}
              ${soldOut > 0 ? `<div class="lottery-soldout-note">${soldOut} sold out</div>` : ''}
            </div>
          </div>`;
      }).join('')}
      <div class="lottery-stock-total">
        <span>${totInStock} book${totInStock !== 1 ? 's' : ''} in stock</span>
        <span>${totActivated} activated</span>
      </div>
    </div>`;
}

function renderLotteryStockByLocation(rows) {
  const el = document.getElementById('lottery-stock-container');

  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No packs in stock</div>';
    return;
  }

  const locOrder = ['Station Booth', 'Front - Extra', 'Office'];
  const byLoc = {};
  for (const row of rows) {
    const loc = row.location || 'Office';
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(row);
  }

  const totInStock   = rows.filter(r => r.status !== 'soldout').length;
  const totActivated = rows.filter(r => r.status === 'activated').length;

  let sections = '';
  for (const loc of locOrder) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;
    const activated = packs.filter(p => p.status === 'activated').length;
    const inStock   = packs.filter(p => p.status !== 'soldout').length;
    const soldOut   = packs.filter(p => p.status === 'soldout').length;
    const locCss    = PACK_LOC_CSS[loc] || 'loc-office';

    sections += `
      <div class="lottery-stock-game">
        <div class="lottery-stock-row">
          <div class="lottery-stock-name">
            <span class="pack-loc-pill ${locCss}">${loc}</span>
          </div>
          <div class="lottery-stock-packs">${inStock} book${inStock !== 1 ? 's' : ''}</div>
          <div class="lottery-stock-open-pill ${activated > 0 ? 'is-open' : ''}">
            ${activated} activated
          </div>
        </div>
        <div class="lottery-stock-books">
          ${packs.filter(p => p.status !== 'soldout').map(p => renderPackRowByLoc(p)).join('')}
          ${soldOut > 0 ? `<div class="lottery-soldout-note">${soldOut} sold out</div>` : ''}
        </div>
      </div>`;
  }

  el.innerHTML = `
    <div class="lottery-stock-table">
      ${sections}
      <div class="lottery-stock-total">
        <span>${totInStock} book${totInStock !== 1 ? 's' : ''} in stock</span>
        <span>${totActivated} activated</span>
      </div>
    </div>`;
}

// ===== SHIFT CLOSE =====

async function openShiftClose() {
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_packs` +
      `?select=id,game_number,pack_number,start_ticket,end_ticket,last_shift_ticket,location,lottery_games(game_name,price,tickets_per_pack)` +
      `&status=eq.activated` +
      `&order=location.asc,pack_number.asc` +
      `&limit=200`
    );
    const rows = await res.json();
    _shiftCloseEntries = rows;
    renderShiftCloseModal(rows);
    document.getElementById('shift-modal').classList.add('open');
  } catch (e) {
    showError('Load failed', e.message);
  }
}

function closeShiftModal() {
  document.getElementById('shift-modal').classList.remove('open');
}

function renderShiftCloseModal(rows) {
  const bodyEl = document.getElementById('shift-modal-body');

  if (!rows.length) {
    bodyEl.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No active books to close</div>';
    return;
  }

  const locOrder = ['Station Booth', 'Front - Extra', 'Office'];
  const byLoc = {};
  for (const r of rows) {
    const loc = r.location || 'Office';
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push(r);
  }

  let html = '';
  for (const loc of locOrder) {
    const packs = byLoc[loc];
    if (!packs || !packs.length) continue;

    html += `<div class="shift-loc-section"><div class="shift-loc-header">${loc}</div>`;
    for (const p of packs) {
      const game      = p.lottery_games || {};
      const price     = parseFloat(game.price || 0);
      const tpp       = game.tickets_per_pack || 0;
      const lastTicket = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const priceEsc  = price.toFixed(2);

      html += `
        <div class="shift-entry-row" data-id="${p.id}">
          <div class="shift-entry-name">
            ${game.game_name || `Game #${p.game_number}`}
            <span class="item-badge lottery-price-badge" style="font-size:10px">$${priceEsc}</span>
            <span style="font-size:11px;font-weight:400;color:var(--text-muted)">#${p.pack_number}</span>
          </div>
          <div class="shift-entry-inputs">
            <span class="shift-entry-open-lbl">Opened at #${lastTicket}</span>
            <span class="shift-entry-arrow">→</span>
            <label class="shift-entry-open-lbl">
              Now at #<input type="number" class="shift-ticket-input" id="shift-ticket-${p.id}"
                value="${p.start_ticket}" min="0" max="${tpp}"
                oninput="updateShiftCalc('${p.id}',${price},${lastTicket})" />
            </label>
          </div>
          <div id="shift-calc-${p.id}" class="shift-entry-calc"></div>
        </div>`;
    }
    html += '</div>';
  }

  html += `
    <div class="shift-total-row">
      <span>Total: <strong id="shift-total-tickets">0</strong> tickets sold</span>
      <span class="shift-total-rev" id="shift-total-revenue">$0.00</span>
    </div>`;

  bodyEl.innerHTML = html;

  // Initialize all calc displays
  for (const p of rows) {
    const price      = parseFloat(p.lottery_games?.price || 0);
    const lastTicket = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    updateShiftCalc(p.id, price, lastTicket);
  }
}

function updateShiftCalc(id, price, lastTicket) {
  const inp    = document.getElementById(`shift-ticket-${id}`);
  const calcEl = document.getElementById(`shift-calc-${id}`);
  if (!inp || !calcEl) return;
  const current = parseInt(inp.value, 10) || 0;
  const sold    = Math.max(0, current - lastTicket);
  const rev     = sold * price;
  calcEl.textContent = sold > 0 ? `${sold} tickets · $${rev.toFixed(2)}` : '—';
  recalcShiftTotals();
}

function recalcShiftTotals() {
  let totalSold = 0;
  let totalRev  = 0;
  for (const p of _shiftCloseEntries) {
    const inp    = document.getElementById(`shift-ticket-${p.id}`);
    if (!inp) continue;
    const current    = parseInt(inp.value, 10) || 0;
    const lastTicket = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
    const price      = parseFloat(p.lottery_games?.price || 0);
    const sold       = Math.max(0, current - lastTicket);
    totalSold += sold;
    totalRev  += sold * price;
  }
  const tEl = document.getElementById('shift-total-tickets');
  const rEl = document.getElementById('shift-total-revenue');
  if (tEl) tEl.textContent = totalSold;
  if (rEl) rEl.textContent = `$${totalRev.toFixed(2)}`;
}

async function confirmShiftClose(shiftType, e) {
  if (e) e.preventDefault();
  const confirmBtn = document.getElementById('shift-confirm-btn');
  const dayBtn     = document.getElementById('shift-day-btn');
  if (confirmBtn) confirmBtn.disabled = true;
  if (dayBtn)     dayBtn.disabled     = true;

  try {
    // Collect current ticket inputs
    const entries = [];
    let totalTicketsSold = 0;
    let totalRevenue     = 0;

    for (const p of _shiftCloseEntries) {
      const inp          = document.getElementById(`shift-ticket-${p.id}`);
      const currentTick  = inp ? (parseInt(inp.value, 10) || p.start_ticket) : p.start_ticket;
      const lastTicket   = p.last_shift_ticket != null ? p.last_shift_ticket : p.start_ticket;
      const price        = parseFloat(p.lottery_games?.price || 0);
      const sold         = Math.max(0, currentTick - lastTicket);
      const revenue      = sold * price;
      totalTicketsSold  += sold;
      totalRevenue      += revenue;
      entries.push({
        pack_id:        p.id,
        tickets_sold:   sold,
        revenue,
        ticket_at_open: lastTicket,
        ticket_at_close: currentTick,
      });
    }

    // Insert shift record
    const shiftRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ shift_type: shiftType, total_tickets_sold: totalTicketsSold, total_revenue: totalRevenue })
      }
    );
    const shifts  = await shiftRes.json();
    const shiftId = Array.isArray(shifts) && shifts[0] ? shifts[0].id : null;

    if (shiftId && entries.length) {
      await sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_shift_entries`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(entries.map(en => ({ ...en, shift_id: shiftId })))
        }
      );
    }

    // Update start_ticket and last_shift_ticket for each pack
    await Promise.all(_shiftCloseEntries.map(p => {
      const inp         = document.getElementById(`shift-ticket-${p.id}`);
      const currentTick = inp ? (parseInt(inp.value, 10) || p.start_ticket) : p.start_ticket;
      return sbFetch(
        `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?id=eq.${encodeURIComponent(p.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ start_ticket: currentTick, last_shift_ticket: currentTick })
        }
      );
    }));

    closeShiftModal();
    await Promise.all([loadLotteryStock(), loadShiftHistory()]);
    loadLotteryDbStats();
  } catch (err) {
    showError('Close failed', err.message);
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
    if (dayBtn)     dayBtn.disabled     = false;
  }
}

// ===== SHIFT HISTORY =====

async function loadShiftHistory() {
  const el = document.getElementById('shift-history-container');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_shifts` +
      `?select=id,shift_type,closed_at,total_tickets_sold,total_revenue,lottery_shift_entries(pack_id,tickets_sold,revenue,ticket_at_open,ticket_at_close,lottery_packs(pack_number,game_number,location,lottery_games(game_name,price)))` +
      `&order=closed_at.desc` +
      `&limit=20`
    );
    const shifts = await res.json();
    renderShiftHistory(shifts);
  } catch (e) {
    el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

function renderShiftHistory(shifts) {
  const el = document.getElementById('shift-history-container');
  if (!el) return;

  if (!Array.isArray(shifts) || !shifts.length) {
    el.innerHTML = '<div class="log-empty" style="padding:12px 0;border:none">No shift history yet</div>';
    return;
  }

  el.innerHTML = shifts.map(s => {
    const typeLabel = s.shift_type === 'day' ? 'Day Close' : 'Shift Close';
    const typeCss   = s.shift_type === 'day' ? 'shift-type-day' : 'shift-type-shift';
    const dt        = new Date(s.closed_at);
    const dateStr   = dt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr   = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const entries   = s.lottery_shift_entries || [];

    const entriesHtml = entries.map(en => {
      const pack = en.lottery_packs || {};
      const game = pack.lottery_games || {};
      const name = game.game_name || `Game #${pack.game_number}`;
      return `<div class="shift-history-entry">
        <span class="shift-history-entry-game">${name} #${pack.pack_number}</span>
        <span class="shift-history-entry-detail">#${en.ticket_at_open}→#${en.ticket_at_close} · ${en.tickets_sold} sold · $${parseFloat(en.revenue).toFixed(2)}</span>
      </div>`;
    }).join('');

    return `
      <div class="shift-history-item">
        <div class="shift-history-hdr">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="shift-history-type ${typeCss}">${typeLabel}</span>
            <span class="shift-history-date">${dateStr} · ${timeStr}</span>
          </div>
          <span class="shift-history-rev">$${parseFloat(s.total_revenue).toFixed(2)}</span>
        </div>
        <div class="shift-history-sub">${s.total_tickets_sold} tickets sold</div>
        ${entriesHtml ? `<div class="shift-history-entries">${entriesHtml}</div>` : ''}
      </div>`;
  }).join('');
}

// ===== TAB INIT =====

async function initLotteryTab() {
  if (!_lotteryEventsReady) {
    _lotteryEventsReady = true;
    const inp = document.getElementById('lottery-input');
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitLotteryInput(); }
    });
    inp.addEventListener('paste', () => {
      setTimeout(() => { const v = inp.value.trim(); if (v) lookupLotteryTicket(v); }, 50);
    });
  }
  renderLotteryLog();
  renderLotteryStats();
  loadLotteryDbStats();
  loadLotteryStock();
  loadShiftHistory();
  refocusLottery();
}
