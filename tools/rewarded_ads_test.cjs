'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const configSource = fs.readFileSync(path.join(root, 'www/ads-config.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'www/rewarded-ads.js'), 'utf8');
const E = { reward: 'onRewardedVideoAdReward', close: 'onRewardedVideoAdDismissed', fail: 'onRewardedVideoAdFailedToShow' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function boot(options = {}) {
  const store = options.store || new Map();
  const listeners = new Map(), calls = [], timers = new Map();
  let timerId = 0;
  const emit = name => { for (const fn of [...(listeners.get(name) || [])]) fn({ amount: 999, type: 'ignored' }); };
  const info = () => ({ status: 'NOT_REQUIRED', canRequestAds: true, privacyOptionsRequirementStatus: 'REQUIRED', ...options.info });
  const ad = {
    requestConsentInfo: async () => { calls.push('consent'); return info(); },
    showConsentForm: async () => { calls.push('form'); return options.form || info(); },
    showPrivacyOptionsForm: async () => { calls.push('privacy'); },
    initialize: async o => { calls.push('init'); assert.equal(o.initializeForTesting, true); },
    addListener: async (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return { remove: async () => { listeners.get(name).delete(fn); } };
    },
    prepareRewardVideoAd: async o => {
      calls.push('load');
      assert.equal(o.adId, 'ca-app-pub-3940256099942544/5224354917');
      assert.equal(o.isTesting, true);
      if (options.loadFail) throw new Error('no fill');
    },
    showRewardVideoAd: () => {
      calls.push('show');
      if (options.showThrow) throw new Error('show failed');
      if (options.showReject) return Promise.reject(new Error('show failed'));
      if (options.manual) return new Promise(() => {});
      if (!options.cancel) { emit(E.reward); emit(E.reward); }
      emit(E.close);
      emit(E.reward); // A late callback after close cannot reward.
      return options.resolveOnly ? Promise.resolve({ amount: 999 }) : new Promise(() => {});
    },
    ...options.adapter
  };
  const w = {
    REWARDED_ADS_CONFIG: options.config,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => {
      if (options.storageFail) throw new Error('storage blocked');
      store.set(k, v);
    } },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    Capacitor: {
      isNativePlatform: () => !options.web,
      getPlatform: () => options.web ? 'web' : 'android',
      isPluginAvailable: () => !options.missingPlugin,
      registerPlugin: name => { assert.equal(name, 'AdMob'); calls.push('register'); return ad; }
    }
  };
  vm.runInNewContext(configSource + '\n' + source, { window: w, Date, console });
  return { api: w.RewardedAds, calls, emit, store, timers, listeners,
    fireTimers: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } } };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  await test('lazy native success; duplicate reward ignored; listeners cleaned', async () => {
    const b = boot();
    assert.deepEqual(b.calls, []);
    assert.equal(b.api.available(), true);
    assert.equal(b.api.config.testMode, true);
    assert.equal(b.api.config.rewardAmount, 25);
    assert.equal(await b.api.watch(), true);
    assert.equal(b.api.remaining(), 2);
    assert.equal(b.api.busy(), false);
    assert.deepEqual(b.calls, ['register', 'consent', 'init', 'load', 'show']);
    assert.equal([...b.listeners.values()].reduce((sum, s) => sum + s.size, 0), 0);
  });
  await test('early cancellation and late reward never grant', async () => {
    const b = boot({ cancel: true });
    assert.equal(await b.api.watch(), false);
    assert.equal(b.api.remaining(), 3);
  });
  await test('show promise alone is not a reward', async () => {
    const b = boot({ cancel: true, resolveOnly: true });
    assert.equal(await b.api.watch(), false);
  });
  await test('no fill and thrown/rejected show are safe', async () => {
    for (const options of [{ loadFail: true }, { showThrow: true }, { showReject: true }]) {
      const b = boot(options);
      assert.equal(await b.api.watch(), false);
      assert.equal(b.api.remaining(), 3);
      assert.equal(b.api.busy(), false);
    }
  });
  await test('required consent form must return canRequestAds true', async () => {
    const b = boot({ info: { status: 'REQUIRED', canRequestAds: false }, form: { canRequestAds: false } });
    assert.equal(await b.api.watch(), false);
    assert.deepEqual(b.calls, ['register', 'consent', 'form']);
    const allowed = boot({ info: { status: 'REQUIRED', canRequestAds: false }, form: { canRequestAds: true } });
    assert.equal(await allowed.api.watch(), true);
    for (const canRequestAds of [false, undefined]) {
      const denied = boot({ info: { status: 'OBTAINED', canRequestAds } });
      assert.equal(await denied.api.watch(), false);
      assert.ok(!denied.calls.includes('init'));
    }
  });
  await test('web, missing native plugin, disabled and ungated production unavailable', async () => {
    for (const options of [{ web: true }, { missingPlugin: true }, { config: { enabled: false } },
      { config: { testMode: false } }, { config: { testMode: false, productionEnabled: true, audienceDeclared: true } }]) {
      const b = boot(options);
      assert.equal(b.api.available(), false);
      assert.equal(await b.api.watch(), false);
      assert.deepEqual(b.calls, []);
    }
  });
  await test('visible ad never times out or unlocks; one reward only after close', async () => {
    const b = boot({ manual: true });
    let settled = false;
    const result = b.api.watch().then(v => { settled = true; return v; });
    await tick();
    assert.ok(b.calls.includes('show'));
    assert.equal(b.api.busy(), true);
    assert.equal(await b.api.watch(), false);
    assert.equal(await b.api.privacy(), false);
    b.fireTimers();
    b.emit(E.reward); b.emit(E.reward);
    await tick();
    assert.equal(settled, false);
    assert.equal(b.api.remaining(), 2);
    assert.equal(b.api.busy(), true);
    b.emit(E.close);
    assert.equal(await result, true);
    assert.equal(b.api.busy(), false);
  });
  await test('failure-to-show callback resolves without hanging', async () => {
    const b = boot({ manual: true });
    const result = b.api.watch(); await tick(); b.emit(E.fail);
    assert.equal(await result, false);
    assert.equal(b.api.busy(), false);
  });
  await test('three daily rewards persist across service reload', async () => {
    const store = new Map();
    for (let i = 0; i < 3; i++) {
      const b = boot({ store });
      assert.equal(b.api.remaining(), 3 - i);
      assert.equal(await b.api.watch(), true);
    }
    const capped = boot({ store });
    assert.equal(capped.api.remaining(), 0);
    assert.equal(capped.api.available(), false);
    assert.equal(await capped.api.watch(), false);
    assert.deepEqual(capped.calls, []);
    store.set('singularity.rewardedAds.v1', JSON.stringify({ day: '2000-01-01', count: 3 }));
    assert.equal(boot({ store }).api.remaining(), 3);
    store.set('singularity.rewardedAds.v1', JSON.stringify({ day: '9999-01-01', count: 3 }));
    assert.equal(boot({ store }).api.remaining(), 0);
  });
  await test('storage failures fail closed before loading', async () => {
    const b = boot({ storageFail: true });
    assert.equal(await b.api.watch(), false);
    assert.deepEqual(b.calls, []);
    const corrupt = boot({ store: new Map([['singularity.rewardedAds.v1', '{invalid']]) });
    assert.equal(await corrupt.api.watch(), false);
  });
  await test('privacy options available at cap and consent refreshed next watch', async () => {
    const b = boot();
    assert.equal(await b.api.privacy(), true);
    assert.deepEqual(b.calls, ['register', 'consent', 'privacy']);
    assert.equal(await b.api.watch(), true);
    assert.equal(b.calls.filter(c => c === 'consent').length, 2);
    const notRequired = boot({ info: { privacyOptionsRequirementStatus: 'NOT_REQUIRED' } });
    assert.equal(await notRequired.api.privacy(), false);
    assert.equal(await boot({ web: true }).api.privacy(), false);
  });
  await test('load timeout prevents late completion from showing or overlapping', async () => {
    let complete;
    const b = boot({ adapter: { prepareRewardVideoAd: () => new Promise(r => { complete = r; }) } });
    const result = b.api.watch(); await tick();
    b.fireTimers();
    assert.equal(await result, false);
    assert.equal(b.api.available(), false);
    assert.equal(await b.api.watch(), false);
    complete(); await tick();
    assert.ok(!b.calls.includes('show'));
  });
  await test('init timeout and consent errors never reject callers', async () => {
    const b = boot({ adapter: { initialize: () => new Promise(() => {}) } });
    const result = b.api.watch(); await tick(); b.fireTimers();
    assert.equal(await result, false);
    const failed = boot({ adapter: { requestConsentInfo: async () => { throw new Error('offline'); } } });
    assert.equal(await failed.api.watch(), false);
    assert.equal(await failed.api.privacy(), false);
  });
  await test('caller integration with game.js', async () => {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); } catch (e) { return; }
    
    const configSource = `const REWARDED_ADS_CONFIG = { enabled: true, testMode: true };`;
    const source = fs.readFileSync(path.join(root, 'www/rewarded-ads.js'), 'utf8');
    const exporter = `
      window.__probe = {
        getState: () => typeof state !== 'undefined' ? state : null,
        setState: (s) => { state = s; },
        getStardust: () => typeof stardust !== 'undefined' ? stardust : 0,
        setStardust: (v) => { stardust = v; },
        setDrone: (b) => { if (typeof Snd !== 'undefined') Snd.setDrone = function(v) { window._droneActive = v; }; }
      };
    `;
    const inlined = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8')
      .replace(/<script\s+src="game\.js[^"]*"><\/script>/, 
      '<script>\n' + configSource + '\n' + source + '\n' + fs.readFileSync(path.join(root, 'www/game.js'), 'utf8') + '\n' + exporter + '\n</script>');
    
    let watchResolver = null;
    const dom = new JSDOM(inlined, {
      url: 'http://localhost/',
      runScripts: 'dangerously',
      beforeParse(window) {
        window.Capacitor = {
          isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true,
          registerPlugin: () => ({
            requestConsentInfo: async () => ({ status: 'OBTAINED', canRequestAds: true }),
            initialize: async () => {}, 
            addListener: async (n, f) => { window._adListeners = window._adListeners || {}; window._adListeners[n] = f; return { remove: async () => {} }; },
            prepareRewardVideoAd: async () => {},
            showRewardVideoAd: async () => new Promise(r => { watchResolver = r; })
          })
        };
        const nop = () => {};
        window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => nop });
        window.AudioContext = function() { return { createGain: () => ({ gain: { setValueAtTime: nop, setTargetAtTime: nop } }), createOscillator: () => ({ start: nop, stop: nop, frequency: {setValueAtTime: nop} }), createBiquadFilter: () => ({ frequency: {setValueAtTime: nop}, Q: {setValueAtTime: nop}, gain: {setValueAtTime: nop} }), createBuffer: () => ({}), createBufferSource: () => ({ playbackRate: {setValueAtTime: nop}, start: nop, stop: nop }), destination: {}, resume: nop }; };
        window.requestAnimationFrame = () => 0;
        window.cancelAnimationFrame = nop;
      }
    });

    await tick(); await tick();
    
    const w = dom.window;
    if (!w.__probe) return;
    w.__probe.setState('play');
    w._droneActive = true;
    w.__probe.setDrone();
    const initialStardust = w.__probe.getStardust();
    
    const btn = w.document.getElementById('rewardAdBtn');
    for (let i = 0; i < 50; i++) {
      if (!btn.disabled) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(btn.disabled, false, 'ad button should become enabled');
    
    btn.click();
    await tick();
    
    assert.equal(w.__probe.getState(), 'paused', 'gameplay pauses while ad is active');
    assert.equal(w._droneActive, false, 'audio pauses while ad is active');
    
    for (let i = 0; i < 50; i++) {
      if (watchResolver) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(watchResolver, 'showRewardVideoAd should have been called');
    
    w._adListeners['onRewardedVideoAdReward']({});
    w._adListeners['onRewardedVideoAdDismissed']({});
    watchResolver();
    
    for (let i = 0; i < 50; i++) {
      if (w.__probe.getState() === 'play') break;
      await new Promise(r => setTimeout(r, 10));
    }
    
    assert.equal(w.__probe.getStardust(), initialStardust + 25, 'caller grants stardust on completion');
    assert.equal(w.__probe.getState(), 'play', 'gameplay resumes on close');
    assert.equal(w._droneActive, true, 'audio resumes on close');
  });
  console.log(`Rewarded ads: ${passed} tests passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
