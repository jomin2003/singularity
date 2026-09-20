/**
 * Headless pacing playtest for SINGULARITY.
 *
 * Boots the REAL game (jsdom + stubbed canvas/audio, same approach as
 * smoke_test.cjs), drives it with simple steering policies, and measures the
 * run curve: time to each era, HAWKING drain vs food intake, death causes and
 * combo cadence. Scenario knobs are applied as checked source transforms
 * before boot, so every number below comes from the shipped simulation.
 *
 * Dev-only. jsdom is NOT a project dependency; run with it on NODE_PATH:
 *
 *   NODE_PATH="<dir containing node_modules>" node tools/playtest_pacing.cjs
 */
const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('jsdom is not installed. Install it somewhere and point NODE_PATH at it.');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
let gameSrc = fs.readFileSync(path.join(WWW, 'game.js'), 'utf8');

const SCRIPT_TAG = /<script\s+src="game\.js[^"]*"><\/script>/;
if (!SCRIPT_TAG.test(html)) {
  console.error('FATAL: no <script src="game.js..."> tag in index.html.');
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * Source transforms. Each replaces a shipped literal with a hook the
 * scenario table can flip. Every replacement is counted -- a silent
 * no-op transform would quietly measure the wrong game.
 * ------------------------------------------------------------------ */
function transform(src, regex, repl, label, expected) {
  // Count on a global COPY, then replace with the original regex: returning
  // repl from a wrapper function would suppress $1 interpolation.
  const gre = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const n = (src.match(gre) || []).length;
  if (n !== (expected || 1)) {
    console.error('FATAL: transform "' + label + '" matched ' + n + ' times (expected ' + (expected || 1) + ').');
    process.exit(2);
  }
  return src.replace(regex, repl);
}

// Tunable consts become vars so scenarios can reassign them through __pt.
gameSrc = transform(gameSrc,
  /const (HAWKING_BASE|HAWKING_MIN|HAWKING_MAX|ENT_TARGET) = /g,
  'var $1 = ', 'consts -> vars', 4);

// Satiated window becomes hookable.
gameSrc = transform(gameSrc,
  /satiatedT = 2\.0;/,
  'satiatedT = (window.__SATIATED != null ? window.__SATIATED : 2.0);',
  'satiatedT hook');

/* ------------------------------------------------------------------ *
 * PROPOSAL transform: the drain fix under test. Two operations, one
 * regex each, so the shipped shape can never drift away silently.
 * ------------------------------------------------------------------ */
gameSrc = transform(gameSrc,
  /let decay = HAWKING_BASE \* clamp\(Math\.pow\(P0 \/ p\.r, 3\),\n                                     HAWKING_MIN, HAWKING_MAX\);/,
  'let decay = HAWKING_BASE * Math.pow(P0 / p.r, 3);\n  if (window.__PT_DRAIN === true) decay = clamp(decay, HAWKING_MIN, HAWKING_MAX);\n  else decay = HAWKING_BASE * clamp(Math.pow(P0 / p.r, 3), HAWKING_MIN, HAWKING_MAX);',
  'drain eq swap');
gameSrc = transform(gameSrc,
  /var HAWKING_MIN = 0\.25;\nvar HAWKING_MAX = 2\.0;/,
  'var HAWKING_MIN = (window.__PT_DRAIN === true ? 0.0035 : 0.25);\nvar HAWKING_MAX = (window.__PT_DRAIN === true ? 0.015 : 2.0);',
  'drain clamps');

/* ------------------------------------------------------------------ *
 * Scenario table. Each entry: const reassignments (applied after boot,
 * before start) + optional window hooks + a label.
 * ------------------------------------------------------------------ */
const SCENARIOS = {
  BASE:   { consts: {},                                    hook: {} },
  GENTLE: { consts: { HAWKING_MAX: 1.4 },                  hook: { __SATIATED: 2.6 } },
  FEED:   { consts: {},                                    hook: {} },
  // Proposal A: drain clamps corrected to match the cubic's intent.
  // Wisp = decayMul 1.5 rides the top band without touching the clamp.
  FIXED:  { consts: { HAWKING_MIN: 0.035, HAWKING_MAX: 0.9 }, hook: {} },
};
// FEED widens the mid-band of pickRadius (more 0.26-0.72x food, fewer scraps).
// Applied as a transform so it is visible in this file next to the numbers.
gameSrc = transform(gameSrc,
  /if \(q < 0\.50\) return p\.r \* rand\(0\.09, 0\.30\);\n  if \(q < 0\.78\) return p\.r \* rand\(0\.30, 0\.72\);/,
  'if (q < (window.__FEED ? 0.44 : 0.50)) return p.r * rand(0.09, 0.30);\n  if (q < 0.78) return p.r * rand(0.26, 0.72);',
  'pickRadius bands');

/* ------------------------------------------------------------------ *
 * Dev probe injected after game.js, same trick as smoke_test.cjs.
 * ------------------------------------------------------------------ */
const PROBE = `
window.__pt = {
  run: function (src) { return eval(src); },
  q: function (name) { return eval(name); },
  start: function () { start(); },
  push: function (x, y) { joy.active = true; joy.dx = x; joy.dy = y; },
  release: function () { joy.active = false; joy.dx = 0; joy.dy = 0; },
  clearEnts: function () { ents.length = 0; },
};
`;

const inlined = html.replace(SCRIPT_TAG, '<script>\n' + gameSrc + '\n' + PROBE + '\n</script>');
if (inlined.indexOf('function frame') === -1) {
  console.error('FATAL: game.js was not inlined into the page.');
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * Canvas 2D + WebAudio stubs (copied from smoke_test.cjs).
 * ------------------------------------------------------------------ */
const METHODS = [
  'setTransform', 'resetTransform', 'transform', 'save', 'restore',
  'translate', 'scale', 'rotate', 'beginPath', 'closePath', 'moveTo',
  'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill',
  'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect', 'fillText',
  'strokeText', 'drawImage', 'quadraticCurveTo', 'bezierCurveTo',
  'setLineDash', 'putImageData',
];
function makeCtx(canvas) {
  const grad = () => ({ addColorStop() {} });
  const ctx = {
    canvas,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt',
    lineJoin: 'miter', miterLimit: 10, shadowBlur: 0, shadowColor: 'transparent',
    imageSmoothingEnabled: true, filter: 'none',
    createRadialGradient: grad, createLinearGradient: grad, createConicGradient: grad,
    createPattern: () => ({}),
    measureText: (t) => ({ width: String(t).length * 6 }),
    getLineDash: () => [],
    isPointInPath: () => false,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)) }),
  };
  for (const m of METHODS) if (!(m in ctx)) ctx[m] = () => {};
  return ctx;
}
function AudioContextStub() {
  const param = () => ({
    value: 0,
    setValueAtTime() {}, linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {}, setTargetAtTime() {},
    cancelScheduledValues() {},
  });
  const node = (extra) => Object.assign({ connect() { return this; }, disconnect() {} }, extra);
  return {
    currentTime: 0, sampleRate: 44100, state: 'running', destination: node({}),
    resume() { this.state = 'running'; },
    createGain: () => node({ gain: param() }),
    createOscillator: () => node({ type: 'sine', frequency: param(), detune: param(), start() {}, stop() {} }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(), Q: param(), gain: param() }),
    createBuffer: (ch, len) => ({ length: len, numberOfChannels: ch, sampleRate: 44100, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => node({ buffer: null, playbackRate: param(), start() {}, stop() {} }),
  };
}

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String((e && e.message) || e || '');
  if (msg.indexOf('HTMLMediaElement') >= 0) return;
  errors.push('jsdomError: ' + (e.stack || e.message));
});
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

function boot(seed, scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  const url = 'http://localhost/?seed=' + seed;
  const dom = new JSDOM(inlined, {
    runScripts: 'dangerously',
    url,
    virtualConsole: vc,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = function (type) {
        if (type !== '2d') return null;
        if (!this.__ctx) this.__ctx = makeCtx(this);
        return this.__ctx;
      };
      window.AudioContext = AudioContextStub;
      window.requestAnimationFrame = () => 0;
      window.cancelAnimationFrame = () => {};
      window.addEventListener('error', (e) => {
        errors.push('error event: ' + ((e.error && e.error.stack) || e.message));
      });
      for (const [k, v] of Object.entries(scenario.hook)) window[k] = v;
      window.__SCENARIO = scenarioName;
      if (scenarioName === 'FEED') window.__FEED = true;
      if (scenarioName === 'FIXED') window.__PT_DRAIN = true;
    },
  });
  const { window } = dom;
  if (typeof window.frame !== 'function') {
    console.error('FATAL: window.frame is not a function after boot.');
    process.exit(2);
  }
  // Apply const overrides before start(), so every spawn after this reads them.
  for (const [k, v] of Object.entries(scenario.consts)) {
    window.__pt.run(k + ' = ' + JSON.stringify(v) + ';');
  }
  return window;
}

/* ------------------------------------------------------------------ *
 * Steering policies. All read live game state through __pt.
 * ------------------------------------------------------------------ */
const POLICIES = {
  // Nearest edible body, flee if a lethal body gets uncomfortably close.
  greedy(w) {
    const p = w.__pt.q('p'), ents = w.__pt.q('ents');
    const VARMODS = w.__pt.q('VARMODS'), variant = w.__pt.q('variant');
    const thresh = VARMODS[variant].thresh;
    let food = null, fd = Infinity, danger = null, dd = Infinity;
    for (const e of ents) {
      if (e.darkMatter || e.civ || e.comet) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (e.r > p.r * thresh) { if (d < dd) { dd = d; danger = e; } }
      else if (d < fd) { fd = d; food = e; }
    }
    if (danger && dd < p.r * 3.5) {
      const m = dd || 1;
      w.__pt.push(-(danger.x - p.x) / m, -(danger.y - p.y) / m);
      return;
    }
    if (food) {
      const m = fd || 1;
      w.__pt.push((food.x - p.x) / m, (food.y - p.y) / m);
    } else w.__pt.push(0.3, 0.3);
  },
  // Drifts mostly straight, eats whatever drifts close. Floor for engagement.
  passive(w) {
    w.__pt.push(0, 0);
  },
  // Greedy + actively hunts combo: prefers the nearest food even at some risk.
  combo(w) {
    const p = w.__pt.q('p'), ents = w.__pt.q('ents');
    const VARMODS = w.__pt.q('VARMODS'), variant = w.__pt.q('variant');
    const thresh = VARMODS[variant].thresh;
    let food = null, fd = Infinity;
    for (const e of ents) {
      if (e.darkMatter || e.civ || e.comet) continue;
      if (e.r > p.r * thresh * 0.9) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < fd) { fd = d; food = e; }
    }
    if (food) {
      const m = fd || 1;
      w.__pt.push((food.x - p.x) / m, (food.y - p.y) / m);
    } else w.__pt.push(0.5, 0.5);
  },
};

/* ------------------------------------------------------------------ *
 * Analytical drain model (no jsdom): exact replica of the shipped
 * HAWKING equation, for the segment table.
 * ------------------------------------------------------------------ */
const P0 = 22, M0 = 10, RS = P0 / M0, YIELD = 0.34, BASE = 0.0015;
function drainPerSec(r) {
  const decay = Math.min(2.0, Math.max(0.25, BASE * Math.pow(P0 / r, 3)));
  return r / RS * decay; // mass/s
}
function massFromMeal(rel) { return YIELD * Math.pow(rel, 2) * M0; }

/* ------------------------------------------------------------------ *
 * Run one game to death (or cap), recording the curve.
 * ------------------------------------------------------------------ */
function runPlaytest(seed, scenarioName, policyName, capSec) {
  const w = boot(seed, scenarioName);
  const policy = POLICIES[policyName];
  const T = { v: 0 };
  const step = (frames, dtMs = 16.7) => {
    for (let i = 0; i < frames; i++) { T.v += dtMs; w.frame(T.v); }
  };
  step(30);                                  // settle boot frames
  w.__pt.start();

  const samples = [];
  const eras = {};                           // era -> first time seen
  let deaths = { hits: 0 }, lastComboPeak = 0;
  let comboPeaks = [];
  const capFrames = Math.round(capSec * 60);

  for (let f = 0; f < capFrames; f++) {
    // Shockwave pick on screen -> hold centre to take the AGN wave.
    if (w.__pt.q('pickHold')) {
      w.__pt.push(0, 0);
      step(1);
      continue;
    }
    policy(w);
    step(1);

    const st = w.__pt.q('state');
    if (st === 'dead') break;
    if (f % 60 === 0) {
      const score = w.__pt.q('score');
      const combo = w.__pt.q('combo');
      if (combo > lastComboPeak) { comboPeaks.push(f / 60); lastComboPeak = combo; }
      samples.push({ t: f / 60, score, r: w.__pt.q('p').r, mass: w.__pt.q('p').mass,
        sat: w.__pt.q('satiatedT'), drain: w.__pt.q('drainRate'),
        ents: w.__pt.q('ents').length });
      const era = Math.floor(score / 1200);
      if (!(era in eras)) eras[era] = f / 60;
    }
  }

  const dead = w.__pt.q('state') === 'dead';
  const finalState = w.__pt.q('state');
  let crash = null;
  if (w.__pt.q('crashed')) {
    const f = w.document.getElementById('fatal');
    crash = (f && f.textContent || '').trim().slice(0, 400);
  }
  const stats = w.__pt.q('runStats');
  const out = {
    seed, scenario: scenarioName, policy: policyName,
    died: dead,
    finalState,
    crashed: !!crash,
    crash,
    time: w.__pt.q('elapsed'),
    score: Math.round(w.__pt.q('score')),
    peakR: w.__pt.q('p').r,
    cause: stats ? (stats.cause || '?') : '?',
    biggest: stats ? stats.biggest : 0,
    era: Math.floor(w.__pt.q('score') / 1200),
    eras,
    samples,
  };
  w.window && w.window.close && w.window.close();
  return out;
}

/* ------------------------------------------------------------------ *
 * MAIN
 * ------------------------------------------------------------------ */
const SEEDS = ['20260915', '777', '424242', '31337', '8675309'];
const PLAN = [
  ['BASE',   'greedy'],
  ['BASE',   'passive'],
  ['BASE',   'combo'],
  ['GENTLE', 'greedy'],
  ['FEED',   'greedy'],
  ['FIXED',  'greedy'],
  ['FIXED',  'passive'],
  ['FIXED',  'combo'],
];
const CAP = 90; // seconds

console.log('== Analytical drain table (shipped equation, no sim) ==');
for (const rel of [1.0, 0.7, 0.5, 0.35, 0.2]) {
  const r = P0 * rel;
  const drain = drainPerSec(r);
  const meal = massFromMeal(0.5);
  console.log(`r=${rel * P0 | 0}u  drain=${drain.toFixed(3)} mass/s  ` +
    `0.5x meal buys ${massFromMeal(0.5) ? (meal / drain).toFixed(1) : '?'}s  ` +
    `0.25x meal buys ${(massFromMeal(0.25) / drain).toFixed(1)}s`);
}
console.log('');

const results = [];
for (const [scen, pol] of PLAN) {
  for (const seed of SEEDS) {
    const r = runPlaytest(seed, scen, pol, CAP);
    results.push(r);
    const mm = (t) => t.toFixed(0) + 's';
    console.log(`[${scen}/${pol} seed=${seed}] ` +
      `${r.died ? 'DIED' : 'ALIVE'} @${mm(r.time)} score=${r.score} era=${r.era} ` +
      `peakR=${r.peakR.toFixed(0)} cause="${r.cause}" biggest=+${r.biggest}`);
    if (r.crash) console.log('    CRASH: ' + r.crash.split('\n')[0] + ' | ' + r.crash.split('\n')[1]);
    if (!r.died && !r.crash && r.finalState !== 'play')
      console.log(`    NOTE: exited state=${r.finalState}`);
    const eraLine = Object.entries(r.eras).map(([e, t]) => `e${e}@${t.toFixed(0)}s`).join(' ');
    if (eraLine) console.log('    eras: ' + eraLine);
  }
}

console.log('\n== Summary (mean over seeds) ==');
for (const [scen, pol] of PLAN) {
  const rs = results.filter(r => r.scenario === scen && r.policy === pol);
  const mean = (fn) => rs.reduce((a, r) => a + fn(r), 0) / rs.length;
  console.log(`${scen}/${pol}: time=${mean(r => r.time).toFixed(0)}s ` +
    `score=${mean(r => r.score).toFixed(0)} era=${mean(r => r.era).toFixed(2)} ` +
    `deaths=${rs.filter(r => r.died).length}/${rs.length} ` +
    `causes=${[...new Set(rs.map(r => r.cause))].join('|')}`);
}  console.log('\n== Passive mass trail (seed 20260915, BASE) ==');
  const pas = results.find(r => r.scenario === 'BASE' && r.policy === 'passive' && r.seed === '20260915');
  for (const s of pas.samples.filter((_, i) => i % 10 === 0)) {
    console.log(`t=${s.t.toFixed(0).padStart(3)}s mass=${s.mass.toFixed(1).padStart(6)} r=${s.r.toFixed(1).padStart(5)} ` +
      `sat=${s.sat.toFixed(1)} drain=${(s.drain * 100).toFixed(1)}%/s ents=${s.ents}`);
  }

  if (errors.length) {
  console.error('\nHarness errors captured:');
  for (const e of errors.slice(0, 8)) console.error('  ' + e);
  process.exit(1);
}
