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
  q('score=4800; update(0)');
  assert.equal(q('runStats.era'),4);
  assert.equal(q('eraLabel(20)'), 'SINGULARITY');
});
test('choice pick is fully removed; combo milestone fires AGN feedback directly', ({q,w}) => {
  q("start(); variant='monk'; combo=5; comboT=1; coachDone=false; coachStep=2; update(0); updateHUD()");
  const comboText = w.document.getElementById('comboValue').textContent;
  assert.match(comboText,/COMBO 5/);
  assert.ok(!/CHOICE IN/.test(comboText), 'no CHOICE IN countdown');
  assert.ok(q("toasts.some(t => t.node.textContent.includes('Every 24 chained eats'))"));
  for (const name of ['PICK_OPTS','startPick','resolvePick','pickAbsorb','drawPick',
                      'pickT','pickHold','pendingWave'])
    assert.equal(q('typeof '+name), 'undefined', name + ' removed');
  // A body landing on the milestone combo fires the classic feedback directly.
  q(`combo = WAVE_EVERY() - 1;
     window.meal = { x: p.x, y: p.y, r: Math.max(6, p.r * 0.3), vx: 0, vy: 0,
       spin: 0, phase: 0, body: { type: 'rocky', variant: 0, spin: 0 } };
     ents = [meal]; waves = []; consume(meal, 0);`);
  assert.ok(q('waves.length') > 0, 'AGN feedback wave fired directly, no pick');
});
test('near miss uses exact next-era points and no currency pressure or wrap', ({q}) => {
  q('score=1199; era=0'); assert.equal(q('computeNearMiss()'),'1 points to STELLAR');
  q('score=2399; era=0'); assert.equal(q('computeNearMiss()'),'1 points to INTERMEDIATE');
  q('score=7200'); assert.equal(q('computeNearMiss()'),'');
  q('score=0; stardust=0'); assert.equal(q('computeNearMiss()'),'');
  assert.equal(q("typeof EVENTS"),'undefined');
});
test('field guide system is fully removed', ({q,w}) => {
  assert.equal(q("typeof FIELD_GUIDE_BODIES"),'undefined');
  assert.equal(q("typeof FIELD_GUIDE_FACTS"),'undefined');
  assert.equal(q("typeof discoverBody"),'undefined');
  assert.equal(q("typeof renderFieldGuide"),'undefined');
  assert.equal(w.document.getElementById('fieldguide'),null);
  assert.equal(w.document.getElementById('menuGuideBtn'),null);
});
test('dark matter proximity no longer feeds a field guide', ({q,w}) => {
  q("start(); ents=[{x:p.r*4,y:0,r:10,vx:0,vy:0,phase:0,spin:0,darkMatter:true,body:{type:'darkMatter'}}]; state='play'; update(0)");
  assert.equal(q("typeof fieldGuide"),'undefined');
  assert.equal(JSON.parse(w.localStorage.getItem('singularity.save')).fieldGuide,undefined);
});
test('Observatory and leaderboard describe ordinary-only upgrades and personal local runs', ({q,w}) => {
  q('renderObservatory(); weeklyScores=[{week:weekKey(),scores:[300,200]}]; myWeeklyBest=900; renderLeaderboard()');
  assert.match(w.document.querySelector('.obs-upgrade-rules').textContent,/ordinary runs only.*1 stardust per 100 score/);
  assert.equal(w.document.querySelector('#leaderboard .glass-title').textContent,'YOUR LOCAL RUNS');
  assert.match(w.document.getElementById('lbInfo').textContent,/device only/);
  assert.deepEqual(Array.from(w.document.querySelectorAll('.lb-name'),n=>n.textContent),['Your best this week','Your run']);
});
console.log(`${passed} design checks passed`);
