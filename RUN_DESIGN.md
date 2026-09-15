# SINGULARITY — making the endless run worth repeating

A design brief on what the game is missing, and what to add. Companion to
`PHYSICS_REVIEW.md`, which covers realism rather than engagement.

Sourced findings are marked `(src)` with references at the end. Anything marked
**Judgement:** is my design opinion, not a research finding.

---

## The diagnosis in one line

The game has a **growth loop but no curve, and no investment**.

`(src)` Nir Eyal's *Hooked* model is Trigger → Action → **Variable Reward** →
**Investment**. The game has the first three. It has no Investment: nothing you
do in run N changes run N+1. That is the single largest gap.

**Judgement:** the second problem is subtler and more damaging. Hawking decay is
a constant drain, which means the run has no *shape*. Pacing doctrine holds that
intensity is only legible against relief — but this game sits at roughly 80%
stress from the ten-second mark and never lets go, so there is nowhere to build
to. The run is a flat line, not a curve. Players do not remember flat lines.

---

## 1. The tension curve (fix this first — it is free)

`(src)` GameAnalytics benchmarks put the median mobile session at **4m45s**, with
top-quartile games averaging 8–9 minutes. A run should therefore land in the
**2–4 minute** band, and the hook must fire inside the first 60 seconds.

**Judgement:** right now the run length is roughly right but the *shape* is
wrong. Three changes, all cheap:

- **Satiated window.** Suspend decay for ~2s after every meal. Decay stops being
  a tax you can only flee and becomes a rhythm you can ride. This also creates
  skill expression for free: optimal play becomes a steady feeding cadence
  rather than a sprint.
- **Scale decay to the combo tier.** High combo should mean a *slower* drain —
  the reward for chaining is that the floor drops away. It ties the two existing
  systems together and gives combo a second meaning beyond score.
- **Read the drain.** Decay is currently a number falling with no visual. Loss
  that cannot be attributed produces helplessness. The low-mass vignette already
  exists; extend it to a continuous, readable indicator of the *rate*.

This is the highest value-per-line change available. It uses systems that already
exist.

## 2. Make the eras real (the content is already written)

The seven eras — NEBULA → PROTOSTAR → MAIN SEQUENCE → RED GIANT → SUPERNOVA →
QUASAR → SINGULARITY — are currently cosmetic labels. They are seven free
"arrival" moments being thrown away.

**Judgement:** make each era a **named, announced threshold with a run-scoped
rule change**:

| Era | Rule change |
| --- | --- |
| PROTOSTAR | decay −20% |
| MAIN SEQUENCE | rarer lethal spawns |
| RED GIANT | combo window +0.3s |
| SUPERNOVA | shockwave every 12th combo instead of 20th |
| QUASAR | jets become lethal *and* harvestable |
| SINGULARITY | run-ending event (see §6) |

No new art, no new content pipeline. The labels, the thresholds and the
announcement toast all exist. This converts "era reached" on the report card from
a decoration into a ladder.

## 3. Give the player a choice without stopping the game

`(src)` Slay the Spire (1-of-3 card), Archero (1-of-3 on level-up) and Vampire
Survivors (1-of-N on level-up) all **freeze time** to present a choice. Those
need a pause, and a pause breaks flow in an arcade game.

**Judgement:** this game already owns the perfect no-pause choice moment — **the
every-20th-combo shockwave**. Convert it from an automatic effect into a 3-way
pick:

- The game drops into ~0.8s of slow-motion.
- Three options appear left / centre / right.
- You select by **steering**, using the input you are already holding.

The choice lives in the movement space rather than a menu, so it never
interrupts. Options could be: *clear the field* (current behaviour), *absorb
everything edible on screen*, or *shield for 5s*.

Two more that need no pause at all:

- **Greed gates.** A body visibly larger than you becomes edible for 2s while a
  combo streak is running. Risk and reward decided entirely by movement.
- **Pre-run build pick.** A 10-second choice before the run starts, not during
  it. Build-defining decisions belong here.

## 4. Loss and near-miss psychology

`(src)` Larche, Musielak & Dixon (2016, *J Gambling Studies* 33:599–615) ran 60
Candy Crush players for 30 minutes measuring heart rate and skin conductance.
Near-misses were **more arousing than losses**, were rated **the most frustrating
outcome of all**, and — the finding that matters — *"of any type of outcome,
near-misses triggered the most substantial urge to continue play."*

`(src)` Goal-gradient hypothesis (Hull 1932; Kivetz et al. 2006): effort rises as
perceived distance to the goal shrinks. Endowed-progress effect (Nunes & Drèze
2006): pre-filled progress increases completion rates.

**Judgement:** the existing near-miss line is the right *category* of cue but the
wrong *unit*. "412 AWAY FROM BEST" is an abstract number. Restate it in the run's
own currency:

- `2 MEALS FROM YOUR BEST`
- `3.1s FROM YOUR BEST`

Second: per Larche, the near-miss manufactures an urge that dies at the first
friction point. The death screen must lead with one-tap **RETRY** — it already
does, and that should be protected. Third: the game only fires near-miss feedback
at death. Extend it *inside* the run — missing a combo by a tenth of a second
should flash `SO CLOSE`.

## 5. Meta-progression — and the trap to avoid

`(src)` Bycer, *The Pitfalls of Meta Game Design* (gamedeveloper.com, 2015):
when meta is the only progression, *"you'll play runs just to impact the
Meta-game until you are far enough along to play 'for real,'"* and *"the player's
skill is being undermined."* His positive example is Binding the Isaac, where
meta adds **options, not power** — *"there is never a point in Isaac where you
will unlock enough meta-game content to let you win."*

**Judgement — and this is the most important warning in this document:** any
permanent `+mass` or decay-resistance unlock **destroys the core mechanic**. The
entire game is a size comparison. A size buff deletes the threat inversion that
makes it work. Never ship a power currency here.

Two patterns are safe and cost almost nothing:

- **Variant unlocks, not stat unlocks.** Downwell's Styles model: new *starting
  rules*. "Start at 3× mass but decay twice as fast." "Fast, but you cannot eat
  anything above your own size." Each is a config object, not content.
- **Ascension-style tiers.** Slay the Spire gets twenty tiers of replayability
  out of pure modifiers, and they *increase* tension rather than flattening it.
  Self-imposed difficulty is infinite content with no asset cost.

A **daily seeded run** is also viable: one attempt, fixed seed, identical
encounters for everyone. `(src)` Slay the Spire's Daily Climb does exactly this.
It needs a seed passed to the existing PRNG, which the game already has
(`mulberry32`).

## 6. The endless problem — give the ladder a top

`(src)` Substitutes for a win condition in endless games: a mastery ladder
(Ascension), a seeded leaderboard (Daily Climb), a completion checklist, or an
explicit terminal event. `(src)` Vampire Survivors hard-caps the run at 30:00
when **Red Death** spawns to end it; Endless Mode is a *separate unlock* that
removes the cap.

**Judgement:** **SINGULARITY should be a run-ending event, not a continued
grind.** A game with no ending needs somewhere to stop that feels like an
ending. Reaching the final era should trigger a scripted, triumphant finale —
and then offer, explicitly, to continue into Endless. That gives the run a
destination while preserving the endless mode for players who want it.

## 7. Missions (the retention pillar)

`(src)` Jetpack Joyride keeps exactly **three active missions** at a time;
completing them levels you up and rolls a new set. The mission system is
identified as that game's retention pillar.

**Judgement:** this is the cheapest possible answer to the Investment gap, and it
requires no content pipeline if the missions are *parametric* rather than
hand-authored. Examples drawn from what the game already tracks: *reach era 4*,
*peak combo ×15*, *eat 3 white dwarfs in one run*, *survive 3 minutes*, *clear a
shockwave with 8+ kills*. Three at a time, rerolled on completion, persisted in
the existing save blob.

This is what turns "one more run" into "one more run, I'm two meals from
finishing a mission."

## 8. What NOT to do

- **No permanent power unlocks.** See §5 — it breaks the core mechanic.
- **No weekly/seasonal content.** `(src)` Subway Surfers' Weekly Hunt is the one
  popular pattern that cannot be copied without a live-ops pipeline.
- **No mid-run menu.** Every choice must resolve through movement or happen
  before the run.
- **No new currencies.** The game has score and best. Adding a third number to
  track is friction, not depth.

---

## Suggested order

| Priority | Change | Cost |
| --- | --- | --- |
| 1 | Satiated window + combo-scaled decay (§1) | ~20 lines |
| 2 | Near-miss in run currency (§4) | ~10 lines |
| 3 | Eras as announced rule changes (§2) | ~40 lines, no assets |
| 4 | Missions, 3 at a time (§7) | ~80 lines, save-blob field |
| 5 | Shockwave as a 3-way steering pick (§3) | ~120 lines |
| 6 | SINGULARITY finale + Endless unlock (§6) | ~100 lines |
| 7 | Daily seed + Ascension tiers (§5) | ~150 lines |

Items 1–4 are a day's work and address the two real problems: the flat tension
curve and the missing investment. Everything after that is depth.

## References

- GameAnalytics, *Mobile Gaming Benchmarks* (2024, 2025)
- Eyal, N. *Hooked: How to Build Habit-Forming Products*
- Bycer, J. "The Pitfalls of Meta Game Design", gamedeveloper.com, 2015
- Larche, C., Musielak, N., Dixon, M. (2016). *J Gambling Studies* 33:599–615.
  DOI 10.1007/s10899-016-9633-7
- Kivetz, R., Urminsky, O., Zheng, Y. (2006), goal-gradient hypothesis
- Nunes, J., Drèze, X. (2006), endowed progress effect
- Slay the Spire: Ascension tiers, Daily Climb
- Downwell: Styles meta-progression; GDC talk "Polishing the Boots"
- Vampire Survivors: 30-minute cap and Red Death
- Jetpack Joyride: three-mission system
- Alto's Odyssey: Zen Mode
- Subway Surfers: Weekly Hunt
