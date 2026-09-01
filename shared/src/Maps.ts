import { GameConfig, type ShipTypeId, type HazardSpec } from "./GameConfig";
import type { Faction } from "./Faction";

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
 * WHO CALLS IT: solo, the client (main.ts, right before `new Game`). Online,
 * the SERVER owns the arena — BattleRoom resolves the creating client's
 * selection and runs applyMap before constructing the shared BattleSim, then
 * replicates the concrete id (BattleState.mapId) so every client applies the
 * SAME map before building its view (main.ts startOnline). The headless
 * harness never calls it, so its deterministic baseline runs on stock config.
 *
 * PRECEDENCE (solo): applyMap runs AFTER applyStoredOverrides (the menus need
 * the overrides live, so those apply at module-init). So for any field that is
 * also a match-settings knob (TuningSchema: asteroids.count, fleets.*), the
 * map writes ONLY when the player hasn't overridden it — hand-tuning always
 * beats a map default. That check is the injectable `hooks` parameter: the
 * client passes its ConfigOverrides predicates (see client Maps.ts); the
 * server and the online client pass nothing, which means "no overrides" —
 * online the board must match the server exactly, so local hand-tuning of
 * board knobs deliberately does NOT apply. Fields with no schema knob
 * (carrier Z, nebula zones, hazards) are always written.
 */

/** "random" is a meta-id resolved to one concrete map at launch. */
export type MapId = ConcreteMapId | "random";
export type ConcreteMapId =
  | "openVoid"
  | "asteroidBelt"
  | "nebulaVeil"
  | "theWreck"
  | "theTempest"
  | "theEye"
  | "theCanyon";

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

  /**
   * Environment THEME (view-only; the sim never reads it). Omitted = "space"
   * (the deep-space backdrop stack). "planet" = low-level flight over a
   * procedural landscape (PlanetTerrain; knobs in GameConfig.planet) — the
   * client skips the space stack and retints the scene to match.
   */
  environment?: "space" | "planet";

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

  /** Ion-storm footprints (GameConfig.storms.zones — same fractional shape).
   *  Storms zap loitering ships, conceal like nebulas, and the AI steers
   *  around them, so banks of these carve navigation lanes. Omitted = none. */
  stormZones?: ReadonlyArray<NebulaZone>;

  /** Optional per-faction fleet composition override (else GameConfig.fleets). */
  fleets?: Partial<Record<Faction, FleetComposition>>;

  /** Placed hazards — e.g. a derelict hulk (indestructible cover). Omitted =
   *  none. See HazardSpec in GameConfig. */
  hazards?: ReadonlyArray<HazardSpec>;

  /** Capture stations (strategic layer M2 — GameConfig.stations.placements,
   *  fractional like the zone shapes). Dock at one to convert it; owned
   *  stations feed the faction Energy pool. Omitted = no stations and the
   *  whole capture/energy layer stays inert on this map. */
  stations?: ReadonlyArray<{ xFrac: number; zFrac: number }>;
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
    blurb: "Open space. Nowhere to hide — hold the relay line or lose it.",
    carrierZ: { player: -850, enemy: 850 },
    asteroids: { count: 0 },
    nebulaZones: [],
    // A midline relay row: with no terrain, the stations ARE the map — the
    // long carrier gap makes holding the line a real commitment.
    stations: [
      { xFrac: -0.55, zFrac: 0 },
      { xFrac: 0, zFrac: 0 },
      { xFrac: 0.55, zFrac: 0 },
    ],
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
    // Flank stations outside the rocks + one dead-center INSIDE the belt's
    // stealth pocket: capturing the middle means docking blind in the murk.
    stations: [
      { xFrac: -0.85, zFrac: 0 },
      { xFrac: 0, zFrac: 0 },
      { xFrac: 0.85, zFrac: 0 },
    ],
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
    // A dead Novari Choirship adrift dead-center — a slowly-spinning hazard
    // both fleets flank around. scale 0.5 = ~half a carrier: a substantial
    // landmark that's still navigable within the combat zoom (tune to taste;
    // 1.0 = full carrier size).
    // rotationY = π/2 lays the hull SIDEWAYS (nose along X), so it walls off the
    // corridor across the carriers' Z axis instead of pointing down it.
    // rollRate barrel-rolls it about the keel (rad/sec) so the deck turns to the
    // belly while the nose holds sideways — the "show top then belly" spin.
    // (rotationRate = flat yaw, pitchRate = nose-over somersault; both 0 here.)
    hazards: [{ kind: "hulk", source: "humans", x: 0, z: 0, rotationY: Math.PI / 2,
                rotationRate: 0.0, pitchRate: 0.0, rollRate: 0.06, scale: 0.5 }],
  },
  theTempest: {
    id: "theTempest",
    name: "The Tempest",
    blurb: "Ion storm walls carve the midfield into lanes. Fly the gaps — or burn through.",
    carrierZ: { player: -750, enemy: 750 },
    asteroids: { count: 20 },
    // One stealth pocket sits dead-center in the main lane: the safe route is
    // also where you can break contact — and where everyone knows to look.
    nebulaZones: [{ xFrac: 0.0, zFrac: 0.0, radius: 50 }],
    // A storm wall across the midline: a wide center lane between ±0.42-frac
    // banks, knife-edge slits between the paired banks, open flanks far out —
    // but each flank is pinched by a picket storm so the wide route costs
    // time. AI pilots route the lanes too (storm keep-outs feed avoidance).
    stormZones: [
      { xFrac: -0.78, zFrac: 0.0, radius: 95 },
      { xFrac: -0.42, zFrac: 0.0, radius: 90 },
      { xFrac: 0.42, zFrac: 0.0, radius: 90 },
      { xFrac: 0.78, zFrac: 0.0, radius: 95 },
      { xFrac: -0.6, zFrac: 0.55, radius: 70 },
      { xFrac: 0.6, zFrac: -0.55, radius: 70 },
    ],
    // One station per lane mouth: center sits in the stealth pocket between
    // the main banks; the flank pair sit beyond the outer storms, past the
    // picket pinch — the wide route pays off in Energy.
    stations: [
      { xFrac: 0, zFrac: 0 },
      { xFrac: -0.92, zFrac: 0 },
      { xFrac: 0.92, zFrac: 0 },
    ],
  },
  theEye: {
    id: "theEye",
    name: "The Eye",
    blurb: "Four storms, one calm heart. Every lane leads to the eye — so does theirs.",
    carrierZ: { player: -700, enemy: 700 },
    asteroids: {
      count: 50,
      radiusMin: 8,
      radiusMax: 24,
      // Four rock clusters ringing the calm center — one astride each carrier
      // approach, one on each flank lane. Brisk drift so the ring churns.
      regions: [
        { x: -176, z: -11, radius: 150 },
        { x: 178, z: -2, radius: 150 },
        { x: -11, z: 296, radius: 150 },
        { x: 19, z: -292, radius: 150 },
      ],
      driftSpeedMin: 1.5,
      driftSpeedMax: 5,
    },
    // The eye itself: one big stealth pocket dead-center where the approach
    // lanes converge — the calm heart every fight funnels into.
    nebulaZones: [{ xFrac: 0.003, zFrac: 0.003, radius: 145 }],
    // Four massive corner storms box the board in, pinching movement onto a
    // cross of lanes: carrier corridors north-south, station runs east-west.
    stormZones: [
      { xFrac: -0.66, zFrac: -0.722, radius: 355 },
      { xFrac: -0.705, zFrac: 0.758, radius: 335 },
      { xFrac: 0.802, zFrac: 0.81, radius: 400 },
      { xFrac: 0.798, zFrac: -0.775, radius: 400 },
    ],
    // One station at each flank-lane mouth, between the storm banks — holding
    // both means owning the east-west cross of the map.
    stations: [
      { xFrac: -0.66, zFrac: 0.007 },
      { xFrac: 0.663, zFrac: 0.003 },
    ],
  },
  theCanyon: {
    id: "theCanyon",
    name: "The Canyon",
    blurb: "A winding canyon of solid rock, carrier to carrier. The walls don't forgive.",
    carrierZ: { player: -750, enemy: 750 },
    // The whole map is PLANETSIDE: a procedural landscape scrolls far below
    // the flight plane (real parallax — it's world geometry, unlike the space
    // Backdrop blit) and the canyon ridges rise out of it. The first map on
    // the "planet" theme; every other map keeps the space stack.
    environment: "planet",
    // The first HARD-WALL map (the `wall` hazard kind — sim/Wall.ts capsule
    // chains + WallView's procedural ridge). Successor to the storm-walled
    // feel-prototype that validated corridor combat here (2026-08-03).
    //
    // Layout: an S-curve lane, centerline x(z) = 220·sin(π·z/600), sampled
    // every 100 on Z with each wall offset 55 along the centerline NORMAL
    // (offsetting in plain X would pinch the lane even further at the steep
    // middle bend). Lane = 80 wide edge-to-edge between wall faces (wall
    // width 30) — a deliberately TIGHT trench (narrowed 220→110→80 on
    // 2026-08-05; walls.chunkLength dropped 24→12 in the same change so the
    // AI's avoidance circles hug the faces tight enough to thread it).
    // Both walls continue BEHIND the carriers to z=±1200, so each mothership
    // and its launch bays live inside a widened trench chamber and the player
    // never sees a canyon mouth during normal play. The chamber walls sit at
    // x≈±135 (240 units clear face-to-face), comfortably outside both fitted
    // carrier hulls; they taper into the authored S-lane before the first bend.
    // The map remains 180°-rotationally symmetric.
    hazards: [
      {
        kind: "wall",
        // West wall, south → north. The lane is to its EAST (the right of
        // the point order), so the mesa high ground rises on its LEFT — the
        // trench topology: mesa top (ground tex) → canyon face (rock tex) →
        // trench floor (ground tex), with the flight plane down inside.
        mesa: "left",
        points: [
          // Widened south carrier chamber (human carrier center z=-750).
          { x: -135, z: -1200 },
          { x: -135, z: -950 },
          { x: -135, z: -780 },
          { x: -140, z: -660 },
          { x: -149, z: -539 },
          { x: -238, z: -427 },
          { x: -275, z: -300 },
          { x: -238, z: -173 },
          { x: -149, z: -61 },
          { x: -36, z: 42 },
          { x: 71, z: 139 },
          { x: 143, z: 227 },
          { x: 165, z: 300 },
          { x: 143, z: 373 },
          { x: 71, z: 461 },
          // Swing out around the machine catapult lanes (x=±41.3, clear at
          // z≈579) before tapering into the carrier chamber.
          { x: -100, z: 558 },
          // Taper out to the widened north carrier chamber.
          { x: -115, z: 610 },
          { x: -130, z: 670 },
          { x: -135, z: 780 },
          { x: -135, z: 950 },
          { x: -135, z: 1200 },
        ],
      },
      {
        kind: "wall",
        // East wall, south → north (point-reflection of the west wall; the
        // reflection flips the lane to its WEST, so the mesa is on its RIGHT).
        mesa: "right",
        points: [
          // Widened south carrier chamber; taper into the shifted S-lane.
          { x: 135, z: -1200 },
          { x: 135, z: -950 },
          { x: 135, z: -780 },
          { x: 130, z: -670 },
          { x: 115, z: -610 },
          // Swing out around the human catapult lanes (x=±38.2, clear at
          // z≈-585); this is the point-reflection of the north entry above.
          { x: 100, z: -558 },
          { x: -71, z: -461 },
          { x: -143, z: -373 },
          { x: -165, z: -300 },
          { x: -143, z: -227 },
          { x: -71, z: -139 },
          { x: 36, z: -42 },
          { x: 149, z: 61 },
          { x: 238, z: 173 },
          { x: 275, z: 300 },
          { x: 238, z: 427 },
          { x: 149, z: 539 },
          // Widened north carrier chamber (machine carrier center z=750).
          { x: 140, z: 660 },
          { x: 135, z: 780 },
          { x: 135, z: 950 },
          { x: 135, z: 1200 },
        ],
      },
    ],
    // Weather sits OUTBOARD of the walls — one storm per open quarter, so the
    // go-around route costs hull while the lane itself stays zap-free. The
    // ±0.717 pair are the original bypass pickets; the ±0.83 pair fill the
    // pockets behind each bend. None reach past a wall's inner face.
    stormZones: [
      { xFrac: 0.717, zFrac: -0.467, radius: 160 },
      { xFrac: -0.717, zFrac: 0.467, radius: 160 },
      { xFrac: -0.83, zFrac: -0.42, radius: 140 },
      { xFrac: 0.83, zFrac: 0.42, radius: 140 },
    ],
    // PLANETSIDE means no space furniture: no drifting asteroids (floating
    // rocks over a desert read as a glitch, not scree), no stealth nebulas
    // (gas clouds are a deep-space thing), and no capture stations (orbital
    // hardware — omitting the field leaves the whole capture/Energy layer
    // inert here, so no station-powered carrier shields either). Cover and
    // concealment come from the terrain itself — the bends break line of
    // sight. The storm banks stay: over a mesa they read as thunderheads,
    // not ion weather. Pure trench warfare: fly the canyon, kill the carrier.
    asteroids: { count: 0 },
    nebulaZones: [],
  },
};

/**
 * Maps exposed through the player-facing mission picker and the "random"
 * pool. The full MAPS catalog deliberately remains larger: hidden arenas can
 * still be loaded directly by developer tools such as the local Map Editor
 * without leaking into normal solo or online matchmaking.
 */
export const EXPOSED_MAP_IDS: readonly ConcreteMapId[] = (
  Object.keys(MAPS) as ConcreteMapId[]
).filter((id) => id !== "theCanyon");

/** Resolve "random" to a concrete map id; pass concrete ids through. Map
 *  SELECTION is a pre-sim config choice (like the loadout), so it uses plain
 *  Math.random — NOT the seeded sim RNG, which must stay reserved for the sim. */
export function resolveMapId(id: MapId): ConcreteMapId {
  if (id !== "random") return id;
  return EXPOSED_MAP_IDS[Math.floor(Math.random() * EXPOSED_MAP_IDS.length)];
}

/** Whether a value is a player-facing map selection (an exposed id or
 *  "random"). Guards both the client's persisted key and the server's join
 *  options: hidden/stale/hand-edited values fall back rather than entering
 *  matchmaking. Hidden catalog entries remain directly applicable in dev
 *  tools without passing through this public-input validator. */
export function isMapSelection(v: unknown): v is MapId {
  return v === "random" || EXPOSED_MAP_IDS.includes(v as ConcreteMapId);
}

/**
 * The match-settings override predicates applyMap consults so a hand-tuned
 * knob beats the map baseline. Client-side ConfigOverrides implements this;
 * omitting it (server, online client) means "nothing overridden".
 */
export interface MapOverrideHooks {
  /** Is this exact dot-path knob overridden in match settings? */
  isOverridden(path: string): boolean;
  /** Is any knob under this dot-path prefix overridden? */
  hasOverrideUnder(prefix: string): boolean;
}

const NO_OVERRIDES: MapOverrideHooks = {
  isOverridden: () => false,
  hasOverrideUnder: () => false,
};

/**
 * Write a concrete map's battlefield setup into the live GameConfig. Call ONCE
 * at startup, BEFORE any sim/view constructs (solo: after applyStoredOverrides
 * so the player's match-settings overrides take precedence — pass the hooks;
 * server/online: stock config, no hooks).
 *
 * SERVER CAVEAT: GameConfig is a process-wide singleton, so on a multi-room
 * server the LAST-created room's map owns the global values. Every map-driven
 * field is read at CONSTRUCTION time (carrier positions, zones, hazards,
 * fleet build, initial asteroid field), so existing rooms keep the board they
 * were built with; the one mid-match read is shatter-chunk drift speed
 * (AsteroidFieldSim.randomDrift), where a stale value is cosmetic — chunks
 * replicate to clients with their actual drift either way.
 */
export function applyMap(id: ConcreteMapId, hooks: MapOverrideHooks = NO_OVERRIDES): void {
  applyMapConfig(MAPS[id], hooks);
}

/**
 * The applier body, taking the map VALUE instead of a catalog id — the seam
 * the client's map editor uses to test-fly a draft that isn't in MAPS yet
 * (no hooks there: a test flight shows the draft exactly as designed).
 * Catalog launches go through applyMap above.
 */
export function applyMapConfig(
  map: Omit<MapConfig, "id">,
  hooks: MapOverrideHooks = NO_OVERRIDES,
): void {
  const a = map.asteroids;

  /** Apply a schema-backed knob only if the player hasn't overridden it. */
  const writeKnob = (path: string, write: () => void): void => {
    if (!hooks.isOverridden(path)) write();
  };

  // Carrier spacing — not a settings knob, always safe to write.
  GameConfig.mothership.playerZ = map.carrierZ.player;
  GameConfig.mothership.enemyZ = map.carrierZ.enemy;

  // Environment theme — ALWAYS written (omitted = "space"), so launching a
  // space map after a planet map restores the deep-space stack. View-only:
  // the server writes it too (harmlessly — nothing server-side reads it).
  GameConfig.scenery.environment = map.environment ?? "space";

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

  // Ion-storm footprints — same contract (StormClouds view + the sim-side
  // computeStormZones both read this). Empty = no storms.
  GameConfig.storms.zones = map.stormZones ?? [];

  // Placed hazards (wrecks). No schema knob; always set (empty = none).
  GameConfig.hazards = map.hazards ?? [];

  // Capture stations — same contract as storms.zones (empty = the strategic
  // capture/energy layer is inert on this map).
  GameConfig.stations.placements = map.stations ?? [];

  // Fleet composition — every pick count + strikeCount IS a settings knob, so
  // only replace a faction's fleet when the player hasn't hand-tuned it.
  if (map.fleets) {
    for (const f of FACTIONS) {
      const comp = map.fleets[f];
      if (comp && !hooks.hasOverrideUnder(`fleets.${f}.`)) {
        GameConfig.fleets[f] = { fleet: comp.fleet, strikeCount: comp.strikeCount };
      }
    }
  }
}
