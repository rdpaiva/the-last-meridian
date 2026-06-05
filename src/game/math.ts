export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
