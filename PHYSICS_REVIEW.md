# SINGULARITY — astrophysics review

An audit of every astronomy- and physics-flavoured system in the game against the
real relations, plus recommended additions.

Audited against build `b14`, from the actual source (`www/game.js`), not from
memory. Constants quoted below are the values in the code.

**Method.** For each system: what the code does → what physics says → verdict →
concrete correction. Verdicts are one of:

- **Accurate** — matches the real relation within the needs of a game.
- **Simplified** — wrong in form but harmless; the trade is deliberate and fine.
- **Inaccurate** — contradicts a real relation in a way that is cheap to fix.
- **Unphysical** — no real mechanism; acceptable as game licence, but should be
  labelled rather than implied to be real.

---

## Reference values used throughout

| Quantity | Real value |
| --- | --- |
| Schwarzschild radius | `r_s = 2GM/c²` |
| Photon sphere | `3GM/c² = 1.5 r_s` |
| Shadow (critical impact parameter) | `b_c = 3√3 GM/c² ≈ 5.196 GM/c² = 2.598 r_s` |
| ISCO (Schwarzschild) | `6GM/c² = 3 r_s = 1.155 b_c` |
| Orbital speed at ISCO | `0.5 c` |
| Gravitational redshift at ISCO | `√(1 − r_s/r) = √(2/3) ≈ 0.816` |
| Thin-disk temperature profile | `T(r) ∝ r^(−3/4)` (Shakura–Sunyaev) |
| Doppler factor | `δ = 1 / (γ(1 − β cos θ))` |
| Beamed intensity | `I_obs = δ^(3+α) I_emit`; bolometric `∝ δ⁴` |
| Higher-order subrings | offset from critical curve `∝ e^(−nπ)`, ratio `≈ 0.043` per half-orbit |
| Accretion efficiency (Schwarzschild) | `1 − √(8/9) ≈ 5.7%` of rest mass |
| Accretion efficiency (max Kerr) | `≈ 42%` |
| Hawking temperature | `T = ħc³ / (8πGMk_B)`; `≈ 6.2×10⁻⁸ K` for 1 M☉ |
| Hawking evaporation time | `≈ 2.1×10⁶⁷ yr` for 1 M☉ |
| Eddington luminosity | `L_Edd ≈ 1.26×10³¹ (M/M☉) W` |
| Tidal (disruption) radius | `r_t ≈ R_body (M_BH / m_body)^(1/3)` |

---

# Part 1 — Assessment of existing systems

## Summary table

| # | System | Verdict |
| --- | --- | --- |
| 1 | Mass–radius relation (`M ∝ r²`) | **Inaccurate** — root cause of 3 downstream issues |
| 2 | Growth by consumption | **Inaccurate** (follows from 1) |
| 3 | Hawking evaporation scaling | **Inaccurate** — code and its own comment disagree |
| 4 | Shadow radius vs Schwarzschild radius | Accurate |
| 5 | Photon ring position | Accurate |
| 6 | Disk inner edge (ISCO) | **Inaccurate** — disk intrudes inside the ISCO |
| 7 | Disk outer edge | Simplified |
| 8 | Disk inclination (`DISK_FLAT`) | Accurate |
| 9 | Doppler beaming | **Inaccurate** — wrong functional form |
| 10 | Gravitational redshift | **Missing** |
| 11 | Einstein lensing bands | **Inaccurate** as a model of subrings |
| 12 | Gravity on bodies | **Inaccurate** (follows from 1) |
| 13 | Orbital motion / angular momentum | **Missing** — nothing orbits |
| 14 | Tidal disruption | **Missing** |
| 15 | Relativistic speed limit / γ | **Mislabel** — hole moves at β ≈ 0.003, so its "beaming" is not relativistic |
| 16 | "Frame dragging" camera roll | **Mislabel** — no spin parameter exists |
| 17 | Era progression | **Conceptually wrong** — stellar sequence for a black hole |
| 18 | HUD "MASS" readout | **Mislabel** — it displays score |
| 19 | Pulsar → one-hit shield | Unphysical, acceptable |
| 20 | Kilonova | Accurate |
| 21 | White dwarf | Accurate |
| 22 | Brown dwarf | Accurate |
| 23 | Star subtype mix | Simplified, defensible |
| 24 | Magnetar | Accurate |
| 25 | Quasar jets | Accurate |
| 26 | Wormhole teleport | Unphysical, acceptable |
| 27 | Comet gravity | Accurate |
| 28 | Combo shockwave | Unphysical — but has a perfect real reframe |
| 29 | Disk temperature gradient | Simplified |
| 30 | Mass loss on the wrong mechanism | **Inaccurate framing** |

---

## 1. Mass–radius relation — **Inaccurate** (the systemic issue)

**Code.** `p.area` is the mass proxy and `p.r = Math.sqrt(p.area)`, so the code
implicitly assumes `M ∝ r²`.

**Physics.** For a Schwarzschild black hole `r_s = 2GM/c²`, so `M ∝ r_s` —
**linear**, not quadratic. The Schwarzschild radius is directly proportional to
mass.

**Why it matters.** This one assumption propagates into three separate systems
(2, 3 and 12 below), so fixing it is the highest-leverage change available.

**Correction.** Track mass as the primary variable and derive the radius:

```js
p.mass += gainedMass;          // mass is the state
p.r = p.mass * RS_PER_MASS;    // r_s = 2GM/c²  →  linear
```

If `P0 = 22` should stay the starting radius, set `RS_PER_MASS = P0 / M0` where
`M0` is the chosen seed mass (see addition **H**).

---

## 2. Growth by consumption — **Inaccurate**

**Code.** `p.area += e.r * e.r * CONSUME_YIELD` with `CONSUME_YIELD = 0.34`. So
the hole absorbs 34% of the consumed body's *area*.

**Physics.** Accretion adds mass, and radius follows linearly. Consuming a body
of mass `m` adds `εm` where `ε` is the capture efficiency.

**Correction.** With the fix from 1: `p.mass += e.mass * CONSUME_YIELD`, and give
each body a mass consistent with its type. A planet should carry far less mass
per unit radius than a white dwarf — which the game already *asserts* via the
score multipliers (`whiteDwarf ×4`, `brownDwarf ×2`) but does not reflect in the
growth curve. Tying `e.mass` to those same multipliers would make the existing
design intent physical for free.

---

## 3. Hawking evaporation scaling — **Inaccurate** (code contradicts its comment)

**Code.**

```js
const decay = HAWKING_BASE * clamp(Math.pow(P0 / p.r, 3), HAWKING_MIN, HAWKING_MAX);
p.area = Math.max(1, p.area - p.area * decay * dt);
```

The comment above it states: *"the FRACTIONAL mass-loss rate scales as 1/M³ — and
since Schwarzschild radius is proportional to mass, as 1/r³."*

**Physics.** The comment is correct: `dM/dt ∝ −1/M²`, so the fractional rate
`(dM/dt)/M ∝ −1/M³`.

**But the code is not.** `decay ∝ r⁻³`, and with the code's own `r = √area` this
becomes `area^(−3/2)`, i.e. **`∝ M^(−1.5)`, not `M^(−3)`**. The comment reasons
with `r ∝ M` (the real relation) while the code implements `r ∝ √M`. The two
halves of this one block are based on different physics.

**Correction.** Two options:

- **If you fix issue 1** (make `M ∝ r`), the existing exponent `3` becomes
  correct as written — the comment finally matches the code.
- **If you keep `M ∝ r²`**, change the exponent to `6`, so `r⁻⁶ = area⁻³ = M⁻³`.

Either way the exponent should be a named constant, not a bare `3`.

**Separate framing problem.** Real Hawking evaporation is absurdly slow —
`≈ 2.1×10⁶⁷ yr` for one solar mass. Using it as the dominant mass sink over a
two-minute run is off by ~70 orders of magnitude. See finding 30 for a much more
physical mechanism at these timescales.

---

## 4. Shadow radius vs Schwarzschild radius — **Accurate**

**Code.** The comment states the observable shadow is ~2.6× the Schwarzschild
radius and treats `p.r` as the shadow radius.

**Physics.** `b_c / r_s = (3√3/2) = 2.598`. Correct.

---

## 5. Photon ring position — **Accurate**

**Code.** `drawPhotonRing` strokes at `r * 1.045`.

**Physics.** The photon ring sits essentially *at* the shadow edge; the higher-order
subrings converge onto the critical curve from just outside it. A thin bright ring
at `1.0–1.05 ×` shadow radius is right.

Note the code is also correct to *not* draw the photon sphere itself: at `1.5 r_s`
it lies at `0.577 b_c`, well inside the shadow, and is therefore invisible.

---

## 6. Disk inner edge — **Inaccurate**

**Code.** `drawDisk` fills a radial gradient from the centre (`0,0,0`) out to
`R = r * DISK_OUT`, with the black shadow painted on top afterwards. The visible
inner edge of the disk is therefore the **shadow edge**, `r`.

**Physics.** The inner edge of a thin accretion disk is the ISCO, at `6GM/c²`, which
is `1.155 ×` the shadow radius. Matter inside that radius plunges; it does not
orbit and does not form a stable disk.

**Correction.** Start the disk gradient at `r * 1.155` instead of `0`. Visually
this is a subtle change — the region between `r` and `1.155r` becomes a dark gap
rather than disk — and it is the correct geometry. It also creates a natural place
to show the **plunging region** as a distinct, dimmer, faster-moving inner band.

---

## 7. Disk outer edge — **Simplified** (acceptable)

**Code.** `DISK_OUT = 3.1` shadow radii `≈ 8.05 GM/c²`.

**Physics.** Real disks extend from the ISCO out to tens, hundreds, or thousands of
`GM/c²` depending on the system.

A hard outer edge at ~8 M is a visual simplification. It is fine — a physically
sized disk would be mostly off-screen — but it could be given a realistic
**taper** rather than an edge, which the current layered gradient already
half-does.

---

## 8. Disk inclination — **Accurate**

**Code.** `DISK_FLAT = 0.115` used as `scale(1, DISK_FLAT)`, so the projected disk
is an ellipse of aspect ratio 0.115 — equivalent to viewing the disk plane
`arcsin(0.115) ≈ 6.6°` above edge-on.

**Physics.** Interstellar's Gargantua and the EHT images sit in the 5–20° range for
the classic near-edge-on look. 6.6° is a good choice.

---

## 9. Doppler beaming — **Inaccurate**

**Code.** `drawDisk` overlays a *linear* alpha gradient from `0.00` on one limb to
`0.62` on the other.

**Physics.** Beaming is a power law in the Doppler factor, not a linear ramp:
`I_obs = δ^(3+α) I_emit` (bolometric `δ⁴`), with
`δ = 1/(γ(1 − β cos θ))`.

At the ISCO, `β = 0.5` and `γ = 1.1547`, so:

- approaching limb, `cos θ = 1` → `δ = 1.732` → `δ⁴ = 9.0`
- receding limb, `cos θ = −1` → `δ = 0.577` → `δ⁴ = 0.111`

That is a **brightness ratio of ~81:1** — dramatic, but *finite*. The current
linear ramp runs to zero, which over-darkens the receding side into invisibility
and under-brightens the approaching side.

**Correction.** Replace the linear stops with computed `δ⁴` values:

```js
// beta at the emitting radius; 0.5 at the ISCO, falling as r^(-1/2)
const beta = 0.5 / Math.sqrt(rad / (r * 1.155));
const gam  = 1 / Math.sqrt(1 - beta * beta);
// t in [0,1] across the disk; cosTheta goes +1 (approaching) to -1
const cosT = 1 - 2 * t;
const delta = 1 / (gam * (1 - beta * cosT));
const beam = Math.pow(delta, 4);
```

Normalise so the peak is 1.0 and multiply into the existing alpha stops. This is a
handful of lines and turns the brightest feature of the object from a guess into
the correct relation.

---

## 10. Gravitational redshift — **Missing**

**Physics.** Light climbing out of the well is redshifted by `√(1 − r_s/r)`. At the
ISCO that factor is `√(2/3) ≈ 0.816`: the inner disk is both **dimmer** and
**redder** than its local temperature implies.

The code instead makes the innermost disk *white-hot* (`rgba(255,255,255,0.90)` at
the centre) and cools outward.

**Correction.** Multiply the disk's colour temperature by the redshift factor and
let the innermost annulus shift toward orange rather than pure white. Combined
with 9, this is what gives real images their characteristic asymmetry: a blazing
blue-white approaching limb and a dim, reddened receding limb.

---

## 11. Einstein lensing bands — **Inaccurate** as subrings

**Code.**

```js
const EINSTEIN_BANDS = [
  { k: 1.26, ... }, { k: 1.44, ... }, { k: 1.66, ... }, { k: 1.94, ... }
];
```

Radii relative to the shadow radius, spaced at roughly even intervals (successive
ratios 1.14, 1.15, 1.17).

**Physics.** The higher-order images of a black hole are indexed by the number of
photon half-orbits `n`, and their offsets from the critical curve shrink
**geometrically**:

```
b_n − b_c  ∝  e^(−nπ)        ratio ≈ 0.043 per half-orbit
```

So a physically faithful set crowds *exponentially* toward the photon ring, not
evenly outward. (This is the "subring" structure that the photon-ring literature
describes, and it is why the n=1 and n=2 rings are separated by only a few
percent.)

**Correction.**

```js
const BAND_BASE = 0.30;   // offset of the n=0 band, in shadow radii
const EINSTEIN_BANDS = [0, 1, 2, 3].map(n => ({
  k: 1 + BAND_BASE * Math.exp(-n * Math.PI)
}));
```

with the alphas also decaying by the same factor. Note this produces a *very*
tight cluster near 1.0; for readability you may want to compress the exponent
(e.g. `e^(−n·0.9)`) and document that as a deliberate exaggeration. Exaggerating a
correct relation reads very differently from using a linear one.

---

## 12. Gravity on bodies — **Inaccurate** (follows from 1)

**Code.**

```js
const mass = (e.r * e.r) / (p.r * p.r);
const soft = d + p.r * 0.85;
const falloff = (p.r * p.r) / (soft * soft);
const s = falloff * 4.6 * p.r * dt / (0.35 + mass * 2.2) * (edible ? 1 : 0.18);
```

**What is right.** The `1/r²` falloff with softening is genuinely Newtonian, and
dividing by the body's own mass to get *acceleration* is correct — the
`(0.35 + mass × 2.2)` term properly makes heavy bodies sluggish.

**What is wrong.** The numerator `p.r²` encodes a gravitational parameter
`GM ∝ r²`, again the mass-as-area assumption. Real: `GM ∝ M ∝ r_s`.

**Correction.** Once mass is the state variable (fix 1), use `GM ∝ p.mass`
directly. The softening length should also scale with `r_s` rather than being a
bare `0.85 p.r` — a physically motivated softening is of order the Schwarzschild
radius itself.

---

## 13. Orbital motion — **Missing** (the biggest realism gap)

**Code.** Bodies spawn with a straight-line drift velocity, gravity is applied
**radially only**, and velocity is damped every frame:

```js
const edamp = Math.pow(0.12, dt);   // velocity ×0.12 per second
```

That is a time constant of `−1/ln(0.12) ≈ 0.47 s`, so a body loses ~88% of its
speed every second. Nothing ever orbits; matter either drifts past or falls
straight in.

**Physics.** Angular momentum is conserved. Infalling matter does not fall
radially — it spirals, which is precisely *why* accretion disks exist. Real
accretion is the conversion of gravitational potential energy into radiation via
viscous torques in a differentially rotating disk.

**Why this matters more than the numbers.** Every other item here is a constant
or a gradient. This one changes the *shape* of the simulation: it is the
difference between a field of drifting objects and a system with dynamics.

**Correction.** Give each body a tangential component at spawn:

```js
// At distance d, the circular orbital speed is sqrt(GM/d).
// Spawn with a fraction of it so matter spirals in rather than plunging.
const vCirc = Math.sqrt(p.mass * G_UNITS / d);
const tang  = rand(0.55, 0.95);              // < 1 → elliptical inspiral
e.vx = -Math.sin(ang) * vCirc * tang + inward * vCirc * 0.15;
e.vy =  Math.cos(ang) * vCirc * tang + inward * vCirc * 0.15;
```

Then remove or greatly reduce `edamp` — damping is what currently destroys the
orbital energy that should be conserved. The result: bodies sweep past in arcs,
some spiral in over several seconds, and the disk-like infall the lensing art
already depicts becomes real. This also makes the existing "danger arrow"
readout far more meaningful, because approach direction becomes predictable.

---

## 14. Tidal disruption — **Missing**

**Code.** Consumption is a hard radius test: if `e.r <= p.r * 0.95` on contact,
the body is eaten whole.

**Physics.** A body is torn apart *outside* the horizon when the tidal
acceleration across it exceeds its own self-gravity, at

```
r_t ≈ R_body (M_BH / m_body)^(1/3)
```

For a black hole eating a planet, `r_t` is far outside the horizon — the body is
stretched into a stream before it is ever swallowed. This is a real, observed
phenomenon (tidal disruption events are a whole class of transient astronomy).

**Correction.** When a body crosses `r_t`, don't consume it: split it into 3–6
smaller fragments with a radial velocity spread along the axis toward the hole.
The game already has `burstFx` and a fragment-friendly entity array, so this is
mostly a spawning change. It would look spectacular and it is textbook physics.

---

## 15. Relativistic speed limit — **Simplified** (and a mislabel I introduced)

**Code.** `SPEED_REF = 11` shadow radii per second; there is no `c` anywhere.

**Physics.** At 11 shadow radii/s, `v = 11 × 3√3 GM/c²` per second, so

```
v/c  =  11 × 3√3 × GM/c³  ≈  2.82×10⁻⁴ × (M / M☉)   per second
```

This stays subluminal up to `M ≈ 3,550 M☉` — the intermediate-mass range. So the
hole never actually breaks `c`. But for a stellar-mass hole it moves at
`β ≈ 0.003` — **0.3% of light speed**, which is emphatically non-relativistic.

**This is worth stating carefully, because one piece of the current look is
misattributed — including by me.** The disk's Doppler beaming and the lensing are
correct: those arise from the *disk's* orbital motion (`β = 0.5` at the ISCO) and
from the hole's gravity, and neither cares how fast the hole translates. But the
"relativistic beaming ahead of the hole" added in build `b13` is keyed to the
hole's **translational** speed, which is `β ≈ 0.003`. That is not relativistic
beaming; it is a direction-of-travel glow. The comment in `drawPlayer` overstates
what the effect is.

**Correction.** Two clean options:

- **Relabel it honestly** — a bow shock or leading-edge glow, which is what a body
  moving through a medium actually produces. Keeps the speed sensation, drops the
  false claim.
- **Make it real** — introduce an explicit `c`, fix a seed mass, and let `β` be a
  genuine quantity. But note the scale problem: at `β = 0.003` aberration is
  invisible; to *see* relativistic effects you need `β ≳ 0.3`, i.e. ~30% of `c`.
  Reaching that means either a far lighter hole or a far higher `SPEED_REF`, which
  would change the pace of the game substantially.

The honest recommendation is the first. The disk already carries the relativistic
physics and is doing the visual work; don't claim relativity for the hole's
translation until the numbers support it.

---

## 16. "Frame dragging" camera roll — **Mislabel**

**Code.**

```js
let camRoll = 0;    // Kerr-style frame-dragging wobble near big bodies
```

`camRoll` tilts the camera when the player is near a star, giant or rival.

**Physics.** Frame dragging (the Lense–Thirring effect) requires a **rotating**
black hole — a Kerr metric with spin parameter `a/M`. It produces precession of
orbits and an asymmetry in the shadow. A non-spinning Schwarzschild hole produces
none. The code has no spin parameter, and the trigger is *proximity to another
body*, which is unrelated.

**Correction.** Either rename it (it is a proximity tilt — perfectly good
game-feel juice, just not frame dragging), or make it real by adding spin
(addition **F**), at which point the camera roll genuinely becomes a readout of
the dragged frame.

This matters because the codebase's comments are otherwise unusually careful about
physics; a wrong label here undermines the ones that are right.

---

## 17. Era progression — **Conceptually wrong**

**Code.**

```js
const ERAS = ['NEBULA', 'PROTOSTAR', 'MAIN SEQUENCE', 'RED GIANT',
              'SUPERNOVA', 'QUASAR', 'SINGULARITY'];
```

**Physics.** This is a **stellar** evolution sequence — the life of a star. The
player is a black hole *from the first frame*. A black hole does not pass through
a protostar or a red giant phase; it is the endpoint of that sequence, not a stage
within it. The list is also self-contradictory: it ends at `SINGULARITY`, which is
where the player started.

**Correction.** Replace with the real classification of black holes by mass:

```js
const ERAS = ['STELLAR-MASS', 'INTERMEDIATE', 'SUPERMASSIVE', 'ULTRAMASSIVE'];
```

(Real ranges: stellar 3–100 M☉, intermediate 10²–10⁵, supermassive 10⁵–10¹⁰,
ultramassive >10¹⁰.) Or, if you want to keep the flavour of accretion states:
`QUIESCENT → SEYFERT → QUASAR → BLAZAR`, which are genuine observational classes
of active galactic nucleus and map beautifully onto a growing accretion rate.

Either option is both more accurate and more evocative than the current list.

---

## 18. HUD "MASS" readout — **Mislabel**

**Code.** The HUD label is `MASS` but it displays `score`:

```js
gained = Math.max(1, Math.round(e.r * 0.42 * comboMult()));
score += gained;
el.hudScore.textContent = fmt(Math.round(shownScore));
```

So the number under `MASS` is accumulated *points*, not the hole's mass. The two
diverge constantly — score is multiplied by the combo multiplier and by type
bonuses, none of which affect `p.area`.

**Correction.** Either rename the label to `SCORE`, or display the real mass. The
latter is more satisfying: with addition **H** the readout becomes
`M = 12.4 M☉`, which is a true statement about the object, and it makes the
Hawking-temperature and Eddington-limit additions meaningful.

---

## 19. Pulsar grants a one-hit shield — **Unphysical, acceptable**

**Code.** Eating a pulsar sets `shield = 1`; the shield absorbs the next hit and
decays over ~1.7 s.

**Physics.** Pulsars are rapidly rotating, highly magnetised neutron stars. They
emit beamed radio/X-ray radiation and a relativistic wind; they do not confer
protection on anything.

**Verdict.** This is fine as game licence, and the *presentation* is honest — the
chip reads `SHIELD` and the game never claims it is physics. If you want it
grounded, the cleanest reframe is that the pulsar's magnetic field briefly
**deflects incoming charged matter** — which is at least the right direction of
effect, and would justify renaming it `MAGNETOSPHERE`.

---

## 20–27. Body taxonomy — mostly **Accurate**

| Body | Code | Physics | Verdict |
| --- | --- | --- | --- |
| Kilonova | NS–NS merger, "heavy elements forged" | Kilonovae are NS–NS mergers and the primary r-process site (gold, platinum) | **Accurate** |
| White dwarf | `×4` score, "DEGENERATE MATTER" | ~1 M☉ in ~1 R⊕, mean density ~10⁹ kg/m³ | **Accurate**, and a nice touch |
| Brown dwarf | `×2` score, "failed star" | 13–80 M_Jup, deuterium fusion only | **Accurate** |
| Magnetar | Lethal, `B ~ 10¹⁴–10¹⁵ G` implied | Real magnetar field strengths | **Accurate** |
| Quasar | Sweeping lethal jets | AGN relativistic jets | **Accurate** |
| Comet | "keep their momentum; gravity barely bends them" | Comets do follow gravity; a low-mass body on a near-parabolic orbit | **Accurate in effect** |
| Wormhole | Teleports the player | Traversable wormholes need exotic matter; unobserved | **Unphysical, fine** — but see below |
| Star subtypes | red giant 62% / supergiant 26% / blue giant 12% | Real populations are dominated by M dwarfs | **Simplified, defensible** |

Two notes:

- **Star subtype mix.** The code only ever renders *lethal* stars as evolved
  giants, with the reasoning that "a main-sequence star you outgrow is really just
  a bigger star". That is sound design. But the stated fractions are not the real
  population: in reality ~76% of stars are M dwarfs and giants are rare. If you
  want the mix to be defensible, the justification is *selection effect* (you only
  ever meet stars big enough to be a threat), which is worth a comment.
- **Wormhole.** Given the game is otherwise careful, I'd label this in the
  first-encounter explainer as speculative rather than observed — a single clause
  in `EVENTS` keeps the rest of the physics credible.

---

## 28. Combo shockwave — **Unphysical, but has a perfect real reframe**

**Code.** At every 20th combo, `shockwave()` expands a ring to `13 × p.r` and
deletes every lethal body inside it.

**Physics.** There is no mechanism by which a black hole's accretion activity
vaporises nearby stars. But there *is* a very close real analogue: **AGN
feedback**. Supermassive black holes launch relativistic jets and radiatively
driven winds that heat and expel gas from their host galaxy, quenching star
formation over kiloparsec scales. It is one of the most important processes in
galaxy evolution.

**Correction.** Keep the mechanic exactly as it is and rename the presentation:
`SHOCKWAVE` → `AGN FEEDBACK` or `JET BURST`. The toast, the HUD, and the
first-encounter copy change; the code does not. You get the same dopamine hit and
it becomes a real astrophysical process rather than a magic pulse.

---

## 29. Disk temperature gradient — **Simplified**

**Code.** Ad-hoc gradient stops: white at the centre, cooling to deep orange at
`DISK_OUT`.

**Physics.** A steady thin disk radiates with `T(r) ∝ r^(−3/4)` (Shakura–Sunyaev),
and the emission is close to a blackbody, so colour follows temperature through
Wien's law.

**Correction.** Generate the stops from the power law instead of hand-picking
them. Combined with the gravitational redshift from 10, this gives the inner disk
its correct *reddened* hot colour rather than white — one of the most
characteristic features of real black hole imagery, and currently absent.

---

## 30. Mass loss is attributed to the wrong mechanism — **Inaccurate framing**

**Code.** `HAWKING_BASE`, `HAWKING_MIN`, `HAWKING_MAX` — Hawking radiation is the
sole mass sink.

**Physics.** Hawking radiation is real but negligible for any astrophysical black
hole: `T ≈ 6.2×10⁻⁸ K` and an evaporation time of `~10⁶⁷ yr` for one solar mass.
It cannot be a factor in a two-minute run. Meanwhile the game ignores the mass-loss
mechanism that *is* enormous at these timescales: **the radiative efficiency of
accretion**.

Accreting matter releases `1 − √(8/9) ≈ 5.7%` of its rest mass as energy for a
Schwarzschild hole (up to ~42% for maximal Kerr). That is a genuinely huge number
— accretion onto black holes is the most efficient energy source known, far
outstripping fusion.

**Correction.** Reframe the mass sink as radiative efficiency:

```js
// Radiative efficiency: accretion is not conservative. A Schwarzschild disk
// converts ~5.7% of the rest mass it swallows into radiation and jets.
const RADIATIVE_EFFICIENCY = 0.057;
p.mass -= eatenMass * RADIATIVE_EFFICIENCY;
```

This is physically true, correctly sized, and preserves the game's core tension
("you cannot keep everything you eat") without needing a mechanism that is 70
orders of magnitude too weak.

If you want to keep Hawking as well, keep it as a *flavour* readout (see addition
**L**) rather than as the mass sink.

---

# Part 2 — Recommended additions

Tiered by (impact on realism) ÷ (effort). Each notes where it attaches to the
existing architecture.

## Tier 1 — high impact, small change

### A. Orbital infall (extends finding 13)
Give bodies tangential spawn velocity at a fraction of `sqrt(GM/d)`, and cut
`edamp`. Touches `spawnBelt` and the entity update loop only. This is the single
largest realism gain available: the field stops being drifting debris and becomes
a dynamic system, and it makes the existing lensing art honest.

### B. AGN feedback rename (extends finding 28)
Rename `SHOCKWAVE` → `AGN FEEDBACK` in `toast`, `updateHUD` and `EVENTS`. Zero
code change, converts a magic pulse into a real galaxy-scale process.

### C. Proper Doppler beaming (extends finding 9)
Replace the linear ramp with `δ⁴` computed from `β(r)`. ~10 lines inside
`drawDisk`. Turns the object's most prominent feature into the correct relation.

### D. Correct subring spacing (extends finding 11)
Generate `EINSTEIN_BANDS` from `1 + c·e^(−nπ)` instead of hard-coded radii. ~5
lines. Correct *structure* rather than correct magnitude — which is the part that
reads as real.

### E. Real mass units (extends findings 1, 18)
Make mass the state variable, pick a seed mass (e.g. `P0` ↔ `10 M☉`), and display
`M = 12.4 M☉` in the HUD. Prerequisite for F, I and L, and it fixes the `MASS`
label for free.

## Tier 2 — high impact, moderate change

### F. Kerr spin parameter `a/M`
The biggest single realism upgrade after orbits. A real black hole is characterised
by mass *and* spin. Adding `a/M ∈ [0, 0.998]` immediately gives you:

- **ISCO moves inward**: from `6M` at `a=0` to `1M` at `a=1`, so the disk's inner
  edge (finding 6) visibly tightens as you spin up.
- **Radiative efficiency rises** from 5.7% to ~42% — a real, dramatic number that
  directly tunes the mass-loss mechanic from finding 30.
- **The shadow goes D-shaped**, flattened on the prograde side — the single most
  recognisable Kerr signature, and visible in real EHT images.
- **Blandford–Znajek jets**: jet power scales with spin, giving the AGN feedback
  from B a physical driver.
- **Frame dragging becomes real**, making `camRoll` (finding 16) honest.

Spin could be gained by eating bodies with net angular momentum — which the
orbital infall from **A** would supply naturally. That is a genuinely elegant
system: angular momentum in, spin up, tighter ISCO, stronger jets.

### G. Tidal disruption (extends finding 14)
When a body crosses `r_t ≈ R (M/m)^(1/3)`, split it into fragments with a radial
velocity spread instead of consuming it. Uses the existing entity array and
`burstFx`. Textbook physics, spectacular visuals, and it would make the
"plunging region" between the ISCO and the horizon visually busy the way real
simulations are.

### H. Eddington limit
`L_Edd ≈ 1.26×10³¹ (M/M☉) W` caps how fast a black hole can accrete — radiation
pressure pushes back once the luminosity exceeds it. Beyond the limit, accretion
is suppressed and outflows dominate.

In game terms this is a natural, *physically motivated* growth cap that scales with
mass: it explains why a huge hole grows slowly, gives the threat readout a second
number, and creates the real "Eddington ratio" that astronomers actually use to
classify AGN. It also pairs with F (spin raises the effective limit).

## Tier 3 — flavour and completeness

### I. Hawking temperature readout
`T = ħc³/(8πGMk_B)`. Because `T ∝ 1/M`, the number *falls* as you grow — a
truthful, slightly melancholy stat that rewards the player with a real fact.
Pairs with E. `6.2×10⁻⁸ K` at 1 M☉, so display in scientific notation and let the
player watch it drop.

### J. Gravitational waves from mergers
Real BH–BH and NS–NS mergers radiate gravitational waves (GW150914 was the first
detection). You already have the kilonova event. Adding a screen-space ripple that
propagates outward from the merger — with the amplitude falling as `1/d` and the
frequency chirping upward as the bodies spiral together — is both correct and
cheap. It also gives the rival black hole a purpose: a **binary inspiral** where
the rival spirals in over ~30 s, chirps, and merges, would be a genuinely exciting
set-piece grounded in real physics.

### K. Relativistic aberration
Once `β` exists (finding 15 / F), the background starfield should crowd forward as
you accelerate — aberration, the same effect that makes the CMB dipole. Because
the starfield is already a parallax-offset tile, this is an offset tweak rather
than a re-render. Strong speed sensation, and physically correct.

### L. Time dilation clock
Show proper time vs coordinate time. At `r = 1.155 b_c` the factor is
`√(1 − r_s/r) ≈ 0.816` — a clock near the hole runs ~18% slow. As a run stat this
is a lovely detail: "you experienced 2:04; the universe saw 2:31."

### M. Roche-limit stripping
Related to G: a passing body that comes within its Roche limit should be stripped
into a stream *before* tidal disruption. Adds a second, gentler regime and makes
close approaches visually interesting without a full disruption event.

### N. Pulsar lighthouse beam
Real pulsars emit beamed radiation from a magnetic axis misaligned with the spin
axis, sweeping like a lighthouse. The game already animates a pulse (`pulseT`,
`beatMax`). Making the pulse a **rotating beam cone** that is dangerous to cross
would turn the pulsar from a static hazard into a timing challenge, and it is the
correct geometry.

---

## Suggested order

1. **A** (orbits) and **C** (beaming) — largest realism gain per line changed.
2. **E** (mass as state) — unblocks the systemic fix and four other items.
3. **B** (AGN rename) and **D** (subring spacing) — near-free wins.
4. **F** (spin) — the big feature; best done after E, and it makes 16 real.
5. **G**, **J** — the two best set-pieces, both grounded in real phenomena.

## A note on what *not* to change

Several "inaccuracies" here are good design and should stay: the pulsar shield
(19), the wormhole (26), and the star subtype mix (23) are all defensible, and
the kilonova, white dwarf and brown dwarf entries are already accurate. The
game's instinct to justify mechanics with real objects — degenerate matter paying
more, r-process elements in a kilonova — is exactly right, and the corrections
above mostly amount to letting that same instinct reach the numbers.
