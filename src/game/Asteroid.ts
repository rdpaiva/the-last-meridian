import type { Scene } from "@babylonjs/core/scene";
import type { Material } from "@babylonjs/core/Materials/material";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
// Registers MeshBuilder.CreateIcoSphere (the rock body).
import "@babylonjs/core/Meshes/Builders/icoSphereBuilder";

import { GameConfig } from "./GameConfig";
// SIM-affecting randomness (tumble spin, starting orientation, ellipsoid
// squash — all feed the collision silhouette) draws from the seeded SIM RNG.
// The PURELY COSMETIC randomness below (surface noise lobes, crater
// sculpting, face tint) deliberately stays on Math.random(): it never touches
// the sim, and keeping it off the seeded stream means later view/sim splits
// can't shift a seeded battle. See src/game/sim/SimRng.ts for the rule.
import { simRandom } from "./sim/SimRng";
import type { DamageTarget } from "./types";

/**
 * A single drifting, tumbling, destructible rock. Owned and updated by
 * AsteroidField — do not construct directly from gameplay code.
 *
 * Implements DamageTarget so the weapon systems can damage it. It serves two
 * roles at once:
 *   - **Cover**: registered with both LaserSystems + the MissileSystem as an
 *     obstacle. Because collision is a per-frame point test along a bolt's
 *     path, a bolt entering this rock's circle is consumed here BEFORE it can
 *     reach a ship behind it — that's the line-of-sight blocking.
 *   - **Hazard**: Game's ship↔asteroid pass hard-bumps any ship that overlaps
 *     `radius` and deals ram damage.
 *
 * Collision is a flat X/Z circle (`radius`) like every other hit test in the
 * game — Y is ignored since play is on one plane. The visual mesh is larger
 * than `radius` (collisionScale < 1) so clipping the jagged edge reads fair.
 */
export class Asteroid implements DamageTarget {
  readonly position: Vector3;
  /** Constant drift (units/sec) on the X/Z plane. */
  readonly drift: Vector3;
  /** Per-axis tumble (rad/sec). */
  private readonly spin: Vector3;

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

  /** Ellipsoid squash factors picked by buildMesh (axis z stays at 1). */
  private squashX = 1;
  private squashY = 1;
  /** Scratch for refreshCollisionShape (avoids per-frame Matrix allocation). */
  private readonly rotMatrix = new Matrix();
  /**
   * Quadratic form of the rock's TOP-DOWN SILHOUETTE — the shadow its tumbling
   * ellipsoid casts on the X/Z plane (a 2D ellipse: d·M·d, with M00/M01/M11
   * its coefficients). Refreshed whenever mesh.rotation changes. This is the
   * shape collision must use in a top-down game: the y=0 cross-section is
   * narrower than what the camera shows whenever the rock's bulk is tilted
   * out of the plane, and colliding against it lets ships visibly overlap a
   * rock without registering a hit.
   */
  private projM00 = 1;
  private projM01 = 0;
  private projM11 = 1;

  readonly maxHp: number;
  hp: number;

  /**
   * Set by AsteroidField once it has spawned this rock's shatter (explosion +
   * child chunks), so the field's death sweep doesn't re-fire it every frame.
   */
  shattered = false;

  private readonly mesh: Mesh;

  constructor(
    scene: Scene,
    material: Material,
    opts: {
      position: Vector3;
      drift: Vector3;
      /** Visual radius; collision radius is derived via collisionScale. */
      visualRadius: number;
      /**
       * Per-axis tumble (rad/sec) override. When omitted, an ambient field
       * spin in [spinRateMin, spinRateMax] is rolled. Shatter chunks pass a
       * violent spin here so fresh debris tumbles from the blast.
       */
      spin?: Vector3;
    },
  ) {
    const cfg = GameConfig.asteroids;
    this.position = opts.position;
    this.drift = opts.drift;
    this.visualRadius = opts.visualRadius;
    this.radius = opts.visualRadius * cfg.collisionScale;
    this.hitRadius = this.radius;
    this.maxHp = Math.max(1, Math.round(opts.visualRadius * cfg.hpPerRadius));
    this.hp = this.maxHp;

    this.spin =
      opts.spin ??
      new Vector3(
        Asteroid.signedRange(cfg.spinRateMin, cfg.spinRateMax),
        Asteroid.signedRange(cfg.spinRateMin, cfg.spinRateMax),
        Asteroid.signedRange(cfg.spinRateMin, cfg.spinRateMax),
      );

    this.mesh = this.buildMesh(scene, opts.visualRadius);
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.mesh.position.copyFrom(this.position);
    // Random starting orientation so identical chunks don't read as clones.
    // Sim RNG: the orientation phases the tumbling collision silhouette.
    this.mesh.rotation.set(
      simRandom() * Math.PI * 2,
      simRandom() * Math.PI * 2,
      simRandom() * Math.PI * 2,
    );
    this.refreshCollisionShape();
  }

  // ---------- DamageTarget ----------

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, _nowMs: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) this.mesh.setEnabled(false);
  }

  /**
   * Collision radius along a world X/Z direction from the rock's center —
   * the DamageTarget directional refinement. Returns the radial extent of the
   * rock's TOP-DOWN SILHOUETTE (the shadow of its squashed, tumbling
   * ellipsoid — see projM* / refreshCollisionShape) along that direction,
   * scaled by collisionScale (which forgives the noise lobes and crater dents
   * the ellipsoid doesn't model). Matching the silhouette the player actually
   * sees is the point: the on-plane cross-section gives phantom misses (ship
   * visibly inside the rock, no hit) and the old max-extent circle gave
   * phantom hits (bumped by empty space).
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
    this.mesh.position.copyFrom(this.position);
    this.mesh.rotation.x += this.spin.x * deltaSeconds;
    this.mesh.rotation.y += this.spin.y * deltaSeconds;
    this.mesh.rotation.z += this.spin.z * deltaSeconds;
    this.refreshCollisionShape();
  }

  /**
   * Rebuild the top-down silhouette ellipse (projM*) from the mesh's Euler
   * rotation. Must use the same yaw-pitch-roll composition Babylon's
   * computeWorldMatrix uses, or the collision shape would spin out of phase
   * with the rendered rock.
   *
   * Math: the ellipsoid (semi-axes ax/ay/az, rotation R) is the set
   * pᵀQp ≤ 1 with Q = R·diag(1/ax²,1/ay²,1/az²)·Rᵀ in world space. Its shadow
   * on the X/Z plane ("does any y make this (x,z) inside?") eliminates y by
   * minimizing the quadratic over it — the Schur complement of Q's yy entry:
   *   M = Q_xz − q_y·q_yᵀ/Q_yy.
   * Verified against brute-force projection sampling to ~1e-16.
   */
  private refreshCollisionShape(): void {
    Matrix.RotationYawPitchRollToRef(
      this.mesh.rotation.y,
      this.mesh.rotation.x,
      this.mesh.rotation.z,
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

  dispose(): void {
    this.mesh.dispose();
  }

  // ---------- Mesh ----------

  /**
   * Builds a faceted low-poly rock: an icosphere squashed into an ellipsoid,
   * dented with craters, vertices pushed in/out along their radius, then
   * flat-shaded for the chunky look with per-face tonal variation.
   *
   * The displacement is a SMOOTH function of each vertex's DIRECTION (a sum of
   * a few low-frequency lobes with per-rock random phases), so neighbouring
   * vertices move almost together — a lumpy-but-watertight potato. An earlier
   * version jittered each vertex independently, which tore adjacent faces apart
   * and let you see through the notches to the backfaces (it looked hollow).
   *
   * Craters are smooth inward dents: each picks a random surface direction,
   * angular footprint, and depth; verts inside the footprint sink along their
   * radius with a cosine falloff (deepest at center, flush at the rim).
   */
  private buildMesh(scene: Scene, radius: number): Mesh {
    const cfg = GameConfig.asteroids;
    const mesh = MeshBuilder.CreateIcoSphere(
      "asteroid",
      { radius, subdivisions: cfg.meshDetail },
      scene,
    );

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      // Per-rock random noise basis so no two rocks share a silhouette.
      const p1 = Math.random() * Math.PI * 2;
      const p2 = Math.random() * Math.PI * 2;
      const p3 = Math.random() * Math.PI * 2;
      const f1 = 1.5 + Math.random() * 1.5;
      const f2 = 2.0 + Math.random() * 2.0;
      const f3 = 3.0 + Math.random() * 2.0;

      // Ellipsoid squash: two axes shrink, one stays at 1 so visualRadius is
      // still the true max extent (the tumble randomizes which way it points).
      // Stored on the rock — surfaceRadiusToward rebuilds this ellipsoid for
      // direction-accurate collision.
      // Sim RNG: squash factors define the collision ellipsoid
      // (surfaceRadiusToward), not just the visual.
      const sx = (this.squashX =
        cfg.squashMin + simRandom() * (1 - cfg.squashMin));
      const sy = (this.squashY =
        cfg.squashMin + simRandom() * (1 - cfg.squashMin));

      // Crater set: random surface direction + footprint + depth per crater.
      const craterCount =
        cfg.craterCountMin +
        Math.floor(Math.random() * (cfg.craterCountMax - cfg.craterCountMin + 1));
      const craters: { x: number; y: number; z: number; r: number; depth: number }[] = [];
      for (let c = 0; c < craterCount; c++) {
        // Uniform random direction on the unit sphere.
        const theta = Math.random() * Math.PI * 2;
        const cz = Math.random() * 2 - 1;
        const cs = Math.sqrt(1 - cz * cz);
        craters.push({
          x: cs * Math.cos(theta),
          y: cs * Math.sin(theta),
          z: cz,
          r: cfg.craterRadiusMin + Math.random() * (cfg.craterRadiusMax - cfg.craterRadiusMin),
          depth: radius * cfg.craterDepth * (0.6 + Math.random() * 0.8),
        });
      }

      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        const len = Math.hypot(x, y, z) || 1;
        const ux = x / len;
        const uy = y / len;
        const uz = z / len;
        // Smooth lobes in ~[-1, 1] — coherent across neighbouring verts.
        let n = Math.sin(ux * f1 + p1) * Math.cos(uy * f1 + p2);
        n += 0.5 * Math.sin(uy * f2 + p2) * Math.cos(uz * f2 + p3);
        n += 0.35 * Math.sin(uz * f3 + p3) * Math.cos(ux * f3 + p1);
        n /= 1.85;
        let scale = 1 + n * cfg.lumpiness;
        // Crater dents: sink verts inside each footprint, cosine falloff.
        for (const crater of craters) {
          const dot = ux * crater.x + uy * crater.y + uz * crater.z;
          const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
          if (angle < crater.r) {
            const falloff = 0.5 + 0.5 * Math.cos((Math.PI * angle) / crater.r);
            scale -= (crater.depth * falloff) / len;
          }
        }
        positions[i] = x * scale * sx;
        positions[i + 1] = y * scale * sy;
        positions[i + 2] = z * scale;
      }
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    }
    // Flat shading: duplicates verts + recomputes per-face normals → faceted.
    mesh.convertToFlatShadedMesh();

    // Per-face mineral tint: after flat shading every face owns 3 consecutive
    // verts, so a shared random darkening per triple reads as rock patchiness
    // (StandardMaterial multiplies vertex color into the diffuse).
    if (cfg.faceTintJitter > 0) {
      const flat = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (flat) {
        const vertCount = flat.length / 3;
        const colors = new Float32Array(vertCount * 4);
        for (let v = 0; v < vertCount; v += 3) {
          const tint = 1 - Math.random() * cfg.faceTintJitter;
          for (let k = 0; k < 3 && v + k < vertCount; k++) {
            const o = (v + k) * 4;
            colors[o] = tint;
            colors[o + 1] = tint;
            colors[o + 2] = tint;
            colors[o + 3] = 1;
          }
        }
        mesh.setVerticesData(VertexBuffer.ColorKind, colors);
      }
    }
    return mesh;
  }

  /** A value in [min, max] with a random sign — for symmetric drift/spin (sim RNG). */
  private static signedRange(min: number, max: number): number {
    const mag = min + simRandom() * (max - min);
    return simRandom() < 0.5 ? -mag : mag;
  }
}
