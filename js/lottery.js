// ===== LOTTERY MODULE =====
// Split into service files — see index.html for load order.
//
//   lottery-locations.js     — location config, slot counts, global state
//   lottery-admin.js         — admin session / auth gate
//   lottery-db.js            — DB capabilities check, pack event logger
//   lottery-audit.js         — inventory scan, progress, reset data
//   lottery-audit-extra.js   — extra books audit section + bypass
//   lottery-day-shift.js     — day/shift state, open day, open shift
//   lottery-barcode.js       — TN Lottery barcode parser
//   lottery-receive.js       — receive new books, lottery result UI
//   lottery-packs.js         — pack status, sold out, move, return to lottery
//   lottery-catalog.js       — game catalog
//   lottery-stock.js         — stock view, shift close modal
//   lottery-history.js       — shift/day history
//   lottery-init.js          — tab initialisation
//   lottery-dashboard.js     — dashboard + analytics + jump nav
//   lottery-settings.js      — settings panel
//   lottery-reports.js       — reports
//   lottery-inventory-tab.js — inventory tab
