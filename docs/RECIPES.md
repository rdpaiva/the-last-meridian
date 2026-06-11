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

## Add a new ship type

Ships are catalog entries — no new class needed. The catalog
(`GameConfig.shipTypes`) holds one complete profile per type (movement,
weapons, `maxHp`, per-bolt `laserDamage`, `missileAmmo`, `hitRadius`,
`model`, `fireSound`); the Breaker heavy gunship is the worked example.

1. **Model** (optional): author a GLB in Blender (source in `art/`, export to
   `public/models/`). Convention: nose along Blender **-Y**, up **+Z**, +Y-up
   GLB export → lands nose-+Z in Babylon with no rotation correction (the
   spitfire needs `rotY: π` because it's authored the other way). Parent
   everything to a root empty, origin at the footprint center. Add marker
   empties: `muzzle.*` (laser spawn points), `thruster.L/R` (engine glow),
   `rcs.nose/port/stbd` (maneuvering jets). `model: null` = procedural
   fallback mesh.
2. **Orientation entry**: add the filename to `GameConfig.shipModels` with
   rotation/scale (tune via the Inspector recipe below).
3. **Catalog entry**: add the type to `GameConfig.shipTypes`. Keep the
   config `muzzles` list in sync with the GLB's `muzzle.*` empties (× the
   `shipModels` scale): the player path reads the GLB markers, but enemy
   fleet CLONES read only the config list.
4. **Fly it / fight it**:
   - Player: set `GameConfig.player.shipType` (wingmen clone it by default;
     `player.wingmen.shipTypes` assigns per-wingman types for a mixed wing).
   - Enemy: add `{ type, count }` to `GameConfig.enemy.fleet` — mixed fleets
     are fine; entries spawn in order and the first `enemy.strikeCount` ships
     across the whole fleet fly the "strike" order.

Per-bolt damage rides each laser (`LaserSystem.spawn(..., damage)`), so mixed
types on one faction system just work.

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
