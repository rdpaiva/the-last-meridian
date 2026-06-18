import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Registers MeshBuilder.CreateBox (boxes are opt-in to tree-shaking).
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
// Registers the .glb/.gltf loader used by applyModel() (same as MothershipView).
import "@babylonjs/loaders/glTF";

import { GameConfig } from "../GameConfig";
import { hullColliderBoxes, type Hulk } from "../sim/Hulk";

/**
 * Hulk VIEW — the depiction of a derelict wreck (sim half: `Hulk`). A dark,
 * dead block per hull rectangle is built immediately as the placeholder /
 * fallback; `applyModel()` then swaps in the actual battle-damaged carrier GLB
 * (the burned-out Aegis / Choirship) under the SAME root, so the model inherits
 * the wreck's position, scale, and slow drift-rotation (`update`) for free.
 *
 * It reads as a husk because it carries no running lights / engine glow — only
 * meshes tagged as embers/breaches (GameConfig.hulk.emberTags) are added to the
 * GlowLayer so the glowing damage blooms; the rest is just lit hull.
 *
 * The blocks/GLB are built from the UNSCALED source-carrier footprint under a
 * root scaled by the hulk's `scale`, matching the sim's collision circles
 * (derived from the same rects × the same scale).
 */
export class HulkView {
  readonly root: TransformNode;

  private readonly scene: Scene;
  private readonly glowLayer: GlowLayer;
  private readonly source: Hulk["source"];
  /** Placeholder block meshes, disposed once a GLB takes over. */
  private placeholderMeshes: AbstractMesh[] = [];
  /** Debug collider wireframes (built lazily on first enable). */
  private debugMeshes: AbstractMesh[] = [];

  constructor(scene: Scene, glowLayer: GlowLayer, sim: Hulk) {
    this.scene = scene;
    this.glowLayer = glowLayer;
    this.source = sim.source;

    this.root = new TransformNode(`hulk_${sim.source}_root`, scene);
    this.root.position.copyFrom(sim.center);
    this.root.rotation.y = sim.rotationY;
    this.root.scaling.setAll(sim.scale);

    if (GameConfig.hulk.debugColliders) this.setDebugColliders(true);

    const mat = new StandardMaterial(`hulk_${sim.source}_dead_mat`, scene);
    // Mid-grey matte metal so the placeholder reads as a SOLID hull, not a void
    // hole. A faint emissive floor keeps it from going pure-black in shadow
    // (it's not added to the GlowLayer, so it doesn't bloom). The real wreck GLB
    // (applyModel) replaces these blocks entirely.
    mat.diffuseColor = new Color3(0.28, 0.29, 0.32);
    mat.specularColor = new Color3(0.06, 0.06, 0.08);
    mat.emissiveColor = new Color3(0.04, 0.04, 0.05);

    const height = 18;
    const rects = GameConfig.mothership.hullRects[sim.source];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const box = MeshBuilder.CreateBox(
        `hulk_${sim.source}_sec${i}`,
        { width: r.halfWidth * 2, height, depth: r.z1 - r.z0 },
        scene,
      );
      box.position.set(0, height / 2, (r.z0 + r.z1) / 2);
      box.parent = this.root;
      box.material = mat;
      box.isPickable = false;
    }
    this.placeholderMeshes = this.root.getChildMeshes(true);
  }

  /**
   * Swap the placeholder blocks for the battle-damaged carrier GLB named by
   * `filename` (under public/models/), parked under a correction node that
   * applies GameConfig.hulk.model orientation/scale. The model keeps its own
   * (burned-out) materials — only ember/breach meshes are bloomed. Returns
   * false and KEEPS the placeholder if `filename` is null/empty or the load
   * fails. Always resolves; never rejects. Call once, after construction.
   */
  async applyModel(filename: string | null): Promise<boolean> {
    const cfg = GameConfig.hulk.model;
    if (!filename) return false;
    try {
      // NOTE: trailing slash on rootUrl is required for SceneLoader.
      const result = await SceneLoader.ImportMeshAsync(
        "",
        `${import.meta.env.BASE_URL}models/`,
        filename,
        this.scene,
      );

      // Park the glTF "__root__" (RHS→LHS handling) under our correction node.
      const modelRoot = new TransformNode(`hulk_model_${this.source}`, this.scene);
      const gltfRoot = result.transformNodes.find((n) => n.name === "__root__");
      if (gltfRoot) {
        gltfRoot.parent = modelRoot;
      } else {
        for (const m of result.meshes) {
          if (m.parent === null) m.parent = modelRoot;
        }
      }
      modelRoot.rotation.set(cfg.rotX, cfg.rotY, cfg.rotZ);
      modelRoot.scaling.setAll(cfg.scale);
      modelRoot.parent = this.root;

      this.registerEmberGlow(result.meshes);

      // The placeholder blocks are redundant now — dispose them. The GLB is a
      // sibling under `root`, so it (and the spin) stay.
      for (const m of this.placeholderMeshes) m.dispose(false, true);
      this.placeholderMeshes = [];
      return true;
    } catch (err) {
      console.warn(
        `[HulkView] Failed to load /models/${filename} — keeping the ` +
          `procedural wreck placeholder.`,
        err,
      );
      return false;
    }
  }

  /** Bloom only the glowing-damage meshes (ember breaches), so the wreck reads
   *  as a dead hull with hot fractures rather than a lit ship. */
  private registerEmberGlow(meshes: AbstractMesh[]): void {
    const tags = GameConfig.hulk.emberTags;
    for (const m of meshes) {
      const nm = m.name.toLowerCase();
      if (tags.some((t) => nm.includes(t))) {
        this.glowLayer.addIncludedOnlyMesh(m as Mesh);
      }
    }
  }

  /** Match the mesh to the wreck's current (sim-owned) drift rotation: yaw, plus
   *  optional pitch (beam-axis somersault) and roll (keel-axis barrel roll) —
   *  all view-only (see Hulk). */
  update(rotationY: number, rotationX = 0, rotationZ = 0): void {
    this.root.rotation.y = rotationY;
    this.root.rotation.x = rotationX;
    this.root.rotation.z = rotationZ;
  }

  /**
   * Toggle bright-green wireframe boxes over the collision sections (built lazily
   * on first enable). They're children of `root` with UNSCALED hullRect/
   * hullHalfHeight dims — `root` applies the wreck's scale AND its yaw/pitch/roll,
   * so the wireframes match `sim/HulkSection` exactly and roll with the hull.
   */
  setDebugColliders(on: boolean): void {
    if (on && this.debugMeshes.length === 0) {
      const mat = new StandardMaterial(`hulk_${this.source}_collider_mat`, this.scene);
      mat.emissiveColor = new Color3(0.1, 1, 0.2);
      mat.disableLighting = true;
      mat.wireframe = true;
      // Same UNSCALED boxes the sim collides with (root applies the wreck scale).
      const boxes = hullColliderBoxes(this.source);
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const box = MeshBuilder.CreateBox(
          `hulk_${this.source}_collider${i}`,
          { width: b.hx * 2, height: b.hy * 2, depth: b.hz * 2 },
          this.scene,
        );
        box.position.set(b.cx, b.cy, b.cz);
        box.parent = this.root;
        box.material = mat;
        box.isPickable = false;
        this.debugMeshes.push(box);
      }
    }
    for (const m of this.debugMeshes) m.setEnabled(on);
  }

  /** Tear down the scene nodes (match end). */
  dispose(): void {
    this.root.dispose(false, true);
  }
}
