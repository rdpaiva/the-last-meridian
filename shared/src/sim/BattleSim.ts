import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import { wrapAngle } from "../math";
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
import type { AsteroidSim } from "./AsteroidSim";
import { Hulk } from "./Hulk";
import type { HulkSection, PlanarPushOut } from "./HulkSection";
import type { MothershipSection } from "./MothershipSection";
import type { Turret } from "./Turret";
import type { DamageTarget, InputState } from "../types";
import { SimEventBus } from "./SimEvents";
import { LaunchSequence } from "../LaunchSequence";
import { computeConcealmentZones } from "./CombatNebulaZones";
import { StormSystem } from "./StormSystem";
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
  /** The InputState the last sim tick applied (null before the first tick /
   *  while the launch catapult suppresses the controller). The offline Game
   *  drives its wing FX from the same fact; the server replicates the RCS
   *  bits (reverse/strafe) from it so remote clients can depict the plumes. */
  lastInput: InputState | null;
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
  readonly storms: StormSystem;
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
  /** Per-ship wreck-scrape damage cooldown (own clock — separate knob from rocks). */
  private readonly lastHulkBumpMs = new Map<Ship, number>();
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

    // --- Ion storms (map-placed; zero zones under stock config = no-op) ---
    this.storms = new StormSystem(
      GameConfig.arena.halfWidth,
      GameConfig.arena.halfDepth,
    );

    // --- Sensors + concealment (shared scene-free footprint math). Storm
    // zones conceal exactly like nebulas — hide in the storm, pay in HP. ---
    this.sensors = new SensorSystem(this.motherships);
    this.sensors.concealmentZones = [
      ...computeConcealmentZones(
        GameConfig.arena.halfWidth,
        GameConfig.arena.halfDepth,
      ),
      ...this.storms.zones,
    ];

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
      missileSalvo: type.missileSalvo,
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
      lastInput: null,
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
          c.lastInput = null; // catapult drives the ship; no pilot input to depict
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
      c.lastInput = input;
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
        const missilePositions = ship.tryFireMissile();
        if (missilePositions.length > 0) {
          // AI pilots home on the contact their controller chose; a HUMAN
          // seat (NetworkController) gets the same lock rule the offline
          // player's HUD applies (Game.computeLockTarget) — without this,
          // every networked player missile launched ballistic.
          const homing =
            c.controller instanceof AIController
              ? c.controller.missileTarget
              : this.computeLockFor(ship);
          for (const p of missilePositions) {
            this.factionMissiles[ship.faction].spawn(
              p,
              ship.rotationY,
              homing,
              ship,
            );
          }
          this.events.emit("missileFired", { ship, target: homing });
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
            // Arrival point, NOT the raw bay staging coordinate — the bay sits
            // inside the hull colliders and an unprotected teleport there
            // wedges the ship (no launch sequence to suspend the keep-out).
            const bay = home.getJumpArrivalPosition(c.bayIndex);
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
    this.resolveHulkCollisions(nowMs);
    this.resolveStormZaps(nowMs);

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

  /**
   * The enemy a HUMAN-driven seat's missile locks at launch — the sim-side
   * mirror of Game.computeLockTarget (offline computes it per frame for the
   * HUD; here it's needed only at the moment of fire): nearest live enemy
   * within lockRange, inside the lock cone, and NOT concealed in a nebula
   * (a cloud denies the seeker head its return, symmetric with the AI's
   * findMissileShot rule).
   */
  private computeLockFor(shooter: Ship): Ship | null {
    const cfg = GameConfig.missile;
    const px = shooter.position.x;
    const pz = shooter.position.z;
    let best: Ship | null = null;
    let bestDist = Infinity;
    for (const enemy of this.shipsByFaction[opposing(shooter.faction)]) {
      if (!enemy.isAlive) continue;
      const dx = enemy.position.x - px;
      const dz = enemy.position.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.lockRange || dist >= bestDist) continue;
      if (this.sensors.isConcealed(enemy.position)) continue;
      const angleToEnemy = Math.atan2(dx, dz);
      if (Math.abs(wrapAngle(angleToEnemy - shooter.rotationY)) > cfg.lockConeAngle) {
        continue;
      }
      best = enemy;
      bestDist = dist;
    }
    return best;
  }

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
    // Storm keep-outs: pilots route around the banks instead of eating zaps.
    for (const o of this.storms.obstacles) this.aiObstacles.push(o);
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
        if (!collideShipWithAsteroid(ship, rock)) continue;

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

  /** Zap every ship loitering in a storm (per-ship cadence in StormSystem).
   *  Mid-launch ships are exempt like the asteroid rams — the catapult owns
   *  them until they clear the bow. */
  private resolveStormZaps(nowMs: number): void {
    if (!this.storms.hasZones) return;
    for (const c of this.combatants) {
      if (c.launch && !c.launch.isComplete) continue;
      if (this.storms.tryZap(c.ship, nowMs)) {
        this.events.emit("stormZap", { ship: c.ship });
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
          bumpShipOutOfSection(ship, s);
        }
      }
    }
  }

  private resolveHulkCollisions(nowMs: number): void {
    const cfg = GameConfig.hulk;
    const bumpCooldownMs = cfg.bumpCooldownSec * 1000;
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      let scraped = false;
      for (const hulk of this.hulks) {
        for (const section of hulk.sections) {
          if (bumpShipOutOfHulkSection(ship, section)) scraped = true;
        }
      }
      if (!scraped) continue;
      // Scrape damage, cooldowned so a ship sliding along (or being rolled
      // over by) the wreck is ground down, not shredded per frame.
      const last = this.lastHulkBumpMs.get(ship) ?? -Infinity;
      if (nowMs - last >= bumpCooldownMs) {
        this.lastHulkBumpMs.set(ship, nowMs);
        ship.takeDamage(cfg.collisionDamage, nowMs);
        this.events.emit("shipRammedHulk", { ship });
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

  // (collision helpers live at module scope below — shared with the
  // networked client's prediction, which must bump identically)

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
   *  rooms), the base hold is launch.mpHoldSec. */
  private assignInitialLaunches(): void {
    this.stageLaunches(
      this.primaryLaunch
        ? LaunchSequence.cinematicHoldSec()
        : GameConfig.launch.mpHoldSec,
    );
  }

  /**
   * (Re)stage both fleets in their launch tubes, `baseHoldSec` before the
   * first catapult fires (each later ship adds the stagger). Idempotent —
   * every combatant is respawned at its bay with a fresh sequence — so a
   * server room can park the fleets on an effectively-infinite hold at
   * creation and RESTAGE with the real hold once the first client reports
   * ready, guaranteeing the opening launch is witnessed (BattleRoom).
   */
  stageLaunches(baseHoldSec: number): void {
    for (const f of ["humans", "machines"] as Faction[]) {
      const queue = this.combatants.filter((c) => c.ship.faction === f);
      // Cinematic seat first so it leads the stagger (its hold is the countdown).
      queue.sort((a, b) => Number(b.cinematic) - Number(a.cinematic));
      this.launchFleet(queue, this.motherships[f], baseHoldSec);
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

/**
 * Resolve one ship↔asteroid overlap: broad-phase circle, then the rock's true
 * top-down silhouette (surfaceRadiusToward); on overlap, push the ship to the
 * surface and cancel its inward velocity. Returns true when a bump happened.
 * GEOMETRY ONLY — ram damage/cooldown stay in resolveAsteroidCollisions.
 * Exported so the networked client's prediction bumps its local ship exactly
 * as the server will (otherwise rocks feel like rubber-band walls online).
 */
export function collideShipWithAsteroid(ship: Ship, rock: AsteroidSim): boolean {
  const dx = ship.position.x - rock.position.x;
  const dz = ship.position.z - rock.position.z;
  const distSq = dx * dx + dz * dz;
  const maxDist = ship.hitRadius + rock.radius;
  if (distSq >= maxDist * maxDist) return false;
  const minDist = ship.hitRadius + rock.surfaceRadiusToward(dx, dz);
  if (distSq >= minDist * minDist) return false;

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
  return true;
}

/**
 * Push a ship out of a carrier hull section (solid AABB): nearest-face
 * ejection with inward-velocity cancel; the degenerate inside-the-box case
 * exits through the closest face. Exported for the networked client's
 * prediction (same reason as collideShipWithAsteroid).
 */
export function bumpShipOutOfSection(ship: Ship, s: MothershipSection): void {
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

/** Scratch for the hulk bump's planar push-out (no per-frame allocation). */
const hulkPush: PlanarPushOut = { nx: 0, nz: 0, dist: 0 };

/**
 * Push a ship out of a wreck hull section (ORIENTED box, unlike the carrier's
 * axis-aligned sections): broad phase against the box's bounding circle, then
 * nearest-face planar ejection in the hull's local frame
 * (HulkSection.computePushOutXZ), cancelling the velocity component into that
 * face. NOT the asteroid-style radial-from-centre push — these boxes are far
 * longer than wide, so a centre-ray eject near the bow/stern points almost
 * along the hull and flings a grazing ship sideways at several times its own
 * speed. Returns true when a bump happened — GEOMETRY ONLY, the scrape
 * damage/cooldown stay in resolveHulkCollisions (like the asteroid split).
 * Exported for the networked client's prediction, the same reason as
 * bumpShipOutOfSection.
 */
export function bumpShipOutOfHulkSection(ship: Ship, section: HulkSection): boolean {
  const dx = ship.position.x - section.position.x;
  const dz = ship.position.z - section.position.z;
  const bound = ship.hitRadius + section.hitRadius;
  if (dx * dx + dz * dz >= bound * bound) return false;
  if (!section.computePushOutXZ(ship.position.x, ship.position.z, ship.hitRadius, hulkPush)) {
    return false;
  }
  ship.position.x += hulkPush.nx * hulkPush.dist;
  ship.position.z += hulkPush.nz * hulkPush.dist;
  const vn = ship.velocity.x * hulkPush.nx + ship.velocity.z * hulkPush.nz;
  if (vn < 0) {
    ship.velocity.x -= vn * hulkPush.nx;
    ship.velocity.z -= vn * hulkPush.nz;
  }
  return true;
}
