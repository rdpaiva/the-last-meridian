import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Sphere builder registration — the splash sphere (tree-shaking drops it otherwise).
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { GameConfig } from "@space-duel/shared";
import type { Faction } from "@space-duel/shared";
import { ShieldHitFlash } from "./ShieldHitFlash";

/**
 * Spawns and ticks the shield-impact splashes (ShieldHitFlash) — view only.
 * Offline the spawns come straight from Game's laserHit/missileHit handlers
 * (a hit on a MothershipSection whose owner has shieldsUp); online
 * NetworkGame derives the same condition from the replicated FX events.
 *
 * Deliberately NOT glow-registered (JumpFlash is): this is a soft translucent
 * splash whose whole job is to look different from the hot bloomed sparks and
 * explosion flashes. Tinted per spawn with the defending faction's
 * shieldFx.hitFlash.color. Spawns beyond hitFlash.maxActive are dropped (a
 * fleet strafing a carrier is many hits/sec) — a cap, not a queue.
 */
export class ShieldHitFlashSystem {
  private readonly active: ShieldHitFlash[] = [];

  constructor(private readonly scene: Scene) {}

  /** Fire one splash at a world position, tinted for the DEFENDING faction. */
  spawn(position: Vector3, faction: Faction): void {
    const fx = GameConfig.shieldFx.hitFlash;
    if (this.active.length >= fx.maxActive) return;
    const rim = fx.color[faction];

    const mat = new StandardMaterial("shield_hit_mat", this.scene);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(
      rim.r * fx.intensity,
      rim.g * fx.intensity,
      rim.b * fx.intensity,
    );
    mat.disableLighting = true;
    mat.alpha = fx.peakAlpha;

    const flash = MeshBuilder.CreateSphere(
      "shield_hit_flash",
      { diameter: fx.radius * 2, segments: 10 },
      this.scene,
    );
    flash.position.copyFrom(position);
    flash.material = mat;
    flash.isPickable = false;
    flash.scaling.setAll(fx.startScale);

    this.active.push(new ShieldHitFlash(flash));
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
}
