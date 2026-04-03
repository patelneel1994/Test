// ===== DB SUMMARY TAB =====
async function loadSummary() {
  const sc = document.getElementById('summary-container');
  const st = document.getElementById('summary-totals');
  sc.innerHTML = '<div class="summary-loading">Loading…</div>';
  st.innerHTML = '';

  try {
    // Fetch all count records, then fetch costs only for the barcodes we need
    const countsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.countsTable}?select=barcode,name,quantity,location,timestamp&limit=5000`
    );
    const rows = await countsRes.json();

    if (!rows.length) {
      st.innerHTML = '';
      sc.innerHTML = '<div class="summary-empty">No records in database yet</div>';
      return;
    }

    const uniqueBarcodes = [...new Set(rows.map(r => r.barcode))];
    const orFilter = encodeURIComponent('(' + uniqueBarcodes.map(b => `${CONFIG.barcodeColumn}.eq.${b}`).join(',') + ')');
    const itemsRes = await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.itemsTable}?select=${CONFIG.barcodeColumn},${CONFIG.costColumn}&or=${orFilter}`
    );
    const itemsList = await itemsRes.json();

    // Build barcode → cost lookup from items table (exact match)
    const costMap = {};
    itemsList.forEach(i => { costMap[i[CONFIG.barcodeColumn]] = i[CONFIG.costColumn]; });
    const getCost = barcode => {
      const c = costMap[barcode];
      return c != null ? parseFloat(c) : null;
    };

    // Overall totals
    const totalQty    = rows.reduce((s, r) => s + r.quantity, 0);
    const totalCost   = rows.reduce((s, r) => { const c = getCost(r.barcode); return s + (c != null ? c * r.quantity : 0); }, 0);
    const uniqueItems = new Set(rows.map(r => r.barcode)).size;
    st.innerHTML = `
      <div class="stat"><div class="stat-val">${rows.length}</div><div class="stat-label">Records</div></div>
      <div class="stat"><div class="stat-val">${uniqueItems}</div><div class="stat-label">Unique items</div></div>
      <div class="stat"><div class="stat-val">${totalQty}</div><div class="stat-label">Total qty</div></div>
      <div class="stat"><div class="stat-val" style="font-size:20px;">$${totalCost.toFixed(2)}</div><div class="stat-label">Total cost</div></div>`;

    // Group by location, joining cost from items table
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
      const locQty     = Object.values(items).reduce((s, i) => s + i.qty, 0);
      const locCost    = Object.values(items).reduce((s, i) => s + i.total, 0);
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

  } catch (e) {
    sc.innerHTML = '';
    showError('Failed to load summary', e.message);
  }
}
