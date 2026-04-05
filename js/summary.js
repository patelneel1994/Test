// ===== DB SUMMARY TAB =====
let _summaryMode  = 'grouped'; // 'grouped' | 'location' | 'detail'
let _summaryCache = null;      // cached full data for location/detail modes

function setSummaryMode(mode) {
  _summaryMode = mode;
  ['grouped', 'location', 'detail'].forEach(m => {
    document.getElementById('summary-mode-' + m).classList.toggle('active', m === mode);
  });
  // 'grouped' fetches its own lightweight data; other modes share _summaryCache
  if (mode === 'grouped') {
    loadGroupedSummary();
  } else if (_summaryCache) {
    renderSummary(_summaryCache.rows, _summaryCache.getCost);
  } else {
    loadFullSummary();
  }
}

async function loadSummary() {
  if (_summaryMode === 'grouped') loadGroupedSummary();
  else loadFullSummary();
}

// ── GROUPED MODE ─────────────────────────────────────────────────────────────
// Calls a Postgres RPC function that does the join+aggregate server-side.
// Returns one row per location: { location, total_qty, total_cost }
// Minimal egress — no item names, no timestamps, no raw records.
async function loadGroupedSummary() {
  const sc = document.getElementById('summary-container');
  const st = document.getElementById('summary-totals');
  sc.innerHTML = '<div class="summary-loading">Loading…</div>';
  st.innerHTML = '';

  try {
    const res  = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/get_location_summary`);
    const rows = await res.json();

    if (!rows.length) {
      sc.innerHTML = '<div class="summary-empty">No records in database yet</div>';
      return;
    }

    const totalQty  = rows.reduce((s, r) => s + Number(r.total_qty),  0);
    const totalCost = rows.reduce((s, r) => s + Number(r.total_cost), 0);

    st.innerHTML = `
      <div class="stat"><div class="stat-val">${rows.length}</div><div class="stat-label">Locations</div></div>
      <div class="stat"><div class="stat-val">${totalQty}</div><div class="stat-label">Total qty</div></div>
      <div class="stat"><div class="stat-val" style="font-size:20px;">$${totalCost.toFixed(2)}</div><div class="stat-label">Total cost</div></div>`;

    sc.innerHTML = rows.map(r => `
      <div class="summary-group">
        <div class="summary-group-hdr" style="padding:16px;">
          <div class="summary-group-name" style="font-size:16px;">${r.location}</div>
          <div class="summary-group-stats">
            <span class="summary-group-stat">Qty <b>${r.total_qty}</b></span>
            <span class="summary-group-stat">Cost <b>$${Number(r.total_cost).toFixed(2)}</b></span>
          </div>
        </div>
      </div>`).join('');

  } catch (e) {
    document.getElementById('summary-container').innerHTML = '';
    showError('Failed to load grouped summary', e.message);
  }
}

// ── FULL DATA MODES (By Location + Detail) ───────────────────────────────────
async function loadFullSummary() {
  const sc = document.getElementById('summary-container');
  const st = document.getElementById('summary-totals');
  sc.innerHTML = '<div class="summary-loading">Loading…</div>';
  st.innerHTML = '';
  _summaryCache = null;

  try {
    const countsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.countsTable}` +
      `?select=barcode,name,quantity,location,timestamp&limit=5000&order=timestamp.desc`
    );
    const rows = await countsRes.json();

    if (!rows.length) {
      sc.innerHTML = '<div class="summary-empty">No records in database yet</div>';
      return;
    }

    const uniqueBarcodes = [...new Set(rows.map(r => r.barcode))];
    const orFilter = encodeURIComponent(
      '(' + uniqueBarcodes.map(b => `${CONFIG.barcodeColumn}.eq.${b}`).join(',') + ')'
    );
    const itemsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.itemsTable}` +
      `?select=${CONFIG.barcodeColumn},${CONFIG.costColumn}&or=${orFilter}`
    );
    const itemsList = await itemsRes.json();

    const costMap = {};
    itemsList.forEach(i => { costMap[i[CONFIG.barcodeColumn]] = i[CONFIG.costColumn]; });
    const getCost = barcode => { const c = costMap[barcode]; return c != null ? parseFloat(c) : null; };

    // Overall totals
    const totalQty    = rows.reduce((s, r) => s + r.quantity, 0);
    const totalCost   = rows.reduce((s, r) => { const c = getCost(r.barcode); return s + (c != null ? c * r.quantity : 0); }, 0);
    const uniqueItems = new Set(rows.map(r => r.barcode)).size;
    st.innerHTML = `
      <div class="stat"><div class="stat-val">${rows.length}</div><div class="stat-label">Records</div></div>
      <div class="stat"><div class="stat-val">${uniqueItems}</div><div class="stat-label">Unique items</div></div>
      <div class="stat"><div class="stat-val">${totalQty}</div><div class="stat-label">Total qty</div></div>
      <div class="stat"><div class="stat-val" style="font-size:20px;">$${totalCost.toFixed(2)}</div><div class="stat-label">Total cost</div></div>`;

    _summaryCache = { rows, getCost };
    renderSummary(rows, getCost);

  } catch (e) {
    document.getElementById('summary-container').innerHTML = '';
    showError('Failed to load summary', e.message);
  }
}

function renderSummary(rows, getCost) {
  if (_summaryMode === 'detail') renderDetail(rows, getCost);
  else renderByLocation(rows, getCost);
}

function renderByLocation(rows, getCost) {
  const sc = document.getElementById('summary-container');
  const groups = {};
  rows.forEach(r => {
    if (!groups[r.location]) groups[r.location] = {};
    const cost = getCost(r.barcode);
    if (!groups[r.location][r.barcode]) {
      groups[r.location][r.barcode] = { name: r.name, barcode: r.barcode, cost, qty: 0, total: 0 };
    }
    groups[r.location][r.barcode].qty += r.quantity;
    if (cost != null) groups[r.location][r.barcode].total += cost * r.quantity;
  });

  sc.innerHTML = Object.entries(groups).map(([loc, items]) => {
    const locQty      = Object.values(items).reduce((s, i) => s + i.qty, 0);
    const locCost     = Object.values(items).reduce((s, i) => s + i.total, 0);
    const sortedItems = Object.values(items).sort((a, b) => b.qty - a.qty);
    return `
      <div class="summary-group">
        <div class="summary-group-hdr">
          <div class="summary-group-name">${loc}</div>
          <div class="summary-group-stats">
            <span class="summary-group-stat">Qty <b>${locQty}</b></span>
            <span class="summary-group-stat">Cost <b>$${locCost.toFixed(2)}</b></span>
          </div>
        </div>
        ${sortedItems.map(i => `
          <div class="summary-row">
            <div>
              <div class="summary-item-name">${i.name}</div>
              <div class="summary-item-barcode">${i.barcode}</div>
            </div>
            <div class="summary-qty">${i.qty}</div>
            <div class="summary-cost">${i.cost != null ? '$' + i.total.toFixed(2) : '—'}</div>
          </div>`).join('')}
      </div>`;
  }).join('');
}

function renderDetail(rows, getCost) {
  const sc = document.getElementById('summary-container');
  sc.innerHTML = `
    <div class="summary-group">
      <div class="summary-detail-hdr">
        <span>Item</span><span>Location</span><span>Qty</span><span>Cost</span><span>Time</span>
      </div>
      ${rows.map(r => {
        const cost    = getCost(r.barcode);
        const lineCost = cost != null ? '$' + (cost * r.quantity).toFixed(2) : '—';
        const ts      = new Date(r.timestamp);
        const timeStr = ts.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '
                      + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
          <div class="summary-detail-row">
            <div>
              <div class="summary-item-name">${r.name}</div>
              <div class="summary-item-barcode">${r.barcode}</div>
            </div>
            <div class="summary-detail-loc">${r.location}</div>
            <div class="summary-qty">${r.quantity}</div>
            <div class="summary-cost">${lineCost}</div>
            <div class="summary-detail-time">${timeStr}</div>
          </div>`;
      }).join('')}
    </div>`;
}
