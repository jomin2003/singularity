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
  q(`start(); state='play'; controlMode='follow'; motion=false;
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
  q(`start(); state='play'; controlMode='joystick';`);
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

test('wormholes and civilisation bodies are fully removed', ({ q }) => {
  for (const name of ['drawWormhole','spawnCiv','pickCivType','updateSlugs','drawSlugs',
                      'drawShield','drawRepulsor','drawDriver','drawArk','drawExtractor',
                      'civT','nextCivIn'])
    assert.equal(q('typeof '+name), 'undefined', name + ' removed');
  assert.equal(q("RARE.join(',')"), 'pulsar', 'RARE pool is pulsar-only');
  assert.equal(q("RARE.length"), 1);
});

test('spawning never produces wormhole or civilisation bodies', ({ q }) => {
  q(`start(); state='play'; window.bad = 0;
     for (let i = 0; i < 300; i++) {
       window.e = { x: 0, y: 0, vx: 0, vy: 0, r: p.r * 0.3, spin: 0, phase: 0 };
       assignBody(e);
       if (['wormhole','shield','repulsor','driver','ark','extractor'].includes(e.body.type)) bad++;
       if (e.civ) bad++;
     }`);
  assert.equal(q('bad'), 0, 'no wormhole/civ bodies in 300 spawns');
});

test('fragments of disrupted bodies carry the pair teleport fields', ({ q }) => {
  q(`start(); state='play';
     window.big = { x: p.x + p.r * 2, y: p.y, vx: 0, vy: 0,
       r: Math.max(8, p.r * 0.5), spin: 0, phase: 0,
       body: { type: 'rocky', variant: 0, spin: 0 }, frag: false,
       pairAng: 1.1, pairDist: 555 };
     ents = [big]; disrupt(big, 0);`);
  assert.ok(q('ents.length') > 0, 'fragments spawned');
  assert.equal(q('ents.every(f => f.pairAng === 1.1 && f.pairDist === 555)'), true,
    'fragments inherit pair fields so consume() can never read undefined');
});

test('pulsar shield lifetime, impact absorption and pause behaviour', ({ q }) => {
  q(`start(); state='play';
     window.pred = { x: p.x - p.r * 3, y: p.y, vx: 0, vy: 0, r: p.r,
       body: { type: 'asteroid', variant: 0, spin: 0 }, spin: 0, phase: 0 };
     ents = [pred]; shield = 3; invuln = 0;`);
  
  // Shield decays at 0.6 per simulation second. shield=3 lasts exactly 5.0 seconds.
  q(`state='paused'`);
  q('update(1/60)');
  assert.equal(q('shield'), 3, 'paused simulation does not consume shield');
  
  q(`state='play'`);
  for (let i = 0; i < 4.9 * 60; i++) q('update(1/60)');
  assert.ok(q('shield') > 0, 'shield remains active just before expiry');
  
  const m1 = q('p.mass');
  q('hurt(ents[0])');
  assert.equal(q('p.mass'), m1, 'protected impact costs no mass');
  assert.equal(q('shield'), 0, 'shield is completely consumed by a protected hit');
  
  q(`shield = 3; invuln = 0;`);
  for (let i = 0; i < 5.1 * 60; i++) q('update(1/60)');
  assert.equal(q('shield'), 0, 'shield naturally expires exactly after intended duration');
  
  const m2 = q('p.mass');
  q('hurt(ents[0])');
  assert.ok(q('p.mass') < m2, 'hit after shield expiry causes mass loss');
});

test('a star landing on the combo milestone fires the AGN feedback directly', ({ q }) => {
  q(`start(); state='play'; combo = WAVE_EVERY() - 1;
     window.meal = { x: p.x, y: p.y, r: Math.max(6, p.r * 0.3), vx: 0, vy: 0,
       spin: 0, phase: 0, body: { type: 'star', variant: 0, spin: 0 } };
     ents = [meal]; comboPopT = 0; waves = []; consume(meal, 0);`);
  assert.ok(q('waves.length') > 0, 'pulse() fired directly, no pick');
  assert.equal(q("typeof pickT"), 'undefined', 'no pick state');
  assert.ok(q('comboPopT') > 0, 'combo pop visual still fires');
});

test('mass-driver slug subsystem is fully removed', ({ q }) => {
  q(`start(); state='play'; update(1/60);`);
  assert.equal(q("typeof updateSlugs"), 'undefined');
  assert.equal(q("typeof drawSlugs"), 'undefined');
});

test('black hole grows very slowly per eat', ({ q }) => {
  assert.ok(q('CONSUME_YIELD') <= 0.1, 'CONSUME_YIELD <= 0.1, got ' + q('CONSUME_YIELD'));
  q(`start(); state='play';
     window.meal = { x: p.x, y: p.y, r: P0 / 2, vx: 0, vy: 0, spin: 0, phase: 0,
       body: { type: 'rocky', variant: 0, spin: 0 }, mass: 2.5 };
     window.m0 = p.mass; ents = [meal]; consume(meal, 0);`);
  const growth = q('p.mass - m0');
  assert.ok(growth > 0 && growth <= 2.5 * 0.1 + 1e-9, 'per-eat growth is tiny, got ' + growth);
});

test('entities are drawn as plain discs with no squash or stretch', ({ q }) => {
  q(`start(); state='play';
     window.e = { x: p.x + p.r * 2, y: p.y, vx: 0, vy: 0, r: p.r * 0.5,
       spin: 0, phase: 0.7, body: { type: 'rocky', variant: 0, spin: 0 } };
     ents = [e];`);
  // drawEnts must not apply any non-uniform scale to the entity sprite.
  const src = q('drawEnts.toString()');
  assert.ok(!/ctx\.scale\(sx/.test(src), 'no tidal scale transform in drawEnts');
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

test('dwarf density and immediate feeding keep mass finite', ({ q }) => {
  q('start();');
  for (const [type, density] of [['rocky', 1], ['whiteDwarf', 4], ['brownDwarf', 2]]) {
    const before = q('p.mass');
    q(`window.meal={x:p.x,y:p.y,r:P0/2,vx:0,vy:0,spin:0,phase:0,
      body:{type:'${type}',variant:0,spin:0}}; ents=[meal]; consume(meal,0);`);
    assert.ok(Number.isFinite(q('p.mass')));
    assert.ok(Math.abs(q('p.mass') - before - 2.5 * density * q('CONSUME_YIELD')) < 1e-10);
    assert.equal(q('p.r'), q('p.mass * RS_PER_MASS'));
  }
});

test('extended feeding across 50 meals keeps mass finite and bounded', ({ q }) => {
  q('start();');
  for (let i = 0; i < 50; i++) {
    const type = (i % 3 === 0) ? 'whiteDwarf' : 'rocky';
    q(`window.meal={x:p.x,y:p.y,r:p.r * 0.45,vx:0,vy:0,spin:0,phase:0,
      body:{type:'${type}',variant:0,spin:0}}; ents=[meal]; consume(meal,0);`);
  }
  const finalMass = q('p.mass');
  const finalR = q('p.r');
  const finalScore = q('score');
  assert.ok(Number.isFinite(finalMass) && finalMass > 0 && finalMass < 1e7, 'mass should be finite: ' + finalMass);
  assert.ok(Number.isFinite(finalR) && finalR > 0 && finalR < 1e8, 'radius should be finite: ' + finalR);
  assert.ok(Number.isFinite(finalScore) && finalScore > 0 && finalScore < 1e12, 'score should be finite: ' + finalScore);
});

console.log(passed + '/' + passed + ' feel checks passed');
