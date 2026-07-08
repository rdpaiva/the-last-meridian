/**
 * @space-duel/shared — the sim. Pure gameplay truth that runs anywhere
 * (browser client, Colyseus server, headless tests). The ONLY Babylon
 * import allowed in here is `@babylonjs/core/Maths/*` (pure math); no
 * scene/mesh/engine imports ever cross this boundary.
 *
 * This barrel is the package's single public entry (`exports` → ./src/index.ts,
 * no build step — consumers bundle the TS source through the workspace symlink).
 * Adding a shared module? Re-export it here.
 */

// Core config / math / types
export * from "./GameConfig";
export * from "./math";
export * from "./types";
export * from "./Faction";
export * from "./Callsigns";
export * from "./WingPlan";

// AI + awareness
export * from "./AIController";
export * from "./FleetCommander";
export * from "./SensorSystem";
export * from "./ShipController";
export * from "./NetworkController";
export * from "./LaunchSequence";
export * from "./protocol";

// Sim entities + systems
export * from "./sim/Ship";
export * from "./sim/Laser";
export * from "./sim/LaserSystem";
export * from "./sim/Missile";
export * from "./sim/MissileSystem";
export * from "./sim/Mothership";
export * from "./sim/MothershipSection";
export * from "./sim/Hulk";
export * from "./sim/HulkSection";
export * from "./sim/AsteroidSim";
export * from "./sim/AsteroidFieldSim";
export * from "./sim/BattleSim";
export * from "./sim/Turret";
export * from "./sim/SimEvents";
export * from "./sim/SimRng";
export * from "./sim/CombatNebulaZones";
export * from "./sim/StormZones";
export * from "./sim/StormSystem";
