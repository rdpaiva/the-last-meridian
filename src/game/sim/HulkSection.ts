import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { DamageTarget } from "../types";
import type { AvoidObstacle } from "../ShipController";
import type { Hulk } from "./Hulk";

const EPS = 1e-4;

/**
 * One ORIENTED hull box of a derelict wreck — the rectangle-based collider that
 * replaced the wreck's coarse circle cluster (circles either left hull corners
 * intangible or added phantom cover beside the hull; the carriers proved that a
 * stack of rectangles from `GameConfig.mothership.hullRects` fits far better).
 * One section per hullRect, mirroring MothershipSection — but a wreck ROTATES
 * (yaw + pitch + roll), so this box is an OBB that tracks the hull's full
 * orientation instead of a static world-aligned rectangle.
 *
 * It satisfies BOTH the weapon-obstacle shape (DamageTarget) and the AI
 * `AvoidObstacle` shape with one object, like the old HulkCircle. `takeDamage`
 * is a no-op — the wreck is indestructible, so a bolt just dies against it.
 *
 * Cover/keep-out resolve through `surfaceRadiusToward` (the same directional-
 * radius hook asteroids use, so the weapon systems need no changes): it casts a
 * ray from the box centre into the rotated box and returns the exit distance.
 * Because gameplay is on the y=0 plane, a sideways ray exits the box's THIN
 * (vertical) face when the hull has rolled edge-on, so the cover/keep-out thins
 * with the roll — matching the visible silhouette (cf. Asteroid's y=0 cross-
 * section). The box's world pose is refreshed each tick from the hulk's basis.
 */
export class HulkSection implements DamageTarget, AvoidObstacle {
  /** World box centre — DamageTarget anchor (hit FX, homing) + AvoidObstacle pos. */
  readonly position = new Vector3();
  /** Broad-phase bounding-sphere radius (circumscribes the box in ANY
   *  orientation), so the cheap pre-test in the weapon loops never misses. */
  readonly hitRadius: number;
  /** AI avoidance circle: max planar extent. Constant (ignores roll) so steering
   *  errs to a wide berth — over-cover is harmless for steering, a bolt dying in
   *  phantom space is not (same split MothershipSection documents). */
  readonly radius: number;

  constructor(
    private readonly hulk: Hulk,
    /** Local half-extents (already scaled): beam X, vertical Y, keel Z. */
    private readonly hx: number,
    private readonly hy: number,
    private readonly hz: number,
    /** Box centre in hull-local space (already scaled): cx beam, cy vertical,
     *  cz along keel. Off-centre boxes (cx≠0) let a stack of sections hug a
     *  concave hull — e.g. one box per prong of the Aegis trident. */
    private readonly cx: number,
    private readonly cy: number,
    private readonly cz: number,
  ) {
    this.hitRadius = Math.hypot(hx, hy, hz);
    this.radius = Math.hypot(hx, hz);
    this.refresh();
  }

  get isAlive(): boolean {
    return true;
  }

  takeDamage(): void {
    /* indestructible wreck — bolts die against it (cover), no effect */
  }

  /** Refresh the world centre from the hulk's current basis + centre. Called by
   *  Hulk.recompute each tick (the box rides the wreck's rotation). */
  refresh(): void {
    const { ex, ey, ez, center } = this.hulk;
    const { cx, cy, cz } = this;
    this.position.x = center.x + ex.x * cx + ey.x * cy + ez.x * cz;
    this.position.y = center.y + ex.y * cx + ey.y * cy + ez.y * cz;
    this.position.z = center.z + ex.z * cx + ey.z * cy + ez.z * cz;
  }

  /** Oriented-box surface radius along world direction (dirX,dirZ): the distance
   *  from the box centre to where that in-plane ray exits the rotated box. */
  surfaceRadiusToward(dirX: number, dirZ: number): number {
    const len = Math.hypot(dirX, dirZ);
    if (len < EPS) return Math.min(this.hx, this.hy, this.hz);
    const nx = dirX / len;
    const nz = dirZ / len;
    const { ex, ey, ez } = this.hulk;
    // World dir (y=0) → local components = dot with each local axis' world dir.
    const lx = ex.x * nx + ex.z * nz;
    const ly = ey.x * nx + ey.z * nz;
    const lz = ez.x * nx + ez.z * nz;
    return Math.min(
      this.hx / Math.max(Math.abs(lx), EPS),
      this.hy / Math.max(Math.abs(ly), EPS),
      this.hz / Math.max(Math.abs(lz), EPS),
    );
  }
}
