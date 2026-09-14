'use strict';

/* ============================================================
   SINGULARITY — an endless gravity-well game
   One finger. Consume what's smaller. Flee what isn't.
   ============================================================ */

/* ---------- math ---------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const mod = (a, n) => ((a % n) + n) % n;
// fraction of the gap to close this frame, frame-rate independent
const smooth = (perSecond, dt) => 1 - Math.pow(perSecond, dt);

/* ---------- tuning ---------- */
const P0 = 22;                       // starting radius, world units
const DEATH_AREA = P0 * P0 * 0.30;   // collapse below this
const ENT_TARGET = 110;              // entities kept alive
const COMBO_WINDOW = 1.35;           // seconds to keep a chain alive
const CONSUME_YIELD = 0.34;          // how much of a body becomes your mass

/* ---------- canvas ---------- */
const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d', { alpha: false });
let W = 0, H = 0, MIN = 0, DPR = 1;

/* ---------- state ---------- */
let state = 'menu';
let p, ents, parts, waves, cam;
let score = 0, shownScore = 0, best = 0, newBest = false;
let combo = 0, comboT = 0, elapsed = 0, era = 0;
let shakeMag = 0, hitstopT = 0, invuln = 0;
let pendingWave = false;

const pointer = { x: 0, y: 0, active: false };
const keys = { up: false, down: false, left: false, right: false };

/* ---------- DOM ---------- */
const el = {
  hud: document.getElementById('hud'),
  hudScore: document.getElementById('hudScore'),
  hudBest: document.getElementById('hudBest'),
  comboWrap: document.getElementById('comboWrap'),
  comboValue: document.getElementById('comboValue'),
  comboBar: document.getElementById('comboBar'),
  menu: document.getElementById('menu'),
  playBtn: document.getElementById('playBtn'),
  menuBest: document.getElementById('menuBest'),
  over: document.getElementById('over'),
  finalScore: document.getElementById('finalScore'),
  overBest: document.getElementById('overBest'),
  newBest: document.getElementById('newBest'),
  againBtn: document.getElementById('againBtn'),
  muteBtn: document.getElementById('muteBtn')
};

const show = (n) => n.classList.remove('hidden');
const hide = (n) => n.classList.add('hidden');
const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// localStorage throws on file:// and in Safari private mode — never let it
// take the whole game down.
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

// True when running inside the Capacitor Android shell. Assets are bundled and
// served locally there, so a service worker would only introduce stale caches.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                     window.Capacitor.isNativePlatform());

/* ============================================================
   AUDIO — everything procedural, no asset files
   ============================================================ */
const Snd = {
  ac: null, master: null, droneGain: null, droneFilter: null, noise: null,
  muted: lsGet('singularity.muted', '0') === '1',

  ensure() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = this.ac = new AC();

    const master = this.master = ac.createGain();
    master.gain.value = this.muted ? 0 : 0.85;
    master.connect(ac.destination);

    const len = Math.floor(ac.sampleRate * 0.5);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    this.noise = buf;

    const dg = this.droneGain = ac.createGain();
    dg.gain.value = 0;
    const df = this.droneFilter = ac.createBiquadFilter();
    df.type = 'lowpass'; df.frequency.value = 200; df.Q.value = 5;
    dg.connect(df); df.connect(master);

    [[55, 'sawtooth', 0.16], [55.7, 'sawtooth', 0.15], [82.5, 'sine', 0.10]]
      .forEach(([f, type, g]) => {
        const o = ac.createOscillator();
        o.type = type; o.frequency.value = f;
        const gg = ac.createGain(); gg.gain.value = g;
        o.connect(gg); gg.connect(dg); o.start();
      });
  },

  // rising pentatonic blip — the main dopamine lever
  blip(step) {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34, 36];
    const semi = SCALE[Math.min(step, SCALE.length - 1)];
    const f = 196 * Math.pow(2, semi / 12);
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.20, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.22);
  },

  thud() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = this.noise;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 0.36);

    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.30);
    const og = ac.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(og); og.connect(this.master);
    o.start(t); o.stop(t + 0.34);
  },

  boom() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(420, t + 0.22);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.34, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.44);
  },

  collapse() {
    if (!this.ac || this.muted) return;
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.0);
    const f = ac.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.0);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 1.15);
  },

  setDrone(on, c) {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    this.droneGain.gain.setTargetAtTime(on ? 0.17 : 0, t, 0.4);
    this.droneFilter.frequency.setTargetAtTime(180 + Math.min(c, 40) * 24, t, 0.12);
  }
};

/* ============================================================
   VISUAL CACHES
   ============================================================ */
const glowCache = new Map();
function glowSprite(hue) {
  const key = Math.round(hue / 24) * 24;
  if (glowCache.has(key)) return glowCache.get(key);
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.00, `hsla(${key}, 100%, 74%, 1)`);
  grd.addColorStop(0.22, `hsla(${key}, 100%, 62%, 0.55)`);
  grd.addColorStop(0.55, `hsla(${key}, 100%, 55%, 0.14)`);
  grd.addColorStop(1.00, `hsla(${key}, 100%, 50%, 0)`);
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  glowCache.set(key, c);
  return c;
}

let starLayers = [];
function buildStars() {
  starLayers = [
    { tile: 180, par: 0.16, n: 30, maxR: 0.9, a: 0.30 },
    { tile: 250, par: 0.42, n: 18, maxR: 1.3, a: 0.45 },
    { tile: 340, par: 0.80, n: 10, maxR: 2.0, a: 0.62 }
  ].map((cfg) => {
    const px = Math.round(cfg.tile * DPR);
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    for (let i = 0; i < cfg.n; i++) {
      const x = Math.random() * px, y = Math.random() * px;
      const r = (Math.random() * cfg.maxR + 0.35) * DPR;
      const a = Math.random() * cfg.a + 0.22;
      g.fillStyle = `rgba(198,228,255,${a})`;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    return Object.assign({}, cfg, { pattern: ctx.createPattern(c, 'repeat') });
  });
}

let vignette = null;
function buildVignette() {
  const g = ctx.createRadialGradient(W / 2, H / 2, MIN * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.72)');
  vignette = g;
}

let nebula = null, nebulaHue = -999;
function getNebula(hue) {
  if (Math.abs(hue - nebulaHue) < 3) return nebula;
  const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.85);
  g.addColorStop(0.00, `hsl(${hue}, 60%, 9%)`);
  g.addColorStop(0.45, `hsl(${(hue + 28) % 360}, 56%, 6%)`);
  g.addColorStop(1.00, `hsl(${(hue + 52) % 360}, 50%, 3%)`);
  nebula = g; nebulaHue = hue;
  return g;
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  MIN = Math.min(W, H);
  cvs.width = Math.round(W * DPR);
  cvs.height = Math.round(H * DPR);
  buildStars();
  buildVignette();
  nebulaHue = -999;
}

/* ============================================================
   GAME LOGIC
   ============================================================ */
function difficulty() { return state === 'play' ? clamp(elapsed / 80, 0, 1) : 0; }
function comboMult() { return Math.min(1 + combo * 0.08, 8); }
function viewWorldRadius() { return Math.hypot(W, H) * 0.5 / cam.zoom; }

function desiredZoom() {
  const grow = p.r / P0;
  const visR = P0 * 8 * Math.pow(grow, 0.78);
  let z = (MIN * 0.5) / visR;
  const sr = p.r * z;
  if (sr > 54) z = 54 / p.r;
  if (sr < 22) z = 22 / p.r;
  return z;
}

function pickRadius() {
  const d = difficulty();
  const q = Math.random();
  if (q < 0.50) return p.r * rand(0.09, 0.30);                        // motes
  if (q < 0.78) return p.r * rand(0.30, 0.72);                        // food
  if (q < 0.78 + 0.18 * (1 - 0.6 * d)) return p.r * rand(0.72, 0.94); // big food
  return p.r * rand(1.05, 1.55 + 1.15 * d);                           // danger
}

// colour IS the difficulty language: cool = edible, warm = lethal
function entHue(ratio) {
  if (ratio <= 0.95) return 188 + clamp(ratio / 0.95, 0, 1) * 82;
  return 44 - clamp((ratio - 0.95) / 0.9, 0, 1) * 44;
}

function reset() {
  p = { x: 0, y: 0, vx: 0, vy: 0, r: P0, area: P0 * P0 };
  ents = []; parts = []; waves = [];
  cam = { x: 0, y: 0, zoom: 1 };
  score = 0; shownScore = 0; combo = 0; comboT = 0;
  elapsed = 0; era = 0; shakeMag = 0; hitstopT = 0; invuln = 0;
  pointer.active = false; pointer.x = W / 2; pointer.y = H / 2;
  for (let i = 0; i < ENT_TARGET; i++) spawn(Math.random() < 0.5 ? 1.15 : 1.7);
  cam.zoom = desiredZoom();
}

function spawn(scaleMul) {
  const v = viewWorldRadius();
  const a = Math.random() * TAU;
  const dist = rand(v * 1.14, v * (scaleMul || 1.7));
  ents.push({
    x: p.x + Math.cos(a) * dist,
    y: p.y + Math.sin(a) * dist,
    vx: rand(-0.12, 0.12) * p.r,
    vy: rand(-0.12, 0.12) * p.r,
    r: pickRadius(),
    spin: rand(-0.9, 0.9),
    phase: Math.random() * TAU
  });
}

function addPart(o) {
  if (parts.length >= 460) parts.splice(0, 48);
  parts.push(o);
}

function absorbFx(e) {
  const n = clamp(Math.round(e.r * 0.5) + 3, 3, 18);
  const tx = e.x - p.x, ty = e.y - p.y;
  const d = Math.hypot(tx, ty) || 1;
  const hue = entHue(e.r / p.r);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(0.5, 1.9) * p.r;
    addPart({
      x: e.x + Math.cos(a) * e.r * 0.7,
      y: e.y + Math.sin(a) * e.r * 0.7,
      vx: -tx / d * sp + Math.cos(a) * sp * 0.5,
      vy: -ty / d * sp + Math.sin(a) * sp * 0.5,
      life: 0, max: rand(0.28, 0.6),
      r: rand(0.06, 0.2) * p.r + 0.8,
      hue, mode: 0
    });
  }
}

function burstFx(x, y, n, spread, scale) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(0.6, 2.4) * (spread || p.r) * 1.4 * (scale || 1);
    addPart({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0, max: rand(0.35, 0.9),
      r: rand(0.08, 0.26) * p.r + 1,
      hue: rand(180, 300), mode: 1
    });
  }
}

function consume(e, idx) {
  p.area += e.r * e.r * CONSUME_YIELD;
  p.r = Math.sqrt(p.area);
  combo++;
  comboT = COMBO_WINDOW;
  score += Math.max(1, Math.round(e.r * 0.42 * comboMult()));
  absorbFx(e);
  Snd.blip(combo - 1);
  Snd.setDrone(true, combo);
  ents.splice(idx, 1);
  if (combo % 20 === 0) pendingWave = true;
}

function hurt(e) {
  p.area *= 0.68;
  p.r = Math.sqrt(p.area);
  const dx = p.x - e.x, dy = p.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  p.vx = dx / d * 9 * p.r;
  p.vy = dy / d * 9 * p.r;
  e.vx -= dx / d * p.r * 1.6;
  e.vy -= dy / d * p.r * 1.6;
  invuln = 1.15;
  combo = 0; comboT = 0;
  shakeMag = Math.max(shakeMag, 20);
  hitstopT = Math.max(hitstopT, 0.09);
  Snd.thud();
  Snd.setDrone(true, 0);
  burstFx(p.x, p.y, 26, p.r, 1);
}

function shockwave() {
  const R = p.r * 13;
  waves.push({ x: p.x, y: p.y, r: p.r, max: R, t: 0 });
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy < R * R && e.r > p.r * 0.95) {
      score += Math.round(e.r * 0.5 * comboMult());
      burstFx(e.x, e.y, 10, e.r, 1);
      ents.splice(i, 1);
    }
  }
  shakeMag = Math.max(shakeMag, 12);
  Snd.boom();
}

function die() {
  state = 'dead';
  Snd.collapse();
  Snd.setDrone(false, 0);
  shakeMag = Math.max(shakeMag, 28);
  burstFx(p.x, p.y, 70, p.r, 1.6);

  newBest = score > best;
  if (newBest) {
    best = score;
    lsSet('singularity.best', String(best));
  }
  hide(el.hud);
  el.finalScore.textContent = fmt(score);
  el.overBest.textContent = 'BEST ' + fmt(best);
  el.newBest.classList.toggle('hidden', !newBest);
  show(el.over);
}

function currentTarget() {
  if (pointer.active) {
    return {
      x: (pointer.x - W / 2) / cam.zoom + cam.x,
      y: (pointer.y - H / 2) / cam.zoom + cam.y
    };
  }
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (dx || dy) {
    const m = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / m * 220, y: p.y + dy / m * 220 };
  }
  return { x: p.x, y: p.y };
}

function update(dt) {
  elapsed += dt;
  era = Math.floor(score / 1200);

  cam.zoom = lerp(cam.zoom, desiredZoom(), smooth(0.02, dt));
  const follow = smooth(0.0008, dt);
  cam.x = lerp(cam.x, p.x, follow);
  cam.y = lerp(cam.y, p.y, follow);

  if (state === 'play') {
    // --- movement: weighted follow, speed capped to size ---
    const t = currentTarget();
    const dx = t.x - p.x, dy = t.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const maxV = 11 * p.r;
    const wantV = Math.min(maxV, dist * 7);
    const k = smooth(0.0006, dt);
    p.vx = lerp(p.vx, dx / dist * wantV, k);
    p.vy = lerp(p.vy, dy / dist * wantV, k);
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // --- entropy: standing still is not free ---
    const decay = 0.0015 + 0.0026 * clamp((p.r / P0 - 1) / 8, 0, 1);
    p.area = Math.max(1, p.area - p.area * decay * dt);
    p.r = Math.sqrt(p.area);

    if (comboT > 0) { comboT -= dt; if (comboT <= 0) combo = 0; }
    if (invuln > 0) invuln -= dt;

    // --- collisions ---
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      const ddx = e.x - p.x, ddy = e.y - p.y;
      const reach = p.r + e.r * 0.5;
      if (ddx * ddx + ddy * ddy < reach * reach) {
        if (e.r <= p.r * 0.95) consume(e, i);
        else if (invuln <= 0) hurt(e);
      }
    }
    if (pendingWave) { pendingWave = false; shockwave(); }
    if (p.area < DEATH_AREA) die();
  }

  updateEnts(dt);
  updateParts(dt);
  updateWaves(dt);

  if (shakeMag > 0) shakeMag = Math.max(0, shakeMag - shakeMag * 7 * dt - 0.5 * dt);
}

function updateEnts(dt) {
  const need = ENT_TARGET - ents.length;
  if (need > 0) for (let i = 0; i < Math.min(need, 6); i++) spawn();

  const v = viewWorldRadius();
  const despawnR = v * 1.95;
  const pullR = p.r * 7;
  const edamp = Math.pow(0.12, dt);

  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    const dx = p.x - e.x, dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > despawnR * despawnR) { ents.splice(i, 1); continue; }

    // gravity well: light things get sucked in, heavy things barely budge
    if (state === 'play' && d2 < pullR * pullR) {
      const d = Math.sqrt(d2) || 1;
      const edible = e.r <= p.r * 0.95;
      const mass = (e.r * e.r) / (p.r * p.r);
      const s = (1 - d / pullR) * 3.2 * p.r * dt / (0.35 + mass * 2.2) * (edible ? 1 : 0.18);
      e.vx += dx / d * s;
      e.vy += dy / d * s;
    }
    e.vx *= edamp; e.vy *= edamp;
    e.x += e.vx * dt; e.y += e.vy * dt;
    e.phase += e.spin * dt;
  }
}

function updateParts(dt) {
  const pd = Math.pow(0.35, dt);
  for (let i = parts.length - 1; i >= 0; i--) {
    const q = parts[i];
    q.life += dt;
    if (q.life >= q.max) { parts.splice(i, 1); continue; }
    if (q.mode === 0) {
      const dx = p.x - q.x, dy = p.y - q.y;
      const d = Math.hypot(dx, dy) || 1;
      q.vx += dx / d * 26 * p.r * dt;
      q.vy += dy / d * 26 * p.r * dt;
    }
    q.vx *= pd; q.vy *= pd;
    q.x += q.vx * dt; q.y += q.vy * dt;
  }
}

function updateWaves(dt) {
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.t += dt;
    w.r += (w.max - w.r) * smooth(0.02, dt);
    if (w.t > 0.85) waves.splice(i, 1);
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = getNebula((210 + era * 24) % 360);
  ctx.fillRect(0, 0, W, H);

  drawStars();

  let sx = 0, sy = 0;
  if (shakeMag > 0.2) { sx = rand(-shakeMag, shakeMag); sy = rand(-shakeMag, shakeMag); }

  ctx.save();
  ctx.translate(W / 2 + sx, H / 2 + sy);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  drawEnts();
  drawWaves();
  drawParts();
  if (state !== 'dead') drawPlayer();

  ctx.restore();

  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

function drawStars() {
  for (const L of starLayers) {
    const T = L.tile;
    const ox = mod(-cam.x * L.par * cam.zoom, T);
    const oy = mod(-cam.y * L.par * cam.zoom, T);
    ctx.save();
    ctx.scale(1 / DPR, 1 / DPR);
    ctx.translate((ox - T) * DPR, (oy - T) * DPR);
    ctx.fillStyle = L.pattern;
    ctx.fillRect(0, 0, (W + 2 * T) * DPR, (H + 2 * T) * DPR);
    ctx.restore();
  }
}

function drawEnts() {
  for (const e of ents) {
    const ratio = e.r / p.r;
    const hue = entHue(ratio);
    const s = e.r * 2.3;

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(glowSprite(hue), e.x - s, e.y - s, s * 2, s * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = `hsl(${hue}, 92%, ${ratio > 0.95 ? 58 : 64}%)`;
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, TAU); ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `hsla(${hue}, 100%, 84%, 0.85)`;
    ctx.lineWidth = Math.max(0.6, e.r * 0.09);
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.99, 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawPlayer() {
  const r = p.r;
  const t = elapsed;
  const hue = (192 + era * 24) % 360;

  // halo
  ctx.globalCompositeOperation = 'lighter';
  const gs = r * 5.2;
  ctx.globalAlpha = 0.5 + Math.min(combo, 30) * 0.012;
  ctx.drawImage(glowSprite(hue), p.x - gs, p.y - gs, gs * 2, gs * 2);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // accretion arcs
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const rr = r * (1.35 + i * 0.34);
    const a0 = t * (1.4 - i * 0.32) + i * 2.1;
    ctx.strokeStyle = `hsla(${(hue + i * 26) % 360}, 100%, ${68 - i * 6}%, ${0.5 - i * 0.11})`;
    ctx.lineWidth = Math.max(1, r * 0.14);
    ctx.beginPath(); ctx.arc(p.x, p.y, rr, a0, a0 + 2.2 + i * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, rr, a0 + Math.PI, a0 + Math.PI + 1.5); ctx.stroke();
  }
  // orbiting sparks
  for (let i = 0; i < 7; i++) {
    const a = t * 2.1 + i * TAU / 7;
    const rr = r * (1.5 + (i % 3) * 0.22);
    ctx.fillStyle = `hsla(${(hue + 40) % 360}, 100%, 78%, 0.8)`;
    ctx.beginPath();
    ctx.arc(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, Math.max(0.8, r * 0.07), 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  // event horizon
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();

  // photon ring (flashes white while invulnerable)
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = (invuln > 0 && Math.floor(invuln * 18) % 2 === 0)
    ? 'rgba(255,255,255,0.95)'
    : `hsla(${hue}, 100%, 76%, 0.9)`;
  ctx.lineWidth = Math.max(1, r * 0.10);
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.02, 0, TAU); ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

function drawParts() {
  ctx.globalCompositeOperation = 'lighter';
  for (const q of parts) {
    const k = 1 - q.life / q.max;
    ctx.globalAlpha = k;
    ctx.fillStyle = `hsl(${q.hue}, 100%, ${62 + k * 22}%)`;
    ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (0.4 + k * 0.8), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawWaves() {
  ctx.globalCompositeOperation = 'lighter';
  for (const w of waves) {
    const k = 1 - w.t / 0.85;
    ctx.strokeStyle = `hsla(190, 100%, 74%, ${k * 0.7})`;
    ctx.lineWidth = Math.max(1.5, w.max * 0.03 * k);
    ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, TAU); ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ============================================================
   HUD + LOOP
   ============================================================ */
function updateHUD() {
  shownScore = lerp(shownScore, score, 0.18);
  if (Math.abs(shownScore - score) < 0.6) shownScore = score;
  el.hudScore.textContent = fmt(Math.round(shownScore));
  el.hudBest.textContent = fmt(best);

  const on = combo >= 3 && comboT > 0;
  el.comboWrap.classList.toggle('on', on);
  if (on) {
    el.comboValue.textContent = 'COMBO ' + combo + '  ×' + comboMult().toFixed(1);
    el.comboBar.firstElementChild.style.transform =
      'scaleX(' + (comboT / COMBO_WINDOW).toFixed(3) + ')';
  }
}

let last = 0;
function frame(now) {
  const real = Math.min((now - last) / 1000, 0.05);
  last = now;
  let dt = real;
  if (hitstopT > 0) { hitstopT -= real; dt = real * 0.18; }
  update(dt);
  render();
  updateHUD();
  requestAnimationFrame(frame);
}

/* ============================================================
   FLOW
   ============================================================ */
function start() {
  Snd.ensure();
  reset();
  state = 'play';
  hide(el.menu); hide(el.over); show(el.hud);
  Snd.setDrone(true, 0);
}

function toMenu() {
  state = 'menu';
  hide(el.over); hide(el.hud); show(el.menu);
  el.menuBest.textContent = best > 0 ? 'BEST ' + fmt(best) : '';
}

/* ============================================================
   INPUT
   ============================================================ */
let dragging = false;
function setPointer(e) {
  const r = cvs.getBoundingClientRect();
  pointer.x = e.clientX - r.left;
  pointer.y = e.clientY - r.top;
  pointer.active = true;
}

cvs.addEventListener('pointerdown', (e) => {
  dragging = true;
  setPointer(e);
  Snd.ensure();
  try { cvs.setPointerCapture(e.pointerId); } catch (_) {}
});
cvs.addEventListener('pointermove', (e) => { if (dragging) setPointer(e); });
cvs.addEventListener('pointerup', () => { dragging = false; pointer.active = false; });
cvs.addEventListener('pointercancel', () => { dragging = false; pointer.active = false; });

document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') keys.up = true;
  if (k === 'arrowdown' || k === 's') keys.down = true;
  if (k === 'arrowleft' || k === 'a') keys.left = true;
  if (k === 'arrowright' || k === 'd') keys.right = true;
  if (k === ' ' || k === 'enter') {
    if (state !== 'play') { e.preventDefault(); start(); }
  }
  if (k === 'm') el.muteBtn.click();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') keys.up = false;
  if (k === 'arrowdown' || k === 's') keys.down = false;
  if (k === 'arrowleft' || k === 'a') keys.left = false;
  if (k === 'arrowright' || k === 'd') keys.right = false;
});

el.playBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });
el.againBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });
el.over.addEventListener('click', () => start());

el.muteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  Snd.ensure();
  Snd.muted = !Snd.muted;
  lsSet('singularity.muted', Snd.muted ? '1' : '0');
  if (Snd.master) Snd.master.gain.setTargetAtTime(Snd.muted ? 0 : 0.85, Snd.ac.currentTime, 0.05);
  el.muteBtn.classList.toggle('off', Snd.muted);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) Snd.setDrone(false, 0);
  else { last = performance.now(); if (state === 'play') Snd.setDrone(true, combo); }
});

window.addEventListener('resize', resize);

/* ============================================================
   BOOT
   ============================================================ */
best = parseInt(lsGet('singularity.best', '0'), 10) || 0;
el.muteBtn.classList.toggle('off', Snd.muted);

resize();
reset();
toMenu();
requestAnimationFrame((t) => { last = t; frame(t); });

if ('serviceWorker' in navigator && !IS_NATIVE) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
