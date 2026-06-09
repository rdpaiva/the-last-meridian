import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Single laser bolt. Owned and updated by LaserSystem — do not construct
 * directly from outside.
 */
export class Laser {
  ageMs = 0;

  constructor(
    readonly mesh: Mesh,
    readonly velocity: Vector3,
    readonly lifetimeMs: number,
    rotationY: number,
    /**
     * True if the human pilot's own ship fired this bolt (as opposed to an AI
     * wingman sharing the same faction system). Lets the hit feedback give the
     * heavy "you landed a hit" jolt only for the player, not every wingman shot.
     */
    readonly fromPlayer: boolean = false,
  ) {
    mesh.rotation.y = rotationY;
  }

  update(deltaSeconds: number, deltaMs: number): void {
    this.mesh.position.x += this.velocity.x * deltaSeconds;
    this.mesh.position.z += this.velocity.z * deltaSeconds;
    this.ageMs += deltaMs;
  }

  get isExpired(): boolean {
    return this.ageMs >= this.lifetimeMs;
  }

  /**
   * Force-expire a laser, e.g. when it hits a target. The next LaserSystem
   * sweep will see isExpired === true and dispose the mesh.
   */
  kill(): void {
    this.ageMs = this.lifetimeMs + 1;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
