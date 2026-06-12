import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Ship } from "./sim/Ship";

/**
 * Single laser bolt. Owned and updated by LaserSystem — do not construct
 * directly from outside.
 */
export class Laser {
  ageMs = 0;

  /**
   * The bolt is spawned and then advanced in the SAME tick. At laser speed a
   * single frame's travel (~1.6 units) is nearly a ship length, so without this
   * the first frame a bolt renders it's already well ahead of the muzzle. We
   * skip the first update so the bolt renders once at the muzzle, then moves.
   */
  private bornThisFrame = true;

  constructor(
    readonly mesh: Mesh,
    readonly velocity: Vector3,
    readonly lifetimeMs: number,
    rotationY: number,
    /**
     * The ship that fired this bolt (null = unattributed). Carried as a SHIP
     * reference, not a "was it the player" boolean, so attribution stays
     * correct with any number of human pilots (multiplayer-ready): kill
     * credit goes to the shooter, and "give the local player the landed-hit
     * jolt" is derived at the edge by comparing against the local ship.
     */
    readonly shooter: Ship | null = null,
    /**
     * Damage this bolt deals on impact. Carried per-bolt because one faction
     * system serves mixed ship types (a Breaker's bolts hit harder than a
     * Spitfire's on the same LaserSystem).
     */
    readonly damage: number = 0,
  ) {
    mesh.rotation.y = rotationY;
  }

  update(deltaSeconds: number, deltaMs: number): void {
    if (this.bornThisFrame) {
      // Render once at the muzzle this frame; start moving next frame.
      this.bornThisFrame = false;
      return;
    }
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
