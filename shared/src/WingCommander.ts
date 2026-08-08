import { GameConfig } from "./GameConfig";
import type { CommandedPilot } from "./FleetCommander";
import type { Ship } from "./sim/Ship";
import type { ControllerWorld } from "./ShipController";

/**
 * Doctrine for the PLAYER-side wing — the FleetCommander's small sibling.
 * The wing's configured orders (WingPlan: escorts fly "cover" on the player,
 * gunships fly "defend" at the carrier) are a fine peacetime baseline, but
 * static orders go brain-dead the moment the situation changes: a dead
 * player left the escorts in lone-wolf fallback for the whole respawn
 * window, and the carrier guards never got reinforced while the hull was
 * actually being pounded. This commander re-evaluates those orders every
 * `commander.thinkIntervalSec` (the knobs are shared with the enemy
 * doctrine — cadence and alarm thresholds are symmetric by nature):
 *
 *   - LEADER FAILOVER — while the player is alive, world.leader is the
 *     player and escorts fly "cover" as configured. When the player dies,
 *     the senior LIVE escort becomes the acting leader (world.leader): it
 *     reads leader === self and prosecutes the nearest contact (the
 *     "avenge the leader" spearhead) while the rest of the wing covers IT —
 *     the wing keeps fighting as a pack instead of scattering. The player
 *     relaunching snaps everything back on the next think.
 *   - CARRIER SCRAMBLE — same alarm as the enemy fleet's (hull + hangar HP
 *     dropped since last think, or a contact inside defendAlertRadius on
 *     this faction's own sensor picture): up to `commander.defendCount`
 *     escorts, nearest the carrier first, are pulled onto "defend" until
 *     the alert has been quiet for `defendHoldThinks` thinks.
 *   - The gunship guards keep their standing "defend" — that is their job.
 *
 * Fair play: reads only this faction's ControllerWorld (its own sensor
 * picture), exactly like the FleetCommander. Draws no RNG, so wiring it in
 * (or not) never shifts the seeded sim stream's draw order.
 */
export class WingCommander {
  /** Wing pilots whose configured order is "cover" (the player's escorts). */
  private readonly escorts: CommandedPilot[];
  /** Wing pilots configured "defend" (the carrier-guard gunships). */
  private readonly guards: CommandedPilot[];

  private nextThinkMs = 0;
  /** Home-carrier hull + subsystem HP at the last think (drop = under fire). */
  private lastHomeHp: number | null = null;
  /** Thinks the defense scramble stays up after the last alert. */
  private defendScrambleRemaining = 0;

  constructor(
    /** The human pilot's ship — the wing's true leader. */
    private readonly leader: Ship,
    /** The wing in slot order, ALREADY carrying their configured orders. */
    pilots: CommandedPilot[],
    private readonly world: ControllerWorld,
  ) {
    this.escorts = pilots.filter((p) => p.ai.currentOrder !== "defend");
    this.guards = pilots.filter((p) => p.ai.currentOrder === "defend");
  }

  update(nowMs: number): void {
    if (nowMs < this.nextThinkMs) return;
    const cfg = GameConfig.commander;
    this.nextThinkMs = nowMs + cfg.thinkIntervalSec * 1000;

    // --- Is the home carrier threatened? (Mirrors FleetCommander.) ---
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

    // Gunship guards always guard (re-asserted like the enemy's fixed roles).
    for (const p of this.guards) p.ai.setOrder("defend");

    // --- Escorts: carrier scramble first, cover otherwise. ---
    let scrambleSet: Set<CommandedPilot> | null = null;
    if (this.defendScrambleRemaining > 0 && home) {
      const candidates = this.escorts
        .filter((p) => p.ship.isAlive)
        .sort((a, b) => {
          const da =
            (a.ship.position.x - home.position.x) ** 2 +
            (a.ship.position.z - home.position.z) ** 2;
          const db =
            (b.ship.position.x - home.position.x) ** 2 +
            (b.ship.position.z - home.position.z) ** 2;
          return da - db;
        });
      scrambleSet = new Set(candidates.slice(0, cfg.defendCount));
    }
    for (const p of this.escorts) {
      if (scrambleSet?.has(p)) {
        p.ai.setOrder("defend");
      } else {
        p.ai.setOrder("cover");
      }
    }

    // --- Leader failover: the player when alive, else the senior live
    // escort still flying cover (never a scrambled defender — the carrier
    // call outranks the spearhead role). ---
    if (this.leader.isAlive) {
      this.world.leader = this.leader;
    } else {
      const standIn = this.escorts.find(
        (p) => p.ship.isAlive && !scrambleSet?.has(p),
      );
      this.world.leader =
        standIn?.ship ??
        this.escorts.find((p) => p.ship.isAlive)?.ship ??
        null;
    }
  }
}
