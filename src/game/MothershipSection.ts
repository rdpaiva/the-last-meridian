import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { DamageTarget } from "./types";
import type { Mothership } from "./Mothership";

/**
 * One rectangle of a mothership's solid hull footprint (built from
 * GameConfig.mothership.hullRects — per faction, the two carriers being
 * different shapes; fitted to the GLBs by scripts/measure-carrier-footprint.mjs).
 *
 * A carrier's top-down silhouette is a stack of long rectangles (spine, body,
 * bow taper…) that circles can only approximate — circles either leave hull
 * corners intangible or add phantom space beside the hull. Since both
 * carriers sit axis-aligned in the world (rotY 0 or π), each section is a
 * world-space axis-aligned box on X/Z, and the fit is near-exact.
 *
 * Each section is a DamageTarget proxy: weapons broad-phase against the
 * box's bounding circle (`hitRadius`), then resolve the exact hit with
 * `intersectsSegmentXZ` (segment-vs-rectangle). Damage forwards to the
 * OWNER's single HP pool — the ship is damaged as a whole; sections have no
 * HP of their own. Game's keep-out bump reads the box extents directly.
 *
 * The AI's avoidance steering still thinks in circles — it steers around
 * `Mothership.avoidanceCircles` (coarse circles derived from these boxes),
 * NOT the sections. Over-covering is harmless there: a pilot giving the
 * hull a wide berth looks natural, while a bolt stopping in phantom space
 * looks broken — that asymmetry is why steering and damage use different
 * shapes.
 *
 * Carriers never move or rotate after construction, so the world-space box
 * is computed once and the proxy is fully static.
 */
export class MothershipSection implements DamageTarget {
  /** World-space box extents on the X/Z plane. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  /** Box center — the DamageTarget anchor (hit sounds, homing, radar). */
  readonly position: Vector3;
  /**
   * Bounding-circle radius (half the box diagonal). BROAD phase only — the
   * exact verdict is intersectsSegmentXZ. Must circumscribe the box.
   */
  readonly hitRadius: number;

  constructor(
    /** The carrier this section belongs to — receives all forwarded damage. */
    readonly owner: Mothership,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ) {
    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
    const halfW = (maxX - minX) / 2;
    const halfD = (maxZ - minZ) / 2;
    this.position = new Vector3(minX + halfW, 0, minZ + halfD);
    this.hitRadius = Math.hypot(halfW, halfD);
  }

  get isAlive(): boolean {
    return this.owner.isAlive;
  }

  takeDamage(amount: number): void {
    this.owner.takeDamage(amount);
  }

  /**
   * Exact silhouette test: does the X/Z segment a→b touch this box? Standard
   * slab clipping; a zero-length segment degenerates to a point-in-box test.
   */
  intersectsSegmentXZ(ax: number, az: number, bx: number, bz: number): boolean {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dz = bz - az;

    if (Math.abs(dx) < 1e-9) {
      if (ax < this.minX || ax > this.maxX) return false;
    } else {
      let tA = (this.minX - ax) / dx;
      let tB = (this.maxX - ax) / dx;
      if (tA > tB) {
        const tmp = tA;
        tA = tB;
        tB = tmp;
      }
      t0 = Math.max(t0, tA);
      t1 = Math.min(t1, tB);
      if (t0 > t1) return false;
    }

    if (Math.abs(dz) < 1e-9) {
      if (az < this.minZ || az > this.maxZ) return false;
    } else {
      let tA = (this.minZ - az) / dz;
      let tB = (this.maxZ - az) / dz;
      if (tA > tB) {
        const tmp = tA;
        tA = tB;
        tB = tmp;
      }
      t0 = Math.max(t0, tA);
      t1 = Math.min(t1, tB);
      if (t0 > t1) return false;
    }

    return true;
  }
}
