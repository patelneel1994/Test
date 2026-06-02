// ===== RECEIVE =====

function submitLotteryInput() {
  const v = document.getElementById('lottery-input').value.trim();
  if (v) lookupLotteryTicket(v);
}

async function _resolveAmbiguousBarcode(result) {
  // Try both candidates against DB; prefer 4-digit (new) if both exist, fall back to 3-digit (legacy)
  const games = await Promise.all(result.candidates.map(c => fetchLotteryGame(c.gameNumber).catch(() => null)));
  for (let i = games.length - 1; i >= 0; i--) {
    if (games[i]) return result.candidates[i];
  }
  // Neither game exists — return 3-digit candidate so "no-game" flow can offer to create it
  return result.candidates[0];
}

async function lookupLotteryTicket(raw) {
  const inp = document.getElementById('lottery-input');
  inp.value = '';
  const result = parseLotteryBarcode(raw);
  if (!result) {
    renderLotteryResult({ type: 'error', msg: `Cannot parse "${raw}" — expected 12+ digits.` });
    refocusLottery(); return;
  }
  renderLotteryResult({ type: 'loading' });
  try {
    const parsed = result.ambiguous ? await _resolveAmbiguousBarcode(result) : result;
    _currentLotteryParse = parsed;
    const game = await fetchLotteryGame(parsed.gameNumber);
    if (!game) { renderLotteryResult({ type: 'no-game', parsed }); beepNotFound(); if (navigator.vibrate) navigator.vibrate([80, 40, 80]); return; }
    if (game.active === false) { renderLotteryResult({ type: 'inactive-game', parsed, game }); beepNotFound(); if (navigator.vibrate) navigator.vibrate([80, 40, 80]); return; }
    const pack = await fetchLotteryPack(parsed.gameNumber, parsed.packNumber);
    if (pack) { renderLotteryResult({ type: 'pack-exists', parsed, game, pack }); beepDuplicate(); }
    else       { await doReceivePack(parsed, game); }
  } catch (e) { renderLotteryResult({ type: 'error', msg: e.message }); }
  refocusLottery();
}

async function fetchLotteryGame(gameNumber) {
  const res = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(gameNumber)}&limit=1`);
  const d = await res.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function fetchLotteryPack(gameNumber, packNumber) {
  const res = await sbFetch(
    `${CONFIG.supabaseUrl}/rest/v1/lottery_packs?game_number=eq.${encodeURIComponent(gameNumber)}&pack_number=eq.${encodeURIComponent(packNumber)}&limit=1`
  );
  const d = await res.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

function setReceiveLocation(loc) {
  _receiveLocation = loc;
  document.querySelectorAll('#recv-loc-btns .recv-loc-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.loc === loc);
  });
}

function renderReceiveLocationButtons() {
  const el = document.getElementById('recv-loc-btns');
  if (!el) return;
  const locs = ['Office', 'Extra', ..._getExtraLocs(), ..._getStations()];
  el.innerHTML = locs.map(loc =>
    `<button class="recv-loc-pill-btn${loc === _receiveLocation ? ' active' : ''}"
      data-loc="${loc}" onclick="setReceiveLocation('${loc}')">${loc}</button>`
  ).join('');
}

async function doReceivePack(parsed, game) {
  renderLotteryResult({ type: 'loading' });
  try {
    const newPackRes = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({
          game_number: parsed.gameNumber, pack_number: parsed.packNumber,
          raw_barcode: parsed.raw, start_ticket: 0,
          end_ticket: game.tickets_per_pack - 1, last_shift_ticket: 0,
          status: 'received', location: _receiveLocation,
        }) });
    const newPacks = await newPackRes.json();
    const newPackId = Array.isArray(newPacks) && newPacks[0] ? newPacks[0].id : null;
    _logPackEvent(newPackId, 'received', { location_to: _receiveLocation, ticket_after: 0 });
    _lotterySession.unshift({
      gameNumber: parsed.gameNumber, packNumber: parsed.packNumber,
      gameName: game.game_name, price: game.price, ticketsPerPack: game.tickets_per_pack,
      startTicket: 0, formatted: parsed.formatted, receivedAt: new Date(),
    });
    renderLotteryResult({ type: 'success', parsed, game });
    renderLotteryLog(); renderLotteryStats(); loadLotteryDbStats();
    loadReceiveQueue();
    beepSuccess();
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (e) { renderLotteryResult({ type: 'error', msg: e.message }); }
}

async function reactivateAndReceivePack(e) {
  if (e) e.preventDefault();
  const parsed = _currentLotteryParse;
  if (!parsed) return;
  renderLotteryResult({ type: 'loading' });
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(parsed.gameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ active: true }) }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    const game = await fetchLotteryGame(parsed.gameNumber);
    await doReceivePack(parsed, game);
  } catch (err) { renderLotteryResult({ type: 'error', msg: err.message }); }
  refocusLottery();
}

function _lgAutoTpp(price) {
  const tppEl = document.getElementById('lg-tpp');
  if (!tppEl || tppEl.value) return;
  if (price > 0 && price < 20) tppEl.value = Math.round(300 / price);
}

function _lgSetPrice(val) {
  const priceEl = document.getElementById('lg-price');
  if (priceEl) { priceEl.value = val; }
  document.querySelectorAll('.lg-price-pill').forEach(b =>
    b.classList.toggle('lg-price-pill-active', Number(b.dataset.val) === val)
  );
  _lgAutoTpp(val);
}

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
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ game_number: parsed.gameNumber, game_name: name, price, tickets_per_pack: tpp, active: true }) });
    await doReceivePack(parsed, { game_name: name, price, tickets_per_pack: tpp });
  } catch (e) { renderLotteryResult({ type: 'error', msg: e.message }); }
  refocusLottery();
}

function renderLotteryResult(state) {
  const el = document.getElementById('lottery-result');
  if (state.type === 'loading') { el.innerHTML = '<div class="summary-loading" style="padding:16px 0">Looking up…</div>'; return; }
  if (state.type === 'error')   { el.innerHTML = `<div class="item-not-found-card" style="margin-top:12px"><div class="item-nf-title">Error</div><div class="item-nf-sub">${state.msg}</div></div>`; return; }
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
          <label class="lottery-form-label">Ticket price ($)</label>
          <div class="lg-price-pills">
            ${[1,2,3,5,10,20,25,30,50].map(v =>
              `<button type="button" class="lg-price-pill" data-val="${v}" onclick="_lgSetPrice(${v})">$${v}</button>`
            ).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <div style="flex:1">
              <input class="modal-input lottery-form-input" id="lg-price" type="number" min="0" step="0.01" placeholder="or enter price" />
            </div>
            <div style="flex:1"><label class="lottery-form-label">Tickets / pack</label>
              <input class="modal-input lottery-form-input" id="lg-tpp" type="number" min="1" placeholder="300" /></div>
          </div>
          <button class="modal-add-btn" style="margin-bottom:0"
            onmousedown="submitAddGame(event)" ontouchstart="submitAddGame(event)">Add Game &amp; Receive Pack</button>
        </div>
      </div>`;
    const lgNameEl = document.getElementById('lg-name');
    if (lgNameEl) lgNameEl.addEventListener('input', () => _capWords(lgNameEl));
    const lgPriceEl = document.getElementById('lg-price');
    if (lgPriceEl) lgPriceEl.addEventListener('input', () => _lgAutoTpp(parseFloat(lgPriceEl.value)));
    return;
  }
  if (state.type === 'inactive-game') {
    const { parsed: p, game: g } = state;
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Game #${p.gameNumber} is deactivated</div>
        <div class="lottery-card-sub">${g.game_name} · $${parseFloat(g.price).toFixed(2)} · ${g.tickets_per_pack} tickets/pack</div>
        <div class="lottery-card-meta" style="margin-bottom:2px">
          <div><span class="sub-lbl">Pack</span> #${p.packNumber}</div>
          <div style="font-family:monospace">${p.formatted}</div>
        </div>
        <button class="modal-add-btn" style="margin-bottom:0"
          onmousedown="reactivateAndReceivePack(event)" ontouchstart="reactivateAndReceivePack(event)">Bring Back &amp; Receive Pack</button>
      </div>`;
    return;
  }
  if (state.type === 'pack-exists') {
    const { parsed: p, game: g, pack: pk } = state;
    const tpp = parseInt(g.tickets_per_pack, 10);
    // Populate cache so openActivationForm works from here
    if (pk.id) {
      _packInfoCache[pk.id] = {
        ticketsPerPack:   tpp,
        gameName:         g.game_name || '',
        packNumber:       pk.pack_number,
        startTicket:      pk.start_ticket ?? 0,
        endTicket:        pk.end_ticket   ?? (tpp - 1),
        lastShiftTicket:  pk.last_shift_ticket ?? 0,
        loadingDirection: (pk.loading_direction || 'asc').toLowerCase(),
        location:         pk.location,
      };
    }
    const canLoad = _canMoveOrActivate();
    const statusLine = pk.status === 'received'
      ? (canLoad
          ? `<div class="lottery-card-sub" style="margin-bottom:8px">Ready to load — pick a station:</div>
             <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
               ${_getStations().map(st => `<button class="pack-act-btn act-station"
                 onmousedown="openActivationForm('${pk.id}','${st}',event)"
                 ontouchstart="openActivationForm('${pk.id}','${st}',event)">${st}</button>`).join('')}
             </div>`
          : `<div class="lottery-card-sub">${_currentDay ? 'Open a shift to load' : 'Open a day to load'}</div>`)
      : pk.status === 'activated'
        ? `<div class="lottery-card-sub">Currently active at <strong>${pk.location || '—'}</strong></div>`
        : `<div class="lottery-card-sub">Status: ${pk.status}</div>`;
    el.innerHTML = `
      <div class="lottery-card lottery-warn" style="margin-top:12px">
        <div class="lottery-card-title">Pack already in system</div>
        <div class="lottery-card-sub">${g.game_name} · Book #${p.packNumber}</div>
        <div class="lottery-card-meta" style="margin-bottom:8px">
          <div><span class="sub-lbl">Game</span> #${p.gameNumber}</div>
          <div><span class="sub-lbl">Tickets</span> ${tpp > 0 ? tpp.toLocaleString() : '—'}</div>
        </div>
        ${statusLine}
      </div>`;
    return;
  }
  if (state.type === 'success') {
    const { parsed: p, game: g } = state;
    const tpp = parseInt(g.tickets_per_pack, 10);
    const bcHtml = p.raw ? `<div style="margin-top:10px">${_renderBarcodeBreakdown(p.raw, p.gameNumber)}</div>` : '';
    el.innerHTML = `
      <div class="lottery-card lottery-success" style="margin-top:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div class="success-icon"><svg viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><polyline points="2 7 6 11 12 3"/></svg></div>
          <div class="lottery-card-title" style="color:var(--green-text)">Book received!</div>
        </div>
        <div class="lottery-card-sub">${g.game_name}</div>
        <div class="lottery-card-meta">
          <div><span class="sub-lbl">Book</span> #${p.packNumber}</div>
          <div><span class="sub-lbl">Tickets</span> ${tpp > 0 ? tpp.toLocaleString() : '—'}</div>
        </div>
        ${bcHtml}
      </div>`;
  }
}

function renderLotteryLog() {
  const el = document.getElementById('lottery-log-container');
  if (!_lotterySession.length) { el.innerHTML = '<div class="log-empty">No packs received this session</div>'; return; }
  el.innerHTML = `<div class="log-list">${_lotterySession.map(e => `
    <div class="log-item">
      <div>
        <div class="log-item-name">${e.gameName}</div>
        <div class="log-item-meta">Book #${e.packNumber} · ${e.ticketsPerPack} tickets</div>
        <div class="log-item-time">${e.receivedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      <div class="log-right"><span class="item-badge lottery-price-badge">$${parseFloat(e.price).toFixed(2)}</span></div>
    </div>`).join('')}</div>`;
}

function renderLotteryStats() {
  const s = document.getElementById('lottery-stat-session');
  const t = document.getElementById('lottery-stat-tickets');
  if (s) s.textContent = _lotterySession.length;
  if (t) t.textContent = _lotterySession.reduce((sum, e) => sum + e.ticketsPerPack, 0);
}

async function loadLotteryDbStats() {
  try {
    const cnt = url => sbFetch(`${CONFIG.supabaseUrl}/rest/v1/${url}&limit=1`, { headers: { 'Prefer': 'count=exact' } })
      .then(r => (r.headers.get('content-range') || '').split('/')[1] || '0');
    const adminOk = isAdmin();
    const fetches = [cnt('lottery_packs?select=id&status=eq.activated')];
    if (adminOk) {
      fetches.push(
        cnt('lottery_packs?select=id&status=eq.received'),
        cnt('lottery_packs?select=id&status=eq.soldout'),
        cnt('lottery_packs?select=id'),
        sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=id,location&status=eq.received&order=location.asc`)
          .then(r => r.json()).catch(() => []),
      );
    }
    const [active, received, soldout, total, recPacks] = await Promise.all(fetches);
    document.getElementById('lottery-stat-db-packs').textContent = active;
    const sfA = document.getElementById('sf-active');
    if (sfA) sfA.textContent = active;
    if (adminOk) {
      document.getElementById('lottery-stat-games').textContent = received;
      const soEl = document.getElementById('lottery-stat-soldout');
      const totEl = document.getElementById('lottery-stat-total');
      if (soEl)  soEl.textContent = soldout;
      if (totEl) totEl.textContent = total;
      const sfR = document.getElementById('sf-received');
      const sfS = document.getElementById('sf-soldout');
      if (sfR) sfR.textContent = received;
      if (sfS) sfS.textContent = soldout;
      _renderReceivedStockBar(Array.isArray(recPacks) ? recPacks : []);
    }
  } catch (_) {}
}

function _renderReceivedStockBar(packs) {
  const el = document.getElementById('received-stock-bar');
  if (!el) return;
  if (!packs.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const byLoc = {};
  for (const p of packs) {
    const loc = p.location || 'Unassigned';
    byLoc[loc] = (byLoc[loc] || 0) + 1;
  }
  const locOrder = [..._getLocOrderAll(), 'Unassigned'];
  const pills = locOrder
    .filter(l => byLoc[l])
    .map(l => `<span class="recv-loc-pill">${l}<strong>${byLoc[l]}</strong></span>`)
    .join('');
  // Any locations not in locOrder
  const extra = Object.entries(byLoc)
    .filter(([l]) => !locOrder.includes(l))
    .map(([l, n]) => `<span class="recv-loc-pill">${l}<strong>${n}</strong></span>`)
    .join('');
  el.innerHTML = `<span class="recv-stock-label">In Stock</span>${pills}${extra}`;
  el.style.display = 'flex';
}

function refocusLottery() {
  setTimeout(() => { const inp = document.getElementById('lottery-input'); if (inp) inp.focus(); }, 50);
}

