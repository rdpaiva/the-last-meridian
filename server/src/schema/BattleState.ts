import { schema, type SchemaType } from "@colyseus/schema";

/**
 * Replicated state, defined with the v4 decorator-free `schema()` factory (no
 * experimentalDecorators flag needed — the server bundles via tsx/esbuild, which
 * doesn't transform TC39 decorators). Kept deliberately small: sent at the patch
 * rate to every client, N ships × this struct, so every field is one the
 * renderer/HUD actually consumes. `isAI` is replicated for the honesty rule
 * (docs/MULTIPLAYER.md) so the HUD/radar can tag bots.
 */
export const ShipSchema = schema(
  {
    id: "string",
    /** Owning client sessionId while a human flies this seat, else "". */
    owner: "string",
    faction: "string",
    shipType: "string",
    x: "float32",
    z: "float32",
    rotationY: "float32",
    bankAngle: "float32",
    hp: "float32",
    maxHp: "float32",
    alive: "boolean",
    /** Still in the launch catapult (view shows the ramp / suppresses some FX). */
    launching: "boolean",
    /** AI-flown seat (honesty rule: HUD + radar tag bots). */
    isAI: "boolean",
  },
  "ShipSchema",
);
export type ShipSchema = SchemaType<typeof ShipSchema>;

export const MothershipSchema = schema(
  {
    faction: "string",
    hp: "float32",
    maxHp: "float32",
    alive: "boolean",
  },
  "MothershipSchema",
);
export type MothershipSchema = SchemaType<typeof MothershipSchema>;

/**
 * Root replicated state. Ships keyed by stable id (the MapSchema patches only
 * the ships that changed). Carriers are two fixed slots. `phase`/`winner` drive
 * the client's launch countdown + victory/defeat banner; `tick` seeds the
 * Phase 2 interpolation clock.
 */
export const BattleState = schema(
  {
    ships: { map: ShipSchema },
    humansMothership: { type: MothershipSchema },
    machinesMothership: { type: MothershipSchema },
    /** "launching" | "playing" | "ended" */
    phase: "string",
    /** "" | "humans" | "machines" */
    winner: "string",
    tick: "number",
  },
  "BattleState",
);
export type BattleState = SchemaType<typeof BattleState>;
