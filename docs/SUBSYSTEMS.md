# Subsystem deep-dives

> Reference detail for individual subsystems. Read the relevant entry
> **before editing that subsystem** — each documents non-obvious
> invariants you can't recover from the code alone. For orientation
> (architecture, render loop, gotchas, conventions) start in `CLAUDE.md`.

---

## PlayerShip
- Self-controlled sim (NOT Babylon physics).
- Owns position, velocity, rotationY, HP, cooldowns, muzzle index.
- `update()` reads `InputState`, integrates motion, syncs `root.position`
  and `root.rotation.y` to its visual root.
- `tryFire()` returns an array of world-space muzzle positions (0 = on
  cooldown, 1 = alternate mode, N = salvo mode).
- `worldFromLocal(lx, ly, lz, out)` transforms ship-local coords (used
  by tryFire) into world coords using the ship's current rotationY.
- Implements `DamageTarget`: `hp`, `hitRadius`, `isAlive`, `takeDamage`,
  `die()`, `respawn()`, `shouldRespawn()`.

## EnemyShip
- Same control pattern as PlayerShip, but with built-in AI.
- AI states (implicit, branched in update):
  - **Wander**: pick a target heading, jitter, bias back to arena center
    so the enemy doesn't grind into a wall.
  - **Engage**: when player is alive and within `engagementRange`, point
    target heading at player.
- Fire test: distance < `fireRange` AND |angle to player| < `fireConeAngle`
  AND cooldown ready → fire.
- Tuned slower than the player (speed/rotation/cooldown) so the duel is
  beatable.
- Mesh is always procedural (red crimson body, swept wings, hot-red
  engine, red "eye" sphere at nose). No GLB path for the enemy.
- `EnemyShip.randomSpawnPosition()` is a static helper for picking a
  respawn spot at least `minDistFromPlayer` away from the player.

## LaserSystem
- Constructed twice: once for the player (pink bolts targeting enemy),
  once for the enemy (green bolts targeting player).
- Shared material per system; one `Laser` instance per bolt with its
  own mesh.
- `spawn(origin, rotationY)` creates a bolt with velocity along forward.
- `update()` advances bolts, runs X/Z sphere-vs-target collision, calls
  `onHit` on impact.
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
