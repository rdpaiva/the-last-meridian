/**
 * Terrain walls (shared/sim/Wall.ts): capsule geometry proofs + the scrape
 * cadence + a real 30Hz canyon battle.
 *
 * The geometry tests pin the two properties the whole feature rests on:
 *  - surfaceRadiusToward is EXACT for the capsule (convex + centered), so the
 *    weapon loops' swept-segment cover test resolves the true silhouette;
 *  - the push-out normal is the radial from the closest CORE-segment point,
 *    so a graze near a wall end ejects perpendicular (a capsule has no
 *    "flung along the hull" failure mode — the bug the wreck boxes needed
 *    nearest-face slab logic to fix).
 *
 * The Canyon battle runs at the 30Hz SERVER tick on the shipped map — the
 * projectile-tunneling lesson: invariants must hold where the authoritative
 * sim actually runs, not just at a friendly 60Hz. It asserts no live ship is
 * ever left inside a wall after a tick resolves, and that combat still
 * happens (lasers fired + damage dealt) — i.e. the AI threads the canyon
 * instead of stalling at its mouth.
 */
import { describe, it, expect } from "vitest";

import {
  GameConfig,
  MAPS,
  NEUTRAL_INPUT,
  NetworkController,
  BattleSim,
  Ship,
  Wall,
  WallSegment,
  applyMapConfig,
  bumpShipOutOfWallSegment,
  type WallHazard,
} from "../../shared/src/index";
import { HeadlessBattle } from "./HeadlessBattle";

describe("WallSegment capsule geometry", () => {
  // Horizontal capsule: core (0,0)→(100,0), halfWidth 15.
  const seg = new WallSegment(0, 0, 100, 0, 15);

  it("centers and circumscribes the chunk", () => {
    expect(seg.position.x).toBe(50);
    expect(seg.position.z).toBe(0);
    expect(seg.hitRadius).toBe(65); // halfLen 50 + halfWidth 15
  });

  it("surfaceRadiusToward is exact: side, tip, and diagonal", () => {
    expect(seg.surfaceRadiusToward(0, 1)).toBeCloseTo(15, 6); // flat side
    expect(seg.surfaceRadiusToward(1, 0)).toBeCloseTo(65, 6); // through the cap
    // 45°: exits the flat side at 15/sin(45°), still within the core span.
    expect(seg.surfaceRadiusToward(1, 1)).toBeCloseTo(15 * Math.SQRT2, 6);
  });

  it("pushes a mid-span overlap straight out and cancels inward velocity", () => {
    const wall = new Wall({
      kind: "wall",
      points: [
        { x: 0, z: 0 },
        { x: 100, z: 0 },
      ],
      width: 30,
    });
    const ship = shipAt(30, 10, 1, -3);
    let bumped = false;
    // Bump runs against the FULL edges: per-chunk resolution would let the
    // neighbor chunk's end-cap radial nudge a mid-span ship along the wall
    // (the seam artifact this test originally caught).
    for (const s of wall.edges) {
      if (bumpShipOutOfWallSegment(ship, s)) bumped = true;
    }
    expect(bumped).toBe(true);
    // Ejected to halfWidth + shipRadius = 15 + 2 above the core; x untouched.
    expect(ship.position.x).toBeCloseTo(30, 5);
    expect(ship.position.z).toBeCloseTo(17, 5);
    // Inward (z) component cancelled, tangential (x) preserved.
    expect(ship.velocity.z).toBeCloseTo(0, 5);
    expect(ship.velocity.x).toBeCloseTo(1, 5);
  });

  it("a graze near the wall end ejects perpendicular — no along-wall fling", () => {
    const ship = shipAt(98, 16.5, 4, -1);
    expect(bumpShipOutOfWallSegment(ship, seg)).toBe(true);
    // 0.5-unit penetration resolves as a 0.5-unit perpendicular push.
    expect(ship.position.x).toBeCloseTo(98, 5);
    expect(ship.position.z).toBeCloseTo(17, 5);
    expect(ship.velocity.x).toBeCloseTo(4, 5);
  });

  it("end-on contact ejects radially through the cap", () => {
    const ship = shipAt(110, 0, 0, 0);
    expect(bumpShipOutOfWallSegment(ship, seg)).toBe(true);
    expect(ship.position.x).toBeCloseTo(117, 5); // cap at 100 + 15 + radius 2
    expect(ship.position.z).toBeCloseTo(0, 5);
  });

  it("leaves a clear ship untouched", () => {
    const ship = shipAt(50, 40, 1, 1);
    expect(bumpShipOutOfWallSegment(ship, seg)).toBe(false);
    expect(ship.position.z).toBe(40);
  });

  it("chunks a polyline edge into contiguous ≤chunkLength capsules", () => {
    const wall = new Wall({
      kind: "wall",
      points: [
        { x: 0, z: 0 },
        { x: 200, z: 0 },
      ],
      width: 30,
    });
    const n = Math.ceil(200 / GameConfig.walls.chunkLength);
    const chunkLen = 200 / n;
    expect(wall.segments.length).toBe(n);
    for (let i = 0; i < n; i++) {
      const s = wall.segments[i];
      // Steering circle stays wall-hugging: exactly chunkLen/2 + halfWidth
      // (the circumscribing circle — the lane-narrowing overreach past the
      // wall face is radius − halfWidth = chunkLen/2, the tuning the
      // walls.chunkLength comment documents).
      expect(s.radius).toBeCloseTo(chunkLen / 2 + 15, 6);
      expect(s.position.x).toBeCloseTo(chunkLen / 2 + chunkLen * i, 6);
    }
  });
});

describe("wall scrape damage (BattleSim.resolveWallCollisions)", () => {
  it("deals walls.collisionDamage on contact, gated by bumpCooldownSec", () => {
    const savedHazards = GameConfig.hazards;
    const savedRockCount = GameConfig.asteroids.count;
    // A lone wall far from both carriers; no rocks to muddy the HP.
    GameConfig.hazards = [
      {
        kind: "wall",
        points: [
          { x: 300, z: -60 },
          { x: 300, z: 60 },
        ],
        width: 30,
      } satisfies WallHazard,
    ];
    GameConfig.asteroids.count = 0;
    try {
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

      // Hold the ship pressed into the wall face (re-place each frame — the
      // bump ejects it): exactly one damage tick per cooldown window.
      const press = () => {
        ship.position.x = 310;
        ship.position.z = 0;
      };
      press();
      sim.advance(1 / 60);
      expect(ship.hp).toBe(hp0 - GameConfig.walls.collisionDamage);

      press();
      sim.advance(1 / 60);
      expect(ship.hp).toBe(hp0 - GameConfig.walls.collisionDamage);

      const frames = Math.ceil(GameConfig.walls.bumpCooldownSec * 60) + 2;
      for (let i = 0; i < frames; i++) {
        press();
        sim.advance(1 / 60);
      }
      expect(ship.hp).toBe(hp0 - 2 * GameConfig.walls.collisionDamage);
    } finally {
      GameConfig.hazards = savedHazards;
      GameConfig.asteroids.count = savedRockCount;
    }
  });
});

describe("The Canyon at the 30Hz server tick", () => {
  it("fleets fight through the canyon and no ship is left inside a wall", () => {
    // Save every field applyMapConfig writes, apply the shipped map, restore.
    const saved = {
      playerZ: GameConfig.mothership.playerZ,
      enemyZ: GameConfig.mothership.enemyZ,
      asteroids: { ...GameConfig.asteroids },
      regions: GameConfig.asteroids.regions,
      nebulaZones: GameConfig.scenery.combatNebulas.zones,
      stormZones: GameConfig.storms.zones,
      hazards: GameConfig.hazards,
      stations: GameConfig.stations.placements,
      environment: GameConfig.scenery.environment,
    };
    applyMapConfig(MAPS.theCanyon);
    try {
      const walls = GameConfig.hazards
        .filter((h): h is WallHazard => h.kind === "wall")
        .map((h) => new Wall(h));
      expect(walls.length).toBe(2);

      const battle = new HeadlessBattle({ seed: 1337 });
      const push = { nx: 0, nz: 0, dist: 0 };
      try {
        const DT = 1 / 30; // the authoritative server cadence
        const TICKS = 30 * 120; // 2 sim-minutes — launch, transit, contact
        for (let t = 0; t < TICKS && !battle.ended; t++) {
          battle.tick(DT);
          if (battle.stats.ticks % 10 !== 0) continue;
          // Keep-out invariant: after a tick resolves, no LIVE ship may
          // remain inside a wall (dead ships park where they fell and the
          // resolver rightly ignores them).
          for (const s of battle.sample().ships) {
            if (s.hp <= 0) continue;
            for (const wall of walls) {
              for (const seg of wall.edges) {
                const inside = seg.computePushOutXZ(s.x, s.z, 0, push);
                expect(
                  inside && push.dist > 0.01,
                  `tick ${battle.stats.ticks}: live ship at (${s.x}, ${s.z}) ` +
                    `is ${push.dist.toFixed(2)} inside a canyon wall`,
                ).toBe(false);
              }
            }
          }
        }
        // The AI must actually fly the canyon and reach the fight — a stalled
        // fleet bunched at the mouth fires nothing.
        expect(battle.stats.anyShipMoved, "no ship ever moved").toBe(true);
        expect(
          battle.stats.anyLaserFired,
          "no laser fired in 2 sim-minutes — fleets never met in the canyon",
        ).toBe(true);
        expect(
          battle.stats.anyShipDamaged,
          "no damage dealt — contact without a real engagement",
        ).toBe(true);
      } finally {
        battle.dispose();
      }
    } finally {
      GameConfig.mothership.playerZ = saved.playerZ;
      GameConfig.mothership.enemyZ = saved.enemyZ;
      Object.assign(GameConfig.asteroids, saved.asteroids);
      GameConfig.asteroids.regions = saved.regions;
      GameConfig.scenery.combatNebulas.zones = saved.nebulaZones;
      GameConfig.storms.zones = saved.stormZones;
      GameConfig.hazards = saved.hazards;
      GameConfig.stations.placements = saved.stations;
      GameConfig.scenery.environment = saved.environment;
    }
  });
});

/** Bare ship at a pose (the hulkKeepOut recipe — radius 2 for exact numbers). */
function shipAt(x: number, z: number, vx: number, vz: number): Ship {
  const type = GameConfig.shipTypes.spitfire;
  const ship = new Ship({
    faction: "humans" as const,
    maxHp: type.maxHp,
    respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
    startMissileAmmo: type.missileAmmo,
    startCannonAmmo: type.cannonAmmo,
    movement: type,
    hitRadius: 2,
    fireSound: type.fireSound,
  });
  ship.position.x = x;
  ship.position.z = z;
  ship.velocity.x = vx;
  ship.velocity.z = vz;
  return ship;
}
