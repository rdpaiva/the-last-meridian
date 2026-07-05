import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import {
  AsteroidFieldSim,
  type AsteroidSim,
  type DamageTarget,
  type KeepClear,
} from "@space-duel/shared";
import { AsteroidView } from "./AsteroidView";

/**
 * The VIEW half of the asteroid field (sim is shared/sim/AsteroidFieldSim).
 * Owns the sim, mirrors every live rock to an AsteroidView mesh, and keeps the
 * mirror in sync as the field shatters/wraps/culls. Drop-in replacement for the
 * old monolithic AsteroidField: same constructor + `asteroids` / `obstacles` /
 * `onShatter` / `update` surface, so Game is unchanged apart from the type name.
 *
 * One shared rock material is reused across the whole field (the CapitalShips
 * pattern), so N rocks cost a fixed material budget regardless of count.
 */
export class AsteroidFieldView {
  private readonly sim: AsteroidFieldSim;
  private readonly material: StandardMaterial;
  /** sim rock → its mesh view. Diffed each update to add/drop meshes. */
  private readonly views = new Map<AsteroidSim, AsteroidView>();

  constructor(
    private readonly scene: Scene,
    halfWidth: number,
    halfDepth: number,
    keepClear: KeepClear[],
  ) {
    this.material = this.buildMaterial(scene);
    // Sim construction draws ALL the seeded RNG (spawn + per-rock); meshes are
    // built after, on Math.random(), so the seeded battle is untouched.
    this.sim = new AsteroidFieldSim(halfWidth, halfDepth, keepClear);
    for (const rock of this.sim.asteroids) this.addView(rock);
  }

  /** Live rocks (sim), held BY REFERENCE by the weapon/collision/AI passes. */
  get asteroids(): AsteroidSim[] {
    return this.sim.asteroids;
  }

  /** The live rocks as weapon obstacles (every one implements DamageTarget). */
  get obstacles(): DamageTarget[] {
    return this.sim.obstacles;
  }

  /** Forwarded to the sim — fires on shatter (position + visual radius). */
  set onShatter(fn: ((position: Vector3, visualRadius: number) => void) | null) {
    this.sim.onShatter = fn;
  }

  /**
   * Advance the sim, then reconcile meshes: spawn views for new rocks (shatter
   * chunks), dispose views for culled/dead rocks, and sync transforms for the
   * rest.
   */
  update(deltaSeconds: number): void {
    this.sim.update(deltaSeconds);

    const live = this.sim.asteroids;
    const liveSet = new Set(live);
    // Drop meshes whose rock is gone (culled by the sim's death sweep).
    for (const [rock, view] of this.views) {
      if (!liveSet.has(rock)) {
        view.dispose();
        this.views.delete(rock);
      }
    }
    // Add meshes for newly-spawned rocks and sync everything live.
    for (const rock of live) {
      let view = this.views.get(rock);
      if (!view) view = this.addView(rock);
      view.sync();
    }
  }

  private addView(rock: AsteroidSim): AsteroidView {
    const view = new AsteroidView(this.scene, this.material, rock);
    this.views.set(rock, view);
    return view;
  }

  private buildMaterial(scene: Scene): StandardMaterial {
    // Lit rocky grey — deliberately NOT emissive and NOT added to the GlowLayer,
    // so rocks read as solid matter against the glowing ships/lasers/nebulas.
    const mat = new StandardMaterial("asteroid_mat", scene);
    mat.diffuseColor = new Color3(0.32, 0.29, 0.26);
    // Fully matte — any specular highlight makes a big rock read as plastic.
    mat.specularColor = Color3.Black();
    return mat;
  }
}
