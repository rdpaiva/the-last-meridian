import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Registers MeshBuilder.CreateBox (boxes are opt-in to tree-shaking).
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "../GameConfig";
import type { Hulk } from "../sim/Hulk";

/**
 * Hulk VIEW — the depiction of a derelict wreck (sim half: `Hulk`). Slice 5a
 * keeps this minimal: a DARK, dead block per hull rectangle, parented to a root
 * that carries the wreck's position + scale and is SPUN each frame to match the
 * sim's slow drift-rotation (`update`). It reads as a husk precisely because it
 * does NOT glow — no emissive, never added to the GlowLayer.
 *
 * Slice 5b swaps these blocks for the actual carrier wreck GLB (the burned-out
 * Aegis / Choirship renders) loaded under this same spinning root, so the GLB
 * inherits the rotation for free.
 *
 * The blocks are built from the UNSCALED source-carrier hull rectangles under a
 * root scaled by the hulk's `scale`, so they line up with the sim's collision
 * circles (which were derived from the same rects × the same scale).
 */
export class HulkView {
  readonly root: TransformNode;

  constructor(scene: Scene, sim: Hulk) {
    this.root = new TransformNode(`hulk_${sim.source}_root`, scene);
    this.root.position.copyFrom(sim.center);
    this.root.rotation.y = sim.rotationY;
    this.root.scaling.setAll(sim.scale);

    const mat = new StandardMaterial(`hulk_${sim.source}_dead_mat`, scene);
    // Cold, dark, matte metal — burned-out and lifeless. No emissive, so it
    // stays dim against the glowing live ships (5b's GLB adds the ember look).
    mat.diffuseColor = new Color3(0.12, 0.12, 0.14);
    mat.specularColor = new Color3(0.02, 0.02, 0.03);

    // One block per hull rectangle, in carrier-LOCAL space under the root.
    const height = 18;
    const rects = GameConfig.mothership.hullRects[sim.source];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const box = MeshBuilder.CreateBox(
        `hulk_${sim.source}_sec${i}`,
        { width: r.halfWidth * 2, height, depth: r.z1 - r.z0 },
        scene,
      );
      box.position.set(0, height / 2, (r.z0 + r.z1) / 2);
      box.parent = this.root;
      box.material = mat;
      box.isPickable = false;
    }
  }

  /** Match the mesh to the wreck's current (sim-owned) drift rotation. */
  update(rotationY: number): void {
    this.root.rotation.y = rotationY;
  }

  /** Tear down the scene nodes (match end). */
  dispose(): void {
    this.root.dispose(false, true);
  }
}
