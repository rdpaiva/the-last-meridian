import { GameConfig } from "./GameConfig";
import { clamp, exponentialDecay, wrapAngle } from "./math";
import type { InputState } from "./types";
import type { Ship } from "./Ship";
import type { ShipController, ControllerWorld } from "./ShipController";

/**
 * A standing order for a computer pilot. Assigned once at spawn (Phase 5: the
 * player's wingmen carry orders; in a future multiplayer build the wing would
 * re-issue these dynamically). The default, "patrol", is the original enemy
 * fighter behavior — so enemy fighters are just AIControllers with no options.
 */
export type AIOrder =
  /** Wander toward the objective mothership; engage opponents that come into range. */
  | "patrol"
  /** Press the enemy mothership and fire on it; engage fighters only in close self-defense. */
  | "strike"
  /** Seek & destroy: always chase the nearest enemy fighter, ignore the carrier. */
  | "hunt"
  /** Escort the leader in a slot; break to engage threats near the leader, reform. */
  | "cover"
  /** Hold the slot on the leader's wing; fire only at targets in the cone. */
  | "formation";

export interface AIControllerOptions {
  /** Standing order (default "patrol" = original enemy fighter behavior). */
  order?: AIOrder;
  /** Formation slot in leader-local units (+x starboard, +z ahead). cover/formation. */
  slot?: { x: number; z: number };
}

/** A thing this controller can aim its guns at (a Ship or a Mothership). */
interface AimTarget {
  position: { x: number; z: number };
}

/**
 * Computer pilot. Emits an `InputState` the shared `Ship` sim consumes (the same
 * code path that drives the human pilot), so AI and human ships are one sim.
 *
 * Each order resolves, each frame, to a heading to steer toward + thrust/reverse/
 * strafe + an optional aim target; a shared tail turns those into button presses.
 * Formation/cover keeps the nose on the leader's heading and slides into the slot
 * with the strafe + reverse thrusters under a damped PD — it does NOT turn to
 * chase the slot, since turning-to-chase makes a fast ship orbit the leader.
 */
export class AIController implements ShipController {
  /** Reused each frame so the render loop stays allocation-free. */
  private readonly out: InputState = {
    thrust: false,
    reverse: false,
    rotateLeft: false,
    rotateRight: false,
    strafeLeft: false,
    strafeRight: false,
    fire: false,
    fireMissile: false,
    zoomIn: false,
    zoomOut: false,
  };

  /** Deadband (rad) around the target heading where we stop turning. */
  private static readonly STEER_DEADBAND = 0.05;

  private readonly order: AIOrder;
  private readonly slot: { x: number; z: number };

  private wanderTargetHeading = Math.random() * Math.PI * 2;
  private wanderTimerSec = 0;
  /**
   * A lagged copy of the leader's heading the wingman flies its formation off,
   * so it banks into the leader's turns a beat LATE (like a real wingman) instead
   * of snapping in lock-step. Eases toward leader.rotationY at formationTurnLag.
   */
  private laggedHeading: number | null = null;

  constructor(opts: AIControllerOptions = {}) {
    this.order = opts.order ?? "patrol";
    this.slot = opts.slot ?? { x: 0, z: 0 };
  }

  update(deltaSeconds: number, self: Ship, world: ControllerWorld): InputState {
    const out = this.out;
    out.rotateLeft = false;
    out.rotateRight = false;
    out.thrust = false;
    out.reverse = false;
    out.strafeLeft = false;
    out.strafeRight = false;
    out.fire = false;
    // missile/zoom stay false for AI.

    if (!self.isAlive) return out;

    const cfg = GameConfig.ai;

    // Per-order plan. Most orders set a heading to steer toward + thrust + an aim
    // target; the formation station-keeper additionally drives strafe/reverse.
    let steerHeading = self.rotationY;
    let thrust = true;
    let reverse = false;
    let strafeDir = 0; // -1 = left, +1 = right
    let aim: AimTarget | null = null;
    let fireRange = cfg.fireRange;

    switch (this.order) {
      case "strike": {
        const close = this.nearestLiveOpponent(self, world, cfg.fireRange);
        if (close) {
          steerHeading = this.headingTo(self, close.position.x, close.position.z);
          aim = close;
        } else if (world.opponentMothership) {
          const m = world.opponentMothership;
          steerHeading = this.headingTo(self, m.position.x, m.position.z);
          aim = m;
          // The carrier is huge — fire from its hit radius, not the fighter range,
          // so strikers strafe it from stand-off instead of ramming the hull.
          fireRange = m.hitRadius;
        } else {
          steerHeading = this.wander(deltaSeconds, self, world);
        }
        break;
      }

      case "hunt": {
        const prey = this.nearestLiveOpponent(self, world, Infinity);
        if (prey) {
          steerHeading = this.headingTo(self, prey.position.x, prey.position.z);
          aim = prey;
        } else if (world.leader && world.leader.isAlive) {
          steerHeading = this.headingTo(self, world.leader.position.x, world.leader.position.z);
        } else {
          steerHeading = this.wander(deltaSeconds, self, world);
        }
        break;
      }

      case "cover":
      case "formation": {
        const leader = world.leader;
        if (!leader || !leader.isAlive) {
          // No one to form on — fall back to the patrol behavior.
          steerHeading = this.patrol(deltaSeconds, self, world);
          aim = this.nearestLiveOpponent(self, world, cfg.engagementRange);
          break;
        }
        // "cover" breaks formation to engage a threat near the LEADER.
        const threat =
          this.order === "cover"
            ? this.nearestLiveOpponentToPoint(world, leader.position.x, leader.position.z, cfg.coverBreakRange)
            : null;
        if (threat) {
          steerHeading = this.headingTo(self, threat.position.x, threat.position.z);
          aim = threat;
          break;
        }
        // Lagged leader heading: the wingman reacts to the leader's turns a beat
        // late (real wingmen don't pivot in perfect sync). Both the slot's
        // orientation and the wingman's own facing follow this lagged value, so a
        // turn visibly ripples out to the wing instead of snapping together.
        if (this.laggedHeading === null) this.laggedHeading = leader.rotationY;
        this.laggedHeading = wrapAngle(
          this.laggedHeading +
            wrapAngle(leader.rotationY - this.laggedHeading) *
              exponentialDecay(cfg.formationTurnLag, deltaSeconds),
        );
        const hdg = this.laggedHeading;

        // World position of the formation slot (leader-local → world), using the
        // lagged heading so the slot swings around behind the leader's turn.
        const cosT = Math.cos(hdg);
        const sinT = Math.sin(hdg);
        const sx = leader.position.x + cosT * this.slot.x + sinT * this.slot.z;
        const sz = leader.position.z - sinT * this.slot.x + cosT * this.slot.z;

        // --- Velocity-servo station-keeping with thrust/reverse/strafe (no
        // turning-to-chase, which orbits). Target velocity = leader's velocity +
        // a speed-capped approach toward the slot. We then fire whichever
        // thrusters reduce the velocity error, projected onto the ship's own
        // axes. Strafe cancels sideways drift directly (kills the orbit); the
        // approach cap keeps closing speed brakeable so it doesn't overshoot.
        let apX = cfg.formationPosGain * (sx - self.position.x);
        let apZ = cfg.formationPosGain * (sz - self.position.z);
        const apMag = Math.hypot(apX, apZ);
        if (apMag > cfg.formationApproachSpeed) {
          const sclamp = cfg.formationApproachSpeed / apMag;
          apX *= sclamp;
          apZ *= sclamp;
        }
        // Velocity error = (leader vel + approach) − own vel.
        const evX = leader.velocity.x + apX - self.velocity.x;
        const evZ = leader.velocity.z + apZ - self.velocity.z;
        const fwd = self.forward();
        const rgt = self.right();
        const eFwd = evX * fwd.x + evZ * fwd.z;
        const eRgt = evX * rgt.x + evZ * rgt.z;
        const dead = cfg.formationVelDeadband;
        thrust = eFwd > dead;
        reverse = eFwd < -dead;
        strafeDir = eRgt > dead ? 1 : eRgt < -dead ? -1 : 0;
        steerHeading = hdg; // lagged leader heading — banks into turns late
        // Opportunistic fire: take the shot if an opponent is in the cone.
        aim = this.nearestLiveOpponent(self, world, Infinity);
        break;
      }

      case "patrol":
      default: {
        steerHeading = this.patrol(deltaSeconds, self, world);
        aim = this.nearestLiveOpponent(self, world, cfg.engagementRange);
        break;
      }
    }

    // --- Shared tail: turn the plan into button presses. ---
    const headingDiff = wrapAngle(steerHeading - self.rotationY);
    if (headingDiff > AIController.STEER_DEADBAND) {
      out.rotateRight = true;
    } else if (headingDiff < -AIController.STEER_DEADBAND) {
      out.rotateLeft = true;
    }
    out.thrust = thrust;
    out.reverse = reverse;
    out.strafeLeft = strafeDir < 0;
    out.strafeRight = strafeDir > 0;

    if (aim) {
      const dx = aim.position.x - self.position.x;
      const dz = aim.position.z - self.position.z;
      const dist = Math.hypot(dx, dz);
      const angle = Math.atan2(dx, dz); // matches forward convention
      if (dist < fireRange && Math.abs(wrapAngle(angle - self.rotationY)) < cfg.fireConeAngle) {
        out.fire = true; // Ship.fireCooldownMs paces the actual shots.
      }
    }

    return out;
  }

  /** Heading (radians) from `self` toward a world point, in the +Z-forward convention. */
  private headingTo(self: Ship, x: number, z: number): number {
    return Math.atan2(x - self.position.x, z - self.position.z);
  }

  /**
   * Patrol: engage the nearest opponent inside engagementRange, else wander
   * (leashed toward the objective mothership). Returns the heading to steer.
   */
  private patrol(deltaSeconds: number, self: Ship, world: ControllerWorld): number {
    const target = this.nearestLiveOpponent(self, world, GameConfig.ai.engagementRange);
    if (target) return this.headingTo(self, target.position.x, target.position.z);
    return this.wander(deltaSeconds, self, world);
  }

  private nearestLiveOpponent(self: Ship, world: ControllerWorld, maxRange: number): Ship | null {
    let best: Ship | null = null;
    let bestDistSq = maxRange * maxRange;
    for (const o of world.opponents) {
      if (!o.isAlive) continue;
      const dx = o.position.x - self.position.x;
      const dz = o.position.z - self.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = o;
      }
    }
    return best;
  }

  /** Nearest live opponent within `maxRange` of an arbitrary point (e.g. the leader). */
  private nearestLiveOpponentToPoint(
    world: ControllerWorld,
    px: number,
    pz: number,
    maxRange: number,
  ): Ship | null {
    let best: Ship | null = null;
    let bestDistSq = maxRange * maxRange;
    for (const o of world.opponents) {
      if (!o.isAlive) continue;
      const dx = o.position.x - px;
      const dz = o.position.z - pz;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = o;
      }
    }
    return best;
  }

  /** Advance the wander timer and return the current leashed wander heading. */
  private wander(deltaSeconds: number, self: Ship, world: ControllerWorld): number {
    this.wanderTimerSec -= deltaSeconds;
    if (this.wanderTimerSec <= 0) this.retargetWander(self, world);
    return this.wanderTargetHeading;
  }

  /**
   * Picks a new wander heading with leash-bias plus jitter. The leash anchor is
   * the fighter's objective — its opponent mothership — so idle fighters press
   * toward the enemy carrier instead of milling at world center. With the arena
   * unbounded this bias (not a wall) is what keeps fighters in the fight: the
   * further a fighter strays from the anchor, the harder its heading is pulled
   * back toward it.
   */
  private retargetWander(self: Ship, world: ControllerWorld): void {
    const cfg = GameConfig.ai;
    const anchorX = world.opponentMothership?.position.x ?? 0;
    const anchorZ = world.opponentMothership?.position.z ?? 0;
    const dx = anchorX - self.position.x;
    const dz = anchorZ - self.position.z;
    const angleToAnchor = Math.atan2(dx, dz); // matches forward convention
    const distFromAnchor = Math.hypot(dx, dz);
    const leashPull = clamp(distFromAnchor / cfg.leashRadius, 0, 1) * cfg.leashBias;

    const jitter = (Math.random() * 2 - 1) * cfg.wanderJitter;
    const naiveTarget = self.rotationY + jitter;
    this.wanderTargetHeading = wrapAngle(
      naiveTarget * (1 - leashPull) + angleToAnchor * leashPull,
    );

    this.wanderTimerSec = cfg.wanderRetargetSec * (0.6 + Math.random() * 0.8);
  }
}
