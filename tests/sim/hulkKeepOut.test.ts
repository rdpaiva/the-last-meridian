/**
 * Regression proof for the wreck keep-out (bumpShipOutOfHulkSection).
 *
 * The original resolver ejected radially from the hull BOX CENTRE (the
 * asteroid pattern). The wreck's boxes are up to ~7× longer than wide, so a
 * ship grazing the long side near the bow sat on a centre-ray nearly parallel
 * to the hull: a sub-unit perpendicular penetration resolved as a push
 * several units long, pointed ALONG the hull — the "ship suddenly flung
 * sideways off The Wreck" bug. The fix ejects along the nearest face in the
 * hull's local frame (HulkSection.computePushOutXZ).
 *
 * Geometry mirrors The Wreck (Maps.ts): the Bastion hulk at the origin,
 * yaw π/2 (keel along world +X), scale 0.5 — but static (no roll) so the
 * numbers are exact. Ship radius 2. The main hull box (GameConfig
 * mothership.colliders.humans[0]: hx 17, hz 127.2, cz 12.7) lands at world
 * centre (6.35, 0), half-extents 8.5 across (world Z) × 63.6 along (world X),
 * so its radius-expanded silhouette spans x ∈ [-59.25, 71.95], z ∈ [-10.5, 10.5].
 */
import { describe, it, expect } from "vitest";

import {
  BattleSim,
  Hulk,
  NetworkController,
  NEUTRAL_INPUT,
  Ship,
  bumpShipOutOfHulkSection,
  GameConfig,
} from "../../shared/src/index";

const SHIP_RADIUS = 2;

function makeWreck(): Hulk {
  return new Hulk({
    kind: "hulk",
    source: "humans",
    x: 0,
    z: 0,
    rotationY: Math.PI / 2,
    rotationRate: 0,
    scale: 0.5,
  });
}

function makeShip(x: number, z: number, vx: number, vz: number): Ship {
  const type = GameConfig.shipTypes.spitfire;
  const ship = new Ship({
    faction: "humans",
    maxHp: type.maxHp,
    respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
    startMissileAmmo: type.missileAmmo,
    startCannonAmmo: type.cannonAmmo,
    movement: type,
    hitRadius: SHIP_RADIUS,
    fireSound: type.fireSound,
  });
  ship.position.x = x;
  ship.position.z = z;
  ship.velocity.x = vx;
  ship.velocity.z = vz;
  return ship;
}

function bumpAll(ship: Ship, wreck: Hulk): boolean {
  let bumped = false;
  for (const section of wreck.sections) {
    if (bumpShipOutOfHulkSection(ship, section)) bumped = true;
  }
  return bumped;
}

describe("wreck keep-out (bumpShipOutOfHulkSection)", () => {
  it("ejects a side graze near the bow straight out, not along the hull", () => {
    const wreck = makeWreck();
    // 55 units down the keel from the box centre, 2.5 into the expanded side.
    // Velocity: 3 along the hull (+X, tangential), 5 into it (+Z, inward).
    const ship = makeShip(61, -8, 3, 5);
    expect(bumpAll(ship, wreck)).toBe(true);

    // Nearest face is the side: straight out to z = -10.5, x untouched. The
    // radial-from-centre resolver moved this graze to ≈(66.4, -8.8) — a 5.4
    // unit fling along the hull for a 2.5 unit penetration.
    expect(ship.position.x).toBeCloseTo(61, 5);
    expect(ship.position.z).toBeCloseTo(-10.5, 5);
    // Inward velocity cancelled, tangential velocity preserved.
    expect(ship.velocity.z).toBeCloseTo(0, 5);
    expect(ship.velocity.x).toBeCloseTo(3, 5);
  });

  it("ejects an end-on contact through the bow face", () => {
    const wreck = makeWreck();
    const ship = makeShip(69, 0, 0, 0);
    bumpAll(ship, wreck);

    // Bow slab is the cheapest escape: out along the keel to x = 71.95.
    expect(ship.position.x).toBeCloseTo(71.95, 5);
    expect(ship.position.z).toBeCloseTo(0, 5);
  });

  it("leaves a clear ship untouched", () => {
    const wreck = makeWreck();
    const ship = makeShip(61, -35, 1, 1);
    expect(bumpAll(ship, wreck)).toBe(false);

    expect(ship.position.x).toBe(61);
    expect(ship.position.z).toBe(-35);
    expect(ship.velocity.x).toBe(1);
    expect(ship.velocity.z).toBe(1);
  });
});

describe("wreck scrape damage (BattleSim.resolveHulkCollisions)", () => {
  it("deals hulk.collisionDamage on contact, gated by bumpCooldownSec", () => {
    // Place The Wreck's hulk far from both carriers, and clear the rocks so
    // nothing else can touch the ship's HP.
    const savedHazards = GameConfig.hazards;
    const savedRockCount = GameConfig.asteroids.count;
    GameConfig.hazards = [{
      kind: "hulk", source: "humans", x: 300, z: 0,
      rotationY: Math.PI / 2, rotationRate: 0, scale: 0.5,
    }];
    GameConfig.asteroids.count = 0;
    try {
      // Lone friendly ship, launched clear (the networkController.test recipe).
      const net = new NetworkController();
      net.setInput(NEUTRAL_INPUT);
      BattleSim.seedRng(7);
      const sim = new BattleSim();
      const ship = sim.spawnShip("humans", GameConfig.shipTypes.spitfire, {
        respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
      });
      const combatant = sim.addCombatant({ ship, controller: net });
      sim.start();
      for (let i = 0; i < 900 && combatant.launch; i++) sim.advance(1 / 60);
      expect(combatant.launch, "ship never cleared the launch tube").toBeNull();
      const hp0 = ship.hp;

      // Hold the ship pressed into the hull side (re-place each frame — the
      // bump ejects it) and tick: exactly one damage application lands.
      const press = () => {
        ship.position.x = 355;
        ship.position.z = -8;
      };
      press();
      sim.advance(1 / 60);
      expect(ship.hp).toBe(hp0 - GameConfig.hulk.collisionDamage);

      // Immediately re-pressed, still inside the cooldown: no extra tick.
      press();
      sim.advance(1 / 60);
      expect(ship.hp).toBe(hp0 - GameConfig.hulk.collisionDamage);

      // Grind for just over one cooldown window: exactly one more tick.
      const frames = Math.ceil(GameConfig.hulk.bumpCooldownSec * 60) + 2;
      for (let i = 0; i < frames; i++) {
        press();
        sim.advance(1 / 60);
      }
      expect(ship.hp).toBe(hp0 - 2 * GameConfig.hulk.collisionDamage);
    } finally {
      GameConfig.hazards = savedHazards;
      GameConfig.asteroids.count = savedRockCount;
    }
  });
});
