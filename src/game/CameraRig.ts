import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";

import { GameConfig } from "./GameConfig";
import { clamp, exponentialDecay } from "./math";

/**
 * Angled top-down camera that smoothly follows the player, with a
 * trauma-based shake on top.
 *
 * The base camera does NOT rotate with the ship — it stays world-aligned,
 * like an Asteroids/Geometry Wars overhead view. We smooth a "tracked
 * target" toward `playerPosition + velocity * lead`, then place the camera
 * at trackedTarget + fixed offset each frame.
 *
 * Shake is layered on top via `addTrauma(amount)`. Each impact adds to
 * trauma (capped at 1.0); trauma decays exponentially; per-frame shake
 * offset = max × trauma² × sine-noise. We shake position but NOT target,
 * which gives a slight angular jolt to the view — feels like the camera
 * mount itself got hit, rather than the whole world translating.
 *
 * Camera shake continues animating during hitstop (Game.ts pauses sim
 * but still calls update()), so the freeze-frame trembles satisfyingly.
 */
export class CameraRig {
  readonly camera: UniversalCamera;
  private readonly offset: Vector3;
  private readonly trackedTarget = new Vector3();
  private readonly desiredTarget = new Vector3();

  /** 0..1 — current trauma. Decays at GameConfig.shake.decayRate per second. */
  private trauma = 0;
  /** Internal clock for the sine-noise. Advances every frame. */
  private shakeTime = 0;

  /**
   * Live zoom factor multiplying the base offset. 1.0 = default framing;
   * driven by the +/- keys via update(), clamped to [minZoom, maxZoom].
   */
  private zoom = 1;

  constructor(scene: Scene) {
    const cfg = GameConfig.camera;
    this.offset = new Vector3(0, cfg.offsetY, -cfg.offsetZ);

    const startPos = new Vector3(0, 0, 0).addInPlace(this.offset);
    this.camera = new UniversalCamera("playerCam", startPos, scene);
    this.camera.setTarget(Vector3.Zero());
    this.camera.minZ = cfg.nearClip;
    this.camera.maxZ = cfg.farClip;
    this.camera.fov = 0.9;

    this.camera.inputs.clear();
  }

  /**
   * Add to the camera's trauma value (clamped to 1.0). Repeated impacts
   * stack until they cap, then decay together — chained hits don't compound
   * past the cap, which keeps long combos from melting your eyes.
   */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(
    deltaSeconds: number,
    playerPosition: Vector3,
    playerVelocity: Vector3,
    zoomInput: number,
  ): void {
    const cfg = GameConfig.camera;
    const shakeCfg = GameConfig.shake;
    const lead = cfg.velocityLead;

    // --- Apply zoom input (+ = closer, - = further) ---
    // zoomInput is -1 / 0 / +1. Positive zooms IN (shrinks the offset),
    // negative zooms OUT, scaled by zoomRate so it's frame-rate-independent.
    if (zoomInput !== 0) {
      this.zoom = clamp(
        this.zoom - zoomInput * cfg.zoomRate * deltaSeconds,
        cfg.minZoom,
        cfg.maxZoom,
      );
    }

    // --- Decay trauma ---
    this.trauma = Math.max(
      0,
      this.trauma - shakeCfg.decayRate * deltaSeconds,
    );
    this.shakeTime += deltaSeconds;

    // --- Base camera tracking (unchanged from before) ---
    this.desiredTarget.x = playerPosition.x + playerVelocity.x * lead;
    this.desiredTarget.y = playerPosition.y;
    this.desiredTarget.z = playerPosition.z + playerVelocity.z * lead;

    const t = exponentialDecay(cfg.smoothingRate, deltaSeconds);
    this.trackedTarget.x +=
      (this.desiredTarget.x - this.trackedTarget.x) * t;
    this.trackedTarget.y +=
      (this.desiredTarget.y - this.trackedTarget.y) * t;
    this.trackedTarget.z +=
      (this.desiredTarget.z - this.trackedTarget.z) * t;

    // --- Compute shake offset ---
    // Squared intensity gives the classic "big events feel huge, small
    // events feel subtle" falloff. Two-sine mix per axis is cheap pseudo-
    // noise without state — looks more natural than a single sine.
    const intensity = this.trauma * this.trauma;
    const tShake = this.shakeTime;
    const shakeX =
      shakeCfg.maxOffsetXZ *
      intensity *
      (Math.sin(tShake * 31.5 + 0.7) + Math.sin(tShake * 47.2 + 1.05)) *
      0.5;
    const shakeZ =
      shakeCfg.maxOffsetXZ *
      intensity *
      (Math.cos(tShake * 27.3 + 1.3) + Math.cos(tShake * 39.7 + 1.95)) *
      0.5;
    const shakeY =
      shakeCfg.maxOffsetY *
      intensity *
      Math.sin(tShake * 41.7);

    // --- Final camera position (base + zoomed offset + shake) ---
    // Offset is scaled by the live zoom factor; shake rides on top unscaled.
    this.camera.position.x =
      this.trackedTarget.x + this.offset.x * this.zoom + shakeX;
    this.camera.position.y =
      this.trackedTarget.y + this.offset.y * this.zoom + shakeY;
    this.camera.position.z =
      this.trackedTarget.z + this.offset.z * this.zoom + shakeZ;

    // Target stays at the un-shaken trackedTarget so the shake introduces
    // a slight tilt — feels like a camera mount being jolted, not the
    // whole world sliding.
    this.camera.setTarget(this.trackedTarget);
  }
}
