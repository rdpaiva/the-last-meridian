import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Registers MeshBuilder.CreateBox (the bolt streak).
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "../GameConfig";
import type { LaserSystem } from "../sim/LaserSystem";

export type LaserSystemViewOptions = {
  /** Emissive RGB of the bolt material (components > 1.0 bloom harder). */
  emissive: Color3;
  /** Optional name for the material — handy when debugging in the inspector. */
  materialName?: string;
  /**
   * Emissive RGB for TURRET bolts (Laser.turret === true) — the carrier's
   * dark-orange flak rounds, distinct from this faction's fighter lasers. Both
   * factions share it (GameConfig.mothership.turrets.boltEmissive). Omit to tint
   * turret bolts the same as ship bolts.
   */
  turretEmissive?: Color3;
  /**
   * Emissive RGB for HEAVY (gunship) bolts (Laser.heavy === true) — the
   * faction's heavy-laser tint, so a Breaker/Reaver's fire reads distinct from
   * a light fighter's. Omit to tint heavy bolts the same as light ship bolts.
   */
  heavyEmissive?: Color3;
};

/**
 * Babylon depiction of one faction's LaserSystem — the view half of the
 * Laser/LaserSystem split (docs/MULTIPLAYER.md Phase 0). The sim owns bolt
 * state; this POOLS box meshes (one material for the whole faction) and, once
 * per frame, maps live bolts onto pool meshes by index: position + heading
 * copied in, surplus meshes disabled. The pool never shrinks — its high-water
 * mark is the max concurrent bolts, a few dozen meshes at most.
 *
 * Pool-by-index works because the sim keeps `bolts` in stable spawn order
 * (expired bolts are spliced out, order preserved). A bolt may therefore hop
 * between pool meshes across frames — invisible, since every visible mesh is
 * re-posed every frame.
 */
export class LaserSystemView {
  private readonly material: StandardMaterial;
  /**
   * Second material for turret bolts (dark-orange flak), or null when no
   * turretEmissive was given — then turret bolts share the ship material. Built
   * once and assigned per-mesh each frame by the bolt's `turret` flag.
   */
  private readonly turretMaterial: StandardMaterial | null;
  /**
   * Second material for heavy (gunship) bolts, or null when no heavyEmissive
   * was given — then heavy bolts share the light ship material. Built once and
   * assigned per-mesh each frame by the bolt's `heavy` flag.
   */
  private readonly heavyMaterial: StandardMaterial | null;
  private readonly pool: Mesh[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly system: LaserSystem,
    options: LaserSystemViewOptions,
  ) {
    this.material = this.buildMaterial(
      options.materialName ?? "laser_mat",
      options.emissive,
    );
    this.turretMaterial = options.turretEmissive
      ? this.buildMaterial(
          `${options.materialName ?? "laser"}_turret`,
          options.turretEmissive,
        )
      : null;
    this.heavyMaterial = options.heavyEmissive
      ? this.buildMaterial(
          `${options.materialName ?? "laser"}_heavy`,
          options.heavyEmissive,
        )
      : null;
  }

  private buildMaterial(name: string, emissive: Color3): StandardMaterial {
    const mat = new StandardMaterial(name, this.scene);
    // Diffuse is irrelevant when lighting is disabled — kept dark so the
    // bolt reads as near-pure emission even outside the bloom pass.
    mat.diffuseColor = new Color3(emissive.r * 0.2, emissive.g * 0.2, emissive.b * 0.2);
    mat.emissiveColor = emissive;
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    return mat;
  }

  /** Copy live bolts onto pool meshes. Call once per frame, before render. */
  update(): void {
    const bolts = this.system.bolts;
    while (this.pool.length < bolts.length) this.pool.push(this.buildMesh());
    for (let i = 0; i < bolts.length; i++) {
      const mesh = this.pool[i];
      const bolt = bolts[i];
      mesh.position.copyFrom(bolt.position);
      mesh.rotation.y = bolt.rotationY;
      // Pool meshes are reused across bolts of every kind, so re-select the
      // material each frame from the bolt's flags (a cheap reference set).
      // Turret flak wins over heavy (a turret bolt has no shooter/heavy);
      // heavy gunship bolts get the heavy tint; everything else is the light
      // ship material.
      const mat =
        bolt.turret && this.turretMaterial
          ? this.turretMaterial
          : bolt.heavy && this.heavyMaterial
            ? this.heavyMaterial
            : this.material;
      if (mesh.material !== mat) mesh.material = mat;
      if (!mesh.isEnabled(false)) mesh.setEnabled(true);
    }
    for (let i = bolts.length; i < this.pool.length; i++) {
      const mesh = this.pool[i];
      if (mesh.isEnabled(false)) mesh.setEnabled(false);
    }
  }

  private buildMesh(): Mesh {
    const cfg = GameConfig.laser;
    const mesh = MeshBuilder.CreateBox(
      "laser",
      {
        width: cfg.radius * 2,
        height: cfg.radius * 2,
        depth: cfg.length,
      },
      this.scene,
    );
    mesh.material = this.material;
    mesh.isPickable = false;
    return mesh;
  }

  dispose(): void {
    for (const mesh of this.pool) mesh.dispose();
    this.pool.length = 0;
    this.material.dispose();
    this.turretMaterial?.dispose();
    this.heavyMaterial?.dispose();
  }
}
