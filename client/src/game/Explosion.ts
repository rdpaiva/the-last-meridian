import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Single short-lived explosion: one bright "flash" (a billboarded flare
 * plane carrying the soft radial sprite — see ExplosionSystem.createFlare)
 * plus N debris pieces that fly outward and shrink. ExplosionSystem owns
 * the materials and creates these in `spawn()`/`spawnSpark()`. A ship
 * BREAKUP (spawnShipBreakup) is a flash-less instance whose debris are
 * clones of the dead ship's own hull meshes.
 *
 * Visual evolution over `durationMs`:
 *   - Flash flare (when present): scales up rapidly to `flashPeakScale`,
 *     then collapses.
 *   - Debris: each piece flies along its initial outward velocity while
 *     scaling linearly toward zero (after an optional full-size hold —
 *     `shrinkHold`). No alpha fade — sharing one material across all
 *     explosions means per-explosion alpha is impossible without
 *     allocating per-explosion materials, which we deliberately avoid.
 */
export type Debris = {
  mesh: Mesh;
  velocity: Vector3;
  rotationVel: Vector3;
  /**
   * The piece's spawn-time scaling, when it isn't 1: breakup clones bake
   * their world transform (model corrections, the glTF mirror) into
   * `scaling`, so the shrink must MULTIPLY this rather than overwrite it.
   * Absent = the plain unit-scale debris cubes/slivers.
   */
  baseScaling?: Vector3;
};

export class Explosion {
  ageMs = 0;

  constructor(
    readonly flash: Mesh | null,
    readonly debris: Debris[],
    readonly durationMs: number,
    readonly flashPeakScale: number,
    /** Fraction of the lifetime debris holds full size before shrinking. */
    readonly shrinkHold = 0,
  ) {}

  update(deltaSeconds: number, deltaMs: number): void {
    this.ageMs += deltaMs;
    if (this.isExpired) return;

    const t = this.ageMs / this.durationMs; // 0..1

    // Flash: ease up to peak then back down. peakAt ~0.25 of duration.
    if (this.flash) {
      const peakAt = 0.25;
      let flashScale: number;
      if (t < peakAt) {
        flashScale = (t / peakAt) * this.flashPeakScale;
      } else {
        flashScale =
          this.flashPeakScale * Math.max(0, 1 - (t - peakAt) / (1 - peakAt));
      }
      this.flash.scaling.set(flashScale, flashScale, flashScale);
    }

    // Debris: linear outward drift + spin, shrinking toward zero after the
    // (usually zero-length) full-size hold.
    const shrink =
      t <= this.shrinkHold
        ? 1
        : 1 - (t - this.shrinkHold) / (1 - this.shrinkHold);
    for (const d of this.debris) {
      d.mesh.position.x += d.velocity.x * deltaSeconds;
      d.mesh.position.y += d.velocity.y * deltaSeconds;
      d.mesh.position.z += d.velocity.z * deltaSeconds;
      d.mesh.rotation.x += d.rotationVel.x * deltaSeconds;
      d.mesh.rotation.y += d.rotationVel.y * deltaSeconds;
      d.mesh.rotation.z += d.rotationVel.z * deltaSeconds;
      if (d.baseScaling) {
        d.mesh.scaling.set(
          d.baseScaling.x * shrink,
          d.baseScaling.y * shrink,
          d.baseScaling.z * shrink,
        );
      } else {
        d.mesh.scaling.set(shrink, shrink, shrink);
      }
    }
  }

  get isExpired(): boolean {
    return this.ageMs >= this.durationMs;
  }

  dispose(): void {
    this.flash?.dispose();
    for (const d of this.debris) {
      d.mesh.dispose();
    }
  }
}
