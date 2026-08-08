import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig, type WallHazard } from "../GameConfig";
import type { DamageTarget } from "../types";
import type { AvoidObstacle } from "../ShipController";

const EPS = 1e-9;

/**
 * One capsule CHUNK of a terrain wall — a sub-segment of a wall polyline edge
 * with the wall's half-thickness as its radius. The chunk is the wall's single
 * collision currency: it satisfies every existing obstacle contract at once,
 * so the weapon and AI systems need no changes (the asteroid trick).
 *
 *  - Weapon cover (DamageTarget): indestructible — takeDamage is a no-op, a
 *    bolt/missile just dies against it. The exact silhouette comes from
 *    `surfaceRadiusToward`: a capsule is convex, so "point inside iff distance
 *    from center ≤ directional surface radius" is EXACT — the same guarantee
 *    the asteroids' ellipsoid gives the swept-segment weapon loops.
 *  - AI steering (AvoidObstacle): `radius` is the chunk's circumscribing
 *    circle. Chunks are deliberately SHORT (walls.chunkLength) so these
 *    circles hug the wall face instead of swallowing the lane beside it —
 *    long walls with one big circle would make corridors unenterable (the
 *    exact failure the trench/maze roadmap entry warns about).
 *  - Ship keep-out: `computePushOutXZ` ejects along the radial from the
 *    closest point on the CORE segment — for a capsule that IS the
 *    nearest-surface normal, so there's no long-thin-box fling problem and
 *    no HulkSection-style slab logic needed. NOTE: ships bump against the
 *    FULL-EDGE capsules (Wall.edges), never the chunks — a ship overlapping
 *    a chunk seam is inside the NEIGHBOR chunk's end-cap sphere too, and
 *    that cap's radial push has an along-wall component (a seam nudge every
 *    chunk length while wall-hugging). The capsule push-out is exact at any
 *    aspect ratio, so the un-chunked edge needs no such compromise.
 *
 * Walls never move; everything is precomputed at construction.
 */
export class WallSegment implements DamageTarget, AvoidObstacle {
  /** Chunk midpoint — DamageTarget anchor (hit FX, homing) + steering center. */
  readonly position: Vector3;
  /** Circumscribing-circle radius: broad phase for weapons, steering circle
   *  for the AI (halfLen along the axis + halfWidth cap). */
  readonly hitRadius: number;
  /** AvoidObstacle alias of hitRadius (the AI reads `radius`). */
  readonly radius: number;

  /** Core segment half-length and unit axis (ux,uz), precomputed. */
  private readonly halfLen: number;
  private readonly ux: number;
  private readonly uz: number;

  constructor(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    /** Half the wall's total thickness — the capsule radius. */
    readonly halfWidth: number,
  ) {
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    this.position = new Vector3(mx, 0, mz);
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    this.halfLen = len / 2;
    // Degenerate (zero-length) chunk collapses to a circle; axis is arbitrary.
    this.ux = len > EPS ? dx / len : 1;
    this.uz = len > EPS ? dz / len : 0;
    this.hitRadius = this.halfLen + halfWidth;
    this.radius = this.hitRadius;
  }

  get isAlive(): boolean {
    return true;
  }

  takeDamage(): void {
    /* indestructible terrain — bolts and missiles die against it (cover) */
  }

  /**
   * Exact capsule directional radius: distance from the chunk center along
   * world direction (dirX,dirZ) to where that ray exits the capsule. Convex +
   * centered, so the weapon loops' "distance ≤ surfaceRadiusToward(offset)"
   * test resolves the true silhouette (see LaserSystem's obstacle pass).
   */
  surfaceRadiusToward(dirX: number, dirZ: number): number {
    const len = Math.hypot(dirX, dirZ);
    if (len < EPS) return this.halfWidth;
    // Decompose the unit ray into axial (a) / perpendicular (c) components
    // in the capsule's frame; both signs fold by symmetry.
    const a = Math.abs((dirX * this.ux + dirZ * this.uz) / len);
    const c = Math.abs((dirX * -this.uz + dirZ * this.ux) / len);
    // Exit through the flat side: perpendicular reach hits halfWidth while
    // still within the core span.
    if (c > EPS) {
      const tSide = this.halfWidth / c;
      if (tSide * a <= this.halfLen) return tSide;
    }
    // Exit through an end cap: |t·(a,c) − (halfLen, 0)| = halfWidth, the
    // positive root of t² − 2·a·halfLen·t + halfLen² − halfWidth² = 0.
    const disc = this.halfWidth * this.halfWidth - this.halfLen * this.halfLen * c * c;
    return a * this.halfLen + Math.sqrt(Math.max(0, disc));
  }

  /**
   * Ship keep-out: if the point (px,pz) with `radius` overlaps the capsule,
   * write the outward unit normal + separation distance into `out` and return
   * true. The normal is the radial from the closest core-segment point — the
   * true nearest-surface direction for a capsule everywhere (flank AND caps).
   */
  computePushOutXZ(
    px: number,
    pz: number,
    radius: number,
    out: { nx: number; nz: number; dist: number },
  ): boolean {
    // Closest point on the core segment: project onto the axis, clamp.
    const rx = px - this.position.x;
    const rz = pz - this.position.z;
    const t = Math.min(this.halfLen, Math.max(-this.halfLen, rx * this.ux + rz * this.uz));
    const cx = this.position.x + this.ux * t;
    const cz = this.position.z + this.uz * t;
    let dx = px - cx;
    let dz = pz - cz;
    let d = Math.hypot(dx, dz);
    const clearance = this.halfWidth + radius;
    if (d >= clearance) return false;
    if (d < EPS) {
      // Dead-center on the core: eject perpendicular to the wall axis.
      dx = -this.uz;
      dz = this.ux;
      d = 1;
    }
    out.nx = dx / d;
    out.nz = dz / d;
    out.dist = clearance - Math.min(d, clearance);
    return true;
  }
}

/**
 * A terrain wall: one WallHazard polyline expanded into collision shapes.
 * Static by construction — no update tick. Two granularities from one spec:
 * `segments` (short chunks) feed the weapon/AI obstacle lists, `edges`
 * (full polyline edges) feed the ship keep-out
 * (BattleSim.bumpShipOutOfWallSegment, shared with solo + prediction) —
 * see the WallSegment doc for why bump must not use the chunks. The VIEW
 * (client WallView) builds its ridge mesh from the same `spec`, so the
 * visible face and the collider can never desync.
 */
export class Wall {
  /** Short capsule chunks — weapon cover + AI steering circles. */
  readonly segments: WallSegment[] = [];
  /** Full-edge capsules — ship keep-out (seam-free wall sliding). */
  readonly edges: WallSegment[] = [];
  /** Resolved total thickness (spec.width or the config default). */
  readonly width: number;
  /** Resolved view height (spec.height or the config default). */
  readonly height: number;

  constructor(readonly spec: WallHazard) {
    const cfg = GameConfig.walls;
    this.width = spec.width ?? cfg.width;
    this.height = spec.height ?? cfg.height;
    const halfWidth = this.width / 2;
    const pts = spec.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < EPS) continue;
      this.edges.push(new WallSegment(a.x, a.z, b.x, b.z, halfWidth));
      // Subdivide the edge into equal chunks no longer than chunkLength —
      // the granularity that keeps AI steering circles wall-hugging.
      const n = Math.max(1, Math.ceil(len / cfg.chunkLength));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        this.segments.push(
          new WallSegment(
            a.x + (b.x - a.x) * t0,
            a.z + (b.z - a.z) * t0,
            a.x + (b.x - a.x) * t1,
            a.z + (b.z - a.z) * t1,
            halfWidth,
          ),
        );
      }
    }
  }
}
