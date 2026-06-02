// ===== DB CAPABILITIES CHECK =====
// Run once; determines which columns/tables exist so queries don't crash.
async function checkDbCapabilities() {
  if (_dbCapsChecked) return;
  _dbCapsChecked = true;
  try {
    const [lRes, dRes, sRes, eRes] = await Promise.all([
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_packs?select=loading_direction&limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_days?limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_shifts?select=day_id,opened_at,status&limit=0`),
      sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events?limit=0`),
    ]);
    _dbCaps.hasLoadingDirection = lRes.ok;
    _dbCaps.hasFullDayTracking  = dRes.ok && sRes.ok;
    _dbCaps.hasPackEvents       = eRes.ok;
  } catch (_) {}
}

// ===== PACK EVENT LOGGER =====

function _logPackEvent(packId, action, details = {}) {
  if (!_dbCaps.hasPackEvents || !packId) return;
  const event = {
    pack_id: packId,
    action,
    ...(_currentShift?.id ? { shift_id: _currentShift.id } : {}),
    ...(_currentDay?.id   ? { day_id:   _currentDay.id   } : {}),
    ...details,
  };
  // fire-and-forget — does not block the main action
  sbFetch(`${CONFIG.supabaseUrl}/rest/v1/lottery_pack_events`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(event) }).catch(() => {});
}

