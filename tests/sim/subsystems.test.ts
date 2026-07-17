/**
 * Mothership subsystem tests (strategic layer M1 — destructible shield
 * generators + hangar, docs/ROADMAP.md):
 *
 *  - shield gate: while ANY generator lives, hull damage is multiplied by
 *    subsystems.shield.shieldedHullDamageFactor (nonzero on purpose — the
 *    anti-stall guarantee); with all generators down the hull takes full
 *    damage;
 *  - hangar effect: Ship.respawnDelayScale stretches shouldRespawn, and the
 *    BattleSim death-latch applies it faction-wide when a hangar falls;
 *  - events: subsystemDestroyed per subsystem, shieldsDown exactly once when
 *    the LAST generator dies.
 */
import { describe, it, expect } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import {
  BattleSim,
  GameConfig,
  Mothership,
  NetworkController,
  NEUTRAL_INPUT,
  type MothershipSubsystem,
} from "../../shared/src/index";

function makeCarrier(): Mothership {
  return new Mothership(new Vector3(0, 0, -400), 0, "humans");
}

function shieldsOf(ms: Mothership): MothershipSubsystem[] {
  return ms.subsystems.filter((s) => s.kind === "shield");
}

function killSubsystem(sub: MothershipSubsystem): void {
  sub.takeDamage(sub.maxHp, 0);
}

describe("mothership subsystems (shield generators + hangar)", () => {
  it("builds the configured subsystems: 2 shields + 1 hangar, own HP pools", () => {
    const ms = makeCarrier();
    const shields = shieldsOf(ms);
    const hangars = ms.subsystems.filter((s) => s.kind === "hangar");
    expect(shields.length).toBe(2);
    expect(hangars.length).toBe(1);
    expect(ms.shieldsUp).toBe(true);
    expect(ms.hangarAlive).toBe(true);
    // Subsystem damage is its own pool — the carrier hull must not move.
    const hullBefore = ms.hp;
    shields[0].takeDamage(50, 0);
    expect(shields[0].hp).toBe(shields[0].maxHp - 50);
    expect(ms.hp).toBe(hullBefore);
  });

  it("gates hull damage while any generator lives, full damage once all are down", () => {
    const ms = makeCarrier();
    const factor = GameConfig.mothership.subsystems.shield.shieldedHullDamageFactor;

    ms.takeDamage(100, 0);
    expect(ms.hp).toBeCloseTo(ms.maxHp - 100 * factor, 6);

    // One generator down: still shielded.
    const shields = shieldsOf(ms);
    killSubsystem(shields[0]);
    expect(ms.shieldsUp).toBe(true);
    const before = ms.hp;
    ms.takeDamage(100, 0);
    expect(ms.hp).toBeCloseTo(before - 100 * factor, 6);

    // Both down: the hull is exposed.
    killSubsystem(shields[1]);
    expect(ms.shieldsUp).toBe(false);
    const exposed = ms.hp;
    ms.takeDamage(100, 0);
    expect(ms.hp).toBeCloseTo(exposed - 100, 6);
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

  it("BattleSim latches subsystem deaths: events fire once, hangar slows the faction", () => {
    const net = new NetworkController();
    net.setInput(NEUTRAL_INPUT);
    BattleSim.seedRng(11);
    const sim = new BattleSim();
    const ship = sim.spawnShip("machines", GameConfig.shipTypes.wraith, {
      respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
    });
    sim.addCombatant({ ship, controller: net });

    const destroyed: string[] = [];
    let shieldsDownCount = 0;
    sim.events.on("subsystemDestroyed", ({ mothership, subsystem }) => {
      destroyed.push(`${mothership.faction}:${subsystem.kind}`);
    });
    sim.events.on("shieldsDown", ({ mothership }) => {
      expect(mothership.faction).toBe("machines");
      shieldsDownCount++;
    });

    sim.start();
    const machines = sim.motherships.machines;

    // First generator: one destroyed event, shields still up.
    killSubsystem(shieldsOf(machines)[0]);
    sim.advance(1 / 60);
    expect(destroyed).toEqual(["machines:shield"]);
    expect(shieldsDownCount).toBe(0);

    // Second generator: shieldsDown fires exactly once, and stays latched.
    killSubsystem(shieldsOf(machines)[1]);
    sim.advance(1 / 60);
    expect(destroyed).toEqual(["machines:shield", "machines:shield"]);
    expect(shieldsDownCount).toBe(1);
    sim.advance(1 / 60);
    expect(shieldsDownCount).toBe(1);

    // Hangar: destroyed event + faction-wide respawn slowdown.
    const hangar = machines.subsystems.find((s) => s.kind === "hangar")!;
    killSubsystem(hangar);
    sim.advance(1 / 60);
    expect(destroyed).toEqual([
      "machines:shield",
      "machines:shield",
      "machines:hangar",
    ]);
    expect(machines.hangarAlive).toBe(false);
    expect(ship.respawnDelayScale).toBe(
      GameConfig.mothership.subsystems.hangar.destroyedRespawnDelayScale,
    );
  });
});
