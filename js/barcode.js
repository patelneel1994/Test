// ===== BARCODE MATCHING UTILITIES =====
function normalizeBarcode(code) {
  const t = String(code).trim();
  if (!t) return '';
  const m = t.match(/^0*(.+)$/);
  return m ? m[1] : '0';
}

function calcCheckDigit(body) {
  let s = 0;
  for (let i = 0; i < body.length; i++) s += parseInt(body[i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (s % 10)) % 10);
}

function expandUpcE(raw) {
  const d = raw.replace(/\D/g, '');
  let b;
  if (d.length === 6)      b = d;
  else if (d.length === 7) b = d.slice(1);
  else if (d.length === 8) b = d.slice(1, 7);
  else return null;
  const [e0, e1, e2, e3, e4, e5] = b.split('');
  let b11;
  switch (parseInt(e5)) {
    case 0: case 1: case 2: b11 = `0${e0}${e1}${e5}0000${e2}${e3}${e4}`; break;
    case 3: b11 = `0${e0}${e1}${e2}00000${e3}${e4}`; break;
    case 4: b11 = `0${e0}${e1}${e2}${e3}00000${e4}`; break;
    default: b11 = `0${e0}${e1}${e2}${e3}${e4}0000${e5}`; break;
  }
  return b11 + calcCheckDigit(b11);
}

function barcodeCandidates(raw) {
  const t = String(raw).trim();
  if (!t) return [];
  const seen = new Set(), result = [];
  const add = c => { const s = String(c).trim(); if (s && !seen.has(s)) { seen.add(s); result.push(s); } };
  const d = t.replace(/\D/g, '');
  add(t); add(normalizeBarcode(t));
  if (d.length === 12) { add('0' + d); add(normalizeBarcode('0' + d)); }
  if (d.length === 13 && d.startsWith('0')) { add(d.slice(1)); add(normalizeBarcode(d.slice(1))); }
  if (d.length >= 6 && d.length <= 8) {
    const u = expandUpcE(d);
    if (u) { add(u); add(normalizeBarcode(u)); add('0' + u); add(normalizeBarcode('0' + u)); }
  }
  if (d.length > 4) { const nc = d.slice(0, -1); add(nc); add(normalizeBarcode(nc)); }
  if (d.length === 11) add(d + calcCheckDigit(d));
  if (d.length === 12) { const e = '0' + d; add(e + calcCheckDigit(e)); }
  result.slice().forEach(c => add(normalizeBarcode(c)));
  return result;
}
