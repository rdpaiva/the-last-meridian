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
// importing here too keeps MothershipView independent of module load order.
import "@babylonjs/loaders/glTF";

import { GameConfig } from "@space-duel/shared";
import { Mothership } from "@space-duel/shared";
import { TurretView } from "./TurretView";

/**
 * Procedural BSG-style carrier/battleship (Galactica silhouette) — the VIEW
 * half of the Mothership/MothershipView split (docs/MULTIPLAYER.md Phase 0).
 * Owns the Babylon scene root + meshes + materials + GLB swap; the gameplay
 * truth (HP, hull footprint, launch geometry) lives in the sim `Mothership`
 * this view depicts. The view reads the sim's static `position`/`rotationY` to
 * place its root once at construction (carriers never move) and, after the GLB
 * loads, feeds the model's launch geometry back to the sim via
 * `setModelLaunchData()`.
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
 */
export class MothershipView {
  readonly root: TransformNode;

  private readonly scene: Scene;
  private readonly glowLayer: GlowLayer;
  private readonly sim: Mothership;

  /**
   * Meshes of the procedural box carrier, captured at construction. Disposed by
   * applyModel() once the GLB takes over (the GLB is a sibling under `root`, so
   * it survives). Empty after a successful model swap.
   */
  private proceduralMeshes: AbstractMesh[] = [];

  /**
   * One depiction per sim turret, parented under `root` (so they ride either
   * the procedural or the swapped-in GLB carrier — they're built AFTER the
   * proceduralMeshes snapshot so applyModel() doesn't dispose them). Index-
   * aligned with `sim.turrets`; syncTurrets() swings each from sim state.
   */
  private readonly turretViews: TurretView[] = [];

  constructor(scene: Scene, glowLayer: GlowLayer, sim: Mothership) {
    this.scene = scene;
    this.glowLayer = glowLayer;
    this.sim = sim;

    const faction = sim.faction;
    this.root = new TransformNode(`mothership_${faction}_root`, scene);
    this.root.position.copyFrom(sim.position);
    this.root.rotation.y = sim.rotationY;

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

    // Turret depictions — built AFTER the snapshot above so the GLB swap leaves
    // them intact. Placed from the SAME config mounts the sim turrets are built
    // from (index-aligned), in carrier-LOCAL coords under `root`.
    const tcfg = GameConfig.mothership.turrets;
    const mounts = tcfg.mounts[faction] ?? [];
    for (const m of mounts) {
      this.turretViews.push(
        new TurretView(
          scene,
          this.root,
          faction,
          m.x,
          m.y ?? tcfg.mountY,
          m.z,
          sim.rotationY,
        ),
      );
    }
  }

  /**
   * Swing every turret barrel to its sim turret's current aim, and drop a
   * destroyed turret to a charred stump. Called each view frame from
   * Game.updateViews (carriers never move, so the body alone needs syncing).
   */
  syncTurrets(): void {
    const turrets = this.sim.turrets;
    for (let i = 0; i < this.turretViews.length; i++) {
      const t = turrets[i];
      if (t) this.turretViews[i].update(t.aimAngle, t.isAlive);
    }
  }

  /**
   * Load the shared turret GLB once and swap every procedural turret on this
   * carrier for an instance of it (static base + rotating gun, faction-tinted).
   * Each view's measured muzzle fire point (pivot→muzzle distance + barrel-tip
   * height — PER TURRET, since GLB-authored mounts can sit at different
   * heights) is fed straight to its index-aligned sim Turret via setMuzzleData
   * so bolts spawn at that barrel's tip. On failure the procedural turrets and
   * the sim's config muzzleForward stay. Awaited from Game.start after the
   * carrier model swap (so mounts are already re-seated from the `turret.*`
   * empties); resolves, never rejects.
   */
  async applyTurretModel(): Promise<void> {
    const cfg = GameConfig.mothership.turrets.model;
    const file = cfg?.file[this.sim.faction];
    if (!cfg || !file || this.turretViews.length === 0) return;
    try {
      const result = await SceneLoader.ImportMeshAsync(
        "",
        `${import.meta.env.BASE_URL}models/`,
        file,
        this.scene,
      );
      // Park the import under a scaled, disabled prefab the views instantiate.
      const prefab = new TransformNode(`turret_prefab_${this.sim.faction}`, this.scene);
      const gltfRoot = result.transformNodes.find((n) => n.name === "__root__");
      if (gltfRoot) {
        gltfRoot.parent = prefab;
      } else {
        for (const m of result.meshes) if (m.parent === null) m.parent = prefab;
      }
      prefab.scaling.setAll(cfg.scale);
      prefab.setEnabled(false);

      const turrets = this.sim.turrets;
      for (let i = 0; i < this.turretViews.length; i++) {
        const fire = this.turretViews[i].applyModel(prefab);
        if (fire !== null && turrets[i]) {
          turrets[i].setMuzzleData(fire.forward, fire.height);
        }
      }
    } catch (err) {
      console.warn(
        `[MothershipView] Failed to load /models/${cfg.file} — keeping the ` +
          `procedural turrets.`,
        err,
      );
    }
  }

  /** Tear down the scene nodes (match end). */
  dispose(): void {
    this.root.dispose(false, true);
  }

  // ─── Detailed model swap (Blender GLB) ────────────────────────────────────

  /**
   * Replace the procedural box carrier with the Blender GLB named by
   * `filename` (GameConfig.mothership.model). Imports the model under a
   * correction node (orientation + scale from config), reads the `launch.*`
   * empties for the bays + the forward extent for the exit distance and feeds
   * both back to the sim, registers the emissive parts with the glow layer,
   * then disposes the procedural meshes. Returns false — and KEEPS the
   * procedural carrier — if the model is disabled in config or fails to load.
   * Always resolves; never rejects. Call once, after construction (Game.start).
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
      const modelRoot = new TransformNode(`ms_model_${this.sim.faction}`, this.scene);
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

      // Read the model's launch geometry and hand it back to the sim (the sim
      // owns launch math; the view only measures it off the loaded mesh).
      this.sim.setModelLaunchData(
        this.captureLaunchMarkers(result.transformNodes),
        this.captureExitDistance(result.meshes),
      );

      // Same for the turret mounts: the GLB's `turret.*` empties re-seat the
      // sim turrets (in place — they're already registered as DamageTargets)
      // AND this view's turret depictions, so mount placement — including
      // HEIGHT, which drives the bolts' downward slope onto the fighter
      // plane — is authored in Blender, not code.
      const turretMounts = this.captureTurretMarkers(result.transformNodes);
      if (turretMounts) {
        this.sim.setModelTurretMounts(turretMounts);
        const n = Math.min(turretMounts.length, this.turretViews.length);
        for (let i = 0; i < n; i++) {
          const m = turretMounts[i];
          this.turretViews[i].setMount(m.x, m.y, m.z);
        }
      }
      this.registerModelGlow(result.meshes);

      // The procedural carrier is now redundant — dispose its meshes. The GLB is
      // a sibling under `root`, so it (and the launch markers we just read) stay.
      for (const m of this.proceduralMeshes) m.dispose(false, true);
      this.proceduralMeshes = [];
      return true;
    } catch (err) {
      console.warn(
        `[MothershipView] Failed to load /models/${filename} — keeping the ` +
          `procedural carrier.`,
        err,
      );
      return false;
    }
  }

  /**
   * Reads the GLB's `launch.*` empties into carrier-LOCAL x/z (the same frame
   * GameConfig.launchBays uses, so the sim's getLaunchStartPosition rotation
   * math is unchanged). Sorted by X for a deterministic port↔starboard bay
   * order regardless of node order in the file. Returns null (keeping the sim's
   * config fallback) if the model authored no launch empties.
   */
  private captureLaunchMarkers(
    nodes: TransformNode[],
  ): ReadonlyArray<{ x: number; z: number }> | null {
    this.root.computeWorldMatrix(true);
    const inv = this.root.getWorldMatrix().clone().invert();
    const pts: { x: number; z: number }[] = [];
    for (const n of nodes) {
      if (!n.name || !n.name.toLowerCase().startsWith("launch")) continue;
      n.computeWorldMatrix(true);
      const p = Vector3.TransformCoordinates(n.getAbsolutePosition(), inv);
      pts.push({ x: p.x, z: p.z });
    }
    if (pts.length === 0) return null;
    pts.sort((a, b) => a.x - b.x);
    return pts;
  }

  /**
   * Reads the GLB's `turret.*` empties into carrier-LOCAL x/y/z — the launch-
   * marker capture, but keeping Y (mount height sets the bolt spawn height and
   * thus the fire slope onto the Y=0 plane). Sorted by x then z so the order is
   * deterministic and matches the config-mount ordering convention (the sim's
   * turrets are index-aligned with GameConfig.mothership.turrets.mounts, whose
   * entries are kept in the same sorted order). Returns null (keeping the
   * config mounts) if the model authored no turret empties. NOTE: matches
   * names STARTING WITH "turret" — the carriers' decorative `*_TurretBarrel_*`
   * meshes don't collide with this (faction prefix), and the turret gun GLB
   * itself is loaded separately (applyTurretModel), never through here.
   */
  private captureTurretMarkers(
    nodes: TransformNode[],
  ): ReadonlyArray<{ x: number; y: number; z: number }> | null {
    this.root.computeWorldMatrix(true);
    const inv = this.root.getWorldMatrix().clone().invert();
    const pts: { x: number; y: number; z: number }[] = [];
    for (const n of nodes) {
      if (!n.name || !n.name.toLowerCase().startsWith("turret")) continue;
      n.computeWorldMatrix(true);
      const p = Vector3.TransformCoordinates(n.getAbsolutePosition(), inv);
      pts.push({ x: p.x, y: p.y, z: p.z });
    }
    if (pts.length === 0) return null;
    pts.sort((a, b) => a.x - b.x || a.z - b.z);
    return pts;
  }

  /**
   * Derives the bow-clearing exit distance from the model's forward (+local Z)
   * extent plus a margin, so a fighter hands back to normal control just after
   * clearing the bow regardless of the model's scale. Local +Z is the launch
   * axis for either carrier (getLaunchForward is the root's facing). Returns
   * null (keeping the sim's procedural fallback) if no finite extent is found.
   */
  private captureExitDistance(meshes: AbstractMesh[]): number | null {
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
    return Number.isFinite(maxZ) ? maxZ + 25 : null;
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

  private makeHullMat(scene: Scene, faction: string): StandardMaterial {
    const mat = new StandardMaterial(`ms_${faction}_hull_mat`, scene);
    mat.diffuseColor = faction === "humans"
      ? new Color3(0.15, 0.20, 0.34)
      : new Color3(0.28, 0.12, 0.12);
    mat.specularColor = new Color3(0.04, 0.04, 0.08);
    return mat;
  }

  private makeAccentMat(scene: Scene, faction: string): StandardMaterial {
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

  private makeLightMat(scene: Scene, faction: string): StandardMaterial {
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
