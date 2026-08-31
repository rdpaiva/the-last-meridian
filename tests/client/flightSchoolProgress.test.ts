import { describe, expect, it } from "vitest";
import type { InputState } from "@space-duel/shared";
import { FlightSchoolProgress } from "../../client/src/game/FlightSchoolProgress";

const input = (patch: Partial<InputState> = {}): InputState => ({
  thrust: false,
  reverse: false,
  rotateLeft: false,
  rotateRight: false,
  turn: 0,
  strafeLeft: false,
  strafeRight: false,
  fire: false,
  fireMissile: false,
  jumpPressed: false,
  zoomIn: false,
  zoomOut: false,
  ...patch,
});

function finishFlight(p: FlightSchoolProgress): void {
  p.updateFlight(input({ thrust: true }), 12, 0);
  p.updateFlight(input({ rotateRight: true }), 12, 0.6);
  p.updateFlight(input({ rotateRight: true }), 12, 1.2);
  p.updateFlight(input({ strafeRight: true }), 12, 1.2);
}

describe("FlightSchoolProgress", () => {
  it("requires thrust, a meaningful controlled turn, and strafe", () => {
    const p = new FlightSchoolProgress();
    p.updateFlight(input({ thrust: true }), 2, 0);
    p.updateFlight(input(), 12, 1.5); // uncontrolled rotation does not count
    p.updateFlight(input({ strafeLeft: true }), 12, 1.5);

    expect(p.lesson).toBe("flight");
    expect(p.flight).toEqual({ thrust: false, turn: false, strafe: true });

    finishFlight(p);
    expect(p.lesson).toBe("guns");
  });

  it("only advances weapons lessons for the real target and a real lock", () => {
    const p = new FlightSchoolProgress();
    finishFlight(p);

    p.recordLaserHit(false);
    expect(p.lesson).toBe("guns");
    p.recordLaserHit(true);
    expect(p.lesson).toBe("missile");

    p.recordMissileLaunch(false);
    expect(p.lesson).toBe("missile");
    p.recordMissileLaunch(true);
    expect(p.lesson).toBe("missile");
    expect(p.missileLaunched).toBe(true);
    p.recordMissileHit(false);
    expect(p.lesson).toBe("missile");
    p.recordMissileHit(true);
    expect(p.lesson).toBe("docking");
  });

  it("requires active servicing before a fully docked state", () => {
    const p = new FlightSchoolProgress();
    finishFlight(p);
    p.recordLaserHit(true);
    p.recordMissileLaunch(true);
    p.recordMissileHit(true);

    p.updateDocking("docked");
    expect(p.lesson).toBe("docking");
    p.updateDocking("servicing");
    p.updateDocking("docked");
    expect(p.lesson).toBe("jump");

    p.recordJumpFired();
    expect(p.lesson).toBe("complete");
  });
});
