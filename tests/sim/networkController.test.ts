/**
 * Unit proof of the NetworkController → Ship seam, isolated from the network
 * (docs/MULTIPLAYER.md Phase 1). A ship wearing a NetworkController must fly the
 * input pushed into it — this is the server side of "the player is just a Ship
 * wearing a controller". Deterministic: a lone friendly ship, no enemies, so it
 * can't die mid-test.
 */
import { describe, it, expect } from "vitest";

import {
  BattleSim,
  NetworkController,
  NEUTRAL_INPUT,
  GameConfig,
} from "../../shared/src/index";

const angleDelta = (a: number, b: number): number =>
  Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Build a lone-ship sim and advance it clear of the launch catapult. */
function launchedShip(net: NetworkController) {
  BattleSim.seedRng(7);
  const sim = new BattleSim();
  const ship = sim.spawnShip("humans", GameConfig.shipTypes.spitfire, {
    respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
  });
  const combatant = sim.addCombatant({ ship, controller: net });
  sim.start();
  // Cap must cover launch.mpHoldSec (the no-cinematic-seat hold) + catapult
  // travel + handback ease; the loop exits early the moment the launch clears.
  for (let i = 0; i < 900 && combatant.launch; i++) sim.advance(1 / 60);
  expect(combatant.launch, "ship never cleared the launch tube").toBeNull();
  ship.debugInvulnerable = true; // ignore stray carrier-turret fire
  return { sim, ship };
}

describe("NetworkController → Ship", () => {
  it("turns the ship under held rotateRight, and not under neutral input", () => {
    const net = new NetworkController();
    const { sim, ship } = launchedShip(net);

    // Neutral: the ship must hold its heading (nothing else drives it).
    net.setInput(NEUTRAL_INPUT);
    const idle0 = ship.rotationY;
    for (let i = 0; i < 20; i++) sim.advance(1 / 60);
    expect(Math.abs(angleDelta(idle0, ship.rotationY))).toBeLessThan(0.001);

    // Held rotateRight: rotationY increases (CLAUDE.md: rotate right → +).
    const r0 = ship.rotationY;
    net.setInput({ ...NEUTRAL_INPUT, rotateRight: true });
    for (let i = 0; i < 30; i++) sim.advance(1 / 60);
    expect(angleDelta(r0, ship.rotationY)).toBeGreaterThan(0.3);
  });

  it("consumes jumpPressed as a one-shot edge", () => {
    const net = new NetworkController();
    net.setInput({ ...NEUTRAL_INPUT, jumpPressed: true });
    expect(net.update().jumpPressed).toBe(true); // first read sees the edge
    expect(net.update().jumpPressed).toBe(false); // cleared thereafter
  });
});
