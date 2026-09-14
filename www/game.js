'use strict';

/* ============================================================
   SINGULARITY — an endless gravity-well game
   One finger. Consume what's smaller. Flee what isn't.

   Every world is drawn procedurally into an offscreen canvas once
   and then blitted, so 110 detailed bodies cost about as much as
   110 flat circles did.
   ============================================================ */

/* ---------- math ---------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const mod = (a, n) => ((a % n) + n) % n;
const smooth = (perSecond, dt) => 1 - Math.pow(perSecond, dt);

// Deterministic PRNG: a body's surface must look identical every frame.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- tuning ---------- */
const P0 = 22;                       // starting radius, world units
const DEATH_AREA = P0 * P0 * 0.30;   // collapse below this
const ENT_TARGET = 110;              // entities kept alive
const COMBO_WINDOW = 1.35;           // seconds to keep a chain alive
const CONSUME_YIELD = 0.34;          // how much of a body becomes your mass
const STAR_BONUS = 3;                // score multiplier for eating a star

// What hitting something too big costs you. A star should feel catastrophic
// and rubble should barely register — one flat penalty made every collision
// feel identical no matter what you flew into.
const IMPACT = {
  star:     { frac: 0.55, knock: 13, burn: true,  msg: 'BURNED BY A STAR' },
  giant:    { frac: 0.32, knock: 12, gas: true,   msg: 'SLAMMED INTO A GIANT' },
  lava:     { frac: 0.40, knock: 9,  burn: true,  msg: null },
  rogue:    { frac: 0.34, knock: 11, msg: null },
  rival:    { frac: 0.60, knock: 16, flash: true, msg: 'RIVAL SINGULARITY' },
  asteroid: { frac: 0.12, knock: 6,  msg: null },
  comet:    { frac: 0.18, knock: 8,  msg: null }
};
const IMPACT_DEFAULT = { frac: 0.25, knock: 9, msg: null };

/* ---------- canvas ---------- */
const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d', { alpha: false });
let W = 0, H = 0, MIN = 0, DPR = 1;

/* ---------- state ---------- */
let state = 'menu';
let p, ents, parts, waves, shots, cam;
let score = 0, shownScore = 0, best = 0, newBest = false;
let combo = 0, comboT = 0, elapsed = 0, era = 0;
let shakeMag = 0, hitstopT = 0, invuln = 0, flashT = 0;
let pendingWave = false, toastT = 0, shotT = 0;
let panel = null;   // null | 'pause' | 'settings'

const pointer = { x: 0, y: 0, active: false };
const keys = { up: false, down: false, left: false, right: false };

// Fixed light direction so every world is lit consistently.
const LIGHT = { x: -0.52, y: -0.58 };

/* ---------- DOM ---------- */
const el = {
  hud: document.getElementById('hud'),
  hudScore: document.getElementById('hudScore'),
  hudBest: document.getElementById('hudBest'),
  comboWrap: document.getElementById('comboWrap'),
  comboValue: document.getElementById('comboValue'),
  comboBar: document.getElementById('comboBar'),
  menu: document.getElementById('menu'),
  playBtn: document.getElementById('playBtn'),
  menuBest: document.getElementById('menuBest'),
  over: document.getElementById('over'),
  finalScore: document.getElementById('finalScore'),
  overBest: document.getElementById('overBest'),
  newBest: document.getElementById('newBest'),
  againBtn: document.getElementById('againBtn'),
  muteBtn: document.getElementById('muteBtn'),
  toast: document.getElementById('toast'),
  pauseBtn: document.getElementById('pauseBtn'),
  pause: document.getElementById('pause'),
  pauseScore: document.getElementById('pauseScore'),
  resumeBtn: document.getElementById('resumeBtn'),
  restartBtn: document.getElementById('restartBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  homeBtn: document.getElementById('homeBtn'),
  overHomeBtn: document.getElementById('overHomeBtn'),
  settings: document.getElementById('settings'),
  soundBtn: document.getElementById('soundBtn'),
  motionBtn: document.getElementById('motionBtn'),
  settingsBackBtn: document.getElementById('settingsBackBtn')
};

const show = (n) => n.classList.remove('hidden');
const hide = (n) => n.classList.add('hidden');
const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

// Best score is committed whenever a run could end, not only on death --
// quitting or backgrounding mid-run used to throw the score away entirely.
function commitBest() {
  if (score > best) { best = score; lsSet('singularity.best', String(best)); return true; }
  return false;
}

let motion = lsGet('singularity.motion', '1') === '1';

const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                     window.Capacitor.isNativePlatform());

/* ============================================================
   AUDIO
   ============================================================ */
const Snd = {
  ac: null, master: null, droneGain: null, droneFilter: null, noise: null,
  muted: lsGet('singularity.muted', '0') === '1',

  ensure() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = this.ac = new AC();

    const master = this.master = ac.createGain();
    master.gain.value = this.muted ? 0 : 0.85;
    master.connect(ac.destination);

    const len = Math.floor(ac.sampleRate * 0.5);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    this.noise = buf;

    const dg = this.droneGain = ac.createGain();
    dg.gain.value = 0;
    const df = this.droneFilter = ac.createBiquadFilter();
    df.type = 'lowpass'; df.frequency.value = 200; df.Q.value = 5;
    dg.connect(df); df.connect(master);

    [[55, 'sawtooth', 0.16], [55.7, 'sawtooth', 0.15], [82.5, 'sine', 0.10]]
      .forEach(([f, type, g]) => {
        const o = ac.createOscillator();
        o.type = type; o.frequency.value = f;
        const gg = ac.createGain(); gg.gain.value = g;
        o.connect(gg); gg.connect(dg); o.start();
      });
  },

  tone(freq, type, peak, attack, decay) {
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + decay + 0.02);
  },

  // rising pentatonic blip — the main dopamine lever
  blip(step) {
    if (!this.ac || this.muted) return;
    const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34, 36];
    const semi = SCALE[Math.min(step, SCALE.length - 1)];
    this.tone(196 * Math.pow(2, semi / 12), 'triangle', 0.20, 0.008, 0.20);
  },

  // short filtered noise — rock breaking apart
  crunch() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = this.noise;
    s.playbackRate.value = 1.9;
    const f = ac.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = 1400; f.Q.value = 1.1;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.30, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 0.15);
  },

  nova() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(1500, t + 0.5);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.72);
    this.boom();
  },

  thud() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = this.noise;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 0.36);

    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.30);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(og); og.connect(this.master);
    o.start(t); o.stop(t + 0.34);
  },

  boom() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(420, t + 0.22);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.34, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.44);
  },

  collapse() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.0);
    const f = ac.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.0);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 1.15);
  },

  setDrone(on, c) {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    this.droneGain.gain.setTargetAtTime(on ? 0.17 : 0, t, 0.4);
    this.droneFilter.frequency.setTargetAtTime(180 + Math.min(c, 40) * 24, t, 0.12);
  }
};

/* ============================================================
   CELESTIAL BODY SPRITES
   Each (type, variant) is rendered once into a 128px canvas.
   ============================================================ */
const SPR = 128, SPR_R = SPR / 2;
const VARIANTS = 4;

// Edible worlds and rubble.
const EDIBLE = ['rocky', 'ice', 'ocean', 'desert', 'barren', 'asteroid'];
// Things that will kill you.
const LETHAL = ['star', 'giant', 'lava', 'rogue', 'rival'];

const PLANET_PAL = {
  rocky:  { hi: '#8a7659', mid: '#6b5b4a', lo: '#3a3128', spot: '#4a4034' },
  ice:    { hi: '#eaf7ff', mid: '#bfe6f5', lo: '#6d9db5', spot: '#ffffff' },
  ocean:  { hi: '#3f9ad1', mid: '#1c5f9e', lo: '#0d3a68', spot: '#2f7a45' },
  desert: { hi: '#d9905f', mid: '#b5643c', lo: '#6b3620', spot: '#8c4a2b' },
  barren: { hi: '#9a9a95', mid: '#71716c', lo: '#43433f', spot: '#5a5a55' },
  lava:   { hi: '#ff8a3a', mid: '#5a2418', lo: '#1a0a08', spot: '#ff5a1a' },
  giant:  { hi: '#e8d3ae', mid: '#c9a678', lo: '#8d6f4e', spot: '#a8543a' },
  rogue:  { hi: '#6b5f7a', mid: '#463c52', lo: '#241d2c', spot: '#372f42' }
};

function blobs(g, rnd, col, n, rmin, rmax, alpha) {
  g.globalAlpha = alpha;
  g.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, d = Math.sqrt(rnd()) * SPR_R * 0.9;
    const rr = rmin + rnd() * (rmax - rmin);
    g.beginPath();
    g.ellipse(SPR_R + Math.cos(a) * d, SPR_R + Math.sin(a) * d,
              rr, rr * (0.55 + rnd() * 0.6), rnd() * TAU, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}

function craters(g, rnd, n, maxR) {
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, d = Math.sqrt(rnd()) * SPR_R * 0.86;
    const x = SPR_R + Math.cos(a) * d, y = SPR_R + Math.sin(a) * d;
    const rr = 1.5 + rnd() * maxR;
    g.fillStyle = 'rgba(0,0,0,0.34)';
    g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.beginPath(); g.arc(x - rr * 0.25, y - rr * 0.25, rr * 0.7, 0, TAU); g.fill();
  }
}

function bands(g, rnd, cols, alphaLo) {
  let y = -4;
  while (y < SPR) {
    const h = 3 + rnd() * 10;
    g.fillStyle = cols[(rnd() * cols.length) | 0];
    g.globalAlpha = alphaLo + rnd() * 0.35;
    const ph = rnd() * 6;
    g.beginPath();
    g.moveTo(-2, y);
    for (let x = -2; x <= SPR + 2; x += 7) g.lineTo(x, y + Math.sin(x * 0.055 + ph) * 2.6);
    for (let x = SPR + 2; x >= -2; x -= 7) g.lineTo(x, y + h + Math.sin(x * 0.055 + ph) * 2.6);
    g.closePath(); g.fill();
    y += h * 0.92;
  }
  g.globalAlpha = 1;
}

function fissures(g, rnd, n, col, glow) {
  g.globalCompositeOperation = glow ? 'lighter' : 'source-over';
  g.strokeStyle = col;
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    let x = rnd() * SPR, y = rnd() * SPR;
    let a = rnd() * TAU;
    g.lineWidth = 0.7 + rnd() * 2.1;
    g.beginPath(); g.moveTo(x, y);
    const segs = 3 + ((rnd() * 4) | 0);
    for (let s = 0; s < segs; s++) {
      a += (rnd() - 0.5) * 1.5;
      x += Math.cos(a) * (4 + rnd() * 12);
      y += Math.sin(a) * (4 + rnd() * 12);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
}

function polarCaps(g, rnd, col) {
  g.globalAlpha = 0.75; g.fillStyle = col;
  g.beginPath(); g.ellipse(SPR_R, 1, SPR_R * 0.92, SPR_R * (0.13 + rnd() * 0.1), 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(SPR_R, SPR - 1, SPR_R * 0.92, SPR_R * (0.13 + rnd() * 0.1), 0, 0, TAU); g.fill();
  g.globalAlpha = 1;
}

function drawAsteroid(g, rnd) {
  // Irregular silhouette rather than a perfect circle.
  const N = 9 + ((rnd() * 4) | 0);
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const rr = SPR_R * (0.70 + rnd() * 0.30);
    pts.push([SPR_R + Math.cos(a) * rr, SPR_R + Math.sin(a) * rr]);
  }
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i <= N; i++) {
    const [x, y] = pts[i % N];
    const [px, py] = pts[i - 1];
    g.quadraticCurveTo(px, py, (x + px) / 2, (y + py) / 2);
  }
  g.closePath();
  const grd = g.createLinearGradient(0, 0, SPR, SPR);
  grd.addColorStop(0, '#8b8175');
  grd.addColorStop(0.5, '#5f574d');
  grd.addColorStop(1, '#37322c');
  g.fillStyle = grd; g.fill();
  g.save(); g.clip();
  craters(g, rnd, 7 + ((rnd() * 6) | 0), SPR_R * 0.16);
  blobs(g, rnd, '#000000', 5, 2, 7, 0.14);
  g.restore();
}

function drawStar(g, rnd) {
  // Self-luminous: limb-darkened core, granulation, a couple of spots.
  const warm = rnd() < 0.5;
  const c1 = warm ? '#fff6d8' : '#eaf4ff';
  const c2 = warm ? '#ffcf5c' : '#bcd8ff';
  const c3 = warm ? '#ff7a1e' : '#6f9dff';
  const grd = g.createRadialGradient(SPR_R * 0.82, SPR_R * 0.78, SPR_R * 0.05,
                                     SPR_R, SPR_R, SPR_R);
  grd.addColorStop(0, c1);
  grd.addColorStop(0.45, c2);
  grd.addColorStop(0.86, c3);
  grd.addColorStop(1, warm ? '#c04a08' : '#2c47a8');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();

  g.save();
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.clip();
  g.globalCompositeOperation = 'lighter';
  blobs(g, rnd, c1, 26, 2, 8, 0.22);
  g.globalCompositeOperation = 'source-over';
  blobs(g, rnd, '#7a2f06', 4, 2.5, 6, 0.34);
  g.restore();
}

function drawPlanet(g, rnd, type) {
  const pal = PLANET_PAL[type] || PLANET_PAL.rocky;
  const grd = g.createLinearGradient(0, 0, 0, SPR);
  grd.addColorStop(0, pal.lo);
  grd.addColorStop(0.42, pal.mid);
  grd.addColorStop(1, pal.lo);
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();

  g.save();
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.clip();

  if (type === 'giant' || type === 'rogue') {
    bands(g, rnd, [pal.hi, pal.mid, pal.lo, pal.spot], 0.5);
    blobs(g, rnd, pal.spot, 3, 4, 13, 0.5);
    if (rnd() < 0.6) {                       // great storm
      g.globalAlpha = 0.8; g.fillStyle = pal.spot;
      g.beginPath();
      g.ellipse(SPR_R * 1.34, SPR_R * 1.22, SPR_R * 0.26, SPR_R * 0.14, 0.25, 0, TAU);
      g.fill(); g.globalAlpha = 1;
    }
  } else if (type === 'ice') {
    blobs(g, rnd, pal.hi, 14, 4, 16, 0.4);
    fissures(g, rnd, 10, 'rgba(255,255,255,0.55)', false);
    polarCaps(g, rnd, '#f2fbff');
  } else if (type === 'lava') {
    blobs(g, rnd, pal.lo, 16, 5, 18, 0.5);
    fissures(g, rnd, 16, pal.spot, true);
    blobs(g, rnd, '#ffb04a', 8, 1.5, 5, 0.7);
  } else if (type === 'ocean') {
    blobs(g, rnd, pal.spot, 7, 6, 20, 0.75);   // continents
    blobs(g, rnd, pal.hi, 12, 5, 16, 0.35);    // shallows
    blobs(g, rnd, '#ffffff', 9, 4, 14, 0.30);  // cloud
    polarCaps(g, rnd, '#e8f6ff');
  } else if (type === 'desert') {
    blobs(g, rnd, pal.spot, 12, 5, 18, 0.45);
    fissures(g, rnd, 6, 'rgba(60,26,12,0.5)', false);
    blobs(g, rnd, '#e8b78d', 6, 6, 16, 0.22);
  } else if (type === 'barren') {
    craters(g, rnd, 20, SPR_R * 0.14);
    blobs(g, rnd, pal.spot, 8, 3, 11, 0.35);
  } else {                                     // rocky
    blobs(g, rnd, pal.spot, 10, 6, 20, 0.55);
    craters(g, rnd, 9 + ((rnd() * 7) | 0), SPR_R * 0.12);
    blobs(g, rnd, pal.hi, 6, 3, 10, 0.28);
  }
  g.restore();
}

// A rival singularity — a real black hole with its own accretion disk.
// It is the most dangerous thing in the field and it pulls you in.
function drawRival(g) {
  g.fillStyle = '#000';
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.60, 0, TAU); g.fill();
  g.globalCompositeOperation = 'lighter';
  const grd = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.58, SPR_R, SPR_R, SPR_R);
  grd.addColorStop(0.00, 'rgba(255,214,150,0.95)');
  grd.addColorStop(0.22, 'rgba(255,140,70,0.70)');
  grd.addColorStop(0.62, 'rgba(210,80,50,0.22)');
  grd.addColorStop(1.00, 'rgba(180,60,40,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
  g.strokeStyle = 'rgba(255,236,205,0.95)';
  g.lineWidth = 2.2;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.63, 0, TAU); g.stroke();
}

function makeBodySprite(type, variant) {
  const c = document.createElement('canvas');
  c.width = c.height = SPR;
  const g = c.getContext('2d');
  const rnd = mulberry32(type.length * 7919 + type.charCodeAt(0) * 331 +
                         variant * 104729 + 17);
  if (type === 'asteroid') drawAsteroid(g, rnd);
  else if (type === 'star') drawStar(g, rnd);
  else if (type === 'rival') drawRival(g);
  else drawPlanet(g, rnd, type);
  return c;
}

const bodySprites = new Map();
function bodySprite(type, variant) {
  const k = type + '#' + variant;
  let s = bodySprites.get(k);
  if (!s) {
    s = makeBodySprite(type, variant);
    // Hard ceiling: ~48 sprites at 128px is about 3 MB of canvas.
    if (bodySprites.size > 48) bodySprites.clear();
    bodySprites.set(k, s);
  }
  return s;
}

/* ---------- shared shading + glow ---------- */
let shadeSprite = null;
function buildShade() {
  const c = document.createElement('canvas');
  c.width = c.height = SPR;
  const g = c.getContext('2d');
  const lx = SPR_R + LIGHT.x * SPR_R * 0.5, ly = SPR_R + LIGHT.y * SPR_R * 0.5;
  const grd = g.createRadialGradient(lx, ly, SPR_R * 0.06, SPR_R, SPR_R, SPR_R * 1.02);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.12)');
  grd.addColorStop(0.34, 'rgba(0,0,0,0)');
  grd.addColorStop(0.70, 'rgba(0,0,0,0.30)');
  grd.addColorStop(1.00, 'rgba(0,0,0,0.80)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  shadeSprite = c;
}

const glowCache = new Map();
function glowSprite(hue) {
  const key = Math.round(hue / 24) * 24;
  if (glowCache.has(key)) return glowCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0.00, `hsla(${key}, 100%, 74%, 1)`);
  grd.addColorStop(0.22, `hsla(${key}, 100%, 62%, 0.55)`);
  grd.addColorStop(0.55, `hsla(${key}, 100%, 55%, 0.14)`);
  grd.addColorStop(1.00, `hsla(${key}, 100%, 50%, 0)`);
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  glowCache.set(key, c);
  return c;
}

let starLayers = [];
function buildStars() {
  starLayers = [
    { tile: 180, par: 0.16, n: 30, maxR: 0.9, a: 0.30 },
    { tile: 250, par: 0.42, n: 18, maxR: 1.3, a: 0.45 },
    { tile: 340, par: 0.80, n: 10, maxR: 2.0, a: 0.62 }
  ].map((cfg) => {
    const px = Math.round(cfg.tile * DPR);
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    for (let i = 0; i < cfg.n; i++) {
      const x = Math.random() * px, y = Math.random() * px;
      const r = (Math.random() * cfg.maxR + 0.35) * DPR;
      const a = Math.random() * cfg.a + 0.22;
      g.fillStyle = `rgba(198,228,255,${a})`;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    return Object.assign({}, cfg, { pattern: ctx.createPattern(c, 'repeat') });
  });
}

let vignette = null;
function buildVignette() {
  const g = ctx.createRadialGradient(W / 2, H / 2, MIN * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.72)');
  vignette = g;
}

let nebula = null, nebulaHue = -999;
function getNebula(hue) {
  if (Math.abs(hue - nebulaHue) < 3) return nebula;
  const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.85);
  g.addColorStop(0.00, `hsl(${hue}, 60%, 9%)`);
  g.addColorStop(0.45, `hsl(${(hue + 28) % 360}, 56%, 6%)`);
  g.addColorStop(1.00, `hsl(${(hue + 52) % 360}, 50%, 3%)`);
  nebula = g; nebulaHue = hue;
  return g;
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  MIN = Math.min(W, H);
  cvs.width = Math.round(W * DPR);
  cvs.height = Math.round(H * DPR);
  buildStars();
  buildVignette();
  nebulaHue = -999;
}

/* ============================================================
   GAME LOGIC
   ============================================================ */
function difficulty() { return state === 'play' ? clamp(elapsed / 80, 0, 1) : 0; }
function comboMult() { return Math.min(1 + combo * 0.08, 8); }
function viewWorldRadius() { return Math.hypot(W, H) * 0.5 / cam.zoom; }

function desiredZoom() {
  const grow = p.r / P0;
  const visR = P0 * 8 * Math.pow(grow, 0.78);
  let z = (MIN * 0.5) / visR;
  const sr = p.r * z;
  if (sr > 54) z = 54 / p.r;
  if (sr < 22) z = 22 / p.r;
  return z;
}

function pickRadius() {
  const d = difficulty();
  const q = Math.random();
  if (q < 0.50) return p.r * rand(0.09, 0.30);
  if (q < 0.78) return p.r * rand(0.30, 0.72);
  if (q < 0.78 + 0.18 * (1 - 0.6 * d)) return p.r * rand(0.72, 0.94);
  return p.r * rand(1.05, 1.55 + 1.15 * d);
}

// Colour IS the difficulty language: cool = edible, warm = lethal.
function entHue(ratio) {
  if (ratio <= 0.95) return 188 + clamp(ratio / 0.95, 0, 1) * 82;
  return 44 - clamp((ratio - 0.95) / 0.9, 0, 1) * 44;
}

// Type follows edibility so the fantasy stays coherent: worlds and rubble are
// food, stars and giants are not. The rim colour remains authoritative,
// because a body's edibility changes as you grow or shrink.
function assignBody(e) {
  const lethal = e.r > p.r * 0.95;
  const q = Math.random();
  let type, spin;

  if (!lethal && q < 0.30) { type = 'asteroid'; spin = rand(-2.6, 2.6); }
  else if (lethal && q < 0.42) { type = 'star'; spin = rand(-0.22, 0.22); }
  else {
    const pool = lethal ? LETHAL : EDIBLE;
    type = pool[(Math.random() * pool.length) | 0];
    if (type === 'asteroid') type = 'barren';      // belt handled separately
    spin = rand(-0.75, 0.75);
  }
  e.body = { type, variant: (Math.random() * VARIANTS) | 0, spin };
}

// Asteroids travel in families.
function spawnBelt() {
  const v = viewWorldRadius();
  const a = Math.random() * TAU;
  const dist = rand(v * 1.2, v * 1.6);
  const bx = p.x + Math.cos(a) * dist, by = p.y + Math.sin(a) * dist;
  const n = 4 + ((Math.random() * 5) | 0);
  for (let i = 0; i < n; i++) {
    const ra = Math.random() * TAU, rd = Math.random() * p.r * 3.2;
    const spin = rand(-2.8, 2.8);
    ents.push({
      x: bx + Math.cos(ra) * rd, y: by + Math.sin(ra) * rd,
      vx: rand(-0.05, 0.05) * p.r, vy: rand(-0.05, 0.05) * p.r,
      r: p.r * rand(0.10, 0.34),
      spin, phase: Math.random() * TAU,
      body: { type: 'asteroid', variant: (Math.random() * VARIANTS) | 0, spin }
    });
  }
}

function spawnComet() {
  const v = viewWorldRadius();
  const a = Math.random() * TAU;
  const dist = v * 1.5;
  const speed = rand(1.6, 3.2) * p.r;
  const spin = rand(-1, 1);
  // Comets cross the field rather than homing in. They are a bonus you have
  // to go and intercept, not food delivered free to a stationary player --
  // otherwise idling would out-earn the entropy decay.
  const inward = rand(0.20, 0.55);
  const cross = rand(0.8, 1.4) * (Math.random() < 0.5 ? -1 : 1);
  ents.push({
    x: p.x + Math.cos(a) * dist, y: p.y + Math.sin(a) * dist,
    vx: (-Math.cos(a) * inward - Math.sin(a) * cross) * speed,
    vy: (-Math.sin(a) * inward + Math.cos(a) * cross) * speed,
    r: p.r * rand(0.22, 0.40),
    spin, phase: Math.random() * TAU,
    body: { type: 'ice', variant: (Math.random() * VARIANTS) | 0, spin },
    comet: { life: 0, max: rand(11, 18) }
  });
}

function reset() {
  p = { x: 0, y: 0, vx: 0, vy: 0, r: P0, area: P0 * P0 };
  ents = []; parts = []; waves = []; shots = [];
  cam = { x: 0, y: 0, zoom: 1 };
  score = 0; shownScore = 0; combo = 0; comboT = 0;
  elapsed = 0; era = 0; shakeMag = 0; hitstopT = 0; invuln = 0;
  flashT = 0; toastT = 0; shotT = 5;
  pointer.active = false; pointer.x = W / 2; pointer.y = H / 2;
  for (let i = 0; i < ENT_TARGET; i++) spawn(Math.random() < 0.5 ? 1.15 : 1.7);
  cam.zoom = desiredZoom();
}

function spawn(scaleMul) {
  const v = viewWorldRadius();
  const a = Math.random() * TAU;
  const dist = rand(v * 1.14, v * (scaleMul || 1.7));
  const e = {
    x: p.x + Math.cos(a) * dist,
    y: p.y + Math.sin(a) * dist,
    vx: rand(-0.12, 0.12) * p.r,
    vy: rand(-0.12, 0.12) * p.r,
    r: pickRadius(),
    spin: 0,
    phase: Math.random() * TAU
  };
  assignBody(e);
  e.spin = e.body.spin;
  ents.push(e);
}

function addPart(o) {
  if (parts.length >= 460) parts.splice(0, 48);
  parts.push(o);
}

function absorbFx(e) {
  const n = clamp(Math.round(e.r * 0.5) + 3, 3, 18);
  const tx = e.x - p.x, ty = e.y - p.y;
  const d = Math.hypot(tx, ty) || 1;
  const hue = entHue(e.r / p.r);
  // Matter spirals in rather than falling straight: add a tangential kick.
  const nx = -ty / d, ny = tx / d;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(0.5, 1.9) * p.r;
    addPart({
      x: e.x + Math.cos(a) * e.r * 0.7,
      y: e.y + Math.sin(a) * e.r * 0.7,
      vx: -tx / d * sp * 0.55 + nx * sp * 0.85 + Math.cos(a) * sp * 0.4,
      vy: -ty / d * sp * 0.55 + ny * sp * 0.85 + Math.sin(a) * sp * 0.4,
      life: 0, max: rand(0.28, 0.6),
      r: rand(0.06, 0.2) * p.r + 0.8,
      hue, mode: 0
    });
  }
}

function burstFx(x, y, n, spread, scale) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(0.6, 2.4) * (spread || p.r) * 1.4 * (scale || 1);
    addPart({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0, max: rand(0.35, 0.9),
      r: rand(0.08, 0.26) * p.r + 1,
      hue: rand(180, 300), mode: 1
    });
  }
}

const ERAS = ['NEBULA', 'PROTOSTAR', 'MAIN SEQUENCE', 'RED GIANT',
              'SUPERNOVA', 'QUASAR', 'SINGULARITY'];

function toast(msg, dur) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  toastT = dur || 1.9;
}

function consume(e, idx) {
  const wasStar = e.body && e.body.type === 'star';

  p.area += e.r * e.r * CONSUME_YIELD;
  p.r = Math.sqrt(p.area);
  combo++;
  comboT = COMBO_WINDOW;

  let gained = Math.max(1, Math.round(e.r * 0.42 * comboMult()));
  if (wasStar) gained *= STAR_BONUS;
  score += gained;

  absorbFx(e);
  if (e.body && e.body.type === 'asteroid') Snd.crunch();
  else Snd.blip(combo - 1);
  Snd.setDrone(true, combo);
  ents.splice(idx, 1);

  if (wasStar) {
    supernova(e.x, e.y, e.r);
    toast('STAR CONSUMED  +' + fmt(gained));
  } else if (combo % 20 === 0) {
    pendingWave = true;
  }
  // Big things break apart visibly instead of just vanishing.
  if (e.r > p.r * 0.55) burstFx(e.x, e.y, 14, e.r, 0.8);
}

function supernova(x, y, r) {
  waves.push({ x, y, r: r, max: r * 16, t: 0 });
  const R = r * 13;
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = e.x - x, dy = e.y - y;
    if (dx * dx + dy * dy < R * R && e.r > p.r * 0.95) {
      score += Math.round(e.r * 0.5 * comboMult());
      burstFx(e.x, e.y, 10, e.r, 1);
      ents.splice(i, 1);
    }
  }
  burstFx(x, y, 46, r * 1.6, 1.4);
  shakeMag = Math.max(shakeMag, 26);
  flashT = Math.max(flashT, 0.34);
  Snd.nova();
}

function hurt(e) {
  const type = e.body && e.body.type;
  const prof = (type && IMPACT[type]) || IMPACT_DEFAULT;

  p.area *= (1 - prof.frac);
  p.r = Math.sqrt(p.area);

  const dx = p.x - e.x, dy = p.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  p.vx = dx / d * prof.knock * p.r;
  p.vy = dy / d * prof.knock * p.r;
  e.vx -= dx / d * p.r * 1.6;
  e.vy -= dy / d * p.r * 1.6;

  // A rival swallows light and time: longer invulnerability or you would be
  // shredded inside its well.
  invuln = prof.flash ? 1.9 : 1.15;
  combo = 0; comboT = 0;
  shakeMag = Math.max(shakeMag, 12 + prof.frac * 46);
  hitstopT = Math.max(hitstopT, 0.09);
  if (prof.flash) flashT = Math.max(flashT, 0.30);
  if (prof.burn) flashT = Math.max(flashT, 0.16);

  if (prof.burn) burstFx(e.x, e.y, 36, e.r * 0.8, 1.2);
  else if (prof.gas) burstFx(e.x, e.y, 30, e.r * 0.9, 1.1);
  else burstFx(p.x, p.y, 26, p.r, 1);

  Snd.thud();
  Snd.setDrone(true, 0);
  if (prof.msg) toast(prof.msg, 1.6);
}

function shockwave() {
  const R = p.r * 13;
  waves.push({ x: p.x, y: p.y, r: p.r, max: R, t: 0 });
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy < R * R && e.r > p.r * 0.95) {
      score += Math.round(e.r * 0.5 * comboMult());
      burstFx(e.x, e.y, 10, e.r, 1);
      ents.splice(i, 1);
    }
  }
  shakeMag = Math.max(shakeMag, 12);
  Snd.boom();
}

function die() {
  state = 'dead';
  Snd.collapse();
  Snd.setDrone(false, 0);
  shakeMag = Math.max(shakeMag, 28);
  flashT = Math.max(flashT, 0.25);
  burstFx(p.x, p.y, 70, p.r, 1.6);

  newBest = commitBest();
  hide(el.hud);
  el.finalScore.textContent = fmt(score);
  el.overBest.textContent = 'BEST ' + fmt(best);
  el.newBest.classList.toggle('hidden', !newBest);
  show(el.over);
  if (el.toast) el.toast.classList.remove('show');
}

function currentTarget() {
  if (pointer.active) {
    return {
      x: (pointer.x - W / 2) / cam.zoom + cam.x,
      y: (pointer.y - H / 2) / cam.zoom + cam.y
    };
  }
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (dx || dy) {
    const m = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / m * 220, y: p.y + dy / m * 220 };
  }
  return { x: p.x, y: p.y };
}

function update(dt) {
  if (state === 'paused') return;      // frozen; render still draws the frame
  elapsed += dt;
  const prevEra = era;
  era = Math.floor(score / 1200);
  if (era !== prevEra && era > 0) toast(ERAS[era % ERAS.length]);

  if (toastT > 0) {
    toastT -= dt;
    if (toastT <= 0 && el.toast) el.toast.classList.remove('show');
  }
  if (flashT > 0) flashT = Math.max(0, flashT - dt * 2.2);

  cam.zoom = lerp(cam.zoom, desiredZoom(), smooth(0.02, dt));
  const follow = smooth(0.0008, dt);
  cam.x = lerp(cam.x, p.x, follow);
  cam.y = lerp(cam.y, p.y, follow);

  if (state === 'play') {
    const t = currentTarget();
    const dx = t.x - p.x, dy = t.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const maxV = 11 * p.r;
    const wantV = Math.min(maxV, dist * 7);
    const k = smooth(0.0006, dt);
    p.vx = lerp(p.vx, dx / dist * wantV, k);
    p.vy = lerp(p.vy, dy / dist * wantV, k);
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const decay = 0.0015 + 0.0026 * clamp((p.r / P0 - 1) / 8, 0, 1);
    p.area = Math.max(1, p.area - p.area * decay * dt);
    p.r = Math.sqrt(p.area);

    if (comboT > 0) { comboT -= dt; if (comboT <= 0) combo = 0; }
    if (invuln > 0) invuln -= dt;

    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      const ddx = e.x - p.x, ddy = e.y - p.y;
      const reach = p.r + e.r * 0.5;
      if (ddx * ddx + ddy * ddy < reach * reach) {
        if (e.r <= p.r * 0.95) consume(e, i);
        else if (invuln <= 0) hurt(e);
      }
    }
    if (pendingWave) { pendingWave = false; shockwave(); }
    if (p.area < DEATH_AREA) die();
  }

  updateEnts(dt);
  updateParts(dt);
  updateWaves(dt);
  updateShots(dt);

  if (shakeMag > 0) shakeMag = Math.max(0, shakeMag - shakeMag * 7 * dt - 0.5 * dt);
}

function updateEnts(dt) {
  const need = ENT_TARGET - ents.length;
  if (need > 0) {
    for (let i = 0; i < Math.min(need, 6); i++) {
      const q = Math.random();
      if (q < 0.10) spawnBelt();
      else if (q < 0.13) spawnComet();
      else spawn();
    }
  }

  const v = viewWorldRadius();
  const despawnR = v * 1.95;
  const pullR = p.r * 7;
  const edamp = Math.pow(0.12, dt);

  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = p.x - e.x, dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > despawnR * despawnR) { ents.splice(i, 1); continue; }

    // Rival singularities drag YOU in as well. That is what separates them
    // from every other big body: you cannot just drift past one.
    if (e.body && e.body.type === 'rival' && state === 'play') {
      const d = Math.sqrt(d2) || 1;
      // Kept deliberately local. Any wider and a rival becomes a field-wide
      // tractor beam that tows a passive player around the map.
      const reachR = p.r * 10;
      if (d < reachR) {
        const s = (1 - d / reachR) * 6.5 * p.r * dt;
        p.vx += (-dx / d) * s;      // dx points player -> rival, so negate
        p.vy += (-dy / d) * s;
      }
    }

    if (e.comet) {
      // Comets keep their momentum; gravity barely bends them.
      e.comet.life += dt;
      if (e.comet.life > e.comet.max) { ents.splice(i, 1); continue; }
      if (state === 'play' && d2 < pullR * pullR) {
        const d = Math.sqrt(d2) || 1;
        const s = (1 - d / pullR) * 1.4 * p.r * dt;
        e.vx += dx / d * s; e.vy += dy / d * s;
      }
      const cd = Math.pow(0.75, dt);
      e.vx *= cd; e.vy *= cd;
    } else {
      if (state === 'play' && d2 < pullR * pullR) {
        const d = Math.sqrt(d2) || 1;
        const edible = e.r <= p.r * 0.95;
        const mass = (e.r * e.r) / (p.r * p.r);
        const s = (1 - d / pullR) * 3.2 * p.r * dt / (0.35 + mass * 2.2) * (edible ? 1 : 0.18);
        e.vx += dx / d * s;
        e.vy += dy / d * s;
      }
      e.vx *= edamp; e.vy *= edamp;
    }
    e.x += e.vx * dt; e.y += e.vy * dt;
    e.phase += (e.spin || 0) * dt;
  }
}

function updateParts(dt) {
  const pd = Math.pow(0.35, dt);
  for (let i = parts.length - 1; i >= 0; i--) {
    const q = parts[i];
    q.life += dt;
    if (q.life >= q.max) { parts.splice(i, 1); continue; }
    if (q.mode === 0) {
      const dx = p.x - q.x, dy = p.y - q.y;
      const d = Math.hypot(dx, dy) || 1;
      q.vx += dx / d * 26 * p.r * dt;
      q.vy += dy / d * 26 * p.r * dt;
    }
    q.vx *= pd; q.vy *= pd;
    q.x += q.vx * dt; q.y += q.vy * dt;
  }
}

function updateWaves(dt) {
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.t += dt;
    w.r += (w.max - w.r) * smooth(0.02, dt);
    if (w.t > 0.85) waves.splice(i, 1);
  }
}

// Occasional background meteor — pure atmosphere.
function updateShots(dt) {
  shotT -= dt;
  if (shotT <= 0) {
    shotT = rand(5, 13);
    const a = rand(-0.7, 0.3);
    shots.push({
      x: rand(-0.1, 0.9) * W, y: rand(-0.1, 0.5) * H,
      vx: Math.cos(a) * rand(500, 900), vy: Math.sin(a) * rand(500, 900),
      life: 0, max: rand(0.5, 0.9), len: rand(60, 160)
    });
  }
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.life += dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.life >= s.max) shots.splice(i, 1);
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = getNebula((210 + era * 24) % 360);
  ctx.fillRect(0, 0, W, H);

  drawStars();
  drawShots();

  let sx = 0, sy = 0;
  if (motion && shakeMag > 0.2) { sx = rand(-shakeMag, shakeMag); sy = rand(-shakeMag, shakeMag); }

  ctx.save();
  ctx.translate(W / 2 + sx, H / 2 + sy);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  drawEnts();
  drawWaves();
  drawParts();
  if (state !== 'dead') drawPlayer();

  ctx.restore();

  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  if (flashT > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,246,224,${(flashT * 0.55).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawStars() {
  for (const L of starLayers) {
    const T = L.tile;
    const ox = mod(-cam.x * L.par * cam.zoom, T);
    const oy = mod(-cam.y * L.par * cam.zoom, T);
    ctx.save();
    ctx.scale(1 / DPR, 1 / DPR);
    ctx.translate((ox - T) * DPR, (oy - T) * DPR);
    ctx.fillStyle = L.pattern;
    ctx.fillRect(0, 0, (W + 2 * T) * DPR, (H + 2 * T) * DPR);
    ctx.restore();
  }
}

function drawShots() {
  ctx.globalCompositeOperation = 'lighter';
  for (const s of shots) {
    const k = 1 - s.life / s.max;
    const d = Math.hypot(s.vx, s.vy) || 1;
    const tx = s.x - s.vx / d * s.len, ty = s.y - s.vy / d * s.len;
    const g = ctx.createLinearGradient(s.x, s.y, tx, ty);
    g.addColorStop(0, `rgba(210,240,255,${(k * 0.85).toFixed(3)})`);
    g.addColorStop(1, 'rgba(210,240,255,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tx, ty); ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawEnts() {
  for (const e of ents) {
    const ratio = e.r / p.r;
    const hue = entHue(ratio);
    const scr = e.r * cam.zoom;          // on-screen radius, CSS px
    const b = e.body;

    // Glow carries the threat colour, so it reads before the surface does.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55;
    const gs = e.r * 2.3;
    ctx.drawImage(glowSprite(hue), e.x - gs, e.y - gs, gs * 2, gs * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Too small on screen to be worth detailing.
    if (scr < 1.6 || !b) {
      ctx.fillStyle = `hsl(${hue}, 92%, 64%)`;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, TAU); ctx.fill();
      continue;
    }

    if (e.comet) drawCometTail(e, hue);

    // Surface: pre-rendered once, blitted with rotation.
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.phase);
    ctx.drawImage(bodySprite(b.type, b.variant), -e.r, -e.r, e.r * 2, e.r * 2);
    ctx.restore();

    // Fixed light direction; stars are self-lit so they skip this.
    if (b.type !== 'star' && scr > 3) {
      ctx.drawImage(shadeSprite, e.x - e.r, e.y - e.r, e.r * 2, e.r * 2);
    }

    // Atmospheric rim — the authoritative edibility cue.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `hsla(${hue}, 100%, ${ratio > 0.95 ? 66 : 84}%, 0.85)`;
    ctx.lineWidth = Math.max(0.6, e.r * 0.09);
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.99, 0, TAU); ctx.stroke();

    // Lethal bodies get a second, pulsing warning ring.
    if (ratio > 0.95) {
      const pulse = 0.35 + 0.35 * Math.sin(elapsed * 5 + e.phase);
      ctx.strokeStyle = `hsla(${hue}, 100%, 70%, ${pulse.toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, e.r * 0.05);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 1.16, 0, TAU); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawCometTail(e, hue) {
  const d = Math.hypot(e.vx, e.vy) || 1;
  const ux = -e.vx / d, uy = -e.vy / d;
  const len = e.r * (7 + Math.sin(elapsed * 3 + e.phase) * 1.5);
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(e.x, e.y, e.x + ux * len, e.y + uy * len);
  g.addColorStop(0, `hsla(${hue}, 100%, 82%, 0.55)`);
  g.addColorStop(1, `hsla(${hue}, 100%, 70%, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(e.x - uy * e.r * 0.5, e.y + ux * e.r * 0.5);
  ctx.lineTo(e.x + ux * len, e.y + uy * len);
  ctx.lineTo(e.x + uy * e.r * 0.5, e.y - ux * e.r * 0.5);
  ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

function drawPlayer() {
  const r = p.r;
  const t = elapsed;
  const hue = (192 + era * 24) % 360;

  // Halo swells with the combo.
  ctx.globalCompositeOperation = 'lighter';
  const gs = r * 5.2;
  ctx.globalAlpha = 0.5 + Math.min(combo, 30) * 0.012;
  ctx.drawImage(glowSprite(hue), p.x - gs, p.y - gs, gs * 2, gs * 2);
  ctx.globalAlpha = 1;

  // Accretion arcs spin faster and brighter the hotter the chain is.
  const heat = clamp(combo / 40, 0, 1);
  for (let i = 0; i < 3; i++) {
    const rr = r * (1.35 + i * 0.34);
    const a0 = t * (1.4 - i * 0.32) * (1 + heat * 1.6) + i * 2.1;
    ctx.strokeStyle = `hsla(${(hue + i * 26) % 360}, 100%, ${68 - i * 6}%, ${0.5 - i * 0.11 + heat * 0.25})`;
    ctx.lineWidth = Math.max(1, r * 0.14);
    ctx.beginPath(); ctx.arc(p.x, p.y, rr, a0, a0 + 2.2 + i * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, rr, a0 + Math.PI, a0 + Math.PI + 1.5); ctx.stroke();
  }
  for (let i = 0; i < 7; i++) {          // orbiting sparks
    const a = t * 2.1 + i * TAU / 7;
    const rr = r * (1.5 + (i % 3) * 0.22);
    ctx.fillStyle = `hsla(${(hue + 40) % 360}, 100%, 78%, 0.8)`;
    ctx.beginPath();
    ctx.arc(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, Math.max(0.8, r * 0.07), 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  ctx.fillStyle = '#000';                // event horizon
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();

  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = `hsla(${(hue + 20) % 360}, 100%, 88%, ${0.35 + heat * 0.4})`;
  ctx.lineWidth = Math.max(0.8, r * 0.05);
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.13, 0, TAU); ctx.stroke();  // lensing

  ctx.strokeStyle = (invuln > 0 && Math.floor(invuln * 18) % 2 === 0)
    ? 'rgba(255,255,255,0.95)'
    : `hsla(${hue}, 100%, 76%, 0.9)`;
  ctx.lineWidth = Math.max(1, r * 0.10);
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.02, 0, TAU); ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

function drawParts() {
  ctx.globalCompositeOperation = 'lighter';
  for (const q of parts) {
    const k = 1 - q.life / q.max;
    ctx.globalAlpha = k;
    ctx.fillStyle = `hsl(${q.hue}, 100%, ${62 + k * 22}%)`;
    ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (0.4 + k * 0.8), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawWaves() {
  ctx.globalCompositeOperation = 'lighter';
  for (const w of waves) {
    const k = 1 - w.t / 0.85;
    ctx.strokeStyle = `hsla(190, 100%, 74%, ${k * 0.7})`;
    ctx.lineWidth = Math.max(1.5, w.max * 0.03 * k);
    ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, TAU); ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ============================================================
   HUD + LOOP
   ============================================================ */
function updateHUD() {
  shownScore = lerp(shownScore, score, 0.18);
  if (Math.abs(shownScore - score) < 0.6) shownScore = score;
  el.hudScore.textContent = fmt(Math.round(shownScore));
  el.hudBest.textContent = fmt(best);

  const on = combo >= 3 && comboT > 0;
  el.comboWrap.classList.toggle('on', on);
  if (on) {
    el.comboValue.textContent = 'COMBO ' + combo + '  ×' + comboMult().toFixed(1);
    el.comboBar.firstElementChild.style.transform =
      'scaleX(' + (comboT / COMBO_WINDOW).toFixed(3) + ')';
  }
}

let last = 0;
function frame(now) {
  const real = Math.min((now - last) / 1000, 0.05);
  last = now;
  let dt = real;
  if (hitstopT > 0) { hitstopT -= real; dt = real * 0.18; }
  update(dt);
  render();
  updateHUD();
  requestAnimationFrame(frame);
}

/* ============================================================
   FLOW
   ============================================================ */
// Some browsers throw on AudioContext construction (autoplay policy, or a
// locked-down webview). Losing sound is fine; losing the game is not.
function ensureAudio() { try { Snd.ensure(); } catch (_) {} }

function start() {
  ensureAudio();
  reset();
  state = 'play';
  panel = null;
  hide(el.menu); hide(el.over); hide(el.pause); hide(el.settings); show(el.hud);
  Snd.setDrone(true, 0);
}

function toMenu() {
  commitBest();
  state = 'menu';
  panel = null;
  hide(el.over); hide(el.hud); hide(el.pause); hide(el.settings); show(el.menu);
  el.menuBest.textContent = best > 0 ? 'BEST ' + fmt(best) : '';
  Snd.setDrone(false, 0);
  if (el.toast) el.toast.classList.remove('show');
}

function pauseGame() {
  if (state !== 'play') return;
  state = 'paused';
  panel = 'pause';
  commitBest();
  if (el.pauseScore) el.pauseScore.textContent = 'MASS ' + fmt(score) + '   BEST ' + fmt(best);
  show(el.pause); hide(el.settings);
  Snd.setDrone(false, 0);
}

function resumeGame() {
  if (state !== 'paused') return;
  panel = null;
  state = 'play';
  hide(el.pause); hide(el.settings);
  last = performance.now();          // don't hand the sim one giant dt
  Snd.setDrone(true, combo);
}

function openSettings() {
  panel = 'settings';
  hide(el.pause); show(el.settings);
  syncSettingsUI();
}

function closeSettings() {
  panel = 'pause';
  hide(el.settings); show(el.pause);
}

function syncSettingsUI() {
  if (el.soundBtn) el.soundBtn.textContent = 'SOUND: ' + (Snd.muted ? 'OFF' : 'ON');
  if (el.motionBtn) el.motionBtn.textContent = 'MOTION: ' + (motion ? 'ON' : 'OFF');
}

/* ============================================================
   INPUT
   ============================================================ */
let dragging = false;
function setPointer(e) {
  const r = cvs.getBoundingClientRect();
  pointer.x = e.clientX - r.left;
  pointer.y = e.clientY - r.top;
  pointer.active = true;
}

cvs.addEventListener('pointerdown', (e) => {
  dragging = true;
  setPointer(e);
  ensureAudio();
  try { cvs.setPointerCapture(e.pointerId); } catch (_) {}
});
cvs.addEventListener('pointermove', (e) => { if (dragging) setPointer(e); });
cvs.addEventListener('pointerup', () => { dragging = false; pointer.active = false; });
cvs.addEventListener('pointercancel', () => { dragging = false; pointer.active = false; });

document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') keys.up = true;
  if (k === 'arrowdown' || k === 's') keys.down = true;
  if (k === 'arrowleft' || k === 'a') keys.left = true;
  if (k === 'arrowright' || k === 'd') keys.right = true;
  if (k === ' ' || k === 'enter') {
    if (state !== 'play') { e.preventDefault(); start(); }
  }
  if (k === 'escape' || k === 'p') {
    if (state === 'play') pauseGame();
    else if (state === 'paused') {
      if (panel === 'settings') closeSettings(); else resumeGame();
    }
  }
  if (k === 'm') el.muteBtn.click();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') keys.up = false;
  if (k === 'arrowdown' || k === 's') keys.down = false;
  if (k === 'arrowleft' || k === 'a') keys.left = false;
  if (k === 'arrowright' || k === 'd') keys.right = false;
});

el.playBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });
el.againBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });
el.over.addEventListener('click', () => start());

el.pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); pauseGame(); });
el.resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); resumeGame(); });
el.restartBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });
el.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
el.homeBtn.addEventListener('click', (e) => { e.stopPropagation(); toMenu(); });
el.overHomeBtn.addEventListener('click', (e) => { e.stopPropagation(); toMenu(); });
el.settingsBackBtn.addEventListener('click', (e) => { e.stopPropagation(); closeSettings(); });

function toggleMute() {
  ensureAudio();
  Snd.muted = !Snd.muted;
  lsSet('singularity.muted', Snd.muted ? '1' : '0');
  if (Snd.master) Snd.master.gain.setTargetAtTime(Snd.muted ? 0 : 0.85, Snd.ac.currentTime, 0.05);
  el.muteBtn.classList.toggle('off', Snd.muted);
  syncSettingsUI();
}

el.muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
el.soundBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });

el.motionBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  motion = !motion;
  lsSet('singularity.motion', motion ? '1' : '0');
  if (!motion) shakeMag = 0;
  syncSettingsUI();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    commitBest();
    Snd.setDrone(false, 0);
    if (state === 'play') pauseGame();     // backgrounding must not cost you
  } else {
    last = performance.now();
    if (state === 'play') Snd.setDrone(true, combo);
  }
});
// Last-ditch save if the tab or the app disappears entirely.
window.addEventListener('pagehide', commitBest);

window.addEventListener('resize', resize);

/* ============================================================
   BOOT
   ============================================================ */
// A blank black screen is the worst possible failure mode. If anything throws
// during boot, say so on screen rather than leaving the player guessing.
function fatal(msg) {
  const n = document.getElementById('fatal');
  if (!n) return;
  n.textContent = 'SINGULARITY failed to start\n\n' + msg;
  n.classList.remove('hidden');
}
window.addEventListener('error', (e) => fatal((e.error && e.error.stack) || e.message));

best = parseInt(lsGet('singularity.best', '0'), 10) || 0;
el.muteBtn.classList.toggle('off', Snd.muted);
syncSettingsUI();

try {
  buildShade();
  resize();
  reset();
  toMenu();
  requestAnimationFrame((t) => { last = t; frame(t); });
} catch (err) {
  fatal((err && err.stack) || String(err));
}

if ('serviceWorker' in navigator && !IS_NATIVE) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
