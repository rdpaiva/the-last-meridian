import { Client, type Room } from "@colyseus/sdk";

import {
  BATTLE_ROOM,
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

  private constructor(room: Room) {
    this.room = room;
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

  /** Send a message to the server (e.g. the per-frame InputState). */
  send(type: string | number, payload: unknown): void {
    this.room.send(type as never, payload as never);
  }

  async leave(): Promise<void> {
    try {
      await this.room.leave(true);
    } catch {
      /* already gone */
    }
  }
}
