// ===== BARCODE PARSER =====
// TN Lottery ITF-14: 14 digits = 13-digit ticket + check digit (discarded).
function _parseSingleBarcode(raw, clean, gameDigits) {
  const g = gameDigits, packEnd = g + 6, tickEnd = packEnd + 3;
  if (clean.length < tickEnd) return null;
  return {
    raw, clean,
    gameNumber:     clean.slice(0, g),
    packNumber:     clean.slice(g, packEnd),
    ticketPosition: parseInt(clean.slice(packEnd, tickEnd), 10),
    formatted:      `${clean.slice(0, g)}-${clean.slice(g, packEnd)}-${clean.slice(packEnd, tickEnd)}`,
  };
}

function parseLotteryBarcode(raw) {
  const clean = raw.replace(/[^0-9]/g, '');

  // Unambiguous lengths: 12 → 3-digit game; 13–14 → 4-digit game
  if (clean.length === 12) return _parseSingleBarcode(raw, clean, 3);
  if (clean.length === 13 || clean.length === 14) return _parseSingleBarcode(raw, clean, 4);

  // Long barcodes (≥15 digits, e.g. 22-digit scanner output):
  // Legacy tickets use 3-digit game numbers, newer ones use 4-digit.
  // Return both candidates — caller must resolve via DB or pack list.
  if (clean.length > 14) {
    return {
      raw, clean, ambiguous: true,
      candidates: [
        _parseSingleBarcode(raw, clean, 3),  // legacy
        _parseSingleBarcode(raw, clean, 4),  // new
      ].filter(Boolean),
    };
  }
  return null;
}

