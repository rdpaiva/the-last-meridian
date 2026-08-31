import { describe, expect, it } from "vitest";

import { GameConfig, Ship } from "../../shared/src/index";

function makeShip(): Ship {
  const type = GameConfig.shipTypes.spitfire;
  return new Ship({
    faction: "humans",
    maxHp: type.maxHp,
    respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
    startMissileAmmo: type.missileAmmo,
    startCannonAmmo: type.cannonAmmo,
    movement: type,
    hitRadius: type.hitRadius,
    fireSound: type.fireSound,
  });
}

describe("jump-drive cooldown feedback", () => {
  it("reports a denied re-arm with the remaining recharge time", () => {
    const ship = makeShip();

    expect(ship.onJumpIntent()).toBe("spool-started");
    ship.tickJump(1);
    expect(ship.onJumpIntent()).toBe("spool-cancelled");
    expect(ship.jumpCooldownRemainingMs).toBe(GameConfig.jump.cooldownMs);
    expect(ship.onJumpIntent()).toBe("cooldown-denied");

    ship.tickJump(GameConfig.jump.cooldownMs / 1000);
    expect(ship.jumpCooldownRemainingMs).toBe(0);
    expect(ship.onJumpIntent()).toBe("spool-started");
  });
});
