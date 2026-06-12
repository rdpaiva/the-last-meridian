import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import type { DamageTarget, FireSoundKey, InputState } from "../types";
import type { Faction } from "../Faction";
import { clamp, exponentialDecay, exponentialMultiplier } from "../math";

/**
 * Movement + weapon tuning a Ship reads each frame. Every entry in
 * `GameConfig.shipTypes` satisfies this shape, so the same sim drives the
 * human pilot and the AI fighters — the only difference is which ship type
 * (and which Controller) is wired in.
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

/**
 * A complete ship TYPE: the movement/weapon profile plus the per-type combat
 * knobs and the art it flies with. `GameConfig.shipTypes` is a catalog of
 * these (spitfire, wraith, breaker, …); both the player and the enemy fleet
 * pick types from it, so adding a new ship = adding one entry + (optionally)
 * a GLB. See docs/RECIPES.md → "Add a new ship type".
 */
export interface ShipTypeConfig extends ShipMovementConfig {
  /** GLB filename in /public/models/ (null = procedural fallback mesh). */
  model: string | null;
  /** Hit points. */
  maxHp: number;
  /** Damage per laser bolt THIS ship fires (each bolt carries it). */
  laserDamage: number;
  /** Heat-seeker rack size (0 = no missile capability). */
  missileAmmo: number;
  /** X/Z collision radius for laser/missile/ram tests (world units). */
  hitRadius: number;
  /** Audio cue when this ship fires its primary guns. */
  fireSound: FireSoundKey;
}

export interface ShipOptions {
  faction: Faction;
  maxHp: number;
  /** Delay before Game may respawn this ship after death (ms). */
  respawnDelayMs: number;
  /** Missiles to start/refill with (the ship type's rack — 0 = no rack). */
  startMissileAmmo: number;
  /** Movement/weapon tuning (a GameConfig.shipTypes entry). */
  movement: ShipMovementConfig;
  /**
   * Damage per laser bolt this ship fires. Defaults to the faction-wide
   * GameConfig.combat.laserDamage when not given (Game fills it from the
   * ship's type, so a Breaker hits harder than a Spitfire).
   */
  laserDamage?: number;
  /** X/Z collision radius override; defaults to GameConfig.combat.shipHitRadius. */
  hitRadius?: number;
  /**
   * Optional per-ship muzzle positions (ship-local), overriding
   * `movement.muzzles`. Fed from the model's `muzzle*` markers when present;
   * falls back to the movement config's muzzles otherwise.
   */
  muzzles?: ReadonlyArray<{ x: number; y: number; z: number }>;
  /** Sound played when this ship fires. Maps ship type to audio cue. */
  fireSound: FireSoundKey;
}

/**
 * The read-only depiction surface a ShipView renders from, once per frame.
 * Deliberately an INTERFACE rather than the Ship class so any pose source can
 * feed a view — the local sim today, a network snapshot interpolation buffer
 * in Phase 2 (docs/MULTIPLAYER.md).
 */
export interface ShipPose {
  readonly position: { x: number; y: number; z: number };
  readonly rotationY: number;
  readonly bankAngle: number;
  readonly isAlive: boolean;
}

/**
 * Unified ship simulation — the single sim class behind both the human pilot
 * and the AI fighters (it merges the old PlayerShip + EnemyShip). It is purely
 * game-state driven (NOT Babylon physics): we own position, velocity, rotation.
 * Ship holds NO scene objects — its depiction is a client-side ShipView
 * (src/game/view/ShipView.ts) reading this ship as a ShipPose each frame, so
 * the same sim runs in the browser, the smoke harness, and (Phase 1) the
 * server.
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
export class Ship implements DamageTarget, ShipPose {
  readonly position = new Vector3(0, 0, 0);
  readonly velocity = new Vector3(0, 0, 0);
  rotationY = 0;

  readonly faction: Faction;
  readonly fireSound: FireSoundKey;
  readonly maxHp: number;
  hp: number;
  readonly hitRadius: number;
  /** Damage each laser bolt this ship fires carries (per-type knob). */
  readonly laserDamage: number;

  /** Remaining heat-seeking missiles. Refills to startMissileAmmo on respawn. */
  missileAmmo: number;
  private missileCooldownRemainingMs = 0;

  private readonly cfg: ShipMovementConfig;
  private readonly respawnDelayMs: number;
  private readonly startMissileAmmo: number;

  /**
   * Sim-clock timestamp of death (the nowMs handed to takeDamage), or null
   * while alive. Game polls `shouldRespawn(nowMs)` and calls `respawn()` when
   * the delay elapses. Sim time belongs to the caller — the server owns it in
   * multiplayer; the browser passes its frame clock.
   */
  private deathTimeMs: number | null = null;

  /**
   * Set by Game once it has fired the death explosion/FX for this ship, so the
   * per-frame death check doesn't re-fire every frame until respawn. Reset in
   * respawn().
   */
  explosionFired = false;

  /** Visual bank roll (radians) — sim-written, view-read via ShipPose. */
  bankAngle = 0;

  private fireCooldownRemainingMs = 0;
  private readonly forwardScratch = new Vector3();
  private readonly rightScratch = new Vector3();

  /** Next muzzle index for "alternate" fire mode; reset on respawn. */
  private nextMuzzleIdx = 0;

  /** Muzzle positions (ship-local): model markers if given, else the config's. */
  private readonly muzzles: ReadonlyArray<{ x: number; y: number; z: number }>;

  constructor(opts: ShipOptions) {
    this.faction = opts.faction;
    this.fireSound = opts.fireSound;
    this.maxHp = opts.maxHp;
    this.hp = opts.maxHp;
    this.hitRadius = opts.hitRadius ?? GameConfig.combat.shipHitRadius;
    this.laserDamage = opts.laserDamage ?? GameConfig.combat.laserDamage;
    this.respawnDelayMs = opts.respawnDelayMs;
    this.startMissileAmmo = opts.startMissileAmmo;
    this.missileAmmo = opts.startMissileAmmo;
    this.cfg = opts.movement;
    this.muzzles = opts.muzzles ?? opts.movement.muzzles;
  }

  // ---------- DamageTarget ----------

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, nowMs: number): void {
    if (!this.isAlive) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.die(nowMs);
    }
  }

  private die(nowMs: number): void {
    this.deathTimeMs = nowMs;
    this.velocity.set(0, 0, 0);
  }

  shouldRespawn(nowMs: number): boolean {
    return (
      this.deathTimeMs !== null && nowMs - this.deathTimeMs >= this.respawnDelayMs
    );
  }

  /** Reset to full HP at the given spawn pose (views re-enable off isAlive). */
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
    this.bankAngle = 0;
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
    const turnRate = clamp(turn, -1, 1);
    this.rotationY += turnRate * cfg.rotationSpeed * deltaSeconds;

    // Visual bank: smoothly roll toward the turn direction (cosmetic only).
    const targetBank = turnRate * GameConfig.bank.maxAngle;
    this.bankAngle += (targetBank - this.bankAngle) * exponentialDecay(GameConfig.bank.rate, deltaSeconds);

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
    // (No visual sync here — a ShipView reads this ship as a ShipPose each
    // frame; the sim never touches scene nodes.)

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

    const muzzles = this.muzzles;
    if (muzzles.length === 0) return [];

    const positions: Vector3[] = [];
    if (this.cfg.fireMode === "salvo") {
      for (const m of muzzles) {
        positions.push(this.worldFromLocal(m.x, m.y, m.z, new Vector3()));
      }
    } else {
      const m = muzzles[this.nextMuzzleIdx];
      this.nextMuzzleIdx = (this.nextMuzzleIdx + 1) % muzzles.length;
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

  /** This ship's velocity cap (units/sec) — its movement profile's maxSpeed. */
  get maxSpeed(): number {
    return this.cfg.maxSpeed;
  }
}
