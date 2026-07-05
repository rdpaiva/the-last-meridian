import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
// SIM-affecting randomness (tumble spin, starting orientation, ellipsoid
// squash — all feed the collision silhouette) draws from the seeded SIM RNG.
// The PURELY COSMETIC randomness (surface noise lobes, crater sculpting, face
// tint) lives in the VIEW (client/game/view/AsteroidView) on Math.random(): it
// never touches the sim, and keeping it off the seeded stream means the
// sim/view split can't shift a seeded battle. See sim/SimRng.ts for the rule.
import { simRandom } from "./SimRng";
import type { DamageTarget } from "../types";

/**
 * A single drifting, tumbling, destructible rock — the SIM half (Ship/ShipView
 * pattern). Scene-free: holds position, drift, tumble, the collision silhouette,
 * and HP. The view (AsteroidView) builds the faceted mesh and reads `rotation` +
 * `squashX/squashY` each frame so the rendered rock matches this collision shape.
 * Owned and updated by AsteroidFieldSim — do not construct directly.
 *
 * Implements DamageTarget so the weapon systems can damage it. It serves two
 * roles at once:
 *   - **Cover**: registered with both LaserSystems + the MissileSystem as an
 *     obstacle. Because collision is a per-frame point test along a bolt's
 *     path, a bolt entering this rock's circle is consumed BEFORE it can reach
 *     a ship behind it — that's the line-of-sight blocking.
 *   - **Hazard**: the ship↔asteroid pass hard-bumps any ship that overlaps
 *     `radius` and deals ram damage.
 *
 * Collision is a flat X/Z circle (`radius`) like every other hit test in the
 * game — Y is ignored since play is on one plane. The visual mesh is larger
 * than `radius` (collisionScale < 1) so clipping the jagged edge reads fair.
 */
export class AsteroidSim implements DamageTarget {
  readonly position: Vector3;
  /** Constant drift (units/sec) on the X/Z plane. */
  readonly drift: Vector3;
  /** Per-axis tumble (rad/sec). Public (like `drift`) so the server can
   *  replicate a rock's full spawn state to networked clients. */
  readonly spin: Vector3;

  /** Visual radius (mesh max extent — the unsquashed axis). */
  readonly visualRadius: number;
  /**
   * CONSERVATIVE flat X/Z collision radius (max extent × collisionScale).
   * Collision proper uses `surfaceRadiusToward` — the rock's true squashed,
   * tumbling silhouette along a direction — with this as the cheap broad-phase
   * bound. AI avoidance steers by this (stable under tumble, errs safe).
   */
  readonly radius: number;
  /** DamageTarget alias for `radius` (fallback when callers ignore direction). */
  readonly hitRadius: number;

  /**
   * Euler tumble orientation (rad). Was `mesh.rotation` before the sim/view
   * split — now sim state the view copies onto the mesh each frame, so the
   * rendered rock and the collision silhouette never drift out of phase.
   */
  readonly rotation = new Vector3();

  /** Ellipsoid squash factors (axis z stays at 1); the view squashes its mesh
   *  by these so the rendered rock matches the collision ellipsoid. */
  readonly squashX: number;
  readonly squashY: number;

  /** Scratch for refreshCollisionShape (avoids per-frame Matrix allocation). */
  private readonly rotMatrix = new Matrix();
  /**
   * Quadratic form of the rock's TOP-DOWN SILHOUETTE — the shadow its tumbling
   * ellipsoid casts on the X/Z plane (a 2D ellipse: d·M·d, with M00/M01/M11
   * its coefficients). Refreshed whenever `rotation` changes. This is the shape
   * collision must use in a top-down game: the y=0 cross-section is narrower
   * than what the camera shows whenever the rock's bulk is tilted out of the
   * plane, and colliding against it lets ships visibly overlap a rock without
   * registering a hit.
   */
  private projM00 = 1;
  private projM01 = 0;
  private projM11 = 1;

  readonly maxHp: number;
  hp: number;

  /**
   * Set by AsteroidFieldSim once it has spawned this rock's shatter (explosion
   * event + child chunks), so the field's death sweep doesn't re-fire it.
   */
  shattered = false;

  constructor(opts: {
    position: Vector3;
    drift: Vector3;
    /** Visual radius; collision radius is derived via collisionScale. */
    visualRadius: number;
    /**
     * Per-axis tumble (rad/sec) override. When omitted, an ambient field spin
     * in [spinRateMin, spinRateMax] is rolled. Shatter chunks pass a violent
     * spin here so fresh debris tumbles from the blast.
     */
    spin?: Vector3;
    /**
     * Full-state reconstruction overrides (networked client): rebuild a rock
     * from its REPLICATED spawn state without touching the seeded RNG. The
     * server/headless path never passes these — its draws stay untouched.
     */
    squash?: { x: number; y: number };
    orientation?: { x: number; y: number; z: number };
  }) {
    const cfg = GameConfig.asteroids;
    this.position = opts.position;
    this.drift = opts.drift;
    this.visualRadius = opts.visualRadius;
    this.radius = opts.visualRadius * cfg.collisionScale;
    this.hitRadius = this.radius;
    this.maxHp = Math.max(1, Math.round(opts.visualRadius * cfg.hpPerRadius));
    this.hp = this.maxHp;

    // SIM RNG DRAW ORDER (must match the pre-split Asteroid constructor exactly,
    // or seeded battles shift): spin (6 draws, only when no override) → squashX
    // → squashY → orientation x/y/z. The view's cosmetic Math.random() draws
    // (lobes/craters/tint) sit on a separate stream and don't affect this.
    this.spin =
      opts.spin ??
      new Vector3(
        AsteroidSim.signedRange(cfg.spinRateMin, cfg.spinRateMax),
        AsteroidSim.signedRange(cfg.spinRateMin, cfg.spinRateMax),
        AsteroidSim.signedRange(cfg.spinRateMin, cfg.spinRateMax),
      );

    // Ellipsoid squash: two axes shrink, one stays at 1 so visualRadius is
    // still the true max extent (the tumble randomizes which way it points).
    if (opts.squash) {
      this.squashX = opts.squash.x;
      this.squashY = opts.squash.y;
    } else {
      this.squashX = cfg.squashMin + simRandom() * (1 - cfg.squashMin);
      this.squashY = cfg.squashMin + simRandom() * (1 - cfg.squashMin);
    }

    // Random starting orientation so identical chunks don't read as clones —
    // it also phases the tumbling collision silhouette.
    if (opts.orientation) {
      this.rotation.set(opts.orientation.x, opts.orientation.y, opts.orientation.z);
    } else {
      this.rotation.set(
        simRandom() * Math.PI * 2,
        simRandom() * Math.PI * 2,
        simRandom() * Math.PI * 2,
      );
    }
    this.refreshCollisionShape();
  }

  // ---------- DamageTarget ----------

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, _nowMs: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
  }

  /**
   * Collision radius along a world X/Z direction from the rock's center —
   * the DamageTarget directional refinement. Returns the radial extent of the
   * rock's TOP-DOWN SILHOUETTE (the shadow of its squashed, tumbling ellipsoid
   * — see projM* / refreshCollisionShape) along that direction, scaled by
   * collisionScale (which forgives the noise lobes and crater dents the
   * ellipsoid doesn't model). Matching the silhouette the player actually sees
   * is the point: the on-plane cross-section gives phantom misses (ship visibly
   * inside the rock, no hit) and the old max-extent circle gave phantom hits.
   */
  surfaceRadiusToward(dirX: number, dirZ: number): number {
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len;
    const uz = dirZ / len;
    // Radial extent of the silhouette ellipse: r(d) = 1/√(d·M·d), |d| = 1.
    const q =
      ux * ux * this.projM00 +
      2 * ux * uz * this.projM01 +
      uz * uz * this.projM11;
    return (1 / Math.sqrt(q)) * GameConfig.asteroids.collisionScale;
  }

  // ---------- Simulation ----------

  /** Advance drift + tumble. Position is integrated frame-rate-independently. */
  update(deltaSeconds: number): void {
    this.position.x += this.drift.x * deltaSeconds;
    this.position.z += this.drift.z * deltaSeconds;
    this.rotation.x += this.spin.x * deltaSeconds;
    this.rotation.y += this.spin.y * deltaSeconds;
    this.rotation.z += this.spin.z * deltaSeconds;
    this.refreshCollisionShape();
  }

  /**
   * Rebuild the top-down silhouette ellipse (projM*) from the Euler `rotation`.
   * Must use the same yaw-pitch-roll composition Babylon's computeWorldMatrix
   * uses, or the collision shape would spin out of phase with the rendered rock.
   *
   * Math: the ellipsoid (semi-axes ax/ay/az, rotation R) is the set pᵀQp ≤ 1
   * with Q = R·diag(1/ax²,1/ay²,1/az²)·Rᵀ in world space. Its shadow on the X/Z
   * plane ("does any y make this (x,z) inside?") eliminates y by minimizing the
   * quadratic over it — the Schur complement of Q's yy entry:
   *   M = Q_xz − q_y·q_yᵀ/Q_yy.
   * Verified against brute-force projection sampling to ~1e-16.
   */
  private refreshCollisionShape(): void {
    Matrix.RotationYawPitchRollToRef(
      this.rotation.y,
      this.rotation.x,
      this.rotation.z,
      this.rotMatrix,
    );
    // Babylon row-major m[]: world = R·local with R rows
    // (m0,m4,m8) / (m1,m5,m9) / (m2,m6,m10).
    const m = this.rotMatrix.m;
    const ax = this.visualRadius * this.squashX;
    const ay = this.visualRadius * this.squashY;
    const az = this.visualRadius;
    const d0 = 1 / (ax * ax);
    const d1 = 1 / (ay * ay);
    const d2 = 1 / (az * az);
    const qxx = d0 * m[0] * m[0] + d1 * m[4] * m[4] + d2 * m[8] * m[8];
    const qxy = d0 * m[0] * m[1] + d1 * m[4] * m[5] + d2 * m[8] * m[9];
    const qxz = d0 * m[0] * m[2] + d1 * m[4] * m[6] + d2 * m[8] * m[10];
    const qyy = d0 * m[1] * m[1] + d1 * m[5] * m[5] + d2 * m[9] * m[9];
    const qyz = d0 * m[1] * m[2] + d1 * m[5] * m[6] + d2 * m[9] * m[10];
    const qzz = d0 * m[2] * m[2] + d1 * m[6] * m[6] + d2 * m[10] * m[10];
    this.projM00 = qxx - (qxy * qxy) / qyy;
    this.projM01 = qxz - (qxy * qyz) / qyy;
    this.projM11 = qzz - (qyz * qyz) / qyy;
  }

  /** A value in [min, max] with a random sign — for symmetric spin (sim RNG). */
  private static signedRange(min: number, max: number): number {
    const mag = min + simRandom() * (max - min);
    return simRandom() < 0.5 ? -mag : mag;
  }
}
