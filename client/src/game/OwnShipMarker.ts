import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Registers MeshBuilder.CreateTorus — the marker ring is a flat torus.
import "@babylonjs/core/Meshes/Builders/torusBuilder";

import { GameConfig } from "@space-duel/shared";

/**
 * Own-ship marker: a persistent flat gold ring under the hull of the ship
 * YOU are flying, so you can re-acquire yourself at a half-second glance in
 * a furball (owner ask 2026-07-05). Client-only depiction — offline it
 * parents to the player root, online to the `myKey` view root; nothing
 * rides the wire. All knobs in `GameConfig.ownMarker`.
 *
 * Deliberate choices:
 * - EXCLUDED from the GlowLayer: the ring is a cue, not a light source —
 *   and exclusion means it depth-tests like ordinary geometry, so the
 *   carrier hull occludes it during launch (a glowing mesh would bleed
 *   through via the GlowLayer's depth-free composite, same reason the
 *   engine glow hides in the tube).
 * - Parented to the ship root: death/respawn visibility is inherited from
 *   the root's setEnabled for free, both offline and via ShipView online.
 * - Counter-banked each frame: the root rolls with the ship's bank
 *   (rotation.z); the ring cancels it so the marker stays a flat ground
 *   ring instead of tilting like a hoop.
 */
export class OwnShipMarker {
  private readonly ring: Mesh;
  private readonly mat: StandardMaterial;
  private readonly shipRoot: TransformNode;
  /** Breathing-pulse phase in radians, advanced by update(). */
  private phase = 0;

  constructor(
    scene: Scene,
    shipRoot: TransformNode,
    glowLayer: GlowLayer,
    hitRadius: number,
  ) {
    const cfg = GameConfig.ownMarker;
    this.shipRoot = shipRoot;

    this.mat = new StandardMaterial("own_marker_mat", scene);
    this.mat.diffuseColor = new Color3(0, 0, 0);
    this.mat.specularColor = new Color3(0, 0, 0);
    this.mat.emissiveColor = new Color3(cfg.color.r, cfg.color.g, cfg.color.b);
    this.mat.disableLighting = true;
    this.mat.alpha = cfg.baseAlpha;

    this.ring = MeshBuilder.CreateTorus(
      "own_ship_marker",
      {
        diameter: hitRadius * cfg.radiusScale * 2,
        thickness: cfg.thickness,
        tessellation: cfg.tessellation,
      },
      scene,
    );
    this.ring.parent = shipRoot;
    this.ring.position.y = cfg.yOffset;
    this.ring.material = this.mat;
    this.ring.isPickable = false;
    glowLayer.addExcludedMesh(this.ring);
  }

  /** Advance the breathing pulse + cancel the hull's bank roll. Call once
   * per frame; safe through hitstop (it's a UI cue, like camera shake). */
  update(deltaSeconds: number): void {
    const cfg = GameConfig.ownMarker;
    this.phase =
      (this.phase + (deltaSeconds * Math.PI * 2000) / cfg.pulsePeriodMs) %
      (Math.PI * 2);
    this.mat.alpha = cfg.baseAlpha + Math.sin(this.phase) * cfg.pulseDepth;
    // ShipView writes the bank as root.rotation.z; a child rotation.z of the
    // negation composes to identity (both are the innermost Euler axis), so
    // the ring stays flat while the hull rolls.
    this.ring.rotation.z = -this.shipRoot.rotation.z;
  }

  /** Tear down the ring (match teardown). */
  dispose(): void {
    this.ring.dispose();
    this.mat.dispose();
  }
}
