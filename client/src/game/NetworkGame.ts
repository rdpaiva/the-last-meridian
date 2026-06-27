import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import {
  GameConfig,
  Mothership,
  exponentialDecay,
  wrapAngle,
  type Faction,
  type ShipPose,
  type ShipTypeId,
  MSG,
} from "@space-duel/shared";
import { Arena } from "./Arena";
import { Backdrop } from "./Backdrop";
import { Nebulas } from "./Nebulas";
import { CapitalShips } from "./CapitalShips";
import { Starfield } from "./Starfield";
import { CameraRig } from "./CameraRig";
import { Hud } from "./Hud";
import { InputManager } from "./InputManager";
import { AssetLoader } from "./AssetLoader";
import { buildFighterMesh } from "./FighterMesh";
import { ShipView } from "./view/ShipView";
import { MothershipView } from "./view/MothershipView";
import type { NetClient } from "../net/NetClient";

/** The shape of a replicated ship (decoded from the server schema). */
interface NetShip {
  id: string;
  owner: string;
  faction: Faction;
  shipType: ShipTypeId;
  x: number;
  z: number;
  rotationY: number;
  bankAngle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  launching: boolean;
  isAI: boolean;
}

/**
 * One rendered ship: its scene node + the latest server target + a SMOOTHED
 * render pose. We lerp render→target each frame so positions move continuously
 * instead of snapping at the patch rate (which otherwise jitters the ship and,
 * because the camera follows it, shakes the whole screen). A poor-man's
 * interpolation until Phase 2's proper snapshot buffer + client prediction.
 */
interface ShipEntry {
  view: ShipView;
  tx: number;
  tz: number;
  trot: number;
  tbank: number;
  alive: boolean;
  pose: {
    position: Vector3;
    rotationY: number;
    bankAngle: number;
    isAlive: boolean;
  };
  fresh: boolean; // first frame: snap instead of lerp
}

/** Position/heading smoothing rate (per second). Higher = snappier/jitterier. */
const SMOOTH_RATE = 14;

/**
 * The networked client renderer (docs/MULTIPLAYER.md Phase 1 — "dumb client
 * rendering"). Runs NO sim: builds the scenery + a ShipView per server ship and
 * smooths each toward the latest replicated pose every frame, while sampling the
 * local keyboard and shipping InputState to the server. Server-authoritative;
 * interpolation here is a simple exponential smooth (Phase 2 brings a real
 * snapshot buffer + local prediction, plus transient FX — lasers/explosions —
 * and sound, none of which exist at this phase).
 */
export class NetworkGame {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly glowLayer: GlowLayer;
  private readonly arena: Arena;
  private readonly cameraRig: CameraRig;
  private readonly starfield: Starfield;
  private readonly hud: Hud;
  private readonly input: InputManager;
  private readonly loader: AssetLoader;
  /** Per-ship-type GLB template (null = procedural fallback), cloned per ship. */
  private readonly templates = new Map<ShipTypeId, TransformNode | null>();

  private readonly ships = new Map<string, ShipEntry>();
  private readonly playerFaction: Faction;

  private readonly camPos = new Vector3();
  private readonly camVel = new Vector3();
  private readonly lastPlayerPos = new Vector3();
  private cameraSnapped = false;
  private ended = false;
  private connectionLost = false;

  private static readonly SEND_INTERVAL_MS = 1000 / 30;
  private lastSendMs = 0;

  constructor(
    canvas: HTMLCanvasElement,
    hudRoot: HTMLDivElement,
    private readonly net: NetClient,
    playerFaction: Faction,
  ) {
    this.playerFaction = playerFaction;

    this.engine = new Engine(
      canvas,
      true,
      { preserveDrawingBuffer: false, stencil: false, audioEngine: true },
      true,
    );
    this.engine.setHardwareScalingLevel(1 / window.devicePixelRatio);

    this.scene = new Scene(this.engine);
    (window as unknown as { __BABYLON_SCENE__: Scene }).__BABYLON_SCENE__ = this.scene;
    this.scene.skipPointerMovePicking = true;
    const c = GameConfig.scene.clearColor;
    this.scene.clearColor = new Color4(c.r, c.g, c.b, 1);

    this.glowLayer = new GlowLayer("glow", this.scene, {
      mainTextureRatio: GameConfig.glow.mainTextureRatio,
      blurKernelSize: GameConfig.glow.blurKernelSize,
    });
    this.glowLayer.intensity = GameConfig.glow.intensity;

    // --- Lights + environment (mirrors Game) ---
    const lcfg = GameConfig.lighting;
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = lcfg.hemiIntensity;
    hemi.groundColor = new Color3(lcfg.hemiGround.r, lcfg.hemiGround.g, lcfg.hemiGround.b);
    hemi.diffuse = new Color3(lcfg.hemiSky.r, lcfg.hemiSky.g, lcfg.hemiSky.b);
    const sun = new DirectionalLight(
      "sun",
      new Vector3(lcfg.sunDirection.x, lcfg.sunDirection.y, lcfg.sunDirection.z),
      this.scene,
    );
    sun.intensity = lcfg.sunIntensity;
    sun.diffuse = new Color3(lcfg.sunColor.r, lcfg.sunColor.g, lcfg.sunColor.b);
    this.scene.environmentTexture = new EquiRectangularCubeTexture(
      `${import.meta.env.BASE_URL}textures/space-backdrop.jpg`,
      this.scene,
      256,
    );
    this.scene.environmentIntensity = lcfg.environmentIntensity;

    // --- Scenery ---
    this.arena = new Arena(this.scene);
    new Backdrop(this.scene);
    new Nebulas(this.scene, this.arena.halfWidth, this.arena.halfDepth);
    new CapitalShips(this.scene, this.arena.halfWidth, this.arena.halfDepth, this.glowLayer);

    // --- Carriers (static depiction; live HP comes from the server). The views
    // attach their meshes to the scene, so they need no kept reference; turret
    // animation (syncTurrets) is skipped until turrets are replicated. ---
    const ms = GameConfig.mothership;
    const humansCarrier = new Mothership(new Vector3(0, ms.yLevel, ms.playerZ), 0, "humans");
    const machinesCarrier = new Mothership(new Vector3(0, ms.yLevel, ms.enemyZ), Math.PI, "machines");
    const carrierViews: Record<Faction, MothershipView> = {
      humans: new MothershipView(this.scene, this.glowLayer, humansCarrier),
      machines: new MothershipView(this.scene, this.glowLayer, machinesCarrier),
    };
    // Swap in the carrier GLBs + turret models once they load (procedural box
    // shown until then). Fire-and-forget — purely cosmetic.
    for (const f of ["humans", "machines"] as Faction[]) {
      const file = GameConfig.mothership.model.file[f];
      if (file) {
        void carrierViews[f].applyModel(file).then(() => carrierViews[f].applyTurretModel());
      }
    }

    this.cameraRig = new CameraRig(this.scene);
    this.starfield = new Starfield(this.scene, this.cameraRig.camera);
    this.hud = new Hud(hudRoot);
    this.hud.setLaunchOverlay("STAND BY");

    this.input = new InputManager();
    this.input.attach();
    this.loader = new AssetLoader(this.scene);

    this.net.room.onLeave(() => {
      this.connectionLost = true;
    });
    this.net.room.onError(() => {
      this.connectionLost = true;
    });
  }

  /** Preload the ship GLBs, then start the render loop. */
  async start(): Promise<void> {
    await this.preloadTemplates();
    this.engine.runRenderLoop(this.tick);
  }

  /** Load one GLB template per ship type that has a model (procedural fallback
   *  recorded as null), so addShip clones the right hull synchronously. */
  private async preloadTemplates(): Promise<void> {
    const types = Object.keys(GameConfig.shipTypes) as ShipTypeId[];
    await Promise.all(
      types.map(async (id) => {
        const file = GameConfig.shipTypes[id].model;
        this.templates.set(id, file ? await this.loader.loadModelTemplate(file) : null);
      }),
    );
  }

  private readonly tick = (): void => {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, GameConfig.scene.maxDeltaSeconds);

    // 1. Sample + send local input, throttled to the server tick rate.
    this.input.update();
    const nowMs = performance.now();
    if (
      !this.ended &&
      !this.connectionLost &&
      nowMs - this.lastSendMs >= NetworkGame.SEND_INTERVAL_MS
    ) {
      this.lastSendMs = nowMs;
      this.net.send(MSG.input, { ...this.input.state });
    }

    const state = this.net.room.state as unknown as
      | {
          ships?: { forEach: (cb: (s: NetShip, key: string) => void) => void };
          humansMothership?: { hp: number; maxHp: number };
          machinesMothership?: { hp: number; maxHp: number };
          phase?: string;
          winner?: string;
        }
      | undefined;

    // First frames before the initial patch lands: just render the scenery.
    if (!state || !state.ships || !state.humansMothership || !state.machinesMothership) {
      this.cameraRig.update(dt, this.camPos, this.camVel, 0);
      this.starfield.update();
      this.scene.render();
      return;
    }

    // 2. Pull the latest server targets; create views for new ships.
    let playerEntry: ShipEntry | null = null;
    const seen = new Set<string>();
    const smooth = exponentialDecay(SMOOTH_RATE, dt);
    state.ships.forEach((s, key) => {
      seen.add(key);
      let entry = this.ships.get(key);
      if (!entry) entry = this.addShip(key, s.faction, s.shipType);
      entry.tx = s.x;
      entry.tz = s.z;
      entry.trot = s.rotationY;
      entry.tbank = s.bankAngle;
      entry.alive = s.alive;
      this.smoothShip(entry, smooth);
      entry.view.update(entry.pose as ShipPose);
      if (s.owner === this.net.sessionId) playerEntry = entry;
    });
    for (const [key, entry] of this.ships) {
      if (!seen.has(key)) {
        entry.view.dispose();
        this.ships.delete(key);
      }
    }

    // 3. Camera follows our (smoothed) ship — smooth pose ⇒ smooth velocity.
    if (playerEntry) {
      const p = (playerEntry as ShipEntry).pose.position;
      this.camPos.copyFrom(p);
      if (!this.cameraSnapped) {
        this.cameraRig.snapTo(this.camPos);
        this.lastPlayerPos.copyFrom(this.camPos);
        this.cameraSnapped = true;
      }
      this.camVel.set(
        dt > 0 ? (this.camPos.x - this.lastPlayerPos.x) / dt : 0,
        0,
        dt > 0 ? (this.camPos.z - this.lastPlayerPos.z) / dt : 0,
      );
      this.lastPlayerPos.copyFrom(this.camPos);
    }
    const zoomInput = this.input.state.zoomIn ? 1 : this.input.state.zoomOut ? -1 : 0;
    this.cameraRig.update(dt, this.camPos, this.camVel, zoomInput);
    this.starfield.update();

    // 4. HUD.
    this.hud.setMothershipHp(
      this.fraction(state.humansMothership),
      this.fraction(state.machinesMothership),
    );
    this.updatePhase(state.phase ?? "launching", state.winner ?? "");

    this.scene.render();
  };

  /** Ease the render pose toward the server target (snap on the first frame). */
  private smoothShip(e: ShipEntry, f: number): void {
    if (e.fresh) {
      e.pose.position.set(e.tx, 0, e.tz);
      e.pose.rotationY = e.trot;
      e.pose.bankAngle = e.tbank;
      e.fresh = false;
    } else {
      e.pose.position.x += (e.tx - e.pose.position.x) * f;
      e.pose.position.z += (e.tz - e.pose.position.z) * f;
      e.pose.rotationY += wrapAngle(e.trot - e.pose.rotationY) * f;
      e.pose.bankAngle += (e.tbank - e.pose.bankAngle) * f;
    }
    e.pose.isAlive = e.alive;
  }

  private addShip(id: string, faction: Faction, shipType: ShipTypeId): ShipEntry {
    const root = this.buildRoot(faction, shipType);
    const entry: ShipEntry = {
      view: new ShipView(root),
      tx: 0,
      tz: 0,
      trot: 0,
      tbank: 0,
      alive: true,
      pose: { position: new Vector3(), rotationY: 0, bankAngle: 0, isAlive: true },
      fresh: true,
    };
    this.ships.set(id, entry);
    return entry;
  }

  /** Clone the type's GLB template (two-tier root), else procedural fallback. */
  private buildRoot(faction: Faction, shipType: ShipTypeId): TransformNode {
    const template = this.templates.get(shipType) ?? null;
    if (!template) return buildFighterMesh(this.scene, this.glowLayer, faction);
    const root = new TransformNode(`net_${faction}_${shipType}`, this.scene);
    template.instantiateHierarchy(root, { doNotInstantiate: true });
    root.setEnabled(true);
    for (const n of root.getDescendants()) n.setEnabled(true);
    return root;
  }

  private fraction(ms: { hp: number; maxHp: number }): number {
    return ms.maxHp > 0 ? ms.hp / ms.maxHp : 0;
  }

  private updatePhase(phase: string, winner: string): void {
    if (this.connectionLost) {
      this.hud.setLaunchOverlay("CONNECTION LOST · refresh to rejoin");
      return;
    }
    if (phase === "ended") {
      if (!this.ended) {
        this.ended = true;
        this.hud.setLaunchOverlay(null);
        this.hud.setEndBanner(winner === this.playerFaction ? "victory" : "defeat");
      }
      return;
    }
    this.hud.setLaunchOverlay(phase === "launching" ? "STAND BY" : null);
  }

  handleResize(): void {
    this.engine.resize();
  }

  dispose(): void {
    this.input.detach();
    void this.net.leave();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
