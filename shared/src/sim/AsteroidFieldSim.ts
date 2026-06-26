import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
// Field layout/drift/shatter randomness draws from the seeded SIM RNG: rocks
// are collision hazards + line-of-sight cover, so their placement and motion
// shape the battle. See sim/SimRng.ts for the rule.
import { simRandom } from "./SimRng";
import { AsteroidSim } from "./AsteroidSim";
import type { DamageTarget } from "../types";

/** Where rocks must NOT spawn (the motherships), with a keep-clear radius. */
export type KeepClear = { x: number; z: number; radius: number };

/**
 * The arena's drifting asteroid field — the SIM half (Ship/ShipView pattern).
 * Scene-free: owns every rock's sim, ticks drift + tumble, wraps them around the
 * arena bounds so the field stays populated, and handles destruction — a rock
 * killed by weapon fire fires `onShatter` (the view pops an explosion) and (if
 * big enough) shatters into smaller drifting chunks. The client AsteroidFieldView
 * mirrors `asteroids` to meshes; the server/headless sim uses this directly.
 *
 * The `obstacles` array is the live list the weapon systems hold BY REFERENCE
 * for line-of-sight cover — when a rock shatters, its child chunks are pushed
 * into the same array, so the weapon systems see them with no extra wiring.
 * Dead rocks are removed from it during the field's update sweep.
 */
export class AsteroidFieldSim {
  /**
   * Live rocks, exposed for the weapon systems (as DamageTarget obstacles), the
   * ship-collision pass, and the view. Mutated in place (shatter children
   * pushed, dead rocks spliced) so external holders of the reference stay
   * current.
   */
  readonly asteroids: AsteroidSim[] = [];

  /**
   * Fired when a rock shatters, with the world position + visual radius of the
   * destroyed rock, so the view can pop a size-scaled explosion + sound + trauma.
   */
  onShatter: ((position: Vector3, visualRadius: number) => void) | null = null;

  constructor(
    private readonly halfWidth: number,
    private readonly halfDepth: number,
    keepClear: KeepClear[],
  ) {
    const cfg = GameConfig.asteroids;
    for (let i = 0; i < cfg.count; i++) {
      const pos = this.findSpawn(keepClear);
      if (!pos) continue; // arena too crowded with keep-clear zones — skip.
      const radius = cfg.radiusMin + simRandom() * (cfg.radiusMax - cfg.radiusMin);
      this.asteroids.push(
        new AsteroidSim({
          position: pos,
          drift: this.randomDrift(),
          visualRadius: radius,
        }),
      );
    }
  }

  /** The live rocks as weapon obstacles (every one implements DamageTarget). */
  get obstacles(): DamageTarget[] {
    return this.asteroids;
  }

  /**
   * Tick drift + tumble for every live rock, wrap strays back into the arena,
   * process any rock killed since the last sweep (shatter event + chunks), and
   * drop dead rocks from the list (the view disposes their meshes on its sync).
   */
  update(deltaSeconds: number): void {
    for (const a of this.asteroids) {
      if (!a.isAlive) continue;
      a.update(deltaSeconds);
      this.wrap(a);
    }

    // Shatter newly-dead rocks. Iterate a snapshot length so chunks pushed this
    // pass (which are alive) aren't themselves processed as deaths.
    const n = this.asteroids.length;
    for (let i = 0; i < n; i++) {
      const a = this.asteroids[i];
      if (a.isAlive || a.shattered) continue;
      a.shattered = true;
      this.onShatter?.(a.position, a.visualRadius);
      this.shatterInto(a);
    }

    // Remove dead rocks (now fully processed) so they stop being tested.
    for (let i = this.asteroids.length - 1; i >= 0; i--) {
      if (!this.asteroids[i].isAlive) this.asteroids.splice(i, 1);
    }
  }

  // ---------- Destruction ----------

  /** Spawn smaller drifting chunks from a destroyed rock, if it's big enough. */
  private shatterInto(parent: AsteroidSim): void {
    const cfg = GameConfig.asteroids;
    if (parent.visualRadius <= cfg.minSplitRadius) return;

    // Chunk count scales with the parent's size, clamped — small rocks crack
    // into a couple of pieces, big boulders burst into a spray of rubble.
    const chunkCount = Math.max(
      cfg.splitCountMin,
      Math.min(
        cfg.splitCountMax,
        Math.round(parent.visualRadius * cfg.chunksPerRadius),
      ),
    );

    for (let i = 0; i < chunkCount; i++) {
      // Size rolled across a wide band, biased toward the small end (rand^bias),
      // so each shatter throws a few large chunks alongside many small fragments
      // instead of a ring of near-clones.
      const frac =
        cfg.splitRadiusMin +
        (cfg.splitRadiusMax - cfg.splitRadiusMin) *
          Math.pow(simRandom(), cfg.splitSizeBias);
      const childRadius = parent.visualRadius * frac;
      // Fan the chunks outward around the parent center with an outward drift
      // kick layered on top of the parent's existing motion.
      const angle = (i / chunkCount) * Math.PI * 2 + simRandom() * 0.8;
      const ox = Math.sin(angle);
      const oz = Math.cos(angle);
      const pos = new Vector3(
        parent.position.x + ox * childRadius,
        cfg.yLevel,
        parent.position.z + oz * childRadius,
      );
      const speed = cfg.splitSpeed + simRandom() * cfg.splitSpeedVariance;
      const drift = new Vector3(
        parent.drift.x + ox * speed,
        0,
        parent.drift.z + oz * speed,
      );
      // Violent blast tumble — far faster than ambient field spin.
      const spin = new Vector3(
        AsteroidFieldSim.signedRange(cfg.chunkSpinRateMin, cfg.chunkSpinRateMax),
        AsteroidFieldSim.signedRange(cfg.chunkSpinRateMin, cfg.chunkSpinRateMax),
        AsteroidFieldSim.signedRange(cfg.chunkSpinRateMin, cfg.chunkSpinRateMax),
      );
      this.asteroids.push(
        new AsteroidSim({
          position: pos,
          drift,
          visualRadius: childRadius,
          spin,
        }),
      );
    }
  }

  // ---------- Spawning ----------

  /**
   * A scatter position inside the arena that clears every keep-clear zone, or
   * null after a bounded number of tries (treat as "skip this rock").
   */
  private findSpawn(keepClear: KeepClear[]): Vector3 | null {
    const cfg = GameConfig.asteroids;
    const regions = cfg.regions;
    for (let tries = 0; tries < 30; tries++) {
      let x: number;
      let z: number;
      if (regions.length === 0) {
        // Full-arena scatter (the default). This branch MUST keep its exact
        // simRandom() draw sequence — two draws, x then z — so the headless
        // smoke harness (which always runs empty regions) stays deterministic.
        x = (simRandom() * 2 - 1) * this.halfWidth;
        z = (simRandom() * 2 - 1) * this.halfDepth;
      } else {
        const p = this.sampleRegion(regions);
        x = p.x;
        z = p.z;
      }
      let ok = true;
      for (const k of keepClear) {
        const dx = x - k.x;
        const dz = z - k.z;
        if (dx * dx + dz * dz < k.radius * k.radius) {
          ok = false;
          break;
        }
      }
      if (ok) return new Vector3(x, cfg.yLevel, z);
    }
    return null;
  }

  /**
   * Pick one spawn circle (weighted by area so density is even across circles
   * of different sizes), then a uniform random point inside it — the sqrt keeps
   * points from clumping at the center. Three seeded draws (region, angle,
   * radius); only ever reached when `regions` is non-empty, so the full-arena
   * default's draw sequence is untouched.
   */
  private sampleRegion(
    regions: ReadonlyArray<{ x: number; z: number; radius: number }>,
  ): { x: number; z: number } {
    let region = regions[0];
    let totalArea = 0;
    for (const r of regions) totalArea += r.radius * r.radius;
    let pick = simRandom() * totalArea;
    for (const r of regions) {
      pick -= r.radius * r.radius;
      if (pick <= 0) {
        region = r;
        break;
      }
    }
    const angle = simRandom() * Math.PI * 2;
    const dist = region.radius * Math.sqrt(simRandom());
    return {
      x: region.x + Math.cos(angle) * dist,
      z: region.z + Math.sin(angle) * dist,
    };
  }

  /** A value in [min, max] with a random sign — for symmetric chunk spin. */
  private static signedRange(min: number, max: number): number {
    const mag = min + simRandom() * (max - min);
    return simRandom() < 0.5 ? -mag : mag;
  }

  private randomDrift(): Vector3 {
    const cfg = GameConfig.asteroids;
    const speed =
      cfg.driftSpeedMin + simRandom() * (cfg.driftSpeedMax - cfg.driftSpeedMin);
    const angle = simRandom() * Math.PI * 2;
    return new Vector3(Math.sin(angle) * speed, 0, Math.cos(angle) * speed);
  }

  /**
   * Wrap a rock that has drifted off an edge to the opposite side, so the field
   * stays populated in the (unbounded) arena. The visual radius is added to the
   * bound so the rock fully exits the frame before reappearing — no pop.
   */
  private wrap(a: AsteroidSim): void {
    const mx = this.halfWidth + a.visualRadius;
    const mz = this.halfDepth + a.visualRadius;
    if (a.position.x > mx) a.position.x = -mx;
    else if (a.position.x < -mx) a.position.x = mx;
    if (a.position.z > mz) a.position.z = -mz;
    else if (a.position.z < -mz) a.position.z = mz;
  }
}
