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
- `intensity` smooths toward target = `thrusting ? 1 : speed/maxSpeed * 0.4`.
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
