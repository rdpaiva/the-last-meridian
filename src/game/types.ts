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
  /**
   * EDGE intent (true for the single frame the jump key was JUST pressed, not
   * a held bool like `thrust`/`fire`) — toggles the ship's jump state machine:
   * arm a spool, or cancel one in progress (docs/JUMP-DRIVE-AND-RESUPPLY.md).
   * LocalInputController edge-detects the `J` key; AIController emits it from
   * its jump-out doctrine. Consumed once by Ship.onJumpIntent().
   */
  jumpPressed: boolean;
  zoomIn: boolean;
  zoomOut: boolean;
};

export type ShipState = {
  position: Vector3;
  velocity: Vector3;
  rotationY: number;
};

/** Keys for the per-ship fire sound, dispatched by SoundSystem.playFireSound(). */
export type FireSoundKey = "playerGuns" | "enemyLaser" | "laserGun" | "breakerLaser";

/**
 * Anything a laser can damage. Implemented by PlayerShip and EnemyShip.
 * LaserSystem holds at most one target reference (set via setTarget) and
 * does an X/Z sphere check against `hitRadius` each frame.
 */
export interface DamageTarget {
  readonly position: Vector3;
  readonly hitRadius: number;
  readonly isAlive: boolean;
  /**
   * Apply damage at sim time `nowMs`. The timestamp is the CALLER's sim
   * clock (Game.tick's frame clock today, the server's tick clock in
   * multiplayer) — death timers must run on sim time, never wall clock.
   * Implementers without time-based death (asteroids, motherships) ignore it.
   */
  takeDamage(amount: number, nowMs: number): void;
  /**
   * Optional directional refinement of `hitRadius` for non-round targets:
   * the collision radius along the given world X/Z direction FROM this
   * target's center (need not be normalized). Asteroids implement it from
   * their squashed, tumbling ellipsoid so collisions match the visible
   * silhouette; collision code falls back to the circular `hitRadius`
   * (the conservative max extent) when absent.
   */
  surfaceRadiusToward?(dirX: number, dirZ: number): number;
  /**
   * Optional exact X/Z silhouette test for non-round targets: does the
   * segment (ax,az)→(bx,bz) touch this target? Pass a zero-length segment
   * (ax=bx, az=bz) for a point test. Collision code uses `hitRadius` as the
   * BROAD phase (it must circumscribe the silhouette), then calls this for
   * the exact verdict when present. Mothership hull sections implement it
   * as a segment-vs-rectangle test so the carriers' boxy hulls collide to
   * their visible footprint instead of a circle.
   */
  intersectsSegmentXZ?(ax: number, az: number, bx: number, bz: number): boolean;
}

/**
 * A small, fragile projectile a laser bolt can shoot down — point defense.
 * Implemented by Missile. Unlike a DamageTarget it has no HP: a single bolt
 * that crosses its `interceptRadius` destroys it outright (intercept()).
 * LaserSystem tests the opposing faction's interceptables each frame with the
 * same swept-segment primitive it uses for ships.
 */
export interface Interceptable {
  readonly position: Vector3;
  /** X/Z radius within which a bolt's path destroys this projectile. */
  readonly interceptRadius: number;
  readonly isAlive: boolean;
  /** Destroy this projectile (a bolt shot it down). */
  intercept(): void;
}
