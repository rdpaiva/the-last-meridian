# Film model → game model

Turns the Episode 01 film ships (Blender exports) into light game versions:
scaled to the game footprint, simplified, 512px WebP textures, quantized, with
the `muzzle.*` / `thruster.*` / `rcs.*` marker empties the game reads.

    cd scripts/game-models && npm install
    # Reaver only: the film export is split per face, so decimate it in Blender first
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python decimate.py -- \
      "<film>/Reaver Hero/Reaver_v13.glb" reaver_dec.glb 0.03
    # same Blender step for the carriers (it also undoes the film files' launch-door animation pose)
    #   … Aegis_v15.glb aegis_dec.glb 0.05   /   … Choirship_v08.glb choirship_dec.glb 0.05
    node make-game-model.mjs spitfire ../../client/public/models/spitfire.glb
    node make-game-model.mjs reaver   ../../client/public/models/reaver.glb
    node make-game-model.mjs aegis     ../../client/public/models/bastion_carrier.glb
    node make-game-model.mjs choirship ../../client/public/models/choirship.glb
    node inspect.mjs ../../client/public/models/reaver.glb   # bounds + markers

When marker positions change, update the matching `muzzles` fallback in
`shared/src/GameConfig.ts` (marker × shipModels scale; used by fleet clones).

Carriers also need their gameplay geometry re-fitted (GameConfig.mothership):

    node footprint.mjs ../../client/public/models/choirship.glb fp_choir   # top-down height map → fp_choir.png/.json
    node fitboxes.mjs fp_choir.json 6 0.975 12 > box_choir.json           # → mothership.colliders.machines
    node rects.mjs box_choir.json                                          # → mothership.hullRects.machines
    cd ../.. && node scripts/measure-carrier-footprint.mjs                 # → measuredLaunch (bays + exitDistance)

Turret mounts are chosen by hand (`turrets` in make-game-model.mjs, written in game
carrier-local units) and must match `mothership.turrets.mounts`. The wreck models
are still the old hull designs, so `GameConfig.hulk.colliders` keeps their old fit.
