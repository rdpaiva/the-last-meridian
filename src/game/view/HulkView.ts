import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Registers MeshBuilder.CreateBox (boxes are opt-in to tree-shaking).
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import type { Hulk } from "../sim/Hulk";

/**
 * Hulk VIEW — the depiction of a derelict wreck (sim half: `Hulk`). Slice 5a
 * (gameplay) keeps this deliberately minimal: a DARK, dead block per hull
 * section, so the wreck is visible and you can see ships/bolts interacting with
 * its real footprint. It reads as a husk precisely because it does NOT glow —
 * no emissive, never added to the GlowLayer — the opposite of the live carriers.
 *
 * Slice 5b swaps this for the actual carrier GLB rendered with a burned-out
 * "destroyed" material (mirroring MothershipView.applyModel), keeping the same
 * sim footprint. The boxes here are axis-aligned because the sim's hull
 * sections are world-space AABBs, so each box matches its section exactly at
 * the 0/π facings the wrecks use.
 */
export class HulkView {
  readonly root: TransformNode;

  constructor(scene: Scene, sim: Hulk) {
    this.root = new TransformNode(`hulk_${sim.source}_root`, scene);

    const mat = new StandardMaterial(`hulk_${sim.source}_dead_mat`, scene);
    // Cold, dark, matte metal — burned-out and lifeless. No emissive, so it
    // stays dim against the glowing live ships (5b adds ember hotspots).
    mat.diffuseColor = new Color3(0.12, 0.12, 0.14);
    mat.specularColor = new Color3(0.02, 0.02, 0.03);

    // One block per hull section. Sections are world-space AABBs, so the boxes
    // sit in world space (parented to the root only for grouped disposal).
    const height = 18;
    for (let i = 0; i < sim.hullSections.length; i++) {
      const s = sim.hullSections[i];
      const box = MeshBuilder.CreateBox(
        `hulk_${sim.source}_sec${i}`,
        { width: s.maxX - s.minX, height, depth: s.maxZ - s.minZ },
        scene,
      );
      box.position.set(s.position.x, sim.position.y + height / 2, s.position.z);
      box.parent = this.root;
      box.material = mat;
      box.isPickable = false;
    }
  }

  /** Tear down the scene nodes (match end). */
  dispose(): void {
    this.root.dispose(false, true);
  }
}
