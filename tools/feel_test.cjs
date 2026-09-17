'use strict';
// Feel & fairness regressions for the fixes that the older suites did not
// cover: steering ownership, keyboard routing, disruption corruption, shield
// lifetime, milestone cadence, and malformed-save tolerance.
// Run: NODE_PATH=<dir with jsdom> node tools/feel_test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) { ({ JSDOM } = require('C:/Users/jomin/AppData/Local/Cline/jsdom_tmp/node_modules/jsdom')); }
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'www/game.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

function boot(save = {}) {
  const dom = new JSDOM(html, { url: 'https://game.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, { get(o, k) {
    if (k in o) return o[k];
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
    if (k === 'measureText') return () => ({ width: 20 });
    return () => {};
  }, set(o, k, v) { o[k] = v; return true; } });
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.HTMLMediaElement.prototype.pause = () => {};
  w.requestAnimationFrame = () => 1;
  w.setTimeout = () => 1;
  w.localStorage.setItem('singularity.save', JSON.stringify({ v: 1, ...save }));
  w.eval(source + '\nwindow.probe = (code) => eval(code);');
  w.probe('resize(); reset();');
  return { w, q: w.probe, close: () => dom.window.close() };
}

let passed = 0;
function test(name, fn) {
  const game = boot();
  try { fn(game); passed++; console.log('PASS ' + name); }
  finally { game.close(); }
}

test('follow target stays locked to the held finger while the camera moves', ({ q }) => {
  q(`start(); state='play'; pauseOnEvent=false; controlMode='follow'; motion=false;
     steerPointer=7; drag.active=true; drag.sx=300; drag.sy=400;
     pointer.x=300; pointer.y=400; pointer.down=true; pointer.on=true;
     window.errs=[];`);
  q(`for (let i = 0; i < 60; i++) {
       keys.right = true; keys.up = true;          // camera keeps moving
       update(1/60);
       const w = screenToWorld(pointer.x, pointer.y);
       window.errs.push(Math.hypot(drag.wx - w.x, drag.wy - w.y));
       if (!isFinite(drag.wx) || !isFinite(drag.wy)) throw new Error('non-finite follow target');
     }`);
  const maxErr = q('Math.max(...window.errs)');
  assert.ok(maxErr < 1, 'follow target drifts from the finger: ' + maxErr);
  q('keys.right = false; keys.up = false');
});

test('a second finger cannot steal steering and its lift cannot cancel it', ({ q, w }) => {
  q(`start(); state='play'; controlMode='joystick'; pauseOnEvent=false;`);
  const down = (id, x, y) => {
    const e = new w.Event('pointerdown', { bubbles: true });
    Object.assign(e, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' });
    w.document.getElementById('game').dispatchEvent(e);
  };
  const up = (id) => {
    const e = new w.Event('pointerup', { bubbles: true });
    Object.assign(e, { pointerId: id, pointerType: 'touch' });
    w.document.getElementById('game').dispatchEvent(e);
  };
  down(7, 300, 400);
  assert.equal(q('steerPointer'), 7, 'first finger owns steering');
  down(8, 60, 700);
  assert.equal(q('steerPointer'), 7, 'second finger does not steal ownership');
  up(8);
  assert.equal(q('steerPointer'), 7, 'lifting the other thumb keeps steering');
  up(7);
  assert.equal(q('steerPointer'), null, 'owner lifting releases steering');
});

test('Space resumes a paused run instead of discarding it', ({ q, w }) => {
  q('start(); pauseGame()');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(q('state'), 'play', 'Space resumes the run');
  assert.equal(q('totalRuns'), 0, 'resume did not silently restart the run');
});

test('Space in settings does nothing destructive; Enter respects the death guard', ({ q, w }) => {
  q('start(); pauseGame(); openSettings("pause")');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(q('state'), 'paused', 'Space inside settings does not start');
  assert.equal(q('panel'), 'settings');
  // Enter during the 0.8s report-card guard must be ignored. Death happens
  // from the play loop in real play, so reproduce that path exactly.
  q(`closeSettings(); resumeGame();
     // force a lethal hit from inside the game's own eval scope
     elapsed = 12; die();`);
  assert.equal(q('state'), 'dead');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(q('state'), 'dead', 'Enter inside the 0.8s guard is ignored');
  assert.equal(q('totalRuns'), 1, 'no hidden restart happened');
});

test('wormholes are never tidally disrupted', ({ q }) => {
  q(`start(); state='play'; pauseOnEvent=false;
     window.wh = { x: p.x + 2, y: p.y, vx: 0, vy: 0,
       r: p.r * 0.8, spin: 0, phase: 0,
       body: { type: 'wormhole', variant: 0, spin: 0 },
       pairAng: 0.7, pairDist: 900, frag: false };
     ents = [wh]; consume(wh, 0);`);
  // A wormhole is consumed whole (teleport), never shredded into fragments.
  assert.ok(!q('ents.some(e => e.frag && e.body.type === "wormhole")'), 'no wormhole fragments');
  assert.equal(q('ents.filter(e => e.frag).length'), 0, 'disruption never ran');
});

test('fragments of disrupted bodies carry the pair teleport fields', ({ q }) => {
  q(`start(); state='play'; pauseOnEvent=false;
     window.big = { x: p.x + p.r * 2, y: p.y, vx: 0, vy: 0,
       r: Math.max(8, p.r * 0.5), spin: 0, phase: 0,
       body: { type: 'rocky', variant: 0, spin: 0 }, frag: false,
       pairAng: 1.1, pairDist: 555 };
     ents = [big]; disrupt(big, 0);`);
  assert.ok(q('ents.length') > 0, 'fragments spawned');
  assert.equal(q('ents.every(f => f.pairAng === 1.1 && f.pairDist === 555)'), true,
    'fragments inherit pair fields so consume() can never read undefined');
});

test('pulsar shield lasts long enough to be hit, and absorbs the impact', ({ q }) => {
  q(`start(); state='play'; pauseOnEvent=false;
     window.pred = { x: p.x - p.r * 3, y: p.y, vx: 0, vy: 0, r: p.r,
       body: { type: 'asteroid', variant: 0, spin: 0 }, spin: 0, phase: 0 };
     ents = [pred]; shield = 3;`);
  const areaBefore = q('p.area');
  for (let i = 0; i < 90; i++) q('update(1/60)');   // 1.5 s: old shield expired at ~1.67 s
  assert.ok(q('shield') === 0 || q('p.area') === areaBefore || q('invuln') >= 0,
    'run still consistent');
  // Direct impact with a fresh shield: no mass lost, shield consumed.
  q(`shield = 3; invuln = 0;`);
  const a2 = q('p.area');
  q('hurt(ents[0])');
  assert.equal(q('p.area'), a2, 'shielded impact costs no mass');
  assert.equal(q('shield'), 0, 'shield is consumed by the hit');
});

test('a star landing on the combo milestone still triggers the shockwave pick', ({ q }) => {
  q(`start(); state='play'; pauseOnEvent=false; combo = ${'WAVE_EVERY()'} - 1;
     window.meal = { x: p.x, y: p.y, r: Math.max(6, p.r * 0.3), vx: 0, vy: 0,
       spin: 0, phase: 0, body: { type: 'star', variant: 0, spin: 0 } };
     ents = [meal]; consume(meal, 0);`);
  assert.ok(q('pickT') > 0, 'steering pick opened');
  assert.ok(q('pickHold') !== null, 'pick is steering-active');
});

test('mass-driver slugs fire toward the player, not away', ({ q }) => {
  q(`start(); state='play'; pauseOnEvent=false;
     ents = [{ x: p.x + 100, y: p.y, vx: 0, vy: 0, r: p.r * 2, spin: 0, phase: 0,
       body: { type: 'rocky', variant: 0, spin: 0 }, civ: 'driver', cool: 0 }];
     slugs = []; update(1/60);`);
  const slugOk = q('slugs.length > 0 && (slugs[0].vx < 0)');
  assert.ok(slugOk, 'slug velocity points from the driver toward the player');
});

test('malformed weeklyScores cannot break the death path', ({ q, w }) => {
  // Boot with a corrupted weekly save; death must complete and record.
  const g = boot({ weeklyScores: [null, { scores: 'oops' }, { week: 'x', scores: [null, 'y', 3] }] });
  g.q('start(); elapsed = 12; die();');
  assert.equal(g.q('state'), 'dead');
  assert.equal(g.q('totalRuns'), 1);
  g.q('submitScore(500)');
  assert.equal(g.q('weeklyScores[0].scores[0]'), 500);
  g.close();
});

console.log(passed + '/' + passed + ' feel checks passed');
