# SINGULARITY — Bug Audit

**Scope:** deep bug audit of the local clone at `~/workspace/singularity`
(HEAD `f93ad15`, `www/game.js` 6,440 lines). Real bugs only — no style nits.
**No game files were modified** in the course of this audit.

**Verification methods used:**
- Full read of `www/game.js`, `www/index.html`, `www/rewarded-ads.js`,
  `www/ads-config.js`, `www/sw.js`, `capacitor.config.json`, `package.json`,
  `android/app/src/main/AndroidManifest.xml`,
  `android/app/src/main/java/com/jomin/singularity/MainActivity.java`,
  `android/app/build.gradle`, `android/app/capacitor.build.gradle`,
  `.github/workflows/{build-apk,build-aab,pages}.yml`.
- `node --check www/game.js` passes.
- All 5 headless suites pass locally: smoke (92/92), progression (16/16),
  feel (12/12), design (7/7), rewarded_ads (14/14). These boot the full game
  in jsdom and exercise play, so they rule out whole classes of crashers —
  but several bugs below are in paths the harnesses never assert on.
- Every literal `getElementById()` in `game.js` was checked against
  `index.html`: all targets exist (see "Verified OK").
- `python3 tools/sync_build.py --check` passes; asset versioning (`?v=b23`)
  is consistent.
- AdMob event names in `rewarded-ads.js` were checked against the installed
  `@capacitor-community/admob@8.1.0` plugin source: all match.

Severity: **High** = breaks a promised feature, corrupts progression/currency,
or makes the game materially unfair/unreproducible. **Medium** = wrong
behaviour a player will notice. **Low** = edge case, cosmetic, or minor
inconsistency.

---

## HIGH

### 1. Era chips, threat readout, and scale readout render into a `display:none` graveyard — three HUD systems are invisible
- **Files/lines:** `www/game.js` `updateHUD()` lines 4502–4523 (writes);
  `www/index.html` lines 350–356 (targets).
- **Explanation:** `updateHUD()` builds the era/shield/spin/control chips
  (`el.chips`, lines 4502–4508), the `THREAT …` line (`el.threatOut`, lines
  4512–4515), and the physical scale readout (`el.scaleOut`, lines 4520–4523).
  The *only* elements with those IDs live inside
  `<div id="graveyard" style="display:none">` (index.html 350–353), so all
  three systems are computed every frame and painted into nodes the player
  can never see. The settings screen even has a "Threat readout" toggle that
  currently toggles nothing visible. This looks like a buried-system restore
  that was wired as a hidden compatibility hook instead of real HUD.
- **Fix:** move `#chips` into `#hud` (next to the score), and `#threatOut` /
  `#scaleOut` into visible HUD containers; delete the graveyard copies.
  (Note: `menuSettingsBtn`, `ctrlPick`, `ctrlHint` are duplicated in the
  graveyard too — `getElementById` resolves to the earlier, real menu nodes,
  so they still work, but the duplicate IDs are invalid HTML; remove the
  graveyard copies.)

### 2. The daily "one attempt" rule can be bypassed with unlimited retries
- **Files/lines:** `www/game.js` `startDaily()` 5073–5082; `die()` 2543–2547;
  `start()` 4600.
- **Explanation:** `startDaily()` shows a "DAILY RUN — one attempt" toast and
  sets `dailyRun = true`, but the attempt is only recorded as consumed in
  `die()` (`saveSet('daily', todayStr())`, lines 2543–2547). Any exit that
  isn't death — HOME button → `toMenu()`, pause → home, closing a panel —
  leaves `save.daily` unset, so tapping DAILY RUN again starts a fresh
  attempt on the *same* daily seed (`dailySeedInt()` is date-derived).
  `start()` even resets `dailyRun = false` (line 4600), so a retry is a clean
  slate. The one-attempt promise is unenforceable.
- **Fix:** persist the attempt at launch: in `startDaily()`, call
  `saveSet('daily', todayStr())` *before* `start()`. (If a grace period for
  accidental taps is wanted, record a timestamp and allow re-entry within
  e.g. 60 s — but the current code promises one attempt.)

### 3. Civilisation spawns are frame-rate dependent — seeded runs are not reproducible across devices
- **Files/lines:** `www/game.js` line 3004:
  `if (state === 'play' && score > CIV_ALERT && rng() < 0.0025) spawnCiv();`
- **Explanation:** the spawn check runs once per rendered update with a fixed
  per-frame probability. The adjacent comment promises "roughly one
  installation every 7 seconds" — true only at 60 Hz (0.0025 × 60 ≈ 1/6.7 s).
  At 30 Hz it's ~13 s, at 120 Hz it's ~3.3 s, and because the check consumes
  the seeded `rng()` stream a frame-dependent number of times, the entire
  run diverges across devices — seeded/daily runs are not reproducible.
- **Fix:** make it time-based, e.g. accumulate `civTimer += dt` and spawn
  when it exceeds `1/0.15` s, or use a dt-scaled probability
  `rng() < 1 - Math.exp(-0.15 * dt)`. Keep all `rng()` calls on the
  simulation path only (cosmetic code already correctly uses
  `cosmeticRandom()`).

### 4. Quasar jets are visual only — the rendered hazard has no collision
- **Files/lines:** `www/game.js` `drawEnts()` 3779–3801 (jets rendered at
  `jl = e.r * 5.5`, sweeping with `jetA`); collision loop ~2920–2958;
  `CAUSE.quasar` = `'VAPORISED BY A QUASAR JET'` (2193).
- **Explanation:** the code comment says "the jets are what actually kills
  you", and jets are drawn sweeping around the core out to 5.5× the body
  radius, but collision only ever tests the body circle (`edibleAt` /
  `hurt(e)` with body reach). The death message blames the jet even when the
  player merely touched the core. Either the jets should kill (as drawn and
  as messaged) or they shouldn't be drawn as a sweeping hazard.
- **Fix:** add segment collision for both jet cones: transform the player
  position into the quasar's rotated frame (`jetA`), test distance to each
  jet segment (length `5.5 * e.r`, half-width growing 0.10→0.30 `e.r`),
  and route jet kills through `hurt()`/`CAUSE.quasar` with the normal
  invulnerability rules.

---

## MEDIUM

### 5. Mass-driver slugs knock the player *toward* the shooter
- **Files/lines:** `www/game.js` `updateSlugs()` 3274–3283.
- **Explanation:** on impact, `dx = s.x - p.x` (vector from player to slug)
  and the player gets `p.vx += dx/d * 3 * p.r` — a shove toward the
  incoming round, i.e. toward the civilisation battery that fired it. The
  comment says the slugs "are trying to deflect you, not kill you outright";
  deflecting the player *into* the attacker is backwards — being hit should
  push the player along the round's travel direction (or radially away from
  the impact).
- **Fix:** apply the impulse along the slug's normalized velocity
  (`s.vx, s.vy`) instead of the player→slug vector.

### 6. The ABSORB shockwave pick bypasses all ingestion accounting
- **Files/lines:** `www/game.js` `pickAbsorb()` 5115–5147 vs `consume()` 6369+.
- **Explanation:** `pickAbsorb()` adds mass/score directly and splices bodies
  out instead of calling `consume()`. It therefore skips: `totalEaten++` /
  `runEaten++` (Observatory stats), field-guide discovery, stardust bonuses
  for stars/wormholes/magnetars/pulsars/quasars, eat_* achievements, `feast`
  skin progress (100 bodies in one run), and the `lastMealT = elapsed`
  update. The last one is the sharpest: `checkSkinUnlocks()` (6394) awards
  the `fasting` skin for "120 s without eating", which a player can earn
  while eating constantly via ABSORB.
- **Fix:** route each absorbed body through the same accounting `consume()`
  performs — extract a shared `ingest(e)` helper with effects suppressible,
  or call `consume()` with an effects-off flag.

### 7. Pending rewarded-ad payout is not atomic — a crash can double-grant stardust
- **Files/lines:** `www/game.js` `checkPendingReward()` 6100–6114.
- **Explanation:** the reward is applied in three separate steps:
  `earnStardust(...)` (saves stardust), then `saveSet('rewardId', pendingId)`,
  then `ads.clearPendingReward()`. If the app is killed between the first
  and second write, the next boot sees the same `pendingRewardId` with a
  different `save.rewardId` and grants the stardust again.
- **Fix:** write stardust and the processed reward ID in a single
  `saveProgression` snapshot before clearing the ledger entry.

### 8. Earned ad reward is lost if the UTC day rolls over before the game applies it
- **Files/lines:** `www/rewarded-ads.js` `ledger()` 32–40;
  reward listener 105–112; `getPendingReward()` 152–157.
- **Explanation:** on day rollover `ledger()` returns a fresh
  `{ day, count: 0 }`, discarding `pendingRewardId`. If the native reward
  fires near midnight and the game reads `getPendingReward()` after the UTC
  date changes (app backgrounded, resumed tomorrow), the earned reward
  silently disappears.
- **Fix:** preserve `pendingRewardId` across the rollover:
  `return value.day < day ? { day, count: 0, pendingRewardId: value.pendingRewardId } : value`.

---

## LOW

### 9. Ghost recording is not validated on load
- **Files/lines:** `www/game.js` `loadGhost()` 206–213.
- **Explanation:** only checks that `x`/`y` are equal-length non-empty arrays.
  Non-finite or non-numeric samples (corrupt/tampered save) flow into
  `drawGhost()`'s `lerp`/canvas calls; canvas silently ignores non-finite
  args, so the ghost just vanishes, and a huge injected array is accepted
  unbounded. (Recording itself is capped at 3600 samples — line 2716 — but
  loading is not.)
- **Fix:** on load, verify every sample is a finite number and cap length
  (e.g. 3600); reject the recording otherwise.

### 10. Ghost playback is off by one sample (~0.1 s ahead)
- **Files/lines:** `www/game.js` recording 2711–2719; `drawGhost()` 3609–3630;
  timestamp discard in `die()` 2553–2557.
- **Explanation:** the first sample is recorded on the first 0.1 s tick, but
  playback treats array index 0 as t = 0 (`gi = Math.floor(elapsed * 10)`),
  so the ghost runs ~0.1 s ahead of the player's historical position. The
  recording even stores per-sample timestamps (`q[0]`), but `die()` drops
  them and keeps only x/y.
- **Fix:** keep the timestamps in the save and look the sample up by time,
  or shift the playback index by the first sample's timestamp.

### 11. "Ad privacy choices" button is shown where it can never work
- **Files/lines:** `www/game.js` line 6082:
  `privacyBtn.classList.toggle('hidden', !(ads && ads.privacy))`.
- **Explanation:** `ads.privacy` always exists (it's part of the frozen API),
  so the visibility check passes on web and anywhere the native plugin is
  unsupported — but `privacy()` returns `false` immediately without
  `supported()`. Users see a control that can never open anything.
- **Fix:** gate visibility on actual availability, e.g. expose an
  `ads.privacyAvailable()` predicate (plugin present + requirement status).

### 12. Post-ad audio resumes while the Observatory is still open
- **Files/lines:** `www/game.js` 6116–6132.
- **Explanation:** the offer button lives in the Observatory, which sets
  `state = 'paused'`, so `previousState` is never `'play'` and the
  `resumeGame()` branch is dead for this placement. The fallback
  `Snd.setDrone(true, combo)` then restarts music/drone while the panel is
  still open and the game paused. (Closing the panel later calls `toMenu()`,
  which stops the drone — so it self-corrects, but the interim state is wrong.)
- **Fix:** only re-enable the drone when actually returning to gameplay;
  otherwise leave audio stopped while a panel is open.

### 13. `obs-upgrade-rules` has no CSS rule — the Observatory rules paragraph is unstyled
- **Files/lines:** `www/game.js` line 6184 (`rules.className = 'obs-upgrade-rules'`);
  no matching selector in `www/style.css`.
- **Explanation:** the paragraph explaining upgrade rules
  ("Upgrades apply to ordinary runs only…") renders with plain inherited
  styles instead of the Observatory's typography. Every other dynamically
  created class in `game.js` was verified to have a rule; this is the only
  miss.
- **Fix:** add an `.obs-upgrade-rules` rule to `style.css`.

### 14. Mass-driver slugs ignore invulnerability and shields
- **Files/lines:** `www/game.js` `updateSlugs()` 3271–3289.
- **Explanation:** slug hits apply mass loss unconditionally during `play`,
  bypassing the post-hurt `invuln` window and the pulsar `shield` (both of
  which `hurt()` respects). A slug landing during the grace window still
  chips mass.
- **Fix:** skip slug damage while `invuln > 0`, and let `shield > 0` absorb
  a slug hit like any other impact.

### 15. Danger arrows / threat readout flag dark matter as a THREAT though it cannot collide
- **Files/lines:** `www/game.js` `drawDangerArrows()` ~3641–3665;
  `threatLine()` 4417–4434; collision skip `if (e.darkMatter) continue;`.
- **Explanation:** dark matter has no collision and only pulls, yet any
  off-screen dark-matter mass bigger than the player draws a danger arrow
  and can set the `THREAT n.n× DIR` readout. The lensing rings already make
  it detectable by design; labeling a non-lethal pull a "THREAT" is
  misleading.
- **Fix:** exclude `e.darkMatter` in `drawDangerArrows()` and `threatLine()`
  (or label it distinctly, e.g. `GRAVITY ANOMALY`).

### 16. A consent/prepare timeout permanently disables ads for the session, against the code's own comment
- **Files/lines:** `www/rewarded-ads.js` `bounded()` 56–65; `consent()` ~69–76;
  `prepareRewardVideoAd` call ~121.
- **Explanation:** the comment on `bounded()` says timeouts are "never used
  on a consent/privacy form or show call: those may legitimately remain
  visible" — but `requestConsentInfo` (15 s) and `prepareRewardVideoAd`
  (30 s) *are* bounded, and any timeout sets `blocked = true`, which is
  never cleared except by reload. One slow network on first launch kills ads
  for the whole session.
- **Fix:** don't set the session-kill `blocked` flag for consent/prepare
  timeouts (retry on next attempt instead), matching the documented intent.

### 17. `www/design.css` (22 KB) is unlinked but still ships inside the APK
- **Files/lines:** `www/index.html` (no `<link>` to `design.css`);
  `www/design.css` (22,335 bytes, exists on disk).
- **Explanation:** the stylesheet was deliberately unlinked (per the
  sync_build.py ASSETS change) but the file remains in `www/`, so
  `cap sync` bundles 22 KB of dead CSS into every APK/AAB.
- **Fix:** delete `www/design.css` (confirm no remaining references first —
  none were found in `index.html`, `android/`, or JS).

---

## Verified OK (checked, not bugs)

- **`getElementById` audit:** every literal `getElementById()` target in
  `game.js` exists in `index.html`, except `skinPickerLabel`, which is
  intentionally created dynamically by `renderSkinPicker()` — valid.
- **Duplicate IDs** (`menuSettingsBtn`, `ctrlPick`, `ctrlHint` in both the
  menu and `#graveyard`): `getElementById` resolves to the earlier, real
  menu nodes, so wiring is unaffected today; still invalid HTML worth
  cleaning (see bug 1 fix).
- **Rewarded-ad event names** (`onRewardedVideoAdReward/Dismissed/FailedToShow`,
  `prepareRewardVideoAd`, `showRewardVideoAd`, consent/privacy APIs) all match
  the installed `@capacitor-community/admob@8.1.0` — no indefinite-wait risk
  from mismatched listeners.
- **Shockwave pick center timing:** the 0.6 s center dwell matches the
  on-screen progress bar (`holds[i] / (i === 1 ? 0.6 : 0.35)`) — documented
  UI behaviour, not a bug. The `pickT <= 0` timeout branch is effectively
  unreachable but harmless.
- **Seeded determinism** was checked for cosmetic-path leaks: all visual/audio
  jitter uses `cosmeticRandom()` (= `Math.random()`), never the sim `rng()` —
  except bug 3, which is a *sim*-path rate bug, not a leak.
- **CI workflows:** `build-apk.yml` / `build-aab.yml` order Node → tests →
  asset check → `cap sync` → JDK 21 → SDK → XML validation → Gradle, which
  satisfies `capacitor.settings.gradle`'s `node_modules` requirement and the
  gitignored `capacitor-cordova-android-plugins` regeneration; keystore
  handling in the AAB job uses absolute paths and always-cleanup.
  `AndroidManifest.xml` is valid (no `--` in comments); `admob_app_id`
  resolves via the `resValue` in `app/build.gradle`.
- **Tests:** all 137 headless checks pass; `sync_build.py --check` passes.
