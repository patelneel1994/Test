// ===== LOTTERY CATALOG (game definitions) =====

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig; }, 1500); }
  }).catch(() => { if (btn) btn.textContent = 'Failed'; });
}

function _renderBarcodeBreakdown(raw, knownGameNumber) {
  if (!raw) return '<div class="bc-none">No barcode on file</div>';
  const clean = raw.replace(/[^0-9]/g, '');
  let segments;

  if (clean.length === 14) {
    segments = [
      { val: clean.slice(0, 4),  label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(4, 10), label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(10,13), label: 'Ticket #', cls: 'bc-ticket' },
      { val: clean.slice(13),    label: 'Check',    cls: 'bc-check'  },
    ];
  } else if (clean.length === 13) {
    segments = [
      { val: clean.slice(0, 4),  label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(4, 10), label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(10),    label: 'Ticket #', cls: 'bc-ticket' },
    ];
  } else if (clean.length === 12) {
    segments = [
      { val: clean.slice(0, 3),  label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(3, 9),  label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(9),     label: 'Ticket #', cls: 'bc-ticket' },
    ];
  } else if (clean.length > 14) {
    // Long barcode — determine game digit count from the known game number,
    // falling back to 3-digit (legacy) if unknown.
    const gd  = knownGameNumber && String(knownGameNumber).replace(/\D/g,'').length === 4 ? 4 : 3;
    const pe  = gd + 6;   // pack end
    const te  = pe + 3;   // ticket end
    segments = [
      { val: clean.slice(0, gd), label: 'Game #',   cls: 'bc-game'   },
      { val: clean.slice(gd, pe),label: 'Pack #',   cls: 'bc-pack'   },
      { val: clean.slice(pe, te),label: 'Ticket #', cls: 'bc-ticket' },
      { val: clean.slice(te),    label: 'Scanner suffix', cls: 'bc-check' },
    ];
  } else {
    return `<div class="bc-raw">${raw}</div><div class="bc-none">Unrecognized format (${clean.length} digits)</div>`;
  }

  const fullDisplay = segments.map(s => `<span class="bc-seg ${s.cls}">${s.val}</span>`).join('<span class="bc-sep">-</span>');
  const legend = segments.map(s =>
    `<div class="bc-legend-item"><span class="bc-legend-dot ${s.cls}"></span><span class="bc-legend-label">${s.label}</span><span class="bc-legend-val">${s.val}</span></div>`
  ).join('');
  return `
    <div class="bc-full-row">
      <div class="bc-full">${fullDisplay}</div>
      <button class="bc-copy-btn" onclick="copyToClipboard('${clean}',this)" title="Copy barcode">Copy</button>
    </div>
    <div class="bc-legend">${legend}</div>`;
}

// Shows barcode structure for a game with only the game # filled in; pack/ticket marked as variable.
// Used in catalog where a sample barcode would imply a specific pack number.
function _renderGameNumberTemplate(gameNumber) {
  const gn  = String(gameNumber).replace(/\D/g, '');
  const segments = [
    { val: gn,      label: 'Game #',   cls: 'bc-game',   dim: false },
    { val: '######', label: 'Pack #',  cls: 'bc-pack',   dim: true  },
    { val: '###',    label: 'Ticket #', cls: 'bc-ticket', dim: true  },
  ];
  const fullDisplay = segments.map(s =>
    `<span class="bc-seg ${s.cls}"${s.dim ? ' style="opacity:0.28"' : ''}>${s.val}</span>`
  ).join('<span class="bc-sep">-</span>');
  const legend = segments.map(s =>
    `<div class="bc-legend-item"${s.dim ? ' style="opacity:0.4"' : ''}>` +
    `<span class="bc-legend-dot ${s.cls}"></span>` +
    `<span class="bc-legend-label">${s.label}</span>` +
    `<span class="bc-legend-val">${s.dim ? 'varies' : s.val}</span></div>`
  ).join('');
  return `<div class="bc-full-row"><div class="bc-full">${fullDisplay}</div></div><div class="bc-legend">${legend}</div>`;
}

const _catalogGameCache = {};
let _catalogSortBy = 'game';   // 'game' | 'price-asc' | 'price-desc'
let _catalogSearch = '';
let _catalogCache  = null;
let _stockSortBy   = 'price-asc'; // 'game' | 'price-asc' | 'price-desc'

function toggleInactiveGames() {
  _showInactiveGames = !_showInactiveGames;
  const btn = document.getElementById('catalog-inactive-btn');
  if (btn) btn.classList.toggle('active', _showInactiveGames);
  loadLotteryCatalog();
}

function setCatalogSort(sort) {
  _catalogSortBy = sort;
  document.querySelectorAll('.cat-sort-pill').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === sort)
  );
  _renderLotteryCatalog();
}

function setCatalogSearch(q) {
  _catalogSearch = q;
  _renderLotteryCatalog();
}

function setStockSort(sort) {
  _stockSortBy = sort;
  document.querySelectorAll('.stock-sort-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === sort)
  );
  if (_cachedStockRows) renderLotteryStock(_cachedStockRows);
}

async function loadLotteryCatalog() {
  const el = document.getElementById('lottery-catalog-container');
  if (!el) return;
  el.innerHTML = '<div class="summary-loading">Loading…</div>';
  await checkDbCapabilities();
  const activeFilter = _showInactiveGames ? '' : '&or=(active.eq.true,active.is.null)';
  try {
    const [gRes, pRes, eRes] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_games?select=game_number,game_name,price,tickets_per_pack,active&order=game_number.asc${activeFilter}`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=game_number,pack_number,status,raw_barcode&order=game_number.asc,id.asc`),
      _dbCaps.hasPackEvents
        ? sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?select=action,created_at,ticket_before,ticket_after,location_to,shift_id,lottery_shifts(opened_at),lottery_packs(game_number,pack_number)&order=created_at.asc`)
        : Promise.resolve(null),
    ]);
    const games  = await gRes.json();
    const packs  = await pRes.json();
    const evtRaw = eRes ? await eRes.json() : null;
    if (!gRes.ok) throw new Error(games?.message || `[${gRes.status}]`);

    if (!Array.isArray(games) || !games.length) {
      el.innerHTML = '<div class="log-empty">No games in catalog yet.</div>';
      return;
    }

    const packCounts    = {};
    const packLists     = {};
    const sampleBarcode = {};
    const packBarcodes  = {};
    for (const p of (Array.isArray(packs) ? packs : [])) {
      const gn = p.game_number;
      if (!packCounts[gn]) {
        packCounts[gn] = { activated: 0, received: 0, soldout: 0, removed: 0, total: 0 };
        packLists[gn]  = { activated: [], received: [], soldout: [], removed: [] };
      }
      packCounts[gn].total++;
      if (packCounts[gn][p.status] !== undefined) {
        packCounts[gn][p.status]++;
        packLists[gn][p.status].push(p.pack_number);
      }
      if (!sampleBarcode[gn] && p.raw_barcode) sampleBarcode[gn] = p.raw_barcode;
      if (p.raw_barcode) {
        if (!packBarcodes[gn]) packBarcodes[gn] = {};
        packBarcodes[gn][p.pack_number] = p.raw_barcode;
      }
    }

    const packHistory = {};
    const _EVT_LABELS = {
      received: 'Received', activated: 'Loaded', soldout: 'Sold Out',
      removed: 'Removed', moved: 'Moved', adjusted: 'Adjusted', discrepancy: 'Discrepancy',
      restored: 'Restored', returned_to_lottery: 'Returned to Lottery',
    };
    for (const ev of (Array.isArray(evtRaw) ? evtRaw : [])) {
      const gn = ev.lottery_packs?.game_number;
      const pn = ev.lottery_packs?.pack_number;
      if (!gn || pn == null) continue;
      if (!packHistory[gn]) packHistory[gn] = {};
      if (!packHistory[gn][pn]) packHistory[gn][pn] = [];
      const isPartialLoad = ev.action === 'activated' && ev.ticket_after > 0;
      const shiftTime = ev.lottery_shifts?.opened_at
        ? new Date(ev.lottery_shifts.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;
      packHistory[gn][pn].push({
        action:      ev.action,
        label:       isPartialLoad ? 'Partial Load' : (_EVT_LABELS[ev.action] || ev.action),
        cls:         `ph-evt-${ev.action}`,
        date:        ev.created_at,
        ticketAfter: ev.ticket_after ?? null,
        shiftTime,
      });
    }

    _catalogCache = { games, packCounts, packLists, packBarcodes, packHistory, sampleBarcode };
    _renderLotteryCatalog();
  } catch (e) {
    el.innerHTML = `<div class="item-nf-sub" style="padding:10px 0">Load failed: ${e.message}</div>`;
  }
}

function _renderLotteryCatalog() {
  const el = document.getElementById('lottery-catalog-container');
  if (!el || !_catalogCache) return;
  const { games, packCounts, packLists, packBarcodes, packHistory } = _catalogCache;

  // Filter
  const q = _catalogSearch.trim().toLowerCase();
  let visible = games;
  if (q) {
    visible = games.filter(g => {
      if (String(g.game_number).includes(q)) return true;
      if ((g.game_name || '').toLowerCase().includes(q)) return true;
      const allPacks = [
        ...(packLists[g.game_number]?.activated || []),
        ...(packLists[g.game_number]?.received  || []),
        ...(packLists[g.game_number]?.soldout   || []),
        ...(packLists[g.game_number]?.removed   || []),
      ];
      return allPacks.some(pn => String(pn).includes(q));
    });
  }

  // Sort
  if (_catalogSortBy === 'price-asc')  visible = [...visible].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  if (_catalogSortBy === 'price-desc') visible = [...visible].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));

  if (!visible.length) {
    el.innerHTML = q
      ? `<div class="log-empty">No games match "${_catalogSearch}"</div>`
      : '<div class="log-empty">No games in catalog yet.</div>';
    return;
  }

  for (const g of visible) _catalogGameCache[g.game_number] = g;

  // Price count summary — unique game types + total active/received books per price
  const catPriceCounts = {};
  for (const g of visible) {
    const price = parseFloat(g.price || 0);
    if (!price) continue;
    const cnt = packCounts[g.game_number] || {};
    if (!catPriceCounts[price]) catPriceCounts[price] = { games: 0, books: 0 };
    catPriceCounts[price].games++;
    catPriceCounts[price].books += (cnt.activated || 0) + (cnt.received || 0);
  }
  let html = _priceSummaryHtml(catPriceCounts) + '<div class="catalog-grid">';
  for (const g of visible) {
    const price    = parseFloat(g.price || 0);
    const tpp      = parseInt(g.tickets_per_pack || 0, 10);
    const bookCost = price * tpp;
    const cnts     = packCounts[g.game_number] || {};
    const active   = cnts.activated || 0;
    const received = cnts.received  || 0;
    const soldout  = cnts.soldout   || 0;
    const total    = cnts.total     || 0;
    const gn       = g.game_number;
    const color    = _gameColor(gn);
    const emoji    = _gameEmoji(gn);

    const stockHTML = (() => {
      const pills = [
        active   ? `<span class="cat-cnt-pill cp-active"><span class="cat-cnt-dot"></span>${active} active</span>`     : '',
        received ? `<span class="cat-cnt-pill cp-received"><span class="cat-cnt-dot"></span>${received} received</span>` : '',
        soldout  ? `<span class="cat-cnt-pill cp-soldout"><span class="cat-cnt-dot"></span>${soldout} sold out</span>`   : '',
      ].filter(Boolean).join('');
      return `<div class="cat-stock">${pills || '<span class="cat-stock-empty">No books recorded</span>'}</div>`;
    })();

    const canEdit = total === 0;
    const editBtns = canEdit
      ? `<button class="catalog-edit-btn" onclick="openEditGame('${gn}')">Edit</button>
         ${g.active
           ? `<button class="catalog-del-btn" onclick="softDeleteGame('${gn}')">Deactivate</button>`
           : `<button class="catalog-edit-btn" onclick="reactivateGame('${gn}')">Reactivate</button>`}`
      : `<button class="catalog-edit-btn" onclick="openEditGame('${gn}')">Edit</button>
         <span class="cat-in-use">${total} book${total !== 1 ? 's' : ''} recorded</span>
         ${!g.active ? `<button class="catalog-edit-btn" onclick="reactivateGame('${gn}')">Reactivate</button>` : ''}`;

    const historyHTML = (() => {
      const gameEvts     = packHistory[g.game_number];
      const gameBarcodes = packBarcodes[gn] || {};
      if (!gameEvts || !Object.keys(gameEvts).length) return { panel: '', hasHistory: false };
      const packCount = Object.keys(gameEvts).length;
      const rows = Object.entries(gameEvts).map(([pn, evts]) => {
        const steps = evts.map((e, i) => {
          const d = new Date(e.date);
          const dateFmt = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const timeFmt = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const ticketStr = e.ticketAfter != null ? `<span class="ph-ticket-tag">#${e.ticketAfter}</span>` : '';
          const shiftStr  = e.shiftTime ? `<span class="ph-shift-tag">Shift ${e.shiftTime}</span>` : '';
          return `${i > 0 ? '<span class="ph-arrow">→</span>' : ''}<span class="ph-step"><span class="ph-evt ${e.cls}">${e.label}${ticketStr}</span>${shiftStr}<span class="ph-date">${dateFmt} ${timeFmt}</span></span>`;
        }).join('');
        const bc = gameBarcodes[pn];
        const bcRow = bc
          ? `<div class="ph-barcode-row"><span class="ph-barcode-val">${bc}</span><button class="ph-copy-btn" onclick="_copyBarcode(this,'${bc}')">Copy</button></div>`
          : `<div class="ph-barcode-row"><span class="ph-barcode-none">No barcode on file</span></div>`;
        return `<div class="ph-pack-row"><span class="ph-pack-num">#${pn}</span><div class="ph-timeline">${steps}</div>${bcRow}</div>`;
      }).join('');
      const panel = `
        <div class="cat-hist-panel">
          <div class="cat-hist-panel-hdr">
            <span class="cat-hist-panel-title">Pack history (${packCount})</span>
            <button class="cat-bc-toggle" onclick="_toggleCatBarcode(event,'${gn}')">Show Barcodes</button>
          </div>
          <div class="ph-list">${rows}</div>
        </div>`;
      return { panel, hasHistory: true };
    })();

    html += `
      <div class="cat-card" id="catalog-row-${gn}">
        <div class="cat-card-bar" style="background:${color}"></div>
        <div class="cat-card-hdr">
          <div class="cat-game-dot" style="background:${color}1a">${emoji}</div>
          <div class="cat-game-identity">
            <div class="cat-game-name">${g.game_name || '—'}</div>
            <div class="cat-game-num">#${gn}</div>
          </div>
          ${g.active ? '<span class="pack-status-pill st-activated">Active</span>' : '<span class="pack-status-pill st-removed">Inactive</span>'}
        </div>
        <div class="cat-stats">
          <div class="cat-stat">
            <div class="cat-stat-val">$${price.toFixed(2)}</div>
            <div class="cat-stat-lbl">Per ticket</div>
          </div>
          <div class="cat-stat">
            <div class="cat-stat-val">${tpp > 0 ? tpp.toLocaleString() : '—'}</div>
            <div class="cat-stat-lbl">Per roll</div>
          </div>
          <div class="cat-stat">
            <div class="cat-stat-val">${bookCost > 0 ? '$' + bookCost.toFixed(0) : '—'}</div>
            <div class="cat-stat-lbl">Book cost</div>
          </div>
        </div>
        ${stockHTML}
        <div class="cat-bc">
          <div class="cat-bc-lbl">Barcode format</div>
          ${_renderGameNumberTemplate(gn)}
        </div>
        <div class="cat-footer">
          ${editBtns}
          ${historyHTML.hasHistory ? `<button class="cat-hist-toggle" onclick="_toggleCatHistory('${gn}')">History <i class="cat-hist-chev">▶</i></button>` : ''}
        </div>
        ${historyHTML.panel || ''}
      </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ===== CATALOG EDIT / SOFT DELETE =====

let _editGameNumber = null;


function openEditGame(gameNumber) {
  requireAdmin(() => _doOpenEditGame(gameNumber));
}

function _doOpenEditGame(gameNumber) {
  const g = _catalogGameCache[gameNumber];
  if (!g) return;
  _editGameNumber = g.game_number;
  document.getElementById('edit-game-info').textContent = `Game #${g.game_number}`;
  const editNameEl = document.getElementById('edit-game-name');
  editNameEl.value = g.game_name || '';
  _capWords(editNameEl);
  editNameEl.oninput = () => _capWords(editNameEl);
  document.getElementById('edit-game-price').value = g.price      != null ? g.price : '';
  document.getElementById('edit-game-tpp').value   = g.tickets_per_pack > 0 ? g.tickets_per_pack : '';
  document.getElementById('edit-game-modal').classList.add('open');
  setTimeout(() => editNameEl.focus(), 120);
}

function closeEditGameModal() {
  document.getElementById('edit-game-modal').classList.remove('open');
  _editGameNumber = null;
}

async function confirmEditGame(e) {
  if (e) e.preventDefault();
  if (!_editGameNumber) return;
  const name  = (document.getElementById('edit-game-name').value || '').trim();
  const price = parseFloat(document.getElementById('edit-game-price').value);
  const tpp   = parseInt(document.getElementById('edit-game-tpp').value, 10);
  if (!name)               { showError('Missing field', 'Game name is required.'); return; }
  if (isNaN(price) || price <= 0) { showError('Missing field', 'Enter a valid ticket price.'); return; }
  if (isNaN(tpp)   || tpp <= 0)   { showError('Missing field', 'Enter tickets per roll.'); return; }
  const btn = document.getElementById('edit-game-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(_editGameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ game_name: name, price, tickets_per_pack: tpp }) });
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    closeEditGameModal();
    loadLotteryCatalog();
  } catch (err) {
    showError('Save failed', err.message);
    if (btn) btn.disabled = false;
  }
}

async function softDeleteGame(gameNumber) {
  if (!confirm(`Deactivate game #${gameNumber}? It will be hidden from active games but kept in history.`)) return;
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(gameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ active: false }) }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    loadLotteryCatalog();
  } catch (err) {
    showError('Deactivate failed', err.message);
  }
}

async function reactivateGame(gameNumber) {
  requireAdmin(() => _doReactivateGame(gameNumber));
}

async function _doReactivateGame(gameNumber) {
  try {
    const res = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/lottery_games?game_number=eq.${encodeURIComponent(gameNumber)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ active: true }) }
    );
    if (!res.ok) { const d = await res.json(); throw new Error(d?.message || `[${res.status}]`); }
    loadLotteryCatalog();
  } catch (err) {
    showError('Reactivate failed', err.message);
  }
}

