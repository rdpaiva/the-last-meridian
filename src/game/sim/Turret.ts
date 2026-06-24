import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import { wrapAngle } from "../math";
import type { DamageTarget } from "../types";
import type { SensorContact } from "../SensorSystem";

/**
 * A request to spawn one turret bolt this tick. The caller (Game.advanceSim /
 * the headless harness) owns the faction LaserSystem and does the spawning, so
 * the Turret never references it — keeping the sim modules free of a
 * construction-order coupling and trivially testable.
 */
export interface TurretFireCommand {
  /** World-space muzzle position the bolt emanates from. */
  origin: Vector3;
  /** Bolt heading (radians); world forward at 0 is +Z, as everywhere else. */
  rotationY: number;
  /** Per-bolt damage (the turret's configured value). */
  damage: number;
}

/**
 * A carrier defensive gun turret — SIM only (the sim half of the Turret/
 * TurretView split, docs/MULTIPLAYER.md Phase 0). It runs anywhere: the
 * browser, the headless smoke harness, and (Phase 1) the server. Its Babylon
 * depiction is a client-side TurretView (src/game/view/TurretView.ts) that
 * reads this object's `aimAngle`/`isAlive` to swing its barrel.
 *
 * It is BOTH a sub-emitter and a DamageTarget:
 *  - it auto-tracks the nearest FRESH sensor contact (its faction's picture,
 *    never ground truth — so a ship hiding in a combat nebula is invisible to
 *    the flak) within range + arc, and fires bolts into the carrier's own
 *    faction LaserSystem via the fire commands `update()` returns;
 *  - it has its OWN hp pool (separate from the carrier), so it can be shot off
 *    the hull — destroying it silences that gun without touching the objective.
 *
 * The carrier is static (position + rotationY never change), so the turret's
 * world mount position is computed once. Aim, cooldown, and hp are the only
 * mutable state — small and bounded, exactly what Phase 1 replicates as carrier
 * sub-state. No `Math.random` (deterministic / server-clean): the initial
 * cooldown stagger is derived from the mount index so turrets don't volley in
 * lockstep.
 */
export class Turret implements DamageTarget {
  /** World-space mount position (Y at deck level). DamageTarget contract. */
  readonly position: Vector3;
  readonly hitRadius: number = GameConfig.mothership.turrets.hitRadius;
  readonly maxHp: number = GameConfig.mothership.turrets.hp;
  hp: number = GameConfig.mothership.turrets.hp;

  /** Latch so the death FX fires once (mirrors Ship.explosionFired). */
  explosionFired = false;

  /** Current barrel heading (radians, world). The view reads this each frame. */
  aimAngle: number;

  /** World center of the slew arc + idle pose. */
  private readonly restAngle: number;
  /** Half-arc (radians) the barrel may slew from `restAngle`. */
  private readonly arcHalf: number;
  /** Seconds until this turret may fire again. */
  private cooldown: number;
  /** Local pivot→muzzle distance; overridable from the GLB (setMuzzleData). */
  private muzzleForward: number = GameConfig.mothership.turrets.muzzleForward;
  /**
   * World Y the bolt spawns at — the barrel-tip height read off the GLB muzzle
   * (setMuzzleData). Null = spawn at the turret's own Y (the procedural
   * fallback). Purely visual: weapon collision is X/Z, so this never touches
   * the headless sim baseline.
   */
  private muzzleHeight: number | null = null;

  constructor(
    private readonly carrierAlive: () => boolean,
    worldX: number,
    worldY: number,
    worldZ: number,
    restAngle: number,
    arcHalf: number,
    mountIndex: number,
    mountCount: number,
  ) {
    this.position = new Vector3(worldX, worldY, worldZ);
    this.restAngle = restAngle;
    this.arcHalf = arcHalf;
    this.aimAngle = restAngle;
    // Deterministic stagger so the battery doesn't fire as one volley.
    const cfg = GameConfig.mothership.turrets;
    this.cooldown =
      mountCount > 0 ? (cfg.fireCooldownSec * mountIndex) / mountCount : 0;
  }

  // ─── DamageTarget ─────────────────────────────────────────────────────────

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, _nowMs: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
  }

  // ─── GLB geometry feedback (mirrors Mothership.setModelLaunchData) ─────────

  /**
   * Override the pivot→muzzle distance with the value the view measured off the
   * turret GLB's `muzzle` empty. Keeps the config procedural fallback until a
   * model supplies a real fire point.
   */
  setMuzzleData(forward: number, height?: number): void {
    if (Number.isFinite(forward) && forward > 0) this.muzzleForward = forward;
    if (height !== undefined && Number.isFinite(height)) this.muzzleHeight = height;
  }

  // ─── Per-tick sim ─────────────────────────────────────────────────────────

  /**
   * Advance the turret one step: pick the nearest fresh enemy contact in range
   * + arc, slew toward it, and (when aligned, in range, and off cooldown)
   * return a fire command. Returns null when there is nothing to shoot or the
   * gun isn't ready. `contacts` is the OWNING faction's sensor picture.
   */
  update(
    deltaSeconds: number,
    contacts: readonly SensorContact[],
    _nowMs: number,
  ): TurretFireCommand | null {
    if (this.cooldown > 0) this.cooldown -= deltaSeconds;

    // Dead turret or dead carrier → idle (no slew, no fire). A destroyed
    // turret simply reports isAlive=false to the weapon systems and is skipped.
    if (!this.isAlive || !this.carrierAlive()) return null;

    const cfg = GameConfig.mothership.turrets;
    const rangeSq = cfg.range * cfg.range;

    // Acquire: nearest FRESH track in range whose bearing is inside the arc.
    let bestSq = rangeSq;
    let bestAngle = 0;
    let hasTarget = false;
    for (const contact of contacts) {
      if (!contact.fresh) continue; // ghosts/last-known don't draw flak
      const dx = contact.position.x - this.position.x;
      const dz = contact.position.z - this.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > bestSq) continue;
      const bearing = Math.atan2(dx, dz);
      if (Math.abs(wrapAngle(bearing - this.restAngle)) > this.arcHalf) continue;
      bestSq = distSq;
      bestAngle = bearing;
      hasTarget = true;
    }

    if (!hasTarget) return null;

    // Slew toward the target bearing at the configured rate (shortest path),
    // clamped to the arc so a wrapped step can't escape past the limit.
    const toTarget = wrapAngle(bestAngle - this.aimAngle);
    const maxStep = cfg.turnRate * deltaSeconds;
    const step = Math.max(-maxStep, Math.min(maxStep, toTarget));
    this.aimAngle = clampToArc(
      this.aimAngle + step,
      this.restAngle,
      this.arcHalf,
    );

    // Fire when lined up + off cooldown (range was already checked above).
    if (this.cooldown > 0) return null;
    if (Math.abs(wrapAngle(bestAngle - this.aimAngle)) > cfg.aimTolerance) {
      return null;
    }
    this.cooldown = cfg.fireCooldownSec;
    const origin = new Vector3(
      this.position.x + Math.sin(this.aimAngle) * this.muzzleForward,
      this.muzzleHeight ?? this.position.y,
      this.position.z + Math.cos(this.aimAngle) * this.muzzleForward,
    );
    return { origin, rotationY: this.aimAngle, damage: cfg.damage };
  }
}

/** Clamp `angle` to within ±`half` of `center` (all radians, shortest-path). */
function clampToArc(angle: number, center: number, half: number): number {
  const off = wrapAngle(angle - center);
  if (off > half) return center + half;
  if (off < -half) return center - half;
  return angle;
}
