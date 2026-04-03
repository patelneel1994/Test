// ===== SHARED STATE =====
let currentItem     = null;
let scanLog         = [];
let locations       = []; // [{id, name}] loaded from Supabase
let cameraRunning   = false;
let html5QrScanner  = null;
let lastScanBarcode = null;
let lastScanTime    = 0;
const DUP_WINDOW_MS = 2000;

// ===== AUDIO =====
const _ac = new (window.AudioContext || window.webkitAudioContext)();
function _beep(freq, dur, type = 'sine', vol = 0.3) {
  const o = _ac.createOscillator(), g = _ac.createGain();
  o.connect(g); g.connect(_ac.destination);
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, _ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, _ac.currentTime + dur);
  o.start(); o.stop(_ac.currentTime + dur);
}
function beepSuccess()   { _beep(880, 0.08); setTimeout(() => _beep(1320, 0.1), 80); }
function beepNotFound()  { _beep(220, 0.25, 'sawtooth', 0.2); }
function beepDuplicate() { _beep(550, 0.12, 'square', 0.15); setTimeout(() => _beep(550, 0.12, 'square', 0.15), 140); }
