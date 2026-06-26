import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { GameConfig } from "@space-duel/shared";
import { Explosion, type Debris } from "./Explosion";

/**
 * Spawns and ticks short-lived explosion effects. Two shared emissive
 * materials (flash + debris) are reused across every explosion.
 *
 * GlowLayer is opt-in per mesh: we add each new flash and debris piece to
 * it on spawn so the explosion blooms hot. They're disposed when the
 * explosion expires — Babylon's GlowLayer handles disposed meshes safely.
 */
export class ExplosionSystem {
  private readonly active: Explosion[] = [];
  private readonly flashMat: StandardMaterial;
  private readonly debrisMat: StandardMaterial;
  /** Hot-orange flash for turret muzzle pops (spawnMuzzleFlash). */
  private readonly muzzleFlashMat: StandardMaterial;
  /** Hot white-gold glint for impact sparks (spawnSpark). */
  private readonly sparkMat: StandardMaterial;

  constructor(
    private readonly scene: Scene,
    private readonly glowLayer: GlowLayer,
  ) {
    // Flash: nearly white, > 1 emissive components so it punches through bloom.
    this.flashMat = new StandardMaterial("explosion_flash_mat", scene);
    this.flashMat.diffuseColor = new Color3(0, 0, 0);
    this.flashMat.specularColor = new Color3(0, 0, 0);
    this.flashMat.emissiveColor = new Color3(2.5, 2.0, 1.2);
    this.flashMat.disableLighting = true;

    // Debris: warm orange.
    this.debrisMat = new StandardMaterial("explosion_debris_mat", scene);
    this.debrisMat.diffuseColor = new Color3(0, 0, 0);
    this.debrisMat.specularColor = new Color3(0, 0, 0);
    this.debrisMat.emissiveColor = new Color3(1.8, 0.6, 0.15);
    this.debrisMat.disableLighting = true;

    // Muzzle flash: hot orange, tinted to match the turret bolt (config-driven).
    const mf = GameConfig.mothership.turrets.muzzleFlash.color;
    this.muzzleFlashMat = new StandardMaterial("turret_muzzle_flash_mat", scene);
    this.muzzleFlashMat.diffuseColor = new Color3(0, 0, 0);
    this.muzzleFlashMat.specularColor = new Color3(0, 0, 0);
    this.muzzleFlashMat.emissiveColor = new Color3(mf.r, mf.g, mf.b);
    this.muzzleFlashMat.disableLighting = true;

    // Spark: hot white-gold, brighter than debris so each sliver punches
    // through bloom as a glint rather than reading as a tiny ember.
    this.sparkMat = new StandardMaterial("impact_spark_mat", scene);
    this.sparkMat.diffuseColor = new Color3(0, 0, 0);
    this.sparkMat.specularColor = new Color3(0, 0, 0);
    this.sparkMat.emissiveColor = new Color3(3.0, 2.6, 1.6);
    this.sparkMat.disableLighting = true;
  }

  /**
   * A small, subtle spark burst at a laser bolt's point of impact — a tiny
   * flash plus a handful of fast slivers that fly out and shrink. Wired off
   * every laserHit so an impact reads on the hull surface, not just via the
   * ship's damage flash. Reuses the Explosion entity (same tween + dispose)
   * at a fraction of a kill's scale.
   */
  spawnSpark(position: Vector3): void {
    const cfg = GameConfig.impactSpark;

    // Roll the burst's shape so no two impacts look stamped from one mold:
    // count, flash punch, and lifetime all vary per hit.
    const count =
      cfg.countMin +
      Math.floor(Math.random() * (cfg.countMax - cfg.countMin + 1));
    const flashPeak =
      cfg.flashPeakMin +
      Math.random() * (cfg.flashPeakMax - cfg.flashPeakMin);
    const duration =
      cfg.durationMs * (1 + (Math.random() * 2 - 1) * cfg.durationJitter);

    const flash = MeshBuilder.CreateSphere(
      "impact_spark_flash",
      { diameter: cfg.flashRadius * 2, segments: 6 },
      this.scene,
    );
    flash.position.copyFrom(position);
    flash.material = this.sparkMat;
    flash.isPickable = false;
    this.glowLayer.addIncludedOnlyMesh(flash);

    // Give the slivers a random base bearing so the spray isn't anchored to a
    // fixed axis, then scatter each one freely around the disc from there.
    const baseAngle = Math.random() * Math.PI * 2;
    const debris: Debris[] = [];
    for (let i = 0; i < count; i++) {
      // Per-sliver size: a burst mixes fine glints with chunkier flecks.
      const sliverSize =
        cfg.size *
        (cfg.sizeVarMin + Math.random() * (cfg.sizeVarMax - cfg.sizeVarMin));
      const mesh = MeshBuilder.CreateBox(
        `impact_spark_${i}`,
        { size: sliverSize },
        this.scene,
      );
      mesh.position.copyFrom(position);
      mesh.material = this.sparkMat;
      mesh.isPickable = false;
      this.glowLayer.addIncludedOnlyMesh(mesh);

      // Slivers spray outward in the X/Z plane with a small vertical kick.
      const angle = baseAngle + Math.random() * Math.PI * 2;
      const speed =
        cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin);
      const velocity = new Vector3(
        Math.cos(angle) * speed,
        (Math.random() - 0.3) * 6,
        Math.sin(angle) * speed,
      );
      const rotationVel = new Vector3(
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
      );
      debris.push({ mesh, velocity, rotationVel });
    }

    this.active.push(new Explosion(flash, debris, duration, flashPeak));
  }

  /**
   * A brief, debris-less flash sphere at a carrier turret's fire point — the
   * muzzle pop wired off the turretFired sim event. Reuses the Explosion entity
   * (flash-only: empty debris list) so it tweens + disposes like any other.
   */
  spawnMuzzleFlash(position: Vector3): void {
    const cfg = GameConfig.mothership.turrets.muzzleFlash;
    const flash = MeshBuilder.CreateSphere(
      "turret_muzzle_flash",
      { diameter: cfg.radius * 2, segments: 6 },
      this.scene,
    );
    flash.position.copyFrom(position);
    flash.material = this.muzzleFlashMat;
    flash.isPickable = false;
    this.glowLayer.addIncludedOnlyMesh(flash);
    this.active.push(new Explosion(flash, [], cfg.durationMs, cfg.peakScale));
  }

  spawn(position: Vector3): void {
    const cfg = GameConfig.explosion;

    const flash = MeshBuilder.CreateSphere(
      "explosion_flash",
      { diameter: cfg.flashRadius * 2, segments: 8 },
      this.scene,
    );
    flash.position.copyFrom(position);
    flash.material = this.flashMat;
    flash.isPickable = false;
    this.glowLayer.addIncludedOnlyMesh(flash);

    const debris: Debris[] = [];
    for (let i = 0; i < cfg.debrisCount; i++) {
      const mesh = MeshBuilder.CreateBox(
        `explosion_debris_${i}`,
        { size: cfg.debrisSize },
        this.scene,
      );
      mesh.position.copyFrom(position);
      mesh.material = this.debrisMat;
      mesh.isPickable = false;
      this.glowLayer.addIncludedOnlyMesh(mesh);

      // Spread outward in a roughly disc-shaped pattern on the X/Z plane,
      // with a small vertical kick for visual depth.
      const angle = (i / cfg.debrisCount) * Math.PI * 2 + Math.random() * 0.4;
      const speed =
        cfg.debrisSpeedMin +
        Math.random() * (cfg.debrisSpeedMax - cfg.debrisSpeedMin);
      const velocity = new Vector3(
        Math.cos(angle) * speed,
        (Math.random() - 0.4) * 4,
        Math.sin(angle) * speed,
      );
      const rotationVel = new Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      );
      debris.push({ mesh, velocity, rotationVel });
    }

    this.active.push(
      new Explosion(flash, debris, cfg.durationMs, cfg.flashPeakScale),
    );
  }

  update(deltaSeconds: number, deltaMs: number): void {
    for (const e of this.active) {
      e.update(deltaSeconds, deltaMs);
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].isExpired) {
        this.active[i].dispose();
        this.active.splice(i, 1);
      }
    }
  }

  get count(): number {
    return this.active.length;
  }
}
