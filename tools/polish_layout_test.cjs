'use strict';
// Dev-only Chrome/CDP layout regression. No game execution or dependencies.
// node tools/polish_layout_test.cjs   (CHROME_PATH optional; Node 22+)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../www');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-polish-'));
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const server = http.createServer((req, res) => {
  const name = req.url.split('?')[0];
  if (name === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (name === '/style.css' || name === '/design.css') {
    res.setHeader('Content-Type', 'text/css'); return res.end(fs.readFileSync(path.join(root, name.slice(1))));
  }
  res.writeHead(404); res.end();
});
function rpc(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); reject(Error('CDP timeout: ' + method)); }, 10000);
    pending.set(mid, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
// Representative content for normally JS-populated hooks, not gameplay mocks.
function fixture() {
  document.getElementById('menuBest').textContent = 'BEST 48,210';
  document.getElementById('ctrlHint').textContent = 'Drag anywhere to steer your black hole.';
  document.getElementById('varHint').textContent = 'Standard flight profile. Consume smaller bodies to grow.';
  document.getElementById('missions').innerHTML = '<div class="mrow">Chain 15 meals in one run · 7 / 15</div>'.repeat(3);
  document.querySelector('#ctrlPick button').classList.add('on');
  document.querySelector('#varPick button').classList.add('on');
  document.getElementById('report').innerHTML = '<b>48,210 points</b><span class="cause">Caught by a spiked hazard.</span>';
  document.getElementById('drCalendar').innerHTML = Array.from({length:28}, (_, i) => '<div class="dr-day">' + (i + 1) + '</div>').join('');
  document.getElementById('lbList').innerHTML = '<div class="lb-row"><span class="lb-rank">1</span><span class="lb-name">Your best this week</span><span class="lb-score">48,210</span></div>'.repeat(10);
  document.getElementById('obsUpgrades').innerHTML = '<div class="obs-upgrade"><div class="obs-upgrade-info"><div class="obs-upgrade-name">Starting mass</div><div class="obs-upgrade-desc">Ordinary runs only</div></div><button class="obs-upgrade-btn">10 dust</button></div>'.repeat(4);
  document.getElementById('obsUpgrades').insertAdjacentHTML('afterend', '<label id="skinPickerLabel">Horizon accent (cosmetic)<select id="skinPicker"><option>Burnt orange</option></select></label><button id="dailyRewardBtn">Daily reward</button>');
  document.getElementById('rewardOffer').classList.remove('hidden');
}
function measure(panel) {
  const layer = document.getElementById(panel);
  const card = layer.querySelector('#menuCard, .glass-card');
  const r = card.getBoundingClientRect();
  const errors = [];
  if (r.x < 0 || r.right > innerWidth + 1 || r.y < 0 || r.bottom > innerHeight + 1) errors.push('card outside viewport');
  if (card.scrollWidth > card.clientWidth + 1) errors.push('horizontal scroll');
  for (const n of card.querySelectorAll('*')) {
    if (!n.checkVisibility() || n.closest('svg') || n.closest('details:not([open])') && !n.closest('summary')) continue;
    const b = n.getBoundingClientRect();
    if (b.width && (b.left < r.left - 1 || b.right > r.right + 1)) errors.push('overflow: ' + (n.id || n.className || n.tagName));
  }
  card.scrollTop = card.scrollHeight;
  const last = Array.from(card.querySelectorAll('button')).filter(n => n.checkVisibility()).at(-1) || card.lastElementChild;
  const b = last.getBoundingClientRect();
  if (b.bottom > r.bottom + 1 || b.top < r.top) errors.push('last control unreachable');
  card.scrollTop = 0;
  return { errors, width: r.width, height: r.height, scroll: card.scrollHeight > card.clientHeight };
}

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'], {stdio:'ignore'});
  let ws;
  try {
    const active = path.join(out, 'profile/DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(active); i++) await sleep(100);
    const port = fs.readFileSync(active, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const send = rpc(ws);
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', {expression, returnByValue:true});
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await send('Page.enable');
    await send('Emulation.setFocusEmulationEnabled', {enabled:true});
    await send('Page.bringToFront');
    await send('Emulation.setDeviceMetricsOverride', {width:390, height:844, deviceScaleFactor:1, mobile:true});
    await send('Page.navigate', {url:'http://127.0.0.1:' + server.address().port + '/'});
    await sleep(500);
    await evaluate('(' + fixture + ')()');
    assert.equal(await evaluate('document.querySelectorAll("#menuCard > details").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll("#menuCard .menu-meta-row .meta-btn .meta-lab").length'), 2);
    assert.equal(await evaluate('document.getElementById("menuCard").classList.contains("menu-min")'), true);
    assert.equal(await evaluate('getComputedStyle(document.body).touchAction'), 'auto');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("game")).touchAction'), 'none');
    const quick = process.argv.includes('--quick');
    const panels = quick ? ['menu'] : ['menu','settings','over','pause','observe','dailyreward','leaderboard','observatory'];
    let count = 0;
    for (const [width,height] of (quick ? [[320,568]] : [[320,568],[360,640],[390,844],[667,375],[844,390],[1280,800],[280,400]])) {
      await send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:true});
      for (const large of [false,true]) {
        await evaluate('document.body.classList.toggle("large", ' + large + ')');
        for (const panel of panels) {
          await evaluate('document.querySelectorAll(".layer").forEach(n=>n.classList.add("hidden")); document.getElementById(' + JSON.stringify(panel) + ').classList.remove("hidden")');
          await sleep(260);
          for (const open of panel === 'menu' ? [false,true] : [false]) {
            await evaluate('document.getElementById("runSetup").open=' + open);
            const result = await evaluate('(' + measure + ')(' + JSON.stringify(panel) + ')');
            assert.deepEqual(result.errors, [], `${panel} ${width}x${height} large=${large} open=${open}: ${JSON.stringify(result)}`);
            count++;
          }
          if (!large && ['menu','settings'].includes(panel)) {
            if (panel === 'menu') await evaluate('document.getElementById("runSetup").open=false');
            const png = await send('Page.captureScreenshot', {format:'png'});
            fs.writeFileSync(path.join(out, `${panel}-${width}x${height}.png`), Buffer.from(png.data, 'base64'));
          }
        }
      }
    }
    await evaluate('document.querySelectorAll(".layer").forEach(n=>n.classList.add("hidden")); document.getElementById("menu").classList.remove("hidden"); document.getElementById("runSetup").open=false; document.getElementById("menuCard").scrollTop=0; document.querySelector("summary").focus()');
    await sleep(300);
    await evaluate('document.querySelector("summary").focus()');
    assert.equal(await evaluate('document.activeElement.tagName'), 'SUMMARY');
    await send('Input.dispatchKeyEvent', {type:'keyDown', key:' ', code:'Space', windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent', {type:'keyUp', key:' ', code:'Space', windowsVirtualKeyCode:32});
    assert.equal(await evaluate('document.getElementById("runSetup").open'), true, 'keyboard opens disclosure');
    assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid', 'visible keyboard focus');
    await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate('getComputedStyle(document.getElementById("menu")).animationName'), 'none');
    await send('Emulation.setEmulatedMedia', {features:[]});
    await evaluate('document.body.classList.add("no-motion")');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("playBtn")).transitionDuration'), '0s');
    console.log(`PASS ${count} layout states; native disclosure, focus, touch contract, reduced motion. Screenshots: ${out}`);
  } finally {
    if (ws) ws.close();
    chrome.kill();
    server.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; server.close(); });
