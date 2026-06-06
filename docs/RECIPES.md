# How-to recipes

> Step-by-step playbooks for common extensions. Read the relevant recipe
> when you start that task. For architecture and conventions these build
> on, see `CLAUDE.md`; for per-subsystem detail, see `SUBSYSTEMS.md`.

---

## Adding a new weapon (e.g. heat-seeking missiles)

1. Add a new `MissileSystem.ts` following the `LaserSystem` pattern.
   Per-instance turn-rate tracking, target acquisition each frame.
2. Define missile config: `GameConfig.missile = { speed, turnRate, damage, lifetimeMs, ... }`.
3. Add launcher positions to `GameConfig.player.missileLaunchers` (mirroring `muzzles`).
4. Add a key to `InputManager` and a `fireMissile` bool to `InputState`.
5. Add the new system to `Game.ts`: construct, target-wire, update in tick.
6. Add a missile SFX to `SoundSystem` and call from `onMissileLaunch`.

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
