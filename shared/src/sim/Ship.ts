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
  /**
   * Cannon magazine: total laser rounds (bolts) before the guns run dry. NO
   * passive regen — empty = defenseless on cannons until refilled at the
   * carrier (docs/JUMP-DRIVE-AND-RESUPPLY.md). Each bolt fired spends one.
   */
  cannonAmmo: number;
  /** X/Z collision radius for laser/missile/ram tests (world units). */
  hitRadius: number;
  /** Audio cue when this ship fires its primary guns. */
  fireSound: FireSoundKey;
  /**
   * True for HEAVY craft (gunships — Breaker/Reaver). Pure VIEW hint: its bolts
   * are tinted with the faction's heavy-laser color so a gunship's fire reads
   * distinct from a light fighter's. No sim effect.
   */
  heavy: boolean;
}

export interface ShipOptions {
  faction: Faction;
  maxHp: number;
  /** Delay before Game may respawn this ship after death (ms). */
  respawnDelayMs: number;
  /** Missiles to start/refill with (the ship type's rack — 0 = no rack). */
  startMissileAmmo: number;
  /** Cannon rounds to start/refill with (the ship type's magazine). */
  startCannonAmmo: number;
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
  /** Heavy (gunship) class — tints this ship's bolts with the faction's heavy
   *  laser color. View hint only; defaults to false (light fighter). */
  heavy?: boolean;
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
  /** Heavy (gunship) class — its bolts are tinted with the faction's heavy
   *  laser color (LaserSystemView). View hint only; no sim effect. */
  readonly heavy: boolean;

  /**
   * DEBUG/test cheats (client-only — the player's god-mode toggle, see
   * Game.toggleGodMode). `debugInvulnerable` makes takeDamage a no-op;
   * `debugSpeedMultiplier` scales thrust + speed cap. Both default to the
   * no-op identity (false / 1), so a stock ship — and the headless sim
   * baseline — is unaffected. A multiplayer server would never set these.
   */
  debugInvulnerable = false;
  debugSpeedMultiplier = 1;

  /** Remaining heat-seeking missiles. Refills to startMissileAmmo on respawn. */
  missileAmmo: number;
  private missileCooldownRemainingMs = 0;

  /** Remaining cannon rounds. Refills to startCannonAmmo on respawn/service. */
  cannonAmmo: number;
  /** Cannon magazine capacity (for HUD fraction + service refill cap). */
  readonly maxCannonAmmo: number;

  /**
   * Jump-drive recall state machine (docs/JUMP-DRIVE-AND-RESUPPLY.md):
   *   idle      — drive ready (cooldown elapsed); a jump intent starts a spool.
   *   spooling  — counting down jumpSpoolRemainingMs; fly/fight freely, enemy
   *               fire can't interrupt. Completing teleports home; a pilot
   *               cancel (outside the commit window) aborts it.
   *   cooldown  — recharging after EITHER a completed jump OR a cancel; jump
   *               intents are inert until jumpCooldownRemainingMs hits 0.
   * All timers tick on dt (no wall clock), so the sim stays deterministic.
   */
  jumpState: "idle" | "spooling" | "cooldown" = "idle";
  private jumpSpoolRemainingMs = 0;
  private jumpCooldownRemainingMs = 0;

  private readonly cfg: ShipMovementConfig;
  private readonly respawnDelayMs: number;
  private readonly startMissileAmmo: number;
  private readonly startCannonAmmo: number;

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

  /**
   * Snapshot/restore the weapon cooldown timers, for prediction
   * rewind/replay (NetworkGame.reconcile): the replay re-runs MOVEMENT
   * through update(), but update() also drains these timers, so without
   * restoring them every reconciliation double-drains the fire cadence —
   * the local fire rate audibly speeds up and down with the pending-input
   * count. Cadence is real-time state, not rewindable motion state.
   */
  saveWeaponTimers(): { fireMs: number; missileMs: number } {
    return {
      fireMs: this.fireCooldownRemainingMs,
      missileMs: this.missileCooldownRemainingMs,
    };
  }

  restoreWeaponTimers(t: { fireMs: number; missileMs: number }): void {
    this.fireCooldownRemainingMs = t.fireMs;
    this.missileCooldownRemainingMs = t.missileMs;
  }

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
    this.heavy = opts.heavy ?? false;
    this.respawnDelayMs = opts.respawnDelayMs;
    this.startMissileAmmo = opts.startMissileAmmo;
    this.missileAmmo = opts.startMissileAmmo;
    this.startCannonAmmo = opts.startCannonAmmo;
    this.cannonAmmo = opts.startCannonAmmo;
    this.maxCannonAmmo = opts.startCannonAmmo;
    this.cfg = opts.movement;
    this.muzzles = opts.muzzles ?? opts.movement.muzzles;
  }

  // ---------- DamageTarget ----------

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, nowMs: number): void {
    if (!this.isAlive) return;
    if (this.debugInvulnerable) return; // god-mode test cheat: shrug it off
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.die(nowMs);
    }
  }

  private die(nowMs: number): void {
    this.deathTimeMs = nowMs;
    this.velocity.set(0, 0, 0);
    // Dying mid-spool aborts the jump (so the sensor signature clears and the
    // ship doesn't "arrive" dead). respawn() fully resets the drive.
    this.jumpState = "idle";
    this.jumpSpoolRemainingMs = 0;
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
    this.cannonAmmo = this.startCannonAmmo;
    this.nextMuzzleIdx = 0;
    this.bankAngle = 0;
    this.jumpState = "idle";
    this.jumpSpoolRemainingMs = 0;
    this.jumpCooldownRemainingMs = 0;
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

    // --- Acceleration --- (debugSpeedMultiplier = 1 normally; the god-mode
    // test cheat scales thrust + the speed cap below to blaze through a match.)
    const sm = this.debugSpeedMultiplier;
    const fwd = this.forward();
    if (input.thrust) {
      this.velocity.x += fwd.x * cfg.thrust * sm * deltaSeconds;
      this.velocity.z += fwd.z * cfg.thrust * sm * deltaSeconds;
    }
    if (input.reverse) {
      this.velocity.x -= fwd.x * cfg.reverseThrust * sm * deltaSeconds;
      this.velocity.z -= fwd.z * cfg.reverseThrust * sm * deltaSeconds;
    }

    // --- Strafe (lateral thrust; heading unchanged) ---
    if (input.strafeLeft || input.strafeRight) {
      const right = this.right();
      const dir = (input.strafeRight ? 1 : 0) - (input.strafeLeft ? 1 : 0);
      this.velocity.x += right.x * dir * cfg.strafeThrust * sm * deltaSeconds;
      this.velocity.z += right.z * dir * cfg.strafeThrust * sm * deltaSeconds;
    }

    // --- Drag (frame-rate independent exponential decay) ---
    const dragFactor = exponentialMultiplier(cfg.dragRate, deltaSeconds);
    this.velocity.x *= dragFactor;
    this.velocity.z *= dragFactor;

    // --- Speed cap ---
    const speedSq =
      this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    const maxSpeed = cfg.maxSpeed * sm;
    const maxSpeedSq = maxSpeed * maxSpeed;
    if (speedSq > maxSpeedSq) {
      const scale = maxSpeed / Math.sqrt(speedSq);
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
    // Out of cannon rounds = defenseless on the guns; the only recourse is to
    // return to the carrier and rearm (docs/JUMP-DRIVE-AND-RESUPPLY.md). The
    // `< 1` (vs `<= 0`) gate needs a WHOLE round in the drum — identical for
    // the integer magazines, correct once service refills fractional rounds.
    if (this.cannonAmmo < 1) return [];

    const muzzles = this.muzzles;
    if (muzzles.length === 0) return [];

    this.fireCooldownRemainingMs = this.cfg.fireCooldownMs;

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
    // Each bolt is a visible fraction of the drum — spend one round per bolt.
    this.cannonAmmo = Math.max(0, this.cannonAmmo - positions.length);
    return positions;
  }

  /**
   * Attempts to launch a heat-seeking missile. Returns the world-space spawn
   * position (along the nose), or null when on cooldown or out of ammo.
   */
  tryFireMissile(): Vector3 | null {
    if (this.missileCooldownRemainingMs > 0 || this.missileAmmo < 1) {
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
   * Replenish HP + cannon/missile ammo while DOCKED in a carrier service
   * bubble. The caller gates on proximity + loiter speed (Mothership
   * .serviceZoneContains + a speed check); this just applies the over-time
   * refill, dt-scaled — never instant (the loiter window IS the cost). Values
   * stay fractional between ticks; user-facing readouts round. Returns true if
   * anything was actually topped off, so a view can show a "SERVICING" cue
   * (false = in the zone but already full → "DOCKED").
   * (docs/JUMP-DRIVE-AND-RESUPPLY.md — one service, repair + rearm.)
   */
  serviceTick(deltaSeconds: number): boolean {
    if (!this.isAlive) return false;
    const svc = GameConfig.service;
    let serviced = false;
    if (this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + svc.healPerSec * deltaSeconds);
      serviced = true;
    }
    if (this.cannonAmmo < this.maxCannonAmmo) {
      this.cannonAmmo = Math.min(
        this.maxCannonAmmo,
        this.cannonAmmo + svc.cannonRefillPerSec * deltaSeconds,
      );
      serviced = true;
    }
    if (this.missileAmmo < this.startMissileAmmo) {
      this.missileAmmo = Math.min(
        this.startMissileAmmo,
        this.missileAmmo + svc.missileRefillPerSec * deltaSeconds,
      );
      serviced = true;
    }
    return serviced;
  }

  // ─── Jump drive ───────────────────────────────────────────────────────────

  /** True while the jump drive is spooling (lights up the sensor signature). */
  get isSpoolingJump(): boolean {
    return this.jumpState === "spooling";
  }

  /** True while the drive can't be re-armed (recharging after jump/cancel). */
  get isJumpOnCooldown(): boolean {
    return this.jumpCooldownRemainingMs > 0;
  }

  /**
   * Spool charge fraction: 0 at arm → 1 at the moment of jump-fire. Drives the
   * HUD countdown ring and the radar "how close is he to gone?" filling ring.
   * 0 when not spooling.
   */
  get jumpSpoolProgress(): number {
    if (this.jumpState !== "spooling") return 0;
    const total = GameConfig.jump.spoolMs;
    return total > 0 ? clamp(1 - this.jumpSpoolRemainingMs / total, 0, 1) : 0;
  }

  /**
   * Process a jump-key edge press (InputState.jumpPressed). Toggle semantics:
   *   idle + ready    → arm the drive, begin the spool ("spool-started").
   *   spooling        → cancel (pays the cooldown) UNLESS inside the final
   *                     commit window, where coordinates are locked ("spool-
   *                     cancelled" / null).
   *   cooldown / idle-but-cooling → inert (null).
   * Returns the event the caller should announce on the SimEventBus, or null
   * if the press did nothing.
   */
  onJumpIntent(): "spool-started" | "spool-cancelled" | null {
    if (!this.isAlive) return null;
    if (this.jumpState === "idle" && this.jumpCooldownRemainingMs <= 0) {
      this.jumpState = "spooling";
      this.jumpSpoolRemainingMs = GameConfig.jump.spoolMs;
      return "spool-started";
    }
    if (this.jumpState === "spooling") {
      // "Coordinates locked": no abort inside the final commit window.
      if (this.jumpSpoolRemainingMs > GameConfig.jump.commitMs) {
        this.jumpState = "cooldown";
        this.jumpCooldownRemainingMs = GameConfig.jump.cooldownMs;
        this.jumpSpoolRemainingMs = 0;
        return "spool-cancelled";
      }
    }
    return null;
  }

  /**
   * Advance the jump timers on dt. Returns true on the single frame the spool
   * COMPLETES — the caller then teleports the ship into its carrier's service
   * bubble (jumpTeleport) and announces `jumpFired`. Enemy fire never calls
   * this off; only death (die) or a pilot cancel (onJumpIntent) stops a spool.
   */
  tickJump(deltaSeconds: number): boolean {
    const dtMs = deltaSeconds * 1000;
    if (this.jumpCooldownRemainingMs > 0) {
      this.jumpCooldownRemainingMs = Math.max(0, this.jumpCooldownRemainingMs - dtMs);
      // Drive recharged: return to idle so a fresh jump can be armed again.
      // (Without this the ship is stuck in "cooldown" forever and can only
      // ever jump once.)
      if (this.jumpCooldownRemainingMs === 0 && this.jumpState === "cooldown") {
        this.jumpState = "idle";
      }
    }
    if (this.jumpState === "spooling") {
      this.jumpSpoolRemainingMs -= dtMs;
      if (this.jumpSpoolRemainingMs <= 0) {
        this.jumpSpoolRemainingMs = 0;
        this.jumpState = "cooldown";
        this.jumpCooldownRemainingMs = GameConfig.jump.cooldownMs;
        return true; // FIRED — caller teleports home this frame.
      }
    }
    return false;
  }

  /**
   * Hard-snap into the carrier service bubble when the jump fires. TRANSIT
   * ONLY — HP/ammo are deliberately PRESERVED (arrival services over time, no
   * free top-off; a jumper and a ship that flew in end up identical). Zero
   * velocity like a respawn; the view must treat this as a position
   * discontinuity (snap trails, no interpolation — docs/JUMP-DRIVE-AND-RESUPPLY).
   */
  jumpTeleport(x: number, z: number, rotationY: number): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.rotationY = rotationY;
    this.bankAngle = 0;
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
