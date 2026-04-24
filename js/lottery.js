// ===== LOTTERY RECEIVING =====

let _lotterySession      = [];   // packs received this session
let _currentLotteryParse = null; // last parsed barcode (used by add-game form)
let _lotteryEventsReady  = false;

// ---- Barcode parser ----
// Strips non-digits, splits by TN Lottery format:
//   12 digits → XXX-XXXXXX-XXX  (game 3, pack 6, pos 3)
//   13 digits → XXXX-XXXXXX-XXX (game 4, pack 6, pos 3)
function parseLotteryBarcode(raw) {
  const clean = raw.replace(/[^0-9]/g, '');
  if (clean.length === 12) {
    return {
      raw, clean,
      gameNumber:     clean.slice(0, 3),
      packNumber:     clean.slice(3, 9),
      ticketPosition: parseInt(clean.slice(9), 10),
      formatted:      `${clean.slice(0,3)}-${clean.slice(3,9)}-${clean.slice(9)}`
    };
  }
  if (clean.length === 13) {
    return {
      raw, clean,
      gameNumber:     clean.slice(0, 4),
      packNumber:     clean.slice(4, 10),
      ticketPosition: parseInt(clean.slice(10), 10),
      formatted:      `${clean.slice(0,4)}-${clean.slice(4,10)}-${clean.slice(10)}`
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
    renderLotteryResult({ type: 'error', msg: `Cannot parse "${raw}" — expected 12 or 13 digits (got ${raw.replace(/[^0-9]/g,'').length}).` });
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
          game_number:      parsed.gameNumber,
          pack_number:      parsed.packNumber,
          raw_barcode:      parsed.raw,
          start_ticket:     0,
          end_ticket:       game.tickets_per_pack - 1,
          status:           'received',
        })
      }
    );

    _lotterySession.unshift({
      gameNumber:     parsed.gameNumber,
      packNumber:     parsed.packNumber,
      gameName:       game.game_name,
      price:          game.price,
      ticketsPerPack: game.tickets_per_pack,
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
    el.innerHTML = `
      <div class="lottery-card lottery-success" style="margin-top:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div class="success-icon">
            <svg viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="2 7 6 11 12 3"/></svg>
          </div>
          <div class="lottery-card-title" style="color:var(--green-text)">Pack received!</div>
        </div>
        <div class="lottery-card-sub">${g.game_name}</div>
        <div class="lottery-card-meta">
          <div><span class="sub-lbl">Pack</span> #${p.packNumber}</div>
          <div><span class="sub-lbl">Tickets</span> ${g.tickets_per_pack} (sells 0 → ${g.tickets_per_pack - 1})</div>
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
          <div class="log-item-meta">Pack #${e.packNumber} · ${e.ticketsPerPack} tickets (0–${e.ticketsPerPack - 1})</div>
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

// ---- Tab init ----
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
  refocusLottery();
}
