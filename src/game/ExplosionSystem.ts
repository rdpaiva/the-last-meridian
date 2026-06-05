import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { GameConfig } from "./GameConfig";
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
