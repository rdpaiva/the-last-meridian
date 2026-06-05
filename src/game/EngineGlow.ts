import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { GameConfig } from "./GameConfig";

/**
 * Engine glow effect: a small steady emissive sphere parented at the rear
 * of the ship, plus a TrailMesh that streams behind as the ship moves.
 *
 * Both meshes use emissive materials and participate in the GlowLayer, so
 * they bloom into a soft halo. Intensity is modulated by thrust state and
 * speed, so cruising glows softly and full-throttle hits a hot orange.
 *
 * The trail's anchor is parented to the ship root, so the trail follows
 * rotation correctly. Sharp 180° flips will stretch the tube briefly —
 * acceptable given the ship's modest rotation speed.
 */
export class EngineGlow {
  private readonly anchor: TransformNode;
  private readonly coreMat: StandardMaterial;
  private readonly trailMat: StandardMaterial;
  private readonly core;

  /** 0 = idle, 1 = full thrust. Smoothed each frame. */
  private intensity = 0;

  /** Read-only view of the smoothed thrust intensity (0..1) — used by
   * SoundSystem to keep the engine hum's audio level in sync with the
   * visual flare. */
  get currentIntensity(): number {
    return this.intensity;
  }

  /** Reused scratch color so we don't allocate per frame. */
  private readonly currentColor = new Color3();

  // Color targets for emissive. > 1 values bloom harder via GlowLayer.
  private readonly idleColor = new Color3(0.35, 0.18, 0.08);
  private readonly hotColor = new Color3(1.6, 0.85, 0.35);

  constructor(scene: Scene, shipRoot: TransformNode, glowLayer: GlowLayer) {
    const cfg = GameConfig.engineGlow;

    // Anchor sits at the rear of the ship in local space.
    this.anchor = new TransformNode("engine_anchor", scene);
    this.anchor.parent = shipRoot;
    this.anchor.position = new Vector3(0, 0, -0.7);

    // --- Core glow sphere ---
    this.core = MeshBuilder.CreateSphere(
      "engine_core",
      { diameter: 0.34, segments: 8 },
      scene,
    );
    this.core.parent = this.anchor;
    this.core.isPickable = false;

    this.coreMat = new StandardMaterial("engine_core_mat", scene);
    this.coreMat.diffuseColor = new Color3(0, 0, 0);
    this.coreMat.specularColor = new Color3(0, 0, 0);
    this.coreMat.emissiveColor = this.idleColor.clone();
    this.coreMat.disableLighting = true;
    this.core.material = this.coreMat;

    // --- Trail ---
    // TrailMesh records the anchor's world matrix each frame and renders a
    // tube. autoStart=true so it begins recording immediately.
    const trail = new TrailMesh(
      "engine_trail",
      this.anchor,
      scene,
      cfg.trailDiameter,
      cfg.trailLength,
      true,
    );
    this.trailMat = new StandardMaterial("engine_trail_mat", scene);
    this.trailMat.diffuseColor = new Color3(0, 0, 0);
    this.trailMat.specularColor = new Color3(0, 0, 0);
    this.trailMat.emissiveColor = this.idleColor.clone();
    this.trailMat.disableLighting = true;
    this.trailMat.alpha = 0.6;
    trail.material = this.trailMat;
    trail.isPickable = false;

    // Opt the core into glow explicitly. The trail glows automatically
    // because emissive materials are picked up by GlowLayer by default;
    // adding the core here keeps it consistent if we ever flip GlowLayer
    // into includedOnly mode.
    glowLayer.addIncludedOnlyMesh(this.core);
  }

  update(
    deltaSeconds: number,
    speed: number,
    maxSpeed: number,
    thrusting: boolean,
  ): void {
    const cfg = GameConfig.engineGlow;
    // Target intensity: 1.0 while thrusting, otherwise scaled by current
    // speed (so coasting at high speed still glows softly).
    const target = thrusting ? 1 : (speed / maxSpeed) * 0.4;

    const t = 1 - Math.exp(-cfg.responseRate * deltaSeconds);
    this.intensity += (target - this.intensity) * t;

    // Lerp idle → hot by intensity, write into shared scratch.
    this.currentColor.r =
      this.idleColor.r + (this.hotColor.r - this.idleColor.r) * this.intensity;
    this.currentColor.g =
      this.idleColor.g + (this.hotColor.g - this.idleColor.g) * this.intensity;
    this.currentColor.b =
      this.idleColor.b + (this.hotColor.b - this.idleColor.b) * this.intensity;

    // copyFrom (not assignment) so we don't replace the Color3 reference
    // Babylon's renderer is reading.
    this.coreMat.emissiveColor.copyFrom(this.currentColor);
    this.trailMat.emissiveColor.copyFrom(this.currentColor);

    // Pulse core scale slightly with thrust so it visibly "kicks" on burn.
    const s = 1 + this.intensity * 0.45;
    this.core.scaling.set(s, s, s);
  }
}
