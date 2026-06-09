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
- `LaunchSequence` state machine: `intro → countdown → launching → complete`
  - **Intro phase** (2 s): camera zooms out to `introZoom=6` showing the full
    mothership silhouette as a cinematic establishing shot; no overlay
  - **Countdown phase** (3 s): "3 / 2 / 1 / LAUNCH!" centered HUD overlay; camera
    smoothstep-lerps from zoom 6→1 so the view closes in on the launch bay
  - **Launching phase**: catapult fires at 90 u/s; engine glow forced on;
    camera trauma burst at fire moment
  - **Complete**: normal player control resumes at `maxSpeed`
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
- **Unbounded arena** — drop the X/Z position clamps in `Ship`; re-leash
  `AIController` toward the combat zone / enemy mothership instead of
  arena-center bias. Match still ends only via mothership destruction.
- **Carriers launch fighters** — both motherships spawn fighters from their pods
  over time (wave cadence + max-alive cap in `GameConfig`); human-side AI
  wingmen fall out for free.
- **Mothership defenses** — pod-mounted gun turrets + missile launchers as
  sub-emitters; optionally per-part hitboxes so pods/turrets can be shot off.
- **Multiplayer** — now a planned direction (not out of scope). The
  Ship/`ShipController` spine is built for it: add a `NetworkController`
  alongside `LocalInputController`/`AIController`; `InputState` is already a
  boolean wire format.

> **Carry-over to fix along the way:** the catapult launch is still
> humans/south-oriented. `Mothership.getLaunchExitZ()` and `LaunchSequence`
> drive the ship along world **+Z** and test `position.z >= exitZ`, which only
> holds for the humans mothership (rotationY 0). Flipping
> `GameConfig.player.faction` to `"machines"` mirrors combat/colors/targeting
> correctly, but the launch from the north pod would look wrong. Generalize the
> launch direction/exit to the mothership's facing when the arena opens up
> (Phase 4) or carriers start launching fighters (Phase 5).

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
