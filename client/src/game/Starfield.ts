import type { Scene } from "@babylonjs/core/scene";
import type { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
// Registers Scene.createPickingRay (used to measure the camera footprint).
// Without this side-effect import the call throws at runtime. See gotcha #2.
import "@babylonjs/core/Culling/ray";

import { GameConfig } from "@space-duel/shared";

/**
 * Backdrop starfield rendered as two parallax layers of thin-instanced
 * spheres. Each layer is one draw call regardless of star count, so the
 * whole field costs essentially nothing.
 *
 * **Camera-locked wrapping field.** The stars are NOT scattered across the
 * arena — that would force the count (and GPU cost) to scale with arena area.
 * Instead each layer holds a fixed number of stars laid out on a periodic
 * lattice whose period (`tile`) is sized to the camera's on-screen footprint.
 * Every frame `update()` snaps each star to the lattice image nearest the
 * camera, so a star that drifts off one screen edge reappears on the opposite
 * edge. The field reads as infinite while the instance count stays constant
 * no matter how large the world is — the multiplayer-safe design.
 *
 * The wrap is invisible because the wrap boundary (±tile/2 from the camera)
 * is pushed off-screen by `GameConfig.starfield.viewMargin`. The two layers
 * sit at different depths below the play plane (Y < -8); perspective makes the
 * deeper layer drift slower across the screen, which is the parallax that
 * sells the sense of movement as you fly.
 *
 * The active star count is density × visible-area, clamped to `maxCount`. A
 * full `maxCount` buffer is allocated once; only the active slice is rendered
 * (via `thinInstanceCount`), so zooming out keeps density constant up to a
 * hard GPU ceiling.
 */
interface StarLayer {
  mesh: Mesh;
  /** Capacity: matrices/base arrays are sized for this many stars. */
  maxCount: number;
  /** Stars per 10,000 world-units² of field area. */
  density: number;
  yLevel: number;
  /** Per-instance world matrices (scale + rotation baked, translation live). */
  matrices: Float32Array;
  /** Normalized base positions in [0, 1) along X and Z within one tile. */
  baseX: Float32Array;
  baseZ: Float32Array;
  /** World-space wrap period — recomputed from the view footprint. */
  tile: number;
  /** How many stars are currently rendered (density × area, ≤ maxCount). */
  activeCount: number;
}

export class Starfield {
  private readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly layers: StarLayer[] = [];
  /** When true, tile sizes / counts are stale (first frame or after resize). */
  private viewDirty = true;
  /** Camera FOV at last recompute — a change means a zoom, so re-fit. */
  private lastFov = -1;

  constructor(scene: Scene, camera: UniversalCamera) {
    this.scene = scene;
    this.camera = camera;
    const cfg = GameConfig.starfield;

    this.layers.push(
      this.buildLayer({
        name: "starfield_near",
        maxCount: cfg.maxNearCount,
        density: cfg.nearDensity,
        yLevel: cfg.nearY,
        minScale: 0.08,
        maxScale: 0.22,
        color: new Color3(1.0, 1.0, 1.0),
      }),
    );

    this.layers.push(
      this.buildLayer({
        name: "starfield_far",
        maxCount: cfg.maxFarCount,
        density: cfg.farDensity,
        yLevel: cfg.farY,
        minScale: 0.04,
        maxScale: 0.12,
        // Slight blue cast — far stars feel cooler.
        color: new Color3(0.7, 0.78, 0.95),
      }),
    );

    // Footprint depends on viewport size, so recompute the tiles whenever the
    // canvas resizes. Cheap (a few picking rays) and only fires on resize.
    scene.getEngine().onResizeObservable.add(() => {
      this.viewDirty = true;
    });
  }

  private buildLayer(opts: {
    name: string;
    maxCount: number;
    density: number;
    yLevel: number;
    minScale: number;
    maxScale: number;
    color: Color3;
  }): StarLayer {
    const template = MeshBuilder.CreateSphere(
      opts.name,
      { diameter: 1, segments: 4 },
      this.scene,
    );

    const mat = new StandardMaterial(`${opts.name}_mat`, this.scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = opts.color;
    mat.disableLighting = true;
    template.material = mat;
    template.isPickable = false;
    template.receiveShadows = false;
    // The wrapping field is always centered on the camera, so it's always on
    // screen — skip frustum culling (which would also need per-frame bounding
    // refreshes as we rewrite the matrix buffer).
    template.alwaysSelectAsActiveMesh = true;

    // Allocate at capacity (maxCount). Only the active slice renders, but
    // every star gets a baked scale/rotation + base position up front so we
    // can grow the active count on zoom-out without re-generating anything.
    const matrices = new Float32Array(opts.maxCount * 16);
    const baseX = new Float32Array(opts.maxCount);
    const baseZ = new Float32Array(opts.maxCount);

    const scaleScratch = new Vector3();
    const posScratch = new Vector3();
    const rotScratch = Quaternion.Identity();
    const matrixScratch = new Matrix();

    for (let i = 0; i < opts.maxCount; i++) {
      const s = opts.minScale + Math.random() * (opts.maxScale - opts.minScale);
      scaleScratch.set(s, s, s);
      baseX[i] = Math.random();
      baseZ[i] = Math.random();
      // Y carries a little per-star jitter and is fixed for the star's life;
      // only X/Z translation is rewritten each frame by update().
      posScratch.set(0, opts.yLevel + (Math.random() - 0.5) * 1.5, 0);
      Matrix.ComposeToRef(scaleScratch, rotScratch, posScratch, matrixScratch);
      matrixScratch.copyToArray(matrices, i * 16);
    }

    // staticBuffer = false: we rewrite the translation components every frame.
    template.thinInstanceSetBuffer("matrix", matrices, 16, false);

    return {
      mesh: template,
      maxCount: opts.maxCount,
      density: opts.density,
      yLevel: opts.yLevel,
      matrices,
      baseX,
      baseZ,
      tile: 1,
      activeCount: opts.maxCount,
    };
  }

  /**
   * Re-anchor the field on the camera. Each star jumps to the lattice image
   * nearest the camera's focus, so stars wrap seamlessly around the view.
   * Pure arithmetic over the typed arrays — no per-frame allocation.
   */
  update(): void {
    // Re-fit on resize or whenever the camera zooms (FOV changes), which
    // changes the footprint and therefore the density-driven star count.
    if (this.viewDirty || this.camera.fov !== this.lastFov) {
      this.recomputeTiles();
      this.lastFov = this.camera.fov;
      this.viewDirty = false;
    }

    const target = this.camera.getTarget();
    const cx = target.x;
    const cz = target.z;

    for (const layer of this.layers) {
      const { matrices, baseX, baseZ } = layer;
      const count = layer.activeCount;
      const tile = layer.tile;
      const cxOverTile = cx / tile;
      const czOverTile = cz / tile;

      for (let i = 0; i < count; i++) {
        const bx = baseX[i];
        const bz = baseZ[i];
        // Lattice points sit at (base + k) * tile; pick k so the star lands
        // within ±tile/2 of the camera — i.e. its nearest periodic image.
        const wx = (bx + Math.round(cxOverTile - bx)) * tile;
        const wz = (bz + Math.round(czOverTile - bz)) * tile;
        const o = i * 16;
        matrices[o + 12] = wx;
        matrices[o + 14] = wz;
      }

      layer.mesh.thinInstanceBufferUpdated("matrix");
    }
  }

  /**
   * Size each layer's wrap period to the camera's footprint on that layer's
   * Y plane. We unproject the four screen corners onto the plane and take the
   * largest half-extent from the camera's focus, then pad by `viewMargin` so
   * the wrap boundary stays off-screen.
   */
  private recomputeTiles(): void {
    const engine = this.scene.getEngine();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const margin = GameConfig.starfield.viewMargin;
    const target = this.camera.getTarget();
    const corners: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];

    for (const layer of this.layers) {
      let halfX = 1;
      let halfZ = 1;
      for (const [px, py] of corners) {
        const ray = this.scene.createPickingRay(px, py, null, this.camera);
        const dy = ray.direction.y;
        if (Math.abs(dy) < 1e-5) continue;
        const t = (layer.yLevel - ray.origin.y) / dy;
        if (t <= 0) continue;
        const x = ray.origin.x + ray.direction.x * t;
        const z = ray.origin.z + ray.direction.z * t;
        halfX = Math.max(halfX, Math.abs(x - target.x));
        halfZ = Math.max(halfZ, Math.abs(z - target.z));
      }
      const tile = 2 * Math.max(halfX, halfZ) * margin;
      layer.tile = tile;

      // Density × field area, capped. The field spans tile² world units; keep
      // density constant so the sky looks the same at any zoom, up to maxCount.
      const areaIn10k = (tile * tile) / 10000;
      const desired = Math.round(layer.density * areaIn10k);
      layer.activeCount = Math.max(1, Math.min(layer.maxCount, desired));
      layer.mesh.thinInstanceCount = layer.activeCount;
    }
  }
}
