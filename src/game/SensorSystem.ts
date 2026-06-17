import { GameConfig } from "./GameConfig";
import { opposing, type Faction } from "./Faction";
import type { Ship } from "./sim/Ship";
import type { Mothership } from "./sim/Mothership";

/** A circular X/Z region that hides ships from radar (a combat nebula). */
export interface ConcealmentZone {
  x: number;
  z: number;
  radius: number;
}

/**
 * One faction's track on one opposing ship. The contact's `position` is the
 * LAST-KNOWN position — it follows the real ship only while the track is
 * fresh, then freezes where contact was lost. AIControllers aim at this (so
 * they chase ghosts and search last-known positions, never ground truth), and
 * the radar draws it (fresh = solid blip, stale = fading ghost).
 */
export class SensorContact {
  /** Last-known X/Z. Frozen the moment the track goes stale. */
  readonly position = { x: 0, z: 0 };
  /** Wall-clock ms of the most recent positive detection. */
  lastSeenMs = -Infinity;
  /** True while the ship is currently detected (a live track). */
  fresh = false;
  /** Maintained by SensorSystem: fresh OR lost less than memorySec ago. */
  trackable = false;

  constructor(readonly ship: Ship) {}

  /**
   * Targetable by an AIController: the ship lives AND the track hasn't
   * expired. Dead ships drop instantly (an explosion is observable), and an
   * expired track means this side has lost them. Named to mirror
   * DamageTarget's isAlive so contacts slot into the same nearest-target
   * scans that used to run over Ships directly.
   */
  get isAlive(): boolean {
    return this.ship.isAlive && this.trackable;
  }
}

/**
 * Per-faction sensor picture — the keystone of the stealth loop. Each faction
 * shares one contact list (squadrons pool sensor data): an opposing ship is
 * DETECTED while it sits within sensor range of any live friendly fighter or
 * the friendly carrier (the long-range AWACS). Lose detection and the track
 * decays into a last-known-position ghost for `sensors.memorySec`, then
 * expires.
 *
 * Concealment (combat nebulas): a ship inside a `ConcealmentZone` is
 * invisible to RADAR entirely — fighters only pick it up inside the short
 * unconditional `visualRange` (you can't be invisible in a knife fight), and
 * the carrier's sweep never sees it. A fighter sitting in a cloud also has
 * its OWN radar degraded by `nebulaSensorFactor` — hiding costs awareness.
 *
 * Detection SWEEPS run on a throttle (`sweepIntervalSec`); fresh contacts'
 * positions are re-copied every frame so an AI's aim point doesn't lag a
 * sweep behind a fast target.
 *
 * Both factions run through identical rules — the player hides from the
 * machines exactly the way machines hide from the player's wing.
 */
export class SensorSystem {
  /** Persistent track tables: faction → (opposing ship → its track). */
  private readonly tracks: Record<Faction, Map<Ship, SensorContact>> = {
    humans: new Map(),
    machines: new Map(),
  };

  /**
   * Per-faction contact lists (what that faction currently knows about),
   * rebuilt in place each frame — ControllerWorld holds these by reference.
   * Contains fresh tracks AND unexpired ghosts; expired tracks are dropped.
   */
  readonly contacts: Record<Faction, SensorContact[]> = {
    humans: [],
    machines: [],
  };

  /**
   * Combat-nebula footprints. Wired by Game once the scenery is built; held
   * by reference (empty until then, which simply disables concealment).
   */
  concealmentZones: ReadonlyArray<ConcealmentZone> = [];

  private nextSweepMs = 0;

  constructor(private readonly motherships: Record<Faction, Mothership>) {}

  /**
   * Does `faction` currently hold a FRESH track on `ship`? Drives the HUD's
   * DETECTED/HIDDEN cue (asked about the ENEMY faction tracking the player).
   */
  isTracked(faction: Faction, ship: Ship): boolean {
    const contact = this.tracks[faction].get(ship);
    return !!contact && contact.fresh && ship.isAlive;
  }

  /** True when a position sits inside any concealment zone (combat nebula). */
  isConcealed(pos: { x: number; z: number }): boolean {
    for (const zone of this.concealmentZones) {
      const dx = pos.x - zone.x;
      const dz = pos.z - zone.z;
      if (dx * dx + dz * dz <= zone.radius * zone.radius) return true;
    }
    return false;
  }

  update(nowMs: number, shipsByFaction: Record<Faction, Ship[]>): void {
    const sweep = nowMs >= this.nextSweepMs;
    if (sweep) {
      this.nextSweepMs = nowMs + GameConfig.sensors.sweepIntervalSec * 1000;
    }
    this.updateFaction("humans", nowMs, shipsByFaction, sweep);
    this.updateFaction("machines", nowMs, shipsByFaction, sweep);
  }

  private updateFaction(
    faction: Faction,
    nowMs: number,
    shipsByFaction: Record<Faction, Ship[]>,
    sweep: boolean,
  ): void {
    const cfg = GameConfig.sensors;
    const table = this.tracks[faction];
    const targets = shipsByFaction[opposing(faction)];
    const friendlies = shipsByFaction[faction];

    if (sweep) {
      for (const target of targets) {
        if (!target.isAlive) continue; // dead ships handled in the prune below
        let contact = table.get(target);
        if (!contact) {
          contact = new SensorContact(target);
          table.set(target, contact);
        }
        if (this.detect(faction, friendlies, target)) {
          contact.fresh = true;
          contact.lastSeenMs = nowMs;
        } else {
          contact.fresh = false;
        }
      }
    }

    // Per-frame: track fresh positions, age out stale tracks, rebuild the
    // public contact list in place.
    const memoryMs = cfg.memorySec * 1000;
    const out = this.contacts[faction];
    out.length = 0;
    for (const contact of table.values()) {
      if (!contact.ship.isAlive) {
        // Death is observable (the explosion) — drop the track immediately.
        // It re-forms from scratch if the ship respawns and is re-detected.
        contact.fresh = false;
        contact.trackable = false;
        continue;
      }
      if (contact.fresh) {
        contact.position.x = contact.ship.position.x;
        contact.position.z = contact.ship.position.z;
      }
      contact.trackable = contact.fresh || nowMs - contact.lastSeenMs < memoryMs;
      if (contact.trackable) out.push(contact);
    }
  }

  /** Can `faction` currently detect `target`? (One sweep's rules.) */
  private detect(faction: Faction, friendlies: Ship[], target: Ship): boolean {
    const cfg = GameConfig.sensors;
    const concealed = this.isConcealed(target.position);
    const tx = target.position.x;
    const tz = target.position.z;

    // The carrier's long-range sweep — blind to concealed ships (radar only).
    const home = this.motherships[faction];
    if (!concealed && home.isAlive) {
      const dx = tx - home.position.x;
      const dz = tz - home.position.z;
      if (dx * dx + dz * dz <= cfg.mothershipRange * cfg.mothershipRange) {
        return true;
      }
    }

    for (const f of friendlies) {
      if (!f.isAlive) continue;
      // A fighter parked in a cloud has degraded radar of its own; eyeballs
      // (visualRange) always work. A concealed TARGET only shows to eyeballs.
      const radarRange = this.isConcealed(f.position)
        ? cfg.shipRange * cfg.nebulaSensorFactor
        : cfg.shipRange;
      const range = concealed ? cfg.visualRange : radarRange;
      const dx = tx - f.position.x;
      const dz = tz - f.position.z;
      if (dx * dx + dz * dz <= range * range) return true;
    }
    return false;
  }
}
