# Subsystem deep-dives

> Reference detail for individual subsystems. Read the relevant entry
> **before editing that subsystem** — each documents non-obvious
> invariants you can't recover from the code alone. For orientation
> (architecture, render loop, gotchas, conventions) start in `CLAUDE.md`.

---

## Ship + Controllers (the faction spine)

> Replaces the old `PlayerShip`/`EnemyShip` split. The key idea:
> **control is decoupled from the ship.** One `Ship` sim is driven by a
> `ShipController` that *emits* an `InputState` — keyboard, AI, or (future)
> network. The "player" is just the Ship wearing a `LocalInputController`.
> That decoupling is what makes the two factions interchangeable and the
> game multiplayer-ready.

- **`Faction`** (`Faction.ts`) — `"humans" | "machines"`. `opposing()` flips
  it; `FACTION_THEME` holds per-side laser color + fighter-mesh colors + label.
  Humans = blue/pink (old player), machines = crimson/green (old enemy).
- **`Ship`** (`Ship.ts`) — self-controlled sim (NOT Babylon physics). Owns
  position, velocity, rotationY, HP, cooldowns, missile ammo, muzzle index, and
  a `faction`. `update(dt, input, …)` integrates motion from an `InputState`
  and syncs the visual `root`. `tryFire()` returns world-space muzzle positions
  (0 = on cooldown, 1 = alternate, N = salvo). Movement/weapon tuning is
  **injected** via `ShipOptions.movement` (a `ShipMovementConfig`); both
  `GameConfig.player` and `GameConfig.enemy` satisfy that shape, so the same
  sim drives the human pilot (rich loadout, missiles) and the AI fighters
  (single nose cannon, 0 missiles). Implements `DamageTarget`.
- **`ShipController`** (`ShipController.ts`) — interface: `update(dt, self,
  world) → InputState`. `ControllerWorld` is a per-faction read-only view
  (opposing ships + opposing mothership + arena bounds + a `leader` ref — the
  human pilot's ship for that faction, used by cover/formation wingmen, else
  null). Implementations must return a **stable** `InputState` (mutate in place —
  no per-frame allocation).
- **`LocalInputController`** — surfaces `InputManager.state` (the keyboard).
- **`AIController`** (`AIController.ts`) — the computer pilot for BOTH sides'
  fighters; **emits inputs** instead of mutating the ship (boolean inputs are
  exactly what a network controller sends). Constructed with a standing **order**
  (`AIOrder`) + optional formation slot:
  - `patrol` (default = the original enemy behavior): wander leashed toward the
    objective mothership, engage the nearest opponent in `engagementRange`.
  - `strike`: press the enemy mothership and fire on it (fire range widens to the
    carrier's `hitRadius` so it strafes from stand-off), self-defense fire only.
  - `hunt`: chase the nearest enemy fighter, ignore the carrier.
  - `cover` / `formation`: hold a slot on the leader's wing (`cover` also breaks
    to engage threats within `ai.coverBreakRange` of the leader, then reforms).
  Most orders resolve to a steer-heading + thrust + aim target, then a shared tail
  presses left/right/thrust/reverse/strafe/fire. Decision tuning is shared in
  `GameConfig.ai`. **Formation is the subtle part** — see the next entry.
- **Player wingmen** (Phase 5) — there is no separate wingman class: a wingman is
  a player-faction `Ship` wearing an `AIController` with a `cover`/`hunt`/etc.
  order, built in `Game.start()` from `GameConfig.player.wingmen`. Two non-obvious
  invariants:
  - **They CLONE the player's loaded ship mesh** (`loaded.modelRoot.instantiate
    Hierarchy(root, { doNotInstantiate: true })`), not a separate mesh, so they
    track whatever the player flies (procedural `shipDesign` or a real
    `fighter.glb`). Clone the *model* root (not the ship root) so the player-only
    engine glow / thrusters / damage-flash don't tag along; `doNotInstantiate` =
    real meshes (not GPU instances) so a wingman survives the player ship being
    disabled on death.
  - **Formation = a velocity-servo on the strafe/reverse thrusters, NOT a
    turn-to-chase.** The wingman keeps its nose on a *lagged* copy of the leader's
    heading (`ai.formationTurnLag`, so it banks into turns a beat late) and makes
    its velocity track `leaderVel + speed-capped approach to the slot`, firing
    whichever of thrust/reverse/strafe cuts the velocity error. Turning to chase
    the slot **orbits** the leader; and a zero-drag ship can't hold a slot with
    on/off thrusters (velocity errors integrate into position drift → it surges
    in/out), which is why wingmen carry a little **drag** (`player.wingmen`) for
    damping. Tuning lives in `GameConfig.ai` (`formationPosGain`,
    `formationApproachSpeed`, `formationVelDeadband`, `formationTurnLag`).
- **`FighterMesh.ts`** — `buildFighterMesh(scene, glow, faction)` is the old
  `EnemyShip.buildMesh`, themed by faction (used for ENEMY AI fighters; the human
  player and its wingmen come from `AssetLoader`). `randomFighterSpawn()` is
  the spawn-away-from-player helper (was `EnemyShip.randomSpawnPosition`).

Game wires each Ship as a target of the **opposing** faction's `LaserSystem`
(+ the player's `MissileSystem`), so collisions are faction-correct and
friendly-fire-free without per-bolt faction checks.

## Mothership (the objective)
- Implements `DamageTarget`: large `maxHp` + generous single `hitRadius`
  (`GameConfig.mothership`) covering the central hull. Per-part hitboxes are a
  later defenses pass.
- It is registered as a target of the **opposing** faction's lasers/missiles.
  Destroying the enemy's mothership → **victory**; losing yours → **defeat**
  (see `Game.checkObjectives` / `endMatch`).
- `onLaserHit` deliberately gives mothership chips only a light hit cue (no
  trauma/hitstop) — otherwise sustained fire on the stationary 1500-HP target
  would spam hitstop and crawl the whole game.

## Radar
- Player-centered, **north-up** circular minimap on its own canvas
  (bottom-right), redrawn every frame from live ship/mothership refs (read-only).
- Orientation matches the world camera (which doesn't rotate with the ship):
  world +Z → screen up, +X → right. `project(dx,dz)` maps a world offset from
  the player to a radar pixel and **clamps** beyond `GameConfig.radar.rangeWorld`
  to the rim (clamped contacts drawn dimmer) so you always get a bearing to far
  things — chiefly the enemy mothership objective.
- Player = heading triangle at center; fighters = faction dots; motherships =
  faction diamonds. Blip colors are canvas-friendly (`Radar.BLIP`), NOT the
  emissive `FACTION_THEME` values (those blow out > 1.0).
- Canvas backing store is sized at `devicePixelRatio` and the ctx pre-scaled, so
  draw code works in logical pixels and stays crisp on HiDPI.

## LaserSystem
- One instance **per faction** (`humansLasers` pink, `machinesLasers` green),
  each firing that faction's bolts and targeting every opposing-faction ship +
  the opposing mothership (`addTarget` supports many targets).
- Shared material per system; one `Laser` instance per bolt with its
  own mesh.
- `spawn(origin, rotationY, fromPlayer?)` creates a bolt with velocity along
  forward. `fromPlayer` tags bolts the human pilot fired (vs. an AI wingman
  sharing the same faction system).
- `update()` advances bolts, runs X/Z sphere-vs-target collision, calls
  `onHit(target, fromPlayer)` on impact — the struck target lets Game scale
  feedback (heavy flash/hitstop for the player's own ship, light cue for a
  mothership), and `fromPlayer` gates the "you landed a hit" jolt + gun SFX to the
  player's OWN shots so 3 wingmen firing don't spam hitstop on the shared system.
- `Laser.kill()` marks a bolt expired (it'll be swept on the next pass).

## MissileSystem
- Player-only scarce weapon (key **R**), parallel to `LaserSystem` but each
  projectile homes and carries its own exhaust trail. One instance, registers
  every enemy as a target.
- **Ammo + cooldown live on `PlayerShip`**, not the system: `missileAmmo`
  (starts at `GameConfig.missile.maxAmmo`, refilled in `respawn()`) and a
  `fireCooldownMs` gate so a held key can't dump the pool in one frame.
  `PlayerShip.tryFireMissile()` returns the nose spawn point or `null`.
- **Lock is computed in `Game.computeLockTarget()`** (once per tick, shared by
  the launch and the HUD): nearest live enemy within `missile.lockRange` AND
  inside the frontal `lockConeAngle` (same idea as the enemy fire cone). The
  HUD shows green `LOCK` only when a lock exists AND ammo > 0.
- `spawn(origin, rotationY, target)` — pass the locked enemy to home, or `null`
  to fire ballistic. **A no-lock missile still flies and still detonates** on
  any enemy it contacts (collision tests all targets, same X/Z sphere check as
  lasers).
- **Homing** (`Missile.update`): while it has a live target it steers
  `rotationY` toward the bearing to that target, capped at `turnRate`/sec (the
  same `wrapAngle` + `turnStep` math as the enemy AI). If the target dies it
  drops to `null` and coasts straight from there.
- **Damage is rolled per hit** in `[minDamage, maxDamage]`. `onHit(position)`
  carries the impact point (unlike `LaserSystem`'s parameterless `onHit`) so
  `Game` pops an `explosions.spawn(pos)` plus heavier trauma/hitstop than a
  laser.
- **Mesh** is a small composite (root `TransformNode` named `missile`): gray
  cylinder body + tapered nose cone + four red `+`-cross tail fins, oriented
  along local +Z, built in `buildMissileMesh()`. Kept ~0.7 long so it reads as
  a sub-munition next to the ~1.6-unit ship. Body/fins are lit (faint emissive
  so they read in the dark) and are NOT in the GlowLayer — only the exhaust
  blooms. Disposing the root recurses into the children; shared materials
  survive.
- **Trail = a per-missile `TrailMesh`** generated from the root, with its own
  orange emissive (`trailEmissive`, picked up by GlowLayer). Three gotchas:
  (1) it's NOT parented to its generator (gotcha #4), so `Missile.dispose()`
  disposes it explicitly or it lingers after detonation; (2) the root is built
  this frame, so `spawn()` calls `computeWorldMatrix(true)` before constructing
  the trail — otherwise the trail seeds at the world origin and the first frame
  draws a stray streak from (0,0,0) to the spawn point; (3) **`Missile.dispose()`
  must call `trail.stop()` BEFORE `trail.dispose()`** — `TrailMesh` registers a
  per-frame `onBeforeRenderObservable` callback in `start()`/autoStart and has
  no `dispose()` override to remove it (it inherits `Mesh.dispose`). Only
  `stop()` unhooks the observer; skip it and every fired missile leaks a
  permanent per-frame callback, piling up into progressive slowdown.

## ExplosionSystem
- Spawns short-lived explosions: 1 flash sphere + 8 debris cubes.
- Shared materials (one flash mat, one debris mat) reused across every
  active explosion. To fade per-explosion without per-material alpha,
  we scale meshes toward 0 instead of fading alpha.
- All meshes opt into GlowLayer on spawn for bloom.

## SoundSystem
- 4 one-shot pools (player_laser × 4, enemy_laser × 4, hit × 4, explosion × 2).
- Pools use N independent Sound instances (not clones).
- Engine hum: looping `Sound` with volume modulated by `EngineGlow.currentIntensity`.
- `unlock()` is idempotent and self-healing: it retries each frame until
  the audio context's `state === "running"` (some browsers need
  `audioContext.resume()` after Babylon's `unlock()`).
- Two `console.info` lines confirm unlock + engine-hum start in DevTools.

## CameraRig
- Top-down with `(offsetY, -offsetZ)` from player position.
- Position smooths toward `playerPos + velocity * velocityLead`.
- **Zoom**: the `+`/`-` keys drive a live `zoom` factor that multiplies the
  base offset (1.0 = default; clamped to `camera.minZoom..maxZoom`, changed
  at `camera.zoomRate`/sec). `update()` takes a `zoomInput` of -1/0/+1 from
  `Game.tick`. Shake rides on top unscaled, no HUD element.
- **Shake**: trauma 0..1, decays at `decayRate`/sec. Per-frame offset =
  `maxOffset × trauma² × sine-noise`. Position-only shake (target stays
  on `trackedTarget`) gives a slight angular tilt that reads as a
  camera-mount jolt.
- Continues updating during hitstop so the freeze-frame trembles.

## EngineGlow
- Core sphere + TrailMesh parented to an anchor at the ship's tail.
- Materials use emissive components > 1.0 for hot bloom.
- `intensity` (core sphere brightness/scale + audio) smooths toward
  `thrusting ? 1 : speed/maxSpeed * 0.4`, so the core keeps a soft coast glow.
- The **trail** ("thruster line") is gated separately on `trailIntensity`,
  which targets thrust input ONLY (never speed). Its alpha fades with that
  value and the mesh is `setEnabled(false)` once it's ~invisible, so the
  exhaust streak appears only while actively burning and not while coasting.
- Exposed via `currentIntensity` getter so SoundSystem can match the audio.

## DamageFlash
- One sphere parented to the player ship root, normally `setEnabled(false)`.
- `trigger()` enables + starts a 220ms linear-alpha fade from 0.7 to 0.
- Depth writes off so it doesn't occlude opaque geometry behind it.
- Opts into GlowLayer; emissive `(2.5, 0.2, 0.2)` blooms hot red.

## Scenery
- **Backdrop** (deepest, behind everything): the `space-backdrop.jpg`
  deep-space image rendered as a Babylon background `Layer` — a 2D blit,
  NOT a 3D plane. A large emissive plane gets multiplied by emissive +
  amplified by the GlowLayer and washes to white; a Layer is immune to
  lighting/glow and shows the whole image. See gotcha #9 and `Backdrop.ts`.
  **Subtle parallax:** `Backdrop.update(cameraFocus)` (called each frame from
  `Game.tick`, right after `Starfield.update()`) drifts the image a hair
  against the camera so it reads as impossibly distant — the slowest-moving
  layer, behind even the far stars. It pans the TEXTURE's `uOffset/vOffset`,
  NOT `layer.offset` (that moves the on-screen quad and exposes a black edge —
  the shader applies `offset` to `gl_Position`). Two modes via
  `GameConfig.scenery.backdrop.parallaxMode`: `"clamp"` (default, bounded
  arena) zooms the texture in by `parallaxZoom` and clamps the pan to that
  margin with CLAMP addressing — works with any image, costs a slight edge
  crop; `"wrap"` (unbounded arena) lets the offset run free and tiles via WRAP
  addressing — needs a seamless image. Either way the edge never shows.
  `parallaxFactor: 0` disables it entirely.
- **Nebulas** (Y per `GameConfig.scenery.nebulas.yLevel`): alpha-blended
  quads textured from the `nebula-*.png` files. Count, depth, size, and
  opacity are all in GameConfig. The PNGs come through the emissive channel
  as **luminance/detail only** — COLOR is supplied per-nebula via
  `emissiveColor` (the `COLORS` array in `Nebulas.ts`), NOT read from the
  texture (white tint would blow the pale art out). `TEXTURE_FILES`,
  `COLORS`, and `POSITIONS` are priority-ordered; `count` takes the first N.
- **Starfield** (Y -8 and -18): two parallax layers, thin-instanced
  spheres, 2 draw calls. **Camera-locked wrapping field** — NOT scattered
  across the arena. Each layer holds a periodic lattice of stars sized to the
  camera footprint; `Starfield.update()` (called each frame from `Game.tick`
  after the camera updates) re-anchors every star to the lattice image nearest
  the camera, so stars wrap off one screen edge onto the other. Star cost is
  therefore independent of arena size (multiplayer-safe). The active count is
  density × visible-area, capped at `GameConfig.starfield.maxNearCount/maxFarCount`
  via `thinInstanceCount` over a max-sized buffer, so zooming out keeps density
  constant up to a hard ceiling. Needs the camera, so it's constructed after
  `CameraRig`.
- **CapitalShips** (Y ≈ -26): 3 procedural destroyers built from boxes
  (hull + spine + tower + engine + 6 running lights). Engines and
  lights are emissive and opt into GlowLayer.
