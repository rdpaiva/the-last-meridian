import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import {
  GameConfig,
  Mothership,
  type Faction,
  type ShipPose,
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
import { buildFighterMesh } from "./FighterMesh";
import { ShipView } from "./view/ShipView";
import { MothershipView } from "./view/MothershipView";
import type { NetClient } from "../net/NetClient";

/** The shape of a replicated ship (decoded from the server schema). */
interface NetShip {
  id: string;
  owner: string;
  faction: Faction;
  shipType: string;
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

/** One rendered remote/local ship: its scene node + a reusable pose object. */
interface ShipEntry {
  view: ShipView;
  pose: {
    position: Vector3;
    rotationY: number;
    bankAngle: number;
    isAlive: boolean;
  };
}

/**
 * The networked client renderer (docs/MULTIPLAYER.md Phase 1 — "dumb client
 * rendering"). It runs NO sim: it builds the scenery + a ShipView per server
 * ship and snaps each to the latest replicated pose every frame, while sampling
 * the local keyboard and shipping InputState to the server. Server-authoritative,
 * so motion looks a touch steppy at low patch rates — interpolation +
 * prediction are Phase 2. Reuses the single-player view stack wholesale; the
 * only thing missing here is transient FX (lasers/explosions), which arrive with
 * Phase 2 event replication.
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

  private readonly ships = new Map<string, ShipEntry>();
  private readonly playerFaction: Faction;

  /** Scratch for camera follow (avoid per-frame allocation). */
  private readonly camPos = new Vector3();
  private readonly camVel = new Vector3();
  private lastPlayerPos = new Vector3();
  private cameraSnapped = false;
  private ended = false;
  private connectionLost = false;

  /** Input send cadence — match the server sim tick (30Hz). */
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

    // --- Carriers (static depiction; live HP comes from the server). The
    // views attach their meshes to the scene, so they need no kept reference;
    // turret animation (syncTurrets) is skipped until turrets are replicated.
    const ms = GameConfig.mothership;
    const humansCarrier = new Mothership(new Vector3(0, ms.yLevel, ms.playerZ), 0, "humans");
    const machinesCarrier = new Mothership(new Vector3(0, ms.yLevel, ms.enemyZ), Math.PI, "machines");
    new MothershipView(this.scene, this.glowLayer, humansCarrier);
    new MothershipView(this.scene, this.glowLayer, machinesCarrier);

    this.cameraRig = new CameraRig(this.scene);
    this.starfield = new Starfield(this.scene, this.cameraRig.camera);
    this.hud = new Hud(hudRoot);
    this.hud.setLaunchOverlay("STAND BY");

    this.input = new InputManager();
    this.input.attach();

    // Surface a dropped connection as an overlay (no auto-reconnect in Phase 1).
    this.net.room.onLeave(() => {
      this.connectionLost = true;
    });
    this.net.room.onError(() => {
      this.connectionLost = true;
    });
  }

  start(): void {
    this.engine.runRenderLoop(this.tick);
  }

  private readonly tick = (): void => {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, GameConfig.scene.maxDeltaSeconds);

    // 1. Sample + send local input, throttled to the server tick rate (sending
    //    every render frame would flood a 144Hz display; the server runs 30Hz).
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

    // 2. Reconcile rendered ships against the replicated state and snap poses.
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

    let playerPos: Vector3 | null = null;
    const seen = new Set<string>();
    state.ships.forEach((s, key) => {
      seen.add(key);
      let entry = this.ships.get(key);
      if (!entry) entry = this.addShip(key, s.faction);
      entry.pose.position.set(s.x, 0, s.z);
      entry.pose.rotationY = s.rotationY;
      entry.pose.bankAngle = s.bankAngle;
      entry.pose.isAlive = s.alive;
      entry.view.update(entry.pose as ShipPose);
      if (s.owner === this.net.sessionId) playerPos = entry.pose.position;
    });
    // Drop views for ships that left the state (rare in Phase 1's fixed roster).
    for (const [key, entry] of this.ships) {
      if (!seen.has(key)) {
        entry.view.dispose();
        this.ships.delete(key);
      }
    }

    // 3. Camera follows our ship (velocity estimated from its motion).
    if (playerPos) {
      this.camPos.copyFrom(playerPos);
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

    // 4. HUD: carrier bars, phase overlay, end banner.
    this.hud.setMothershipHp(
      this.fraction(state.humansMothership),
      this.fraction(state.machinesMothership),
    );
    this.updatePhase(state.phase ?? "launching", state.winner ?? "");

    this.scene.render();
  };

  private addShip(id: string, faction: Faction): ShipEntry {
    const root: TransformNode = buildFighterMesh(this.scene, this.glowLayer, faction);
    const entry: ShipEntry = {
      view: new ShipView(root),
      pose: { position: new Vector3(), rotationY: 0, bankAngle: 0, isAlive: true },
    };
    this.ships.set(id, entry);
    return entry;
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
