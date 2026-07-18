import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import type { DamageTarget } from "../types";

/** The named subsystem kinds a carrier can mount (see GameConfig.mothership.subsystems). */
export type SubsystemKind = "hangar";

/**
 * A destructible mothership SUBSYSTEM mount — SIM only (the Turret pattern
 * minus the gun; see sim/Turret.ts). It runs anywhere: the browser, the
 * headless smoke harness, and the server. Its Babylon depiction is a
 * client-side SubsystemView that reads this object's `position`/`hp` each
 * frame.
 *
 * One subsystem exists per configured mount, each with its OWN hp pool
 * (owner call 2026-07-18: the hangar's two bays are INDEPENDENT — shooting
 * one out leaves the other launching). What losing mounts means is the
 * owner's business, not this class's:
 *  - "hangar": the faction's respawn delay GRADUATES with destroyed bays —
 *    1 → destroyedRespawnDelayScale as dead/total climbs (applied
 *    declaratively by StrategicSystem), and respawn launches re-route to
 *    surviving bays (Mothership.getLiveLaunchBayIndices). Nothing repairs a
 *    bay (T3 became turret overdrive 2026-07-18).
 * (Carrier SHIELDS are not a subsystem: they're powered by capture-station
 * ownership — Mothership.stationShieldFactor, written by StrategicSystem.)
 *
 * The carrier is static, so the world mount position is computed once by the
 * owning Mothership. HP is the only mutable state — exactly what the server
 * replicates as carrier sub-state (hangar0Hp/hangar1Hp, index-aligned with
 * the mounts array). Deterministic: no RNG anywhere.
 */
export class MothershipSubsystem implements DamageTarget {
  /** World-space mount position (Y at deck level). DamageTarget contract. */
  readonly position: Vector3;
  readonly hitRadius: number;
  readonly maxHp: number;
  hp: number;

  /** Latch so the death FX/effect fires once (mirrors Turret.explosionFired). */
  explosionFired = false;

  constructor(
    readonly kind: SubsystemKind,
    worldX: number,
    worldY: number,
    worldZ: number,
  ) {
    const cfg = GameConfig.mothership.subsystems[kind];
    this.position = new Vector3(worldX, worldY, worldZ);
    this.hitRadius = cfg.hitRadius;
    this.maxHp = cfg.hp;
    this.hp = cfg.hp;
  }

  // ─── DamageTarget ─────────────────────────────────────────────────────────

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, _nowMs: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
  }

  /**
   * Move the mount to the WORLD position the view measured off a carrier GLB
   * empty (future `hangar.*` seam — mirrors Turret.setMountPosition).
   * Mutates the existing Vector3 in place: the subsystem is already registered
   * by reference as a DamageTarget on the opposing weapon systems.
   */
  setMountPosition(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
  }
}
