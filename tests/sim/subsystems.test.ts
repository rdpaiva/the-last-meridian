/**
 * Mothership subsystem + station-powered shield tests (strategic layer;
 * docs/strategic-layer-plan.md, redesigned 2026-07-18):
 *
 *  - station-powered shields: Mothership.stationShieldFactor is written each
 *    tick by StrategicSystem from owned-station counts — graduated
 *    1 → stations.shield.minFactor with owned/total, factor 1 on
 *    station-free maps (the anti-stall guarantee: never 0);
 *  - shield edge events: shieldsOnline on a faction's first owned station,
 *    shieldsDown on losing the last, re-firing across re-flips, silent on
 *    station-free maps;
 *  - hangar effect: Ship.respawnDelayScale stretches shouldRespawn, and the
 *    BattleSim death-latch applies it faction-wide when the hangar falls.
 *
 * GameConfig is a mutable process-wide singleton — tests that write
 * stations.placements restore in afterEach.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import {
  BattleSim,
  GameConfig,
  Mothership,
  NetworkController,
  NEUTRAL_INPUT,
  type Faction,
  type MothershipSubsystem,
} from "../../shared/src/index";

const savedPlacements = GameConfig.stations.placements;

afterEach(() => {
  GameConfig.stations.placements = savedPlacements;
});

const DT = 1 / 60;

function makeCarrier(): Mothership {
  return new Mothership(new Vector3(0, 0, -400), 0, "humans");
}

function killSubsystem(sub: MothershipSubsystem): void {
  sub.takeDamage(sub.maxHp, 0);
}

/** A BattleSim with `placements` stations and one idle humans ship seated. */
function makeSim(placements: Array<{ xFrac: number; zFrac: number }>) {
  GameConfig.stations.placements = placements;
  const net = new NetworkController();
  net.setInput(NEUTRAL_INPUT);
  BattleSim.seedRng(11);
  const sim = new BattleSim();
  const ship = sim.spawnShip("humans", GameConfig.shipTypes.spitfire, {
    respawnDelayMs: 1000,
  });
  sim.addCombatant({ ship, controller: net });
  sim.start();
  return { sim, ship };
}

const THREE_STATIONS = [
  { xFrac: -0.5, zFrac: 0 },
  { xFrac: 0, zFrac: 0 },
  { xFrac: 0.5, zFrac: 0 },
];

describe("mothership subsystems (hangar)", () => {
  it("builds the configured subsystems: 1 hangar, own HP pool, no shields", () => {
    const ms = makeCarrier();
    const hangars = ms.subsystems.filter((s) => s.kind === "hangar");
    expect(hangars.length).toBe(1);
    expect(ms.subsystems.length).toBe(1);
    expect(ms.hangarAlive).toBe(true);
    // A fresh carrier is UNSHIELDED (no station power yet).
    expect(ms.stationShieldFactor).toBe(1);
    expect(ms.shieldsUp).toBe(false);
    // Subsystem damage is its own pool — the carrier hull must not move.
    const hullBefore = ms.hp;
    hangars[0].takeDamage(50, 0);
    expect(hangars[0].hp).toBe(hangars[0].maxHp - 50);
    expect(ms.hp).toBe(hullBefore);
    // And with factor 1, hull damage lands in full.
    ms.takeDamage(100, 0);
    expect(ms.hp).toBeCloseTo(hullBefore - 100, 6);
  });

  it("stretches a ship's respawn clock by respawnDelayScale", () => {
    BattleSim.seedRng(11);
    const sim = new BattleSim();
    const ship = sim.spawnShip("humans", GameConfig.shipTypes.spitfire, {
      respawnDelayMs: 1000,
    });
    ship.takeDamage(ship.maxHp, 0); // dies at t=0
    expect(ship.shouldRespawn(1000)).toBe(true);

    const ship2 = sim.spawnShip("humans", GameConfig.shipTypes.spitfire, {
      respawnDelayMs: 1000,
    });
    ship2.respawnDelayScale = 2.5;
    ship2.takeDamage(ship2.maxHp, 0);
    expect(ship2.shouldRespawn(1000)).toBe(false);
    expect(ship2.shouldRespawn(2499)).toBe(false);
    expect(ship2.shouldRespawn(2500)).toBe(true);
  });

  it("BattleSim latches the hangar death: event fires once, faction slows", () => {
    const { sim, ship } = makeSim([]);
    const destroyed: string[] = [];
    sim.events.on("subsystemDestroyed", ({ mothership, subsystem }) => {
      destroyed.push(`${mothership.faction}:${subsystem.kind}`);
    });

    const humans = sim.motherships.humans;
    const hangar = humans.subsystems.find((s) => s.kind === "hangar")!;
    killSubsystem(hangar);
    sim.advance(DT);
    expect(destroyed).toEqual(["humans:hangar"]);
    sim.advance(DT);
    expect(destroyed).toEqual(["humans:hangar"]); // latched
    expect(humans.hangarAlive).toBe(false);
    expect(ship.respawnDelayScale).toBe(
      GameConfig.mothership.subsystems.hangar.destroyedRespawnDelayScale,
    );
  });
});

describe("station-powered carrier shields", () => {
  it("graduates the hull damage factor with owned/total stations", () => {
    const { sim } = makeSim(THREE_STATIONS);
    const stations = sim.strategic.stations;
    const humans = sim.motherships.humans;
    const machines = sim.motherships.machines;
    const minFactor = GameConfig.stations.shield.minFactor;

    const expectFactor = (owned: number) =>
      owned === 0 ? 1 : 1 - (1 - minFactor) * (owned / 3);

    for (let owned = 0; owned <= 3; owned++) {
      for (let i = 0; i < stations.length; i++) {
        stations[i].owner = i < owned ? "humans" : null;
      }
      sim.advance(DT);
      expect(humans.stationShieldFactor).toBeCloseTo(expectFactor(owned), 6);
      // The other side owns nothing — always fully exposed.
      expect(machines.stationShieldFactor).toBe(1);
      // And takeDamage actually scales by the factor.
      const before = humans.hp;
      humans.takeDamage(100, 0);
      expect(humans.hp).toBeCloseTo(before - 100 * expectFactor(owned), 6);
    }
    // All stations held = the configured floor exactly (never 0).
    expect(humans.stationShieldFactor).toBeCloseTo(minFactor, 6);
    expect(minFactor).toBeGreaterThan(0);
  });

  it("station-free maps leave both carriers permanently unshielded", () => {
    const { sim } = makeSim([]);
    for (let i = 0; i < 120; i++) sim.advance(DT);
    expect(sim.motherships.humans.stationShieldFactor).toBe(1);
    expect(sim.motherships.machines.stationShieldFactor).toBe(1);
    expect(sim.motherships.humans.shieldsUp).toBe(false);
  });

  it("emits shieldsOnline/shieldsDown on the 0↔≥1 owned-station edges", () => {
    const { sim } = makeSim(THREE_STATIONS);
    const stations = sim.strategic.stations;
    const online: Faction[] = [];
    const down: Faction[] = [];
    sim.events.on("shieldsOnline", ({ faction }) => online.push(faction));
    sim.events.on("shieldsDown", ({ faction }) => down.push(faction));

    // First station: one shieldsOnline, no re-fire while more are gained.
    stations[0].owner = "humans";
    sim.advance(DT);
    expect(online).toEqual(["humans"]);
    stations[1].owner = "humans";
    sim.advance(DT);
    expect(online).toEqual(["humans"]);
    expect(down).toEqual([]);

    // Losing SOME power is silent; losing the LAST station fires shieldsDown.
    stations[1].owner = null;
    sim.advance(DT);
    expect(down).toEqual([]);
    stations[0].owner = null;
    sim.advance(DT);
    expect(down).toEqual(["humans"]);

    // Re-capturing from zero announces again.
    stations[2].owner = "humans";
    sim.advance(DT);
    expect(online).toEqual(["humans", "humans"]);
  });

  it("stays silent on station-free maps", () => {
    const { sim } = makeSim([]);
    let events = 0;
    sim.events.on("shieldsOnline", () => events++);
    sim.events.on("shieldsDown", () => events++);
    for (let i = 0; i < 120; i++) sim.advance(DT);
    expect(events).toBe(0);
  });
});
