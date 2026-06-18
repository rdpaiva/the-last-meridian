import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Builder used below — opt in (tree-shaking drops it otherwise).
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { GameConfig } from "./GameConfig";
import { JumpFlash } from "./JumpFlash";

/**
 * Spawns and ticks the central jump flash "pops" (JumpFlash). Driven off the
 * jumpFired SimEvent (Game.wireSimEventFeedback) — view only, never the sim.
 * The expanding SHOCKWAVE is the separate JumpRipple post-process; this owns
 * only the bright core. One spawn() per END of a jump (departure + arrival).
 *
 * Each flash gets a fresh mesh + material (jumps are rare). Meshes opt into the
 * GlowLayer so the core blooms, and are disposed on expiry — Babylon's
 * GlowLayer handles disposed meshes safely (same pattern as ExplosionSystem).
 */
export class JumpFlashSystem {
  private readonly active: JumpFlash[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly glowLayer: GlowLayer,
  ) {}

  /** Fire one flash at a world position (Y is taken from the vector). */
  spawn(position: Vector3): void {
    const fx = GameConfig.jumpFx;

    const mat = new StandardMaterial("jump_flash_mat", this.scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(
      fx.flashColor.r,
      fx.flashColor.g,
      fx.flashColor.b,
    );
    mat.disableLighting = true;

    const flash = MeshBuilder.CreateSphere(
      "jump_flash",
      { diameter: fx.flashRadius * 2, segments: 12 },
      this.scene,
    );
    flash.position.copyFrom(position);
    flash.material = mat;
    flash.isPickable = false;
    flash.scaling.setAll(0);
    this.glowLayer.addIncludedOnlyMesh(flash);

    this.active.push(new JumpFlash(flash, fx.durationMs));
  }

  update(deltaMs: number): void {
    for (const f of this.active) f.update(deltaMs);
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
