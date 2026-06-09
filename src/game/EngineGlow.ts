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
  private readonly coreMat: StandardMaterial;
  private readonly trailMat: StandardMaterial;
  /** One glow core + exhaust trail per configured nozzle (emitter). */
  private readonly cores: ReturnType<typeof MeshBuilder.CreateSphere>[] = [];
  private readonly trails: TrailMesh[] = [];

  /** 0 = idle, 1 = full thrust. Smoothed each frame. */
  private intensity = 0;

  /** Separate smoothing for the trail "thruster line". Unlike `intensity`,
   * this targets thrust input ONLY (never speed) so the streak appears only
   * while the player is actively burning, then fades out as they coast. */
  private trailIntensity = 0;

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

  /**
   * `emitters` are nozzle positions in the ship's local frame; when omitted or
   * empty (no model markers), `GameConfig.engineGlow.emitters` is used.
   */
  constructor(
    scene: Scene,
    shipRoot: TransformNode,
    glowLayer: GlowLayer,
    emitters?: ReadonlyArray<{ x: number; y: number; z: number }>,
  ) {
    const cfg = GameConfig.engineGlow;
    const nozzles = emitters && emitters.length > 0 ? emitters : cfg.emitters;

    // Shared materials — one set drives every nozzle, updated once per frame.
    this.coreMat = new StandardMaterial("engine_core_mat", scene);
    this.coreMat.diffuseColor = new Color3(0, 0, 0);
    this.coreMat.specularColor = new Color3(0, 0, 0);
    this.coreMat.emissiveColor = this.idleColor.clone();
    this.coreMat.disableLighting = true;

    this.trailMat = new StandardMaterial("engine_trail_mat", scene);
    this.trailMat.diffuseColor = new Color3(0, 0, 0);
    this.trailMat.specularColor = new Color3(0, 0, 0);
    this.trailMat.emissiveColor = this.idleColor.clone();
    this.trailMat.disableLighting = true;
    this.trailMat.alpha = 0.6;

    // Build a core glow sphere + exhaust trail at each nozzle.
    nozzles.forEach((e, i) => {
      // Anchor sits at the nozzle in the ship's local space.
      const anchor = new TransformNode(`engine_anchor${i}`, scene);
      anchor.parent = shipRoot;
      anchor.position = new Vector3(e.x, e.y, e.z);

      const core = MeshBuilder.CreateSphere(
        `engine_core${i}`,
        { diameter: cfg.coreDiameter, segments: 8 },
        scene,
      );
      core.parent = anchor;
      core.isPickable = false;
      core.material = this.coreMat;
      this.cores.push(core);

      // TrailMesh records the anchor's world matrix each frame and renders a
      // tube. autoStart=true so it begins recording immediately.
      const trail = new TrailMesh(
        `engine_trail${i}`,
        anchor,
        scene,
        cfg.trailDiameter,
        cfg.trailLength,
        true,
      );
      trail.material = this.trailMat;
      trail.isPickable = false;
      trail.setEnabled(false); // hidden until the player burns
      this.trails.push(trail);

      // Opt the core into glow explicitly. The trail glows automatically
      // because emissive materials are picked up by GlowLayer by default;
      // adding the core here keeps it consistent if we ever flip GlowLayer
      // into includedOnly mode.
      glowLayer.addIncludedOnlyMesh(core);
    });
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

    // The trail streak is gated on thrust input alone, so coasting at speed
    // glows the core softly but shows no exhaust line. Fade in fast on burn,
    // taper out slowly on release, and disable the mesh once it's effectively
    // invisible.
    const trailRate = thrusting ? cfg.trailFadeInRate : cfg.trailFadeOutRate;
    const trailT = 1 - Math.exp(-trailRate * deltaSeconds);
    this.trailIntensity += ((thrusting ? 1 : 0) - this.trailIntensity) * trailT;
    this.trailMat.alpha = 0.6 * this.trailIntensity;
    const trailVisible = this.trailIntensity > 0.01;
    for (const trail of this.trails) trail.setEnabled(trailVisible);

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
    for (const core of this.cores) core.scaling.set(s, s, s);
  }
}
