import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import {
  closestTOnSegmentXZ,
  distSqSegmentToPointXZ,
  sweptClosestT,
} from "../math";
import { Laser } from "./Laser";
import type { DamageTarget, Interceptable } from "../types";
import type { Ship } from "./Ship";

/**
 * Per-faction collection of laser bolts — SIM only since the Laser/LaserSystem
 * split (docs/MULTIPLAYER.md Phase 0): spawn math, swept collision, damage and
 * lifetime. It owns no meshes/materials; LaserSystemView (src/game/view/) pools
 * box meshes and copies live bolts' position/heading out of `bolts` each frame.
 *
 * Two instances exist per match: one per faction, each wired with its default
 * per-hit damage, the shared asteroid obstacle list, and an optional onHit
 * callback (the client uses it for feedback; the server, for replication).
 *
 * Collision sweeps BOTH bodies: the bolt's per-tick path segment against the
 * target's per-tick path (reconstructed from its velocity — see sweptClosestT
 * in math.ts). Y is ignored because gameplay is on a single plane. On a hit,
 * the target takes damage and the bolt is killed for removal on the next sweep.
 */
export type LaserSystemOptions = {
  /**
   * DEFAULT bolt damage, used when spawn() isn't given a per-bolt value.
   * Ships pass their own type's laserDamage per shot, so this is just the
   * fallback for un-attributed bolts.
   */
  damage: number;
  /**
   * Called once per bolt that lands a hit, with the target it struck and the
   * SHIP that fired the bolt (null = unattributed). The target lets the
   * caller scale feedback by what was hit (flash + big hitstop when the
   * player's own ship is hit, light cue when the mothership is chipped); the
   * shooter drives kill attribution and lets the caller gate the "you landed
   * a hit" jolt to the LOCAL pilot's own shots by comparing ships — a
   * comparison that stays correct with any number of human pilots. `position`
   * is the bolt's impact point, so the caller can place an impact effect where
   * the hit landed rather than at the target's center.
   */
  onHit?: (
    target: DamageTarget,
    shooter: Ship | null,
    position: Vector3,
  ) => void;
  /**
   * Live obstacles (asteroids) that block bolts as line-of-sight cover. Checked
   * BEFORE the target loop each frame, so a bolt entering a rock is consumed
   * there and can't pass through to a ship behind it. Damaged on contact (rocks
   * are destructible). Held by reference — the field mutates this array as rocks
   * shatter/are destroyed, and the system sees the changes for free.
   */
  obstacles?: DamageTarget[];
  /**
   * Live missiles (the OPPOSING faction's) this system's bolts can shoot down
   * as point defense. Checked AFTER cover but BEFORE ship targets, so a
   * defensive shot prioritizes an incoming round over the ship behind it. One
   * bolt destroys one missile (Interceptable has no HP). Held by reference —
   * the pool mutates as missiles spawn/expire; dead rounds report isAlive
   * false and are skipped.
   */
  interceptables?: readonly Interceptable[];
  /**
   * Called once per missile a bolt shoots down, with the impact point and the
   * SHIP that fired the bolt (null = unattributed). Lets the caller pop a
   * small explosion + sound at the kill, the same way onHit drives feedback.
   */
  onIntercept?: (position: Vector3, shooter: Ship | null) => void;
};

export class LaserSystem {
  private readonly lasers: Laser[] = [];
  private readonly damage: number;
  private readonly onHit:
    | ((target: DamageTarget, shooter: Ship | null, position: Vector3) => void)
    | null;
  /** Asteroid cover bolts are blocked by (held by reference; may be empty). */
  private readonly obstacles: DamageTarget[];
  /** Opposing missiles bolts can shoot down (held by reference; may be empty). */
  private readonly interceptables: readonly Interceptable[];
  private readonly onIntercept:
    | ((position: Vector3, shooter: Ship | null) => void)
    | null;
  /**
   * Targets this system's bolts test against each frame. The player system
   * registers every enemy (multi-target); the enemy system registers just
   * the player (a one-element list). A bolt hits the first target it overlaps
   * and is then consumed, so it can't pass through one ship to strike another.
   */
  private readonly targets: DamageTarget[] = [];

  constructor(options: LaserSystemOptions) {
    this.damage = options.damage;
    this.onHit = options.onHit ?? null;
    this.obstacles = options.obstacles ?? [];
    this.interceptables = options.interceptables ?? [];
    this.onIntercept = options.onIntercept ?? null;
  }

  /** Live bolts, in spawn order — what a LaserSystemView depicts each frame. */
  get bolts(): readonly Laser[] {
    return this.lasers;
  }

  /** Replace the target list with a single DamageTarget. */
  setTarget(target: DamageTarget): void {
    this.targets.length = 0;
    this.targets.push(target);
  }

  /** Add a DamageTarget to the list this system tests bolts against. */
  addTarget(target: DamageTarget): void {
    this.targets.push(target);
  }

  /**
   * Spawn a laser at `origin` with forward direction derived from `rotationY`.
   * `shooter` is the firing SHIP — carried per bolt so onHit can attribute
   * kills and feedback to a pilot, human or AI, on this shared faction
   * system. `damage` is what THIS bolt deals (the firing ship's type knob);
   * omitted = the system's default.
   */
  spawn(
    origin: Vector3,
    rotationY: number,
    shooter: Ship | null = null,
    damage?: number,
    turret = false,
    velocityY = 0,
    heavy?: boolean,
  ): void {
    const cfg = GameConfig.laser;

    // The bolt streak is `length` long and CENTERED on its position, so
    // spawning it exactly at the muzzle leaves half the streak poking out
    // behind. Nudge it forward along its heading so its rear tip sits at the
    // muzzle and the bolt reads as emanating from the gun.
    const position = new Vector3(
      origin.x + Math.sin(rotationY) * cfg.spawnOffset,
      origin.y,
      origin.z + Math.cos(rotationY) * cfg.spawnOffset,
    );

    // X/Z speed is always the full bolt speed (so heading + swept collision are
    // identical to every other bolt); `velocityY` is an optional vertical slope
    // (turret bolts descending onto the fighter plane — see TurretFireCommand).
    const velocity = new Vector3(
      Math.sin(rotationY) * cfg.speed,
      velocityY,
      Math.cos(rotationY) * cfg.speed,
    );

    this.lasers.push(
      new Laser(
        position,
        velocity,
        // Turret flak lives longer than fighter fire: the carrier's guns
        // engage a bigger bubble (turrets.range) than laser.lifetimeMs can
        // cover, so their bolts get the matching endurance.
        turret ? GameConfig.mothership.turrets.boltLifetimeMs : cfg.lifetimeMs,
        rotationY,
        shooter,
        damage ?? this.damage,
        turret,
        // Heavy (gunship) bolts get the faction's heavy-laser tint. Turret flak
        // has no shooter, so it stays on the turret material regardless.
        // The explicit `heavy` override serves shooter-less COSMETIC bolts (a
        // networked client depicting a remote gunship's fire).
        heavy ?? shooter?.heavy ?? false,
      ),
    );
  }

  /** `nowMs` is the frame's sim clock, forwarded to takeDamage (death timers). */
  update(deltaSeconds: number, deltaMs: number, nowMs: number): void {
    const targets = this.targets;
    const obstacles = this.obstacles;
    const interceptables = this.interceptables;

    for (const laser of this.lasers) {
      // Capture the bolt's position BEFORE it moves, then sweep the segment
      // from there to its new position against every circle this frame. A point
      // test at only the new position tunnels: at 95 u/s a single 60Hz step is
      // ~1.6 units and a 30Hz (delta-clamped) step is ~3.2 — larger than a
      // ship's 2.4-unit capture diameter — so a target sitting between the two
      // sample points is skipped entirely. The swept test makes hits
      // frame-rate-independent: any circle the path crosses is caught.
      const ax = laser.position.x;
      const az = laser.position.z;
      laser.update(deltaSeconds, deltaMs);
      if (laser.isExpired) continue;
      const bx = laser.position.x;
      const bz = laser.position.z;

      // Cover: asteroids block bolts. Checked BEFORE targets, so a rock between
      // the gun and a ship eats the bolt (line-of-sight blocking) and chips the
      // rock (destructible). Swept-segment X/Z test, same as targets.
      let blocked = false;
      for (const rock of obstacles) {
        if (!rock.isAlive) continue;
        // Closest point on the bolt's path segment to the rock center; the
        // squared distance there is what we test the silhouette against.
        // Rocks are tested STATIC by contract: the field updates AFTER the
        // weapon systems each tick, so `position` is the rock's tick pose.
        const t = closestTOnSegmentXZ(rock.position.x, rock.position.z, ax, az, bx, bz);
        const cx = ax + (bx - ax) * t;
        const cz = az + (bz - az) * t;
        const dx = cx - rock.position.x;
        const dz = cz - rock.position.z;
        const distSq = dx * dx + dz * dz;
        // Broad phase vs. the conservative circle, then the exact directional
        // silhouette (asteroids are squashed ellipsoids — a bolt skimming a
        // rock's short axis should pass, not vanish into empty space).
        if (distSq > rock.hitRadius * rock.hitRadius) continue;
        const r = rock.surfaceRadiusToward
          ? rock.surfaceRadiusToward(dx, dz)
          : rock.hitRadius;
        if (distSq <= r * r) {
          rock.takeDamage(laser.damage, nowMs);
          laser.kill();
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Point defense: a bolt can shoot an opposing missile out of the air.
      // Same swept-segment test, against the missile's intercept bubble; the
      // first one the path crosses is destroyed and consumes the bolt. Checked
      // before ship targets so a defensive shot favors the incoming round.
      // NOTE: point defense deliberately stays a STATIC test (missile pinned
      // at its current position): missiles update AFTER lasers each tick, so
      // a velocity reconstruction here would need the opposite sign, and the
      // generous interceptRadius already lands ~96% of dead-aimed bolts.
      let intercepted = false;
      for (const missile of interceptables) {
        if (!missile.isAlive) continue;
        const distSq = distSqSegmentToPointXZ(
          missile.position.x,
          missile.position.z,
          ax,
          az,
          bx,
          bz,
        );
        const r = missile.interceptRadius;
        if (distSq > r * r) continue;
        missile.intercept();
        laser.kill();
        this.onIntercept?.(missile.position, laser.shooter);
        intercepted = true;
        break;
      }
      if (intercepted) continue;

      // Collision: closest approach of the bolt's path vs. EACH TARGET'S PATH
      // this tick (both bodies swept — see sweptClosestT; pinning the target
      // at its end-of-tick point lets fast head-on targets slip a bolt). The
      // target's tick-start is reconstructed from its velocity: ships advance
      // BEFORE the weapon systems in BattleSim.advance, so `position` is
      // end-of-tick and `position - velocity * dt` is where the tick began
      // (teleports zero velocity, collapsing the sweep to a point). Y axis is
      // ignored — gameplay is on one plane. First overlap consumes the bolt.
      // The hitRadius circle is the broad phase; targets with an exact
      // silhouette (mothership hull boxes — always static) refine it via
      // intersectsSegmentXZ so the bolt only dies on the visible hull.
      for (const target of targets) {
        if (!target.isAlive) continue;
        // Turret bolts fly a downward slope from the carrier deck onto the Y=0
        // fighter plane (see spawn's velocityY). Collision is otherwise X/Z
        // only, which would let a bolt still high overhead tag a ship it's
        // merely passing ABOVE — the on-screen "hit without touching". Gate
        // turret bolts on the bolt actually being near the target's plane, so a
        // hit only lands once the slope has brought it down to the ship.
        if (
          laser.turret &&
          Math.abs(laser.position.y - target.position.y) >
            GameConfig.mothership.turrets.boltVerticalHitRange
        ) {
          continue;
        }
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
        target.takeDamage(laser.damage, nowMs);
        // Report the impact at the CONTACT POINT, not the bolt's post-move
        // tip — a 3.2u step past a 2.4u ship is exactly the "bolt sails
        // through, spark pops behind it" clients would otherwise depict
        // (the server sends this position on the wire as laserHit).
        laser.position.x = px;
        laser.position.z = pz;
        laser.kill();
        this.onHit?.(target, laser.shooter, laser.position);
        break;
      }
    }

    // Sweep expired entries last-to-first so splice doesn't shift the cursor.
    // (No mesh disposal here — the view pool releases meshes by watching
    // `bolts` shrink.)
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      if (this.lasers[i].isExpired) {
        this.lasers.splice(i, 1);
      }
    }
  }

  get count(): number {
    return this.lasers.length;
  }
}
