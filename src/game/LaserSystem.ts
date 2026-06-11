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
   * Called once per bolt that lands a hit, with the target it struck and
   * whether the human pilot fired that bolt. The target lets the caller scale
   * feedback by what was hit (flash + big hitstop when the player's own ship is
   * hit, light cue when the mothership is chipped); `fromPlayer` lets it give
   * the "you landed a hit" jolt only for the player, not every AI wingman shot.
   */
  onHit?: (target: DamageTarget, fromPlayer: boolean) => void;
  /**
   * Live obstacles (asteroids) that block bolts as line-of-sight cover. Checked
   * BEFORE the target loop each frame, so a bolt entering a rock is consumed
   * there and can't pass through to a ship behind it. Damaged on contact (rocks
   * are destructible). Held by reference — the field mutates this array as rocks
   * shatter/are destroyed, and the system sees the changes for free.
   */
  obstacles?: DamageTarget[];
};

export class LaserSystem {
  private readonly lasers: Laser[] = [];
  private readonly material: Material;
  private readonly damage: number;
  private readonly onHit: ((target: DamageTarget, fromPlayer: boolean) => void) | null;
  /** Asteroid cover bolts are blocked by (held by reference; may be empty). */
  private readonly obstacles: DamageTarget[];
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
    this.obstacles = options.obstacles ?? [];

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
   * `fromPlayer` tags bolts the human pilot fired (vs. an AI wingman on the same
   * faction system) so onHit can scale feedback to the player's own shots.
   */
  spawn(origin: Vector3, rotationY: number, fromPlayer = false): void {
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
    // The bolt mesh is `length` long and CENTERED on its position, so spawning
    // it exactly at the muzzle leaves half the streak poking out behind. Nudge
    // it forward along its heading so its rear tip sits at the muzzle and the
    // bolt reads as emanating from the gun.
    mesh.position.set(
      origin.x + Math.sin(rotationY) * cfg.spawnOffset,
      origin.y,
      origin.z + Math.cos(rotationY) * cfg.spawnOffset,
    );

    const velocity = new Vector3(
      Math.sin(rotationY) * cfg.speed,
      0,
      Math.cos(rotationY) * cfg.speed,
    );

    this.lasers.push(new Laser(mesh, velocity, cfg.lifetimeMs, rotationY, fromPlayer));
  }

  update(deltaSeconds: number, deltaMs: number): void {
    const targets = this.targets;
    const obstacles = this.obstacles;

    for (const laser of this.lasers) {
      // Capture the bolt's position BEFORE it moves, then sweep the segment
      // from there to its new position against every circle this frame. A point
      // test at only the new position tunnels: at 95 u/s a single 60Hz step is
      // ~1.6 units and a 30Hz (delta-clamped) step is ~3.2 — larger than a
      // ship's 2.4-unit capture diameter — so a target sitting between the two
      // sample points is skipped entirely. The swept test makes hits
      // frame-rate-independent: any circle the path crosses is caught.
      const ax = laser.mesh.position.x;
      const az = laser.mesh.position.z;
      laser.update(deltaSeconds, deltaMs);
      if (laser.isExpired) continue;
      const bx = laser.mesh.position.x;
      const bz = laser.mesh.position.z;

      // Cover: asteroids block bolts. Checked BEFORE targets, so a rock between
      // the gun and a ship eats the bolt (line-of-sight blocking) and chips the
      // rock (destructible). Swept-segment X/Z test, same as targets.
      let blocked = false;
      for (const rock of obstacles) {
        if (!rock.isAlive) continue;
        // Closest point on the bolt's path segment to the rock center; the
        // squared distance there is what we test the silhouette against.
        const t = closestTOnSegment(rock.position.x, rock.position.z, ax, az, bx, bz);
        const cx = ax + (bx - ax) * t;
        const cz = az + (bz - az) * t;
        const dx = cx - rock.position.x;
        const dz = cz - rock.position.z;
        const distSq = dx * dx + dz * dz;
        // Broad phase vs. the conservative circle, then the exact directional
        // silhouette (asteroids are squashed ellipsoids — a bolt skimming a
        // rock's short axis should pass, not vanish into empty space).
        if (distSq > rock.hitRadius * rock.hitRadius) continue;
        const r = rock.surfaceRadiusToward
          ? rock.surfaceRadiusToward(dx, dz)
          : rock.hitRadius;
        if (distSq <= r * r) {
          rock.takeDamage(this.damage);
          laser.kill();
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Collision: swept X/Z test of the path segment against each live target.
      // Y axis is ignored — gameplay is on one plane. First overlap consumes
      // the bolt.
      for (const target of targets) {
        if (!target.isAlive) continue;
        const distSq = distSqSegmentToPoint(target.position.x, target.position.z, ax, az, bx, bz);
        const radiusSq = target.hitRadius * target.hitRadius;
        if (distSq <= radiusSq) {
          target.takeDamage(this.damage);
          laser.kill();
          this.onHit?.(target, laser.fromPlayer);
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

/**
 * Clamped parameter `t` in [0, 1] of the point on segment a→b nearest to
 * point p, in the X/Z plane. `t = 0` is at `a`, `t = 1` is at `b`. Used to
 * resolve where along a bolt's per-frame path it passes closest to a circle
 * center (degenerate zero-length segments — e.g. a bolt's spawn frame, where
 * it hasn't moved yet — return 0).
 */
function closestTOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq <= 0) return 0;
  let t = ((px - ax) * abx + (pz - az) * abz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t;
}

/**
 * Squared distance from point p to the nearest point on segment a→b, in the
 * X/Z plane. This is the swept collision primitive: comparing it to a target's
 * squared hit radius tells us whether the bolt's path THIS FRAME crossed the
 * target's circle, regardless of how far the bolt stepped — closing the
 * tunneling gap a point-at-new-position test leaves open.
 */
function distSqSegmentToPoint(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const t = closestTOnSegment(px, pz, ax, az, bx, bz);
  const cx = ax + (bx - ax) * t;
  const cz = az + (bz - az) * t;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
}
