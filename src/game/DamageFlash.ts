import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

/** Default red — signals damage to the player. Pass a different color for hit-confirm flashes on AI ships. */
const DEFAULT_EMISSIVE = new Color3(2.5, 0.2, 0.2);

import { GameConfig } from "./GameConfig";

/**
 * Red emissive sphere that surrounds the player ship and pulses briefly
 * on damage. The bloom from GlowLayer makes it read as a hot energy
 * shock rather than a flat overlay.
 *
 * Parented to the ship root so it tracks position and rotation
 * automatically. Hidden between flashes via setEnabled() — fully invisible
 * and zero-cost to render.
 */
export class DamageFlash {
  private readonly mesh: Mesh;
  private readonly material: StandardMaterial;
  private flashStartedMs = 0;
  private active = false;

  constructor(scene: Scene, shipRoot: TransformNode, glowLayer: GlowLayer, emissiveColor?: Color3) {
    const cfg = GameConfig.damageFlash;

    this.mesh = MeshBuilder.CreateSphere(
      "damage_flash",
      { diameter: cfg.diameter, segments: 12 },
      scene,
    );
    this.mesh.parent = shipRoot;
    this.mesh.isPickable = false;
    this.mesh.setEnabled(false);

    this.material = new StandardMaterial("damage_flash_mat", scene);
    this.material.diffuseColor = new Color3(0, 0, 0);
    this.material.specularColor = new Color3(0, 0, 0);
    this.material.emissiveColor = emissiveColor ?? DEFAULT_EMISSIVE;
    this.material.disableLighting = true;
    this.material.alpha = 0;
    // Don't write into the depth buffer — keeps the ship's own depth
    // values intact so opaque geometry behind the flash isn't occluded.
    this.material.disableDepthWrite = true;
    this.mesh.material = this.material;

    glowLayer.addIncludedOnlyMesh(this.mesh);
  }

  /** Start a flash from full alpha. Idempotent — re-triggering restarts. */
  trigger(): void {
    this.flashStartedMs = performance.now();
    this.active = true;
    this.mesh.setEnabled(true);
  }

  /**
   * Update the flash alpha based on wall-clock time. Called every frame
   * (even during hitstop — we want the flash to keep animating during
   * the freeze).
   */
  update(): void {
    if (!this.active) return;

    const cfg = GameConfig.damageFlash;
    const elapsed = performance.now() - this.flashStartedMs;
    if (elapsed >= cfg.durationMs) {
      this.material.alpha = 0;
      this.mesh.setEnabled(false);
      this.active = false;
      return;
    }

    // Linear fade from peakAlpha → 0.
    const remaining = 1 - elapsed / cfg.durationMs;
    this.material.alpha = cfg.peakAlpha * remaining;
  }
}
