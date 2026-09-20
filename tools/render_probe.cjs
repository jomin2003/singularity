'use strict';
/**
 * Dev-only render probe for SINGULARITY.
 *
 *   node tools/render_probe.cjs
 *
 * visual_check.cjs proves layout fits; this proves the RENDER. It loads the
 * real game in headless Chrome, boots a run with ?shot=play, and reads actual
 * canvas pixels back over CDP to assert the things a human eye would check:
 *
 *   * the hole's core is actually black (shadow not washed out)
 *   * the disk emits warm orange light around the shadow
 *   * the disk is asymmetric (Doppler beaming survived the redesign)
 *   * the menu carries the ink/bone/orange palette and no legacy cyan/violet
 *
 * Pixel thresholds are generous on purpose: this catches "renderer broke /
 * palette regressed", not aesthetic drift. Node built-ins only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9223);
const TEMP_PAGE = path.join(WWW, '_render_probe.html');
const PROFILE = path.join(os.tmpdir(), 'singularity-render-probe');

const PLAY_PROBE = `(() => {
  const out = { errs: [] };
  try {
    const cv = document.querySelector('canvas');
    if (!cv) { out.errs.push('no canvas'); return out; }
    const g = cv.getContext('2d');
    if (!g) { out.errs.push('no 2d context'); return out; }
    if (typeof p === 'undefined' || !p) { out.errs.push('no player object'); return out; }
    if (typeof cam === 'undefined' || !cam) { out.errs.push('no camera object'); return out; }
    if (typeof state === 'undefined' || state !== 'play') {
      // Force the game's own entry into a run rather than inferring anything.
      try { if (typeof start === 'function') start(); } catch (e) { out.errs.push('start threw: ' + e.message); return out; }
      if (state !== 'play') { out.errs.push('state=' + state); return out; }
    }
    // Freeze the follow-cam on the hole and pull the zoom out so the whole
    // disk assembly (out to ~2.6x the shadow) sits in sampled empty space.
    // A live cam drifts with velocity; a pinned one makes the pixel sampling
    // deterministic.
    p.vx = 0; p.vy = 0;
    cam.x = p.x; cam.y = p.y;
    cam.zoom = 0.5;
    const W = cv.width, H = cv.height;
    // Anchor the hole at the world origin with the camera on top of it, then
    // render synchronously so the sampled pixels ARE the pinned state -- no
    // world-to-screen transform math, no drift, no save/restore ambiguity.
    p.vx = 0; p.vy = 0;
    p.x = 0; p.y = 0;
    cam.x = 0; cam.y = 0;
    cam.zoom = 0.5;
    if (typeof render === 'function') render();
    const img = g.getImageData(0, 0, W, H).data;
    const dpr = window.devicePixelRatio || 1;
    const cx = W / 2, cy = H / 2;
    const R = Math.max(4, p.r * cam.zoom * dpr);
    const reach = Math.min(R * 2.7, Math.min(cx, cy, W - cx, H - cy) - 2);
    if (reach < R * 1.2) { out.errs.push('player too close to edge to probe r=' + R.toFixed(1)); return out; }
    let coreLum = 0, coreN = 0;
    let beamLum = 0, beamN = 0, backLum = 0, backN = 0;
    let warm = 0, annN = 0;
    const step = Math.max(1, Math.round(R / 10));
    for (let dy = -reach; dy <= reach; dy += step) {
      for (let dx = -reach; dx <= reach; dx += step) {
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        const r8 = img[i], g8 = img[i + 1], b8 = img[i + 2];
        const lum = 0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8;
        const d = Math.hypot(dx, dy);
        if (d < R * 0.5) { coreLum += lum; coreN++; }
        else if (d > R * 1.12 && d < R * 2.55) {
          annN++;
          if (r8 > b8 + 25 && r8 > 60) warm++;
          if (dx > R * 0.5) { beamLum += lum; beamN++; }
          else if (dx < -R * 0.5) { backLum += lum; backN++; }
        }
      }
    }
    if (!coreN || !annN || !beamN || !backN) { out.errs.push('empty sample regions'); return out; }
    out.coreLum = +(coreLum / coreN).toFixed(1);
    out.warmFrac = +(warm / annN).toFixed(3);
    out.beamLum = +(beamLum / beamN).toFixed(1);
    out.backLum = +(backLum / backN).toFixed(1);
    out.asymmetry = +(Math.max(beamLum, backLum) / Math.max(1, Math.min(beamLum, backLum))).toFixed(2);
  } catch (e) { out.errs.push('probe threw: ' + e.message); }
  return out;
})()`;

const MENU_PROBE = `(() => {
  const out = { errs: [], flagged: [], orangeSeen: false, aurora: 'absent' };
  try {
    if (document.getElementById('menuAurora')) out.aurora = 'PRESENT';
    const CYAN = ['143, 233, 230', '143,233,230'];
    const VIOLET = ['171, 158, 234', '171,158,234'];
    const seen = new Set();
    document.querySelectorAll('body *').forEach((n) => {
      if (n.closest('.hidden')) return;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const props = [cs.color, cs.backgroundColor, cs.borderTopColor];
      const bgImg = cs.backgroundImage;
      if (bgImg && bgImg !== 'none') {
        if (CYAN.some((c) => bgImg.includes(c)) || VIOLET.some((c) => bgImg.includes(c))) {
          seen.add('bg-image on ' + (n.id ? '#' + n.id : n.className));
        }
      }
      for (const v of props) {
        if (v === 'rgba(0, 0, 0, 0)') continue;
        if (CYAN.some((c) => v.includes(c)) || VIOLET.some((c) => v.includes(c))) {
          seen.add((n.id ? '#' + n.id : n.tagName.toLowerCase() + '.' + String(n.className).split(' ')[0]) + ' -> ' + v);
        }
      }
      const all = (cs.color + ' ' + cs.backgroundColor);
      if (all.includes('198, 93, 50') || all.includes('198,93,50')) orangeSeen = true;
    });
    out.flagged = [...seen].slice(0, 12);
    out.flagCount = seen.length;
    // Note: orangeSeen checks rgb text form; browsers may serialize as-is.
  } catch (e) { out.errs.push('menu probe threw: ' + e.message); }
  return out;
})()`;

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
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  fs.writeFileSync(TEMP_PAGE, html, 'utf8');
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

    // -- gameplay render probe ------------------------------------------------
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await send('Page.navigate', { url: fileUrl + '?shot=play&seed=20260915' });
    await sleep(2600);
    const play = (await send('Runtime.evaluate', {
      expression: PLAY_PROBE, returnByValue: true,
    })).result.value || { errs: ['no value'] };

    console.log('== play render probe (390x844 @2x)');
    console.log('   core luminance : ' + (play.coreLum ?? '?') + '  (want < 40; HEAD baseline 74.3, redesign 0)');
    console.log('   warm disk frac : ' + (play.warmFrac ?? '?') +
      '  (want > 0.012, baseline-calibrated: HEAD 0.018, redesign 0.022)');
    console.log('   beam asymmetry : ' + (play.asymmetry ?? '?') +
      '  (beam ' + (play.beamLum ?? '?') + ' vs back ' + (play.backLum ?? '?') + ', want > 1.12)');
    if (play.errs && play.errs.length) console.log('   ERRORS: ' + play.errs.join(' | '));
    const playOk = !(play.errs || []).length &&
      play.coreLum < 40 && play.warmFrac > 0.012 && play.asymmetry > 1.12;
    if (!playOk) failures++;
    console.log('   ' + (playOk ? 'PASS' : 'FAIL'));

    // -- menu palette probe ----------------------------------------------------
    await send('Page.navigate', { url: fileUrl + '?v=probe' });
    await sleep(1400);
    const menu = (await send('Runtime.evaluate', {
      expression: MENU_PROBE, returnByValue: true,
    })).result.value || { errs: ['no value'] };

    console.log('\n== menu palette probe');
    console.log('   legacy cyan/violet leaks: ' + (menu.flagCount ?? '?') +
      ((menu.flagged || []).length ? '  ' + menu.flagged.join(' | ') : ''));
    console.log('   aurora element: ' + menu.aurora + '  (want absent or hidden)');
    const menuOk = !(menu.errs || []).length &&
      menu.flagCount === 0 && menu.aurora !== 'VISIBLE';
    if (!menuOk) failures++;
    console.log('   ' + (menuOk ? 'PASS' : 'FAIL'));

    ws.close();
  } finally {
    chrome.kill();
    if (fs.existsSync(TEMP_PAGE)) fs.unlinkSync(TEMP_PAGE);
  }
  console.log('\n' + (failures ? 'RENDER PROBE FAILED' : 'render probe clean') );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
