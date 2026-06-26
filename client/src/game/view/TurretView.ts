import type { Scene } from "@babylonjs/core/scene";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Box builder registration — the procedural fallback turret is built from boxes,
// matching the carrier's boxy procedural style (see MothershipView).
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "@space-duel/shared";
import type { Faction } from "@space-duel/shared";

/**
 * Depiction of ONE carrier defense turret — the VIEW half of the Turret/
 * TurretView split (docs/MULTIPLAYER.md Phase 0). Holds no gameplay truth (aim,
 * hp, fire all live in sim/Turret.ts); each frame it reads the sim turret's
 * `aimAngle` (world radians) and `isAlive` and swings the gun.
 *
 * Two nested nodes under the carrier root, so only the UPPER GUN traverses while
 * the armored base stays bolted to the deck (the structure the user asked for):
 *   `mount`  — static, at the carrier-LOCAL mount; holds the tiered base.
 *   `gun`    — child of `mount`, rotated to the aim; holds the barrel + muzzle.
 *
 * It ships a procedural box turret immediately and upgrades to the shared turret
 * GLB (art/turret.blend → turret.glb) via applyModel() once it loads — same
 * two-tier "procedural fallback, swap in the model" pattern as the carrier.
 *
 * Frame note: `gun` sits under the carrier root (whose `rotation.y` is the
 * carrier facing), so to point at the sim's WORLD `aimAngle` we set the gun's
 * LOCAL Y rotation to `aimAngle − carrierRotationY + yawOffset`. The procedural
 * barrel is built along +Z so `yawOffset` is 0; the GLB's barrel lands at a
 * fixed import angle, so its `yawOffset` is the config `model.yaw` correction.
 */
export class TurretView {
  private readonly mount: TransformNode;
  private readonly gun: TransformNode;
  private readonly carrierRotationY: number;
  private readonly faction: Faction;

  /** Procedural meshes, disposed once the GLB swaps in. */
  private proceduralMeshes: Mesh[] = [];
  /** Added to `gun.rotation.y` so the visible barrel matches the bolt heading. */
  private yawOffset = 0;
  private deadShown = false;

  constructor(
    scene: Scene,
    root: TransformNode,
    faction: Faction,
    mountX: number,
    mountY: number,
    mountZ: number,
    carrierRotationY: number,
  ) {
    this.carrierRotationY = carrierRotationY;
    this.faction = faction;

    this.mount = new TransformNode(`turret_mount_${mountX}_${mountZ}`, scene);
    this.mount.parent = root;
    this.mount.position.set(mountX, mountY, mountZ);

    this.gun = new TransformNode(`turret_gun_${mountX}_${mountZ}`, scene);
    this.gun.parent = this.mount;

    this.buildProcedural(scene, faction);
  }

  // ─── Procedural fallback (boxes) ──────────────────────────────────────────

  private buildProcedural(scene: Scene, faction: Faction): void {
    const hullMat = new StandardMaterial(`turret_hull_${faction}`, scene);
    hullMat.diffuseColor =
      faction === "humans"
        ? new Color3(0.22, 0.28, 0.4)
        : new Color3(0.34, 0.16, 0.15);
    hullMat.specularColor = new Color3(0.05, 0.05, 0.08);

    // Static base (under mount).
    const base = MeshBuilder.CreateBox(
      "turret_base",
      { width: 5, height: 2.4, depth: 5 },
      scene,
    );
    base.parent = this.mount;
    base.material = hullMat;
    base.isPickable = false;
    this.proceduralMeshes.push(base);

    // Barrel (under the rotating gun node), along +Z. No emissive muzzle tip —
    // the laser bolt spawning at the muzzle is the firing flash.
    const len = GameConfig.mothership.turrets.muzzleForward;
    const barrel = MeshBuilder.CreateBox(
      "turret_barrel",
      { width: 1.4, height: 1.4, depth: len + 2 },
      scene,
    );
    barrel.parent = this.gun;
    barrel.position.set(0, 1.6, (len + 2) / 2);
    barrel.material = hullMat;
    barrel.isPickable = false;
    this.proceduralMeshes.push(barrel);
  }

  // ─── GLB swap ─────────────────────────────────────────────────────────────

  /**
   * Replace the procedural turret with an instance of the shared turret GLB
   * `prefab` (a scaled, disabled template MothershipView loads once). Clones the
   * hierarchy, reparents the static base under `mount` and the rotating
   * `TurretBody` subtree under `gun` (so the clean Y-only `gun` node drives the
   * traverse — sidestepping the glTF root's handedness transform), tints it for
   * the faction, and disposes the procedural boxes.
   *
   * Returns the muzzle fire-point distance (game units, pivot→muzzle in the X/Z
   * plane) measured off the model's `muzzle` empty, for the caller to hand the
   * sim via Turret.setMuzzleData — or null if the model lacks the expected
   * nodes (then the procedural turret stays and the sim keeps its config
   * `muzzleForward`).
   */
  applyModel(prefab: TransformNode): { forward: number; height: number } | null {
    const clone = prefab.instantiateHierarchy(this.mount, {
      doNotInstantiate: true,
    });
    if (!clone) return null;

    const descendants = clone.getDescendants(false);
    const find = (needle: string) =>
      descendants.find((n) => n.name.toLowerCase().includes(needle)) ?? null;
    const baseNode = find("turretbase");
    const bodyNode = find("turretbody");
    const muzzleNode = find("muzzle");
    if (!baseNode || !bodyNode) {
      clone.dispose(false, true);
      return null;
    }

    // Reparent out of the glTF wrapper onto our clean nodes (keepWorldTransform
    // bakes the prefab scale + import orientation into each subtree).
    (bodyNode as TransformNode).setParent(this.gun);
    (baseNode as TransformNode).setParent(this.mount);
    clone.dispose(false, true); // disposes the now-empty __root__ wrapper

    // Collect every mesh under the base + body.
    const meshes: AbstractMesh[] = [];
    for (const node of [baseNode, bodyNode]) {
      node.setEnabled(true);
      const self = node as AbstractMesh;
      if (self.getClassName?.() === "Mesh") meshes.push(self);
      meshes.push(...(node as TransformNode).getChildMeshes(false));
    }
    // Keep the GLB's BAKED skin if it carries one (the per-faction turret
    // texture); only fall back to a flat faction tint for an untextured grey
    // model (e.g. a side whose skinned GLB is missing).
    const textured = meshes.some(
      (m) => m.material != null && m.material.getActiveTextures().length > 0,
    );
    if (!textured) {
      const tint = new StandardMaterial(`turret_glb_${this.faction}`, prefab.getScene());
      tint.diffuseColor =
        this.faction === "humans"
          ? new Color3(0.26, 0.32, 0.44)
          : new Color3(0.36, 0.17, 0.16);
      tint.specularColor = new Color3(0.06, 0.06, 0.1);
      for (const m of meshes) m.material = tint;
    }
    for (const m of meshes) m.isPickable = false;
    this.gun.setEnabled(true);

    // Force the whole transform chain fresh before measuring. applyModel runs
    // pre-first-render, so cached world matrices (root → mount → gun → body →
    // muzzle) may be stale/identity — reading them dirty would corrupt BOTH the
    // distance and the yaw (e.g. a zero muzzle offset → bolts from the pivot).
    const chain: TransformNode[] = [];
    for (
      let n: TransformNode | null = this.mount;
      n;
      n = n.parent as TransformNode | null
    ) {
      chain.unshift(n);
    }
    for (const node of chain) node.computeWorldMatrix(true);
    this.gun.computeWorldMatrix(true);

    // Read the fire point off the `muzzle` empty — the pivot→muzzle planar
    // distance (sim muzzleForward), the muzzle's WORLD HEIGHT (so bolts spawn at
    // the barrel tip, not the turret base), AND the barrel's actual world
    // heading, from which we derive the yaw correction so the VISIBLE barrel
    // always points where the bolt flies. Deriving from the model (not a config
    // constant) is handedness-agnostic — whatever way the glTF import lands the
    // barrel, this cancels it. No bolt/barrel divergence.
    let fire: { forward: number; height: number } | null = null;
    if (muzzleNode) {
      (bodyNode as TransformNode).computeWorldMatrix(true);
      (muzzleNode as TransformNode).computeWorldMatrix(true);
      const c = this.gun.getAbsolutePosition();
      const mzl = (muzzleNode as TransformNode).getAbsolutePosition();
      const dx = mzl.x - c.x;
      const dz = mzl.z - c.z;
      // gun.rotation.y is 0 here, so atan2(dx, dz) is the barrel's world heading
      // at zero aim (sim convention: heading θ → dir (sinθ, cosθ)). Cancel it
      // (minus the carrier facing) so update()'s `aimAngle − carrierRotationY +
      // yawOffset` lands the barrel — and the muzzle — exactly on aimAngle.
      this.yawOffset = this.carrierRotationY - Math.atan2(dx, dz);
      fire = { forward: Math.hypot(dx, dz), height: mzl.y };
    } else {
      this.yawOffset = GameConfig.mothership.turrets.model.yaw;
    }

    for (const m of this.proceduralMeshes) m.dispose(false, true);
    this.proceduralMeshes = [];
    return fire;
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  /**
   * Swing the gun to the sim turret's world aim, and the first frame it reads
   * dead, drop the gun (the static base stays as a charred stump). Called every
   * view frame from MothershipView.syncTurrets().
   */
  update(aimAngle: number, isAlive: boolean): void {
    if (!isAlive) {
      if (!this.deadShown) {
        this.deadShown = true;
        this.gun.setEnabled(false);
      }
      return;
    }
    this.gun.rotation.y = aimAngle - this.carrierRotationY + this.yawOffset;
  }

  dispose(): void {
    this.mount.dispose(false, true);
  }
}
