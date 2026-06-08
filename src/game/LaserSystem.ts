import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
// Registers MeshBuilder.CreateBox.
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "./GameConfig";
import { Laser } from "./Laser";
import type { DamageTarget } from "./types";

/**
 * Per-faction collection of laser bolts.
 *
 * Two instances exist in the game: one for player bolts (hot pink, targets
 * the enemy ship) and one for enemy bolts (green, targets the player).
 * Each is wired with its visual color, per-hit damage, and an optional
 * DamageTarget that bolts test against each frame.
 *
 * Collision check is intentionally simple: X/Z distance vs. target's
 * `hitRadius`. Y is ignored because gameplay is on a single plane. On a
 * hit, the target takes damage and the bolt is killed for disposal on the
 * next sweep.
 */
export type LaserSystemOptions = {
  /** Bolt damage when it hits the registered target. */
  damage: number;
  /** Emissive RGB of the bolt material (components > 1.0 bloom harder). */
  emissive: Color3;
  /** Optional name for the material — handy when debugging in the inspector. */
  materialName?: string;
  /**
   * Called once per bolt that lands a hit, with the target it struck. The
   * target lets the caller scale feedback by what was hit — e.g. flash + big
   * hitstop when the player's own ship is hit, but only a light cue when the
   * (huge, stationary) mothership takes a chip of damage.
   */
  onHit?: (target: DamageTarget) => void;
};

export class LaserSystem {
  private readonly lasers: Laser[] = [];
  private readonly material: Material;
  private readonly damage: number;
  private readonly onHit: ((target: DamageTarget) => void) | null;
  /**
   * Targets this system's bolts test against each frame. The player system
   * registers every enemy (multi-target); the enemy system registers just
   * the player (a one-element list). A bolt hits the first target it overlaps
   * and is then consumed, so it can't pass through one ship to strike another.
   */
  private readonly targets: DamageTarget[] = [];

  constructor(
    private readonly scene: Scene,
    options: LaserSystemOptions,
  ) {
    this.damage = options.damage;
    this.onHit = options.onHit ?? null;

    const mat = new StandardMaterial(
      options.materialName ?? "laser_mat",
      scene,
    );
    // Diffuse is irrelevant when lighting is disabled — kept dark so the
    // bolt reads as near-pure emission even outside the bloom pass.
    mat.diffuseColor = new Color3(
      options.emissive.r * 0.2,
      options.emissive.g * 0.2,
      options.emissive.b * 0.2,
    );
    mat.emissiveColor = options.emissive;
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    this.material = mat;
  }

  /** Replace the target list with a single DamageTarget. */
  setTarget(target: DamageTarget): void {
    this.targets.length = 0;
    this.targets.push(target);
  }

  /** Add a DamageTarget to the list this system tests bolts against. */
  addTarget(target: DamageTarget): void {
    this.targets.push(target);
  }

  /**
   * Spawn a laser at `origin` with forward direction derived from `rotationY`.
   */
  spawn(origin: Vector3, rotationY: number): void {
    const cfg = GameConfig.laser;

    const mesh = MeshBuilder.CreateBox(
      "laser",
      {
        width: cfg.radius * 2,
        height: cfg.radius * 2,
        depth: cfg.length,
      },
      this.scene,
    );
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.position.copyFrom(origin);

    const velocity = new Vector3(
      Math.sin(rotationY) * cfg.speed,
      0,
      Math.cos(rotationY) * cfg.speed,
    );

    this.lasers.push(new Laser(mesh, velocity, cfg.lifetimeMs, rotationY));
  }

  update(deltaSeconds: number, deltaMs: number): void {
    const targets = this.targets;

    for (const laser of this.lasers) {
      laser.update(deltaSeconds, deltaMs);
      if (laser.isExpired) continue;

      // Collision: simple X/Z sphere test against each live target. Y axis is
      // ignored — gameplay is on one plane. First overlap consumes the bolt.
      for (const target of targets) {
        if (!target.isAlive) continue;
        const dx = laser.mesh.position.x - target.position.x;
        const dz = laser.mesh.position.z - target.position.z;
        const radiusSq = target.hitRadius * target.hitRadius;
        if (dx * dx + dz * dz <= radiusSq) {
          target.takeDamage(this.damage);
          laser.kill();
          this.onHit?.(target);
          break;
        }
      }
    }

    // Sweep expired entries last-to-first so splice doesn't shift the cursor.
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      if (this.lasers[i].isExpired) {
        this.lasers[i].dispose();
        this.lasers.splice(i, 1);
      }
    }
  }

  get count(): number {
    return this.lasers.length;
  }
}
