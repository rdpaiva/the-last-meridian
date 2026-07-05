import { Client, type Room } from "@colyseus/sdk";

import {
  BATTLE_ROOM,
  GameConfig,
  PROTOCOL_VERSION,
  type JoinOptions,
  type Faction,
  type ShipTypeId,
} from "@space-duel/shared";

/** The loadout fields the join needs (matches client PlayerLoadout). */
export interface NetLoadout {
  faction: Faction;
  shipType: ShipTypeId;
}

/**
 * Default server endpoint. Baked at build time via VITE_SERVER_URL so the
 * static client can point at a deployed server; falls back to localhost for
 * dev (`npm run server` listens on :2567).
 */
export const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "ws://localhost:2567";

/**
 * The WITH FRIENDS invite payload: `#join=<roomId>` in the page URL. Read
 * live (not captured at load) — the hash is (re)written when a match starts,
 * so the address bar is always the shareable link.
 */
export function inviteRoomId(): string | null {
  const m = location.hash.match(/join=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Thin wrapper over the Colyseus client. Owns the connection + the joined room;
 * the NetworkGame reads `room.state` each frame and `send`s input. The room's
 * state decodes via schema reflection (the server ships the definition on join),
 * so the client needs no copy of the schema class.
 */
export class NetClient {
  readonly room: Room;

  /**
   * Netsim (GameConfig.net.sim) outbound release clock: monotonic, so a
   * lightly-jittered message never overtakes an earlier heavily-jittered one
   * (the simulated transport is TCP — delay, never reorder).
   */
  private lastSimSendAt = 0;

  private constructor(room: Room) {
    this.room = room;
    const sim = GameConfig.net.sim;
    if (sim.enabled) {
      // The netsim must be impossible to leave on silently — this banner plus
      // the NetDebugOverlay's pinned NETSIM badge are the safeguards.
      console.warn(
        `[NETSIM] Artificial network conditions ON — ${sim.latencyMs}ms RTT ` +
          `±${sim.jitterMs}ms jitter per message, both directions ` +
          `(GameConfig.net.sim — disable before judging real feel).`,
      );
    }
  }

  /** Quick match: join (or create) a battle room with the chosen loadout. */
  static async quickMatch(loadout: NetLoadout, url = SERVER_URL): Promise<NetClient> {
    const room = await new Client(url).joinOrCreate(BATTLE_ROOM, NetClient.options(loadout));
    return new NetClient(room);
  }

  /** Join a FRIEND'S room by id (the `#join=<roomId>` invite link). Throws if
   *  the room is gone/full — the caller decides the fallback. */
  static async joinById(
    roomId: string,
    loadout: NetLoadout,
    url = SERVER_URL,
  ): Promise<NetClient> {
    const room = await new Client(url).joinById(roomId, NetClient.options(loadout));
    return new NetClient(room);
  }

  private static options(loadout: NetLoadout): JoinOptions {
    return {
      protocolVersion: PROTOCOL_VERSION,
      faction: loadout.faction,
      shipType: loadout.shipType,
    };
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  /** The joined room's id — the payload of the WITH FRIENDS invite link. */
  get roomId(): string {
    return this.room.roomId;
  }

  /**
   * Send a message to the server (e.g. the per-frame InputState). With the
   * dev netsim on (GameConfig.net.sim) the send is held for half the
   * simulated RTT plus jitter — inbound delay is the NetworkGame's half.
   */
  send(type: string | number, payload: unknown): void {
    const sim = GameConfig.net.sim;
    if (!sim.enabled) {
      this.room.send(type as never, payload as never);
      return;
    }
    const now = performance.now();
    const at = Math.max(now + sim.latencyMs / 2 + Math.random() * sim.jitterMs, this.lastSimSendAt);
    this.lastSimSendAt = at;
    setTimeout(() => {
      try {
        this.room.send(type as never, payload as never);
      } catch {
        /* room left/closed while the message was "in flight" — drop it */
      }
    }, at - now);
  }

  async leave(): Promise<void> {
    try {
      await this.room.leave(true);
    } catch {
      /* already gone */
    }
  }
}
