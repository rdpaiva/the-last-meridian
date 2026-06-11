import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import { GameConfig } from "./GameConfig";
import { Asteroid } from "./Asteroid";
import type { DamageTarget } from "./types";

/** Where rocks must NOT spawn (the motherships), with a keep-clear radius. */
type KeepClear = { x: number; z: number; radius: number };

/**
 * The arena's drifting asteroid field. Owns every rock, ticks their drift +
 * tumble, wraps them around the arena bounds so the field stays populated, and
 * handles destruction: a rock killed by weapon fire pops an explosion and (if
 * big enough) shatters into smaller drifting chunks.
 *
 * The `obstacles` array is the live list the weapon systems hold BY REFERENCE
 * for line-of-sight cover — when a rock shatters, its child chunks are pushed
 * into the same array, so the weapon systems see them with no extra wiring.
 * Dead rocks are removed from it during the field's update sweep.
 *
 * One shared rock material is reused across the whole field (the CapitalShips
 * pattern), so N rocks cost a fixed material budget regardless of count.
 */
export class AsteroidField {
  /**
   * Live rocks, exposed for the weapon systems (as DamageTarget obstacles) and
   * Game's ship-collision pass. Mutated in place (shatter children pushed, dead
   * rocks spliced) so external holders of the reference stay current.
   */
  readonly asteroids: Asteroid[] = [];

  private readonly material: StandardMaterial;

  /**
   * Fired when a rock shatters, with the world position + visual radius of the
   * destroyed rock, so Game can pop a size-scaled explosion + sound + trauma.
   */
  onShatter: ((position: Vector3, visualRadius: number) => void) | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly halfWidth: number,
    private readonly halfDepth: number,
    keepClear: KeepClear[],
  ) {
    this.material = this.buildMaterial(scene);

    const cfg = GameConfig.asteroids;
    for (let i = 0; i < cfg.count; i++) {
      const pos = this.findSpawn(keepClear);
      if (!pos) continue; // arena too crowded with keep-clear zones — skip.
      const radius = cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin);
      this.asteroids.push(
        new Asteroid(scene, this.material, {
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
   * process any rock killed since the last sweep (explosion + shatter), and
   * drop dead rocks from the list.
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
      const a = this.asteroids[i];
      if (!a.isAlive) {
        a.dispose();
        this.asteroids.splice(i, 1);
      }
    }
  }

  // ---------- Destruction ----------

  /** Spawn smaller drifting chunks from a destroyed rock, if it's big enough. */
  private shatterInto(parent: Asteroid): void {
    const cfg = GameConfig.asteroids;
    if (parent.visualRadius <= cfg.minSplitRadius) return;

    const baseRadius = parent.visualRadius * cfg.splitRadiusFactor;
    for (let i = 0; i < cfg.splitCount; i++) {
      // Each chunk varies its size around the base split radius, so a big rock
      // breaks into a mix of larger and smaller fragments rather than clones.
      const sizeJitter = 1 + (Math.random() * 2 - 1) * cfg.splitSizeVariance;
      const childRadius = baseRadius * sizeJitter;
      // Fan the chunks outward around the parent center with an outward drift
      // kick layered on top of the parent's existing motion.
      const angle = (i / cfg.splitCount) * Math.PI * 2 + Math.random() * 0.8;
      const ox = Math.sin(angle);
      const oz = Math.cos(angle);
      const pos = new Vector3(
        parent.position.x + ox * childRadius,
        cfg.yLevel,
        parent.position.z + oz * childRadius,
      );
      const speed = cfg.splitSpeed + Math.random() * cfg.splitSpeedVariance;
      const drift = new Vector3(
        parent.drift.x + ox * speed,
        0,
        parent.drift.z + oz * speed,
      );
      // Violent blast tumble — far faster than ambient field spin.
      const spin = new Vector3(
        AsteroidField.signedRange(cfg.chunkSpinRateMin, cfg.chunkSpinRateMax),
        AsteroidField.signedRange(cfg.chunkSpinRateMin, cfg.chunkSpinRateMax),
        AsteroidField.signedRange(cfg.chunkSpinRateMin, cfg.chunkSpinRateMax),
      );
      this.asteroids.push(
        new Asteroid(this.scene, this.material, {
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
    for (let tries = 0; tries < 30; tries++) {
      const x = (Math.random() * 2 - 1) * this.halfWidth;
      const z = (Math.random() * 2 - 1) * this.halfDepth;
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

  /** A value in [min, max] with a random sign — for symmetric chunk spin. */
  private static signedRange(min: number, max: number): number {
    const mag = min + Math.random() * (max - min);
    return Math.random() < 0.5 ? -mag : mag;
  }

  private randomDrift(): Vector3 {
    const cfg = GameConfig.asteroids;
    const speed =
      cfg.driftSpeedMin + Math.random() * (cfg.driftSpeedMax - cfg.driftSpeedMin);
    const angle = Math.random() * Math.PI * 2;
    return new Vector3(Math.sin(angle) * speed, 0, Math.cos(angle) * speed);
  }

  /**
   * Wrap a rock that has drifted off an edge to the opposite side, so the field
   * stays populated in the (unbounded) arena. The visual radius is added to the
   * bound so the rock fully exits the frame before reappearing — no pop.
   */
  private wrap(a: Asteroid): void {
    const mx = this.halfWidth + a.visualRadius;
    const mz = this.halfDepth + a.visualRadius;
    if (a.position.x > mx) a.position.x = -mx;
    else if (a.position.x < -mx) a.position.x = mx;
    if (a.position.z > mz) a.position.z = -mz;
    else if (a.position.z < -mz) a.position.z = mz;
  }

  // ---------- Material ----------

  private buildMaterial(scene: Scene): StandardMaterial {
    // Lit rocky grey — deliberately NOT emissive and NOT added to the GlowLayer,
    // so rocks read as solid matter against the glowing ships/lasers/nebulas.
    const mat = new StandardMaterial("asteroid_mat", scene);
    mat.diffuseColor = new Color3(0.32, 0.29, 0.26);
    // Fully matte — any specular highlight makes a big rock read as plastic.
    mat.specularColor = Color3.Black();
    return mat;
  }
}
