import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import { closestTOnSegmentXZ, sweptClosestT, wrapAngle } from "../math";
// Damage rolls draw from the seeded SIM RNG (not Math.random) so battles are
// reproducible from a seed — see src/game/sim/SimRng.ts for the rule.
import { simRandom } from "./SimRng";
import { Missile } from "./Missile";
import type { DamageTarget, Interceptable } from "../types";
import type { Ship } from "./Ship";

/**
 * Per-faction collection of heat-seeking missiles — SIM only since the
 * Missile/MissileSystem split (docs/MULTIPLAYER.md Phase 0): launch, homing,
 * mid-flight reacquisition, collision, damage rolls. It owns no meshes or
 * trails; MissileSystemView (src/game/view/) builds a composite mesh + exhaust
 * trail per live round in `rounds` and disposes them as rounds disappear.
 *
 * Parallels LaserSystem. Like the lasers, each missile carries ITS shooter,
 * so kill attribution and feedback scaling work the same whether the player
 * or an AI pilot fired.
 *
 * Collision reuses the laser pattern: the missile's per-tick path segment is
 * swept against every registered target's per-tick path (BOTH bodies move —
 * see sweptClosestT in math.ts; a point test at the missile's new position
 * tunnels at the 30Hz server tick, where a head-on pass closes more than a
 * fighter's whole capture diameter per step). A ballistic or off-target
 * missile still detonates on contact. On a hit, damage is rolled uniformly in
 * [minDamage, maxDamage], the missile is killed, and onHit fires with the
 * impact position — the contact point — so the caller can pop an explosion
 * there.
 */
export type MissileSystemOptions = {
  /** Inclusive damage roll bounds applied per hit. */
  minDamage: number;
  maxDamage: number;
  /**
   * Called once per missile that detonates, with the world-space impact point,
   * the DamageTarget it struck — null when it detonated on an asteroid
   * (cover) rather than a registered target — and the SHIP that launched it
   * (null = unattributed). The target is reported AFTER damage is applied, so
   * the caller can check `!target.isAlive` for a kill.
   */
  onHit?: (
    position: Vector3,
    target: DamageTarget | null,
    shooter: Ship | null,
  ) => void;
  /**
   * Live obstacles (asteroids) a missile detonates against. Checked BEFORE the
   * target loop, so a rock blocks a missile (cover) and the missile still pops
   * its explosion on the rock. Damaged on contact (rocks are destructible).
   * Held by reference — the field mutates it as rocks shatter/are destroyed.
   * NOTE: the seeker (findSeekerTarget) ignores these, so missiles home on
   * ships, not rocks — they only detonate on a rock they happen to fly into.
   */
  obstacles?: DamageTarget[];
};

export class MissileSystem {
  private readonly missiles: Missile[] = [];
  private readonly minDamage: number;
  private readonly maxDamage: number;
  private readonly onHit:
    | ((position: Vector3, target: DamageTarget | null, shooter: Ship | null) => void)
    | null;
  /** Targets every missile tests against each frame (all enemies). */
  private readonly targets: DamageTarget[] = [];
  /** Asteroid cover missiles detonate against (held by reference; may be empty). */
  private readonly obstacles: DamageTarget[];

  constructor(options: MissileSystemOptions) {
    this.minDamage = options.minDamage;
    this.maxDamage = options.maxDamage;
    this.onHit = options.onHit ?? null;
    this.obstacles = options.obstacles ?? [];
  }

  /** Live rounds, in launch order — what a MissileSystemView depicts. */
  get rounds(): readonly Missile[] {
    return this.missiles;
  }

  /** Add a DamageTarget to the list missiles test against. */
  addTarget(target: DamageTarget): void {
    this.targets.push(target);
  }

  /**
   * Append every live missile currently homing on `target` to `out`. Backs the
   * incoming-missile warning (MissileWarning), which polls this once per frame
   * with a reusable array — write-in-place, no per-frame allocation. A missile
   * that lost its target (went ballistic) or already detonated is excluded; a
   * ballistic round that REACQUIRES `target` mid-flight shows up the frame it
   * does.
   */
  collectHomingOn(target: DamageTarget, out: Missile[]): void {
    for (const missile of this.missiles) {
      if (!missile.isExpired && missile.currentTarget === target) {
        out.push(missile);
      }
    }
  }

  /**
   * Spawn a missile at `origin` heading along `rotationY`. Pass the locked
   * enemy as `target` to home on it, or `null` to fire ballistic. `shooter`
   * is the launching SHIP, reported back through onHit for attribution.
   */
  spawn(
    origin: Vector3,
    rotationY: number,
    target: DamageTarget | null,
    shooter: Ship | null = null,
  ): void {
    const cfg = GameConfig.missile;
    this.missiles.push(
      new Missile(
        origin.clone(),
        rotationY,
        target,
        shooter,
        cfg.speed,
        cfg.turnRate,
        cfg.lifetimeMs,
        cfg.interceptRadius,
      ),
    );
  }

  /**
   * The live missiles, as point-defense targets for the OPPOSING faction's
   * lasers. Held by reference (like the laser systems' obstacles array): the
   * pool mutates in place as missiles spawn/expire, so a LaserSystem handed
   * this once sees the current set every frame for free. Expired rounds stay
   * in the array until the end-of-update sweep, but report isAlive === false,
   * so the lasers skip them.
   */
  get interceptables(): readonly Interceptable[] {
    return this.missiles;
  }

  /** `nowMs` is the frame's sim clock, forwarded to takeDamage (death timers). */
  update(deltaSeconds: number, deltaMs: number, nowMs: number): void {
    const targets = this.targets;

    for (const missile of this.missiles) {
      // Capture the round's position BEFORE it moves: a→b is its path this
      // tick, and every collision test below sweeps that segment. A point
      // test at only the new position tunnels — at the 30Hz server tick a
      // head-on pass closes ~2.4 units/tick against a fighter's 2.0-unit
      // capture diameter, so dead-center hits skip clean across the circle
      // between two samples (the "missile flies through the ship and loops
      // back" playtest bug).
      const ax = missile.position.x;
      const az = missile.position.z;
      missile.update(deltaSeconds, deltaMs);
      if (missile.isExpired) continue;
      const bx = missile.position.x;
      const bz = missile.position.z;

      // Mid-flight re-acquisition: a missile launched without a lock seeks the
      // nearest live enemy ahead of it (within seekRange + seekConeAngle) and
      // homes once it finds one. Missiles launched WITH a lock never do this.
      if (missile.canReacquire && !missile.hasTarget) {
        const found = this.findSeekerTarget(missile);
        if (found) missile.acquire(found);
      }

      // Cover: a rock in the way detonates the missile (and chips the rock).
      // Checked before targets so a missile can't punch through cover. Rocks
      // are tested STATIC by contract (the field updates AFTER the weapon
      // systems each tick), but the MISSILE's path is swept, same as lasers.
      let blocked = false;
      for (const rock of this.obstacles) {
        if (!rock.isAlive) continue;
        const t = closestTOnSegmentXZ(rock.position.x, rock.position.z, ax, az, bx, bz);
        const cx = ax + (bx - ax) * t;
        const cz = az + (bz - az) * t;
        const dx = cx - rock.position.x;
        const dz = cz - rock.position.z;
        const distSq = dx * dx + dz * dz;
        // Broad phase vs. the conservative circle, then the exact directional
        // silhouette (see LaserSystem — squashed rocks shouldn't detonate a
        // missile that visibly cleared them).
        if (distSq > rock.hitRadius * rock.hitRadius) continue;
        const r = rock.surfaceRadiusToward
          ? rock.surfaceRadiusToward(dx, dz)
          : rock.hitRadius;
        if (distSq <= r * r) {
          rock.takeDamage(this.rollDamage(), nowMs);
          // Detonate at the contact point on the path, not past the rock.
          missile.position.x = cx;
          missile.position.z = cz;
          this.onHit?.(missile.position, null, missile.shooter);
          missile.kill();
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Collision: closest approach of the missile's path vs. EACH TARGET'S
      // PATH this tick — both bodies swept (sweptClosestT). The target's
      // tick-start is reconstructed from its velocity (`position - velocity
      // * dt`): ships advance BEFORE the weapon systems in BattleSim.advance,
      // so `position` is end-of-tick — and teleports (jump drive, respawn)
      // zero the velocity, collapsing the sweep to a point instead of a
      // phantom hitbox smeared across the arena. Y ignored — single plane.
      // First overlap detonates the missile. hitRadius is the broad phase;
      // targets with an exact silhouette (mothership hull boxes — always
      // static) refine it via intersectsSegmentXZ over the missile's segment.
      for (const target of targets) {
        if (!target.isAlive) continue;
        const tex = target.position.x;
        const tez = target.position.z;
        const vel = target.velocity;
        const tsx = vel ? tex - vel.x * deltaSeconds : tex;
        const tsz = vel ? tez - vel.z * deltaSeconds : tez;
        const t = sweptClosestT(ax, az, bx, bz, tsx, tsz, tex, tez);
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const dx = px - (tsx + (tex - tsx) * t);
        const dz = pz - (tsz + (tez - tsz) * t);
        const radiusSq = target.hitRadius * target.hitRadius;
        if (dx * dx + dz * dz > radiusSq) continue;
        if (
          target.intersectsSegmentXZ &&
          !target.intersectsSegmentXZ(ax, az, bx, bz)
        ) {
          continue;
        }
        target.takeDamage(this.rollDamage(), nowMs);
        // Report the impact at the CONTACT POINT — this position rides the
        // wire as missileHit, and the client pops the explosion (and kills
        // its cosmetic round) there.
        missile.position.x = px;
        missile.position.z = pz;
        this.onHit?.(missile.position, target, missile.shooter);
        missile.kill();
        break;
      }
    }

    // Sweep expired entries last-to-first so splice doesn't shift the cursor.
    // (No mesh/trail disposal here — the view releases them by watching
    // `rounds` shrink.)
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      if (this.missiles[i].isExpired) {
        this.missiles.splice(i, 1);
      }
    }
  }

  /**
   * Nearest live target ahead of `missile` within the seeker range + cone, or
   * null. "Ahead" = inside `seekConeAngle` of the missile's current heading, so
   * a ballistic missile only locks onto enemies along its path, not behind it.
   */
  private findSeekerTarget(missile: Missile): DamageTarget | null {
    const cfg = GameConfig.missile;
    const mx = missile.position.x;
    const mz = missile.position.z;
    const heading = missile.heading;

    let best: DamageTarget | null = null;
    let bestDist = Infinity;
    for (const target of this.targets) {
      if (!target.isAlive) continue;
      const dx = target.position.x - mx;
      const dz = target.position.z - mz;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.seekRange || dist >= bestDist) continue;
      const angleToTarget = Math.atan2(dx, dz);
      if (Math.abs(wrapAngle(angleToTarget - heading)) > cfg.seekConeAngle) {
        continue;
      }
      best = target;
      bestDist = dist;
    }
    return best;
  }

  /** Uniform integer roll in [minDamage, maxDamage]. */
  private rollDamage(): number {
    const span = this.maxDamage - this.minDamage;
    return this.minDamage + Math.round(simRandom() * span);
  }

  get count(): number {
    return this.missiles.length;
  }
}
