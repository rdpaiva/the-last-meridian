# Art sources

Editable source files for assets that ship as exported formats elsewhere in
the repo. Edit the source here, re-export, and commit both.

> **Carrier deck skins:** the motherships can wear a top-down painted livery
> (`textures/<ship>_skin.png`, planar-projected onto the deck). Both carriers
> also have separate hull/hangar atlases for their sides and undersides.
> See their sections below for the re-export helpers, and
> `docs/RECIPES.md` → "Apply a top-down deck skin to a carrier" for deck mapping.

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
- **Sides, underside, and launch tunnels:** `textures/bastion_hull_atlas.png`
  supplements the original deck skin. Its four horizontal strips (top to
  bottom) contain exterior armor, underside service panels, hangar walls/ceiling,
  and launch flooring. Explicit UVs keep panel proportions on vertical faces;
  floor chevrons point forward along +Y in both bays. `Bastion_HullWrap` and
  `Bastion_HangarSkin` share the atlas, embedded as JPEG in the GLB. The hangar
  has a restrained albedo-colored emission floor so its interior remains
  readable, while the existing ceiling strips supply the stronger light.
  Floor/back-wall surfaces are no longer solid emissive panels. The original
  deck artwork, exterior emitters, geometry, and `launch.0/1` remain unchanged.

### Export settings
Run `scripts/skin_bastion.py` with `art/bastion_carrier.blend` open in Blender
to reapply the atlas mapping, save the editable source with packed textures,
and export **GLB**, **+Y up**, apply modifiers, JPEG quality 90. It exports
the visible `Bastion_Carrier` objects only and checks that geometry, launch
markers, and exterior deck UVs are preserved. After editing the PNG externally,
reload that image in Blender before rerunning the helper.
The current asset has 1,468 triangles, two embedded images, and is about 1 MB.
The model needs `GameConfig.mothership.model.rotY = Math.PI` so the bay mouths
face the launch axis — set empirically in-game, not derived.
Studio previews are in `pictures/bastion_textured_overview.png`,
`pictures/bastion_textured_underside.png`, and
`pictures/bastion_textured_launch_bay.png`.

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
- **Sides, underside, and launch tunnels:** `textures/choirship_hull_atlas.png`
  complements the original Novari deck skin with petrol-teal armor, cyan
  details, service panels, mechanical hangar walls/ceilings, and marked launch
  flooring. Its four horizontal strips have the same layout as the Bastion
  atlas. `Choir_HullWrap` and `Choir_HangarSkin` share one embedded JPEG;
  the hangar uses a restrained albedo-colored emission floor for readability.
  Only inward wall faces and the roof underside receive the interior finish.
  Both floor chevrons point +Y, and the existing cyan rims/guide rails, red
  nacelle accents, and exterior deck artwork are preserved. Nacelle side
  facets use a continuous cylindrical unwrap below the original top skin.
- **Export:** run `scripts/skin_choirship.py` with `art/choirship.blend` open.
  It saves the source with packed textures, verifies geometry and exterior
  deck UVs are unchanged, then exports visible `Choirship` objects as GLB,
  +Y up, apply modifiers, JPEG quality 90. Reload the atlas in Blender after
  changing its external PNG. The asset has 1,524 triangles, two embedded
  images, and is about 0.9 MB. The launch markers remain at (±3.9, 2.2, 0).
  Studio previews are `pictures/choirship_textured_overview.png`,
  `pictures/choirship_textured_underside.png`, and
  `pictures/choirship_textured_launch_bay.png`.

## `station.blend` → `public/models/station.glb`

Low-poly capture station (the strategic layer's neutral points — see
`docs/strategic-layer-plan.md`). Wheel-and-spire orbital: a 48-segment
habitat wheel with six spokes, three chunky coupler modules and dashed
orange window strips; a central hub climbing through a tapering core into a
tall stacked spire with blade fins; a reactor drum with rosette end cap
hanging below the wheel plane. Loaded at runtime by
`StationView.tryLoadModel()` via `GameConfig.stations.model`.

### Conventions baked into the model
- **Axes:** station axis along **+Z** (Blender native up), radially
  symmetric so no facing correction is needed. Wheel plane at z=0; native
  bounds: wheel Ø ~13.1 units, spire top +10.05, reactor bottom -3.38.
- **Root/structure:** all meshes parented to the `Station_Root` empty in the
  `Station` collection, prefixed `Station_`. No marker empties.
- **Ownership emitters — naming is load-bearing:** `StationView` re-materials
  GLB meshes whose lowercase names contain `beacon`/`ring` with its
  faction-tinted emissives. That's **`Station_Beacon`** (spire-tip sphere)
  and **`Station_RingLight`** (thin light torus on the wheel's top face,
  the top-down ownership read). Don't let "ring"/"beacon" leak into hull
  mesh names (the wheel is `Station_Wheel` for exactly this reason).
- **Emission:** orange window strips (`Station_Windows_*`) stay
  station-owned (not faction-tinted); strengths ~2.2 per the GlowLayer/ACES
  blow-out gotcha.
- **Textures (AI-painted, user-generated):** two skins, both embedded in the
  GLB. `textures/station_skin.png` — top-down painting projected planar from
  above onto the wheel/spokes/modules (`Station_SkinWheel` material); the
  projection frame is the MEASURED painted ring (center 627.2/653.3 px,
  outer edge 543.5 px ↔ wheel outer radius 5.55). The coupler modules sit at
  **33.2° / 147.1° / 269.7°** — moved from the original 20/140/260 to match
  where the painting put them (on the spoke junctions); keep that if
  regenerating the skin. `textures/station_spire_atlas.png` — sprite-sheet
  regions UV-mapped per part onto the spire/core/hub/lower stack
  (`Station_SkinSpire`); region rects live only in the baked UVs, so
  re-atlasing means re-running the mapping (session script) or hand-UVing.

### Export settings
`File → Export → glTF 2.0 (.glb)`, format **GLB**, **+Y up**, apply
modifiers, selection = the `Station` collection. In-game placement
(scale 4, sunk `yOffset: -44` below the fighter plane, slow idle spin) lives
in `GameConfig.stations.model`.

## `breaker.blend` → `public/models/breaker.glb`

Low-poly Breaker heavy gunship (the human strike craft — see the story bible).
Faceted prisms + low-seg cylinders, flat-shaded, textured tan/dark camo: blunt armored
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
- **Texture:** `textures/breaker_armor.png` is the lossless 1024² source for
  the shared `Breaker_ArmorSkin` material. Structural hull faces use a
  world-scale box projection so the 33 separate breakup pieces keep consistent
  texel density; canopy and gunmetal weapons retain their dedicated materials.
  The exported GLB embeds the skin as JPEG, so every fighter clone shares one
  compact GPU texture. Re-run `scripts/skin_breaker.py` inside Blender after
  replacing the source texture or changing the projection/material settings.

### Export settings
`File → Export → glTF 2.0 (.glb)`, format **GLB**, **+Y up**, apply
modifiers, selection = the `Breaker` collection (keeps the preview
camera/lights out), embedded texture format **JPEG** at quality 84. The helper
script applies these settings automatically.

## `reaver.blend` → `public/models/reaver.glb`

Low-poly Reaver heavy gunship (the Novari strike craft — see the story
bible). Deep-purple textured faceted hull with Novari cyan emissives: lofted
diamond-section fuselage, smoked teal-black canopy lens + bright cyan core orb,
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
- **Naming:** meshes prefixed `Reaver_`. The cockpit uses a dedicated
  `Reaver_CanopyGlass` smoked teal-black material with only a 0.24 emissive
  floor. Trim slits and nozzle discs share `Reaver_Glow` (Novari cyan,
  strength 1.45), while the small core orb uses `Reaver_GlowCore` (strength
  1.80). The restrained, sparse cyan matches the Wraith and Choirship without
  washing the purple armor in GlowLayer/ACES bloom. Engine THRUST glow still
  comes from the runtime `EngineGlow` via the thruster markers.
- **Texture:** `textures/reaver_armor.png` is the lossless 1024² source for
  the shared `Reaver_ArmorSkin` material: saturated royal-purple/amethyst
  interlocking armor with true-black recessed panels and bright lavender
  channels. Black is limited to roughly one quarter of the source and never
  occupies the large silhouette-carrying plates. The material is intentionally
  only 0.18 metallic / 0.58 rough, with the albedo feeding a restrained 0.12
  emissive floor, so the purple silhouette survives the dark starfield without
  creating a hull-wide bloom. The texture's lavender channels are non-blooming
  armor detail; the separate cyan materials provide faction recognition.
  Structural hull faces use a world-scale box projection so all 44 breakup
  meshes retain consistent texel density. The GLB embeds one JPEG shared by
  every clone; re-run `scripts/skin_reaver.py` after changing the source or
  any of the cockpit/emissive palette values.

### Export settings
Same as the Breaker — GLB, +Y up, apply modifiers (bakes the wing
Solidify), selection = the `Reaver` collection, embedded JPEG quality 84. The
helper script applies these settings automatically.

## `spitfire.blend` → `public/models/spitfire.glb`

Low-poly Commonwealth Spitfire Mk II interceptor, rebuilt in-house to replace
the legacy third-party speeder. Its silhouette takes the original long-nose
space fighter idea forward with a faceted spear nose, long narrow swept wings
with hard-clipped tips, squared twin engine nacelles, dorsal stabilizers, wing guns, and a dark
naval-style canopy. The asset is deliberately lean (about 868 triangles) and
consolidated into five material batches for large fighter groups.

### Conventions baked into the model
- **Axes:** unlike the newer Breaker/Reaver sources, the Spitfire is authored
  nose along Blender **+Y**, up **+Z**, preserving the legacy runtime
  correction. After +Y-up GLB export, `GameConfig.shipModels["spitfire.glb"]`
  keeps `rotY: Math.PI, scale: 0.7`.
- **Root:** all runtime objects are parented to `Spitfire_MkII` inside the
  `Spitfire` collection. The camera and lights live in `Spitfire_Preview` and
  do not export.
- **Markers:** `muzzle.L/R`, `thruster.L/R`, and `rcs.nose/port/stbd` are
  embedded for player/wingman placement. The catalog muzzle fallback remains
  for fleet clones.
- **Texture:** `textures/spitfire_armor.png` is the lossless 1024² source for
  `Spitfire_ArmorSkin`: medium warm gunmetal/taupe-gray plates, graphite seams,
  crimson recognition panels, and restrained orange safety marks. Hull pieces
  use a consistent world-space box projection. The armor is intentionally only
  0.14 metallic / 0.60 rough, with the same albedo feeding a subtle 0.14
  emissive floor; this preserves the dark warm palette while keeping the
  top-down silhouette readable against the starfield. The armor is not added
  to the GlowLayer, so it does not bloom. Red wing/dorsal panels, canopy,
  weapons, and engine nozzles retain small dedicated materials. The exported
  GLB embeds the shared texture as JPEG.

### Export settings
Run `scripts/build_spitfire.py` in Blender. It rebuilds the source, saves
`art/spitfire.blend`, exports only the `Spitfire` collection as +Y-up GLB with
JPEG quality 84, and writes `art/pictures/spitfire_mk2_preview.png`.

## `wraith.blend` → `public/models/wraith.glb`

Low-poly Wraith Mk II interceptor (the Novari knife-fighter — see the story
bible), rebuilt in-house to replace the legacy third-party lancer. It retains
the recognizable long central prow, split blade wings, and twin raised engine
nacelles, but sharpens them into a sleeker dagger/crescent silhouette. The
model is about 592 triangles consolidated into four material batches.

### Conventions baked into the model
- **Axes (FIGHTER convention):** nose along **-Y**, up **+Z** → nose-+Z in
  Babylon; `GameConfig.shipModels["wraith.glb"]` needs no rotation
  correction, only `scale: 0.28` (~7.7u long / 7.1u span native).
- **Root/structure:** runtime meshes are parented to `Wraith_MkII` in the
  `Wraith` collection. Preview camera/lights live in `Wraith_Preview` and do
  not export. Geometry is joined into Armor, Structure, Canopy, and CyanGlow
  batches to keep squadron draw cost low.
- **No marker empties** — muzzles/thrusters come from the `wraith` entry in
  `GameConfig.shipTypes`; the engine plume is still the runtime `EngineGlow`.
- **Texture:** `textures/wraith_armor.png` is the lossless 1024² source for
  `Wraith_ArmorSkin`: medium-light pearl-gray and turquoise ceramic plates,
  graphite seams, and sparse cyan channels. Broad near-black areas are avoided
  deliberately so the fighter reads over the starfield. The armor is 0.16
  metallic / 0.58 rough and feeds the same albedo into a restrained 0.10
  emissive floor; it is not added to the GlowLayer, so it remains crisp rather
  than blooming. World-space box projection keeps scale consistent.
- **Emissives:** the narrow dorsal/wing channels, muzzle cells, and nozzle discs
  use `Wraith_CyanGlow`; they provide Novari recognition while the runtime
  engine system supplies the actual thrust plume.

### Export settings
Run `scripts/build_wraith.py` in Blender. It rebuilds the source, saves
`art/wraith.blend`, exports only the `Wraith` collection as +Y-up GLB with
JPEG quality 84, and writes `art/pictures/wraith_mk2_preview.png`.
