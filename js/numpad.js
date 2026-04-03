// ===== QTY HELPERS =====
function getQty()      { return parseInt(document.getElementById('qty-input').value) || 1; }
function stepQty(delta, e) { e.preventDefault(); setQtyVal(getQty() + delta); }
function setQty(n, e)      { e.preventDefault(); setQtyVal(n); }
function setQtyVal(n) {
  n = Math.max(1, n);
  document.getElementById('qty-input').value = n;
  document.getElementById('qty-display').textContent = n;
}

// ===== NUMPAD =====
let _numpadVal = '1';

function openNumpad() {
  _numpadVal = '';
  document.getElementById('numpad-display').textContent = _numpadVal;
  document.getElementById('numpad-overlay').classList.add('open');
}

function numpadKey(key, e) {
  e.preventDefault();
  if (key === 'back') {
    _numpadVal = _numpadVal.length > 1 ? _numpadVal.slice(0, -1) : '0';
  } else {
    _numpadVal = _numpadVal === '0' ? key : _numpadVal + key;
    if (_numpadVal.length > 4) _numpadVal = _numpadVal.slice(0, 4); // cap at 9999
  }
  document.getElementById('numpad-display').textContent = _numpadVal || '0';
}

function numpadConfirm(e) {
  e.preventDefault();
  const v = parseInt(_numpadVal) || 1;
  setQtyVal(v);
  document.getElementById('numpad-overlay').classList.remove('open');
  refocusBarcode();
}

function numpadCancel(e) {
  e.preventDefault();
  document.getElementById('numpad-overlay').classList.remove('open');
  refocusBarcode();
}

function numpadOutsideClick(e) {
  if (e.target === document.getElementById('numpad-overlay')) numpadCancel(e);
}
