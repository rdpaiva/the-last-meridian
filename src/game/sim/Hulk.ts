import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig, type HulkHazard } from "../GameConfig";
import { MothershipSection, type SectionOwner } from "./MothershipSection";
import type { AvoidObstacle } from "../ShipController";

/**
 * Hulk SIM — a derelict capital-ship wreck as gameplay truth, with NO Babylon
 * scene objects (its depiction is a client-side HulkView). A placed map hazard
 * (docs/ARENA-MAPS.md slice 5): INDESTRUCTIBLE static terrain that blocks
 * weapons line-of-sight (cover) and keeps ships out, reusing a carrier's hull
 * footprint so it costs almost no new collision code.
 *
 * It's structurally a `Mothership` minus the objective role: same hull-section
 * + avoidance-circle machinery (built identically — keep the two in sync), but
 * `isAlive` is always true and `takeDamage` is a no-op, so weapons die against
 * its hull (cover) without ever destroying it. Because its sections are
 * `MothershipSection`s, Game's `instanceof MothershipSection` hit guard gives a
 * hulk hit the same light "spark, no score" treatment as a carrier hull hit.
 *
 * The footprint comes from `GameConfig.mothership.hullRects[source]` — the
 * carrier whose mesh the view also reuses — scaled by `scale`, rotated by
 * `rotationY`, and translated to (x, z). At rotationY 0/π the footprint is
 * exact (axis-aligned, like the carriers); other angles give the AABB of each
 * rotated rect (slightly generous cover). Static after construction.
 */
export class Hulk implements SectionOwner {
  /** World position on the gameplay plane (Y = the view's deck level). */
  readonly position: Vector3;
  readonly rotationY: number;
  readonly scale: number;
  /** Which carrier's hull footprint + mesh this wreck reuses. */
  readonly source: HulkHazard["source"];

  readonly hullSections: ReadonlyArray<MothershipSection>;
  readonly avoidanceCircles: ReadonlyArray<AvoidObstacle>;

  constructor(spec: HulkHazard) {
    this.source = spec.source;
    this.rotationY = spec.rotationY ?? 0;
    this.scale = spec.scale ?? 1;
    this.position = new Vector3(spec.x, GameConfig.mothership.yLevel, spec.z);

    // Hull rectangles → world-space sections, identical math to Mothership
    // (rotate the two opposite corners, take the AABB; exact at 0/π). Scaled
    // by `scale`. Keep this in lockstep with Mothership's hull build.
    const sin = Math.sin(this.rotationY);
    const cos = Math.cos(this.rotationY);
    const s = this.scale;
    this.hullSections = GameConfig.mothership.hullRects[this.source].map((rect) => {
      const hw = rect.halfWidth * s;
      const z0 = rect.z0 * s;
      const z1 = rect.z1 * s;
      const ax = spec.x + cos * -hw + sin * z0;
      const az = spec.z - sin * -hw + cos * z0;
      const bx = spec.x + cos * hw + sin * z1;
      const bz = spec.z - sin * hw + cos * z1;
      return new MothershipSection(
        this,
        Math.min(ax, bx),
        Math.max(ax, bx),
        Math.min(az, bz),
        Math.max(az, bz),
      );
    });
    this.avoidanceCircles = this.buildAvoidanceCircles();
  }

  // ─── SectionOwner: indestructible terrain ──────────────────────────────────

  get isAlive(): boolean {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  takeDamage(_amount: number, _nowMs: number): void {
    // No-op: a hulk is permanent cover. Bolts/missiles die against its hull
    // (the cover effect) but deal no damage and never destroy it.
  }

  /**
   * AI steering circles derived from the hull boxes — a copy of
   * Mothership.buildAvoidanceCircles (each box split into roughly-square slices,
   * each circumscribed by a circle). Over-covers ~40% at corners, which for
   * steering just reads as a healthy berth. `isAlive` is a literal `true` here
   * since a hulk never dies.
   */
  private buildAvoidanceCircles(): AvoidObstacle[] {
    const circles: AvoidObstacle[] = [];
    for (const sec of this.hullSections) {
      const halfX = (sec.maxX - sec.minX) / 2;
      const halfZ = (sec.maxZ - sec.minZ) / 2;
      const alongZ = halfZ >= halfX;
      const longHalf = alongZ ? halfZ : halfX;
      const shortHalf = alongZ ? halfX : halfZ;
      const n = Math.max(1, Math.ceil(longHalf / Math.max(shortHalf, 1)));
      const sliceHalf = longHalf / n;
      const radius = Math.hypot(shortHalf, sliceHalf);
      for (let i = 0; i < n; i++) {
        const t = -longHalf + sliceHalf * (2 * i + 1);
        circles.push({
          position: {
            x: sec.position.x + (alongZ ? 0 : t),
            z: sec.position.z + (alongZ ? t : 0),
          },
          radius,
          isAlive: true,
        });
      }
    }
    return circles;
  }
}
