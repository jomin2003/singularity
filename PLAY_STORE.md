# Getting SINGULARITY onto Google Play

Everything below is in the order you actually have to do it. The build itself
runs on GitHub Actions — you never need the Android SDK on this laptop.

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
| Screenshots | ⚠️ **you must capture these yourself** — see below |

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
in-app purchases, no network calls of any kind. Every sound and every pixel is
generated live on your device.

One more run.
```

**Screenshots** — Play requires at least 2, and they must show the real app.
Install the build from your closed test track on a phone and grab:

```bash
adb exec-out screencap -p > shot1.png
```

Recommended 4: the title screen, early game, a high-combo moment with big
entities, and the COLLAPSE game-over screen.

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

## Known trade-offs worth knowing

- **`INTERNET` permission is declared but unused.** `AndroidManifest.xml` keeps
  it because Capacitor's WebView is happier with it and I could not test the app
  on a real device from here. Once you have confirmed the game runs fine
  offline, you can delete that one line for a slightly cleaner listing — but
  verify first, do not take it on faith.
- **The game has never been run in a browser or on a device.** All verification
  so far has been static. Install the closed-test build and play it before you
  submit anything to production.
