// ===== SUPABASE FETCH WRAPPER =====
// All Supabase calls go through here. Any non-2xx throws with the full error body.
async function sbFetch(url, options = {}) {
  const headers = {
    'apikey': CONFIG.supabaseKey,
    'Authorization': 'Bearer ' + CONFIG.supabaseKey,
    ...options.headers
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    throw new Error(`[${res.status}] ${body || res.statusText}`);
  }
  return res;
}

// ===== ERROR BANNER =====
function showError(title, msg) {
  document.getElementById('error-banner-title').textContent = title;
  document.getElementById('error-banner-msg').textContent = msg;
  document.getElementById('error-banner').classList.add('show');
  console.error(title, msg);
}
function dismissError() {
  document.getElementById('error-banner').classList.remove('show');
}

// ===== FOCUS =====
// Barcode input ALWAYS holds focus except when camera open or modal is active.
// ALL qty buttons use onmousedown/ontouchstart + e.preventDefault() so they never steal focus.
function refocusBarcode() {
  if (cameraRunning) return;
  if (document.getElementById('loc-modal').classList.contains('open')) return;
  setTimeout(() => document.getElementById('barcode-input').focus(), 30);
}

// ===== DB STATUS =====
async function checkDBConnection() {
  const el = document.getElementById('db-status');
  try {
    const res = await sbFetch(
      CONFIG.supabaseUrl + '/rest/v1/' + CONFIG.itemsTable + '?select=count&limit=1',
      { headers: { 'Prefer': 'count=exact' } }
    );
    const total = (res.headers.get('content-range') || '').split('/')[1] || '?';
    el.style.cssText = 'background:var(--green-bg);border:1.5px solid var(--green-border);color:var(--green-text);border-radius:var(--radius-sm);padding:9px 14px;margin-bottom:12px;font-size:13px;font-weight:500;';
    el.innerHTML = '✓ Connected — <strong>' + total + '</strong> items in database';
  } catch (e) {
    el.style.cssText = 'background:var(--red-bg);border:1.5px solid var(--red-border);color:var(--red-text);border-radius:var(--radius-sm);padding:9px 14px;margin-bottom:12px;font-size:13px;font-weight:500;';
    el.innerHTML = '✗ Database error: ' + e.message;
  }
}
