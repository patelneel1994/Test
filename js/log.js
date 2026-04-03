// ===== SUBMIT COUNT =====
async function submitCount(e) {
  if (e) e.preventDefault();
  if (!currentItem) return;
  const location = document.getElementById('loc-select').value;
  const qty = getQty();
  if (qty < 1) { setQtyVal(1); return; }

  const dbRecord = {
    barcode:   currentItem.dbBarcode || currentItem.barcode,
    name:      currentItem.name,
    quantity:  qty,
    location,
    timestamp: (currentItem.scanTime || new Date()).toISOString(),
  };

  if (!CONFIG.demoMode) {
    try {
      await saveCountToSupabase(dbRecord);
    } catch (e) {
      showError('Failed to save record', e.message);
      return;
    }
  }

  // Keep cost in memory only for session display
  const record = { ...dbRecord, cost: currentItem.cost != null ? parseFloat(currentItem.cost) : null };
  scanLog.unshift(record);
  localStorage.setItem('inv_log', JSON.stringify(scanLog.slice(0, 500)));
  // Reset dup guard so same item can be scanned again intentionally after logging
  lastScanBarcode = null;

  document.getElementById('success-text').textContent = `Logged: ${qty}× ${currentItem.name}`;
  const flash = document.getElementById('success-flash');
  flash.classList.remove('show'); void flash.offsetWidth; flash.classList.add('show');

  renderLog(true);
  updateStats();
  setQtyVal(1);
  refocusBarcode();
  dismissCurrentItem();
}

async function saveCountToSupabase(record) {
  await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/${CONFIG.countsTable}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(record)
  });
}

// ===== LOG RENDERING =====
function formatTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Logged at ${time}`;
  return `Logged ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

function toggleLocGroup(el) {
  const items = el.nextElementSibling;
  items.classList.toggle('hidden');
  el.querySelector('.loc-group-chevron').classList.toggle('open');
}

function renderLog(flashFirst) {
  document.getElementById('undo-btn').style.display = scanLog.length ? '' : 'none';
  const c = document.getElementById('log-container');
  if (!scanLog.length) { c.innerHTML = '<div class="log-empty">No items logged yet this session</div>'; return; }

  // Group by location, preserving newest-first order within each group
  const groupMap = {}, groupOrder = [];
  scanLog.forEach((r, i) => {
    if (!groupMap[r.location]) { groupMap[r.location] = []; groupOrder.push(r.location); }
    groupMap[r.location].push({ r, i });
  });

  c.innerHTML = groupOrder.map(loc => {
    const entries   = groupMap[loc];
    const totalQty  = entries.reduce((s, { r }) => s + r.quantity, 0);
    const hasCost   = entries.some(({ r }) => r.cost != null);
    const totalCost = entries.reduce((s, { r }) => s + (r.cost != null ? parseFloat(r.cost) * r.quantity : 0), 0);
    return `
      <div class="loc-group">
        <div class="loc-group-hdr" onclick="toggleLocGroup(this)">
          <div class="loc-group-name">${loc}</div>
          <div class="loc-group-meta">
            <span class="loc-group-stat">Qty <b>${totalQty}</b></span>
            ${hasCost ? `<span class="loc-group-stat">Cost <b>$${totalCost.toFixed(2)}</b></span>` : ''}
            <span class="loc-group-chevron open">▼</span>
          </div>
        </div>
        <div class="loc-group-items">
          ${entries.map(({ r, i }) => `
            <div class="log-item${flashFirst && i === 0 ? ' new-flash' : ''}">
              <div>
                <div class="log-item-name">${r.name}</div>
                <div class="log-item-meta">${r.barcode}${r.cost != null ? ' · $' + parseFloat(r.cost).toFixed(2) : ''}</div>
                <div class="log-item-time">${formatTime(r.timestamp)}</div>
              </div>
              <div class="log-right">
                <div class="log-qty-pill">${r.quantity}</div>
                <button class="log-delete" onclick="deleteLogItem(${i})">×</button>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function deleteLogItem(i) {
  scanLog.splice(i, 1);
  localStorage.setItem('inv_log', JSON.stringify(scanLog));
  renderLog();
  updateStats();
  refocusBarcode();
}

function undoLast() {
  if (!scanLog.length) return;
  scanLog.shift();
  localStorage.setItem('inv_log', JSON.stringify(scanLog));
  renderLog();
  updateStats();
  refocusBarcode();
}

function clearLog() {
  if (!confirm('Clear this session log?')) return;
  scanLog = [];
  localStorage.removeItem('inv_log');
  currentItem = null;
  document.getElementById('log-btn').disabled = true;
  showPlaceholder();
  renderLog();
  updateStats();
  refocusBarcode();
}

function updateStats() {
  const totalCost = scanLog.reduce((s, r) => s + (r.cost != null ? parseFloat(r.cost) * r.quantity : 0), 0);
  document.getElementById('stat-scans').textContent = scanLog.length;
  document.getElementById('stat-items').textContent = new Set(scanLog.map(r => r.barcode)).size;
  document.getElementById('stat-qty').textContent   = scanLog.reduce((s, r) => s + r.quantity, 0);
  document.getElementById('stat-cost').textContent  = '$' + totalCost.toFixed(2);
}

// ===== EXPORT =====
function exportCSV() {
  if (!scanLog.length) { alert('Nothing to export yet.'); return; }
  const h = ['Timestamp', 'Location', 'Barcode', 'Item Name', 'Cost', 'Quantity'];
  const rows = scanLog.map(r => [r.timestamp, r.location, r.barcode, r.name, r.cost, r.quantity]);
  const csv = [h, ...rows].map(row => row.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
