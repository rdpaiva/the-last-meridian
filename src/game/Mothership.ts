import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
// Registers the .glb/.gltf loader plugin used by applyModel() to swap the
// procedural carrier for the Blender model. AssetLoader also registers it, but
// importing here too keeps Mothership independent of module load order.
import "@babylonjs/loaders/glTF";

import { GameConfig } from "./GameConfig";
import { MothershipSection } from "./MothershipSection";
import type { DamageTarget } from "./types";
import type { Faction } from "./Faction";
import type { AvoidObstacle } from "./ShipController";

/**
 * Procedural BSG-style carrier/battleship (Galactica silhouette).
 *
 * Viewed from above the structure is:
 *
 *   [conning tower]   ← angular command bridge at the bow; viewport faces +Z
 *   [== decks ===]    ← stacked 2-tier deckhouse amidships (multiple decks)
 *   |=== hull ==|     ← central spine (24 wide, 280 long along Z)
 *   [= stern =  ]
 *
 *   ....necks....   ← 4 strut pairs spanning the gap each side
 *
 *   [==== starboard pod (38 wide, 220 long) ====]   x = +65 center
 *   [==== port pod      (38 wide, 220 long) ====]   x = -65 center
 *
 * Rows of warm amber portholes run the hull flanks, deck sides, and pod outer
 * edges (faction-NEUTRAL "crew aboard" detail); faction color stays on the hull
 * and running lights. The command bridge has a forward-raked glowing viewport
 * band so the crew "looks out onto the battlefield" (the enemy is at +Z).
 *
 * At rotationY=0 (player) the bow faces world +Z.
 * At rotationY=π (enemy) the bow faces world -Z.
 *
 * The player fighter launches from the STARBOARD pod (local +X side).
 *
 * Implements DamageTarget: it is the match objective. Destroying the opposing
 * faction's mothership wins; losing yours ends the game. Collision is per
 * HULL SECTION — world-space axis-aligned rectangles stacked along the keel
 * (`hullSections`, from GameConfig.mothership.hullRects[faction]) that match
 * the visible hull near-exactly. Weapons and the ship keep-out consume the
 * boxes; the AI's circle-based avoidance steers around `avoidanceCircles`
 * (coarse circles derived from the boxes). Damage on any section lands on
 * this one shared HP pool. The legacy single `hitRadius` remains only for
 * the DamageTarget interface.
 */
export class Mothership implements DamageTarget {
  readonly root: TransformNode;
  readonly faction: Faction;

  hp: number = GameConfig.mothership.maxHp;
  readonly maxHp: number = GameConfig.mothership.maxHp;
  /** Legacy single circle — weapons/avoidance use `hullSections` instead. */
  readonly hitRadius: number = GameConfig.mothership.hitRadius;
  /**
   * The solid hull footprint: world-space axis-aligned boxes along the keel
   * (carriers never move and face ±Z, so the rects stay axis-aligned). What
   * lasers/missiles actually test and what ships are bumped out of. Every
   * section forwards its damage here — one HP pool for the whole ship.
   */
  readonly hullSections: ReadonlyArray<MothershipSection>;
  /**
   * Coarse circles circumscribing slices of the hull boxes — what the AI's
   * (circle-only) avoidance pass steers around. Deliberately oversized
   * relative to hullSections: a pilot giving the hull a wide berth looks
   * natural, while weapons stopping in that same phantom space would look
   * broken, which is why steering and damage use different shapes.
   */
  readonly avoidanceCircles: ReadonlyArray<AvoidObstacle>;

  // Shared geometry constants — used by both build methods and query helpers.
  static readonly HULL_HALF_DEPTH = 140; // half of hull Z length
  static readonly POD_HALF_DEPTH = 110;  // half of pod Z length
  static readonly STARBOARD_X = 65;      // local X center of the starboard pod

  private readonly scene: Scene;
  private readonly glowLayer: GlowLayer;

  /**
   * Meshes of the procedural box carrier, captured at construction. Disposed by
   * applyModel() once the GLB takes over (the GLB is a sibling under `root`, so
   * it survives). Empty after a successful model swap.
   */
  private proceduralMeshes: AbstractMesh[] = [];

  /**
   * Launch-bay positions (carrier-LOCAL x/z) read from the GLB's `launch.*`
   * empties, or null while running the procedural carrier (then the query
   * helpers fall back to GameConfig.mothership.launchBays). Set by applyModel().
   */
  private modelLaunchBays: ReadonlyArray<{ x: number; z: number }> | null = null;

  /** Bow-clearing exit distance derived from the GLB's forward extent, or null. */
  private modelExitDistance: number | null = null;

  constructor(
    scene: Scene,
    glowLayer: GlowLayer,
    worldPosition: Vector3,
    rotationY: number,
    faction: Faction,
  ) {
    this.scene = scene;
    this.glowLayer = glowLayer;
    this.faction = faction;
    this.root = new TransformNode(`mothership_${faction}_root`, scene);
    this.root.position.copyFrom(worldPosition);
    this.root.rotation.y = rotationY;

    // Hull footprint rectangles (per-faction — the two carriers are different
    // shapes), rotated into world space once: the carrier is static, so the
    // sections are too. Rects are carrier-local (keel along z, bow = +z,
    // symmetric in x); rotating the two opposite corners and taking min/max
    // gives the world box — exact for the 0/π facings the carriers use.
    const sin = Math.sin(rotationY);
    const cos = Math.cos(rotationY);
    this.hullSections = GameConfig.mothership.hullRects[faction].map((rect) => {
      const ax = worldPosition.x + cos * -rect.halfWidth + sin * rect.z0;
      const az = worldPosition.z - sin * -rect.halfWidth + cos * rect.z0;
      const bx = worldPosition.x + cos * rect.halfWidth + sin * rect.z1;
      const bz = worldPosition.z - sin * rect.halfWidth + cos * rect.z1;
      return new MothershipSection(
        this,
        Math.min(ax, bx),
        Math.max(ax, bx),
        Math.min(az, bz),
        Math.max(az, bz),
      );
    });
    this.avoidanceCircles = this.buildAvoidanceCircles();

    const hullMat = this.makeHullMat(scene, faction);
    const accentMat = this.makeAccentMat(scene, faction);
    const engineMat = this.makeEngineMat(scene);
    const lightMat = this.makeLightMat(scene, faction);
    const windowMat = this.makeWindowMat(scene);
    const viewportMat = this.makeViewportMat(scene);

    this.buildCentralHull(scene, hullMat, engineMat, windowMat, glowLayer);
    this.buildDecks(scene, accentMat, windowMat);
    this.buildBridge(scene, accentMat, viewportMat, windowMat, glowLayer);
    this.buildPod(scene, hullMat, accentMat, lightMat, windowMat, glowLayer, +Mothership.STARBOARD_X, "sb");
    this.buildPod(scene, hullMat, accentMat, lightMat, windowMat, glowLayer, -Mothership.STARBOARD_X, "pt");
    this.buildNecks(scene, accentMat);

    // Snapshot the procedural meshes so applyModel() can dispose them after the
    // GLB loads. The carrier is visible immediately (and is the fallback if the
    // model is missing or fails to load).
    this.proceduralMeshes = this.root.getChildMeshes(true);
  }

  /**
   * Derives the AI steering circles from the hull boxes: each box is split
   * into roughly-square slices along its long axis, each circumscribed by a
   * circle. Coverage is guaranteed (no gap a pilot could thread into a wall
   * — the keep-out bump backstops any residual contact) at the cost of ~40%
   * corner overshoot, which for steering just reads as a healthy berth.
   */
  private buildAvoidanceCircles(): AvoidObstacle[] {
    const owner = this;
    const circles: AvoidObstacle[] = [];
    for (const s of this.hullSections) {
      const halfX = (s.maxX - s.minX) / 2;
      const halfZ = (s.maxZ - s.minZ) / 2;
      const alongZ = halfZ >= halfX;
      const longHalf = alongZ ? halfZ : halfX;
      const shortHalf = alongZ ? halfX : halfZ;
      const n = Math.max(1, Math.ceil(longHalf / Math.max(shortHalf, 1)));
      const sliceHalf = longHalf / n;
      const radius = Math.hypot(shortHalf, sliceHalf);
      for (let i = 0; i < n; i++) {
        const t = -longHalf + sliceHalf * (2 * i + 1);
        circles.push({
          position: {
            x: s.position.x + (alongZ ? 0 : t),
            z: s.position.z + (alongZ ? t : 0),
          },
          radius,
          get isAlive() {
            return owner.isAlive;
          },
        });
      }
    }
    return circles;
  }

  // ─── Detailed model swap (Blender GLB) ────────────────────────────────────

  /**
   * Replace the procedural box carrier with the Blender GLB named by
   * `filename` (GameConfig.mothership.model). Imports the model under a
   * correction node (orientation + scale from config), reads the `launch.*`
   * empties for the bays, registers the emissive parts with the glow layer, then
   * disposes the procedural meshes. Returns false — and KEEPS the procedural
   * carrier — if the model is disabled in config or fails to load. Always
   * resolves; never rejects. Call once, after construction (see Game.start()).
   */
  async applyModel(filename: string): Promise<boolean> {
    const cfg = GameConfig.mothership.model;
    if (!cfg || !filename) return false;
    try {
      // NOTE: trailing slash on rootUrl is required for SceneLoader.
      const result = await SceneLoader.ImportMeshAsync(
        "",
        `${import.meta.env.BASE_URL}models/`,
        filename,
        this.scene,
      );

      // The glTF loader inserts a "__root__" TransformNode (RHS→LHS handling).
      // Park it (or any loose meshes) under a correction node we own.
      const modelRoot = new TransformNode(`ms_model_${this.faction}`, this.scene);
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

      this.captureLaunchMarkers(result.transformNodes);
      this.captureExitDistance(result.meshes);
      this.registerModelGlow(result.meshes);

      // The procedural carrier is now redundant — dispose its meshes. The GLB is
      // a sibling under `root`, so it (and the launch markers we just read) stay.
      for (const m of this.proceduralMeshes) m.dispose(false, true);
      this.proceduralMeshes = [];
      return true;
    } catch (err) {
      console.warn(
        `[Mothership] Failed to load /models/${filename} — keeping the ` +
          `procedural carrier.`,
        err,
      );
      return false;
    }
  }

  /**
   * Reads the GLB's `launch.*` empties into carrier-LOCAL x/z (the same frame
   * GameConfig.launchBays uses, so getLaunchStartPosition's rotation math is
   * unchanged). Sorted by X for a deterministic port↔starboard bay order
   * regardless of node order in the file. No-op (keeps the config fallback) if
   * the model authored no launch empties.
   */
  private captureLaunchMarkers(nodes: TransformNode[]): void {
    this.root.computeWorldMatrix(true);
    const inv = this.root.getWorldMatrix().clone().invert();
    const pts: { x: number; z: number }[] = [];
    for (const n of nodes) {
      if (!n.name || !n.name.toLowerCase().startsWith("launch")) continue;
      n.computeWorldMatrix(true);
      const p = Vector3.TransformCoordinates(n.getAbsolutePosition(), inv);
      pts.push({ x: p.x, z: p.z });
    }
    if (pts.length === 0) return;
    pts.sort((a, b) => a.x - b.x);
    this.modelLaunchBays = pts;
  }

  /**
   * Derives the bow-clearing exit distance from the model's forward (+local Z)
   * extent plus a margin, so a fighter hands back to normal control just after
   * clearing the bow regardless of the model's scale. Local +Z is the launch
   * axis for either carrier (getLaunchForward is the root's facing).
   */
  private captureExitDistance(meshes: AbstractMesh[]): void {
    this.root.computeWorldMatrix(true);
    const inv = this.root.getWorldMatrix().clone().invert();
    let maxZ = -Infinity;
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      for (const corner of m.getBoundingInfo().boundingBox.vectorsWorld) {
        const local = Vector3.TransformCoordinates(corner, inv);
        if (local.z > maxZ) maxZ = local.z;
      }
    }
    if (Number.isFinite(maxZ)) this.modelExitDistance = maxZ + 25;
  }

  /**
   * Adds only the EXTERIOR emissive parts to the GlowLayer — engines, the bridge
   * viewport, and the pod running lights — so they bloom like the procedural build.
   *
   * The recessed LAUNCH-BAY emitters (deck / back wall / ceiling strips) are
   * deliberately NOT registered: the GlowLayer composites emissive over opaque
   * geometry with NO depth test (see EngineGlow.hide()), so a bright glow buried
   * inside a pod bleeds straight through the hull and shows as a phantom bay on
   * the far side. Left off the glow layer they stay normal depth-tested emissive
   * surfaces — visible (lit) only through the actual bay opening, no bleed. Same
   * reasoning the dense window rows use (they'd blow out to white).
   */
  private registerModelGlow(meshes: AbstractMesh[]): void {
    const GLOW = ["engine", "viewport", "runlight"]; // exterior emitters only
    for (const m of meshes) {
      const nm = m.name.toLowerCase();
      if (nm.includes("bay")) continue; // recessed → emissive only, never glow
      if (GLOW.some((g) => nm.includes(g))) this.glowLayer.addIncludedOnlyMesh(m as Mesh);
    }
  }

  // ─── DamageTarget ─────────────────────────────────────────────────────────

  /** World-space position (the root's). Used by laser/missile collision. */
  get position(): Vector3 {
    return this.root.position;
  }

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, _nowMs: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
  }

  // ─── Query helpers ────────────────────────────────────────────────────────

  /**
   * Launch-bay offsets (carrier-LOCAL x/z): the GLB's `launch.*` empties once
   * the model has loaded, else the GameConfig procedural-fallback positions.
   */
  private launchBays(): ReadonlyArray<{ x: number; z: number }> {
    return this.modelLaunchBays ?? GameConfig.mothership.launchBays;
  }

  /** How many catapult launch bays (tubes) this carrier has. */
  getLaunchBayCount(): number {
    return this.launchBays().length;
  }

  /**
   * World-space start position inside launch bay `bayIndex` (wraps if it runs
   * past the available bays). Y is forced to 0 so the fighter sits on the
   * gameplay plane. Works for either carrier — the local bay offset is rotated
   * by the root's facing. Bay positions come from the model's `launch.*` empties
   * (else GameConfig.mothership.launchBays); see launchBays().
   */
  getLaunchStartPosition(bayIndex = 0): Vector3 {
    const bays = this.launchBays();
    const bay = bays[bayIndex % bays.length];
    const sin = Math.sin(this.root.rotation.y);
    const cos = Math.cos(this.root.rotation.y);
    return new Vector3(
      this.root.position.x + cos * bay.x + sin * bay.z,
      0,
      this.root.position.z - sin * bay.x + cos * bay.z,
    );
  }

  /**
   * Unit forward direction (world X/Z) the catapult fires along — the carrier's
   * facing. Humans (rotationY=0) launch toward +Z; machines (rotationY=π) toward
   * -Z. Pairs with getLaunchExitDistance() so the launch works for either side.
   */
  getLaunchForward(): { x: number; z: number } {
    return { x: Math.sin(this.root.rotation.y), z: Math.cos(this.root.rotation.y) };
  }

  /**
   * Distance (world units) along the launch-forward axis, measured from the
   * carrier center, that a fighter must travel to fully clear the bow.
   */
  getLaunchExitDistance(): number {
    // From the model's measured forward extent once loaded; else the procedural
    // hull: bridge cap overhangs to roughly localZ = +148, plus a margin.
    return this.modelExitDistance ?? Mothership.HULL_HALF_DEPTH + 25;
  }

  // ─── Central hull ─────────────────────────────────────────────────────────

  private buildCentralHull(
    scene: Scene,
    hullMat: StandardMaterial,
    engineMat: StandardMaterial,
    windowMat: StandardMaterial,
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

    // Reinforced stern block at the aft (-Z) end.
    const stern = MeshBuilder.CreateBox("ms_stern", { width: 20, height: 8, depth: 14 }, scene);
    stern.position.set(0, 0, -HD + 4);
    stern.parent = r;
    stern.material = hullMat;
    stern.isPickable = false;

    // Engine block: a mount that bridges the stern to the glowing nozzles, so
    // the exhausts read as attached to the hull instead of floating behind it.
    // Its front overlaps the stern (which ends at z=-HD+11=-129 → spans to -143);
    // depth 8 centered at -141 spans -145..-137, so it ties into the stern.
    const mount = MeshBuilder.CreateBox("ms_engine_mount", { width: 19, height: 7, depth: 8 }, scene);
    mount.position.set(0, 0, -(HD + 1));
    mount.parent = r;
    mount.material = hullMat;
    mount.isPickable = false;

    // 4 glowing amber nozzles seated in the mount's aft face (z=-145).
    const exhaustXs = [-7.5, -2.5, 2.5, 7.5];
    for (let i = 0; i < exhaustXs.length; i++) {
      const ex = MeshBuilder.CreateBox(`ms_exhaust_${i}`, { width: 3.8, height: 3.8, depth: 2 }, scene);
      ex.position.set(exhaustXs[i], 0, -(HD + 5));
      ex.parent = r;
      ex.material = engineMat;
      ex.isPickable = false;
      glowLayer.addIncludedOnlyMesh(ex);
    }

    // Portholes down both flanks of the hull (mid-height), bow-to-stern.
    const hullZ = L * 0.42;
    this.addWindowRow(scene, "hull_sb", 12, 1.5, -hullZ, +hullZ, 22, +1, windowMat);
    this.addWindowRow(scene, "hull_pt", -12, 1.5, -hullZ, +hullZ, 22, -1, windowMat);
  }

  // ─── Decks (multi-tier deckhouse) ─────────────────────────────────────────

  /**
   * Stacked superstructure amidships — replaces the old single spine ridge with
   * two stepped tiers so the carrier reads as a multi-deck ship from above and
   * at the launch-intro angle. Each tier carries a porthole row down each flank.
   */
  private buildDecks(
    scene: Scene,
    accentMat: StandardMaterial,
    windowMat: StandardMaterial,
  ): void {
    const r = this.root;

    // Lower deck: wide, long — sits on the hull top (hull top face ≈ y+3).
    const lowZ = 120;
    const low = MeshBuilder.CreateBox("ms_deck_low", { width: 16, height: 4, depth: lowZ }, scene);
    low.position.set(0, 5, -10); // centered slightly aft of midships
    low.parent = r;
    low.material = accentMat;
    low.isPickable = false;
    this.addWindowRow(scene, "deck_low_sb", 8, 5, -lowZ * 0.42, +lowZ * 0.42, 12, +1, windowMat);
    this.addWindowRow(scene, "deck_low_pt", -8, 5, -lowZ * 0.42, +lowZ * 0.42, 12, -1, windowMat);

    // Upper deck: narrower, shorter — stacked on the lower deck.
    const upZ = 70;
    const up = MeshBuilder.CreateBox("ms_deck_up", { width: 10, height: 3, depth: upZ }, scene);
    up.position.set(0, 8.5, -10);
    up.parent = r;
    up.material = accentMat;
    up.isPickable = false;
    this.addWindowRow(scene, "deck_up_sb", 5, 8.5, -upZ * 0.4, +upZ * 0.4, 8, +1, windowMat);
    this.addWindowRow(scene, "deck_up_pt", -5, 8.5, -upZ * 0.4, +upZ * 0.4, 8, -1, windowMat);
  }

  // ─── Command bridge (angular conning tower) ───────────────────────────────

  /**
   * Faceted stepped conning tower at the bow. The forward (+Z) face carries a
   * raked, glowing viewport band — the command center looking out onto the
   * battlefield (the enemy carrier is at +Z). Side faces get porthole rows.
   */
  private buildBridge(
    scene: Scene,
    accentMat: StandardMaterial,
    viewportMat: StandardMaterial,
    windowMat: StandardMaterial,
    glowLayer: GlowLayer,
  ): void {
    const HD = Mothership.HULL_HALF_DEPTH; // 140
    const r = this.root;
    const towerZ = HD - 18; // bridge sits just inboard of the bow

    // Base block (widest tier).
    const base = MeshBuilder.CreateBox("ms_bridge_base", { width: 18, height: 7, depth: 26 }, scene);
    base.position.set(0, 9.5, towerZ);
    base.parent = r;
    base.material = accentMat;
    base.isPickable = false;
    this.addWindowRow(scene, "bridge_base_sb", 9, 9.5, towerZ - 9, towerZ + 9, 5, +1, windowMat);
    this.addWindowRow(scene, "bridge_base_pt", -9, 9.5, towerZ - 9, towerZ + 9, 5, -1, windowMat);

    // Mid tower (narrower).
    const mid = MeshBuilder.CreateBox("ms_bridge_mid", { width: 13, height: 6, depth: 18 }, scene);
    mid.position.set(0, 16, towerZ + 1);
    mid.parent = r;
    mid.material = accentMat;
    mid.isPickable = false;

    // Forward viewport band — raked glass slab on the +Z face, glows.
    const viewport = MeshBuilder.CreateBox("ms_bridge_viewport", { width: 12, height: 3.2, depth: 1.2 }, scene);
    viewport.position.set(0, 16.5, towerZ + 11);
    viewport.rotation.x = -0.35; // rake the glass to look down at the battlefield
    viewport.parent = r;
    viewport.material = viewportMat;
    viewport.isPickable = false;
    glowLayer.addIncludedOnlyMesh(viewport);

    // Small cap + a pair of sensor masts on top.
    const cap = MeshBuilder.CreateBox("ms_bridge_cap", { width: 8, height: 2.5, depth: 10 }, scene);
    cap.position.set(0, 20.5, towerZ + 1);
    cap.parent = r;
    cap.material = accentMat;
    cap.isPickable = false;

    for (const mx of [-3, 3]) {
      const mast = MeshBuilder.CreateBox(`ms_bridge_mast_${mx}`, { width: 0.7, height: 9, depth: 0.7 }, scene);
      mast.position.set(mx, 26, towerZ);
      mast.parent = r;
      mast.material = accentMat;
      mast.isPickable = false;
    }
  }

  // ─── Window helper ────────────────────────────────────────────────────────

  /**
   * Places `count` thin emissive window panels evenly along Z on one side face,
   * at local X = `x` (`faceSign` = +1 starboard / -1 port = which way the flank
   * faces outward). The panels are seated INTO the surface — their lit face is
   * coplanar with the flank (a hair proud to avoid z-fighting) and the rest is
   * recessed into the hull, so they read as inset windows rather than protruding
   * bumps. Emissive-only: the rows are NOT added to the GlowLayer (a dense
   * glowing row blows out to white).
   */
  private addWindowRow(
    scene: Scene,
    tag: string,
    x: number,
    y: number,
    z0: number,
    z1: number,
    count: number,
    faceSign: number,
    windowMat: StandardMaterial,
  ): void {
    const panelThickness = 0.25;        // depth into the hull along the flank normal
    // Center the panel so its outer face sits ~flush with the surface at `x`
    // (0.02 proud), the rest sunk inward — gives the inset-window look.
    const wx = x - faceSign * (panelThickness / 2 - 0.02);
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0.5;
      const wz = z0 + t * (z1 - z0);
      const w = MeshBuilder.CreateBox(`ms_win_${tag}_${i}`, { width: panelThickness, height: 0.7, depth: 0.7 }, scene);
      w.position.set(wx, y, wz);
      w.parent = this.root;
      w.material = windowMat;
      w.isPickable = false;
    }
  }

  // ─── Flight pod ───────────────────────────────────────────────────────────

  private buildPod(
    scene: Scene,
    hullMat: StandardMaterial,
    accentMat: StandardMaterial,
    lightMat: StandardMaterial,
    windowMat: StandardMaterial,
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

    // Warm portholes along the pod's OUTER flank (the inner edge carries the
    // faction running lights above) — distinguishes the two and reads as crew
    // quarters running the length of the pod.
    const outerX = centerX + (centerX > 0 ? 19 : -19);
    const outerSign = centerX > 0 ? +1 : -1;
    this.addWindowRow(scene, `pod_${tag}`, outerX, 1.5, -PD * 0.42, +PD * 0.42, 18, outerSign, windowMat);
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

  /** Warm amber porthole glow — faction-neutral. Shared by all window rows. */
  private makeWindowMat(scene: Scene): StandardMaterial {
    const mat = new StandardMaterial("ms_window_mat", scene);
    const c = GameConfig.mothership.windowColor;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(c.r, c.g, c.b);
    mat.disableLighting = true;
    return mat;
  }

  /** Brighter warm amber for the command-bridge viewport glass (this one glows). */
  private makeViewportMat(scene: Scene): StandardMaterial {
    const mat = new StandardMaterial("ms_viewport_mat", scene);
    const c = GameConfig.mothership.viewportColor;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(c.r, c.g, c.b);
    mat.disableLighting = true;
    return mat;
  }
}
