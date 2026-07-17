import { GameConfig } from "../GameConfig";
import type { Faction } from "../Faction";

/** What one update step changed, for the owner (StrategicSystem) to announce. */
export type StationChange = "captured" | "neutralized" | null;

/**
 * One neutral capture station — SIM only (strategic layer M2,
 * docs/strategic-layer-plan.md). Runs anywhere: browser, headless harness,
 * server. Its Babylon depiction is a client-side StationView reading
 * `owner`/`capturingFaction`/`progress`/`contested` each frame.
 *
 * Capture model ("docking", the owner's requirement): presence counts are
 * computed by StrategicSystem — a ship inside `stations.captureRadius`
 * flying below `stations.dockMaxSpeed` (alive, clear of its catapult). The
 * capture METER (`progress` 0..1) belongs to `capturingFaction`:
 *
 *  - both factions docked → `contested`, meter frozen;
 *  - one faction docked and it owns the meter → meter climbs at
 *    speedFactor / captureTimeSec (speedFactor = docked count capped at
 *    maxAssistFactor). Full meter: an enemy-owned station NEUTRALIZES
 *    (owner → null, meter resets — flipping enemy ground is two-stage);
 *    a neutral station is CAPTURED (owner → that faction);
 *  - one faction docked against another faction's meter → it DRAINS the
 *    meter at the same rate; at zero the meter changes hands;
 *  - nobody docked → everything holds (ownership persists until contested).
 *
 * Indestructible in v1 (no DamageTarget) — the fight is over the ground, not
 * the structure. Deterministic: no RNG, no allocation in update.
 */
export class CaptureStation {
  /** World-space X/Z (stations sit on the gameplay plane, static). */
  readonly position: { x: number; z: number };
  readonly radius: number = GameConfig.stations.captureRadius;

  owner: Faction | null = null;
  /** Whose capture meter `progress` currently is (null = empty meter). */
  capturingFaction: Faction | null = null;
  /** Capture meter 0..1, owned by `capturingFaction`. */
  progress = 0;
  /** True while both factions are docked (meter frozen). */
  contested = false;

  constructor(
    readonly id: number,
    x: number,
    z: number,
  ) {
    this.position = { x, z };
  }

  /**
   * Advance the capture meter one step from this tick's docked-presence
   * counts. Returns what changed ("captured"/"neutralized") for the caller
   * to announce, or null.
   */
  update(dt: number, humansDocked: number, machinesDocked: number): StationChange {
    const cfg = GameConfig.stations;
    this.contested = humansDocked > 0 && machinesDocked > 0;
    if (this.contested) return null;

    const docked = humansDocked > 0 ? humansDocked : machinesDocked;
    if (docked === 0) return null; // nobody here — everything holds
    const f: Faction = humansDocked > 0 ? "humans" : "machines";
    if (this.owner === f && this.capturingFaction === null) return null; // secure

    const rate = Math.min(docked, cfg.maxAssistFactor) / cfg.captureTimeSec;

    // An empty meter starts filling for whoever is docked (their own station
    // just drains enemy meters — handled below — so this only fires when
    // there's ground to take).
    if (this.capturingFaction === null) {
      if (this.owner === f) return null;
      this.capturingFaction = f;
      this.progress = 0;
    }

    if (this.capturingFaction === f) {
      this.progress += rate * dt;
      if (this.progress < 1) return null;
      this.progress = 0;
      if (this.owner !== null && this.owner !== f) {
        // Stage one of flipping enemy ground: it goes NEUTRAL first.
        this.owner = null;
        // Meter stays with f — stage two (the capture climb) starts clean.
        return "neutralized";
      }
      this.owner = f;
      this.capturingFaction = null;
      return "captured";
    }

    // Enemy meter — drain it; at zero the meter is free (and starts filling
    // for f next step).
    this.progress -= rate * dt;
    if (this.progress <= 0) {
      this.progress = 0;
      this.capturingFaction = null;
    }
    return null;
  }
}
