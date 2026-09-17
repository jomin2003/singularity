# SINGULARITY

An endless gravity-well game for Android. One finger. Consume what's smaller.
Flee what isn't. Get a little bigger every run.

The game itself is a single-page web app — Canvas 2D plus procedural WebAudio,
no assets and no framework. It is wrapped for Android with **Capacitor** so it
can be published to Google Play as a signed AAB, and it still runs standalone
in a browser.

**Publishing? See [PLAY_STORE.md](PLAY_STORE.md) — that's the step-by-step
submission path.**

## Play

Tap **TAP TO BEGIN** on the menu, then push the stick at the bottom of the
screen. Things in cool colours (cyan → violet) and *without* spikes are edible;
anything warm (amber → red) that wears a **spiked ring** will hurt you and cost
you mass. Shape carries the threat, not just hue, so the game is playable with
any colour vision.

Every chain of consumes builds a combo (shown top-centre, with the bar split
into twenty pips counting down to the next pulse). Every 20 combos unleashes
a shockwave that vaporises nearby dangers. Combo carries a multiplier up to
×8.

Three control schemes, pickable from the menu or from Settings. All three are
touch-first — this ships as an Android app:

| Scheme | How it works |
| --- | --- |
| `STICK` | the stick is fixed at the bottom centre; press anywhere to drive it |
| `FOLLOW` | the hole chases your fingertip |
| `DRAG` | relative drag; the hole tracks the gesture |

WASD / arrows, `Space` to start, `P` to pause and `M` to mute always work.

### How the hole moves

Movement is thrust-and-inertia, not cursor-following. The stick applies an
acceleration; the resulting velocity has to be carried around, so nothing
changes direction within a frame. Two rules fall out of that:

- **Top speed is `SPEED_REF * r`** and nothing else. This is the number that
  sets how fast the hole can ever go, so the difficulty curve and the
  reachability of food are independent of the feel tuning.
- **Mass dulls response, not top speed.** A small hole reaches 53% of its top
  speed in 0.4 s; a hole four times larger reaches only 28% in the same time,
  and coasts roughly twice as long after you let go. You keep the speed you
  earned by growing — you just take longer to get there and longer to stop.

Turn `DRIFT_EXP` down if big holes feel too ponderous; set it to 0 and every
size responds identically. `SPEED_REF` is the one to touch for overall pace.

## UI design system

The rules live as tokens at the top of `style.css` so they are enforceable
rather than aspirational. Everything below is a token, and no rule should
introduce a raw value outside the scale.

- **8px grid.** Every margin, padding and gap is a multiple of `--s-1..--s-4`.
- **Two faces, never three.** Orbitron Black for the wordmark and nothing else;
  the system UI face for everything including numerals. Numerals use
  `font-variant-numeric: tabular-nums` for alignment — mono was tried and
  rejected, because its slashed zero renders a score of zero as "Ø", which
  reads as a null marker rather than a number.
- **Six type sizes** (`--t-display / hero / readout / heading / body / label /
  micro`) and **three tracking values** (`--ls-display / label / tight`).
  Over-tracked uppercase at `.2em+` on every element is the single most
  recognisable tell of a sci-fi UI built by feel; `.16em` is now reserved for
  the wordmark alone.
- **One glow per screen.** Glow marks the primary thing and nothing else. The
  only exceptions are semantic — the low-mass warning glows because the glow
  *means* "you are about to die". This was the biggest change: the stylesheet
  previously carried 19 glow declarations, and when everything glows nothing is
  emphasised. It now carries four, each justified.
- **A radius scale**, so shape carries hierarchy. Exactly one element is a pill
  (the segmented track); everything else picks a step. Previously nearly every
  surface was a 100px pill, so shape communicated nothing.
- **Weight carries emphasis, not glow.** `--w-body / label / strong / display`.
- **Motion is a token scale too.** `--dur-fast / med / slow` and `--ease-out`,
  and nothing animates permanently. An infinitely breathing primary button and
  a 5s `drop-shadow` filter animation on the wordmark were removed: the first
  moves the tap target out from under the thumb, the second repaints a blurred
  layer every frame for no information. Panels get one ~200ms opacity+translate
  entrance between them (the scrim fade and the card reveal used to double up,
  and seven `animation-delay` rules for a child stagger that never existed were
  removed as dead CSS).
- **Reduced motion is answered twice over.** Both the OS setting and the in-game
  MOTION toggle disable every animation and transition, and the list is
  exhaustive rather than naming three selectors — an accessibility switch that
  misses the panel reveal, both toast transitions and the low-mass heartbeat is
  not an accessibility switch.

The accessibility presets scale the **tokens**, not individual selectors. The
large-text preset previously overrode ten elements by hand, which meant every
new element silently opted out of it.

**Overlays are a layer plus a card, never both.** `.layer` owns the scrim, the
safe-area padding and the hit-testing; the card inside it owns the surface, the
`max-height`, the scroll container and the entrance. An element that is both
gets the two paddings stacked and measures its own `max-height` against a box it
is also padding. `tools/smoke_test.cjs` asserts this shape, because it is easy
to reintroduce and impossible to see in a diff.

Menu styling is scoped to `#menu`. `.layer.center` is shared with the
game-over, pause, settings and event panels, so nothing in the menu shell may
leak into those.

Two implementation notes worth keeping:

- **No `:has()` anywhere.** It works in current Chromium, but `minSdk` here is
  24 and an unsupported selector silently drops the whole rule on an older
  WebView. The segmented control's sliding pill is driven by a `data-sel`
  attribute set in `syncControlPick()` instead.
- **The font is bundled, not linked.** `www/fonts/orbitron-900.woff2` (6.4 kB,
  latin subset) with its OFL licence alongside. A Google Fonts `<link>` would
  break the offline guarantee and simply fail inside the Android wrapper, which
  has no network at all.

## Layout

```
www/                       the game -- this is what ships inside the app
  index.html               app shell, UI overlays
  style.css                dark, glowy, mobile-first UI
  game.js                  everything: rendering, physics, audio, input, loop
  fonts/                   Orbitron Black woff2 + its OFL licence
  manifest.webmanifest     PWA installability (browser build)
  sw.js                    offline cache -- browser only, skipped inside the app
  icons/                   PWA launcher icons
android/                   Capacitor's native Android project (committed on purpose)
capacitor.config.json      appId com.jomin.singularity, webDir www
store/                     Play listing assets (generated)
  feature-graphic-1024x500.png
  icon-512.png
privacy.html               privacy policy, published via GitHub Pages
PHYSICS_REVIEW.md          audit of every physics system vs the real relations
RUN_DESIGN.md              what the endless run is missing, and what to add
tools/
  make_icons.py            PWA icons (stdlib only)
  make_store_assets.py     Play feature graphic + 512 icon (needs Pillow)
  make_android_icons.py    launcher icons + splash screens (needs Pillow)
  smoke_test.cjs           jsdom boot + physics/UI suite
  progression_test.cjs     meta-progression, save and state-machine suite
  visual_check.cjs         real-browser layout check + screenshots (CDP)
.github/workflows/
  build-aab.yml            builds the signed release AAB
  pages.yml                hosts privacy.html on GitHub Pages
```

`android/app/src/main/assets/public/` is generated by `cap sync` from `www/`
and is gitignored — CI regenerates it on every build.

### Regenerating artwork

```
python tools/make_store_assets.py     # store/ feature graphic + 512 icon
python tools/make_android_icons.py    # res/mipmap-* launcher icons + splash
python tools/make_icons.py            # www/icons PWA icons (stdlib only)
```

The first two need Pillow; `make_icons.py` is pure stdlib.

### Running locally

Open `www/index.html` in Chrome. For the service worker to register you need
HTTP rather than `file://` — e.g. `python -m http.server` inside `www/` and
visit `http://localhost:8000`.

### Building the Android bundle

You do **not** need the Android SDK on this machine — GitHub Actions produces
the signed AAB. See [PLAY_STORE.md](PLAY_STORE.md).

## Design decisions

### Why one mechanic

Research consistently shows that the stickiest mobile games are the ones with
*one* core verb (Flappy Bird = tap to flap, Crossy Road = tap to hop, Hole.io
= move a hole). SINGULARITY's verb is **move**. All depth comes from how the
move interacts with entities of different sizes.

### Why a black hole

- The "swallow smaller things" loop is the most consistently engaging growth
  fantasy in mobile (Agario, Hole.io, Kirby, Katamari).
- The visual language is free: an accretion disk, photon ring, and lensed
  halo give an unmistakable silhouette.
- Growth is the reward: as you get bigger, more of the world becomes
  edible, which keeps late runs interesting instead of running out of goals.

### Why colour is the difficulty signal

Players must read the field in a split second. A red/cyan split — edible
things are cool, dangerous things are warm — communicates threat level
without text, numbers, or a tutorial. The hue is recomputed every frame
relative to the player's size, so as you grow, previously-dangerous bodies
visibly cool down and become food. That's the dopamine moment of the game.

### Why combo

Combo is the most well-known engagement lever in arcade games (Piano Tiles
is literally built around a rising tone per note). Here it does two jobs:

1. **Score multiplier**, which makes a good run visibly distinct from a
   mediocre one (the readout animates upward with smooth-lerp so a big
   meal registers even if you never glance at the HUD).
2. **Milestone reward at every 20**, where a shockwave vaporises nearby
   dangers. This is the "one more run" hook: you're chasing the next pulse.

Combo decays over `COMBO_WINDOW` (1.35s), so it forces engagement without
being punishing.

### Why entropy

A passive 0.15%–0.4%/s mass decay (scaling up with size) is the part that
turns the game from sandbox into chase. Bigger you get, the faster you
shrink if you stop eating, which means the game keeps demanding aggression
even when the field looks calm. This is the lever the research on core
loops calls "gentle urgency" — the thing that makes it feel alive.

### Why juice

- **Screen shake** on hit (and shockwave) — taps into impact reflex.
- **Hit-stop** (~0.09s time-scale dip) on hit — adds weight.
- **Parallax starfield** (3 layers) — gives speed and depth cues when the
  camera moves.
- **Vignette + nebula** — keeps the play area readable while the world
  feels infinite.
- **Camera zooms out as you grow** — using a `pow(grow, 0.78)` curve so
  the player visibly grows on screen but the field always reads.
- **Procedural WebAudio** — drone that opens with combo, a rising
  pentatonic blip on each consume, noise thud on hit, descending saw on
  death. All five sounds together make the loop feel musical.
- **Era hue shift** — every 1,200 mass, the palette shifts ~24° hue. The
  player doesn't notice consciously, but sessions feel long and
  surprising.

### Performance

- DPR capped at 2 to avoid 3× devices melting on full-canvas pixel work.
- Starfield uses three pre-rendered `createPattern` tiles (one draw each).
- Glow effects use cached radial-gradient sprites bucketed by hue.
- `globalCompositeOperation = 'lighter'` is set per layer and reset.
- Particle cap of 460 with bulk-drop to amortise splice cost.

### Sound

- **Procedural WebAudio** — drone that opens with combo, a rising
  pentatonic blip on each consume, noise thud on hit, descending saw on
  death. All five sounds together make the loop feel musical.
- **Bundled soundtrack** — five era-themed ambient tracks in `www/audio/`
  (regenerate with `npm run assets:music`), played through plain audio
  elements so they follow the MUSIC slider and the mute switch. The tracks
  also pin the APK above 20 MB with real content rather than padding.

### Accessibility / resilience

- No external assets — fully offline (there is no network use at all; the
  old service worker was retired — see Android wrapper notes).
- Keyboard fallback (WASD / arrows) for desktop testing, plus a footer key
  legend on wide screens. There is no custom cursor: the hole is driven by the
  stick or the keyboard, so hiding the OS pointer would leave a desktop player
  with no pointer and nothing drawn in its place.
- **Hazard shape, not just hue** — lethal bodies wear a closed spiked ring,
  edible ones stay smooth, so no mode depends on colour alone.
- **Colour-vision** presets: normal / deuteranopia / protanopia / tritanopia.
- **Motion off** kills shake, camera tilt *and* the fullscreen white strobe
  (the flash is the real photosensitivity risk, not the shake).
- **Large text** and **high contrast** presets for sunlight and low vision.
- **Music** and **effects** have separate sliders; **haptics** has three
  strengths, because mute-everything is a blunt tool.
- **First-encounter pause** stops the world the first time you meet a pulsar,
  a wormhole or a civilisation, with a one-line explainer — the rarest content
  in the game used to be missable mid-chaos.
- Page Visibility pauses the audio drone.
- All UI text is real DOM (not canvas), so screen readers can see it.

### Rendering the black hole

The hole is drawn entirely with continuous gradients: a pure-black shadow, a
thin photon ring hugging its edge, a near-edge-on accretion disk crossing in
front of the shadow (hottest along its centre line, cooling outward), the
far side of that disk lensed up over the top and under the bottom, and
Doppler beaming so the approaching limb is far brighter than the receding
one. Nothing is segmented — stroked arc segments stack into visible blocks
and read as a gear or a clock face rather than as gas.

**Light wrapping.** The signature of the object is not the disk, it is the
background being bent around the hole. Photons from the sky behind it are
dragged into concentric arcs, each band being the same sky bent further
round: fainter, thinner and closer in. `EINSTEIN_BANDS` stacks four of them
between 1.26x and 1.94x the shadow radius, and `drawSecondaryImage` puts the
lensed far side of the disk back on the limb as a bright knot that drifts
around the edge. Two things matter for it to read correctly:

- **The bands must be crescents, not rings.** A uniform circle looks like a
  painted archery target. Each band's gradient runs from ~15% to 100% across
  its width, so the beamed limb is several times brighter and the light looks
  dragged around rather than stamped on.
- **They need dark space between them.** Bands packed tight against the
  photon ring merge into one bright collar and the whole object inflates into
  a fuzzy torus. The first band sits at 1.26x for exactly this reason.

The halo is kept very low (0.075 alpha, capped at 1.5x) for the same reason —
this plus the bands is all the "glow" the object can carry before the hard
black shadow stops reading as black. Both holes share this structure, so a
rival reads as the same class of object rather than a different sprite.

## Run structure

- **Variants** (STANDARD / TITAN / WISP / MONK on the menu) are the difficulty
  modes: starting rules, never stat unlocks. A permanent size or drain buff
  would delete the threat inversion the game is built on.
- **Missions**, three at a time, read counters the game already tracks
  (era, peak combo, white dwarfs, arks, pulsars, shockwave kills, grazes,
  survival time, score). Completed missions roll a fresh objective.
- **Daily run**: one seeded attempt per calendar day from the menu.
- **Finale**: reaching SINGULARITY stops the world with a scripted panel;
  continuing is an explicit choice, so the endless grind has a destination.
- **Ghost rival**: your best run's positions replay as a translucent ring
  (toggle in Settings). No simulation needed — every run starts at origin.
- **Tension curve**: each meal buys ~2s without decay, and combo ×10+ slows
  the drain, so evaporation is a rhythm to ride rather than a flat tax.

## Meta-progression

The game has a full meta-progression layer that persists between runs:

- **Stardust** — earn 1 per 100 score (settled as each 100-point threshold is
  crossed, including multi-hundred gains in one bite), plus bonuses for rare
  bodies (pulsar +5, wormhole +3, magnetar +3, quasar +5, star +2). Spend at
  the Observatory on permanent upgrades across four branches, five levels each:

  | Branch | Effect per level | At level 5 |
  | --- | --- | --- |
  | Gravity Well | +2% starting radius | +10% starting radius |
  | Accretion Disk | +5% combo window | +25% combo window |
  | Event Horizon | 4% less mass lost to impacts | 20% less |
  | Singularity | 3% slower evaporation | 15% slower |

  Upgrades apply to ordinary runs only. A seeded challenge (the daily run, or a
  `?seed=` URL) runs the stock rules, so a shared seed means the same game for
  everyone rather than the same game plus one player's upgrades.
- **Daily Rewards** — a 28-day cumulative calendar keyed to the device's local
  date. Missing a day costs you that day only; no reset and no lockout — the
  cycle simply repeats. Day 7 gives a skin, Day 14 a larger reward, Day 28 a
  legendary skin.
- **Skins** — cosmetic variants for your black hole. Unlock by reaching eras,
  performing rare feats, lucky drops, or daily rewards.
- **Achievements** — 12+ milestones from "First Meal" to "Committed". Each
  unlocks with a toast and a stinger.
- **Field Guide** — a collection album of every body type. Eating something
  for the first time discovers it, with a fun fact about the real object.
- **Weekly Leaderboard** — your top 10 scores this week, ranked. Resets every
  Monday.
- **Near-miss feedback** — the game-over screen tells you how close you were
  to the next era or upgrade, turning frustration into "one more run".
- **Rare body windows** — every 5th run guarantees a rare spawn within 30
  seconds, with a boosted chance after 3 dry runs.

## Not done

- No level / chapter system. Eras are announced thresholds with a finale at
  SINGULARITY, but the field itself has no chapters.
- The base curve is tuned in `pickRadius` and the Hawking constants at the
  top of `game.js`.

## Android wrapper notes

- `MainActivity` sets `FLAG_KEEP_SCREEN_ON` so the screen can't dim mid-run,
  and hides the system bars — Android 15+ enforces edge-to-edge, so drawing
  behind them and then hiding them is the only way to get true fullscreen.
- Back requires **two presses within 2s** with a toast, so a stray back gesture
  during play doesn't dump the player out.
- The service worker is deliberately **not** registered when running inside
  Capacitor (`IS_NATIVE`). In a WebView a stale cache would silently keep
  serving an old build after an update.
- `localStorage` is accessed through `lsGet`/`lsSet` wrappers. It genuinely
  throws on `file://` and in some private-browsing modes, and an uncaught throw
  there used to kill the boot sequence.
- Orientation is locked to portrait in `AndroidManifest.xml`.

## Testing status

The game is exercised by two headless suites and one real-browser check:

| Suite | What it proves | Command |
| --- | --- | --- |
| `tools/smoke_test.cjs` | boots the real game in jsdom, drives the frame loop, and checks physics, camera, shield, audio-RNG isolation, layout contracts and the boot/menu/play/death/restart path (75 checks) | `NODE_PATH=<dir with jsdom> node tools/smoke_test.cjs` |
| `tools/progression_test.cjs` | seeded-run determinism, Stardust settlement, daily rewards, upgrades, rare windows, skins, state-machine edges (16 checks) | `node tools/progression_test.cjs` |
| `tools/visual_check.cjs` | renders real frames in headless Chrome at phone, short-phone and landscape sizes and fails on any element that leaves the viewport; writes PNGs to `<temp>/singularity-shots` | `node tools/visual_check.cjs` |

`npm test` runs the two jsdom suites; `npm run test:visual` runs the browser
check (set `CHROME_PATH` if Chrome is not in the default location). jsdom is
deliberately **not** a project dependency — install it wherever you like and
point `NODE_PATH` at it.

`visual_check.cjs` drives Chrome over the DevTools Protocol rather than with
`--screenshot`, because plain headless `--screenshot` ignores `--window-size`
for layout: the page lays out at the default window (measured 762x484) and the
PNG is letterboxed into the size you asked for. Every measurement taken that
way is wrong, which is how a "the card overflows the phone" report turns out to
be an artifact of the harness.

What has **still never happened** is a human playing it on a physical Android
device. Install the closed-test build and play it before submitting to
production.