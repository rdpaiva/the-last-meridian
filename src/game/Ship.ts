import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { GameConfig } from "./GameConfig";
import type { DamageTarget, InputState } from "./types";
import type { Faction } from "./Faction";
import { clamp, exponentialMultiplier } from "./math";

/**
 * Movement + weapon tuning a Ship reads each frame. Both GameConfig.player and
 * GameConfig.enemy satisfy this shape, so the same sim drives the human pilot
 * and the AI fighters — the only difference is which config block (and which
 * Controller) is wired in.
 */
export interface ShipMovementConfig {
  thrust: number;
  reverseThrust: number;
  strafeThrust: number;
  maxSpeed: number;
  dragRate: number;
  rotationSpeed: number;
  fireCooldownMs: number;
  muzzles: ReadonlyArray<{ x: number; y: number; z: number }>;
  fireMode: "alternate" | "salvo";
}

export interface ShipOptions {
  faction: Faction;
  maxHp: number;
  /** Delay before Game may respawn this ship after death (ms). */
  respawnDelayMs: number;
  /** Missiles to start/refill with. AI fighters get 0; the player gets a full rack. */
  startMissileAmmo: number;
  /** Movement/weapon tuning (GameConfig.player or GameConfig.enemy). */
  movement: ShipMovementConfig;
}

/**
 * Unified ship simulation — the single sim class behind both the human pilot
 * and the AI fighters (it merges the old PlayerShip + EnemyShip). It is purely
 * game-state driven (NOT Babylon physics): we own position, velocity, rotation
 * and write them into the visual `root` each frame.
 *
 * It consumes an InputState in update() and does NOT care where that came from
 * — a LocalInputController (keyboard), an AIController, or a future
 * NetworkController all just hand it an InputState. That decoupling is what
 * makes the two factions interchangeable and the game multiplayer-ready.
 *
 * Coordinate convention (Babylon left-handed default):
 *   forward at rotationY=0 is local +Z.
 *   Increasing rotationY rotates clockwise when viewed from above, so
 *   rotateRight increases rotationY and rotateLeft decreases it.
 *
 * Implements DamageTarget so the opposing faction's lasers/missiles can hit it.
 */
export class Ship implements DamageTarget {
  readonly position = new Vector3(0, 0, 0);
  readonly velocity = new Vector3(0, 0, 0);
  rotationY = 0;

  readonly faction: Faction;
  readonly maxHp: number;
  hp: number;
  readonly hitRadius: number = GameConfig.combat.shipHitRadius;

  /** Remaining heat-seeking missiles. Refills to startMissileAmmo on respawn. */
  missileAmmo: number;
  private missileCooldownRemainingMs = 0;

  private readonly cfg: ShipMovementConfig;
  private readonly respawnDelayMs: number;
  private readonly startMissileAmmo: number;

  /**
   * Wall-clock timestamp of death, or null while alive. Game polls
   * `shouldRespawn(nowMs)` and calls `respawn()` when the delay elapses.
   */
  private deathTimeMs: number | null = null;

  /**
   * Set by Game once it has fired the death explosion/FX for this ship, so the
   * per-frame death check doesn't re-fire every frame until respawn. Reset in
   * respawn().
   */
  explosionFired = false;

  private fireCooldownRemainingMs = 0;
  private readonly forwardScratch = new Vector3();
  private readonly rightScratch = new Vector3();

  /** Next muzzle index for "alternate" fire mode; reset on respawn. */
  private nextMuzzleIdx = 0;

  constructor(
    readonly root: TransformNode,
    opts: ShipOptions,
  ) {
    this.faction = opts.faction;
    this.maxHp = opts.maxHp;
    this.hp = opts.maxHp;
    this.respawnDelayMs = opts.respawnDelayMs;
    this.startMissileAmmo = opts.startMissileAmmo;
    this.missileAmmo = opts.startMissileAmmo;
    this.cfg = opts.movement;
  }

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
      this.deathTimeMs !== null && nowMs - this.deathTimeMs >= this.respawnDelayMs
    );
  }

  /** Reset to full HP at the given spawn pose, re-enable mesh. */
  respawn(x = 0, z = 0, rotationY = 0): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.rotationY = rotationY;
    this.hp = this.maxHp;
    this.deathTimeMs = null;
    this.explosionFired = false;
    this.fireCooldownRemainingMs = 0;
    this.missileCooldownRemainingMs = 0;
    this.missileAmmo = this.startMissileAmmo;
    this.nextMuzzleIdx = 0;
    this.root.position.copyFrom(this.position);
    this.root.rotation.y = this.rotationY;
    this.root.setEnabled(true);
  }

  /**
   * World-space forward direction on the X/Z plane. Returns a shared scratch
   * Vector3 (no allocation) — copy if you need to keep it.
   */
  forward(): Vector3 {
    this.forwardScratch.x = Math.sin(this.rotationY);
    this.forwardScratch.y = 0;
    this.forwardScratch.z = Math.cos(this.rotationY);
    return this.forwardScratch;
  }

  /**
   * World-space right (starboard) direction on the X/Z plane — forward rotated
   * +90° clockwise from above. Returns a shared scratch Vector3.
   */
  right(): Vector3 {
    this.rightScratch.x = Math.cos(this.rotationY);
    this.rightScratch.y = 0;
    this.rightScratch.z = -Math.sin(this.rotationY);
    return this.rightScratch;
  }

  update(deltaSeconds: number, input: InputState): void {
    if (!this.isAlive) return; // frozen while dead; Game handles respawn.

    const cfg = this.cfg;

    // --- Rotation ---
    // Analog turn channel (AI sets a proportional rate for smooth tracking)
    // summed with the keyboard's full-rate booleans, then clamped to ±1.
    let turn = input.turn;
    if (input.rotateRight) turn += 1;
    if (input.rotateLeft) turn -= 1;
    this.rotationY += clamp(turn, -1, 1) * cfg.rotationSpeed * deltaSeconds;

    // --- Acceleration ---
    const fwd = this.forward();
    if (input.thrust) {
      this.velocity.x += fwd.x * cfg.thrust * deltaSeconds;
      this.velocity.z += fwd.z * cfg.thrust * deltaSeconds;
    }
    if (input.reverse) {
      this.velocity.x -= fwd.x * cfg.reverseThrust * deltaSeconds;
      this.velocity.z -= fwd.z * cfg.reverseThrust * deltaSeconds;
    }

    // --- Strafe (lateral thrust; heading unchanged) ---
    if (input.strafeLeft || input.strafeRight) {
      const right = this.right();
      const dir = (input.strafeRight ? 1 : 0) - (input.strafeLeft ? 1 : 0);
      this.velocity.x += right.x * dir * cfg.strafeThrust * deltaSeconds;
      this.velocity.z += right.z * dir * cfg.strafeThrust * deltaSeconds;
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
    // The arena is unbounded — no position clamp. Ships are kept in the combat
    // corridor by piloting (the player) and the AIController's leash bias
    // toward its objective mothership (the AI fighters), not by walls.

    // --- Sync visuals ---
    this.root.position.copyFrom(this.position);
    this.root.rotation.y = this.rotationY;

    // --- Fire cooldowns ---
    if (this.fireCooldownRemainingMs > 0) {
      this.fireCooldownRemainingMs -= deltaSeconds * 1000;
    }
    if (this.missileCooldownRemainingMs > 0) {
      this.missileCooldownRemainingMs -= deltaSeconds * 1000;
    }
  }

  /**
   * Attempts to fire the primary cannon. Returns an array of world-space spawn
   * positions — one per muzzle to fire this frame. Empty array = on cooldown.
   * Driven by the ship's movement config (muzzles + fireMode).
   */
  tryFire(): Vector3[] {
    if (this.fireCooldownRemainingMs > 0) return [];
    this.fireCooldownRemainingMs = this.cfg.fireCooldownMs;

    const cfg = this.cfg;
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
   * Attempts to launch a heat-seeking missile. Returns the world-space spawn
   * position (along the nose), or null when on cooldown or out of ammo.
   */
  tryFireMissile(): Vector3 | null {
    if (this.missileCooldownRemainingMs > 0 || this.missileAmmo <= 0) {
      return null;
    }
    this.missileCooldownRemainingMs = GameConfig.missile.fireCooldownMs;
    this.missileAmmo--;

    const fwd = this.forward();
    const off = GameConfig.missile.spawnOffset;
    return new Vector3(
      this.position.x + fwd.x * off,
      this.position.y,
      this.position.z + fwd.z * off,
    );
  }

  /**
   * Transforms a ship-local point into world coordinates, accounting for the
   * ship's current position and Y rotation. (forward = +Z at rotationY=0,
   * positive rotation = clockwise from above.)
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
