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
  | "formation"
  /** Loiter near the friendly mothership; intercept any enemy that enters defendRadius. */
  | "defend";

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
  /**
   * Where a `hunt` wingman loiters when it has no prey: its configured slot if
   * it has one, else a default station trailing the leader. Station-keeping on
   * THIS (with the same servo formation uses) is what makes an idle hunter sit
   * behind the leader and hold, instead of charging the leader's exact position
   * at full thrust and looping back past it (the old no-prey "ram + orbit").
   */
  private readonly escortSlot: { x: number; z: number };
  /**
   * Scratch output of `stationKeep`, reused each frame so the servo stays
   * allocation-free. Both the formation/cover orders and the hunt loiter fill
   * it, then copy its fields into the per-frame control locals.
   */
  private readonly formationCmd = {
    steerHeading: 0,
    thrust: false,
    reverse: false,
    strafeDir: 0,
  };

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
    // A configured slot doubles as the hunt loiter station; with no slot, fall
    // back to a default position trailing the leader so the hunter sits BEHIND
    // it rather than on top of it.
    this.escortSlot =
      this.slot.x !== 0 || this.slot.z !== 0
        ? this.slot
        : { x: 0, z: -GameConfig.ai.huntEscortDistance };
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

    // Some orders must re-plan every frame: formation/cover run a velocity servo
    // (freezing it breaks stability), and hunt runs that same servo when it
    // loiters on the leader (escorting a moving leader needs a fresh heading each
    // frame, and chasing prey every frame suits a dedicated hunter). The rest
    // (patrol/strike) re-evaluate heading + target only on the reaction timer so
    // they have realistic lag instead of perfect-reflex tracking.
    const perFrame =
      this.order === "cover" || this.order === "formation" || this.order === "hunt" || this.order === "defend";
    let useCachedPlan = false;
    if (!perFrame) {
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
        const prey = this.nearestLiveOpponent(self, world, Infinity);
        if (prey) {
          steerHeading = this.headingTo(self, prey.position.x, prey.position.z);
          aim = prey;
        } else if (world.leader && world.leader.isAlive) {
          // No prey: loiter on the leader with the formation servo instead of
          // charging its position and looping back. Station-keep on the escort
          // slot (trailing the leader) so it eases into place and HOLDS there,
          // braking as needed, until a target shows up.
          const cmd = this.formationCmd;
          this.stationKeep(
            deltaSeconds, self, world.leader, this.escortSlot.x, this.escortSlot.z, cmd,
          );
          steerHeading = cmd.steerHeading;
          thrust = cmd.thrust;
          reverse = cmd.reverse;
          strafeDir = cmd.strafeDir;
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
        // Hold the slot with the station-keeping servo, then take any shot of
        // opportunity.
        const cmd = this.formationCmd;
        this.stationKeep(deltaSeconds, self, leader, this.slot.x, this.slot.z, cmd);
        steerHeading = cmd.steerHeading;
        thrust = cmd.thrust;
        reverse = cmd.reverse;
        strafeDir = cmd.strafeDir;
        aim = this.nearestLiveOpponent(self, world, Infinity);
        break;
      }

      case "defend": {
        const home = world.homeMothership;
        const homeX = home?.position.x ?? 0;
        const homeZ = home?.position.z ?? 0;
        // Intercept any enemy inside the defense perimeter around the home carrier.
        const intruder = this.nearestLiveOpponentToPoint(world, homeX, homeZ, cfg.defendRadius);
        if (intruder) {
          steerHeading = this.headingTo(self, intruder.position.x, intruder.position.z);
          aim = intruder;
        } else {
          const distFromHome = Math.hypot(
            self.position.x - homeX,
            self.position.z - homeZ,
          );
          if (distFromHome > cfg.defendOrbitRadius) {
            // Drifted too far — head straight back to the carrier.
            steerHeading = this.headingTo(self, homeX, homeZ);
          } else {
            // Within orbit — wander freely, leashed to home.
            steerHeading = this.wander(deltaSeconds, self, world, homeX, homeZ);
          }
        }
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
    if (!perFrame) {
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
   * Station-keeping servo: fly `self` to a slot defined relative to `leader`'s
   * smoothed COURSE (not its facing), matching the leader's velocity, and write
   * the resulting heading + thruster commands into `cmd`. Shared by the
   * formation/cover orders and the hunt order's no-prey loiter (which passes its
   * escort slot). MUST be called every frame: it low-passes the leader's
   * velocity and runs Schmitt-gated jets that both need continuity.
   *
   * The wing rides the leader's SMOOTHED velocity, not its raw velocity: a
   * hand-flown leader holding a line thrusts while tapping its nose, so the raw
   * velocity wobbles; matching that would make wingmen at their speed limit chase
   * the wobble and weave. The slot is placed by the leader's course (smoothed
   * velocity direction), NOT its facing, so a nose-swing with no course change
   * doesn't whip the slot sideways. The nose steers by the leader's PATH; the
   * slot-approach is a POSITION correction handled by the thrusters (a
   * translation), only blended into the heading as the wingman gets far from its
   * slot so it still turns nose-first to fly up to formation.
   */
  private stationKeep(
    deltaSeconds: number,
    self: Ship,
    leader: Ship,
    slotX: number,
    slotZ: number,
    cmd: { steerHeading: number; thrust: boolean; reverse: boolean; strafeDir: number },
  ): void {
    const cfg = GameConfig.ai;

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

    // Slot in world space, oriented by the leader's COURSE (falling back to its
    // facing only when it's too slow for velocity to define a direction).
    const leaderSpeed = Math.hypot(lvX, lvZ);
    const course =
      leaderSpeed > cfg.formationHeadingMinSpeed
        ? Math.atan2(lvX, lvZ)
        : leader.rotationY;
    const cosT = Math.cos(course);
    const sinT = Math.sin(course);
    const sx = leader.position.x + cosT * slotX + sinT * slotZ;
    const sz = leader.position.z - sinT * slotX + cosT * slotZ;
    const slotDist = Math.hypot(sx - self.position.x, sz - self.position.z);

    // Desired velocity = leader's (smoothed) velocity + a speed-capped approach
    // toward the slot (a P-controller on slot position). The approach shrinks to
    // zero at the slot, so it eases in instead of barrelling through, and the cap
    // stays under the reverse thruster's authority so closing speed is brakeable.
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

    // Heading: steer by the leader's PATH, blending in the slot-approach only as
    // the wingman gets far from its slot (so it still turns nose-first to fly up
    // to formation); parked in the slot the nose tracks only the smooth path.
    const headWeight = clamp(slotDist / cfg.formationHeadingBlendRange, 0, 1);
    const hvX = lvX + apX * headWeight;
    const hvZ = lvZ + apZ * headWeight;
    if (Math.hypot(hvX, hvZ) > cfg.formationHeadingMinSpeed) {
      cmd.steerHeading = Math.atan2(hvX, hvZ);
    } else {
      // Near-stationary leader: path direction is ill-defined, hold heading.
      cmd.steerHeading = self.rotationY;
    }

    // Drive the thrusters to close the velocity error, projected onto the ship's
    // own axes, each gated through a Schmitt trigger so a stable slot doesn't
    // chatter. Forward thrust/reverse only fire when the nose is roughly on the
    // desired-velocity direction; while still turning to line up the wingman
    // coasts. Strafe trims small cross-track error at any time.
    const evX = dvX - self.velocity.x;
    const evZ = dvZ - self.velocity.z;
    const fwd = self.forward();
    const rgt = self.right();
    const eFwd = evX * fwd.x + evZ * fwd.z;
    const eRgt = evX * rgt.x + evZ * rgt.z;
    const aligned =
      Math.abs(wrapAngle(cmd.steerHeading - self.rotationY)) < cfg.formationThrustConeAngle;
    this.prevFwdCmd = aligned
      ? AIController.schmitt(eFwd, this.prevFwdCmd, cfg.formationVelDeadband, cfg.formationVelEngageBand)
      : 0;
    this.prevLatCmd = AIController.schmitt(
      eRgt, this.prevLatCmd, cfg.formationVelDeadband, cfg.formationVelEngageBand,
    );
    cmd.thrust = this.prevFwdCmd > 0;
    cmd.reverse = this.prevFwdCmd < 0;
    cmd.strafeDir = this.prevLatCmd;
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
  private wander(
    deltaSeconds: number,
    self: Ship,
    world: ControllerWorld,
    anchorX = world.opponentMothership?.position.x ?? 0,
    anchorZ = world.opponentMothership?.position.z ?? 0,
  ): number {
    this.wanderTimerSec -= deltaSeconds;
    if (this.wanderTimerSec <= 0) this.retargetWander(self, anchorX, anchorZ);
    return this.wanderTargetHeading;
  }

  /**
   * Picks a new wander heading with leash-bias plus jitter. The leash anchor
   * is caller-supplied: patrol/strike use the opponent mothership so idle
   * fighters press toward the enemy carrier; defend uses the home mothership
   * so defenders orbit their own carrier.
   */
  private retargetWander(self: Ship, anchorX: number, anchorZ: number): void {
    const cfg = GameConfig.ai;
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
