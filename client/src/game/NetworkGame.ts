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
  FACTION_THEME,
  LaserSystem,
  MissileSystem,
  Ship,
  exponentialMultiplier,
  type Laser,
  type Faction,
  type ShipTypeId,
  type InputState,
  type NetEvent,
  type EventsMessage,
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
import { LaserSystemView } from "./view/LaserSystemView";
import { MissileSystemView } from "./view/MissileSystemView";
import { ExplosionSystem } from "./ExplosionSystem";
import { JumpFlashSystem } from "./JumpFlashSystem";
import { JumpRipple } from "./JumpRipple";
import { SoundSystem } from "./SoundSystem";
import { EngineGlow } from "./EngineGlow";
import { SecondaryThrusters } from "./SecondaryThrusters";
import type { NetClient } from "../net/NetClient";

/** The shape of a replicated ship (decoded from the server schema). */
interface NetShip {
  owner: string;
  faction: Faction;
  shipType: ShipTypeId;
  x: number;
  z: number;
  vx: number;
  vz: number;
  rotationY: number;
  bankAngle: number;
  alive: boolean;
  launching: boolean;
  cannonAmmo: number;
  missileAmmo: number;
  lastInputSeq: number;
}

/** Mutable pose scratch (structurally satisfies the read-only ShipPose). */
interface MutablePose {
  position: Vector3;
  rotationY: number;
  bankAngle: number;
  isAlive: boolean;
}

/** One timestamped server sample of a ship's pose (SERVER sim clock, ms). */
interface Snap {
  t: number;
  x: number;
  z: number;
  rot: number;
  bank: number;
  alive: boolean;
}

// Netcode feel knobs (interp delay, teleport/correction thresholds, rates)
// live in GameConfig.net — read at use sites, never captured at module scope,
// so ConfigOverrides applied at startup are honored.

/**
 * The networked client renderer (docs/MULTIPLAYER.md Phase 1 — "dumb client
 * rendering" + the start of Phase 2's interpolation buffer). Runs NO sim: it
 * buffers timestamped server poses per ship and renders each at
 * `now - INTERP_DELAY_MS`, lerping between the two bracketing samples, so ships
 * move smoothly even though state arrives in 20Hz steps. Samples the local
 * keyboard and ships InputState at 30Hz.
 *
 * Transient FX + sound (Phase 2 event replication): the server relays the
 * sim's SimEventBus facts as batched, sim-timestamped NetEvents (MSG.events);
 * applyFxEvent depicts each one when the render clock reaches its sim time,
 * so muzzle flashes, bolts, explosions and SFX line up with the interpolated
 * poses. Weapon projectiles here are COSMETIC pools — no damage, no
 * collision; hits arrive as events. Still missing (Phase 2): local-ship
 * prediction; hitstop is deliberately absent (freezing the render clock
 * would desync the interpolation timeline).
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
  /**
   * Smoothed estimate of (client wall clock − server sim clock), i.e. what
   * performance.now() reads when the server sim is at time 0, network delay
   * included. Snapshots are timestamped on the SERVER sim clock (state.timeMs)
   * because the sim (30Hz) and patch (20Hz) rates alias — consecutive patches
   * carry alternating 1-or-2 sim ticks of motion, so arrival-time timestamps
   * make apparent ship speed oscillate ±33% at 10Hz (the Phase 1 jitter).
   * This offset maps render wall time onto that sim timeline.
   */
  private clockOffsetMs: number | null = null;
  private readonly meta = new Map<string, { faction: Faction; shipType: ShipTypeId }>();
  private readonly views = new Map<string, ShipView>();
  /**
   * Per-ship engine FX (offline parity: every GLB fighter gets an EngineGlow;
   * procedural fallbacks carry their own emissive engine block). `thrusters`
   * (RCS plumes) exist only on OUR ship — they depict reverse/strafe INPUT,
   * which isn't replicated for remotes. `lastX/lastZ` feed the remote-speed
   * estimate that drives glow intensity (their thrust input isn't on the wire).
   */
  private readonly visuals = new Map<
    string,
    {
      glow: EngineGlow | null;
      thrusters: SecondaryThrusters | null;
      lastX: number;
      lastZ: number;
    }
  >();
  private myKey: string | null = null;

  // ─── Local-ship prediction (Phase 2) ───
  /** The locally simulated own ship (shared Ship math = server parity). */
  private predicted: Ship | null = null;
  private predictionActive = false;
  /** Inputs sent but not yet acked (ShipSchema.lastInputSeq) — the replay set. */
  private readonly pendingInputs: Array<{ seq: number; input: InputState }> = [];
  private inputSeq = 0;
  /** Visual offset hiding sub-snap reconciliation error; decays each frame. */
  private readonly correctionPos = new Vector3();
  private correctionRot = 0;
  /** Own seat's newest authoritative sample (prediction seed + rewind point). */
  private readonly myServer = {
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    rot: 0,
    bank: 0,
    cannonAmmo: 0,
    missileAmmo: 0,
    seq: 0,
    valid: false,
  };
  private myAlive = false;
  private myLaunching = true;

  // ─── Transient FX (Phase 2 event replication) ───
  private readonly sound: SoundSystem;
  private readonly explosions: ExplosionSystem;
  private readonly jumpFlashes: JumpFlashSystem;
  private readonly jumpRipple: JumpRipple;
  /** Cosmetic per-faction projectile pools (no damage/collision — see class doc). */
  private readonly cosmeticLasers: Record<Faction, LaserSystem>;
  private readonly laserViews: Record<Faction, LaserSystemView>;
  private readonly cosmeticMissiles: Record<Faction, MissileSystem>;
  private readonly missileViews: Record<Faction, MissileSystemView>;
  /** Carrier centers (for the mothership death spectacle placement). */
  private readonly carrierCenters: Record<Faction, Vector3>;
  /** Server FX facts awaiting their sim time on the render clock. */
  private readonly fxQueue: Array<{ t: number; e: NetEvent }> = [];
  /** Stable per-ship stubs for SoundSystem's jump-drive clip tracking. */
  private readonly jumpSoundKeys = new Map<string, Ship>();
  private readonly fxVec = new Vector3();
  private lastRenderT = 0;

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
    // DevTools debug handle (docs/PHASE1_OPEN_ISSUES.md): inspect snapshot
    // buffers / clockOffsetMs / camera live while chasing netcode feel.
    (window as unknown as { __netGame: NetworkGame }).__netGame = this;
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
    this.carrierCenters = {
      humans: new Vector3(0, ms.yLevel, ms.playerZ),
      machines: new Vector3(0, ms.yLevel, ms.enemyZ),
    };
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

    // --- Transient FX (Phase 2 event replication): sound + explosions +
    // jump FX + cosmetic projectile pools, driven by applyFxEvent.
    this.sound = new SoundSystem(this.scene);
    this.explosions = new ExplosionSystem(this.scene, this.glowLayer);
    this.jumpFlashes = new JumpFlashSystem(this.scene, this.glowLayer);
    this.jumpRipple = new JumpRipple(this.scene, this.cameraRig.camera);
    this.cosmeticLasers = {
      humans: new LaserSystem({ damage: 0 }),
      machines: new LaserSystem({ damage: 0 }),
    };
    const tb = GameConfig.mothership.turrets.boltEmissive;
    const turretBoltEmissive = new Color3(tb.r, tb.g, tb.b);
    this.laserViews = {
      humans: new LaserSystemView(this.scene, this.cosmeticLasers.humans, {
        emissive: FACTION_THEME.humans.laserEmissive,
        heavyEmissive: FACTION_THEME.humans.laserHeavyEmissive,
        materialName: FACTION_THEME.humans.laserMaterialName,
        turretEmissive: turretBoltEmissive,
      }),
      machines: new LaserSystemView(this.scene, this.cosmeticLasers.machines, {
        emissive: FACTION_THEME.machines.laserEmissive,
        heavyEmissive: FACTION_THEME.machines.laserHeavyEmissive,
        materialName: FACTION_THEME.machines.laserMaterialName,
        turretEmissive: turretBoltEmissive,
      }),
    };
    this.cosmeticMissiles = {
      humans: new MissileSystem({ minDamage: 0, maxDamage: 0 }),
      machines: new MissileSystem({ minDamage: 0, maxDamage: 0 }),
    };
    // Round colors mirror Game's faction-themed missile views.
    this.missileViews = {
      humans: new MissileSystemView(this.scene, this.cosmeticMissiles.humans, {
        bodyColor: new Color3(0.62, 0.66, 0.7),
        finColor: new Color3(0.78, 0.16, 0.16),
        trailEmissive: new Color3(2.2, 0.7, 0.1),
        materialName: "humans_missile_mat",
      }),
      machines: new MissileSystemView(this.scene, this.cosmeticMissiles.machines, {
        bodyColor: new Color3(0.4, 0.38, 0.44),
        finColor: new Color3(0.5, 0.12, 0.14),
        trailEmissive: new Color3(0.5, 2.2, 0.6),
        materialName: "machines_missile_mat",
      }),
    };

    // Queue server FX facts; the tick plays each at its sim time. EXCEPT our
    // own weapon fire: that is depicted PREDICTIVELY at the keypress
    // (updatePrediction) — the server echo would double-render it, and even
    // an immediately-applied echo trails a thrusting ship by a round trip.
    this.net.room.onMessage(MSG.events, (msg: EventsMessage) => {
      for (const e of msg.events) {
        if (
          this.predictionActive &&
          (e.k === "laserFired" || e.k === "missileFired") &&
          e.ship === this.myKey
        ) {
          continue;
        }
        this.fxQueue.push({ t: msg.t, e });
      }
    });

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
    // Loaded + rendering: tell the room we can actually SEE the battlefield.
    // The first ready in a room releases the opening fleet launch.
    this.net.send(MSG.ready, {});
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

  /** Capture one pose sample per ship, timestamped on the server sim clock. */
  private recordSnapshot(state: unknown): void {
    const s = state as {
      timeMs?: number;
      ships?: { forEach: (cb: (v: NetShip, k: string) => void) => void };
    };
    if (!s.ships) return;
    const t = s.timeMs ?? 0;

    // Track the wall↔sim clock offset. EMA so per-patch arrival jitter doesn't
    // wobble the render clock; hard resync on a big jump (first patch, hitch,
    // or a tab that was backgrounded).
    const offsetSample = performance.now() - t;
    if (this.clockOffsetMs === null || Math.abs(offsetSample - this.clockOffsetMs) > 250) {
      this.clockOffsetMs = offsetSample;
    } else {
      this.clockOffsetMs += (offsetSample - this.clockOffsetMs) * 0.05;
    }

    s.ships.forEach((ship, key) => {
      if (!this.meta.has(key)) {
        this.meta.set(key, { faction: ship.faction, shipType: ship.shipType });
      }
      if (ship.owner === this.net.sessionId) this.myKey = key;
      if (key === this.myKey) {
        // Own seat: capture the authoritative sample for prediction and fold
        // it in immediately (rewind + replay happens on arrival, not render).
        this.myServer.x = ship.x;
        this.myServer.z = ship.z;
        this.myServer.vx = ship.vx;
        this.myServer.vz = ship.vz;
        this.myServer.rot = ship.rotationY;
        this.myServer.bank = ship.bankAngle;
        this.myServer.cannonAmmo = ship.cannonAmmo;
        this.myServer.missileAmmo = ship.missileAmmo;
        this.myServer.seq = ship.lastInputSeq;
        this.myServer.valid = true;
        this.myAlive = ship.alive;
        this.myLaunching = ship.launching;
        if (this.predictionActive) this.reconcile();
      }
      let buf = this.snaps.get(key);
      if (!buf) {
        buf = [];
        this.snaps.set(key, buf);
      }
      // A patch can arrive without a sim step in between — same sim time,
      // same pose. Skip it; a zero-dt pair would corrupt interpolation.
      const prev = buf.length > 0 ? buf[buf.length - 1] : null;
      if (prev && prev.t >= t) return;
      // Teleport (jump drive / respawn): duplicate the arrival pose just after
      // the departure sample so interpolation POPS across the discontinuity
      // instead of streaking the ship across the map for a patch interval.
      if (prev && Math.hypot(ship.x - prev.x, ship.z - prev.z) > GameConfig.net.teleportSnapUnits) {
        buf.push({ t: prev.t + 1, x: ship.x, z: ship.z, rot: ship.rotationY, bank: ship.bankAngle, alive: ship.alive });
        // The exhaust trail is NOT parented to the ship root — flush it or the
        // teleport (jump/respawn) drags a streak across the whole map.
        this.visuals.get(key)?.glow?.resetTrails();
      }
      buf.push({ t, x: ship.x, z: ship.z, rot: ship.rotationY, bank: ship.bankAngle, alive: ship.alive });
      if (buf.length > 40) buf.shift(); // ~2s of history at 20Hz
    });
  }

  private readonly tick = (): void => {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, GameConfig.scene.maxDeltaSeconds);

    // 1. Sample + send local input, throttled to the server tick rate.
    this.input.update();
    // Audio unlock rides the first real input gesture (mirrors Game.tick).
    const held = this.input.state;
    if (held.thrust || held.reverse || held.rotateLeft || held.rotateRight || held.fire) {
      this.sound.unlock();
    }
    const nowMs = performance.now();
    if (
      !this.ended &&
      !this.connectionLost &&
      nowMs - this.lastSendMs >= NetworkGame.SEND_INTERVAL_MS
    ) {
      this.lastSendMs = nowMs;
      const input = { ...this.input.state };
      const seq = ++this.inputSeq;
      this.net.send(MSG.input, { seq, input });
      if (this.predictionActive) {
        this.pendingInputs.push({ seq, input });
        if (this.pendingInputs.length > GameConfig.net.maxPendingInputs) {
          this.pendingInputs.shift();
        }
      }
    }

    // 1.5 Local-ship prediction: fly our own ship on this frame's input.
    this.updatePrediction(dt);

    // 2. Render every ship at (sim time - delay), interpolated between two
    // samples. clockOffsetMs maps our wall clock onto the server sim clock;
    // until the first patch sets it there are no snapshots to render anyway.
    const renderT = nowMs - (this.clockOffsetMs ?? 0) - GameConfig.net.interpDelayMs;
    this.lastRenderT = renderT;
    let havePlayer = false;
    for (const [key, buf] of this.snaps) {
      if (buf.length === 0) continue;
      let view = this.views.get(key);
      if (!view) view = this.makeView(key);
      if (key === this.myKey && this.predictionActive && this.predicted) {
        // Own ship: the locally predicted pose (immediate input response),
        // plus the decaying correction offset that hides reconciliation.
        this.pose.position.set(
          this.predicted.position.x + this.correctionPos.x,
          0,
          this.predicted.position.z + this.correctionPos.z,
        );
        this.pose.rotationY = this.predicted.rotationY + this.correctionRot;
        this.pose.bankAngle = this.predicted.bankAngle;
        this.pose.isAlive = true;
      } else {
        this.sampleInto(buf, renderT, this.pose); // writes into this.pose
      }
      view.update(this.pose);
      this.updateEngineFx(key, dt);
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

    // 3.5 Transient FX: play each queued server fact once the render clock
    // reaches its sim time (aligning FX with the interpolated poses), then
    // advance the cosmetic projectile pools + one-shot FX systems.
    while (this.fxQueue.length > 0 && this.fxQueue[0].t <= renderT) {
      this.applyFxEvent(this.fxQueue.shift()!.e);
    }
    const dtMs = dt * 1000;
    for (const f of ["humans", "machines"] as Faction[]) {
      this.cosmeticLasers[f].update(dt, dtMs, nowMs);
      this.laserViews[f].update();
      this.cosmeticMissiles[f].update(dt, dtMs, nowMs);
      this.missileViews[f].update();
    }
    this.explosions.update(dt, dtMs);
    this.jumpFlashes.update(dtMs);
    this.jumpRipple.update(dtMs);
    // Engine hum tracks our glow's smoothed intensity (offline parity),
    // falling back to raw thrust before the visuals exist.
    const ownGlow = this.myKey !== null ? this.visuals.get(this.myKey)?.glow : null;
    this.sound.updateEngine(
      dt,
      ownGlow?.currentIntensity ?? (this.input.state.thrust ? 1 : 0),
    );

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

  /**
   * Depict one replicated sim fact — the MP mirror of Game.wireSimEventFeedback.
   * Deliberate differences from offline: no hitstop (freezing the render clock
   * would desync the interpolation timeline) and no kill/score bookkeeping yet.
   */
  private applyFxEvent(e: NetEvent): void {
    const shake = GameConfig.shake;
    switch (e.k) {
      case "laserFired": {
        const meta = this.meta.get(e.ship);
        if (!meta || e.mx.length === 0) return;
        const type = GameConfig.shipTypes[meta.shipType];
        for (let i = 0; i < e.mx.length; i++) {
          this.fxVec.set(e.mx[i], 0, e.mz[i]);
          this.cosmeticLasers[meta.faction].spawn(this.fxVec, e.rot, null, 0, false, 0, type.heavy);
        }
        this.fxVec.set(e.mx[0], 0, e.mz[0]);
        this.sound.playFireSound(type.fireSound, e.ship === this.myKey ? undefined : this.fxVec);
        return;
      }
      case "missileFired": {
        const meta = this.meta.get(e.ship);
        const pose = this.poseOf(e.ship);
        if (!meta || !pose) return;
        // The cosmetic round flies ballistic from the shooter's rendered pose
        // (the lock isn't on the wire); the missileHit event detonates it.
        // Same nose offset as Ship.tryFireMissile — the server's round leaves
        // from ahead of the hull, not the ship's center.
        const off = GameConfig.missile.spawnOffset;
        this.fxVec.set(
          pose.position.x + Math.sin(pose.rotationY) * off,
          0,
          pose.position.z + Math.cos(pose.rotationY) * off,
        );
        this.cosmeticMissiles[meta.faction].spawn(this.fxVec, pose.rotationY, null, null);
        this.sound.playMissileLaunch(e.ship === this.myKey ? undefined : this.fxVec);
        return;
      }
      case "laserHit": {
        this.fxVec.set(e.x, e.y, e.z);
        this.sound.playHit(this.fxVec);
        this.explosions.spawnSpark(this.fxVec);
        this.killNearestBolt(e.x, e.z);
        if (this.myKey !== null && e.target === this.myKey) {
          this.cameraRig.addTrauma(shake.traumaPlayerLaserHit);
        } else if (this.myKey !== null && e.shooter === this.myKey) {
          this.cameraRig.addTrauma(shake.traumaEnemyLaserHit);
        }
        return;
      }
      case "missileHit":
      case "missileIntercepted": {
        this.fxVec.set(e.x, e.y, e.z);
        this.explosions.spawn(this.fxVec);
        this.sound.playExplosion(this.fxVec);
        this.killNearestMissile(e.x, e.z);
        if (e.k === "missileHit" && this.myKey !== null && e.target === this.myKey) {
          this.cameraRig.addTrauma(shake.traumaPlayerMissileHit);
        } else {
          this.cameraRig.addTrauma(this.traumaAtDistance(shake.traumaMissileHit, e.x, e.z));
        }
        return;
      }
      case "shipLaunched": {
        if (e.ship === this.myKey) {
          this.cameraRig.addTrauma(GameConfig.launch.launchTrauma);
        } else {
          const pose = this.poseOf(e.ship);
          if (pose) {
            this.cameraRig.addTrauma(
              this.traumaAtDistance(GameConfig.launch.launchTrauma, pose.position.x, pose.position.z),
            );
          }
        }
        return;
      }
      case "shipDied": {
        this.fxVec.set(e.x, 0, e.z);
        // Destroyed mid-spool: cut its jump-drive clip (no-op otherwise).
        this.sound.stopJumpDrive(this.jumpKey(e.ship));
        this.explosions.spawn(this.fxVec);
        this.sound.playExplosion(this.fxVec);
        this.cameraRig.addTrauma(
          e.ship === this.myKey
            ? shake.traumaPlayerExplosion
            : this.traumaAtDistance(shake.traumaEnemyExplosion, e.x, e.z),
        );
        return;
      }
      case "mothershipDied": {
        const cfg = GameConfig.mothership;
        const center = this.carrierCenters[e.faction];
        for (let i = 0; i < cfg.deathExplosionCount; i++) {
          this.fxVec.set(
            center.x + (Math.random() * 2 - 1) * cfg.deathExplosionSpread,
            center.y,
            center.z + (Math.random() * 2 - 1) * cfg.deathExplosionSpread,
          );
          this.explosions.spawn(this.fxVec);
        }
        this.sound.playExplosion(center);
        this.cameraRig.addTrauma(cfg.deathTrauma);
        return;
      }
      case "turretFired": {
        this.fxVec.set(e.x, e.y, e.z);
        this.cosmeticLasers[e.faction].spawn(this.fxVec, e.rot, null, 0, true);
        this.sound.playTurretFire(this.fxVec);
        this.explosions.spawnMuzzleFlash(this.fxVec);
        return;
      }
      case "turretDestroyed": {
        this.fxVec.set(e.x, e.y, e.z);
        this.explosions.spawn(this.fxVec);
        this.sound.playExplosion(this.fxVec);
        this.cameraRig.addTrauma(
          this.traumaAtDistance(GameConfig.mothership.turrets.destroyTrauma, e.x, e.z),
        );
        return;
      }
      case "jumpSpoolStarted": {
        const pose = this.poseOf(e.ship);
        this.sound.startJumpDrive(
          this.jumpKey(e.ship),
          e.ship === this.myKey || !pose ? null : pose.position.clone(),
        );
        return;
      }
      case "jumpCancelled":
        this.sound.stopJumpDrive(this.jumpKey(e.ship));
        return;
      case "jumpFired": {
        this.sound.releaseJumpDrive(this.jumpKey(e.ship));
        this.visuals.get(e.ship)?.glow?.resetTrails();
        const from = new Vector3(e.fromX, 0, e.fromZ);
        const to = new Vector3(e.toX, 0, e.toZ);
        this.jumpFlashes.spawn(from);
        this.jumpFlashes.spawn(to);
        this.jumpRipple.spawn(from);
        if (e.ship === this.myKey) {
          // Our own teleport: hard-snap the camera across the discontinuity
          // (mirrors offline) and zero the velocity lead so it doesn't whip.
          this.cameraRig.snapTo(to);
          this.lastPlayerPos.copyFrom(to);
          this.camVel.set(0, 0, 0);
          if (this.predicted && this.predictionActive) {
            // Mirror the server teleport into the prediction so it doesn't
            // render the pre-jump pose for a patch until reconciliation snaps.
            // Arrival heading = the home carrier's (humans 0, machines π).
            this.predicted.position.set(e.toX, 0, e.toZ);
            this.predicted.velocity.set(0, 0, 0);
            this.predicted.rotationY = this.playerFaction === "machines" ? Math.PI : 0;
            this.predicted.bankAngle = 0;
            this.correctionPos.set(0, 0, 0);
            this.correctionRot = 0;
          }
        }
        return;
      }
    }
  }

  /**
   * Light one ship's exhaust from this frame's rendered pose (this.pose must
   * hold it — call right after view.update). Our own ship burns on REAL input
   * (predicted sim speed + held keys, RCS plumes included) and hides the glow
   * in the launch tube like offline (a lit glow bleeds through the carrier
   * hull via the GlowLayer). Remotes have no replicated input, so intensity
   * rides a speed estimate from pose deltas: above half throttle reads as
   * burning, below as coasting. Dead ships are skipped — the disabled root
   * hides the cores and the (unparented) trail collapses on its own.
   */
  private updateEngineFx(key: string, dt: number): void {
    const vis = this.visuals.get(key);
    if (!vis) return;
    const isMine = key === this.myKey;
    if (isMine && this.myLaunching) {
      vis.glow?.hide();
      vis.thrusters?.update(dt, false, false, false);
    } else if (isMine && this.predictionActive && this.predicted) {
      const held = this.input.state;
      vis.glow?.update(dt, this.predicted.speed, this.predicted.maxSpeed, held.thrust);
      vis.thrusters?.update(dt, held.reverse, held.strafeLeft, held.strafeRight);
    } else if (this.pose.isAlive) {
      const type = GameConfig.shipTypes[this.meta.get(key)!.shipType];
      const raw = dt > 0
        ? Math.hypot(this.pose.position.x - vis.lastX, this.pose.position.z - vis.lastZ) / dt
        : 0;
      // Clamp: a missed teleport-pop otherwise reads as a hypersonic burn.
      const speed = Math.min(raw, type.maxSpeed * 1.6);
      vis.glow?.update(dt, speed, type.maxSpeed, speed > type.maxSpeed * 0.5);
    }
    vis.lastX = this.pose.position.x;
    vis.lastZ = this.pose.position.z;
  }

  /**
   * Local-ship prediction (Phase 2): run the SHARED Ship movement math on the
   * player's own input every render frame, so the ship answers the stick
   * immediately instead of after a server round-trip + interpolation delay.
   * Active only while the seat is alive and clear of the launch catapult —
   * during launch/death/respawn the server-driven interpolated pose renders
   * instead, and prediction re-seeds from the authoritative state on re-entry.
   */
  private updatePrediction(dt: number): void {
    const meta = this.myKey !== null ? this.meta.get(this.myKey) : undefined;
    if (!meta) return;
    const shouldPredict =
      this.myAlive && !this.myLaunching && !this.ended && !this.connectionLost;
    if (!shouldPredict) {
      this.predictionActive = false;
      this.pendingInputs.length = 0;
      return;
    }
    if (!this.predictionActive) {
      if (!this.myServer.valid) return;
      if (!this.predicted) this.predicted = this.buildPredictedShip(meta);
      const s = this.myServer;
      const p = this.predicted;
      p.position.set(s.x, 0, s.z);
      p.velocity.set(s.vx, 0, s.vz);
      p.rotationY = s.rot;
      p.bankAngle = s.bank;
      p.cannonAmmo = s.cannonAmmo;
      p.missileAmmo = s.missileAmmo;
      this.correctionPos.set(0, 0, 0);
      this.correctionRot = 0;
      this.pendingInputs.length = 0;
      this.predictionActive = true;
      // Our ship gets the RCS plumes (reverse/strafe are OUR held keys —
      // remotes can't have them, their input isn't replicated). Config
      // nozzle positions; MP templates don't expose the GLB rcs markers.
      const vis = this.visuals.get(this.myKey!);
      const view = this.views.get(this.myKey!);
      if (vis && view && !vis.thrusters) {
        vis.thrusters = new SecondaryThrusters(this.scene, view.root, this.glowLayer, {});
      }
    }
    const ship = this.predicted!;
    ship.update(dt, this.input.state);

    // Predicted weapon fire: depict our shots the instant the key acts, from
    // the live muzzle — even an instantly-applied server echo trails a
    // thrusting ship by a round trip ("lasers firing from behind the ship").
    // tryFire/tryFireMissile mirror the server's cooldown + ammo gates, and
    // ammo re-syncs from every authoritative sample, so the depiction can't
    // run away from the truth. Hits remain entirely server-decided.
    const type = GameConfig.shipTypes[meta.shipType];
    if (this.input.state.fire) {
      const positions = ship.tryFire();
      if (positions.length > 0) {
        for (const p of positions) {
          this.cosmeticLasers[meta.faction].spawn(p, ship.rotationY, null, 0, false, 0, type.heavy);
        }
        this.sound.playFireSound(type.fireSound);
      }
    }
    if (this.input.state.fireMissile) {
      const missilePos = ship.tryFireMissile();
      if (missilePos) {
        this.cosmeticMissiles[meta.faction].spawn(missilePos, ship.rotationY, null, null);
        this.sound.playMissileLaunch();
      }
    }

    // Decay the visual correction offset toward zero (frame-rate independent).
    const m = exponentialMultiplier(GameConfig.net.correctionRate, dt);
    this.correctionPos.x *= m;
    this.correctionPos.z *= m;
    this.correctionRot *= m;
  }

  /**
   * Fold the newest authoritative sample into the prediction: rewind the
   * predicted ship to the server state, drop acked inputs, replay the pending
   * ones at the send cadence, and absorb the resulting pose delta into the
   * decaying correction offset — or hard-snap past correctionSnapUnits (an
   * unpredicted collision or teleport).
   */
  private reconcile(): void {
    const ship = this.predicted;
    if (!ship) return;
    const s = this.myServer;
    const prevX = ship.position.x;
    const prevZ = ship.position.z;
    const prevRot = ship.rotationY;
    ship.position.set(s.x, 0, s.z);
    ship.velocity.set(s.vx, 0, s.vz);
    ship.rotationY = s.rot;
    ship.bankAngle = s.bank;
    // Ammo is authoritative (spends + carrier-service refills happen there);
    // syncing every sample keeps the predicted fire gates honest.
    ship.cannonAmmo = s.cannonAmmo;
    ship.missileAmmo = s.missileAmmo;
    while (this.pendingInputs.length > 0 && this.pendingInputs[0].seq <= s.seq) {
      this.pendingInputs.shift();
    }
    const dt = NetworkGame.SEND_INTERVAL_MS / 1000;
    for (const p of this.pendingInputs) ship.update(dt, p.input);
    const ex = ship.position.x - prevX;
    const ez = ship.position.z - prevZ;
    const er = wrapAngle(ship.rotationY - prevRot);
    if (Math.hypot(ex, ez) > GameConfig.net.correctionSnapUnits) {
      this.correctionPos.set(0, 0, 0);
      this.correctionRot = 0;
    } else {
      // Keep the RENDERED pose continuous: the offset absorbs the delta now
      // and decays away over the next few frames (updatePrediction).
      this.correctionPos.x -= ex;
      this.correctionPos.z -= ez;
      this.correctionRot -= er;
    }
  }

  /** The prediction's Ship — same construction as BattleSim.spawnShip. */
  private buildPredictedShip(meta: { faction: Faction; shipType: ShipTypeId }): Ship {
    const type = GameConfig.shipTypes[meta.shipType];
    return new Ship({
      faction: meta.faction,
      maxHp: type.maxHp,
      respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
      startMissileAmmo: type.missileAmmo,
      startCannonAmmo: type.cannonAmmo,
      movement: type,
      laserDamage: type.laserDamage,
      hitRadius: type.hitRadius,
      fireSound: type.fireSound,
      heavy: type.heavy,
    });
  }

  /** Sample a ship's interpolation buffer at the current render time. Writes
   *  the shared pose scratch — copy anything you need to keep. Null = unseen. */
  private poseOf(key: string): MutablePose | null {
    const buf = this.snaps.get(key);
    if (!buf || buf.length === 0) return null;
    this.sampleInto(buf, this.lastRenderT, this.pose);
    return this.pose;
  }

  /** Trauma attenuated by distance from OUR ship (mirrors Game.traumaAtDistance). */
  private traumaAtDistance(base: number, x: number, z: number): number {
    const dx = x - this.camPos.x;
    const dz = z - this.camPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    return base * Math.max(0, 1 - dist / GameConfig.sound.maxDistance);
  }

  /** SoundSystem keys jump-drive clips by Ship identity and reads only its
   *  `.faction`; networked ships have no sim Ship, so hand it a stable stub. */
  private jumpKey(shipId: string): Ship {
    let stub = this.jumpSoundKeys.get(shipId);
    if (!stub) {
      stub = {
        faction: this.meta.get(shipId)?.faction ?? "humans",
      } as unknown as Ship;
      this.jumpSoundKeys.set(shipId, stub);
    }
    return stub;
  }

  /** Kill the closest live cosmetic bolt to an impact — the server consumed
   *  the real one; without this the depicted bolt sails through its victim. */
  private killNearestBolt(x: number, z: number): void {
    let best: Laser | null = null;
    let bestSq = 15 * 15;
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const bolt of this.cosmeticLasers[f].bolts) {
        if (bolt.isExpired) continue;
        const dx = bolt.position.x - x;
        const dz = bolt.position.z - z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestSq) {
          bestSq = dSq;
          best = bolt;
        }
      }
    }
    best?.kill();
  }

  /** Same as killNearestBolt, for cosmetic missile rounds (wider net — the
   *  ballistic depiction can drift further from the server's homing truth). */
  private killNearestMissile(x: number, z: number): void {
    let best: { kill(): void } | null = null;
    let bestSq = 30 * 30;
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const round of this.cosmeticMissiles[f].rounds) {
        if (!round.isAlive) continue;
        const dx = round.position.x - x;
        const dz = round.position.z - z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestSq) {
          bestSq = dSq;
          best = round;
        }
      }
    }
    best?.kill();
  }

  private makeView(key: string): ShipView {
    const m = this.meta.get(key)!;
    const view = new ShipView(this.buildRoot(m.faction, m.shipType));
    this.views.set(key, view);
    // Engine glow on GLB fighters only — the procedural fallback mesh carries
    // its own emissive engine block (offline parity). Nozzles come from the
    // model's `thruster.*` marker empties (cloned along with the hierarchy —
    // a Spitfire burns two trails, like offline); mesh-bounds rear center is
    // the fallback for models that author no markers.
    const hasTemplate = (this.templates.get(m.shipType) ?? null) !== null;
    const nozzles = this.thrusterMarkers(view.root);
    this.visuals.set(key, {
      glow: hasTemplate
        ? new EngineGlow(
            this.scene,
            view.root,
            this.glowLayer,
            nozzles.length > 0 ? nozzles : this.rearEmitters(view.root),
          )
        : null,
      thrusters: null,
      lastX: 0,
      lastZ: 0,
    });
    return view;
  }

  /**
   * `thruster*` marker empties read off the cloned hierarchy, in root-local
   * coordinates (the root is freshly built at the origin here — same frame
   * AssetLoader.extractMarkers uses). Substring match: instantiateHierarchy
   * may prefix clone names. Empty = the model authored no markers.
   */
  private thrusterMarkers(root: TransformNode): Array<{ x: number; y: number; z: number }> {
    root.computeWorldMatrix(true);
    const out: Array<{ x: number; y: number; z: number }> = [];
    for (const n of root.getDescendants()) {
      if (!(n instanceof TransformNode) || !n.name) continue;
      if (!n.name.toLowerCase().includes("thruster")) continue;
      n.computeWorldMatrix(true);
      const p = n.getAbsolutePosition();
      out.push({ x: p.x, y: p.y, z: p.z });
    }
    return out;
  }

  /**
   * Rear-nozzle fallback for fleet clones (mirrors Game.rearEmitters): the
   * mesh-bounds rear center, nudged slightly forward to sit at the nozzle
   * plane. Local frame — the root is freshly built at the origin here.
   */
  private rearEmitters(root: TransformNode): Array<{ x: number; y: number; z: number }> {
    const meshes = root.getChildMeshes(false);
    if (meshes.length === 0) return [];
    const inv = root.getWorldMatrix().clone().invert();
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
    return [
      { x: (min.x + max.x) * 0.5, y: (min.y + max.y) * 0.5, z: min.z + 0.15 },
    ];
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
