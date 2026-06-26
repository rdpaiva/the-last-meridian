import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
// Registers MeshBuilder.CreatePlane (planes are opt-in to tree-shaking).
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import { GameConfig } from "@space-duel/shared";
import type { ConcealmentZone } from "@space-duel/shared";
import { computeConcealmentZones } from "@space-duel/shared";

/**
 * Combat nebulas — the gameplay stealth clouds, distinct from the deep
 * background `Nebulas`. Each cloud is a painted alpha quad floating just
 * ABOVE the fighter plane (GameConfig.scenery.combatNebulas.yLevel), so a
 * ship that flies in is visibly veiled by the gas — and the cloud's X/Z
 * footprint is exported via `zones` as a SensorSystem concealment zone, the
 * thing that actually hides it from the opposing radar.
 *
 * Rendering follows the Nebulas recipe (and gotchas #9/#10): the premultiplied
 * cloud PNG carries shape/detail through the emissive channel + its own alpha,
 * while the COLOR comes from emissiveColor — saturated and mid-deep so
 * texture × color reads as gas, not bloom white-out.
 */

// Saturated tints, one per zone (wraps). Slightly brighter than the deep
// background nebulas so the gameplay clouds read as "near".
const COLORS: Color3[] = [
  new Color3(0.5, 0.2, 0.68), // violet
  new Color3(0.24, 0.24, 0.8), // indigo
  new Color3(0.66, 0.2, 0.5), // magenta-plum
];

const TEXTURE_FILES = [
  "nebula-1-deep-purple.png",
  "nebula-2-violet-indigo.png",
  "nebula-4-warm-magenta.png",
];

export class CombatNebulas {
  /**
   * Hard sensor footprints (world units), consumed by SensorSystem and drawn
   * on the radar. Held by reference by both — never reallocated. The math is
   * the scene-free computeConcealmentZones (the gameplay truth); this view just
   * paints a textured quad over each one.
   */
  readonly zones: ConcealmentZone[];

  constructor(scene: Scene, arenaHalfWidth: number, arenaHalfDepth: number) {
    const cfg = GameConfig.scenery.combatNebulas;
    this.zones = computeConcealmentZones(arenaHalfWidth, arenaHalfDepth);

    this.zones.forEach((zone, i) => {
      const file = TEXTURE_FILES[i % TEXTURE_FILES.length];
      const tex = new Texture(`${import.meta.env.BASE_URL}textures/${file}`, scene);
      tex.hasAlpha = true;

      const mat = new StandardMaterial(`combat_nebula_${i}_mat`, scene);
      mat.emissiveTexture = tex;
      mat.opacityTexture = tex; // per-pixel opacity from the PNG's feathered alpha
      mat.emissiveColor = COLORS[i % COLORS.length];
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.specularColor = new Color3(0, 0, 0);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.alpha = cfg.alpha;

      const quad = MeshBuilder.CreatePlane(
        `combat_nebula_${i}`,
        { size: zone.radius * cfg.visualScale },
        scene,
      );
      quad.position = new Vector3(zone.x, cfg.yLevel, zone.z);
      // Lie flat, normal +Y, facing the top-down camera.
      quad.rotation.x = -Math.PI / 2;
      // Vary the art's rotation so repeated textures don't read as copies.
      quad.rotation.z = i * 1.3;
      quad.material = mat;
      quad.isPickable = false;
      // Render late among transparents so the veil composites over engine
      // trails / bolts flying beneath it.
      quad.alphaIndex = 200;
    });
  }
}
