import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { DamageTarget } from "../types";
import type { AvoidObstacle } from "../ShipController";
import type { Hulk } from "./Hulk";

const EPS = 1e-4;

/** Result of a HulkSection planar push-out: outward unit direction on the
 *  gameplay (y=0) plane + the distance to move along it. Callers pass one in
 *  as an out-param so the per-frame keep-out pass allocates nothing. */
export interface PlanarPushOut {
  nx: number;
  nz: number;
  dist: number;
}

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
 * Weapon cover resolves through `surfaceRadiusToward` (the same directional-
 * radius hook asteroids use, so the weapon systems need no changes): it casts a
 * ray from the box centre into the rotated box and returns the exit distance.
 * Because gameplay is on the y=0 plane, a sideways ray exits the box's THIN
 * (vertical) face when the hull has rolled edge-on, so the cover thins with
 * the roll — matching the visible silhouette (cf. Asteroid's y=0 cross-
 * section). The SHIP keep-out resolves through `computePushOutXZ` instead —
 * nearest-face ejection, NOT a centre-ray push (see its doc for why). The
 * box's world pose is refreshed each tick from the hulk's basis.
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

  /**
   * Nearest-face planar ejection for the SHIP keep-out. Treats the ship as a
   * point with `radius` folded into the box's half-extents (rounded-box
   * approximation) and the gameplay plane as passing through the box centre
   * (the same slice `surfaceRadiusToward` uses, so keep-out still thins as the
   * hull rolls edge-on). If the point is inside the expanded box, writes the
   * cheapest in-plane escape into `out` — the local axis whose slab costs the
   * least PLANAR distance to clear — and returns true.
   *
   * Why not eject along the centre→ship ray like the asteroid bump? These
   * boxes are up to ~7× longer than wide, so near the bow/stern that ray runs
   * almost parallel to the hull: a grazing ship's tiny perpendicular
   * penetration resolves as a push several times larger, pointed ALONG the
   * hull — the "ship suddenly flung sideways off the wreck" bug.
   *
   * A near-vertical local axis can't be cleared by a planar push (in-plane
   * component ~0) and is skipped; the basis is orthonormal, so at most one
   * axis is near-vertical at a time and an escape always exists.
   */
  computePushOutXZ(px: number, pz: number, radius: number, out: PlanarPushOut): boolean {
    const dx = px - this.position.x;
    const dz = pz - this.position.z;
    const { ex, ey, ez } = this.hulk;
    // Planar offset in hull-local coords = dot with each local axis' world dir.
    const lx = ex.x * dx + ex.z * dz;
    const ly = ey.x * dx + ey.z * dz;
    const lz = ez.x * dx + ez.z * dz;
    // Penetration vs the radius-expanded box, per local slab. Outside any slab
    // → no overlap.
    const penX = this.hx + radius - Math.abs(lx);
    if (penX <= 0) return false;
    const penY = this.hy + radius - Math.abs(ly);
    if (penY <= 0) return false;
    const penZ = this.hz + radius - Math.abs(lz);
    if (penZ <= 0) return false;

    let best = Infinity;
    best = this.considerEscapeAxis(ex, penX, lx, best, out);
    best = this.considerEscapeAxis(ey, penY, ly, best, out);
    best = this.considerEscapeAxis(ez, penZ, lz, best, out);
    if (!Number.isFinite(best)) return false; // unreachable: orthonormal basis
    out.dist = best;
    return true;
  }

  /** Consider one local axis as the escape direction: clearing its slab by a
   *  planar push costs pen / |axis in-plane component|. When it beats `best`,
   *  write the outward planar unit direction into `out`; return the winning
   *  cost either way. */
  private considerEscapeAxis(
    axis: { x: number; z: number },
    pen: number,
    l: number,
    best: number,
    out: PlanarPushOut,
  ): number {
    const g = Math.hypot(axis.x, axis.z);
    if (g < EPS) return best; // near-vertical axis: planar push can't clear it
    const cost = pen / g;
    if (cost >= best) return best;
    const sign = l >= 0 ? 1 : -1;
    out.nx = (sign * axis.x) / g;
    out.nz = (sign * axis.z) / g;
    return cost;
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
