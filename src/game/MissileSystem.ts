import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
// Registers MeshBuilder.CreateCylinder (body + nose cone) and CreateBox (fins).
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "./GameConfig";
import { wrapAngle } from "./math";
// Damage rolls draw from the seeded SIM RNG (not Math.random) so battles are
// reproducible from a seed — see src/game/sim/SimRng.ts for the rule.
import { simRandom } from "./sim/SimRng";
import { Missile } from "./Missile";
import type { DamageTarget } from "./types";
import type { Ship } from "./sim/Ship";

/**
 * Per-faction collection of heat-seeking missiles. Parallels LaserSystem, but
 * each projectile homes (see Missile) and carries its own exhaust trail. Like
 * the lasers, each missile carries ITS shooter, so kill attribution and
 * feedback scaling work the same whether the player or an AI pilot fired.
 *
 * Collision reuses the laser pattern: a simple X/Z distance test against every
 * registered target each frame (so a ballistic or off-target missile still
 * detonates on contact). On a hit, damage is rolled uniformly in
 * [minDamage, maxDamage], the missile is killed, and onHit fires with the
 * impact position so the caller can pop an explosion there.
 */
export type MissileSystemOptions = {
  /** Inclusive damage roll bounds applied per hit. */
  minDamage: number;
  maxDamage: number;
  /** Diffuse color of the missile body + nose cone (the gray hull). */
  bodyColor: Color3;
  /** Diffuse color of the tail fins (the red accent). */
  finColor: Color3;
  /** Emissive RGB of the exhaust trail (components > 1.0 bloom harder). */
  trailEmissive: Color3;
  /** Optional material name prefix — handy when debugging in the inspector. */
  materialName?: string;
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
  private readonly bodyMaterial: StandardMaterial;
  private readonly finMaterial: StandardMaterial;
  private readonly trailMaterial: StandardMaterial;
  private readonly minDamage: number;
  private readonly maxDamage: number;
  private readonly onHit:
    | ((position: Vector3, target: DamageTarget | null, shooter: Ship | null) => void)
    | null;
  /** Targets every missile tests against each frame (all enemies). */
  private readonly targets: DamageTarget[] = [];
  /** Asteroid cover missiles detonate against (held by reference; may be empty). */
  private readonly obstacles: DamageTarget[];

  constructor(
    private readonly scene: Scene,
    options: MissileSystemOptions,
  ) {
    this.minDamage = options.minDamage;
    this.maxDamage = options.maxDamage;
    this.onHit = options.onHit ?? null;
    this.obstacles = options.obstacles ?? [];

    const name = options.materialName ?? "missile_mat";

    // Body: a lit gray hull with a faint self-emissive so it still reads as a
    // solid object against the dark backdrop (not added to the GlowLayer — the
    // hull shouldn't bloom; only the exhaust does).
    const body = new StandardMaterial(`${name}_body`, scene);
    body.diffuseColor = options.bodyColor;
    body.emissiveColor = options.bodyColor.scale(0.25);
    body.specularColor = new Color3(0.2, 0.2, 0.22);
    this.bodyMaterial = body;

    // Fins: red accent, same lit-with-faint-emissive treatment.
    const fin = new StandardMaterial(`${name}_fin`, scene);
    fin.diffuseColor = options.finColor;
    fin.emissiveColor = options.finColor.scale(0.3);
    fin.specularColor = new Color3(0.1, 0.1, 0.1);
    this.finMaterial = fin;

    // Trail emissive blooms via the GlowLayer into a hot streak. Semi-
    // transparent so it reads as exhaust, not a solid tube.
    const trail = new StandardMaterial(`${name}_trail`, scene);
    trail.diffuseColor = new Color3(0, 0, 0);
    trail.specularColor = new Color3(0, 0, 0);
    trail.emissiveColor = options.trailEmissive;
    trail.disableLighting = true;
    trail.alpha = 0.7;
    this.trailMaterial = trail;
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

    const mesh = this.buildMissileMesh();
    mesh.position.copyFrom(origin);
    mesh.rotation.y = rotationY;

    // Bake the world matrix NOW. The root was created this frame, so its world
    // matrix is still identity until the next render — and TrailMesh seeds all
    // its segments from the generator's world position at construction. Without
    // this, every trail starts as a stray streak from the world origin (0,0,0)
    // to the spawn point on the first frame.
    mesh.computeWorldMatrix(true);

    // Trail generator = the missile root; autoStart records immediately.
    const trail = new TrailMesh(
      "missile_trail",
      mesh,
      this.scene,
      cfg.trailDiameter,
      cfg.trailLength,
      true,
    );
    trail.material = this.trailMaterial;
    trail.isPickable = false;

    this.missiles.push(
      new Missile(
        mesh,
        trail,
        rotationY,
        target,
        shooter,
        cfg.speed,
        cfg.turnRate,
        cfg.lifetimeMs,
      ),
    );
  }

  /**
   * Builds one missile as a small composite parented to a root TransformNode:
   * a gray cylindrical body, a tapered nose cone, and four red tail fins in a
   * `+` cross — oriented along local +Z (forward), tip toward +Z.
   *
   * Kept deliberately small (~0.7 long) so it reads as a sub-munition next to
   * the ~1.6-unit player ship. Disposing the root recurses into the children
   * (shared materials survive — disposeMaterialAndTextures defaults to false).
   */
  private buildMissileMesh(): TransformNode {
    const cfg = GameConfig.missile;
    const scene = this.scene;
    const root = new TransformNode("missile", scene);

    const bodyDia = cfg.radius * 2;
    const bodyLen = cfg.length;
    const noseLen = cfg.length * 0.36;

    // Body tube — cylinder's height axis (Y) rotated onto +Z.
    const body = MeshBuilder.CreateCylinder(
      "missile_body",
      { height: bodyLen, diameter: bodyDia, tessellation: 10 },
      scene,
    );
    body.rotation.x = Math.PI / 2;
    body.material = this.bodyMaterial;
    body.isPickable = false;
    body.parent = root;

    // Nose cone — slightly blunt tip, seated on the body's front face.
    const nose = MeshBuilder.CreateCylinder(
      "missile_nose",
      {
        height: noseLen,
        diameterTop: bodyDia * 0.12,
        diameterBottom: bodyDia,
        tessellation: 10,
      },
      scene,
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.z = bodyLen / 2 + noseLen / 2;
    nose.material = this.bodyMaterial;
    nose.isPickable = false;
    nose.parent = root;

    // Four fins around the aft body. Rotating each box about +Z puts its width
    // along the radial direction; depth stays along the body (chord).
    const finSpan = bodyDia;
    const finChord = bodyLen * 0.4;
    const finThick = bodyDia * 0.18;
    const off = bodyDia / 2 + finSpan / 2;
    const tailZ = -bodyLen / 2 + finChord / 2;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const fin = MeshBuilder.CreateBox(
        "missile_fin",
        { width: finSpan, height: finThick, depth: finChord },
        scene,
      );
      fin.position.set(Math.cos(a) * off, Math.sin(a) * off, tailZ);
      fin.rotation.z = a;
      fin.material = this.finMaterial;
      fin.isPickable = false;
      fin.parent = root;
    }

    return root;
  }

  /** `nowMs` is the frame's sim clock, forwarded to takeDamage (death timers). */
  update(deltaSeconds: number, deltaMs: number, nowMs: number): void {
    const targets = this.targets;

    for (const missile of this.missiles) {
      missile.update(deltaSeconds, deltaMs);
      if (missile.isExpired) continue;

      // Mid-flight re-acquisition: a missile launched without a lock seeks the
      // nearest live enemy ahead of it (within seekRange + seekConeAngle) and
      // homes once it finds one. Missiles launched WITH a lock never do this.
      if (missile.canReacquire && !missile.hasTarget) {
        const found = this.findSeekerTarget(missile);
        if (found) missile.acquire(found);
      }

      // Cover: a rock in the way detonates the missile (and chips the rock).
      // Checked before targets so a missile can't punch through cover.
      let blocked = false;
      for (const rock of this.obstacles) {
        if (!rock.isAlive) continue;
        const dx = missile.mesh.position.x - rock.position.x;
        const dz = missile.mesh.position.z - rock.position.z;
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
          this.onHit?.(missile.mesh.position, null, missile.shooter);
          missile.kill();
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Collision: X/Z distance vs. each live target (Y ignored — single
      // plane). First overlap detonates the missile. hitRadius is the broad
      // phase; targets with an exact silhouette (mothership hull boxes)
      // refine it via intersectsSegmentXZ with a zero-length segment.
      for (const target of targets) {
        if (!target.isAlive) continue;
        const mx = missile.mesh.position.x;
        const mz = missile.mesh.position.z;
        const dx = mx - target.position.x;
        const dz = mz - target.position.z;
        const radiusSq = target.hitRadius * target.hitRadius;
        if (dx * dx + dz * dz > radiusSq) continue;
        if (
          target.intersectsSegmentXZ &&
          !target.intersectsSegmentXZ(mx, mz, mx, mz)
        ) {
          continue;
        }
        target.takeDamage(this.rollDamage(), nowMs);
        this.onHit?.(missile.mesh.position, target, missile.shooter);
        missile.kill();
        break;
      }
    }

    // Sweep expired entries last-to-first so splice doesn't shift the cursor.
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      if (this.missiles[i].isExpired) {
        this.missiles[i].dispose();
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
    const mx = missile.mesh.position.x;
    const mz = missile.mesh.position.z;
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
