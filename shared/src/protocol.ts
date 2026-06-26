import type { Faction } from "./Faction";
import type { ShipTypeId } from "./GameConfig";
import type { InputState } from "./types";

/**
 * Client/server wire-compatibility version. The client sends it in join
 * options; the server rejects a mismatch with a typed error the client renders
 * as "new version — refresh". BUMP MANUALLY on any breaking change to the
 * message protocol or to GameConfig (balance lives in shared, so a tweak is a
 * both-sides deploy) — see docs/MULTIPLAYER.md → Decisions (protocol version).
 */
export const PROTOCOL_VERSION = 1;

/** Room name registered on the server + asked for by the client. */
export const BATTLE_ROOM = "battle";

/** Colyseus error code the server throws on a protocol mismatch. */
export const PROTOCOL_MISMATCH = 4001;

/** Options the client passes to joinOrCreate (the loadout becomes the payload). */
export interface JoinOptions {
  protocolVersion: number;
  faction: Faction;
  shipType: ShipTypeId;
}

/** Client → server, sampled once per client frame: the player's input. */
export type InputMessage = InputState;

/** Message channel names (avoid stringly-typed drift across the boundary). */
export const MSG = {
  /** Client → server: an InputState sample. */
  input: "i",
} as const;
