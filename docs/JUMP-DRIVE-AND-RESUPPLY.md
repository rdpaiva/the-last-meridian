# Jump Drive & Resupply — Design Notes

> **Status:** design fully converged, not yet implemented — ready to build.
> **Phase 1 only** — deployable jump gates are a later phase.

---

## The core idea (why)

- Make cannon ammo **finite** and let **battle damage** persist → a reason to leave
  the fight → the **carrier becomes an active hub** (repair + rearm), not a passive
  HP bar → a **jump drive** makes the trip home viable instead of tedious.
- Two motivations converge on one mechanism: (1) add a strategic resupply/retreat
  loop, and (2) **discourage holding the fire button forever** — today constant fire
  has zero cost.
- The three systems interlock into **one loop**: finite ammo + slow jump + carrier
  service. They are interdependent, not separable features.

## Cannon ammo

- **Generous, finite magazine, per ship type.** No passive regen — regen rewards the
  exact trigger-holder we want to discourage.
- **Empty = defenseless on cannons.** The only recourse is to return to the carrier.
- **Magazine size is the key tuning lever:** a disciplined pilot rarely empties in a
  normal engagement; a trigger-holder runs dry partway through.
- **Per-ship-type magazines** become part of ship identity (gunships: big drum,
  sustained fire; fighters: smaller, burst discipline).
- Side benefit: **accuracy starts to matter** — each bolt is a visible fraction of
  the drum.
- **HUD must show a clear, draining ammo readout** (replace the current near-useless
  "bolts in flight" number). The visible drain *is* part of the anti-spam mechanic.

## Carrier as hub — one service, two entrances

- There is **one service** (repair HP + refill cannon/missile ammo at your carrier),
  reached by **two entrances**: **flying in & docking**, or **jumping home**. These
  are not two systems — they are two ways to arrive at the same service.
- **Service zone = a generous proximity bubble around the carrier's bow/bays.**
  Loiter inside it (slow down — not strafe past) and HP + ammo **refill over time**.
  Forgiving radius, **no precise alignment** required (arcade-friendly, not a docking
  minigame).
- **Over-time, not instant** — the loiter creates a vulnerability window and a "do I
  have time to top off?" decision.
- **Geometry makes it a real decision:** each carrier's **bow (and its launch bays)
  faces the enemy**, so docking happens on the **contested front**, not a safe rear.
  That turns the hangar into a **pressurable chokepoint** — a striker can harass the
  enemy's bays to **deny resupply** — and it's **symmetric** (your bays can be
  pressured too).
- Reuses existing carrier geometry: it's a cheap distance check against the bow/bay
  area, the same circle-test shape already used for nebula zones / AI avoidance. To
  leave, re-launch via the existing catapult or just fly out.

## Two entrances (a range split, not redundancy)

- **Close → fly in & dock:** cheap, quiet (no spool, no signature), available anytime.
  Risk is running a gauntlet if enemies sit between you and home.
- **Far / disarmed → jump:** fast, but costly (~6s spool) and loud (lit-up
  signature). The only viable way home when the flight wouldn't be survivable.
- They naturally cover **different distances**, so they complement rather than compete.

## The jump drive — Phase 1 (recall to own carrier only)

- Player (and AI — symmetric) **initiates** a jump. Phase 1 destination = **own
  mothership only**.
- **~6s spool-up** ("charge drive / calculate coordinates") — a deliberate cost so
  the jump is **preplanned, not a reactive panic button**; you can't bail mid-dogfight
  on a whim. Duration is **matched 1:1 to the `jump-drive.mp3` asset** (see Jump audio).
- You can **fly, fight, and perform all normal maneuvers while spooling.**
- Justified by scale: real cross-field transit is **~45s**, so even a ~6s jump is a
  **large, broadly worthwhile** saving (not niche), and the **only viable way home
  when disarmed deep in enemy territory.** The jump is what makes finite ammo
  *playable*. (We had headroom to go longer — 8–12s all work — but chose ~6s to map
  cleanly onto the audio.)
- **Interruption: none.** Enemy fire never resets or interrupts the spool — surviving
  the countdown under fire *is* the skill test. (Only the pilot can stop it; see cancel
  below.)
- **Arrival = into the service bubble at zero velocity** (like respawn): you reappear
  at your carrier's bow/bay, stopped, and the **same over-time service** ticks — no
  instant top-off. The jump buys *transit*, not free repair; from there a jumper and a
  ship that flew in are in exactly the same state.
- **Cancellable — but at a cost.** The pilot *can* abort a spool (situations change;
  you shouldn't be trapped leaving a fight you've turned around). The cost is the
  **drive cooldown** (below): aborting spends it, leaving you without your escape for a
  while. This keeps commitment honest and kills **fake-jump baiting** (you can't cry
  wolf to lure the enemy in, then cancel).
- **Drive cooldown** gates *both* a completed jump *and* a cancel — after either, the
  drive must recharge before it can spool again. (Also stops anyone chain-jumping every
  ~10s.) A useful knob regardless.
- **Voluntary vs involuntary, as a matched pair:** enemy fire **cannot** knock you out
  of a jump (surviving the countdown is the skill test); **only the pilot** can call it
  off, and doing so costs the cooldown.
- *(Optional flourish)* a **commit point** — lock the jump in for its final ~1s
  ("coordinates locked"), so a last-instant abort isn't possible.

## Controls

- **Jump = a toggle key (default `J`), not a hold.** Tap once to **arm/start the
  spool**; tap again during the spool to **cancel** (incurs the drive cooldown). A hold
  would tie up a finger for ~6s and fight the movement hand — a toggle keeps you free to
  fly and fight while spooling.
- **During cooldown the key is inert** (optionally a short "denied" blip).
- **Feedback removes ambiguity:** arming kicks off the `jump-drive.mp3` build-up + HUD
  countdown ring; cancelling does the quick audio fade + clears the ring. The ~6s window
  plus an always-available cancel make accidental presses recoverable, so no heavyweight
  guard is needed (add a tiny ~0.3s hold-to-arm later *only* if playtests show
  fat-fingering).
- **Place the binding away from the movement/fire cluster** (WASD / Space) so it can't
  be hit mid-maneuver.
- **Implementation:** the jump is an **edge event** (key *just pressed*), not a held
  bool like `thrust`/`fire`. Add a press-detected intent on `InputState` (e.g.
  `jumpPressed`) consumed by a small jump state machine on `Ship` (idle → spooling →
  fired / cancelled). `AIController` emits the same intent for symmetry.

## Jump audio (`jump-drive.mp3`)

- The asset is **~8s total**: a **6s build-up → jump trigger hit at the 6s mark →
  2s fade tail**.
- **Anchor the trigger to the moment of jump-fire.** With the ~6s spool the sound
  starts at spool-start, so: the **build-up *is* the spool** (and doubles as the
  player's audible countdown), the **trigger hit lands exactly as the ship teleports**,
  and the **2s fade tail plays through arrival as the "whoosh out" departure cue** —
  let it ring; don't cut it at the trigger.
- **Cancel = quick fade, not a hard cut.** On a pilot abort, ramp volume to 0 over
  ~0.3–0.5s (optionally a short "power-down" blip). Damage never interrupts, so cancel
  and natural completion are the only stop cases.
- **This is the jumping ship's OWN drive sound** — distinct from the RWR rising-whine
  alert that *other* ships hear when they **detect** a spool (see Detection). Two
  separate audio layers.
- Drop the file in `public/sounds/` and add a **CC0 attribution line to
  `public/sounds/SOURCES.md`** (project convention).

## Detection / telegraph

- A **spooling jump drive is detectable** — a **signature spike** modeled in the
  existing per-faction `SensorSystem` (reuse `DETECTED`/`HIDDEN`, not a bolt-on icon).
- **Spooling fully overrides nebula stealth** — there is **no stealth while the jump
  drive is spooling**; charging the drive lights you up regardless of cover. You can't
  quietly bug out — the signature is the price of the jump.
- **Radar form:** a distinct **pulsing blip — ideally a ring that fills as the drive
  charges**, so both sides can read "how close is he to gone?"
- **Audio:** reuse the `MissileWarning` RWR threat-tone idiom (a rising whine).
- The **spooling ship's own HUD** shows the ~6s countdown (the audio build-up is the
  audible companion to it — see Jump audio).
- **The telegraph only matters if acted on:** requires new AI doctrine to **press /
  finish a fleeing (spooling) target.** Symmetric — the player gets the same
  "kill the runner" window when an enemy spools.
- **Payoff:** a spooling ship is **lit up, still shooting, high-priority** → everyone
  converges → a desperate last stand against a clock both sides can see.

## Symmetry / multiplayer

- **Whatever the player can do, the enemy can do.** The game is faction-agnostic and
  headed for multiplayer (play any faction).
- Architecture already supports it: the jump is **just another `InputState` field**
  (like `fireMissile`); `LocalInputController` vs `AIController` set it; the `Ship` /
  jump code is driver-agnostic. The only new AI work is the **judgment** to jump, not
  the mechanic.

## Build on Phase 0 (sim/view compliance)

- **Build this feature on the Phase 0 branch (`feat/phase0-smoke-harness`), not flat on
  `main`.** The jump drive touches nearly every file Phase 0 split (`Ship`, weapon
  systems, `AIController`, `SensorSystem`, `Mothership`, `Hud`, input, `Game.tick`).
  Built flat it would mix sim/view and collide with the split later; built on Phase 0
  it's born server-authoritative and multiplayer-ready. `main` is only ~3 *cosmetic*
  carrier-skin/docs commits ahead of Phase 0 (the gameplay is already folded in), so
  syncing them is a trivial merge.
- **Sim (server-authoritative, `shared`, deterministic, no scene imports):** the jump
  state machine + drive cooldown (tick on **`dt`, not `performance.now()`** — Phase 0
  removed wall-clock from the sim), finite cannon ammo (mirrors `missileAmmo`; the
  Phase 1 ship schema **already lists `ammo`**), the teleport (respawn-style), the
  carrier service bubble, and the AI jump-out doctrine.
- **AI thresholds must use the harness's seeded RNG**, never `Math.random()`, or the
  deterministic smoke-harness baseline breaks.
- **View (client-only, via `SimEventBus`):** `jump-drive.mp3`, HUD countdown ring,
  radar filling-ring, RWR whine, departure whoosh — all fired off events
  (`jumpSpoolStarted` / `jumpFired` / `jumpCancelled`), **never inline**. These become
  Phase 2 network FX messages.
- **Signature spike lives in `SensorSystem` (sim)** so it rides Phase 2's
  **sensor-filtered replication** — a spooling enemy becomes visible through the
  *server's* sensor filter (true anti-wallhack), not just client UI.
- **Teleport must bypass interpolation.** A jump-arrival is a position discontinuity;
  Phase 2's interpolation buffer must treat it as a **hard snap** (like a respawn —
  which already resets trails), not lerp a remote ship sliding across the map.
- **Protocol bump:** adding ammo + jump state to the ship schema (and the GameConfig
  tunables) is a both-sides deploy — bump `protocolVersion`.

## AI jump-out doctrine

- **Trigger (OR):** an AI ship commits to a jump when it's **low on HP *or* low on
  ammo** — either condition alone. (Out of ammo = defenseless, so it must go home
  regardless of HP; badly hurt = retreat regardless of ammo.)
- **Thresholds, per-ship-randomized:** each ship rolls its own thresholds **once at
  spawn** (stored on its `AIController`) so the fleet never bugs out in unison — some
  pilots timid, some berserkers. Suggested bases:
  - **HP ~35%**, with a **wide spread** (~20%–45%). Deliberately *earlier* than
    near-death: the ~6s spool can't be interrupted, so a ship that waits until ~15% HP
    usually dies mid-charge. ~35% leaves margin to survive it.
  - **Ammo ~10%** (a late trigger is fine — low ammo doesn't kill you during the spool).
  - Optionally a single per-ship **"caution" trait** that nudges both thresholds
    together (more legible personality than two independent rolls).
- **Jump vs. dock (range split):** needing service doesn't always mean jumping. If the
  ship is **already close to its carrier**, it just **flies in and docks** (cheap, no
  telegraph); it **jumps only when far** from home. Mirrors optimal player play.
- **Damage-triggered jump = personality-driven behavior.** How a ship acts during a
  *survival* (low-HP) spool keys off its per-ship nerve/caution roll — the **same trait
  that set its jump threshold**:
  - **Cautious pilots flee:** full throttle **away from threats / toward open space**
    (biased home) to break weapons range and survive the no-interrupt ~6s charge,
    firing only opportunistically — escape is the movement priority.
  - **Hotshot pilots go out in a blaze of glory:** they **keep pressing the attack**
    while the drive charges, betting they can win or at least die swinging — a defiant
    escape if they make it, a spectacular death mid-spool if they don't.
  - Either way, a survivor **rides the jump home to repair** (doesn't cancel just
    because it broke contact). A *low-ammo* jump, by contrast, is not an emergency and
    can egress calmly.
- **Pairs with the chase:** spooling overrides stealth, so the fleeing ship is lit up
  and the **"finish the runner"** doctrine sends hunters after it — a hunter-vs-prey
  sprint against a clock both sides can read.

## Realism stance

- Target **consequence-realism** (grounded logistics: RTB to rearm; a disarmed ship
  is prey), **not physics simulation.**
- **Resist the slippery slope** (fuel, ammo types, crew). Stop at **ammo + repair.**

## Scope / phasing

- **Phase 1 (this design):** finite cannon ammo · carrier repair/rearm · recall-jump
  to own carrier · spool detection signature · AI retreat + "finish the runner"
  behavior.
- **Phase 2 (deferred):** **deployable jump gates** — a heavy ship deploys a forward
  jump node (a new mid-match entity system; the biggest novelty/risk). Framing it as
  diegetic "fielded technology" fits the realism lean better than a personal teleport.

## Considered but not adopted (or deferred)

- **Passive ammo regen** — rejected (rewards spam).
- **Energy/heat cannon model** — considered; self-regulates tempo but doesn't drive
  the carrier loop, so not chosen for this feature.
- **Carrier point-defense "umbrella"** for covering retreats — deferred; the jump
  largely removes the need, but it could complement later.
- **Instant / no-spool jump** — rejected (free panic button).
- **Finite fuel / boost (afterburner over a slower "impulse" baseline)** — discussed,
  set aside for now. Unlike ammo, thrust is the *continuous* core verb, so a fuel tax
  penalizes simply playing; the better framing is an additive boost (regenerating, or
  carrier-refilled) with the baseline kept at today's speed. Mainly deferred to avoid
  **giving the player too many resources to track** (HP + cannon ammo + missiles + jump
  is already a full plate). Revisit only if movement needs more depth after the core
  loop ships.

## Resolved

- **Carrier service is over-time, in a generous bay/bow proximity bubble** (loiter to
  top off) — not instant, not precise-bay docking, not anywhere-on-the-hull.
- **Jump arrivals drop into that same bubble at zero velocity** and service over time —
  the jump is transit only, not a free top-off.
- **Spool is ~6s, matched 1:1 to the `jump-drive.mp3` asset** (build-up = audible
  countdown, trigger hit on jump-fire, 2s tail = departure whoosh).
- **A spool is cancellable, gated by a drive cooldown** that fires on both completion
  and cancel — so abort is allowed (agency) but never free (no fake-jump baiting),
  while enemy fire still can't knock you out of a jump.
- **No interruption from damage** — enemy fire can't reset the spool; surviving the
  countdown is the test.
- **No nebula stealth while spooling** — the signature spike fully overrides cover.
- **AI jumps out on low HP *or* low ammo**, with **per-ship randomized thresholds**
  (HP ~35% wide spread; ammo ~10%), prefers **docking when close / jumping when far**,
  and behaves by personality during a survival spool (cautious = flee, hotshot = blaze
  of glory). See *AI jump-out doctrine*.

## Open questions

- **None — design converged.** All Phase 1 decisions are settled; next step is
  implementation (and, later, Phase 2 jump gates).
