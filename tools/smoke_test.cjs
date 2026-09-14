/**
 * Headless smoke test for SINGULARITY.
 *
 * Boots www/index.html in jsdom with a stubbed 2D canvas and a stubbed
 * WebAudio, then drives the real frame loop by hand so we can prove the
 * boot path, the update loop and the render loop all execute without
 * throwing -- something we cannot do in a real browser from here.
 *
 * Dev-only. jsdom is NOT a project dependency; run with it on NODE_PATH:
 *
 *   NODE_PATH="<dir containing node_modules>" node tools/smoke_test.cjs
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
const gameSrc = fs.readFileSync(path.join(WWW, 'game.js'), 'utf8');
const inlined = html.replace(
  '<script src="game.js"></script>',
  '<script>\n' + gameSrc + '\n</script>'
);

/* ------------------------------------------------------------------ *
 * Canvas 2D stub. We only care that calls resolve, not that they draw.
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
    // style defaults
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt',
    lineJoin: 'miter', miterLimit: 10, shadowBlur: 0, shadowColor: 'transparent',
    imageSmoothingEnabled: true, filter: 'none',

    createRadialGradient: grad,
    createLinearGradient: grad,
    createConicGradient: grad,
    createPattern: () => ({}),
    measureText: (t) => ({ width: String(t).length * 6 }),
    getLineDash: () => [],
    isPointInPath: () => false,
    getImageData: (x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)),
    }),
    createImageData: (w, h) => ({
      data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)),
    }),
  };
  for (const m of METHODS) if (!(m in ctx)) ctx[m] = () => {};
  return ctx;
}

/* ------------------------------------------------------------------ *
 * WebAudio stub.
 * ------------------------------------------------------------------ */
function AudioContextStub() {
  const param = () => ({
    value: 0,
    setValueAtTime() {}, linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {}, setTargetAtTime() {},
    cancelScheduledValues() {},
  });
  const node = (extra) => Object.assign({ connect() { return this; }, disconnect() {} }, extra);
  return {
    currentTime: 0,
    sampleRate: 44100,
    state: 'running',
    destination: node({}),
    resume() { this.state = 'running'; },
    createGain: () => node({ gain: param() }),
    createOscillator: () => node({
      type: 'sine', frequency: param(), detune: param(),
      start() {}, stop() {},
    }),
    createBiquadFilter: () => node({
      type: 'lowpass', frequency: param(), Q: param(), gain: param(),
    }),
    createBuffer: (ch, len) => ({
      length: len, numberOfChannels: ch, sampleRate: 44100,
      getChannelData: () => new Float32Array(len),
    }),
    createBufferSource: () => node({ buffer: null, playbackRate: param(), start() {}, stop() {} }),
  };
}

/* ------------------------------------------------------------------ */
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

const dom = new JSDOM(inlined, {
  runScripts: 'dangerously',
  // Set SMOKE_URL to a file:// URL to exercise the double-click-to-open path,
  // where localStorage and service workers are unavailable.
  url: process.env.SMOKE_URL || 'http://localhost/',
  virtualConsole: vc,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function (type) {
      if (type !== '2d') return null;
      if (!this.__ctx) this.__ctx = makeCtx(this);
      return this.__ctx;
    };
    window.AudioContext = AudioContextStub;
    // We drive frames manually so timing is deterministic.
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    window.addEventListener('error', (e) => {
      errors.push('error event: ' + ((e.error && e.error.stack) || e.message));
    });
  },
});

const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const visible = (id) => !$(id).classList.contains('hidden');
const num = (id) => parseInt(String($(id).textContent).replace(/,/g, ''), 10) || 0;

let T = 0;
const step = (frames, dtMs = 16.7) => {
  for (let i = 0; i < frames; i++) { T += dtMs; window.frame(T); }
};

const report = [];
const check = (label, cond, detail) => {
  report.push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
  return cond;
};

/* ---- 1. boot ---- */
check('boot: menu layer visible', visible('menu'));
check('boot: HUD hidden', !visible('hud'));
check('boot: game-over hidden', !visible('over'));

/* ---- 2. idle frames on the menu ---- */
step(60);
check('menu: 60 frames without throwing', errors.length === 0);

/* ---- 3. start a run ---- */
$('playBtn').click();
check('start: menu hidden after TAP TO BEGIN', !visible('menu'));
check('start: HUD visible', visible('hud'));

/* ---- 4. play with the pointer held down, drifting around ---- */
const cvs = $('game');
const send = (type, x, y) =>
  cvs.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

send('pointerdown', 512, 384);
for (let i = 0; i < 40; i++) {
  send('pointermove', 512 + Math.round(Math.cos(i / 4) * 240), 384 + Math.round(Math.sin(i / 4) * 180));
  step(30);                       // ~0.5 s per leg => ~20 s total
}
const scoreAfterPlay = num('hudScore');
const died = visible('over');
check('play: ~20s of frames without throwing', errors.length === 0);
check('play: score increased', scoreAfterPlay > 0, 'mass=' + scoreAfterPlay);

/* ---- 4b. pause / settings / back / home (only valid if still alive) ---- */
if (!died) {
  const before = num('hudScore');
  $('pauseBtn').click();
  check('pause: PAUSED panel shown', visible('pause'));
  step(120);
  check('pause: simulation actually frozen', num('hudScore') === before,
    'mass=' + num('hudScore') + ' (was ' + before + ')');

  $('settingsBtn').click();
  check('settings: panel shown, pause hidden',
    visible('settings') && !visible('pause'));

  $('settingsBackBtn').click();
  check('settings: BACK returns to pause',
    visible('pause') && !visible('settings'));

  $('resumeBtn').click();
  check('resume: pause panel hidden', !visible('pause'));
  step(60);
  check('resume: frames run again without throwing', errors.length === 0);
}

send('pointerup', 512, 384);

/* ---- 5. if it survived, keep going until it dies (bounded) ---- */
// Standing still is not free. Entities spawn ~15-23 player-radii out but the
// gravity well only reaches 7, so nothing drifts to you: an idle hole slowly
// bleeds mass and eventually collapses on decay alone. That takes ~13 min of
// simulated time, hence the large guard.
if (!died) {
  let guard = 0;
  while (!visible('over') && guard < 120000) { step(1); guard++; }
  if (visible('over')) {
    report.push(`      (collapsed after ~${(guard / 60).toFixed(0)}s of idling)`);
  } else {
    // Rivals tow a passive player around the field, so decay alone is not
    // guaranteed to finish a run in bounded time. Force it so the death ->
    // game-over -> restart path stays covered either way.
    report.push('      (idle did not collapse in 2000s - forcing die() to cover the path)');
    window.die();
    step(2);
  }
}
check('death: COLLAPSE screen shown', visible('over'));
check('death: final score carried into game-over', num('finalScore') > 0,
  'final=' + $('finalScore').textContent);

/* ---- 6. restart ---- */
$('againBtn').click();
check('restart: HUD visible again', visible('hud'));
check('restart: game-over hidden', !visible('over'));
step(120);
check('restart: 120 frames without throwing', errors.length === 0);

/* ---- 7. HOME from pause -> main menu, and the best score survives ---- */
$('pauseBtn').click();
check('pause: works on a restarted run', visible('pause'));
$('homeBtn').click();
check('home: back at main menu', visible('menu'));
check('home: HUD hidden', !visible('hud'));
check('home: best score shown on menu', /BEST/.test($('menuBest').textContent),
  'menuBest="' + $('menuBest').textContent + '"');

/* ---- output ---- */
console.log('\n' + report.join('\n'));
if (errors.length) {
  console.log('\n--- runtime errors ---');
  errors.slice(0, 10).forEach((e) => console.log(e));
}
const failed = report.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${report.length - failed}/${report.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
