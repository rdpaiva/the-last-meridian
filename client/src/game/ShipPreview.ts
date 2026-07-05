import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// Builds a cube/IBL environment from an equirectangular image — the GLB ships
// use PBR metal materials, which render almost entirely by what they reflect.
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture";
import { AssetLoader } from "./AssetLoader";
import { GameConfig, type ShipTypeId } from "@space-duel/shared";

/**
 * The splash menu's "hangar bay": a small standalone Babylon engine + scene
 * that shows ONE ship GLB at a time on a slow turntable, and renders cached
 * one-frame thumbnails for the ship cards. Deliberately separate from Game's
 * engine — it exists only while the splash is up and is disposed at launch.
 *
 * Design constraints (from the splash UX spec):
 *   - exactly one LIVE 3D view (the selected-ship preview); ship cards get
 *     static data-URL thumbnails captured from the same scene, never their
 *     own render loops;
 *   - models load once each (AssetLoader.loadModelTemplate applies the same
 *     GameConfig.shipModels orientation/scale corrections the game uses) and
 *     are toggled with setEnabled — switching ships is instant after the
 *     first load.
 *
 * The canvas is created here and handed to LoadoutMenu, which re-parents it
 * into the preview panel on every menu re-render (innerHTML rebuilds would
 * otherwise destroy the WebGL context).
 */
export class ShipPreview {
  readonly canvas: HTMLCanvasElement;
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  /** Yaw node the visible ship spins on (camera stays fixed). */
  private readonly turntable: TransformNode;
  private readonly loader: AssetLoader;
  private readonly models = new Map<ShipTypeId, TransformNode>();
  private readonly loads = new Map<ShipTypeId, Promise<TransformNode | null>>();
  private readonly thumbs = new Map<ShipTypeId, string>();
  /** Resolves when the IBL environment texture has loaded — see thumbnail(). */
  private readonly envReady: Promise<void>;
  private current: ShipTypeId | null = null;
  private disposed = false;

  constructor() {
    const cfg = GameConfig.shipPreview;

    this.canvas = document.createElement("canvas");
    this.canvas.id = "ship-preview-canvas";
    // preserveDrawingBuffer lets thumbnail() read the frame back via
    // toDataURL; without it the buffer is cleared before we can copy it.
    this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: true });
    this.scene = new Scene(this.engine);
    // Transparent clear — the CSS hangar glow behind the canvas shows through.
    this.scene.clearColor = new Color4(0, 0, 0, 0);

    this.camera = new ArcRotateCamera(
      "previewCam",
      -Math.PI / 2,
      cfg.cameraBeta,
      8,
      Vector3.Zero(),
      this.scene,
    );

    const hemi = new HemisphericLight("previewHemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = cfg.hemiIntensity;
    hemi.groundColor = new Color3(0.08, 0.08, 0.16);

    const key = new DirectionalLight(
      "previewKey",
      new Vector3(-0.5, -1, 0.45),
      this.scene,
    );
    key.intensity = cfg.keyIntensity;

    // Cool rim from behind/above — the "lit hangar" backlight on the hull.
    const rim = new DirectionalLight(
      "previewRim",
      new Vector3(0.2, -0.35, -1),
      this.scene,
    );
    rim.intensity = cfg.rimIntensity;
    rim.diffuse = new Color3(0.62, 0.6, 1.0);

    // Same IBL source the game scene uses, at a smaller cube size — the PBR
    // metal hulls go flat/dark without an environment to reflect. The onLoad
    // callback gates the card thumbnails: they're captured once and cached
    // forever, so we must not shoot them before the IBL exists (see thumbnail).
    this.envReady = new Promise<void>((resolve) => {
      this.scene.environmentTexture = new EquiRectangularCubeTexture(
        `${import.meta.env.BASE_URL}textures/space-backdrop.jpg`,
        this.scene,
        128,
        undefined,
        undefined,
        () => resolve(),
        () => resolve(), // capture even on error rather than hang forever
      );
    });
    this.scene.environmentIntensity = cfg.environmentIntensity;

    this.turntable = new TransformNode("previewTurntable", this.scene);
    this.loader = new AssetLoader(this.scene);
  }

  /** Begin the idle-rotation render loop (entering the selection screen). */
  start(): void {
    if (this.disposed) return;
    this.engine.stopRenderLoop();
    this.engine.runRenderLoop(this.renderFrame);
  }

  /** Pause rendering (leaving the selection screen) without losing state. */
  stop(): void {
    this.engine.stopRenderLoop();
  }

  private readonly renderFrame = (): void => {
    const dt = this.engine.getDeltaTime() / 1000;
    this.turntable.rotation.y += GameConfig.shipPreview.idleRotationSpeed * dt;
    this.scene.render();
  };

  /** Swap the live preview to `id`, loading its GLB on first use. */
  async show(id: ShipTypeId): Promise<void> {
    this.current = id;
    const node = await this.ensureModel(id);
    // Selection may have moved on (or the splash closed) during the await.
    if (this.disposed || !node || this.current !== id) return;
    this.applyCurrent();
  }

  /**
   * Static card thumbnail for `id` as a data URL, captured once from this
   * scene at a fixed 3/4 pose and cached. Returns null when the type has no
   * GLB (procedural-fallback ships) — the card keeps its CSS placeholder.
   */
  async thumbnail(id: ShipTypeId): Promise<string | null> {
    const cached = this.thumbs.get(id);
    if (cached) return cached;
    const node = await this.ensureModel(id);
    if (this.disposed || !node) return null;

    // The hulls are PBR metal — they render black until the IBL environment
    // (and the model's own materials) finish loading. Capturing before then
    // bakes a blank frame into the permanent cache, which is why the default
    // faction's cards came up empty on a cold load. Wait for both first.
    await this.envReady;
    await this.scene.whenReadyAsync();
    if (this.disposed) return null;
    const recheck = this.thumbs.get(id);
    if (recheck) return recheck;

    // One-frame photo shoot on the live canvas: pose the target alone at the
    // thumbnail yaw, render, read back, then restore the live preview state.
    // Synchronous between awaits, so the render loop never sees the swap.
    const prevYaw = this.turntable.rotation.y;
    this.engine.resize();
    for (const [tid, n] of this.models) n.setEnabled(tid === id);
    this.turntable.rotation.y = GameConfig.shipPreview.thumbnailYaw;
    this.frame(node);
    this.scene.render();
    const url = this.canvas.toDataURL("image/png");
    this.thumbs.set(id, url);

    this.turntable.rotation.y = prevYaw;
    this.applyCurrent();
    return url;
  }

  resize(): void {
    if (!this.disposed) this.engine.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
    this.canvas.remove();
  }

  /** Load-once cache; the template arrives disabled with corrections applied. */
  private ensureModel(id: ShipTypeId): Promise<TransformNode | null> {
    let pending = this.loads.get(id);
    if (!pending) {
      pending = this.loader
        .loadModelTemplate(GameConfig.shipTypes[id].model)
        .then((node) => {
          if (!node) return null;
          if (this.disposed) {
            node.dispose();
            return null;
          }
          node.parent = this.turntable;
          this.models.set(id, node);
          return node;
        });
      this.loads.set(id, pending);
    }
    return pending;
  }

  /** Enable only the current selection and frame the camera on it. */
  private applyCurrent(): void {
    for (const [tid, n] of this.models) n.setEnabled(tid === this.current);
    const cur = this.current ? this.models.get(this.current) : undefined;
    if (cur) this.frame(cur);
  }

  /**
   * Point the camera at the model's height center and back off far enough to
   * cover its bounding diagonal. The turntable spins about the world origin
   * (AssetLoader recenters each model's X/Z pivot), so only Y needs centering.
   */
  private frame(node: TransformNode): void {
    node.computeWorldMatrix(true);
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of node.getChildMeshes(false)) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, bb.minimumWorld);
      max = Vector3.Maximize(max, bb.maximumWorld);
    }
    if (min.x === Infinity) return;
    this.camera.target.set(0, (min.y + max.y) * 0.5, 0);
    this.camera.radius = Math.max(
      max.subtract(min).length() * GameConfig.shipPreview.radiusFactor,
      2,
    );
  }
}
