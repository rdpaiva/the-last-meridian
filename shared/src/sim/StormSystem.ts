import { GameConfig } from "../GameConfig";
import type { ConcealmentZone } from "../SensorSystem";
import type { AvoidObstacle } from "../ShipController";
import type { Ship } from "./Ship";
import { computeStormZones } from "./StormZones";

/**
 * Ion-storm damage sim (GameConfig.storms): a ship inside a storm zone takes
 * a discrete ZAP every zapIntervalSec — the first the moment it enters, so
 * the cloud's bite is legible immediately. Mirrors the asteroid ram-damage
 * pattern (per-ship cooldown map + takeDamage); the caller (Game / BattleSim)
 * loops its combatants, calls tryZap, and emits the `stormZap` SimEvent on a
 * landed zap so the client can crack lightning at the victim.
 *
 * Also owns the storms' two derived gameplay surfaces:
 *  - `zones` — the world-space footprints (StormZones math). The caller
 *    appends these to SensorSystem.concealmentZones, which is what makes
 *    hiding in a storm break radar tracks (the hurt-to-hide tradeoff).
 *  - `obstacles` — one AvoidObstacle per zone (radius + avoidanceMargin),
 *    fed into the shared AI steering list so pilots route around storm banks
 *    instead of shredding themselves. This is what lets maps use storms as
 *    soft walls that carve navigation lanes.
 *
 * Zero-zone construction (the stock config) is a complete no-op — the
 * headless smoke baseline is unaffected.
 */
export class StormSystem {
  /** World-space storm footprints (damage + concealment + radar truth). */
  readonly zones: ConcealmentZone[];
  /** AI keep-out circles (zone radius + storms.avoidanceMargin), static. */
  readonly obstacles: AvoidObstacle[];

  /** Per-ship sim-clock timestamp of the last zap (the ram-cooldown pattern). */
  private readonly lastZapMs = new Map<Ship, number>();

  constructor(arenaHalfWidth: number, arenaHalfDepth: number) {
    this.zones = computeStormZones(arenaHalfWidth, arenaHalfDepth);
    const margin = GameConfig.storms.avoidanceMargin;
    this.obstacles = this.zones.map((zone) => ({
      position: { x: zone.x, z: zone.z },
      radius: zone.radius + margin,
      isAlive: true,
    }));
  }

  /** Whether the active map placed any storms (false = every call no-ops). */
  get hasZones(): boolean {
    return this.zones.length > 0;
  }

  /** True when a position sits inside any storm zone. */
  contains(x: number, z: number): boolean {
    for (const zone of this.zones) {
      const dx = x - zone.x;
      const dz = z - zone.z;
      if (dx * dx + dz * dz <= zone.radius * zone.radius) return true;
    }
    return false;
  }

  /**
   * Apply the periodic storm zap to one ship. Returns true when a zap landed
   * THIS call — the caller emits the `stormZap` SimEvent (and any FX) off it.
   * A storm kill awards no kill credit by design: the death flows through the
   * normal shipDied bookkeeping, but no weapon hit means no attribution.
   */
  tryZap(ship: Ship, nowMs: number): boolean {
    if (!ship.isAlive || this.zones.length === 0) return false;
    if (!this.contains(ship.position.x, ship.position.z)) return false;
    const intervalMs = GameConfig.storms.zapIntervalSec * 1000;
    const last = this.lastZapMs.get(ship) ?? -Infinity;
    if (nowMs - last < intervalMs) return false;
    // The cooldown key survives leaving the cloud, so darting out and back
    // in can't reset the cadence for a free instant zap.
    this.lastZapMs.set(ship, nowMs);
    ship.takeDamage(GameConfig.storms.zapDamage, nowMs);
    return true;
  }
}
