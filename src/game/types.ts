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
  /**
   * Analog turn rate in [-1, 1] (-1 = full left, +1 = full right), summed with
   * the rotateLeft/rotateRight booleans by the Ship sim. The keyboard leaves
   * this 0 and drives the booleans (full-rate turns, as a human expects); the
   * AIController uses it to turn PROPORTIONALLY — easing the rate down as it
   * lines up on its target heading so it tracks a moving heading smoothly
   * instead of stepping toward it with bang-bang full-rate pulses.
   */
  turn: number;
  strafeLeft: boolean;
  strafeRight: boolean;
  fire: boolean;
  fireMissile: boolean;
  zoomIn: boolean;
  zoomOut: boolean;
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
