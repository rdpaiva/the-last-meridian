import { GameConfig, type ShipTypeId, type HazardSpec } from "./GameConfig";
import type { Faction } from "./Faction";
import { isOverridden, hasOverrideUnder } from "./ConfigOverrides";

/**
 * Arena / map system — see docs/ARENA-MAPS.md.
 *
 * A Map is a named bundle of BATTLEFIELD SETUP (scenery density, carrier
 * spacing, fleet composition) chosen at match start, parallel to the ship
 * PlayerLoadout. It changes the board the match is played on, not how the game
 * plays frame to frame.
 *
 * HOW IT'S APPLIED (Option B in the spec): `applyMap` writes the map's values
 * INTO the live GameConfig at startup, before any system constructs — the same
 * startup-mutation seam ConfigOverrides uses. Every existing read site (incl.
 * the sim-side computeConcealmentZones and the headless smoke harness) then
 * picks up the map with zero signature changes.
 *
 * PRECEDENCE: applyMap runs AFTER applyStoredOverrides (the menus need the
 * overrides live, so those apply at module-init). So for any field that is also
 * a match-settings knob (TuningSchema: asteroids.count, fleets.*), the map
 * writes ONLY when the player hasn't overridden it — hand-tuning always beats a
 * map default. Fields with no schema knob (carrier Z, nebula zones) are always
 * safe to write.
 *
 * MULTIPLAYER / PHASE 0: applyMap is browser-only (called from main.ts). The
 * headless harness never calls it, so its deterministic baseline runs on stock
 * GameConfig and is unaffected. When a server picks a map it will run the same
 * applyMap before constructing the shared sim — same startup-mutation contract.
 */

/** "random" is a meta-id resolved to one concrete map at launch. */
export type MapId = ConcreteMapId | "random";
export type ConcreteMapId = "openVoid" | "asteroidBelt" | "nebulaVeil" | "theWreck";

type NebulaZone = { xFrac: number; zFrac: number; radius: number };
type FleetComposition = {
  fleet: ReadonlyArray<{ type: ShipTypeId; count: number }>;
  strikeCount: number;
};

export interface MapConfig {
  id: ConcreteMapId;
  /** Splash card title. */
  name: string;
  /** One-line flavor for the card / loading line. */
  blurb: string;

  /** Carrier spacing along Z. Overrides mothership.playerZ / enemyZ.
   *  Tighter = brawl; wider = a long approach where the jump drive matters. */
  carrierZ: { player: number; enemy: number };

  /** Asteroid field for this map. `count: 0` disables the field. Omitted
   *  fields keep their GameConfig.asteroids default.
   *  - `regions`: spawn circles (a row reads as a belt; separate = clusters).
   *    Empty/omitted = scatter across the whole arena. INITIAL placement only —
   *    rocks drift, so pair a belt with low drift to keep its shape.
   *  - `driftSpeedMin/Max`: per-map drift so a belt can hold (low) or churn. */
  asteroids: {
    count: number;
    radiusMin?: number;
    radiusMax?: number;
    regions?: ReadonlyArray<{ x: number; z: number; radius: number }>;
    driftSpeedMin?: number;
    driftSpeedMax?: number;
  };

  /** Combat (stealth) nebula footprints, fractional like the config default.
   *  Empty array = no stealth clouds. */
  nebulaZones: ReadonlyArray<NebulaZone>;

  /** Optional per-faction fleet composition override (else GameConfig.fleets). */
  fleets?: Partial<Record<Faction, FleetComposition>>;

  /** Placed hazards — e.g. a derelict hulk (indestructible cover). Omitted =
   *  none. See HazardSpec in GameConfig. */
  hazards?: ReadonlyArray<HazardSpec>;
}

const FACTIONS: readonly Faction[] = ["humans", "machines"];

/**
 * The v1 preset catalog. Tuned to feel distinct: an empty long-range void, a
 * dense knife-fight belt, and a stealth-heavy veil. Carrier Z mirrors the
 * stock ±700 corridor as the midpoint to keep the AI leash happy (see the
 * open question in docs/ARENA-MAPS.md about wide-spacing maps + leash).
 */
export const MAPS: Record<ConcreteMapId, MapConfig> = {
  openVoid: {
    id: "openVoid",
    name: "The Void",
    blurb: "Open space. Nowhere to hide — jump drives win or lose it.",
    carrierZ: { player: -850, enemy: 850 },
    asteroids: { count: 0 },
    nebulaZones: [],
  },
  asteroidBelt: {
    id: "asteroidBelt",
    name: "The Belt",
    blurb: "A dense rock belt across the midline. Knife-fight ranges, cover everywhere.",
    carrierZ: { player: -600, enemy: 600 },
    asteroids: {
      count: 95,
      radiusMin: 6,
      radiusMax: 18,
      // A row of overlapping circles along X at the midline (z=0) — a belt both
      // fleets must cross. Low drift so it holds its shape through the match.
      regions: [
        { x: -360, z: 0, radius: 150 },
        { x: -180, z: 0, radius: 150 },
        { x: 0, z: 0, radius: 150 },
        { x: 180, z: 0, radius: 150 },
        { x: 360, z: 0, radius: 150 },
      ],
      driftSpeedMin: 0,
      driftSpeedMax: 1.2,
    },
    nebulaZones: [{ xFrac: 0.0, zFrac: 0.0, radius: 45 }],
  },
  nebulaVeil: {
    id: "nebulaVeil",
    name: "The Veil",
    blurb: "Stealth gas in every quarter. Break contact, strike from the murk.",
    carrierZ: { player: -700, enemy: 700 },
    asteroids: { count: 25 },
    nebulaZones: [
      { xFrac: -0.5, zFrac: 0.1, radius: 70 },
      { xFrac: 0.5, zFrac: 0.45, radius: 64 },
      { xFrac: 0.15, zFrac: -0.5, radius: 72 },
      { xFrac: -0.3, zFrac: -0.3, radius: 58 },
      { xFrac: 0.35, zFrac: -0.05, radius: 52 },
      { xFrac: 0.0, zFrac: 0.55, radius: 66 },
      { xFrac: -0.55, zFrac: -0.55, radius: 60 },
      { xFrac: 0.6, zFrac: -0.4, radius: 56 },
      { xFrac: -0.15, zFrac: 0.35, radius: 54 },
      { xFrac: 0.28, zFrac: 0.12, radius: 48 },
      { xFrac: -0.62, zFrac: 0.5, radius: 50 },
    ],
  },
  theWreck: {
    id: "theWreck",
    name: "The Wreck",
    blurb: "A dead carrier adrift at the center. Fight through its shadow.",
    carrierZ: { player: -700, enemy: 700 },
    asteroids: { count: 35 },
    nebulaZones: [
      { xFrac: -0.42, zFrac: 0.28, radius: 55 },
      { xFrac: 0.42, zFrac: -0.28, radius: 55 },
    ],
    // One large derelict (the dead Novari Choirship "Silent Choir") adrift
    // dead-center — a slowly-spinning circular hazard both fleets flank around.
    // scale > 1 gives it presence as the map's landmark.
    hazards: [{ kind: "hulk", source: "machines", x: 0, z: 0, rotationY: 0, scale: 1.1 }],
  },
};

/** Resolve "random" to a concrete map id; pass concrete ids through. Map
 *  SELECTION is a pre-sim config choice (like the loadout), so it uses plain
 *  Math.random — NOT the seeded sim RNG, which must stay reserved for the sim. */
export function resolveMapId(id: MapId): ConcreteMapId {
  if (id !== "random") return id;
  const ids = Object.keys(MAPS) as ConcreteMapId[];
  return ids[Math.floor(Math.random() * ids.length)];
}

// ─── Persistence ─────────────────────────────────────────────────────────────
// The map SELECTION persists alongside the loadout (Loadout.ts owns faction/
// ship; the map is a separate `lastMeridian_*` key, NOT a PlayerLoadout field,
// since the map applies via GameConfig rather than being passed to `new Game`).
//
// What's stored is the selection, not the resolved map: a concrete id PINS that
// map; "random" RE-ROLLS each launch (resolveMapId runs per page load, and the
// end-of-match restart is a fresh reload, so a new map is picked every match).

const MAP_KEY = "lastMeridian_map";

/** Whether a stored value is a usable selection (a known map id or "random").
 *  hasOwnProperty (not `in`) so prototype keys like "toString" can't sneak in. */
function isValidSelection(v: unknown): v is MapId {
  return (
    v === "random" ||
    (typeof v === "string" && Object.prototype.hasOwnProperty.call(MAPS, v))
  );
}

/** The persisted map selection. Defaults to "random" so matches vary out of
 *  the box; an unknown/corrupt/missing stored value falls back the same way.
 *  (To pin a map for dev before the picker UI lands, run e.g.
 *  `localStorage.setItem("lastMeridian_map", "openVoid")` in the console.) */
export function loadSavedMapSelection(): MapId {
  try {
    const v = localStorage.getItem(MAP_KEY);
    return isValidSelection(v) ? v : "random";
  } catch {
    return "random";
  }
}

/** Persist the player's map selection (written by the picker UI in slice 3). */
export function saveMapSelection(selection: MapId): void {
  try {
    localStorage.setItem(MAP_KEY, selection);
  } catch {
    // Storage unavailable (private mode etc.) — the selection just won't persist.
  }
}

/** Apply a map's value for a schema-backed knob only if the player hasn't
 *  overridden it in match settings — their hand-tuning beats the map default. */
function writeKnob(path: string, write: () => void): void {
  if (!isOverridden(path)) write();
}

/**
 * Write a concrete map's battlefield setup into the live GameConfig. Call ONCE
 * at startup, AFTER applyStoredOverrides (so the player's match-settings
 * overrides take precedence over the map baseline) and BEFORE `new Game(...)`.
 */
export function applyMap(id: ConcreteMapId): void {
  const map = MAPS[id];
  const a = map.asteroids;

  // Carrier spacing — not a settings knob, always safe to write.
  GameConfig.mothership.playerZ = map.carrierZ.player;
  GameConfig.mothership.enemyZ = map.carrierZ.enemy;

  // Asteroid count / radius band / drift speed are ALL match-settings knobs,
  // so each writes only when the player hasn't overridden it (hand-tuning wins).
  writeKnob("asteroids.count", () => (GameConfig.asteroids.count = a.count));
  if (a.radiusMin !== undefined) {
    writeKnob("asteroids.radiusMin", () => (GameConfig.asteroids.radiusMin = a.radiusMin!));
  }
  if (a.radiusMax !== undefined) {
    writeKnob("asteroids.radiusMax", () => (GameConfig.asteroids.radiusMax = a.radiusMax!));
  }
  if (a.driftSpeedMin !== undefined) {
    writeKnob("asteroids.driftSpeedMin", () => (GameConfig.asteroids.driftSpeedMin = a.driftSpeedMin!));
  }
  if (a.driftSpeedMax !== undefined) {
    writeKnob("asteroids.driftSpeedMax", () => (GameConfig.asteroids.driftSpeedMax = a.driftSpeedMax!));
  }

  // Spawn regions — no schema knob, always set (empty = full-arena scatter).
  GameConfig.asteroids.regions = a.regions ?? [];

  // Stealth-cloud footprints — no schema knob, always safe to replace. Both
  // the textured CombatNebulas view and the sim-side computeConcealmentZones
  // read this, so they stay in lockstep automatically.
  GameConfig.scenery.combatNebulas.zones = map.nebulaZones;

  // Placed hazards (wrecks). No schema knob; always set (empty = none).
  GameConfig.hazards = map.hazards ?? [];

  // Fleet composition — every pick count + strikeCount IS a settings knob, so
  // only replace a faction's fleet when the player hasn't hand-tuned it.
  if (map.fleets) {
    for (const f of FACTIONS) {
      const comp = map.fleets[f];
      if (comp && !hasOverrideUnder(`fleets.${f}.`)) {
        GameConfig.fleets[f] = { fleet: comp.fleet, strikeCount: comp.strikeCount };
      }
    }
  }
}
