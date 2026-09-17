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
test('HUD goals use exact score and reset within each era; optional IDs are safe', ({q,w}) => {
  for (const id of ['runGoalLabel','runGoalFill','runMission']) {
    if (!w.document.getElementById(id)) { const n=w.document.createElement('div'); n.id=id; w.document.body.appendChild(n); }
  }
  q('start(); score=1199; updateHUD()');
  assert.match(w.document.getElementById('runGoalLabel').textContent, /STELLAR.*1 points/);
  q('score=1200; updateHUD()');
  assert.match(w.document.getElementById('runGoalLabel').textContent, /INTERMEDIATE.*1,200/);
  assert.equal(w.document.getElementById('runGoalFill').style.width, '0%');
  q('score=1800; updateHUD()');
  assert.equal(w.document.getElementById('runGoalFill').style.width, '50%');
  q('score=8400; updateHUD()');
  assert.match(w.document.getElementById('runGoalLabel').textContent, /SINGULARITY.*ENDLESS/);
  assert.equal(w.document.getElementById('runGoalFill').style.width, '100%');
  for (const id of ['runGoalLabel','runGoalFill','runMission']) w.document.getElementById(id).remove();
  assert.doesNotThrow(()=>q('updateHUD()'));
});
test('one incomplete run mission shows chain progress and era stays synchronized', ({q,w}) => {
  q("start(); missions=[{id:'combo15',done:false},{id:'score5k',done:false}]; runStats.peakCombo=7; updateHUD()");
  const node=w.document.getElementById('runMission');
  assert.match(node.textContent,/Chain 15.*7\/15/);
  q('runStats.peakCombo=15; updateHUD()');
  assert.match(node.textContent,/Score 5,000/);
  q('score=4800; pauseOnEvent=false; update(0)');
  assert.equal(q('runStats.era'),4);
  assert.equal(q('eraLabel(20)'), 'SINGULARITY');
});
test('choice and coach cadence is variant-driven and descriptions are truthful', ({q,w}) => {
  q("start(); variant='monk'; combo=5; comboT=1; coachDone=false; coachStep=2; update(0); updateHUD()");
  assert.match(w.document.getElementById('comboValue').textContent,/CHOICE IN 19/);
  assert.ok(q("toasts.some(t => t.node.textContent.includes('Every 24 chained eats'))"));
  assert.match(q('PICK_OPTS[0].sub'),/15.*no special effects/);
  assert.match(q('PICK_OPTS[2].sub'),/one impact within 6s/);
  q('startPick(); resolvePick(2)');
  const area=q('p.area');
  q("hurt({x:100,y:0,vx:0,vy:0,body:{type:'rocky'}})");
  assert.equal(q('shield'),0); assert.equal(q('p.area'),area);
});
test('near miss uses exact next-era points and no currency pressure or wrap', ({q}) => {
  q('score=1199; era=0'); assert.equal(q('computeNearMiss()'),'1 points to STELLAR');
  q('score=2399; era=0'); assert.equal(q('computeNearMiss()'),'1 points to INTERMEDIATE');
  q('score=7200'); assert.equal(q('computeNearMiss()'),'');
  q('score=0; stardust=0'); assert.equal(q('computeNearMiss()'),'');
  assert.doesNotMatch(q('EVENTS.finale.body'),/Nothing left|invulnerab/i);
});
test('field guide reveals facts and behavior only for discovered cells', ({q,w}) => {
  q("fieldGuide={uranus:true,neptune:true}; renderFieldGuide()");
  const u=w.document.querySelector('[data-body=uranus]');
  const n=w.document.querySelector('[data-body=neptune]');
  assert.equal(u.querySelector('.fg-name').textContent,'Uranus');
  assert.equal(n.querySelector('.fg-name').textContent,'Neptune');
  assert.equal(u.querySelector('.fg-fact').textContent,q('FIELD_GUIDE_FACTS.uranus'));
  assert.ok(u.querySelector('.fg-behavior'));
  assert.equal(w.document.querySelector('[data-body=rocky] .fg-fact'),null);
});
test('dark matter proximity unlocks once only during play without advancing RNG', ({q,w}) => {
  q("start(); fieldGuide={}; pauseOnEvent=false; ents=[{x:p.r*4,y:0,r:10,vx:0,vy:0,phase:0,spin:0,darkMatter:true,body:{type:'darkMatter'}}]; state='paused'; update(0)");
  assert.equal(q('!!fieldGuide.darkMatter'),false);
  q("state='play'; update(0)");
  assert.equal(q('fieldGuide.darkMatter'),true);
  assert.equal(JSON.parse(w.localStorage.getItem('singularity.save')).fieldGuide.darkMatter,true);
  const rng=q('rngState');
  q("clearToasts(); discoverBody('darkMatter'); renderFieldGuide(); updateHUD()");
  assert.equal(q('rngState'),rng); assert.equal(q('toasts.length'),0);
  q('FIELD_GUIDE_BODIES.forEach(discoverBody); renderFieldGuide()');
  assert.match(w.document.getElementById('fgProgress').textContent,/20 \/ 20/);
});
test('Observatory and leaderboard describe ordinary-only upgrades and personal local runs', ({q,w}) => {
  q('renderObservatory(); weeklyScores=[{week:weekKey(),scores:[300,200]}]; myWeeklyBest=900; renderLeaderboard()');
  assert.match(w.document.querySelector('.obs-upgrade-rules').textContent,/ordinary runs only.*1 stardust per 100 score/);
  assert.equal(w.document.querySelector('#leaderboard .glass-title').textContent,'YOUR LOCAL RUNS');
  assert.match(w.document.getElementById('lbInfo').textContent,/device only/);
  assert.deepEqual(Array.from(w.document.querySelectorAll('.lb-name'),n=>n.textContent),['Your best this week','Your run']);
});
console.log(`${passed} design checks passed`);
