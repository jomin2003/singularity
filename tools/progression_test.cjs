'use strict';
// Dev-only: uses installed jsdom, never adds a production dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) { ({ JSDOM } = require('C:/Users/jomin/AppData/Local/Cline/jsdom_tmp/node_modules/jsdom')); }
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'www/game.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
function boot(save = {}) {
  const dom = new JSDOM(html, { url: 'https://game.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, { get(o, k) {
    if (k in o) return o[k];
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
    if (k === 'measureText') return () => ({ width: 20 });
    if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(256 * 256 * 4) });
    return () => {};
  }, set(o,k,v) { o[k] = v; return true; } });
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.HTMLMediaElement.prototype.pause = () => {};
  w.requestAnimationFrame = () => 1;
  w.setTimeout = () => 1;
  w.localStorage.setItem('singularity.save', JSON.stringify({ v: 1, ...save }));
  w.eval(source + '\nwindow.probe = (code) => eval(code);');
  assert.equal(typeof w.probe, 'function', 'game booted');
  // Boot initialization is scheduled on load in the real page.
  w.probe('resize(); reset();');
  return { w, q: w.probe, close: () => dom.window.close() };
}
let passed = 0;
function test(name, fn) {
  const game = boot();
  try { fn(game); passed++; console.log('PASS ' + name); }
  finally { game.close(); }
}
test('boot and start', ({q}) => { q('start()'); assert.equal(q('state'), 'play'); });
test('fixed-seed reset and 120 simulation ticks reproduce exactly', ({q}) => {
  q(`window.sampleRun = () => {
    seedOverride = 12345; reset(); state = 'play'; pauseOnEvent = false;
    for (let i = 0; i < 120; i++) update(1 / 60);
    return JSON.stringify({ radius: p.r, score, rngState,
      bodies: ents.map(e => [e.x, e.y, e.r, e.body.type]) });
  }`);
  const first = q('sampleRun()');
  assert.equal(q('sampleRun()'), first);
  assert.ok(JSON.parse(first).radius > 12);
});
test('a meal crossing score 100 awards one stardust, not zero', ({q}) => {
  q(`start(); score = 95; stardust = 0;
    window.meal = { x: 0, y: 0, r: 20, body: { type: 'rocky' } };
    ents = [meal]; consume(meal, 0);`);
  assert.equal(q('score'), 104);
  assert.equal(q('stardust'), 1);
  q('consume(meal, 0)');
  assert.equal(q('stardust'), 1, 'stale entity cannot pay twice');
});
test('daily claims continue past 28 and block same local date', ({q}) => {
  q(`dailyRewards = Array.from({length:28}, (_,i)=>i); dailyStreak=28;
     dailyLastClaim=''; stardust=0; claimDailyReward();`);
  assert.equal(q('dailyStreak'), 29);
  assert.equal(q('stardust'), 6);
  q('claimDailyReward()');
  assert.equal(q('stardust'), 6);
});
test('death is idempotent and menu/paused time cannot earn achievements', ({q}) => {
  q('start(); elapsed=12; die(); die();');
  assert.equal(q('totalRuns'), 1);
  assert.equal(q('totalPlayTime'), 12);
  q("state='menu'; elapsed=200; score=10000; era=5; update(1/60)");
  assert.equal(q('!!achievements.survive180'), false);
  assert.equal(q('!!skins.quasar'), false);
  q("state='paused'; update(200); die()");
  assert.equal(q('totalRuns'), 1);
});
test('reset and pause discard pending waves, drag, joystick and keys', ({q,w}) => {
  q('start(); pendingWave=0.2; drag.active=true; joy.active=true; joy.dx=1; keys.right=true; reset()');
  assert.equal(q('pendingWave'), 0);
  assert.equal(q('drag.active || joy.active || keys.right'), false);
  q('joy.active=true; joy.dx=1; drag.active=true; keys.right=true; pauseGame(); resumeGame()');
  assert.equal(q('drag.active || joy.active || keys.right'), false);
  q('pauseGame()');
  const e = new w.Event('pointerdown'); Object.assign(e, {clientX:200,clientY:300,pointerId:1});
  w.document.getElementById('game').dispatchEvent(e);
  assert.equal(q('joy.active || drag.active'), false);
});
test('rare window freezes when paused, spawns on simulation time, resets', ({q}) => {
  q('start(); rareWindowActive=true; rareWindowT=20; rareSpawnT=5; ents=[]; pauseGame(); updateRareWindow(8)');
  assert.equal(q('rareSpawnT'), 5);
  q('resumeGame(); updateRareWindow(5)');
  assert.equal(q('ents.length'), 1);
  assert.equal(q('ents[0].body.type'), 'pulsar');
  q('reset()');
  assert.equal(q('rareWindowActive'), false);
  assert.equal(q('rareSpawnT'), 0);
});
test('upgrades apply modest actual effects on next ordinary run only', ({q}) => {
  q('upgrades={gravity:5,accretion:5,horizon:5,singularity:5}; start()');
  assert.ok(Math.abs(q('p.r') - 24.2) < 1e-8);
  assert.ok(Math.abs(q('COMBO_WINDOW_V()/VARMODS[variant].comboWin') - 1.25) < 1e-8);
  q("hurt({x:100,y:0,vx:0,vy:0,body:{type:'rocky'}})");
  assert.ok(Math.abs(q('p.mass') - 11 * 0.8) < 1e-8);
  q("start(); ents=[]; pauseOnEvent=false; update(0.01)");
  assert.ok(Math.abs(q('drainRate') - q('HAWKING_BASE * Math.pow(P0 / 24.2, 3) * 0.85')) < 1e-8);
  q('seedOverride=123; start()');
  assert.equal(q('p.r'), 22, 'seeded challenges stay unupgraded');
});
test('render and cosmetic effects leave seeded RNG untouched', ({q}) => {
  q('start(); seedRng(123); shakeMag=10');
  const before = q('rngState');
  q('render(); burstFx(0,0,10); absorbFx({x:0,y:0,r:5}); shotT=0; updateShots(0.1); resize()');
  assert.equal(q('rngState'), before);
});
test('score settlements cover multi-hundred gains and quitting without duplicate rewards', ({q}) => {
  q('start(); stardust=0; score=350; update(0); update(0)');
  assert.equal(q('stardust'), 3);
  q('score=510; toMenu()');
  assert.equal(q('stardust'), 5);
  q('start(); score=100; update(0)');
  assert.equal(q('stardust'), 6);
});
test('local-date claims survive reload, cross months and repeat 28-day cycles', ({q,w}) => {
  q(`window.RealDate=Date; window.claimClock=new RealDate(2026,0,31,23,59).getTime();
    window.Date=class extends RealDate { constructor(...a) { super(...(a.length?a:[claimClock])); } };`);
  assert.equal(q('localDateKey()'), '2026-01-31');
  q('claimDailyReward()');
  const saved = JSON.parse(w.localStorage.getItem('singularity.save'));
  const reloaded = boot(saved);
  try {
    reloaded.q(`window.RealDate=Date; window.Date=class extends RealDate {
      constructor(...a) { super(...(a.length?a:[2026,0,31,23,59])); }
    }; claimDailyReward()`);
    assert.equal(reloaded.q('dailyStreak'), 1);
  } finally { reloaded.close(); }
  q('claimClock=new RealDate(2026,1,1,0,1).getTime(); claimDailyReward()');
  assert.equal(q('dailyStreak'), 2);
  q(`for(let i=2;i<58;i++) { claimClock=new RealDate(2026,0,31+i,12).getTime(); claimDailyReward(); }`);
  assert.equal(q('dailyStreak'), 58);
  assert.equal(q('dailyRewards.length'), 28);
  assert.equal(q('!!achievements.daily28'), true);
});
test('newly unlocked accents equip, persist and render without affecting physics', ({q,w}) => {
  q('openObservatory(); unlockSkin("nebula"); renderObservatory()');
  assert.ok(w.document.getElementById('skinPicker'));
  assert.equal(q('equipSkin("quasar")'), false);
  assert.equal(q('equipSkin("nebula")'), true);
  assert.equal(JSON.parse(w.localStorage.getItem('singularity.save')).activeSkin, 'nebula');
  q('start(); seedRng(99); drawPlayer()');
  assert.equal(q('rngState'), 99);
  w.document.getElementById('dailyRewardBtn').click();
  assert.equal(q('panel'), 'dailyreward');
});
test('fresh death blocks an immediate retry, then permits retry after 0.8 seconds', ({q,w}) => {
  q('start(); die()');
  w.document.getElementById('againBtn').click();
  assert.equal(q('state'), 'dead');
  q('update(0.81)');
  w.document.getElementById('againBtn').click();
  assert.equal(q('state'), 'play');
});
test('a panel opened outside play closes back to that state, not to play', ({q}) => {
  // The realistic shape of this: update() keeps running after death, so a
  // surprise can land on the fatal frame. Closing must not resume the run --
  // its score is already committed and its report is on screen.
  q('start(); die()');
  assert.equal(q('state'), 'dead');
  q('openEventPanel("civ")');
  assert.equal(q('state'), 'paused');
  q('closeEventPanel()');
  assert.equal(q('state'), 'dead');
  // ...and closing a panel opened during play still resumes play.
  q('start(); openEventPanel("civ"); closeEventPanel()');
  assert.equal(q('state'), 'play');
});
test('a finale on the fatal frame cannot open over the run report', ({q, w}) => {
  q('start(); score = 1200 * (ERAS.length - 1); die(); update(0.016)');
  assert.equal(q('state'), 'dead');
  assert.equal(q('panel'), null);
  assert.equal(w.document.getElementById('eventPanel').classList.contains('hidden'), true);
  assert.equal(w.document.getElementById('over').classList.contains('hidden'), false);
});
test('a zero-score run is not charted in the footer history', ({q}) => {
  q('start(); score = 0; die()');
  assert.equal(q('history.length'), 0, 'a 0 run writes no bar');
  q('start(); score = 250; die()');
  assert.equal(q('history.length'), 1);
});
console.log(`${passed} progression checks passed`);
