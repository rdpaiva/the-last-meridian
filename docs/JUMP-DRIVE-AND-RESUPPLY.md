# Jump Drive & Resupply — Design Notes

> **Status:** Phase 1 **IMPLEMENTED** (2026-06-18) on `feat/phase0-smoke-harness`
> — all six slices landed; typecheck + headless smoke green. See *Implementation
> notes & deviations* below for where the build differs from this spec.
> **Phase 1 only** — deployable jump gates (Phase 2) are **designed but not built**.
> See the *Phase 2 — deployable jump gates* section below for the converged design
> and sliced build order.

---

## Implementation notes & deviations (as built)

The slices below were all built. A few things differ from the spec — recorded
here so the doc matches the code:

- **Detection audio.** The spec called for an RWR "rising whine" (reusing the
  `MissileWarning` idiom) when you detect an enemy spool. That literally reused
  the missile-warning blip and read as a *missile lock* — confusing. Replaced
  with the enemy's **own jump-drive clip played spatially** at their position
  (you hear their drive winding up, attenuating with distance; the trigger
  "boom" lands where they vanish). The radar **filling-ring** is unchanged.
- **Jump FX.** Implemented as a **BSG "FTL crack"**: a small cool flash plus a
  **screen-space ripple post-process** (`JumpRipple`) that refracts the scene —
  the wavefront expands and the area behind it ripples like a pond. Plays at
  **both** ends (departure + arrival), so observers see a ship vanish and a
  jumper sees itself arrive. New view files: `JumpFlash`, `JumpFlashSystem`,
  `JumpRipple`. (The HUD countdown ring + camera snap/trail-flush are also in.)
- **Player spool also shows on the radar** (a filling ring around your own
  center marker), not just enemies — symmetric.
- **Jump-drive sound lifecycle** is tracked **per ship** so a spool clip is cut
  (quick fade) if the ship is destroyed *or* cancels mid-spool; a completed jump
  is released to ring out (trigger + tail). See `SoundSystem.startJumpDrive` /
  `stopJumpDrive` / `releaseJumpDrive`.
- **Drive cooldown** (`GameConfig.jump.cooldownMs`) is **12s**; `spoolMs` 6000.
  The state machine returns `cooldown → idle` when the timer expires (a ship can
  jump again after it recharges).
- **Magazines** (`shipTypes[*].cannonAmmo`): spitfire 240, breaker 420,
  wraith 180, reaver 480. **Service** (`GameConfig.service`) radius tuned to 40
  (measured per launch-bay), loiter gate 7 u/s.
- **Config homes:** `GameConfig.jump` (spool/cooldown/commit/arrivalTrauma +
  `doctrine` for the AI), `GameConfig.service`, `GameConfig.jumpFx` (flash +
  `ripple`). AI thresholds roll once per pilot from the seeded sim RNG.
- **Wingmen jump too** — they're `AIController`s, so the doctrine is symmetric;
  they retreat/dock/jump to *your* carrier. There is currently **no separate
  wing tuning** (shared `jump.doctrine`).
- **Still pending (owner):** a CC0 attribution line for `jump-drive.mp3` in
  `public/sounds/SOURCES.md` (the mp3 is present; agents don't author audio).

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
- **Phase 2 (designed 2026-06-18, not built):** **deployable jump gates** — a heavy
  (gunship) deploys a forward jump node (a new mid-match entity system; the biggest
  novelty/risk). Framing it as diegetic "fielded technology" fits the realism lean better
  than a personal teleport. Full design + sliced build order in *Phase 2 — deployable
  jump gates* above.

## Implementation / build order

Build in **slices**, in order — each independently shippable and verifiable. Don't
one-shot the whole feature. Build on `feat/phase0-smoke-harness`; respect the
*Build on Phase 0* section (sim vs view vs input).

**Cross-cutting rules (every slice):**
- Run `npm run typecheck` + the headless smoke harness after each slice.
- Sim changes that legitimately alter behavior (ammo runs dry, AI retreats) **will
  shift the smoke baseline** — recapture it and sanity-check the new trace, don't just
  bless the diff.
- All new tunables live in `GameConfig`; numbers below are **starter values — owner
  tunes later**, not final balance.
- Schema/protocol work is **not** needed yet (no networking until Phase 1) — but the
  Phase 1 ship schema already anticipates `ammo` + jump state.

**Slice 0 — prereqs (`[human]`/owner):**
- Confirm you're on `feat/phase0-smoke-harness`.
- Drop `jump-drive.mp3` into `public/sounds/` + a CC0 line in `SOURCES.md` (agents
  don't author/commit audio — this unblocks Slice 4).
- Add a `GameConfig` section for the jump/ammo/service knobs.

**Slice 1 — finite cannon ammo + HUD readout** (smallest, self-contained):
- Sim: add `cannonAmmo` / `startCannonAmmo` to `Ship` (mirror `missileAmmo`); per-ship
  magazine in `shipTypes`. Gate `tryFire()` on `> 0`, decrement on fire, refill on
  respawn.
- View: replace the HUD "bolts in flight" number with a **draining ammo readout** (dim
  at empty).
- Done: typecheck green; baseline recaptured (ships now run dry); eyeball — ammo drains
  and the HUD shows it.
- Starter: fighters ~240 rounds (~30s sustained), gunships ~400; wraith/pure-dogfighter
  smaller. *(owner tunes)*

**Slice 2 — carrier service bubble (repair + rearm):**
- Sim (server-authoritative): proximity to own carrier bow/bays **+ loiter (speed gate)**
  → heal HP + refill ammo over time. Reuse `Mothership` position/bay geometry (cheap
  circle test).
- View: a "DOCKED / SERVICING" HUD cue.
- Done: fly in, slow down, HP + ammo refill over time.
- Starter: bubble radius, heal rate (HP/s), refill rate (rounds/s) *(owner tunes)*.

**Slice 3 — jump state machine + input toggle:**
- Sim: jump state machine on `Ship` (idle → spooling(timer) → fired/cancelled) +
  drive cooldown, **ticking on `dt`**; teleport to assigned bay at zero velocity
  (respawn-style; reuse trail reset).
- Input: `jumpPressed` edge intent on `InputState`; `LocalInputController` edge-detects
  the toggle key (`J`). Tap = arm, tap again = cancel; inert during cooldown.
- Done: press `J` → ~6s spool → teleport into the service bubble; second tap cancels;
  cooldown gates re-arm.
- Starter: `spoolMs` 6000 (match the audio), `cooldownMs` *(owner tunes)*.

**Slice 4 — audio + jump FX (via `SimEventBus`):** *(needs Slice 0 mp3)*
- Sim emits `jumpSpoolStarted` / `jumpFired` / `jumpCancelled`.
- View: `jump-drive.mp3` (build = spool, trigger on teleport, 2s tail through arrival),
  quick fade on cancel; HUD countdown ring; departure whoosh.
- Done (`[human]` eyeball): build → trigger on teleport → tail; cancel fades; ring
  counts down.

**Slice 5 — detection signature + radar:**
- Sim: `SensorSystem` signature spike while spooling, **overrides nebula concealment**.
- View: radar **filling-ring** blip for detected spooling hostiles; RWR rising-whine
  (reuse the `MissileWarning` idiom).
- Done: a spooling enemy shows on radar even inside a nebula; RWR alerts.

**Slice 6 — AI jump-out doctrine** (the meatiest; see *AI jump-out doctrine*):
- `AIController`: OR trigger (low HP **or** low ammo), **per-ship thresholds rolled at
  spawn from the harness's seeded RNG** (never `Math.random()`), jump-vs-dock range
  split, survival-spool behavior by caution trait (flee vs blaze-of-glory), and the
  "finish the runner" press on detected spoolers.
- Done: baseline recaptured (AI now retreats/jumps — verify fights still resolve);
  `[human]` eyeball — enemies bug out to resupply, some flee, some go down swinging.
- Starter: HP ~35% (spread ~20–45%), ammo ~10% *(owner tunes)*.

## Phase 2 — deployable jump gates

> **Status:** designed (2026-06-18), not built. Build on the same sim/view discipline
> as Phase 1 (see *Build on Phase 0*). This is the biggest novelty in the feature: the
> **first placed, persistent, mid-match entity** in the game — everything else is a
> ship, a bolt, or scenery.

### The core idea (why)

- Phase 1 gives you *one* destination (home). Phase 2 lets a heavy ship **field a forward
  jump node** anywhere it chooses, so the jump becomes a **destination chooser** (deployed
  gates **or** the mothership), not just a recall. This is map control: you decide where
  "home-ish" is.
- Framed diegetically as **fielded technology** (a deployed beacon you anchor in space),
  which fits the realism lean better than a personal teleport.
- It **reuses three existing patterns** and adds exactly one new concept (a persistent
  placed entity): the per-ship ammo field (`missileAmmo`/`cannonAmmo`), `DamageTarget`
  collision, and `SimEventBus` FX. The only genuinely net-new design work is the
  **destination-selection control**.

### Decisions locked

- **Gate-laying is a gunship capability, not a new ship class.** No new hull/GLB/story-bible
  name/thumbnail/AI-doctrine pipeline. (Revisit a dedicated *tender* class later only if the
  support role proves it wants its own hull — see *Considered but not adopted*.)
- **The gate is destructible and faction-locked:** it has an HP pool (`DamageTarget`), only
  the owning faction can **jump to** it, and the enemy can **destroy** it. That killability
  is the counterplay that keeps it from being oppressive.
- **Transit-only — no service bubble.** A gate moves you; it does **not** repair or rearm.
  The carrier stays the **sole** service hub. A forward gate buys *position*, not a free
  top-off. Hold this line firmly — it's what protects the Phase 1 resupply loop.
- **State-driven enemy visibility** (the twist): a **cold/unused** gate is **invisible to the
  enemy's long-range radar**; **using** it (a ship jumps in/out) **lights it up**; close
  **visual range** still spots it. See *Detection / visibility* below.

### Gunship capability + the gate economy

- New per-ship-type field in `shipTypes`, mirroring the ammo pattern: **`gateAmmo`** (start
  `1`, maybe `2`) on the heavies (**Breaker / Reaver**). Fighters get `0` — they can't carry
  a gate.
- **Consumed on deploy; refilled at the carrier service bubble**, exactly like cannon/missile
  ammo. To lay another forward gate you must **go home first** — this ties gate-laying into
  the *existing* resupply loop instead of inventing a second economy. Nice tension: every gate
  you field is a trip home you've spent.
- **Deploy is its own edge-event intent** (`deployGatePressed` on `InputState`), separate from
  the jump toggle. `AIController` emits the same intent for symmetry.
- **Anchoring time:** deploying isn't instant — the gunship must **loiter a beat** (speed-gated,
  reuse the service-bubble loiter idiom) while it "anchors the node." That deploy window is a
  deliberate **vulnerability cost**, consistent with the feature's time-as-cost theme.
- **Faction cap on simultaneous gates** (start `1`, maybe `2`). A hard cap keeps the map readable
  and the radar uncluttered. Gates persist until **destroyed** or **match end**.

### The gate as a battlefield entity

- New sim entity **`JumpGate`** + manager **`JumpGateSystem`**, structured parallel to
  `Missile` / `MissileSystem` (spawn / track / dispose; feeds the radar and the jump
  destination list).
- **It's a `DamageTarget`.** Add each gate to the **opposing** faction's `LaserSystem` /
  `MissileSystem` target lists — enemies then shoot it down with **zero new collision code**,
  exactly like a ship or mothership. On death: `gateDestroyed` event → explosion FX, radar blip
  clears, it drops out of the owner's destination list.
- **Keep-out / no service:** it does **not** carry a service bubble and does **not** heal/rearm.
  Arrival at a gate is **into open space at zero velocity** (respawn-style snap; reuse the trail
  reset / interpolation hard-snap rules from Phase 1), *not* into a safe bubble — you arrive
  forward and exposed.

### Destination selection (the one net-new control)

The jump is now a chooser, and this is the single place the feature brushes the CLAUDE.md
"no complex menu system" guardrail. **Chosen approach: cycle-during-spool.**

- `J` **arms** a jump to the **nearest friendly node** (gate or carrier) as the default — so the
  one-tap gesture still does the sensible thing with no extra input.
- A **second key** (e.g. `K`, placed away from the movement/fire cluster) **cycles the destination**
  among friendly nodes *while the 6s spool runs*. The radar **highlights the armed target**.
- The spool window is otherwise dead time — filling it with a target decision is free UX budget.
- **Fallbacks if cycle feels heavy in playtest:** (a) pure **auto-nearest** (no choice — simplest,
  but wastes the tactic), or (b) radar-pick before arming (richest, closest to a "menu" — avoid
  unless cycle fails). Prototype cycle first.

### Detection / visibility (the twist, via `SensorSystem`)

Visibility is **not binary** — the gate is faction-locked, so **you always see your own gate**
(you placed it). The only variable is what the **enemy's** sensor picture shows, and that rides
the existing `SensorSystem` gradient (range, eyeball `visualRange`, nebula, ghost decay):

- **Cold / unused → invisible to enemy long-range radar.** A gate you drop deep and don't touch
  stays secret — they can't fly over and farm it because they don't know it's there.
- **Using it lights it up.** A jump **in or out** throws a **signature spike** at the gate's
  location — the **same idiom** as Phase 1's "spooling overrides nebula stealth." Now the enemy
  gets pings there and converges → the gate becomes a **defensible strongpoint** you must garrison.
  Routing your fleet through a gate is the live tradeoff: *useful = exposed.*
- **Close visual range still spots it.** An enemy within eyeball range stumbles onto it. So a gate
  can be **found** — by being used or by someone flying up on it — but **never sniped from across
  the map.**
- This activates the "kill the enemy's forward gate" objective layer **only once the gate reveals
  itself**, which feels earned rather than free.
- **Watch item (playtest dial):** a purely cold gate the enemy never finds is un-counterable until
  used. Probably fine (counterplay = make them use it, then punish the traffic). If it feels too
  safe, the dial is a faint **passive** signature — detectable only at medium-close range, decaying
  like a ghost — so a patrol can *sweep* for gates without a free long-range ping.

### Sim / view split (must stay compliant)

- **Sim (server-authoritative, deterministic, no scene imports):** the `JumpGate` entity + HP, the
  deploy/anchor state machine, `gateAmmo` decrement/refill, the **faction cap**, the destination
  resolution (nearest + cycle target), and the **signature-spike** that overrides stealth. AI
  deploy/defend judgment uses the **harness's seeded RNG**, never `Math.random()`.
- **View (client-only, via `SimEventBus`):** deploy flash / anchoring FX, the gate's idle hum,
  destruction explosion, radar blip, and the destination-highlight UI — all off events
  (`gateDeployed` / `gateDestroyed`, reuse `jumpFired` for the arrival crack), **never inline.**
  These become Phase 2-networking FX messages.
- **Protocol:** adding the gate entity + `gateAmmo` to the schema is a both-sides deploy — bump
  `protocolVersion`. Gate arrival is a **position discontinuity** — same interpolation hard-snap
  rule as a respawn/jump.

### AI doctrine (additions)

- **Deploy judgment:** a gunship with `gateAmmo > 0` deploys a forward gate when the fleet's
  fighting **far from home** and it can find a **defensible-ish spot** (not under immediate fire) —
  rolled against its per-ship caution trait so the fleet doesn't all deploy in unison.
- **Defend judgment:** when an *owned* gate reveals (gets used / spotted) and an enemy presses it,
  the `FleetCommander` can re-task escorts to **garrison** it — reuses the existing `defend` order
  seam pointed at the gate instead of the carrier.
- **Exploit judgment:** when an *enemy* gate is detected, the "finish the runner" / strike doctrine
  extends to **"kill the exposed gate"** as a high-value target.

### New files (anticipated)

```
src/game/
  JumpGate.ts          single deployed node: position, HP (DamageTarget), owner faction,
                       deploy/anchor state, signature state (cold/revealed)
  JumpGateSystem.ts    per-faction gate pool: deploy + cap + track + dispose; feeds radar
                       + the jump destination list; emits gateDeployed/gateDestroyed
```
(Plus a small view FX file if the deploy/anchor crack wants its own, mirroring
`JumpFlash`/`JumpFlashSystem`.)

### Build order (slices — each independently shippable)

Same cross-cutting rules as Phase 1: `npm run typecheck` + the headless smoke harness after each
slice; sim changes that shift the baseline get **recaptured and sanity-checked**, not blessed;
all tunables in `GameConfig`; starter numbers are **owner-tuned later.**

- **Slice 1 — `gateAmmo` + deploy mechanic (sim + HUD).** Add `gateAmmo` to `shipTypes`
  (gunships only), the `deployGatePressed` edge intent, the loiter-gated anchor window, decrement
  on deploy, refill at the carrier. HUD shows gate ammo. *Gate does nothing yet — just consumes.*
- **Slice 2 — `JumpGate` entity + `JumpGateSystem` (sim).** Spawn a persistent placed node on
  deploy; faction cap; it's a `DamageTarget` added to the opposing weapon systems; `gateDestroyed`
  on death. Radar shows **your own** gates only.
- **Slice 3 — gate as jump destination + selection control.** Extend the jump state machine to
  resolve a destination; arm-to-nearest; the `K` cycle-during-spool with radar highlight; teleport
  to the chosen gate at zero velocity (hard-snap).
- **Slice 4 — state-driven enemy visibility (`SensorSystem`).** Cold = hidden from enemy radar;
  use/proximity reveal via signature spike (overrides nebula); the optional faint passive dial.
- **Slice 5 — deploy/destruction FX (via `SimEventBus`).** Deploy flash + anchor cue, idle hum,
  destruction explosion, radar reveal blip — all off events.
- **Slice 6 — AI doctrine.** Deploy / garrison-defend / kill-enemy-gate judgment, seeded RNG;
  recapture baseline (fleets now field and contest gates — verify fights still resolve).

### Open questions (Phase 2)

- **Gate count / cap** — start at 1 per faction; does 2 stay readable?
- **Cycle key** — `K`? Confirm it's clear of the movement/fire cluster on the chosen layout.
- **Cold-gate safety** — ship without the passive signature and add it only if playtest shows a
  cold gate is too un-counterable.
- **Dedicated tender class** — still deferred; promote from gunship-capability only if the support
  role earns its own hull.

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

- **None — design converged.** All Phase 1 decisions are settled and **built**; Phase 2
  (deployable jump gates) is now **designed** with a sliced build order (see *Phase 2 —
  deployable jump gates*). Remaining Phase 2 unknowns are tuning/playtest dials, tracked
  in that section's *Open questions (Phase 2)*.
