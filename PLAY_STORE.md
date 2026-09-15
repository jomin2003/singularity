# Getting SINGULARITY onto Google Play

Everything below is in the order you actually have to do it. The build itself
runs on GitHub Actions — you never need the Android SDK on this laptop.

> **Before any of this: get the game on your phone.**
> `.github/workflows/build-apk.yml` produces an installable **debug APK** that
> needs no keystore and no secrets. Push the repo, run the *Build Debug APK*
> workflow, download `singularity-debug-apk`, install it. Play it properly
> before you spend $25 on a Play account — if the game doesn't feel good, none
> of the rest of this matters.

**Requirements already satisfied by the code in this repo**

| Play requirement | Status |
|---|---|
| Signed **AAB** (APKs no longer accepted for new apps) | ✅ workflow produces `app-release.aab` |
| Target API **36** (Android 16) | ✅ `variables.gradle` → `targetSdkVersion = 36` |
| **16 KB page size** support | ✅ almost certainly N/A — the app ships no native `.so`. The CI job prints a warning if that ever changes |
| Play App Signing | ✅ enabled by default when you first upload |
| Privacy policy URL | ✅ `privacy.html` + Pages workflow |

---

## 0. Decide the package name — this is permanent

`capacitor.config.json` currently says:

```json
"appId": "com.jomin.singularity"
```

**Once you upload an AAB with this ID it can never be changed, and the Play
listing URL is derived from it.** If you want a different one, change it now in
`capacitor.config.json` *and* `android/app/build.gradle` (`applicationId`), then
run `npx cap sync android` before doing anything else.

---

## 1. Pay the registration fee and create the developer account

- One-off **US$25** at [play.google.com/console](https://play.google.com/console).
- Because this account is created **after 13 Nov 2023**, the closed-testing
  requirement applies to you (step 8). It is not optional and cannot be skipped.

---

## 2. Create the upload keystore (once, on this machine)

This key proves *you* are the one uploading. Keep it — but note that with Play
App Signing you **can** request a reset if you lose it, so it is not fatal.

**Git Bash:**

```bash
keytool -genkey -v -keystore singularity-upload.jks -keyalg RSA \
        -keysize 2048 -validity 10000 -alias singularity
```

Answer the prompts (name/org/city…). Use a real password you will not forget.

> ⚠️ **Never commit this file.** `.gitignore` already excludes `*.jks`.

---

## 3. Push the repo and add the four secrets

```bash
git init && git add . && git commit -m "SINGULARITY 1.0"
git remote add origin <your-repo-url>
git push -u origin main
```

Then **Settings → Secrets and variables → Actions → New repository secret**,
adding each of these:

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | base64 of the `.jks` file |
| `KEYSTORE_PASSWORD` | keystore password |
| `KEY_ALIAS` | `singularity` |
| `KEY_PASSWORD` | key password |

To produce `KEYSTORE_BASE64`:

```bash
# Git Bash -- the -w0 matters, no line breaks
base64 -w0 singularity-upload.jks > ks.b64
```

```powershell
# PowerShell alternative (copies straight to clipboard)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("singularity-upload.jks")) | Set-Clipboard
```

Paste the single long line in. No trailing newline, no `-----BEGIN`.

---

## 4. Build the AAB

**Actions → Build Release AAB → Run workflow.**

About 5–10 minutes. When it finishes, download the artifact
`singularity-release-aab`. The job also prints whether any `.so` files ended up
in the bundle.

> If it fails at the *sync* step, you changed `appId` — re-run
> `npx cap sync android` locally and commit.

---

## 5. Turn on the privacy policy URL

**Settings → Pages → Source: GitHub Actions.** Push `privacy.html` (or run the
*Deploy Privacy Policy* workflow). Your URL will be:

```
https://<username>.github.io/<repo>/privacy.html
```

You need this string in step 7. Do this before creating the app, because you
cannot save the listing without it.

---

## 6. Create the app

**Play Console → Create app**, then fill in: app name `SINGULARITY`, default
language, **App** (not Game — unless you prefer Game; either is fine, "Game"
gives you a game category), free, and accept the declarations.

---

## 7. Store listing

Upload from this repo:

| Field | File |
|---|---|
| App icon | `store/icon-512.png` (512×512) |
| Feature graphic | `store/feature-graphic-1024x500.png` (1024×500) |
| Screenshots | `store/screenshots/phone-*.png` (real renders of the b18 build, 824×1784) |

**Short description** (80 chars):

```
You are a black hole. Consume, grow, survive.
```

**Full description** (4000 chars max):

```
You are a gravity well drifting through a decaying field of matter.

Drag to move. Swallow everything smaller than you and grow. Touch anything
larger and you collapse.

The rules are one sentence deep, but the field fights back: matter spawns
faster as you grow, the camera pulls away, and your mass bleeds away between
meals. Chain your feeds without pausing to build a combo multiplier — long
chains detonate a shockwave that clears the screen.

Colour is the whole language. Cyan and violet are food. Amber and red will
kill you. Learn to read the field at a glance.

SINGULARITY is completely offline. No ads, no accounts, no analytics, no
in-app purchases, no network calls of any kind. Every pixel is drawn live on
your device; the ambient soundtrack plays from files bundled in the app.

One more run.
```

**Screenshots** — `store/screenshots/` already contains real renders of the
current build, captured from the game itself in a headless browser (the
`?shot=play` boot hook in `game.js` starts a run automatically). They are
genuine gameplay, but re-capture from the shipped build once you can install
it on a phone — it looks better and doubles as a device test:

```bash
adb exec-out screencap -p > shot1.png
```

---

## 8. The questionnaires

Work through each of these in the left sidebar — they gate the release:

- **Content rating** — answer honestly. Abstract shapes, no violence, no
  realistic weapons, no user-generated content, no gambling, no ads → you
  should land on the lowest rating.
- **Target audience** — **not** child-directed. The app collects nothing.
- **Data safety** — this matters most. Declare:
  - **No data collected**
  - **No data shared with third parties**
  - Encryption: N/A (nothing transmitted)
  - No independent security review
  - Link the privacy policy URL from step 5.
- **App access** — all functionality is available with no login or special access.
- **Ads** — the app contains no ads.

---

## 9. Closed testing — 12 testers, 14 days, real usage

This is the part that trips up new personal accounts.

**Testing → Closed testing → Create track.** Add at least **12** testers by
email (add 15–20; some will not accept). They get an opt-in URL, then install
from Play.

Three things that will get you rejected if you get them wrong:

1. **14 *continuous* days.** The clock restarts if the track goes empty. Don't
   remove testers mid-run.
2. **Testers must actually use it.** Since 2026 Google checks engagement —
   installs that sit untouched do not count. Ask each tester to open the game
   and play a couple of runs a day. A dead track fails even at day 14.
3. Upload the **same** AAB to the closed track first; do not create a separate
   production release yet.

When the 14 days are up, the **Apply for production** button unlocks. You fill
in a short form describing who tested it and for how long, then submit.

---

## 10. Release

**Production → Create new release.** Upload the AAB, write release notes
(`1.0 — first release`), roll out to 100%, and submit.

Typical review: a few days. If you are asked for anything, it is almost always
screenshots, the privacy URL, or proof of the closed test.

---

## Updating later

Every update needs a **higher `versionCode`** in
`android/app/build.gradle` — bump `versionCode` and `versionName`, commit, tag,
push:

```bash
git tag v1.1 && git push --tags
```

Tagged pushes trigger the build automatically.

---

## Timing reality check: "one day after" production is not possible for a new
## personal account

The closed-testing gate in step 9 is enforced by Google, not by this repo:
**12 testers opted in continuously for 14 days** before the *Apply for
production* button even appears, and Google now checks that testers actually
played. Plan the calendar accordingly — the fastest honest path is: upload the
AAB to the closed track on day 0, recruit the testers before you upload, and
submit for production on day 15+. If the developer account already has
production access from a previous app, the track requirement does not apply and
a next-day release is possible.

---

## Known trade-offs worth knowing

- **`INTERNET` permission is declared but unused.** Capacitor's WebView is
  happier with it (the `https` asset scheme lives in the WebView stack), and
  the Data safety form still truthfully says "no data collected" — a permission
  is not a collection. Do not remove it without a device test.
- **`VIBRATE` is now declared** — the haptics setting drives
  `navigator.vibrate()`, which the Android WebView refuses to act on without
  that permission. Verify haptics on a real device.
- **The SHARE button goes through `@capacitor/share` + `@capacitor/filesystem`**
  inside the app (the WebView has no Web Share API); the Web Share / clipboard
  / download paths remain for the browser build. Verify on a device.
- **Backups are off** (`allowBackup="false"`) so the privacy policy's "your
  data never leaves your device" is literally true.
- **The app ships a ~22 MB MP3 soundtrack** (`www/audio/`, regenerated by
  `npm run assets:music`) and stores it uncompressed — that is what keeps the
  APK above 20 MB, and it doubles as an actual feature: five era-themed ambient
  tracks following the MUSIC slider.
- **Still not verified on a physical device.** The game boots and plays
  headlessly (67/67 smoke checks, real-render screenshots), but install the
  closed-test build and play it on a phone before you submit anything to
  production.
