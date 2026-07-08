import { Room, type Client, ServerError, CloseCode } from "colyseus";
import { StateView } from "@colyseus/schema";

import {
  BattleSim,
  type SimCombatant,
  AIController,
  NetworkController,
  NEUTRAL_INPUT,
  FleetCommander,
  type CommandedPilot,
  GameConfig,
  Ship,
  type AsteroidSim,
  type DamageTarget,
  type Faction,
  type InputMessage,
  type JoinOptions,
  type ShipTypeId,
  type NetEvent,
  type EventsMessage,
  PROTOCOL_VERSION,
  PROTOCOL_MISMATCH,
  FACTION_FULL,
  MSG,
  aiCallsign,
  sanitizePilotName,
} from "@space-duel/shared";

import {
  BattleState,
  ShipSchema,
  MothershipSchema,
  AsteroidSchema,
  ScoreSchema,
} from "../schema/BattleState";

/** A flyable slot in the battle: one ship that is either AI-flown or, when a
 *  human is connected, driven by their networked input. */
interface Seat {
  id: string;
  faction: Faction;
  typeId: ShipTypeId;
  combatant: SimCombatant;
  ai: AIController;
  net: NetworkController;
  occupant: string | null; // client sessionId, or null when AI-flown
  schema: ShipSchema;
  /** Sequence number of the newest InputMessage applied (prediction ack). */
  lastInputSeq: number;
  /** This seat's generated AI callsign — worn while AI-flown, restored when
   *  a human occupant leaves (the bot resumes its own designation). */
  aiCallsign: string;
  /** The occupant's resolved callsign (pilot name, or the AI callsign when
   *  they joined anonymous) — kept across a disconnect so a reconnection
   *  restores the name the seat wore. "" when no human is attached. */
  pilotCallsign: string;
  /** SessionId holding a reconnection-grace reservation on this seat (the AI
   *  flies it meanwhile, but claimSeat won't give it away). null = free. */
  reserved: string | null;
}

const SIM_HZ = 30;
const PATCH_HZ = 20;
/** One fixed sim step (ms) — every advance uses exactly this (see step()). */
const TICK_MS = 1000 / SIM_HZ;
/** Hitch cap: at most this many catch-up ticks per callback; the rest of the
 *  accumulated delta is dropped (the fixed-dt mirror of Game.tick's clamp). */
const MAX_CATCHUP_TICKS = 3;
/** Pre-ready launch hold: effectively "park in the tubes until released". */
const HOLD_FOR_READY_SEC = 3600;
/** Release the launch anyway this long after creation (a client that never
 *  sends MSG.ready — crashed mid-load, ancient build — can't stall the match). */
const READY_SAFETY_MS = 20_000;

/**
 * Server-authoritative battle room (docs/MULTIPLAYER.md Phase 1). Runs the
 * shared BattleSim at a fixed tick and replicates a small per-ship state to
 * every client; clients send InputState, the server replays it into their seat.
 *
 * AI backfill: every seat starts AI-flown, so a freshly-created room plays a
 * full battle on its own (solo join = today's single-player, server-side).
 * Joining humans replace an AI in a seat on their faction; leaving hands the
 * seat back to AI. The honesty rule (HUD/radar tag bots) is served by the
 * replicated `isAI` flag.
 */
export class BattleRoom extends Room<{ state: BattleState }> {
  private sim!: BattleSim;
  private readonly seats: Seat[] = [];
  private readonly seatBySession = new Map<string, Seat>();
  /** Accumulated (clamped) sim time, replicated as the interpolation clock. */
  private simTimeMs = 0;
  /** Fixed-dt accumulator: wall delta not yet consumed by whole sim ticks. */
  private tickAccMs = 0;
  /** FX facts collected from the sim bus during the current tick (Phase 2
   *  event replication); step() broadcasts + clears them after syncState. */
  private readonly pendingEvents: NetEvent[] = [];
  /** Live sim Ship → replicated schema id (the ships-map key clients see). */
  private readonly shipIds = new Map<Ship, string>();
  /** Whether the opening fleet launch has been released (first MSG.ready). */
  private launchReleased = false;
  /** Whether the end-of-match teardown (lock + delayed dispose) has run. */
  private matchEnded = false;
  /** Live sim rock → its replicated id (diffed each tick in syncAsteroids). */
  private readonly rockIds = new Map<AsteroidSim, string>();
  private nextRockId = 0;
  /** Victim ship id → shooter ship id of the last hit it took. Consumed on
   *  shipDied to attribute the kill on the wire (client kill/score HUD). */
  private readonly lastHitBy = new Map<string, string>();
  /** Each faction's AI-fleet default formation leader (the first striker) —
   *  restored when the last human on that side leaves. */
  private readonly defaultLeader: Record<Faction, Ship | null> = {
    humans: null,
    machines: null,
  };
  /** Live sim Ship → its Seat (event relay lookups: ship type on the wire). */
  private readonly seatByShip = new Map<Ship, Seat>();
  /**
   * Per-client replication view (sensor-filtered replication, Phase 2): the
   * `ships` map is view-tagged, so a client receives exactly the entries in
   * its StateView. Friendlies are added once at join and never leave; enemy
   * ships are diffed in/out each tick by syncClientViews from the sim's own
   * sensor picture (`visibleEnemies` mirrors the view's enemy content — the
   * StateView API has no cheap membership query).
   */
  private readonly clientViews = new Map<
    string,
    { view: StateView; faction: Faction; visibleEnemies: Set<Seat> }
  >();

  override onCreate(): void {
    this.setState(new BattleState());

    // Per-room seed: reproducible within a match, different across matches.
    BattleSim.seedRng((Math.random() * 0xffffffff) >>> 0);
    this.sim = new BattleSim();

    // Both teams are AI fleets to begin with; humans take seats on join.
    this.buildFleet("humans");
    this.buildFleet("machines");
    this.wireEventRelay();
    this.sim.start();
    // Park both fleets in their tubes until the first client is READY to
    // watch (MSG.ready) — a fixed hold gets eaten by asset loading and the
    // opening launch happens unseen. Safety timer so nothing stalls forever.
    this.sim.stageLaunches(HOLD_FOR_READY_SEC);
    this.clock.setTimeout(() => this.releaseLaunch(), READY_SAFETY_MS);

    // Carrier slots + initial match fields (the schema() factory leaves
    // primitives undefined; tick must start at 0 or `tick++` yields NaN).
    this.initMothershipSchema(this.state.humansMothership, "humans");
    this.initMothershipSchema(this.state.machinesMothership, "machines");
    this.state.phase = "launching";
    this.state.winner = "";
    this.state.tick = 0;
    this.state.timeMs = 0;
    this.state.pilotHumans = 0;
    this.state.pilotBots = this.seats.length;

    this.maxClients = this.seats.length;

    // Client → server input (sequenced — the seq is acked back through
    // ShipSchema.lastInputSeq so the sender's prediction can reconcile).
    // Frames are QUEUED, one consumed per sim tick, so each acked seq maps to
    // exactly one fixed step — the invariant the client replay assumes (see
    // NetworkController). While the catapult suppresses the controller the
    // queue would only hoard stale frames, so hold-latest + ack-on-arrival
    // there (the client doesn't predict in the tube; nothing replays).
    this.onMessage(MSG.input, (client: Client, msg: InputMessage) => {
      if (!msg?.input) return;
      const seat = this.seatBySession.get(client.sessionId);
      if (!seat) return;
      if (seat.combatant.launch !== null) {
        seat.net.setInput(msg.input);
        seat.lastInputSeq = msg.seq;
      } else {
        seat.net.pushInput(msg.seq, msg.input);
      }
    });

    // First loaded-and-rendering client releases the opening launch.
    this.onMessage(MSG.ready, () => this.releaseLaunch());

    // Fixed-dt sim (accumulator): every tick advances EXACTLY 1/SIM_HZ, so a
    // consumed input frame equals the 1/SIM_HZ step the client's prediction
    // replays for it — measured-delta ticks made the two drift apart, which
    // reconciliation rendered as speed-proportional judder. The catch-up cap
    // plays the role of Game.tick's delta clamp: a hitch drops sim time
    // instead of teleporting ships (clients re-sync their clock offset).
    this.setSimulationInterval((deltaMs) => this.step(deltaMs), 1000 / SIM_HZ);
    this.setPatchRate(1000 / PATCH_HZ);
  }

  override onJoin(client: Client, options: JoinOptions): void {
    if (!options || options.protocolVersion !== PROTOCOL_VERSION) {
      throw new ServerError(
        PROTOCOL_MISMATCH,
        `protocol mismatch: server ${PROTOCOL_VERSION}, client ${options?.protocolVersion ?? "?"}`,
      );
    }
    const seat = this.claimSeat(options.faction, options.shipType);
    if (!seat) {
      throw new ServerError(FACTION_FULL, `no free seat on faction ${options.faction}`);
    }
    seat.occupant = client.sessionId;
    seat.combatant.controller = seat.net; // input arrives via the MSG.input handler
    seat.net.setInput(NEUTRAL_INPUT); // start from a clean frame until the first message
    seat.schema.isAI = false;
    seat.schema.owner = client.sessionId; // lets that client find its own ship
    // The seat wears the human's name while they fly it. Sanitized HERE (not
    // just client-side) — the wire string feeds every peer's DOM nameplates.
    // Empty after sanitizing = keep the AI callsign; nobody flies anonymous.
    const pilotName = sanitizePilotName(options.pilotName);
    seat.schema.callsign = pilotName !== "" ? pilotName : seat.aiCallsign;
    seat.pilotCallsign = seat.schema.callsign; // survives a disconnect for the reclaim
    this.syncScoreIdentity(seat);
    this.seatBySession.set(client.sessionId, seat);

    // Sensor-filtered replication: this client's view starts with every
    // FRIENDLY ship (always replicated — the radar shows friendly truth) and
    // whatever enemies its faction currently tracks; syncClientViews keeps
    // the enemy half honest from here on.
    const view = new StateView();
    for (const s of this.seats) {
      if (s.faction === seat.faction) view.add(s.schema);
    }
    client.view = view;
    this.clientViews.set(client.sessionId, {
      view,
      faction: seat.faction,
      visibleEnemies: new Set(),
    });
    this.syncClientViews();

    this.retaskLeader(seat.faction);
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const seat = this.seatBySession.get(client.sessionId);
    if (!seat) return;
    this.seatBySession.delete(client.sessionId);
    // Hand the seat back to its AI brain either way — the match stays
    // balanced whether or not the pilot comes back.
    seat.occupant = null;
    seat.combatant.controller = seat.ai;
    seat.schema.isAI = true;
    seat.schema.owner = "";
    seat.schema.callsign = seat.aiCallsign; // the bot resumes its designation
    this.syncScoreIdentity(seat);
    this.retaskLeader(seat.faction);

    if (code === CloseCode.CONSENTED || this.matchEnded) {
      // Intentional exit (menu/leave(true)) — or any leave once the match is
      // decided: there is nothing to reclaim a seat INTO, and a held
      // reservation would only delay the ended room's disposal.
      this.clientViews.delete(client.sessionId);
      seat.pilotCallsign = "";
      return;
    }

    // Unexpected drop: hold the seat for the same session while the AI flies
    // it. The clientViews entry stays ALIVE through the window — sessionId
    // and client.view both survive a Colyseus reconnection, and letting
    // syncClientViews keep diffing prevents stale enemy entries from
    // lingering in the surviving StateView.
    seat.reserved = client.sessionId;
    try {
      await this.allowReconnection(client, GameConfig.net.reconnectGraceSec);
      // Reclaimed: same restore as onJoin, wearing the name the seat had.
      seat.reserved = null;
      seat.occupant = client.sessionId;
      seat.combatant.controller = seat.net;
      seat.net.setInput(NEUTRAL_INPUT); // clears any stale pre-drop frames
      seat.schema.isAI = false;
      seat.schema.owner = client.sessionId;
      seat.schema.callsign =
        seat.pilotCallsign !== "" ? seat.pilotCallsign : seat.aiCallsign;
      this.syncScoreIdentity(seat);
      this.seatBySession.set(client.sessionId, seat);
      this.retaskLeader(seat.faction);
    } catch {
      // Window elapsed (or the room disposed): the AI keeps the seat.
      seat.reserved = null;
      seat.pilotCallsign = "";
      this.clientViews.delete(client.sessionId);
    }
  }

  /**
   * Point a faction's formation leadership at its senior HUMAN pilot — the
   * friendly-escort feature: the fleet's `cover` wing (the FleetCommander
   * re-asserts those orders every think) and loitering hunters station-keep
   * on ControllerWorld.leader, so re-seating the leader is all it takes for
   * the AI wing to fly cover on the player. No humans on the side = the
   * default AI leader (first striker) takes the wing back.
   */
  private retaskLeader(faction: Faction): void {
    let human: Ship | null = null;
    for (const seat of this.seatBySession.values()) {
      if (seat.faction === faction) {
        human = seat.combatant.ship; // insertion order ⇒ earliest-joined wins
        break;
      }
    }
    this.sim.setLeader(faction, human ?? this.defaultLeader[faction]);
  }

  /**
   * End-of-match room lifecycle (Phase 3): a decided battle accepts no new
   * pilots — lock() takes the room out of matchmaking immediately, so a
   * rematch quick-match (joinOrCreate) creates a FRESH room and a stale
   * `#join=` invite link falls back to one (the client already degrades a
   * failed joinById to a quick match). The room then lingers just long
   * enough for the players to read the end banner before disconnect()
   * disposes it; leaves during the window skip the reconnection seat-hold
   * (see onLeave) so an emptied room isn't kept alive by a reservation.
   */
  private onMatchEnded(): void {
    this.matchEnded = true;
    this.lock();
    this.clock.setTimeout(
      () => this.disconnect(),
      GameConfig.net.endedRoomLingerSec * 1000,
    );
  }

  /** Restage the parked fleets with the real (short) pre-launch hold. */
  private releaseLaunch(): void {
    if (this.launchReleased) return;
    this.launchReleased = true;
    this.sim.stageLaunches(GameConfig.launch.mpHoldSec);
  }

  // ─── Sim loop ─────────────────────────────────────────────────────────────

  private step(deltaMs: number): void {
    // Fixed-dt accumulator (see onCreate): run whole 1/SIM_HZ ticks, carry the
    // remainder. Capped at a few ticks so a hitch can't burst-advance the sim.
    this.tickAccMs = Math.min(this.tickAccMs + deltaMs, TICK_MS * MAX_CATCHUP_TICKS);
    let ticked = false;
    while (this.tickAccMs >= TICK_MS) {
      this.tickAccMs -= TICK_MS;
      this.simTimeMs += TICK_MS;
      this.sim.advance(TICK_MS / 1000);
      ticked = true;
    }
    if (!ticked) return; // nothing advanced — keep the last synced state
    // Ack the input frames the tick(s) actually consumed (never regress: the
    // launch-tube path acks on arrival, ahead of the controller's counter).
    for (const seat of this.seats) {
      seat.lastInputSeq = Math.max(seat.lastInputSeq, seat.net.lastConsumedSeq);
    }
    this.syncState();
    this.syncClientViews();
    if (this.sim.ended && !this.matchEnded) this.onMatchEnded();
    if (this.pendingEvents.length > 0) {
      const msg: EventsMessage = { t: this.simTimeMs, events: [...this.pendingEvents] };
      this.broadcast(MSG.events, msg);
      this.pendingEvents.length = 0;
    }
  }

  /**
   * Serialize the sim's transient-FX facts onto the wire (Phase 2 event
   * replication, docs/MULTIPLAYER.md): live object refs become schema ids and
   * raw coordinates here, at the network boundary — exactly the seam
   * sim/SimEvents.ts promises.
   */
  private wireEventRelay(): void {
    const ev = this.sim.events;
    const id = (ship: Ship | null): string =>
      (ship && this.shipIds.get(ship)) || "";
    const targetId = (t: DamageTarget | null): string =>
      t instanceof Ship ? id(t) : "";
    // Shooter faction/type + launch pose ride the events because the shooter
    // itself may be sensor-hidden from a given client (filtered replication):
    // its bolts/rounds are still visible objects, so their depiction can't
    // depend on the client holding the shooter's replicated metadata.
    const typeOf = (ship: Ship): ShipTypeId =>
      this.seatByShip.get(ship)?.typeId ?? "spitfire";
    ev.on("shipFiredLaser", ({ ship, muzzles }) =>
      this.pendingEvents.push({
        k: "laserFired",
        ship: id(ship),
        f: ship.faction,
        st: typeOf(ship),
        rot: ship.rotationY,
        mx: muzzles.map((m) => m.x),
        mz: muzzles.map((m) => m.z),
      }),
    );
    ev.on("missileFired", ({ ship, target }) => {
      const off = GameConfig.missile.spawnOffset;
      this.pendingEvents.push({
        k: "missileFired",
        ship: id(ship),
        f: ship.faction,
        target: id(target),
        x: ship.position.x + Math.sin(ship.rotationY) * off,
        z: ship.position.z + Math.cos(ship.rotationY) * off,
        rot: ship.rotationY,
      });
    });
    // Kill attribution: remember the last shooter to land a hit on each ship;
    // shipDied consumes it. Ships only (both ids non-empty) — carrier and
    // turret damage doesn't feed the fighter kill board.
    const recordHit = (target: string, shooter: string): void => {
      if (target !== "" && shooter !== "") this.lastHitBy.set(target, shooter);
    };
    ev.on("laserHit", ({ target, shooter, position }) => {
      const t = targetId(target);
      const s = id(shooter);
      recordHit(t, s);
      this.pendingEvents.push({
        k: "laserHit",
        x: position.x,
        y: position.y,
        z: position.z,
        target: t,
        shooter: s,
      });
    });
    ev.on("missileHit", ({ position, struck, shooter }) => {
      const t = targetId(struck);
      const s = id(shooter);
      recordHit(t, s);
      this.pendingEvents.push({
        k: "missileHit",
        x: position.x,
        y: position.y,
        z: position.z,
        target: t,
        shooter: s,
      });
    });
    ev.on("missileIntercepted", ({ position }) =>
      this.pendingEvents.push({
        k: "missileIntercepted",
        x: position.x,
        y: position.y,
        z: position.z,
      }),
    );
    ev.on("shipLaunched", ({ ship }) =>
      this.pendingEvents.push({ k: "shipLaunched", ship: id(ship) }),
    );
    ev.on("shipDied", ({ ship }) => {
      const victim = id(ship);
      const by = this.lastHitBy.get(victim) ?? "";
      // Scoreboard tally (the replicated running leaderboard): the death
      // always counts; a non-empty attribution credits the shooter the
      // victim's max hull — the same score currency as the client HUD.
      const victimScore = this.state.scores.get(victim);
      if (victimScore) victimScore.deaths++;
      const shooterScore = by !== "" ? this.state.scores.get(by) : undefined;
      if (shooterScore) {
        shooterScore.kills++;
        shooterScore.score += ship.maxHp;
      }
      this.pendingEvents.push({
        k: "shipDied",
        ship: victim,
        x: ship.position.x,
        z: ship.position.z,
        by,
        vf: ship.faction,
        vt: typeOf(ship),
      });
      this.lastHitBy.delete(victim); // a respawned ship starts a fresh ledger
    });
    ev.on("mothershipDied", ({ mothership }) =>
      this.pendingEvents.push({ k: "mothershipDied", faction: mothership.faction }),
    );
    ev.on("turretFired", ({ faction, origin, rotationY }) =>
      this.pendingEvents.push({
        k: "turretFired",
        faction,
        rot: rotationY,
        x: origin.x,
        y: origin.y,
        z: origin.z,
      }),
    );
    ev.on("turretDestroyed", ({ position }) =>
      this.pendingEvents.push({
        k: "turretDestroyed",
        x: position.x,
        y: position.y,
        z: position.z,
      }),
    );
    ev.on("jumpSpoolStarted", ({ ship }) =>
      this.pendingEvents.push({ k: "jumpSpoolStarted", ship: id(ship) }),
    );
    ev.on("jumpCancelled", ({ ship }) =>
      this.pendingEvents.push({ k: "jumpCancelled", ship: id(ship) }),
    );
    ev.on("jumpFired", ({ ship, fromX, fromZ, toX, toZ }) =>
      this.pendingEvents.push({
        k: "jumpFired",
        ship: id(ship),
        fromX,
        fromZ,
        toX,
        toZ,
      }),
    );
    ev.on("asteroidShattered", ({ position, radius }) =>
      this.pendingEvents.push({
        k: "asteroidShattered",
        x: position.x,
        y: position.y,
        z: position.z,
        r: radius,
      }),
    );
    ev.on("shipRammedAsteroid", ({ ship }) =>
      this.pendingEvents.push({ k: "shipRammedAsteroid", ship: id(ship) }),
    );
    ev.on("stormZap", ({ ship }) =>
      this.pendingEvents.push({ k: "stormZap", ship: id(ship) }),
    );
  }

  /**
   * Diff the sim's live rocks against the replicated map: new rocks (initial
   * field, shatter chunks) get their SPAWN STATE captured once; rocks gone
   * from the sim (shattered/destroyed) get their entries deleted. Drift and
   * spin are constant, so this is the ONLY asteroid traffic — clients
   * integrate poses locally from t0 on the shared sim clock.
   */
  private syncAsteroids(): void {
    const live = this.sim.asteroids.asteroids;
    const liveSet = new Set<AsteroidSim>();
    for (const rock of live) {
      liveSet.add(rock);
      if (this.rockIds.has(rock)) continue;
      const id = `rock-${this.nextRockId++}`;
      this.rockIds.set(rock, id);
      const r = new AsteroidSchema();
      r.id = id;
      r.t0 = this.simTimeMs;
      r.x = rock.position.x;
      r.z = rock.position.z;
      r.rotX = rock.rotation.x;
      r.rotY = rock.rotation.y;
      r.rotZ = rock.rotation.z;
      r.driftX = rock.drift.x;
      r.driftZ = rock.drift.z;
      r.spinX = rock.spin.x;
      r.spinY = rock.spin.y;
      r.spinZ = rock.spin.z;
      r.visualRadius = rock.visualRadius;
      r.squashX = rock.squashX;
      r.squashY = rock.squashY;
      this.state.asteroids.set(id, r);
    }
    for (const [rock, id] of this.rockIds) {
      if (liveSet.has(rock)) continue;
      this.rockIds.delete(rock);
      this.state.asteroids.delete(id);
    }
  }

  private syncState(): void {
    this.syncAsteroids();
    for (const seat of this.seats) {
      const ship = seat.combatant.ship;
      const s = seat.schema;
      s.x = ship.position.x;
      s.z = ship.position.z;
      s.vx = ship.velocity.x;
      s.vz = ship.velocity.z;
      s.rotationY = ship.rotationY;
      s.bankAngle = ship.bankAngle;
      s.hp = ship.hp;
      s.alive = ship.isAlive;
      s.cannonAmmo = ship.cannonAmmo;
      s.missileAmmo = ship.missileAmmo;
      s.launching = seat.combatant.launch !== null;
      s.lastInputSeq = seat.lastInputSeq;
      // RCS depiction bits: the input the tick actually applied (null while
      // dead / catapulted, which correctly reads as engines-quiet).
      const applied = ship.isAlive ? seat.combatant.lastInput : null;
      s.reverse = applied?.reverse ?? false;
      s.strafeLeft = applied?.strafeLeft ?? false;
      s.strafeRight = applied?.strafeRight ?? false;
    }
    this.syncMothership(this.state.humansMothership, "humans");
    this.syncMothership(this.state.machinesMothership, "machines");

    this.state.phase = this.sim.state;
    this.state.winner = this.sim.winner ?? "";
    this.state.tick++;
    this.state.timeMs = this.simTimeMs;
    this.state.pilotHumans = this.seatBySession.size;
    this.state.pilotBots = this.seats.length - this.seatBySession.size;
  }

  /**
   * The anti-wallhack gate (sensor-filtered replication, docs/MULTIPLAYER.md
   * Phase 2): diff each client's StateView against its faction's live sensor
   * picture. An enemy ship replicates while the faction holds a FRESH track
   * on it (`SensorSystem.isTracked` — the same rule the server AI flies on
   * and the client HUD mirrors for its DETECTED/HIDDEN cue; a spooling jump
   * drive force-detects, so runners still telegraph) and drops off the wire
   * the sweep it goes stale — nebula stealth hides the ship from packet
   * sniffing, not just from the radar. Death removes it too (isTracked
   * requires isAlive); the explosion still reaches everyone as the shipDied
   * EVENT, which is deliberately unfiltered (observable, like offline).
   */
  private syncClientViews(): void {
    for (const cv of this.clientViews.values()) {
      for (const seat of this.seats) {
        if (seat.faction === cv.faction) continue; // friendlies never leave
        const tracked = this.sim.sensors.isTracked(cv.faction, seat.combatant.ship);
        if (tracked && !cv.visibleEnemies.has(seat)) {
          cv.view.add(seat.schema);
          cv.visibleEnemies.add(seat);
        } else if (!tracked && cv.visibleEnemies.has(seat)) {
          cv.view.remove(seat.schema);
          cv.visibleEnemies.delete(seat);
        }
      }
    }
  }

  // ─── Scenario assembly ──────────────────────────────────────────────────────

  /**
   * Build one team's fleet into the sim from GameConfig.fleets, with the same
   * strike / escort / patrol split the single-player enemy fleet uses, and give
   * the faction a FleetCommander. Each ship becomes an AI-flown Seat.
   */
  private buildFleet(faction: Faction): void {
    const fleet = GameConfig.fleets[faction];
    const escortEnd = fleet.strikeCount + GameConfig.commander.escortCount;
    const pilots: CommandedPilot[] = [];
    let index = 0;
    for (const entry of fleet.fleet) {
      const type = GameConfig.shipTypes[entry.type];
      for (let i = 0; i < entry.count; i++, index++) {
        const ship = this.sim.spawnShip(faction, type, {
          respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
        });
        let ai: AIController;
        if (index < fleet.strikeCount) {
          ai = new AIController({ order: "strike" });
        } else if (index < escortEnd) {
          ai = new AIController({
            order: "cover",
            slot: GameConfig.player.wingmen.formationSlot(index - fleet.strikeCount),
          });
        } else {
          ai = new AIController({ order: "patrol" });
        }
        const combatant = this.sim.addCombatant({ ship, controller: ai });
        const schema = this.makeShipSchema(faction, entry.type, `${faction}-${index}`);
        // Deterministic per (faction, seat index) — the same fleet the
        // offline Game names in makeFighter.
        const callsign = aiCallsign(faction, index);
        schema.callsign = callsign;
        this.state.ships.set(schema.id, schema);
        // Every seat gets a scoreboard row from birth (0/0/0) — kills stay
        // with the SEAT across human↔AI occupancy swaps (the row renames via
        // syncScoreIdentity, matching how the seat keeps its ship/HP).
        this.state.scores.set(schema.id, this.makeScoreSchema(schema.id, callsign, faction));
        this.shipIds.set(ship, schema.id);
        const seat: Seat = {
          id: schema.id,
          faction,
          typeId: entry.type,
          combatant,
          ai,
          net: new NetworkController(),
          occupant: null,
          schema,
          lastInputSeq: 0,
          aiCallsign: callsign,
          pilotCallsign: "",
          reserved: null,
        };
        this.seats.push(seat);
        this.seatByShip.set(ship, seat);
        pilots.push({ ship, ai });
      }
    }
    if (pilots.length > 0) {
      this.defaultLeader[faction] = pilots[0].ship;
      this.sim.setLeader(faction, pilots[0].ship);
    }
    this.sim.addCommander(
      new FleetCommander(pilots, fleet.strikeCount, this.sim.worldByFaction[faction]),
    );
  }

  /** Claim a free AI seat on `faction`, preferring the requested ship type.
   *  Seats reserved for a reconnecting pilot are not up for grabs. */
  private claimSeat(faction: Faction, typeId: ShipTypeId): Seat | null {
    const free = this.seats.filter(
      (s) => s.faction === faction && s.occupant === null && s.reserved === null,
    );
    return free.find((s) => s.typeId === typeId) ?? free[0] ?? null;
  }

  // ─── Schema helpers ─────────────────────────────────────────────────────────

  private makeShipSchema(faction: Faction, typeId: ShipTypeId, id: string): ShipSchema {
    // Initialize EVERY field — the schema() factory leaves unset primitives
    // undefined, which would replicate as undefined until the first syncState.
    const ship = new ShipSchema();
    ship.id = id;
    ship.owner = "";
    ship.faction = faction;
    ship.shipType = typeId;
    ship.x = 0;
    ship.z = 0;
    ship.vx = 0;
    ship.vz = 0;
    ship.rotationY = 0;
    ship.bankAngle = 0;
    ship.lastInputSeq = 0;
    ship.maxHp = GameConfig.shipTypes[typeId].maxHp;
    ship.hp = ship.maxHp;
    ship.cannonAmmo = GameConfig.shipTypes[typeId].cannonAmmo;
    ship.missileAmmo = GameConfig.shipTypes[typeId].missileAmmo;
    ship.alive = true;
    ship.launching = true;
    ship.isAI = true;
    ship.callsign = ""; // real value set by buildFleet (every-field-init rule)
    ship.reverse = false;
    ship.strafeLeft = false;
    ship.strafeRight = false;
    return ship;
  }

  private makeScoreSchema(id: string, callsign: string, faction: Faction): ScoreSchema {
    // Initialize EVERY field (same every-field-init rule as makeShipSchema).
    const score = new ScoreSchema();
    score.id = id;
    score.callsign = callsign;
    score.faction = faction;
    score.isAI = true;
    score.kills = 0;
    score.deaths = 0;
    score.score = 0;
    return score;
  }

  /**
   * Mirror a seat's replicated identity (callsign + isAI) onto its scoreboard
   * row — call after every occupancy swap site that rewrites seat.schema
   * (join, leave, reconnection reclaim). The tally itself stays with the seat.
   */
  private syncScoreIdentity(seat: Seat): void {
    const entry = this.state.scores.get(seat.id);
    if (entry) {
      entry.callsign = seat.schema.callsign;
      entry.isAI = seat.schema.isAI;
    }
  }

  private initMothershipSchema(schema: MothershipSchema, faction: Faction): void {
    const ms = this.sim.motherships[faction];
    schema.faction = faction;
    schema.maxHp = ms.maxHp;
    schema.hp = ms.hp;
    schema.alive = ms.isAlive;
  }

  private syncMothership(schema: MothershipSchema, faction: Faction): void {
    const ms = this.sim.motherships[faction];
    schema.hp = ms.hp;
    schema.alive = ms.isAlive;
  }
}
