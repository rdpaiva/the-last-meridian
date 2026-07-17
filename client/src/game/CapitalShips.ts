import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "@space-duel/shared";
import { includeInGlow } from "./GlowInclude";

/**
 * Procedural background capital ships built entirely from box primitives.
 * Stationary scenery — they exist purely to give the deep-space backdrop a
 * sense of scale and inhabitation. Engines and running lights are emissive
 * and bloom via the GlowLayer.
 *
 * Three shared materials (hull, engine, light) are reused across every
 * ship so the entire fleet costs a small fixed amount regardless of count.
 *
 * Each destroyer is composed of:
 *   - Hull base (wide flat box)
 *   - Spine (slimmer box on top, full length)
 *   - Tower (tall box near the rear)
 *   - Engine block (emissive amber at the rear)
 *   - Running lights (6 small emissive cool-blue boxes along the spine)
 *
 * Local convention: hull length runs along the ship's local +Z axis.
 * The "rear" is -Z (where the engine sits) and the "nose" is +Z.
 */

type Placement = {
  /** Position as fraction of arena halfWidth/halfDepth. May exceed ±1. */
  xFrac: number;
  zFrac: number;
  yOffset: number;
  rotationY: number;
  /** Hull length in world units. */
  length: number;
};

const PLACEMENTS: Placement[] = [
  { xFrac: 0.55, zFrac: 0.45, yOffset: 0, rotationY: 0.35, length: 32 },
  { xFrac: -0.7, zFrac: -0.6, yOffset: -2, rotationY: -1.1, length: 38 },
  { xFrac: 0.1, zFrac: 0.95, yOffset: 1.5, rotationY: 1.7, length: 26 },
];

export class CapitalShips {
  private readonly hullMat: StandardMaterial;
  private readonly engineMat: StandardMaterial;
  private readonly lightMat: StandardMaterial;

  constructor(
    scene: Scene,
    arenaHalfWidth: number,
    arenaHalfDepth: number,
    glowLayer: GlowLayer,
  ) {
    this.hullMat = this.buildHullMaterial(scene);
    this.engineMat = this.buildEngineMaterial(scene);
    this.lightMat = this.buildLightMaterial(scene);

    const cfg = GameConfig.scenery.capitalShips;
    const placements = PLACEMENTS.slice(0, cfg.count);

    placements.forEach((p, i) => {
      const length = Math.max(
        cfg.lengthMin,
        Math.min(cfg.lengthMax, p.length),
      );
      this.buildDestroyer(scene, glowLayer, {
        position: new Vector3(
          p.xFrac * arenaHalfWidth,
          cfg.yLevel + p.yOffset,
          p.zFrac * arenaHalfDepth,
        ),
        rotationY: p.rotationY,
        length,
        index: i,
      });
    });
  }

  // --- Shared materials ---

  private buildHullMaterial(scene: Scene): StandardMaterial {
    const mat = new StandardMaterial("capship_hull_mat", scene);
    mat.diffuseColor = new Color3(0.18, 0.22, 0.32);
    mat.specularColor = new Color3(0.05, 0.05, 0.08);
    return mat;
  }

  private buildEngineMaterial(scene: Scene): StandardMaterial {
    const mat = new StandardMaterial("capship_engine_mat", scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    // Same warm amber as the player engine, slightly cooled for distance.
    mat.emissiveColor = new Color3(1.4, 0.7, 0.3);
    mat.disableLighting = true;
    return mat;
  }

  private buildLightMaterial(scene: Scene): StandardMaterial {
    const mat = new StandardMaterial("capship_light_mat", scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    // Cool blue-white. >1 components bloom harder via the GlowLayer.
    mat.emissiveColor = new Color3(0.7, 0.85, 1.3);
    mat.disableLighting = true;
    return mat;
  }

  // --- Builder ---

  private buildDestroyer(
    scene: Scene,
    glowLayer: GlowLayer,
    opts: {
      position: Vector3;
      rotationY: number;
      length: number;
      index: number;
    },
  ): void {
    const L = opts.length;
    const root = new TransformNode(`capship_${opts.index}_root`, scene);
    root.position = opts.position;
    root.rotation.y = opts.rotationY;

    // Hull base — flat box, runs along +Z.
    const hull = MeshBuilder.CreateBox(
      `capship_${opts.index}_hull`,
      { width: 4, height: 0.9, depth: L },
      scene,
    );
    hull.material = this.hullMat;
    hull.parent = root;
    hull.isPickable = false;
    hull.checkCollisions = false;

    // Spine — slimmer box on top.
    const spine = MeshBuilder.CreateBox(
      `capship_${opts.index}_spine`,
      { width: 1.8, height: 0.5, depth: L * 0.85 },
      scene,
    );
    spine.position = new Vector3(0, 0.7, 0);
    spine.material = this.hullMat;
    spine.parent = root;
    spine.isPickable = false;

    // Tower — tall block toward the rear.
    const tower = MeshBuilder.CreateBox(
      `capship_${opts.index}_tower`,
      { width: 1.4, height: 3.5, depth: 3.5 },
      scene,
    );
    tower.position = new Vector3(0, 2.4, -L * 0.3);
    tower.material = this.hullMat;
    tower.parent = root;
    tower.isPickable = false;

    // Engine block — emissive amber, sits behind the hull.
    const engineDepth = 2.5;
    const engine = MeshBuilder.CreateBox(
      `capship_${opts.index}_engine`,
      { width: 2.6, height: 1.4, depth: engineDepth },
      scene,
    );
    engine.position = new Vector3(0, 0, -L / 2 - engineDepth / 2);
    engine.material = this.engineMat;
    engine.parent = root;
    engine.isPickable = false;
    includeInGlow(glowLayer, engine);

    // Running lights — 6 small emissive boxes spaced along the spine top.
    // Type-widen to `number` so a future change to `1` doesn't trigger the
    // "comparison has no overlap" TS warning.
    const lightCount: number = 6;
    const spineUsableLen = L * 0.8;
    for (let i = 0; i < lightCount; i++) {
      const t = lightCount === 1 ? 0.5 : i / (lightCount - 1);
      const z = -spineUsableLen / 2 + t * spineUsableLen;
      const light = MeshBuilder.CreateBox(
        `capship_${opts.index}_light_${i}`,
        { width: 0.18, height: 0.18, depth: 0.18 },
        scene,
      );
      light.position = new Vector3(0, 1.05, z);
      light.material = this.lightMat;
      light.parent = root;
      light.isPickable = false;
      includeInGlow(glowLayer, light);
    }
  }
}
