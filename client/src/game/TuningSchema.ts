import { GameConfig, type ShipTypeId } from "@space-duel/shared";
import type { Faction } from "@space-duel/shared";

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
  /**
   * Optional one-liner rendered under the group's header — for context that
   * applies to the WHOLE group (e.g. "the AI flies the side you didn't
   * pick"), so it isn't repeated in every row's hint.
   */
  note?: string;
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

// NOTE: `kind: "choice"` (a <select> row) has no current entries but stays a
// supported kind — SettingsMenu renders it and ConfigOverrides validates it.
// To add one, build the entry literal with its `options` list.

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
      num(`${p}.missileSalvo`, "Missiles per launch", 1, 4, 1,
        `Missiles the ${name} ripples per trigger pull (each spends one rack round). The Reaver's twin launch is 2.`),
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
      `How many ${capitalize(pick.type)}s launch when the AI flies the ${side.toLowerCase()} side.`,
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

/**
 * The wing rows: one COUNT per role (mirroring the fleet rows' shape) instead
 * of per-slot dropdowns. Roles are resolved against the runtime loadout
 * (WingPlan.resolveWingPlan) — "your ship" / "the other type" track whatever
 * faction + fighter the player picks in the hangar, so one set of rows serves
 * both sides. Each role's standing order is fixed doctrine (escorts cover
 * you, gunships guard the carrier); tune WHO flies, not micromanage slots.
 */
function wingEntries(): TuningEntry[] {
  return [
    num("player.wingmen.composition.self", "Escorts flying your ship", 0, 6, 1,
      "Wingmen flying the same ship you picked in the hangar — exact clones of your fighter. They fly your wing on cover: holding formation and breaking off to attack anything that threatens you."),
    num("player.wingmen.composition.other", "Escorts flying the other type", 0, 6, 1,
      "Wingmen flying your faction's OTHER ship type, rounding out the wing. They fly cover like your clone escorts: on your wing, breaking off to engage whatever threatens you."),
    num("player.wingmen.composition.gunship", "Gunships guarding your carrier", 0, 6, 1,
      "Heavy gunships on defend: they loiter at your mothership and intercept anything that gets close. Your rear guard while you're out front."),
  ];
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
      num("hulk.collisionDamage", "Wreck scrape damage", 0, 100, 1,
        "Hull damage a ship takes when it scrapes a derelict wreck (maps place the wrecks — see The Wreck). 0 makes contact free."),
      num("hulk.bumpCooldownSec", "Wreck scrape interval", 0.2, 5, 0.1,
        "Minimum seconds between scrape-damage ticks for a ship grinding along a wreck. Lower = the hull bites faster."),
      num("storms.zapDamage", "Ion storm zap damage", 0, 50, 1,
        "Hull damage per lightning zap while a ship sits inside an ion storm (maps place the storms — The Tempest is full of them). 0 makes storms harmless."),
      num("storms.zapIntervalSec", "Ion storm zap interval", 0.2, 5, 0.1,
        "Seconds between zaps for a ship loitering inside a storm. Lower = the storm bites faster."),
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
    title: "Your Wing",
    note:
      "The AI teammates launching at your side. “Your ship” and “the other type” resolve against whatever faction and fighter you pick in the hangar. All zeros = you fly alone.",
    entries: wingEntries(),
  },
  {
    title: "Enemy Fleet",
    note:
      "The AI flies whichever side you did NOT pick in the hangar — only that side’s rows shape a given match (your own side fields you and your wing instead).",
    entries: [...fleetEntries("humans"), ...fleetEntries("machines")],
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
        "Point-blank detection: a ship hiding in a nebula is still spotted (and shot at with guns) this close up — but it still can't be missile-locked while in the cloud. You can't be invisible in a knife fight."),
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
  {
    title: "Subsystems & Stations",
    note:
      "The strategic layer: carrier shield generators/hangar, and the capture stations + Energy economy on maps that place stations.",
    entries: [
      num("mothership.subsystems.shield.hp", "Shield generator HP", 50, 1500, 25,
        "Health of each carrier shield generator. While any generator lives, the carrier hull only takes a fraction of incoming damage."),
      num("mothership.subsystems.shield.shieldedHullDamageFactor", "Shielded hull damage", 0, 1, 0.05,
        "Fraction of damage the hull takes while shields are up. 0.2 = shields soak 80%. Keep above 0 so a match can always end."),
      num("mothership.subsystems.hangar.hp", "Hangar HP", 50, 1500, 25,
        "Health of the carrier hangar. Destroying it slows that faction's respawns."),
      num("mothership.subsystems.hangar.destroyedRespawnDelayScale", "Hangar-down respawn ×", 1, 6, 0.25,
        "Respawn-delay multiplier a faction suffers once its hangar is destroyed."),
      num("stations.captureTimeSec", "Station capture time (s)", 3, 60, 1,
        "Seconds one docked ship takes to flip a neutral station (draining an enemy one costs the same again)."),
      num("stations.dockMaxSpeed", "Dock speed limit", 4, 40, 1,
        "A ship must fly slower than this inside the station radius to capture — fly-throughs don't count."),
      num("stations.energyPerSec", "Energy per station (/s)", 0.2, 6, 0.1,
        "Energy each owned station feeds its faction's pool per second — sets the pace of the upgrade tiers."),
      num("commander.captureCount", "Enemy capture pilots", 0, 6, 1,
        "How many enemy fleet pilots the commander sends to contest stations. 0 = the enemy ignores stations."),
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
