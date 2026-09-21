import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { BattleSim, GameConfig, Mothership, NetworkController, type Faction } from "@space-duel/shared";
import { CameraRig } from "../../client/src/game/CameraRig";
import { OpeningLaunchCamera } from "../../client/src/game/OpeningLaunchCamera";

const engines: NullEngine[] = [];
afterEach(() => {
  engines.splice(0).forEach(e => e.dispose());
  vi.unstubAllGlobals();
});

function rigFor(flipped = false, width = 1600, height = 900) {
  const engine = new NullEngine({ renderWidth: width, renderHeight: height, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
  engines.push(engine);
  return new CameraRig(new Scene(engine), flipped);
}

function advance(rig: CameraRig, seconds: number, position = Vector3.Zero(), hz = 60) {
  for (let i = 0; i < Math.round(seconds * hz); i++) rig.update(1 / hz, position, Vector3.Zero(), 0);
}

describe("opening launch camera", () => {
  it.each(["humans", "machines"] as Faction[])("waits for the entire %s catapult roster, then returns to normal tracking", faction => {
    BattleSim.seedRng(7);
    const sim = new BattleSim();
    const home = sim.motherships[faction];
    const roster = Array.from({ length: 7 }, (_, i) => {
      const type = GameConfig.factionShips[faction][i === 6 ? 1 : 0];
      const ship = sim.spawnShip(faction, GameConfig.shipTypes[type], { respawnDelayMs: 5000 });
      return sim.addCombatant({ ship, controller: new NetworkController(), cinematic: i === 0 });
    });
    sim.start();
    const rig = rigFor(faction === "machines");
    const normal = rigFor(faction === "machines");
    const shot = new OpeningLaunchCamera(rig, home, roster.map(c => ({
      bayIndex: c.bayIndex, isFinished: () => c.launch === null,
    })));
    let sawPlayerClearBeforeWing = false;
    for (let frame = 0; frame < 1200; frame++) {
      sim.advance(1 / 60);
      shot.update();
      const player = roster[0].ship;
      rig.update(1 / 60, player.position, player.velocity, 0);
      normal.update(1 / 60, player.position, player.velocity, 0);
      if (!roster[0].launch && roster.some(c => c.launch !== null)) {
        sawPlayerClearBeforeWing = true;
        expect(shot.active).toBe(true);
        expect(rig.camera.position.y).toBeLessThan(35);
      }
    }
    expect(sawPlayerClearBeforeWing).toBe(true);
    expect(shot.active).toBe(false);
    expect(Vector3.Distance(rig.camera.position, normal.camera.position)).toBeLessThan(0.001);
    expect(Vector3.Distance(rig.camera.getTarget(), normal.camera.getTarget())).toBeLessThan(0.001);
  });

  it("moves from the first frame, independent of frame rate, with no jump when the return starts", () => {
    const home = new Mothership(Vector3.Zero(), 0, "humans");
    let finished = false;
    const rigs = [rigFor(), rigFor()];
    const shots = rigs.map(rig => new OpeningLaunchCamera(rig, home, [{ bayIndex: 0, isFinished: () => finished }]));
    const start = rigs[0].camera.position.clone();
    advance(rigs[0], 1 / 60);
    expect(Vector3.Distance(start, rigs[0].camera.position)).toBeGreaterThan(0.005);
    advance(rigs[0], 5 - 1 / 60);
    advance(rigs[1], 5, Vector3.Zero(), 144);
    expect(Vector3.Distance(rigs[0].camera.position, rigs[1].camera.position)).toBeLessThan(0.001);
    const lastHold = rigs[0].camera.position.clone();
    finished = true;
    shots[0].update();
    advance(rigs[0], 1 / 60);
    expect(Vector3.Distance(lastHold, rigs[0].camera.position)).toBeLessThan(0.1);
  });

  it.each(["humans", "machines"] as Faction[])("keeps both %s bay mouths in a narrow window throughout the glide", faction => {
    const rig = rigFor(faction === "machines", 900, 1000);
    const home = new Mothership(Vector3.Zero(), faction === "machines" ? Math.PI : 0, faction);
    new OpeningLaunchCamera(rig, home, [0, 1].map(bayIndex => ({ bayIndex, isFinished: () => false })));
    for (let second = 0; second < 20; second++) {
      advance(rig, 1);
      const transform = rig.camera.getViewMatrix().multiply(rig.camera.getProjectionMatrix());
      for (const bayIndex of [0, 1]) {
        const mouth = home.getLaunchStartPosition(bayIndex);
        const forward = home.getLaunchForward();
        mouth.x += forward.x * GameConfig.camera.launchShot.bayMouthForward;
        mouth.z += forward.z * GameConfig.camera.launchShot.bayMouthForward;
        const screen = Vector3.Project(mouth, Matrix.Identity(), transform, new Viewport(0, 0, 900, 1000));
        expect(screen.x).toBeGreaterThan(45);
        expect(screen.x).toBeLessThan(855);
        expect(screen.y).toBeGreaterThan(50);
        expect(screen.y).toBeLessThan(950);
      }
    }
  });

  it.each(["humans", "machines"] as Faction[])("shows %s launches from a three-quarter angle", faction => {
    const rig = rigFor(faction === "machines");
    const home = new Mothership(Vector3.Zero(), faction === "machines" ? Math.PI : 0, faction);
    new OpeningLaunchCamera(rig, home, [{ bayIndex: 0, isFinished: () => false }]);

    const view = rig.camera.getTarget().subtract(rig.camera.position).normalize();
    const forward = home.getLaunchForward();
    const launch = new Vector3(forward.x, 0, forward.z).normalize();
    const angleFromLaunchAxis = Math.acos(Math.min(1, Math.abs(Vector3.Dot(view, launch))));

    // A near-axis view makes the fuselage disappear behind the wings and reads
    // as a squashed model. Keep at least 30 degrees of visible ship length.
    expect(angleFromLaunchAxis).toBeGreaterThan(Math.PI / 6);
  });

  it("preserves saved zoom, and completed members cannot extend the shot by respawning", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => "1.7", setItem });
    const rig = rigFor();
    const home = new Mothership(Vector3.Zero(), 0, "humans");
    const done = [false, false];
    const shot = new OpeningLaunchCamera(rig, home, done.map((_, i) => ({ bayIndex: 0, isFinished: () => done[i] })));
    done[0] = true;
    shot.update();
    done[0] = false; // a later launch must not re-add this finished member
    advance(rig, 30);
    expect(shot.active).toBe(true); // no fixed timeout cuts off the last ship
    rig.update(1 / 60, Vector3.Zero(), Vector3.Zero(), 1);
    expect(rig.currentZoom).toBe(1.7);
    expect(setItem).not.toHaveBeenCalled();
    done[1] = true;
    shot.update();
    advance(rig, GameConfig.camera.launchShot.returnDuration + 1);
    expect(shot.active).toBe(false);
    expect(rig.currentZoom).toBe(1.7);
    rig.update(1 / 60, Vector3.Zero(), Vector3.Zero(), 1);
    rig.update(1 / 60, Vector3.Zero(), Vector3.Zero(), 0);
    expect(rig.currentZoom).toBeLessThan(1.7);
    expect(setItem).toHaveBeenCalledOnce();
  });

  it("can cancel for death/end of match and does not start for an empty roster", () => {
    const rig = rigFor();
    const home = new Mothership(Vector3.Zero(), 0, "humans");
    expect(new OpeningLaunchCamera(rig, home, []).active).toBe(false);
    const shot = new OpeningLaunchCamera(rig, home, [{ bayIndex: 0, isFinished: () => false }]);
    shot.cancel();
    shot.update();
    expect(shot.active).toBe(false);
    rig.snapTo(Vector3.Zero());
    expect(rig.camera.position.y).toBeCloseTo(GameConfig.camera.offsetY * rig.currentZoom);
  });
});
