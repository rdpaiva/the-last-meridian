import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import { opposing, type Faction } from "../Faction";
import { Ship, type ShipTypeConfig } from "./Ship";
import { AIController } from "../AIController";
import type { ShipController, ControllerWorld, AvoidObstacle } from "../ShipController";
import { FleetCommander } from "../FleetCommander";
import { SensorSystem } from "../SensorSystem";
import { Mothership } from "./Mothership";
import { LaserSystem } from "./LaserSystem";
import { MissileSystem } from "./MissileSystem";
import { AsteroidFieldSim } from "./AsteroidFieldSim";
import { Hulk } from "./Hulk";
import type { MothershipSection } from "./MothershipSection";
import type { Turret } from "./Turret";
import type { DamageTarget } from "../types";
import { SimEventBus } from "./SimEvents";
import { LaunchSequence } from "../LaunchSequence";
import { computeConcealmentZones } from "./CombatNebulaZones";
import { seedSimRng } from "./SimRng";

/**
 * One ship + its brain + launch state. The unit BattleSim ticks. `cinematic`
 * marks the seat whose launch runs the player's hold/countdown and whose
 * launch-clear flips the match from "launching" to "playing" (and whose
 * relaunch on respawn keeps the cinematic intro) — in solo that's the player,
 * server-side it's whichever seat the room designates.
 */
export interface SimCombatant {
  ship: Ship;
  controller: ShipController;
  launch: LaunchSequence | null;
  bayIndex: number;
  cinematic: boolean;
}

export type MatchState = "launching" | "playing" | "ended";

/**
 * The standalone, scene-free battle coordinator — the single source of
 * gameplay truth that runs ANYWHERE (browser client, Colyseus server, headless
 * tests). It owns the world (carriers, asteroids, weapon systems, sensors,
 * obstacle lists) and the simulation step (`advance`); it does NOT own the
 * scenario (who flies which seat, AI vs human, fleet composition) — the caller
 * builds that with `spawn` / `addCombatant` / `addCommander`, then `start`.
 *
 * This is the "standalone shared coordinator" docs/MULTIPLAYER.md Phase 1 calls
 * for. The `advance` body mirrors what Game.tick's sim block used to do inline
 * (and what HeadlessBattle hand-mirrored against the committed baseline); the
 * headless smoke test now drives THIS class, so the unchanged baseline trace
 * proves BattleSim is behavior-identical to the canonical sim.
 *
 * Faction-symmetric by design: it tracks a `winner` faction, not a
 * victory/defeat verdict — perspective (which side is "you") belongs to the
 * caller, since on a server every client has a different one.
 *
 * Time: `advance(dt)` owns the sim clock (`nowMs`); no wall-clock reads ever
 * happen inside the sim. Hitstop is a client-only presentation freeze the
 * browser gates OUTSIDE this call — the server never freezes.
 */
export class BattleSim {
  /**
   * The sim→view event channel (SimEvents.ts). Every transient fact the sim
   * produces — fire, hits, deaths, launches, jumps, turret fire — is emitted
   * here. The offline Game subscribes FX/SFX; a server room serializes these
   * onto the wire (Phase 2 event replication); a headless run subscribes
   * nothing. Emissions draw no RNG, so listeners can't perturb determinism.
   */
  readonly events = new SimEventBus();

  readonly motherships: Record<Faction, Mothership>;
  readonly asteroids: AsteroidFieldSim;
  readonly factionLasers: Record<Faction, LaserSystem>;
  readonly factionMissiles: Record<Faction, MissileSystem>;
  readonly sensors: SensorSystem;
  readonly worldByFaction: Record<Faction, ControllerWorld>;

  readonly combatants: SimCombatant[] = [];
  private readonly commanders: FleetCommander[] = [];

  /** Placed wrecks (map hazards) — empty unless the active map has them. */
  private readonly hulks: Hulk[] = [];
  /** Combined weapon line-of-sight cover (rocks + wreck circles), rebuilt each
   *  step. Held BY REFERENCE by the weapon systems. */
  private readonly weaponObstacles: DamageTarget[] = [];
  /** Combined AI avoidance shapes (rocks + carrier circles + wreck sections). */
  private readonly aiObstacles: AvoidObstacle[] = [];
  private readonly shipsByFaction: Record<Faction, Ship[]> = {
    humans: [],
    machines: [],
  };
  private readonly lastBumpMs = new Map<Ship, number>();
  /** Turrets whose destruction has been announced (fire-once latch). */
  private readonly deadTurretsAnnounced = new Set<Turret>();

  /** The seat whose launch-clear flips launching → playing (the cinematic one). */
  private primaryLaunch: SimCombatant | null = null;

  private _state: MatchState = "launching";
  private _winner: Faction | null = null;
  private simNowMs = 0;

  /**
   * Seed the shared sim RNG. Call BEFORE constructing a BattleSim — the world
   * build (asteroid layout) and every AIController draw from this stream, so a
   * server room seeds per match for reproducibility, as the harness does.
   */
  static seedRng(seed: number): void {
    seedSimRng(seed);
  }

  constructor() {
    // --- Carriers (humans south, machines north) ---
    const ms = GameConfig.mothership;
    this.motherships = {
      humans: new Mothership(new Vector3(0, ms.yLevel, ms.playerZ), 0, "humans"),
      machines: new Mothership(new Vector3(0, ms.yLevel, ms.enemyZ), Math.PI, "machines"),
    };

    // --- Asteroid field (sim RNG draws begin here) — keep clear of both bays.
    this.asteroids = new AsteroidFieldSim(
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

    // Placed wrecks (inert under stock config).
    for (const hazard of GameConfig.hazards) {
      if (hazard.kind === "hulk") this.hulks.push(new Hulk(hazard));
    }

    this.asteroids.onShatter = (position, radius) =>
      this.events.emit("asteroidShattered", { position, radius });

    // --- Weapon systems. Missiles BEFORE lasers so each laser system can hold
    // the OPPOSING pool's live missiles by reference as interceptables. ---
    const onMissileHit = (
      position: Vector3,
      struck: DamageTarget | null,
      shooter: Ship | null,
    ) => this.events.emit("missileHit", { position, struck, shooter });
    const humansMissiles = new MissileSystem({
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      obstacles: this.weaponObstacles,
      onHit: onMissileHit,
    });
    const machinesMissiles = new MissileSystem({
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      obstacles: this.weaponObstacles,
      onHit: onMissileHit,
    });
    const onLaserHit = (
      target: DamageTarget,
      shooter: Ship | null,
      position: Vector3,
    ) => this.events.emit("laserHit", { target, shooter, position });
    const onIntercept = (position: Vector3) =>
      this.events.emit("missileIntercepted", { position });
    this.factionMissiles = { humans: humansMissiles, machines: machinesMissiles };
    this.factionLasers = {
      humans: new LaserSystem({
        damage: GameConfig.combat.laserDamage,
        obstacles: this.weaponObstacles,
        interceptables: machinesMissiles.interceptables,
        onHit: onLaserHit,
        onIntercept,
      }),
      machines: new LaserSystem({
        damage: GameConfig.combat.laserDamage,
        obstacles: this.weaponObstacles,
        interceptables: humansMissiles.interceptables,
        onHit: onLaserHit,
        onIntercept,
      }),
    };

    // --- Sensors + nebula concealment (shared scene-free footprint math) ---
    this.sensors = new SensorSystem(this.motherships);
    this.sensors.concealmentZones = computeConcealmentZones(
      GameConfig.arena.halfWidth,
      GameConfig.arena.halfDepth,
    );

    // --- Controller worlds (sensor-picture views) ---
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
  }

  // ─── Scenario assembly (caller-driven) ──────────────────────────────────────

  /**
   * Construct a ship from a type config — sim stats only (no view). Mirrors
   * Game.makeFighter's SHIP half. Draws NO seeded RNG (only the controller
   * does), so call order here is determinism-neutral.
   */
  spawnShip(
    faction: Faction,
    type: ShipTypeConfig,
    opts: { respawnDelayMs: number },
  ): Ship {
    return new Ship({
      faction,
      maxHp: type.maxHp,
      respawnDelayMs: opts.respawnDelayMs,
      startMissileAmmo: type.missileAmmo,
      startCannonAmmo: type.cannonAmmo,
      movement: type,
      laserDamage: type.laserDamage,
      hitRadius: type.hitRadius,
      fireSound: type.fireSound,
    });
  }

  /** Register a combatant. Order matters: laser/missile target order (wired in
   *  `start`) follows combatant order, which can decide overlapping hits. */
  addCombatant(c: {
    ship: Ship;
    controller: ShipController;
    bayIndex?: number;
    cinematic?: boolean;
  }): SimCombatant {
    const entry: SimCombatant = {
      ship: c.ship,
      controller: c.controller,
      launch: null,
      bayIndex: c.bayIndex ?? 0,
      cinematic: c.cinematic ?? false,
    };
    this.combatants.push(entry);
    if (entry.cinematic && !this.primaryLaunch) this.primaryLaunch = entry;
    return entry;
  }

  /** Register a fleet commander (its faction's doctrine); ticked in `advance`. */
  addCommander(commander: FleetCommander): void {
    this.commanders.push(commander);
  }

  /** Set a faction's formation leader (the seat its `cover`/`formation` AI keys
   *  off). */
  setLeader(faction: Faction, ship: Ship | null): void {
    this.worldByFaction[faction].leader = ship;
  }

  /**
   * Finalize wiring + stage the launch. Wires weapon targets in the order the
   * baseline expects — every combatant's ship (combatant order), then turrets
   * (humans, machines), then hull sections (humans, machines) — then catapults
   * each faction's fleet out of its carrier's bays.
   */
  start(): void {
    for (const c of this.combatants) {
      this.factionLasers[opposing(c.ship.faction)].addTarget(c.ship);
      this.factionMissiles[opposing(c.ship.faction)].addTarget(c.ship);
    }
    // Turrets BEFORE sections (shootable, sit proud of the hull).
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const turret of this.motherships[f].turrets) {
        this.factionLasers[opposing(f)].addTarget(turret);
        this.factionMissiles[opposing(f)].addTarget(turret);
      }
    }
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const section of this.motherships[f].hullSections) {
        this.factionLasers[opposing(f)].addTarget(section);
        this.factionMissiles[opposing(f)].addTarget(section);
      }
    }
    this.assignInitialLaunches();
  }

  // ─── State accessors ────────────────────────────────────────────────────────

  get state(): MatchState {
    return this._state;
  }
  /** The victorious faction once the match has ended, else null. */
  get winner(): Faction | null {
    return this._winner;
  }
  get ended(): boolean {
    return this._state === "ended";
  }
  get nowMs(): number {
    return this.simNowMs;
  }

  // ─── Simulation step ────────────────────────────────────────────────────────

  /**
   * Advance the sim one fixed step. Order is load-bearing (it IS the canonical
   * order the baseline locks in): rosters → AI obstacles → sensors → commander
   * → per-combatant [launch | controller → ship → fire → jump → service] →
   * turret fire → collisions → death/respawn → projectiles → field → objectives.
   */
  advance(dtSeconds: number): void {
    const deltaMs = dtSeconds * 1000;
    this.simNowMs += deltaMs;
    const nowMs = this.simNowMs;

    this.refreshRosters();
    this.refreshAiObstacles();
    this.sensors.update(nowMs, this.shipsByFaction);

    if (this.ended) return;

    for (const hulk of this.hulks) hulk.update(dtSeconds);
    this.refreshWeaponObstacles();

    for (const commander of this.commanders) commander.update(nowMs);

    for (const c of this.combatants) {
      const ship = c.ship;

      // Catapult: the sequence drives the ship; its controller is suppressed
      // until it clears the bow.
      if (c.launch && !c.launch.isComplete) {
        if (ship.isAlive) {
          c.launch.update(dtSeconds, ship);
          if (c.launch.justLaunched) this.events.emit("shipLaunched", { ship });
          if (c.launch.isComplete) {
            // Flip to "playing" when the cinematic seat clears the tube; with no
            // cinematic seat (MP rooms), the first seat to clear flips it.
            if (
              this._state === "launching" &&
              (this.primaryLaunch === null || c === this.primaryLaunch)
            ) {
              this._state = "playing";
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
        if (positions.length > 0) {
          this.events.emit("shipFiredLaser", { ship, muzzles: positions });
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
          this.events.emit("missileFired", { ship });
        }
      }

      // Jump drive: arm/cancel on the input edge, teleport home on spool done.
      if (ship.isAlive) {
        if (input.jumpPressed) {
          const intent = ship.onJumpIntent();
          if (intent === "spool-started") {
            this.events.emit("jumpSpoolStarted", { ship });
          } else if (intent === "spool-cancelled") {
            this.events.emit("jumpCancelled", { ship });
          }
        }
        if (ship.tickJump(dtSeconds)) {
          const home = this.motherships[ship.faction];
          if (home.isAlive) {
            const bay = home.getLaunchStartPosition(c.bayIndex);
            const fromX = ship.position.x;
            const fromZ = ship.position.z;
            ship.jumpTeleport(bay.x, bay.z, home.rotationY);
            this.events.emit("jumpFired", {
              ship,
              fromX,
              fromZ,
              toX: bay.x,
              toZ: bay.z,
            });
          }
        }
      }

      // Carrier service: loiter slowly inside the home bubble → repair + rearm.
      if (ship.isAlive) {
        const home = this.motherships[ship.faction];
        if (
          home.isAlive &&
          ship.speed <= GameConfig.service.loiterMaxSpeed &&
          home.serviceZoneContains(ship.position.x, ship.position.z)
        ) {
          ship.serviceTick(dtSeconds);
        }
      }
    }

    // Carrier turrets fire into their own faction's laser system.
    for (const f of ["humans", "machines"] as Faction[]) {
      const fires = this.motherships[f].updateTurrets(
        dtSeconds,
        this.sensors.contacts[f],
        nowMs,
      );
      for (const cmd of fires) {
        this.factionLasers[f].spawn(cmd.origin, cmd.rotationY, null, cmd.damage);
        this.events.emit("turretFired", {
          faction: f,
          origin: cmd.origin,
          rotationY: cmd.rotationY,
        });
      }
      for (const turret of this.motherships[f].turrets) {
        if (!turret.isAlive && !this.deadTurretsAnnounced.has(turret)) {
          this.deadTurretsAnnounced.add(turret);
          this.events.emit("turretDestroyed", { position: turret.position });
        }
      }
    }

    this.resolveAsteroidCollisions(nowMs);
    this.resolveMothershipCollisions();
    this.resolveHulkCollisions();

    // Death bookkeeping + respawns.
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive && !ship.explosionFired) {
        ship.explosionFired = true;
        this.events.emit("shipDied", { ship });
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

  // ─── Tick helpers ───────────────────────────────────────────────────────────

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
    for (const hulk of this.hulks) {
      for (const section of hulk.sections) this.aiObstacles.push(section);
    }
  }

  private refreshWeaponObstacles(): void {
    this.weaponObstacles.length = 0;
    for (const rock of this.asteroids.obstacles) this.weaponObstacles.push(rock);
    for (const hulk of this.hulks) {
      for (const section of hulk.sections) this.weaponObstacles.push(section);
    }
  }

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
          this.events.emit("shipRammedAsteroid", { ship });
        }
        break; // one bump per ship per frame
      }
    }
  }

  private resolveMothershipCollisions(): void {
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      for (const f of ["humans", "machines"] as Faction[]) {
        for (const s of this.motherships[f].hullSections) {
          this.bumpShipOutOfSection(ship, s);
        }
      }
    }
  }

  private resolveHulkCollisions(): void {
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      for (const hulk of this.hulks) {
        for (const section of hulk.sections) {
          const dx = ship.position.x - section.position.x;
          const dz = ship.position.z - section.position.z;
          const distSq = dx * dx + dz * dz;
          const bound = ship.hitRadius + section.hitRadius;
          if (distSq >= bound * bound || distSq === 0) continue;
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const nz = dz / dist;
          const r = ship.hitRadius + section.surfaceRadiusToward(dx, dz);
          if (dist >= r) continue;
          ship.position.x = section.position.x + nx * r;
          ship.position.z = section.position.z + nz * r;
          const vn = ship.velocity.x * nx + ship.velocity.z * nz;
          if (vn < 0) {
            ship.velocity.x -= vn * nx;
            ship.velocity.z -= vn * nz;
          }
        }
      }
    }
  }

  private bumpShipOutOfSection(ship: Ship, s: MothershipSection): void {
    const r = ship.hitRadius;
    const px = Math.min(Math.max(ship.position.x, s.minX), s.maxX);
    const pz = Math.min(Math.max(ship.position.z, s.minZ), s.maxZ);
    const dx = ship.position.x - px;
    const dz = ship.position.z - pz;
    const distSq = dx * dx + dz * dz;
    if (distSq > 0) {
      if (distSq >= r * r) return;
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

  private respawnShip(c: SimCombatant): void {
    const ship = c.ship;
    const home = this.motherships[ship.faction];
    if (!home.isAlive) return;
    const start = home.getLaunchStartPosition(c.bayIndex);
    ship.respawn(start.x, start.z, home.rotationY);
    c.launch = this.makeLaunchSequence(home, 0, c.cinematic, true);
  }

  private checkObjectives(): void {
    if (this._state === "ended") return;
    if (!this.motherships.machines.isAlive) this.endMatch("humans");
    else if (!this.motherships.humans.isAlive) this.endMatch("machines");
  }

  private endMatch(winner: Faction): void {
    this._state = "ended";
    this._winner = winner;
    this.events.emit("mothershipDied", {
      mothership: this.motherships[opposing(winner)],
    });
    for (const c of this.combatants) c.launch = null;
  }

  // ─── Launch staging ─────────────────────────────────────────────────────────

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

  /** Catapult each faction's fleet out of its carrier; the cinematic seat leads
   *  its fleet so its hold is the intro/countdown. With no cinematic seat (MP
   *  rooms), the base hold is launch.mpHoldSec — long enough for joining
   *  clients to load and watch the fleets stream out. */
  private assignInitialLaunches(): void {
    const base = this.primaryLaunch
      ? LaunchSequence.cinematicHoldSec()
      : GameConfig.launch.mpHoldSec;
    for (const f of ["humans", "machines"] as Faction[]) {
      const queue = this.combatants.filter((c) => c.ship.faction === f);
      // Cinematic seat first so it leads the stagger (its hold is the countdown).
      queue.sort((a, b) => Number(b.cinematic) - Number(a.cinematic));
      this.launchFleet(queue, this.motherships[f], base);
    }
  }

  private launchFleet(
    queue: SimCombatant[],
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
      c.launch = this.makeLaunchSequence(home, baseHoldSec + i * stagger, c.cinematic);
    });
  }
}
