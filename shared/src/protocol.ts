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
export const PROTOCOL_VERSION = 23;

/** Room name registered on the server + asked for by the client. */
export const BATTLE_ROOM = "battle";

/** Colyseus error code the server throws on a protocol mismatch. */
export const PROTOCOL_MISMATCH = 4001;

/** Colyseus error code the server throws when the requested faction has no
 *  free seat (the room itself may still have space on the other side). The
 *  client renders it as "faction full" — on an invite it means "switch sides
 *  to join your friend"; on a quick match the client starts a fresh room. */
export const FACTION_FULL = 4002;

/** Options the client passes to joinOrCreate (the loadout becomes the payload). */
export interface JoinOptions {
  protocolVersion: number;
  faction: Faction;
  shipType: ShipTypeId;
  /** Player-entered pilot name (sanitizePilotName runs on both sides; ""
   *  falls back to the seat's AI callsign so no ship flies anonymous). */
  pilotName: string;
  /**
   * The player's arena selection (a MapId — a concrete map or "random").
   * Consulted only when THIS join CREATES the room: the creator's pick
   * becomes the room's arena (BattleRoom resolves + applies it before the
   * sim constructs, then replicates the concrete id as BattleState.mapId).
   * Joiners inherit the room's arena; their value is ignored. Typed as
   * string on the wire — the server validates with isMapSelection and
   * falls back to "random" rather than trusting the client.
   */
  mapSelection: string;
}

/**
 * Client → server, sampled at the send cadence: one InputState plus a
 * monotonically increasing sequence number. The server acks the last seq it
 * applied via ShipSchema.lastInputSeq, which is what lets the client's
 * prediction drop acknowledged inputs and replay only the still-pending ones
 * on top of the authoritative state (Phase 2 reconciliation).
 */
export interface InputMessage {
  seq: number;
  input: InputState;
}

/**
 * One serialized transient-FX fact (Phase 2 event replication): the wire form
 * of a SimEventMap entry. Ships are referred to by their replicated schema id
 * (the `state.ships` map key); positions are raw world coordinates. The
 * client queues these and plays each when its interpolation clock reaches the
 * batch's sim time, so FX line up with the (delayed) interpolated ship poses.
 */
export type NetEvent =
  /** `rot` = shooter heading; `mx`/`mz` = world muzzle positions (one bolt
   *  each). `f`/`st` = shooter faction + ship type: with sensor-filtered
   *  replication the shooter may never have replicated to this client, so
   *  the depiction (bolt color, heavy tint, fire sound) can't rely on the
   *  client having its metadata — the fired-from-a-nebula case. */
  | { k: "laserFired"; ship: string; f: Faction; st: ShipTypeId; rot: number; mx: number[]; mz: number[] }
  /** `target` = ship id the round homes on ("" = ballistic) — steers the
   *  client's cosmetic round and lets the RWR hear a seeker on YOU.
   *  `f` = shooter faction; `x`/`z`/`rot` = the launch pose (nose offset
   *  included) — the depiction fallback when the shooter is sensor-hidden
   *  (the round is a visible object even when its shooter isn't). */
  | { k: "missileFired"; ship: string; f: Faction; target: string; x: number; z: number; rot: number }
  /** `target`/`shooter` are ship ids, or "" when not a ship (carrier, turret…). */
  | { k: "laserHit"; x: number; y: number; z: number; target: string; shooter: string }
  | { k: "missileHit"; x: number; y: number; z: number; target: string; shooter: string }
  | { k: "missileIntercepted"; x: number; y: number; z: number }
  | { k: "shipLaunched"; ship: string }
  /** `by` = ship id of the last shooter to damage the victim ("" = environment
   *  kill: asteroid ram, turret, unattributed) — the client's kill/score HUD.
   *  `vf`/`vt` = victim faction + ship type (kill-board bookkeeping must not
   *  depend on the victim ever having replicated to this client). */
  | { k: "shipDied"; ship: string; x: number; z: number; by: string; vf: Faction; vt: ShipTypeId }
  | { k: "mothershipDied"; faction: Faction }
  | { k: "turretFired"; faction: Faction; rot: number; x: number; y: number; z: number }
  | { k: "turretDestroyed"; x: number; y: number; z: number }
  | { k: "jumpSpoolStarted"; ship: string }
  | { k: "jumpCancelled"; ship: string }
  | { k: "jumpFired"; ship: string; fromX: number; fromZ: number; toX: number; toZ: number }
  | { k: "asteroidShattered"; x: number; y: number; z: number; r: number }
  | { k: "shipRammedAsteroid"; ship: string }
  | { k: "shipRammedHulk"; ship: string }
  /** Ship id ONLY — no position, on purpose: storms conceal, so the victim
   *  may be sensor-hidden from this client; the client depicts the strike
   *  only when it holds a pose for the ship (no stealth leak). */
  | { k: "stormZap"; ship: string };

/** Server → client: all FX events from one sim tick, stamped with its sim time. */
export interface EventsMessage {
  /** Sim clock (ms) of the tick that produced these — same axis as state.timeMs. */
  t: number;
  events: NetEvent[];
}

/** Message channel names (avoid stringly-typed drift across the boundary). */
export const MSG = {
  /** Client → server: an InputState sample. */
  input: "i",
  /** Server → client: an EventsMessage batch of transient-FX facts. */
  events: "e",
  /**
   * Client → server, once, after assets are loaded and the render loop is
   * running. The FIRST ready in a room releases the opening fleet launch
   * (until then both fleets hold in their tubes), so the launch is actually
   * witnessed no matter how long the client spends loading. Payload: {}.
   */
  ready: "r",
} as const;
