import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Ship } from "./Ship";

/**
 * Single laser bolt — SIM state only (position, heading, age, kill flag).
 * Owned and updated by LaserSystem; depicted by LaserSystemView, which pools
 * meshes and copies position/heading out of live bolts each frame
 * (the Laser/LaserSystem split, docs/MULTIPLAYER.md Phase 0).
 * Do not construct directly from outside LaserSystem.
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
    /** World-space bolt position (starts at the rear-tip-at-muzzle spawn point). */
    readonly position: Vector3,
    readonly velocity: Vector3,
    readonly lifetimeMs: number,
    /** Heading (radians) — fixed at spawn; views orient the streak with it. */
    readonly rotationY: number,
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
    /**
     * True if this bolt came from a carrier defense turret rather than a ship.
     * Pure VIEW hint (sim/collision treat it like any other bolt): the
     * LaserSystemView tints turret bolts with the dark-orange flak material so
     * the carrier's battery reads distinct from the faction fighter lasers.
     */
    readonly turret: boolean = false,
    /**
     * True if the shooter is a HEAVY craft (gunship). Pure VIEW hint (sim
     * treats it like any other bolt): LaserSystemView tints heavy bolts with
     * the faction's heavy-laser color so a gunship's fire reads distinct from a
     * light fighter's. Derived from the shooter at spawn.
     */
    readonly heavy: boolean = false,
  ) {}

  update(deltaSeconds: number, deltaMs: number): void {
    if (this.bornThisFrame) {
      // Render once at the muzzle this frame; start moving next frame.
      this.bornThisFrame = false;
      return;
    }
    this.position.x += this.velocity.x * deltaSeconds;
    this.position.y += this.velocity.y * deltaSeconds;
    this.position.z += this.velocity.z * deltaSeconds;
    this.ageMs += deltaMs;
  }

  get isExpired(): boolean {
    return this.ageMs >= this.lifetimeMs;
  }

  /**
   * Force-expire a laser, e.g. when it hits a target. The next LaserSystem
   * sweep will see isExpired === true and drop it (views release the mesh).
   */
  kill(): void {
    this.ageMs = this.lifetimeMs + 1;
  }
}
