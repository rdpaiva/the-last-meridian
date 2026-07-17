import type { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
// Cylinder builder registration — the station's core pylon.
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
// Sphere builder registration — the ownership beacon.
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
// Torus builder registration — the structure ring + the flat dock-radius ring.
import "@babylonjs/core/Meshes/Builders/torusBuilder";

import { GameConfig, FACTION_THEME } from "@space-duel/shared";
import type { CaptureStation, Faction } from "@space-duel/shared";

/**
 * Depiction of ONE capture station — reads the sim CaptureStation's
 * owner/capture state each frame and recolors itself; holds no gameplay
 * truth. Works identically offline (real sim station) and online
 * (NetworkGame's replicated client-side copy).
 *
 * Two-tier like every model in the game: a procedural build (pylon + beacon
 * + ring, plus a flat ring on the fighter plane marking the DOCK RADIUS — the
 * gameplay-legibility piece) that ships immediately, upgraded to the
 * user-authored GLB via tryLoadModel() once `GameConfig.stations.model.file`
 * exists. The dock-radius ring and beacon tinting survive the model swap —
 * they're the state read, the model is the body.
 */
export class StationView {
  private readonly root: TransformNode;
  /** Beacon + ring emissives — retinted per frame from the sim state. */
  private readonly beaconMat: StandardMaterial;
  private readonly ringMat: StandardMaterial;
  private readonly dockRingMat: StandardMaterial;
  /** Procedural body meshes, disposed if/when the GLB swaps in. */
  private proceduralBody: Mesh[] = [];

  /** Scratch color for per-frame lerps (no allocation in update). */
  private readonly colorScratch = new Color3();

  private static readonly NEUTRAL = new Color3(0.45, 0.5, 0.58);
  /**
   * Ownership tint = the faction IDENTITY palette (engine exhaust: the
   * friend-or-foe channel — Commonwealth blue, Novari red; same read as the
   * radar blips and HUD bars). NOT laserEmissive: humans' lasers are canon
   * hot pink, which made a human-owned station read as RED.
   */
  private static factionColor(f: Faction): Color3 {
    const c = FACTION_THEME[f].engineHot;
    return new Color3(c.r * 0.5, c.g * 0.5, c.b * 0.5);
  }

  constructor(
    private readonly scene: Scene,
    private readonly sim: CaptureStation,
  ) {
    this.root = new TransformNode(`station_${sim.id}_root`, scene);
    this.root.position.set(sim.position.x, 0, sim.position.z);

    const hullMat = new StandardMaterial(`station_hull_${sim.id}`, scene);
    hullMat.diffuseColor = new Color3(0.24, 0.27, 0.34);
    hullMat.specularColor = new Color3(0.05, 0.05, 0.08);

    this.beaconMat = new StandardMaterial(`station_beacon_${sim.id}`, scene);
    this.beaconMat.emissiveColor = StationView.NEUTRAL.clone();
    this.beaconMat.diffuseColor = Color3.Black();
    this.beaconMat.disableLighting = true;

    this.ringMat = new StandardMaterial(`station_ring_${sim.id}`, scene);
    this.ringMat.emissiveColor = StationView.NEUTRAL.scale(0.6);
    this.ringMat.diffuseColor = Color3.Black();
    this.ringMat.disableLighting = true;

    this.dockRingMat = new StandardMaterial(`station_dock_${sim.id}`, scene);
    this.dockRingMat.emissiveColor = StationView.NEUTRAL.scale(0.35);
    this.dockRingMat.diffuseColor = Color3.Black();
    this.dockRingMat.disableLighting = true;
    this.dockRingMat.alpha = 0.5;

    this.buildProcedural(hullMat);
    void this.tryLoadModel();
  }

  /** Pylon + beacon + structure ring (body) and the flat dock-radius ring. */
  private buildProcedural(hullMat: StandardMaterial): void {
    const pylon = MeshBuilder.CreateCylinder(
      "station_pylon",
      { diameter: 9, height: 16, tessellation: 6 },
      this.scene,
    );
    pylon.parent = this.root;
    pylon.position.y = 2;
    pylon.material = hullMat;
    pylon.isPickable = false;
    this.proceduralBody.push(pylon);

    const beacon = MeshBuilder.CreateSphere(
      "station_beacon",
      { diameter: 6, segments: 12 },
      this.scene,
    );
    beacon.parent = this.root;
    beacon.position.y = 12;
    beacon.material = this.beaconMat;
    beacon.isPickable = false;
    this.proceduralBody.push(beacon);

    const ring = MeshBuilder.CreateTorus(
      "station_ring",
      { diameter: 24, thickness: 1.2, tessellation: 32 },
      this.scene,
    );
    ring.parent = this.root;
    ring.position.y = 4;
    ring.material = this.ringMat;
    ring.isPickable = false;
    this.proceduralBody.push(ring);

    // The DOCK RADIUS on the fighter plane — the "slow down inside this line
    // to capture" read. NOT part of proceduralBody: it survives a GLB swap.
    const dockRing = MeshBuilder.CreateTorus(
      "station_dock_ring",
      { diameter: this.sim.radius * 2, thickness: 0.8, tessellation: 64 },
      this.scene,
    );
    dockRing.parent = this.root;
    dockRing.position.y = 0;
    dockRing.material = this.dockRingMat;
    dockRing.isPickable = false;
  }

  /**
   * Swap the procedural body for the user-authored station GLB when
   * `GameConfig.stations.model.file` names one (null today — procedural
   * ships first, the model drops in with zero code change later). The
   * beacon/ring materials keep driving ownership color via the GLB meshes
   * whose names contain "beacon"/"ring", if authored; otherwise the tint
   * rides only the dock ring.
   */
  private async tryLoadModel(): Promise<void> {
    const cfg = GameConfig.stations.model;
    if (!cfg.file) return;
    try {
      const result = await SceneLoader.ImportMeshAsync("", "/models/", cfg.file, this.scene);
      const glbRoot = result.meshes[0];
      glbRoot.parent = this.root;
      glbRoot.rotation.set(cfg.rotX, cfg.rotY, cfg.rotZ);
      glbRoot.scaling.setAll(cfg.scale);
      for (const m of result.meshes) {
        m.isPickable = false;
        const name = m.name.toLowerCase();
        if (name.includes("beacon")) m.material = this.beaconMat;
        else if (name.includes("ring")) m.material = this.ringMat;
      }
      for (const m of this.proceduralBody) m.dispose(false, true);
      this.proceduralBody = [];
    } catch (err) {
      console.warn(`[StationView] model ${cfg.file} failed to load — keeping procedural station.`, err);
    }
  }

  /**
   * Per-frame state read: beacon/ring/dock-ring take the OWNER's color
   * (neutral grey unowned); while a flip is in progress they lerp toward the
   * capturing faction's color with the meter; contested flickers the beacon.
   */
  update(nowMs: number): void {
    const st = this.sim;
    const base = st.owner ? StationView.factionColor(st.owner) : StationView.NEUTRAL;
    const c = this.colorScratch;
    c.copyFrom(base);
    if (st.capturingFaction && st.progress > 0) {
      const target = StationView.factionColor(st.capturingFaction);
      const t = Math.min(1, st.progress) * 0.8;
      c.r += (target.r - c.r) * t;
      c.g += (target.g - c.g) * t;
      c.b += (target.b - c.b) * t;
    }
    // Contested: a fast flicker so the fight over the point reads at a glance.
    const flicker = st.contested && Math.floor(nowMs / 160) % 2 === 0 ? 0.35 : 1;
    this.beaconMat.emissiveColor.set(c.r * 1.6 * flicker, c.g * 1.6 * flicker, c.b * 1.6 * flicker);
    this.ringMat.emissiveColor.set(c.r * 0.8, c.g * 0.8, c.b * 0.8);
    this.dockRingMat.emissiveColor.set(c.r * 0.5, c.g * 0.5, c.b * 0.5);
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}
