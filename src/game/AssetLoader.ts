import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { GameConfig } from "./GameConfig";

// Side-effect imports.
//   glTF      — registers the .glb / .gltf loader plugin (handles both).
//   builders  — registers MeshBuilder.CreateBox / CreateCylinder /
//               CreateSphere. Without these the fallback ship throws at
//               runtime (sphere is the cockpit canopy).
import "@babylonjs/loaders/glTF";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

/**
 * Per-model orientation + scale lives in `GameConfig.shipModels`, keyed by
 * filename, so spitfire (player) and wraith (enemy) each carry their own
 * correction. The value points the model's nose along the ship's local +Z at
 * fleet scale. All rotations are radians.
 *
 * HOW TO TUNE WHEN A MODEL LOOKS WRONG:
 *
 *   1. Open the dev server with `npm run dev`.
 *   2. Press `I` in the browser to open the Babylon Inspector.
 *   3. In the scene tree, expand `playerShipRoot` → `playerShipModel`
 *      (NOT the outer playerShipRoot — gameplay drives its Y rotation,
 *      so any edits there get overwritten each frame). Enemy clones live
 *      under `fighter_<faction>_root` nodes.
 *   4. Adjust rotation X/Y/Z in the right panel until the booster is
 *      at the back of the ship and the nose points "north" in the
 *      arena. Tweak scaling if the ship is too big or too small.
 *   5. Copy the values into the matching entry in `GameConfig.shipModels`
 *      (note: Inspector shows DEGREES; the config uses RADIANS — multiply
 *      by π/180).
 *
 * Common rotation tries — start here before opening the Inspector:
 *   - Ship facing backwards:   rotY = Math.PI
 *   - Nose points right/left:  rotY = ±Math.PI / 2  (model authored along X)
 *   - Lying on its back/belly: rotX = ∓Math.PI / 2
 *   - Rolled 90° sideways:     rotZ = ±Math.PI / 2
 */
const DEFAULT_CORRECTION = { rotX: 0, rotY: 0, rotZ: 0, scale: 1 };

/** A point in the ship's OUTER-root local frame (same space gameplay uses). */
export type MarkerPoint = { x: number; y: number; z: number };

/**
 * Mount points read from named "empty" nodes authored into the GLB (in Blender:
 * `Add → Empty`, name it, parent to the hull, re-export). Each is expressed in
 * the ship's outer-root frame, so they feed straight into EngineGlow / Ship
 * muzzles / SecondaryThrusters. Empty arrays / undefined = the model defined
 * none, and the consumer falls back to its GameConfig defaults.
 *
 * Naming convention (case-insensitive, Blender `.001` suffixes ignored):
 *   thruster*  → engine glow nozzles (any count)
 *   muzzle*    → laser spawn points (any count)
 *   rcs.nose   → reverse jet; the other two rcs.* are the strafe jets, assigned
 *                port/stbd by their actual X (see extractMarkers) so a 180° yaw
 *                correction or a mislabel can't put them on the wrong side.
 */
export type ModelMarkers = {
  thrusters: MarkerPoint[];
  muzzles: MarkerPoint[];
  rcs: { nose?: MarkerPoint; port?: MarkerPoint; stbd?: MarkerPoint };
};

const EMPTY_MARKERS: ModelMarkers = { thrusters: [], muzzles: [], rcs: {} };

export type LoadedShip = {
  /**
   * TransformNode that gameplay code (PlayerShip) writes to each frame.
   * Its `rotation.y` becomes the ship's facing; never write static model
   * corrections here, they'll be overwritten.
   */
  root: TransformNode;
  /**
   * Inner node holding the static orientation + scale correction. Edit
   * THIS in the Inspector when tuning a new model.
   */
  modelRoot: TransformNode;
  usingFallback: boolean;
  /** Mount points authored into the model (empty when using the fallback). */
  markers: ModelMarkers;
};

export class AssetLoader {
  constructor(private readonly scene: Scene) {}

  /**
   * Attempts to load /models/<GameConfig.player.shipModel> (.glb or .gltf
   * — same loader). If shipModel is null, or the file is missing / fails to
   * load, builds a fallback ship from primitives so the game still runs.
   * Always resolves; never rejects.
   *
   * Returns a TWO-LEVEL node hierarchy:
   *
   *   playerShipRoot   ← outer, gameplay-driven (rotation.y = ship facing)
   *     └ playerShipModel  ← inner, holds fixed alignment corrections
   *         └ [GLB content OR fallback primitives]
   *
   * This separation matters: PlayerShip.update() writes to the outer
   * root's rotation.y every frame, which would clobber any alignment
   * fix if both lived on the same node.
   */
  async loadPlayerShip(): Promise<LoadedShip> {
    const root = new TransformNode("playerShipRoot", this.scene);
    const modelRoot = new TransformNode("playerShipModel", this.scene);
    modelRoot.parent = root;

    const modelFile = GameConfig.player.shipModel;
    if (modelFile) {
      const markers = await this.importInto(modelRoot, modelFile);
      if (markers) {
        return { root, modelRoot, usingFallback: false, markers };
      }
    }

    // No model configured, or the import failed: build a primitive ship.
    // The fallback is oriented +Z forward by construction, so we leave
    // modelRoot at identity rotation/scale (no correction applied).
    this.buildFallbackShip(modelRoot);
    return { root, modelRoot, usingFallback: true, markers: EMPTY_MARKERS };
  }

  /**
   * Loads a GLB into a single TransformNode (with its orientation/scale
   * correction applied) for use as a CLONE TEMPLATE — the enemy fleet
   * instantiates one copy per fighter. The template itself is disabled so it
   * never renders as a stray ship; callers re-enable each clone's subtree.
   *
   * Returns null when `filename` is null or the import fails, so the caller
   * can fall back to a procedural mesh.
   */
  async loadModelTemplate(filename: string | null): Promise<TransformNode | null> {
    if (!filename) return null;
    const modelRoot = new TransformNode(`shipTemplate_${filename}`, this.scene);
    if (await this.importInto(modelRoot, filename)) {
      modelRoot.setEnabled(false);
      return modelRoot;
    }
    modelRoot.dispose();
    return null;
  }

  /**
   * Imports /models/<filename> and parents its content under `modelRoot`,
   * then applies the per-model correction. Returns true on success, false on
   * failure (logged). Shared by the player loader and the clone-template
   * loader so both handle the glTF __root__ and correction identically.
   */
  private async importInto(
    modelRoot: TransformNode,
    filename: string,
  ): Promise<ModelMarkers | null> {
    try {
      // NOTE: trailing slash on rootUrl is required for SceneLoader.
      const result = await SceneLoader.ImportMeshAsync(
        "",
        "/models/",
        filename,
        this.scene,
      );

      // The glTF loader inserts a "__root__" TransformNode at the top to
      // handle right-handed → left-handed conversion. Re-parent it (or any
      // unparented meshes as a fallback) under our model root.
      const gltfRoot = result.transformNodes.find(
        (n) => n.name === "__root__",
      );
      if (gltfRoot) {
        gltfRoot.parent = modelRoot;
      } else {
        for (const mesh of result.meshes) {
          if (mesh.parent === null) {
            mesh.parent = modelRoot;
          }
        }
      }

      // Recenter BEFORE applying the correction: many GLBs are authored with
      // their origin off the hull's center (Kenney's craft_* are far off in
      // X/Z). Gameplay rotates the OUTER root about the model root's origin and
      // the EngineGlow is anchored there, so an off-center origin makes the
      // ship orbit a point beside itself and parks the thruster off to the
      // side. This slides the content so its X/Z centroid sits on the pivot.
      this.recenterPivot(modelRoot, filename);

      this.applyOrientationCorrection(modelRoot, filename);

      // Read mount-point markers in the OUTER-root frame (the parent gameplay
      // drives). At load the outer root is identity, but transforming by its
      // inverse is robust if that ever changes.
      const frame = modelRoot.parent instanceof TransformNode ? modelRoot.parent : modelRoot;
      return this.extractMarkers(result.transformNodes, frame);
    } catch (err) {
      console.warn(
        `[AssetLoader] Failed to load /models/${filename} — using fallback.`,
        err,
      );
      return null;
    }
  }

  /**
   * Collects named "empty" marker nodes from an import and returns their
   * positions in `frame`'s local space. See `ModelMarkers` for the naming
   * convention. RCS strafe jets are assigned to port/stbd by their actual X
   * (min → port, max → stbd), NOT by their `.port`/`.stbd` label, so a model
   * with a 180° yaw correction (which mirrors left↔right) still gets the jets
   * on the correct sides.
   */
  private extractMarkers(
    nodes: TransformNode[],
    frame: TransformNode,
  ): ModelMarkers {
    frame.computeWorldMatrix(true);
    const inv = frame.getWorldMatrix().clone().invert();
    const localPos = (n: TransformNode): MarkerPoint => {
      n.computeWorldMatrix(true);
      const p = Vector3.TransformCoordinates(n.getAbsolutePosition(), inv);
      return { x: p.x, y: p.y, z: p.z };
    };
    // Lowercase and drop Blender's duplicate suffix (".001") for matching.
    const norm = (name: string) => name.toLowerCase().replace(/\.\d+$/, "");

    const thrusters: MarkerPoint[] = [];
    const muzzles: MarkerPoint[] = [];
    const rcsSides: MarkerPoint[] = [];
    const rcs: ModelMarkers["rcs"] = {};

    for (const n of nodes) {
      if (!n.name) continue;
      const nm = norm(n.name);
      if (nm.startsWith("thruster")) thrusters.push(localPos(n));
      else if (nm.startsWith("muzzle")) muzzles.push(localPos(n));
      else if (nm.startsWith("rcs")) {
        if (nm.includes("nose")) rcs.nose = localPos(n);
        else rcsSides.push(localPos(n));
      }
    }

    // Assign strafe jets by position, not label (see method doc).
    rcsSides.sort((a, b) => a.x - b.x);
    if (rcsSides.length >= 1) rcs.port = rcsSides[0];
    if (rcsSides.length >= 2) rcs.stbd = rcsSides[rcsSides.length - 1];

    return { thrusters, muzzles, rcs };
  }

  /**
   * Slides the imported content so its bounding-box center sits on `modelRoot`'s
   * origin in the X/Z (yaw) plane — making the rotation pivot the visual center.
   * Called while `modelRoot` is still at identity (before correction), so its
   * local frame is the content's frame. Y is left as authored so the ship keeps
   * its height above the arena plane.
   */
  private recenterPivot(modelRoot: TransformNode, filename: string): void {
    const meshes = modelRoot.getChildMeshes(false);
    if (meshes.length === 0) return;

    const inv = modelRoot.getWorldMatrix().clone().invert();
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      for (const corner of m.getBoundingInfo().boundingBox.vectorsWorld) {
        const local = Vector3.TransformCoordinates(corner, inv);
        min = Vector3.Minimize(min, local);
        max = Vector3.Maximize(max, local);
      }
    }

    const centerX = (min.x + max.x) * 0.5;
    const centerZ = (min.z + max.z) * 0.5;

    // This is a SAFETY NET, not the intended fix: a model should be authored
    // with its origin at the geometry center (in Blender: Set Origin → Origin
    // to Geometry, then zero the location). When it isn't, the rotation pivot
    // sits beside the hull, so we recenter — but warn so the bad asset gets
    // fixed at the source instead of silently relying on this. Threshold is 1%
    // of the model's footprint, so a correctly-centered model never warns.
    const offCenterX = Math.abs(centerX) > (max.x - min.x) * 0.01;
    const offCenterZ = Math.abs(centerZ) > (max.z - min.z) * 0.01;
    if (offCenterX || offCenterZ) {
      console.warn(
        `[AssetLoader] /models/${filename} is off-center by ` +
          `(${centerX.toFixed(2)}, ${centerZ.toFixed(2)}) in X/Z — recentering ` +
          `at runtime. Fix at the source: center the model's origin in Blender ` +
          `(Set Origin → Origin to Geometry, then zero its location) and re-export.`,
      );
    }

    // Shift every direct child (the glTF __root__, or loose meshes) by the same
    // offset, preserving their relative layout. Their `position` is in
    // modelRoot-local space, which is what we measured the center in.
    for (const child of modelRoot.getChildTransformNodes(true)) {
      child.position.x -= centerX;
      child.position.z -= centerZ;
    }
  }

  private applyOrientationCorrection(
    modelRoot: TransformNode,
    filename: string,
  ): void {
    const c = GameConfig.shipModels[filename] ?? DEFAULT_CORRECTION;
    modelRoot.rotation.x = c.rotX;
    modelRoot.rotation.y = c.rotY;
    modelRoot.rotation.z = c.rotZ;
    modelRoot.scaling.setAll(c.scale);
  }

  /**
   * Dispatches to one of the procedural ship builders based on
   * `GameConfig.player.shipDesign`. Both builders parent their meshes to
   * `modelRoot` and orient the ship nose along the local +Z axis.
   */
  private buildFallbackShip(modelRoot: TransformNode): void {
    if (GameConfig.player.shipDesign === "classic") {
      this.buildClassicShip(modelRoot);
    } else {
      this.buildViperShip(modelRoot);
    }
  }

  /**
   * "classic" — a sleek dart: tapered conical body, two flat wings, a blue
   * glass cockpit dome, and canted wingtip fins. Nose points along +Z.
   *
   * Critical detail: Babylon's CreateCylinder with diameterTop=0 produces a
   * cone with its tip at local +Y; rotating +π/2 around X points it along +Z.
   */
  private buildClassicShip(modelRoot: TransformNode): void {
    const scene = this.scene;

    const body = MeshBuilder.CreateCylinder(
      "fallback_body",
      { height: 1.6, diameterTop: 0, diameterBottom: 0.7, tessellation: 12 },
      scene,
    );
    body.rotation.x = Math.PI / 2; // tip: +Y → +Z
    body.parent = modelRoot;

    const bodyMat = new StandardMaterial("fallback_body_mat", scene);
    bodyMat.diffuseColor = new Color3(0.7, 0.78, 0.92);
    bodyMat.specularColor = new Color3(0.2, 0.2, 0.3);
    body.material = bodyMat;

    // Wings — two flat slabs flanking the body.
    const wingSpec = { width: 0.7, height: 0.08, depth: 0.6 };
    const wingL = MeshBuilder.CreateBox("fallback_wingL", wingSpec, scene);
    wingL.position = new Vector3(-0.55, 0, -0.1);
    wingL.parent = modelRoot;

    const wingR = MeshBuilder.CreateBox("fallback_wingR", wingSpec, scene);
    wingR.position = new Vector3(0.55, 0, -0.1);
    wingR.parent = modelRoot;

    const wingMat = new StandardMaterial("fallback_wing_mat", scene);
    wingMat.diffuseColor = new Color3(0.45, 0.5, 0.65);
    wingMat.specularColor = new Color3(0.1, 0.1, 0.15);
    wingL.material = wingMat;
    wingR.material = wingMat;

    // Engine — small emissive block at the tail (-Z).
    const engine = MeshBuilder.CreateBox(
      "fallback_engine",
      { width: 0.4, height: 0.25, depth: 0.35 },
      scene,
    );
    engine.position = new Vector3(0, 0, -0.7);
    engine.parent = modelRoot;

    const engineMat = new StandardMaterial("fallback_engine_mat", scene);
    engineMat.diffuseColor = new Color3(0.1, 0.1, 0.1);
    engineMat.emissiveColor = new Color3(0.95, 0.55, 0.25);
    engineMat.specularColor = new Color3(0, 0, 0);
    engine.material = engineMat;

    // Cockpit canopy — a low-poly glass dome riding on top of the body,
    // set forward toward the nose. Flattened (low scaling.y) and stretched
    // along +Z so it reads as a fighter canopy rather than a ball. Low
    // segment count keeps the faceted look consistent with the hull.
    const cockpit = MeshBuilder.CreateSphere(
      "fallback_cockpit",
      { diameter: 0.42, segments: 6 },
      scene,
    );
    cockpit.scaling = new Vector3(1, 0.55, 1.4);
    cockpit.position = new Vector3(0, 0.16, 0.15);
    cockpit.parent = modelRoot;

    const cockpitMat = new StandardMaterial("fallback_cockpit_mat", scene);
    cockpitMat.diffuseColor = new Color3(0.05, 0.12, 0.35);
    cockpitMat.emissiveColor = new Color3(0.1, 0.35, 0.85);
    cockpitMat.specularColor = new Color3(0.6, 0.7, 1.0);
    cockpit.material = cockpitMat;

    // Wingtips — small swept fins canting up-and-outward at the leading
    // outer corner of each wing. Wings span to x = ±0.9, so the tips sit
    // there. A slight outward roll (rotation.z) gives them a winglet flair.
    const tipSpec = { width: 0.08, height: 0.32, depth: 0.42 };
    const tipCant = Math.PI / 7;

    const tipL = MeshBuilder.CreateBox("fallback_wingtipL", tipSpec, scene);
    tipL.position = new Vector3(-0.9, 0.12, -0.05);
    tipL.rotation.z = tipCant; // top leans outward (−X)
    tipL.parent = modelRoot;

    const tipR = MeshBuilder.CreateBox("fallback_wingtipR", tipSpec, scene);
    tipR.position = new Vector3(0.9, 0.12, -0.05);
    tipR.rotation.z = -tipCant; // top leans outward (+X)
    tipR.parent = modelRoot;

    const tipMat = new StandardMaterial("fallback_wingtip_mat", scene);
    tipMat.diffuseColor = new Color3(0.08, 0.18, 0.45);
    tipMat.emissiveColor = new Color3(0.06, 0.22, 0.6);
    tipMat.specularColor = new Color3(0.3, 0.4, 0.7);
    tipL.material = tipMat;
    tipR.material = tipMat;
  }

  /**
   * "viper" — a Colonial-Viper-style interceptor: a long tapered nose, a
   * triple-engine cluster at the tail, short swept-back wings with vertical
   * winglets, and a red dorsal stripe. Everything stays low-poly (small
   * tessellation / sphere segments) to match the rest of the scene.
   *
   * Critical detail: Babylon's CreateCylinder with diameterTop=0 produces
   * a cone with its tip at local +Y. To point the tip along +Z we rotate
   * the primitive by +π/2 around the X axis. Plain cylinders (the engine
   * nacelles) get the same +π/2 so their axis runs nose-to-tail.
   */
  private buildViperShip(modelRoot: TransformNode): void {
    const scene = this.scene;

    // Shared materials.
    const hullMat = new StandardMaterial("fallback_hull_mat", scene);
    hullMat.diffuseColor = new Color3(0.72, 0.75, 0.8);
    hullMat.specularColor = new Color3(0.25, 0.25, 0.3);

    const panelMat = new StandardMaterial("fallback_panel_mat", scene);
    panelMat.diffuseColor = new Color3(0.5, 0.53, 0.58);
    panelMat.specularColor = new Color3(0.15, 0.15, 0.2);

    const redMat = new StandardMaterial("fallback_red_mat", scene);
    redMat.diffuseColor = new Color3(0.85, 0.15, 0.1);
    redMat.emissiveColor = new Color3(0.3, 0.03, 0.02);
    redMat.specularColor = new Color3(0.2, 0.1, 0.1);

    const exhaustMat = new StandardMaterial("fallback_exhaust_mat", scene);
    exhaustMat.diffuseColor = new Color3(0.1, 0.1, 0.1);
    exhaustMat.emissiveColor = new Color3(0.95, 0.5, 0.2);
    exhaustMat.specularColor = new Color3(0, 0, 0);

    // Fuselage — one long faceted hull that tapers from a wide tail to a
    // small BLUNT tip at the nose (+Z). The reference Viper noses out to a
    // slender chisel, not a needle and not a bulb: diameterTop 0.14 leaves a
    // tiny flat hex face at the very front (reads as a chamfered chisel from
    // the top-down camera) while the long height keeps the snout long and
    // sleek. Flattened vertically (scaling on the post-rotation Y axis) so
    // the cross-section is a wide wedge, like the real hull, rather than a
    // round tube. Hexagonal cross-section (tessellation 6) keeps the low-poly
    // read; widest at the tail where the engines mount.
    const body = MeshBuilder.CreateCylinder(
      "fallback_body",
      { height: 2.7, diameterTop: 0.14, diameterBottom: 0.82, tessellation: 6 },
      scene,
    );
    body.rotation.x = Math.PI / 2; // axis: +Y → +Z (nose-to-tail)
    // Local Z maps to world Y after the X rotation, so scaling.z flattens the
    // hull vertically into a wedge; scaling.x narrows it a touch.
    body.scaling = new Vector3(0.92, 1, 0.66);
    body.position = new Vector3(0, -0.03, 0.4);
    body.material = hullMat;
    body.parent = modelRoot;

    // Engine cluster — three nacelles at the tail (-Z), each capped with a
    // hot emissive exhaust disk at the very back.
    const nacelleXs = [-0.46, 0, 0.46];
    const nacelleZ = -1.05;
    for (let i = 0; i < nacelleXs.length; i++) {
      const x = nacelleXs[i];

      const nacelle = MeshBuilder.CreateCylinder(
        `fallback_nacelle${i}`,
        { height: 0.85, diameter: 0.46, tessellation: 8 },
        scene,
      );
      nacelle.rotation.x = Math.PI / 2; // axis: +Y → +Z (nose-to-tail)
      nacelle.position = new Vector3(x, -0.02, nacelleZ);
      nacelle.material = panelMat;
      nacelle.parent = modelRoot;

      const exhaust = MeshBuilder.CreateCylinder(
        `fallback_exhaust${i}`,
        { height: 0.08, diameter: 0.4, tessellation: 8 },
        scene,
      );
      exhaust.rotation.x = Math.PI / 2;
      exhaust.position = new Vector3(x, -0.02, nacelleZ - 0.46);
      exhaust.material = exhaustMat;
      exhaust.parent = modelRoot;
    }

    // Cockpit canopy — a low-poly tinted-glass diamond set forward on the
    // spine. segments:4 gives a faceted octahedral look; flattened on Y and
    // stretched along Z so it reads as a canopy, not a ball.
    const cockpit = MeshBuilder.CreateSphere(
      "fallback_cockpit",
      { diameter: 0.42, segments: 4 },
      scene,
    );
    cockpit.scaling = new Vector3(0.95, 0.55, 1.7);
    cockpit.position = new Vector3(0, 0.2, 0.45);
    cockpit.material = (() => {
      const m = new StandardMaterial("fallback_cockpit_mat", scene);
      m.diffuseColor = new Color3(0.05, 0.12, 0.32);
      m.emissiveColor = new Color3(0.1, 0.32, 0.75);
      m.specularColor = new Color3(0.6, 0.7, 1.0);
      return m;
    })();
    cockpit.parent = modelRoot;

    // Dorsal stripe — a flat red centerline PAINTED onto the spine, running
    // from the cockpit out along the nose (as on the reference Viper). Kept
    // razor-thin in height (0.015) and seated flush with the hull's top
    // surface — half-embedded — so it reads as a painted stripe, not a raised
    // fin. The flattened cone's top slopes down toward the chisel tip, so the
    // box is positioned/tilted to follow that slope: its top face sits at
    // ~y 0.16 over the mid-body and ~y 0.04 near the nose.
    const stripe = MeshBuilder.CreateBox(
      "fallback_stripe",
      { width: 0.1, height: 0.015, depth: 1.2 },
      scene,
    );
    stripe.position = new Vector3(0, 0.1, 0.75);
    stripe.rotation.x = 0.083; // matches the hull's nose-down top slope
    stripe.material = redMat;
    stripe.parent = modelRoot;

    // Wings + winglets — short, swept-back slabs near the tail, each tipped
    // with a vertical fin carrying a red stripe. Built per side via a sign
    // factor (-1 = left, +1 = right). Sweep is a Y-rotation that pulls each
    // outboard tip rearward; per CLAUDE.md, +rotationY turns a local +X axis
    // toward -Z, so the right wing sweeps with +angle and the left with -.
    const sweep = 0.5;
    for (const side of [-1, 1] as const) {
      const tag = side < 0 ? "L" : "R";

      const wing = MeshBuilder.CreateBox(
        `fallback_wing${tag}`,
        { width: 0.6, height: 0.07, depth: 0.66 },
        scene,
      );
      wing.position = new Vector3(side * 0.52, -0.08, -0.45);
      wing.rotation.y = side * sweep;
      wing.material = panelMat;
      wing.parent = modelRoot;

      // Winglet rises from the outboard edge (local ∓X) of the wing, canted
      // slightly outward. Parented to the wing so it inherits the sweep.
      const winglet = MeshBuilder.CreateBox(
        `fallback_winglet${tag}`,
        { width: 0.06, height: 0.36, depth: 0.34 },
        scene,
      );
      winglet.position = new Vector3(side * 0.27, 0.18, -0.04);
      winglet.rotation.z = side * 0.18; // top leans outward
      winglet.material = hullMat;
      winglet.parent = wing;

      const wingletStripe = MeshBuilder.CreateBox(
        `fallback_winglet_stripe${tag}`,
        { width: 0.015, height: 0.3, depth: 0.08 },
        scene,
      );
      wingletStripe.position = new Vector3(side * 0.035, 0.0, 0.1);
      wingletStripe.material = redMat;
      wingletStripe.parent = winglet;
    }
  }
}
