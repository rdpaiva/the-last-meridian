# How-to recipes

> Step-by-step playbooks for common extensions. Read the relevant recipe
> when you start that task. For architecture and conventions these build
> on, see `CLAUDE.md`; for per-subsystem detail, see `SUBSYSTEMS.md`.

---

## Adding a new weapon

The heat-seeking missile (`Missile.ts` + `MissileSystem.ts`) is the worked
example of a second weapon — read it as the reference. How it's wired, and the
pattern to copy for another secondary weapon:

1. **System + entity**, mirroring `LaserSystem`/`Laser`: `MissileSystem` owns a
   pool, shared materials, a `targets` list, and an `onHit` callback; `Missile`
   owns its mesh and per-frame behavior (homing steer toward a target at a
   capped `turnRate`, else ballistic). Collision is the same X/Z sphere test.
2. **Config** under its own `GameConfig.missile` section (speed, lifetime,
   damage range, turnRate, lock range/cone, ammo, mesh dims). No magic numbers
   in the system.
3. **Ammo + cooldown live on `PlayerShip`** (`missileAmmo`, reset in
   `respawn()`); `tryFireMissile()` returns the nose spawn point or `null`.
4. **Input**: a `fireMissile` bool in `InputState`, mapped to a key in
   `InputManager` (`R`) and whitelisted in `isGameKey()`.
5. **Game wiring**: construct the system, `addTarget()` each enemy, compute the
   lock once per tick (`computeLockTarget`), fire in the player block, and
   `update()` it in the sim step. The `onHit(pos)` carries the impact point so
   `Game` can pop an explosion + juice there.
6. **HUD**: pass ammo + lock state into `Hud.update()`.

Gotchas worth copying: a homing projectile's mesh is built the spawn frame, so
call `computeWorldMatrix(true)` before attaching a `TrailMesh`; and a
`TrailMesh` must be `stop()`-ped before `dispose()` or it leaks a per-frame
observer (see `Missile.dispose` / `SUBSYSTEMS.md`). No dedicated missile SFX
yet — launch reuses `playPlayerLaser`, impact reuses `playExplosion`; add CC0
assets + `SoundSystem` methods if you want distinct audio.

## Adding a new enemy type

1. New file `EnemyShipBomber.ts` (or whatever). Same `DamageTarget` impl,
   different AI in `update()`, different mesh.
2. Game holds an array of enemies instead of a single one. LaserSystem's
   single-target API needs to become multi-target (pick closest? or a
   `targets` array iterated per bolt).
3. Reshape `playerLasers.setTarget` → `addTarget`/`removeTarget` if you
   want true multi-targeting.

## Tuning juice

- More shake: bump `shake.traumaXxx` values 1.3-1.5×.
- Longer freeze: bump `hitstop.xxxMs` 1.3-1.5×.
- Brighter damage flash: `damageFlash.peakAlpha` 0.9, `diameter` 2.8.
- Less shake decay (lingering): lower `shake.decayRate` from 1.8 → 1.2.

## Live-editing the model in the Babylon Inspector

```ts
// One-shot in DevTools console after dev server is running:
import("@babylonjs/inspector").then(({ Inspector }) =>
  Inspector.Show(window.__BABYLON_SCENE__, {}));
```

(`@babylonjs/inspector` is installed as a dev dep.) Expand
`playerShipRoot` → `playerShipModel` and tweak rotation/scale there.
Whatever values look right, copy into the `MODEL_ROTATION_X/Y/Z` /
`MODEL_SCALE` consts at the top of `AssetLoader.ts` (Inspector shows
degrees; consts use radians — multiply by π/180).
