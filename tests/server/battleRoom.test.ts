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
      const client = await colyseus.connectTo(room, joinOpts());
      // Wait for the first replicated patch to reach the client.
      expect(await waitUntil(() => (client.state?.ships?.size ?? 0) > 0)).toBe(true);

      // Both fleets present (AI backfill) and replicated to the client.
      expect(room.state.ships.size).toBe(TOTAL_SHIPS);
      expect(client.state.ships.size).toBe(TOTAL_SHIPS);
      expect(client.state.humansMothership.maxHp).toBeGreaterThan(0);
      expect(client.state.machinesMothership.maxHp).toBeGreaterThan(0);

      // The joining human took exactly one AI seat on humans, of the requested
      // type; every other seat stays AI (the honesty flag).
      const humanSeats = [...room.state.ships.values()].filter(
        (s) => s.faction === "humans" && !s.isAI,
      );
      expect(humanSeats).toHaveLength(1);
      expect(humanSeats[0].shipType).toBe("spitfire");
      expect([...room.state.ships.values()].filter((s) => !s.isAI)).toHaveLength(1);

      await client.leave();
    },
    TEST_TIMEOUT,
  );

  it(
    "advances the shared sim on the server (launches clear, ships move)",
    async () => {
      const room = await colyseus.createRoom(BATTLE_ROOM, {});
      await colyseus.connectTo(room, joinOpts());

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
