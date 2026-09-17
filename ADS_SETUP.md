# Optional rewarded ads (Android, test configuration)

This is a native AdMob service, **not a production-ready monetization release**. It uses `@capacitor-community/admob` exactly `8.1.0`, installed with `npm install --save-exact @capacitor-community/admob@8`, compatible with Capacitor 8. No browser fallback or simulated rewards exist.

## Integration contract

Load `www/ads-config.js`, then `www/rewarded-ads.js`, before the game caller, as ordinary scripts after the Capacitor bridge is available. This service change does not edit `index.html`, `game.js`, CSS, or workflows; the UI/caller integration is separate.

`window.RewardedAds` exposes:

- `available(): boolean`: supported Android bridge/plugin, enabled configuration, cap remaining, and not busy/timeout-disabled. This is eligibility, not a guarantee of consent or ad inventory. It does not initialize or request an ad.
- `busy(): boolean`: a watch or privacy operation owns the service.
- `remaining(): number`: remaining local rewards out of three per UTC day, independent of availability.
- `watch(): Promise<boolean>`: true only when a real native earned-reward event occurred before dismissal and the cap was persisted. False on early close, denial, load/show failure, unsupported web, overlap, or cap. Never grant currency from the dismissal event alone or from the SDK show promise.
- `privacy(): Promise<boolean>`: requests UMP information and opens `showPrivacyOptionsForm()` when required. True means the form completed, not that consent was granted. Works even after the daily reward cap. Expose an accessible privacy-choices entry in settings; do not hide it based on `available()`.
- `config`: frozen effective configuration, including `testMode`, `productionEnabled`, `rewardAmount: 25`, and `dailyLimit: 3`.

The game caller must offer the ad voluntarily, explain “watch for 25 stardust” before the click, and grant exactly 25 stardust **once** only when its single awaited `watch()` returns true. Do not use SDK reward amount/type. Disable duplicate clicks, pause gameplay/audio while native UI is open, and restore the previous state afterward. Ads must not gate ordinary play.

The service registers `Capacitor.registerPlugin('AdMob')` lazily. UMP `requestConsentInfo()` runs before each watch, `showConsentForm()` runs when status is REQUIRED, and `canRequestAds === true` is required before SDK initialization/loading. Privacy changes are rechecked on the next watch. Do not bypass this gate or equate OBTAINED with permission to request ads.

## Test IDs and native setup

The defaults request Google's Android rewarded test unit `ca-app-pub-3940256099942544/5224354917` with `isTesting: true`. The Android manifest references the Gradle-generated `@string/admob_app_id`, whose default is Google's sample app ID `ca-app-pub-3940256099942544~3347511713`. App IDs contain `~`; rewarded unit IDs contain `/`. Never interchange them.

After dependency/config changes run `npm run sync` (or `npx cap sync android`) before building. Capacitor generates plugin registration and Gradle dependencies; no manual MainActivity registration is needed. Use the project's JDK 21 / Android SDK 36 requirements. Validate a native build and then exercise actual UMP/test ads on a supported device; JavaScript mocks alone do not prove SDK integration.

## Before considering a real release

1. Create/verify the actual AdMob account and Android app, complete applicable app/account verification, and create a rewarded ad unit. Follow AdMob's current app-ads.txt and store-linking requirements where applicable.
2. Configure and publish the applicable UMP privacy messages in AdMob. Supply a real privacy policy, explain Google advertising data processing, and update Play Data safety and Contains ads declarations accurately. UMP is not a substitute for reviewing all applicable consent/privacy obligations.
3. Review the actual audience and Play target-audience declaration, including child-directed treatment, under-age-of-consent handling, and any Families obligations. The default false flags are test configuration, **not an audience assessment**. Mixed-age audiences may require an age-screening design before enabling ads; this service does not implement one.
4. Explicitly configure `window.REWARDED_ADS_CONFIG` before the scripts, or edit `www/ads-config.js`: set `testMode: false`, `productionEnabled: true`, `audienceDeclared: true`, and `androidRewardedAdUnitId` to the real rewarded unit. Set `tagForChildDirectedTreatment` and `tagForUnderAgeOfConsent` to the reviewed appropriate values. Missing production gate/audience declaration/valid non-sample unit leaves ads disabled. Configuration is captured at script load.
5. Set the native app ID independently via Gradle property `ADMOB_APP_ID`, e.g. `-PADMOB_APP_ID=YOUR_REAL_ADMOB_APP_ID` on the Android build command, or a local Gradle properties file. Changing the JavaScript unit does not change the manifest app ID. No real IDs are supplied here.
6. Sync, build, and verify the merged manifest, device consent flow, privacy choices, earned reward, early dismissal, offline/no-fill, background/resume, repeated taps, and cap/restart. Use Google's test IDs/test devices during development; never click your own live ads. Do not distribute the sample/test configuration as finished monetization.

`DELAY_APP_MEASUREMENT_INIT` is enabled in the manifest and explicit SDK initialization is lazy, but this is not a claim of zero native SDK startup behavior or zero data collection. Review the merged SDK manifest and policy declarations.

## Lifecycle and limitations

Installed Java/Kotlin source confirms `onRewardedVideoAdReward` is emitted on earned reward; the show promise resolves then, while dismissal has its own `onRewardedVideoAdDismissed` event and early close can leave the show promise pending. The service latches and persists one earned reward, keeps the lock until dismissal, removes its listeners, and ignores callbacks after that attempt is terminal. It never uses `removeAllListeners()` or a visible-ad timeout.

Consent-info/init requests are bounded at 15 seconds, listener registration at 10 seconds, and ad loading at 30 seconds. Because these native calls cannot be cancelled, a timeout disables watches until reload rather than allowing late requests to overlap. Consent/privacy forms and the ad presentation have no timer; if the native SDK never reports completion, the lock stays held rather than permitting a second native UI. Normal denial/no-fill may be retried.

The cap uses a separate localStorage key `singularity.rewardedAds.v1`; it does not modify the game save. The UTC day resets when the stored day is older, not when the clock moves backward. Storage corruption/inaccessibility fails closed. Storage is checked before requesting ads and the count persists at the first earned event, before returning true. A process death between earning and the caller crediting currency can therefore consume a slot without credit; there is no atomic cross-file transaction or replay reward. Clearing app data, tampering, multiple WebViews, and cross-device caps are not prevented. Server-side verification/account-backed accounting would be separate work if that level of enforcement is needed.

## Tests

Run `npm test`: smoke, progression, feel, design, and `tools/rewarded_ads_test.cjs`. The new Node VM suite mocks the actual native API and covers successful reward, duplicate callback, early-close/late reward, show-promise-only behavior, load/show failures, UMP denial/missing canRequestAds, web/unconfigured production, overlapping calls, no visible timeout, listener cleanup, privacy, persistent cap/reload/day rollover, storage failures, and bounded-request timeout safety. It does not use a browser or make real ad requests.
