import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { GameConfig } from "./GameConfig";
import type { DamageTarget, InputState } from "./types";
import { clamp, exponentialMultiplier } from "./math";

/**
 * Player ship simulation. Game-state driven (NOT Babylon physics) — we own
 * position, velocity, rotation and write them into the visual root each
 * frame.
 *
 * Coordinate convention (Babylon left-handed default):
 *   forward at rotationY=0 is local +Z.
 *   Increasing rotationY rotates clockwise when viewed from above, so
 *   rotateRight increases rotationY and rotateLeft decreases it.
 *
 * Implements DamageTarget so enemy lasers can find it via setTarget().
 */
export class PlayerShip implements DamageTarget {
  readonly position = new Vector3(0, 0, 0);
  readonly velocity = new Vector3(0, 0, 0);
  rotationY = 0;

  hp: number = GameConfig.combat.playerMaxHp;
  readonly maxHp: number = GameConfig.combat.playerMaxHp;
  readonly hitRadius: number = GameConfig.combat.shipHitRadius;

  /**
   * Wall-clock timestamp of death, or null while alive. Game.ts polls
   * `shouldRespawn(nowMs)` and calls `respawn()` when the delay elapses.
   */
  private deathTimeMs: number | null = null;

  private fireCooldownRemainingMs = 0;
  private readonly forwardScratch = new Vector3();

  /**
   * Index of the next muzzle to fire from when GameConfig.player.fireMode
   * is "alternate". Resets on respawn so respawning doesn't desync the
   * left/right alternation pattern.
   */
  private nextMuzzleIdx = 0;

  constructor(readonly root: TransformNode) {}

  // ---------- DamageTarget ----------

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number): void {
    if (!this.isAlive) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.die();
    }
  }

  private die(): void {
    this.deathTimeMs = performance.now();
    this.root.setEnabled(false);
    this.velocity.set(0, 0, 0);
  }

  shouldRespawn(nowMs: number): boolean {
    return (
      this.deathTimeMs !== null &&
      nowMs - this.deathTimeMs >= GameConfig.combat.playerRespawnDelayMs
    );
  }

  /** Reset to full HP at the given spawn pose, re-enable mesh. */
  respawn(x = 0, z = 0, rotationY = 0): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.rotationY = rotationY;
    this.hp = this.maxHp;
    this.deathTimeMs = null;
    this.fireCooldownRemainingMs = 0;
    this.nextMuzzleIdx = 0;
    this.root.position.copyFrom(this.position);
    this.root.rotation.y = this.rotationY;
    this.root.setEnabled(true);
  }

  /**
   * World-space forward direction on the X/Z plane. Returns the same scratch
   * Vector3 each call (no allocation) — copy if you need to keep it.
   */
  forward(): Vector3 {
    this.forwardScratch.x = Math.sin(this.rotationY);
    this.forwardScratch.y = 0;
    this.forwardScratch.z = Math.cos(this.rotationY);
    return this.forwardScratch;
  }

  update(
    deltaSeconds: number,
    input: InputState,
    arenaHalfX: number,
    arenaHalfZ: number,
  ): void {
    if (!this.isAlive) return; // frozen while dead; Game handles respawn.

    const cfg = GameConfig.player;

    // --- Rotation ---
    if (input.rotateLeft) this.rotationY -= cfg.rotationSpeed * deltaSeconds;
    if (input.rotateRight) this.rotationY += cfg.rotationSpeed * deltaSeconds;

    // --- Acceleration ---
    const fwd = this.forward();
    if (input.thrust) {
      this.velocity.x += fwd.x * cfg.thrust * deltaSeconds;
      this.velocity.z += fwd.z * cfg.thrust * deltaSeconds;
    }
    if (input.reverse) {
      // Reverse thrust (not damp-brake): pilot can back away while still
      // facing the enemy. Lower magnitude than forward thrust so reverse
      // doesn't feel like a get-out-of-trouble jet.
      this.velocity.x -= fwd.x * cfg.reverseThrust * deltaSeconds;
      this.velocity.z -= fwd.z * cfg.reverseThrust * deltaSeconds;
    }

    // --- Drag (frame-rate independent exponential decay) ---
    const dragFactor = exponentialMultiplier(cfg.dragRate, deltaSeconds);
    this.velocity.x *= dragFactor;
    this.velocity.z *= dragFactor;

    // --- Speed cap ---
    const speedSq =
      this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    const maxSpeedSq = cfg.maxSpeed * cfg.maxSpeed;
    if (speedSq > maxSpeedSq) {
      const scale = cfg.maxSpeed / Math.sqrt(speedSq);
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }

    // --- Integrate position ---
    this.position.x += this.velocity.x * deltaSeconds;
    this.position.z += this.velocity.z * deltaSeconds;
    this.position.x = clamp(this.position.x, -arenaHalfX, arenaHalfX);
    this.position.z = clamp(this.position.z, -arenaHalfZ, arenaHalfZ);

    // --- Sync visuals ---
    this.root.position.copyFrom(this.position);
    this.root.rotation.y = this.rotationY;

    // --- Fire cooldown ---
    if (this.fireCooldownRemainingMs > 0) {
      this.fireCooldownRemainingMs -= deltaSeconds * 1000;
    }
  }

  /**
   * Attempts to fire. Returns an array of world-space spawn positions —
   * one per muzzle to fire from this frame. Empty array means cooldown
   * not ready.
   *
   * Driven by GameConfig.player.muzzles and .fireMode:
   *   - "alternate": returns one position, round-robining through muzzles
   *   - "salvo":     returns one position per muzzle (all fire at once)
   */
  tryFire(): Vector3[] {
    if (this.fireCooldownRemainingMs > 0) return [];
    this.fireCooldownRemainingMs = GameConfig.player.fireCooldownMs;

    const cfg = GameConfig.player;
    if (cfg.muzzles.length === 0) return [];

    const positions: Vector3[] = [];
    if (cfg.fireMode === "salvo") {
      for (const m of cfg.muzzles) {
        positions.push(this.worldFromLocal(m.x, m.y, m.z, new Vector3()));
      }
    } else {
      const m = cfg.muzzles[this.nextMuzzleIdx];
      this.nextMuzzleIdx = (this.nextMuzzleIdx + 1) % cfg.muzzles.length;
      positions.push(this.worldFromLocal(m.x, m.y, m.z, new Vector3()));
    }
    return positions;
  }

  /**
   * Transforms a ship-local point (lx, ly, lz) into world coordinates,
   * accounting for the ship's current position and Y rotation.
   *
   * Y rotation matrix in our LHS convention (forward = +Z at rotationY=0,
   * positive rotation = clockwise from above):
   *   worldX = cos·lx + sin·lz
   *   worldZ = -sin·lx + cos·lz
   */
  worldFromLocal(lx: number, ly: number, lz: number, out: Vector3): Vector3 {
    const cos = Math.cos(this.rotationY);
    const sin = Math.sin(this.rotationY);
    out.x = this.position.x + cos * lx + sin * lz;
    out.y = this.position.y + ly;
    out.z = this.position.z + -sin * lx + cos * lz;
    return out;
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }
}
