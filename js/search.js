// ===== SEARCH TAB =====
let _searchDebounce = null;

async function saveSearchItemCost(barcode, idx) {
  const input  = document.getElementById(`search-cost-${idx}`);
  const status = document.getElementById(`search-cost-status-${idx}`);
  const newCost = parseFloat(input.value);

  if (isNaN(newCost) || newCost < 0) {
    status.textContent = '⚠ Invalid';
    status.style.color = 'var(--warning, #f59e0b)';
    return;
  }

  status.textContent = 'Saving…';
  status.style.color = 'var(--text-muted, #888)';

  try {
    const col  = CONFIG.barcodeColumn;
    const cost = CONFIG.costColumn;
    const base = `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.itemsTable}`;

    const res = await sbFetch(
      `${base}?${col}=eq.${encodeURIComponent(barcode)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ [cost]: newCost })
      }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    status.textContent = '✓ Saved';
    status.style.color = 'var(--success, #22c55e)';
    setTimeout(() => { status.textContent = ''; }, 2500);

  } catch (e) {
    status.textContent = '✗ Failed';
    status.style.color = 'var(--danger, #ef4444)';
    showError('Cost update failed', e.message);
  }
}

function onSearchInput() {
  clearTimeout(_searchDebounce);
  const q = document.getElementById('search-input').value.trim();
  if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
  document.getElementById('search-results').innerHTML = '<div class="search-loading">Searching…</div>';
  _searchDebounce = setTimeout(() => doSearch(q), 350);
}

async function doSearch(query) {
  if (query === undefined) query = document.getElementById('search-input').value.trim();
  const rc = document.getElementById('search-results');
  if (!query) { rc.innerHTML = ''; return; }

  rc.innerHTML = '<div class="search-loading">Searching…</div>';

  try {
    const col  = CONFIG.barcodeColumn;
    const name = CONFIG.nameColumn;
    const cost = CONFIG.costColumn;
    const base = `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.itemsTable}`;
    const sel  = `select=${col},${name},${cost}`;
    const enc  = encodeURIComponent(query);

    // Search by name (ilike) OR exact barcode match
    const url = `${base}?or=(${name}.ilike.%25${enc}%25,${col}.eq.${enc})&${sel}&limit=50&order=${name}.asc`;
    const res  = await sbFetch(url);
    const rows = await res.json();

    if (!rows.length) {
      rc.innerHTML = '<div class="search-empty">No items found</div>';
      return;
    }

    rc.innerHTML = `<div class="search-results">${rows.map((row, idx) => {
      const costVal = row[cost] != null ? parseFloat(row[cost]).toFixed(2) : '';
      return `
        <div class="search-item">
          <div class="search-item-name">${row[name]}</div>
          <div class="search-item-meta">
            <span class="search-item-barcode">${row[col]}</span>
          </div>
          <div class="item-cost-row" style="margin-top:8px;">
            <span class="item-cost-label">Cost</span>
            <div class="item-cost-edit">
              <span class="item-cost-prefix">$</span>
              <input class="item-cost-input" id="search-cost-${idx}" type="number" min="0" step="0.01"
                value="${costVal}" placeholder="0.00" />
            </div>
            <button class="item-cost-save" onclick="saveSearchItemCost('${row[col]}', ${idx})">Save</button>
            <span class="item-cost-status" id="search-cost-status-${idx}"></span>
          </div>
        </div>`;
    }).join('')}</div>`;
  } catch (e) {
    rc.innerHTML = '';
    showError('Search failed', e.message);
  }
}
