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
