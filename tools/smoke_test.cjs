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

// Match the script tag LOOSELY, and fail loudly if we cannot.
//
// This used to be an exact-string replace on '<script src="game.js"></script>'.
// When a cache-busting query was added (?v=b10) the replace silently matched
// nothing, game.js was never loaded, the entire suite went dead -- and the
// only symptom was a misleading "window.frame is not a function" deep in the
// harness. A test that cannot load the code under test must say so.
const SCRIPT_TAG = /<script\s+src="game\.js[^"]*"><\/script>/;
if (!SCRIPT_TAG.test(html)) {
  console.error('FATAL: no <script src="game.js..."> tag in index.html.');
  console.error('The harness inlines game.js to run it headlessly. Without a');
  console.error('match there is nothing to test -- fix the script tag markup.');
  process.exit(2);
}
// Dev-only probe. game.js is inlined as a plain <script>, so its top-level
// consts and lets are script-scoped and invisible from here. Expose just the
// internals the movement checks need -- same trick the screenshot harness uses.
const PROBE = `
window.__probe = {
  geom: function () {
    return { x: JOY_BASE_X, y: JOY_BASE_Y, r: JOY_R, knob: JOY_KNOB, dead: JOY_DEADZONE };
  },
  speedRef: function () { return SPEED_REF; },
  dragExp: function () { return DRIFT_EXP; },
  radius: function () { return p.r; },
  setRadius: function (v) { p.r = v; p.area = v * v; },
  setVel: function (x, y) { p.vx = x; p.vy = y; },
  vel: function () { return { x: p.vx, y: p.vy }; },
  push: function (x, y) { joy.active = true; joy.dx = x; joy.dy = y; },
  release: function () { joy.active = false; joy.dx = 0; joy.dy = 0; },
  joyState: function () { return { dx: joy.dx, dy: joy.dy, kx: joy.kx, ky: joy.ky }; },
  toPoint: function (x, y) { updateJoyFromPoint(x, y); },
  setControl: function (m) { setControl(m); },
  mode: function () { return controlMode; },
  // The physics checks measure the movement integrator, so they need the eat
  // loop out of the way -- otherwise the hole grows mid-measurement and its
  // top-speed cap moves while we are measuring against it.
  clearEnts: function () { ents.length = 0; },
  // Direction to the nearest edible body, so the growth test can actually
  // play the game rather than flail around and hope.
  seek: function () {
    let best = null, bd = Infinity;
    for (const e of ents) {
      if (e.r > p.r * 0.95) continue;          // same lethality rule as drawEnts
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return null;
    const dx = best.x - p.x, dy = best.y - p.y;
    const m = Math.hypot(dx, dy) || 1;
    return { x: dx / m, y: dy / m, dist: m };
  },
  startAt: function (r, zoom) {
    start();
    p.r = r; p.area = r * r; p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
    cam.x = 0; cam.y = 0; cam.zoom = zoom || 1;
  }
};
`;

const inlined = html.replace(SCRIPT_TAG, '<script>\n' + gameSrc + '\n' + PROBE + '\n</script>');
if (inlined.indexOf('function frame') === -1) {
  console.error('FATAL: game.js was not inlined into the page.');
  process.exit(2);
}

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
// jsdom does not implement media playback at all. The game routes every play()
// through a guard that tolerates the gap, so the resulting "Not implemented"
// jsdomError is an environment limitation, not a game bug -- counting it would
// fail five frame-loop checks for something that works on a real device.
const IGNORED_JSDOM_ERRORS = [
  // Any HTMLMediaElement gap: jsdom implements neither play() nor pause(),
  // and throws its "Not implemented" notice for both.
  'HTMLMediaElement'
];
vc.on('jsdomError', (e) => {
  const msg = String((e && e.message) || e || '');
  if (IGNORED_JSDOM_ERRORS.some((s) => msg.indexOf(s) >= 0)) return;
  errors.push('jsdomError: ' + (e.stack || e.message));
});
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

// The game must expose `frame` as a top-level FUNCTION DECLARATION so it lands
// on window. A `const frame = ...` arrow would not, and the harness would have
// nothing to drive -- which is worth a clear message rather than a TypeError.
if (typeof window.frame !== 'function') {
  console.error('FATAL: window.frame is not a function after boot.');
  console.error('game.js must declare `function frame(now) { ... }` at top level.');
  const seen = errors.slice(0, 6).map((e) => '  ' + e).join('\n');
  if (seen) console.error('Errors captured during boot:\n' + seen);
  process.exit(2);
}

let T = 0;
const step = (frames, dtMs = 16.7) => {
  for (let i = 0; i < frames; i++) { T += dtMs; window.frame(T); }
};

const report = [];
const check = (label, cond, detail) => {
  report.push(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
  return cond;
};

// The first-encounter stop pauses the run to explain a pulsar / wormhole /
// civilisation. It must never be able to wedge the harness, so every phase
// that expects the sim to be running clears it first.
const dismissEvent = () => {
  if (!visible('eventPanel')) return false;
  $('eventOkBtn').click();
  return true;
};

/* ---- 0. new UI surfaces exist before anything is played ---- */
check('menu: control picker rendered',
  $('ctrlPick') && $('ctrlPick').querySelectorAll('button').length === 3);
check('menu: no MOUSE scheme (Android-first)',
  $('ctrlPick') && !$('ctrlPick').querySelector('[data-ctrl="mouse"]'));
check('menu: how-to rows rendered',
  doc.querySelectorAll('#howto .how-row').length === 3);
check('menu: settings reachable without playing', !!$('menuSettingsBtn'));
check('menu: wrapped in a glass card', !!$('menuCard'));
check('menu: how-to rows use inline SVG icons',
  doc.querySelectorAll('#howto .how-ico svg').length === 3,
  doc.querySelectorAll('#howto .how-ico svg').length + ' icons');
check('menu: the old colour dots are gone',
  doc.querySelectorAll('#howto .dot').length === 0);
check('menu: settings demoted to a labelled icon button',
  $('menuSettingsBtn').tagName === 'BUTTON' &&
  $('menuSettingsBtn').getAttribute('aria-label') === 'Settings');
check('menu: control picker exposes its selection for the pill indicator',
  $('ctrlPick').dataset.sel === 'joystick', 'data-sel=' + $('ctrlPick').dataset.sel);
check('menu: primary action is present and last in the card',
  $('menuCard').lastElementChild.classList.contains('menu-foot'));
check('hud: combo bar built with 20 pips',
  $('comboBar').children.length === 20, $('comboBar').children.length + ' pips');

/* ---- 1. boot ---- */
check('boot: menu layer visible', visible('menu'));
check('boot: HUD hidden', !visible('hud'));
check('boot: game-over hidden', !visible('over'));
check('boot: no fatal error surface', !visible('fatal'));

/* ---- 2. idle frames on the menu ---- */
step(60);
check('menu: 60 frames without throwing', errors.length === 0);

/* ---- 3. start a run ---- */
$('playBtn').click();
check('start: menu hidden after TAP TO BEGIN', !visible('menu'));
check('start: HUD visible', visible('hud'));

/* ---- 4. play: the fixed bottom-centre stick ---- */
const cvs = $('game');
const send = (type, x, y) =>
  cvs.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

// Touching the MIDDLE of the screen must still drive the hole. The base is
// fixed at the bottom centre, so a press at mid-screen is a full-throw push
// straight up. (The old floating stick anchored wherever you pressed; a fixed
// zone that ignored mid-screen taps was the bug that made the game feel
// broken, so this stays a deliberate regression guard.)
const midX = Math.round(window.innerWidth / 2);
const midY = Math.round(window.innerHeight * 0.5);
send('pointerdown', midX, midY);
const joyMid = window.__probe.joyState();
check('play: a mid-screen press drives the fixed stick',
  Math.abs(Math.hypot(joyMid.dx, joyMid.dy) - 1) < 0.001 && joyMid.dy < -0.9,
  'dx=' + joyMid.dx.toFixed(2) + ' dy=' + joyMid.dy.toFixed(2));

step(20);
const vMid = window.__probe.vel();
check('play: the hole actually moves under thrust',
  Math.hypot(vMid.x, vMid.y) > 1,
  'speed=' + Math.hypot(vMid.x, vMid.y).toFixed(1));
send('pointerup', midX, midY);

// Now actually play: steer toward the nearest edible body every frame. This is
// the real playability regression test -- if inertial movement made food
// unreachable, this is where it would show up as a hole that never grows.
for (let i = 0; i < 40; i++) {
  for (let f = 0; f < 30; f++) {
    const t = window.__probe.seek();
    if (t) window.__probe.push(t.x, t.y); else window.__probe.release();
    step(1);                      // 30 frames = ~0.5 s per leg => ~20 s total
  }
}
window.__probe.release();

const scoreAfterPlay = num('hudScore');
const died = visible('over');
check('play: ~20s of frames without throwing', errors.length === 0);
check('play: score increased', scoreAfterPlay > 0, 'mass=' + scoreAfterPlay);
check('play: the hole grows by eating under inertial control',
  scoreAfterPlay > 22 * 1.35,
  'grew 22 -> ' + scoreAfterPlay);

/* ---- 4b. pause / settings / back / home (only valid if still alive) ---- */
dismissEvent();
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

  // Cycle the accessibility and control options, then confirm the game
  // still runs -- a mode switch that leaves stale input state would throw.
  // Since b17 a settings row is a label plus a value slot, so the assertions
  // read the slot rather than matching a "LABEL: VALUE" string.
  $('cbBtn').click();
  check('settings: colour mode cycles',
    /Deuteranopia|Protanopia|Tritanopia|Normal/.test($('cbBtn').querySelector('.setting-val').textContent),
    $('cbBtn').querySelector('.setting-val').textContent);
  $('ctrlBtn').click();
  check('settings: control mode cycles',
    /Stick|Follow|Drag/.test($('ctrlBtn').querySelector('.setting-val').textContent),
    $('ctrlBtn').querySelector('.setting-val').textContent);

  $('settingsBackBtn').click();
  check('settings: BACK returns to pause',
    visible('pause') && !visible('settings'));

  // New accessibility + audio options must round-trip through Settings.
  $('textBtn').click();
  check('settings: text size toggles',
    $('textBtn').querySelector('.setting-val').textContent === 'Large',
    $('textBtn').querySelector('.setting-val').textContent);
  $('contrastBtn').click();
  check('settings: contrast toggles',
    $('contrastBtn').querySelector('.setting-val').textContent === 'On',
    $('contrastBtn').querySelector('.setting-val').textContent);
  $('hapticBtn').click();
  check('settings: haptics cycle',
    $('hapticBtn').querySelector('.setting-val').textContent === 'Low',
    $('hapticBtn').querySelector('.setting-val').textContent);
  check('settings: music + sfx sliders exist', !!$('musicRange') && !!$('sfxRange'));
  $('textBtn').click();
  $('contrastBtn').click();

  $('resumeBtn').click();
  check('resume: pause panel hidden', !visible('pause'));
  step(60);
  check('resume: frames run again without throwing', errors.length === 0);

  // Civilisation defences normally need mass 900 to trigger, which a 20s
  // test never reaches. Force them so the shield / repulsor / driver /
  // ark / extractor paths and the mass-driver slugs actually execute.
  if (typeof window.spawnCiv === 'function') {
    for (let k = 0; k < 5; k++) window.spawnCiv();
    step(300);
    check('civ: installations and slugs run without throwing',
      errors.length === 0);
  }

  // The first-encounter stop is new; prove it opens, then that it lets go.
  if (visible('eventPanel')) {
    check('event: first-encounter panel opened', true,
      $('eventTitle').textContent);
    $('eventOkBtn').click();
    check('event: CONTINUE returns to play', !visible('eventPanel'));
    step(60);
    check('event: run continues after the explainer', errors.length === 0);
  }
}

send('pointerup', 512, 384);

/* ---- 5. if it survived, keep going until it dies (bounded) ---- */
// Standing still is not free. Entities spawn ~15-23 player-radii out but the
// gravity well only reaches 7, so nothing drifts to you: an idle hole slowly
// bleeds mass and eventually collapses on decay alone. That takes ~13 min of
// simulated time, hence the large guard.
if (!died) {
  let guard = 0;
  while (!visible('over') && guard < 120000) {
    if ((guard & 63) === 0) dismissEvent();   // an explainer would freeze the sim
    step(1); guard++;
  }
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
check('death: run report card filled in',
  $('report').children.length >= 2, $('report').textContent.trim().slice(0, 48));
check('death: near-miss line present',
  /best/i.test($('overGap').textContent), $('overGap').textContent);

/* ---- 6. restart ---- */
// The game-over screen holds input for ~0.8s so one stray tap cannot wipe the
// score you are still reading. Prove the guard exists, then wait it out.
$('againBtn').click();
check('game-over: input guard blocks an instant restart', visible('over'));
step(70);                                   // 70 x 16.7ms > 0.8s
$('againBtn').click();
check('restart: HUD visible again', visible('hud'));
check('restart: game-over hidden', !visible('over'));
step(120);
check('restart: 120 frames without throwing', errors.length === 0);

/* ---- 7. HOME from pause -> main menu, and the best score survives ---- */
dismissEvent();
$('pauseBtn').click();
check('pause: works on a restarted run', visible('pause'));
$('homeBtn').click();
check('home: back at main menu', visible('menu'));
check('home: HUD hidden', !visible('hud'));
check('home: best score shown on menu', /BEST/.test($('menuBest').textContent),
  'menuBest="' + $('menuBest').textContent + '"');
check('home: best-history strip has entries',
  $('histStrip').children.length >= 1, $('histStrip').children.length + ' runs');

/* ---- 8. SETTINGS from the menu, and BACK returns to the menu ---- */
$('menuSettingsBtn').click();
check('menu settings: opens before any run', visible('settings') && !visible('menu'));
$('settingsBackBtn').click();
check('menu settings: BACK returns to the menu',
  visible('menu') && !visible('settings'));

/* ---- 9. movement: the bottom-centre stick and the inertial physics ---- */
// Section 5 left the control mode cycled to FOLLOW, so put it back before
// testing the stick -- otherwise the stick is not the active input at all.
const probe = window.__probe;
probe.setControl('joystick');
check('stick: joystick is the active scheme', probe.mode() === 'joystick', probe.mode());
// The sliding pill is driven by a data attribute, not :has(), so it must be
// kept in sync by syncControlPick() -- including after a mode change.
check('menu: pill indicator tracks the control mode',
  $('ctrlPick').dataset.sel === probe.mode(),
  'data-sel=' + $('ctrlPick').dataset.sel + ' mode=' + probe.mode());

const geom = probe.geom();
check('stick: base is horizontally centred',
  Math.abs(geom.x - window.innerWidth / 2) < 1.5,
  'x=' + geom.x.toFixed(1) + ' vs centre ' + (window.innerWidth / 2));
check('stick: base sits low on the screen',
  geom.y > window.innerHeight * 0.6 && geom.y < window.innerHeight,
  'y=' + geom.y.toFixed(1) + ' of ' + window.innerHeight);
check('stick: radius adapts to the viewport',
  geom.r >= 40 && geom.r <= 74, 'r=' + geom.r.toFixed(1));
check('stick: knob is a fixed fraction of the base',
  Math.abs(geom.knob / geom.r - 0.36) < 0.01, 'knob=' + geom.knob.toFixed(1));

// Deadzone. A resting thumb drifts a few pixels; that must produce nothing at
// all, and crossing the threshold must ramp from zero rather than jump.
probe.toPoint(geom.x + geom.r * geom.dead * 0.5, geom.y);
const inDead = probe.joyState();
check('stick: inside the deadzone produces no thrust',
  inDead.dx === 0 && inDead.dy === 0, 'dx=' + inDead.dx);

probe.toPoint(geom.x + geom.r, geom.y);
const full = probe.joyState();
check('stick: full deflection produces full thrust',
  Math.abs(Math.hypot(full.dx, full.dy) - 1) < 0.001,
  'mag=' + Math.hypot(full.dx, full.dy).toFixed(3));

probe.toPoint(geom.x + geom.r * 4, geom.y);
const beyond = probe.joyState();
check('stick: throw beyond the ring is clamped',
  Math.abs(Math.hypot(beyond.dx, beyond.dy) - 1) < 0.001);

// Mass-dependent inertia. Identical thrust for identical time, different size:
// the small hole must convert it into a larger share of its own top speed.
const speedOf = () => {
  const v = probe.vel();
  return Math.hypot(v.x, v.y);
};
const rampUp = (radius, frames) => {
  probe.startAt(radius, 1);
  probe.clearEnts();
  probe.push(1, 0);
  for (let i = 0; i < frames; i++) {
    probe.clearEnts();                 // isolate the integrator from eating
    T += 16.7; window.frame(T);
  }
  const frac = speedOf() / (probe.speedRef() * probe.radius());
  probe.release();
  return frac;
};
// Radii must stay clear of DEATH_AREA (P0^2 * 0.30), or the hole dies on the
// first frame and "does not accelerate" for a completely unrelated reason.
const smallFrac = rampUp(22 * 0.75, 24);
const largeFrac = rampUp(22 * 4.0, 24);
check('physics: a small hole accelerates faster than a large one',
  smallFrac > largeFrac * 1.3,
  'small=' + smallFrac.toFixed(3) + ' large=' + largeFrac.toFixed(3));

// Inertia. Let go and the hole must keep drifting -- the old model stopped it
// within a frame, which is exactly what made it feel like a cursor.
probe.startAt(22, 1);
probe.clearEnts();
probe.push(1, 0);
for (let i = 0; i < 40; i++) { probe.clearEnts(); T += 16.7; window.frame(T); }
const coastBefore = speedOf();
probe.release();
for (let i = 0; i < 12; i++) { probe.clearEnts(); T += 16.7; window.frame(T); }
const coastAfter = speedOf();
check('physics: the hole coasts instead of stopping dead',
  coastAfter > coastBefore * 0.5,
  'before=' + coastBefore.toFixed(1) + ' after=' + coastAfter.toFixed(1));

// Top speed must still be SPEED_REF * r, or the game's reachability breaks.
probe.startAt(22, 1);
probe.clearEnts();
probe.push(1, 0);
for (let i = 0; i < 260; i++) { probe.clearEnts(); T += 16.7; window.frame(T); }
const terminal = speedOf() / (probe.speedRef() * probe.radius());
probe.release();
check('physics: top speed still equals SPEED_REF * r',
  terminal > 0.85 && terminal < 1.05,
  'terminal=' + (terminal * 100).toFixed(1) + '% of cap');

/* ---- output ---- */
console.log('\n' + report.join('\n'));
if (errors.length) {
  console.log('\n--- runtime errors ---');
  errors.slice(0, 10).forEach((e) => console.log(e));
}
const failed = report.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${report.length - failed}/${report.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
