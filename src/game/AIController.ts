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
 * Formation/cover follows the leader's PATH, not its nose: it computes the
 * velocity it needs (the leader's velocity plus an approach toward its slot),
 * points where that velocity is going, and flies there like a pilot. A turn the
 * leader makes without changing course therefore does NOT drag the wing around —
 * the wing only banks when the leader's actual travel direction changes.
 */
export class AIController implements ShipController {
  /** Reused each frame so the render loop stays allocation-free. */
  private readonly out: InputState = {
    thrust: false,
    reverse: false,
    rotateLeft: false,
    rotateRight: false,
    turn: 0,
    strafeLeft: false,
    strafeRight: false,
    fire: false,
    fireMissile: false,
    zoomIn: false,
    zoomOut: false,
  };

  private readonly order: AIOrder;
  private readonly slot: { x: number; z: number };

  private wanderTargetHeading = Math.random() * Math.PI * 2;
  private wanderTimerSec = 0;
  /**
   * Last frame's station-keeping jet commands (-1 / 0 / +1), kept so the
   * Schmitt trigger in the formation servo has a previous state to latch
   * against. prevFwdCmd drives thrust(+)/reverse(-); prevLatCmd drives strafe.
   */
  private prevFwdCmd = 0;
  private prevLatCmd = 0;

  // Reaction timer — non-formation orders re-evaluate heading + target only
  // when this reaches zero. Staggered per-ship so pilots don't all think on
  // the same frame. Formation/cover are exempt (servo needs per-frame updates).
  private reactionTimer = Math.random() * 0.2;
  private planHeading: number = Math.random() * Math.PI * 2;
  private planAimX = 0;
  private planAimZ = 0;
  private planHasAim = false;
  private planFireRange = 0;
  /**
   * Low-passed copy of the leader's velocity that formation flies off, so the
   * wing rides the leader's SMOOTHED path instead of reproducing every twitch of
   * a hand-flown stick. Without it, a player holding a line at speed (thrusting
   * while tapping the nose left/right) makes the raw velocity — and so the
   * course-placed slot — wobble, and wingmen at their speed limit chase the
   * wobble and weave. Eased toward leader.velocity at formationCourseSmooth.
   */
  private smoothVelX = 0;
  private smoothVelZ = 0;
  private smoothVelInit = false;

  constructor(opts: AIControllerOptions = {}) {
    this.order = opts.order ?? "patrol";
    this.slot = opts.slot ?? { x: 0, z: 0 };
  }

  update(deltaSeconds: number, self: Ship, world: ControllerWorld): InputState {
    const out = this.out;
    out.rotateLeft = false;
    out.rotateRight = false;
    out.turn = 0;
    out.thrust = false;
    out.reverse = false;
    out.strafeLeft = false;
    out.strafeRight = false;
    out.fire = false;
    // missile/zoom stay false for AI.

    if (!self.isAlive) return out;

    const cfg = GameConfig.ai;

    // Formation orders run their velocity servo every frame (freezing it breaks
    // stability). All other orders re-evaluate heading + target only on the
    // reaction timer so pilots have realistic lag instead of perfect-reflex tracking.
    const isFormation = this.order === "cover" || this.order === "formation";
    let useCachedPlan = false;
    if (!isFormation) {
      this.reactionTimer -= deltaSeconds;
      useCachedPlan = this.reactionTimer > 0;
    }

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
        if (!useCachedPlan) {
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
        }
        break;
      }

      case "hunt": {
        if (!useCachedPlan) {
          const prey = this.nearestLiveOpponent(self, world, Infinity);
          if (prey) {
            steerHeading = this.headingTo(self, prey.position.x, prey.position.z);
            aim = prey;
          } else if (world.leader && world.leader.isAlive) {
            steerHeading = this.headingTo(self, world.leader.position.x, world.leader.position.z);
          } else {
            steerHeading = this.wander(deltaSeconds, self, world);
          }
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
        // The whole formation rides the leader's SMOOTHED velocity, not its raw
        // velocity. A hand-flown leader holding a line at speed thrusts while
        // tapping its nose, so the raw velocity wobbles; if the slot (and the
        // matched velocity) tracked that, wingmen at their speed limit would
        // chase the wobble and weave. The low-pass makes them follow the average
        // path — like a real wingman ignoring your twitches — at the cost of a
        // slight, natural reaction lag.
        const k = exponentialDecay(cfg.formationCourseSmooth, deltaSeconds);
        if (!this.smoothVelInit) {
          this.smoothVelX = leader.velocity.x;
          this.smoothVelZ = leader.velocity.z;
          this.smoothVelInit = true;
        }
        this.smoothVelX += (leader.velocity.x - this.smoothVelX) * k;
        this.smoothVelZ += (leader.velocity.z - this.smoothVelZ) * k;
        const lvX = this.smoothVelX;
        const lvZ = this.smoothVelZ;

        // Formation slot in world space, oriented by the leader's COURSE (its
        // smoothed velocity direction) — NOT its facing. The geometry is
        // leader-relative (+x starboard, +z ahead), but it must ride the leader's
        // PATH: if the slot tracked the leader's facing, then swinging the nose
        // WITHOUT changing course (e.g. the small heading corrections you make to
        // hold a straight line) would whip the slots sideways and send the whole
        // wing scrambling to chase them — that nose-coupled slot swing is the
        // "shake at certain angles while following". Falling back to facing only
        // when the leader is too slow for its velocity to define a direction.
        const leaderSpeed = Math.hypot(lvX, lvZ);
        const course =
          leaderSpeed > cfg.formationHeadingMinSpeed
            ? Math.atan2(lvX, lvZ)
            : leader.rotationY;
        const cosT = Math.cos(course);
        const sinT = Math.sin(course);
        const sx = leader.position.x + cosT * this.slot.x + sinT * this.slot.z;
        const sz = leader.position.z - sinT * this.slot.x + cosT * this.slot.z;
        const slotDist = Math.hypot(sx - self.position.x, sz - self.position.z);

        // Desired velocity = match the leader's (smoothed) velocity + a
        // speed-capped approach toward the slot (a P-controller on slot
        // position). The approach shrinks to zero as the wingman reaches the
        // slot, so it eases in instead of barrelling through, and the cap stays
        // under the reverse thruster's authority so any closing speed is brakeable.
        let apX = cfg.formationPosGain * (sx - self.position.x);
        let apZ = cfg.formationPosGain * (sz - self.position.z);
        const apMag = Math.hypot(apX, apZ);
        if (apMag > cfg.formationApproachSpeed) {
          const sclamp = cfg.formationApproachSpeed / apMag;
          apX *= sclamp;
          apZ *= sclamp;
        }
        const dvX = lvX + apX; // desired velocity (world) — for the servo
        const dvZ = lvZ + apZ;

        // Heading: steer by the leader's PATH (its velocity), NOT by the desired
        // velocity. The slot-approach term is a POSITION correction — a job for
        // the thrusters (a translation), not the nose. Feeding it into the
        // heading is what made a wingman that was slightly off-slot yaw back and
        // forth: the correction tilts the aim point, it turns, overshoots, the
        // error flips, and with zero drag nothing damps the cycle. So we only
        // blend the slot-approach into the heading as the wingman gets FAR from
        // its slot (so it still turns to fly nose-first up to formation); parked
        // in the slot the weight is ~0 and the nose tracks only the smooth path.
        const headWeight = clamp(slotDist / cfg.formationHeadingBlendRange, 0, 1);
        const hvX = lvX + apX * headWeight;
        const hvZ = lvZ + apZ * headWeight;
        const hvMag = Math.hypot(hvX, hvZ);
        if (hvMag > cfg.formationHeadingMinSpeed) {
          steerHeading = Math.atan2(hvX, hvZ);
        } else {
          // Near-stationary leader: path direction is ill-defined, hold heading.
          steerHeading = self.rotationY;
        }

        // Drive the thrusters to close the velocity error, projected onto the
        // ship's own axes, each gated through a SCHMITT TRIGGER (cross the larger
        // engage band to light a jet, stays lit until the error falls back under
        // the smaller release band) so a stable slot doesn't chatter. Forward
        // thrust/reverse only fire when the nose is roughly on the desired-
        // velocity direction; while the wingman is still turning to line up it
        // coasts rather than thrusting (or braking) off-course. Strafe trims
        // small cross-track error at any time.
        const evX = dvX - self.velocity.x;
        const evZ = dvZ - self.velocity.z;
        const fwd = self.forward();
        const rgt = self.right();
        const eFwd = evX * fwd.x + evZ * fwd.z;
        const eRgt = evX * rgt.x + evZ * rgt.z;
        const aligned =
          Math.abs(wrapAngle(steerHeading - self.rotationY)) < cfg.formationThrustConeAngle;
        this.prevFwdCmd = aligned
          ? AIController.schmitt(eFwd, this.prevFwdCmd, cfg.formationVelDeadband, cfg.formationVelEngageBand)
          : 0;
        this.prevLatCmd = AIController.schmitt(
          eRgt, this.prevLatCmd, cfg.formationVelDeadband, cfg.formationVelEngageBand,
        );
        thrust = this.prevFwdCmd > 0;
        reverse = this.prevFwdCmd < 0;
        strafeDir = this.prevLatCmd;
        // Opportunistic fire: take the shot if an opponent is in the cone.
        aim = this.nearestLiveOpponent(self, world, Infinity);
        break;
      }

      case "patrol":
      default: {
        if (!useCachedPlan) {
          steerHeading = this.patrol(deltaSeconds, self, world);
          aim = this.nearestLiveOpponent(self, world, cfg.engagementRange);
        }
        break;
      }
    }

    // Cache plan after a fresh think; restore it on stale frames.
    if (!isFormation) {
      if (!useCachedPlan) {
        this.planHeading = steerHeading;
        this.planHasAim = aim !== null;
        if (aim) { this.planAimX = aim.position.x; this.planAimZ = aim.position.z; }
        this.planFireRange = fireRange;
        this.reactionTimer = cfg.reactionSec * (0.85 + Math.random() * 0.3);
      } else {
        steerHeading = this.planHeading;
        aim = this.planHasAim ? { position: { x: this.planAimX, z: this.planAimZ } } : null;
        fireRange = this.planFireRange;
      }
    }

    // --- Shared tail: turn the plan into button presses. ---
    // Steer the nose with PROPORTIONAL control (an analog turn rate), not
    // bang-bang keys. The rate saturates to full beyond steerBand of error and
    // eases linearly to zero as the nose lines up, so the pilot decelerates
    // INTO its target heading and tracks a moving one smoothly — instead of
    // snapping to it at full rate, stopping, and stepping again (the "clock
    // hands" turn). A thin deadband around zero stops a tracked heading from
    // inducing a permanent micro-jitter; inside it the nose just holds.
    const headingDiff = wrapAngle(steerHeading - self.rotationY);
    if (Math.abs(headingDiff) > cfg.steerDeadband) {
      out.turn = clamp(headingDiff / cfg.steerBand, -1, 1);
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
   * Schmitt trigger for one thruster axis. Given the signed error `e`, the
   * previous command `prev` (-1/0/+1), a small `releaseBand` and a larger
   * `engageBand`: a jet only LIGHTS once |e| exceeds engageBand, then stays lit
   * until |e| drops back under releaseBand. The gap between the two bands is the
   * hysteresis that kills the every-few-frames chatter a plain deadband produces.
   */
  private static schmitt(
    e: number,
    prev: number,
    releaseBand: number,
    engageBand: number,
  ): number {
    if (prev > 0) return e > releaseBand ? 1 : 0;
    if (prev < 0) return e < -releaseBand ? -1 : 0;
    return e > engageBand ? 1 : e < -engageBand ? -1 : 0;
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
