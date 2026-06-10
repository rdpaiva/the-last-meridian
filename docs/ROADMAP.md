# Roadmap

Snapshot of what's built, what's pending, and what's been considered
and explicitly skipped. Update this when you finish or start work.

---

## ✅ Done

### Core
- Vite + TypeScript + Babylon.js 7.x scaffold
- LHS coordinate system pinned (forward = +Z, up = +Y)
- Single render loop in `Game.tick` with delta-time clamp (1/30 s max)
- `GameConfig` as the single source of truth for tuning
- Rate-based exponential decay helpers in `math.ts` (no per-frame multipliers)

### Factions & match flow (multiplayer-ready spine)
- **`Faction`** model (`humans` vs `machines`) with `FACTION_THEME` colors/labels;
  player side chosen by a one-line `GameConfig.player.faction` flag (no UI)
- **Control decoupled from ship**: one `Ship` sim driven by a `ShipController`
  that emits an `InputState` — `LocalInputController` (keyboard), `AIController`
  (ported enemy AI), and a future `NetworkController`. The "player" is just the
  Ship wearing a local controller. (Merged the old `PlayerShip`/`EnemyShip`.)
- `Ship` takes injected movement/weapon config + faction + missile loadout;
  `FighterMesh.buildFighterMesh()` builds faction-themed AI fighters
- **Win/lose loop**: `Mothership` implements `DamageTarget` with HP; destroying
  the enemy mothership = victory, losing yours = defeat. `GameState`
  (`launching → playing → victory/defeat`) drives a frozen end screen +
  mothership death spectacle + Enter-to-restart
- **Respawn-from-launchpad fix**: a dead player relaunches from its mothership
  tube via a streamlined (skip-intro) `LaunchSequence`, not from world origin
- HUD: two faction mothership HP bars + VICTORY/DEFEAT banner
- **Radar** (`Radar.ts`): player-centered north-up canvas minimap, bottom-right;
  faction blips for fighters + both motherships, out-of-range contacts clamped
  to the rim (bearing to the objective)
- **Unbounded arena** (Phase 4): the X/Z position clamp is gone from `Ship`
  (`arena.halfWidth/halfDepth` now only size the reference grid + seed spawn
  scatter — no walls). `AIController` is re-leashed: idle fighters bias their
  wander toward their objective mothership (`ai.leashBias`/`leashRadius`),
  not arena center, so they press the front line instead of drifting off.
  Launch geometry generalized to the carrier's facing
  (`Mothership.getLaunchForward()` + `getLaunchExitDistance()` →
  `LaunchSequence` along an arbitrary axis), so `"machines"` launches correctly
  from the north pod.

### Player
- `Ship` simulation (was `PlayerShip`): thrust, reverse thrust, drag, rotation, speed cap
- Forward direction math (sin/cos rotationY)
- Arena bounds clamping
- HP system + `DamageTarget` interface impl
- Death → mesh disabled → respawn after delay
- Multi-muzzle firing system with ship-local coordinates
- `fireMode: "alternate" | "salvo"` — round-robin vs simultaneous
- Default config: dual wing blasters at (±0.85, 0, 0.1)
- `worldFromLocal()` helper for muzzle position transforms

### Enemy
- `EnemyShip` with same physics base as PlayerShip
- AI: wander (with center bias jitter) when out of range, engage when in range
- Fire test: distance < `fireRange` AND |angle| < `fireConeAngle` AND cooldown ready
- Procedural red mesh (crimson body, dark wings, hot-red engine, red "eye" sphere)
- Random respawn position helper (kept far from player)
- Tuning: slower than the player so the duel is beatable

### Player wingmen (Phase 5)
- **AI wingmen on the player's side** — `GameConfig.player.wingmen.count` (default 3)
  player-faction `Ship`s wearing an `AIController`, the same seam that drives the
  enemy fighters. Friendly-fire-free by construction (per-faction LaserSystems);
  they appear on the radar as friendly blips and are missile-immune to the player.
- **Standing orders** (`AIController` `AIOrder`, static per-wingman, no command UI
  yet — multiplayer would re-issue them): `cover` (escort the leader in a slot,
  break to engage threats within `ai.coverBreakRange` of the leader, reform),
  `formation` (hold the wing slot, opportunistic fire only), `hunt` (seek &
  destroy the nearest enemy fighter, ignore the carrier), `strike` (press the
  enemy mothership and fire on it — `fireRange` widens to the carrier's hitRadius
  so it strafes from stand-off — self-defense fire only). Default loadout:
  2× `cover` + `hunt`.
- **Wingmen fly the player's ship**, piloted with the same control inputs a human
  presses — the `AIController` only ever emits an `InputState` (thrust/turn/
  reverse/strafe), exactly like the keyboard, and the shared `Ship` sim turns that
  into motion; speed/position are never set directly. They use `GameConfig.player`
  for guns, turn rate, reverse/strafe and HP, overriding three movement values
  (`player.wingmen`): a slightly higher `maxSpeed` (close the gap to the slot),
  real `dragRate` (the player has none), and scaled-up `thrust` so terminal speed
  still matches the player. The drag matters — see formation below.
- **Wingmen look like the player** — each is a real-mesh CLONE of the player's
  ACTUAL loaded ship (`loaded.modelRoot.instantiateHierarchy(root, { doNotInstantiate:
  true })`), not a separately-built mesh, so changing the player's ship (the
  `shipDesign` flag or dropping in a real `fighter.glb`) changes the wing with it.
  Clones the model root, not the ship root, so the player-only damage-flash
  doesn't tag along; `doNotInstantiate` = independent meshes (not GPU instances)
  so a wingman stays visible when the player ship is disabled on death. Each
  wingman then gets its **own** engine glow + maneuvering-thruster plumes on its
  root, driven from its emitted input, so it reads as a real fighter under burn.
- **Identical to the player.** Wingmen fly `GameConfig.player` verbatim (no
  per-wingman movement overrides) — same thrust, drag (currently zero), top speed,
  guns, HP. An ally can never out-run you, and with the player's zero drag it
  coasts at your velocity once matched instead of puffing its engine on an interval
  to fight drag.
- **Formation follows the leader's PATH, not its nose.** Each frame the wingman
  computes the velocity it needs (leader's velocity + a speed-capped approach
  toward the slot: `ai.formationPosGain`, `formationApproachSpeed`), points its
  nose along that desired velocity, and flies there like a pilot — trimming
  cross-track error with strafe. The SLOT itself is also placed relative to the
  leader's *course* (velocity direction), not its facing, so nudging the nose to
  hold a line doesn't whip the slots around and shake the wing. Because it steers
  by where it needs to **go**, a turn the leader makes without changing course
  doesn't drag the wing around; it only banks when the leader's actual travel
  direction shifts. Forward thrust is
  gated to a cone around the desired-velocity heading (`formationThrustConeAngle`)
  so it coasts while turning to line up, and each jet runs through a **Schmitt
  trigger** (`formationVelEngageBand` lights / `formationVelDeadband` releases) so
  a stable slot stays quiet instead of chattering. This replaced an earlier
  lagged-leader-heading + strafe-crab scheme that read as the wing copying your
  turns in lock-step.
- **Shared AI tuning extracted to `GameConfig.ai`** — decision knobs (engage/fire
  ranges, cone, wander, leash, formation gains) in one block read by both sides'
  fighters; movement profiles stay per-faction. Leash anchor is role-specific
  (objective carrier for patrol/strike; leader for cover).
- **Enemy strikers** — `GameConfig.enemy.strikeCount` (default 3) of the enemy
  fighters fly `strike` orders, so the enemy actually attacks the player's
  mothership (the win/lose objective) instead of only dogfighting. 0 restores the
  old behavior.
- Friendly-fire-free by construction (per-faction LaserSystems); wingmen appear
  on radar as friendly blips, are missile-immune to the player, form up near the
  home carrier at launch, and re-join from it on respawn.
- **Player-laser hit feedback fix** — bolts carry a `fromPlayer` flag so the
  "you landed a hit" trauma/hitstop + player gun SFX fire only for the human
  pilot's own shots, not every wingman bolt on the shared faction LaserSystem.
- **Wingman engine visuals** — each wingman gets its own `EngineGlow` +
  `SecondaryThrusters` (were player-only), driven from its emitted input, so it
  lights its exhaust under thrust instead of floating.

- **Wingman "shake"/jitter fixed — steering is now proportional.** The remaining
  weave/jitter (and the "clock-hands" stepping that briefly replaced it) was a
  bang-bang steering limit cycle: the AI could only press rotate-left/right at
  full rate, so tracking a continuously-moving heading meant snapping to it,
  stopping, and snapping again — a tight deadband made it a high-frequency shake,
  a wide one a low-frequency step. Fixed by adding an analog `InputState.turn`
  ∈ [-1, 1] channel: the shared tail now sets it *proportionally* to heading
  error (`ai.steerBand` saturation, `ai.steerDeadband` floor), so the nose eases
  into its target heading and tracks a moving one smoothly. `Ship.update` sums
  `turn` with the keyboard rotate booleans (keyboard leaves it 0), so the human
  still turns full-rate. The path-following slot work above still stands — this
  fixed the *nose control* on top of it.
- **Hunt wingman loiters properly when there's no prey.** Previously the `hunt`
  order's no-prey branch flew straight at the leader's position with thrust
  always on and no braking, so it drifted past and looped back (a ram/orbit).
  Now it station-keeps on an escort slot trailing the leader using the SAME
  servo formation uses (extracted to `AIController.stationKeep`) — easing in and
  holding, braking as needed — until a target appears. It loiters on its
  configured slot if it has one, else `ai.huntEscortDistance` behind the leader.
  Hunt now re-plans every frame (like formation/cover) so the escort heading
  stays fresh and the chase tracks tightly.

### Combat
- Two `LaserSystem` instances per faction (player → enemy, enemy → player)
- Per-bolt X/Z sphere collision against a single target
- `Laser.kill()` for hit-induced disposal
- Faction-colored materials with emissive > 1.0 for hot bloom
- `onHit` callback on each system (used to wire SFX + juice)

### Missiles (player secondary weapon)
- `MissileSystem` + `Missile` — homing projectiles fired with `R`, limited
  ammo (`GameConfig.missile.maxAmmo`, refilled on respawn)
- Per-missile homing: steers toward a live target at capped `turnRate`;
  flies ballistic with no lock or once its target dies — still detonates on
  contact with any enemy
- Frontal-cone + range lock (`Game.computeLockTarget`, once per tick), driving
  the HUD `LOCK` indicator and the launched missile's target
- Randomized damage per hit (`[minDamage, maxDamage]`); detonation pops an
  explosion + heavier trauma/hitstop than a laser
- Composite mesh (gray body + nose cone + red fins) with an orange `TrailMesh`
  exhaust; HUD shows ammo count + lock state

### Explosions
- `ExplosionSystem` with shared materials (flash + debris)
- Per-explosion: 1 flash sphere (scales up then collapses) + 8 debris cubes
  (random outward velocity, spin, linear shrink to 0)
- 700ms duration; spawned on either ship's death

### Camera
- Top-down with configurable offset (Y, Z)
- Smooth follow with `playerPos + velocity * velocityLead`
- World-aligned (does NOT rotate with the ship)
- Disabled default Babylon camera inputs
- Player zoom via `+`/`-` keys (scales the offset; range/rate in `GameConfig.camera`)

### Visuals / FX
- `GlowLayer` for global bloom on emissive surfaces
- `Starfield`: 2 parallax layers of thin-instanced spheres, camera-locked
  wrapping field (count independent of arena size; density-driven + capped)
- `Nebulas`: 4 alpha-blended `NoiseProceduralTexture` quads, muted purples
- `CapitalShips`: 3 procedural box-built destroyers in deep background
- `EngineGlow`: core sphere + TrailMesh, thrust-modulated emissive intensity
- Arena wireframe grid (no opaque ground so stars show through)

### Juice
- Trauma-based camera shake in `CameraRig` (decays at 1.8/sec; per-impact trauma values configurable)
- Squared trauma for nice intensity falloff
- Two-sine pseudo-noise per axis
- Position-only shake (introduces slight angular tilt)
- Hitstop system in `Game` with `applyHitstop(ms)` and `maxStackedMs` cap
- During hitstop: simulation pauses; camera shake, damage flash, audio, render continue
- `DamageFlash`: red emissive sphere pulses around player on damage (220ms fade)

### Audio
- `SoundSystem` with 5 CC0 sounds from freesound.org
- `PooledSound` for overlap support (4 instances per short SFX)
- Engine hum loop with thrust-driven volume modulation
- `unlock()` method that retries until WebAudio context is `running`
- DevTools console.info confirmations on unlock + hum start
- **Critical**: Engine constructed with `audioEngine: true`

### Motherships + Launch sequence (BSG-inspired)
- `Mothership` — procedural BSG Galactica-style capital ship: twin flight pods,
  connecting struts, central hull with bridge, amber engine exhausts, faction-tinted
  running lights (blue-grey for player, red for enemy), glow-layer bloom
- Two motherships placed as persistent scenery at opposite ends of the arena:
  player's at z=−700 (bow faces +Z), enemy's at z=+700 (bow faces −Z)
- `LaunchSequence` — a per-SHIP catapult: `hold → launching → complete`. Every
  ship that launches from a carrier gets one (player, AI wingmen, and the enemy
  fleet), so all are frozen in the tube until their own catapult fires.
  - **Hold phase**: ship frozen in the bay for `holdSec` (its controller is
    suppressed). For the player's `cinematic` launch this window is the 2 s wide
    establishing shot (camera at `introZoom=6`) + the "3 / 2 / 1 / LAUNCH!"
    countdown (camera smoothstep-lerps zoom 6→default); for everyone else it is
    just a staggered wait, silent and overlay-free.
  - **Launching phase**: catapult fires at 90 u/s along the carrier's forward
    axis; engine glow forced on; camera trauma burst at the fire moment
    (distance-scaled for non-player ships).
  - **Complete**: normal control resumes at the ship's own `maxSpeed`.
- Match-start launch (`Game.assignInitialLaunches` / `launchFleet`): both fleets
  stream out of their carriers' two launch bays (`GameConfig.mothership.launchBays`,
  tunable), alternating bays so two tubes fire in parallel. The player catapults
  first (cinematic), wingmen follow one behind the other; the enemy fleet does the
  same from its own carrier (`GameConfig.launch.staggerSec` sets the cadence) — so
  enemies start on their carrier rather than pre-scattered beside the player.
  Respawns: every ship — player, wingmen, and enemy fleet — relaunches (skip-intro)
  from its own carrier's assigned bay, so reinforcements always re-enter from the
  mothership rather than popping into the arena.
- **Carrier fleet launch** — both motherships launch their full fighter complement
  from their pod bays at match start; ships respawn back through their carrier bay
  on death, so reinforcements always re-enter from the mothership
- `CameraRig.setZoom()` for programmatic zoom override during launch (bypasses
  `maxZoom` upper clamp so the cinematic wide-shot can exceed the player range)
- Arena `halfDepth` expanded 400→600 to accommodate the post-launch glide path
- Launch overlay styled in `style.css` (fullscreen centered, glow text-shadow)

### HUD
- Plain DOM HUD throttled to 10 Hz
- HP readout with color cue (green/yellow/red/dimmed-on-death)
- Position, velocity, laser count, model label (fallback or fighter.glb)
- `setLaunchOverlay(text)` — fullscreen countdown overlay during launch sequence

### Asset pipeline
- `AssetLoader` with GLB import → procedural fallback ship
  (two designs: `"classic"` / `"viper"`, picked by `GameConfig.player.shipDesign`)
- Two-tier root: outer for gameplay rotation, inner for fixed model alignment
- `MODEL_ROTATION_X/Y/Z` + `MODEL_SCALE` consts for tuning
- `@babylonjs/inspector` installed as dev dep for live mesh debugging

### Docs
- `CLAUDE.md` (comprehensive architecture primer for AI agents)
- `README.md` (human-facing setup + features)
- `docs/ROADMAP.md` (this file)
- `docs/AGENT_KICKOFF.md` (prompt template for new agent sessions)
- `public/sounds/SOURCES.md` (CC0 audio attribution)

---

## 🚧 In flight

_Nothing currently in flight._

When you start something multi-step, list it here with a checkbox state
so the next agent (or you, in a future session) doesn't redo work.

---

## 📋 Backlog / candidate features

Things that have come up in conversation as good ideas but haven't been
implemented yet. Roughly ordered by gameplay value.

**Agreed next phases (battle build, continuing from the faction spine):**
- **Mothership defenses** — pod-mounted gun turrets + missile launchers as
  sub-emitters; optionally per-part hitboxes so pods/turrets can be shot off.
- **Multiplayer** — now a planned direction (not out of scope). The
  Ship/`ShipController` spine is built for it: add a `NetworkController`
  alongside `LocalInputController`/`AIController`; `InputState` is already a
  boolean wire format.

> **Carry-over (FIXED in Phase 4):** the catapult launch is now oriented to the
> carrier's facing. `Mothership.getLaunchForward()` + `getLaunchExitDistance()`
> drive `LaunchSequence` along the mothership's forward axis (humans +Z, machines
> -Z), and the exit test projects travel onto that axis instead of testing world
> Z. Flipping `GameConfig.player.faction` to `"machines"` now launches correctly
> from the north pod.

- **Score + combo multiplier** — kills earn points; quick consecutive
  kills build a multiplier. Persist best score to localStorage.
- **Wave system** — replace single respawning enemy with escalating
  waves (1 enemy → 2 → 3 → 4, capped at 4). Wave counter in HUD.
- **Invulnerability frames on respawn** — 1.5s with ship flicker so
  the respawn moment isn't a free kill.
- **Tighter player feel pass** — bump thrust, reduce rotation latency,
  sharpen laser fire response.
- **Shootable missiles (interceptable, both sides)** — lasers can destroy an
  in-flight missile before it lands. Make `Missile` damageable (implement
  `DamageTarget` or a lighter "interceptable" hook) and register live missiles
  as laser targets; a shot-down missile pops a small explosion and deals no
  damage. Pairs with giving `EnemyShip` its own missiles (player-only today),
  so each side can launch AND intercept the other's missiles. Watch friendly
  fire: a faction's lasers shouldn't detonate its own missiles.
- **Multiple enemy types** — strafer, charger, dropper. Different AI
  states + meshes; share the `DamageTarget` interface.
- **Power-ups** — drop from killed enemies. Temporary muzzle config swaps
  (spread shot, rapid fire), shield charges.
- **Enemy multi-gun** — give EnemyShip the same `muzzles`/`fireMode`
  system as PlayerShip.
- **Positional 3D audio** — Babylon `spatialSound = true` on explosion
  and hit sounds, with the camera as the listener.
- **Mute toggle (M key)** — master volume control persisted to localStorage.
- **Visible audio status indicator** — small HUD line showing
  `AUDIO: LOCKED | ON` so users can tell whether unlock fired.
- **Differentiated hit sounds** — one for "you hit them", one for
  "they hit you".
- **Capital ship drift** — subtle parallax movement on the background
  destroyers so they don't feel painted-on.
- **Animated nebula breathing** — set `NoiseProceduralTexture.animationSpeedFactor`
  to a small non-zero value.
- **Particle explosion** — replace the cube-debris explosion with a
  Babylon ParticleSystem for more density.

---

## 🚫 Out of scope

These were considered and deliberately rejected. Don't implement them
without an explicit user request — they add complexity without arcade-feel
benefit.

- **React or any UI framework**. HUD is plain DOM. The game doesn't have
  a complex UI layer.
- **Physics engine** (cannon, ammo, havok). Motion is hand-rolled in
  `Ship` and that's a feature, not a bug — keeps the control feel tunable.
- **ECS framework** (bitecs, etc.). The entity count is too small to
  benefit; the explicit class-per-entity pattern is easier to read.
- **Mobile / touch controls**. Game is keyboard-only.
- **Gamepad input** (could be added later, not core).
- **Complex menu system** (main menu, options screen, pause). Game
  starts directly into play.
- **Asset preloading splash screen**. Sounds load lazily; the procedural
  fallback ship is available instantly.
- **Authoritative server / cheat-resistant logic**. There's no server
  and no plans for one.

---

## 📐 Architecture decisions worth noting

- **Two LaserSystems instead of one with owner tags.** Simpler ownership,
  no friendly-fire bugs, faction-specific config (color, damage curve in
  the future).
- **Game-state-driven physics (not Babylon physics).** Keeps the feel
  tunable and the math obvious. Trade-off: no rigid-body interactions,
  but the game doesn't need them.
- **Hitstop pauses sim but not camera/audio.** The asymmetry is what
  makes hitstop feel impactful instead of laggy.
- **Per-instance Sound pools, not clones.** Avoids Babylon `Sound.clone()`
  edge cases (returns null in some setups). Costs ~1 KB of audio buffer
  reuse per pool — negligible.
- **Procedural fallback ship as the default.** No asset pipeline means
  zero orientation problems and zero file-format questions.
