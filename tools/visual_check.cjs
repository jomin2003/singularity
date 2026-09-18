'use strict';
/**
 * Dev-only visual + layout check for SINGULARITY.
 *
 *   node tools/visual_check.cjs
 *
 * Renders REAL frames with headless Chrome and reports, per viewport, whether
 * anything leaves the screen horizontally and how tall each panel is against
 * its scroll container. PNGs land in <temp>/singularity-shots so the UI can
 * actually be looked at -- jsdom stubs the canvas, lays nothing out and parses
 * no CSS, so it cannot answer "does this fit a phone".
 *
 * Why the DevTools Protocol and not `--screenshot`: plain `--headless
 * --screenshot` ignores `--window-size` for layout, so the page lays out at the
 * default window (measured 762x484) and the PNG is letterboxed into the
 * requested size. Every measurement taken that way is wrong, which is worse
 * than useless. `Emulation.setDeviceMetricsOverride` sets a real viewport, DPR
 * and mobile flag.
 *
 * Set CHROME_PATH to override the browser. Node built-ins only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const OUT = path.join(os.tmpdir(), 'singularity-shots');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9222);
const TEMP_PAGE = path.join(WWW, '_visual_check.html');

const PANEL_SCRIPT = `
<script>
(function () {
  var want = new URLSearchParams(location.search).get('panel');
  window.__shotError = null;
  if (!want) return;
  setTimeout(function () {
    try {
      start();
      if (want === 'observe')  openObservatory();
      if (want === 'settings') openSettings('menu');
      if (want === 'daily')    openDailyReward();
      if (want === 'guide')    openFieldGuide();
      if (want === 'board')    openLeaderboard();
      if (want === 'pause')    pauseGame();
      if (want === 'over')     { best = 0; score = 48210; die(); }
    } catch (e) { window.__shotError = e.message; }
  }, 400);
})();
</script>
`;

const PROFILE = path.join(os.tmpdir(), 'singularity-visual-profile');

const MEASURE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = { vw: vw, vh: vh, dpr: window.devicePixelRatio,
                docW: document.documentElement.clientWidth,
                shotError: window.__shotError || null };
  const menu = document.getElementById('menu');
  if (menu && !menu.classList.contains('hidden')) {
    const p = getComputedStyle(menu);
    out.menuPadding = [p.paddingTop, p.paddingRight, p.paddingBottom, p.paddingLeft].join(' ');
  }
  const card = document.querySelector('#menu:not(.hidden) #menuCard, .layer:not(.hidden) > .glass-card');
  if (card) {
    const r = card.getBoundingClientRect();
    out.card = { x: +r.x.toFixed(1), right: +r.right.toFixed(1),
                 w: +r.width.toFixed(1), h: +r.height.toFixed(1),
                 bottom: +r.bottom.toFixed(1),
                 scrollH: card.scrollHeight, clientH: card.clientHeight };
  }
  const bad = [];
  document.querySelectorAll('body *').forEach((n) => {
    if (n.closest('.hidden')) return;
    if (n.id === 'menuAurora') return;                 // deliberately oversized wash
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = n.getBoundingClientRect();
    if (!r.width && !r.height) return;
    if (r.right > vw + 1 || r.left < -1) {
      bad.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
        (n.className ? '.' + String(n.className).split(' ').join('.') : '') +
        ' [' + r.left.toFixed(0) + '..' + r.right.toFixed(0) + ']');
    }
  });
  out.overflow = bad.slice(0, 10);
  out.overflowCount = bad.length;
  return out;
})()`;

const SHOTS = [
  { name: 'menu',            w: 390, h: 844, url: '' },
  { name: 'menu-360',        w: 360, h: 640, url: '' },
  { name: 'play',            w: 390, h: 844, url: '?shot=play' },
  { name: 'pause',           w: 390, h: 844, url: '?panel=pause' },
  { name: 'observatory',     w: 390, h: 844, url: '?panel=observe' },
  { name: 'observatory-360', w: 360, h: 640, url: '?panel=observe' },
  { name: 'settings',        w: 390, h: 844, url: '?panel=settings' },
  { name: 'settings-360',    w: 360, h: 640, url: '?panel=settings' },
  { name: 'gameover',        w: 390, h: 844, url: '?panel=over' },
  { name: 'guide',           w: 390, h: 844, url: '?panel=guide' },
  { name: 'landscape',       w: 844, h: 390, url: '' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* chrome not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debuggable page');
}

function rpc(ws) {
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    waiting.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // Fresh profile every run. A reused one keeps localStorage, so a run left in
  // the save by an earlier invocation shows up in the menu screenshot and makes
  // the footer look inconsistent ("no runs yet" next to a charted score).
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  fs.writeFileSync(TEMP_PAGE, html.replace('</body>', PANEL_SCRIPT + '</body>'), 'utf8');
  const fileUrl = 'file:///' + TEMP_PAGE.replace(/\\/g, '/');

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank',
  ], { stdio: 'ignore' });

  let failures = 0;
  try {
    const ws = new WebSocket(await connect());
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const send = rpc(ws);
    await send('Page.enable');

    for (const shot of SHOTS) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: shot.w, height: shot.h, deviceScaleFactor: 2, mobile: true,
      });
      await send('Page.navigate', {
        url: fileUrl + (shot.url || '?v=b21') + '&seed=20260915',
      });
      await sleep(1200);
      const res = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
      const d = res.result.value || {};
      const png = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, shot.name + '.png'), Buffer.from(png.data, 'base64'));

      const overflow = d.overflowCount || 0;
      const fits = d.card ? (d.card.right <= d.vw + 1 && d.card.x >= -1) : true;
      if (overflow || !fits || d.shotError) failures++;

      console.log('\n== ' + shot.name + '  ' + d.vw + 'x' + d.vh + ' @' + d.dpr + 'x');
      if (d.shotError) console.log('   SHOT ERROR: ' + d.shotError);
      if (d.menuPadding) console.log('   menu padding (t/r/b/l): ' + d.menuPadding);
      if (d.card) {
        console.log('   card x=' + d.card.x + ' right=' + d.card.right +
          ' w=' + d.card.w + ' bottom=' + d.card.bottom + '/' + d.vh +
          '  scrollH=' + d.card.scrollH + ' clientH=' + d.card.clientH +
          (fits ? '' : '   <-- LEAVES THE VIEWPORT'));
      }
      console.log('   overflow: ' + overflow +
        (overflow ? '  ' + d.overflow.join(' | ') : ''));
    }
    ws.close();
  } finally {
    chrome.kill();
    if (fs.existsSync(TEMP_PAGE)) fs.unlinkSync(TEMP_PAGE);
  }
  console.log('\n' + (SHOTS.length - failures) + '/' + SHOTS.length +
    ' shots clean; PNGs in ' + OUT);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
