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
const mod = (a, n) => ((a % n) + n) % n;
const smooth = (perSecond, dt) => 1 - Math.pow(perSecond, dt);

// ---- Randomness ---------------------------------------------------------
// One seeded stream for the entire simulation, so a run is reproducible from a
// seed. That is the foundation for daily seeds, ghost replay, and bug reports
// that can actually be re-run rather than described.
//
// Previously the game used rng() at 35 call sites, which made a run
// unreproducible by construction -- no amount of recording could replay it.
// Seeding is also what lets two players get an identical field on a given day.
let rngState = 1;
function seedRng(s) { rngState = (s >>> 0) || 1; }
function rng() {
  rngState = rngState + 0x6D2B79F5 | 0;
  let t = Math.imul(rngState ^ rngState >>> 15, 1 | rngState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const rand = (a, b) => a + rng() * (b - a);
// Audio variation must not advance the seeded simulation stream.
const cosmeticRandom = () => Math.random();

// The seed a run was generated from. Kept so a run can be described exactly,
// and so ?seed=NNN pins a field -- which turns "it broke when a giant spawned
// on top of me" into a URL someone else can actually reproduce.
let runSeed = 0, runCounter = 0;
function seedFromUrl() {
  try {
    const v = new URLSearchParams(location.search).get('seed');
    if (v === null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? (n >>> 0) : null;
  } catch (_) { return null; }
}
function nextRunSeed() {
  // One-shot override (daily run) wins over everything, then the URL pin.
  if (seedOverride !== null) {
    const s = seedOverride >>> 0;
    seedOverride = null;
    return s;
  }
  const forced = seedFromUrl();
  if (forced !== null) return forced;
  runCounter++;
  return (Date.now() ^ Math.imul(runCounter, 2654435761)) >>> 0;
}

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
const P0 = 22;
const M0 = 10;
const RS_PER_MASS = P0 / M0;
const RADIATIVE_EFFICIENCY = 0.057;
const DEATH_AREA = P0 * P0 * 0.30;   // collapse below this
const ENT_TARGET = 110;              // entities kept alive
const COMBO_WINDOW = 1.35;           // seconds to keep a chain alive
const CONSUME_YIELD = 0.34;          // how much of a body becomes your mass
const STAR_BONUS = 3;                // score multiplier for eating a star

/* ---------- real-unit scale ----------
   The HUD reports how big the hole actually is. The anchor is chosen so a run
   climbs through scales a player can picture: P0 reads as roughly one Earth
   diameter, a few meals in reads as Neptune, then Jupiter, then the Sun, and
   only a very long run reaches orbital distances. The ratios between the steps
   are real; only the absolute anchor is a game choice. */
const KM_PER_UNIT = 300;             // P0 (22) is about 13,200 km across
const AU_KM = 1.495978707e8;
const LY_KM = 9.4607e12;             // one light-year in km

/* ---------- movement physics ----------
   SPEED_REF is the one number that sets how fast the hole can ever go:
   top speed is SPEED_REF * r, exactly as before, so the difficulty curve and
   the reachability of food are untouched by the switch to inertial motion.

   SPACE_DRAG and DRIFT_EXP only decide how long it takes to get there and how
   long you coast afterwards. Raising DRIFT_EXP makes big holes feel heavier;
   setting it to 0 makes every size equally twitchy. */
const SPEED_REF = 11;      // top speed, in shadow radii per second
const SPACE_DRAG = 1.70;   // velocity bleed at the starting mass
const DRIFT_EXP = 0.45;    // how much more a big hole coasts and lags
const IMPULSE_CAP = 1.9;   // knockback headroom, as a multiple of top speed

// How far ahead of the hole the camera leads, in seconds of travel. Small on
// purpose: enough to open up the space you are moving into rather than the
// space you just left, without making the hole feel detached from the camera.
const CAM_LEAD = 0.18;

// Bumped on each change and shown on the menu. Stale caches have already cost
// a whole round of "your changes didn't work", so make the running build
// visible rather than guessable.
const BUILD_ID = 'b22';

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
// Run-scoped progression is reset with the simulation, not by wall timers.
let runUpgrades = { gravity: 0, accretion: 0, horizon: 0, singularity: 0 };
let runDustScore = 0, runEaten = 0, lastMealT = 0;
let rareWindowActive = false, rareWindowT = 0, rareSpawnT = 0;
const cosmeticRand = (a, b) => a + cosmeticRandom() * (b - a);
let p, ents, parts, waves, shots, slugs, floats, cam;
let score = 0, shownScore = 0, best = 0, newBest = false;
let combo = 0, comboT = 0, elapsed = 0, era = 0;
let shakeMag = 0, hitstopT = 0, invuln = 0, flashT = 0;
let pendingWave = 0, shotT = 0;   // AGN feedback wind-up timer (0 = none)
let panel = null;   // null | 'pause' | 'settings' | 'event'
let camRoll = 0;    // proximity tilt wobble near big bodies
let shield = 0;     // one-hit protection from eating a pulsar
let kilonovaT = 0;  // countdown to the next neutron-star merger event

// New feedback state.
let eraFx = 0;          // milestone celebration envelope (era-up)
let hitFx = 0;          // directional damage vignette envelope
let hitDirX = 0, hitDirY = 0;   // unit vector from the hole to the impact
let nearDeath = 0;      // 0 = comfortable, 1 = about to evaporate
let lastHurtT = -99;    // elapsed time of the last impact (death attribution)
let overGuardT = 0;     // input guard so a stray tap cannot skip the score
let drainRate = 0;      // current fractional decay, for the vignette pulse
let eventKey = null;    // which first-encounter panel is open
// What the world was doing before the panel froze it. closeEventPanel has to
// restore THIS, not 'play' -- see the guard there.
let eventReturnState = 'play';
let coachStep = 0;      // first-run scripted hint index
let bestAtRunStart = 0; // previous best, for the "N away from BEST" line
let runStats = { time: 0, peakCombo: 0, biggest: 0, biggestName: '', era: 0, cause: '' };
let comboPopT = 0;      // combo-heat pop envelope
let nextSystemId = 1;   // unique ID for star systems
let satiatedT = 0;      // decay holiday after a meal (Tier 0 tension curve)
let lastBeatT = -99;    // last heartbeat haptic, for the low-mass warning
let sparseOn = false;   // low-mass music strip-back currently engaged
let greedT = 0;         // greed-gate window remaining
let greedE = null;      // the body the greed gate applies to
let pickT = 0;          // AGN feedback steering-pick window remaining
let pickHold = null;    // accumulated steering dwell per lane
let spinA = 0;          // Kerr spin parameter a/M, 0 (Schwarzschild) .. 0.998
let kilonovaWarned = false;  // kilonova telegraph already fired this cycle
let seedOverride = null;// one-shot forced seed (daily run)
let dailyRun = false;   // this run is the daily-seeded attempt
let ghostOn = true;       // race your best-run ghost (loaded with options)
let ghostData = null;   // recorded positions of the best run
let ghostRec = null;    // live recording of this run's positions
let ghostClock = 0;     // 10 Hz recording accumulator
function loadGhost() {
  try {
    const g = save.ghost;
    if (g && Array.isArray(g.x) && Array.isArray(g.y) &&
        g.x.length === g.y.length && g.x.length) return g;
  } catch (_) {}
  return null;
}
// Per-run mission counters. runStats carries the report card; these carry the
// mission objectives. Both reset in reset().
let runMission = null;
function resetMissionCounters() {
  runMission = { wd: 0, ark: 0, pulsar: 0, graze: 0, waveBest: 0 };
}

// Last input device. The floating joystick's home ring is a touch affordance;
// Tracks the last thing that drove the hole. Only used to decide whether the
// stick should be dimmed for a player who is clearly on a keyboard.
let lastInput = 'touch';
// Pointer position, kept for press-state only.
const pointer = { x: 0, y: 0, on: false, down: false };

const keys = { up: false, down: false, left: false, right: false };

// Fixed joystick, pinned to the bottom centre of the screen. This is an
// Android game first, so the stick is the primary control and it never moves:
// a base that slides to wherever you first touched means you have to look down
// and find it mid-dodge. A fixed base you can hit blind is the whole point.
//
// JOY_R is recomputed on every resize from the viewport height, because a
// radius that reads well on a tablet is half the screen on a landscape phone.
let JOY_R = 78;
let JOY_KNOB = 28;
let JOY_BASE_X = 0;
let JOY_BASE_Y = 0;
let SAFE_BOTTOM = 0;
// Throw before the hole responds at all. Without it a resting thumb that
// drifts a few pixels constantly nudges the hole off course.
const JOY_DEADZONE = 0.16;
const joy = { active: false, bx: 0, by: 0, kx: 0, ky: 0, dx: 0, dy: 0 };

// Android draws an edge-to-edge canvas, so the gesture pill sits on top of
// whatever we put at the bottom. env() only exists in CSS, so measure it by
// laying out a probe element and reading it back.
function readSafeBottom() {
  try {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);' +
      'pointer-events:none;visibility:hidden';
    document.body.appendChild(probe);
    SAFE_BOTTOM = probe.getBoundingClientRect().height || 0;
    probe.remove();
  } catch (_) {
    SAFE_BOTTOM = 0;
  }
}

// Fixed light direction so every world is lit consistently.
const LIGHT = { x: -0.52, y: -0.58 };

/* ---------- DOM ---------- */
const el = {
  hud: document.getElementById('hud'),
  hudScore: document.getElementById('hudScore'),
  hudBest: document.getElementById('hudBest'),
  chips: document.getElementById('chips'),
  threatOut: document.getElementById('threatOut'),
  scaleOut: document.getElementById('scaleOut'),
  comboWrap: document.getElementById('comboWrap'),
  comboValue: document.getElementById('comboValue'),
  comboBar: document.getElementById('comboBar'),
  menu: document.getElementById('menu'),
  playBtn: document.getElementById('playBtn'),
  menuBest: document.getElementById('menuBest'),
  menuSettingsBtn: document.getElementById('menuSettingsBtn'),
  ctrlPick: document.getElementById('ctrlPick'),
  ctrlHint: document.getElementById('ctrlHint'),
  varPick: document.getElementById('varPick'),
  varHint: document.getElementById('varHint'),
  dailyBtn: document.getElementById('dailyBtn'),
  missions: document.getElementById('missions'),
  histStrip: document.getElementById('histStrip'),
  over: document.getElementById('over'),
  finalScore: document.getElementById('finalScore'),
  overBest: document.getElementById('overGap'),
  report: document.getElementById('report'),
  newBest: document.getElementById('newBest'),
  againBtn: document.getElementById('againBtn'),
  shareBtn: document.getElementById('shareBtn'),
  muteBtn: document.getElementById('muteBtn'),
  toasts: document.getElementById('toasts'),
  pauseBtn: document.getElementById('pauseBtn'),
  pause: document.getElementById('pause'),
  pauseScore: document.getElementById('pauseScore'),
  resumeBtn: document.getElementById('resumeBtn'),
  restartBtn: document.getElementById('restartBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  homeBtn: document.getElementById('homeBtn'),
  observe: document.getElementById('observe'),
  obsFov: document.getElementById('obsFov'),
  obsNearest: document.getElementById('obsNearest'),
  obsSpan: document.getElementById('obsSpan'),
  obsEra: document.getElementById('obsEra'),
  obsSpin: document.getElementById('obsSpin'),
  overHomeBtn: document.getElementById('overHomeBtn'),
  settings: document.getElementById('settings'),
  soundBtn: document.getElementById('soundBtn'),
  musicRange: document.getElementById('musicRange'),
  musicVal: document.getElementById('musicVal'),
  sfxRange: document.getElementById('sfxRange'),
  sfxVal: document.getElementById('sfxVal'),
  hapticBtn: document.getElementById('hapticBtn'),
  ghostBtn: document.getElementById('ghostBtn'),
  motionBtn: document.getElementById('motionBtn'),
  cbBtn: document.getElementById('cbBtn'),
  ctrlBtn: document.getElementById('ctrlBtn'),
  textBtn: document.getElementById('textBtn'),
  contrastBtn: document.getElementById('contrastBtn'),
  threatBtn: document.getElementById('threatBtn'),
  eventBtn: document.getElementById('eventBtn'),
  settingsBackBtn: document.getElementById('settingsBackBtn'),
  eventPanel: document.getElementById('eventPanel'),
  eventTitle: document.getElementById('eventTitle'),
  eventBody: document.getElementById('eventBody'),
  eventOkBtn: document.getElementById('eventOkBtn'),
  keysLegend: document.getElementById('keysLegend'),
  buildTag: document.getElementById('buildTag')
};

const show = (n) => n.classList.remove('hidden');
const hide = (n) => n.classList.add('hidden');
const fmt = (n) => {
  if (!isFinite(n)) return '---';
  if (Math.abs(n) >= 1e21) return Number(n).toExponential(2);
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

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
  if (state === 'play' || state === 'paused') settleScoreDust();
  if (score > best) { best = score; saveSet('best', best); return true; }
  return false;
}

const motionQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let motionPreference = lsGet('motion', '1') === '1';
let motion = motionPreference && !(motionQuery && motionQuery.matches);
// Accessibility + comfort options. All persisted in the same versioned blob.
let textLarge = lsGet('text', '0') === '1';
let highContrast = lsGet('contrast', '0') === '1';
let threatReadout = lsGet('threat', '0') === '1';
let pauseOnEvent = lsGet('eventPause', '1') !== '0';
let coachDone = lsGet('coach', '0') === '1';
// Older saves used ghost for BOTH the toggle string and the recording.
// Migrate the preference only; never overwrite a surviving recording.
if (save.ghostOn === undefined) {
  saveSet('ghostOn', save.ghost === '0' ? '0' : '1');
}
ghostOn = lsGet('ghostOn', '1') !== '0';
ghostData = loadGhost();

// Run history: five scores with dates. A single BEST number has no story.
const HIST_MAX = 5;
let history = Array.isArray(save.history) ? save.history.slice(0, HIST_MAX) : [];
history = history.filter((h) => h && typeof h.s === 'number');

function pushHistory(s, when) {
  // A run that ended without scoring is not a run worth charting. It used to
  // be recorded anyway, so a first attempt that collapsed immediately wrote a
  // zero-height bar into the footer while the BEST chip beside it still said
  // "no runs yet" -- two readouts disagreeing about whether you had played.
  if (!(s > 0)) return;
  history.unshift({ s: Math.round(s), t: when || Date.now() });
  history = history.slice(0, HIST_MAX);
  saveSet('history', history);
}

/* ---------- haptics ---------- */
const HAPTIC_ORDER = ['off', 'low', 'med', 'high'];
const HAPTIC_LABEL = { off: 'Off', low: 'Low', med: 'Medium', high: 'High' };
const HAPTIC_SCALE = { off: 0, low: 0.45, med: 1, high: 1.7 };
let haptics = lsGet('haptic', 'off');
if (HAPTIC_ORDER.indexOf(haptics) < 0) haptics = 'off';

function buzz(ms) {
  const k = HAPTIC_SCALE[haptics] || 0;
  if (!k) return;
  try {
    if (navigator.vibrate) navigator.vibrate(Math.max(6, Math.round(ms * k)));
  } catch (_) {}
}

/* ============================================================
   AUDIO
   ============================================================ */

// Adaptive playlist. The five shipped tracks are already named for the five
// eras (nebula -> stellar -> intermediate -> supermassive -> quasar), so the
// simplest "adaptive" music is to pick the track that matches where the
// player is. A live combo nudges one slot up so a heated moment gets a more
// intense track instead of staying on the current one.
function pickMusicTrack() {
  const n = Snd.TRACKS.length;
  if (!n) return 0;
  let idx = era % n;
  if (combo >= 3 && comboT > 0 && idx < n - 1) idx++;
  return idx;
}

const Snd = {
  ac: null, master: null, musicBus: null, sfxBus: null,
  droneGain: null, droneFilter: null, noise: null,
  muted: lsGet('muted', '0') === '1',
  // Separate buses so "mute everything" stops being the only tool available.
  musicVol: clamp(parseFloat(lsGet('music', 0.7)) || 0, 0, 1),
  sfxVol: clamp(parseFloat(lsGet('sfx', 0.85)) || 0, 0, 1),

  ensure() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = this.ac = new AC();

    const master = this.master = ac.createGain();
    master.gain.value = this.muted ? 0 : 0.85;
    master.connect(ac.destination);

    const music = this.musicBus = ac.createGain();
    music.gain.value = this.musicVol;
    music.connect(master);

    const sfx = this.sfxBus = ac.createGain();
    sfx.gain.value = this.sfxVol;
    sfx.connect(master);

    const len = Math.floor(ac.sampleRate * 0.5);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (cosmeticRandom() * 2 - 1) * (1 - i / len);
    this.noise = buf;

    const dg = this.droneGain = ac.createGain();
    dg.gain.value = 0;
    const df = this.droneFilter = ac.createBiquadFilter();
    df.type = 'lowpass'; df.frequency.value = 200; df.Q.value = 5;
    dg.connect(df); df.connect(music);

    [[55, 'sawtooth', 0.16], [55.7, 'sawtooth', 0.15], [82.5, 'sine', 0.10]]
      .forEach(([f, type, g]) => {
        const o = ac.createOscillator();
        o.type = type; o.frequency.value = f;
        const gg = ac.createGain(); gg.gain.value = g;
        o.connect(gg); gg.connect(dg); o.start();
      });
  },

  setMusicVol(v) {
    this.musicVol = clamp(v, 0, 1);
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicVol, this.ac.currentTime, 0.05);
    this.updateMusicAssetVol();
  },

  setSfxVol(v) {
    this.sfxVol = clamp(v, 0, 1);
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(this.sfxVol, this.ac.currentTime, 0.05);
  },

  // Two oscillators a few cents apart rather than one. A single oscillator is
  // a pure mathematical waveform, and that is precisely why one sounds
  // synthetic; the slight detune produces the slow beating that makes it read
  // as an instrument instead. The drone already did this (55 and 55.7 Hz
  // sawtooths) -- the eat blip, which is the sound you hear most, did not.
  tone(freq, type, peak, attack, decay, detuneCents) {
    const ac = this.ac, t = ac.currentTime;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // Two voices sum, so trim the peak to keep the perceived level steady.
    g.gain.linearRampToValueAtTime(peak * 0.62, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    g.connect(this.sfxBus);
    const cents = (detuneCents === undefined) ? 8 : detuneCents;
    for (let i = 0; i < 2; i++) {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = i === 0 ? -cents : cents;
      o.connect(g);
      o.start(t); o.stop(t + decay + 0.02);
    }
  },

  // A very short filtered noise click. The transient is most of what makes a
  // sound feel physical rather than synthesised -- a note that starts at full
  // volume with no attack noise reads as a beep.
  tick(freq, q, peak, decay) {
    if (!this.ac || this.muted || !this.noise) return;
    const ac = this.ac, t = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = this.noise;
    const f = ac.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = freq; f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    s.connect(f); f.connect(g); g.connect(this.sfxBus);
    s.start(t); s.stop(t + decay + 0.02);
  },

  // rising pentatonic blip — the main dopamine lever
  blip(step) {
    if (!this.ac || this.muted) return;
    const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34, 36];
    const semi = SCALE[Math.min(step, SCALE.length - 1)];
    const f = 196 * Math.pow(2, semi / 12);
    // Slight per-note detune so a fast chain of eats does not sound like the
    // same sample retriggered.
    this.tone(f, 'triangle', 0.19, 0.008, 0.20, 6 + cosmeticRandom() * 8);
    this.tick(f * 6, 1.4, 0.045, 0.03);
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
    s.connect(f); f.connect(g); g.connect(this.sfxBus);
    s.start(t); s.stop(t + 0.15);
  },

  nova() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34 * 0.62, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    g.connect(this.sfxBus);
    // Two detuned sweepers plus a noise swell. A single sine sweep is the
    // classic placeholder laser; the second voice and the noise give it mass.
    for (let i = 0; i < 2; i++) {
      const o = ac.createOscillator(); o.type = 'sine';
      o.detune.value = i === 0 ? -14 : 14;
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(1500, t + 0.5);
      o.connect(g);
      o.start(t); o.stop(t + 0.72);
    }
    this.tick(900, 0.7, 0.13, 0.45);
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
    s.connect(f); f.connect(g); g.connect(this.sfxBus);
    s.start(t); s.stop(t + 0.36);

    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.30);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(og); og.connect(this.sfxBus);
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
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.44);
  },

  // Pitch sweep primitive for risers, falls and telegraphs.
  sweep(f0, f1, dur, peak, type) {
    if (!this.ac || this.muted) return;
    try {
      const ac = this.ac, t = ac.currentTime;
      const o = ac.createOscillator(); o.type = type || 'sine';
      o.frequency.setValueAtTime(Math.max(1, f0), t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.sfxBus);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (_) {}
  },

  riser() { this.sweep(200, 900, 1.1, 0.12); },       // kilonova telegraph
  fall() { this.sweep(600, 140, 0.5, 0.14, 'triangle'); },  // combo break

  // Stingers: short composed phrases in the drone's key that punctuate
  // milestones. Scheduled with timers so they need no sequencer.
  sting(kind) {
    if (!this.ac || this.muted) return;
    const seq = {
      era:     [[523, 0], [659, 90], [784, 180]],
      wave:    [[196, 0], [294, 60], [392, 120]],
      death:   [[392, 0], [311, 120], [233, 240]],
      mission: [[660, 0], [880, 100]],
      finale:  [[523, 0], [659, 120], [784, 240], [1046, 360]]
    }[kind];
    if (!seq) return;
    seq.forEach(([f, ms]) => setTimeout(() => {
      try { if (this.ac && !this.muted) this.tone(f, 'triangle', 0.16, 0.01, 0.3, 5); }
      catch (_) {}
    }, ms));
  },

  // Low-mass strip-back: duck the music and thin the drone when evaporation
  // threatens, so danger reads in the mix as well as the vignette.
  setSparse(on) {
    if (!this.ac) return;
    try {
      const t = this.ac.currentTime;
      if (this.musicBus) {
        this.musicBus.gain.setTargetAtTime(on ? this.musicVol * 0.35 : this.musicVol, t, 0.4);
      }
      if (this.droneFilter) {
        this.droneFilter.frequency.setTargetAtTime(on ? 120 : 180, t, 0.4);
      }
    } catch (_) {}
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
    o.connect(f); f.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 1.15);
  },

  // ---- Bundled soundtrack -----------------------------------------------
  // www/audio ships five generated ambient tracks (tools/make_music.py
  // recreates them). They play through plain Audio elements rather than the
  // WebAudio graph: the procedural game sounds stay on their synth buses, and
  // the music follows the MUSIC slider and the master mute without requiring
  // anything extra of the audio context. Playback only ever starts from inside
  // a user gesture (BEGIN / RUN AGAIN), which is what WebView's autoplay
  // policy demands.
  TRACKS: ['audio/01-nebula.mp3', 'audio/02-stellar.mp3', 'audio/03-intermediate.mp3',
           'audio/04-supermassive.mp3', 'audio/05-quasar.mp3'],
  trackIdx: 0,
  audioEl: null,
  musicOn: false,

  updateMusicAssetVol() {
    if (this.audioEl) this.audioEl.volume = this.muted ? 0 : this.musicVol * 0.8;
  },

  // .play() returns a Promise in real engines but undefined in some stubs, so
  // route both start paths through this one guard.
  playMusicAsset() {
    try {
      const p = this.audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  },

  setMusicAsset(on) {
    this.musicOn = on;
    if (on) {
      if (!this.audioEl) {
        try {
          const a = this.audioEl = new Audio();
          // Pick a track that matches the current era so the soundtrack
          // escalates with the player, not in fixed sequence.
          this.trackIdx = pickMusicTrack();
          a.src = this.TRACKS[this.trackIdx];
          // Cross to the next track on end -- never a hard silence gap.
          a.addEventListener('ended', () => {
            if (!this.musicOn || !this.audioEl) return;
            this.trackIdx = pickMusicTrack();
            this.audioEl.src = this.TRACKS[this.trackIdx];
            this.updateMusicAssetVol();
            this.playMusicAsset();
          });
        } catch (_) { this.audioEl = null; return; }
      } else {
        // An era transition since last pick: switch immediately to the track
        // that matches where the player is now.
        const want = pickMusicTrack();
        if (want !== this.trackIdx) {
          this.trackIdx = want;
          this.audioEl.src = this.TRACKS[this.trackIdx];
        }
      }
      this.updateMusicAssetVol();
      this.playMusicAsset();
    } else if (this.audioEl) {
      this.audioEl.pause();
    }
  },

  setDrone(on, c) {
    if (!this.ac) return;
    // Music assets ride the same on/off signal as the drone, so every existing
    // lifecycle path (pause, death, menu, page visibility) pauses them too.
    this.setMusicAsset(on);
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

// The civilisation reacts to your escalation. Early on they panic and flee
// (arks). Once you have proven you are a threat they start building shields
// and projecting their own gravity wells (repulsors). At supermassive scale
// they go on the offensive: extractors skim your energy, mass drivers shoot.
// Weighted pools make the curve gradual instead of all at once.
const CIV_POOL_EARLY = ['ark', 'ark', 'ark', 'shield'];
const CIV_POOL_MID   = ['ark', 'shield', 'shield', 'repulsor', 'repulsor'];
const CIV_POOL_LATE  = ['shield', 'repulsor', 'repulsor', 'extractor', 'driver'];
function pickCivType() {
  let pool;
  if (era < 2) pool = CIV_POOL_EARLY;
  else if (era < 4) pool = CIV_POOL_MID;
  else pool = CIV_POOL_LATE;
  return pool[(rng() * pool.length) | 0];
}

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

// Which bodies actually have an atmosphere, and the colour its limb glow takes.
// A rocky or barren world has no air, so it gets none -- that contrast is the
// point. The halo is what separates "a lit sphere" from "a sphere in space".
const ATMO_TYPES = {
  ocean:   'rgba(120,190,255,0.16)',
  ice:     'rgba(200,235,255,0.13)',
  desert:  'rgba(255,190,140,0.10)',
  giant:   'rgba(255,215,170,0.12)',
  uranus:  'rgba(190,245,240,0.13)',
  neptune: 'rgba(120,160,255,0.14)',
  lava:    'rgba(255,130,60,0.10)'
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

  // ---- Shading, applied over the surface detail ------------------------
  // A planet used to be a flat vertical gradient clipped to a circle, which
  // reads as a sticker rather than a sphere. Three cheap passes fix it.

  // 1. Limb darkening. A real disc is darker at its edge, because at a grazing
  // angle you are looking through more atmosphere and less surface.
  const limb = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.52, SPR_R, SPR_R, SPR_R);
  limb.addColorStop(0.00, 'rgba(0,0,0,0)');
  limb.addColorStop(0.74, 'rgba(0,0,0,0.10)');
  limb.addColorStop(1.00, 'rgba(0,0,0,0.40)');
  g.fillStyle = limb;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();

  // 2. A lit rim on the sunward limb. Painted as a full ring here and then
  // half-eaten by the terminator below, which leaves only the lit side bright.
  g.globalCompositeOperation = 'lighter';
  const rim = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.87, SPR_R, SPR_R, SPR_R);
  rim.addColorStop(0.00, 'rgba(255,255,255,0)');
  rim.addColorStop(1.00, 'rgba(255,252,244,0.20)');
  g.fillStyle = rim;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';

  // 3. Terminator -- the day/night line. The scene light is fixed, so the
  // shadowed hemisphere is always the lower-right. This is the single change
  // that makes the bodies look like they are being lit by something.
  const lx = SPR_R - LIGHT.x * SPR_R * 1.6;
  const ly = SPR_R - LIGHT.y * SPR_R * 1.6;
  const term = g.createLinearGradient(lx, ly, SPR_R * 2 - lx, SPR_R * 2 - ly);
  term.addColorStop(0.00, 'rgba(0,0,0,0)');
  term.addColorStop(0.42, 'rgba(0,0,0,0.05)');
  term.addColorStop(1.00, 'rgba(2,4,10,0.46)');
  g.fillStyle = term;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R, 0, TAU); g.fill();

  g.restore();

  // 4. Atmospheric halo, outside the clip so it can bleed past the limb. Only
  // bodies that actually have an atmosphere get one.
  if (ATMO_TYPES[type]) {
    g.globalCompositeOperation = 'lighter';
    const at = g.createRadialGradient(SPR_R, SPR_R, SPR_R * 0.94, SPR_R, SPR_R, SPR_R * 1.20);
    at.addColorStop(0.00, ATMO_TYPES[type]);
    at.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = at;
    g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 1.20, 0, TAU); g.fill();
    g.globalCompositeOperation = 'source-over';
  }
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

// A rival singularity — a real black hole with its own accretion disk. It is
// the most dangerous thing in the field and it pulls you in.
//
// The old version painted a cream radial gradient straight over the shadow
// (a radial gradient repeats its first stop all the way inward), so the hole
// rendered as a beige ball with a dark rim instead of a black one. Same
// structure as the player now: disk first, then the shadow on top, then the
// photon ring.
function drawRival(g) {
  const R = SPR_R * 0.50;

  // Disk: a thin band seen almost edge-on, so it crosses the shadow.
  // Layered exactly like the player's disk so the two holes read as the
  // same kind of object -- one projected circle would give a hard-edged bar.
  const RD = SPR_R * 0.98;
  const flats = [1.00, 0.74, 0.48, 0.26];
  const share = 1 / flats.length;
  g.globalCompositeOperation = 'lighter';
  for (const flat of flats) {
    g.save();
    g.translate(SPR_R, SPR_R);
    g.scale(1, 0.15 * flat);
    const dg = g.createRadialGradient(0, 0, 0, 0, 0, RD);
    dg.addColorStop(0.00, 'rgba(255,246,228,' + (0.95 * share).toFixed(3) + ')');
    dg.addColorStop(0.34, 'rgba(255,214,152,' + (0.72 * share).toFixed(3) + ')');
    dg.addColorStop(0.70, 'rgba(255,150,80,' + (0.30 * share).toFixed(3) + ')');
    dg.addColorStop(1.00, 'rgba(255,118,48,0)');
    g.fillStyle = dg;
    g.beginPath(); g.arc(0, 0, RD, 0, TAU); g.fill();
    g.restore();
  }

  // Lensed far side, hugging the shadow.
  const hg = g.createRadialGradient(SPR_R, SPR_R, R * 1.0, SPR_R, SPR_R, SPR_R * 0.96);
  hg.addColorStop(0.00, 'rgba(255,244,224,0.50)');
  hg.addColorStop(0.45, 'rgba(255,180,110,0.20)');
  hg.addColorStop(1.00, 'rgba(255,140,80,0)');
  g.fillStyle = hg;
  g.beginPath(); g.arc(SPR_R, SPR_R, SPR_R * 0.96, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';

  // Bent background: the same concentric light-wrapping bands the player's
  // hole wears, so the two read as the same class of object. Static here
  // because this is a pre-rendered sprite.
  g.globalCompositeOperation = 'lighter';
  const rbands = [
    { k: 1.16, a: 0.150, w: 0.042 },
    { k: 1.32, a: 0.090, w: 0.032 },
    { k: 1.54, a: 0.052, w: 0.024 },
    { k: 1.82, a: 0.028, w: 0.018 }
  ];
  for (const b of rbands) {
    const rad = R * b.k;
    const g2 = g.createLinearGradient(SPR_R - rad, 0, SPR_R + rad, 0);
    g2.addColorStop(0.00, 'rgba(255,214,178,' + (b.a * 0.15).toFixed(3) + ')');
    g2.addColorStop(0.50, 'rgba(255,240,220,' + (b.a * 0.45).toFixed(3) + ')');
    g2.addColorStop(1.00, 'rgba(255,214,178,' + b.a.toFixed(3) + ')');
    g.strokeStyle = g2;
    g.lineWidth = Math.max(1, R * b.w);
    g.beginPath(); g.arc(SPR_R, SPR_R, rad, 0, TAU); g.stroke();
  }
  g.globalCompositeOperation = 'source-over';

  g.fillStyle = '#000';
  g.beginPath(); g.arc(SPR_R, SPR_R, R, 0, TAU); g.fill();

  // The lensed far side, come back round as a knot on the limb.
  g.globalCompositeOperation = 'lighter';
  const kx = SPR_R + R * 1.02;
  const ky = SPR_R + R * 0.18;
  const kg = g.createRadialGradient(kx, ky, 0, kx, ky, R * 0.34);
  kg.addColorStop(0.00, 'rgba(255,252,242,0.88)');
  kg.addColorStop(0.45, 'rgba(255,226,186,0.34)');
  kg.addColorStop(1.00, 'rgba(255,190,130,0)');
  g.fillStyle = kg;
  g.beginPath(); g.arc(kx, ky, R * 0.34, 0, TAU); g.fill();
  g.globalCompositeOperation = 'source-over';

  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,244,226,0.95)';
  g.lineWidth = 2.2;
  g.beginPath(); g.arc(SPR_R, SPR_R, R * 1.07, 0, TAU); g.stroke();
  g.globalCompositeOperation = 'source-over';
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
// Cosmic microwave background: the oldest light there is, released 380,000
// years after the Big Bang. It is a nearly uniform glow with temperature
// fluctuations of about one part in 100,000 -- real maps of it look like a
// faint mottling of warm and cool patches. Drawn beneath the starfield at very
// low alpha, it gives the void a floor instead of flat black.
let cmbPattern = null;
// Stellar spectral classes, weighted roughly the way a real field is weighted:
// the sky is dominated by cool K/M dwarfs, with hot blue stars rare. The old
// field painted every star the same rgba(198,228,255) -- one colour across
// three layers and fifty-eight stars, which is a large part of why it read as
// a texture rather than a sky.
const STAR_CLASSES = [
  { c: [155, 176, 255], w: 3,  lum: 1.00 },   // O/B  blue-white, rare, bright
  { c: [170, 191, 255], w: 6,  lum: 0.90 },   // A
  { c: [202, 215, 255], w: 10, lum: 0.80 },   // F
  { c: [255, 244, 234], w: 16, lum: 0.70 },   // G    sun-like
  { c: [255, 210, 161], w: 26, lum: 0.56 },   // K    orange
  { c: [255, 181, 107], w: 39, lum: 0.44 }    // M    red, common, dim
];
const STAR_W_TOTAL = STAR_CLASSES.reduce((s, k) => s + k.w, 0);

function pickStarClass(r) {
  let t = r * STAR_W_TOTAL;
  for (const k of STAR_CLASSES) { t -= k.w; if (t <= 0) return k; }
  return STAR_CLASSES[STAR_CLASSES.length - 1];
}

// One star, plus its four-point diffraction cross if it is bright enough.
// Spikes are what make a bright star read as BRIGHT rather than merely large.
function paintStar(g, x, y, r, a, col, spike) {
  g.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + a.toFixed(3) + ')';
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  if (!spike) return;
  const L = r * 7;
  const lg = g.createLinearGradient(x - L, y, x + L, y);
  lg.addColorStop(0.00, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0)');
  lg.addColorStop(0.50, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (a * 0.5).toFixed(3) + ')');
  lg.addColorStop(1.00, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0)');
  g.fillStyle = lg;
  g.fillRect(x - L, y - r * 0.16, L * 2, r * 0.32);
  const lg2 = g.createLinearGradient(x, y - L, x, y + L);
  lg2.addColorStop(0.00, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0)');
  lg2.addColorStop(0.50, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (a * 0.5).toFixed(3) + ')');
  lg2.addColorStop(1.00, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0)');
  g.fillStyle = lg2;
  g.fillRect(x - r * 0.16, y - L, r * 0.32, L * 2);
}

function buildStars() {
  starLayers = [
    { tile: 220, par: 0.12, n: 58, maxR: 0.70, a: 0.26, hero: 1 },
    { tile: 320, par: 0.30, n: 44, maxR: 1.00, a: 0.36, hero: 1 },
    { tile: 440, par: 0.54, n: 30, maxR: 1.40, a: 0.48, hero: 2 },
    { tile: 600, par: 0.80, n: 20, maxR: 1.85, a: 0.60, hero: 3 },
    { tile: 780, par: 1.06, n: 13, maxR: 2.40, a: 0.76, hero: 4 }
  ].map((cfg) => {
    const px = Math.round(cfg.tile * DPR);
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');

    for (let i = 0; i < cfg.n; i++) {
      const x = cosmeticRandom() * px, y = cosmeticRandom() * px;
      const cls = pickStarClass(cosmeticRandom());
      // Luminosity drives size: hot stars are both brighter and larger, which
      // is what makes a real field read as having depth rather than being
      // scattered confetti.
      const r = (cosmeticRandom() * cfg.maxR * cls.lum + 0.32) * DPR;
      const a = Math.min(1, (cosmeticRandom() * 0.5 + 0.5) * cfg.a * (0.55 + cls.lum * 0.65));
      const spike = i < cfg.hero && cls.lum > 0.55;

      // Draw at nine offsets so a star crossing a tile edge reappears on the
      // far side. Without this the tile has hard seams where stars are sliced
      // in half -- which, with a 180px tile, was half of why the field read as
      // a repeating pattern rather than a sky.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          paintStar(g, x + ox * px, y + oy * px, r, a, cls.c, spike);
        }
      }
    }
    return Object.assign({}, cfg, { pattern: ctx.createPattern(c, 'repeat') });
  });
}


// A tileable CMB field. Built from soft overlapping blobs rather than
// per-pixel noise: per-pixel would cost a full-canvas ImageData pass and, at
// this alpha, would just read as film grain anyway. Seeded so the pattern is
// stable across resizes instead of shimmering every time the window changes.
function buildCmb() {
  const T = 256;
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const g = c.getContext('2d');
  const rr = mulberry32(20240917);          // fixed seed: one canonical sky
  // No opaque base: the tile stays transparent and only carries the
  // fluctuations. The nebula wash is fully opaque, so anything painted under
  // it would simply vanish -- the CMB has to be an overlay on top of it.
  g.globalCompositeOperation = 'lighter';
  const N = 46;
  for (let i = 0; i < N; i++) {
    // Wrap at nine offsets like the starfield does, so blobs crossing an edge
    // reappear on the far side and the tile has no seams.
    const bx = rr() * T, by = rr() * T;
    const rad = (18 + rr() * 46);
    // Temperature fluctuation: slightly warm or slightly cool. Kept within a
    // narrow band -- a strong colour spread would read as a nebula, not as
    // the CMB.
    const warm = rr() < 0.5;
    const r = warm ? 120 : 90;
    const gg = warm ? 110 : 120;
    const b = warm ? 120 : 175;
    const a = 0.020 + rr() * 0.028;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const x = bx + ox * T, y = by + oy * T;
        const rg = g.createRadialGradient(x, y, 0, x, y, rad);
        rg.addColorStop(0, 'rgba(' + r + ',' + gg + ',' + b + ',' + a.toFixed(4) + ')');
        rg.addColorStop(1, 'rgba(' + r + ',' + gg + ',' + b + ',0)');
        g.fillStyle = rg;
        g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
      }
    }
  }
  g.globalCompositeOperation = 'source-over';
  cmbPattern = ctx.createPattern(c, 'repeat');
}

let vignette = null;
function buildVignette() {
  const g = ctx.createRadialGradient(W / 2, H / 2, MIN * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.72)');
  vignette = g;
}

let nebula = null, nebulaHue = -999, nebulaHeat = -1;
// The nebula already shifted HUE per era, but hue alone is a rotation, not a
// progression. Saturation and lightness now climb with it, so the sky goes
// from cold and thin to hot and dense across a run -- the palette carries the
// same arc as the mass.
function getNebula(hue, heat) {
  if (Math.abs(hue - nebulaHue) < 3 && Math.abs(heat - nebulaHeat) < 0.02) return nebula;
  const sat = 44 + heat * 26;
  const li = 6 + heat * 5;
  const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.85);
  g.addColorStop(0.00, `hsl(${hue}, ${sat.toFixed(0)}%, ${(li + 3).toFixed(1)}%)`);
  g.addColorStop(0.45, `hsl(${(hue + 28) % 360}, ${(sat - 4).toFixed(0)}%, ${li.toFixed(1)}%)`);
  g.addColorStop(1.00, `hsl(${(hue + 52) % 360}, ${(sat - 10).toFixed(0)}%, ${Math.max(2, li - 3).toFixed(1)}%)`);
  nebula = g; nebulaHue = hue; nebulaHeat = heat;
  return g;
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  MIN = Math.min(W, H);
  cvs.width = Math.round(W * DPR);
  cvs.height = Math.round(H * DPR);
  buildStars();
  buildCmb();
  buildVignette();
  nebulaHue = -999;
  nebulaHeat = -1;
  layoutStick();
}

// Geometry for the bottom-centre stick. Scaled off viewport HEIGHT rather than
// width, because the stick's budget is vertical: on a landscape phone the
// screen is short, and a 78px-radius stick would eat half of it.
function layoutStick() {
  readSafeBottom();
  JOY_R = clamp(H * 0.155, 40, 74);
  JOY_KNOB = JOY_R * 0.36;
  JOY_BASE_X = W * 0.5;
  // 26px of breathing room above the gesture bar, on top of the safe inset.
  JOY_BASE_Y = H - SAFE_BOTTOM - 26 - JOY_R;
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
  const q = rng();
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
const CB_LABEL = { normal: 'Normal', deutan: 'Deuteranopia', protan: 'Protanopia', tritan: 'Tritanopia' };
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
  // Spawn-time type follows the same lethality rule as everything else, so a
  // Wisp's wider gullet is born edible, not just treated as edible.
  const lethal = e.r > p.r * VARMODS[variant].thresh;
  const q = rng();
  let type, sub = null;
  let spin = rand(-0.75, 0.75);

  if (!lethal) {
    if (q < 0.04) {                                   // rare anomaly
      type = RARE[(rng() * RARE.length) | 0];
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
      type = EDIBLE[(rng() * EDIBLE.length) | 0];
    }
  } else {
    if (q < 0.40) {
      // A star you cannot yet swallow is an evolved giant, weighted toward
      // red giants the way real stellar populations are.
      type = 'star';
      const g = rng();
      sub = g < 0.62 ? 'redgiant' : (g < 0.88 ? 'supergiant' : 'bluegiant');
      spin = rand(-0.18, 0.18);
    } else if (q < 0.45) {                            // magnetar
      type = 'magnetar';
      spin = rand(-0.4, 0.4);
    } else if (q < 0.49) {                            // quasar
      type = 'quasar';
      spin = 0;
    } else {
      type = LETHAL[(rng() * LETHAL.length) | 0];
    }
  }
  e.body = { type, variant: (rng() * VARIANTS) | 0, spin, sub };
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
  const a = rng() * TAU;
  const dist = rand(v * 1.2, v * 1.6);
  const bx = p.x + Math.cos(a) * dist, by = p.y + Math.sin(a) * dist;
  const n = 4 + ((rng() * 5) | 0);
  for (let i = 0; i < n; i++) {
    const ra = rng() * TAU, rd = rng() * p.r * 3.2;
    const spin = rand(-2.8, 2.8);
    ents.push({
      x: bx + Math.cos(ra) * rd, y: by + Math.sin(ra) * rd,
      vx: rand(-0.05, 0.05) * p.r, vy: rand(-0.05, 0.05) * p.r,
      r: p.r * rand(0.10, 0.34),
      spin, phase: rng() * TAU,
      body: { type: 'asteroid', variant: (rng() * VARIANTS) | 0, spin }
    });
  }
}

function spawnComet() {
  const v = viewWorldRadius();
  const a = rng() * TAU;
  const dist = v * 1.5;
  const speed = rand(1.6, 3.2) * p.r;
  const spin = rand(-1, 1);
  // Comets cross the field rather than homing in. They are a bonus you have
  // to go and intercept, not food delivered free to a stationary player --
  // otherwise idling would out-earn the entropy decay.
  const inward = rand(0.20, 0.55);
  const cross = rand(0.8, 1.4) * (rng() < 0.5 ? -1 : 1);
  ents.push({
    x: p.x + Math.cos(a) * dist, y: p.y + Math.sin(a) * dist,
    vx: (-Math.cos(a) * inward - Math.sin(a) * cross) * speed,
    vy: (-Math.sin(a) * inward + Math.cos(a) * cross) * speed,
    r: p.r * rand(0.22, 0.40),
    spin, phase: rng() * TAU,
    body: { type: 'ice', variant: (rng() * VARIANTS) | 0, spin },
    comet: { life: 0, max: rand(11, 18) }
  });
}

// Once you are big enough to be noticed, somebody starts building.
function spawnDarkMatter() {
  const v = viewWorldRadius();
  const a = rng() * TAU;
  const dist = rand(v * 1.1, v * 1.7);
  // Dark matter is massive: 1.4x - 2.2x the player's radius.
  // It is invisible -- detected only by the way it lenses background stars.
  ents.push({
    x: p.x + Math.cos(a) * dist, y: p.y + Math.sin(a) * dist,
    vx: 0, vy: 0,
    r: p.r * rand(1.4, 2.2),
    spin: 0, phase: 0,
    darkMatter: true
  });
}

function spawnStarSystem() {
  const v = viewWorldRadius();
  const a = rng() * TAU;
  const dist = rand(v * 0.9, v * 1.4);
  const sx = p.x + Math.cos(a) * dist;
  const sy = p.y + Math.sin(a) * dist;
  const sid = nextSystemId++;

  // Central star -- lethal until you have grown.
  const starR = p.r * rand(1.1, 1.55);
  const star = {
    x: sx, y: sy,
    vx: rand(-0.04, 0.04) * p.r, vy: rand(-0.04, 0.04) * p.r,
    r: starR,
    spin: rand(-0.15, 0.15), phase: rng() * TAU,
    body: {
      type: 'star', variant: (rng() * VARIANTS) | 0,
      spin: rand(-0.15, 0.15),
      sub: (rng() < 0.65) ? 'redgiant' : ((rng() < 0.7) ? 'supergiant' : 'bluegiant')
    },
    systemId: sid
  };
  ents.push(star);

  // 2-4 planets on Keplerian orbits.
  const n = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const orbitR = starR * (2.0 + i * 0.85 + rng() * 0.55);
    const angle = rng() * TAU;
    const speed = rand(0.35, 0.9) / orbitR; // closer planets orbit faster
    const pr = p.r * rand(0.14, 0.40);
    ents.push({
      x: sx + Math.cos(angle) * orbitR,
      y: sy + Math.sin(angle) * orbitR,
      vx: 0, vy: 0,
      r: pr,
      spin: rand(-1.2, 1.2),
      phase: rng() * TAU,
      body: {
        type: EDIBLE[(rng() * EDIBLE.length) | 0],
        variant: (rng() * VARIANTS) | 0,
        spin: rand(-1.2, 1.2)
      },
      orbit: { id: sid, radius: orbitR, angle, speed }
    });
  }
}

function spawnCiv() {
  let live = 0;
  for (const e of ents) if (e.civ) live++;
  if (live >= CIV_MAX) return;

  const type = pickCivType();
  const v = viewWorldRadius();
  const a = rng() * TAU;
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
  // Seed first: every spawn below draws from this stream, so the field is a
  // pure function of the seed from here on.
  runSeed = nextRunSeed();
  seedRng(runSeed);
  // Variants change the starting rules, never the ladder: Titan opens heavy.
  const startMass = M0 * VARMODS[variant].startMul * (1 + 0.02 * runUpgrades.gravity);
  runDustScore = 0; runEaten = 0; lastMealT = 0;
  rareWindowActive = false; rareWindowT = 0; rareSpawnT = 0;
  pendingWave = 0; greedE = null; nextSystemId = 1; eventKey = null;
  clearInput();
  p = { x: 0, y: 0, vx: 0, vy: 0, r: startMass * RS_PER_MASS, mass: startMass };
  ents = []; parts = []; waves = []; shots = []; slugs = []; floats = [];
  cam = { x: 0, y: 0, zoom: 1 };
  score = 0; shownScore = 0; combo = 0; comboT = 0;
  elapsed = 0; era = 0; shakeMag = 0; hitstopT = 0; invuln = 0;
  flashT = 0; shotT = 5;
  camRoll = 0; shield = 0; kilonovaT = rand(35, 70);
  eraFx = 0; hitFx = 0; nearDeath = 0; lastHurtT = -99; comboPopT = 0;
  satiatedT = 0; drainRate = 0; spinA = 0;
  greedT = 0; pickT = 0; pickHold = null;
  kilonovaWarned = false; lastBeatT = -99;
  if (sparseOn) Snd.setSparse(false);
  sparseOn = false;
  ghostRec = []; ghostClock = 0;
  coachStep = 0;
  runStats = { time: 0, peakCombo: 0, biggest: 0, biggestName: '', era: 0, cause: '', finale: false };
  bestAtRunStart = best;
  resetMissionCounters();
  // Completed missions roll a fresh objective for the next run.
  if (missions.length) {
    const activeIds = missions.map((m) => m.id);
    for (const m of missions) {
      if (!m.done) continue;
      const ids = MISSION_POOL.map((d) => d.id).filter((id) => activeIds.indexOf(id) < 0);
      m.id = ids.length ? ids[(Math.random() * ids.length) | 0] : m.id;
      m.done = false;
      activeIds.push(m.id);
    }
    try { saveSet('missions', missions); } catch (_) {}
  }
  joy.active = false; joy.dx = 0; joy.dy = 0;
  drag.active = false; joy.kx = 0; joy.ky = 0;
  for (let i = 0; i < ENT_TARGET; i++) spawn(rng() < 0.5 ? 1.15 : 1.7);
  cam.zoom = desiredZoom();
}

function spawn(scaleMul) {
  const v = viewWorldRadius();
  const a = rng() * TAU;
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
    phase: rng() * TAU
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
    const a = cosmeticRandom() * TAU;
    const sp = cosmeticRand(0.5, 1.9) * p.r;
    addPart({
      x: e.x + Math.cos(a) * e.r * 0.7,
      y: e.y + Math.sin(a) * e.r * 0.7,
      vx: -tx / d * sp * 0.55 + nx * sp * 0.85 + Math.cos(a) * sp * 0.4,
      vy: -ty / d * sp * 0.55 + ny * sp * 0.85 + Math.sin(a) * sp * 0.4,
      life: 0, max: cosmeticRand(0.28, 0.6),
      r: cosmeticRand(0.06, 0.2) * p.r + 0.8,
      hue, mode: 0
    });
  }
}

// Spark burst. `hue` should be the colour of whatever produced it -- the old
// version used rand(180,300) unconditionally, so eating a red giant and eating
// an ice world threw identical cyan-magenta sparks and the feedback actively
// misreported what had happened. Callers pass entHue(...) for bodies; the
// default is the player's own accent.
function burstFx(x, y, n, spread, scale, hue) {
  const base = (hue === undefined) ? 196 : hue;
  for (let i = 0; i < n; i++) {
    const a = cosmeticRandom() * TAU;
    const sp = cosmeticRand(0.6, 2.4) * (spread || p.r) * 1.4 * (scale || 1);
    addPart({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0, max: cosmeticRand(0.35, 0.9),
      r: cosmeticRand(0.08, 0.26) * p.r + 1,
      // Scatter so the burst is not flat, but stay anchored to the source.
      hue: base + cosmeticRand(-18, 18), mode: 1
    });
  }
}

// Eras are thresholds of score, announced with a toast and a wave. The names
// are the mass classes of a growing hole, ending in the active-galactic-nucleus
// phases -- a black hole has no main sequence or red giant phase, that is a
// star's life, and the fiction should survive a player who knows astronomy.
const ERAS = ['NEBULA', 'STELLAR', 'INTERMEDIATE', 'SUPERMASSIVE',
              'QUASAR', 'BLAZAR', 'SINGULARITY'];
const ERA_SCORE = 1200;
function eraLabel(index) { return ERAS[clamp(Math.floor(index), 0, ERAS.length - 1)]; }
function runGoal() {
  // Read actual score, not the eased HUD score or last simulation frame's era.
  const index = Math.max(0, Math.floor(score / ERA_SCORE));
  const endless = index >= ERAS.length - 1;
  const remaining = endless ? 0 : (index + 1) * ERA_SCORE - score;
  return { endless, remaining, next: eraLabel(index + 1),
    fill: endless ? 100 : clamp((score - index * ERA_SCORE) / ERA_SCORE * 100, 0, 100),
    label: endless ? 'SINGULARITY · ENDLESS' : eraLabel(index + 1) + ' · ' + fmt(remaining) + ' points to go' };
}

// Human names for the run report card ("BIGGEST MEAL +320 (ice giant)").
const BODY_NAME = {
  rocky: 'world', ice: 'ice world', ocean: 'ocean world', desert: 'desert world',
  barren: 'dead world', asteroid: 'rubble', uranus: 'Uranus', neptune: 'Neptune',
  giant: 'gas giant', lava: 'lava world', rogue: 'rogue planet', brownDwarf: 'brown dwarf',
  whiteDwarf: 'white dwarf', pulsar: 'pulsar', wormhole: 'wormhole',
  magnetar: 'magnetar', ark: 'ark ship', darkMatter: 'dark matter',
  star: 'star', rival: 'rival singularity', quasar: 'quasar'
};

// What actually finished you, for the report card and the share image.
const CAUSE = {
  star: 'BURNED BY A GIANT',
  giant: 'SLAMMED INTO A GIANT',
  uranus: 'SWALLOWED BY AN ICE GIANT',
  neptune: 'SWALLOWED BY AN ICE GIANT',
  lava: 'MELTED BY A LAVA WORLD',
  rogue: 'HIT BY A ROGUE PLANET',
  rival: 'CONSUMED BY A RIVAL HOLE',
  asteroid: 'BROKEN BY RUBBLE',
  comet: 'STRUCK BY A COMET',
  brownDwarf: 'CRUSHED BY A BROWN DWARF',
  whiteDwarf: 'TORN APART BY DEGENERATE MATTER',
  magnetar: 'SCORCHED BY A MAGNETAR',
  quasar: 'VAPORISED BY A QUASAR JET',
  darkMatter: 'DISPERSED BY DARK MATTER'
};

// Scripted hints, run 1 only. One static line never taught anybody anything.
//   0 -> shortly after the run starts   1 -> after the first meal
//   2 -> the first time a combo of 5 lands
// Voice. Two registers, and a string must be one or the other:
//   SHOUT  -- proper-noun events and milestones (era names, death causes,
//             STAR CONSUMED). All caps.
//   SAY    -- anything the game explains to the player. Sentence case, with
//             the explanation after an em dash when a headline needs one.
// The old copy shouted everything, which is the single most recognisable
// tell of sci-fi UI written by feel.
const COACH = ['Push the stick to move', 'Chain eats to build a combo'];

/* ---------- toasts ---------- */
// A single slot meant era-up, KILONOVA and STAR CONSUMED clobbered each
// other, so the most interesting line of a run was routinely lost. Up to
// three now stack, newest at the bottom.
const toasts = [];
const TOAST_MAX = 3;

function dropToast(i) {
  const t = toasts[i];
  if (!t) return;
  toasts.splice(i, 1);
  t.node.classList.remove('show');
  setTimeout(() => { if (t.node.parentNode) t.node.parentNode.removeChild(t.node); }, 320);
}

function clearToasts() {
  for (let i = toasts.length - 1; i >= 0; i--) dropToast(i);
}

function toast(msg, dur) {
  if (!el.toasts) return;
  while (toasts.length >= TOAST_MAX) dropToast(0);
  const node = document.createElement('div');
  node.className = 'toast-item';
  node.textContent = msg;
  el.toasts.appendChild(node);
  void node.offsetWidth;            // force a reflow so the transition runs
  node.classList.add('show');
  toasts.push({ node, life: 0, max: dur || 1.9 });
}

function updateToasts(dt) {
  for (let i = toasts.length - 1; i >= 0; i--) {
    toasts[i].life += dt;
    if (toasts[i].life >= toasts[i].max) dropToast(i);
  }
}

// Tidal disruption event: a body torn apart outside the horizon shreds into
// a stream instead of being swallowed whole. Uses the live entity array, so
// it is mostly a spawning change -- and it makes big meals spectacular.
function disrupt(e, idx) {
  const n = 3 + ((rng() * 3) | 0);
  const ax = Math.atan2(p.y - e.y, p.x - e.x);   // infall axis
  for (let k = 0; k < n; k++) {
    const fr = e.r * rand(0.28, 0.45);
    const spread = rand(-0.5, 0.5);
    const sp = rand(0.5, 1.6) * p.r;
    ents.push({
      x: e.x + rand(-0.4, 0.4) * e.r,
      y: e.y + rand(-0.4, 0.4) * e.r,
      vx: Math.cos(ax + spread) * sp + rand(-0.3, 0.3) * p.r,
      vy: Math.sin(ax + spread) * sp + rand(-0.3, 0.3) * p.r,
      r: fr,
      spin: rand(-2, 2), phase: rng() * TAU,
      pairAng: e.pairAng || 0, pairDist: e.pairDist || 0,
      body: { type: e.body.type, variant: (rng() * VARIANTS) | 0,
              spin: rand(-2, 2), sub: e.body.sub },
      frag: true
    });
  }
  burstFx(e.x, e.y, 16, e.r, 1.0, entHue(e.r / p.r));
  Snd.crunch();
  ents.splice(idx, 1);
}

// Shared by ingestion and gravity: scripted/rare bodies may be consumed
// before their first entity update. Never let an absent mass poison the run.
function bodyMass(e) {
  if (Number.isFinite(e.mass) && e.mass > 0) return e.mass;
  const type = e.body && e.body.type;
  const density = type === 'whiteDwarf' ? 4 : type === 'brownDwarf' ? 2 : 1;
  e.mass = (e.r / P0) ** 2 * M0 * density;
  return e.mass;
}

function consume(e, idx) {
  const type = e.body && e.body.type;
  const wasStar = type === 'star';
  const wasPulsar = type === 'pulsar';
  const wasWormhole = type === 'wormhole';

  p.mass += bodyMass(e) * CONSUME_YIELD;
  p.r = p.mass * RS_PER_MASS;
  combo++;
  comboT = COMBO_WINDOW_V();
  // A fresh meal buys a satiated window (Tier 0 tension curve).
  satiatedT = 2.0;
  // Angular momentum in: meals spin the hole up toward maximal Kerr.
  spinA = Math.min(0.998, spinA + 0.004 * (e.r / p.r));
  // Mission counters.
  if (runMission) {
    if (type === 'whiteDwarf') runMission.wd++;
    if (type === 'ark') runMission.ark++;
    if (type === 'pulsar') runMission.pulsar++;
  }
  checkMissions();

  let gained = Math.max(1, Math.round(e.r * 0.42 * comboMult()));
  if (wasStar) gained *= STAR_BONUS;
  if (wasPulsar) gained *= 3;
  // Degenerate matter: a white dwarf packs roughly a Sun's mass into an
  // Earth-sized volume, so it pays far better than its radius suggests.
  if (type === 'whiteDwarf') gained *= 4;
  if (type === 'brownDwarf') gained *= 2;
  if (type === 'ark') gained *= 3;          // a whole ship full of people
  score += gained;

  // Run report card bookkeeping.
  if (runStats) {
    if (combo > runStats.peakCombo) runStats.peakCombo = combo;
    if (gained > runStats.biggest) {
      runStats.biggest = gained;
      runStats.biggestName = BODY_NAME[type] || '';
    }
    if (era > runStats.era) runStats.era = era;
  }
  // Combo heat pops on every AGN feedback.
  if (combo > 0 && combo % WAVE_EVERY() === 0) comboPopT = 0.45;
  buzz(8);

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
    toast('STAR CONSUMED +' + fmt(gained));
  } else if (wasPulsar) {
    shield = 3;   // seconds of one-hit protection; impact consumes it
    toast('PULSAR ABSORBED — your next impact is shielded', 2.2);
    burstFx(e.x, e.y, 24, e.r, 1.4, 205);
  } else if (wasWormhole) {
    // Teleport along the stored pair vector. Move the player AND the camera
    // so the world scrolls instead of jumping under the finger.
    const tx = Math.cos(e.pairAng) * e.pairDist;
    const ty = Math.sin(e.pairAng) * e.pairDist;
    p.x += tx; p.y += ty;
    cam.x += tx; cam.y += ty;
    burstFx(e.x, e.y, 30, e.r, 1, 286);
    burstFx(p.x, p.y, 18, p.r * 0.6, 0.8, 286);
    toast('WORMHOLE');
  } else if (type === 'magnetar') {
    // A starquake: the crust cracks and releases a burst that clears the
    // field of anything dangerous nearby.
    const R = p.r * 11;
    for (let i = ents.length - 1; i >= 0; i--) {
      const o = ents[i];
      const ddx = o.x - p.x, ddy = o.y - p.y;
      if (ddx * ddx + ddy * ddy < R * R && !edibleAt(o)) {
        burstFx(o.x, o.y, 8, o.r, 1, 268);
        ents.splice(i, 1);
      }
    }
    waves.push({ x: p.x, y: p.y, r: p.r, max: R, t: 0, hue: 205 });
    flashT = Math.max(flashT, 0.22);
    toast('MAGNETAR STARQUAKE');
    Snd.boom();
  } else if (type === 'ark') {
    toast('ARK CONSUMED +' + fmt(gained), 1.8);
    burstFx(e.x, e.y, 26, e.r, 1.2, entHue(e.r / p.r));
  }
  // The AGN feedback cadence is the no-pause choice moment, and it belongs to
  // the COMBO, not to the body: a star or pulsar landing on the 20th used to
  // swallow the milestone entirely.
  if (combo > 0 && combo % WAVE_EVERY() === 0) startPick();
  // Big things break apart visibly instead of just vanishing.
  if (e.r > p.r * 0.55) burstFx(e.x, e.y, 14, e.r, 0.8, entHue(e.r / p.r));
}

function supernova(x, y, r) {
  waves.push({ x, y, r: r, max: r * 16, t: 0 });
  const R = r * 13;
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = e.x - x, dy = e.y - y;
    if (dx * dx + dy * dy < R * R && !edibleAt(e)) {
      score += Math.round(e.r * 0.5 * comboMult());
      burstFx(e.x, e.y, 10, e.r, 1, entHue(e.r / p.r));
      ents.splice(i, 1);
    }
  }
  burstFx(x, y, 46, r * 1.6, 1.4, 196);
  shakeMag = Math.max(shakeMag, 26);
  flashT = Math.max(flashT, 0.34);
  Snd.nova();
}

function hurt(e) {
  // Pulsar shield absorbs the next impact entirely, then is consumed.
  if (shield > 0) {
    shield = 0;
    invuln = 0.3;   // grace period: overlapping bodies must not hit again this frame
    toast('SHIELD — impact blocked', 1.4);
    if (Snd.ac) Snd.tone(520, 'sine', 0.18, 0.005, 0.16);
    burstFx(p.x, p.y, 22, p.r * 0.5, 1.2, 196);
    return;
  }
  const type = e.body && e.body.type;
  const prof = (type && IMPACT[type]) || IMPACT_DEFAULT;

  p.mass *= (1 - prof.frac * (1 - 0.04 * runUpgrades.horizon));
  p.r = p.mass * RS_PER_MASS;

  const dx = p.x - e.x, dy = p.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  p.vx = dx / d * prof.knock * p.r;
  p.vy = dy / d * prof.knock * p.r;
  e.vx -= dx / d * p.r * 1.6;
  e.vy -= dy / d * p.r * 1.6;

  // A rival swallows light and time: longer invulnerability or you would be
  // shredded inside its well.
  invuln = prof.flash ? 1.9 : 1.15;
  // Combo break you can hear: losing a hot streak strips the mix, not just
  // the number.
  if (combo >= 10) Snd.fall();
  combo = 0; comboT = 0;
  shakeMag = Math.max(shakeMag, 12 + prof.frac * 46);
  hitstopT = Math.max(hitstopT, 0.09);
  if (prof.flash) flashT = Math.max(flashT, 0.30);
  if (prof.burn) flashT = Math.max(flashT, 0.16);

  // Directional damage vignette: hits used to have no directional UI at all,
  // even though we already know the vector. Store it screen-space.
  hitDirX = -dx / d;          // dx points impact -> player, so negate
  hitDirY = -dy / d;
  hitFx = 1;
  lastHurtT = elapsed;
  if (runStats) runStats.cause = prof.msg || CAUSE[type] || 'CRUSHED';
  buzz(60);

  if (prof.burn) burstFx(e.x, e.y, 36, e.r * 0.8, 1.2, entHue(e.r / p.r));
  else if (prof.gas) burstFx(e.x, e.y, 30, e.r * 0.9, 1.1, entHue(e.r / p.r));
  else burstFx(p.x, p.y, 26, p.r, 1, 8);

  Snd.thud();
  Snd.setDrone(true, 0);
  if (prof.msg) toast(prof.msg, 1.6);
}

function pulse() {
  // Jets strengthen with spin (Blandford–Znajek): a spun-up hole clears
  // a wider field, so angular momentum pays out visibly.
  const R = p.r * 13 * (1 + spinA * 0.3);
  waves.push({ x: p.x, y: p.y, r: p.r, max: R, t: 0 });
  let kills = 0;
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy < R * R && !edibleAt(e)) {
      score += Math.round(e.r * 0.5 * comboMult());
      burstFx(e.x, e.y, 10, e.r, 1, entHue(e.r / p.r));
      ents.splice(i, 1);
      kills++;
    }
  }
  if (runMission && kills > runMission.waveBest) runMission.waveBest = kills;
  shakeMag = Math.max(shakeMag, 12);
  Snd.boom();
  Snd.sting('wave');
  buzz(45);
}

function renderReport() {
  if (!el.report) return;
  el.report.innerHTML = '';
  const mm = Math.floor(runStats.time / 60);
  const ss = Math.floor(runStats.time % 60);
  const time = mm + ':' + String(ss).padStart(2, '0');
  const eraName = eraLabel(runStats.era);

  const lines = [
    'TIME ' + time + '  ·  PEAK CHAIN ' + runStats.peakCombo,
    'BIGGEST MEAL +' + fmt(runStats.biggest) +
      (runStats.biggestName ? ' (' + runStats.biggestName + ')' : '') +
      '  ·  ' + eraName
  ];
  for (const t of lines) {
    const d = document.createElement('div');
    d.textContent = t;
    el.report.appendChild(d);
  }
  const c = document.createElement('div');
  c.className = 'cause';
  c.textContent = runStats.cause || 'EVAPORATED';
  el.report.appendChild(c);
}

function die() {
  clearInput();
  state = 'dead';
  Snd.collapse();
  Snd.sting('death');
  Snd.setDrone(false, 0);
  shakeMag = Math.max(shakeMag, 28);
  flashT = Math.max(flashT, 0.25);
  burstFx(p.x, p.y, 70, p.r, 1.6, 8);
  buzz(180);

  // Attribute the death. A hit inside the last half second is what killed
  // you; otherwise you simply boiled away, which the old screen never said.
  runStats.time = elapsed;
  runStats.era = Math.max(runStats.era, era);
  if (!runStats.cause || elapsed - lastHurtT > 0.5) runStats.cause = 'EVAPORATED';

  const prevBest = bestAtRunStart;
  newBest = score > prevBest && score > 0;
  commitBest();
  pushHistory(score);
  // A daily attempt is consumed by dying, win or lose.
  if (dailyRun) {
    try { saveSet('daily', todayStr()); } catch (_) {}
    dailyRun = false;
  }
  // The ghost records only the best run: positions at 10 Hz cap the save at
  // a few tens of kilobytes, and every run starts at the origin, so the
  // recording replays anywhere with no simulation.
  if (newBest && ghostRec && ghostRec.length > 30) {
    try {
      const xs = [], ys = [];
      for (const q of ghostRec) { xs.push(q[1]); ys.push(q[2]); }
      saveSet('ghost', { x: xs, y: ys, score: Math.round(score) });
      ghostData = save.ghost;
    } catch (_) {}
  }

  hide(el.hud);
  hide(el.keysLegend);
  el.finalScore.textContent = fmt(score);
  el.newBest.classList.toggle('hidden', !newBest);
  el.overBest.textContent = newBest
    ? 'New best by ' + fmt(score - prevBest)
    : fmt(Math.max(0, best - score)) + ' away from your best';
  renderReport();
  show(el.over);
  overGuardT = 0.8;      // one stray tap must not wipe the score you're reading
  clearToasts();
}

// Returns a thrust vector with magnitude 0..1 for whichever scheme is active.
// Every input funnels through here so the physics below is identical however
// you are steering -- there is exactly one place that decides how the hole
// accelerates, which is what keeps the feel consistent across control modes.
function thrustVector() {
  let x = 0, y = 0;

  // Directional inputs: the stick, plus the keyboard (desktop, or Android with
  // a hardware keyboard). They sum, then get clamped to unit length.
  if (controlMode === 'joystick') { x += joy.dx; y += joy.dy; }
  const kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const ky = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (kx || ky) {
    const m = Math.hypot(kx, ky);
    x += kx / m; y += ky / m;
  }

  // Drag schemes steer toward the held point. Thrust tapers off as you arrive,
  // because a constant full-thrust pull at a nearby target is just something
  // to overshoot and then orbit forever.
  if (!x && !y && drag.active) {
    const dx = drag.wx - p.x, dy = drag.wy - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      const mag = clamp(dist / (p.r * 6), 0, 1);
      x = (dx / dist) * mag;
      y = (dy / dist) * mag;
    }
  }

  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  return { x: x, y: y };
}

function update(dt) {
  if (state === 'paused') return;      // frozen; render still draws the frame
  elapsed += dt;
  const prevEra = era;
  era = Math.floor(score / ERA_SCORE);
  if (era !== prevEra && runStats) runStats.era = Math.max(runStats.era, era);
  if (era !== prevEra && era > 0) {
    toast(eraLabel(era));
    // Milestone celebration: the only progression system in the game
    // deserved more than a line of text.
    eraFx = 1;
    waves.push({ x: p.x, y: p.y, r: p.r * 0.9, max: p.r * 9, t: 0, hue: 275 });
    Snd.boom();
    Snd.sting('era');
    buzz(40);
    // SINGULARITY finale: the ladder gets a top. Reaching the final era is a
    // scripted, triumphant stop -- CONTINUE resumes into the endless grind,
    // now an explicit choice rather than a run with no destination.
    if (era >= ERAS.length - 1 && runStats && !runStats.finale) {
      runStats.finale = true;
      Snd.sting('finale');
      buzz(150);
      flashT = Math.max(flashT, 0.5);
      waves.push({ x: p.x, y: p.y, r: p.r, max: p.r * 20, t: 0, hue: 280 });
      // Only stop the world if there is still a world to stop. update() keeps
      // running after death, so an era crossed on the fatal frame would
      // otherwise open this explainer on top of the run report.
      if (state === 'play') openEventPanel('finale');
    }
  }

  updateToasts(dt);
  if (overGuardT > 0) overGuardT -= dt;
  if (flashT > 0) flashT = Math.max(0, flashT - dt * 2.2);
  if (shield > 0) shield = Math.max(0, shield - dt * 0.6);
  if (eraFx > 0) eraFx = Math.max(0, eraFx - dt * 1.1);
  if (hitFx > 0) hitFx = Math.max(0, hitFx - dt * 2.4);
  if (comboPopT > 0) comboPopT = Math.max(0, comboPopT - dt);

  // First-run coach marks. Only on run 1, and only until all three land.
  if (!coachDone && state === 'play') {
    if (coachStep === 0 && elapsed > 1.2) { toast(COACH[0], 2.4); coachStep = 1; }
    else if (coachStep === 1 && combo >= 1) { toast(COACH[1], 2.4); coachStep = 2; }
    else if (coachStep === 2 && combo >= 5) {
      toast('Every ' + WAVE_EVERY() + ' chained eats offers a power choice', 2.6);
      coachStep = 3;
      coachDone = true;
      saveSet('coach', '1');
    }
  }

  // Low-mass warning: evaporation death used to arrive untelegraphed.
  nearDeath = state === 'play'
    ? clamp(1 - (p.mass - (DEATH_AREA / (P0*P0)) * M0) / ((DEATH_AREA / (P0*P0)) * M0 * 2.4), 0, 1)
    : 0;

  // Shockwave steering pick: dwell steers the choice, timeout takes SHOCK.
  if (state === 'play' && pickT > 0 && pickHold) {
    pickT -= dt;
    const pv = thrustVector();
    if (pv.x < -0.45) pickHold.l += dt;
    else if (pv.x > 0.45) pickHold.r += dt;
    else pickHold.c += dt;
    if (pickHold.l > 0.35) resolvePick(0);
    else if (pickHold.r > 0.35) resolvePick(2);
    else if (pickHold.c > 0.6) resolvePick(1);
    else if (pickT <= 0) {
      const h = pickHold;
      resolvePick(h.l >= h.r && h.l >= h.c ? 0 : h.r >= h.c ? 2 : 1);
    }
  }

  // Greed gate: while a streak runs hot, one bigger body becomes edible for
  // a few seconds. Risk and reward decided entirely by movement.
  if (state === 'play' && combo >= 10 && comboT > 0 && greedT <= 0) {
    const Rv = viewWorldRadius() * 0.9;
    let gate = null, gd = Infinity;
    for (const o of ents) {
      if (o.darkMatter || o.civ || o.comet || o.greedT > 0) continue;
      if (o.r <= p.r * VARMODS[variant].thresh || o.r > p.r * 1.6) continue;
      const ddx = o.x - p.x, ddy = o.y - p.y;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < Rv * Rv && d2 < gd) { gd = d2; gate = o; }
    }
    if (gate) {
      gate.greedT = 2.5;
      greedT = 6;
      toast('GREED GATE — eat the big one', 1.6);
      Snd.tick(1200, 1.0, 0.08, 0.12);
    }
  }
  if (greedT > 0) greedT -= dt;

  // Ghost recording at 10 Hz: positions only, so playback needs no sim.
  if (state === 'play' && ghostRec) {
    ghostClock += dt;
    if (ghostClock >= 0.1) {
      ghostClock = 0;
      if (ghostRec.length < 3600) {
        ghostRec.push([Math.round(elapsed * 10) / 10, Math.round(p.x), Math.round(p.y)]);
      }
    }
  }

  // Heartbeat haptic quickens with the warning, synced to the HUD pulse.
  if (state === 'play' && nearDeath > 0.6) {
    const period = 1.05 - (nearDeath - 0.6) * 1.1;
    if (elapsed - lastBeatT > period) { lastBeatT = elapsed; buzz(22); }
  }

  // Low-mass strip-back: thin the mix as evaporation threatens.
  {
    const wantSparse = state === 'play' && nearDeath > 0.5;
    if (wantSparse !== sparseOn) { sparseOn = wantSparse; Snd.setSparse(wantSparse); }
  }

  // Missions tick every frame; each check is a counter read.
  checkMissions();

  // Kilonova: a neutron-star merger going off somewhere in the field. Real
  // ones forge the heavy elements (gold, platinum, uranium) and flash hard
  // across the spectrum. This one pays out and clears danger nearby.
  if (state === 'play') {
    kilonovaT -= dt;
    // Telegraph: a rising tone and a warning a beat before it fires, so the
    // biggest relief moment in the loop lands with anticipation.
    if (!kilonovaWarned && kilonovaT <= 1.2 && kilonovaT > 0) {
      kilonovaWarned = true;
      toast('KILONOVA INCOMING', 1.2);
      Snd.riser();
    }
    if (kilonovaT <= 0) {
      kilonovaWarned = false;
      kilonovaT = rand(45, 85);
      const R = p.r * 16;
      waves.push({ x: p.x, y: p.y, r: p.r, max: R, t: 0, hue: 45 });
      for (let i = ents.length - 1; i >= 0; i--) {
        const o = ents[i];
        const ddx = o.x - p.x, ddy = o.y - p.y;
        if (ddx * ddx + ddy * ddy < R * R && !edibleAt(o)) {
          score += Math.round(o.r * 0.6 * comboMult());
          burstFx(o.x, o.y, 10, o.r, 1, entHue(o.r / p.r));
          ents.splice(i, 1);
        }
      }
      flashT = Math.max(flashT, 0.45);
      shakeMag = Math.max(shakeMag, 18);
      toast('KILONOVA — heavy elements forged', 2.4);
      Snd.boom();
    }
  }

  // Frame-dragging: large bodies tilt the world subtly when close. Real
  // Kerr black holes drag spacetime around them; this is the cheap version.
  // (fd, not drag: `drag` is the input object, and a local of the same name
  // shadowed it and crashed Follow steering.)
  let fd = 0;
  for (const e of ents) {
    const t = e.body && e.body.type;
    if (t !== 'star' && t !== 'giant' && t !== 'rival') continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    const reach = p.r * 5;
    if (d < reach) {
      const sign = (dx > 0) ? 1 : -1;
      fd += sign * (1 - d / reach) * 0.14;
    }
  }
  // Spin-coupled drag: a Schwarzschild hole (spin 0) barely drags the frame;
  // a near-maximal Kerr hole does. Meals spin you up, so the tilt deepens
  // across a run instead of sitting at one flat value.
  camRoll = motion ? lerp(camRoll, clamp(fd, -0.22, 0.22) * (0.3 + spinA), smooth(0.6, dt)) : 0;

  cam.zoom = lerp(cam.zoom, desiredZoom(), smooth(0.02, dt));
  // Snap the camera to the player. The old "smooth" follow lagged badly -- a few
  // quick moves and the player was drawn in the corner with the whole field
  // off-screen, which read as "the game is empty". 0.35 is snappy without
  // being jittery at 60 fps. Preserve that feel at any frame rate.
  const follow = 1 - Math.pow(0.65, dt * 60);
  cam.x = lerp(cam.x, p.x + p.vx * CAM_LEAD, follow);
  cam.y = lerp(cam.y, p.y + p.vy * CAM_LEAD, follow);

  if (state === 'play') {
    // ---- Movement: thrust and inertia, not "seek a point" ---------------
    // The old model lerped velocity straight at a target point, so the hole
    // changed direction within a frame and handled like a mouse cursor. A
    // black hole is the least manoeuvrable object in the universe, so the
    // stick now applies THRUST, and the resulting velocity has to be carried
    // around by drag. Nothing can turn on a dime any more.
    //
    // The two rates are chosen so that top speed is UNCHANGED at SPEED_REF*r
    // (the game's reachability depends on it) while the time taken to reach
    // that speed grows with mass:
    //
    //   terminal speed = thrust / bleedRate = (maxV * bleedRate) / bleedRate
    //                  = maxV                                <- balance held
    //   time constant  = 1 / bleedRate  ~ (r / P0) ^ DRIFT_EXP <- heavier is slower
    //
    // So a small hole is nimble and a grown hole is ponderous, but neither is
    // any slower flat out than it used to be.
    // Follow: the target is the finger's screen position, and the camera moves
    // under it every frame. Re-deriving the world point here (not only on
    // pointermove) keeps a resting finger steering at the same spot -- the
    // camera dragging used to bend the target with it. Runs before the thrust
    // read so the same frame steers at where the finger is now.
    if (controlMode === 'follow' && steerPointer !== null && pointer.down) {
      const w = screenToWorld(pointer.x, pointer.y);
      drag.wx = w.x; drag.wy = w.y;
    }
    const tv = thrustVector();
    const maxV = SPEED_REF * p.r;
    // Wisp variant: nimbler hands, same top speed.
    const dexp = VARMODS[variant].driftExp;
    const bleedRate = SPACE_DRAG * Math.pow(P0 / p.r, dexp === null ? DRIFT_EXP : dexp);
    const thrust = maxV * bleedRate;

    p.vx += tv.x * thrust * dt;
    p.vy += tv.y * thrust * dt;

    // Space is a vacuum, so there is no real friction -- but a hole that never
    // slows down is unplayable. This is a light bleed, and because bleedRate
    // falls with size, big holes coast for longer.
    const bleed = Math.exp(-bleedRate * dt);
    p.vx *= bleed;
    p.vy *= bleed;

    // Ceiling. Loose enough that collisions and AGN feedbacks still land a punch
    // (they inject velocity directly), tight enough that nothing runs away.
    const sp = Math.hypot(p.vx, p.vy);
    const cap = maxV * IMPULSE_CAP;
    if (sp > cap) { const s = cap / sp; p.vx *= s; p.vy *= s; }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Hawking radiation. A black hole's temperature goes as 1/M and its power
// as 1/M^2, so the FRACTIONAL mass-loss rate scales as 1/M^3 -- and since
// Schwarzschild radius is proportional to mass, as 1/r^3. Small holes
// evaporate furiously and large ones are nearly stable. The old curve was
// backwards: it punished you for growing.
//
// Tension curve: a fresh meal buys a satiated window, and a hot combo slows
// the drain, so decay is a rhythm to ride rather than a flat tax. drainRate
// is published for the vignette so the drain stays readable, not just felt.
    let decay = HAWKING_BASE * clamp(Math.pow(P0 / p.r, 3),
                                     HAWKING_MIN, HAWKING_MAX);
    if (VARMODS[variant].decayMul !== 1) decay *= VARMODS[variant].decayMul;
    if (satiatedT > 0) { satiatedT -= dt; decay = 0; }
    else if (combo >= 10 && comboT > 0) decay *= 0.55;
    decay *= 1 - 0.03 * runUpgrades.singularity;
    drainRate = decay;
    p.mass = Math.max(1, p.mass - p.mass * decay * dt);
    p.r = p.mass * RS_PER_MASS;

    // Combo fizzle: a hot streak dying quietly still drops the mix.
    // Frozen while steering a AGN feedback pick -- choosing must not cost you.
    if (comboT > 0 && pickT <= 0) {
      comboT -= dt;
      if (comboT <= 0) {
        if (combo >= 10) Snd.setDrone(true, 0);
        combo = 0;
      }
    }
    if (invuln > 0) invuln -= dt;

    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      // A consume inside this loop can detonate a supernova/starquake that
      // removes bodies at lower indices out from under the iteration, leaving
      // a hole. Skipping it is correct: those bodies are already gone.
      if (!e) continue;
      const ddx = e.x - p.x, ddy = e.y - p.y;
      const reach = p.r + e.r * 0.5;
      const d2c = ddx * ddx + ddy * ddy;
      if (d2c < reach * reach) {
        // Dark matter has no surface and no collision -- you pass straight
        // through it, but its gravity bends your trajectory.
        if (e.darkMatter) continue;
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
        if (edibleAt(e)) {
          // Tidal disruption: a big meal shreds into fragments outside the
          // horizon instead of vanishing whole. Fragments (flagged) never
          // shred again, or one planet would chain into confetti forever.
          if (!e.frag && !e.civ && !e.comet && !e.darkMatter &&
              e.body && e.body.type !== 'wormhole' &&
              e.r > p.r * 0.45 && e.r > 6) {
            disrupt(e, i);
            continue;
          }
          consume(e, i);
        }
        else if (invuln <= 0) hurt(e);
      } else if (!e.grazed && !e.civ && !e.darkMatter && !edibleAt(e)) {
        // Graze: skirting something that could hurt you pays a sliver.
        // Danger-adjacent by construction -- only lethal bodies qualify.
        const gr = reach * 1.45;
        if (d2c < gr * gr) {
          e.grazed = true;
          const g = Math.max(1, Math.round(e.r * 0.06 * comboMult()));
          score += g;
          if (floats.length < 24) {
            floats.push({ x: p.x, y: p.y - p.r, text: '+' + fmt(g) + ' GRAZE',
                          life: 0, max: 0.7, big: false });
          }
          burstFx(p.x, p.y, 3, p.r * 0.4, 0.6, entHue(e.r / p.r));
          Snd.tick(2400, 1.2, 0.05, 0.05);
          if (runMission) runMission.graze++;
          checkMissions();
        }
      }
    }
    // Shockwave wind-up: a beat of inward rush before the release, so the
    // biggest moment in the loop lands with anticipation, not just aftermath.
    if (pendingWave > 0) {
      pendingWave -= dt;
      if (cosmeticRandom() < 10 * dt) {
        const a = cosmeticRandom() * TAU;
        addPart({ x: p.x + Math.cos(a) * p.r * 6, y: p.y + Math.sin(a) * p.r * 6,
                  vx: 0, vy: 0, life: 0, max: 0.3, r: 2, hue: 190, mode: 0 });
      }
      if (pendingWave <= 0) { pendingWave = 0; pulse(); }
    }
    if (p.mass < (DEATH_AREA / (P0*P0)) * M0) die();
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
      const q = rng();
      if (q < 0.10) spawnBelt();
      else if (q < 0.13) spawnComet();
      else if (q < 0.135) spawnDarkMatter();
      else if (q < 0.175) spawnStarSystem();
      else spawn();
    }
  }

  // The civilisation starts deploying countermeasures once you are big
  // enough for someone to have noticed.
  // Roughly one installation every 7 seconds, so they trickle in and escalate
// rather than all appearing the instant you cross the threshold.
  if (state === 'play' && score > CIV_ALERT && rng() < 0.0025) spawnCiv();

  const v = viewWorldRadius();
  const despawnR = v * 1.95;
  const pullR = p.r * 7;
  const edamp = Math.pow(0.85, dt);

  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    bodyMass(e);

    // Orbital motion: planets track their parent star. If the parent has been
    // eaten or despawned, they are flung free with tangential velocity.
    if (e.orbit) {
      let parent = null;
      for (const q of ents) { if (q.systemId === e.orbit.id) { parent = q; break; } }
      if (parent) {
        e.orbit.angle += e.orbit.speed * dt;
        e.x = parent.x + Math.cos(e.orbit.angle) * e.orbit.radius;
        e.y = parent.y + Math.sin(e.orbit.angle) * e.orbit.radius;
      } else {
        // Parent gone -- fling free with orbital tangential velocity.
        const a = e.orbit.angle;
        const v = e.orbit.speed * e.orbit.radius;
        e.vx = -Math.sin(a) * v;
        e.vy = Math.cos(a) * v;
        e.orbit = null;
      }
    }

    const dx = p.x - e.x, dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > despawnR * despawnR) {
      if (e.civ === 'ark') toast('ARK ESCAPED', 1.4);
      ents.splice(i, 1); continue;
    }

    // Greed-gate expiry lives on the body so it survives anything except
    // being eaten or despawned.
    if (e.greedT > 0) e.greedT -= dt;

    // ---- First encounters ---------------------------------------------
    // Your rarest content should not be missable in the middle of a fight.
    // Gated on a few seconds of elapsed play so the opening of a run is never
    // interrupted before the player has even got moving.
    if (state === 'play' && elapsed > 4 &&
        !(seenEvents.pulsar && seenEvents.wormhole && seenEvents.civ)) {
      const bt = e.body && e.body.type;
      if ((bt === 'pulsar' || bt === 'wormhole') && !seenEvents[bt]) {
        const reach = p.r * ENCOUNTER_REACH;
        if (d2 < reach * reach) firstEncounter(bt, e.x, e.y);
      } else if (e.civ && !seenEvents.civ && d2 < v * v) {
        firstEncounter('civ', e.x, e.y);
      }
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
          p.mass = Math.max(1, p.mass * (1 - (1 - d / reach) * 0.035 * dt));
          p.r = p.mass * RS_PER_MASS;
          if (cosmeticRandom() < 0.25) {
            addPart({
              x: e.x, y: e.y,
              vx: -dx / d * p.r * 2, vy: -dy / d * p.r * 2,
              life: 0, max: 0.5,
              r: cosmeticRand(0.05, 0.12) * p.r + 0.8, hue: 275, mode: 1
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
            vx: dx / d * sp, vy: dy / d * sp,
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
        // Proximity rumble: you feel a rival through your hands before you
        // see what it is doing to your trajectory.
        if (d < reachR * 0.6 && cosmeticRandom() < dt * 2) buzz(12);
      }
    }

    // Pulsars broadcast periodic gravity AGN feedbacks -- the spin of a
    // neutron star pushing the field outward.
    if (e.body && e.body.type === 'pulsar' && state === 'play') {
      e.pulseT -= dt;
      if (e.pulseT <= 0) {
        e.pulseT = e.beatMax;
        waves.push({ x: e.x, y: e.y, r: e.r * 0.6, max: e.r * 9, t: 0, hue: 210 });
        burstFx(e.x, e.y, 6, e.r * 0.5, 0.5, entHue(e.r / p.r));
      }
      // Lighthouse beams are dangerous to cross -- but only while the pulsar
      // out-masses you. An edible pulsar stays safe to approach and eat.
      e.beamCD = Math.max(0, (e.beamCD || 0) - dt);
      if (e.beamCD <= 0 && invuln <= 0 && e.r > p.r * VARMODS[variant].thresh) {
        const d = Math.sqrt(d2) || 1;
        if (d < e.r * 2.4) {
          const beamA = elapsed * 1.5;   // matches the drawEnts sweep
          let da = Math.atan2(p.y - e.y, p.x - e.x) - beamA;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          const halfW = 0.16 + (e.r * 0.06) / d;
          if (Math.abs(da) < halfW || Math.abs(Math.abs(da) - Math.PI) < halfW) {
            e.beamCD = 0.5;
            p.mass = Math.max(1, p.mass * 0.985);
            p.r = p.mass * RS_PER_MASS;
            burstFx(p.x, p.y, 4, p.r * 0.4, 0.7, 210);
            Snd.tick(1800, 1.2, 0.07, 0.08);
            shakeMag = Math.max(shakeMag, 4);
          }
        }
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

    // Dark matter: invisible, massive, pulls the player but is not pulled.
    if (e.darkMatter && state === 'play') {
      if (!fieldGuide.darkMatter && d2 <= (p.r * 5) ** 2) discoverBody('darkMatter');
      const d = Math.sqrt(d2) || 1;
      const reach = p.r * 14;
      if (d < reach) {
        const s = (1 - d / reach) * 3.2 * p.r * dt;
        p.vx += (-dx / d) * s;
        p.vy += (-dy / d) * s;
      }
      continue;   // skip the rest of the update for this entity
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
        const edible = edibleAt(e);
        const bodyMass = e.mass / p.mass;
        // Newtonian gravity: pull falls off as 1/r^2, softened near the
        // centre so nothing goes infinite. The old linear falloff let the
        // hole vacuum the entire field evenly, which is not how gravity
        // behaves -- now distant bodies barely drift and close ones get
        // hauled in hard.
        const soft = d + p.r * 1.5;
        const falloff = p.mass / (soft * soft);
        const s = falloff * 4.6 * p.r * dt / (0.35 + bodyMass * 2.2) * (edible ? 1 : 0.18);
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
    shotT = cosmeticRand(5, 13);
    const a = cosmeticRand(-0.7, 0.3);
    shots.push({
      x: cosmeticRand(-0.1, 0.9) * W, y: cosmeticRand(-0.1, 0.5) * H,
      vx: Math.cos(a) * cosmeticRand(500, 900), vy: Math.sin(a) * cosmeticRand(500, 900),
      life: 0, max: cosmeticRand(0.5, 0.9), len: cosmeticRand(60, 160)
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
        p.mass = Math.max(1, p.mass * 0.97);
        p.r = p.mass * RS_PER_MASS;
        const d = Math.hypot(dx, dy) || 1;
        p.vx += dx / d * 3 * p.r;
        p.vy += dy / d * 3 * p.r;
        burstFx(s.x, s.y, 8, s.r * 4, 0.7, 196);
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
  ctx.fillStyle = getNebula((210 + era * 24) % 360, clamp(era / 6, 0, 1));
  ctx.fillRect(0, 0, W, H);
  // Over the nebula wash, under the stars: the CMB is the farthest light, so
  // it belongs behind the starfield but cannot sit under an opaque fill.
  drawCmb();

  drawStars();
  drawShots();

  let sx = 0, sy = 0;
  if (motion && shakeMag > 0.2) { sx = cosmeticRand(-shakeMag, shakeMag); sy = cosmeticRand(-shakeMag, shakeMag); }

  ctx.save();
  ctx.translate(W / 2 + sx, H / 2 + sy);
  ctx.rotate(camRoll);                     // frame-dragging tilt
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  drawEnts();
  drawWaves();
  drawSlugs();
  drawParts();
  // Squash and stretch along the direction of travel. A perfectly rigid disc
  // reads as a sprite no matter how good the shading is; anything under
  // acceleration should deform. The hole is drawn at absolute coordinates, so
  // the transform wraps the call rather than the function.
  if (state !== 'dead') {
    const spd = Math.hypot(p.vx, p.vy);
    let psx = 1;
    if (spd > 1 && state === 'play') {
      const k = clamp(spd / (SPEED_REF * p.r * 1.6), 0, 1) * 0.13;
      if (k > 0.002) {
        const ang = Math.atan2(p.vy, p.vx);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(ang);
        ctx.scale(1 + k, 1 - k);          // roughly preserves area
        ctx.rotate(-ang);
        ctx.translate(-p.x, -p.y);
        psx = 0;
        drawPlayer();
        ctx.restore();
      }
    }
    if (psx === 1) drawPlayer();
    drawGhost();
  }

  ctx.restore();

  drawDangerArrows();                     // screen space
  drawFloats();                           // screen space
  drawPick();                             // AGN feedback choice lanes
  drawJoystick();                         // joystick is screen-space, not world

  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  // Low-mass squeeze: the walls close in as you evaporate, so the end of a
  // run is something you feel coming. The pulse quickens with the drain rate,
  // so the vignette reports how fast you are losing mass, not just how low.
  if (nearDeath > 0.02) {
    const inner = MIN * (0.36 - 0.24 * nearDeath);
    const g = ctx.createRadialGradient(W / 2, H / 2, inner, W / 2, H / 2, Math.max(W, H) * 0.62);
    g.addColorStop(0, 'rgba(255,60,40,0)');
    const beat = 0.72 + 0.28 * Math.sin(elapsed * (2.2 + drainRate * 900));
    g.addColorStop(1, 'rgba(255,40,25,' + (0.55 * nearDeath * beat).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Directional damage vignette: a red edge-pulse from the side the hit came
  // from. We already knew the vector in hurt(); now it is visible.
  if (hitFx > 0.01) {
    const hx = W / 2 + hitDirX * W * 0.5;
    const hy = H / 2 + hitDirY * H * 0.5;
    const g = ctx.createRadialGradient(hx, hy, MIN * 0.10, hx, hy, Math.max(W, H) * 0.74);
    g.addColorStop(0, 'rgba(255,60,40,0)');
    g.addColorStop(1, 'rgba(255,70,45,' + (0.7 * hitFx).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Era-up celebration: a brief tint + a ring swell instead of a bare toast.
  if (eraFx > 0.01 && motion) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(150,110,255,' + (eraFx * 0.20).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  // MOTION: OFF has to kill the fullscreen white strobe as well. That flash,
  // not the shake, is the real photosensitivity risk.
  if (flashT > 0 && motion) {
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

// The CMB sits beneath everything: it is the most distant light in the
// universe, so it gets the lowest parallax of any layer -- nearly fixed while
// the starfield drifts over it.
function drawCmb() {
  if (!cmbPattern) return;
  const T = 256;
  const par = 0.05;
  const ox = mod(-cam.x * par * cam.zoom, T);
  const oy = mod(-cam.y * par * cam.zoom, T);
  ctx.save();
  ctx.scale(1 / DPR, 1 / DPR);
  ctx.translate((ox - T) * DPR, (oy - T) * DPR);
  ctx.fillStyle = cmbPattern;
  ctx.fillRect(0, 0, (W + 2 * T) * DPR, (H + 2 * T) * DPR);
  ctx.restore();
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

// The stick, drawn in screen space at a fixed bottom-centre position. Because
// it never moves, it can be hit blind -- which is the only way a thumb control
// is usable while you are watching the hole instead of your hands.
function drawJoystick() {
  if (controlMode !== 'joystick') return;   // drag modes steer themselves
  if (state !== 'play') return;

  const cx = JOY_BASE_X, cy = JOY_BASE_Y;
  const kx = cx + joy.dx * JOY_R;
  const ky = cy + joy.dy * JOY_R;
  const mag = Math.min(1, Math.hypot(joy.dx, joy.dy));

  // The stick sits over the bottom of the play area, which is where a lot of
  // the food arrives from. Dim it while nobody is touching it, so it is
  // findable but does not sit on top of the game the rest of the time.
  const idle = joy.active ? 1 : 0.55;

  ctx.globalCompositeOperation = 'lighter';

  // Base well. A soft dark disc keeps the knob readable over a bright nebula.
  const well = ctx.createRadialGradient(cx, cy, 0, cx, cy, JOY_R * 1.12);
  well.addColorStop(0.00, 'rgba(10,20,36,' + (0.42 * idle).toFixed(3) + ')');
  well.addColorStop(1.00, 'rgba(10,20,36,0)');
  ctx.fillStyle = well;
  ctx.beginPath(); ctx.arc(cx, cy, JOY_R * 1.12, 0, TAU); ctx.fill();

  // Outer ring brightens as you push, so the stick reports its own deflection.
  ctx.strokeStyle = 'rgba(79,240,255,' +
    ((0.24 + mag * 0.34) * idle).toFixed(3) + ')';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(cx, cy, JOY_R, 0, TAU); ctx.stroke();

  // Deadzone guide at 25% -- the throw before the hole actually moves.
  ctx.strokeStyle = 'rgba(150,200,230,' + (0.13 * idle).toFixed(3) + ')';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, JOY_R * JOY_DEADZONE, 0, TAU); ctx.stroke();

  // Four cardinal ticks, so the ring reads as a control and not a decoration.
  ctx.strokeStyle = 'rgba(150,200,230,' + (0.20 * idle).toFixed(3) + ')';
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5;
    const ux = Math.cos(a), uy = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + ux * JOY_R * 1.06, cy + uy * JOY_R * 1.06);
    ctx.lineTo(cx + ux * JOY_R * 1.20, cy + uy * JOY_R * 1.20);
    ctx.stroke();
  }

  // Thrust vector: a line from the centre to the knob, thickening with push.
  if (mag > 0.02) {
    ctx.strokeStyle = 'rgba(79,240,255,' + (0.16 + mag * 0.34).toFixed(3) + ')';
    ctx.lineWidth = 1 + mag * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(kx, ky); ctx.stroke();
  }

  // Knob.
  const knob = ctx.createRadialGradient(kx, ky, 0, kx, ky, JOY_KNOB);
  knob.addColorStop(0.00, 'rgba(190,250,255,' + ((0.55 + mag * 0.30) * idle).toFixed(3) + ')');
  knob.addColorStop(0.70, 'rgba(79,240,255,' + ((0.32 + mag * 0.28) * idle).toFixed(3) + ')');
  knob.addColorStop(1.00, 'rgba(79,240,255,0)');
  ctx.fillStyle = knob;
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,' + ((0.40 + mag * 0.40) * idle).toFixed(3) + ')';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB * 0.72, 0, TAU); ctx.stroke();

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

// Shockwave steering pick, drawn as three lanes. No DOM: the choice lives in
// the movement space, so it never interrupts flow with a menu.
function drawPick() {
  if (pickT <= 0 || !pickHold || state !== 'play') return;
  const holds = [pickHold.l, pickHold.c, pickHold.r];
  const bw = Math.min(150, W * 0.28), bh = 54;
  const cy = H * 0.60;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 3; i++) {
    const cx = W / 2 + (i - 1) * W * 0.30;
    const frac = clamp(holds[i] / (i === 1 ? 0.6 : 0.35), 0, 1);
    ctx.globalCompositeOperation = 'source-over';
    // 40% opacity background like real mobile games
    ctx.fillStyle = 'rgba(8,14,26,0.40)';
    ctx.strokeStyle = i === 1 ? 'rgba(79,240,255,0.75)' : 'rgba(150,200,230,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 10);
    else ctx.rect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.fill();
    ctx.stroke();
    // Dwell progress fills the lane from the bottom.
    if (frac > 0) {
      ctx.fillStyle = 'rgba(79,240,255,0.25)';
      const fh = (bh - 4) * frac;
      ctx.fillRect(cx - bw / 2 + 2, cy + bh / 2 - 2 - fh, bw - 4, fh);
    }
    ctx.fillStyle = '#eaf6ff';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillText(PICK_OPTS[i].name, cx, cy - 8);
    ctx.fillStyle = 'rgba(170,205,235,0.7)';
    ctx.font = '400 10px system-ui, sans-serif';
    ctx.fillText(PICK_OPTS[i].sub, cx, cy + 12);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// Ghost of your best run: a translucent ring replaying its positions.
// Positions are absolute and every run starts at the origin, so no
// simulation is needed -- just an index into the recording.
function drawGhost() {
  if (!ghostOn || !ghostData || state !== 'play') return;
  const sample = elapsed * 10;
  const gi = Math.floor(sample);
  if (gi < 0 || gi >= ghostData.x.length) return;
  const next = Math.min(gi + 1, ghostData.x.length - 1);
  const gx = lerp(ghostData.x[gi], ghostData.x[next], sample - gi);
  const gy = lerp(ghostData.y[gi], ghostData.y[next], sample - gi);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = 'rgba(79,240,255,0.8)';
  ctx.lineWidth = Math.max(1, p.r * 0.05);
  ctx.beginPath();
  ctx.arc(gx, gy, Math.max(6, p.r * 0.45), 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
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
    if (edibleAt(e)) continue;                       // edible ones are fine
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
    // Dark matter: no body, no glow, no collision. The only visible sign is
    // the way it lenses background starlight -- a much fainter version of the
    // Einstein rings that surround the player. This is the whole mechanic:
    // you know it is there because the stars behind it warp.
    if (e.darkMatter) {
      const dmR = e.r * 0.55;   // lensing radius smaller than the mass itself
      ctx.globalCompositeOperation = 'lighter';
      // Detection is the whole mechanic -- the rings must read clearly at
      // gameplay distance or the player cannot tell where the hazard is.
      // Two bright concentric arcs do that better than four faint ones, and
      // they are still recognisably the same Einstein-ring language the
      // player already knows from their own shadow.
      const bands = [EINSTEIN_BANDS[0], EINSTEIN_BANDS[2]];
      ctx.globalAlpha = 0.78;
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        const rad = dmR * b.k * (1 + Math.sin(elapsed * 0.6 - i * 0.9) * 0.012);
        ctx.strokeStyle = `rgba(225,236,255,${(b.a * 0.95).toFixed(3)})`;
        ctx.lineWidth = Math.max(0.8, dmR * b.w * 1.3);
        ctx.beginPath(); ctx.arc(e.x, e.y, rad, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      continue;
    }

    const ratio = e.r / p.r;
    const lethalAt = VARMODS[variant].thresh;
    const isGreed = e.greedT > 0;
    // Civilisation hardware is artificial, so it gets a cold tech tint
    // instead of the edible/lethal colour language of natural bodies.
    // A greed-gated body borrows the edible hue: it IS food right now.
    const hue = e.civ ? 200 : (isGreed ? entHue(0.7) : entHue(ratio));
    const scr = e.r * cam.zoom;          // on-screen radius, CSS px
    const b = e.body;

    // Atmospheric perspective. Without it every body sits on the same plane at
    // full contrast, which is a large part of why the field read as flat.
    // Distant bodies fade toward the background the way they do through air --
    // the oldest depth cue there is, and it costs one multiply.
    const dc = Math.hypot(e.x - cam.x, e.y - cam.y);
    const vis = Math.max(1, viewWorldRadius());
    const depthA = 1 - clamp((dc / vis - 0.5) / 0.8, 0, 1) * 0.55;

    // Threat colour rides on a soft glow instead of a hard stroked ring. The
    // old uniform circle drawn around every single body read as a UI outline
    // sitting on top of the art; the hue now bleeds off the limb the way an
    // atmosphere does, which is both prettier and less like a selection box.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (highContrast ? 0.82 : 0.6) * depthA;
    const gs = e.r * (ratio > lethalAt ? 2.5 : 2.2);
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
    ctx.globalAlpha = depthA;
    ctx.drawImage(bodySprite(b.type, b.variant, b.sub), -e.r, -e.r, e.r * 2, e.r * 2);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Fixed light direction; stars are self-lit so they skip this, and a
    // rival is a black hole -- a lit-side highlight on a shadow is nonsense.
    if (b.type !== 'star' && b.type !== 'rival' && b.type !== 'quasar' && scr > 3) {
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
      ctx.rotate(Math.PI);
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

    // Hazard shape. Lethal bodies wear a closed, spiked ring; edible ones
    // stay smooth. That is a SHAPE channel, so threat stays readable for
    // anyone who cannot separate the two hues -- colour alone is unusable
    // for them. Drawn as one closed polygon rather than radiating rays,
    // which read as a cartoon sunburst.
    // Greed pulse: a white ring says "eat me now" in the shape channel,
    // so the gate reads even for players who cannot separate the hues.
    if (isGreed) {
      const gp = 0.5 + 0.3 * Math.sin(elapsed * 8);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,255,255,' + gp.toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, e.r * 0.06);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 1.18, 0, TAU); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    if (ratio > lethalAt && !e.civ && !isGreed) {
      const pulse = 0.35 + 0.35 * Math.sin(elapsed * 5 + e.phase);
      const teeth = 12;
      const rIn = e.r * 1.10;
      const rOut = e.r * (1.26 + pulse * 0.10);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = Math.max(1, e.r * 0.055);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `hsla(${hue}, 100%, 70%, ${(0.45 + pulse * 0.45).toFixed(3)})`;
      ctx.beginPath();
      for (let k = 0; k < teeth * 2; k++) {
        const a = (k / (teeth * 2)) * TAU + e.phase * 0.4;
        const rr = (k & 1) ? rOut : rIn;
        const px = e.x + Math.cos(a) * rr, py = e.y + Math.sin(a) * rr;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.lineJoin = 'miter';
      ctx.globalCompositeOperation = 'source-over';
    }
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

// ============================================================
// THE BLACK HOLE
//
// Everything below is drawn with continuous gradients. The previous version
// stroked thirty separate arc segments for the photon ring and another thirty
// for the lensed disk, which stacked into a ring of hard-edged blocks and
// read as a brass gear or a clock face rather than as gas falling into a
// hole -- and its "near side" was a flat metallic-looking bar.
//
// The structure now is the one every real image shows (M87*, Sgr A*, and the
// Gargantua render everyone has seen):
//   * a perfectly black shadow
//   * a thin, brilliant photon ring hugging its edge
//   * a thin accretion disk seen almost edge-on, crossing in FRONT of the
//     shadow, hottest along its centre line and cooling outward
//   * the far side of that same disk lensed up over the top and down under
//     the bottom, because gravity bends its light around the hole
//   * Doppler beaming, so the limb rotating toward the camera is far
//     brighter than the one receding -- this is what makes a real
//     black-hole image lopsided instead of symmetric
// ============================================================
const DISK_FLAT = 0.115;   // sin(inclination): how edge-on the disk sits
const DISK_OUT = 3.1;      // outer disk radius, in shadow radii

// One side of the disk is always brighter. Which one is set by the fixed
// scene light direction so it stays consistent with every other body.
function beamSide() {
  return Math.cos(Math.atan2(LIGHT.y, LIGHT.x)) >= 0 ? 1 : -1;
}

// A thin, near-edge-on accretion disk. Projected through scale(1, DISK_FLAT)
// a radial gradient becomes an elliptical band, which is exactly the shape
// of a real disk seen from just above its plane -- and because the gradient
// is continuous there is no segmentation anywhere in it.
//
// One subtlety: a single projected circle has a HARD top and bottom edge,
// because the radial gradient is still ~85% opaque where the ellipse clip
// slices through it. A real disk fades vertically. So we stack a few
// ellipses of decreasing flatness at partial strength; their union ramps
// the opacity down through the vertical limb instead of stepping off a
// cliff, which is what stops the disk reading as a flat metallic bar.
const DISK_LAYERS = [1.00, 0.72, 0.44];
function drawDisk(r, beam, cx, cy) {
  const R = r * DISK_OUT;
  const ox = cx === undefined ? p.x : cx;
  const oy = cy === undefined ? p.y : cy;
  const share = 1 / DISK_LAYERS.length;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.globalCompositeOperation = 'lighter';

  const ISCO = r * 1.155;
  
  for (const flat of DISK_LAYERS) {
    ctx.save();
    ctx.scale(1, DISK_FLAT * flat);

    // Redshifted temperature gradient starting at ISCO
    const rg = ctx.createRadialGradient(0, 0, ISCO, 0, 0, R);
    rg.addColorStop(0.00, 'rgba(255,210,180,' + (0.90 * share).toFixed(3) + ')'); // Redshifted inner
    rg.addColorStop(0.14, 'rgba(255,190,140,' + (0.84 * share).toFixed(3) + ')');
    rg.addColorStop(0.36, 'rgba(255,160,90,' + (0.56 * share).toFixed(3) + ')');
    rg.addColorStop(0.62, 'rgba(255,120,50,' + (0.28 * share).toFixed(3) + ')');
    rg.addColorStop(0.85, 'rgba(255,80,20,' + (0.11 * share).toFixed(3) + ')');
    rg.addColorStop(1.00, 'rgba(255,50,10,0)');
    ctx.fillStyle = rg;
    
    // Gap inside ISCO
    ctx.beginPath(); 
    ctx.arc(0, 0, R, 0, TAU); 
    ctx.arc(0, 0, ISCO, 0, TAU, true); 
    ctx.fill();
    ctx.restore();
  }

  // Proper Doppler Beaming (δ⁴) using a linear gradient across the disk
  ctx.save();
  ctx.scale(1, DISK_FLAT);
  
  const lg = ctx.createLinearGradient(-R * beam, 0, R * beam, 0); // beam is 1 or -1
  // Calculate delta^4 stops from ISCO out
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const rad = ISCO + (R - ISCO) * (1 - Math.abs(2 * t - 1)); // rough approximation of radius across the line
    const beta = 0.5 / Math.sqrt(Math.max(1, rad / ISCO));
    const gam = 1 / Math.sqrt(1 - beta * beta);
    const cosT = 1 - 2 * t; 
    const delta = 1 / (gam * (1 - Math.abs(beam) * beta * cosT)); // beam is direction
    const b = Math.pow(delta, 4);
    
    // Normalize roughly so peak is around 1 (max delta^4 is ~9.0 at ISCO approaching limb)
    const normalizedB = Math.min(1, b / 9.0);
    lg.addColorStop(t, 'rgba(255,255,255,' + (normalizedB * 0.7).toFixed(3) + ')');
  }
  
  ctx.fillStyle = lg;
  ctx.globalCompositeOperation = 'lighter'; // Only brighten where disk exists
  ctx.beginPath(); 
  ctx.arc(0, 0, R, 0, TAU); 
  ctx.arc(0, 0, ISCO, 0, TAU, true); 
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

// Light from the far side of the disk, bent up over the top of the shadow and
// down under the bottom. Brightest at the pole and fading out toward the
// equator, which is where the lensed image piles up in a real photograph.
function drawLensedArcs(r, beam) {
  const inner = r * 1.02;
  const outer = r * 1.62;
  ctx.globalCompositeOperation = 'lighter';
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = s < 0 ? 1 : 0.38;

    // Half-plane, then annulus: only the arc outside the shadow survives.
    ctx.beginPath();
    ctx.rect(-outer, s < 0 ? -outer : 0, outer * 2, outer);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, TAU);
    ctx.arc(0, 0, inner, 0, TAU, true);
    ctx.clip();

    const g = ctx.createRadialGradient(0, s * r * 1.02, r * 0.02, 0, s * r * 1.02, r * 1.30);
    g.addColorStop(0.00, 'rgba(255,253,247,0.62)');
    g.addColorStop(0.30, 'rgba(255,238,208,0.34)');
    g.addColorStop(0.70, 'rgba(255,190,124,0.12)');
    g.addColorStop(1.00, 'rgba(255,150,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-outer, -outer, outer * 2, outer * 2);

    // Same Doppler asymmetry as the disk itself.
    const dg = ctx.createLinearGradient(-outer, 0, outer, 0);
    if (beam > 0) {
      dg.addColorStop(0.00, 'rgba(0,0,0,0)');
      dg.addColorStop(1.00, 'rgba(255,232,196,0.30)');
    } else {
      dg.addColorStop(0.00, 'rgba(255,232,196,0.30)');
      dg.addColorStop(1.00, 'rgba(0,0,0,0)');
    }
    ctx.fillStyle = dg;
    ctx.fillRect(-outer, -outer, outer * 2, outer * 2);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Light that has orbited the hole and escaped. Thin, continuous, and carried
// by a single linear gradient so the beaming runs smoothly around it with no
// visible segment joins.
function drawPhotonRing(r, beam) {
  const rr = r * 1.045;
  const g = ctx.createLinearGradient(p.x - rr, 0, p.x + rr, 0);
  const lo = beam > 0 ? 0.20 : 0.95;
  const hi = beam > 0 ? 0.95 : 0.20;
  g.addColorStop(0.00, 'rgba(255,216,180,' + lo.toFixed(3) + ')');
  g.addColorStop(0.50, 'rgba(255,247,234,1)');
  g.addColorStop(1.00, 'rgba(255,216,180,' + hi.toFixed(3) + ')');

  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = g;
  // A soft wide pass for the glow, then the crisp core on top.
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = Math.max(2, r * 0.075);
  ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(1, r * 0.035);
  ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

// ============================================================
//   Light wrapping around the hole.
//
//   Photons from the sky behind the hole are bent around it, so the
//   background piles up into concentric arcs hugging the shadow. Each
//   successive band is the same sky bent further round the hole:
//   fainter, thinner, and closer in. That stack of rings is the thing
//   that reads as "a black hole" more than the disk does.
// ============================================================
const EINSTEIN_BANDS = [
  { k: 1.26, a: 0.165, w: 0.026 },
  { k: 1.44, a: 0.100, w: 0.019 },
  { k: 1.66, a: 0.058, w: 0.014 },
  { k: 1.94, a: 0.032, w: 0.011 }
];

function drawEinsteinRings(r, beam, cx, cy) {
  const ox = cx === undefined ? p.x : cx;
  const oy = cy === undefined ? p.y : cy;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < EINSTEIN_BANDS.length; i++) {
    const b = EINSTEIN_BANDS[i];
    // A little breathing. Static rings read as a painted archery target;
    // a slow drift reads as fluid.
    const rad = r * b.k * (1 + Math.sin(elapsed * 0.6 - i * 0.9) * 0.012);
    // Each band is a CRESCENT, not a ring: the beamed limb is several times
    // brighter than the receding one, so the light looks like it is being
    // dragged around the hole rather than painted on as a circle.
    const lo = beam > 0 ? b.a * 0.15 : b.a;
    const hi = beam > 0 ? b.a : b.a * 0.15;
    const g = ctx.createLinearGradient(ox - rad, 0, ox + rad, 0);
    g.addColorStop(0.00, 'rgba(255,214,178,' + lo.toFixed(3) + ')');
    g.addColorStop(0.50, 'rgba(255,240,220,' + (b.a * 0.45).toFixed(3) + ')');
    g.addColorStop(1.00, 'rgba(255,214,178,' + hi.toFixed(3) + ')');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1, r * b.w);
    ctx.beginPath(); ctx.arc(ox, oy, rad, 0, TAU); ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// The far side of the disk, bent right around the shadow until it comes
// back out as a small bright knot clinging to the limb. In the reference
// this is the little highlight that drifts around the edge of the shadow.
function drawSecondaryImage(r, beam, cx, cy) {
  const ox = cx === undefined ? p.x : cx;
  const oy = cy === undefined ? p.y : cy;
  const dir = beam > 0 ? 1 : -1;
  const ang = (motion ? elapsed * 0.35 : 0) * dir;
  const ax = ox + Math.cos(ang) * r * 1.02;
  const ay = oy + Math.sin(ang) * r * 1.02;
  const rad = r * 0.22;
  ctx.save();
  // Higher-order disk light stays outside the apparent capture shadow.
  ctx.beginPath();
  ctx.arc(ox, oy, r * 1.30, 0, TAU);
  ctx.arc(ox, oy, r * 1.015, 0, TAU, true);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(ax, ay, 0, ax, ay, rad);
  g.addColorStop(0.00, 'rgba(255,252,242,0.88)');
  g.addColorStop(0.45, 'rgba(255,226,186,0.34)');
  g.addColorStop(1.00, 'rgba(255,190,130,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(ax, ay, rad, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawPlayer() {
  const r = p.r;
  const beam = beamSide();

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

  // A faint halo -- background starlight dragged around the well. Kept very
  // low: this and the lensing bands together were inflating the whole object
  // into a fuzzy torus, when the reference is a hard shadow with THIN arcs.
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(p.x, p.y, r * 1.02, p.x, p.y, r * 1.50);
  halo.addColorStop(0.00, 'rgba(255,198,156,0.075)');
  halo.addColorStop(0.45, 'rgba(255,150,110,0.022)');
  halo.addColorStop(1.00, 'rgba(255,132,100,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.50, 0, TAU); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // Bow shock. Light piles up in the direction you are travelling,
  // so a hole at speed wears a brighter cap on its leading edge. Without this
  // there is no way to read speed off the screen at all: the camera is pinned
  // to the hole, so motion at 900 units/s looks identical to motion at 90.
  const spd = Math.hypot(p.vx, p.vy);
  if (spd > 1) {
    const sf = clamp(spd / (SPEED_REF * P0 * 2.2), 0, 1);
    if (sf > 0.03) {
      const ux = p.vx / spd, uy = p.vy / spd;
      const gx = p.x + ux * r * 0.85;
      const gy = p.y + uy * r * 0.85;
      ctx.globalCompositeOperation = 'lighter';
      const bg = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 2.1);
      bg.addColorStop(0.00, 'rgba(190,235,255,' + (0.20 * sf).toFixed(3) + ')');
      bg.addColorStop(0.50, 'rgba(150,205,255,' + (0.07 * sf).toFixed(3) + ')');
      bg.addColorStop(1.00, 'rgba(120,180,255,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(gx, gy, r * 2.1, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // Unlocked skins are cosmetic horizon accents, never gameplay modifiers.
  const skinHue = SKIN_HUES[activeSkin];
  if (skinHue !== null && skinHue !== undefined) {
    ctx.save();
    ctx.strokeStyle = 'hsla(' + skinHue + ',85%,70%,0.65)';
    ctx.lineWidth = Math.max(1, r * 0.035);
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.8, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  // Pulsar-shield ring, when active.
  if (shield > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(255,236,205,${(0.45 + 0.35 * Math.sin(elapsed * 14)).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.55, 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  // The bent background. These live outside the shadow, so they go down
  // first -- the hole then punches its black disc out of the middle of them,
  // which is exactly the "light wrapping around" silhouette.
  drawEinsteinRings(r, beam);

  // The shadow -- pure black. (The observable "shadow" is about 2.6x the
  // Schwarzschild radius; we treat p.r as that shadow radius.)
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();

  // Lensed far side first: it lives outside the shadow, so it can go down
  // before the disk crosses in front.
  drawLensedArcs(r, beam);

  // The near side of the disk passes between us and the hole, so it is drawn
  // ON TOP of the black sphere and splits it in two. That is the single most
  // recognisable feature of the whole object.
  drawDisk(r, beam);

  // The far side of the disk, having wrapped right round the hole, lands on
  // the limb as a bright knot. Drawn over the shadow because it clings to it.
  drawSecondaryImage(r, beam);

  drawPhotonRing(r, beam);

  // Invulnerability flash overrides the whole assembly.
  if (invuln > 0 && Math.floor(invuln * 18) % 2 === 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.045, 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
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
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
const PIP_COUNT = 20;

function buildPips() {
  if (!el.comboBar) return;
  el.comboBar.innerHTML = '';
  for (let i = 0; i < PIP_COUNT; i++) el.comboBar.appendChild(document.createElement('i'));
}

// Nearest lethal body, its size relative to yours, and which way it lies.
// The danger arrows already knew this; a number makes it learnable.
function threatLine() {
  let bestD2 = Infinity, ratio = 0, ang = 0;
  const reach = viewWorldRadius();
  const reach2 = reach * reach;
  for (const e of ents) {
    if (edibleAt(e)) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > reach2 || d2 >= bestD2) continue;
    bestD2 = d2;
    ratio = e.r / p.r;
    ang = Math.atan2(dy, dx);
  }
  if (bestD2 === Infinity) return 'CLEAR';
  const dir = COMPASS[Math.round(mod(ang, TAU) / (TAU / 8)) % 8];
  return 'THREAT ' + ratio.toFixed(1) + '× ' + dir;
}

// Only touch the DOM when something actually changed -- this runs every frame.
// The hole's real size, in whatever unit keeps the number readable. Returns
// the diameter, because "13,200 km across" is how a person pictures an object
// -- radius is the physically meaningful quantity but diameter is the one you
// can see.
function scaleReadout() {
  const km = p.r * 2 * KM_PER_UNIT;
  if (km >= LY_KM) {
    const v = km / LY_KM;
    return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' ly ACROSS';
  }
  if (km >= AU_KM) {
    const v = km / AU_KM;
    return (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' AU ACROSS';
  }
  const n = Math.round(km);
  // Thousands separators once the number gets long enough to need them.
  return n.toLocaleString('en-US') + ' km ACROSS';
}

const hudCache = { chips: '', threat: '', scale: null, warn: null, crit: null, pips: -1 };

function updateHUD() {
  // Don't let the rolling counter keep easing while paused -- nothing should
  // animate on screen when the game is stopped.
  if (state !== 'paused') {
    shownScore = lerp(shownScore, score, 0.18);
    if (Math.abs(shownScore - score) < 0.6) shownScore = score;
    el.hudScore.textContent = fmt(Math.round(shownScore));
  }
  el.hudBest.textContent = fmt(best);
  const goal = runGoal();
  const goalLabel = document.getElementById('runGoalLabel');
  const goalFill = document.getElementById('runGoalFill');
  const missionLabel = document.getElementById('runMission');
  if (goalLabel && goalLabel.textContent !== goal.label) goalLabel.textContent = goal.label;
  if (goalFill) goalFill.style.width = goal.fill + '%';
  if (missionLabel) {
    const current = missions.find((m) => !m.done && MISSION_DEF(m.id) &&
      runMission && MISSION_DEF(m.id).prog() < MISSION_DEF(m.id).need);
    const def = current && MISSION_DEF(current.id);
    const text = def ? def.text + ' · ' + Math.max(0, Math.min(def.need, def.prog())) + '/' + def.need
      : 'Run missions complete';
    if (missionLabel.textContent !== text) missionLabel.textContent = text;
  }

  // Low-mass warning state: amber, then red, with a heartbeat.
  const warn = nearDeath > 0.45;
  const crit = nearDeath > 0.78;
  if (warn !== hudCache.warn) {
    el.hudScore.classList.toggle('warn', warn);
    hudCache.warn = warn;
  }
  if (crit !== hudCache.crit) {
    el.hudScore.classList.toggle('crit', crit);
    hudCache.crit = crit;
  }

  // Chips answer "why did I survive that?" and "what stage am I in?".
  const chips = [];
  if (shield > 0) chips.push('shield|MAGNETOSPHERE');
  chips.push('era|' + eraLabel(era));
  if (spinA > 0.5) chips.push('spin|SPIN ' + spinA.toFixed(2));
  chips.push('|' + (CTRL_LABEL[controlMode] || 'STICK'));
  const chipKey = chips.join(',');
  if (chipKey !== hudCache.chips) {
    hudCache.chips = chipKey;
    el.chips.innerHTML = '';
    for (const c of chips) {
      const parts = c.split('|');
      const d = document.createElement('div');
      d.className = 'chip' + (parts[0] ? ' ' + parts[0] : '');
      d.textContent = parts[1];
      el.chips.appendChild(d);
    }
  }

  const threat = (threatReadout && state === 'play') ? threatLine() : '';
  if (threat !== hudCache.threat) {
    hudCache.threat = threat;
    el.threatOut.textContent = threat;
  }

  // Real-unit size. Only meaningful while playing, and only worth touching the
  // DOM when the rendered string actually changes.
  const scale = (state === 'play' || state === 'paused') ? scaleReadout() : '';
  if (scale !== hudCache.scale) {
    hudCache.scale = scale;
    el.scaleOut.textContent = scale;
  }

  const on = combo >= 3 && comboT > 0;
  el.comboWrap.classList.toggle('on', on);
  if (on) {
    // Pips read as distance to the next AGN feedback under any variant cadence.
    const WE = WAVE_EVERY();
    const intoWave = combo % WE;
    el.comboValue.textContent =
      'COMBO ' + combo + '  ×' + comboMult().toFixed(1) +
      '  ·  CHOICE IN ' + (WE - intoWave);
    // Combo heat: the text grows and runs hotter toward the AGN feedback, then
    // pops when it fires.
    const heat = clamp(intoWave / WE, 0, 1);
    const pop = comboPopT > 0 ? comboPopT : 0;
    el.comboValue.style.transform =
      'scale(' + (1 + heat * 0.30 + pop * 0.55).toFixed(3) + ')';
    el.comboValue.style.color = highContrast
      ? ''
      : 'rgb(' + Math.round(79 + heat * 176) + ',' +
        Math.round(240 - heat * 40) + ',' +
        Math.round(255 - heat * 70) + ')';
    if (intoWave !== hudCache.pips) {
      hudCache.pips = intoWave;
      const kids = el.comboBar.children;
      const lit = Math.round((intoWave / WE) * kids.length);
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('on', i < lit);
    }
  } else {
    hudCache.pips = -1;
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
    // Shockwave pick: the world drops into slow motion while you steer.
    if (pickT > 0) dt *= 0.3;
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
  dailyRun = false;   // startDaily() re-arms it after calling us
  reset();
  state = 'play';
  panel = null;
  overGuardT = 0;
  hide(el.menu); hide(el.over); hide(el.pause); hide(el.settings);
  hide(el.eventPanel);
  show(el.hud); show(el.keysLegend);
  Snd.setDrone(true, 0);
}

function renderHistory() {
  if (!el.histStrip) return;
  el.histStrip.innerHTML = '';
  if (!history.length) return;
  let top = 1;
  for (const h of history) if (h.s > top) top = h.s;
  for (const h of history) {
    const d = new Date(h.t || Date.now());
    const cell = document.createElement('div');
    cell.className = 'hist';

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = Math.max(4, Math.round((h.s / top) * 26)) + 'px';

    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = fmt(h.s);

    const dt = document.createElement('div');
    dt.className = 'd';
    dt.textContent = (d.getMonth() + 1) + '/' + d.getDate();

    cell.appendChild(bar); cell.appendChild(n); cell.appendChild(dt);
    el.histStrip.appendChild(cell);
  }
}

function toMenu() {
  clearInput();
  for (const id of ['observatory', 'fieldguide', 'dailyreward', 'leaderboard']) {
    const node = document.getElementById(id);
    if (node) hide(node);
  }
  commitBest();
  state = 'menu';
  panel = null;
  hide(el.over); hide(el.hud); hide(el.pause); hide(el.settings);
  hide(el.eventPanel); hide(el.keysLegend);
  show(el.menu);
  // The footer chip is an icon plus this string. On a first run it used to be
  // set to '' , which left a trophy icon floating on its own above the build
  // tag -- on the very first screen every new player sees.
  el.menuBest.textContent = best > 0 ? 'BEST ' + fmt(best) : 'NO RUNS YET';
  renderHistory();
  renderMissions();
  renderDaily();
  syncControlPick();
  syncVariantPick();
  Snd.setDrone(false, 0);
  clearToasts();
}

function pauseGame() {
  if (state !== 'play') return;
  clearInput();
  state = 'paused';
  panel = 'pause';
  commitBest();
  if (el.pauseScore) el.pauseScore.textContent = 'MASS ' + fmt(score) + ' BEST ' + fmt(best);
  show(el.pause); hide(el.settings);
  Snd.setDrone(false, 0);
}

function resumeGame() {
  if (state !== 'paused' || !['pause', 'event', 'observe'].includes(panel)) return;
  clearInput();
  panel = null;
  state = 'play';
  hide(el.pause); hide(el.settings); hide(el.eventPanel); hide(el.observe);
  last = performance.now();          // don't hand the sim one giant dt
  Snd.setDrone(true, combo);
}

// Observation mode. A pause-and-frame view of the scene with real
// astronomical readouts. The player has chosen to look, so this is the only
// place where annotated numbers are welcome rather than noise.
function computeObserveStats() {
  // Geometric field of view in degrees. The render transform maps a world
  // radius of viewWorldRadius() to half the screen, so the half-angle is
  // atan(1/cam.zoom).
  const fovRad = 2 * Math.atan(1 / cam.zoom);
  const fovDeg = fovRad * 180 / Math.PI;
  el.obsFov.textContent = fovDeg.toFixed(fovDeg < 10 ? 2 : 1) + '°';

  // Nearest body in the field. Dark matter is included because the whole
  // point is that you can detect it; civ hardware is excluded because it is
  // a structure, not a celestial object. Distance converted to AU via the
  // same scale constant the size readout uses.
  let best = null, bd = Infinity;
  for (const e of ents) {
    if (e.civ) continue;
    const d2 = (e.x - p.x) * (e.x - p.x) + (e.y - p.y) * (e.y - p.y);
    if (d2 < bd) { bd = d2; best = e; }
  }
  if (!best) {
    el.obsNearest.textContent = 'nothing in range';
  } else {
    const distKm = Math.sqrt(bd) * KM_PER_UNIT;
    const au = distKm / AU_KM;
    const type = best.darkMatter ? 'dark matter' : (BODY_NAME[best.body && best.body.type] || 'body');
    const auStr = au >= 1
      ? au.toFixed(au < 10 ? 2 : 1) + ' AU'
      : (distKm >= 10000 ? Math.round(distKm).toLocaleString('en-US') + ' km'
                         : Math.round(distKm) + ' km');
    el.obsNearest.textContent = type + ' · ' + auStr;
  }

  el.obsSpan.textContent = scaleReadout();
  el.obsEra.textContent = eraLabel(era);
  // Spin is what makes the camera tilt honest: Schwarzschild sits near zero,
  // a meal-fed hole climbs toward maximal Kerr.
  if (el.obsSpin) el.obsSpin.textContent = 'a/M ' + spinA.toFixed(3);
}

function openObserve() {
  if (state !== 'play') return;
  commitBest();
  clearInput();
  state = 'paused';
  panel = 'observe';
  computeObserveStats();
  show(el.observe);
  Snd.setDrone(false, 0);
}

function closeObserve() {
  if (state !== 'paused' || panel !== 'observe') return;
  panel = null;
  state = 'play';
  hide(el.observe);
  last = performance.now();
  Snd.setDrone(true, combo);
}

// Settings is reachable from the menu as well as from pause, so remember
// where we came from and hand control back there.
let settingsFrom = 'pause';

function openSettings(from) {
  settingsFrom = from || (state === 'play' || state === 'paused' ? 'pause' : 'menu');
  panel = 'settings';
  hide(el.pause); hide(el.menu); hide(el.eventPanel);
  show(el.settings);
  syncSettingsUI();
}

function closeSettings() {
  hide(el.settings);
  if (settingsFrom === 'menu') {
    panel = null;
    state = 'menu';
    show(el.menu);
    renderHistory();
    renderMissions();
    renderDaily();
    syncControlPick();
    syncVariantPick();
  } else {
    panel = 'pause';
    show(el.pause);
  }
}

/* ---------- first-encounter panels ---------- */
// The rarest content in the game used to be missable mid-chaos. The first
// time each thing shows up we stop the world and say one line about it.
const EVENTS = {
  pulsar: {
    title: 'PULSAR',
    body: 'A neutron star spinning hundreds of times a second, sweeping the field with twin beams. ' +
          'Crossing a live beam burns while the pulsar out-masses you. ' +
          'Eat it and you steal a shield that absorbs your next impact.'
  },
  finale: {
    title: 'SINGULARITY',
    body: 'You reached the final score era. Larger bodies and evaporation remain dangerous. ' +
          'Continue into Singularity Endless with the same survival rules.'
  },
  wormhole: {
    title: 'WORMHOLE',
    body: 'Two mouths, one throat. Touch it and you are thrown across the field instantly. ' +
          'Useful for escaping — disorienting every time.'
  },
  civ: {
    title: 'SOMETHING NOTICED YOU',
    body: 'A civilisation is building countermeasures: deflector domes, gravity projectors, ' +
          'mass drivers, arks running for the edge. None of it is food.'
  }
};

function openEventPanel(key, ex, ey) {
  const info = EVENTS[key];
  if (!info) return;
  eventKey = key;
  clearInput();
  // Remember what we interrupted. update() does NOT early-return on 'dead', so
  // a surprise that lands on the fatal frame can open an explainer while the
  // run is already over; the panel must then close back to the run report
  // rather than back into play.
  eventReturnState = state === 'paused' ? 'play' : state;
  state = 'paused';
  panel = 'event';
  if (el.eventTitle) el.eventTitle.textContent = info.title;
  if (el.eventBody) el.eventBody.textContent = info.body;

  // Frame the encounter: park the camera between the hole and the thing we
  // are talking about and pull in a little, so the explainer is about
  // something you can actually see. update() is frozen while this is open,
  // and both ease back to normal the moment play resumes.
  if (typeof ex === 'number' && isFinite(ex)) {
    cam.x = p.x + (ex - p.x) * 0.55;
    cam.y = p.y + (ey - p.y) * 0.55;
  }
  cam.zoom *= 1.5;

  hide(el.pause); hide(el.settings);
  show(el.eventPanel);
  Snd.setDrone(false, 0);
}

// One stop per event per session: the first time you meet something rare we
// stop the world, later ones just play out.
const seenEvents = { pulsar: false, wormhole: false, civ: false };

// How close an encounter has to be before we interrupt. It has to be close
// enough that it is plainly ON SCREEN and about to matter -- an explainer
// that fires the instant something wanders into range stops a run dead in
// the opening seconds, which is worse than the content being missable.
const ENCOUNTER_REACH = 6;

function firstEncounter(key, ex, ey) {
  if (seenEvents[key]) return;
  if (panel === 'event') return;      // one explainer at a time; retry later
  seenEvents[key] = true;
  if (pauseOnEvent && state === 'play') openEventPanel(key, ex, ey);
  else toast(EVENTS[key].title, 2.2);
}

function closeEventPanel() {
  if (panel !== 'event') return;
  hide(el.eventPanel);
  panel = null;
  // Restore the state we froze, not 'play'. Unconditionally resuming play let
  // CONTINUE resurrect a run that had already died and had already committed
  // its score: the run report stayed on screen, but the simulation went live
  // again behind it.
  state = (eventReturnState === 'paused' || !eventReturnState) ? 'play' : eventReturnState;
  last = performance.now();
  if (state === 'play') Snd.setDrone(true, combo);
}

// One place decides what every settings row says. Each row is a label plus a
// value slot, so a sync writes the value (and aria-pressed for the boolean
// rows) instead of rebuilding a "LABEL: VALUE" string — the value's colour
// carries the state, so it is never buried mid-label.
function setSetting(btn, value, pressed) {
  if (!btn) return;
  const slot = btn.querySelector('.setting-val');
  if (slot) slot.textContent = value;
  if (pressed === true || pressed === false) {
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
}

function syncSettingsUI() {
  setSetting(el.soundBtn, Snd.muted ? 'Off' : 'On', !Snd.muted);
  setSetting(el.motionBtn, motion ? 'On' : 'Off', motion);
  setSetting(el.cbBtn, CB_LABEL[cbMode] || 'Normal');
  setSetting(el.ctrlBtn, CTRL_VALUE[controlMode] || 'Stick');
  setSetting(el.hapticBtn, HAPTIC_LABEL[haptics] || 'Off');
  setSetting(el.textBtn, textLarge ? 'Large' : 'Normal');
  setSetting(el.contrastBtn, highContrast ? 'On' : 'Off', highContrast);
  setSetting(el.threatBtn, threatReadout ? 'On' : 'Off', threatReadout);
  setSetting(el.eventBtn, pauseOnEvent ? 'On' : 'Off', pauseOnEvent);
  setSetting(el.ghostBtn, ghostData ? (ghostOn ? 'On' : 'Off') : 'No ghost yet', ghostOn && !!ghostData);
  if (el.musicRange) el.musicRange.value = String(Math.round(Snd.musicVol * 100));
  if (el.sfxRange) el.sfxRange.value = String(Math.round(Snd.sfxVol * 100));
  if (el.musicVal) el.musicVal.textContent = Math.round(Snd.musicVol * 100) + '%';
  if (el.sfxVal) el.sfxVal.textContent = Math.round(Snd.sfxVol * 100) + '%';
  syncControlPick();
}

/* ============================================================
   INPUT
   ============================================================ */
// Three control schemes, all touch-first, all selectable from the menu and
// from Settings. There is deliberately no MOUSE mode: this ships as an Android
// app, and a mouse-steering channel that only exists on desktop made the same
// hole handle differently depending on the device.
const CTRL_ORDER = ['joystick', 'follow', 'relative'];
const CTRL_LABEL = { joystick: 'STICK', follow: 'FOLLOW', relative: 'DRAG' };
// Title case for the settings row, where the value reads as a word; the chip
// and the menu's segmented control keep the caps form.
const CTRL_VALUE = { joystick: 'Stick', follow: 'Follow', relative: 'Drag' };
const CTRL_HINT = {
  joystick: 'push the stick at the bottom of the screen',
  follow: 'the hole chases your fingertip',
  relative: 'drag anywhere; the hole tracks the gesture'
};
let controlMode = lsGet('control', 'joystick');
if (CTRL_ORDER.indexOf(controlMode) < 0) controlMode = 'joystick';

function syncControlPick() {
  if (el.ctrlPick) {
    for (const b of el.ctrlPick.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.ctrl === controlMode);
    }
    // Drives the sliding pill indicator. A data attribute rather than CSS
    // :has(), which older Android WebView builds do not support.
    el.ctrlPick.dataset.sel = controlMode;
  }
  if (el.ctrlHint) el.ctrlHint.textContent = CTRL_HINT[controlMode] || '';
}

function setControl(m) {
  if (CTRL_ORDER.indexOf(m) < 0) return;
  controlMode = m;
  lsSet('control', m);
  // Drop any in-flight input so the schemes cannot fight each other.
  joy.active = false; joy.dx = 0; joy.dy = 0;
  drag.active = false;
  syncSettingsUI();
}

// Pre-run variants (Downwell Styles model): starting rules, never stat
// unlocks. A permanent size or drain buff would delete the threat inversion
// the whole game is built on; a choice of starting rules is replayability
// with no asset cost and no power creep across runs.
const VARMODS = {
  normal: { name: 'Standard', hint: 'the run as designed', decayMul: 1, comboWin: 1.35, waveEvery: 20, thresh: 0.95, driftExp: null, startMul: 1 },
  titan:  { name: 'Titan', hint: 'triple starting mass, double drain', decayMul: 2, comboWin: 1.35, waveEvery: 20, thresh: 0.95, driftExp: null, startMul: 3 },
  wisp:   { name: 'Wisp', hint: 'nimble hands, hungry hole: eats to its own size, drains fast', decayMul: 1.5, comboWin: 1.35, waveEvery: 20, thresh: 1.00, driftExp: 0.15, startMul: 1 },
  monk:   { name: 'Monk', hint: 'long combo breath, slower pulse', decayMul: 1, comboWin: 1.85, waveEvery: 24, thresh: 0.95, driftExp: null, startMul: 1 }
};
const VARIANT_ORDER = ['normal', 'titan', 'wisp', 'monk'];
let variant = lsGet('variant', 'normal');
if (!VARMODS[variant]) variant = 'normal';
function COMBO_WINDOW_V() { return VARMODS[variant].comboWin * (1 + 0.05 * runUpgrades.accretion); }
function WAVE_EVERY() { return VARMODS[variant].waveEvery; }
// One lethality rule for the whole game: AGN feedbacks, arrows, threat line,
// gravity and collisions all read the same predicate, including greed gates.
function edibleAt(e) {
  if (e.greedT > 0) return true;      // greed gate: this one is fair game
  return e.r <= p.r * VARMODS[variant].thresh;
}

function syncVariantPick() {
  if (el.varPick) {
    for (const b of el.varPick.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.var === variant);
    }
    el.varPick.dataset.sel = variant;
  }
  if (el.varHint) el.varHint.textContent = VARMODS[variant].hint;
}

function setVariant(m) {
  if (!VARMODS[m]) return;
  variant = m;
  lsSet('variant', m);
  syncVariantPick();
  syncSettingsUI();
}

/* ---------- parametric missions (3 at a time, Jetpack Joyride model) --- */
// The Investment gap: nothing in run N changes run N+1. Missions are the
// cheapest answer and need no content pipeline -- every objective reads a
// counter the game already tracks. Completed missions roll a fresh one.
const MISSION_POOL = [
  { id: 'era4',      need: 4,    text: 'Reach QUASAR (era 4)',                  prog: () => runStats.era },
  { id: 'combo15',   need: 15,   text: 'Chain 15 eats in one run',               prog: () => runStats.peakCombo },
  { id: 'dwarf3',    need: 3,    text: 'Eat 3 white dwarfs in one run', prog: () => runMission.wd },
  { id: 'survive180', need: 180, text: 'Survive 3:00',                 prog: () => Math.floor(elapsed) },
  { id: 'wave8',     need: 8,    text: 'One AGN feedback kills 8',        prog: () => runMission.waveBest },
  { id: 'ark2',      need: 2,    text: 'Eat 2 ark ships in one run',   prog: () => runMission.ark },
  { id: 'pulsar2',   need: 2,    text: 'Eat 2 pulsars in one run',     prog: () => runMission.pulsar },
  { id: 'score5k',   need: 5000, text: 'Score 5,000 in one run',       prog: () => Math.floor(score) },
  { id: 'graze20',   need: 20,   text: 'Graze danger 20 times in one run', prog: () => runMission.graze }
];
function MISSION_DEF(id) {
  for (const d of MISSION_POOL) if (d.id === id) return d;
  return null;
}
function dealMissionSet() {
  const ids = MISSION_POOL.map((d) => d.id);
  const out = [];
  while (out.length < 3 && ids.length) {
    out.push({ id: ids.splice((Math.random() * ids.length) | 0, 1)[0], done: false });
  }
  return out;
}
let missions = [];
function loadMissions() {
  const arr = Array.isArray(save.missions) ? save.missions : null;
  const ok = (m) => m && MISSION_DEF(m.id);
  if (arr && arr.length === 3 && arr.every(ok)) {
    missions = arr.map((m) => ({ id: m.id, done: !!m.done }));
  } else {
    missions = dealMissionSet();
    try { saveSet('missions', missions); } catch (_) {}
  }
}
function checkMissions() {
  if (!runMission || state !== 'play' || !missions.length) return;
  let changed = false;
  for (const m of missions) {
    if (m.done) continue;
    const def = MISSION_DEF(m.id);
    if (def && def.prog() >= def.need) {
      m.done = true;
      changed = true;
      toast('MISSION — ' + def.text, 2.4);
      Snd.sting('mission');
      buzz(50);
    }
  }
  if (changed) {
    try { saveSet('missions', missions); } catch (_) {}
    renderMissions();
  }
}
function renderMissions() {
  if (!el.missions) return;
  el.missions.innerHTML = '';
  for (const m of missions) {
    const def = MISSION_DEF(m.id);
    if (!def) continue;
    const row = document.createElement('div');
    row.className = 'mrow' + (m.done ? ' done' : '');
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = m.done ? '✓' : '○';
    const tx = document.createElement('span');
    let label = def.text;
    if (!m.done) {
      try { label += ' — ' + Math.min(def.prog(), def.need) + '/' + def.need; }
      catch (_) {}
    }
    tx.textContent = label;
    row.appendChild(tick);
    row.appendChild(tx);
    el.missions.appendChild(row);
  }
}

/* ---------- daily seeded run (Slay the Spire Daily Climb model) -------- */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function dailySeedInt() {
  const d = new Date();
  return (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) >>> 0;
}
function renderDaily() {
  if (!el.dailyBtn) return;
  // "DAILY RUN", not "DAILY": the Observatory has its own daily *rewards*
  // calendar, and two controls called DAILY on two different screens (one
  // starting a seeded run, one opening a reward list) read as the same thing.
  el.dailyBtn.textContent = (save.daily === todayStr()) ? 'DAILY RUN ✓' : 'DAILY RUN';
}
function startDaily() {
  if (save.daily === todayStr()) {
    toast('Daily already run — come back tomorrow', 2.2);
    return;
  }
  seedOverride = dailySeedInt();
  start();
  dailyRun = true;
  toast('DAILY RUN — one attempt', 2.2);
}

/* ---------- AGN feedback steering pick ------------------------------------ */
// The every-20th-combo AGN feedback is the perfect no-pause choice moment: the
// game drops into slow motion, three lanes appear, and you select by
// steering -- the input you are already holding. Timeout resolves to the
// middle lane (the classic AGN feedback), so indecision costs nothing.
const PICK_OPTS = [
  { name: 'ABSORB', sub: 'up to 15 nearby edibles; no special effects' },
  { name: 'FEEDBACK', sub: 'classic AGN feedback' },
  { name: 'AEGIS', sub: 'block one impact within 6s' }
];
function startPick() {
  if (state !== 'play') return;
  if (pickT > 0) { pendingWave = 0.28; return; }  // already choosing: queue it
  pickT = 2.4;
  pickHold = { l: 0, c: 0, r: 0 };
  buzz(20);
}
function resolvePick(i) {
  if (pickT <= 0 && !pickHold) return;
  pickT = 0;
  pickHold = null;
  if (i === 0) pickAbsorb();
  else if (i === 2) {
    shield = 3.6;   // ~6 s at the 0.6/s shield decay
    toast('AEGIS — deflect one impact within 6s', 2.0);
    waves.push({ x: p.x, y: p.y, r: p.r, max: p.r * 6, t: 0, hue: 45 });
    if (Snd.ac) Snd.tone(520, 'sine', 0.16, 0.01, 0.4, 5);
  } else {
    pendingWave = 0.28;   // AGN feedback with a wind-up
  }
}
function pickAbsorb() {
  const R = viewWorldRadius();
  const R2 = R * R;
  let n = 0, total = 0;
  for (let i = ents.length - 1; i >= 0 && n < 15; i--) {
    const o = ents[i];
    const dx = o.x - p.x, dy = o.y - p.y;
    if (dx * dx + dy * dy > R2) continue;
    if (o.darkMatter || (o.civ && o.civ !== 'ark') || !edibleAt(o)) continue;
    const gain = Math.max(1, Math.round(o.r * 0.42 * comboMult()));
    p.mass += bodyMass(o) * CONSUME_YIELD;
    score += gain;
    total += gain;
    burstFx(o.x, o.y, 6, o.r, 0.9, entHue(o.r / p.r));
    ents.splice(i, 1);
    n++;
  }
  p.r = p.mass * RS_PER_MASS;
  satiatedT = Math.max(satiatedT, 1.0);
  if (n) {
    toast('ABSORBED +' + fmt(total), 1.8);
    Snd.blip(combo);
  } else {
    toast('NOTHING TO ABSORB', 1.4);
  }
  checkMissions();
}

// Screen-space anchor used by the two drag schemes.
const drag = { active: false, sx: 0, sy: 0, ax: 0, ay: 0, wx: 0, wy: 0 };

function screenToWorld(cx, cy) {
  return {
    x: (cx - W / 2) / cam.zoom + cam.x,
    y: (cy - H / 2) / cam.zoom + cam.y
  };
}

// Turn a screen point into stick state. The knob follows the raw direction so
// it stays glued to the finger, while joy.dx/dy carry the EFFECTIVE thrust --
// deadzone removed and the remainder rescaled to 0..1. Rescaling matters: if
// the output simply jumped from 0 to JOY_DEADZONE at the threshold, the hole
// would lurch the instant you crossed it and fine control would be impossible.
function updateJoyFromPoint(px, py) {
  const vx = (px - JOY_BASE_X) / JOY_R;
  const vy = (py - JOY_BASE_Y) / JOY_R;
  const raw = Math.hypot(vx, vy);
  const ux = raw > 0 ? vx / raw : 0;
  const uy = raw > 0 ? vy / raw : 0;

  const kMag = Math.min(1, raw);
  joy.kx = JOY_BASE_X + ux * kMag * JOY_R;
  joy.ky = JOY_BASE_Y + uy * kMag * JOY_R;

  if (raw <= JOY_DEADZONE) { joy.dx = 0; joy.dy = 0; return; }
  const t = Math.min(1, (raw - JOY_DEADZONE) / (1 - JOY_DEADZONE));
  joy.dx = ux * t;
  joy.dy = uy * t;
}

let steerPointer = null;   // the one pointer that owns steering

cvs.addEventListener('pointerdown', (e) => {
  if (state !== 'play') return;
  if (steerPointer !== null) return;   // a second finger never steals steering
  ensureAudio();
  try { cvs.setPointerCapture(e.pointerId); } catch (_) {}
  steerPointer = e.pointerId;

  lastInput = (e.pointerType === 'mouse') ? 'mouse' : 'touch';
  pointer.x = e.clientX; pointer.y = e.clientY;
  pointer.on = true; pointer.down = true;

  if (controlMode === 'joystick') {
    // The base is pinned to the bottom centre, so a press ANYWHERE on the
    // screen drives it -- you never have to find the stick first, and you
    // never lose it mid-dodge. The throw is measured from the base, not from
    // wherever the finger happened to land.
    joy.active = true;
    joy.bx = JOY_BASE_X; joy.by = JOY_BASE_Y;
    updateJoyFromPoint(e.clientX, e.clientY);
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
  if (state !== 'play') return;
  if (steerPointer !== null && e.pointerId !== steerPointer) return;
  if (e.pointerType === 'mouse') {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.on = true;
  }
  if (controlMode === 'joystick') {
    if (!joy.active) return;
    updateJoyFromPoint(e.clientX, e.clientY);
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

function pointerRelease(e) {
  // Only the steering finger may release steering; a stray lift of the other
  // thumb used to drop the stick mid-dodge.
  if (e && e.pointerId !== undefined && steerPointer !== null &&
      e.pointerId !== steerPointer) return;
  steerPointer = null;
  joy.active = false;
  joy.dx = 0;
  joy.dy = 0;
  drag.active = false;
  pointer.down = false;
}
cvs.addEventListener('pointerup', pointerRelease);
cvs.addEventListener('pointercancel', pointerRelease);
cvs.addEventListener('lostpointercapture', (e) => {
  // Recapture can fire lostpointercapture for a pointer we never owned.
  if (steerPointer !== null && e.pointerId !== steerPointer) return;
  pointerRelease(e);
});
function clearInput() {
  steerPointer = null;
  pointerRelease();
  pointer.on = false;
  for (const key of Object.keys(keys)) keys[key] = false;
}

// Pointer tracking for the desktop/web build. There is deliberately no
// mouse-steering here any more: the hole is driven by the stick (or the
// keyboard), and a second, invisible steering channel made the same movement
// feel different depending on how you happened to be holding the device.
window.addEventListener('pointermove', (e) => {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  pointer.x = e.clientX; pointer.y = e.clientY;
  pointer.on = true;
  lastInput = 'mouse';
});
document.documentElement.addEventListener('pointerleave', () => { pointer.on = false; });
window.addEventListener('blur', () => { clearInput(); if (state === 'play') pauseGame(); });

// Suppression must not swallow panel scrolling: cards scroll natively, so the
// gesture block only applies to the canvas itself (and only mid-run).
document.addEventListener('touchmove', (e) => {
  if (state !== 'play' || e.target !== cvs) return;
  e.preventDefault();
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (window.RewardedAds && window.RewardedAds.busy()) return;
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') keys.up = true;
  if (k === 'arrowdown' || k === 's') keys.down = true;
  if (k === 'arrowleft' || k === 'a') keys.left = true;
  if (k === 'arrowright' || k === 'd') keys.right = true;
  if (k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright' ||
      k === 'w' || k === 'a' || k === 's' || k === 'd') {
    lastInput = 'key';
  }
  if (k === ' ' || k === 'enter') {
    // Route by state, never "not play = start": Space on the pause screen used
    // to throw the run away and start over, and Enter on the report card
    // bypassed the 0.8 s guard that the tap path respects.
    if (e.repeat) return;
    if (state === 'menu') { e.preventDefault(); start(); }
    else if (state === 'paused' && (panel === null || panel === 'pause')) {
      e.preventDefault(); resumeGame();
    }
    else if (state === 'dead' && overGuardT <= 0) { e.preventDefault(); start(); }
  }
  if (k === 'escape' || k === 'p') {
    if (state === 'play') pauseGame();
    else if (state === 'paused') {
      if (panel === 'settings') closeSettings();
      else if (panel === 'event') closeEventPanel();
      else if (panel === 'observe') closeObserve();
      else resumeGame();
    }
  }
  if (k === 'o') {
    if (state === 'play') openObserve();
    else if (state === 'paused' && panel === 'observe') closeObserve();
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

// Game-over used to restart on ANY tap, so one stray touch while reading the
// score wiped the moment. 0.8 s of dead input costs nothing and saves runs.
el.againBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (overGuardT <= 0) start();
});
el.over.addEventListener('click', () => { if (overGuardT <= 0) start(); });
el.shareBtn.addEventListener('click', (e) => { e.stopPropagation(); shareRun(); });

el.pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); pauseGame(); });
el.resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); resumeGame(); });
// Tapping anywhere on the observation overlay returns to play -- the panel
// itself catches the gesture with stopPropagation in case we ever add inner
// controls.
el.observe && el.observe.addEventListener('click', (e) => { e.stopPropagation(); closeObserve(); });
el.restartBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });
el.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings('pause'); });
el.menuSettingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings('menu'); });
el.homeBtn.addEventListener('click', (e) => { e.stopPropagation(); toMenu(); });
el.overHomeBtn.addEventListener('click', (e) => { e.stopPropagation(); toMenu(); });
el.settingsBackBtn.addEventListener('click', (e) => { e.stopPropagation(); closeSettings(); });
el.eventOkBtn.addEventListener('click', (e) => { e.stopPropagation(); closeEventPanel(); });

if (el.ctrlPick) {
  el.ctrlPick.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button[data-ctrl]') : null;
    if (!b) return;
    e.stopPropagation();
    setControl(b.dataset.ctrl);
  });
}

if (el.varPick) {
  el.varPick.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button[data-var]') : null;
    if (!b) return;
    e.stopPropagation();
    ensureAudio();
    setVariant(b.dataset.var);
    if (Snd.ac) Snd.tick(900, 1.0, 0.06, 0.06);
  });
}

if (el.dailyBtn) {
  el.dailyBtn.addEventListener('click', (e) => { e.stopPropagation(); startDaily(); });
}

function toggleMute() {
  ensureAudio();
  Snd.muted = !Snd.muted;
  lsSet('muted', Snd.muted ? '1' : '0');
  if (Snd.master) Snd.master.gain.setTargetAtTime(Snd.muted ? 0 : 0.85, Snd.ac.currentTime, 0.05);
  Snd.updateMusicAssetVol();
  el.muteBtn.classList.toggle('off', Snd.muted);
  el.muteBtn.setAttribute('aria-pressed', Snd.muted ? 'true' : 'false');
  syncSettingsUI();
}

el.muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
el.soundBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });

function applyA11y() {
  document.body.classList.toggle('large', textLarge);
  document.body.classList.toggle('hc', highContrast);
  // MOTION: OFF has to reach the menu too, not just the in-game shake. The
  // breathing CTA and the drifting aurora are decorative motion, so they are
  // gated by the same preference as the screen flash.
  document.body.classList.toggle('no-motion', !motion);
}

el.motionBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  motionPreference = !motionPreference;
  motion = motionPreference && !(motionQuery && motionQuery.matches);
  lsSet('motion', motionPreference ? '1' : '0');
  // MOTION: OFF must also kill the fullscreen white strobe -- that flash, not
  // the shake, is the actual photosensitivity risk.
  if (!motion) { shakeMag = 0; camRoll = 0; flashT = 0; eraFx = 0; }
  applyA11y();
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
  setControl(CTRL_ORDER[(i + 1) % CTRL_ORDER.length]);
});

el.hapticBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const i = HAPTIC_ORDER.indexOf(haptics);
  haptics = HAPTIC_ORDER[(i + 1) % HAPTIC_ORDER.length];
  lsSet('haptic', haptics);
  buzz(30);
  syncSettingsUI();
});

el.textBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  textLarge = !textLarge;
  lsSet('text', textLarge ? '1' : '0');
  applyA11y();
  syncSettingsUI();
});

el.contrastBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  highContrast = !highContrast;
  lsSet('contrast', highContrast ? '1' : '0');
  applyA11y();
  syncSettingsUI();
});

el.threatBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  threatReadout = !threatReadout;
  lsSet('threat', threatReadout ? '1' : '0');
  syncSettingsUI();
});

el.eventBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  pauseOnEvent = !pauseOnEvent;
  lsSet('eventPause', pauseOnEvent ? '1' : '0');
  syncSettingsUI();
});

if (el.ghostBtn) {
  el.ghostBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ghostOn = !ghostOn;
    lsSet('ghostOn', ghostOn ? '1' : '0');
    syncSettingsUI();
  });
}

if (el.musicRange) {
  el.musicRange.addEventListener('input', () => {
    ensureAudio();
    const v = clamp(parseInt(el.musicRange.value, 10) / 100 || 0, 0, 1);
    Snd.setMusicVol(v);
    lsSet('music', v);
    if (el.musicVal) el.musicVal.textContent = Math.round(v * 100) + '%';
  });
}
if (el.sfxRange) {
  el.sfxRange.addEventListener('input', () => {
    ensureAudio();
    const v = clamp(parseInt(el.sfxRange.value, 10) / 100 || 0, 0, 1);
    Snd.setSfxVol(v);
    lsSet('sfx', v);
    if (el.sfxVal) el.sfxVal.textContent = Math.round(v * 100) + '%';
    Snd.blip(4);              // audition the level while you drag
  });
}

/* ---------- share card ---------- */
// One button that renders the run to an image. Free distribution.
function shareRun() {
  try {
    const w = 1000, h = 525;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!g) { toast('Sharing unavailable on this device'); return; }

    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#04050d');
    bg.addColorStop(1, '#120b24');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);

    for (let i = 0; i < 220; i++) {
      g.fillStyle = 'rgba(198,228,255,' + (0.12 + cosmeticRandom() * 0.5).toFixed(2) + ')';
      g.beginPath();
      g.arc(cosmeticRandom() * w, cosmeticRandom() * h, cosmeticRandom() * 1.5 + 0.3, 0, TAU);
      g.fill();
    }

    // A miniature of the hole itself.
    const bx = w - 190, by = h / 2, br = 96;
    g.globalCompositeOperation = 'lighter';
    const halo = g.createRadialGradient(bx, by, br * 0.9, bx, by, br * 2.1);
    halo.addColorStop(0, 'rgba(255,196,150,0.34)');
    halo.addColorStop(1, 'rgba(255,130,100,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(bx, by, br * 2.1, 0, TAU); g.fill();
    g.globalCompositeOperation = 'source-over';

    g.save();
    g.translate(bx, by);
    g.scale(1, 0.13);
    const disk = g.createRadialGradient(0, 0, br * 0.9, 0, 0, br * 2.6);
    disk.addColorStop(0.00, 'rgba(255,255,255,0.95)');
    disk.addColorStop(0.22, 'rgba(255,236,198,0.70)');
    disk.addColorStop(0.60, 'rgba(255,168,86,0.30)');
    disk.addColorStop(1.00, 'rgba(255,120,50,0)');
    g.fillStyle = disk;
    g.beginPath(); g.arc(0, 0, br * 2.6, 0, TAU); g.fill();
    g.restore();

    g.fillStyle = '#000';
    g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,240,220,0.85)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(bx, by, br * 1.04, 0, TAU); g.stroke();

    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(79,240,255,0.95)';
    g.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillText('S I N G U L A R I T Y', 64, 96);

    g.fillStyle = '#ffffff';
    g.font = '800 84px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillText(fmt(score), 64, 200);
    g.fillStyle = 'rgba(180,215,245,0.7)';
    g.font = '700 20px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillText('SCORE', 66, 232);

    g.fillStyle = 'rgba(200,230,255,0.88)';
    g.font = '700 24px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillText('COMBO ×' + runStats.peakCombo, 64, 320);
    g.fillText(eraLabel(runStats.era), 64, 356);
    g.fillStyle = 'rgba(255,176,87,0.95)';
    g.fillText(runStats.cause || 'EVAPORATED', 64, 400);
    g.fillStyle = 'rgba(150,185,215,0.5)';
    g.font = '600 18px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillText('BEST ' + fmt(best), 64, 462);

    const done = (blob) => {
      if (!blob) { toast('Sharing unavailable on this device'); return; }
      let file = null;
      try { file = new File([blob], 'singularity.png', { type: 'image/png' }); } catch (_) {}

      // The Android WebView has no Web Share API at all -- Chrome exposes
      // navigator.share, the embedded WebView does not -- and Capacitor's
      // WebView installs no download handler, so both fallbacks below are
      // silent no-ops inside the app. On native, go through the official
      // plugins instead: write the PNG into the cache dir, then hand the file
      // to the system share sheet.
      const Cap = window.Capacitor;
      if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
        const Share = Cap.Plugins && Cap.Plugins.Share;
        const Filesystem = Cap.Plugins && Cap.Plugins.Filesystem;
        if (Share && Filesystem) {
          const reader = new FileReader();
          reader.onload = () => {
            const b64 = String(reader.result).split(',')[1] || '';
            Filesystem.writeFile({
              path: 'singularity-' + Math.round(score) + '.png',
              data: b64,
              directory: 'CACHE'
            })
              .then((res) => Share.share({
                title: 'SINGULARITY',
                text: 'Score ' + fmt(score),
                files: [res.uri],
                dialogTitle: 'Share your run'
              }))
              .catch(() => toast('Sharing unavailable on this device'));
          };
          reader.onerror = () => toast('Sharing unavailable on this device');
          reader.readAsDataURL(blob);
          return;
        }
      }

      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        navigator.share({ files: [file], title: 'SINGULARITY', text: 'Score ' + fmt(score) })
          .catch(() => {});
        return;
      }
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
          .then(() => toast('Card copied', 1.8))
          .catch(() => save());
        return;
      }
      save();
      function save() {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'singularity-' + Math.round(score) + '.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          if (a.parentNode) a.parentNode.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1200);
        toast('Card saved', 1.8);
      }
    };

    if (c.toBlob) c.toBlob(done, 'image/png');
    else toast('Sharing unavailable on this device');
  } catch (_) {
    toast('Sharing unavailable on this device');
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInput();
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
  // A human sentence opens the surface; the stack is for the developer, so it
  // trails behind a clear marker rather than greeting the player.
  n.textContent = 'SINGULARITY failed to start.\n\n' +
    'Reload the app and try again. If it keeps happening, the details ' +
    'below say where.\n\n— technical details —\n' + msg;
  n.classList.remove('hidden');
}
window.addEventListener('error', (e) => fatal((e.error && e.error.stack) || e.message));

best = parseInt(lsGet('best', 0), 10) || 0;
el.muteBtn.classList.toggle('off', Snd.muted);
el.muteBtn.setAttribute('aria-pressed', Snd.muted ? 'true' : 'false');

// Desktop-only affordance: the key legend along the bottom. A machine with no
// touch points can still play with WASD, so it gets the legend even though the
// stick is drawn for everyone.
let hasTouch = false;
try {
  hasTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
} catch (_) {}

applyA11y();
buildPips();
loadMissions();
syncSettingsUI();
if (el.buildTag) el.buildTag.textContent = 'BUILD ' + BUILD_ID;

try {
  buildShade();
  resize();
  reset();
  toMenu();
  // Dev hook for store screenshots: `?shot=play` boots straight into a run so
  // a headless browser can capture real gameplay frames (see PLAY_STORE.md).
  try {
    if (new URLSearchParams(location.search).get('shot') === 'play') start();
  } catch (_) {}
  requestAnimationFrame((t) => { last = t; frame(t); });
} catch (err) {
  fatal((err && err.stack) || String(err));
}

// The service worker has now caused more confusion than it ever solved.
// It kept serving stale JS after fixes, which is exactly what produced "your
// changes didn't work" and "nothing is visible". Unregister it so the browser
// always loads the build actually on disk. Nothing is lost: the Android app
// never used it -- Capacitor bundles the assets into the APK directly.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => { for (const r of regs) r.unregister(); })
    .catch(() => {});
}

/* ============================================================
   NEW: Meta-progression systems
   Stardust currency, upgrades, daily rewards, skins, achievements,
   field guide, leaderboard, near-miss feedback, rare windows.
   All appended below; nothing above this line is modified.
   ============================================================ */

/* ---------- Stardust + Upgrades ---------- */
// Save data is untrusted. Accept finite numeric values (including legacy
// numeric strings), never coercible arrays/objects or partial parseInt values.
function progressionNumber(value, integer = true) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, integer ? Math.floor(n) : n);
}
function progressionFlags(value, keys) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of keys) if (value[key] === true) result[key] = true;
  return result;
}
function saveProgression(values) {
  Object.assign(save, values);
  saveSet('v', SAVE_VER); // one complete snapshot, not several partial writes
}

let stardust = progressionNumber(lsGet('stardust', 0));
let upgrades = lsGet('upgrades', { gravity: 0, accretion: 0, horizon: 0, singularity: 0 });
if (typeof upgrades !== 'object' || upgrades === null || Array.isArray(upgrades)) upgrades = { gravity: 0, accretion: 0, horizon: 0, singularity: 0 };

// A lost arrow. These strings literally contained "?" where a separator was
// meant ("+2% starting radius per level ? next run"), so the Observatory showed
// a question mark mid-sentence -- which reads as a rendering fault or an
// unfinished thought. Plain words instead, no glyph to lose in a font subset.
const UPGRADE_DEFS = [
  { key: 'gravity', name: 'Gravity Well', desc: '+2% starting radius per level, active next ordinary run', max: 5 },
  { key: 'accretion', name: 'Accretion Disk', desc: '+5% combo duration per level, active next ordinary run', max: 5 },
  { key: 'horizon', name: 'Event Horizon', desc: '4% less impact mass loss per level, active next ordinary run', max: 5 },
  { key: 'singularity', name: 'Singularity', desc: '3% less evaporation per level, active next ordinary run', max: 5 }
];

function upgradeCost(level) { return (level + 1) * 10; }
function upgradeLevel(key) { return Math.min(5, progressionNumber(upgrades[key])); }
for (const def of UPGRADE_DEFS) upgrades[def.key] = upgradeLevel(def.key);

// Settle score milestones for ALL score sources, once per run. A large meal
// can cross several hundreds; effects and mission bonuses count as well.
function settleScoreDust() {
  if (!Number.isFinite(score) || score < 0) return;
  const reached = Math.floor(score / 100);
  if (reached > runDustScore) earnStardust(reached - runDustScore);
  runDustScore = Math.max(runDustScore, reached);
}

function earnStardust(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  stardust = Math.min(Number.MAX_SAFE_INTEGER, stardust + Math.floor(amount));
  try { saveSet('stardust', stardust); } catch (_) {}
}

/* ---------- Daily Rewards (28-day cumulative) ---------- */
let dailyRewards = Array.isArray(save.dailyRewards) ? [...new Set(save.dailyRewards.filter((day) =>
  (Number.isInteger(day) && day >= 0 && day < 28) || validClaimDate(day)))].slice(-28) : [];
// Keep legacy modulo indices as history, not as a permanent claim lock.
let dailyStreak = Math.max(dailyRewards.length, progressionNumber(lsGet('dailyStreak', 0)));
let dailyLastClaim = validClaimDate(lsGet('dailyLastClaim', '')) ? save.dailyLastClaim : '';
function validClaimDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T12:00:00');
  return Number.isFinite(d.getTime()) && localDateKey(d) === value;
}
function localDateKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dailyClaimedToday() { return dailyLastClaim === localDateKey(); }
function checkDailyAchievements() {
  if (dailyStreak >= 7) unlockAchievement('daily7');
  if (dailyStreak >= 28) unlockAchievement('daily28');
}

function dailyRewardForDay(day) {
  if (day <= 6) return { stardust: 5 + day, skin: null };
  if (day === 7) return { stardust: 25, skin: 'red_giant' };
  if (day === 14) return { stardust: 50, skin: 'veteran' };
  if (day === 21) return { stardust: 75, skin: 'quasar' };
  if (day === 28) return { stardust: 150, skin: 'nebula' };
  if (day % 7 === 0) return { stardust: 20, skin: null };
  return { stardust: 5 + (day % 7), skin: null };
}

function claimDailyReward() {
  const today = localDateKey();
  if (dailyClaimedToday()) {
    toast('Already claimed today', 1.6);
    return;
  }
  dailyLastClaim = today;
  dailyRewards.push(today);
  dailyRewards = dailyRewards.slice(-28);
  dailyStreak = Math.min(Number.MAX_SAFE_INTEGER, dailyStreak + 1);
  const reward = dailyRewardForDay((dailyStreak - 1) % 28 + 1);
  stardust = Math.min(Number.MAX_SAFE_INTEGER, stardust + reward.stardust);
  // Persist the lock, payout and unlocks together. A failed later write must
  // not leave a claimed date on disk without its corresponding reward.
  saveProgression({ dailyLastClaim, dailyRewards, dailyStreak, stardust,
    skins: { ...skins, ...(reward.skin ? { [reward.skin]: true } : {}) },
    achievements: { ...achievements, ...(dailyStreak >= 7 ? { daily7: true } : {}),
      ...(dailyStreak >= 28 ? { daily28: true } : {}) } });
  // Reflect the full unlock snapshot in memory before notification helpers
  // can persist either map again (notably when both daily badges unlock).
  const newSkin = reward.skin && !skins[reward.skin];
  const newBadges = ['daily7', 'daily28'].filter((id) => save.achievements[id] && !achievements[id]);
  skins = { ...save.skins };
  achievements = { ...save.achievements };
  if (newSkin) { toast('SKIN UNLOCKED', 2.0); Snd.sting('mission'); }
  for (const id of newBadges) {
    toast('ACHIEVEMENT: ' + ACH_DEFS[id].name, 2.6);
    Snd.sting('mission');
    buzz(60);
  }
  toast('+' + reward.stardust + ' STARDUST', 2.2);
  Snd.sting('mission');
  renderDailyReward();
}

/* ---------- Skins ---------- */
let skins = lsGet('skins', { default: true });
let activeSkin = lsGet('activeSkin', 'default');
if (typeof skins !== 'object' || skins === null) skins = { default: true };

const SKIN_HUES = { default: null, red_giant: 12, veteran: 45, quasar: 195,
  nebula: 280, pulsar: 215, feast: 145, fasting: 310 };
skins = progressionFlags(skins, Object.keys(SKIN_HUES));
skins.default = true;
if (!Object.prototype.hasOwnProperty.call(SKIN_HUES, activeSkin) || !skins[activeSkin]) activeSkin = 'default';

function equipSkin(id) {
  if (!Object.prototype.hasOwnProperty.call(SKIN_HUES, id) || !skins[id]) return false;
  activeSkin = id;
  saveSet('activeSkin', id);
  return true;
}

function renderSkinPicker() {
  if (!el2.obsUpgrades) return;
  let label = document.getElementById('skinPickerLabel');
  if (!label) {
    label = document.createElement('label');
    label.id = 'skinPickerLabel';
    label.appendChild(document.createTextNode('Horizon accent (cosmetic) '));
    const select = document.createElement('select');
    select.id = 'skinPicker';
    select.addEventListener('change', () => equipSkin(select.value));
    label.appendChild(select);
    el2.obsUpgrades.after(label);
    const daily = document.createElement('button');
    daily.type = 'button'; daily.id = 'dailyRewardBtn';
    daily.textContent = 'Daily reward';
    daily.addEventListener('click', () => { hide(el2.observatory); openDailyReward(); });
    label.after(daily);
  }
  const select = label.querySelector('select');
  select.replaceChildren();
  for (const id of Object.keys(SKIN_HUES)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id.replace(/_/g, ' ') + (skins[id] ? '' : ' (locked)');
    option.disabled = !skins[id];
    select.appendChild(option);
  }
  select.value = activeSkin;
}

function unlockSkin(id) {
  if (!Object.prototype.hasOwnProperty.call(SKIN_HUES, id) || skins[id]) return;
  skins[id] = true;
  try { saveSet('skins', skins); } catch (_) {}
  toast('SKIN UNLOCKED', 2.0);
  Snd.sting('mission');
}

function checkSkinUnlocks() {
  if (state !== 'play') return;
  if (era >= 3) unlockSkin('red_giant');
  if (era >= 5) unlockSkin('quasar');
}

/* ---------- Achievements ---------- */
let achievements = lsGet('achievements', {});
if (typeof achievements !== 'object' || achievements === null) achievements = {};

const ACH_DEFS = {
  first_eat: { name: 'First Meal', desc: 'Eat your first body' },
  first_era: { name: 'Stellar', desc: 'Reach era 1' },
  era5: { name: 'Supermassive', desc: 'Reach era 5' },
  combo20: { name: 'Combo Master', desc: 'Reach combo 20' },
  eat1000: { name: 'Glutton', desc: 'Eat 1,000 bodies total' },
  eat_pulsar: { name: 'Pulsar Hunter', desc: 'Eat a pulsar' },
  eat_wormhole: { name: 'Wormhole Rider', desc: 'Eat a wormhole' },
  eat_magnetar: { name: 'Magnetar Breaker', desc: 'Eat a magnetar' },
  eat_quasar: { name: 'Quasar Devourer', desc: 'Eat a quasar' },
  survive180: { name: 'Survivor', desc: 'Survive 3 minutes' },
  score10k: { name: 'High Scorer', desc: 'Score 10,000 in one run' },
  daily7: { name: 'Dedicated', desc: 'Claim 7 daily rewards' },
  daily28: { name: 'Committed', desc: 'Claim 28 daily rewards' }
};

achievements = progressionFlags(achievements, Object.keys(ACH_DEFS));

function unlockAchievement(id) {
  if (!Object.prototype.hasOwnProperty.call(ACH_DEFS, id) || achievements[id]) return;
  achievements[id] = true;
  try { saveSet('achievements', achievements); } catch (_) {}
  const def = ACH_DEFS[id];
  toast('ACHIEVEMENT: ' + (def ? def.name : id), 2.6);
  Snd.sting('mission');
  buzz(60);
}

function checkAchievements() {
  if (state !== 'play') return;
  if (totalEaten >= 1000) unlockAchievement('eat1000');
  if (runEaten > 0) unlockAchievement('first_eat');
  if (era >= 1) unlockAchievement('first_era');
  if (era >= 5) unlockAchievement('era5');
  if (combo >= 20) unlockAchievement('combo20');
  if (elapsed >= 180) unlockAchievement('survive180');
  if (score >= 10000) unlockAchievement('score10k');
  checkDailyAchievements();
}

/* ---------- Field Guide ---------- */
let fieldGuide = lsGet('fieldGuide', {});
if (typeof fieldGuide !== 'object' || fieldGuide === null) fieldGuide = {};

const FIELD_GUIDE_BODIES = [
  'rocky', 'ice', 'ocean', 'desert', 'barren', 'asteroid', 'uranus', 'neptune',
  'star', 'giant', 'lava', 'rogue', 'rival', 'brownDwarf', 'whiteDwarf',
  'pulsar', 'wormhole', 'magnetar', 'quasar', 'darkMatter'
];

const FIELD_GUIDE_FACTS = {
  rocky: 'A barren world of stone and iron, not so different from home.',
  ice: 'A frozen shell over a hidden ocean, cracked by tidal forces.',
  ocean: 'A world entirely of water, hundreds of kilometres deep.',
  desert: 'Dunes of iron oxide under a thin carbon dioxide sky.',
  barren: 'A dead world, baked by day and frozen by night.',
  asteroid: 'A loose rubble pile barely held together by its own gravity.',
  uranus: 'Tipped on its side, its bands run pole to pole.',
  neptune: 'The windiest planet: storms at two thousand kilometres per hour.',
  star: 'A ball of fusing hydrogen, pouring light into the void.',
  giant: 'A gas giant with no surface, only deeper and denser gas.',
  lava: 'A world still cooling from its formation, oceans of magma.',
  rogue: 'A planet with no star, wandering the dark between systems.',
  rival: 'Another singularity. Only one of you is leaving.',
  brownDwarf: 'A failed star, too small to ignite, too large to be a planet.',
  whiteDwarf: 'The dead core of a star, a teaspoon weighs six tonnes.',
  pulsar: 'A spinning neutron star, beaming radiation like a lighthouse.',
  wormhole: 'A shortcut through spacetime. No one knows where it leads.',
  magnetar: 'A neutron star with a field strong enough to strip atoms.',
  quasar: 'A supermassive hole devouring a galaxy, outshining the stars.',
  darkMatter: 'Invisible mass. You know it is there only by its gravity.'
};

const FIELD_GUIDE_BEHAVIOR = {
  star: 'Consume when smaller for bonus score and a supernova; larger stars burn on impact.',
  lava: 'Consume when smaller; larger lava worlds burn on impact.',
  rival: 'Pulls you toward it. Consume when smaller; larger rivals hit hard.',
  brownDwarf: 'Consume when smaller for double meal score.',
  whiteDwarf: 'Consume when smaller for fourfold meal score; larger dwarfs hit hard.',
  pulsar: 'Larger pulsars burn with their beams. Consume for a temporary one-impact shield.',
  wormhole: 'Consume when small enough to teleport across the field.',
  magnetar: 'Deflects you sideways nearby. Consume to clear nearby threats with a starquake.',
  quasar: 'Consume when smaller; larger quasars cause severe impact damage.',
  darkMatter: 'Pulls you nearby and cannot be eaten. Discover by approaching within five player radii.'
};

fieldGuide = progressionFlags(fieldGuide, FIELD_GUIDE_BODIES);

function discoverBody(type) {
  if (!FIELD_GUIDE_BODIES.includes(type) || fieldGuide[type]) return;
  fieldGuide[type] = true;
  try { saveSet('fieldGuide', fieldGuide); } catch (_) {}
  toast('FIELD GUIDE: ' + (BODY_NAME[type] || type), 2.0);
}

/* ---------- Weekly Leaderboard ---------- */
let weeklyScores = Array.isArray(save.weeklyScores) ? save.weeklyScores : [];
// A local Sunday-start calendar week, identified by its start DATE. This
// stays stable across DST and New Year; legacy week numbers lack a year and
// cannot safely be attributed to this week.
function weekKey(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  start.setDate(start.getDate() - start.getDay());
  return localDateKey(start);
}
function normalizeWeeklyScores() {
  const wk = weekKey();
  const scores = weeklyScores.filter((w) => w && w.week === wk && Array.isArray(w.scores))
    .flatMap((w) => w.scores).filter((s) => Number.isFinite(s) && s >= 0)
    .map((s) => Math.min(Number.MAX_SAFE_INTEGER, Math.round(s)))
    .sort((a, b) => b - a).slice(0, 10);
  weeklyScores = [{ week: wk, scores }];
  myWeeklyBest = scores[0] || 0;
}
let myWeeklyBest = 0;
normalizeWeeklyScores();
let totalEaten = progressionNumber(lsGet('totalEaten', 0));
let totalRuns = progressionNumber(lsGet('totalRuns', 0));
let totalPlayTime = progressionNumber(lsGet('totalPlayTime', 0), false);

function submitScore(sc, stats = {}) {
  normalizeWeeklyScores();
  if (Number.isFinite(sc) && sc >= 0) {
    weeklyScores[0].scores.push(Math.min(Number.MAX_SAFE_INTEGER, Math.round(sc)));
    weeklyScores[0].scores.sort((a, b) => b - a);
    weeklyScores[0].scores = weeklyScores[0].scores.slice(0, 10);
    myWeeklyBest = weeklyScores[0].scores[0] || 0;
  }
  saveProgression({ ...stats, weeklyScores, myWeeklyBest });
}

/* ---------- Rare Body Windows ---------- */
let runsSinceLastRare = progressionNumber(lsGet('runsSinceLastRare', 0));
function checkRareWindow() {
  runsSinceLastRare++;
  // Decide only after reset has seeded this run. Pinned/daily fields do not
  // depend on account history; ordinary runs retain the five-run pity rule.
  const pinned = seedFromUrl() !== null || dailyRun;
  if (pinned ? rng() < 0.25 : (runsSinceLastRare >= 5 || (runsSinceLastRare >= 3 && rng() < 0.5))) {
    rareWindowActive = true;
    rareWindowT = 20;
    rareSpawnT = 5;
    runsSinceLastRare = 0;
  }
  saveSet('runsSinceLastRare', runsSinceLastRare);
}

function updateRareWindow(dt) {
  if (state !== 'play' || !rareWindowActive) return;
  rareWindowT -= dt;
  rareSpawnT -= dt;
  if (rareSpawnT <= 0 && rareWindowT > 0) {
    rareSpawnT += 5;
    const a = rng() * TAU, d = viewWorldRadius() * 0.85;
    ents.push({ x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d,
      vx: 0, vy: 0, r: p.r * 0.45, spin: 0, phase: 0,
      body: { type: 'pulsar', variant: 0, spin: 0 }, pulseT: 1, beatMax: 2 });
  }
  if (rareWindowT <= 0) rareWindowActive = false;
}

/* ---------- Button Press Sounds ---------- */
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('button') : null;
  if (btn && Snd.ac && !Snd.muted) {
    try { Snd.tick(880, 1.0, 0.04, 0.06); } catch (_) {}
  }
});

/* ---------- Rewarded Ad Offer (Observatory) ---------- */
// Optional placement: explicit opt-in, plain-language disclosure, capped by
// the ads service. Declining changes nothing; earned stardust never depends
// on ads. Only a watch() === true (real earned callback, capped) pays out.
(function initRewardedOffer() {
  const offer = document.getElementById('rewardOffer');
  const btn = document.getElementById('rewardAdBtn');
  const status = document.getElementById('rewardAdStatus');
  const privacyBtn = document.getElementById('adPrivacyBtn');
  if (!offer || !btn) return;
  const ads = window.RewardedAds;
  if (!ads || !ads.available()) { offer.classList.add('hidden'); }
  if (privacyBtn) privacyBtn.classList.toggle('hidden', !(ads && ads.privacy));
  function refresh() {
    const reward = (ads && ads.config.rewardAmount) || 25;
    const daily = (ads && ads.config.dailyLimit) || 3;
    const left = ads ? ads.remaining() : 0;
    btn.disabled = !(ads && ads.available());
    btn.textContent = 'WATCH AD · +' + reward + ' STARDUST' +
      (left < daily ? ' (' + left + ' LEFT TODAY)' : '');
    if (status && !(ads && ads.available())) {
      status.textContent = left <= 0 ? 'Daily bonus used — back tomorrow.' : '';
    }
  }
  function checkPendingReward() {
    if (!ads || !ads.getPendingReward) return false;
    const pendingId = ads.getPendingReward();
    if (!pendingId) return false;
    const applied = save.rewardId;
    if (pendingId !== applied) {
      earnStardust((ads.config.rewardAmount) || 25);
      save.rewardId = pendingId;
      try { saveSet('rewardId', pendingId); } catch (_) {}
      ads.clearPendingReward();
      return true;
    }
    ads.clearPendingReward();
    return false;
  }
  checkPendingReward();

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!ads || ads.busy() || btn.disabled) return;
    btn.disabled = true;
    if (status) status.textContent = 'Loading ad…';
    
    const previousState = state;
    if (state === 'play') pauseGame();
    Snd.setDrone(false, 0);

    let earned = false;
    try { earned = await ads.watch(); } catch (_) { earned = false; }
    
    const recovered = checkPendingReward();
    earned = earned || recovered;

    if (previousState === 'play' && (panel === null || panel === 'pause')) {
      resumeGame();
    } else if (state !== 'dead') {
      Snd.setDrone(true, combo);
    }

    if (earned) {
      renderObservatory();
      if (status) status.textContent = '+' + ((ads.config.rewardAmount) || 25) + ' stardust added.';
      toast('+' + ((ads.config.rewardAmount) || 25) + ' stardust', 1.8);
    } else if (status) {
      status.textContent = 'No ad available or closed early — stardust unchanged.';
    }
    refresh();
  });
  if (privacyBtn) privacyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await ads.privacy(); } catch (_) {}
  });
  refresh();
})();

/* ---------- New DOM references ---------- */
const el2 = {};
['menuObservatoryBtn', 'menuFieldGuideBtn', 'menuLeaderboardBtn',
 'fgCloseBtn', 'drCloseBtn', 'drClaimBtn', 'lbCloseBtn', 'obsCloseBtn',
 'fgGrid', 'fgProgress', 'drCalendar', 'drInfo', 'lbList', 'lbInfo',
 'obsStardust', 'obsRuns', 'obsEaten', 'obsTime', 'obsUpgrades',
 'overNearMiss', 'observatory', 'fieldguide', 'dailyreward', 'leaderboard',
 'menu'].forEach((id) => { el2[id] = document.getElementById(id); });

/* ---------- Observatory Panel ---------- */
function openObservatory() {
  clearInput();
  state = 'paused';
  panel = 'observatory';
  renderObservatory();
  show(el2.observatory);
  hide(el.menu); hide(el.pause); hide(el.settings);
  Snd.setDrone(false, 0);
}

function renderObservatory() {
  renderSkinPicker();
  if (el2.obsStardust) el2.obsStardust.textContent = stardust;
  if (el2.obsRuns) el2.obsRuns.textContent = totalRuns;
  if (el2.obsEaten) el2.obsEaten.textContent = totalEaten;
  if (el2.obsTime) el2.obsTime.textContent = Math.floor(totalPlayTime / 60) + ':' + String(Math.floor(totalPlayTime % 60)).padStart(2, '0');
  if (!el2.obsUpgrades) return;
  el2.obsUpgrades.innerHTML = '';
  const rules = document.createElement('p');
  rules.className = 'obs-upgrade-rules';
  rules.textContent = 'Upgrades apply to ordinary runs only, not daily or seeded challenges. ' +
    'Earn 1 stardust per 100 score, plus special consumption bonuses: stars +2, ' +
    'wormholes and magnetars +3, pulsars and quasars +5.';
  el2.obsUpgrades.appendChild(rules);
  for (const def of UPGRADE_DEFS) {
    const lvl = upgrades[def.key] || 0;
    const cost = upgradeCost(lvl);
    const maxed = lvl >= def.max;
    const row = document.createElement('div');
    row.className = 'obs-upgrade';
    row.innerHTML =
      '<div class="obs-upgrade-info">' +
        '<div class="obs-upgrade-name">' + def.name + ' <span class="obs-upgrade-level">L' + lvl + '/' + def.max + '</span></div>' +
        '<div class="obs-upgrade-desc">' + def.desc + '</div>' +
      '</div>' +
      '<button class="obs-upgrade-btn"' + (maxed || stardust < cost ? ' disabled' : '') + '>' +
        (maxed ? 'MAX' : cost + ' ✦') +
      '</button>';
    const btn = row.querySelector('button');
    if (btn && !maxed) {
      btn.addEventListener('click', () => {
        if (upgradeLevel(def.key) === lvl && stardust >= cost && lvl < def.max) {
          stardust -= cost;
          upgrades[def.key] = lvl + 1;
          try { saveSet('stardust', stardust); saveSet('upgrades', upgrades); } catch (_) {}
          toast(def.name + ' L' + (lvl + 1), 1.8);
          Snd.sting('mission');
          renderObservatory();
        }
      });
    }
    el2.obsUpgrades.appendChild(row);
  }
}

/* ---------- Field Guide Panel ---------- */
function openFieldGuide() {
  clearInput();
  state = 'paused';
  panel = 'fieldguide';
  renderFieldGuide();
  show(el2.fieldguide);
  hide(el.menu); hide(el.pause); hide(el.settings);
  Snd.setDrone(false, 0);
}

function renderFieldGuide() {
  if (!el2.fgGrid) return;
  el2.fgGrid.innerHTML = '';
  let found = 0;
  for (const type of FIELD_GUIDE_BODIES) {
    const discovered = !!fieldGuide[type];
    if (discovered) found++;
    const cell = document.createElement('div');
    cell.className = 'fg-cell' + (discovered ? ' discovered' : ' locked');
    cell.dataset.body = type;
    cell.innerHTML =
      '<div class="fg-swatch"></div>' +
      '<div class="fg-name">' + (discovered ? (BODY_NAME[type] || type) : '???') + '</div>';
    if (discovered) {
      for (const [className, text] of [['fg-fact', FIELD_GUIDE_FACTS[type]],
        ['fg-behavior', FIELD_GUIDE_BEHAVIOR[type] || 'Consume when smaller; avoid when larger.']]) {
        if (!text) continue;
        const detail = document.createElement('div');
        detail.className = className; detail.textContent = text;
        cell.appendChild(detail);
      }
    }
    el2.fgGrid.appendChild(cell);
  }
  if (el2.fgProgress) el2.fgProgress.textContent = found + ' / ' + FIELD_GUIDE_BODIES.length + ' discovered';
}

/* ---------- Daily Reward Panel ---------- */
function openDailyReward() {
  clearInput();
  state = 'paused';
  panel = 'dailyreward';
  renderDailyReward();
  show(el2.dailyreward);
  hide(el.menu); hide(el.pause); hide(el.settings);
  Snd.setDrone(false, 0);
}

function renderDailyReward() {
  if (!el2.drCalendar) return;
  el2.drCalendar.innerHTML = '';
  const claimedToday = dailyClaimedToday();
  const progress = dailyStreak % 28 || (claimedToday && dailyStreak ? 28 : 0);
  const today = claimedToday ? progress - 1 : progress;
  for (let i = 0; i < 28; i++) {
    const claimed = i < progress;
    const isToday = i === today;
    const future = i > today;
    const day = document.createElement('div');
    day.className = 'dr-day' + (claimed ? ' claimed' : '') + (isToday ? ' today' : '') + (future ? ' future' : '');
    const reward = dailyRewardForDay(i + 1);
    day.innerHTML = '<div class="dr-num">' + (i + 1) + '</div><div class="dr-ico">' + (claimed ? '✓' : (reward.skin ? '★' : '✦')) + '</div>';
    el2.drCalendar.appendChild(day);
  }
  if (el2.drInfo) {
    const nextClaim = claimedToday ? 'Come back tomorrow!' : 'Claim your reward!';
    el2.drInfo.textContent = 'Total claims: ' + dailyStreak + ' days · ' + nextClaim;
  }
  if (el2.drClaimBtn) el2.drClaimBtn.style.display = claimedToday ? 'none' : '';
}

/* ---------- Leaderboard Panel ---------- */
function openLeaderboard() {
  normalizeWeeklyScores();
  clearInput();
  state = 'paused';
  panel = 'leaderboard';
  renderLeaderboard();
  show(el2.leaderboard);
  hide(el.menu); hide(el.pause); hide(el.settings);
  Snd.setDrone(false, 0);
}

function renderLeaderboard() {
  const title = el2.leaderboard && el2.leaderboard.querySelector('.glass-title');
  if (title) title.textContent = 'YOUR LOCAL RUNS';
  if (el2.lbInfo) el2.lbInfo.textContent = 'This week · personal runs saved on this device only';
  if (!el2.lbList) return;
  el2.lbList.innerHTML = '';
  const wk = weekKey();
  const entry = weeklyScores.find((w) => w.week === wk);
  const scores = entry ? entry.scores : [];
  if (!scores.length) {
    el2.lbList.innerHTML = '<div class="hint dim">No local runs recorded this week.</div>';
    return;
  }
  for (let i = 0; i < scores.length; i++) {
    const isMe = i === 0;
    const row = document.createElement('div');
    row.className = 'lb-row' + (isMe ? ' me' : '');
    row.innerHTML =
      '<span class="lb-rank">' + (i + 1) + '</span>' +
      '<span class="lb-name">' + (isMe ? 'Your best this week' : 'Your run') + '</span>' +
      '<span class="lb-score">' + fmt(scores[i]) + '</span>';
    el2.lbList.appendChild(row);
  }
}

/* ---------- Near-Miss Death Feedback ---------- */
function computeNearMiss() {
  const goal = runGoal();
  return !goal.endless && goal.remaining > 0 && goal.remaining < 300
    ? fmt(goal.remaining) + ' points to ' + goal.next : '';
}

/* ---------- Wire up new buttons ---------- */
if (el2.menuObservatoryBtn) el2.menuObservatoryBtn.addEventListener('click', (e) => { e.stopPropagation(); openObservatory(); });
if (el2.menuFieldGuideBtn) el2.menuFieldGuideBtn.addEventListener('click', (e) => { e.stopPropagation(); openFieldGuide(); });
if (el2.menuLeaderboardBtn) el2.menuLeaderboardBtn.addEventListener('click', (e) => { e.stopPropagation(); openLeaderboard(); });
if (el2.fgCloseBtn) el2.fgCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); hide(el2.fieldguide); show(el.menu); state = 'menu'; panel = null; toMenu(); });
if (el2.drCloseBtn) el2.drCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); hide(el2.dailyreward); show(el.menu); state = 'menu'; panel = null; toMenu(); });
if (el2.drClaimBtn) el2.drClaimBtn.addEventListener('click', (e) => { e.stopPropagation(); claimDailyReward(); });
if (el2.lbCloseBtn) el2.lbCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); hide(el2.leaderboard); show(el.menu); state = 'menu'; panel = null; toMenu(); });
if (el2.obsCloseBtn) el2.obsCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); hide(el2.observatory); show(el.menu); state = 'menu'; panel = null; toMenu(); });

/* ---------- Hook into existing systems ---------- */
// Stardust earning: hook into consume() by wrapping the original
const _origConsume = consume;
consume = function(e, idx) {
  if (state !== 'play' || !e || ents[idx] !== e) return;
  const type = e.body && e.body.type;
  const result = _origConsume.apply(this, arguments);
  // Earn stardust
  settleScoreDust();
  let earned = 0;
  if (type === 'pulsar') earned += 5;
  else if (type === 'wormhole') earned += 3;
  else if (type === 'magnetar') earned += 3;
  else if (type === 'quasar') earned += 5;
  else if (type === 'star') earned += 2;
  if (earned > 0) earnStardust(earned);
  // Field guide
  if (type) discoverBody(type);
  // Achievements
  if (type === 'pulsar') unlockAchievement('eat_pulsar');
  if (type === 'wormhole') unlockAchievement('eat_wormhole');
  if (type === 'magnetar') unlockAchievement('eat_magnetar');
  if (type === 'quasar') unlockAchievement('eat_quasar');
  totalEaten++; runEaten++; lastMealT = elapsed;
  try { saveSet('totalEaten', totalEaten); } catch (_) {}
  // Skin: pulsar rare drop
  if (type === 'pulsar' && cosmeticRandom() < 0.005) unlockSkin('pulsar');
  // Skin: feast (100 bodies in one run)
  if (runEaten >= 100) unlockSkin('feast');
  return result;
};

// Hook into die() for near-miss feedback and stats
let runProgressionSettled = false;
const _origDie = die;
die = function() {
  if (state !== 'play' || runProgressionSettled) return;
  runProgressionSettled = true;
  settleScoreDust();
  totalRuns = Math.min(Number.MAX_SAFE_INTEGER, totalRuns + 1);
  totalPlayTime = Math.min(Number.MAX_SAFE_INTEGER, totalPlayTime + progressionNumber(elapsed, false));
  submitScore(score, { totalRuns, totalPlayTime });
  // Veteran skin
  if (totalRuns >= 50) unlockSkin('veteran');
  // Near-miss feedback
  const nearMiss = computeNearMiss();
  if (el2.overNearMiss) el2.overNearMiss.textContent = nearMiss;
  // Fasting skin: survived 120s without eating (check before death)
  if (elapsed - lastMealT >= 120) unlockSkin('fasting');
  checkAchievements();
  checkSkinUnlocks();
  return _origDie.apply(this, arguments);
};

// Hook into start() for rare windows
const _origStart = start;
start = function() {
  // Restart can replace a paused/live run without passing through death.
  // Commit its score before reset clears the per-run milestone watermark.
  if (state === 'play' || state === 'paused') commitBest();
  const seeded = seedOverride !== null || seedFromUrl() !== null;
  for (const def of UPGRADE_DEFS) runUpgrades[def.key] = seeded ? 0 : upgradeLevel(def.key);
  const result = _origStart.apply(this, arguments);
  runProgressionSettled = false;
  if (seeded) {
    if (rng() < 0.25) { rareWindowActive = true; rareWindowT = 20; rareSpawnT = 5; }
  } else checkRareWindow();
  return result;
};

// Hook into update() for achievement checks
const _origUpdate = update;
update = function(dt) {
  const playing = state === 'play';
  const result = _origUpdate.apply(this, arguments);
  if (playing) settleScoreDust();
  if (state === 'play') {
    updateRareWindow(dt);
    checkAchievements();
    checkSkinUnlocks();
  }
  return result;
};

// Hook into toMenu() to render new panels
const _origToMenu = toMenu;
toMenu = function() {
  renderDailyReward();
  renderFieldGuide();
  renderObservatory();
  return _origToMenu.apply(this, arguments);
};

// Initial render
setTimeout(() => { renderDailyReward(); renderFieldGuide(); renderObservatory(); }, 100);
