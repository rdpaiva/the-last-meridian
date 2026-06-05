import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";

import { GameConfig } from "./GameConfig";

/**
 * Backdrop starfield rendered as two parallax layers of thin-instanced
 * spheres. Each layer is one draw call regardless of star count, so 1500
 * stars cost essentially nothing.
 *
 * The stars sit far below the play plane (Y < -8). Because the gameplay
 * arena uses only a wireframe grid (no opaque ground), the stars are
 * visible "through" the playing field — they read as deep space behind
 * the ships.
 */
export class Starfield {
  constructor(scene: Scene, arenaHalfWidth: number) {
    const cfg = GameConfig.starfield;

    this.buildLayer(scene, {
      name: "starfield_near",
      count: cfg.nearCount,
      yLevel: cfg.nearY,
      spread: arenaHalfWidth * 4,
      minScale: 0.08,
      maxScale: 0.22,
      color: new Color3(1.0, 1.0, 1.0),
    });

    this.buildLayer(scene, {
      name: "starfield_far",
      count: cfg.farCount,
      yLevel: cfg.farY,
      spread: arenaHalfWidth * 6,
      minScale: 0.04,
      maxScale: 0.12,
      // Slight blue cast — far stars feel cooler.
      color: new Color3(0.7, 0.78, 0.95),
    });
  }

  private buildLayer(
    scene: Scene,
    opts: {
      name: string;
      count: number;
      yLevel: number;
      spread: number;
      minScale: number;
      maxScale: number;
      color: Color3;
    },
  ): void {
    const template = MeshBuilder.CreateSphere(
      opts.name,
      { diameter: 1, segments: 4 },
      scene,
    );

    const mat = new StandardMaterial(`${opts.name}_mat`, scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = opts.color;
    mat.disableLighting = true;
    template.material = mat;
    template.isPickable = false;
    // Stars don't cast shadows or receive lighting — keep them out of any
    // shadow generators we add later.
    template.receiveShadows = false;

    // Build the per-instance world matrices once at construction.
    const matrices = new Float32Array(opts.count * 16);
    const scaleScratch = new Vector3();
    const posScratch = new Vector3();
    const rotScratch = Quaternion.Identity();
    const matrixScratch = new Matrix();

    for (let i = 0; i < opts.count; i++) {
      const s =
        opts.minScale + Math.random() * (opts.maxScale - opts.minScale);
      scaleScratch.set(s, s, s);
      posScratch.set(
        (Math.random() - 0.5) * opts.spread * 2,
        opts.yLevel + (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * opts.spread * 2,
      );
      Matrix.ComposeToRef(scaleScratch, rotScratch, posScratch, matrixScratch);
      matrixScratch.copyToArray(matrices, i * 16);
    }
    template.thinInstanceSetBuffer("matrix", matrices, 16);
  }
}
