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

// Bumped on each change and shown on the menu. Stale caches have already cost
// a whole round of "your changes didn't work", so make the running build
// visible rather than guessable.
const BUILD_ID = 'b8';

// Hawking evaporation tunables. Fractional mass loss scales as 1/M^3, so a
// hole shrinks faster the smaller it gets -- correct, but it also means the
// early game is the deadliest, which is backwards for onboarding.
// HAWKING_MAX is the dial to turn down if that feels too punishing.
const HAWKING_BASE = 0.0015;
const HAWKING_MIN = 0.25;
const HAWKING_MAX = 2.0;

// What hitting something too big costs you. A star should feel catastrophic
// and rubble should barely register — one flat penalty made every collision
// feel identical no matter what you flew into.
const IMPACT = {
  // Lethal 'star' types are evolved giants, so this reads "giant", not "sun".
  star:       { frac: 0.55, knock: 13, burn: true,  msg: 'BURNED BY A GIANT' },
  giant:      { frac: 0.32, knock: 12, gas: true,   msg: 'SLAMMED INTO A GIANT' },
  uranus:     { frac: 0.30, knock: 12, gas: true,   msg: null },
  neptune:    { frac: 0.30, knock: 12, gas: true,   msg: null },
  lava:       { frac: 0.40, knock: 9,  burn: true,  msg: null },
  rogue:      { frac: 0.34, knock: 11, msg: null },
  rival:      { frac: 0.60, knock: 16, flash: true, msg: 'RIVAL SINGULARITY' },
  asteroid:   { frac: 0.12, knock: 6,  msg: null },
  comet:      { frac: 0.18, knock: 8,  msg: null },
  brownDwarf: { frac: 0.28, knock: 9,  msg: null },
  // A white dwarf is Sun-mass in an Earth volume: it hits far above its size.
  whiteDwarf: { frac: 0.45, knock: 10, flash: true, msg: 'DEGENERATE MATTER' },
  magnetar:   { frac: 0.50, knock: 14, flash: true, msg: 'MAGNETAR FIELD' },
  quasar:     { frac: 0.65, knock: 18, flash: true, msg: 'QUASAR JET' }
};
const IMPACT_DEFAULT = { frac: 0.25, knock: 9, msg: null };

/* ---------- canvas ---------- */
const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d', { alpha: false });
let W = 0, H = 0, MIN = 0, DPR = 1;

/* ---------- state ---------- */
let state = 'menu';
let p, ents, parts, waves, shots, slugs, floats, cam;
let score = 0, shownScore = 0, best = 0, newBest = false;
let combo = 0, comboT = 0, elapsed = 0, era = 0;
let shakeMag = 0, hitstopT = 0, invuln = 0, flashT = 0;
let pendingWave = false, toastT = 0, shotT = 0;
let panel = null;   // null | 'pause' | 'settings'
let camRoll = 0;    // Kerr-style frame-dragging wobble near big bodies
let shield = 0;     // one-hit protection from eating a pulsar
let kilonovaT = 0;  // countdown to the next neutron-star merger event

const pointer = { x: 0, y: 0, active: false };
const keys = { up: false, down: false, left: false, right: false };

// Virtual joystick on the lower-left. Touch-and-drag anywhere in the left
// third of the screen drives the black hole. Mouse and keyboard still work
// outside that zone (desktop users get WASD).
const JOY_R = 78;
const JOY_KNOB = 28;
const joy = { active: false, bx: 0, by: 0, kx: 0, ky: 0, dx: 0, dy: 0 };

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
  cbBtn: document.getElementById('cbBtn'),
  ctrlBtn: document.getElementById('ctrlBtn'),
  settingsBackBtn: document.getElementById('settingsBackBtn'),
  buildTag: document.getElementById('buildTag')
};

const show = (n) => n.classList.remove('hidden');
const hide = (n) => n.classList.add('hidden');
const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* ---------- persistence ---------- */
// One versioned JSON blob. A corrupt, truncated or foreign-shaped save must
// silently degrade to defaults -- it must never take the game down on boot,
// which is exactly what an unguarded JSON.parse would do.
const SAVE_KEY = 'singularity.save';
const SAVE_VER = 1;

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== SAVE_VER) return {};
    return o;
  } catch (_) {
    return {};                       // corrupt JSON -> defaults, keep playing
  }
}

let save = loadSave();

function saveSet(key, value) {
  save[key] = value;
  save.v = SAVE_VER;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (_) {}
}

// Pull an old single-key value across once, then remove it.
function migrateLegacy(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    localStorage.removeItem(key);
    return v;
  } catch (_) { return fallback; }
}

const lsGet = (k, d) => {
  const v = save[k];
  return (v === undefined || v === null) ? d : v;
};
const lsSet = saveSet;

// Migrate the pre-v1 single-key saves.
if (save.best === undefined) {
  const lb = parseInt(migrateLegacy('singularity.best', ''), 10);
  if (!isNaN(lb)) saveSet('best', lb);
}
if (save.muted === undefined) {
  saveSet('muted', migrateLegacy('singularity.muted', '0') === '1' ? '1' : '0');
}
if (save.motion === undefined) {
  saveSet('motion', migrateLegacy('singularity.motion', '1') === '1' ? '1' : '0');
}

// Best score is committed whenever a run could end, not only on death --
// quitting or backgrounding mid-run used to throw the score away entirely.
function commitBest() {
  if (score > best) { best = score; saveSet('best', best); return true; }
  return false;
}

let motion = lsGet('motion', '1') === '1';

const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                     window.Capacitor.isNativePlatform());

/* ============================================================
   AUDIO
   ============================================================ */
const Snd = {
  ac: null, master: null, droneGain: null, droneFilter: null, noise: null,
  muted: lsGet('muted', '0') === '1',

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
// Edible worlds, rubble, and sub-stellar objects. Brown dwarfs ("failed
// stars") and white dwarfs are included because they genuinely sit between
// planet and star in mass -- you could plausibly swallow one.
const EDIBLE = ['rocky', 'ice', 'ocean', 'desert', 'barren', 'asteroid',
                'uranus', 'neptune'];
// Things that will kill you. 'star' is always rendered as an evolved giant
// (red giant / supergiant / blue giant) since a main-sequence star you
// outgrow is really just... a bigger star.
const LETHAL = ['star', 'giant', 'lava', 'rogue', 'rival'];
// Rare astronomical anomalies, each with its own behaviour.
const RARE = ['pulsar', 'wormhole'];
// Neutron-star remnants with extreme fields, and active galactic nuclei.
const EXTREME = ['magnetar', 'quasar'];
// What an advanced civilisation builds once it realises the hole is coming.
// Grounded in real proposed megastructures plus the classic sci-fi answers:
//   shield     - planetary deflector dome (Star Wars / Dune house shields)
//   repulsor   - gravity-well projector, run in reverse to shove you away
//                (the Interdictor's gravity well generator, inverted)
//   driver     - mass driver / railgun battery firing matter at you
//   ark        - evacuation ship running for the edge of the map
//   extractor  - a Penrose-process station siphoning your rotational energy
const CIV = ['shield', 'repulsor', 'driver', 'ark', 'extractor'];
const CIV_ALERT = 900;        // score at which they notice you exist
const CIV_MAX = 5;            // never more than this many installations

const PLANET_PAL = {
  rocky:   { hi: '#8a7659', mid: '#6b5b4a', lo: '#3a3128', spot: '#4a4034' },
  // Europa-style: the "lineae" cracks are brown/red from salt and sulphur,
  // not white. A white-cracked ice moon is the classic get-it-wrong detail.
  ice:     { hi: '#eaf7ff', mid: '#c3dcea', lo: '#7ba3b8', spot: '#a8705a' },
  ocean:   { hi: '#3f9ad1', mid: '#1c5f9e', lo: '#0d3a68', spot: '#2f7a45' },
  desert:  { hi: '#d9905f', mid: '#b5643c', lo: '#6b3620', spot: '#8c4a2b' },
  barren:  { hi: '#9a9a95', mid: '#71716c', lo: '#43433f', spot: '#5a5a55' },
  lava:    { hi: '#ff8a3a', mid: '#5a2418', lo: '#1a0a08', spot: '#ff5a1a' },
  giant:   { hi: '#e8d3ae', mid: '#c9a678', lo: '#8d6f4e', spot: '#a8543a' },
  // Ice giants were simply missing. Uranus is nearly featureless pale cyan
  // (and is tipped 98 deg, so its bands run nearly pole-to-pole); Neptune is
  // deep blue with dark storm spots and faint banding.
  uranus:  { hi: '#dff6f3', mid: '#a9dce1', lo: '#77aeb8', spot: '#c9eff0' },
  neptune: { hi: '#5f93e3', mid: '#2c58bb', lo: '#15307c', spot: '#14255c' },
  // A rogue planet has no star. It should be cold, dark and barely lit --
  // not a purple world basking in a nonexistent sun.
  rogue:   { hi: '#4c4c55', mid: '#2c2c35', lo: '#101015', spot: '#23232b' }
};

// Real main-sequence spectral classes with their true colours and their
// actual frequency in the galaxy. M dwarfs are ~76% of all stars, so most
// stars you meet should be red -- which is the opposite of what most games
// draw.
const SPECTRAL = [
  { cls: 'M', w: 0.765,  hi: '#ffd2ad', mid: '#ff9a66', lo: '#e2603a' },
  { cls: 'K', w: 0.121,  hi: '#ffe3b8', mid: '#ffbb70', lo: '#f0913f' },
  { cls: 'G', w: 0.076,  hi: '#fff8e6', mid: '#ffdb85', lo: '#ffb64c' },
  { cls: 'F', w: 0.030,  hi: '#fffcf4', mid: '#fff3cc', lo: '#ffe596' },
  { cls: 'A', w: 0.006,  hi: '#ffffff', mid: '#eef2ff', lo: '#ccd9ff' },
  { cls: 'B', w: 0.0013, hi: '#eef3ff', mid: '#bcd4ff', lo: '#8fb4ff' },
  { cls: 'O', w: 0.000003, hi: '#dde8ff', mid: '#a8c0ff', lo: '#7f9dff' }
];

function pickSpectral(rnd) {
  let r = rnd(), acc = 0;
  for (const s of SPECTRAL) { acc += s.w; if (r < acc) return s; }
  return SPECTRAL[0];
}

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
  // Real asteroids are darker than charcoal -- typical albedo is 0.05-0.15,
// which is why they are so hard to see against space.
  const grd = g.createLinearGradient(0, 0, SPR, SPR);
  grd.addColorStop(0, '#6b6259');
  grd.addColorStop(0.5, '#423c35');
  grd.addColorStop(1, '#201d19');
  g.fillStyle = grd; g.fill();
  g.save(); g.clip();
  craters(g, rnd, 7 + ((rnd() * 6) | 0), SPR_R * 0.16);
  blobs(g, rnd, '#000000', 7, 2, 7, 0.20);
  g.restore();
}

// Main-sequence stars and evolved giants. Colour comes from the real
// spectral sequence (O B A F G K M) weighted by true galactic frequency, so
// most stars you meet are red dwarfs -- the opposite of what most games
// draw. Includes limb darkening and a granulation texture. Giants are
// distended and have much larger convection cells.
function drawStar(g, rnd, sub) {
  const giant = sub === 'redgiant' || sub === 'supergiant' || sub === 'bluegiant';
  let spec;
  if (sub === 'bluegiant') spec = SPECTRAL[5];        // B: hot, blue-white
  else if (sub === 'redgiant') spec = SPECTRAL[1];    // K: orange
  else if (sub === 'supergiant') spec = SPECTRAL[0];  // M: Betelgeuse red
  else spec = pickSpectral(rnd);

  const R = giant ? SPR_R * 0.98 : SPR_R * 0.86;
  const grd = g.createRadialGradient(SPR_R, SPR_R, R * 0.05, SPR_R, SPR_R, R);
  grd.addColorStop(0.00, spec.hi);
  grd.addColorStop(0.42, spec.mid);
  grd.addColorStop(0.88, spec.lo);
  grd.addColorStop(1.00, spec.lo);
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, R, 0, TAU); g.fill();

  g.save();
  g.beginPath(); g.arc(SPR_R, SPR_R, R, 0, TAU); g.clip();
  g.globalCompositeOperation = 'lighter';
  blobs(g, rnd, spec.hi, 26, 2, 8, 0.22);            // granulation
  g.globalCompositeOperation = 'source-over';
  if (giant) {
    blobs(g, rnd, 'rgba(120,30,10,0.30)', 6, 6, 16, 0.34);   // huge cells
  } else {
    blobs(g, rnd, 'rgba(90,30,8,0.45)', 4, 2, 5, 0.38);      // starspots
  }
  g.restore();

  // Corona. Giants have large, tenuous, cooler envelopes.
  g.globalCompositeOperation = 'lighter';
  const cg = g.createRadialGradient(SPR_R, SPR_R, R * 0.9, SPR_R, SPR_R, SPR_R);
  cg.addColorStop(0, giant ? 'rgba(255,180,120,0.30)' : 'rgba(255,220,170,0.22)');
  cg.addColorStop(1, 'rgba(255,180,120,0)');
  g.fillStyle = cg;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
}

// A brown dwarf -- a "failed star" too small to sustain hydrogen fusion.
// Dim, magenta-brown, with patchy methane/ammonia cloud bands.
function drawBrownDwarf(g, rnd) {
  const R = SPR_R * 0.82;
  const grd = g.createRadialGradient(SPR_R, SPR_R, R * 0.05, SPR_R, SPR_R, R);
  grd.addColorStop(0.00, '#c89a86');
  grd.addColorStop(0.45, '#8a5a4a');
  grd.addColorStop(1.00, '#3a2018');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, R, 0, TAU); g.fill();
  g.save();
  g.beginPath(); g.arc(SPR_R, SPR_R, R, 0, TAU); g.clip();
  bands(g, rnd, ['#a06a55', '#7a4a3c', '#5c342a'], 0.22);
  g.restore();
  // Very faint glow -- these barely shine in visible light.
  g.globalCompositeOperation = 'lighter';
  const cg = g.createRadialGradient(SPR_R, SPR_R, R * 0.8, SPR_R, SPR_R, SPR_R);
  cg.addColorStop(0, 'rgba(180,90,60,0.18)');
  cg.addColorStop(1, 'rgba(180,90,60,0)');
  g.fillStyle = cg;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
}

// A white dwarf -- Earth-sized and immensely dense, so it renders as a tiny
// brilliant blue-white point. Very high mass for its size.
function drawWhiteDwarf(g, rnd) {
  const R = SPR_R * 0.34;
  g.globalCompositeOperation = 'lighter';
  const cg = g.createRadialGradient(SPR_R, SPR_R, R * 0.2, SPR_R, SPR_R, SPR_R);
  cg.addColorStop(0.00, 'rgba(255,255,255,0.95)');
  cg.addColorStop(0.30, 'rgba(200,225,255,0.42)');
  cg.addColorStop(1.00, 'rgba(160,200,255,0)');
  g.fillStyle = cg;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(SPR_R, SPR_R, R, 0, TAU); g.fill();
  g.fillStyle = '#dbe9ff';
  g.beginPath(); g.arc(SPR_R, SPR_R, R * 0.7, 0, TAU); g.fill();
}

// A magnetar -- a neutron star with a magnetic field around 10^15 gauss,
// strong enough to distort atoms. Rendered with dipole field loops.
function drawMagnetar(g, rnd) {
  const R = SPR_R * 0.30;
  g.globalCompositeOperation = 'lighter';
  const cg = g.createRadialGradient(SPR_R, SPR_R, R * 0.2, SPR_R, SPR_R, SPR_R * 0.92);
  cg.addColorStop(0.00, 'rgba(230,245,255,0.95)');
  cg.addColorStop(0.35, 'rgba(120,190,255,0.35)');
  cg.addColorStop(1.00, 'rgba(90,150,255,0)');
  g.fillStyle = cg;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.92, 0, TAU); g.fill();
  // Dipole field loops.
  g.strokeStyle = 'rgba(150,205,255,0.50)';
  g.lineWidth = 1.4;
  for (let k = 1; k <= 3; k++) {
    g.beginPath();
    g.ellipse(SPR_R, SPR_R, SPR_R * 0.26 * k, SPR_R * 0.76, 0, 0, TAU);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#eaf6ff';
  g.beginPath(); g.arc(SPR_R, SPR_R, R, 0, TAU); g.fill();
}

// A quasar -- an active galactic nucleus. A supermassive black hole with a
// hot accretion torus and two relativistic polar jets.
function drawQuasar(g, rnd) {
  g.globalCompositeOperation = 'lighter';
  for (let s = -1; s <= 1; s += 2) {
    const jg = g.createLinearGradient(SPR_R, SPR_R, SPR_R, SPR_R + s * SPR_R);
    jg.addColorStop(0.00, 'rgba(215,238,255,0.95)');
    jg.addColorStop(0.35, 'rgba(150,200,255,0.55)');
    jg.addColorStop(1.00, 'rgba(120,180,255,0)');
    g.fillStyle = jg;
    g.beginPath();
    g.moveTo(SPR_R - SPR_R * 0.10, SPR_R);
    g.lineTo(SPR_R + SPR_R * 0.10, SPR_R);
    g.lineTo(SPR_R + SPR_R * 0.32, SPR_R + s * SPR_R);
    g.lineTo(SPR_R - SPR_R * 0.32, SPR_R + s * SPR_R);
    g.closePath(); g.fill();
  }
  const tg = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.1, SPR_R, SPR_R, SPR_R * 0.8);
  tg.addColorStop(0.00, 'rgba(255,245,220,0.95)');
  tg.addColorStop(0.40, 'rgba(255,190,120,0.45)');
  tg.addColorStop(1.00, 'rgba(255,150,90,0)');
  g.fillStyle = tg;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.8, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#120a06';
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.26, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,240,210,0.95)';
  g.lineWidth = 2;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.31, 0, TAU); g.stroke();
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
    // Europa-like: a bright ice shell scored by brown/red lineae -- salt and
    // sulphur dragged up from the ocean beneath. White cracks are wrong.
    blobs(g, rnd, pal.hi, 14, 4, 16, 0.4);
    fissures(g, rnd, 14, 'rgba(168,112,90,0.55)', false);
    fissures(g, rnd, 6, 'rgba(120,70,52,0.45)', false);
    polarCaps(g, rnd, '#f2fbff');
  } else if (type === 'uranus') {
    // Tipped ~98 deg, so its banding runs nearly pole-to-pole instead of
    // along the equator like every other giant.
    blobs(g, rnd, pal.hi, 8, 6, 18, 0.30);
    g.save();
    g.translate(SPR_R, SPR_R);
    g.rotate(Math.PI / 2);
    g.translate(-SPR_R, -SPR_R);
    bands(g, rnd, [pal.hi, pal.mid, pal.lo], 0.16);
    g.restore();
  } else if (type === 'neptune') {
    // Deep blue, faint banding, dark storm spots, and methane cloud streaks.
    // Windiest planet in the Solar System (up to 2,100 km/h).
    bands(g, rnd, [pal.hi, pal.mid, pal.lo], 0.30);
    blobs(g, rnd, pal.spot, 3, 5, 12, 0.55);
    blobs(g, rnd, '#ffffff', 5, 3, 7, 0.28);
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

// A pulsar — a rapidly rotating neutron star with two crossing emission
// beams. Eating one gives a one-hit shield (next impact is ignored).
function drawPulsar(g, rnd) {
  const grd = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.04, SPR_R, SPR_R, SPR_R);
  grd.addColorStop(0.00, '#ffffff');
  grd.addColorStop(0.18, '#eaf4ff');
  grd.addColorStop(0.55, '#9ed1ff');
  grd.addColorStop(1.00, 'rgba(140,200,255,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  // Two crossed beams. They sweep in `drawEnts`, this paints the static sprite.
  g.globalCompositeOperation = 'lighter';
  g.save();
  g.translate(SPR_R, SPR_R);
  for (let i = 0; i < 2; i++) {
    g.rotate(i * Math.PI / 2);
    const lg = g.createLinearGradient(0, 0, SPR, 0);
    lg.addColorStop(0.00, 'rgba(255,255,255,0.85)');
    lg.addColorStop(0.55, 'rgba(180,220,255,0.45)');
    lg.addColorStop(1.00, 'rgba(180,220,255,0)');
    g.fillStyle = lg;
    g.fillRect(0, -2.5, SPR, 5);
  }
  g.restore();
  g.globalCompositeOperation = 'source-over';
}

// A wormhole — a violet ring with a dark throat. The paired exit is
// stored on the entity; we just draw the entrance here.
function drawWormhole(g, rnd) {
  // Soft outer halo
  const grd = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.45, SPR_R, SPR_R, SPR_R);
  grd.addColorStop(0.00, 'rgba(220,180,255,0.7)');
  grd.addColorStop(0.50, 'rgba(180,140,255,0.35)');
  grd.addColorStop(1.00, 'rgba(140,100,220,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  // Bright ring
  g.strokeStyle = 'rgba(255,240,255,0.95)';
  g.lineWidth = 6;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.54, 0, TAU); g.stroke();
  g.strokeStyle = 'rgba(200,160,255,0.6)';
  g.lineWidth = 3;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.40, 0, TAU); g.stroke();
  // Dark throat
  g.fillStyle = '#000';
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.34, 0, TAU); g.fill();
  // Faint inner sparkle
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,240,255,0.6)';
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.10, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
}

// ---- Civilisation installations ---------------------------------------
// Deliberately angular and emissive so they read as artificial at a glance
// against every natural body in the field.

function drawShield(g) {
  g.strokeStyle = 'rgba(120,225,255,0.55)';
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(SPR_R, SPR_R * 1.05, SPR_R * 0.72, Math.PI, TAU);
  g.stroke();
  g.strokeStyle = 'rgba(120,225,255,0.26)';
  g.lineWidth = 1.3;
  for (let k = 1; k <= 3; k++) {
    g.beginPath();
    g.arc(SPR_R, SPR_R * 1.05, SPR_R * 0.72 * (k / 4), Math.PI, TAU);
    g.stroke();
  }
  g.fillStyle = '#2b3a48';
  g.fillRect(SPR_R - SPR_R * 0.78, SPR_R * 1.02, SPR_R * 1.56, SPR_R * 0.30);
  g.fillStyle = '#7fe0ff';
  g.fillRect(SPR_R - SPR_R * 0.30, SPR_R * 0.94, SPR_R * 0.60, SPR_R * 0.11);
  g.globalCompositeOperation = 'lighter';
  const grd = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.2, SPR_R, SPR_R, SPR_R);
  grd.addColorStop(0, 'rgba(90,200,255,0.22)');
  grd.addColorStop(1, 'rgba(90,200,255,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
}

function drawRepulsor(g) {
  g.fillStyle = '#2f3b46';
  g.beginPath();
  g.moveTo(SPR_R - SPR_R * 0.42, SPR);
  g.lineTo(SPR_R - SPR_R * 0.16, SPR_R * 0.30);
  g.lineTo(SPR_R + SPR_R * 0.16, SPR_R * 0.30);
  g.lineTo(SPR_R + SPR_R * 0.42, SPR);
  g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,180,120,0.85)';
  g.lineWidth = 3;
  for (let k = 0; k < 3; k++) {
    g.beginPath();
    g.ellipse(SPR_R, SPR_R * (0.34 + k * 0.16),
              SPR_R * (0.52 - k * 0.10), SPR_R * 0.10, 0, 0, TAU);
    g.stroke();
  }
  g.globalCompositeOperation = 'lighter';
  const grd = g.createRadialGradient(SPR_R, SPR_R * 0.35, SPR_R * 0.1,
                                     SPR_R, SPR_R * 0.35, SPR_R * 0.9);
  grd.addColorStop(0, 'rgba(255,170,110,0.35)');
  grd.addColorStop(1, 'rgba(255,170,110,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R * 0.35, SPR_R * 0.9, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
}

function drawDriver(g) {
  g.fillStyle = '#333a42';
  g.fillRect(SPR_R - SPR_R * 0.62, SPR_R * 0.72, SPR_R * 1.24, SPR_R * 0.34);
  g.save();
  g.translate(SPR_R, SPR_R * 0.70);
  g.rotate(-0.5);
  g.fillStyle = '#4a535d';
  g.fillRect(-SPR_R * 0.10, -SPR_R * 0.72, SPR_R * 0.20, SPR_R * 0.90);
  g.fillStyle = '#ffd08a';
  g.fillRect(-SPR_R * 0.055, -SPR_R * 0.72, SPR_R * 0.11, SPR_R * 0.24);
  g.restore();
  g.fillStyle = '#7fd8ff';
  g.beginPath(); g.arc(SPR_R, SPR_R * 0.86, SPR_R * 0.10, 0, TAU); g.fill();
}

function drawArk(g) {
  g.fillStyle = '#5a6470';
  g.beginPath();
  g.moveTo(SPR_R + SPR_R * 0.86, SPR_R);
  g.lineTo(SPR_R - SPR_R * 0.20, SPR_R - SPR_R * 0.30);
  g.lineTo(SPR_R - SPR_R * 0.72, SPR_R - SPR_R * 0.22);
  g.lineTo(SPR_R - SPR_R * 0.72, SPR_R + SPR_R * 0.22);
  g.lineTo(SPR_R - SPR_R * 0.20, SPR_R + SPR_R * 0.30);
  g.closePath(); g.fill();
  g.fillStyle = 'rgba(150,220,255,0.9)';
  for (let k = 0; k < 4; k++) {
    g.fillRect(SPR_R - SPR_R * 0.50 + k * SPR_R * 0.24,
               SPR_R - SPR_R * 0.07, SPR_R * 0.12, SPR_R * 0.14);
  }
  g.globalCompositeOperation = 'lighter';
  const grd = g.createLinearGradient(SPR_R - SPR_R * 0.70, SPR_R,
                                     SPR_R - SPR_R * 1.00, SPR_R);
  grd.addColorStop(0, 'rgba(150,210,255,0.75)');
  grd.addColorStop(1, 'rgba(150,210,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(SPR_R - SPR_R * 0.70, SPR_R - SPR_R * 0.14);
  g.lineTo(SPR_R - SPR_R * 1.00, SPR_R);
  g.lineTo(SPR_R - SPR_R * 0.70, SPR_R + SPR_R * 0.14);
  g.closePath(); g.fill();
  g.globalCompositeOperation = 'source-over';
}

// A Penrose-process station. It mines your ergosphere for rotational
// energy, so being near one actually costs you mass.
function drawExtractor(g) {
  g.strokeStyle = 'rgba(190,150,255,0.85)';
  g.lineWidth = 7;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.62, 0, TAU); g.stroke();
  g.strokeStyle = 'rgba(240,225,255,0.90)';
  g.lineWidth = 2;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.62, 0, TAU); g.stroke();
  g.strokeStyle = 'rgba(190,150,255,0.60)';
  g.lineWidth = 3;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU;
    g.beginPath();
    g.moveTo(SPR_R + Math.cos(a) * SPR_R * 0.62, SPR_R + Math.sin(a) * SPR_R * 0.62);
    g.lineTo(SPR_R + Math.cos(a) * SPR_R * 0.92, SPR_R + Math.sin(a) * SPR_R * 0.92);
    g.stroke();
  }
  g.globalCompositeOperation = 'lighter';
  const grd = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.3, SPR_R, SPR_R, SPR_R);
  grd.addColorStop(0, 'rgba(170,120,255,0.30)');
  grd.addColorStop(1, 'rgba(170,120,255,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';
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

function makeBodySprite(type, variant, sub) {
  const c = document.createElement('canvas');
  c.width = c.height = SPR;
  const g = c.getContext('2d');
  const rnd = mulberry32(type.length * 7919 + type.charCodeAt(0) * 331 +
                         variant * 104729 + 17 + (sub ? sub.length * 131 : 0));
  if (type === 'asteroid') drawAsteroid(g, rnd);
  else if (type === 'star') drawStar(g, rnd, sub);
  else if (type === 'rival') drawRival(g);
  else if (type === 'pulsar') drawPulsar(g, rnd);
  else if (type === 'wormhole') drawWormhole(g, rnd);
  else if (type === 'brownDwarf') drawBrownDwarf(g, rnd);
  else if (type === 'whiteDwarf') drawWhiteDwarf(g, rnd);
  else if (type === 'magnetar') drawMagnetar(g, rnd);
  else if (type === 'quasar') drawQuasar(g, rnd);
  else if (type === 'shield') drawShield(g);
  else if (type === 'repulsor') drawRepulsor(g);
  else if (type === 'driver') drawDriver(g);
  else if (type === 'ark') drawArk(g);
  else if (type === 'extractor') drawExtractor(g);
  else drawPlanet(g, rnd, type);
  return c;
}

const bodySprites = new Map();
function bodySprite(type, variant, sub) {
  const k = type + '#' + variant + '#' + (sub || '');
  let s = bodySprites.get(k);
  if (!s) {
    s = makeBodySprite(type, variant, sub);
    // Hard ceiling: ~56 sprites at 128px is about 3.5 MB of canvas.
    if (bodySprites.size > 56) bodySprites.clear();
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

// Colour is the fast cue for edibility, but it must NEVER be the only one --
// drawEnts also gives lethal bodies hazard spikes. Roughly 8% of men have
// some colour-vision deficiency, and a colour-only threat signal is simply
// unusable for them.
// These palettes keep the two ends separable under each common CVD:
//   deutan / protan (red-green) -> separate BLUE from ORANGE
//   tritan (blue-yellow)        -> separate MAGENTA from GREEN
const CB_PALETTES = {
  normal: { e0: 188, e1: 270, l0: 44,  l1: 0   },
  deutan: { e0: 205, e1: 235, l0: 32,  l1: 16  },
  protan: { e0: 205, e1: 235, l0: 32,  l1: 16  },
  tritan: { e0: 300, e1: 332, l0: 150, l1: 168 }
};
const CB_ORDER = ['normal', 'deutan', 'protan', 'tritan'];
const CB_LABEL = { normal: 'NORMAL', deutan: 'DEUTAN', protan: 'PROTAN', tritan: 'TRITAN' };
let cbMode = lsGet('cb', 'normal');
if (!CB_PALETTES[cbMode]) cbMode = 'normal';

function entHue(ratio) {
  const p = CB_PALETTES[cbMode] || CB_PALETTES.normal;
  if (ratio <= 0.95) return p.e0 + clamp(ratio / 0.95, 0, 1) * (p.e1 - p.e0);
  return p.l0 - clamp((ratio - 0.95) / 0.9, 0, 1) * (p.l0 - p.l1);
}

// Type follows edibility so the fantasy stays coherent: worlds and rubble are
// food, stars and giants are not. The rim colour remains authoritative,
// because a body's edibility changes as you grow or shrink.
function assignBody(e) {
  const lethal = e.r > p.r * 0.95;
  const q = Math.random();
  let type, sub = null;
  let spin = rand(-0.75, 0.75);

  if (!lethal) {
    if (q < 0.04) {                                   // rare anomaly
      type = RARE[(Math.random() * RARE.length) | 0];
      spin = rand(-0.3, 0.3);
    } else if (q < 0.06) {                            // failed star
      type = 'brownDwarf';
      spin = rand(-0.5, 0.5);
    } else if (q < 0.08) {                            // stellar remnant
      type = 'whiteDwarf';
      spin = rand(-0.2, 0.2);
    } else if (q < 0.08 + 0.30) {                     // asteroid
      type = 'asteroid';
      spin = rand(-2.6, 2.6);
    } else {
      type = EDIBLE[(Math.random() * EDIBLE.length) | 0];
    }
  } else {
    if (q < 0.40) {
      // A star you cannot yet swallow is an evolved giant, weighted toward
      // red giants the way real stellar populations are.
      type = 'star';
      const g = Math.random();
      sub = g < 0.62 ? 'redgiant' : (g < 0.88 ? 'supergiant' : 'bluegiant');
      spin = rand(-0.18, 0.18);
    } else if (q < 0.45) {                            // magnetar
      type = 'magnetar';
      spin = rand(-0.4, 0.4);
    } else if (q < 0.49) {                            // quasar
      type = 'quasar';
      spin = 0;
    } else {
      type = LETHAL[(Math.random() * LETHAL.length) | 0];
    }
  }
  e.body = { type, variant: (Math.random() * VARIANTS) | 0, spin, sub };
  initRare(e);
}

// Extra state for the rare bodies that need it.
function initRare(e) {
  if (e.body.type === 'pulsar') {
    e.pulseT = rand(0.4, 1.6);
    e.beatMax = rand(1.6, 2.2);
  } else if (e.body.type === 'wormhole') {
    // Paired exit: a random offset the player teleports along on impact.
    e.pairAng = rand(0, TAU);
    e.pairDist = rand(140, 220);
  } else if (e.body.type === 'quasar') {
    // Jets slowly sweep; touching one is catastrophic.
    e.jetA = rand(0, TAU);
    e.jetSpin = rand(-0.45, 0.45);
  }
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

// Once you are big enough to be noticed, somebody starts building.
function spawnCiv() {
  let live = 0;
  for (const e of ents) if (e.civ) live++;
  if (live >= CIV_MAX) return;

  const type = CIV[(Math.random() * CIV.length) | 0];
  const v = viewWorldRadius();
  const a = Math.random() * TAU;
  const dist = rand(v * 0.55, v * 1.0);
  const e = {
    x: p.x + Math.cos(a) * dist,
    y: p.y + Math.sin(a) * dist,
    vx: 0, vy: 0,
    r: p.r * (type === 'ark' ? rand(0.16, 0.26) : rand(0.30, 0.52)),
    spin: 0, phase: 0,
    civ: type,
    body: { type, variant: 0, spin: 0, sub: null },
    cool: rand(1.2, 3.0)
  };
  if (type === 'ark') {
    // Arks burn directly away from the hole at whatever they can manage.
    const sp = rand(2.2, 3.6) * p.r;
    e.vx = Math.cos(a) * sp;
    e.vy = Math.sin(a) * sp;
  }
  ents.push(e);
}

function reset() {
  p = { x: 0, y: 0, vx: 0, vy: 0, r: P0, area: P0 * P0 };
  ents = []; parts = []; waves = []; shots = []; slugs = []; floats = [];
  cam = { x: 0, y: 0, zoom: 1 };
  score = 0; shownScore = 0; combo = 0; comboT = 0;
  elapsed = 0; era = 0; shakeMag = 0; hitstopT = 0; invuln = 0;
  flashT = 0; toastT = 0; shotT = 5;
  camRoll = 0; shield = 0; kilonovaT = rand(35, 70);
  pointer.active = false; pointer.x = W / 2; pointer.y = H / 2;
  joy.active = false; joy.dx = 0; joy.dy = 0;
  for (let i = 0; i < ENT_TARGET; i++) spawn(Math.random() < 0.5 ? 1.15 : 1.7);
  cam.zoom = desiredZoom();
}

function spawn(scaleMul) {
  const v = viewWorldRadius();
  const a = Math.random() * TAU;
  // Spawn just inside the visible ring so the field is never empty around
  // the player. The old 1.14-1.7 range put everything just out of view.
  const dist = rand(v * 0.85, v * (scaleMul || 1.25));
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
  const type = e.body && e.body.type;
  const wasStar = type === 'star';
  const wasPulsar = type === 'pulsar';
  const wasWormhole = type === 'wormhole';

  p.area += e.r * e.r * CONSUME_YIELD;
  p.r = Math.sqrt(p.area);
  combo++;
  comboT = COMBO_WINDOW;

  let gained = Math.max(1, Math.round(e.r * 0.42 * comboMult()));
  if (wasStar) gained *= STAR_BONUS;
  if (wasPulsar) gained *= 3;
  // Degenerate matter: a white dwarf packs roughly a Sun's mass into an
  // Earth-sized volume, so it pays far better than its radius suggests.
  if (type === 'whiteDwarf') gained *= 4;
  if (type === 'brownDwarf') gained *= 2;
  if (type === 'ark') gained *= 3;          // a whole ship full of people
  score += gained;

  // Floating number, so a big eat lands without having to watch the HUD.
  if (floats.length < 24) {
    floats.push({
      x: e.x, y: e.y,
      text: '+' + fmt(gained),
      life: 0, max: 0.9,
      big: gained >= 40
    });
  }

  absorbFx(e);
  if (type === 'asteroid') Snd.crunch();
  else Snd.blip(combo - 1);
  Snd.setDrone(true, combo);
  ents.splice(idx, 1);

  if (wasStar) {
    supernova(e.x, e.y, e.r);
    toast('STAR CONSUMED  +' + fmt(gained));
  } else if (wasPulsar) {
    shield = 1;
    toast('PULSAR ABSORBED - next impact shielded', 2.2);
    burstFx(e.x, e.y, 24, e.r, 1.4);
  } else if (wasWormhole) {
    // Teleport along the stored pair vector. Move the player AND the camera
    // so the world scrolls instead of jumping under the finger.
    const tx = Math.cos(e.pairAng) * e.pairDist;
    const ty = Math.sin(e.pairAng) * e.pairDist;
    p.x += tx; p.y += ty;
    cam.x += tx; cam.y += ty;
    burstFx(e.x, e.y, 30, e.r, 1);
    burstFx(p.x, p.y, 18, p.r * 0.6, 0.8);
    toast('WORMHOLE');
  } else if (type === 'magnetar') {
    // A starquake: the crust cracks and releases a burst that clears the
    // field of anything dangerous nearby.
    const R = p.r * 11;
    for (let i = ents.length - 1; i >= 0; i--) {
      const o = ents[i];
      const ddx = o.x - p.x, ddy = o.y - p.y;
      if (ddx * ddx + ddy * ddy < R * R && o.r > p.r * 0.95) {
        burstFx(o.x, o.y, 8, o.r, 1);
        ents.splice(i, 1);
      }
    }
    waves.push({ x: p.x, y: p.y, r: p.r, max: R, t: 0, hue: 205 });
    flashT = Math.max(flashT, 0.22);
    toast('MAGNETAR STARQUAKE');
    Snd.boom();
  } else if (type === 'ark') {
    toast('ARK CONSUMED  +' + fmt(gained), 1.8);
    burstFx(e.x, e.y, 26, e.r, 1.2);
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
  // Pulsar shield absorbs the next impact entirely, then is consumed.
  if (shield > 0) {
    shield = 0;
    toast('PULSAR SHIELD', 1.4);
    if (Snd.ac) Snd.tone(520, 'sine', 0.18, 0.005, 0.16);
    burstFx(p.x, p.y, 22, p.r * 0.5, 1.2);
    return;
  }
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
  // The drag schemes steer toward an explicit point in the world.
  if (controlMode !== 'joystick' && drag.active) {
    return { x: drag.wx, y: drag.wy };
  }
  // Joystick drives touch input.
  if (controlMode === 'joystick' && joy.active && (joy.dx !== 0 || joy.dy !== 0)) {
    const m = Math.hypot(joy.dx, joy.dy) || 1;
    return { x: p.x + (joy.dx / m) * 260, y: p.y + (joy.dy / m) * 260 };
  }
  // Keyboard fallback -- desktop, or Android with a hardware keyboard.
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (dx || dy) {
    const m = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / m * 260, y: p.y + dy / m * 260 };
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
  if (shield > 0) shield = Math.max(0, shield - dt * 0.6);

  // Kilonova: a neutron-star merger going off somewhere in the field. Real
  // ones forge the heavy elements (gold, platinum, uranium) and flash hard
  // across the spectrum. This one pays out and clears danger nearby.
  if (state === 'play') {
    kilonovaT -= dt;
    if (kilonovaT <= 0) {
      kilonovaT = rand(45, 85);
      const R = p.r * 16;
      waves.push({ x: p.x, y: p.y, r: p.r, max: R, t: 0, hue: 45 });
      for (let i = ents.length - 1; i >= 0; i--) {
        const o = ents[i];
        const ddx = o.x - p.x, ddy = o.y - p.y;
        if (ddx * ddx + ddy * ddy < R * R && o.r > p.r * 0.95) {
          score += Math.round(o.r * 0.6 * comboMult());
          burstFx(o.x, o.y, 10, o.r, 1);
          ents.splice(i, 1);
        }
      }
      flashT = Math.max(flashT, 0.45);
      shakeMag = Math.max(shakeMag, 18);
      toast('KILONOVA - heavy elements forged', 2.4);
      Snd.boom();
    }
  }

  // Frame-dragging: large bodies tilt the world subtly when close. Real
  // Kerr black holes drag spacetime around them; this is the cheap version.
  let drag = 0;
  for (const e of ents) {
    const t = e.body && e.body.type;
    if (t !== 'star' && t !== 'giant' && t !== 'rival') continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    const reach = p.r * 5;
    if (d < reach) {
      const sign = (dx > 0) ? 1 : -1;
      drag += sign * (1 - d / reach) * 0.14;
    }
  }
  camRoll = lerp(camRoll, clamp(drag, -0.22, 0.22), smooth(0.6, dt));

  cam.zoom = lerp(cam.zoom, desiredZoom(), smooth(0.02, dt));
  // Snap the camera to the player. The old "smooth" follow lagged badly -- a few
  // quick moves and the player was drawn in the corner with the whole field
  // off-screen, which read as "the game is empty". 0.35 is snappy without
  // being jittery at 60 fps.
  cam.x = lerp(cam.x, p.x, 0.35);
  cam.y = lerp(cam.y, p.y, 0.35);

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

    // Hawking radiation. A black hole's temperature goes as 1/M and its power
// as 1/M^2, so the FRACTIONAL mass-loss rate scales as 1/M^3 -- and since
// Schwarzschild radius is proportional to mass, as 1/r^3. Small holes
// evaporate furiously and large ones are nearly stable. The old curve was
// backwards: it punished you for growing.
const decay = HAWKING_BASE * clamp(Math.pow(P0 / p.r, 3),
                                       HAWKING_MIN, HAWKING_MAX);
    p.area = Math.max(1, p.area - p.area * decay * dt);
    p.r = Math.sqrt(p.area);

    if (comboT > 0) { comboT -= dt; if (comboT <= 0) combo = 0; }
    if (invuln > 0) invuln -= dt;

    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      const ddx = e.x - p.x, ddy = e.y - p.y;
      const reach = p.r + e.r * 0.5;
      if (ddx * ddx + ddy * ddy < reach * reach) {
        // Civilisation hardware is neither food nor a body to collide with.
        // A deflector dome simply throws you back off it.
        if (e.civ === 'shield') {
          const dd = Math.hypot(ddx, ddy) || 1;
          p.vx = -ddx / dd * 7 * p.r;
          p.vy = -ddy / dd * 7 * p.r;
          combo = 0; comboT = 0;
          shakeMag = Math.max(shakeMag, 10);
          toast('DEFLECTOR SHIELD', 1.2);
          if (Snd.ac) Snd.tone(300, 'sine', 0.16, 0.005, 0.18);
          continue;
        }
        if (e.civ && e.civ !== 'ark') continue;   // arks can be caught
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
  updateSlugs(dt);
  updateFloats(dt);

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

  // The civilisation starts deploying countermeasures once you are big
  // enough for someone to have noticed.
  // Roughly one installation every 7 seconds, so they trickle in and escalate
// rather than all appearing the instant you cross the threshold.
  if (state === 'play' && score > CIV_ALERT && Math.random() < 0.0025) spawnCiv();

  const v = viewWorldRadius();
  const despawnR = v * 1.95;
  const pullR = p.r * 7;
  const edamp = Math.pow(0.12, dt);

  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = p.x - e.x, dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > despawnR * despawnR) {
      if (e.civ === 'ark') toast('ARK ESCAPED', 1.4);
      ents.splice(i, 1); continue;
    }

    // ---- Civilisation countermeasures --------------------------------
    if (e.civ && state === 'play') {
      const d = Math.sqrt(d2) || 1;
      if (e.civ === 'ark') {
        // Arks keep their burn; only mild drag.
        const kd = Math.pow(0.85, dt);
        e.vx *= kd; e.vy *= kd;
      } else if (e.civ === 'repulsor') {
        // Gravity-well projector run in reverse: it shoves you away.
        const reach = p.r * 7;
        if (d < reach) {
          const s = (1 - d / reach) * 7.5 * p.r * dt;
          p.vx += (dx / d) * s;              // dx points structure -> hole
          p.vy += (dy / d) * s;
        }
      } else if (e.civ === 'extractor') {
        // Penrose process: they skim your rotational energy. This is a
        // real proposed way to extract energy from a Kerr black hole.
        const reach = p.r * 5.5;
        if (d < reach) {
          // ~3.5%/s at point blank -- meaningful pressure, not instant death.
          p.area = Math.max(1, p.area * (1 - (1 - d / reach) * 0.035 * dt));
          p.r = Math.sqrt(p.area);
          if (Math.random() < 0.25) {
            addPart({
              x: e.x, y: e.y,
              vx: -dx / d * p.r * 2, vy: -dy / d * p.r * 2,
              life: 0, max: 0.5,
              r: rand(0.05, 0.12) * p.r + 0.8, hue: 275, mode: 1
            });
          }
        }
      } else if (e.civ === 'driver') {
        e.cool -= dt;
        if (e.cool <= 0 && d < p.r * 12) {
          e.cool = rand(1.6, 3.2);
          const sp = rand(3.5, 6.0) * p.r;
          slugs.push({
            x: e.x, y: e.y,
            vx: -dx / d * sp, vy: -dy / d * sp,
            r: p.r * 0.07, life: 0, max: 4
          });
          if (Snd.ac) Snd.tone(180, 'square', 0.10, 0.004, 0.10);
        }
      }
    }

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

    // Pulsars broadcast periodic gravity shockwaves -- the spin of a
    // neutron star pushing the field outward.
    if (e.body && e.body.type === 'pulsar' && state === 'play') {
      e.pulseT -= dt;
      if (e.pulseT <= 0) {
        e.pulseT = e.beatMax;
        waves.push({ x: e.x, y: e.y, r: e.r * 0.6, max: e.r * 9, t: 0, hue: 210 });
        burstFx(e.x, e.y, 6, e.r * 0.5, 0.5);
      }
    }

    // Quasar jets sweep. Magnetars deflect you sideways -- the field is
    // strong enough that steering near one is genuinely hard, which is the
    // whole hazard.
    if (e.body && state === 'play') {
      if (e.body.type === 'quasar') {
        e.jetA = (e.jetA || 0) + (e.jetSpin || 0) * dt;
      } else if (e.body.type === 'magnetar') {
        const d = Math.sqrt(d2) || 1;
        const reach = p.r * 6;
        if (d < reach) {
          const s = (1 - d / reach) * 5.5 * p.r * dt;
          p.vx += (-dy / d) * s;                 // perpendicular to approach
          p.vy += (dx / d) * s;
        }
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
        // Newtonian gravity: pull falls off as 1/r^2, softened near the
        // centre so nothing goes infinite. The old linear falloff let the
        // hole vacuum the entire field evenly, which is not how gravity
        // behaves -- now distant bodies barely drift and close ones get
        // hauled in hard.
        const soft = d + p.r * 0.85;
        const falloff = (p.r * p.r) / (soft * soft);
        const s = falloff * 4.6 * p.r * dt / (0.35 + mass * 2.2) * (edible ? 1 : 0.18);
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

// Mass-driver rounds fired by the civilisation's railgun batteries.
function updateSlugs(dt) {
  for (let i = slugs.length - 1; i >= 0; i--) {
    const s = slugs[i];
    s.life += dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.life >= s.max) { slugs.splice(i, 1); continue; }
    if (state === 'play') {
      const dx = s.x - p.x, dy = s.y - p.y;
      const rr = p.r + s.r;
      if (dx * dx + dy * dy < rr * rr) {
        // Small chip of mass and a shove -- they are trying to deflect
        // you, not kill you outright.
        p.area = Math.max(1, p.area * 0.97);
        p.r = Math.sqrt(p.area);
        const d = Math.hypot(dx, dy) || 1;
        p.vx += dx / d * 3 * p.r;
        p.vy += dy / d * 3 * p.r;
        burstFx(s.x, s.y, 8, s.r * 4, 0.7);
        shakeMag = Math.max(shakeMag, 6);
        slugs.splice(i, 1);
        if (Snd.ac) Snd.tone(120, 'square', 0.14, 0.004, 0.12);
      }
    }
  }
}

function updateFloats(dt) {
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i];
    f.life += dt;
    f.y -= p.r * 0.55 * dt;              // drift upward, in world units
    if (f.life >= f.max) floats.splice(i, 1);
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
  ctx.rotate(camRoll);                     // frame-dragging tilt
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  drawEnts();
  drawWaves();
  drawSlugs();
  drawParts();
  if (state !== 'dead') drawPlayer();

  ctx.restore();

  drawDangerArrows();                     // screen space
  drawFloats();                           // screen space
  drawJoystick();                         // joystick is screen-space, not world

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

// Virtual joystick drawn in screen space. The base lives in the lower-left
// when idle and slides under the finger when active.
function drawJoystick() {
  if (controlMode !== 'joystick') return;     // nothing to draw in drag modes
  const homeX = JOY_R + 28;
  const homeY = H - JOY_R - 36;
  const cx = joy.active ? joy.bx : homeX;
  const cy = joy.active ? joy.by : homeY;
  const kx = joy.active ? joy.kx : cx;
  const ky = joy.active ? joy.ky : cy;

  ctx.globalCompositeOperation = 'lighter';

  // Outer base ring + faint inner guide ring.
  ctx.strokeStyle = joy.active ? 'rgba(79,240,255,0.42)' : 'rgba(150,200,230,0.18)';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(cx, cy, JOY_R, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(150,200,230,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, JOY_R * 0.55, 0, TAU); ctx.stroke();

  // Knob.
  const live = joy.active ? (0.85 + 0.15 * Math.sin(elapsed * 6)) : 0.65;
  ctx.globalAlpha = live;
  ctx.fillStyle = 'rgba(79,240,255,0.55)';
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.globalCompositeOperation = 'source-over';
}

// Floating "+1,240" numbers. Drawn in screen space so the type stays a
// constant size no matter how far the camera has zoomed out.
function drawFloats() {
  if (!floats.length) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of floats) {
    const k = 1 - f.life / f.max;
    const sx = (f.x - cam.x) * cam.zoom + W / 2;
    const sy = (f.y - cam.y) * cam.zoom + H / 2;
    if (sx < -60 || sx > W + 60 || sy < -40 || sy > H + 40) continue;
    const size = (f.big ? 17 : 12) * (0.9 + k * 0.3);
    ctx.globalAlpha = Math.min(1, k * 1.6);
    ctx.font = `700 ${size.toFixed(1)}px ui-monospace, monospace`;
    ctx.fillStyle = f.big ? 'rgba(255,236,190,0.95)' : 'rgba(200,238,255,0.92)';
    ctx.fillText(f.text, sx, sy);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// Arrows pointing at lethal bodies that are off-screen. Partly juice, partly
// accessibility: knowing where the danger is should not depend on being able
// to see its colour.
function drawDangerArrows() {
  if (state === 'dead') return;
  const cx = W / 2, cy = H / 2;
  const rad = Math.min(W, H) * 0.5 - 26;
  ctx.globalCompositeOperation = 'lighter';
  for (const e of ents) {
    if (e.r <= p.r * 0.95) continue;                 // edible ones are fine
    const sx = (e.x - cam.x) * cam.zoom + cx;
    const sy = (e.y - cam.y) * cam.zoom + cy;
    if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) continue;   // visible already
    const dx = sx - cx, dy = sy - cy;
    const d = Math.hypot(dx, dy) || 1;
    ctx.save();
    ctx.translate(cx + dx / d * rad, cy + dy / d * rad);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = 'rgba(255,150,110,0.55)';
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawEnts() {
  for (const e of ents) {
    const ratio = e.r / p.r;
    // Civilisation hardware is artificial, so it gets a cold tech tint
    // instead of the edible/lethal colour language of natural bodies.
    const hue = e.civ ? 200 : entHue(ratio);
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

    // Tidal stretching. The near side of an infalling body is pulled harder
// than the far side, so it elongates toward the hole before being torn
// apart. This is real spaghettification, not a squash-and-stretch cartoon.
    let sx = 1, sAng = 0;
    if (state !== 'dead') {
      const td = Math.hypot(e.x - p.x, e.y - p.y);
      const tide = p.r * 2.8;
      if (td < tide) {
        const t = 1 - td / tide;
        sx = 1 + t * t * 2.4;
        sAng = Math.atan2(p.y - e.y, p.x - e.x);
      }
    }

    // Surface: pre-rendered once, blitted with rotation.
    ctx.save();
    ctx.translate(e.x, e.y);
    if (sx > 1.02) {
      ctx.rotate(sAng);
      ctx.scale(sx, 1 / Math.sqrt(sx));        // roughly preserves volume
      ctx.rotate(-sAng);
    }
    ctx.rotate(e.phase);
    ctx.drawImage(bodySprite(b.type, b.variant, b.sub), -e.r, -e.r, e.r * 2, e.r * 2);
    ctx.restore();

    // Fixed light direction; stars are self-lit so they skip this.
    if (b.type !== 'star' && scr > 3) {
      ctx.drawImage(shadeSprite, e.x - e.r, e.y - e.r, e.r * 2, e.r * 2);
    }

    // Pulsars: the sprite is static, the beam sweep is live.
    if (b.type === 'pulsar') {
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.5 + 0.4 * Math.sin(elapsed * 4 + e.phase);
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(elapsed * 1.5);                       // lighthouse sweep
      const lg = ctx.createLinearGradient(0, 0, e.r * 2.2, 0);
      lg.addColorStop(0.00, `rgba(220,240,255,${(0.85 * pulse).toFixed(3)})`);
      lg.addColorStop(0.55, `rgba(160,210,255,${(0.45 * pulse).toFixed(3)})`);
      lg.addColorStop(1.00, 'rgba(160,210,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, -e.r * 0.06, e.r * 2.2, e.r * 0.12);
      ctx.rotate(Math.PI / 2);
      ctx.fillRect(0, -e.r * 0.06, e.r * 2.2, e.r * 0.12);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Quasar: two relativistic polar jets sweeping around the core. These are
    // the business end -- the jets are what actually kills you.
    if (b.type === 'quasar') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.jetA || 0);
      const jl = e.r * 5.5;
      for (let s = -1; s <= 1; s += 2) {
        const jg = ctx.createLinearGradient(0, 0, 0, s * jl);
        jg.addColorStop(0.00, 'rgba(220,240,255,0.80)');
        jg.addColorStop(0.40, 'rgba(150,200,255,0.42)');
        jg.addColorStop(1.00, 'rgba(120,180,255,0)');
        ctx.fillStyle = jg;
        ctx.beginPath();
        ctx.moveTo(-e.r * 0.10, 0);
        ctx.lineTo(e.r * 0.10, 0);
        ctx.lineTo(e.r * 0.30, s * jl);
        ctx.lineTo(-e.r * 0.30, s * jl);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Magnetar: dipole field loops pulsing with the spin period.
    if (b.type === 'magnetar') {
      ctx.globalCompositeOperation = 'lighter';
      const beat = 0.35 + 0.30 * Math.sin(elapsed * 5 + e.phase);
      ctx.strokeStyle = `rgba(150,205,255,${(beat * 0.7).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, e.r * 0.06);
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.phase * 0.5);
      for (let k = 1; k <= 3; k++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, e.r * 0.55 * k, e.r * 1.55, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Atmospheric rim — the authoritative edibility cue.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `hsla(${hue}, 100%, ${ratio > 0.95 ? 66 : 84}%, 0.85)`;
    ctx.lineWidth = Math.max(0.6, e.r * 0.09);
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.99, 0, TAU); ctx.stroke();

    // Lethal bodies get a pulsing ring AND outward hazard spikes. The spikes are
// a SHAPE cue, so threat stays readable for anyone who cannot separate the
// two colours -- colour alone would make this unplayable for them.
    if (ratio > 0.95 && !e.civ) {
      const pulse = 0.35 + 0.35 * Math.sin(elapsed * 5 + e.phase);
      ctx.strokeStyle = `hsla(${hue}, 100%, 70%, ${pulse.toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, e.r * 0.05);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 1.16, 0, TAU); ctx.stroke();

      const spikes = 8;
      const inner = e.r * 1.30;
      const outer = e.r * 1.62;
      ctx.lineWidth = Math.max(1, e.r * 0.07);
      ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${(0.45 + pulse * 0.5).toFixed(3)})`;
      ctx.beginPath();
      for (let k = 0; k < spikes; k++) {
        const a = (k / spikes) * TAU + e.phase * 0.4;
        ctx.moveTo(e.x + Math.cos(a) * inner, e.y + Math.sin(a) * inner);
        ctx.lineTo(e.x + Math.cos(a) * outer, e.y + Math.sin(a) * outer);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

// A real comet has TWO tails and neither points along its velocity -- both
// are pushed anti-sunward by radiation pressure and the solar wind.
//   * Ion (plasma) tail: blue, narrow, nearly straight. The solar wind is
//     far faster than the comet, so it barely curves.
//   * Dust tail: pale yellow-white, broader and curved, because the heavier
//     dust lags behind along the orbit.
// The nucleus is one of the darkest objects known (albedo ~0.04); the bright
// blur around it is the coma, not the nucleus itself.
function drawCometTail(e, hue) {
  // Anti-solar direction: away from the fixed scene light source.
  const sm = Math.hypot(LIGHT.x, LIGHT.y) || 1;
  const ax = -LIGHT.x / sm, ay = -LIGHT.y / sm;
  const d = Math.hypot(e.vx, e.vy) || 1;
  const vx = e.vx / d, vy = e.vy / d;

  ctx.globalCompositeOperation = 'lighter';

  // --- Ion tail: blue and straight ---
  const ilen = e.r * (7 + Math.sin(elapsed * 3 + e.phase) * 1.2);
  const tx = e.x + ax * ilen, ty = e.y + ay * ilen;
  const ig = ctx.createLinearGradient(e.x, e.y, tx, ty);
  ig.addColorStop(0.00, 'rgba(150,205,255,0.62)');
  ig.addColorStop(0.45, 'rgba(110,175,255,0.28)');
  ig.addColorStop(1.00, 'rgba(90,150,255,0)');
  ctx.fillStyle = ig;
  ctx.beginPath();
  ctx.moveTo(e.x - ay * e.r * 0.28, e.y + ax * e.r * 0.28);
  ctx.lineTo(tx - ay * e.r * 0.85, ty + ax * e.r * 0.85);
  ctx.lineTo(tx + ay * e.r * 0.85, ty - ax * e.r * 0.85);
  ctx.lineTo(e.x + ay * e.r * 0.28, e.y - ax * e.r * 0.28);
  ctx.closePath(); ctx.fill();

  // --- Dust tail: pale, broad, curved by orbital lag ---
  const dlen = e.r * 4.8;
  const tipX = e.x + (ax * 0.72 - vx * 0.45) * dlen;
  const tipY = e.y + (ay * 0.72 - vy * 0.45) * dlen;
  const bulgeX = (e.x + tipX) / 2 + ay * e.r * 0.9;
  const bulgeY = (e.y + tipY) / 2 - ax * e.r * 0.9;
  const dg = ctx.createLinearGradient(e.x, e.y, tipX, tipY);
  dg.addColorStop(0.00, 'rgba(255,246,214,0.52)');
  dg.addColorStop(0.50, 'rgba(255,232,180,0.24)');
  dg.addColorStop(1.00, 'rgba(255,220,150,0)');
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.moveTo(e.x - ay * e.r * 0.80, e.y + ax * e.r * 0.80);
  ctx.quadraticCurveTo(bulgeX, bulgeY, tipX, tipY);
  ctx.lineTo(e.x + ay * e.r * 0.80, e.y - ax * e.r * 0.80);
  ctx.closePath(); ctx.fill();

  // Coma: the bright gas halo around the (very dark) nucleus.
  const comaR = e.r * 2.1;
  const cg = ctx.createRadialGradient(e.x, e.y, e.r * 0.3, e.x, e.y, comaR);
  cg.addColorStop(0.00, 'rgba(225,245,255,0.55)');
  cg.addColorStop(1.00, 'rgba(180,220,255,0)');
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(e.x, e.y, comaR, 0, TAU); ctx.fill();

  ctx.globalCompositeOperation = 'source-over';
}

// Mass-driver rounds in flight, drawn as short bright tracers.
function drawSlugs() {
  if (!slugs.length) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const s of slugs) {
    const d = Math.hypot(s.vx, s.vy) || 1;
    const ux = -s.vx / d, uy = -s.vy / d;
    const len = s.r * 9;
    const g = ctx.createLinearGradient(s.x, s.y, s.x + ux * len, s.y + uy * len);
    g.addColorStop(0, 'rgba(255,218,155,0.90)');
    g.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1, s.r * 1.8);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + ux * len, s.y + uy * len);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Relativistic Doppler beaming factor for a point on a ring. The side of
// the ring rotating toward the observer is boosted steeply while the
// receding side dims. ((1+cos)/2)^2 is a cheap stand-in for the true
// D^(3+alpha) boost, and it is what gives every real black-hole image
// (M87*, Sgr A*) its characteristic one-sided brightness.
function doppler(angle, beamDir) {
  const c = Math.cos(angle - beamDir);
  return Math.pow(Math.max(0, (1 + c) / 2), 2);
}

function drawPlayer() {
  const r = p.r;

  // Relativistic polar jets once the hole is accreting hard enough to power
  // an active galactic nucleus. Real supermassive black holes do exactly
  // this, and it is the same structure as the quasar entity.
  if (era >= 5) {
    ctx.globalCompositeOperation = 'lighter';
    const jl = r * 7;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.sin(elapsed * 0.25) * 0.12);
    for (let s = -1; s <= 1; s += 2) {
      const jg = ctx.createLinearGradient(0, 0, 0, s * jl);
      jg.addColorStop(0.00, 'rgba(215,238,255,0.52)');
      jg.addColorStop(0.40, 'rgba(150,200,255,0.24)');
      jg.addColorStop(1.00, 'rgba(120,180,255,0)');
      ctx.fillStyle = jg;
      ctx.beginPath();
      ctx.moveTo(-r * 0.14, 0);
      ctx.lineTo(r * 0.14, 0);
      ctx.lineTo(r * 0.42, s * jl);
      ctx.lineTo(-r * 0.42, s * jl);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }

  // A warm, faint outer halo -- the lensed glow of the background starfield.
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(p.x, p.y, r * 1.0, p.x, p.y, r * 1.7);
  halo.addColorStop(0.00, 'rgba(255,200,170,0.40)');
  halo.addColorStop(0.55, 'rgba(255,160,130,0.16)');
  halo.addColorStop(1.00, 'rgba(255,140,110,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.7, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // Pulsar-shield ring, when active.
  if (shield > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(255,236,205,${(0.45 + 0.35 * Math.sin(elapsed * 14)).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.55, 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  // The shadow -- pure black. (The observable "shadow" is about 2.6x the
  // Schwarzschild radius; we treat p.r as that shadow radius.)
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();

  const beamDir = Math.atan2(LIGHT.y, LIGHT.x);
  ctx.globalCompositeOperation = 'lighter';

  // ---- Photon ring ---------------------------------------------------
  // Light that has orbited the hole and escaped. Very thin, hugging the
  // shadow edge. Segmented so it can carry relativistic Doppler beaming:
  // the side rotating toward us is boosted, the receding side is dimmed.
  const SEG = 30;
  const ringR = r * 1.045;
  const ringW = Math.max(1, r * 0.055);
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * TAU;
    const a1 = ((i + 1) / SEG) * TAU + 0.02;      // slight overlap, no seams
    const mid = (a0 + a1) / 2;
    const boost = doppler(mid, beamDir);
    const alpha = 0.20 + 0.78 * boost;
    const gg = Math.round(226 + 26 * boost);
    const bb = Math.round(212 + 42 * boost);
    ctx.strokeStyle = `rgba(255,${gg},${bb},${alpha.toFixed(3)})`;
    ctx.lineWidth = ringW;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ringR, a0, a1);
    ctx.stroke();
  }

  // ---- Lensed accretion disk: the light-wrapping effect ---------------
  // Gravity bends the far side of the disk up over the top of the hole and
  // down under the bottom, so the disk appears to wrap right around the
  // sphere instead of stopping at the edges. This is the Gargantua /
  // Interstellar look and it is what real lensing actually does.
  const wrapR = r * 1.34;
  const wrapW = Math.max(1.5, r * 0.20);
  const ARCS = 30;
  for (let i = 0; i < ARCS; i++) {
    const a0 = (i / ARCS) * TAU;
    const a1 = ((i + 1) / ARCS) * TAU + 0.02;
    const mid = (a0 + a1) / 2;
    // Brightest at top and bottom, where the lensed image piles up.
    const wrap = Math.pow(Math.abs(Math.sin(mid)), 1.4);
    const boost = doppler(mid, beamDir);
    const alpha = (0.10 + 0.62 * wrap) * (0.35 + 0.75 * boost);
    if (alpha < 0.012) continue;
    const gg = Math.round(198 + 48 * boost);
    const bb = Math.round(188 + 62 * boost);
    ctx.strokeStyle = `rgba(255,${gg},${bb},${alpha.toFixed(3)})`;
    ctx.lineWidth = wrapW;
    ctx.beginPath();
    ctx.arc(p.x, p.y, wrapR, a0, a1);
    ctx.stroke();
  }

  // ---- Near side of the disk, crossing in FRONT of the shadow ---------
  // In a real image the near edge of the disk passes between us and the
  // hole, so it is drawn on top of the black sphere.
  const bandW = r * 2.9;
  const bandH = Math.max(1.2, r * 0.15);
  const bg = ctx.createLinearGradient(p.x - bandW / 2, 0, p.x + bandW / 2, 0);
  bg.addColorStop(0.00, 'rgba(255,238,220,0)');
  bg.addColorStop(0.30, 'rgba(255,244,232,0.50)');
  bg.addColorStop(0.50, 'rgba(255,251,242,0.72)');
  bg.addColorStop(0.70, 'rgba(255,244,232,0.42)');
  bg.addColorStop(1.00, 'rgba(255,238,220,0)');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, bandW / 2, bandH, 0, 0, TAU);
  ctx.fill();

  // ---- Faint outer lensing halo --------------------------------------
  ctx.strokeStyle = 'rgba(228,240,255,0.30)';
  ctx.lineWidth = Math.max(0.8, r * 0.022);
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.64, 0, TAU); ctx.stroke();

  // Invulnerability flash overrides the whole assembly.
  if (invuln > 0 && Math.floor(invuln * 18) % 2 === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.beginPath(); ctx.arc(p.x, p.y, ringR, 0, TAU); ctx.stroke();
  }

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
    const hue = w.hue == null ? 190 : w.hue;
    ctx.strokeStyle = `hsla(${hue}, 100%, 74%, ${k * 0.7})`;
    ctx.lineWidth = Math.max(1.5, w.max * 0.03 * k);
    ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, TAU); ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ============================================================
   HUD + LOOP
   ============================================================ */
function updateHUD() {
  // Don't let the rolling counter keep easing while paused -- nothing should
  // animate on screen when the game is stopped.
  if (state !== 'paused') {
    shownScore = lerp(shownScore, score, 0.18);
    if (Math.abs(shownScore - score) < 0.6) shownScore = score;
    el.hudScore.textContent = fmt(Math.round(shownScore));
  }
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
let crashed = false;
function frame(now) {
  if (crashed) return;
  try {
    const real = Math.min((now - last) / 1000, 0.05);
    last = now;
    let dt = real;
    if (hitstopT > 0) { hitstopT -= real; dt = real * 0.18; }
    update(dt);
    render();
    updateHUD();
  } catch (err) {
    // A throw inside the loop used to leave a silent black canvas with the
    // menu already hidden -- completely indistinguishable from "the game is
    // broken". Surface the error and restore the menu so the player can see
    // what happened and try again.
    crashed = true;
    fatal('The game hit an error while running.\n\n' +
          ((err && err.stack) || String(err)));
    state = 'menu';
    hide(el.hud); hide(el.pause); hide(el.settings); hide(el.over);
    show(el.menu);
    return;
  }
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
  if (el.cbBtn) el.cbBtn.textContent = 'COLOUR: ' + (CB_LABEL[cbMode] || 'NORMAL');
  if (el.ctrlBtn) {
    el.ctrlBtn.textContent = 'CONTROL: ' + (CTRL_LABEL[controlMode] || 'JOYSTICK');
  }
}

/* ============================================================
   INPUT
   ============================================================ */
// Three control schemes. The README described drag-to-move while the code
// only ever had a joystick -- both now exist and are selectable in Settings.
const CTRL_ORDER = ['joystick', 'follow', 'relative'];
const CTRL_LABEL = { joystick: 'JOYSTICK', follow: 'FOLLOW', relative: 'RELATIVE' };
let controlMode = lsGet('control', 'joystick');
if (CTRL_ORDER.indexOf(controlMode) < 0) controlMode = 'joystick';

// Screen-space anchor used by the two drag schemes.
const drag = { active: false, sx: 0, sy: 0, ax: 0, ay: 0, wx: 0, wy: 0 };

function screenToWorld(cx, cy) {
  return {
    x: (cx - W / 2) / cam.zoom + cam.x,
    y: (cy - H / 2) / cam.zoom + cam.y
  };
}

cvs.addEventListener('pointerdown', (e) => {
  ensureAudio();
  try { cvs.setPointerCapture(e.pointerId); } catch (_) {}

  if (controlMode === 'joystick') {
    // Floating joystick: it anchors wherever you actually touch. A fixed
    // left-hand zone meant any tap in the middle of the screen did nothing
    // at all, which just reads as "the game is broken". There is no dead
    // zone now -- anywhere you put a finger works.
    joy.active = true;
    joy.bx = e.clientX; joy.by = e.clientY;
    joy.kx = e.clientX; joy.ky = e.clientY;
    joy.dx = 0; joy.dy = 0;
    return;
  }

  drag.active = true;
  drag.sx = e.clientX; drag.sy = e.clientY;
  drag.ax = p.x;       drag.ay = p.y;
  if (controlMode === 'follow') {
    const w = screenToWorld(e.clientX, e.clientY);
    drag.wx = w.x; drag.wy = w.y;
  } else {
    drag.wx = p.x;   drag.wy = p.y;
  }
});

cvs.addEventListener('pointermove', (e) => {
  if (controlMode === 'joystick') {
    if (!joy.active) return;
    joy.kx = e.clientX;
    joy.ky = e.clientY;
    let dx = (joy.kx - joy.bx) / JOY_R;
    let dy = (joy.ky - joy.by) / JOY_R;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    joy.dx = dx;
    joy.dy = dy;
    return;
  }
  if (!drag.active) return;
  if (controlMode === 'follow') {
    // The hole steers to wherever your finger is standing.
    const w = screenToWorld(e.clientX, e.clientY);
    drag.wx = w.x; drag.wy = w.y;
  } else {
    // Relative: the hole shifts by how far your thumb has travelled since it
    // landed, so it tracks the gesture instead of snapping to the fingertip.
    drag.wx = drag.ax + (e.clientX - drag.sx) / cam.zoom;
    drag.wy = drag.ay + (e.clientY - drag.sy) / cam.zoom;
  }
});

function pointerRelease() {
  joy.active = false;
  joy.dx = 0;
  joy.dy = 0;
  drag.active = false;
}
cvs.addEventListener('pointerup', pointerRelease);
cvs.addEventListener('pointercancel', pointerRelease);

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
  lsSet('muted', Snd.muted ? '1' : '0');
  if (Snd.master) Snd.master.gain.setTargetAtTime(Snd.muted ? 0 : 0.85, Snd.ac.currentTime, 0.05);
  el.muteBtn.classList.toggle('off', Snd.muted);
  syncSettingsUI();
}

el.muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
el.soundBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });

el.motionBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  motion = !motion;
  lsSet('motion', motion ? '1' : '0');
  if (!motion) { shakeMag = 0; camRoll = 0; }     // also kills the tilt
  syncSettingsUI();
});

el.cbBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const i = CB_ORDER.indexOf(cbMode);
  cbMode = CB_ORDER[(i + 1) % CB_ORDER.length];
  lsSet('cb', cbMode);
  syncSettingsUI();
});

el.ctrlBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const i = CTRL_ORDER.indexOf(controlMode);
  controlMode = CTRL_ORDER[(i + 1) % CTRL_ORDER.length];
  lsSet('control', controlMode);
  // Drop any in-flight input so the schemes cannot fight each other.
  joy.active = false; joy.dx = 0; joy.dy = 0;
  drag.active = false;
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

best = parseInt(lsGet('best', 0), 10) || 0;
el.muteBtn.classList.toggle('off', Snd.muted);
syncSettingsUI();
if (el.buildTag) el.buildTag.textContent = 'build ' + BUILD_ID;

try {
  buildShade();
  resize();
  reset();
  toMenu();
  requestAnimationFrame((t) => { last = t; frame(t); });
} catch (err) {
  fatal((err && err.stack) || String(err));
}

// The service worker has now caused more confusion than it ever solved. It
// kept serving stale JS after fixes, which is exactly what produced "your
// changes didn't work" and "nothing is visible". Unregister it so the browser
// always loads the build actually on disk. Nothing is lost: the Android app
// never used it -- Capacitor bundles the assets into the APK directly.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => { for (const r of regs) r.unregister(); })
    .catch(() => {});
}
