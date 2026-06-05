import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Single source of truth for input state. InputManager produces it,
 * PlayerShip / Game consume it. Don't redefine elsewhere.
 */
export type InputState = {
  thrust: boolean;
  reverse: boolean;
  rotateLeft: boolean;
  rotateRight: boolean;
  strafeLeft: boolean;
  strafeRight: boolean;
  fire: boolean;
};

export type ShipState = {
  position: Vector3;
  velocity: Vector3;
  rotationY: number;
};

/**
 * Anything a laser can damage. Implemented by PlayerShip and EnemyShip.
 * LaserSystem holds at most one target reference (set via setTarget) and
 * does an X/Z sphere check against `hitRadius` each frame.
 */
export interface DamageTarget {
  readonly position: Vector3;
  readonly hitRadius: number;
  readonly isAlive: boolean;
  takeDamage(amount: number): void;
}
