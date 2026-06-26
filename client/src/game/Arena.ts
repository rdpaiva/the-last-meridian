import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/groundBuilder";

import { GameConfig } from "@space-duel/shared";

/**
 * Visual play-area reference: a wireframe grid plane. The arena is unbounded —
 * there are no position clamps; halfWidth/halfDepth size the reference grid and
 * seed scenery/spawn scatter, but nothing is walled in by them.
 */
export class Arena {
  readonly halfWidth = GameConfig.arena.halfWidth;
  readonly halfDepth = GameConfig.arena.halfDepth;

  constructor(scene: Scene) {
    // Wireframe grid only — no opaque ground. The starfield (rendered below
    // the play plane) shows through the grid for a "floating in space"
    // feel. If you want a translucent floor, re-add a ground plane here
    // with a low-alpha material.
    const grid = MeshBuilder.CreateGround(
      "arena_grid",
      {
        width: this.halfWidth * 2,
        height: this.halfDepth * 2,
        subdivisions: 24,
      },
      scene,
    );
    grid.position.y = -0.49;
    grid.isPickable = false;

    const gridMat = new StandardMaterial("arena_grid_mat", scene);
    gridMat.wireframe = true;
    gridMat.emissiveColor = new Color3(0.12, 0.18, 0.32);
    gridMat.diffuseColor = new Color3(0, 0, 0);
    gridMat.specularColor = new Color3(0, 0, 0);
    gridMat.disableLighting = true;
    grid.material = gridMat;
    // Toggle off via GameConfig while the textured backdrop carries the
    // visuals. Flip arena.showGrid back on to restore the reference grid.
    grid.setEnabled(GameConfig.arena.showGrid);
  }
}
