/**
 * Headless battle fixture — the smoke-harness backbone
 * (docs/MULTIPLAYER.md → Verification).
 *
 * Since Phase 1 this is a THIN WRAPPER over the standalone shared coordinator
 * (shared/src/sim/BattleSim.ts): it assembles the same two-AI-fleet scenario
 * Game sets up (an AI "stand-in" in the player's seat + wingmen vs. the enemy
 * fleet + its commander), drives BattleSim.advance at a fixed dt, and samples a
 * deterministic trace for the smoke test to diff against the committed baseline.
 *
 * Because BattleSim now owns the world + the tick (what Game.tick's sim block
 * and the old hand-mirrored harness used to each carry separately), an UNCHANGED
 * baseline trace through this rewrite is the proof that BattleSim is
 * behavior-identical to the canonical sim.
 *
 * Determinism rests on construction ORDER: only AIController draws seeded RNG in
 * its constructor, so the controllers must be built stand-in → wingmen → enemy,
 * exactly as Game does (the stand-in's controller is built before the wing).
 *
 * DELIBERATE DIFFERENCES from the browser game (so baseline shifts are
 * explainable):
 *   - The human pilot is an AI "stand-in" (default order "strike"); the
 *     stand-in still launches first with the cinematic hold, like the player.
 *   - No hitstop (presentation only — headless advances every tick).
 *   - No FX/score listeners (view-side).
 */

import { GameConfig } from "../../shared/src/GameConfig";
import { opposing, type Faction } from "../../shared/src/Faction";
import { Ship } from "../../shared/src/sim/Ship";
import { AIController, type AIOrder } from "../../shared/src/AIController";
import { FleetCommander, type CommandedPilot } from "../../shared/src/FleetCommander";
import { BattleSim } from "../../shared/src/sim/BattleSim";

type ShipTypeId = keyof typeof GameConfig.shipTypes;

export interface HeadlessBattleOptions {
  /** Sim RNG seed — same seed, same battle. */
  seed: number;
  /** Standing order for the AI flying the player's seat (default "strike"). */
  standInOrder?: AIOrder;
}

export interface BattleStats {
  /** Ticks advanced so far. */
  ticks: number;
  /** Sim-clock ms elapsed. */
  nowMs: number;
  /** True once any fighter has moved after clearing its launch. */
  anyShipMoved: boolean;
  /** True once any laser bolt has existed. */
  anyLaserFired: boolean;
  /** True once any missile has existed. */
  anyMissileFired: boolean;
  /** True once any fighter has taken damage (hp < maxHp while alive). */
  anyShipDamaged: boolean;
  /** Fighter deaths observed (alive→dead transitions). */
  deaths: number;
  /** Fighter respawns observed (dead→alive transitions). */
  respawns: number;
  /** Hull damage observed on either carrier. */
  anyMothershipDamaged: boolean;
  /** Match outcome, from the stand-in's perspective (null = still going). */
  outcome: "victory" | "defeat" | null;
}

/** One ship's sampled sim state in the trace. */
export interface TraceShip {
  x: number;
  z: number;
  hp: number;
}

/** One sampled tick: every combatant (spawn order) + both carrier HPs. */
export interface TraceSample {
  tick: number;
  ships: TraceShip[];
  mothershipHp: { humans: number; machines: number };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export class HeadlessBattle {
  readonly playerFaction: Faction;
  readonly enemyFaction: Faction;

  private readonly sim: BattleSim;
  /** Per-ship alive state at the end of the previous tick (death/respawn edges). */
  private readonly wasAlive = new Map<Ship, boolean>();

  readonly stats: BattleStats = {
    ticks: 0,
    nowMs: 0,
    anyShipMoved: false,
    anyLaserFired: false,
    anyMissileFired: false,
    anyShipDamaged: false,
    deaths: 0,
    respawns: 0,
    anyMothershipDamaged: false,
    outcome: null,
  };

  constructor(opts: HeadlessBattleOptions) {
    // Seed FIRST: asteroid layout + AI timers must come out of the seeded stream.
    BattleSim.seedRng(opts.seed);

    this.sim = new BattleSim(); // builds the world (asteroid RNG draws here)

    this.playerFaction = GameConfig.player.faction;
    this.enemyFaction = opposing(this.playerFaction);

    // --- Player-side fleet: AI stand-in (the human's seat) + wingmen ---
    // The stand-in's controller is built FIRST (Game builds the player's
    // controller before start() builds the wing) — controller construction
    // order is the determinism contract.
    const playerTypeId = GameConfig.player.shipType;
    const playerType = GameConfig.shipTypes[playerTypeId];
    const standInController = new AIController({
      order: opts.standInOrder ?? "strike",
    });
    const standInShip = this.sim.spawnShip(this.playerFaction, playerType, {
      respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
    });

    // Resolve the wing exactly as Game.resolveWingPlan does.
    const wcfg = GameConfig.player.wingmen;
    const ships = GameConfig.factionShips[this.playerFaction];
    const otherType = ships.find((t) => t !== playerTypeId) ?? playerTypeId;
    const gunshipType = ships[ships.length - 1];
    const wingTypes = wcfg.shipTypes[this.playerFaction];
    for (let i = 0; i < wcfg.count; i++) {
      let typeId: ShipTypeId;
      let order: (typeof wcfg.orders)[number];
      if (wcfg.composition.length > 0) {
        const c = wcfg.composition[i % wcfg.composition.length];
        typeId = c.role === "self" ? playerTypeId : c.role === "other" ? otherType : gunshipType;
        order = c.order;
      } else {
        typeId = wingTypes.length > 0 ? wingTypes[i % wingTypes.length] : playerTypeId;
        order = wcfg.orders[i % wcfg.orders.length];
      }
      const ship = this.sim.spawnShip(this.playerFaction, GameConfig.shipTypes[typeId], {
        respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
      });
      const controller = new AIController({ order, slot: wcfg.formationSlot(i) });
      this.sim.addCombatant({ ship, controller });
    }

    // Stand-in pushed AFTER the wing (combatant order mirrors Game), cinematic.
    this.sim.addCombatant({
      ship: standInShip,
      controller: standInController,
      cinematic: true,
    });
    this.sim.setLeader(this.playerFaction, standInShip);

    // --- Enemy fleet: strike / cover / patrol split + commander ---
    const enemyFleet = GameConfig.fleets[this.enemyFaction];
    const enemyPilots: CommandedPilot[] = [];
    const escortEnd = enemyFleet.strikeCount + GameConfig.commander.escortCount;
    let fleetIndex = 0;
    for (const entry of enemyFleet.fleet) {
      const type = GameConfig.shipTypes[entry.type];
      for (let i = 0; i < entry.count; i++, fleetIndex++) {
        const ship = this.sim.spawnShip(this.enemyFaction, type, {
          respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
        });
        let controller: AIController;
        if (fleetIndex < enemyFleet.strikeCount) {
          controller = new AIController({ order: "strike" });
        } else if (fleetIndex < escortEnd) {
          controller = new AIController({
            order: "cover",
            slot: GameConfig.player.wingmen.formationSlot(fleetIndex - enemyFleet.strikeCount),
          });
        } else {
          controller = new AIController({ order: "patrol" });
        }
        enemyPilots.push({ ship, ai: controller });
        this.sim.addCombatant({ ship, controller });
      }
    }
    if (enemyPilots.length > 0) {
      this.sim.setLeader(this.enemyFaction, enemyPilots[0].ship);
    }
    this.sim.addCommander(
      new FleetCommander(
        enemyPilots,
        enemyFleet.strikeCount,
        this.sim.worldByFaction[this.enemyFaction],
      ),
    );

    // Wire targets + stage the launch.
    this.sim.start();
    for (const c of this.sim.combatants) this.wasAlive.set(c.ship, c.ship.isAlive);
  }

  /** No-op: the sim holds no Engine/Scene. Kept so callers' teardown is stable. */
  dispose(): void {}

  get ended(): boolean {
    return this.sim.ended;
  }

  /** Advance the sim one fixed step, then update the harness stats. */
  tick(dtSeconds: number): void {
    this.sim.advance(dtSeconds);
    this.stats.ticks++;
    this.stats.nowMs = this.sim.nowMs;
    this.collectStats();
  }

  /** Run `n` ticks (or until the match ends, with `stopWhenEnded`). */
  run(n: number, dtSeconds: number, stopWhenEnded = false): void {
    for (let i = 0; i < n; i++) {
      this.tick(dtSeconds);
      if (stopWhenEnded && this.ended) return;
    }
  }

  /** Sim-state digest for trace sampling (positions/HP per combatant). */
  sample(): TraceSample {
    return {
      tick: this.stats.ticks,
      ships: this.sim.combatants.map((c) => ({
        x: round3(c.ship.position.x),
        z: round3(c.ship.position.z),
        hp: round3(c.ship.hp),
      })),
      mothershipHp: {
        humans: this.sim.motherships.humans.hp,
        machines: this.sim.motherships.machines.hp,
      },
    };
  }

  private collectStats(): void {
    const s = this.stats;
    const sim = this.sim;

    if (s.outcome === null && sim.ended && sim.winner) {
      s.outcome = sim.winner === this.playerFaction ? "victory" : "defeat";
    }

    if (!s.anyLaserFired) {
      s.anyLaserFired =
        sim.factionLasers.humans.count > 0 || sim.factionLasers.machines.count > 0;
    }
    if (!s.anyMissileFired) {
      s.anyMissileFired =
        sim.factionMissiles.humans.count > 0 || sim.factionMissiles.machines.count > 0;
    }

    for (const c of sim.combatants) {
      const ship = c.ship;
      // Death / respawn edges (BattleSim consumes explosionFired internally, so
      // detect from the alive flag instead).
      const prev = this.wasAlive.get(ship) ?? ship.isAlive;
      if (prev && !ship.isAlive) s.deaths++;
      else if (!prev && ship.isAlive) s.respawns++;
      this.wasAlive.set(ship, ship.isAlive);

      if (!s.anyShipMoved && c.launch === null && ship.isAlive && ship.speed > 0.5) {
        s.anyShipMoved = true;
      }
      if (!s.anyShipDamaged && ship.isAlive && ship.hp < ship.maxHp) {
        s.anyShipDamaged = true;
      }
    }

    if (!s.anyMothershipDamaged) {
      s.anyMothershipDamaged =
        sim.motherships.humans.hp < sim.motherships.humans.maxHp ||
        sim.motherships.machines.hp < sim.motherships.machines.maxHp;
    }
  }
}
