/**
 * Headless battle fixture — Phase 0's smoke-harness backbone
 * (docs/MULTIPLAYER.md → Verification).
 *
 * Constructs the FULL gameplay sim with two AI fleets under a Babylon
 * NullEngine (no canvas, no render, no DOM — the precedent is
 * scripts/measure-carrier-footprint.mjs) and steps it with a FIXED dt and a
 * SIMULATED clock. With the sim RNG seeded (src/game/sim/SimRng.ts), a run is
 * fully deterministic: the same seed always plays the same battle, which is
 * what lets the smoke test diff a refactor against a committed baseline
 * trace ("the split changed nothing" becomes a mechanical check).
 *
 * WHAT THIS MIRRORS — and must keep mirroring. Construction and tick order
 * replicate Game.ts exactly, minus the view-only work (camera, glow, HUD,
 * radar, SFX, explosions, hitstop):
 *
 *   Construction = Game's constructor + start():
 *     motherships → asteroid field → laser systems → missile systems →
 *     sensors (+ nebula concealment zones) → controller worlds → player-side
 *     fleet (stand-in + wingmen) → enemy fleet (strike/cover/patrol split) →
 *     enemy FleetCommander → target wiring (ships + carrier hull sections) →
 *     initial launch assignment.
 *   tick(dt) = Game.tick's sim block, in order:
 *     rosters → AI obstacles → sensors → commander → per-combatant
 *     [launch | controller → ship → fire lasers → fire missile] →
 *     asteroid collisions → carrier collisions → death flags + respawns →
 *     lasers ×2 → missiles ×2 → asteroid field → objectives.
 *
 *   Phase 0's "split Game.tick into advanceSim/updateViews" task HAS landed:
 *   Game.tick now calls Game.advanceSim (sim) + Game.updateViews (depiction),
 *   and this tick body mirrors advanceSim's order exactly. The full collapse —
 *   this fixture CALLING the shared advanceSim instead of re-deriving it —
 *   waits on Phase 1, when the sim is lifted out of Game (which still owns a
 *   live Engine/Scene) into the standalone shared coordinator. Until then this
 *   stays a faithful hand-mirror; the unchanged baseline trace is the proof.
 *
 * DELIBERATE DIFFERENCES from the browser game (all documented so baseline
 * shifts are explainable):
 *   - The human pilot is replaced by an AI "stand-in" (default order:
 *     "strike") — two AI fleets, no keyboard. The stand-in still launches
 *     first from bay 0 with the cinematic hold time, exactly like the player.
 *   - No hitstop: hitstop is presentation (the sim simply doesn't advance
 *     during it in the browser); headless we advance every tick.
 *   - No FX/score listeners: LaserSystem/MissileSystem onHit callbacks are
 *     omitted (they only drive feedback + kill tallies in Game).
 *   - No ShipViews: post Ship/ShipView split the ship sim is depiction-free,
 *     so headless ships simply have no view attached.
 *   - Combat-nebula concealment zones are computed from GameConfig directly
 *     (the same three lines CombatNebulas runs) instead of constructing the
 *     textured view class. Keep in sync until the zone math is split out of
 *     the view (Phase 0 "verify AI + sensors are scene-free" task).
 *   - Sim time: tick() advances its own clock and passes nowMs everywhere —
 *     no wall-clock reads anywhere in the sim (Ship death stamps come from
 *     takeDamage's nowMs parameter since the Ship/ShipView split).
 */

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../../src/game/GameConfig";
import { opposing, type Faction } from "../../src/game/Faction";
import { Ship, type ShipTypeConfig } from "../../src/game/sim/Ship";
import type {
  ShipController,
  ControllerWorld,
  AvoidObstacle,
} from "../../src/game/ShipController";
import { AIController, type AIOrder } from "../../src/game/AIController";
import { FleetCommander, type CommandedPilot } from "../../src/game/FleetCommander";
import { SensorSystem } from "../../src/game/SensorSystem";
import { Mothership } from "../../src/game/sim/Mothership";
import { LaserSystem } from "../../src/game/sim/LaserSystem";
import { MissileSystem } from "../../src/game/sim/MissileSystem";
import { AsteroidField } from "../../src/game/AsteroidField";
import { LaunchSequence } from "../../src/game/LaunchSequence";
import { seedSimRng } from "../../src/game/sim/SimRng";

type ShipTypeId = keyof typeof GameConfig.shipTypes;

/** Mirrors Game's private Combatant record (ship + brain + launch state). */
interface Combatant {
  ship: Ship;
  controller: ShipController;
  launch: LaunchSequence | null;
  bayIndex: number;
}

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
  /** Fighter deaths observed (explosionFired transitions). */
  deaths: number;
  /** Fighter respawns performed. */
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

  private readonly engine: NullEngine;
  private readonly scene: Scene;

  private readonly motherships: Record<Faction, Mothership>;
  private readonly asteroids: AsteroidField;
  private readonly factionLasers: Record<Faction, LaserSystem>;
  private readonly factionMissiles: Record<Faction, MissileSystem>;
  private readonly sensors: SensorSystem;
  private readonly fleetCommander: FleetCommander;
  private readonly worldByFaction: Record<Faction, ControllerWorld>;

  private readonly combatants: Combatant[] = [];
  private readonly standIn: Combatant;
  private readonly shipsByFaction: Record<Faction, Ship[]> = {
    humans: [],
    machines: [],
  };
  private readonly aiObstacles: AvoidObstacle[] = [];
  private readonly lastBumpMs = new Map<Ship, number>();

  private state: "launching" | "playing" | "victory" | "defeat" = "launching";
  private simNowMs = 0;

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
    // Seed FIRST: every construction below that draws sim randomness
    // (asteroid layout, AI timers) must come out of the seeded stream.
    seedSimRng(opts.seed);

    this.engine = new NullEngine();
    this.scene = new Scene(this.engine);

    this.playerFaction = GameConfig.player.faction;
    this.enemyFaction = opposing(this.playerFaction);

    // --- Carriers (Game constructor order: humans south, machines north) ---
    // Sim only: post Mothership/MothershipView split the carrier sim holds no
    // scene state, so the harness constructs it directly — no scene, no glow,
    // no procedural mesh build (all view-side now). The launch geometry it
    // exposes runs on GameConfig's bays (no GLB load headless), exactly as the
    // browser does before applyModel() swaps the model in.
    const ms = GameConfig.mothership;
    this.motherships = {
      humans: new Mothership(new Vector3(0, ms.yLevel, ms.playerZ), 0, "humans"),
      machines: new Mothership(new Vector3(0, ms.yLevel, ms.enemyZ), Math.PI, "machines"),
    };

    // --- Asteroid field (sim RNG draws begin here) ---
    this.asteroids = new AsteroidField(
      this.scene,
      GameConfig.arena.halfWidth,
      GameConfig.arena.halfDepth,
      [
        {
          x: this.motherships.humans.position.x,
          z: this.motherships.humans.position.z,
          radius: GameConfig.asteroids.mothershipClearance,
        },
        {
          x: this.motherships.machines.position.x,
          z: this.motherships.machines.position.z,
          radius: GameConfig.asteroids.mothershipClearance,
        },
      ],
    );

    // --- Weapon systems (no onHit/onIntercept: feedback/score is view-side) ---
    // Missiles are built BEFORE lasers so each laser system can hold the
    // OPPOSING pool's live missiles by reference as point-defense
    // interceptables — mirrors Game's construction order exactly (Game.ts).
    const humansMissiles = new MissileSystem({
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      obstacles: this.asteroids.obstacles,
    });
    const machinesMissiles = new MissileSystem({
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      obstacles: this.asteroids.obstacles,
    });
    this.factionMissiles = { humans: humansMissiles, machines: machinesMissiles };
    this.factionLasers = {
      humans: new LaserSystem({
        damage: GameConfig.combat.laserDamage,
        obstacles: this.asteroids.obstacles,
        interceptables: machinesMissiles.interceptables,
      }),
      machines: new LaserSystem({
        damage: GameConfig.combat.laserDamage,
        obstacles: this.asteroids.obstacles,
        interceptables: humansMissiles.interceptables,
      }),
    };

    // --- Sensors + concealment (zones = CombatNebulas' footprint math) ---
    this.sensors = new SensorSystem(this.motherships);
    const neb = GameConfig.scenery.combatNebulas;
    this.sensors.concealmentZones = neb.zones.map((z) => ({
      x: z.xFrac * GameConfig.arena.halfWidth,
      z: z.zFrac * GameConfig.arena.halfDepth,
      radius: z.radius,
    }));

    // --- Controller worlds (sensor-picture views, same shape as Game) ---
    this.worldByFaction = {
      humans: {
        opponents: this.sensors.contacts.humans,
        opponentMothership: this.motherships.machines,
        homeMothership: this.motherships.humans,
        leader: null,
        obstacles: this.aiObstacles,
        arenaHalfX: GameConfig.arena.halfWidth,
        arenaHalfZ: GameConfig.arena.halfDepth,
      },
      machines: {
        opponents: this.sensors.contacts.machines,
        opponentMothership: this.motherships.humans,
        homeMothership: this.motherships.machines,
        leader: null,
        obstacles: this.aiObstacles,
        arenaHalfX: GameConfig.arena.halfWidth,
        arenaHalfZ: GameConfig.arena.halfDepth,
      },
    };

    // --- Player-side fleet: AI stand-in (the human's seat) + wingmen ---
    const playerTypeId = GameConfig.player.shipType;
    const playerType = GameConfig.shipTypes[playerTypeId];
    // Game constructs the player's controller before start() builds the
    // wing; the stand-in's AIController draws its timers first to match.
    const standInController = new AIController({
      order: opts.standInOrder ?? "strike",
    });
    const standInShip = this.makeShip(this.playerFaction, playerType, {
      respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
    });

    const wcfg = GameConfig.player.wingmen;
    const wingTypes = wcfg.shipTypes[this.playerFaction];
    for (let i = 0; i < wcfg.count; i++) {
      const typeId: ShipTypeId =
        wingTypes.length > 0 ? wingTypes[i % wingTypes.length] : playerTypeId;
      const ship = this.makeShip(
        this.playerFaction,
        GameConfig.shipTypes[typeId],
        { respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs },
      );
      const controller = new AIController({
        order: wcfg.orders[i % wcfg.orders.length],
        slot: wcfg.formationSlot(i),
      });
      this.combatants.push({ ship, controller, launch: null, bayIndex: 0 });
    }

    this.standIn = {
      ship: standInShip,
      controller: standInController,
      launch: null,
      bayIndex: 0,
    };
    this.combatants.push(this.standIn);
    this.worldByFaction[this.playerFaction].leader = standInShip;

    // --- Enemy fleet: strike / cover / patrol split + commander (Game.start) ---
    const enemyFleet = GameConfig.fleets[this.enemyFaction];
    const enemyPilots: CommandedPilot[] = [];
    const escortEnd = enemyFleet.strikeCount + GameConfig.commander.escortCount;
    let fleetIndex = 0;
    for (const entry of enemyFleet.fleet) {
      const type = GameConfig.shipTypes[entry.type];
      for (let i = 0; i < entry.count; i++, fleetIndex++) {
        const ship = this.makeShip(this.enemyFaction, type, {
          respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
        });
        let controller: AIController;
        if (fleetIndex < enemyFleet.strikeCount) {
          controller = new AIController({ order: "strike" });
        } else if (fleetIndex < escortEnd) {
          controller = new AIController({
            order: "cover",
            slot: GameConfig.player.wingmen.formationSlot(
              fleetIndex - enemyFleet.strikeCount,
            ),
          });
        } else {
          controller = new AIController({ order: "patrol" });
        }
        enemyPilots.push({ ship, ai: controller });
        this.combatants.push({ ship, controller, launch: null, bayIndex: 0 });
      }
    }
    if (enemyPilots.length > 0) {
      this.worldByFaction[this.enemyFaction].leader = enemyPilots[0].ship;
    }
    this.fleetCommander = new FleetCommander(
      enemyPilots,
      enemyFleet.strikeCount,
      this.worldByFaction[this.enemyFaction],
    );

    // --- Target wiring: ships + carrier hull sections (Game.start) ---
    for (const c of this.combatants) {
      this.factionLasers[opposing(c.ship.faction)].addTarget(c.ship);
      this.factionMissiles[opposing(c.ship.faction)].addTarget(c.ship);
    }
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const section of this.motherships[f].hullSections) {
        this.factionLasers[opposing(f)].addTarget(section);
        this.factionMissiles[opposing(f)].addTarget(section);
      }
    }

    // --- Both fleets stage in the bays and launch (Game.assignInitialLaunches)
    // No applyModel(): the procedural carriers' config launch bays are used.
    this.assignInitialLaunches();
  }

  /** Tear down the NullEngine scene. Call when done with the fixture. */
  dispose(): void {
    this.scene.dispose();
    this.engine.dispose();
  }

  /** Sim-state digest for trace sampling (positions/HP per combatant). */
  sample(): TraceSample {
    return {
      tick: this.stats.ticks,
      ships: this.combatants.map((c) => ({
        x: round3(c.ship.position.x),
        z: round3(c.ship.position.z),
        hp: round3(c.ship.hp),
      })),
      mothershipHp: {
        humans: this.motherships.humans.hp,
        machines: this.motherships.machines.hp,
      },
    };
  }

  get ended(): boolean {
    return this.state === "victory" || this.state === "defeat";
  }

  /**
   * Advance the sim one fixed step — Game.tick's simulation block, minus
   * presentation. Keep the ORDER in lockstep with Game.tick (see file
   * header); a divergence here is a baseline break that means nothing.
   */
  tick(dtSeconds: number): void {
    const deltaMs = dtSeconds * 1000;
    this.simNowMs += deltaMs;
    const nowMs = this.simNowMs;

    this.refreshRosters();
    this.refreshAiObstacles();
    this.sensors.update(nowMs, this.shipsByFaction);

    if (!this.ended) {
      this.fleetCommander.update(nowMs);

      for (const c of this.combatants) {
        const ship = c.ship;

        // Catapult: the sequence drives the ship; its controller is
        // suppressed until it clears the bow (same as Game.tick).
        if (c.launch && !c.launch.isComplete) {
          if (ship.isAlive) {
            c.launch.update(dtSeconds, ship);
            if (c.launch.isComplete) {
              if (c === this.standIn && this.state === "launching") {
                this.state = "playing";
              }
              c.launch = null;
            }
            continue;
          }
          c.launch = null; // died mid-launch — fall through to death handling
        }

        const input = c.controller.update(
          dtSeconds,
          ship,
          this.worldByFaction[ship.faction],
        );
        ship.update(dtSeconds, input);

        if (ship.isAlive && input.fire) {
          const positions = ship.tryFire();
          for (const p of positions) {
            this.factionLasers[ship.faction].spawn(
              p,
              ship.rotationY,
              ship,
              ship.laserDamage,
            );
          }
        }

        if (ship.isAlive && input.fireMissile) {
          const missilePos = ship.tryFireMissile();
          if (missilePos) {
            const homing =
              c.controller instanceof AIController
                ? c.controller.missileTarget
                : null;
            this.factionMissiles[ship.faction].spawn(
              missilePos,
              ship.rotationY,
              homing,
              ship,
            );
          }
        }
      }

      this.resolveAsteroidCollisions(nowMs);
      this.resolveMothershipCollisions();

      // Death bookkeeping + respawns (explosion FX is view-side; the FLAG is
      // sim state Game maintains, so maintain it identically).
      for (const c of this.combatants) {
        const ship = c.ship;
        if (!ship.isAlive && !ship.explosionFired) {
          ship.explosionFired = true;
          this.stats.deaths++;
        }
        if (ship.shouldRespawn(nowMs)) this.respawnShip(c);
      }

      this.factionLasers.humans.update(dtSeconds, deltaMs, nowMs);
      this.factionLasers.machines.update(dtSeconds, deltaMs, nowMs);
      this.factionMissiles.humans.update(dtSeconds, deltaMs, nowMs);
      this.factionMissiles.machines.update(dtSeconds, deltaMs, nowMs);

      this.asteroids.update(dtSeconds);

      this.checkObjectives();
    }

    this.stats.ticks++;
    this.stats.nowMs = nowMs;
    this.collectStats();
  }

  /** Run `n` ticks (or until the match ends, with `stopWhenEnded`). */
  run(n: number, dtSeconds: number, stopWhenEnded = false): void {
    for (let i = 0; i < n; i++) {
      this.tick(dtSeconds);
      if (stopWhenEnded && this.ended) return;
    }
  }

  // ─── Game.tick helpers, replicated sim-only ────────────────────────────────

  private refreshRosters(): void {
    this.shipsByFaction.humans.length = 0;
    this.shipsByFaction.machines.length = 0;
    for (const c of this.combatants) {
      this.shipsByFaction[c.ship.faction].push(c.ship);
    }
  }

  private refreshAiObstacles(): void {
    this.aiObstacles.length = 0;
    for (const rock of this.asteroids.asteroids) this.aiObstacles.push(rock);
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const circle of this.motherships[f].avoidanceCircles) {
        this.aiObstacles.push(circle);
      }
    }
  }

  /** Game.resolveAsteroidCollisions, verbatim minus player FX. */
  private resolveAsteroidCollisions(nowMs: number): void {
    const cfg = GameConfig.asteroids;
    const bumpCooldownMs = cfg.bumpCooldownSec * 1000;
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      for (const rock of this.asteroids.asteroids) {
        if (!rock.isAlive) continue;
        const dx = ship.position.x - rock.position.x;
        const dz = ship.position.z - rock.position.z;
        const distSq = dx * dx + dz * dz;
        const maxDist = ship.hitRadius + rock.radius;
        if (distSq >= maxDist * maxDist) continue;
        const minDist = ship.hitRadius + rock.surfaceRadiusToward(dx, dz);
        if (distSq >= minDist * minDist) continue;

        const dist = Math.sqrt(distSq) || 0.0001;
        const nx = dx / dist;
        const nz = dz / dist;
        ship.position.x = rock.position.x + nx * minDist;
        ship.position.z = rock.position.z + nz * minDist;
        const vn = ship.velocity.x * nx + ship.velocity.z * nz;
        if (vn < 0) {
          ship.velocity.x -= vn * nx;
          ship.velocity.z -= vn * nz;
        }

        const last = this.lastBumpMs.get(ship) ?? -Infinity;
        if (nowMs - last >= bumpCooldownMs) {
          this.lastBumpMs.set(ship, nowMs);
          ship.takeDamage(cfg.collisionDamage, nowMs);
        }
        break; // one bump per ship per frame
      }
    }
  }

  /** Game.resolveMothershipCollisions, verbatim. */
  private resolveMothershipCollisions(): void {
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      for (const f of ["humans", "machines"] as Faction[]) {
        for (const s of this.motherships[f].hullSections) {
          const r = ship.hitRadius;
          const px = Math.min(Math.max(ship.position.x, s.minX), s.maxX);
          const pz = Math.min(Math.max(ship.position.z, s.minZ), s.maxZ);
          const dx = ship.position.x - px;
          const dz = ship.position.z - pz;
          const distSq = dx * dx + dz * dz;
          if (distSq > 0) {
            if (distSq >= r * r) continue;
            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const nz = dz / dist;
            ship.position.x = px + nx * r;
            ship.position.z = pz + nz * r;
            const vn = ship.velocity.x * nx + ship.velocity.z * nz;
            if (vn < 0) {
              ship.velocity.x -= vn * nx;
              ship.velocity.z -= vn * nz;
            }
          } else {
            const left = ship.position.x - s.minX;
            const right = s.maxX - ship.position.x;
            const near = ship.position.z - s.minZ;
            const far = s.maxZ - ship.position.z;
            const min = Math.min(left, right, near, far);
            if (min === left) {
              ship.position.x = s.minX - r;
              if (ship.velocity.x > 0) ship.velocity.x = 0;
            } else if (min === right) {
              ship.position.x = s.maxX + r;
              if (ship.velocity.x < 0) ship.velocity.x = 0;
            } else if (min === near) {
              ship.position.z = s.minZ - r;
              if (ship.velocity.z > 0) ship.velocity.z = 0;
            } else {
              ship.position.z = s.maxZ + r;
              if (ship.velocity.z < 0) ship.velocity.z = 0;
            }
          }
        }
      }
    }
  }

  /** Game.respawnShip: relaunch from the home carrier's assigned bay. */
  private respawnShip(c: Combatant): void {
    const ship = c.ship;
    const home = this.motherships[ship.faction];
    if (!home.isAlive) return;
    const start = home.getLaunchStartPosition(c.bayIndex);
    ship.respawn(start.x, start.z, home.rotationY);
    c.launch = this.makeLaunchSequence(home, 0, c === this.standIn, true);
    this.stats.respawns++;
  }

  /** Game.checkObjectives: a fallen carrier ends the match. */
  private checkObjectives(): void {
    if (this.state !== "playing" && this.state !== "launching") return;
    if (!this.motherships[this.enemyFaction].isAlive) {
      this.endMatch("victory");
    } else if (!this.motherships[this.playerFaction].isAlive) {
      this.endMatch("defeat");
    }
  }

  /** Game.endMatch minus the death-FX spectacle (view-side). */
  private endMatch(outcome: "victory" | "defeat"): void {
    this.state = outcome;
    this.stats.outcome = outcome;
    for (const c of this.combatants) c.launch = null;
  }

  // ─── Construction helpers ───────────────────────────────────────────────────

  /**
   * Game.makeFighter's SHIP construction — sim stats only (hit radii and
   * muzzles come from the type config exactly as procedural fighters do).
   * No view: post Ship/ShipView split the sim is depiction-free by design.
   */
  private makeShip(
    faction: Faction,
    type: ShipTypeConfig,
    opts: { respawnDelayMs: number },
  ): Ship {
    return new Ship({
      faction,
      maxHp: type.maxHp,
      respawnDelayMs: opts.respawnDelayMs,
      startMissileAmmo: type.missileAmmo,
      movement: type,
      laserDamage: type.laserDamage,
      hitRadius: type.hitRadius,
      fireSound: type.fireSound,
    });
  }

  /** Game.makeLaunchSequence, verbatim. */
  private makeLaunchSequence(
    home: Mothership,
    holdSec: number,
    cinematic: boolean,
    skipIntro = false,
  ): LaunchSequence {
    const fwd = home.getLaunchForward();
    return new LaunchSequence(
      fwd.x,
      fwd.z,
      home.position.x,
      home.position.z,
      home.getLaunchExitDistance(),
      holdSec,
      cinematic,
      skipIntro,
    );
  }

  /** Game.assignInitialLaunches + launchFleet: stand-in first, then the wing. */
  private assignInitialLaunches(): void {
    const friendly: Combatant[] = [this.standIn];
    for (const c of this.combatants) {
      if (c.ship.faction === this.playerFaction && c !== this.standIn) {
        friendly.push(c);
      }
    }
    const enemy = this.combatants.filter(
      (c) => c.ship.faction === this.enemyFaction,
    );

    const base = LaunchSequence.cinematicHoldSec();
    this.launchFleet(friendly, this.motherships[this.playerFaction], base);
    this.launchFleet(enemy, this.motherships[this.enemyFaction], base);
  }

  /** Game.launchFleet, verbatim. */
  private launchFleet(
    queue: Combatant[],
    home: Mothership,
    baseHoldSec: number,
  ): void {
    const bays = home.getLaunchBayCount();
    const perBay = GameConfig.launch.shipsPerBay;
    const stagger = GameConfig.launch.staggerSec;
    queue.forEach((c, i) => {
      const bayIndex = Math.min(Math.floor(i / perBay), bays - 1);
      c.bayIndex = bayIndex;
      const start = home.getLaunchStartPosition(bayIndex);
      c.ship.respawn(start.x, start.z, home.rotationY);
      c.launch = this.makeLaunchSequence(
        home,
        baseHoldSec + i * stagger,
        c === this.standIn,
      );
    });
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  private collectStats(): void {
    const s = this.stats;
    if (!s.anyLaserFired) {
      s.anyLaserFired =
        this.factionLasers.humans.count > 0 ||
        this.factionLasers.machines.count > 0;
    }
    if (!s.anyMissileFired) {
      s.anyMissileFired =
        this.factionMissiles.humans.count > 0 ||
        this.factionMissiles.machines.count > 0;
    }
    if (!s.anyShipMoved || !s.anyShipDamaged) {
      for (const c of this.combatants) {
        const ship = c.ship;
        if (
          !s.anyShipMoved &&
          c.launch === null &&
          ship.isAlive &&
          ship.speed > 0.5
        ) {
          s.anyShipMoved = true;
        }
        if (!s.anyShipDamaged && ship.isAlive && ship.hp < ship.maxHp) {
          s.anyShipDamaged = true;
        }
      }
    }
    if (!s.anyMothershipDamaged) {
      s.anyMothershipDamaged =
        this.motherships.humans.hp < this.motherships.humans.maxHp ||
        this.motherships.machines.hp < this.motherships.machines.maxHp;
    }
  }
}
