import { Schema, MapSchema, defineTypes } from "@colyseus/schema";

/**
 * Replicated per-ship state — the pose the client's ShipView needs plus the
 * gameplay flags the HUD/radar read. Kept deliberately small: this is sent at
 * the patch rate to every client, N ships × this struct, so every field is one
 * the renderer actually consumes. `isAI` is replicated because the honesty rule
 * (docs/MULTIPLAYER.md) requires the HUD/radar to tag bots.
 *
 * Decorator-free `defineTypes` so no experimentalDecorators tsconfig flag is
 * needed (the server bundles via tsx/esbuild).
 */
export class ShipSchema extends Schema {
  id = "";
  faction = "";
  shipType = "";
  x = 0;
  z = 0;
  rotationY = 0;
  bankAngle = 0;
  hp = 0;
  maxHp = 0;
  alive = true;
  /** Still in the launch catapult (view suppresses some FX / shows the ramp). */
  launching = false;
  /** AI-flown seat (honesty rule: HUD + radar tag bots). */
  isAI = true;
}
defineTypes(ShipSchema, {
  id: "string",
  faction: "string",
  shipType: "string",
  x: "float32",
  z: "float32",
  rotationY: "float32",
  bankAngle: "float32",
  hp: "float32",
  maxHp: "float32",
  alive: "boolean",
  launching: "boolean",
  isAI: "boolean",
});

export class MothershipSchema extends Schema {
  faction = "";
  hp = 0;
  maxHp = 0;
  alive = true;
}
defineTypes(MothershipSchema, {
  faction: "string",
  hp: "float32",
  maxHp: "float32",
  alive: "boolean",
});

/**
 * Root replicated state. Ships keyed by stable id (MapSchema patches only the
 * ships that changed). Carriers are two fixed slots. `phase`/`winner` drive the
 * client's launch countdown + victory/defeat banner.
 */
export class BattleState extends Schema {
  ships = new MapSchema<ShipSchema>();
  humansMothership = new MothershipSchema();
  machinesMothership = new MothershipSchema();
  /** "launching" | "playing" | "ended" */
  phase = "launching";
  /** "" | "humans" | "machines" */
  winner = "";
  /** Sim tick counter (debug / interpolation clock seed in Phase 2). */
  tick = 0;
}
defineTypes(BattleState, {
  ships: { map: ShipSchema },
  humansMothership: MothershipSchema,
  machinesMothership: MothershipSchema,
  phase: "string",
  winner: "string",
  tick: "number",
});
