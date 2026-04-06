// ===== DB SUMMARY TAB =====
let _summaryMode  = 'grouped'; // 'grouped' | 'location' | 'detail'
let _groupedCache = null;      // cached grouped data (rows from RPC)

function setSummaryMode(mode) {
  _summaryMode = mode;
  ['grouped', 'location', 'detail'].forEach(m => {
    document.getElementById('summary-mode-' + m).classList.toggle('active', m === mode);
  });
  loadSummary();
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
    _groupedCache = rows;

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
      `?select=${CONFIG.barcodeColumn},${CONFIG.costColumn},Category,Retail_Price,Last_Sale_Date,Total_Units_Sold&or=${orFilter}`
    );
    const itemsList = await itemsRes.json();

    const itemMap = {};
    itemsList.forEach(i => { itemMap[i[CONFIG.barcodeColumn]] = i; });
    const getItem  = b => itemMap[b] || null;
    const getCost  = b => { const i = getItem(b); return i && i[CONFIG.costColumn] != null ? parseFloat(i[CONFIG.costColumn]) : null; };

    // Overall totals
    const totalQty    = rows.reduce((s, r) => s + r.quantity, 0);
    const totalCost   = rows.reduce((s, r) => { const c = getCost(r.barcode); return s + (c != null ? c * r.quantity : 0); }, 0);
    const uniqueItems = new Set(rows.map(r => r.barcode)).size;
    st.innerHTML = `
      <div class="stat"><div class="stat-val">${rows.length}</div><div class="stat-label">Records</div></div>
      <div class="stat"><div class="stat-val">${uniqueItems}</div><div class="stat-label">Unique items</div></div>
      <div class="stat"><div class="stat-val">${totalQty}</div><div class="stat-label">Total qty</div></div>
      <div class="stat"><div class="stat-val" style="font-size:20px;">$${totalCost.toFixed(2)}</div><div class="stat-label">Total cost</div></div>`;

    renderSummary(rows, getCost, getItem);

  } catch (e) {
    document.getElementById('summary-container').innerHTML = '';
    showError('Failed to load summary', e.message);
  }
}

function renderSummary(rows, getCost, getItem) {
  if (_summaryMode === 'detail') renderDetail(rows, getCost, getItem);
  else renderByLocation(rows, getCost, getItem);
}

function renderByLocation(rows, getCost, getItem) {
  const sc = document.getElementById('summary-container');
  const groups = {};
  rows.forEach(r => {
    if (!groups[r.location]) groups[r.location] = {};
    const cost = getCost(r.barcode);
    const meta = getItem(r.barcode);
    if (!groups[r.location][r.barcode]) {
      groups[r.location][r.barcode] = {
        name: r.name, barcode: r.barcode, cost, qty: 0, total: 0,
        category:       meta?.Category        ?? null,
        retailPrice:    meta?.Retail_Price    ?? null,
        lastSaleDate:   meta?.Last_Sale_Date  ?? null,
        totalUnitsSold: meta?.Total_Units_Sold ?? null,
      };
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
        ${sortedItems.map(i => {
          const rp = parseFloat(i.retailPrice);
          return `
          <div class="summary-row">
            <div>
              <div class="summary-item-name">${i.name}</div>
              ${i.category ? `<span class="item-badge">${i.category}</span>` : ''}
              <div class="summary-item-barcode">${i.barcode}</div>
              <div class="summary-item-sub">
                ${i.cost != null ? `<span class="sub-field"><span class="sub-lbl">Cost</span> $${i.cost.toFixed(2)}</span>` : ''}
                ${!isNaN(rp)     ? `<span class="sub-field"><span class="sub-lbl">Retail</span> $${rp.toFixed(2)}</span>` : ''}
                ${i.totalUnitsSold != null ? `<span class="sub-field"><span class="sub-lbl">Sold</span> ${i.totalUnitsSold}</span>` : ''}
                ${i.lastSaleDate ? `<span class="sub-field"><span class="sub-lbl">Last Sale</span> ${i.lastSaleDate.slice(0,10)}</span>` : ''}
              </div>
            </div>
            <div class="summary-qty">${i.qty}</div>
            <div class="summary-cost">${i.cost != null ? '$' + i.total.toFixed(2) : '—'}</div>
          </div>`;
        }).join('')}
      </div>`;
  }).join('');
}

function renderDetail(rows, getCost, getItem) {
  const sc = document.getElementById('summary-container');
  sc.innerHTML = `
    <div class="summary-group">
      <div class="detail-scroll">
        <div class="summary-detail-hdr">
          <span>Item</span><span>Category</span><span>Location</span><span>Qty</span><span>Unit Cost</span><span>Total Cost</span><span>Retail</span><span>Sold</span><span>Last Sale</span><span>Time</span>
        </div>
        ${rows.map(r => {
          const cost      = getCost(r.barcode);
          const meta      = getItem(r.barcode);
          const unitCost  = cost != null ? '$' + cost.toFixed(2) : '—';
          const totalCost = cost != null ? '$' + (cost * r.quantity).toFixed(2) : '—';
          const _rp       = parseFloat(meta?.Retail_Price);
          const retail    = !isNaN(_rp) ? '$' + _rp.toFixed(2) : '—';
          const sold      = meta?.Total_Units_Sold ?? '—';
          const lastSale  = meta?.Last_Sale_Date   ? meta.Last_Sale_Date.slice(0,10) : '—';
          const ts        = new Date(r.timestamp);
          const timeStr   = ts.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '
                          + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return `
            <div class="summary-detail-row">
              <div>
                <div class="summary-item-name">${r.name}</div>
                <div class="summary-item-barcode">${r.barcode}</div>
              </div>
              <div class="summary-detail-cat">${meta?.Category ?? '—'}</div>
              <div class="summary-detail-loc">${r.location}</div>
              <div class="summary-qty">${r.quantity}</div>
              <div class="summary-cost">${unitCost}</div>
              <div class="summary-cost">${totalCost}</div>
              <div class="summary-cost">${retail}</div>
              <div class="summary-detail-num">${sold}</div>
              <div class="summary-detail-time">${lastSale}</div>
              <div class="summary-detail-time">${timeStr}</div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ===== EXPORT CSV =====
async function exportSummaryCSV() {
  const fmt = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const download = (rows, filename) => {
    const csv = rows.map(r => r.map(fmt).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename;
    a.click();
  };
  const date = new Date().toISOString().slice(0, 10);

  if (_summaryMode === 'grouped') {
    if (!_groupedCache?.length) { showError('Nothing to export', 'Load the summary first.'); return; }
    const header  = ['Location', 'Total Qty', 'Total Cost'];
    const csvRows = _groupedCache.map(r => [r.location, r.total_qty, Number(r.total_cost).toFixed(2)]);
    download([header, ...csvRows], `summary-grouped-${date}.csv`);
    return;
  }

  // For location/detail: fetch fresh data (same as loadFullSummary)
  try {
    const countsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.countsTable}` +
      `?select=barcode,name,quantity,location,timestamp&limit=5000&order=timestamp.desc`
    );
    const rows = await countsRes.json();
    if (!rows.length) { showError('Nothing to export', 'No records in database.'); return; }

    const uniqueBarcodes = [...new Set(rows.map(r => r.barcode))];
    const orFilter = encodeURIComponent('(' + uniqueBarcodes.map(b => `${CONFIG.barcodeColumn}.eq.${b}`).join(',') + ')');
    const itemsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.itemsTable}` +
      `?select=${CONFIG.barcodeColumn},${CONFIG.costColumn},Category,Retail_Price,Last_Sale_Date,Total_Units_Sold&or=${orFilter}`
    );
    const itemsList = await itemsRes.json();
    const itemMap   = {};
    itemsList.forEach(i => { itemMap[i[CONFIG.barcodeColumn]] = i; });
    const getItem = b => itemMap[b] || null;
    const getCost = b => { const i = getItem(b); return i && i[CONFIG.costColumn] != null ? parseFloat(i[CONFIG.costColumn]) : null; };

    if (_summaryMode === 'location') {
      const groups = {};
      rows.forEach(r => {
        if (!groups[r.location]) groups[r.location] = {};
        const cost = getCost(r.barcode);
        const meta = getItem(r.barcode);
        if (!groups[r.location][r.barcode]) {
          groups[r.location][r.barcode] = {
            name: r.name, barcode: r.barcode,
            category: meta?.Category ?? '', cost, qty: 0, total: 0,
            retailPrice: meta?.Retail_Price ?? '',
            totalUnitsSold: meta?.Total_Units_Sold ?? '',
            lastSaleDate: meta?.Last_Sale_Date ?? '',
          };
        }
        groups[r.location][r.barcode].qty += r.quantity;
        if (cost != null) groups[r.location][r.barcode].total += cost * r.quantity;
      });
      const header  = ['Location', 'Item', 'Barcode', 'Category', 'Qty', 'Unit Cost', 'Total Cost', 'Retail Price', 'Units Sold', 'Last Sale Date'];
      const csvRows = [];
      Object.entries(groups).forEach(([loc, items]) => {
        Object.values(items).sort((a, b) => b.qty - a.qty).forEach(i => {
          const rp = parseFloat(i.retailPrice);
          csvRows.push([
            loc, i.name, i.barcode, i.category, i.qty,
            i.cost != null ? i.cost.toFixed(2) : '',
            i.cost != null ? i.total.toFixed(2) : '',
            !isNaN(rp) ? rp.toFixed(2) : '',
            i.totalUnitsSold,
            i.lastSaleDate ? String(i.lastSaleDate).slice(0, 10) : '',
          ]);
        });
      });
      download([header, ...csvRows], `summary-by-location-${date}.csv`);

    } else { // detail
      const header  = ['Timestamp', 'Location', 'Item', 'Barcode', 'Category', 'Qty', 'Unit Cost', 'Total Cost', 'Retail Price', 'Units Sold', 'Last Sale Date'];
      const csvRows = rows.map(r => {
        const cost = getCost(r.barcode);
        const meta = getItem(r.barcode);
        const rp   = parseFloat(meta?.Retail_Price);
        return [
          r.timestamp, r.location, r.name, r.barcode,
          meta?.Category ?? '', r.quantity,
          cost != null ? cost.toFixed(2) : '',
          cost != null ? (cost * r.quantity).toFixed(2) : '',
          !isNaN(rp) ? rp.toFixed(2) : '',
          meta?.Total_Units_Sold ?? '',
          meta?.Last_Sale_Date ? String(meta.Last_Sale_Date).slice(0, 10) : '',
        ];
      });
      download([header, ...csvRows], `summary-detail-${date}.csv`);
    }
  } catch (e) {
    showError('Export failed', e.message);
  }
}
