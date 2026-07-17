import { GameConfig } from "./GameConfig";
import type { AIController } from "./AIController";
import type { Ship } from "./sim/Ship";
import type { ControllerWorld } from "./ShipController";

/** A fleet pilot the commander may re-task: the ship + its AI brain. */
export interface CommandedPilot {
  ship: Ship;
  ai: AIController;
}

/**
 * Lightweight fleet doctrine for the AI side — what makes the enemy read as
 * "doing something intelligent" instead of flying one static order forever.
 * Not a planner: a fixed role split plus a short priority list, re-evaluated
 * every `commander.thinkIntervalSec`.
 *
 * Role split (by spawn order, set once at construction):
 *   - STRIKERS  — the first `strikeCount` ships (the heavies, by fleet
 *                 convention). Permanently on "strike": they ARE the threat
 *                 to the player's mothership. The first striker doubles as
 *                 the fleet's wing leader (ControllerWorld.leader), so…
 *   - ESCORTS   — the next `commander.escortCount` ships fly "cover" on that
 *                 leader: an escorted strike package that breaks to engage
 *                 anything near the heavies, then reforms.
 *   - POOL      — everyone else, re-tasked dynamically each think:
 *       1. carrier threatened (hull dropped since last think, or a contact
 *          near it) → up to `defendCount` pool ships, nearest first, fly
 *          "defend" — and stay scrambled for `defendHoldThinks` thinks;
 *       2. any live contact on the sensor picture → up to `huntCount` fly
 *          "hunt" (which chases ghosts to their last-known position — a
 *          search, when the contact is stale);
 *       3. the rest "patrol".
 *
 * Fair play: the commander reads ONLY its own faction's ControllerWorld —
 * the same sensor picture its pilots fly on. If the player breaks contact,
 * the commander is as blind as the fleet.
 */
export class FleetCommander {
  private readonly strikers: CommandedPilot[];
  private readonly escorts: CommandedPilot[];
  private readonly pool: CommandedPilot[];

  private nextThinkMs = 0;
  /** Home-carrier hull + subsystem HP at the last think — a drop means it's
   *  under fire. Summing the subsystems in means a shield-generator strike
   *  scrambles defenders even while the gated hull pool barely moves. */
  private lastHomeHp: number | null = null;
  /** Thinks the defense scramble stays up after the last alert. */
  private defendScrambleRemaining = 0;

  constructor(
    pilots: CommandedPilot[], // in spawn order
    strikeCount: number,
    private readonly world: ControllerWorld,
  ) {
    const escortCount = GameConfig.commander.escortCount;
    this.strikers = pilots.slice(0, strikeCount);
    this.escorts = pilots.slice(strikeCount, strikeCount + escortCount);
    this.pool = pilots.slice(strikeCount + escortCount);
  }

  update(nowMs: number): void {
    if (nowMs < this.nextThinkMs) return;
    const cfg = GameConfig.commander;
    this.nextThinkMs = nowMs + cfg.thinkIntervalSec * 1000;

    // Fixed roles re-asserted each think (cheap; setOrder no-ops on same
    // order). This snaps strikers/escorts back if a future rule borrows them.
    for (const p of this.strikers) p.ai.setOrder("strike");
    for (const p of this.escorts) p.ai.setOrder("cover");

    // --- Is the home carrier threatened? ---
    const home = this.world.homeMothership;
    let alert = false;
    if (home && home.isAlive) {
      let totalHp = home.hp;
      for (const sub of home.subsystems) totalHp += sub.hp;
      if (this.lastHomeHp !== null && totalHp < this.lastHomeHp) alert = true;
      this.lastHomeHp = totalHp;
      if (!alert) {
        const r = cfg.defendAlertRadius;
        for (const c of this.world.opponents) {
          if (!c.isAlive) continue;
          const dx = c.position.x - home.position.x;
          const dz = c.position.z - home.position.z;
          if (dx * dx + dz * dz <= r * r) {
            alert = true;
            break;
          }
        }
      }
    }
    if (alert) this.defendScrambleRemaining = cfg.defendHoldThinks;
    else if (this.defendScrambleRemaining > 0) this.defendScrambleRemaining--;

    // Live contacts (fresh or ghost). Hunters sent at ghosts fly to the
    // last-known position and search — the "they saw where you went" beat.
    const anyContact = this.world.opponents.some((c) => c.isAlive);

    // Stations the fleet doesn't hold (neutral, enemy, or being flipped).
    // Empty on station-free maps → the capture rung never fires. Runs at the
    // think cadence (0.5Hz), so the filter allocation is fine.
    const myFaction = home?.faction ?? null;
    const stationTargets = myFaction
      ? this.world.stations.filter((s) => s.owner !== myFaction)
      : [];

    // --- Re-task the pool: defenders first (nearest home), then capturers,
    // hunters, patrol. Losing the carrier outranks losing a station. ---
    const available = this.pool.filter((p) => p.ship.isAlive);
    if (this.defendScrambleRemaining > 0 && home) {
      available.sort((a, b) => {
        const da =
          (a.ship.position.x - home.position.x) ** 2 +
          (a.ship.position.z - home.position.z) ** 2;
        const db =
          (b.ship.position.x - home.position.x) ** 2 +
          (b.ship.position.z - home.position.z) ** 2;
        return da - db;
      });
    }
    let defenders = 0;
    let capturers = 0;
    let hunters = 0;
    const assignedStations = new Set<number>();
    for (const p of available) {
      if (this.defendScrambleRemaining > 0 && defenders < cfg.defendCount) {
        p.ai.setOrder("defend");
        defenders++;
      } else if (stationTargets.length > 0 && capturers < cfg.captureCount) {
        // Nearest contestable station to THIS pilot, spreading over stations
        // not already assigned this think (fall back to nearest overall when
        // there are more capturers than targets).
        let best: (typeof stationTargets)[number] | null = null;
        let bestSq = Infinity;
        let bestUnassigned: (typeof stationTargets)[number] | null = null;
        let bestUnassignedSq = Infinity;
        for (const s of stationTargets) {
          const dx = s.position.x - p.ship.position.x;
          const dz = s.position.z - p.ship.position.z;
          const dSq = dx * dx + dz * dz;
          if (dSq < bestSq) {
            bestSq = dSq;
            best = s;
          }
          if (!assignedStations.has(s.id) && dSq < bestUnassignedSq) {
            bestUnassignedSq = dSq;
            bestUnassigned = s;
          }
        }
        const target = bestUnassigned ?? best;
        if (target) {
          assignedStations.add(target.id);
          p.ai.setOrder("capture");
          p.ai.setCaptureTarget(target);
          capturers++;
        } else {
          p.ai.setOrder("patrol");
        }
      } else if (anyContact && hunters < cfg.huntCount) {
        p.ai.setOrder("hunt");
        hunters++;
      } else {
        p.ai.setOrder("patrol");
      }
    }
  }
}
