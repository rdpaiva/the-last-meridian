# Art sources

Editable source files for assets that ship as exported formats elsewhere in
the repo. Edit the source here, re-export, and commit both.

## `bastion_carrier.blend` → `public/models/bastion_carrier.glb`

Low-poly Bastion Carrier mothership (the human capital ship). Built from simple
boxes + faceted primitives, flat-shaded, matching the Spitfire/Wraith style.
Loaded at runtime by `src/game/Mothership.applyModel()`.

### Conventions baked into the model
- **Axes:** bow along **+Y**, up **+Z** (Blender native). Origin centered in
  X and forward (Y); deck height left on the up axis so the bays sit near the
  model origin.
- **Launch bays:** two empties named **`launch.0` / `launch.1`**, one per flight
  pod, seated inside the carved bay tunnels. Read by `Mothership` (carrier-local
  frame) to position fighters at launch. **Keep these on any re-export** or
  launches fall back to `GameConfig.mothership.launchBays`.
- **Naming:** every mesh is prefixed `Bastion_`; emissive parts use the
  `Engine` / `Viewport` / `RunLight` / `Bay*` / `*Win*` keywords that
  `registerModelGlow` matches on. Only exterior emitters go on the GlowLayer
  (recessed bay emitters + window rows are emissive-only to avoid the no-depth
  bloom bleeding through the hull).
- **Emission:** keep strengths ~2–3, not 8–14 — Babylon's GlowLayer + ACES
  tonemap blow out anything higher. (Blender folds emission color channels >1
  into the exported KHR strength.)
- **Detail emissives follow the taper:** the hull (×0.42) and pods (×0.82)
  narrow toward the bow, so portholes/running lights are seated against the
  actual flank at each Y, not a fixed X — otherwise they float off the surface.

### Export settings
`File → Export → glTF 2.0 (.glb)`, format **GLB**, **+Y up**, apply modifiers,
selection = the `Bastion_Carrier` collection (so the Camera/Light stay out).
The model needs `GameConfig.mothership.model.rotY = Math.PI` so the bay mouths
face the launch axis — set empirically in-game, not derived.

## `choirship.blend` → `public/models/choirship.glb`

Low-poly Choirship — the Novari (machines) mothership. Same conventions as
the Bastion Carrier above (bow +Y, up +Z, root empty `Choir_Ship` in the
`Choirship` collection, ~27 Blender units long so the shared
`GameConfig.mothership.model` scale/rotY apply unchanged). Loaded per-faction
by `Mothership.applyModel()` via `GameConfig.mothership.model.file.machines`.

Design language (vs. the boxy human carrier): dark petrol-teal hull, faceted
pointed prow, a glowing cyan "spine ladder" of paired cells down the
midline, twin engine nacelles with red accent rings, and a flared angular
stern with four cyan exhausts.

### Choirship-specific notes
- **Launch bays:** open-front tunnels through the FORWARD section of each
  side sponson (channel x ±3.4–4.4, mouth at Y 4.2, glowing rim + floor
  rails). `launch.0` / `launch.1` empties sit at (±3.9, 2.2, 0) — keep them
  on re-export. The exit lane forward of each mouth (|x| 3.4–4.4) must stay
  clear of geometry all the way past the bow: the bridge cheeks stop at
  |x| 2.6 and the prow tapers inward, so don't widen anything past |x| 3.4
  forward of Y 4.
- **Naming/glow:** meshes prefixed `Choir_`; only `Engine` / `Viewport` /
  `RunLight` names reach the GlowLayer. The spine/cheek cells are named
  `SpineCell`/`CheekCell` ON PURPOSE — they face the top-down camera, so
  they're emissive-only (GlowLayer bloom straight at the lens would wash out).
  `Bay*` parts are likewise emissive-only.
- **Export:** same as the Bastion — GLB, +Y up, apply modifiers, selection =
  the `Choirship` collection.

## `breaker.blend` → `public/models/breaker.glb`

Low-poly Breaker heavy gunship (the human strike craft — see the story bible).
Faceted prisms + low-seg cylinders, flat-shaded, tan/dark camo: blunt armored
nose with twin gun mounts, hex canopy, shoulder + wing turrets, tilted rocket
pods, spinal four-barrel battery, twin ribbed engine nacelles. Flown via the
`breaker` entry in `GameConfig.shipTypes`.

### Conventions baked into the model
- **Axes (FIGHTER convention, unlike the carriers):** nose along **-Y**, up
  **+Z**. With the +Y-up GLB export this lands the nose on glTF +Z, which
  Babylon imports nose-+Z — so `GameConfig.shipModels["breaker.glb"]` needs
  **no rotation correction**, only `scale: 0.35` (model is ~9.3u long native).
- **Root:** everything is parented to the `Breaker_Gunship` empty; origin
  centered on the X/Y footprint, hull midline shifted to z≈0 so the ship sits
  on the gameplay plane.
- **Marker empties** (read by `AssetLoader.extractMarkers` — keep on
  re-export): `muzzle.FL/FR` (nose gun pairs), `muzzle.WL/WR` (wing turrets),
  `thruster.L/R` (nozzle exits), `rcs.nose/port/stbd`. The `breaker` catalog
  entry's `muzzles` list mirrors these × 0.35 — keep both in sync (enemy
  fleet clones read only the config list).
- **Naming:** meshes prefixed `Breaker_`. No emissive parts — the engine glow
  comes from the runtime `EngineGlow` (thruster markers), like the spitfire.

### Export settings
`File → Export → glTF 2.0 (.glb)`, format **GLB**, **+Y up**, apply
modifiers, selection = the `Breaker` collection (keeps the preview
camera/lights out).

## `reaver.blend` → `public/models/reaver.glb`

Low-poly Reaver heavy gunship (the Novari strike craft — see the story
bible). Dark gunmetal faceted hull with violet emissives: lofted
diamond-section fuselage, glowing violet canopy lens + bright core orb,
two crescent scythe wings raking forward, triple-barrel gun pod under each
wing, twin long chin cannons reaching past the nose, twin aft engines with
glowing nozzle discs. Flown via the `reaver` entry in `GameConfig.shipTypes`.

### Conventions baked into the model
- **Axes (FIGHTER convention, same as the breaker):** nose along **-Y**, up
  **+Z** → lands nose-+Z in Babylon, so `GameConfig.shipModels["reaver.glb"]`
  needs no rotation correction, only `scale: 0.35` (~9.1u long, 12.1u blade
  span native).
- **Root:** everything parented to the `Reaver_Gunship` empty in the
  `Reaver` collection; origin centered, hull midline at z≈0.
- **Marker empties** (read by `AssetLoader.extractMarkers` — keep on
  re-export): `muzzle.NL/NR` (chin cannon tips), `muzzle.WL/WR` (wing gun
  pod tips), `thruster.L/R` (engine nozzles), `rcs.nose/port/stbd`. The
  `reaver` catalog entry's `muzzles` list mirrors these × 0.35 — keep both
  in sync (enemy fleet clones read only the config list).
- **Naming:** meshes prefixed `Reaver_`. Emissive parts (canopy, core orb,
  nozzle glow discs, trim slits) use modest strengths (~2.5-3) per the
  GlowLayer/ACES blow-out gotcha; engine THRUST glow still comes from the
  runtime `EngineGlow` via the thruster markers.

### Export settings
Same as the Breaker — GLB, +Y up, apply modifiers (bakes the wing
Solidify), selection = the `Reaver` collection.

## `wraith.blend` → `public/models/wraith.glb`

Low-poly Wraith fighter (the Novari fighter — see the story bible). Unlike
the other ships this model wasn't built in-house: the original GLB shipped
with a single non-metallic material driven by a 2×2 palette texture, so it
ignored scene lighting. This .blend was reverse-engineered from that GLB —
faces were bucketed by which palette pixel their UVs sampled and rebuilt as
three named PBR materials (texture dropped):

| Material | From palette | Tuning |
|---|---|---|
| `Wraith_Hull` (530 faces) | white (245,244,244) | metallic 0.85 / rough 0.45 — same recipe as the spitfire's `metal` |
| `Wraith_Panel` (200 faces) | dark teal (22,64,61) | metallic 0.6 / rough 0.4, base lifted off near-black so it specs |
| `Wraith_Dark` (96 faces, canopy panes + intakes) | near-black (22,22,23) | metallic 0.7 / rough 0.35 — glossy dark glass look |

### Conventions baked into the model
- **Axes (FIGHTER convention):** nose along **-Y**, up **+Z** → nose-+Z in
  Babylon; `GameConfig.shipModels["wraith.glb"]` needs no rotation
  correction, only `scale: 0.28` (~8.2u long, 6.9u span native).
- **Root/structure:** ONE mesh (`Wraith_Fighter`) in the `Wraith`
  collection — no per-part objects, no root empty (legacy of the imported
  asset). Material slots 0/1/2 = Hull/Panel/Dark.
- **No marker empties** — muzzles/thrusters come from the `wraith` entry in
  `GameConfig.shipTypes` only. If you add `muzzle.*`/`thruster.*` empties,
  keep the config list in sync like the other fighters.
- **No baked emissives** — engine glow is the runtime `EngineGlow`, same as
  the spitfire/breaker. The original palette had an unused bright-teal pixel
  (1,151,137); if you ever add glow accents, that's the canon color.

### Export settings
Same as the Breaker — GLB, +Y up, selection = the `Wraith` collection.
