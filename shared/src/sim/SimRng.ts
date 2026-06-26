/**
 * Seedable RNG for SIMULATION randomness — the deterministic replacement for
 * `Math.random()` in any code path that can change gameplay state (AI wander/
 * reaction/missile pacing, missile damage rolls, asteroid layout/drift/spin/
 * shatter). Multiplayer needs the sim reproducible from a seed, and the
 * Phase 0 headless smoke harness needs it to diff refactors against a
 * committed baseline trace (see docs/MULTIPLAYER.md → Verification).
 *
 * THE RULE: if a random draw can affect positions/HP/orders/collisions — the
 * battle's outcome — it must come from `simRandom()`. Randomness that is
 * purely cosmetic (explosion debris, starfield scatter, asteroid surface
 * noise/crater sculpting/face tint, music shuffle) stays on `Math.random()`
 * so view-only work never advances the sim stream: splitting view code out
 * later must not change a seeded battle.
 *
 * Default behavior is unseeded-equivalent: the module seeds itself from
 * `Math.random()` at load, so normal play stays varied with the exact same
 * distributions as before. Tests (and, later, the server) call
 * `seedSimRng(seed)` for reproducible runs.
 *
 * Implementation: mulberry32 — tiny, fast, solid distribution for game use,
 * and (unlike engine RNGs) IDENTICAL across platforms/JS engines, which is
 * what makes committed baseline traces comparable anywhere.
 */

/** Internal 32-bit state. */
let state = 0;

/** The seed currently in effect (for logging/repro reports). */
let currentSeed = 0;

/**
 * Seed the sim RNG. The same seed always yields the same draw sequence.
 * Any finite number is accepted; it is hashed into 32 bits.
 */
export function seedSimRng(seed: number): void {
  // Normalize to an odd-ish 32-bit state so tiny ints (0, 1, 2…) still
  // produce well-mixed streams from the first draw.
  currentSeed = seed >>> 0;
  state = (currentSeed ^ 0x9e3779b9) >>> 0;
}

/** The seed in effect (set explicitly or rolled at module load). */
export function getSimRngSeed(): number {
  return currentSeed;
}

/**
 * Drop-in `Math.random()` replacement for sim code: uniform float in [0, 1).
 * (mulberry32 core — one 32-bit LCG-ish scramble per draw.)
 */
export function simRandom(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Self-seed at load so regular gameplay is varied without any caller setup.
// Tests overwrite this with seedSimRng() before constructing the sim.
seedSimRng(Math.floor(Math.random() * 0xffffffff));
