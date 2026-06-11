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
