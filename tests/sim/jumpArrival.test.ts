/**
 * Regression proof for the jump-home arrival point (Mothership.
 * getJumpArrivalPosition).
 *
 * The jump drive used to teleport a ship to its raw launch-bay STAGING
 * coordinate. That point sits inside the carrier's solid hull colliders —
 * fine for catapult launches (a live LaunchSequence suspends the keep-out),
 * but a jump arrival has no launch sequence, so resolveMothershipCollisions
 * ran against it the same tick. On the Choirship the bay is covered by TWO
 * overlapping boxes (launch-bay housing + nacelle nose): the per-face
 * ejection bounced the ship between them every frame with its velocity
 * cancelled both ways — permanently wedged "in a weird part of the
 * mothership". getJumpArrivalPosition instead pushes the arrival outboard
 * of the bay until it clears every hull box by jump.arrivalClearance, while
 * staying inside the service bubble (docs/JUMP-DRIVE-AND-RESUPPLY.md:
 * arrivals drop into the bubble, stopped, and get serviced).
 */
import { describe, it, expect } from "vitest";

import {
  BattleSim,
  NetworkController,
  NEUTRAL_INPUT,
  GameConfig,
  type Faction,
} from "../../shared/src/index";

/** Largest fighter body in the catalog — the clearance the arrival must beat. */
const MAX_SHIP_RADIUS = Math.max(
  ...Object.values(GameConfig.shipTypes).map((t) => t.hitRadius),
);

function insideAnySection(
  sim: BattleSim,
  x: number,
  z: number,
  margin: number,
): boolean {
  for (const f of ["humans", "machines"] as Faction[]) {
    for (const s of sim.motherships[f].hullSections) {
      if (
        x >= s.minX - margin &&
        x <= s.maxX + margin &&
        z >= s.minZ - margin &&
        z <= s.maxZ + margin
      ) {
        return true;
      }
    }
  }
  return false;
}

describe("jump arrival point (Mothership.getJumpArrivalPosition)", () => {
  it("clears every hull collider and stays inside the service bubble, both factions × both bays", () => {
    BattleSim.seedRng(7);
    const sim = new BattleSim();
    for (const f of ["humans", "machines"] as Faction[]) {
      const home = sim.motherships[f];
      for (let bay = 0; bay < home.getLaunchBayCount(); bay++) {
        const p = home.getJumpArrivalPosition(bay);
        expect(
          insideAnySection(sim, p.x, p.z, MAX_SHIP_RADIUS),
          `${f} bay ${bay} arrival (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) overlaps a hull box`,
        ).toBe(false);
        expect(
          home.serviceZoneContains(p.x, p.z),
          `${f} bay ${bay} arrival left the service bubble`,
        ).toBe(true);
      }
    }
  });

  it("documents the hazard: the raw Choirship bay staging point IS inside the hull", () => {
    BattleSim.seedRng(7);
    const sim = new BattleSim();
    const bay = sim.motherships.machines.getLaunchStartPosition(0);
    expect(insideAnySection(sim, bay.x, bay.z, 0)).toBe(true);
  });

  it("a machines ship parked at its arrival point is not bumped (no wedge oscillation)", () => {
    const savedRockCount = GameConfig.asteroids.count;
    GameConfig.asteroids.count = 0; // nothing else may shove the ship
    try {
      const net = new NetworkController();
      net.setInput(NEUTRAL_INPUT);
      BattleSim.seedRng(7);
      const sim = new BattleSim();
      const ship = sim.spawnShip("machines", GameConfig.shipTypes.wraith, {
        respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
      });
      const combatant = sim.addCombatant({ ship, controller: net });
      sim.start();
      for (let i = 0; i < 900 && combatant.launch; i++) sim.advance(1 / 60);
      expect(combatant.launch, "ship never cleared the launch tube").toBeNull();

      // Simulate the jump arrival: snap to the bay's arrival point, stopped.
      const home = sim.motherships.machines;
      const arrival = home.getJumpArrivalPosition(0);
      ship.jumpTeleport(arrival.x, arrival.z, home.rotationY);

      // Two seconds of ticks with neutral input: a wedged ship ping-pongs
      // several units per frame; a clear one must not move at all.
      for (let i = 0; i < 120; i++) sim.advance(1 / 60);
      expect(ship.isAlive).toBe(true);
      expect(ship.position.x).toBeCloseTo(arrival.x, 3);
      expect(ship.position.z).toBeCloseTo(arrival.z, 3);
      expect(Math.hypot(ship.velocity.x, ship.velocity.z)).toBeCloseTo(0, 3);
    } finally {
      GameConfig.asteroids.count = savedRockCount;
    }
  });
});
