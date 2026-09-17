/* Classic Capacitor bridge; no web implementation and no simulated rewards. */
(function (w) {
  'use strict';
  if (w.RewardedAds) return;
  const input = w.REWARDED_ADS_CONFIG || {};
  const TEST_ID = 'ca-app-pub-3940256099942544/5224354917';
  const config = Object.freeze({
    enabled: input.enabled !== false,
    testMode: input.testMode !== false,
    productionEnabled: input.productionEnabled === true,
    audienceDeclared: input.audienceDeclared === true,
    androidRewardedAdUnitId: input.androidRewardedAdUnitId || '',
    tagForChildDirectedTreatment: input.tagForChildDirectedTreatment === true,
    tagForUnderAgeOfConsent: input.tagForUnderAgeOfConsent === true,
    rewardAmount: 25,
    dailyLimit: 3
  });
  const KEY = 'singularity.rewardedAds.v1';
  let adapter, locked = false, blocked = false, initialized = false;
  const cap = w.Capacitor;
  function supported() {
    try {
      return !!(cap && cap.isNativePlatform() && cap.getPlatform() === 'android' &&
        cap.isPluginAvailable('AdMob'));
    } catch (_) { return false; }
  }
  function configured() {
    return config.enabled && (config.testMode || (config.productionEnabled &&
      config.audienceDeclared && /^ca-app-pub-\d{16}\/\d{10}$/.test(config.androidRewardedAdUnitId) &&
      !config.androidRewardedAdUnitId.startsWith('ca-app-pub-3940256099942544/')));
  }
  function ledger() {
    const day = new Date().toISOString().slice(0, 10); // UTC; rollback cannot reset today's cap.
    const raw = w.localStorage.getItem(KEY);
    if (raw === null) return { day, count: 0 };
    const value = JSON.parse(raw);
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
        !Number.isInteger(value.count) || value.count < 0 || value.count > 3) throw new Error('Invalid cap');
    return value.day < day ? { day, count: 0 } : value;
  }
  function remaining() {
    try { return Math.max(0, config.dailyLimit - ledger().count); }
    catch (_) { return 0; } // Fail closed if storage is corrupt or inaccessible.
  }
  function available() {
    return configured() && supported() && !blocked && !locked && remaining() > 0;
  }
  function native() {
    if (!adapter) adapter = cap.registerPlugin('AdMob');
    return adapter;
  }
  // Native requests cannot be cancelled. On timeout, disable this service until
  // reload rather than letting a late load overlap a new request. Never used on
  // a consent/privacy form or show call: those may legitimately remain visible.
  function bounded(work, ms) {
    return new Promise((resolve, reject) => {
      const timer = w.setTimeout(() => { blocked = true; reject(new Error('Native timeout')); }, ms);
      Promise.resolve().then(work).then(value => {
        w.clearTimeout(timer); resolve(value);
      }, error => { w.clearTimeout(timer); reject(error); });
    });
  }
  function consentOptions() {
    return { tagForUnderAgeOfConsent: config.tagForUnderAgeOfConsent };
  }
  async function consent(ad) {
    let info = await bounded(() => ad.requestConsentInfo(consentOptions()), 15000);
    if (info.status === 'REQUIRED') info = await ad.showConsentForm();
    return info.canRequestAds === true;
  }
  async function watch() {
    if (!available()) return false;
    locked = true;
    let terminal = false, showing = false, earned = false;
    const handles = [];
    try {
      // Verify persistence before asking the player to watch anything.
      w.localStorage.setItem(KEY, JSON.stringify(ledger()));
      const ad = native();
      if (!await consent(ad)) return false;
      if (!initialized) {
        await bounded(() => ad.initialize({
          initializeForTesting: config.testMode,
          tagForChildDirectedTreatment: config.tagForChildDirectedTreatment,
          tagForUnderAgeOfConsent: config.tagForUnderAgeOfConsent
        }), 15000);
        initialized = true;
      }
      let finish;
      const outcome = new Promise(resolve => {
        finish = result => {
          if (terminal) return;
          terminal = true;
          resolve(result === true);
        };
      });
      async function listen(event, callback) {
        await bounded(async () => {
          const handle = await ad.addListener(event, callback);
          if (terminal) { Promise.resolve(handle.remove()).catch(() => {}); }
          else handles.push(handle);
        }, 10000);
      }
      await listen('onRewardedVideoAdReward', () => {
        if (!showing || terminal || earned) return;
        // The native earned event is the sole authority. Ignore SDK amount/type;
        // the game caller grants the fixed 25 only on watch() === true.
        try {
          const value = ledger();
          if (value.count >= config.dailyLimit) return;
          value.count++;
          value.pendingRewardId = Date.now().toString(36) + Math.random().toString(36).slice(2);
          w.localStorage.setItem(KEY, JSON.stringify(value));
          earned = true;
        } catch (_) { /* No persisted cap, no reward. */ }
      });
      await listen('onRewardedVideoAdDismissed', () => { if (showing) finish(earned); });
      await listen('onRewardedVideoAdFailedToShow', () => { if (showing) finish(false); });
      const adId = config.testMode ? TEST_ID : config.androidRewardedAdUnitId;
      await bounded(() => ad.prepareRewardVideoAd({ adId, isTesting: config.testMode }), 30000);
      showing = true;
      // Plugin show promise resolves at reward, not dismissal; early close can
      // leave it pending forever. Do not await it or treat resolution as reward.
      try {
        Promise.resolve(ad.showRewardVideoAd({ adId })).catch(() => finish(false));
      } catch (_) { finish(false); }
      return await outcome;
    } catch (_) {
      return false;
    } finally {
      terminal = true;
      for (const handle of handles) {
        try { Promise.resolve(handle.remove()).catch(() => {}); } catch (_) { /* best effort */ }
      }
      locked = false;
    }
  }
  async function privacy() {
    if (!supported() || locked || blocked) return false;
    locked = true;
    try {
      const ad = native();
      const info = await bounded(() => ad.requestConsentInfo(consentOptions()), 15000);
      if (info.privacyOptionsRequirementStatus !== 'REQUIRED') return false;
      await ad.showPrivacyOptionsForm(); // No UI timeout. Consent refreshed on next watch.
      return true;
    } catch (_) { return false; }
    finally { locked = false; }
  }
  function getPendingReward() {
    try {
      const value = ledger();
      return value.pendingRewardId || null;
    } catch (_) { return null; }
  }
  function clearPendingReward() {
    try {
      const value = ledger();
      if (value.pendingRewardId) {
        delete value.pendingRewardId;
        w.localStorage.setItem(KEY, JSON.stringify(value));
      }
    } catch (_) {}
  }
  w.RewardedAds = Object.freeze({ available, busy: () => locked, remaining, watch, privacy, config, getPendingReward, clearPendingReward });
})(window);
