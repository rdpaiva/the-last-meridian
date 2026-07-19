import type { DamageTarget } from "@space-duel/shared";
import { Ship } from "@space-duel/shared";
import { compareScoreRows, type ScoreRow } from "./Hud";

/**
 * Per-pilot kill/death/score ledger for the OFFLINE match — the data behind
 * the end-of-game leaderboard. Mirrors the server's attribution semantics
 * exactly (BattleRoom's lastHitBy map): every ship-on-ship hit remembers the
 * last shooter to land one, and a death consumes that memory to credit the
 * kill. Score is the victim's maxHp — the same currency as the personal
 * score line, so the player's board row and HUD line agree by construction.
 *
 * This is a PARALLEL accumulator: the legacy playerKills/wingKills/score
 * fields on Game (and their best-score persistence) are untouched.
 *
 * Keyed by Ship instance — solo respawns reuse the same Ship, so a pilot's
 * tally survives its deaths. Turret/asteroid deaths stay unattributed
 * (turret bolts carry shooter: null); the death still counts.
 */
export class ScoreBoard {
  private readonly entries = new Map<Ship, ScoreRow>();
  /** Victim → last shooter to land a hit on it; consumed on death. */
  private readonly lastHitBy = new Map<Ship, Ship>();

  /** Add a pilot to the board (0/0/0) — call once per combatant at spawn. */
  register(
    ship: Ship,
    callsign: string,
    opts: { isPlayer: boolean; isHuman: boolean },
  ): void {
    this.entries.set(ship, {
      callsign,
      faction: ship.faction,
      kills: 0,
      deaths: 0,
      score: 0,
      isPlayer: opts.isPlayer,
      isHuman: opts.isHuman,
    });
  }

  /**
   * A laser/missile landed. Ships only — carrier hull and turret damage
   * doesn't feed the fighter kill board (same rule as the server's recordHit).
   */
  noteHit(target: DamageTarget | null, shooter: Ship | null): void {
    if (target instanceof Ship && shooter !== null) {
      this.lastHitBy.set(target, shooter);
    }
  }

  /**
   * Peek at the last shooter to land a hit on this ship (NOT consumed —
   * noteDeath still credits the kill). The death-spectate camera reads this
   * at the player's death edge to open on the killer.
   */
  lastAttacker(victim: Ship): Ship | null {
    return this.lastHitBy.get(victim) ?? null;
  }

  /** A ship died (any cause): count the death, credit the last shooter. */
  noteDeath(victim: Ship): void {
    const v = this.entries.get(victim);
    if (v) v.deaths++;
    const shooter = this.lastHitBy.get(victim);
    if (shooter) {
      const s = this.entries.get(shooter);
      if (s) {
        s.kills++;
        s.score += victim.maxHp;
      }
    }
    this.lastHitBy.delete(victim); // a respawned ship starts a fresh ledger
  }

  /** Every pilot, ranked: kills desc → score desc → callsign asc. */
  rows(): ScoreRow[] {
    return [...this.entries.values()].sort(compareScoreRows);
  }
}
