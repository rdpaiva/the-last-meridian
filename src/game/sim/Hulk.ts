import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig, type HulkHazard } from "../GameConfig";
import type { DamageTarget } from "../types";
import type { AvoidObstacle } from "../ShipController";

/**
 * One world-space cover circle of a hulk. Satisfies BOTH the weapon-obstacle
 * shape (DamageTarget: `position`/`hitRadius`/`isAlive`/`takeDamage`) and the
 * AI `AvoidObstacle` shape (`position`/`radius`/`isAlive`) with a single object,
 * so the same circle feeds weapon LOS-blocking, the keep-out bump, and AI
 * steering. `takeDamage` is a no-op — the wreck is indestructible, so a bolt
 * dies against it (cover) without doing anything. `position` mutates as the
 * hulk rotates.
 */
export interface HulkCircle extends DamageTarget {
  readonly radius: number;
}

/**
 * Hulk SIM — a derelict capital-ship wreck as gameplay truth, with NO Babylon
 * scene objects (its depiction is a client-side HulkView). A placed map hazard
 * (docs/ARENA-MAPS.md slice 5): INDESTRUCTIBLE static cover that blocks weapons
 * line-of-sight and keeps ships out.
 *
 * Collision is a CLUSTER OF CIRCLES (not the carrier's exact rectangles),
 * because the wreck SLOWLY ROTATES (a drifting derelict) — circles are
 * rotation-invariant, so the cover/keep-out never desyncs from the spinning
 * mesh, and the slightly-generous coverage matches the shattered-debris look.
 * The circle cluster is derived once from the source carrier's hull footprint
 * (`GameConfig.mothership.hullRects[source]`, scaled), then its world positions
 * are recomputed each tick as `rotationY` advances. A dynamic sim entity:
 * `update(dt)` must run every sim step (Game.advanceSim + the headless harness).
 */
export class Hulk {
  /** World center on the gameplay plane (Y = the view's deck level). */
  readonly center: Vector3;
  /** Current facing (radians) — advances slowly each tick. */
  rotationY: number;
  readonly rotationRate: number;
  readonly scale: number;
  readonly source: HulkHazard["source"];

  /** World cover circles (positions mutate as the hulk rotates). Held BY
   *  REFERENCE by Game's weapon-obstacle + AI-obstacle lists. */
  readonly circles: ReadonlyArray<HulkCircle>;

  /** Circle centers in carrier-LOCAL space (pre-rotation), paired 1:1 with
   *  `circles`; rotated into world each tick by `recompute`. */
  private readonly localOffsets: ReadonlyArray<{ x: number; z: number }>;

  constructor(spec: HulkHazard) {
    this.source = spec.source;
    this.rotationY = spec.rotationY ?? 0;
    this.rotationRate = spec.rotationRate ?? 0.03; // rad/sec — a slow drift
    this.scale = spec.scale ?? 1;
    this.center = new Vector3(spec.x, GameConfig.mothership.yLevel, spec.z);

    // Build the local circle cluster from the source carrier's hull rectangles
    // (scaled): each rect is sliced into roughly-square circles along its long
    // axis — the same derivation Mothership.buildAvoidanceCircles uses, but on
    // LOCAL rects so the cluster can be rotated as a rigid body each tick.
    const offsets: { x: number; z: number }[] = [];
    const circles: HulkCircle[] = [];
    const s = this.scale;
    for (const rect of GameConfig.mothership.hullRects[this.source]) {
      const halfX = rect.halfWidth * s;
      const z0 = rect.z0 * s;
      const z1 = rect.z1 * s;
      const halfZ = (z1 - z0) / 2;
      const centerZ = (z0 + z1) / 2; // local rect center (x is symmetric → 0)
      const alongZ = halfZ >= halfX;
      const longHalf = alongZ ? halfZ : halfX;
      const shortHalf = alongZ ? halfX : halfZ;
      const n = Math.max(1, Math.ceil(longHalf / Math.max(shortHalf, 1)));
      const sliceHalf = longHalf / n;
      const radius = Math.hypot(shortHalf, sliceHalf);
      for (let i = 0; i < n; i++) {
        const t = -longHalf + sliceHalf * (2 * i + 1);
        offsets.push({
          x: alongZ ? 0 : t,
          z: alongZ ? centerZ + t : centerZ,
        });
        circles.push({
          position: new Vector3(0, this.center.y, 0),
          radius,
          hitRadius: radius,
          isAlive: true,
          takeDamage: () => {
            /* indestructible wreck — bolts die against it (cover), no effect */
          },
        });
      }
    }
    this.localOffsets = offsets;
    this.circles = circles;
    this.recompute();
  }

  /** Advance the slow rotation and refresh every cover circle's world position. */
  update(dtSeconds: number): void {
    this.rotationY += this.rotationRate * dtSeconds;
    this.recompute();
  }

  /** Rotate the local circle offsets into world space about the hulk center. */
  private recompute(): void {
    const sin = Math.sin(this.rotationY);
    const cos = Math.cos(this.rotationY);
    for (let i = 0; i < this.circles.length; i++) {
      const o = this.localOffsets[i];
      // Carrier rotation convention (see Mothership): worldX = cx + cos*lx +
      // sin*lz; worldZ = cz - sin*lx + cos*lz.
      this.circles[i].position.x = this.center.x + cos * o.x + sin * o.z;
      this.circles[i].position.z = this.center.z - sin * o.x + cos * o.z;
    }
  }

  /** AI steering obstacles — the same circle objects (AvoidObstacle-shaped). */
  get avoidObstacles(): ReadonlyArray<AvoidObstacle> {
    return this.circles;
  }
}
