import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Single short-lived explosion: one bright "flash" (a billboarded flare
 * plane carrying the soft radial sprite — see ExplosionSystem.createFlare)
 * plus N debris pieces that fly outward and shrink. ExplosionSystem owns
 * the materials and creates these in `spawn()`/`spawnSpark()`.
 *
 * Visual evolution over `durationMs`:
 *   - Flash flare: scales up rapidly to `flashPeakScale`, then collapses.
 *   - Debris: each piece flies along its initial outward velocity while
 *     scaling linearly toward zero. No alpha fade — sharing one material
 *     across all explosions means per-explosion alpha is impossible without
 *     allocating per-explosion materials, which we deliberately avoid.
 */
export type Debris = {
  mesh: Mesh;
  velocity: Vector3;
  rotationVel: Vector3;
};

export class Explosion {
  ageMs = 0;

  constructor(
    readonly flash: Mesh,
    readonly debris: Debris[],
    readonly durationMs: number,
    readonly flashPeakScale: number,
  ) {}

  update(deltaSeconds: number, deltaMs: number): void {
    this.ageMs += deltaMs;
    if (this.isExpired) return;

    const t = this.ageMs / this.durationMs; // 0..1

    // Flash: ease up to peak then back down. peakAt ~0.25 of duration.
    const peakAt = 0.25;
    let flashScale: number;
    if (t < peakAt) {
      flashScale = (t / peakAt) * this.flashPeakScale;
    } else {
      flashScale =
        this.flashPeakScale * Math.max(0, 1 - (t - peakAt) / (1 - peakAt));
    }
    this.flash.scaling.set(flashScale, flashScale, flashScale);

    // Debris: linear outward drift + spin, shrinking toward zero.
    const shrink = 1 - t;
    for (const d of this.debris) {
      d.mesh.position.x += d.velocity.x * deltaSeconds;
      d.mesh.position.y += d.velocity.y * deltaSeconds;
      d.mesh.position.z += d.velocity.z * deltaSeconds;
      d.mesh.rotation.x += d.rotationVel.x * deltaSeconds;
      d.mesh.rotation.y += d.rotationVel.y * deltaSeconds;
      d.mesh.rotation.z += d.rotationVel.z * deltaSeconds;
      d.mesh.scaling.set(shrink, shrink, shrink);
    }
  }

  get isExpired(): boolean {
    return this.ageMs >= this.durationMs;
  }

  dispose(): void {
    this.flash.dispose();
    for (const d of this.debris) {
      d.mesh.dispose();
    }
  }
}
