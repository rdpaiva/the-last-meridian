export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Wraps an angle into the (-π, π] range so heading differences take the
 * shortest path. Used by both the enemy AI's steering and missile homing.
 */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Returns the lerp factor for exponential smoothing over a time step.
 * Use as: value = lerp(value, target, exponentialDecay(rate, dt));
 *
 * `rate` is "1/time-constant" — higher = snappier convergence. With rate=8,
 * the value covers ~63% of remaining distance every 1/8 sec, regardless of
 * frame rate.
 */
export function exponentialDecay(rate: number, deltaSeconds: number): number {
  return 1 - Math.exp(-rate * deltaSeconds);
}

/**
 * Returns the multiplier to apply to a value for exponential decay over dt.
 * Use as: value *= exponentialMultiplier(rate, dt);
 *
 * `rate` is "1/time-constant" — higher = faster decay toward zero. With
 * rate=1.5, the value decays to ~22% after 1 second.
 */
export function exponentialMultiplier(rate: number, deltaSeconds: number): number {
  return Math.exp(-rate * deltaSeconds);
}

/**
 * Clamped parameter `t` in [0, 1] of the point on segment a→b nearest to
 * point p, in the X/Z plane. `t = 0` is at `a`, `t = 1` is at `b`. Used to
 * resolve where along a projectile's per-tick path it passes closest to a
 * circle center (degenerate zero-length segments — e.g. a bolt's spawn
 * frame, where it hasn't moved yet — return 0).
 */
export function closestTOnSegmentXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq <= 0) return 0;
  let t = ((px - ax) * abx + (pz - az) * abz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t;
}

/**
 * Squared distance from point p to the nearest point on segment a→b, in the
 * X/Z plane. Swept collision vs. a STATIC circle: comparing this to a target's
 * squared hit radius tells us whether the projectile's path THIS TICK crossed
 * the circle, regardless of how far the projectile stepped.
 */
export function distSqSegmentToPointXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const t = closestTOnSegmentXZ(px, pz, ax, az, bx, bz);
  const cx = ax + (bx - ax) * t;
  const cz = az + (bz - az) * t;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
}

/**
 * Closest-approach parameter `t` in [0, 1] of TWO bodies each moving in a
 * straight line across one tick: a projectile from a→b and a target from
 * c→d (X/Z plane). Both motions are linear within a tick, so their relative
 * motion is the straight segment (a−c)→(b−d); the closest approach of that
 * segment to the origin is where the two bodies pass nearest each other.
 *
 * This is the BOTH-BODIES sweep weapon collision must use. Sweeping only the
 * projectile while pinning the target at its end-of-tick point throws away
 * `targetSpeed * dt` of motion — at the 30Hz server tick that's comparable to
 * a fighter's whole hit radius, and head-on passes tunnel straight through
 * (missiles ghosted ~25% of true hits in playtests). Tunneling is governed by
 * RELATIVE closing speed, not the projectile's own speed.
 *
 * Callers evaluate both paths at the returned `t` and compare the distance
 * between the two points against the hit radius.
 */
export function sweptClosestT(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): number {
  // Relative frame: pin the target at the origin.
  const rax = ax - cx;
  const raz = az - cz;
  const mx = bx - dx - rax;
  const mz = bz - dz - raz;
  const lenSq = mx * mx + mz * mz;
  if (lenSq <= 0) return 0;
  let t = -(rax * mx + raz * mz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t;
}
