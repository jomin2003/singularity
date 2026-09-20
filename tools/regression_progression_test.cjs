'use strict';
// Focused persistence tests: real progression source with stubbed gameplay.
// --integration additionally runs the same cases against the whole game in
// installed jsdom (same convention as progression_test.cjs; no new dependency).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../www/game.js'), 'utf8');
const integration = process.argv.includes('--integration');
const marker = '/* ---------- Stardust + Upgrades ---------- */';
assert.ok(source.includes(marker), 'progression boundary exists');
function boot(data = {}, date = [2026, 0, 3, 12]) {
  let q, close = () => {};
  if (integration) {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); }
    catch (_) { ({ JSDOM } = require('C:/Users/jomin/AppData/Local/Cline/jsdom_tmp/node_modules/jsdom')); }
    const html = fs.readFileSync(path.resolve(__dirname, '../www/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const dom = new JSDOM(html, {url: 'https://game.test/', runScripts: 'outside-only', pretendToBeVisual: true});
    const w = dom.window;
    const context = new Proxy({}, { get(o,k) {
      if (k in o) return o[k];
      if (k === 'measureText') return () => ({width: 20});
      if (k === 'getImageData') return () => ({data: new Uint8ClampedArray(256*256*4)});
      if (/^create.*Gradient$/.test(k)) return () => ({addColorStop() {}});
      return () => {};
    }, set(o,k,v) { o[k] = v; return true; } });
    w.HTMLCanvasElement.prototype.getContext = () => context;
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.HTMLMediaElement.prototype.pause = () => {};
    w.requestAnimationFrame = w.setTimeout = () => 1;
    w.localStorage.setItem('singularity.save', JSON.stringify({v: 1, ...data}));
    w.eval(clock(date));
    w.eval(source + '\nwindow.probe = code => eval(code);');
    q = w.probe;
    q('resize(); reset();');
    close = () => w.close();
  } else {
    const sandbox = vm.createContext({console});
    vm.runInContext(clock(date) + `
      let save = ${JSON.stringify({v: 1, ...data})};
      const SAVE_VER = 1;
      let disk = JSON.stringify(save);
      const localStorage = { getItem() { return disk; }, setItem(k,v) { disk=v; } };
      function saveSet(k,v) { save[k]=v; save.v=1; try { localStorage.setItem('singularity.save',JSON.stringify(save)); } catch (_) {} }
      const lsGet = (k,d) => save[k] == null ? d : save[k];
      const window = globalThis;
      const document = {getElementById() { return null; }, addEventListener() {}};
      const setTimeout = () => 1;
      const Snd = {sting() {}, setDrone() {}};
      const toast = () => {}, buzz = () => {}, clearInput = () => {};
      const BODY_NAME = {};
      let state='menu', panel=null, score=0, best=0, elapsed=0, era=0, combo=0;
      let runDustScore=0, runEaten=0, lastMealT=0, seedOverride=null, dailyRun=false;
      let runUpgrades={}, rareWindowActive=false, rareWindowT=0, rareSpawnT=0;
      const seedFromUrl=()=>null, rng=()=>1, clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
      const runGoal=()=>({endless:true});
      function consume() {}
      function die() { state='dead'; }
      function commitBest() { if(state==='play'||state==='paused') settleScoreDust(); best=Math.max(best,score); }
      function start() { score=0; runDustScore=0; elapsed=0; state='play'; }
      function update() {}
      function toMenu() { commitBest(); state='menu'; }
    ` + source.slice(source.indexOf(marker)), sandbox);
    q = code => vm.runInContext(code, sandbox);
  }
  return {q, close, saved: () => JSON.parse(q("localStorage.getItem('singularity.save')"))};
}
function clock(date) {
  return `globalThis.RealDate=Date; globalThis.claimClock=new RealDate(...${JSON.stringify(date)}).getTime();
    globalThis.Date=class extends RealDate { constructor(...a) { super(...(a.length?a:[claimClock])); } static now() { return claimClock; } };`;
}
let passed=0, failed=0;
function test(name, fn, data, date) {
  let game;
  try { game=boot(data,date); fn(game); passed++; console.log('PASS '+name); }
  catch(e) { failed++; console.error('FAIL '+name+'\n'+e.stack); }
  finally { if(game) game.close(); }
}

test('malformed counters remain finite and upgrade values are bounded', ({q}) => {
  for (const key of ['stardust','totalRuns','totalEaten','runsSinceLastRare','dailyStreak']) assert.equal(q(key),0,key);
  assert.equal(q('totalPlayTime'),12.75);
  assert.equal(q('upgradeLevel("gravity")'),0);
  assert.equal(q('upgradeLevel("horizon")'),5);
}, {stardust:'9'.repeat(400), totalRuns:-5, totalEaten:'25oops', runsSinceLastRare:[], dailyStreak:'Infinity', totalPlayTime:12.75, upgrades:{gravity:[5], horizon:99}});
test('array-shaped unlock maps retain newly earned flags after reload', ({q,saved}) => {
  q('unlockSkin("nebula"); unlockAchievement("first_eat")');
  const next=boot(saved());
  try {
    assert.equal(next.q('skins.nebula'),true);
    assert.equal(next.q('achievements.first_eat'),true);
  } finally { next.close(); }
}, {skins:[], achievements:[]});
test('false-shaped unlocks cannot equip or suppress a legitimate unlock', ({q}) => {
  assert.equal(q('equipSkin("quasar")'),false);
  q('unlockSkin("quasar"); unlockAchievement("first_eat")');
  assert.equal(q('skins.quasar && achievements.first_eat'),true);
}, {skins:{quasar:'false'}, achievements:{first_eat:{}}});
test('invalid score cannot poison the milestone watermark or currency', ({q}) => {
  q('start(); score=NaN; settleScoreDust(); score=Infinity; settleScoreDust(); score=350; settleScoreDust(); settleScoreDust()');
  assert.equal(q('stardust'),3);
  assert.equal(q('runDustScore'),3);
});
test('restart commits pending milestones once before resetting accounting', ({q}) => {
  q('start(); score=350; start()');
  assert.equal(q('stardust'),3);
  assert.equal(q('best'),350);
  q('score=100; settleScoreDust(); start()');
  assert.equal(q('stardust'),4);
});
test('death settlement is idempotent even after accidental state re-entry', ({q,saved}) => {
  q('start(); elapsed=12.75; score=350; die(); die(); state="play"; die()');
  assert.equal(q('totalRuns'),1);
  assert.equal(q('totalPlayTime'),12.75);
  assert.equal(q('weeklyScores[0].scores.length'),1);
  const next=boot(saved());
  try { assert.equal(next.q('totalPlayTime'),12.75); } finally { next.close(); }
  q('start(); elapsed=0.5; die()');
  assert.equal(q('totalRuns'),2);
  assert.equal(q('totalPlayTime'),13.25);
});
test('daily history ignores malformed entries, duplicates and impossible dates', ({q}) => {
  assert.equal(q('dailyStreak'),3);
  assert.equal(q('dailyRewards.length'),3);
  assert.equal(q('dailyLastClaim'),'');
}, {dailyRewards:[0,0,27,28,-1,{},null,'2026-02-30','2026-01-01','2026-01-01'], dailyLastClaim:'2026-02-30'});
test('daily milestone writes always contain lock, currency, skin and badges together', ({q,saved}) => {
  q(`globalThis.snapshots=[]; globalThis.originalSaveSet=saveSet;
    saveSet=function(k,v) { originalSaveSet(k,v); snapshots.push(JSON.parse(localStorage.getItem('singularity.save'))); };
    claimDailyReward(); claimDailyReward();`);
  const snapshots=JSON.parse(q('JSON.stringify(snapshots)'));
  assert.ok(snapshots.length);
  for (const s of snapshots) {
    assert.equal(s.dailyStreak,28); assert.equal(s.stardust,150);
    assert.equal(s.dailyLastClaim,'2026-01-03');
    assert.equal(s.skins.nebula,true);
    assert.equal(s.achievements.daily7,true); assert.equal(s.achievements.daily28,true);
  }
  const next=boot(saved());
  try { next.q('claimDailyReward()'); assert.equal(next.q('stardust'),150); } finally { next.close(); }
}, {dailyStreak:27});
test('unavailable storage keeps session rewards usable without duplicate claims', ({q}) => {
  q(`globalThis.originalSetItem=localStorage.setItem;
    Object.getPrototypeOf(localStorage).setItem=function() { throw Error('quota'); };
    localStorage.setItem=function() { throw Error('quota'); };
    claimDailyReward(); claimDailyReward();`);
  assert.equal(q('stardust'),6);
  assert.equal(q('dailyStreak'),1);
});
test('weekly key changes at Sunday midnight, not Saturday after midnight', ({q}) => {
  const key=(args)=>q(`weekKey(new Date(${args}))`);
  assert.equal(key('2026,0,3,0,0'),'2025-12-28');
  assert.equal(key('2026,0,3,23,59,59'),'2025-12-28');
  assert.equal(key('2026,0,4,0,0'),'2026-01-04');
  assert.equal(key('2025,11,31,12'),key('2026,0,1,12'));
  assert.notEqual(key('2026,0,4,12'),key('2027,0,4,12'));
});
test('weekly boundaries remain calendar-based across spring and fall DST', ({q}) => {
  assert.equal(q('weekKey(new Date(2026,2,8,0))'),'2026-03-08');
  assert.equal(q('weekKey(new Date(2026,2,14,23,59))'),'2026-03-08');
  assert.equal(q('weekKey(new Date(2026,10,1,0))'),'2026-11-01');
  assert.equal(q('weekKey(new Date(2026,10,7,23,59))'),'2026-11-01');
});
test('weekly records normalize, sort, merge, cap and reset best on rollover', ({q,saved}) => {
  assert.equal(q('weeklyScores[0].scores[0]'),50);
  assert.equal(q('myWeeklyBest'),50);
  q('for(let i=0;i<15;i++) submitScore(i); submitScore(-5); submitScore(Infinity)');
  assert.equal(q('weeklyScores[0].scores.length'),10);
  q('claimClock=new RealDate(2026,0,4,0).getTime(); submitScore(3)');
  assert.equal(q('myWeeklyBest'),3);
  assert.equal(q('weeklyScores[0].scores.length'),1);
  assert.equal(saved().myWeeklyBest,3);
}, {weeklyScores:[null,{week:'2025-12-28',scores:[2,-4,'90',50]},{week:'2025-12-28',scores:[12]},{week:1,scores:[9999]}],myWeeklyBest:99999});
console.log(`${passed} progression regression checks passed; ${failed} failed (${integration?'whole-game jsdom':'isolated progression'})`);
if(failed) process.exitCode=1;
