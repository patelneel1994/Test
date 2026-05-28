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

// Unlock AudioContext on first user gesture (browsers suspend it until then)
(function _unlockAudio() {
  const unlock = () => {
    _ac.resume();
    document.removeEventListener('click',       unlock);
    document.removeEventListener('touchstart',  unlock);
    document.removeEventListener('keydown',     unlock);
    document.removeEventListener('pointerdown', unlock);
  };
  document.addEventListener('click',       unlock, { once: true, passive: true });
  document.addEventListener('touchstart',  unlock, { once: true, passive: true });
  document.addEventListener('keydown',     unlock, { once: true, passive: true });
  document.addEventListener('pointerdown', unlock, { once: true, passive: true });
})();

function _beep(freq, dur, type = 'sine', vol = 0.5) {
  // Always resume first — if already running the Promise resolves synchronously,
  // if suspended it resumes before the oscillator starts, ensuring the sound plays.
  _ac.resume().then(() => {
    const o = _ac.createOscillator(), g = _ac.createGain();
    o.connect(g); g.connect(_ac.destination);
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, _ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, _ac.currentTime + dur);
    o.start(); o.stop(_ac.currentTime + dur);
  });
}

// Two rising tones — clean match / pack received
function beepSuccess()   { _beep(880, 0.08); setTimeout(() => _beep(1320, 0.12), 80); }
// Low sawtooth buzz — book not found / game unknown
function beepNotFound()  { _beep(220, 0.28, 'sawtooth', 0.45); }
// Three descending square tones — direction violation
function beepViolation() { _beep(660, 0.09, 'square', 0.4); setTimeout(() => _beep(550, 0.09, 'square', 0.4), 100); setTimeout(() => _beep(440, 0.14, 'square', 0.4), 200); }
// Two identical blips — duplicate scan
function beepDuplicate() { _beep(550, 0.12, 'square', 0.3); setTimeout(() => _beep(550, 0.12, 'square', 0.3), 140); }
