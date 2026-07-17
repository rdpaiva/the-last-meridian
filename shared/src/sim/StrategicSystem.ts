import { GameConfig } from "../GameConfig";
import { CaptureStation } from "./CaptureStation";
import type { Faction } from "../Faction";
import type { Ship } from "./Ship";
import type { Mothership } from "./Mothership";
import type { SensorSystem } from "../SensorSystem";
import type { SimEventBus } from "./SimEvents";

/**
 * One combat seat as the strategic layer sees it — structurally satisfied by
 * BOTH loops' combatant entries (BattleSim.SimCombatant and solo Game's).
 * `launch` non-null and incomplete = the catapult still owns the ship, so it
 * can't dock-capture (the storm-zap exemption pattern).
 */
export interface StrategicSeat {
  ship: Ship;
  launch: { isComplete: boolean } | null;
}

const FACTIONS: readonly Faction[] = ["humans", "machines"];

/**
 * The strategic layer's tick — SIM only (M2, docs/strategic-layer-plan.md):
 * capture stations, the per-faction Energy pools they feed, the automatic
 * upgrade thresholds Energy crosses, and the application of every strategic
 * EFFECT onto the plain sim systems. Owned and ticked by both loops
 * (BattleSim.advance and solo Game.advanceSim) at the same fixed point:
 * after storm zaps, before death/respawn.
 *
 * Map contract (the storms pattern): stations come from
 * GameConfig.stations.placements, which is EMPTY on stock config — no
 * placements means `active` is false, capture/energy never run, and the
 * headless smoke baseline is untouched. Effects application still runs
 * (see below) so the hangar-destroyed respawn penalty works on every map.
 *
 * EFFECTS are applied DECLARATIVELY each tick — recomputed from their source
 * flags rather than written on events — so multiple writers compose and
 * reversals (a repaired hangar) heal automatically:
 *  - Ship.respawnDelayScale = hangarPenalty(faction) × respawnUpgrade(faction)
 *  - SensorSystem.rangeScale[faction] = sensorBoost unlocked ? boost : 1
 *  - "subsystemRepair" is the one genuine one-shot: on unlock it revives this
 *    faction's shield generators + hangar (resetting their death latches, so
 *    re-destroying them announces again).
 *
 * Deterministic: no RNG, no allocation in update.
 */
export class StrategicSystem {
  /** The map's stations (empty = the whole capture/energy layer is inert). */
  readonly stations: ReadonlyArray<CaptureStation>;
  /** Cumulative faction Energy (never spent in v1 — thresholds are gates). */
  readonly energy: Record<Faction, number> = { humans: 0, machines: 0 };
  /** Thresholds crossed so far per faction (index into energy.thresholds). */
  readonly tier: Record<Faction, number> = { humans: 0, machines: 0 };

  constructor(
    private readonly events: SimEventBus,
    arenaHalfX: number,
    arenaHalfZ: number,
  ) {
    this.stations = GameConfig.stations.placements.map(
      (p, i) => new CaptureStation(i, p.xFrac * arenaHalfX, p.zFrac * arenaHalfZ),
    );
  }

  /** False on maps without stations — capture/energy sections short-circuit. */
  get active(): boolean {
    return this.stations.length > 0;
  }

  /**
   * Advance the strategic layer one step. `seats` is the full combatant list
   * (both factions, alive or dead — dead ships still need their respawn
   * scale maintained); `sensors`/`motherships` receive the effects.
   */
  update(
    dt: number,
    seats: ReadonlyArray<StrategicSeat>,
    sensors: SensorSystem,
    motherships: Record<Faction, Mothership>,
  ): void {
    if (this.active) {
      this.updateStations(dt, seats);
      this.accrueAndUnlock(dt, motherships);
    }
    this.applyEffects(seats, sensors, motherships);
  }

  /** Docked-presence counts per station → capture meters → events. */
  private updateStations(dt: number, seats: ReadonlyArray<StrategicSeat>): void {
    const cfg = GameConfig.stations;
    for (const station of this.stations) {
      let humansDocked = 0;
      let machinesDocked = 0;
      for (const seat of seats) {
        const ship = seat.ship;
        if (!ship.isAlive) continue;
        if (seat.launch && !seat.launch.isComplete) continue; // mid-catapult
        if (ship.speed > cfg.dockMaxSpeed) continue; // fly-throughs don't dock
        const dx = ship.position.x - station.position.x;
        const dz = ship.position.z - station.position.z;
        if (dx * dx + dz * dz > station.radius * station.radius) continue;
        if (ship.faction === "humans") humansDocked++;
        else machinesDocked++;
      }
      const change = station.update(dt, humansDocked, machinesDocked);
      if (change === "captured" && station.owner) {
        this.events.emit("stationCaptured", { station, faction: station.owner });
      } else if (change === "neutralized" && station.capturingFaction) {
        this.events.emit("stationNeutralized", {
          station,
          faction: station.capturingFaction,
        });
      }
    }
  }

  /** Owned stations trickle Energy; crossed thresholds unlock in order. */
  private accrueAndUnlock(
    dt: number,
    motherships: Record<Faction, Mothership>,
  ): void {
    const rate = GameConfig.stations.energyPerSec;
    for (const station of this.stations) {
      if (station.owner) this.energy[station.owner] += rate * dt;
    }
    const thresholds = GameConfig.energy.thresholds;
    for (const f of FACTIONS) {
      while (
        this.tier[f] < thresholds.length &&
        this.energy[f] >= thresholds[this.tier[f]].cost
      ) {
        const unlocked = thresholds[this.tier[f]];
        this.tier[f]++;
        if (unlocked.effect === "subsystemRepair") this.repairSubsystems(motherships[f]);
        this.events.emit("upgradeUnlocked", {
          faction: f,
          tier: this.tier[f],
          effect: unlocked.effect,
        });
      }
    }
  }

  /** Has `faction` unlocked a threshold carrying `effect` yet? */
  private hasEffect(
    faction: Faction,
    effect: "fasterRespawn" | "sensorBoost" | "subsystemRepair",
  ): boolean {
    const thresholds = GameConfig.energy.thresholds;
    for (let i = 0; i < this.tier[faction]; i++) {
      if (thresholds[i].effect === effect) return true;
    }
    return false;
  }

  /**
   * The one-shot "subsystemRepair" unlock: revive/refill this faction's
   * shield generators + hangar and RE-ARM their death latches, so the view
   * un-stumps them and a re-destruction announces again.
   */
  private repairSubsystems(carrier: Mothership): void {
    if (!carrier.isAlive) return; // no ghost repairs after the carrier falls
    const frac = GameConfig.energy.repairHpFrac;
    for (const sub of carrier.subsystems) {
      sub.hp = Math.max(sub.hp, sub.maxHp * frac);
      if (sub.isAlive) sub.explosionFired = false;
    }
  }

  /**
   * Declarative per-tick effect application (runs even with no stations, so
   * the hangar respawn penalty holds on station-free maps).
   */
  private applyEffects(
    seats: ReadonlyArray<StrategicSeat>,
    sensors: SensorSystem,
    motherships: Record<Faction, Mothership>,
  ): void {
    const subsCfg = GameConfig.mothership.subsystems;
    const energyCfg = GameConfig.energy;
    for (const f of FACTIONS) {
      sensors.rangeScale[f] = this.hasEffect(f, "sensorBoost")
        ? energyCfg.sensorRangeScale
        : 1;
    }
    const scaleHumans = this.respawnScale("humans", motherships, subsCfg, energyCfg);
    const scaleMachines = this.respawnScale("machines", motherships, subsCfg, energyCfg);
    for (const seat of seats) {
      seat.ship.respawnDelayScale =
        seat.ship.faction === "humans" ? scaleHumans : scaleMachines;
    }
  }

  private respawnScale(
    f: Faction,
    motherships: Record<Faction, Mothership>,
    subsCfg: typeof GameConfig.mothership.subsystems,
    energyCfg: typeof GameConfig.energy,
  ): number {
    const hangarPenalty = motherships[f].hangarAlive
      ? 1
      : subsCfg.hangar.destroyedRespawnDelayScale;
    const upgrade = this.hasEffect(f, "fasterRespawn")
      ? energyCfg.fasterRespawnScale
      : 1;
    return hangarPenalty * upgrade;
  }
}
