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
    /** Velocity — the client's prediction seeds its replay from this. */
    vx: "float32",
    vz: "float32",
    rotationY: "float32",
    bankAngle: "float32",
    hp: "float32",
    maxHp: "float32",
    /** Ammo (fractional while the carrier service refills) — the owner's
     *  predicted fire re-syncs from these so its depiction can't drift. */
    cannonAmmo: "float32",
    missileAmmo: "float32",
    /** Last InputMessage.seq applied to this seat (prediction ack; 0 = none). */
    lastInputSeq: "number",
    alive: "boolean",
    /** Still in the launch catapult (view shows the ramp / suppresses some FX). */
    launching: "boolean",
    /** AI-flown seat (honesty rule: HUD + radar tag bots). */
    isAI: "boolean",
    /** Pilot identity for nameplates: the occupant's sanitized name while a
     *  human flies this seat, else the seat's generated AI callsign
     *  (Callsigns.ts). Swaps with isAI on join/leave. */
    callsign: "string",
    /** RCS bits of the input the last sim tick applied — clients depict
     *  reverse/strafe plumes on FRIENDLY ships from these (offline parity:
     *  the wing's plumes ride each pilot's emitted input, the enemy's don't
     *  show). False while dead / in the launch tube. */
    reverse: "boolean",
    strafeLeft: "boolean",
    strafeRight: "boolean",
  },
  "ShipSchema",
);
export type ShipSchema = SchemaType<typeof ShipSchema>;

/**
 * One asteroid's SPAWN STATE — written once when the rock enters the sim
 * (field layout at room creation, or a shatter chunk later) and never
 * patched again: drift and spin are constant, so the client reconstructs a
 * real AsteroidSim from this and integrates its pose locally on the shared
 * sim clock (`t0` = sim time of capture). Death = entry deleted from the map.
 */
export const AsteroidSchema = schema(
  {
    id: "string",
    /** Pose at capture time t0 (sim clock, ms). */
    t0: "number",
    x: "float32",
    z: "float32",
    rotX: "float32",
    rotY: "float32",
    rotZ: "float32",
    /** Constant motion. */
    driftX: "float32",
    driftZ: "float32",
    spinX: "float32",
    spinY: "float32",
    spinZ: "float32",
    /** Shape. */
    visualRadius: "float32",
    squashX: "float32",
    squashY: "float32",
  },
  "AsteroidSchema",
);
export type AsteroidSchema = SchemaType<typeof AsteroidSchema>;

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
    /**
     * VIEW-FILTERED (sensor-filtered replication, docs/MULTIPLAYER.md Phase
     * 2): entries reach a client only through its StateView. BattleRoom keeps
     * every FRIENDLY ship in the client's view permanently and diffs ENEMY
     * ships in/out per tick from the sim's SensorSystem (fresh track = in) —
     * nebula stealth and sensor range are anti-wallhack, not just UI.
     */
    ships: { map: ShipSchema, view: true },
    /** Live rocks by id — spawn states only (see AsteroidSchema). */
    asteroids: { map: AsteroidSchema },
    humansMothership: { type: MothershipSchema },
    machinesMothership: { type: MothershipSchema },
    /** Seat occupancy for the HUD's pilots row — root fields because the
     *  ships map is view-filtered (a client can't count what it can't see). */
    pilotHumans: "number",
    pilotBots: "number",
    /** "launching" | "playing" | "ended" */
    phase: "string",
    /** "" | "humans" | "machines" */
    winner: "string",
    tick: "number",
    /** Accumulated sim time in ms — the client's interpolation timeline. The
     *  sim (30Hz) and patch (20Hz) rates alias, so snapshots must be
     *  timestamped on THIS clock, not client arrival time. */
    timeMs: "number",
  },
  "BattleState",
);
export type BattleState = SchemaType<typeof BattleState>;
