/**
 * Phase 1 integration test (docs/MULTIPLAYER.md → Verification). Proves the
 * server pipe end-to-end WITHOUT a browser, using @colyseus/testing: boot the
 * BattleRoom in-process, join as a client, and assert that
 *   1. the room replicates a populated battle (AI backfill — both fleets present),
 *   2. a joining human takes an AI seat on their faction (the isAI honesty flag),
 *   3. the shared sim actually advances on the server (launches clear → playing,
 *      ships move),
 *   4. client InputState replays into that seat's Ship over the wire (the
 *      NetworkController seam — the human ship turns under held input),
 *   5. a protocol-version mismatch is rejected.
 *
 * The pure NetworkController → Ship seam is unit-proven separately in
 * tests/sim/networkController.test.ts; here we prove the NETWORK transport
 * carries the input to that seam.
 *
 * This is the doorstep the [human] two-tab acceptance test stands on.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import defineConfig from "@colyseus/tools";

import {
  BATTLE_ROOM,
  PROTOCOL_VERSION,
  MSG,
  NEUTRAL_INPUT,
  GameConfig,
  type JoinOptions,
  type InputMessage,
  type EventsMessage,
} from "../../shared/src/index";
import { BattleRoom } from "../../server/src/rooms/BattleRoom";

/** Expected total fleet size = both factions' configured fleet counts. */
const fleetCount = (f: "humans" | "machines"): number =>
  GameConfig.fleets[f].fleet.reduce((n, e) => n + e.count, 0);
const TOTAL_SHIPS = fleetCount("humans") + fleetCount("machines");

const TEST_TIMEOUT = 30_000;

const joinOpts = (over: Partial<JoinOptions> = {}): JoinOptions => ({
  protocolVersion: PROTOCOL_VERSION,
  faction: "humans",
  shipType: "spitfire",
  pilotName: "",
  ...over,
});

/** Shortest signed angle from a to b (radians), wrap-safe. */
const angleDelta = (a: number, b: number): number =>
  Math.atan2(Math.sin(b - a), Math.cos(b - a));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` until true or the cap elapses (real timers; the sim runs on them). */
async function waitUntil(cond: () => boolean, capMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < capMs) await sleep(25);
  return cond();
}

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await boot(
    defineConfig({
      initializeGameServer: (gameServer) => {
        gameServer.define(BATTLE_ROOM, BattleRoom);
      },
    }),
  );
});

afterAll(async () => {
  await colyseus.shutdown();
});

beforeEach(async () => {
  await colyseus.cleanup();
});

describe("BattleRoom integration", () => {
  it(
    "replicates a full AI-backfilled battle to a joining client",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      const client = await colyseus.connectTo(room, joinOpts({ pilotName: "Maverick" }));
      // Wait for the first replicated patch to reach the client.
      expect(await waitUntil(() => (client.state?.ships?.size ?? 0) > 0)).toBe(true);

      // Both fleets present server-side (AI backfill)…
      expect(room.state.ships.size).toBe(TOTAL_SHIPS);
      // …but the CLIENT receives only its own faction plus tracked enemies:
      // at match start the enemy fleet sits parked at its carrier, outside
      // every human sensor (sensor-filtered replication — anti-wallhack).
      expect(client.state.ships.size).toBe(fleetCount("humans"));
      expect(
        [...client.state.ships.values()].every((s) => s.faction === "humans"),
      ).toBe(true);
      expect(client.state.humansMothership.maxHp).toBeGreaterThan(0);
      expect(client.state.machinesMothership.maxHp).toBeGreaterThan(0);

      // Pilot counts ride unfiltered root fields (the client can't count the
      // filtered map): one human seat, every other seat a bot.
      expect(await waitUntil(() => client.state.pilotHumans === 1)).toBe(true);
      expect(client.state.pilotBots).toBe(TOTAL_SHIPS - 1);

      // The joining human took exactly one AI seat on humans, of the requested
      // type; every other seat stays AI (the honesty flag).
      const humanSeats = [...room.state.ships.values()].filter(
        (s) => s.faction === "humans" && !s.isAI,
      );
      expect(humanSeats).toHaveLength(1);
      expect(humanSeats[0].shipType).toBe("spitfire");
      expect([...room.state.ships.values()].filter((s) => !s.isAI)).toHaveLength(1);

      // Callsigns: the human seat wears the typed pilot name; every AI seat
      // carries a generated designation (nobody flies anonymous).
      expect(humanSeats[0].callsign).toBe("Maverick");
      expect(
        [...room.state.ships.values()].every((s) => s.callsign !== ""),
      ).toBe(true);
      const humanSeatId = humanSeats[0].id;

      await client.leave();
      // The seat hands back to AI and resumes its generated callsign — the
      // departed human's name must not linger on a bot (honesty rule).
      expect(
        await waitUntil(() => {
          const s = room.state.ships.get(humanSeatId);
          return s !== undefined && s.isAI && s.callsign !== "Maverick" && s.callsign !== "";
        }),
      ).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "advances the shared sim on the server (launches clear, ships move)",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      const client = await colyseus.connectTo(room, joinOpts());
      // The fleets hold in their tubes until a client reports ready.
      client.send(MSG.ready, {});

      // Snapshot after the first sim tick so positions are real (not the
      // pre-sync defaults), then prove they change as the battle plays out.
      await room.waitForNextSimulationTick();
      const before = [...room.state.ships.values()].map((s) => ({ x: s.x, z: s.z }));

      // Drive sim ticks until the match leaves "launching" (proves the catapults
      // ran and time advanced).
      expect(
        await waitUntil(() => room.state.phase === "playing"),
        "match never left the launching phase",
      ).toBe(true);
      expect(room.state.tick).toBeGreaterThan(0);

      // At least one ship has moved from its launch start.
      const after = [...room.state.ships.values()].map((s) => ({ x: s.x, z: s.z }));
      const moved = after.some(
        (p, i) => Math.hypot(p.x - before[i].x, p.z - before[i].z) > 1,
      );
      expect(moved, "no ship moved after launch").toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "replays client input into its seat over the wire (NetworkController seam)",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      const client = await colyseus.connectTo(room, joinOpts());

      // The seat this client occupies, found server-side.
      const seat = (room as unknown as { seatBySession: Map<string, { combatant: { ship: { debugInvulnerable: boolean } }; schema: { id: string } }> })
        .seatBySession.get(client.sessionId)!;
      const seatId = seat.schema.id;
      // Shield it from combat so a stray hit can't mask the input under test.
      seat.combatant.ship.debugInvulnerable = true;
      // Release the parked launch (fleets hold until a client reports ready).
      client.send(MSG.ready, {});

      // Wait until the seat clears its launch tube (the catapult suppresses the
      // controller until then).
      expect(
        await waitUntil(() => room.state.ships.get(seatId)!.launching === false),
        "seat never cleared the launch tube",
      ).toBe(true);
      expect(room.state.ships.get(seatId)!.alive).toBe(true);

      // Held rotateRight sent over the wire: the seat must turn (input reached
      // the sim through the transport + NetworkController).
      const rotBefore = room.state.ships.get(seatId)!.rotationY;
      client.send(MSG.input, {
        seq: 1,
        input: { ...NEUTRAL_INPUT, rotateRight: true },
      } satisfies InputMessage);
      for (let i = 0; i < 20; i++) await room.waitForNextSimulationTick();
      const rotAfter = room.state.ships.get(seatId)!.rotationY;
      // The applied seq must ack back through the schema (the prediction seam).
      expect(room.state.ships.get(seatId)!.lastInputSeq).toBe(1);
      expect(
        Math.abs(angleDelta(rotBefore, rotAfter)),
        "seat did not turn under held rotateRight — input did not reach the seat",
      ).toBeGreaterThan(0.1);

      await client.leave();
    },
    TEST_TIMEOUT,
  );

  it(
    "relays sim FX events to clients (Phase 2 event replication)",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      const client = await colyseus.connectTo(room, joinOpts());
      const batches: EventsMessage[] = [];
      client.onMessage(MSG.events, (msg: EventsMessage) => batches.push(msg));
      // Release the parked launch (fleets hold until a client reports ready).
      client.send(MSG.ready, {});

      // The fleets catapult out after launch.mpHoldSec — every launch must
      // reach the client as a shipLaunched fact on the events channel.
      expect(
        await waitUntil(() =>
          batches.some((b) => b.events.some((e) => e.k === "shipLaunched")),
        ),
        "no shipLaunched event batch reached the client",
      ).toBe(true);

      const batch = batches.find((b) =>
        b.events.some((e) => e.k === "shipLaunched"),
      )!;
      // Batches are stamped on the sim clock (the client's FX timeline)...
      expect(batch.t).toBeGreaterThan(0);
      // ...and refer to ships by their replicated schema id.
      const launched = batch.events.find((e) => e.k === "shipLaunched")!;
      if (launched.k === "shipLaunched") {
        expect(room.state.ships.has(launched.ship)).toBe(true);
      }

      await client.leave();
    },
    TEST_TIMEOUT,
  );

  it(
    "makes a joining human the faction's formation leader (escort wing), and hands it back on leave",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      const inner = room as unknown as {
        sim: { worldByFaction: Record<string, { leader: { position: unknown } | null }> };
        seatBySession: Map<string, { combatant: { ship: unknown } }>;
      };
      const aiLeader = inner.sim.worldByFaction.humans.leader;
      expect(aiLeader).not.toBeNull();

      const client = await colyseus.connectTo(room, joinOpts());
      // The human's ship now leads the wing — the commander's cover escorts
      // (and loitering hunters) station-keep on ControllerWorld.leader.
      const seat = inner.seatBySession.get(client.sessionId)!;
      expect(inner.sim.worldByFaction.humans.leader).toBe(seat.combatant.ship);
      // The other faction keeps its own AI leader.
      expect(inner.sim.worldByFaction.machines.leader).not.toBeNull();

      await client.leave();
      expect(
        await waitUntil(() => inner.sim.worldByFaction.humans.leader === aiLeader),
        "leadership never returned to the AI default after the human left",
      ).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "sensor-filters enemy replication (anti-wallhack), friendlies always on the wire",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      const client = await colyseus.connectTo(room, joinOpts()); // humans seat
      const inner = room as unknown as {
        seats: Array<{
          faction: string;
          occupant: string | null;
          schema: { id: string };
          combatant: {
            ship: {
              position: { set(x: number, y: number, z: number): void };
              debugInvulnerable: boolean;
              takeDamage(n: number): void;
            };
          };
        }>;
      };
      expect(await waitUntil(() => (client.state?.ships?.size ?? 0) > 0)).toBe(true);

      // Baseline: the parked enemy fleet is outside every human sensor —
      // nothing of it may reach this client's wire.
      expect(
        [...client.state.ships.values()].filter((s) => s.faction === "machines"),
      ).toHaveLength(0);

      client.send(MSG.ready, {});
      expect(await waitUntil(() => room.state.phase === "playing")).toBe(true);

      // Drag one enemy into the humans carrier's AWACS bubble (re-pinned each
      // poll against its AI): a fresh track must put it on the client's wire.
      const enemy = inner.seats.find((s) => s.faction === "machines")!;
      enemy.combatant.ship.debugInvulnerable = true; // carrier turrets fire on it here
      const enemyId = enemy.schema.id;
      expect(
        await waitUntil(() => {
          enemy.combatant.ship.position.set(200, 0, GameConfig.mothership.playerZ + 100);
          return client.state.ships.has(enemyId);
        }),
        "tracked enemy never replicated to the client",
      ).toBe(true);

      // Kill it: death drops the track instantly (the explosion is the
      // observable), and its respawn at the far carrier stays hidden — the
      // entry must LEAVE the client's map.
      enemy.combatant.ship.debugInvulnerable = false;
      enemy.combatant.ship.takeDamage(1e9);
      expect(
        await waitUntil(() => !client.state.ships.has(enemyId)),
        "dead/hidden enemy stayed on the wire",
      ).toBe(true);

      // Friendlies are never filtered: a killed humans ship stays replicated
      // (alive=false) instead of vanishing.
      const friendly = inner.seats.find(
        (s) => s.faction === "humans" && s.occupant === null,
      )!;
      friendly.combatant.ship.takeDamage(1e9);
      expect(
        await waitUntil(
          () => client.state.ships.get(friendly.schema.id)?.alive === false,
        ),
        "friendly death never replicated",
      ).toBe(true);
      expect(client.state.ships.has(friendly.schema.id)).toBe(true);

      await client.leave();
    },
    60_000,
  );

  it(
    "rejects a protocol-version mismatch",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      await expect(
        colyseus.connectTo(room, joinOpts({ protocolVersion: PROTOCOL_VERSION + 999 })),
      ).rejects.toBeDefined();
    },
    TEST_TIMEOUT,
  );
});
