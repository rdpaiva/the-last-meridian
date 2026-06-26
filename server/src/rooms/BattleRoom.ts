import { Room, type Client, ServerError } from "colyseus";

import {
  BattleSim,
  type SimCombatant,
  AIController,
  NetworkController,
  NEUTRAL_INPUT,
  FleetCommander,
  type CommandedPilot,
  GameConfig,
  type Faction,
  type InputState,
  type JoinOptions,
  type ShipTypeId,
  PROTOCOL_VERSION,
  PROTOCOL_MISMATCH,
  MSG,
} from "@space-duel/shared";

import { BattleState, ShipSchema, MothershipSchema } from "../schema/BattleState";

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
}

const SIM_HZ = 30;
const PATCH_HZ = 15;

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

  override onCreate(): void {
    this.setState(new BattleState());

    // Per-room seed: reproducible within a match, different across matches.
    BattleSim.seedRng((Math.random() * 0xffffffff) >>> 0);
    this.sim = new BattleSim();

    // Both teams are AI fleets to begin with; humans take seats on join.
    this.buildFleet("humans");
    this.buildFleet("machines");
    this.sim.start();

    // Carrier slots + initial match fields (the schema() factory leaves
    // primitives undefined; tick must start at 0 or `tick++` yields NaN).
    this.initMothershipSchema(this.state.humansMothership, "humans");
    this.initMothershipSchema(this.state.machinesMothership, "machines");
    this.state.phase = "launching";
    this.state.winner = "";
    this.state.tick = 0;

    this.maxClients = this.seats.length;

    // Client → server input.
    this.onMessage(MSG.input, (client: Client, input: InputState) => {
      this.seatBySession.get(client.sessionId)?.net.setInput(input);
    });

    // Fixed-tick sim; clamp the delta exactly like Game.tick so a hitch can't
    // teleport ships (the server never freezes — no hitstop here).
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
      throw new ServerError(4002, `no free seat on faction ${options.faction}`);
    }
    seat.occupant = client.sessionId;
    seat.combatant.controller = seat.net; // input arrives via the MSG.input handler
    seat.net.setInput(NEUTRAL_INPUT); // start from a clean frame until the first message
    seat.schema.isAI = false;
    seat.schema.owner = client.sessionId; // lets that client find its own ship
    this.seatBySession.set(client.sessionId, seat);
  }

  override onLeave(client: Client): void {
    const seat = this.seatBySession.get(client.sessionId);
    if (!seat) return;
    this.seatBySession.delete(client.sessionId);
    // Hand the seat back to its AI brain so the match stays balanced.
    seat.occupant = null;
    seat.combatant.controller = seat.ai;
    seat.schema.isAI = true;
    seat.schema.owner = "";
  }

  // ─── Sim loop ─────────────────────────────────────────────────────────────

  private step(deltaMs: number): void {
    const dt = Math.min(deltaMs / 1000, GameConfig.scene.maxDeltaSeconds);
    this.sim.advance(dt);
    this.syncState();
  }

  private syncState(): void {
    for (const seat of this.seats) {
      const ship = seat.combatant.ship;
      const s = seat.schema;
      s.x = ship.position.x;
      s.z = ship.position.z;
      s.rotationY = ship.rotationY;
      s.bankAngle = ship.bankAngle;
      s.hp = ship.hp;
      s.alive = ship.isAlive;
      s.launching = seat.combatant.launch !== null;
    }
    this.syncMothership(this.state.humansMothership, "humans");
    this.syncMothership(this.state.machinesMothership, "machines");

    this.state.phase = this.sim.state;
    this.state.winner = this.sim.winner ?? "";
    this.state.tick++;
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
        this.state.ships.set(schema.id, schema);
        this.seats.push({
          id: schema.id,
          faction,
          typeId: entry.type,
          combatant,
          ai,
          net: new NetworkController(),
          occupant: null,
          schema,
        });
        pilots.push({ ship, ai });
      }
    }
    if (pilots.length > 0) this.sim.setLeader(faction, pilots[0].ship);
    this.sim.addCommander(
      new FleetCommander(pilots, fleet.strikeCount, this.sim.worldByFaction[faction]),
    );
  }

  /** Claim a free AI seat on `faction`, preferring the requested ship type. */
  private claimSeat(faction: Faction, typeId: ShipTypeId): Seat | null {
    const free = this.seats.filter((s) => s.faction === faction && s.occupant === null);
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
    ship.rotationY = 0;
    ship.bankAngle = 0;
    ship.maxHp = GameConfig.shipTypes[typeId].maxHp;
    ship.hp = ship.maxHp;
    ship.alive = true;
    ship.launching = true;
    ship.isAI = true;
    return ship;
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
