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
  lerp,
  wrapAngle,
  type Faction,
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
  owner: string;
  faction: Faction;
  shipType: ShipTypeId;
  x: number;
  z: number;
  rotationY: number;
  bankAngle: number;
  alive: boolean;
}

/** Mutable pose scratch (structurally satisfies the read-only ShipPose). */
interface MutablePose {
  position: Vector3;
  rotationY: number;
  bankAngle: number;
  isAlive: boolean;
}

/** One timestamped server sample of a ship's pose (client arrival clock). */
interface Snap {
  t: number;
  x: number;
  z: number;
  rot: number;
  bank: number;
  alive: boolean;
}

/**
 * Render this far BEHIND the latest server sample, in ms. Interpolating between
 * two already-received samples (instead of chasing the newest) is what makes
 * motion smooth regardless of patch jitter — the price is this much added
 * visual latency. ~2 patch intervals at 20Hz, with slack for arrival jitter.
 */
const INTERP_DELAY_MS = 110;

/**
 * The networked client renderer (docs/MULTIPLAYER.md Phase 1 — "dumb client
 * rendering" + the start of Phase 2's interpolation buffer). Runs NO sim: it
 * buffers timestamped server poses per ship and renders each at
 * `now - INTERP_DELAY_MS`, lerping between the two bracketing samples, so ships
 * move smoothly even though state arrives in 20Hz steps. Samples the local
 * keyboard and ships InputState at 30Hz. Still missing (Phase 2): local-ship
 * prediction, transient FX (lasers/explosions), and sound.
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

  private readonly playerFaction: Faction;

  // Interpolation state, keyed by ship id.
  private readonly snaps = new Map<string, Snap[]>();
  private readonly meta = new Map<string, { faction: Faction; shipType: ShipTypeId }>();
  private readonly views = new Map<string, ShipView>();
  private myKey: string | null = null;

  // Reused per-frame scratch (no allocation in the loop).
  private readonly pose: MutablePose = {
    position: new Vector3(),
    rotationY: 0,
    bankAngle: 0,
    isAlive: true,
  };
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

    // --- Carriers (static depiction; live HP from the server) ---
    const ms = GameConfig.mothership;
    const carriers: Record<Faction, MothershipView> = {
      humans: new MothershipView(
        this.scene,
        this.glowLayer,
        new Mothership(new Vector3(0, ms.yLevel, ms.playerZ), 0, "humans"),
      ),
      machines: new MothershipView(
        this.scene,
        this.glowLayer,
        new Mothership(new Vector3(0, ms.yLevel, ms.enemyZ), Math.PI, "machines"),
      ),
    };
    for (const f of ["humans", "machines"] as Faction[]) {
      const file = GameConfig.mothership.model.file[f];
      if (file) {
        void carriers[f].applyModel(file).then(() => carriers[f].applyTurretModel());
      }
    }

    this.cameraRig = new CameraRig(this.scene);
    this.starfield = new Starfield(this.scene, this.cameraRig.camera);
    this.hud = new Hud(hudRoot);
    this.hud.setLaunchOverlay("STAND BY");

    this.input = new InputManager();
    this.input.attach();
    this.loader = new AssetLoader(this.scene);

    // Buffer a timestamped pose for every ship on each server patch.
    this.net.room.onStateChange((state) => this.recordSnapshot(state));
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

  private async preloadTemplates(): Promise<void> {
    const types = Object.keys(GameConfig.shipTypes) as ShipTypeId[];
    await Promise.all(
      types.map(async (id) => {
        const file = GameConfig.shipTypes[id].model;
        this.templates.set(id, file ? await this.loader.loadModelTemplate(file) : null);
      }),
    );
  }

  /** Capture one pose sample per ship at arrival time (the interpolation feed). */
  private recordSnapshot(state: unknown): void {
    const s = state as { ships?: { forEach: (cb: (v: NetShip, k: string) => void) => void } };
    if (!s.ships) return;
    const t = performance.now();
    s.ships.forEach((ship, key) => {
      if (!this.meta.has(key)) {
        this.meta.set(key, { faction: ship.faction, shipType: ship.shipType });
      }
      if (ship.owner === this.net.sessionId) this.myKey = key;
      let buf = this.snaps.get(key);
      if (!buf) {
        buf = [];
        this.snaps.set(key, buf);
      }
      buf.push({ t, x: ship.x, z: ship.z, rot: ship.rotationY, bank: ship.bankAngle, alive: ship.alive });
      if (buf.length > 40) buf.shift(); // ~2s of history at 20Hz
    });
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

    // 2. Render every ship at (now - delay), interpolated between two samples.
    const renderT = nowMs - INTERP_DELAY_MS;
    let havePlayer = false;
    for (const [key, buf] of this.snaps) {
      if (buf.length === 0) continue;
      let view = this.views.get(key);
      if (!view) view = this.makeView(key);
      this.sampleInto(buf, renderT, this.pose); // writes into this.pose
      view.update(this.pose);
      if (key === this.myKey) {
        this.camPos.copyFrom(this.pose.position);
        havePlayer = true;
      }
    }

    // 3. Camera follows our interpolated ship (smooth pose ⇒ smooth velocity).
    if (havePlayer) {
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

    // 4. HUD straight from current state (HP/phase need no interpolation).
    const state = this.net.room.state as unknown as {
      humansMothership?: { hp: number; maxHp: number };
      machinesMothership?: { hp: number; maxHp: number };
      phase?: string;
      winner?: string;
    };
    if (state?.humansMothership && state.machinesMothership) {
      this.hud.setMothershipHp(
        this.fraction(state.humansMothership),
        this.fraction(state.machinesMothership),
      );
    }
    this.updatePhase(state?.phase ?? "launching", state?.winner ?? "");

    this.scene.render();
  };

  /** Interpolate the buffer at time `t` into `out` (hold the ends; no extrapolation). */
  private sampleInto(buf: Snap[], t: number, out: MutablePose): void {
    const last = buf[buf.length - 1];
    if (t >= last.t) {
      out.position.set(last.x, 0, last.z);
      out.rotationY = last.rot;
      out.bankAngle = last.bank;
      out.isAlive = last.alive;
      return;
    }
    if (t <= buf[0].t) {
      out.position.set(buf[0].x, 0, buf[0].z);
      out.rotationY = buf[0].rot;
      out.bankAngle = buf[0].bank;
      out.isAlive = buf[0].alive;
      return;
    }
    // Find the pair bracketing t (buffers are tiny — a linear scan is fine).
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1];
      const b = buf[i];
      if (a.t <= t && t < b.t) {
        const f = (t - a.t) / (b.t - a.t || 1);
        out.position.set(lerp(a.x, b.x, f), 0, lerp(a.z, b.z, f));
        out.rotationY = a.rot + wrapAngle(b.rot - a.rot) * f;
        out.bankAngle = lerp(a.bank, b.bank, f);
        out.isAlive = a.alive; // discrete; take the earlier sample's state
        return;
      }
    }
  }

  private makeView(key: string): ShipView {
    const m = this.meta.get(key)!;
    const view = new ShipView(this.buildRoot(m.faction, m.shipType));
    this.views.set(key, view);
    return view;
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
