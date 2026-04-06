// ===== MANUAL GO BUTTON =====
function submitBarcodeInput() {
  const v = document.getElementById('barcode-input').value.trim();
  if (v) lookupBarcode(v);
}

// ===== LOOKUP =====
async function lookupBarcode(barcode) {
  if (!barcode) return;

  const inp = document.getElementById('barcode-input');
  inp.value = '';

  const location = document.getElementById('loc-select').value;
  if (!location) { showError('No location selected', 'Please select a location before scanning.'); refocusBarcode(); return; }

  // Duplicate scan guard
  const now = Date.now();
  if (barcode === lastScanBarcode && (now - lastScanTime) < DUP_WINDOW_MS) {
    beepDuplicate();
    inp.classList.add('dup-warn');
    setTimeout(() => inp.classList.remove('dup-warn'), 600);
    refocusBarcode();
    return;
  }
  lastScanBarcode = barcode;
  lastScanTime = now;

  // Auto-log the previous item before switching to the new scan
  if (currentItem) await submitCount(null);

  // Loading state
  inp.classList.add('loading');
  inp.placeholder = 'Looking up…';

  let item;
  try {
    item = await fetchFromSupabase(barcode);
  } catch (e) {
    inp.classList.remove('loading');
    inp.placeholder = 'Scan or type barcode…';
    document.getElementById('item-found-box').innerHTML = `
      <div class="item-not-found-card">
        <div class="item-nf-title">Lookup error</div>
        <div class="item-nf-sub">${e.message}</div>
      </div>`;
    document.getElementById('count-form').classList.remove('visible');
    beepNotFound();
    refocusBarcode();
    return;
  }

  inp.classList.remove('loading');
  inp.placeholder = 'Scan or type barcode…';

  const scanTime = new Date();
  currentItem = item ? { ...item, barcode, scanTime } : null;
  document.getElementById('log-btn').disabled = !currentItem;

  if (item) {
    beepSuccess();
    dismissError();
    if (navigator.vibrate) navigator.vibrate(40);
    const timeStr = scanTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const costVal = item.cost != null ? parseFloat(item.cost).toFixed(2) : '';
    document.getElementById('item-found-box').innerHTML = `
      <div class="item-found-card">
        <div class="item-found-name">${item.name}</div>
        ${item.category ? `<div class="item-badge">${item.category}</div>` : ''}
        <div class="item-cost-row">
          <span class="item-cost-label">Cost</span>
          <div class="item-cost-edit">
            <span class="item-cost-prefix">$</span>
            <input class="item-cost-input" id="cost-input" type="number" min="0" step="0.01"
              value="${costVal}" placeholder="0.00" onchange="updateCostLocal()" />
          </div>
          <button class="item-cost-save" onclick="saveCostToDb()">Save</button>
          <span class="item-cost-status" id="cost-status"></span>
        </div>
        <div class="item-meta-grid">
          ${!isNaN(parseFloat(item.retailPrice)) ? `<div class="item-meta-cell"><span class="item-meta-lbl">Retail</span><span class="item-meta-val">$${parseFloat(item.retailPrice).toFixed(2)}</span></div>` : ''}
          ${item.totalUnitsSold != null ? `<div class="item-meta-cell"><span class="item-meta-lbl">Units Sold</span><span class="item-meta-val">${item.totalUnitsSold}</span></div>` : ''}
          ${item.lastSaleDate ? `<div class="item-meta-cell"><span class="item-meta-lbl">Last Sale</span><span class="item-meta-val">${item.lastSaleDate.slice(0,10)}</span></div>` : ''}
        </div>
        <div class="item-found-code">${barcode}</div>
        <div class="item-found-time">Scanned at ${timeStr}</div>
      </div>`;
    setQtyVal(1);
    document.getElementById('count-form').classList.add('visible');
    refocusBarcode();
  } else {
    beepNotFound();
    document.getElementById('item-found-box').innerHTML = `
      <div class="item-not-found-card">
        <div class="item-nf-title">Item not found</div>
        <div class="item-nf-sub">${barcode}</div>
      </div>`;
    document.getElementById('count-form').classList.remove('visible');
    refocusBarcode();
  }
}

const ITEM_SELECT = [
  CONFIG.barcodeColumn, CONFIG.nameColumn, CONFIG.costColumn,
  'Category', 'Retail_Price', 'Last_Sale_Date', 'Total_Units_Sold'
].join(',');

async function fetchFromSupabase(barcode) {
  const sel  = `select=${ITEM_SELECT}`;
  const base = `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.itemsTable}`;
  const col  = CONFIG.barcodeColumn;
  const parse = row => ({
    name:           row[CONFIG.nameColumn],
    cost:           row[CONFIG.costColumn],
    dbBarcode:      row[CONFIG.barcodeColumn],
    category:       row.Category,
    retailPrice:    row.Retail_Price,
    lastSaleDate:   row.Last_Sale_Date,
    totalUnitsSold: row.Total_Units_Sold,
  });
  const cands = barcodeCandidates(barcode);
  if (cands.length) {
    const or  = encodeURIComponent('(' + cands.map(c => `${col}.eq.${c}`).join(',') + ')');
    const res = await sbFetch(`${base}?or=${or}&${sel}&limit=1`);
    const d   = await res.json();
    if (Array.isArray(d) && d.length) return parse(d[0]);
  }
  const norm = normalizeBarcode(barcode);
  if (norm.length >= 4) {
    const r2 = await sbFetch(`${base}?${col}=like.%25${encodeURIComponent(norm)}&${sel}&limit=1`);
    const d2 = await r2.json();
    if (Array.isArray(d2) && d2.length) return parse(d2[0]);
  }
  return null;
}

// ===== COST EDIT =====
function updateCostLocal() {
  const v = parseFloat(document.getElementById('cost-input').value);
  if (!isNaN(v) && currentItem) currentItem.cost = v;
}

async function saveCostToDb() {
  if (!currentItem) return;
  const inp    = document.getElementById('cost-input');
  const status = document.getElementById('cost-status');
  const v = parseFloat(inp.value);
  if (isNaN(v) || v < 0) { status.style.color = 'var(--red-text)'; status.textContent = 'Invalid'; return; }

  currentItem.cost = v;
  status.textContent = 'Saving…';
  status.style.color = 'var(--text-muted)';

  try {
    const matchBarcode = currentItem.dbBarcode || currentItem.barcode;
    await sbFetch(
      `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.itemsTable}?${CONFIG.barcodeColumn}=eq.${encodeURIComponent(matchBarcode)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, body: JSON.stringify({ [CONFIG.costColumn]: v }) }
    );
    status.style.color = 'var(--green)';
    status.textContent = 'Saved';
    setTimeout(() => { if (status) status.textContent = ''; }, 2000);
  } catch (e) {
    status.style.color = 'var(--red-text)';
    status.textContent = 'Failed';
    showError('Cost save failed', e.message);
  }
}

// ===== ITEM DISPLAY =====
function showPlaceholder() {
  document.getElementById('item-found-box').innerHTML = '<div class="item-placeholder">Scan a barcode to see item details</div>';
  document.getElementById('count-form').classList.remove('visible');
}

function dismissCurrentItem() {
  currentItem = null;
  document.getElementById('log-btn').disabled = true;
  showPlaceholder();
  refocusBarcode();
}
