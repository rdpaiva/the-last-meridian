import { GameConfig } from "./GameConfig";
import { clamp, exponentialDecay, wrapAngle } from "./math";
// All AI decision randomness draws from the seeded SIM RNG, not Math.random():
// multiplayer needs the sim reproducible from a seed, and the headless smoke
// harness diffs battles against a committed baseline (docs/MULTIPLAYER.md).
import { simRandom } from "./sim/SimRng";
import type { InputState } from "./types";
import type { Ship } from "./sim/Ship";
import type { ShipController, ControllerWorld, AvoidObstacle } from "./ShipController";
import type { SensorContact } from "./SensorSystem";

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

/**
 * A thing this controller can aim its guns at (a sensor contact's last-known
 * position, or a Mothership). Note that for contacts this means an AI fires
 * at where its faction's sensors SAY the target is — a stale ghost draws fire
 * at empty space, which is exactly the point of breaking contact.
 */
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
    // Jump-out doctrine (Slice 6) sets this on its own frames; idle by default.
    jumpPressed: false,
    zoomIn: false,
    zoomOut: false,
  };

  /** Standing order. Mutable: the FleetCommander re-tasks pilots at runtime. */
  private order: AIOrder;
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
   * Scratch aim target for the strike order's carrier attack, reused each
   * think so targeting the hull stays allocation-free. Holds the nearest
   * point on the enemy carrier's hull boxes (not the carrier center).
   */
  private readonly carrierAim = { position: { x: 0, z: 0 } };
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

  /**
   * Avoidance scratch (reused each frame, render loop stays allocation-free):
   * threat* hold the most imminent rock found by the scanForThreat passes;
   * avoid* hold the escape maneuver avoidObstacles computed from it.
   */
  private threatRock: AvoidObstacle | null = null;
  private threatEdge = Infinity;
  private threatLateral = 0;
  private avoidSteerHeading = 0;
  private avoidStrafeDir = 0;

  private wanderTargetHeading = simRandom() * Math.PI * 2;
  private wanderTimerSec = 0;
  /**
   * Last frame's station-keeping jet commands (-1 / 0 / +1), kept so the
   * Schmitt trigger in the formation servo has a previous state to latch
   * against. prevFwdCmd drives thrust(+)/reverse(-); prevLatCmd drives strafe.
   */
  private prevFwdCmd = 0;
  private prevLatCmd = 0;

  /**
   * Per-pilot missile pacing (seconds until the next launch is allowed) —
   * the doctrine gate that makes a rack last a fight instead of dumping on
   * the first target (see GameConfig.ai "Missiles"). Seeded randomly so a
   * fleet's first volley staggers instead of firing in sync.
   */
  private missileTimerSec = simRandom() * GameConfig.ai.missileCooldownSec;
  /**
   * The real SHIP behind the contact this pilot just launched at, valid only
   * on a frame where the emitted InputState.fireMissile is true (null = the
   * launch is ballistic, e.g. a strike pilot rippling into the carrier hull).
   * Game reads this to spawn the homing missile — the AI equivalent of the
   * player's HUD lock. Only ever set from a FRESH sensor track, so it never
   * grants guidance the pilot's own sensors couldn't provide.
   */
  missileTarget: Ship | null = null;

  // Reaction timer — non-formation orders re-evaluate heading + target only
  // when this reaches zero. Staggered per-ship so pilots don't all think on
  // the same frame. Formation/cover are exempt (servo needs per-frame updates).
  private reactionTimer = simRandom() * 0.2;
  private planHeading: number = simRandom() * Math.PI * 2;
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

  /**
   * Last well-defined leader COURSE (rad), held while the leader is too slow
   * for velocity to define one. The slot frame rides this instead of snapping
   * to the leader's FACING at low speed: a slow leader pivoting in place (a
   * heavy gunship hovering to aim) would otherwise sweep the slots around
   * itself faster than a wingman can fly, sending the wing orbiting through
   * the leader's position. Holding the last course leaves the slots still
   * while the leader turns on the spot. Null until the first stationKeep.
   */
  private lastCourse: number | null = null;

  /**
   * Jump-out doctrine, rolled ONCE per pilot at spawn from the seeded sim RNG
   * (docs/JUMP-DRIVE-AND-RESUPPLY.md → AI jump-out doctrine). `caution` (0 =
   * berserker, 1 = timid) drives the HP threshold AND the survival-spool
   * personality. Drawn in the constructor body so the draw order is fixed and
   * identical in the browser and the headless harness.
   */
  private readonly caution: number;
  /** HP fraction at/below which this pilot commits to going home (from caution). */
  private readonly hpJumpFrac: number;
  /** Cannon-ammo fraction at/below which it commits to going home. */
  private readonly ammoJumpFrac: number;
  /** Latched once the pilot commits to RTB for service; released when serviced. */
  private retreating = false;

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

    const d = GameConfig.jump.doctrine;
    this.caution = simRandom();
    this.hpJumpFrac = d.hpFracMin + (d.hpFracMax - d.hpFracMin) * this.caution;
    this.ammoJumpFrac = d.ammoFrac;
  }

  /** The pilot's current standing order (FleetCommander reads before re-tasking). */
  get currentOrder(): AIOrder {
    return this.order;
  }

  /**
   * Re-task this pilot at runtime (used by the FleetCommander). Zeroes the
   * reaction timer so the new order takes hold on the next think, and clears
   * the station-keeping jet latches so a slot order re-engages cleanly
   * instead of resuming a stale Schmitt state.
   */
  setOrder(order: AIOrder): void {
    if (order === this.order) return;
    this.order = order;
    this.reactionTimer = 0;
    this.prevFwdCmd = 0;
    this.prevLatCmd = 0;
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
    out.fireMissile = false;
    out.jumpPressed = false;
    this.missileTarget = null;
    // zoom stays false for AI.

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
            // Press the NEAREST POINT on the carrier's hull boxes, not its
            // center — the hull is hundreds of units long, and center-seeking
            // flew strikers INTO the bow before they were "in range". Aiming
            // at the clamped surface point makes the fire gate (dist <
            // carrierFireStandoff) a distance-to-surface test, so a striker
            // opens up on approach and the avoidance pass (the carrier's
            // steering circles are obstacles) then peels it into a strafing
            // run along the hull instead of letting it ram or enter the model.
            let bestSq = Infinity;
            for (const s of world.opponentMothership.hullSections) {
              const px = clamp(self.position.x, s.minX, s.maxX);
              const pz = clamp(self.position.z, s.minZ, s.maxZ);
              const dx = px - self.position.x;
              const dz = pz - self.position.z;
              const dSq = dx * dx + dz * dz;
              if (dSq < bestSq) {
                bestSq = dSq;
                this.carrierAim.position.x = px;
                this.carrierAim.position.z = pz;
              }
            }
            steerHeading = this.headingTo(
              self,
              this.carrierAim.position.x,
              this.carrierAim.position.z,
            );
            aim = this.carrierAim;
            fireRange = cfg.carrierFireStandoff;
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
        this.reactionTimer = cfg.reactionSec * (0.85 + simRandom() * 0.3);
      } else {
        steerHeading = this.planHeading;
        aim = this.planHasAim ? { position: { x: this.planAimX, z: this.planAimZ } } : null;
        fireRange = this.planFireRange;
      }
    }

    // --- Jump-out doctrine (docs/JUMP-DRIVE-AND-RESUPPLY.md) ---
    // Commit to going home for service on low HP OR low ammo; arm the drive
    // when far (this frame's edge press), or dock when close. While retreating,
    // movement is overridden per personality (cautious flee / hotshot blaze);
    // otherwise, peel off to press a detected, spooling RUNNER.
    if (this.thinkRetreat(self, world)) {
      out.jumpPressed = true; // EDGE: arm the spool (never re-pressed mid-spool)
    }
    if (this.retreating) {
      const r = this.retreatMovement(self, world);
      if (r) {
        steerHeading = r.heading;
        thrust = r.thrust;
        reverse = r.reverse;
        strafeDir = r.strafeDir;
        aim = r.aim;
        fireRange = cfg.fireRange;
      }
      // r === null = a hotshot's blaze-of-glory spool: keep the attack plan.
    } else {
      const runner = this.nearestSpoolingOpponent(
        self,
        world,
        GameConfig.jump.doctrine.finishRunnerRange,
      );
      if (runner) {
        steerHeading = this.headingTo(self, runner.position.x, runner.position.z);
        aim = runner;
        thrust = true;
        reverse = false;
        strafeDir = 0;
        fireRange = cfg.fireRange;
      }
    }

    // Asteroid avoidance overrides every order's COMMANDS: a pilot about to
    // fly into a rock steers for the clearing tangent, thrusts along it, and
    // strafes away — then resumes its order once past. It must own the
    // thrusters, not just the nose: the formation/cover servo strafes the
    // ship toward its slot regardless of facing, so a heading-only override
    // lets the servo push a wingman sideways into a rock with its nose
    // politely pointed away. Runs per-frame AFTER the plan cache, so even the
    // slow-thinking orders (patrol/strike) never coast into a rock between
    // reaction ticks.
    if (this.avoidObstacles(self, world, steerHeading)) {
      steerHeading = this.avoidSteerHeading;
      thrust = true;
      reverse = false;
      strafeDir = this.avoidStrafeDir;
      // Reset the servo's jet latches so it re-decides cleanly after the dodge.
      this.prevFwdCmd = 0;
      this.prevLatCmd = 0;
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

    // --- Missiles (independent of the gun aim) ---
    // The launch decision re-scans the contacts itself rather than reusing
    // `aim`: gun aim points at last-known positions (including ghosts), but a
    // seeker is only worth a round when there's a live return to ride. All
    // doctrine gates live in findMissileShot/carrierMissileShot — see the
    // GameConfig.ai "Missiles" block for the full policy.
    this.missileTimerSec -= deltaSeconds;
    if (self.missileAmmo >= 1 && this.missileTimerSec <= 0) {
      const shot = this.findMissileShot(self, world);
      if (shot) {
        out.fireMissile = true;
        this.missileTarget = shot.ship;
        this.resetMissileTimer();
      } else if (this.order === "strike" && this.carrierMissileShot(self, world)) {
        // Ballistic ripple into the carrier hull — missileTarget stays null.
        out.fireMissile = true;
        this.resetMissileTimer();
      }
    }

    return out;
  }

  /** Re-arm the missile pacing timer with ±20% per-pilot jitter. */
  private resetMissileTimer(): void {
    this.missileTimerSec =
      GameConfig.ai.missileCooldownSec * (0.8 + simRandom() * 0.4);
  }

  /**
   * The contact this pilot would spend a missile on right now, or null. A
   * shot must pass every doctrine gate: FRESH track (a live sensor return —
   * ghosts and concealed ships never draw a missile), inside the launch
   * envelope (missileMinRange..missileMaxRange, within missileLaunchConeAngle
   * of the nose so the seeker starts on target), and a clear line of fire
   * (an asteroid would just eat the round). Nearest qualifying contact wins.
   */
  private findMissileShot(
    self: Ship,
    world: ControllerWorld,
  ): SensorContact | null {
    const cfg = GameConfig.ai;
    let best: SensorContact | null = null;
    let bestDist = Infinity;
    for (const o of world.opponents) {
      if (!o.isAlive || !o.fresh) continue;
      const dx = o.position.x - self.position.x;
      const dz = o.position.z - self.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < cfg.missileMinRange || dist > cfg.missileMaxRange || dist >= bestDist) {
        continue;
      }
      const angle = Math.atan2(dx, dz); // matches forward convention
      if (Math.abs(wrapAngle(angle - self.rotationY)) > cfg.missileLaunchConeAngle) {
        continue;
      }
      if (!this.lineOfFireClear(self, world, o.position.x, o.position.z)) {
        continue;
      }
      best = o;
      bestDist = dist;
    }
    return best;
  }

  /**
   * Should a strike pilot ripple a BALLISTIC missile into the enemy carrier
   * right now? Checks the same launch envelope as a fighter shot against the
   * nearest point on the carrier's hull boxes (the surface the strike order
   * already aims its guns at). No line-of-fire test: world.obstacles includes
   * the carrier's own (deliberately over-sized) avoidance circles, which
   * would always "block" a shot aimed at the hull inside them — and at
   * standoff range the path is short enough that an occasional round lost to
   * a drifting rock reads as battle noise, not waste.
   */
  private carrierMissileShot(self: Ship, world: ControllerWorld): boolean {
    const carrier = world.opponentMothership;
    if (!carrier || !carrier.isAlive) return false;
    const cfg = GameConfig.ai;

    let bestSq = Infinity;
    let aimX = 0;
    let aimZ = 0;
    for (const s of carrier.hullSections) {
      const px = clamp(self.position.x, s.minX, s.maxX);
      const pz = clamp(self.position.z, s.minZ, s.maxZ);
      const dx = px - self.position.x;
      const dz = pz - self.position.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestSq) {
        bestSq = dSq;
        aimX = px;
        aimZ = pz;
      }
    }
    const dist = Math.sqrt(bestSq);
    if (dist < cfg.missileMinRange || dist > cfg.missileMaxRange) return false;
    const angle = Math.atan2(aimX - self.position.x, aimZ - self.position.z);
    return Math.abs(wrapAngle(angle - self.rotationY)) <= cfg.missileLaunchConeAngle;
  }

  /**
   * True when the straight X/Z segment from `self` to the target point clears
   * every live asteroid's collision circle. Missiles detonate on rocks (cover
   * works against them like it does against lasers), so a pilot holds a shot
   * that would just feed a rock. Carrier avoidance circles also live in
   * world.obstacles — blocking on those is fine here, since a missile that
   * would cross a carrier's footprint to reach a fighter is a low-value shot
   * anyway.
   */
  private lineOfFireClear(
    self: Ship,
    world: ControllerWorld,
    tx: number,
    tz: number,
  ): boolean {
    const sx = self.position.x;
    const sz = self.position.z;
    const dx = tx - sx;
    const dz = tz - sz;
    const lenSq = dx * dx + dz * dz;
    for (const rock of world.obstacles) {
      if (!rock.isAlive) continue;
      const rx = rock.position.x - sx;
      const rz = rock.position.z - sz;
      // Closest point on the segment to the circle center.
      const t = lenSq > 0 ? clamp((rx * dx + rz * dz) / lenSq, 0, 1) : 0;
      const cx = rx - t * dx;
      const cz = rz - t * dz;
      if (cx * cx + cz * cz < rock.radius * rock.radius) return false;
    }
    return true;
  }

  /** Heading (radians) from `self` toward a world point, in the +Z-forward convention. */
  private headingTo(self: Ship, x: number, z: number): number {
    return Math.atan2(x - self.position.x, z - self.position.z);
  }

  /**
   * Steer around asteroids. Scans for the most imminent live rock whose
   * collision circle — inflated by the ship's radius + avoidMargin — straddles
   * either travel path within avoidLookahead:
   *
   *   - the INTENDED path (the order's steer heading), and
   *   - the ACTUAL velocity direction.
   *
   * The second scan is what saves servo-flown wingmen: holding formation they
   * strafe and coast in directions their nose never points, so a heading-only
   * scan is blind to a rock they're sliding into sideways.
   *
   * Returns true if a threat was found, with the escape written to
   * avoidSteerHeading (the tangent past the rock on the side it's already
   * offset from — the cheaper turn; saturates to a perpendicular break if
   * already inside the clearance circle) and avoidStrafeDir (jets away from
   * the rock relative to the ship's current facing).
   */
  private avoidObstacles(
    self: Ship,
    world: ControllerWorld,
    steerHeading: number,
  ): boolean {
    // Reset the shared threat scratch, then scan both travel directions.
    // (Reset lives in a helper so TS doesn't narrow threatRock to null here —
    // it can't see scanForThreat mutate the field.)
    this.resetThreatScan();
    // Intended path (+Z-forward convention: x = sin, z = cos).
    this.scanForThreat(self, world, Math.sin(steerHeading), Math.cos(steerHeading));
    const speed = Math.hypot(self.velocity.x, self.velocity.z);
    if (speed > 1) {
      this.scanForThreat(
        self, world, self.velocity.x / speed, self.velocity.z / speed,
      );
    }
    const threat = this.threatRock;
    if (!threat) return false;

    const cfg = GameConfig.ai;
    const dx = threat.position.x - self.position.x;
    const dz = threat.position.z - self.position.z;
    const dist = Math.hypot(dx, dz) || 1;
    const clear = threat.radius + self.hitRadius + cfg.avoidMargin;
    const angleToRock = Math.atan2(dx, dz);
    const offset = Math.asin(clamp(clear / dist, 0, 1));
    // Rock right of path → pass left (smaller heading); left → pass right.
    this.avoidSteerHeading = wrapAngle(
      this.threatLateral >= 0 ? angleToRock - offset : angleToRock + offset,
    );
    // Strafe away from the rock relative to current FACING (strafe jets are
    // body-relative): rock on the starboard side → strafe left, and vice versa.
    const rightX = Math.cos(self.rotationY);
    const rightZ = -Math.sin(self.rotationY);
    this.avoidStrafeDir = dx * rightX + dz * rightZ >= 0 ? -1 : 1;
    return true;
  }

  /** Clear the threat scratch before a fresh pair of avoidance scans. */
  private resetThreatScan(): void {
    this.threatRock = null;
    this.threatEdge = Infinity;
    this.threatLateral = 0;
  }

  /**
   * One avoidance scan along a unit direction: finds rocks whose clearance
   * circle straddles that path within avoidLookahead and keeps the one with
   * the nearest edge in the threat scratch fields (shared across the two
   * scans avoidObstacles runs, so the most imminent threat overall wins).
   */
  private scanForThreat(
    self: Ship,
    world: ControllerWorld,
    dirX: number,
    dirZ: number,
  ): void {
    const cfg = GameConfig.ai;
    for (const rock of world.obstacles) {
      if (!rock.isAlive) continue;
      const dx = rock.position.x - self.position.x;
      const dz = rock.position.z - self.position.z;
      const along = dx * dirX + dz * dirZ; // distance ahead along the path
      if (along <= 0) continue; // behind us — no threat
      const edge = along - rock.radius; // distance to the rock's near edge
      if (edge > cfg.avoidLookahead) continue; // too far ahead to care yet
      const clear = rock.radius + self.hitRadius + cfg.avoidMargin;
      const lateral = dx * dirZ - dz * dirX; // signed: rock right(+)/left(-)
      if (Math.abs(lateral) >= clear) continue; // path already clears it
      if (edge < this.threatEdge) {
        this.threatEdge = edge;
        this.threatRock = rock;
        this.threatLateral = lateral;
      }
    }
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

    // Slot in world space, oriented by the leader's COURSE. When the leader is
    // too slow for velocity to define a direction, HOLD the last course (see
    // the lastCourse field doc — snapping to the leader's facing here lets a
    // slow, pivoting leader whip the slots around itself). Before any course
    // exists (first frames out of the tube), seed from the leader's facing.
    const leaderSpeed = Math.hypot(lvX, lvZ);
    if (leaderSpeed > cfg.formationHeadingMinSpeed) {
      this.lastCourse = Math.atan2(lvX, lvZ);
    } else if (this.lastCourse === null) {
      this.lastCourse = leader.rotationY;
    }
    const course = this.lastCourse;
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

  private nearestLiveOpponent(
    self: Ship,
    world: ControllerWorld,
    maxRange: number,
  ): SensorContact | null {
    let best: SensorContact | null = null;
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

  /** Nearest live contact within `maxRange` of an arbitrary point (e.g. the leader). */
  private nearestLiveOpponentToPoint(
    world: ControllerWorld,
    px: number,
    pz: number,
    maxRange: number,
  ): SensorContact | null {
    let best: SensorContact | null = null;
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

  // ─── Jump-out doctrine ──────────────────────────────────────────────────────

  /**
   * Decide whether to commit to (or stay committed to) going home for service,
   * and whether to ARM a jump THIS frame. Trigger is OR — low HP *or* low ammo
   * — latched so a pilot doesn't flip-flop at the threshold (releases only once
   * serviced back up). Returns true on the single frame the drive should arm:
   * only when far from home (close ships dock instead) and the drive is idle +
   * off cooldown. Never returns true mid-spool (the AI commits, never cancels).
   */
  private thinkRetreat(self: Ship, world: ControllerWorld): boolean {
    const d = GameConfig.jump.doctrine;
    const hpFrac = self.hp / self.maxHp;
    const ammoFrac =
      self.maxCannonAmmo > 0 ? self.cannonAmmo / self.maxCannonAmmo : 1;

    if (!this.retreating) {
      if (hpFrac <= this.hpJumpFrac || ammoFrac <= this.ammoJumpFrac) {
        this.retreating = true;
      }
    } else if (hpFrac >= d.recoverHpFrac && ammoFrac >= d.recoverAmmoFrac) {
      this.retreating = false;
    }

    if (!this.retreating || self.isSpoolingJump) return false;
    const home = world.homeMothership;
    if (!home || !home.isAlive) return false;
    const dist = Math.hypot(
      self.position.x - home.position.x,
      self.position.z - home.position.z,
    );
    return (
      dist > d.dockRange && self.jumpState === "idle" && !self.isJumpOnCooldown
    );
  }

  /**
   * Movement override for a retreating pilot. Returns null to KEEP the normal
   * attack plan (a hotshot's blaze-of-glory spool). Otherwise:
   *   - close to home → DOCK: fly to the bow service bubble, brake to loiter so
   *     the carrier services it (the existing speed-gated refuel).
   *   - far + cautious → FLEE: full throttle away from the nearest threat,
   *     biased toward home, firing only opportunistically.
   */
  private retreatMovement(
    self: Ship,
    world: ControllerWorld,
  ): {
    heading: number;
    thrust: boolean;
    reverse: boolean;
    strafeDir: number;
    aim: AimTarget | null;
  } | null {
    const d = GameConfig.jump.doctrine;
    const home = world.homeMothership;
    if (!home || !home.isAlive) return null;

    // Opportunistic gun target — fire only if one happens to line up.
    const oppo = this.nearestLiveOpponent(self, world, GameConfig.ai.fireRange);

    const dist = Math.hypot(
      self.position.x - home.position.x,
      self.position.z - home.position.z,
    );

    if (dist <= d.dockRange) {
      // DOCK: steer for the bow bay (inside the service bubble, clear of the
      // hull center) and brake once there so the loiter gate refuels us.
      const bay = home.getLaunchStartPosition(0);
      const toBay = Math.hypot(
        self.position.x - bay.x,
        self.position.z - bay.z,
      );
      const inBubble = toBay <= GameConfig.service.radius * 0.6;
      return {
        heading: this.headingTo(self, bay.x, bay.z),
        thrust: !inBubble,
        reverse: inBubble && self.speed > GameConfig.service.loiterMaxSpeed,
        strafeDir: 0,
        aim: oppo,
      };
    }

    // FAR. A hotshot keeps swinging while it spools — leave the attack plan.
    const cautious = this.caution >= d.fleeCautionThreshold;
    if (self.isSpoolingJump && !cautious) return null;

    // Cautious flee (and the approach before the spool arms): break weapons
    // range, biased home toward open space.
    const threat = this.nearestLiveOpponent(self, world, Infinity);
    let heading: number;
    if (threat) {
      const awayH = Math.atan2(
        self.position.x - threat.position.x,
        self.position.z - threat.position.z,
      );
      const homeH = this.headingTo(self, home.position.x, home.position.z);
      heading = this.blendHeading(awayH, homeH, d.homeFleeBias);
    } else {
      heading = this.headingTo(self, home.position.x, home.position.z);
    }
    return { heading, thrust: true, reverse: false, strafeDir: 0, aim: oppo };
  }

  /**
   * Nearest DETECTED opponent that is spooling a jump within `maxRange` — the
   * "kill the runner" target. Only fresh tracks (the signature spike makes a
   * spooling ship visible even in a nebula, so this still works through cover).
   */
  private nearestSpoolingOpponent(
    self: Ship,
    world: ControllerWorld,
    maxRange: number,
  ): SensorContact | null {
    let best: SensorContact | null = null;
    let bestSq = maxRange * maxRange;
    for (const o of world.opponents) {
      if (!o.isAlive || !o.fresh || !o.ship.isSpoolingJump) continue;
      const dx = o.position.x - self.position.x;
      const dz = o.position.z - self.position.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestSq) {
        bestSq = dSq;
        best = o;
      }
    }
    return best;
  }

  /** Blend two headings (radians) by `t` (0 = a, 1 = b) via unit-vector lerp. */
  private blendHeading(a: number, b: number, t: number): number {
    const x = Math.sin(a) * (1 - t) + Math.sin(b) * t;
    const z = Math.cos(a) * (1 - t) + Math.cos(b) * t;
    return Math.atan2(x, z);
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

    const jitter = (simRandom() * 2 - 1) * cfg.wanderJitter;
    const naiveTarget = self.rotationY + jitter;
    this.wanderTargetHeading = wrapAngle(
      naiveTarget * (1 - leashPull) + angleToAnchor * leashPull,
    );

    this.wanderTimerSec = cfg.wanderRetargetSec * (0.6 + simRandom() * 0.8);
  }
}
