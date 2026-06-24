import { GameConfig, type ShipTypeId } from "./GameConfig";
import type { Faction } from "./Faction";

/**
 * The CURATED tuning surface for the match-settings screen (SettingsMenu) —
 * a declarative list of the GameConfig knobs that meaningfully change
 * GAMEPLAY, each with a label, bounds, step, and a plain-language hint. The
 * GUI renders itself from this schema; ConfigOverrides validates and clamps
 * every stored/imported value against it, so nothing outside these bounds
 * can reach the sim.
 *
 * Deliberately NOT the whole of GameConfig: juice and visuals (shake,
 * hitstop, glow, camera, scenery) stay out so testers see ~70 knobs that
 * matter, not a 200-row wall. Add an entry = it appears in the menu, is
 * persisted, and round-trips through JSON export/import — nothing else to
 * wire.
 *
 * This same schema is the planned MULTIPLAYER match-config surface: a host's
 * override blob (see ConfigOverrides.exportJson) is exactly the document a
 * server would apply before a match (docs/MULTIPLAYER.md).
 *
 * `path` is a dot-path into GameConfig (numeric segments index into arrays,
 * e.g. `fleets.humans.fleet.0.count`). Values apply on the NEXT match launch
 * — every system copies its config at construction, so live mutation
 * mid-match is out of scope by design.
 */
export interface TuningEntry {
  /** Dot-path into GameConfig (numeric segments index arrays). */
  path: string;
  label: string;
  /**
   * Plain-language explanation shown by the row's ⓘ popover. REQUIRED — the
   * settings screen is aimed at testers who haven't read GameConfig.ts, so
   * every knob explains itself in one or two friendly sentences (what it
   * does in play, not how the code implements it).
   */
  hint: string;
  kind: "number" | "boolean" | "choice";
  /** Bounds + step — required for "number" entries; ignored otherwise. */
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values + display labels — required for "choice" entries. */
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface TuningGroup {
  title: string;
  entries: ReadonlyArray<TuningEntry>;
}

function num(
  path: string,
  label: string,
  min: number,
  max: number,
  step: number,
  hint: string,
): TuningEntry {
  return { path, label, kind: "number", min, max, step, hint };
}

function bool(path: string, label: string, hint: string): TuningEntry {
  return { path, label, kind: "boolean", hint };
}

function choice(
  path: string,
  label: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  hint: string,
): TuningEntry {
  return { path, label, kind: "choice", options, hint };
}

/** "spitfire" → "Spitfire" — the catalog ids are already the canon names. */
function capitalize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** One group per catalog ship — the same knob set for every type. */
function shipGroup(id: ShipTypeId): TuningGroup {
  const p = `shipTypes.${id}`;
  const name = capitalize(id);
  return {
    title: `Ship — ${name}`,
    entries: [
      num(`${p}.maxSpeed`, "Max speed", 5, 60, 1,
        `The ${name}'s top speed. Higher = harder to chase and harder to hit.`),
      num(`${p}.thrust`, "Thrust", 5, 100, 1,
        `How hard the engine pushes — how quickly the ${name} reaches top speed and recovers from maneuvers.`),
      num(`${p}.rotationSpeed`, "Turn rate", 0.5, 10, 0.1,
        `How fast the ${name} swings its nose around. Higher = more agile in a dogfight.`),
      num(`${p}.maxHp`, "Hull HP", 10, 1000, 10,
        `Total damage the ${name} can take before it explodes.`),
      num(`${p}.laserDamage`, "Laser damage", 1, 100, 1,
        `Damage each of the ${name}'s laser bolts deals on a hit.`),
      num(`${p}.fireCooldownMs`, "Fire cooldown (ms)", 40, 1000, 10,
        "Pause between laser shots, in milliseconds. Lower = a faster trigger and more damage per second."),
      num(`${p}.missileAmmo`, "Missile rack", 0, 60, 1,
        `Heat-seeking missiles the ${name} carries per life. 0 removes the rack entirely.`),
    ],
  };
}

/**
 * Fleet-composition entries, generated from the CURRENT composition lists so
 * they track GameConfig if the default fleet mix changes. Only the COUNTS
 * are tunable — the entry list itself (which types, their order) stays
 * config-only, because strikeCount's "first entries get strike orders"
 * semantics depend on that order.
 */
function fleetEntries(faction: Faction): TuningEntry[] {
  const side = capitalize(faction);
  const rows = GameConfig.fleets[faction].fleet.map((pick, i) =>
    num(
      `fleets.${faction}.fleet.${i}.count`,
      `${side} fleet — ${capitalize(pick.type)}s`,
      0,
      12,
      1,
      `How many ${capitalize(pick.type)}s launch when the AI flies the ${side.toLowerCase()} side. (Your own side fields you and your wingmen instead.)`,
    ),
  );
  rows.push(
    num(
      `fleets.${faction}.strikeCount`,
      `${side} fleet — strikers`,
      0,
      12,
      1,
      "How many of this fleet's ships attack your mothership instead of dogfighting. These are what actually threaten the win condition — 0 means the fleet never presses the objective.",
    ),
  );
  return rows;
}

/** The standing orders an AI wingman can fly (AIController's AIOrder). */
const WINGMAN_ORDER_OPTIONS = [
  { value: "cover", label: "Cover" },
  { value: "formation", label: "Formation" },
  { value: "hunt", label: "Hunt" },
  { value: "strike", label: "Strike" },
  { value: "defend", label: "Defend" },
];

/**
 * One order dropdown per wingman SLOT — generated from the orders array's
 * length (GameConfig pads it to the max wing size), so slot i's dropdown is
 * exactly `player.wingmen.orders[i]`.
 */
function wingmanOrderEntries(): TuningEntry[] {
  return GameConfig.player.wingmen.orders.map((_, i) =>
    choice(
      `player.wingmen.orders.${i}`,
      `Wingman ${i + 1} order`,
      WINGMAN_ORDER_OPTIONS,
      "This wingman's standing order for the whole match. Cover = fly your wing and break off to attack anything that threatens you. Formation = hold position on your wing, only shooting what crosses its nose. Hunt = roam and chase down enemy fighters. Strike = press the attack on the enemy mothership. Defend = guard your own mothership. (Only matters if you field this many wingmen.)",
    ),
  );
}

/**
 * One ship-type dropdown per wingman SLOT, PER faction — generated from the
 * shipTypes list's length (GameConfig pads each to the max wing size), so slot
 * i's dropdown is exactly `player.wingmen.shipTypes.<faction>.i`. Per-faction
 * because a ship type is faction-specific (a humans wing can't fly a wraith);
 * only the side the player actually picks is read at launch. Options come from
 * the faction's roster (factionShips) — and picking your OWN ship's type makes
 * that wingman a clone of your loaded fighter (Game.ts), so "match me" is just
 * "pick the same type".
 */
function wingmanShipEntries(faction: Faction): TuningEntry[] {
  const side = capitalize(faction);
  const options = GameConfig.factionShips[faction].map((id) => ({
    value: id,
    label: capitalize(id),
  }));
  return GameConfig.player.wingmen.shipTypes[faction].map((_, i) =>
    choice(
      `player.wingmen.shipTypes.${faction}.${i}`,
      `${side} wing — ship ${i + 1}`,
      options,
      `Which ship wingman ${i + 1} flies when you pick the ${side.toLowerCase()} side. Picking your own ship's type makes that wingman a clone of your loaded fighter. (Only matters if you fly this side and field this many wingmen.)`,
    ),
  );
}

export const TUNING_SCHEMA: ReadonlyArray<TuningGroup> = [
  {
    title: "Arena & Asteroids",
    entries: [
      num("arena.halfWidth", "Arena half-width", 200, 1500, 50,
        "How far the battlefield spreads east–west: fighter spawns, rocks, and scenery scatter across this. Space itself is unbounded — ships can still fly past it."),
      num("arena.halfDepth", "Arena half-depth", 200, 1500, 50,
        "How far the battlefield spreads north–south (toward the two motherships). Space itself is unbounded — ships can still fly past it."),
      bool("arena.showGrid", "Show reference grid",
        "Draws a wireframe grid on the battle plane — handy for judging distance and speed while tuning."),
      num("asteroids.count", "Asteroid count", 0, 200, 1,
        "How many asteroids the battlefield starts with. Rocks block shots and missiles (cover!) and can be destroyed. 0 = empty space."),
      num("asteroids.radiusMin", "Asteroid min radius", 2, 30, 1,
        "The smallest rock size the field spawns with."),
      num("asteroids.radiusMax", "Asteroid max radius", 5, 60, 1,
        "The largest rock size the field spawns with."),
      num("asteroids.driftSpeedMin", "Drift speed min", 0, 20, 0.5,
        "The slowest a rock drifts across the field."),
      num("asteroids.driftSpeedMax", "Drift speed max", 0, 30, 0.5,
        "The fastest a rock drifts across the field. Fast rocks make cover that moves."),
      num("asteroids.hpPerRadius", "Rock HP per radius", 1, 60, 1,
        "Rock toughness: hit points per unit of size, so bigger rocks take more shots to crack."),
      num("asteroids.collisionDamage", "Ram damage", 0, 100, 1,
        "Hull damage a ship takes when it flies into a rock. 0 makes ramming free."),
      num("asteroids.mothershipClearance", "Carrier clearance", 50, 400, 10,
        "Rock-free bubble around each mothership, keeping the launch lanes and the objective fight clear."),
    ],
  },
  ...(Object.keys(GameConfig.shipTypes) as ShipTypeId[]).map(shipGroup),
  {
    title: "Weapons — Lasers & Missiles",
    entries: [
      num("laser.speed", "Laser bolt speed", 30, 250, 5,
        "How fast laser bolts travel (both sides). Faster bolts are easier to land on a moving target."),
      num("laser.lifetimeMs", "Laser lifetime (ms)", 300, 3000, 50,
        "How long a bolt flies before fizzling out. Together with bolt speed, this sets laser range."),
      num("missile.speed", "Missile speed", 10, 120, 1,
        "How fast missiles fly. Slower missiles are easier to out-run and out-turn."),
      num("missile.turnRate", "Missile turn rate", 0.5, 10, 0.1,
        "How sharply a missile can turn while chasing. Keep it below a ship's turn rate so a hard juke can still shake it."),
      num("missile.interceptRadius", "Intercept radius", 0, 3, 0.05,
        "How close a laser bolt must pass to shoot a missile down (point defense). Bigger = easier to swat incoming rounds. 0 disables shoot-down."),
      num("missile.minDamage", "Missile min damage", 0, 200, 5,
        "A missile hit rolls its damage randomly between min and max — this is the low end."),
      num("missile.maxDamage", "Missile max damage", 0, 200, 5,
        "A missile hit rolls its damage randomly between min and max — this is the high end."),
      num("missile.lockRange", "Lock range", 50, 800, 10,
        "How far away a missile lock can be acquired before launch."),
      num("missile.lockConeAngle", "Lock cone half-angle", 0.1, 1.5, 0.05,
        "How wide the lock-on cone in front of the nose is, in radians (0.5 ≈ 29°). Wider = easier locks."),
      num("missile.fireCooldownMs", "Launch cooldown (ms)", 100, 3000, 50,
        "Minimum pause between missile launches, so a full rack can't be dumped in one second."),
      num("missile.lifetimeMs", "Missile lifetime (ms)", 1000, 12000, 250,
        "How long a missile flies before self-destructing. With speed, this sets how far a missile can chase."),
    ],
  },
  {
    title: "Fleets & Wing",
    entries: [
      num("player.wingmen.count", "Player wingmen", 0, 6, 1,
        "How many AI teammates fly at your side. 0 = you fly alone."),
      ...wingmanOrderEntries(),
      ...wingmanShipEntries("humans"),
      ...wingmanShipEntries("machines"),
      ...fleetEntries("humans"),
      ...fleetEntries("machines"),
    ],
  },
  {
    title: "AI & Commander",
    entries: [
      num("ai.engagementRange", "Engagement range", 10, 150, 1,
        "How close an enemy must get before an AI pilot stops cruising and turns in to attack."),
      num("ai.fireRange", "AI fire range", 5, 100, 1,
        "How close an AI pilot closes before pulling the trigger."),
      num("ai.fireConeAngle", "AI fire cone", 0.05, 0.8, 0.01,
        "How well-aimed the AI's nose must be before it shoots, in radians (0.22 ≈ 13°). Smaller = more precise, less spray."),
      num("ai.carrierFireStandoff", "Carrier strike standoff", 30, 150, 5,
        "How far off a mothership's hull attacking ships start shooting at it."),
      num("ai.missileMinRange", "AI missile min range", 5, 80, 1,
        "Closer than this, AI pilots save their missiles and use guns — no wasting a seeker on a knife fight."),
      num("ai.missileMaxRange", "AI missile max range", 30, 300, 5,
        "The furthest an AI pilot will launch a missile from. Beyond it, a juking target can outlast the motor."),
      num("ai.missileCooldownSec", "AI missile pacing (sec)", 1, 30, 0.5,
        "Seconds an AI pilot waits between missile launches, so a rack lasts a whole fight instead of one volley."),
      num("ai.reactionSec", "AI reaction lag (sec)", 0, 1, 0.02,
        "AI reaction time: how often pilots re-aim and re-pick targets. 0 = inhumanly perfect reflexes; higher feels more human."),
      num("commander.thinkIntervalSec", "Commander think (sec)", 0.5, 10, 0.5,
        "How often the enemy fleet commander re-assigns its ships' jobs (attack, escort, defend, hunt)."),
      num("commander.escortCount", "Commander escorts", 0, 6, 1,
        "Ships the commander assigns to guard its lead attacker."),
      num("commander.defendCount", "Commander defenders", 0, 6, 1,
        "Ships scrambled back home when the enemy mothership feels threatened."),
      num("commander.huntCount", "Commander hunters", 0, 6, 1,
        "Ships sent to chase down whatever contacts the enemy fleet can see on radar."),
      num("commander.defendAlertRadius", "Defense alert radius", 50, 600, 10,
        "An intruder this close to the enemy mothership triggers its defensive scramble."),
    ],
  },
  {
    title: "Sensors & Stealth",
    entries: [
      num("sensors.shipRange", "Fighter radar range", 50, 600, 10,
        "How far each fighter's radar sees. Both your radar screen and AI targeting work off what's detected — not where ships really are."),
      num("sensors.mothershipRange", "Carrier radar range", 100, 1000, 10,
        "How far a mothership's big radar sees — long-range early warning for its whole team."),
      num("sensors.visualRange", "Eyeball range", 10, 150, 5,
        "Point-blank detection: even a ship hiding in a nebula is spotted this close up. You can't be invisible in a knife fight."),
      num("sensors.memorySec", "Ghost memory (sec)", 0, 30, 0.5,
        "After a contact disappears (e.g. into a nebula), its last-known position stays on radar as a fading ghost — and AI pilots keep hunting it — for this many seconds."),
      num("sensors.nebulaSensorFactor", "Nebula sensor factor", 0, 1, 0.05,
        "How well a ship's OWN radar works while it hides inside a nebula. 1 = no penalty, 0 = hiding makes you blind."),
    ],
  },
  {
    title: "Objective & Respawn",
    entries: [
      num("mothership.maxHp", "Mothership HP", 200, 10000, 100,
        "Health of both motherships. Destroy the enemy's to win the match — lose yours and it's over."),
      num("combat.playerRespawnDelayMs", "Player respawn (ms)", 0, 10000, 250,
        "How long you wait after dying before relaunching from your mothership."),
      num("combat.enemyRespawnDelayMs", "Enemy respawn (ms)", 0, 15000, 250,
        "How long enemy fighters wait after dying before they relaunch."),
    ],
  },
  {
    title: "Carrier Turrets",
    entries: [
      num("mothership.turrets.hp", "Turret HP", 20, 600, 10,
        "Health of each carrier defense gun. Shoot a turret off the pod to open a lane before pressing the hull."),
      num("mothership.turrets.range", "Turret range", 80, 600, 10,
        "How far a carrier turret will engage approaching ships."),
      num("mothership.turrets.damage", "Turret damage", 2, 60, 1,
        "Damage per turret bolt."),
      num("mothership.turrets.fireCooldownSec", "Turret fire interval (s)", 0.2, 4, 0.05,
        "Seconds between shots for each turret — lower = heavier flak."),
      num("mothership.turrets.turnRate", "Turret slew rate", 0.3, 6, 0.1,
        "How fast a turret barrel tracks a moving target (radians/sec)."),
    ],
  },
];

/** Flat path → entry lookup, for validation/clamping (ConfigOverrides). */
const BY_PATH = new Map<string, TuningEntry>();
for (const group of TUNING_SCHEMA) {
  for (const entry of group.entries) BY_PATH.set(entry.path, entry);
}

export function findTuningEntry(path: string): TuningEntry | undefined {
  return BY_PATH.get(path);
}
