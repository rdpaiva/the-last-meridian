/**
 * Projectile tunneling regression (found in a 2026-07-08 multiplayer
 * playtest: missiles flew straight through opposing players and looped back
 * for another pass).
 *
 * The sim invariant under test: weapon collision must sweep BOTH bodies'
 * per-tick paths (the projectile's a→b AND the target's c→d — closest
 * approach of the relative segment, math.ts sweptClosestT). Two historical
 * failure modes, both fixed here and pinned by this suite:
 *
 *   1. Point test at the projectile's new position (missiles): at the 30Hz
 *      SERVER tick a head-on pass closes ~2.4 u/tick against a fighter's
 *      2.0-unit capture diameter — dead-center shots skip clean across the
 *      circle between samples. Tunneling is governed by RELATIVE closing
 *      speed, so tail-chase-heavy solo play at 60Hz never showed it.
 *   2. Sweeping only the projectile while pinning the target at its
 *      end-of-tick point (lasers): throws away targetSpeed * dt (~0.9u at
 *      30Hz — comparable to the whole hit radius), which still ghosts
 *      grazing hits.
 *
 * ORACLE: each tick, after the system updates, densely sample the ACTUAL
 * linear motion of both bodies across the tick and measure their true
 * closest approach. Any tick where the true paths came inside the hit
 * radius but the sim registered nothing is a ghosted hit — the exact bug.
 * The oracle reads the projectile's real per-tick endpoints, so missile
 * homing (heading re-derived at each tick start) needs no re-derivation
 * here: within one tick every body moves in a straight line.
 *
 * Run config matters: HZ = 30 mirrors BattleRoom's SIM_HZ. If that constant
 * changes, change it here too — the invariant must hold at the sim's OWN
 * tick rate, not the renderer's.
 */

import { describe, it, expect } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../../shared/src/GameConfig";
import { MissileSystem } from "../../shared/src/sim/MissileSystem";
import { LaserSystem } from "../../shared/src/sim/LaserSystem";
import { seedSimRng } from "../../shared/src/sim/SimRng";
import type { DamageTarget } from "../../shared/src/types";

/** BattleRoom's SIM_HZ — the authoritative tick rate the invariant must hold at. */
const SERVER_HZ = 30;
/** Slack for the oracle's dense sampling vs. the sim's exact segment math. */
const TOL = 5e-3;

/** A fighter-like target flying a straight line (worst-case: toward the shot). */
class MovingTarget implements DamageTarget {
  readonly position: Vector3;
  readonly velocity: Vector3;
  isAlive = true;

  constructor(
    x: number,
    z: number,
    vx: number,
    vz: number,
    readonly hitRadius: number,
  ) {
    this.position = new Vector3(x, 0, z);
    this.velocity = new Vector3(vx, 0, vz);
  }

  takeDamage(): void {
    // Stays alive so a homing round keeps tracking; the hit is observed
    // through the system's onHit callback instead.
  }

  /** One tick of straight flight — ships advance BEFORE weapons (BattleSim). */
  advance(dt: number): void {
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
  }

  /** Mirror Ship.jumpTeleport/respawn: position snaps, velocity ZEROES. */
  teleport(x: number, z: number): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
  }
}

/**
 * True (continuous-time) closest approach of two bodies moving linearly
 * across one tick, by dense sampling — deliberately NOT the sim's segment
 * math, so it can't share a bug with the code under test.
 */
function trueMinDistOverTick(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): number {
  const N = 256;
  let min = Infinity;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const mx = ax + (bx - ax) * s;
    const mz = az + (bz - az) * s;
    const tx = cx + (dx - cx) * s;
    const tz = cz + (dz - cz) * s;
    const d = Math.hypot(mx - tx, mz - tz);
    if (d < min) min = d;
  }
  return min;
}

/** Distance from a point to a segment (independent test-local impl). */
function distPointToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  let t = lenSq > 0 ? ((px - ax) * abx + (pz - az) * abz) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

interface RunResult {
  /** Impact position reported through onHit, or null if nothing ever hit. */
  impact: Vector3 | null;
  /** Ticks where the TRUE paths touched but the sim registered no hit. */
  ghostTicks: number[];
  /** Projectile tick-start position at the hit tick (contact sanity check). */
  hitFrom: { x: number; z: number } | null;
  /** Target path across the hit tick (contact sanity check). */
  hitTargetSeg: { ax: number; az: number; bx: number; bz: number } | null;
}

/** Drive one projectile against one straight-flying target to resolution. */
function runScenario(opts: {
  weapon: "missile" | "laser";
  hz: number;
  /** Projectile launch point; fired along +Z (rotationY = 0). */
  start: { x: number; z: number };
  target: MovingTarget;
  /** Missiles only: launch with a lock on the target (homing). */
  locked?: boolean;
  /** Called between ticks (tick index) — teleport hook. */
  beforeTick?: (tick: number) => void;
}): RunResult {
  seedSimRng(0xbeef);
  const dt = 1 / opts.hz;
  const rec: { impact: Vector3 | null } = { impact: null };
  const onHitPos = (p: Vector3) => {
    rec.impact = p.clone();
  };

  let system: MissileSystem | LaserSystem;
  if (opts.weapon === "missile") {
    const sys = new MissileSystem({
      minDamage: 10,
      maxDamage: 10,
      onHit: onHitPos,
    });
    sys.addTarget(opts.target);
    sys.spawn(
      new Vector3(opts.start.x, 0, opts.start.z),
      0,
      opts.locked ? opts.target : null,
    );
    system = sys;
  } else {
    const sys = new LaserSystem({
      damage: 10,
      onHit: (_target, _shooter, p) => onHitPos(p),
    });
    sys.addTarget(opts.target);
    sys.spawn(new Vector3(opts.start.x, 0, opts.start.z), 0);
    system = sys;
  }
  const liveRound = () =>
    opts.weapon === "missile"
      ? (system as MissileSystem).rounds[0]
      : (system as LaserSystem).bolts[0];

  const result: RunResult = {
    impact: null,
    ghostTicks: [],
    hitFrom: null,
    hitTargetSeg: null,
  };
  // 3200ms missile motor at 30Hz is 96 ticks; 400 is a generous stall guard.
  for (let tick = 0; tick < 400 && system.count > 0; tick++) {
    opts.beforeTick?.(tick);
    const tAx = opts.target.position.x;
    const tAz = opts.target.position.z;
    opts.target.advance(dt); // ships move first — the BattleSim tick order
    const round = liveRound();
    const ax = round.position.x;
    const az = round.position.z;
    system.update(dt, dt * 1000, tick * dt * 1000);
    if (rec.impact) {
      result.impact = rec.impact;
      result.hitFrom = { x: ax, z: az };
      result.hitTargetSeg = {
        ax: tAx,
        az: tAz,
        bx: opts.target.position.x,
        bz: opts.target.position.z,
      };
      break;
    }
    if (system.count === 0) break; // expired (motor burnout / bolt lifetime)
    const minD = trueMinDistOverTick(
      ax,
      az,
      round.position.x,
      round.position.z,
      tAx,
      tAz,
      opts.target.position.x,
      opts.target.position.z,
    );
    if (minD < opts.target.hitRadius - TOL) result.ghostTicks.push(tick);
  }
  return result;
}

/** Wraith-like worst case: lightest hull, fastest straight-line closure. */
const TARGET_SPEED = 27;
const HIT_RADIUS = 1.0;

/** One full tick of head-on relative closure — sweeping the launch
 *  separation across it covers every tick-phase alignment. */
function phaseSpan(projectileSpeed: number, hz: number): number {
  return (projectileSpeed + TARGET_SPEED) / hz;
}

function assertScenarioHonest(r: RunResult, label: string): void {
  expect(
    r.ghostTicks,
    `${label}: true paths crossed the hit radius on tick(s) ` +
      `${r.ghostTicks.join(", ")} but the sim registered no hit (tunneling)`,
  ).toEqual([]);
  if (r.impact && r.hitTargetSeg && r.hitFrom) {
    // Contact discipline: the reported impact must sit on/inside the target's
    // circle somewhere along the target's path this tick — not past the ship
    // ("explosion pops behind it"), not somewhere unrelated (phantom hit).
    const d = distPointToSegment(
      r.impact.x,
      r.impact.z,
      r.hitTargetSeg.ax,
      r.hitTargetSeg.az,
      r.hitTargetSeg.bx,
      r.hitTargetSeg.bz,
    );
    expect(
      d,
      `${label}: impact reported ${d.toFixed(3)}u from the target's path — ` +
        `outside its ${HIT_RADIUS}u hit radius`,
    ).toBeLessThanOrEqual(HIT_RADIUS + TOL);
  }
}

describe("projectile tunneling (both-body swept collision)", () => {
  it("missiles: head-on joust at the 30Hz server tick hits at EVERY phase", () => {
    const speed = GameConfig.missile.speed;
    const span = phaseSpan(speed, SERVER_HZ);
    for (let i = 0; i < 24; i++) {
      const sep = 9 + (span * i) / 24;
      const label = `missile joust, 30Hz, sep ${sep.toFixed(3)}`;
      const r = runScenario({
        weapon: "missile",
        hz: SERVER_HZ,
        start: { x: 0, z: 0 },
        target: new MovingTarget(0, sep, 0, -TARGET_SPEED, HIT_RADIUS),
        locked: true,
      });
      assertScenarioHonest(r, label);
      expect(r.impact, `${label}: dead-center homing shot never hit`).not.toBeNull();
    }
  });

  it("missiles: grazing offsets stay honest (hit or miss matches true paths)", () => {
    const speed = GameConfig.missile.speed;
    const span = phaseSpan(speed, SERVER_HZ);
    for (const offset of [0.5, 0.9, 1.3]) {
      for (let i = 0; i < 12; i++) {
        const sep = 9 + (span * i) / 12;
        const r = runScenario({
          weapon: "missile",
          hz: SERVER_HZ,
          start: { x: offset, z: 0 },
          target: new MovingTarget(0, sep, 0, -TARGET_SPEED, HIT_RADIUS),
          locked: true,
        });
        assertScenarioHonest(
          r,
          `missile graze, offset ${offset}, sep ${sep.toFixed(3)}`,
        );
      }
    }
  });

  it("missiles: the invariant holds at 60Hz too (rate-independent)", () => {
    const speed = GameConfig.missile.speed;
    const span = phaseSpan(speed, 60);
    for (let i = 0; i < 12; i++) {
      const sep = 9 + (span * i) / 12;
      const label = `missile joust, 60Hz, sep ${sep.toFixed(3)}`;
      const r = runScenario({
        weapon: "missile",
        hz: 60,
        start: { x: 0, z: 0 },
        target: new MovingTarget(0, sep, 0, -TARGET_SPEED, HIT_RADIUS),
        locked: true,
      });
      assertScenarioHonest(r, label);
      expect(r.impact, `${label}: dead-center homing shot never hit`).not.toBeNull();
    }
  });

  it("lasers: head-on and grazing shots at 30Hz account for the TARGET's motion", () => {
    const speed = GameConfig.laser.speed;
    const span = phaseSpan(speed, SERVER_HZ);
    for (const offset of [0, 0.5, 0.9]) {
      for (let i = 0; i < 16; i++) {
        const sep = 12 + (span * i) / 16;
        const label = `laser, offset ${offset}, 30Hz, sep ${sep.toFixed(3)}`;
        const r = runScenario({
          weapon: "laser",
          hz: SERVER_HZ,
          start: { x: offset, z: 0 },
          target: new MovingTarget(0, sep, 0, -TARGET_SPEED, HIT_RADIUS),
        });
        assertScenarioHonest(r, label);
        if (offset === 0) {
          expect(r.impact, `${label}: dead-center bolt never hit`).not.toBeNull();
        }
      }
    }
  });

  it("lasers: a clearly wide shot never phantom-hits", () => {
    const r = runScenario({
      weapon: "laser",
      hz: SERVER_HZ,
      start: { x: 3, z: 0 },
      target: new MovingTarget(0, 20, 0, -TARGET_SPEED, HIT_RADIUS),
    });
    expect(r.ghostTicks).toEqual([]);
    expect(r.impact, "bolt passing 3u wide of a 1u target hit it").toBeNull();
  });

  it("teleports don't smear a phantom hitbox across the arena", () => {
    // A homing missile chases a target up the +Z axis; mid-flight the target
    // jump-teleports from ahead of the missile to far behind it — the jump
    // LINE crosses the missile. Velocity zeroes on teleport (Ship semantics),
    // so the tick-start reconstruction must collapse to a point: no hit may
    // register on the teleport tick. (A cached-previous-position sweep would
    // detonate the round on the phantom segment — the failure mode this pins.)
    const target = new MovingTarget(0, 40, 0, -5, HIT_RADIUS);
    let teleported = false;
    const r = runScenario({
      weapon: "missile",
      hz: SERVER_HZ,
      start: { x: 0, z: 0 },
      target,
      locked: true,
      beforeTick: (tick) => {
        // Missile flies +Z at 45 u/s: by tick 12 it's near z≈17, target near
        // z≈38 — comfortably apart. Jump the target 90 units to its rear,
        // straight across the missile's nose.
        if (tick === 12 && !teleported) {
          teleported = true;
          target.teleport(0, -50);
        }
      },
    });
    expect(teleported).toBe(true);
    // The missile may legitimately loop around and catch the target later —
    // what must NOT happen is a hit ON the teleport tick, when the two bodies
    // were never within radius. The oracle covers every tick including that
    // one: any phantom would surface as an impact with no true contact.
    assertScenarioHonest(r, "teleport tick");
    if (r.impact) {
      // A later legitimate hit must be AT the target's new home, not on the
      // phantom jump line between z≈17 and z≈38.
      expect(
        Math.hypot(r.impact.x - 0, r.impact.z - -50),
        "impact landed on the teleport line, not at the target",
      ).toBeLessThanOrEqual(HIT_RADIUS + TOL);
    }
  });
});
