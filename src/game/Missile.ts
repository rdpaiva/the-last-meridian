import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { wrapAngle } from "./math";
import type { DamageTarget } from "./types";

/**
 * Single heat-seeking missile. Owned and updated by MissileSystem — do not
 * construct directly from outside.
 *
 * Unlike a Laser (pure ballistic), a missile re-derives its velocity from
 * `rotationY` every frame and, while it has a live `target`, steers that
 * heading toward the target at a capped turn rate. If launched without a
 * lock (`target === null`) — or once its target dies — it flies straight on
 * its current heading, so an unguided missile still detonates on whatever it
 * runs into (collision lives in MissileSystem).
 */
export class Missile {
  ageMs = 0;
  private readonly velocity = new Vector3();

  /**
   * Whether this missile may acquire a target mid-flight. True only when it
   * launched WITHOUT a lock — a ballistic missile seeks a nearby target along
   * its path (MissileSystem does the scan and calls `acquire`). A missile that
   * launched WITH a lock stays committed to its original target and never
   * re-targets, even after that target dies.
   */
  readonly canReacquire: boolean;

  constructor(
    /** Root node of the composite missile mesh (body + nose + fins). */
    readonly mesh: TransformNode,
    /**
     * The missile's own exhaust trail. NOT parented to the mesh — a TrailMesh
     * lives independently in the scene (CLAUDE.md gotcha #4), so dispose() must
     * tear it down explicitly or it lingers after detonation.
     */
    private readonly trail: TrailMesh,
    private rotationY: number,
    private target: DamageTarget | null,
    private readonly speed: number,
    private readonly turnRate: number,
    readonly lifetimeMs: number,
  ) {
    mesh.rotation.y = rotationY;
    this.canReacquire = target === null;
    this.setVelocityFromHeading();
  }

  /** Heading (radians) the missile is currently flying along. */
  get heading(): number {
    return this.rotationY;
  }

  /** True while the missile has a live target it is homing on. */
  get hasTarget(): boolean {
    return this.target !== null;
  }

  /** Lock onto a target found mid-flight (only used for `canReacquire` missiles). */
  acquire(target: DamageTarget): void {
    this.target = target;
  }

  private setVelocityFromHeading(): void {
    this.velocity.x = Math.sin(this.rotationY) * this.speed;
    this.velocity.z = Math.cos(this.rotationY) * this.speed;
  }

  update(deltaSeconds: number, deltaMs: number): void {
    // Homing: steer toward a live target, capped at turnRate. Drop a dead
    // target and coast straight from here on.
    if (this.target && !this.target.isAlive) this.target = null;
    if (this.target) {
      const dx = this.target.position.x - this.mesh.position.x;
      const dz = this.target.position.z - this.mesh.position.z;
      const angleToTarget = Math.atan2(dx, dz); // matches forward = +Z convention
      const headingDiff = wrapAngle(angleToTarget - this.rotationY);
      const turnStep =
        Math.sign(headingDiff) *
        Math.min(Math.abs(headingDiff), this.turnRate * deltaSeconds);
      this.rotationY += turnStep;
      this.setVelocityFromHeading();
      this.mesh.rotation.y = this.rotationY;
    }

    this.mesh.position.x += this.velocity.x * deltaSeconds;
    this.mesh.position.z += this.velocity.z * deltaSeconds;
    this.ageMs += deltaMs;
  }

  get isExpired(): boolean {
    return this.ageMs >= this.lifetimeMs;
  }

  /**
   * Force-expire the missile, e.g. when it detonates on a target. The next
   * MissileSystem sweep will see isExpired === true and dispose it.
   */
  kill(): void {
    this.ageMs = this.lifetimeMs + 1;
  }

  dispose(): void {
    // Trail first — it's not a child of the mesh, so disposing the mesh alone
    // would leak the tube (gotcha #4).
    //
    // stop() BEFORE dispose() is mandatory: TrailMesh registers a per-frame
    // scene.onBeforeRenderObservable callback in start()/autoStart and does NOT
    // remove it in dispose() (no dispose override — it inherits Mesh.dispose).
    // Only stop() unhooks that observer. Skip this and every fired missile
    // leaks a permanent per-frame callback updating dead geometry, which piles
    // up into progressive slowdown/choppiness.
    this.trail.stop();
    this.trail.dispose();
    this.mesh.dispose();
  }
}
