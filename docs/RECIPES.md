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

## Apply a top-down "deck skin" to a carrier

Worked example: the Bastion Carrier wears `art/textures/bastion_skin.png`, an
MCS AEGIS top-view livery. The game camera looks straight down, so a carrier
reads best with a **painted top-view decal projected onto the deck** — this is
the first/only image texture in an otherwise texture-free project, a deliberate
one-off for the capital ships.

Think of it as **two jobs** (a point the image-generating AI made well):
*concept/art-direction* (what the ship looks like) vs. *correct mapping* (the
image landing on the model). A concept image won't auto-wrap; you control the
mapping in Blender.

There are two ways to do the mapping. **Use Workflow A (planar) by default** —
it fits a top-down game, needs no manual unwrap, and is proven on the Bastion
(and is the chosen path for the Choirship). Reach for Workflow B only if you
later want textured sides, close-up detail, or full PBR maps.

### Before either workflow: the asset-request packet

Hand the image AI the *actual model*, not just a description, so it designs to
the real silhouette (this alone prevents most mis-alignment):

- **Renders Claude generates from Blender** — a **top-down** render (most
  important; hull markings read from above) plus a 3/4 view, and a footprint
  guide. Ask for these; they take seconds via the Blender MCP.
- **Faction/role brief** — e.g. "Meridian Commonwealth heavy carrier, human
  military, worn-but-advanced, dark gunmetal + orange stripes, white winged-bird
  insignia, anime sci-fi." The role (carrier vs. fighter vs. relic) changes the
  texture a lot.
- **Style refs** if you have them.
- **Which maps** you want. For this game: **base color + emission + roughness**
  are what matter; normal maps are a nice-to-have to add later.
- Tell it **not to mirror** anything with readable text ("MCS AEGIS"), and to
  give the **top hull the most resolution** (it's what players see).

### Workflow A — planar top-down projection (default)

The reusable Blender Python lives in **`scripts/skin_carrier.py`** (run inside
Blender via the MCP; its module docstring shows the call sequence). The steps:

1. **Save** the image to `art/textures/<ship>_skin.png`.
2. **`footprint(prefix)`** — world bbox of all `<Prefix>*` meshes
   (`minX/maxX/minY/maxY`; bow is +Y).
3. **`detect_ship_uv_rect(img)`** — finds the ship inside the image's dark
   margin (corner = background, mask the difference) → UV sub-rect
   `uL,uR,vBot,vTop`. `img.pixels` is bottom-row-first, so image-bottom = stern
   = low V. **Gotcha:** if you ever WRITE pixels, call `img.update()` after
   `foreach_set` or the buffer reads back as zeros.
4. **`make_skin_material(...)`** — image → Base Color, `metallic 0`,
   `roughness ~0.85`. Matte on purpose: high metallic reflects the markings
   away from the top-down camera and washes them out.
5. **`skin_top_faces(...)`** — assigns the skin to **top faces only**
   (`world-normal.z > 0.5`) of the *structural* objects (skips emitters:
   `engine/window/viewport/runlight/bay/spine/cheek/groove/light/glow`) and
   planar-projects `U,V` from world `X,Y` into the ship rect.
6. **Make un-skinned parts match.** `recolor` the flanks/undersides to
   `sample_hull_color(img)` (median ship hull, sRGB→linear) and drop their
   metallic; shift any clashing emitters to the livery accent (Bastion: blue
   bay/run lights → amber). `hide_and_unskin([...])` the procedural top detail
   the skin now paints (spine ladder, deck grooves) so it's excluded from
   export.
7. **Emblems vs. height steps (the fiddly part).** A flat decal projected onto
   3-D superstructure SPLITS wherever the deck steps in Z — a ridge ending, a
   turret poking up, a deck's forward edge. Fix per emblem by giving it flat
   deck: `extend_face(...)` the deck under it, or `move_world(...)` the
   obstacle onto another deck (and re-seat its Z). Then **`reproject(obj, ...)`
   from its new world XY** or the texture won't follow. Find an emblem's Y by
   scanning the image column for the widest "silver" blob.
8. **`export_glb_jpeg(...)`** — downscales the texture to ~768 px long edge
   (still legible at gameplay distance) and JPEG-encodes it: a ~2.5 MB GLB
   becomes ~400 KB. Keep the lossless PNG master on disk. Selects the ship
   collection **minus hidden objects**, `+Y up`, applies modifiers.
9. **Verify:** `node scripts/measure-carrier-footprint.mjs` — deck/turret
   nudges stay inside the hull envelope, so `GameConfig.mothership.hullRects`
   usually needs NO change (confirm, don't assume). Check the GLB still has
   `launch.0/1` and the `<Prefix>_Skin` `baseColorTexture`.

### Workflow B — UV-unwrap + PBR (high fidelity, only when needed)

The "proper" game-art pipeline: unwrap the model, `UV > Export UV Layout`
(2048² or 4096²), send the layout PNG to the image AI so it paints *into the
islands*, and import base/roughness/metallic/normal/emission maps. Higher
fidelity and textures the sides too, but **our carriers are ~100 separate box
primitives with no unified unwrap** — doing this right means actually unwrapping
them (Smart UV / manual island layout), a much bigger job that changes the whole
material setup. Worth it only for a hero asset seen up close from all angles;
overkill for a top-down carrier. If you go this way: large visible surfaces →
large islands, top hull gets the most space, don't mirror UVs under readable
text, leave padding so colors don't bleed.

**Choirship cautions (planar):** it has MORE 3-D superstructure than the Bastion
(glowing cyan spine ladder, cheek cells, twin nacelles, pointed prow, sponson
launch bays), so expect more emblem-vs-step conflicts in step 7. Its emitters
are cyan and the top-facing `SpineCell`/`CheekCell` are deliberately
emissive-only (no glow keyword) — match the supplied livery's accent and keep
the sponson launch lane (`|x| 3.4–4.4` forward of the mouths) clear. See
`art/README.md` (Choirship section) and the carrier-GLB-pipeline notes.
