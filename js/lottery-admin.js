// ===== ADMIN CHECK =====
// Session-level admin unlock. Expires after ADMIN_SESSION_MS of inactivity.
// Replace _adminUnlocked with a real auth lookup when a user/role system is added.
const ADMIN_SESSION_MS = 2 * 60 * 1000;  // 2 minutes
let _adminUnlocked       = false;
let _adminCallback       = null;   // pending action waiting for admin auth
let _adminExpireTimer    = null;   // auto-lock timeout
let _adminExpireAt       = null;   // absolute timestamp when session expires
let _adminCountdownInterval = null; // 1-second tick to update the pill

function isAdmin() { return _adminUnlocked; }

function _syncAdminStats() {
  const show = _adminUnlocked;
  document.querySelectorAll('.admin-stat').forEach(el => {
    el.style.display = show ? '' : 'none';
  });
}

function _syncAdminPill() {
  const btn = document.getElementById('admin-lock-pill');
  if (!btn) return;
  if (_adminUnlocked && _adminExpireAt) {
    const remaining = Math.max(0, Math.ceil((_adminExpireAt - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = String(remaining % 60).padStart(2, '0');
    btn.textContent       = `🔓 Admin · ${mins}:${secs}`;
    btn.style.background  = 'var(--amber-bg)';
    btn.style.color       = 'var(--accent-dk)';
    btn.style.borderColor = 'var(--amber-border)';
  } else {
    btn.textContent       = '🔒 Admin';
    btn.style.background  = '';
    btn.style.color       = '';
    btn.style.borderColor = '';
  }
}

function _lockAdmin() {
  _adminUnlocked = false;
  _adminExpireAt = null;
  if (_adminExpireTimer)      { clearTimeout(_adminExpireTimer);         _adminExpireTimer      = null; }
  if (_adminCountdownInterval){ clearInterval(_adminCountdownInterval);  _adminCountdownInterval = null; }
  _syncAdminPill();
  _syncAdminStats();
  if (_cachedStockRows) renderLotteryStock(_cachedStockRows);
  _renderLocationView();
}

function _resetAdminTimer() {
  _adminExpireAt = Date.now() + ADMIN_SESSION_MS;
  if (_adminExpireTimer) clearTimeout(_adminExpireTimer);
  _adminExpireTimer = setTimeout(_lockAdmin, ADMIN_SESSION_MS);
  // Start (or restart) the 1-second countdown tick
  if (_adminCountdownInterval) clearInterval(_adminCountdownInterval);
  _adminCountdownInterval = setInterval(_syncAdminPill, 1000);
}

// Gate any action behind admin auth.
// If already unlocked, resets the expiry timer and runs callback immediately.
// Otherwise shows the admin-auth modal; callback fires on successful unlock.
function requireAdmin(callback) {
  if (_adminUnlocked) { _resetAdminTimer(); callback(); return; }
  _adminCallback = callback;
  const inp = document.getElementById('admin-auth-input');
  if (inp) inp.value = '';
  const btn = document.getElementById('admin-auth-btn');
  if (btn) btn.disabled = true;
  document.getElementById('admin-auth-modal').classList.add('open');
  setTimeout(() => inp?.focus(), 120);
}

function _onAdminAuthInput() {
  const val = (document.getElementById('admin-auth-input')?.value || '');
  const btn = document.getElementById('admin-auth-btn');
  if (btn) btn.disabled = (val !== 'Neel');
}

function confirmAdminAuth(e) {
  if (e) e.preventDefault();
  const val = (document.getElementById('admin-auth-input')?.value || '');
  if (val !== 'Neel') return;
  _adminUnlocked = true;
  _resetAdminTimer();
  closeAdminAuthModal();
  if (_adminCallback) { const cb = _adminCallback; _adminCallback = null; cb(); }
  _syncAdminPill();
  _syncAdminStats();
  if (_cachedStockRows) renderLotteryStock(_cachedStockRows);
  _renderLocationView();
}

function toggleAdminLock() {
  if (_adminUnlocked) { _lockAdmin(); } else { requireAdmin(() => {}); }
}

function closeAdminAuthModal() {
  document.getElementById('admin-auth-modal').classList.remove('open');
  _adminCallback = null;
}

