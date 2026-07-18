/**
 * Capture stations + Energy + upgrade thresholds (strategic layer M2,
 * docs/strategic-layer-plan.md):
 *
 *  - CaptureStation meter rules: neutral capture, assist cap, contested
 *    freeze, the two-stage enemy flip (drain → neutral → capture);
 *  - StrategicSystem docking gate (radius + dockMaxSpeed + not mid-launch),
 *    energy accrual from owned stations, thresholds unlocking in order, and
 *    the three effects (respawn scale / sensor rangeScale / turret overdrive
 *    reviving the turret death latches + arming the full-hp fire buff);
 *  - the stock-config guarantee: no placements → inert (the smoke baseline
 *    contract; the smoke test itself is the enforcement).
 *
 * GameConfig is a mutable process-wide singleton — every test that writes it
 * restores in afterEach.
 */
import { describe, it, expect, afterEach } from "vitest";

import {
  BattleSim,
  CaptureStation,
  GameConfig,
  NetworkController,
  NEUTRAL_INPUT,
  SimEventBus,
  StrategicSystem,
  type Faction,
} from "../../shared/src/index";

const savedPlacements = GameConfig.stations.placements;
const savedThresholds = GameConfig.energy.thresholds;

afterEach(() => {
  GameConfig.stations.placements = savedPlacements;
  GameConfig.energy.thresholds = savedThresholds;
});

const DT = 1 / 60;
const CAPTURE_SEC = GameConfig.stations.captureTimeSec;

/** Advance a station with fixed presence counts for `seconds`. */
function run(
  station: CaptureStation,
  seconds: number,
  humans: number,
  machines: number,
): Array<"captured" | "neutralized"> {
  const changes: Array<"captured" | "neutralized"> = [];
  for (let t = 0; t < seconds; t += DT) {
    const c = station.update(DT, humans, machines);
    if (c) changes.push(c);
  }
  return changes;
}

describe("CaptureStation meter rules", () => {
  it("one docked ship captures a neutral station in captureTimeSec", () => {
    const st = new CaptureStation(0, 0, 0);
    expect(run(st, CAPTURE_SEC * 0.9, 1, 0)).toEqual([]);
    expect(st.owner).toBeNull();
    expect(run(st, CAPTURE_SEC * 0.2, 1, 0)).toEqual(["captured"]);
    expect(st.owner).toBe("humans");
    expect(st.capturingFaction).toBeNull();
  });

  it("extra allies speed capture, capped at maxAssistFactor", () => {
    const st = new CaptureStation(0, 0, 0);
    // 4 docked ships, cap 2 → half the solo time (plus slack for tick grain).
    expect(run(st, CAPTURE_SEC / 2 + 0.1, 4, 0)).toEqual(["captured"]);
  });

  it("contested (both factions docked) freezes the meter", () => {
    const st = new CaptureStation(0, 0, 0);
    run(st, CAPTURE_SEC / 2, 1, 0);
    const midway = st.progress;
    expect(run(st, CAPTURE_SEC * 2, 1, 1)).toEqual([]);
    expect(st.contested).toBe(true);
    expect(st.progress).toBeCloseTo(midway, 6);
    // Nobody docked → holds too (ownership/progress persist).
    run(st, CAPTURE_SEC, 0, 0);
    expect(st.progress).toBeCloseTo(midway, 6);
  });

  it("flipping an enemy station is two-stage: neutralize, then capture", () => {
    const st = new CaptureStation(0, 0, 0);
    st.owner = "machines";
    const changes = run(st, CAPTURE_SEC * 2.2, 1, 0);
    expect(changes).toEqual(["neutralized", "captured"]);
    expect(st.owner).toBe("humans");
  });

  it("a defender drains the attacker's partial meter before it can climb", () => {
    const st = new CaptureStation(0, 0, 0);
    st.capturingFaction = "machines";
    st.progress = 0.5;
    // Humans docked alone: drain the machine meter to 0, then fill their own.
    const changes = run(st, CAPTURE_SEC * 1.6, 1, 0);
    expect(changes).toEqual(["captured"]);
    expect(st.owner).toBe("humans");
  });
});

describe("StrategicSystem docking gate + energy + upgrades", () => {
  function makeSim(placements: Array<{ xFrac: number; zFrac: number }>) {
    GameConfig.stations.placements = placements;
    BattleSim.seedRng(23);
    const sim = new BattleSim();
    const net = new NetworkController();
    net.setInput(NEUTRAL_INPUT);
    const ship = sim.spawnShip("humans", GameConfig.shipTypes.spitfire, {
      respawnDelayMs: 1000,
    });
    const seat = sim.addCombatant({ ship, controller: net });
    sim.start();
    return { sim, ship, seat };
  }

  it("captures only when docked: inside the radius AND slow AND launched", () => {
    const { sim, ship, seat } = makeSim([{ xFrac: 0, zFrac: 0 }]);
    const station = sim.strategic.stations[0];

    // Park ON the station while still mid-catapult: no capture.
    ship.position.set(station.position.x, 0, station.position.z);
    ship.velocity.set(0, 0, 0);
    const preLaunch = seat.launch !== null;
    sim.advance(DT);
    if (preLaunch) expect(station.capturingFaction).toBeNull();

    // Clear the tube (long enough for the staggered catapult), re-park.
    for (let i = 0; i < 1200 && seat.launch; i++) sim.advance(DT);
    expect(seat.launch).toBeNull();
    ship.position.set(station.position.x, 0, station.position.z);

    // Too fast = a fly-through, no progress.
    ship.velocity.set(GameConfig.stations.dockMaxSpeed + 5, 0, 0);
    const before = station.progress;
    sim.advance(DT);
    ship.position.set(station.position.x, 0, station.position.z); // re-center
    expect(station.progress).toBeCloseTo(before, 6);

    // Slow = docked, the meter climbs.
    ship.velocity.set(0, 0, 0);
    sim.advance(DT);
    expect(
      station.capturingFaction === "humans" && station.progress > 0,
    ).toBe(true);
  });

  it("owned stations accrue Energy; thresholds unlock in order with effects", () => {
    // Cheap thresholds so the test runs in sim-seconds, not minutes.
    GameConfig.energy.thresholds = [
      { cost: 2, effect: "fasterRespawn" },
      { cost: 4, effect: "sensorBoost" },
      { cost: 6, effect: "turretOverdrive" },
    ];
    const { sim, ship, seat } = makeSim([{ xFrac: 0, zFrac: 0 }]);
    const station = sim.strategic.stations[0];
    const unlocked: string[] = [];
    sim.events.on("upgradeUnlocked", ({ faction, effect }) => {
      expect(faction).toBe("humans");
      unlocked.push(effect);
    });

    for (let i = 0; i < 1200 && seat.launch; i++) sim.advance(DT);
    // Pre-wound a turret to death so turretOverdrive's repair has work.
    const humansCarrier = sim.motherships.humans;
    const turret = humansCarrier.turrets[0]!;
    turret.takeDamage(turret.maxHp, 0);
    sim.advance(DT); // death latch announces
    expect(turret.explosionFired).toBe(true);

    // Dock until captured, then hold until every threshold has fired.
    for (let t = 0; t < 60 && unlocked.length < 3; t += DT) {
      ship.position.set(station.position.x, 0, station.position.z);
      ship.velocity.set(0, 0, 0);
      sim.advance(DT);
    }
    expect(station.owner).toBe("humans");
    expect(unlocked).toEqual(["fasterRespawn", "sensorBoost", "turretOverdrive"]);
    expect(sim.strategic.tier.humans).toBe(3);
    // Effects observable:
    expect(ship.respawnDelayScale).toBeCloseTo(GameConfig.energy.fasterRespawnScale, 6);
    expect(sim.sensors.rangeScale.humans).toBeCloseTo(GameConfig.energy.sensorRangeScale, 6);
    expect(sim.sensors.rangeScale.machines).toBe(1);
    expect(turret.isAlive).toBe(true); // revived…
    expect(turret.explosionFired).toBe(false); // …and the death latch re-armed
    expect(turret.hp).toBe(turret.maxHp);
    expect(humansCarrier.turretOverdrive).toBe(true); // full-hp fire buff armed
    expect(sim.motherships.machines.turretOverdrive).toBe(false);
  });

  it("stock config (no placements) leaves the strategic layer inert", () => {
    const { sim } = makeSim([]);
    expect(sim.strategic.active).toBe(false);
    for (let i = 0; i < 120; i++) sim.advance(DT);
    const factions: Faction[] = ["humans", "machines"];
    for (const f of factions) {
      expect(sim.strategic.energy[f]).toBe(0);
      expect(sim.strategic.tier[f]).toBe(0);
      expect(sim.sensors.rangeScale[f]).toBe(1);
    }
  });
});

describe("StrategicSystem standalone (no BattleSim)", () => {
  it("counts docked presence per faction against the same station", () => {
    GameConfig.stations.placements = [{ xFrac: 0, zFrac: 0 }];
    BattleSim.seedRng(29);
    const sim = new BattleSim(); // just for spawnShip + motherships
    const strategic = new StrategicSystem(
      new SimEventBus(),
      GameConfig.arena.halfWidth,
      GameConfig.arena.halfDepth,
    );
    const station = strategic.stations[0];
    const mkSeat = (faction: Faction) => {
      const ship = sim.spawnShip(faction, GameConfig.shipTypes.spitfire, {
        respawnDelayMs: 1000,
      });
      ship.position.set(station.position.x, 0, station.position.z);
      ship.velocity.set(0, 0, 0);
      return { ship, launch: null };
    };
    const seats = [mkSeat("humans"), mkSeat("machines")];
    strategic.update(DT, seats, sim.sensors, sim.motherships);
    expect(station.contested).toBe(true);
  });
});
