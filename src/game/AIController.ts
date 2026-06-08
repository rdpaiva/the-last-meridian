import { GameConfig } from "./GameConfig";
import { clamp, wrapAngle } from "./math";
import type { InputState } from "./types";
import type { Ship } from "./Ship";
import type { ShipController, ControllerWorld } from "./ShipController";

/**
 * Computer pilot. Ports the old EnemyShip wander/engage/fire-cone behavior, but
 * instead of mutating the ship it emits an InputState that the shared Ship sim
 * consumes — so the same code path drives AI and human ships.
 *
 * Behavior (unchanged from the original duel):
 *   - No live opponent in engagement range → wander: pick a heading
 *     periodically, biased back toward arena center, with jitter.
 *   - Opponent inside engagementRange → steer to face the nearest one.
 *   - Opponent inside fireRange AND inside the fire cone → hold fire. The
 *     Ship's own fireCooldownMs paces the actual shots (same as the player).
 *
 * Steering is expressed as left/right button presses from the sign of the
 * heading error (with a small deadband so it doesn't oscillate). At ~2 rad/s
 * the per-frame step is ~1.8°, so any jitter around the target heading is
 * invisible — and boolean inputs are exactly what a network controller sends.
 */
export class AIController implements ShipController {
  /** Reused each frame so the render loop stays allocation-free. */
  private readonly out: InputState = {
    thrust: false,
    reverse: false,
    rotateLeft: false,
    rotateRight: false,
    strafeLeft: false,
    strafeRight: false,
    fire: false,
    fireMissile: false,
    zoomIn: false,
    zoomOut: false,
  };

  /** Deadband (rad) around the target heading where we stop turning. */
  private static readonly STEER_DEADBAND = 0.05;

  private wanderTargetHeading = Math.random() * Math.PI * 2;
  private wanderTimerSec = 0;

  update(deltaSeconds: number, self: Ship, world: ControllerWorld): InputState {
    const out = this.out;
    out.rotateLeft = false;
    out.rotateRight = false;
    out.thrust = false;
    out.fire = false;
    // reverse/strafe/missile/zoom stay false for AI.

    if (!self.isAlive) return out;

    const cfg = GameConfig.enemy;

    // Nearest live opponent on the X/Z plane.
    const target = this.nearestLiveOpponent(self, world);

    let targetHeading: number;
    let distToTarget = Infinity;
    let angleToTarget = 0;
    if (target) {
      const dx = target.position.x - self.position.x;
      const dz = target.position.z - self.position.z;
      distToTarget = Math.hypot(dx, dz);
      angleToTarget = Math.atan2(dx, dz); // matches forward convention
    }

    if (target && distToTarget < cfg.engagementRange) {
      targetHeading = angleToTarget;
    } else {
      this.wanderTimerSec -= deltaSeconds;
      if (this.wanderTimerSec <= 0) {
        this.retargetWander(self, world);
      }
      targetHeading = this.wanderTargetHeading;
    }

    // Steer: press left/right toward the target heading.
    const headingDiff = wrapAngle(targetHeading - self.rotationY);
    if (headingDiff > AIController.STEER_DEADBAND) {
      out.rotateRight = true;
    } else if (headingDiff < -AIController.STEER_DEADBAND) {
      out.rotateLeft = true;
    }

    // Always thrust forward (the old enemy always drove forward).
    out.thrust = true;

    // Hold fire when in range and roughly on target; Ship gates the rate.
    if (
      target &&
      distToTarget < cfg.fireRange &&
      Math.abs(wrapAngle(angleToTarget - self.rotationY)) < cfg.fireConeAngle
    ) {
      out.fire = true;
    }

    return out;
  }

  private nearestLiveOpponent(self: Ship, world: ControllerWorld): Ship | null {
    let best: Ship | null = null;
    let bestDistSq = Infinity;
    for (const o of world.opponents) {
      if (!o.isAlive) continue;
      const dx = o.position.x - self.position.x;
      const dz = o.position.z - self.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = o;
      }
    }
    return best;
  }

  /** Picks a new wander heading with center-bias plus jitter (as before). */
  private retargetWander(self: Ship, world: ControllerWorld): void {
    const cfg = GameConfig.enemy;
    const angleToCenter = Math.atan2(-self.position.x, -self.position.z);
    const distFromCenter = Math.hypot(self.position.x, self.position.z);
    const arenaRadius = Math.min(world.arenaHalfX, world.arenaHalfZ);
    const centerPull =
      clamp(distFromCenter / arenaRadius, 0, 1) * cfg.centerBias;

    const jitter = (Math.random() * 2 - 1) * cfg.wanderJitter;
    const naiveTarget = self.rotationY + jitter;
    this.wanderTargetHeading = wrapAngle(
      naiveTarget * (1 - centerPull) + angleToCenter * centerPull,
    );

    this.wanderTimerSec = cfg.wanderRetargetSec * (0.6 + Math.random() * 0.8);
  }
}
