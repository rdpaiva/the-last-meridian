import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "./GameConfig";
import type { DamageTarget } from "./types";
import type { Faction } from "./Faction";

/**
 * Procedural BSG-style carrier/battleship (Galactica silhouette).
 *
 * Viewed from above the structure is:
 *
 *   [bridge cap]
 *   [== bridge =]
 *   |=== hull ==|   ← central spine (24 wide, 280 long along Z)
 *   [= stern =  ]
 *
 *   ....necks....   ← 4 strut pairs spanning the gap each side
 *
 *   [==== starboard pod (38 wide, 220 long) ====]   x = +65 center
 *   [==== port pod      (38 wide, 220 long) ====]   x = -65 center
 *
 * At rotationY=0 (player) the bow faces world +Z.
 * At rotationY=π (enemy) the bow faces world -Z.
 *
 * The player fighter launches from the STARBOARD pod (local +X side).
 *
 * Implements DamageTarget: it is the match objective. Destroying the opposing
 * faction's mothership wins; losing yours ends the game. Collision uses a
 * single generous X/Z radius (GameConfig.mothership.hitRadius) for the whole
 * ship — per-part hitboxes arrive with the defenses pass.
 */
export class Mothership implements DamageTarget {
  readonly root: TransformNode;
  readonly faction: Faction;

  hp: number = GameConfig.mothership.maxHp;
  readonly maxHp: number = GameConfig.mothership.maxHp;
  readonly hitRadius: number = GameConfig.mothership.hitRadius;

  // Shared geometry constants — used by both build methods and query helpers.
  static readonly HULL_HALF_DEPTH = 140; // half of hull Z length
  static readonly POD_HALF_DEPTH = 110;  // half of pod Z length
  static readonly STARBOARD_X = 65;      // local X center of the starboard pod

  constructor(
    scene: Scene,
    glowLayer: GlowLayer,
    worldPosition: Vector3,
    rotationY: number,
    faction: Faction,
  ) {
    this.faction = faction;
    this.root = new TransformNode(`mothership_${faction}_root`, scene);
    this.root.position.copyFrom(worldPosition);
    this.root.rotation.y = rotationY;

    const hullMat = this.makeHullMat(scene, faction);
    const accentMat = this.makeAccentMat(scene, faction);
    const engineMat = this.makeEngineMat(scene);
    const lightMat = this.makeLightMat(scene, faction);

    this.buildCentralHull(scene, hullMat, accentMat, engineMat, glowLayer);
    this.buildPod(scene, hullMat, accentMat, lightMat, glowLayer, +Mothership.STARBOARD_X, "sb");
    this.buildPod(scene, hullMat, accentMat, lightMat, glowLayer, -Mothership.STARBOARD_X, "pt");
    this.buildNecks(scene, accentMat);
  }

  // ─── DamageTarget ─────────────────────────────────────────────────────────

  /** World-space position (the root's). Used by laser/missile collision. */
  get position(): Vector3 {
    return this.root.position;
  }

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
  }

  // ─── Query helpers ────────────────────────────────────────────────────────

  /**
   * World-space start position inside the starboard launch tube (near the aft
   * wall). Y is forced to 0 so the fighter sits on the gameplay plane.
   * Only meaningful for a player-faction ship (rotationY=0).
   */
  getLaunchStartPosition(): Vector3 {
    const lx = Mothership.STARBOARD_X;
    const lz = -(Mothership.POD_HALF_DEPTH - 30); // 30 units from aft wall
    const sin = Math.sin(this.root.rotation.y);
    const cos = Math.cos(this.root.rotation.y);
    return new Vector3(
      this.root.position.x + cos * lx + sin * lz,
      0,
      this.root.position.z - sin * lx + cos * lz,
    );
  }

  /**
   * World-space Z that the player ship must pass (heading +Z) to have fully
   * cleared the bow. Only valid for rotationY=0 (player mothership).
   */
  getLaunchExitZ(): number {
    // Bridge cap overhangs to roughly localZ = +148; add a margin.
    return this.root.position.z + Mothership.HULL_HALF_DEPTH + 25;
  }

  // ─── Central hull ─────────────────────────────────────────────────────────

  private buildCentralHull(
    scene: Scene,
    hullMat: StandardMaterial,
    accentMat: StandardMaterial,
    engineMat: StandardMaterial,
    glowLayer: GlowLayer,
  ): void {
    const L = GameConfig.mothership.hullLength; // 280
    const HD = Mothership.HULL_HALF_DEPTH;      // 140
    const r = this.root;

    // Main hull box
    const hull = MeshBuilder.CreateBox("ms_hull", { width: 24, height: 6, depth: L }, scene);
    hull.parent = r;
    hull.material = hullMat;
    hull.isPickable = false;

    // Spine ridge on top — gives the hull a raised backbone visible from above.
    const spine = MeshBuilder.CreateBox("ms_spine", { width: 13, height: 2.5, depth: L * 0.9 }, scene);
    spine.position.y = 4.25;
    spine.parent = r;
    spine.material = accentMat;
    spine.isPickable = false;

    // Bridge tower at the bow (+Z end).
    const bridge = MeshBuilder.CreateBox("ms_bridge", { width: 16, height: 10, depth: 28 }, scene);
    bridge.position.set(0, 7, HD - 6);
    bridge.parent = r;
    bridge.material = accentMat;
    bridge.isPickable = false;

    // Narrow cap on top of the bridge.
    const bridgeCap = MeshBuilder.CreateBox("ms_bridge_cap", { width: 8, height: 3.5, depth: 12 }, scene);
    bridgeCap.position.set(0, 13.5, HD + 2);
    bridgeCap.parent = r;
    bridgeCap.material = accentMat;
    bridgeCap.isPickable = false;

    // Reinforced stern block at the aft (-Z) end.
    const stern = MeshBuilder.CreateBox("ms_stern", { width: 20, height: 8, depth: 14 }, scene);
    stern.position.set(0, 0, -HD + 4);
    stern.parent = r;
    stern.material = hullMat;
    stern.isPickable = false;

    // Engine exhausts: 4 glowing amber squares aft of the stern.
    const exhaustXs = [-7.5, -2.5, 2.5, 7.5];
    for (let i = 0; i < exhaustXs.length; i++) {
      const ex = MeshBuilder.CreateBox(`ms_exhaust_${i}`, { width: 3.8, height: 3.8, depth: 2 }, scene);
      ex.position.set(exhaustXs[i], 0, -(HD + 9));
      ex.parent = r;
      ex.material = engineMat;
      ex.isPickable = false;
      glowLayer.addIncludedOnlyMesh(ex);
    }
  }

  // ─── Flight pod ───────────────────────────────────────────────────────────

  private buildPod(
    scene: Scene,
    hullMat: StandardMaterial,
    accentMat: StandardMaterial,
    lightMat: StandardMaterial,
    glowLayer: GlowLayer,
    centerX: number,
    tag: string,
  ): void {
    const PD = Mothership.POD_HALF_DEPTH * 2; // 220
    const r = this.root;

    // Main pod body.
    const pod = MeshBuilder.CreateBox(`ms_pod_${tag}`, { width: 38, height: 5, depth: PD }, scene);
    pod.position.set(centerX, 0, 0);
    pod.parent = r;
    pod.material = hullMat;
    pod.isPickable = false;

    // Armor ridge on top of the pod.
    const ridge = MeshBuilder.CreateBox(`ms_pod_ridge_${tag}`, { width: 20, height: 2.5, depth: PD * 0.88 }, scene);
    ridge.position.set(centerX, 3.75, 0);
    ridge.parent = r;
    ridge.material = accentMat;
    ridge.isPickable = false;

    // Bow end-cap plate.
    const bow = MeshBuilder.CreateBox(`ms_pod_bow_${tag}`, { width: 38, height: 5, depth: 3 }, scene);
    bow.position.set(centerX, 0, Mothership.POD_HALF_DEPTH + 1.5);
    bow.parent = r;
    bow.material = accentMat;
    bow.isPickable = false;

    // Running lights: small emissive cubes along the pod's inner edge.
    const innerX = centerX + (centerX > 0 ? -14 : 14);
    const lightCount = 12;
    const zSpan = PD * 0.84;
    for (let i = 0; i < lightCount; i++) {
      const t = i / (lightCount - 1);
      const lz = -zSpan / 2 + t * zSpan;
      const light = MeshBuilder.CreateBox(
        `ms_pod_light_${tag}_${i}`,
        { width: 0.35, height: 0.35, depth: 0.35 },
        scene,
      );
      light.position.set(innerX, 4, lz);
      light.parent = r;
      light.material = lightMat;
      light.isPickable = false;
      glowLayer.addIncludedOnlyMesh(light);
    }
  }

  // ─── Neck connectors ──────────────────────────────────────────────────────

  private buildNecks(scene: Scene, accentMat: StandardMaterial): void {
    // Hull outer edge at x=±12; pod inner edge at x=±(65−19)=±46.
    // Each neck box spans the full 34-unit gap.
    const neckW = 34;
    const sbCenterX = 12 + neckW / 2;  //  29
    const ptCenterX = -(12 + neckW / 2); // −29

    const neckZs = [-80, -27, +27, +80];

    for (const nz of neckZs) {
      const sb = MeshBuilder.CreateBox(`ms_neck_sb_z${nz}`, { width: neckW, height: 3.5, depth: 9 }, scene);
      sb.position.set(sbCenterX, 0, nz);
      sb.parent = this.root;
      sb.material = accentMat;
      sb.isPickable = false;

      const pt = MeshBuilder.CreateBox(`ms_neck_pt_z${nz}`, { width: neckW, height: 3.5, depth: 9 }, scene);
      pt.position.set(ptCenterX, 0, nz);
      pt.parent = this.root;
      pt.material = accentMat;
      pt.isPickable = false;
    }
  }

  // ─── Materials ────────────────────────────────────────────────────────────

  private makeHullMat(scene: Scene, faction: Faction): StandardMaterial {
    const mat = new StandardMaterial(`ms_${faction}_hull_mat`, scene);
    mat.diffuseColor = faction === "humans"
      ? new Color3(0.15, 0.20, 0.34)
      : new Color3(0.28, 0.12, 0.12);
    mat.specularColor = new Color3(0.04, 0.04, 0.08);
    return mat;
  }

  private makeAccentMat(scene: Scene, faction: Faction): StandardMaterial {
    const mat = new StandardMaterial(`ms_${faction}_accent_mat`, scene);
    mat.diffuseColor = faction === "humans"
      ? new Color3(0.22, 0.30, 0.46)
      : new Color3(0.38, 0.18, 0.15);
    mat.specularColor = new Color3(0.06, 0.06, 0.10);
    return mat;
  }

  private makeEngineMat(scene: Scene): StandardMaterial {
    const mat = new StandardMaterial("ms_engine_mat", scene);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(1.4, 0.7, 0.3); // warm amber, same as capital ships
    mat.disableLighting = true;
    return mat;
  }

  private makeLightMat(scene: Scene, faction: Faction): StandardMaterial {
    const mat = new StandardMaterial(`ms_${faction}_light_mat`, scene);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = faction === "humans"
      ? new Color3(0.7, 0.85, 1.3)   // cool blue-white
      : new Color3(1.2, 0.35, 0.25); // dull red
    mat.disableLighting = true;
    return mat;
  }
}
