import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import {
  GameConfig,
  Mothership,
  lerp,
  wrapAngle,
  opposing,
  FACTION_THEME,
  factionExhaust,
  LaserSystem,
  MissileSystem,
  SensorSystem,
  Ship,
  AsteroidSim,
  collideShipWithAsteroid,
  bumpShipOutOfSection,
  bumpShipOutOfHulkSection,
  Hulk,
  exponentialMultiplier,
  type DamageTarget,
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
import { CombatNebulas } from "./CombatNebulas";
import { StormClouds } from "./StormClouds";
import { LightningSystem } from "./LightningSystem";
import { Radar } from "./Radar";
import { MissileWarning } from "./MissileWarning";
import { BEST_SCORE_KEY, RESTART_FLAG } from "./Game";
import { Nebulas } from "./Nebulas";
import { CapitalShips } from "./CapitalShips";
import { Starfield } from "./Starfield";
import { CameraRig } from "./CameraRig";
import { SpectatorCamera, type SpectateSubject } from "./SpectatorCamera";
import { buildPostPipeline } from "./PostPipeline";
import {
  Hud,
  UPGRADE_LABELS,
  captureStatusFor,
  type CaptureStatus,
  type ScoreRow,
} from "./Hud";
import { InputManager } from "./InputManager";
import { MouseSteering } from "./MouseSteering";
import { GamepadSteering } from "./GamepadSteering";
import { AssetLoader } from "./AssetLoader";
import { buildFighterMesh } from "./FighterMesh";
import { ShipView } from "./view/ShipView";
import { MothershipView } from "./view/MothershipView";
import { StationView } from "./view/StationView";
import { CaptureStation } from "@space-duel/shared";
import { HulkView } from "./view/HulkView";
import { AsteroidView } from "./view/AsteroidView";
import { LaserSystemView } from "./view/LaserSystemView";
import { MissileSystemView } from "./view/MissileSystemView";
import { ExplosionSystem } from "./ExplosionSystem";
import { JumpFlashSystem } from "./JumpFlashSystem";
import { ShieldHitFlashSystem } from "./ShieldHitFlashSystem";
import { JumpGhostSystem } from "./JumpGhostSystem";
import { JumpRipple } from "./JumpRipple";
import { SoundSystem } from "./SoundSystem";
import { MusicSystem } from "./MusicSystem";
import { EngineGlow } from "./EngineGlow";
import { Nameplates } from "./Nameplates";
import { SecondaryThrusters } from "./SecondaryThrusters";
import { NetDebugOverlay } from "./NetDebugOverlay";
import { DelayQueue } from "../net/DelayQueue";
import { clearInviteHash, type NetClient } from "../net/NetClient";

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
  hp: number;
  alive: boolean;
  launching: boolean;
  isAI: boolean;
  /** Pilot identity (nameplates): typed name while human-flown, else the
   *  seat's generated AI callsign. */
  callsign: string;
  cannonAmmo: number;
  missileAmmo: number;
  lastInputSeq: number;
  /** RCS bits of the last applied input (friendly plume depiction). */
  reverse: boolean;
  strafeLeft: boolean;
  strafeRight: boolean;
}

/**
 * A shadow of one replicated ship, holding its RENDERED pose each frame —
 * the client-side stand-in the offline systems (SensorSystem, Radar,
 * MissileWarning, cosmetic missile homing) read where they'd read a sim
 * `Ship`. It carries exactly the fields those consumers touch (position /
 * rotation / life / jump-spool state) and is handed to them `as Ship`; the
 * jump-spool getters ride the replicated spool events + the config spool
 * time, since drive state isn't in the schema. This is the "client-side
 * sensor picture" decision (docs/PHASE1_OPEN_ISSUES.md): the radar plays by
 * the same stealth rules as offline, while true sensor-FILTERED replication
 * (anti-wallhack) stays a pre-deploy Phase 2 item.
 */
class ShadowShip {
  readonly position = new Vector3();
  rotationY = 0;
  isAlive = false;
  /**
   * In the replicated ships map RIGHT NOW. With sensor-filtered replication
   * the server drops enemies our faction has no fresh track on; an absent
   * stub freezes at its last rendered pose (the client SensorSystem ages the
   * frozen track into a radar ghost) and leaves the sensor rosters + scene.
   * Friendlies always replicate, so they're absent only before first sight.
   */
  present = false;
  /** Wall-clock ms the drive started spooling, or null when idle. */
  spoolStartMs: number | null = null;
  /** Pilot identity for the nameplate (patch-fed; slow-changing). */
  callsign = "";
  isHumanPilot = false;
  /** Still in the launch catapult — nameplates hold off (a DOM label would
   *  float over the carrier hull; DOM ignores occlusion). */
  launching = true;

  constructor(
    readonly faction: Faction,
    /** The ship type's collision radius — the predictive missile contact
     *  fuse (fuseFriendlyMissiles) detonates depicted rounds against the
     *  RENDERED hull, so it needs the same radius the server tests. */
    readonly hitRadius: number,
  ) {}

  get isSpoolingJump(): boolean {
    return this.spoolStartMs !== null;
  }

  get jumpSpoolProgress(): number {
    if (this.spoolStartMs === null) return 0;
    return Math.min(1, (performance.now() - this.spoolStartMs) / GameConfig.jump.spoolMs);
  }
}

/** Mutable pose scratch (structurally satisfies the read-only ShipPose). */
interface MutablePose {
  position: Vector3;
  rotationY: number;
  bankAngle: number;
  isAlive: boolean;
  /** RCS bits riding the snapshot (discrete — sampled like `isAlive`). */
  reverse: boolean;
  strafeLeft: boolean;
  strafeRight: boolean;
}

/** The shape of a replicated asteroid spawn state (see AsteroidSchema). */
interface NetRock {
  t0: number;
  x: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  driftX: number;
  driftZ: number;
  spinX: number;
  spinY: number;
  spinZ: number;
  visualRadius: number;
  squashX: number;
  squashY: number;
}

/**
 * A plain-object copy of one arriving state patch, held by the netsim's
 * inbound delay queue (GameConfig.net.sim). It MUST be a copy: Colyseus
 * decodes every patch into the same live state object, so a held reference
 * would read FUTURE data by its release time. Shape duck-types what
 * recordSnapshot reads (Map.forEach matches the schema map's forEach).
 */
interface DelayedState {
  timeMs: number;
  /** Absent when the arriving patch had no such map — recordSnapshot's
   *  presence checks must see the same shape they'd see on the live state. */
  ships?: Map<string, NetShip>;
  asteroids?: Map<string, NetRock>;
}

/** One timestamped server sample of a ship's pose (SERVER sim clock, ms). */
interface Snap {
  t: number;
  x: number;
  z: number;
  rot: number;
  bank: number;
  alive: boolean;
  /** RCS bits (reverse/strafe input applied that tick) — friendly plumes. */
  rev: boolean;
  sl: boolean;
  sr: boolean;
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
 * collision; hits arrive as events (cosmetic missiles DO home, on the target
 * shadow the missileFired event names). Hitstop is deliberately absent
 * (freezing the render clock would desync the interpolation timeline).
 *
 * MP HUD slice: a per-ship shadow roster (ShadowShip) mirrors the rendered
 * poses into a client-side SensorSystem, which drives the Radar (ghost
 * tracks, nebula stealth, human-pilot halos), the DETECTED/HIDDEN cue, the
 * lock cue, and the RWR — the same stealth rules as offline, computed
 * locally. Kills/score ride the shipDied event's `by` attribution.
 */
export class NetworkGame {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly glowLayer: GlowLayer;
  private readonly arena: Arena;
  private readonly cameraRig: CameraRig;
  private readonly starfield: Starfield;
  private readonly backdrop: Backdrop;
  private readonly hud: Hud;
  private readonly input: InputManager;
  /** Mouse heading-steer + fire buttons, merged into input.state each frame. */
  private readonly mouse: MouseSteering;
  /** Gamepad stick-steer + buttons, merged into input.state after the mouse. */
  private readonly gamepad: GamepadSteering;
  private readonly loader: AssetLoader;
  /** Per-ship-type GLB template (null = procedural fallback), cloned per ship. */
  private readonly templates = new Map<ShipTypeId, TransformNode | null>();

  private readonly playerFaction: Faction;
  /** True when the player's carrier is at the north (+Z) end — camera, radar,
   * and backdrop parallax rotate 180° so this pilot also fights "up-screen".
   * View-only; inputs/replication are world-space and unaffected. */
  private readonly viewFlipped: boolean;
  private readonly enemyFaction: Faction;

  // ─── MP HUD slice: sensor picture + radar + RWR + kills/score ───
  /** Client-side sensor picture over the shadow roster (see ShadowShip doc). */
  private readonly sensors: SensorSystem;
  /** Gameplay stealth clouds — visuals + the concealment zone truth. */
  private readonly combatNebulas: CombatNebulas;
  /** Ion-storm cloud visuals + ambient lightning (damage is server-side). */
  private readonly stormClouds: StormClouds;
  private readonly lightning: LightningSystem;
  private readonly radar: Radar;
  private readonly missileWarning: MissileWarning;
  /** Per-ship shadow stubs, keyed like `snaps`; rosters share the same refs. */
  private readonly shadows = new Map<string, ShadowShip>();
  private readonly shadowStubs: Record<Faction, ShadowShip[]> = {
    humans: [],
    machines: [],
  };
  /** Shadow ships currently flown by a HUMAN (radar honesty halos). */
  private readonly humanPiloted = new Set<Ship>();
  /** The enemy shadow a missile fired NOW would lock (HUD cue + predicted
   *  round's homing target) — the client mirror of BattleSim.computeLockFor. */
  private lockStub: ShadowShip | null = null;
  private playerKills = 0;
  private wingKills = 0;
  private score = 0;
  private bestScore = 0;

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
  /** Per-patch scratch: keys present in the replicated map (absence sweep). */
  private readonly seenKeys = new Set<string>();
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
  /** Projected callsign labels (shadow-roster fed — see the plate loop). */
  private readonly nameplates: Nameplates;

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
  /**
   * Render-clock time our ship was first seen dead (alive→dead edge), for
   * the cosmetic redeploy countdown. The server owns the actual respawn —
   * this only times the wait locally. Null while alive.
   */
  private myDeathStartMs: number | null = null;

  /** Death spectate: follows a live shadow while the redeploy clock runs. */
  private readonly spectator = new SpectatorCamera();
  /** Killer ship key from our own shipDied event's `by` attribution — kept in
   *  case the FX event lands BEFORE the alive→dead patch begins the spectate
   *  (setPreferred covers the after case). Null = environment/unknown. */
  private myKillerKey: string | null = null;
  /** Scratch roster rebuilt each spectating frame (held only within the frame). */
  private readonly spectateRoster: SpectateSubject[] = [];

  // ─── Transient FX (Phase 2 event replication) ───
  private readonly sound: SoundSystem;
  private readonly music: MusicSystem;
  private readonly explosions: ExplosionSystem;
  private readonly jumpFlashes: JumpFlashSystem;
  /** Tinted splashes where shots land on a SHIELDED carrier (shieldFx.hitFlash). */
  private readonly shieldHitFlashes: ShieldHitFlashSystem;
  /** Spectral hull streaks at both ends of a jump (phase-out / phase-in). */
  private readonly jumpGhosts: JumpGhostSystem;
  private readonly jumpRipple: JumpRipple;
  /** Cosmetic per-faction projectile pools (no damage/collision — see class doc). */
  private readonly cosmeticLasers: Record<Faction, LaserSystem>;
  private readonly laserViews: Record<Faction, LaserSystemView>;
  private readonly cosmeticMissiles: Record<Faction, MissileSystem>;
  private readonly missileViews: Record<Faction, MissileSystemView>;
  /** Carrier centers (for the mothership death spectacle placement). */
  private readonly carrierCenters: Record<Faction, Vector3>;
  /** Carrier sims (hull sections) — the prediction bumps off these locally. */
  private readonly carrierSims: Record<Faction, Mothership>;
  /** Carrier depictions — kept for the subsystem death-state sync in tick(). */
  private readonly carrierViews: Record<Faction, MothershipView>;
  /**
   * Client-side capture-station copies (strategic layer M2): real
   * CaptureStation objects built from the replicated StationSchema on first
   * sight (positions are static), owner/capture state overwritten per patch —
   * so StationView/Radar/AI-free HUD read the same shape as offline.
   */
  private readonly netStations = new Map<number, CaptureStation>();
  private readonly netStationList: CaptureStation[] = [];
  private readonly stationViews: StationView[] = [];
  /** Faction tiers from the last patch (drives the client sensor rangeScale). */
  private readonly netTier: Record<Faction, number> = { humans: 0, machines: 0 };

  // ─── Replicated asteroid field ───
  /** Shared rock material (mirrors AsteroidFieldView.buildMaterial). */
  private readonly rockMaterial: StandardMaterial;
  /**
   * Rocks reconstructed from their replicated SPAWN STATE (drift/spin are
   * constant, so integrating from t0 on the shared sim clock reproduces the
   * server's trajectory exactly). `simT` = the sim time the pose is at.
   */
  private readonly rocks = new Map<
    string,
    { sim: AsteroidSim; view: AsteroidView; simT: number }
  >();
  /** Live rock sims, held BY REFERENCE as the cosmetic lasers' obstacles so
   *  depicted bolts get consumed by rocks (line-of-sight reads correctly). */
  private readonly rockObstacles: AsteroidSim[] = [];
  /**
   * Everything a depicted bolt dies against: the live rocks (mirrored from
   * rockObstacles by syncRocks — the radar wants rocks ONLY, so the two lists
   * stay separate) plus any wreck's hull sections. Held by reference by both
   * cosmetic LaserSystems.
   */
  private readonly cosmeticObstacles: DamageTarget[] = [];
  /**
   * Placed wreck hazards (the room's map put them in GameConfig.hazards):
   * local Hulk sims driven to the render clock — their yaw/pitch/roll rates
   * are constant, so integrating on the interpolated sim time reproduces the
   * server's pose exactly, the same trick as the rocks. `hulkSimT` = the sim
   * time the poses are at (null until the first patch sets the clock offset).
   */
  private readonly hulks: Hulk[] = [];
  private readonly hulkViews: HulkView[] = [];
  private hulkSimT: number | null = null;
  /** Server FX facts awaiting their sim time on the render clock. */
  private readonly fxQueue: Array<{ t: number; e: NetEvent }> = [];
  /**
   * After a stall (tab background, server hiccup) the render clock can leap
   * far forward in one frame, making EVERY queued FX fact due at once —
   * spawning all those meshes/sounds on the resync frame lengthens the very
   * hitch the player just felt. Cap the drain per frame; a normal frame has
   * 0–3 due events, so the cap only bites (and smears the burst over a few
   * frames) after a freeze. (docs/perf-freeze-investigation.md, hyp. 3.)
   */
  private static readonly MAX_FX_EVENTS_PER_FRAME = 24;
  /** Wall-clock time the scoreboard rows were last rebuilt (throttle). */
  private lastScoreboardMs = 0;
  /** Scoreboard rebuild cadence — kills/scores don't change 60×/sec, and
   *  rebuilding the row array every frame was measurable GC churn
   *  (docs/perf-freeze-investigation.md, hyp. 2). */
  private static readonly SCOREBOARD_INTERVAL_MS = 500;
  /**
   * Recent PREDICTIVE missile detonations (fuseFriendlyMissiles): our own
   * depicted rounds fly on the predicted timeline, so they visibly reach the
   * enemy hull ~a round trip + interp delay BEFORE the server's missileHit
   * event can play — the fuse pops the boom on contact, records it here, and
   * the matching event (arriving moments later) is consumed instead of
   * double-popping. Entries expire (wall clock) if the server turns out to
   * have missed — the round is gone either way, damage was never predicted.
   */
  private readonly localDetonations: Array<{ x: number; z: number; expiresMs: number }> =
    [];

  // ─── Dev tooling: netsim inbound delay + netcode overlay ───
  /** Netsim-held state patches (cloned at arrival — see DelayedState). */
  private readonly delayedSnaps = new DelayQueue<DelayedState>();
  /** Netsim-held FX batches (fresh decoded objects — safe by reference). */
  private readonly delayedEvents = new DelayQueue<EventsMessage>();
  /** Backquote-toggled netcode readout (+ the pinned NETSIM badge). */
  private readonly netDebug = new NetDebugOverlay();
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
    reverse: false,
    strafeLeft: false,
    strafeRight: false,
  };
  private readonly camPos = new Vector3();
  private readonly camVel = new Vector3();
  private readonly lastPlayerPos = new Vector3();
  private cameraSnapped = false;
  /**
   * Opening-launch camera (mirrors solo's cinematic LaunchSequence.desiredZoom):
   * hold the wide introZoom establishing shot while our seat waits in the
   * launch tube, then smoothstep down to the default framing once our catapult
   * fires. Latched off the room phase on the first tick with state — a
   * mid-match join starts at "playing" and never sees the wide shot — and
   * spent after the one ease, so respawn relaunches skip it like offline.
   */
  private openingShot: boolean | null = null;
  /** Wall-clock ms when OUR catapult fired — starts the opening-shot zoom ease. */
  private launchZoomEaseStartMs: number | null = null;
  private ended = false;
  private connectionLost = false;
  /** A resume attempt is in flight (unexpected drop, grace window open). */
  private reconnecting = false;
  /** Set by dispose() so a room drop during teardown never tries to resume. */
  private disposing = false;

  private static readonly SEND_INTERVAL_MS = 1000 / 30;
  private lastSendMs = 0;

  constructor(
    canvas: HTMLCanvasElement,
    hudRoot: HTMLDivElement,
    private readonly net: NetClient,
    playerFaction: Faction,
  ) {
    this.playerFaction = playerFaction;
    this.enemyFaction = opposing(playerFaction);
    // Every pilot attacks "up-screen": the north-end (+Z carrier) player's
    // view rotates 180° so their carrier is at the bottom of THEIR screen.
    // Same derivation as Game.viewFlipped — keyed off the carrier's spawn
    // end, view-only, three screen-oriented consumers (CameraRig, Radar,
    // Backdrop parallax). See docs/SUBSYSTEMS.md → CameraRig.
    this.viewFlipped =
      (playerFaction === "humans"
        ? GameConfig.mothership.playerZ
        : GameConfig.mothership.enemyZ) > 0;

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
    this.backdrop = new Backdrop(this.scene, this.viewFlipped ? -1 : 1);
    new Nebulas(this.scene, this.arena.halfWidth, this.arena.halfDepth);
    new CapitalShips(this.scene, this.arena.halfWidth, this.arena.halfDepth, this.glowLayer);

    // --- Carriers (static depiction; live HP from the server) ---
    const ms = GameConfig.mothership;
    this.carrierCenters = {
      humans: new Vector3(0, ms.yLevel, ms.playerZ),
      machines: new Vector3(0, ms.yLevel, ms.enemyZ),
    };
    this.carrierSims = {
      humans: new Mothership(new Vector3(0, ms.yLevel, ms.playerZ), 0, "humans"),
      machines: new Mothership(new Vector3(0, ms.yLevel, ms.enemyZ), Math.PI, "machines"),
    };
    const carriers: Record<Faction, MothershipView> = {
      humans: new MothershipView(this.scene, this.glowLayer, this.carrierSims.humans),
      machines: new MothershipView(this.scene, this.glowLayer, this.carrierSims.machines),
    };
    // Retained so tick() can sync subsystem death states off the replicated HP.
    this.carrierViews = carriers;
    for (const f of ["humans", "machines"] as Faction[]) {
      const file = GameConfig.mothership.model.file[f];
      if (file) {
        void carriers[f].applyModel(file).then(() => carriers[f].applyTurretModel());
      }
    }

    // --- Placed wrecks (the room's map wrote them into GameConfig.hazards
    // before construction — see main.ts startOnline). Local sims + views,
    // mirroring solo Game; poses advance on the render clock in tick. Their
    // hull sections block depicted bolts (cosmeticObstacles) and bump the
    // predicted ship (updatePrediction) — the REAL collision/LOS truth stays
    // server-side.
    for (const hazard of GameConfig.hazards) {
      if (hazard.kind === "hulk") {
        const hulk = new Hulk(hazard);
        this.hulks.push(hulk);
        this.hulkViews.push(new HulkView(this.scene, this.glowLayer, hulk));
        for (const section of hulk.sections) this.cosmeticObstacles.push(section);
      }
    }

    this.cameraRig = new CameraRig(this.scene, this.viewFlipped);
    // Mouse steering unprojects the cursor through the rig's camera; it
    // merges into input.state each frame BEFORE the input send (tick step 1),
    // so the server receives the mouse-commanded turn like any other input.
    this.mouse = new MouseSteering(this.cameraRig.camera);
    this.mouse.attach(canvas);
    // Gamepad steering maps the stick into screen-relative headings via the
    // same flipped flag the camera/radar use; its commanded turn rides the
    // input message to the server like any other input.
    this.gamepad = new GamepadSteering(this.viewFlipped);
    this.gamepad.attach();
    // ACES tone mapping + FXAA + vignette — the SAME full-frame grade as the
    // offline Game (shared helper), so both modes render identical colors.
    buildPostPipeline(this.scene, this.cameraRig.camera);
    this.starfield = new Starfield(this.scene, this.cameraRig.camera);
    this.hud = new Hud(hudRoot);
    this.hud.setLaunchOverlay("STAND BY");
    this.hud.showInviteHint(); // the address bar is the WITH FRIENDS link
    this.nameplates = new Nameplates(this.scene, this.cameraRig.camera, hudRoot);

    this.input = new InputManager();
    this.input.attach();
    this.loader = new AssetLoader(this.scene);

    // --- Transient FX (Phase 2 event replication): sound + explosions +
    // jump FX + cosmetic projectile pools, driven by applyFxEvent.
    this.sound = new SoundSystem(this.scene);
    this.music = new MusicSystem(this.scene);
    this.explosions = new ExplosionSystem(this.scene, this.glowLayer);
    // Hangar-bay damage feedback is spark bursts — hand the FX system to the
    // carrier views (built earlier; mirrors the solo Game wiring).
    carriers.humans.setExplosions(this.explosions);
    carriers.machines.setExplosions(this.explosions);
    this.jumpFlashes = new JumpFlashSystem(this.scene, this.glowLayer);
    this.shieldHitFlashes = new ShieldHitFlashSystem(this.scene);
    this.jumpGhosts = new JumpGhostSystem(this.scene, this.glowLayer);
    this.jumpRipple = new JumpRipple(this.scene, this.cameraRig.camera);
    // Lit rocky grey (mirrors AsteroidFieldView) — NOT emissive, NOT glowed.
    this.rockMaterial = new StandardMaterial("asteroid_mat", this.scene);
    this.rockMaterial.diffuseColor = new Color3(0.32, 0.29, 0.26);
    this.rockMaterial.specularColor = Color3.Black();

    this.cosmeticLasers = {
      humans: new LaserSystem({ damage: 0, obstacles: this.cosmeticObstacles }),
      machines: new LaserSystem({ damage: 0, obstacles: this.cosmeticObstacles }),
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

    // --- MP HUD slice: stealth clouds + client sensor picture + radar + RWR.
    // The zones are pure config math (computeConcealmentZones), so this
    // picture matches the one the server's AI flies on; carrier sims double
    // as the sensors' AWACS sources (hp synced from the schema each frame).
    this.combatNebulas = new CombatNebulas(
      this.scene,
      this.arena.halfWidth,
      this.arena.halfDepth,
    );
    // Ion storms (visual + ambient lightning; the DAMAGE runs server-side in
    // BattleSim). Zones are the same pure config math, so the client picture
    // matches the server truth. No-op until a server-side map places storms.
    this.stormClouds = new StormClouds(
      this.scene,
      this.arena.halfWidth,
      this.arena.halfDepth,
    );
    this.lightning = new LightningSystem(this.scene, this.glowLayer, this.stormClouds);
    this.sensors = new SensorSystem(this.carrierSims);
    this.sensors.concealmentZones = [
      ...this.combatNebulas.zones,
      ...this.stormClouds.zones,
    ];
    this.radar = new Radar(this.viewFlipped);
    this.missileWarning = new MissileWarning(this.sound, this.hud);
    try {
      this.bestScore = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
    } catch {
      this.bestScore = 0; // storage unavailable — best just won't persist
    }

    // Queue server FX facts; the tick plays each at its sim time (see
    // ingestEvents for the own-fire exception). With the dev netsim on, both
    // inbound channels are first held for half the simulated RTT + jitter —
    // the tick drains them, so ingest is just LATER (everything already rides
    // state.timeMs / msg.t, never arrival time). Direct-state reads (carrier
    // HP, phase, winner) stay realtime — slow-changing, not feel-relevant.
    this.net.room.onMessage(MSG.events, (msg: EventsMessage) => {
      if (GameConfig.net.sim.enabled) {
        this.delayedEvents.push(msg, performance.now(), this.netSimDelayMs());
      } else {
        this.ingestEvents(msg);
      }
    });

    // Buffer a timestamped pose for every ship on each server patch.
    this.net.room.onStateChange((state) => {
      if (GameConfig.net.sim.enabled) {
        this.delayedSnaps.push(this.cloneNetState(state), performance.now(), this.netSimDelayMs());
      } else {
        this.recordSnapshot(state);
      }
    });

    // Reconnection (Phase 3): the SDK auto-reconnects the SAME Room object on
    // a non-consented close (exponential backoff, ~60s of retries — matched
    // to the server's net.reconnectGraceSec seat hold, where the AI flies our
    // seat meanwhile). All handlers here survive the reconnect. onDrop marks
    // the outage (overlay + send/prediction freeze), onReconnect resumes,
    // onLeave is TERMINAL: consented exit, retries exhausted, or a drop
    // before the SDK's min-uptime guard.
    this.net.room.onDrop(() => {
      if (this.disposing || this.ended) {
        // Nothing worth resuming into — stop the SDK's retry loop before it
        // starts (it consults this right after the drop signal), which routes
        // the close to onLeave instead.
        this.net.room.reconnection.enabled = false;
        return;
      }
      this.reconnecting = true;
    });
    this.net.room.onReconnect(() => this.onReconnected());
    this.net.room.onLeave(() => {
      this.reconnecting = false;
      if (!this.disposing) this.connectionLost = true;
    });
    // Errors are informational only: every real disconnect also fires the
    // close event, and onDrop/onLeave above decide the outcome there.
    this.net.room.onError((code, message) => {
      console.warn(`[net] room error ${code}: ${message ?? ""}`);
    });

    // End-screen + mute keys (mirrors Game.onKeyDown — the end banner's
    // "Press Enter to restart · Esc for menu" promise has to hold online too;
    // the reload keeps ?online, so restart rejoins a match).
    window.addEventListener("keydown", this.onKeyDown);
    // A page unload (reload, ESC-to-menu, tab close) is an INTENTIONAL exit:
    // best-effort consented leave so the server frees the seat immediately
    // instead of holding it for the reconnection grace window.
    window.addEventListener("pagehide", this.onPageHide);
  }

  /**
   * Back in the room (same sessionId, same seat — the server restored our
   * occupancy and callsign). The transport is new and the dead gap is
   * unknowable, so every timeline-derived buffer restarts clean:
   * interpolation snapshots, the wall↔sim clock offset (hard-resyncs on the
   * first patch), prediction/reconciliation state, and queued FX — nothing
   * may interpolate, replay, or play across the gap.
   */
  private onReconnected(): void {
    this.snaps.clear();
    this.clockOffsetMs = null;
    this.pendingInputs.length = 0;
    this.myServer.valid = false;
    this.predictionActive = false;
    this.correctionPos.set(0, 0, 0);
    this.correctionRot = 0;
    this.fxQueue.length = 0;
    // Netsim-held inbound: drop, don't play — these predate the drop.
    this.delayedSnaps.drain(Number.POSITIVE_INFINITY, () => {});
    this.delayedEvents.drain(Number.POSITIVE_INFINITY, () => {});
    this.reconnecting = false;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.sound.unlock();
    if (e.code === "KeyM") {
      this.sound.toggleMute();
      this.hud.setMuted(this.sound.isMuted);
    }
    if (e.code === "KeyI" && !this.ended) {
      // Copy the invite link (the address bar carries #join=<roomId>). After
      // the end the room is locked — there is nothing to invite into.
      if (navigator.clipboard) {
        navigator.clipboard.writeText(window.location.href).then(
          () => this.hud.flashInviteCopied(true),
          () => this.hud.flashInviteCopied(false),
        );
      } else {
        this.hud.flashInviteCopied(false); // insecure context — no clipboard
      }
    }
    if (e.code === "Enter" && this.ended) {
      // The flag's value is the relaunch MODE (main.ts): rejoin a match. The
      // invite hash must go first — it points at THIS room, which the server
      // locked at match end; keeping it would make the reload try the dead
      // room and burn a failed joinById before falling back to quick match.
      clearInviteHash();
      sessionStorage.setItem(RESTART_FLAG, "online");
      window.location.reload();
    }
    if (e.code === "Escape") {
      // Mid-match the hash stays: rejoining the still-live room from the
      // splash is the invite-link flow working as intended.
      if (this.ended) clearInviteHash();
      window.location.reload();
    }
  };

  /** Preload the ship GLBs, then start the render loop. */
  async start(): Promise<void> {
    await this.preloadTemplates();
    // Swap each wreck's placeholder blocks for its battle-damaged GLB (same
    // fallback contract as solo Game.start — the procedural placeholder stays
    // if the file is missing/fails).
    await Promise.all(
      this.hulks.map((hulk, i) =>
        this.hulkViews[i].applyModel(GameConfig.hulk.model.file[hulk.source]),
      ),
    );
    this.music.playPlaylist("game");
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
      asteroids?: { forEach: (cb: (v: NetRock, k: string) => void) => void };
    };
    if (s.asteroids) this.syncRocks(s.asteroids);
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

    this.seenKeys.clear();
    s.ships.forEach((ship, key) => {
      this.seenKeys.add(key);
      if (!this.meta.has(key)) {
        this.meta.set(key, { faction: ship.faction, shipType: ship.shipType });
        this.shadows.set(
          key,
          new ShadowShip(ship.faction, GameConfig.shipTypes[ship.shipType].hitRadius),
        );
      }
      const stub = this.shadows.get(key)!;
      if (!stub.present) {
        // (Re)entered our replicated picture — rejoin the sensor rosters and
        // flush the exhaust trail (it isn't parented to the root; bridging
        // the hidden gap would streak it across the map).
        stub.present = true;
        this.shadowStubs[ship.faction].push(stub);
        this.visuals.get(key)?.glow?.resetTrails();
      }
      // Honesty bookkeeping: seats swap human↔AI at runtime (join/leave), so
      // the halo set re-derives from every patch.
      if (ship.isAI) {
        this.humanPiloted.delete(stub as unknown as Ship);
      } else {
        this.humanPiloted.add(stub as unknown as Ship);
      }
      // Nameplate identity rides the stub (patch cadence is plenty — the
      // callsign only changes when a seat swaps human↔AI).
      stub.callsign = ship.callsign ?? "";
      stub.isHumanPilot = !ship.isAI;
      stub.launching = ship.launching;
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
        if (this.predicted) {
          // HP is authoritative-only (never predicted) — the HUD reads it off
          // the predicted Ship, so keep it current on every sample.
          this.predicted.hp = ship.hp;
          if (!this.predictionActive) {
            // Not flying the prediction (launch tube / dead): keep its pose
            // tracking the server so the HUD's pos/vel stay truthful.
            this.predicted.position.set(ship.x, 0, ship.z);
            this.predicted.velocity.set(ship.vx, 0, ship.vz);
            this.predicted.rotationY = ship.rotationY;
            this.predicted.cannonAmmo = ship.cannonAmmo;
            this.predicted.missileAmmo = ship.missileAmmo;
          }
        }
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
        buf.push({ t: prev.t + 1, x: ship.x, z: ship.z, rot: ship.rotationY, bank: ship.bankAngle, alive: ship.alive, rev: ship.reverse, sl: ship.strafeLeft, sr: ship.strafeRight });
        // The exhaust trail is NOT parented to the ship root — flush it or the
        // teleport (jump/respawn) drags a streak across the whole map.
        this.visuals.get(key)?.glow?.resetTrails();
      }
      buf.push({ t, x: ship.x, z: ship.z, rot: ship.rotationY, bank: ship.bankAngle, alive: ship.alive, rev: ship.reverse, sl: ship.strafeLeft, sr: ship.strafeRight });
      if (buf.length > 40) buf.shift(); // ~2s of history at 20Hz
    });

    // Absence sweep (sensor-filtered replication): a ship that left the
    // replicated map is one our faction lost track of — freeze its stub
    // (the client sensors age the frozen track into a radar ghost), pull it
    // from the sensor rosters, hide its depiction, and wipe its snapshot
    // buffer so reappearance starts fresh instead of interpolating across
    // the hidden gap. Pilot counts ride root state now, not this roster.
    for (const [key, stub] of this.shadows) {
      if (!stub.present || this.seenKeys.has(key)) continue;
      stub.present = false;
      const roster = this.shadowStubs[stub.faction];
      const i = roster.indexOf(stub);
      if (i >= 0) roster.splice(i, 1);
      const buf = this.snaps.get(key);
      if (buf) buf.length = 0;
      // Root disable hides the hull + parented plumes; the engine glow's
      // trail is NOT parented (gotcha #4) and needs its own hide.
      this.views.get(key)?.root.setEnabled(false);
      this.visuals.get(key)?.glow?.hide();
    }
  }

  /**
   * Queue a server FX batch for playback at its sim time. EXCEPT our own
   * weapon fire: that is depicted PREDICTIVELY at the keypress
   * (updatePrediction) — the server echo would double-render it, and even an
   * immediately-applied echo trails a thrusting ship by a round trip.
   */
  private ingestEvents(msg: EventsMessage): void {
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
  }

  /** One inbound message's simulated delay: half the RTT + uniform jitter. */
  private netSimDelayMs(): number {
    const sim = GameConfig.net.sim;
    return sim.latencyMs / 2 + Math.random() * sim.jitterMs;
  }

  /** Copy an arriving patch into plain objects for the netsim delay queue —
   *  the live schema object mutates in place, so it can't be held. */
  private cloneNetState(state: unknown): DelayedState {
    const s = state as {
      timeMs?: number;
      ships?: { forEach: (cb: (v: NetShip, k: string) => void) => void };
      asteroids?: { forEach: (cb: (v: NetRock, k: string) => void) => void };
    };
    const out: DelayedState = { timeMs: s.timeMs ?? 0 };
    if (s.ships) {
      const ships = new Map<string, NetShip>();
      out.ships = ships;
      s.ships.forEach((v, k) => {
        ships.set(k, {
          owner: v.owner,
          faction: v.faction,
          shipType: v.shipType,
          x: v.x,
          z: v.z,
          vx: v.vx,
          vz: v.vz,
          rotationY: v.rotationY,
          bankAngle: v.bankAngle,
          hp: v.hp,
          alive: v.alive,
          launching: v.launching,
          isAI: v.isAI,
          callsign: v.callsign,
          cannonAmmo: v.cannonAmmo,
          missileAmmo: v.missileAmmo,
          lastInputSeq: v.lastInputSeq,
          reverse: v.reverse,
          strafeLeft: v.strafeLeft,
          strafeRight: v.strafeRight,
        });
      });
    }
    if (s.asteroids) {
      const asteroids = new Map<string, NetRock>();
      out.asteroids = asteroids;
      s.asteroids.forEach((v, k) => {
        asteroids.set(k, {
          t0: v.t0,
          x: v.x,
          z: v.z,
          rotX: v.rotX,
          rotY: v.rotY,
          rotZ: v.rotZ,
          driftX: v.driftX,
          driftZ: v.driftZ,
          spinX: v.spinX,
          spinY: v.spinY,
          spinZ: v.spinZ,
          visualRadius: v.visualRadius,
          squashX: v.squashX,
          squashY: v.squashY,
        });
      });
    }
    return out;
  }

  /** Netsim drain targets (bound once — no per-frame closure allocation). */
  private readonly consumeDelayedSnap = (s: DelayedState): void => this.recordSnapshot(s);
  private readonly consumeDelayedEvents = (m: EventsMessage): void => this.ingestEvents(m);

  private readonly tick = (): void => {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, GameConfig.scene.maxDeltaSeconds);

    // 0. Dev netsim: release inbound messages whose simulated delay elapsed.
    if (GameConfig.net.sim.enabled) {
      const drainNow = performance.now();
      this.delayedSnaps.drain(drainNow, this.consumeDelayedSnap);
      this.delayedEvents.drain(drainNow, this.consumeDelayedEvents);
    }

    // 1. Sample + send local input, throttled to the server tick rate.
    this.input.update();
    // Backquote: the netcode readout (offline the key is god mode; free in MP).
    if (this.input.consumeDebugToggle()) this.netDebug.toggle();
    const nowMs = performance.now();
    // Merge mouse steering + buttons into the keyboard's InputState before
    // it's read anywhere. Steering needs a ship pose to compute a bearing —
    // the predicted own-ship is that pose; until prediction is live the
    // mouse contributes buttons only.
    this.mouse.apply(
      this.input.state,
      this.predictionActive ? this.predicted : null,
      nowMs,
    );
    // Pad merges after the mouse: a deflected stick is explicit intent and
    // overrides a parked-but-recent mouse on the turn channel.
    this.gamepad.apply(
      this.input.state,
      this.predictionActive ? this.predicted : null,
    );
    // Audio unlock rides the first real input gesture (mirrors Game.tick).
    const held = this.input.state;
    if (held.thrust || held.reverse || held.rotateLeft || held.rotateRight || held.fire) {
      this.sound.unlock();
    }
    if (
      !this.ended &&
      !this.connectionLost &&
      !this.reconnecting &&
      nowMs - this.lastSendMs >= NetworkGame.SEND_INTERVAL_MS
    ) {
      // Drift-free pacing: advance the send clock by the interval, not to
      // `now` — sends are quantized to render frames, and rounding up every
      // time would ship inputs slower than the server consumes them (e.g.
      // ~28.8Hz at 144fps), starving its input queue once a second. Resync
      // only when a hitch leaves the clock more than one interval behind.
      this.lastSendMs += NetworkGame.SEND_INTERVAL_MS;
      if (nowMs - this.lastSendMs >= NetworkGame.SEND_INTERVAL_MS) this.lastSendMs = nowMs;
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

    // Rocks: integrate each reconstructed sim to the render clock (drift+spin
    // are constant, so this stays exactly on the server's trajectory). The
    // first step can be NEGATIVE (t0 is ~an interp delay ahead of renderT) —
    // linear motion reverses cleanly, but skip the wrap then, so a rock
    // captured just after a server wrap can't bounce to the far side.
    for (const entry of this.rocks.values()) {
      const dtRock = (renderT - entry.simT) / 1000;
      if (dtRock !== 0) {
        entry.sim.update(dtRock);
        if (dtRock > 0) this.wrapRock(entry.sim);
        entry.simT = renderT;
      }
      entry.view.sync();
    }

    // Wrecks: same trick as the rocks — the server integrates each hulk from
    // sim time 0 at constant yaw/pitch/roll rates, so driving our local copy
    // to the render clock lands on the same pose (the first advance fast-
    // forwards from the spec pose; a mid-match join catches up in one step).
    // Gated on the clock offset: before the first patch renderT is garbage.
    if (this.hulks.length > 0 && this.clockOffsetMs !== null) {
      const dtHulk = (renderT - (this.hulkSimT ?? 0)) / 1000;
      this.hulkSimT = renderT;
      for (let i = 0; i < this.hulks.length; i++) {
        if (dtHulk !== 0) this.hulks[i].update(dtHulk);
        this.hulkViews[i].update(
          this.hulks[i].rotationY,
          this.hulks[i].rotationX,
          this.hulks[i].rotationZ,
        );
      }
    }

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
      // Feed the shadow stub this frame's rendered pose — the sensor picture,
      // radar, RWR and cosmetic missile homing all read the shadows.
      const stub = this.shadows.get(key);
      if (stub) {
        stub.position.copyFrom(this.pose.position);
        stub.rotationY = this.pose.rotationY;
        stub.isAlive = this.pose.isAlive;
      }
      if (key === this.myKey) {
        this.camPos.copyFrom(this.pose.position);
        havePlayer = true;
      }
    }

    // 3. Camera follows our ship. Velocity feeds the lead offset — when the
    // prediction flies, pass the SIM velocity like offline Game.tick does:
    // finite-differencing the rendered pose (predicted + decaying correction)
    // turns every reconciliation ripple into velocity-lead wobble, which the
    // lead factor amplifies into visible judder at full thrust.
    if (havePlayer) {
      if (!this.cameraSnapped) {
        this.cameraRig.snapTo(this.camPos);
        this.lastPlayerPos.copyFrom(this.camPos);
        this.cameraSnapped = true;
      }
      if (this.predictionActive && this.predicted) {
        this.camVel.set(this.predicted.velocity.x, 0, this.predicted.velocity.z);
      } else {
        this.camVel.set(
          dt > 0 ? (this.camPos.x - this.lastPlayerPos.x) / dt : 0,
          0,
          dt > 0 ? (this.camPos.z - this.lastPlayerPos.z) / dt : 0,
        );
      }
      this.lastPlayerPos.copyFrom(this.camPos);
    }
    // Opening-launch camera (mirrors solo's LaunchSequence.desiredZoom): hold
    // the wide introZoom establishing shot while our seat waits in the launch
    // tube, then smoothstep down to the default framing — over the same
    // duration as solo's 3-2-1 countdown — once our catapult fires.
    if (this.openingShot === null) {
      // Latch off the first replicated phase: a mid-match join arrives at
      // "playing" and must never see the wide shot.
      const p = (this.net.room.state as unknown as { phase?: string }).phase;
      if (p !== undefined) this.openingShot = p === "launching";
    }
    if (this.openingShot) {
      const launch = GameConfig.launch;
      if (this.launchZoomEaseStartMs === null) {
        if (this.myLaunching) {
          this.cameraRig.setZoom(launch.introZoom);
        } else {
          // Already clear of the tube (our shipLaunched FX never played, or we
          // joined between catapult and phase flip) — just ease down from here.
          this.launchZoomEaseStartMs = nowMs;
        }
      }
      if (this.launchZoomEaseStartMs !== null) {
        const durMs = launch.countdownStepSec * 3 * 1000;
        const t = Math.min((nowMs - this.launchZoomEaseStartMs) / durMs, 1);
        const eased = t * t * (3 - 2 * t); // smoothstep — same curve as solo
        this.cameraRig.setZoom(
          launch.introZoom + (GameConfig.camera.defaultZoom - launch.introZoom) * eased,
        );
        if (t >= 1) this.openingShot = false; // spent — zoom keys take over
      }
    }
    const zoomInput = this.input.state.zoomIn ? 1 : this.input.state.zoomOut ? -1 : 0;
    // Death spectate (offline parity — Game.updateViews's dead branch): while
    // our seat is dead mid-match, follow a live shadow instead of holding at
    // our last pose. cameraSnapped gates it behind the first own-ship snap so
    // a joining client never spectates before it has ever seen itself.
    const phaseNow = (this.net.room.state as unknown as { phase?: string }).phase;
    if (phaseNow === "playing" && !this.ended && !this.myAlive && this.cameraSnapped) {
      if (!this.spectator.active) {
        // camPos still holds our last rendered pose — the wreck position.
        this.spectator.begin(
          nowMs,
          this.camPos,
          this.myKillerKey !== null
            ? (this.shadows.get(this.myKillerKey) ?? null)
            : null,
        );
      }
      // This frame's watchable roster: replicating, live, launched, not us.
      this.spectateRoster.length = 0;
      for (const [key, stub] of this.shadows) {
        if (key === this.myKey || !stub.present || !stub.isAlive || stub.launching)
          continue;
        this.spectateRoster.push(stub);
      }
      this.spectator.update(
        dt,
        nowMs,
        this.cameraRig,
        zoomInput,
        this.input.state,
        this.spectateRoster,
      );
    } else {
      if (this.spectator.active) {
        // Respawn edge: hard-cut back to our own ship (a smoothed pan would
        // streak the whole arena past).
        this.spectator.end();
        this.myKillerKey = null;
        this.cameraRig.snapTo(this.camPos);
      }
      this.cameraRig.update(dt, this.camPos, this.camVel, zoomInput);
    }
    this.starfield.update();
    this.backdrop.update(this.cameraRig.camera.getTarget());

    // 3.4 Mirror the replicated stations + derive the station-powered shield
    // factor BEFORE the FX playback below, so shieldedCarrierAt sees THIS
    // frame's ownership when deciding whether a hit splashes.
    this.mirrorStations();

    // 3.5 Transient FX: play each queued server fact once the render clock
    // reaches its sim time (aligning FX with the interpolated poses), then
    // advance the cosmetic projectile pools + one-shot FX systems.
    let fxApplied = 0;
    while (
      this.fxQueue.length > 0 &&
      this.fxQueue[0].t <= renderT &&
      fxApplied < NetworkGame.MAX_FX_EVENTS_PER_FRAME
    ) {
      this.applyFxEvent(this.fxQueue.shift()!.e);
      fxApplied++;
    }
    const dtMs = dt * 1000;
    for (const f of ["humans", "machines"] as Faction[]) {
      this.cosmeticLasers[f].update(dt, dtMs, nowMs);
      this.laserViews[f].update();
      this.cosmeticMissiles[f].update(dt, dtMs, nowMs);
      this.missileViews[f].update();
    }
    this.fuseFriendlyMissiles(nowMs);
    this.explosions.update(dt, dtMs);
    this.jumpFlashes.update(dtMs);
    this.shieldHitFlashes.update(dtMs);
    this.jumpGhosts.update(dtMs);
    this.stormClouds.update(dt);
    this.lightning.update(dt, dtMs);
    this.jumpRipple.update(dtMs);
    // Engine hum tracks our glow's smoothed intensity (offline parity),
    // falling back to raw thrust before the visuals exist.
    const ownGlow = this.myKey !== null ? this.visuals.get(this.myKey)?.glow : null;
    this.sound.updateEngine(
      dt,
      ownGlow?.currentIntensity ?? (this.input.state.thrust ? 1 : 0),
    );

    // 4. Sensor picture + HUD + radar straight from current state (HP/phase
    // need no interpolation; poses come from the shadow roster fed above).
    const state = this.net.room.state as unknown as {
      humansMothership?: {
        hp: number;
        maxHp: number;
        hangar0Hp?: number;
        hangar1Hp?: number;
      };
      machinesMothership?: {
        hp: number;
        maxHp: number;
        hangar0Hp?: number;
        hangar1Hp?: number;
      };
      phase?: string;
      winner?: string;
      pilotHumans?: number;
      pilotBots?: number;
      humansEnergy?: number;
      machinesEnergy?: number;
      humansTier?: number;
      machinesTier?: number;
    };
    // Pilot counts are root fields — the ships map is sensor-filtered, so
    // counting replicated entries would miss every hidden enemy seat.
    // (Undefined until the first patch: keep the HUD row hidden till then.)
    if (state?.pilotHumans !== undefined) {
      this.hud.setPilotCounts(state.pilotHumans, state.pilotBots ?? 0);
    }
    // Running scoreboard — same live-root-state path as the pilot counts
    // (bypasses the netsim delay queue; UI-only, ~one RTT "early" under
    // artificial latency is acceptable). setScoreboard is write-on-change,
    // but building the rows allocates, so rebuild on a cadence, not per frame.
    if (nowMs - this.lastScoreboardMs >= NetworkGame.SCOREBOARD_INTERVAL_MS) {
      this.lastScoreboardMs = nowMs;
      const scoreRows = this.scoreRows();
      if (scoreRows.length > 0) this.hud.setScoreboard(scoreRows);
    }
    if (state?.humansMothership && state.machinesMothership) {
      // Carrier sims mirror the replicated HP: the radar diamond drops and the
      // sensors lose their AWACS sweep when a carrier dies, like offline.
      this.carrierSims.humans.hp = state.humansMothership.hp;
      this.carrierSims.machines.hp = state.machinesMothership.hp;
      // Subsystem HP rides the same path: writing the local Mothership's
      // subsystem objects makes hangarAlive, the views, and the HUD read
      // identically to offline (mid-match joiners included). Shield state
      // is separate — derived from station owners in mirrorStations().
      this.applySubsystemHp(this.carrierSims.humans, state.humansMothership);
      this.applySubsystemHp(this.carrierSims.machines, state.machinesMothership);
      this.carrierViews.humans.syncSubsystems();
      this.carrierViews.machines.syncSubsystems();
      this.hud.setSubsystems(
        this.carrierSims.humans.subsystems,
        this.carrierSims.machines.subsystems,
      );
      this.hud.setMothershipHp(
        this.fraction(state.humansMothership),
        this.fraction(state.machinesMothership),
      );
    }
    // Stations were mirrored pre-FX (step 3.4); here just animate the views
    // and feed the strategic HUD.
    for (const sv of this.stationViews) sv.update(nowMs);
    {
      let ownedHumans = 0;
      let ownedMachines = 0;
      for (const st of this.netStationList) {
        if (st.owner === "humans") ownedHumans++;
        else if (st.owner === "machines") ownedMachines++;
      }
      this.hud.setShieldPower(
        ownedHumans,
        ownedMachines,
        this.netStationList.length,
      );
    }
    this.netTier.humans = state?.humansTier ?? 0;
    this.netTier.machines = state?.machinesTier ?? 0;
    this.hud.setEnergy(
      this.netStationList.length > 0,
      state?.humansEnergy ?? 0,
      this.netTier.humans,
      state?.machinesEnergy ?? 0,
      this.netTier.machines,
    );
    // Sensor-boost parity: the SERVER's filter already replicates farther
    // contacts once the tier unlocks; scaling the client's own sweep the
    // same way keeps the radar picture in step with what arrives.
    this.sensors.rangeScale.humans = this.sensorScaleFor("humans");
    this.sensors.rangeScale.machines = this.sensorScaleFor("machines");
    const phase = state?.phase ?? "launching";
    this.updatePhase(phase, state?.winner ?? "");

    // Client sensor sweep over the shadow roster (wall clock — it only ages
    // tracks), then the lock cue the predicted missile fire also uses.
    this.sensors.update(
      nowMs,
      this.shadowStubs as unknown as Record<Faction, Ship[]>,
    );
    this.lockStub = this.computeNetLock();

    const myStub = this.myKey !== null ? this.shadows.get(this.myKey) : undefined;

    // RWR: poll the ENEMY's cosmetic missile pool for rounds homing on OUR
    // shadow (the homing target rides the missileFired event). Forced quiet
    // outside live play, mirroring Game.tick.
    const rwrActive =
      phase === "playing" && this.myAlive && !this.myLaunching && !this.ended;
    this.missileWarning.update(
      dt,
      nowMs,
      this.cosmeticMissiles[this.enemyFaction],
      rwrActive && myStub ? (myStub as unknown as Ship) : null,
    );

    if (this.predicted && myStub) {
      // Carrier-service cue (offline parity — Game.tick's dock block): the
      // same gate the server applies, mirrored over the predicted ship —
      // loitering inside the HOME carrier's service bubble. SERVICING vs
      // DOCKED derives from the replicated hp/ammo; serviceTick itself never
      // runs here (refills are authoritative and already ride the schema).
      const ship = this.predicted;
      const home = this.carrierSims[this.playerFaction];
      const myType = GameConfig.shipTypes[this.meta.get(this.myKey!)!.shipType];
      const docked =
        this.myAlive &&
        home.isAlive &&
        ship.speed <= GameConfig.service.loiterMaxSpeed &&
        home.serviceZoneContains(ship.position.x, ship.position.z);
      const needsService =
        ship.hp < ship.maxHp ||
        ship.cannonAmmo < myType.cannonAmmo ||
        ship.missileAmmo < myType.missileAmmo;
      this.hud.setServiceStatus(docked ? (needsService ? "servicing" : "docked") : null);

      // Stealth cue: does the ENEMY's picture hold a fresh track on us?
      const signature = this.sensors.isTracked(
        this.enemyFaction,
        myStub as unknown as Ship,
      )
        ? "detected"
        : this.sensors.isConcealed(myStub.position)
          ? "hidden"
          : "untracked";
      this.hud.update(
        this.predicted,
        nowMs,
        this.lockStub !== null,
        this.cameraRig.currentZoom,
        signature,
        this.playerKills,
        this.wingKills,
        this.score,
        this.bestScore,
      );
      this.hud.setJumpSpool(
        myStub.isSpoolingJump && this.myAlive ? myStub.jumpSpoolProgress : null,
      );

      // Redeploy countdown (offline parity — Game.updateViews's block): the
      // server owns the respawn clock, so time the wait locally from the
      // alive→dead edge, mirroring the server's scaling (hangar penalty ×
      // replicated fasterRespawn tier). Cosmetic: the actual respawn arrives
      // by replication; a small drift just snaps the last fraction.
      if (!this.myAlive && phase === "playing" && !this.ended) {
        if (this.myDeathStartMs === null) this.myDeathStartMs = nowMs;
        const total =
          GameConfig.combat.enemyRespawnDelayMs * // every online seat spawns with this delay
          this.respawnScaleFor(this.playerFaction);
        this.hud.setRespawnCountdown(
          Math.max(0, total - (nowMs - this.myDeathStartMs)),
          total,
        );
      } else {
        this.myDeathStartMs = null;
        this.hud.setRespawnCountdown(null, 0);
      }
      // Who the death-cam is following (null hides the line — alive, or
      // still lingering on the wreck).
      this.hud.setSpectating(this.spectator.subjectLabel);

      // Capture status (offline parity — Game.updateViews's docked block):
      // the meter itself is server truth riding the StationSchema; the
      // predicted ship supplies "am I inside the ring, slow enough" for the
      // line's presence, same approximation as the service cue above.
      let captureStatus: CaptureStatus | null = null;
      if (this.myAlive && !this.myLaunching) {
        for (const st of this.netStationList) {
          const dx = ship.position.x - st.position.x;
          const dz = ship.position.z - st.position.z;
          if (dx * dx + dz * dz > st.radius * st.radius) continue;
          captureStatus =
            ship.speed > GameConfig.stations.dockMaxSpeed
              ? { text: "REDUCE SPEED TO DOCK", tone: "neutral" }
              : captureStatusFor(st, this.playerFaction);
          break;
        }
      }
      this.hud.setCaptureStatus(captureStatus);
    }
    if (myStub) {
      this.radar.update(
        myStub as unknown as Ship,
        this.shadowStubs[this.playerFaction] as unknown as Ship[],
        this.sensors.contacts[this.playerFaction],
        this.missileWarning.threats,
        this.carrierSims,
        this.rockObstacles,
        this.combatNebulas.zones,
        this.stormClouds.zones,
        this.netStationList,
        nowMs,
        this.humanPiloted,
      );
    }

    // Nameplates off the shadow roster: friendly pilots always, an enemy's
    // only while it's the lock target, never our own ship (the own-ship
    // engine tint is that cue). Human names vs AI callsigns style
    // differently (honesty rule); launch-gated like offline (a DOM label
    // would float over the carrier hull — DOM ignores occlusion).
    this.nameplates.begin(this.cameraRig.currentZoom);
    for (const [key, stub] of this.shadows) {
      if (key === this.myKey || !stub.present || !stub.isAlive || stub.launching) continue;
      if (stub.callsign === "") continue;
      const friendly = stub.faction === this.playerFaction;
      if (!friendly && stub !== this.lockStub) continue;
      this.nameplates.show(
        key,
        stub.callsign,
        stub.position.x,
        stub.position.z,
        stub.isHumanPilot ? "human" : "ai",
        stub.faction,
      );
    }
    this.nameplates.end();

    // Netcode readout — stats gathered only while the panel is showing (the
    // one dev-path allocation; the overlay itself rewrites at 5Hz).
    if (this.netDebug.visible) {
      const myBuf = this.myKey !== null ? this.snaps.get(this.myKey) : undefined;
      this.netDebug.update(nowMs, {
        clockOffsetMs: this.clockOffsetMs,
        bufferDepth: myBuf?.length ?? 0,
        bufferHeadroomMs:
          myBuf && myBuf.length > 0 ? myBuf[myBuf.length - 1].t - renderT : 0,
        pendingInputs: this.pendingInputs.length,
        ackLagInputs: this.inputSeq - this.myServer.seq,
        correctionUnits: Math.hypot(this.correctionPos.x, this.correctionPos.z),
        correctionDeg: (Math.abs(this.correctionRot) * 180) / Math.PI,
        fxQueueDepth: this.fxQueue.length,
        shipsTracked: this.snaps.size,
      });
    }

    this.scene.render();
  };

  /** Interpolate the buffer at time `t` into `out` (hold the ends; no extrapolation). */
  private sampleInto(buf: Snap[], t: number, out: MutablePose): void {
    const last = buf[buf.length - 1];
    if (t >= last.t) {
      out.position.set(last.x, 0, last.z);
      out.rotationY = last.rot;
      out.bankAngle = last.bank;
      this.sampleDiscrete(last, out);
      return;
    }
    if (t <= buf[0].t) {
      out.position.set(buf[0].x, 0, buf[0].z);
      out.rotationY = buf[0].rot;
      out.bankAngle = buf[0].bank;
      this.sampleDiscrete(buf[0], out);
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
        this.sampleDiscrete(a, out); // discrete; take the earlier sample's state
        return;
      }
    }
  }

  /** Copy a snap's discrete (non-lerpable) fields into the pose scratch. */
  private sampleDiscrete(s: Snap, out: MutablePose): void {
    out.isAlive = s.alive;
    out.reverse = s.rev;
    out.strafeLeft = s.sl;
    out.strafeRight = s.sr;
  }

  /**
   * Mirror the replicated stations onto client-side CaptureStation copies
   * (created on first sight — positions are static) so views/radar/HUD read
   * the offline shape, then derive the STATION-POWERED shield factor onto
   * both local carrier sims (the same graduated formula StrategicSystem
   * writes server-side; zero new wire data). Runs each tick BEFORE the FX
   * playback so shieldedCarrierAt reads this frame's ownership. Pre-first-
   * patch the list is empty → factor 1 (unshielded), matching the sim
   * default.
   */
  private mirrorStations(): void {
    const state = this.net.room.state as unknown as {
      stations?: {
        forEach: (
          cb: (v: {
            id: number;
            x: number;
            z: number;
            owner: string;
            capturing: string;
            progress: number;
            contested: boolean;
          }) => void,
        ) => void;
      };
    };
    state?.stations?.forEach((s) => {
      let st = this.netStations.get(s.id);
      if (!st) {
        st = new CaptureStation(s.id, s.x, s.z);
        this.netStations.set(s.id, st);
        this.netStationList.push(st);
        this.stationViews.push(new StationView(this.scene, st));
      }
      st.owner = (s.owner || null) as Faction | null;
      st.capturingFaction = (s.capturing || null) as Faction | null;
      st.progress = s.progress;
      st.contested = s.contested;
    });
    const total = this.netStationList.length;
    const minFactor = GameConfig.stations.shield.minFactor;
    let ownedHumans = 0;
    let ownedMachines = 0;
    for (const st of this.netStationList) {
      if (st.owner === "humans") ownedHumans++;
      else if (st.owner === "machines") ownedMachines++;
    }
    this.carrierSims.humans.stationShieldFactor =
      total === 0 ? 1 : 1 - (1 - minFactor) * (ownedHumans / total);
    this.carrierSims.machines.stationShieldFactor =
      total === 0 ? 1 : 1 - (1 - minFactor) * (ownedMachines / total);
  }

  /**
   * Was this non-ship hit a SHIELDED carrier hull? The wire flattens every
   * non-ship target to "" (protocol.ts), so the solo check (`target
   * instanceof MothershipSection && owner.shieldsUp`) is re-derived here from
   * the local carrier sims: the hit point must lie inside a hull-section box
   * (small margin — hit positions land on section edges) of a carrier whose
   * station-derived factor says shieldsUp, and must NOT be a live turret or
   * subsystem being chipped (those poke past the silhouette and also arrive
   * as target:""). Returns the defending faction, or null. Cosmetic-only, so
   * a one-patch race around the exact shields-down frame is acceptable.
   */
  private shieldedCarrierAt(x: number, z: number): Faction | null {
    const MARGIN = 2;
    for (const f of ["humans", "machines"] as Faction[]) {
      const carrier = this.carrierSims[f];
      if (!carrier.isAlive || !carrier.shieldsUp) continue;
      let inHull = false;
      for (const s of carrier.hullSections) {
        if (
          x >= s.minX - MARGIN &&
          x <= s.maxX + MARGIN &&
          z >= s.minZ - MARGIN &&
          z <= s.maxZ + MARGIN
        ) {
          inHull = true;
          break;
        }
      }
      if (!inHull) continue;
      // Exclude turret/subsystem chips: near a LIVE mounted target, the hit
      // was (almost certainly) that target, not the shielded hull.
      for (const t of carrier.turrets) {
        if (!t.isAlive) continue;
        const dx = x - t.position.x;
        const dz = z - t.position.z;
        const r = t.hitRadius + 1;
        if (dx * dx + dz * dz <= r * r) return null;
      }
      for (const s of carrier.subsystems) {
        if (!s.isAlive) continue;
        const dx = x - s.position.x;
        const dz = z - s.position.z;
        const r = s.hitRadius + 1;
        if (dx * dx + dz * dz <= r * r) return null;
      }
      return f;
    }
    return null;
  }

  /**
   * Depict one replicated sim fact — the MP mirror of Game.wireSimEventFeedback.
   * Deliberate difference from offline: no hitstop (freezing the render clock
   * would desync the interpolation timeline). Kill/score bookkeeping rides
   * shipDied's `by` field (recordKill).
   */
  private applyFxEvent(e: NetEvent): void {
    const shake = GameConfig.shake;
    switch (e.k) {
      case "laserFired": {
        // Depiction rides the event's faction/type (`f`/`st`): a sensor-hidden
        // shooter never replicated to us, but its bolts are visible objects.
        if (e.mx.length === 0) return;
        const type = GameConfig.shipTypes[e.st];
        for (let i = 0; i < e.mx.length; i++) {
          this.fxVec.set(e.mx[i], 0, e.mz[i]);
          this.cosmeticLasers[e.f].spawn(this.fxVec, e.rot, null, 0, false, 0, type.heavy);
        }
        this.fxVec.set(e.mx[0], 0, e.mz[0]);
        this.sound.playFireSound(type.fireSound, e.ship === this.myKey ? undefined : this.fxVec);
        return;
      }
      case "missileFired": {
        // The cosmetic round homes on the TARGET's shadow (the lock ship id
        // rides the event), so its depiction tracks the interpolated pose;
        // the missileHit event still detonates it at the server's truth.
        // Launch point: the shooter's interpolated pose (nose offset — same
        // as Ship.tryFireMissile) so the round leaves the rendered ship; a
        // sensor-hidden shooter has no pose, so fall back to the event's
        // launch coordinates (the round is visible even when the ship isn't).
        const pose = this.poseOf(e.ship);
        const target = e.target !== "" ? (this.shadows.get(e.target) ?? null) : null;
        const off = GameConfig.missile.spawnOffset;
        const rot = pose?.rotationY ?? e.rot;
        if (pose) {
          this.fxVec.set(
            pose.position.x + Math.sin(rot) * off,
            0,
            pose.position.z + Math.cos(rot) * off,
          );
        } else {
          this.fxVec.set(e.x, 0, e.z);
        }
        this.cosmeticMissiles[e.f].spawn(
          this.fxVec,
          rot,
          target ? (target as unknown as Ship) : null,
          null,
        );
        this.sound.playMissileLaunch(e.ship === this.myKey ? undefined : this.fxVec);
        return;
      }
      case "laserHit": {
        this.fxVec.set(e.x, e.y, e.z);
        this.sound.playHit(this.fxVec);
        this.explosions.spawnSpark(this.fxVec);
        // The wire says target:"" for every non-ship hit (carrier hull,
        // turret, subsystem alike) — derive "shielded carrier hull" locally
        // and add the tinted splash, mirroring solo's onLaserHit.
        if (e.target === "") {
          const shielded = this.shieldedCarrierAt(e.x, e.z);
          if (shielded) this.shieldHitFlashes.spawn(this.fxVec, shielded);
        }
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
        this.killNearestMissile(e.x, e.z);
        // Our predictive fuse may have already depicted this exact boom
        // (fuseFriendlyMissiles) — consume the ledger entry instead of
        // double-popping. Never consumed for hits ON US (those come from
        // the ENEMY pool, which the fuse doesn't touch — being hit stays
        // strictly authoritative).
        if (
          e.k === "missileHit" &&
          !(this.myKey !== null && e.target === this.myKey) &&
          this.consumeLocalDetonation(e.x, e.z)
        ) {
          return;
        }
        this.fxVec.set(e.x, e.y, e.z);
        this.explosions.spawn(this.fxVec);
        this.sound.playExplosion(this.fxVec);
        // Missile into a shielded carrier hull: same derivation as laserHit
        // (intercepted rounds die mid-air, so only real hits splash).
        if (e.k === "missileHit" && e.target === "") {
          const shielded = this.shieldedCarrierAt(e.x, e.z);
          if (shielded) this.shieldHitFlashes.spawn(this.fxVec, shielded);
        }
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
          // Our catapult fired — start easing the opening wide shot down to
          // the default framing (consumed by the camera block in tick()).
          if (this.openingShot && this.launchZoomEaseStartMs === null) {
            this.launchZoomEaseStartMs = performance.now();
          }
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
        const stub = this.shadows.get(e.ship);
        if (stub) {
          stub.spoolStartMs = null;
          // Death is observable (this explosion) — mark the stub dead even
          // when the ship is sensor-hidden (absent stubs get no snapshots),
          // so the client sensors drop its track instead of ghosting it.
          stub.isAlive = false;
        }
        this.recordKill(e);
        // Our own death: hand the killer to the death-cam so it opens on
        // them. This event rides the FX queue, so it can land a beat AFTER
        // the alive→dead patch already began the spectate — setPreferred
        // covers that window ("" = environment kill → no preference).
        if (e.ship === this.myKey) {
          const killer = e.by !== "" ? (this.shadows.get(e.by) ?? null) : null;
          this.spectator.setPreferred(killer);
          this.myKillerKey = e.by !== "" ? e.by : null;
        }
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
        // Kill the matching MIRROR turret (turret HP is not replicated —
        // this event is the only death signal), so TurretView drops the gun
        // to its stump and runs the dead-turret burn, same as offline. The
        // event position is the turret's static mount: nearest-match it.
        let nearest: { hp: number } | null = null;
        let nearestSq = Infinity;
        for (const f of ["humans", "machines"] as Faction[]) {
          for (const t of this.carrierSims[f].turrets) {
            const dx = t.position.x - e.x;
            const dz = t.position.z - e.z;
            const dSq = dx * dx + dz * dz;
            if (dSq < nearestSq) {
              nearestSq = dSq;
              nearest = t;
            }
          }
        }
        if (nearest) nearest.hp = 0;
        return;
      }
      case "subsystemDestroyed": {
        // Mirrors the offline subsystemDestroyed subscription in Game.ts —
        // a slightly bigger cue than a turret (it moves the strategic
        // picture) plus the HUD toast colored by whose carrier lost it.
        this.fxVec.set(e.x, e.y, e.z);
        this.explosions.spawn(this.fxVec);
        this.sound.playExplosion(this.fxVec);
        this.cameraRig.addTrauma(
          this.traumaAtDistance(
            GameConfig.mothership.subsystems.destroyTrauma,
            e.x,
            e.z,
          ),
        );
        // Per-bay milestone toast; the LAST bay escalates to the full
        // headline (mirrors the Game.ts subscription; `remaining` counted
        // server-side at emit).
        const name = FACTION_THEME[e.faction].mothershipName.toUpperCase();
        this.hud.showStrategicToast(
          e.remaining > 0
            ? `${name} HANGAR BAY DESTROYED`
            : `${name} HANGAR DESTROYED — LAUNCH CREWS CRIPPLED`,
          e.faction === this.playerFaction ? "bad" : "good",
        );
        return;
      }
      case "shieldsDown": {
        // Shield state derives from the replicated station owners; the event
        // marks the moment for the headline toast (mirrors Game.ts).
        const name = FACTION_THEME[e.faction].mothershipName.toUpperCase();
        this.hud.showStrategicToast(
          `${name} SHIELDS OFFLINE — NO STATION POWER`,
          e.faction === this.playerFaction ? "bad" : "good",
        );
        return;
      }
      case "shieldsOnline": {
        const name = FACTION_THEME[e.faction].mothershipName.toUpperCase();
        this.hud.showStrategicToast(
          `${name} SHIELDS ONLINE — STATION POWER`,
          e.faction === this.playerFaction ? "good" : "bad",
        );
        return;
      }
      case "stationCaptured": {
        // Continuous capture state rides the schema; the event is the toast
        // moment (mirrors the offline subscriptions in Game.ts).
        const own = e.faction === this.playerFaction;
        this.hud.showStrategicToast(
          own ? "STATION CAPTURED — ENERGY ONLINE" : "ENEMY CAPTURED A STATION",
          own ? "good" : "bad",
        );
        return;
      }
      case "stationNeutralized": {
        const own = e.faction === this.playerFaction;
        this.hud.showStrategicToast(
          own ? "ENEMY STATION NEUTRALIZED" : "STATION LOST — BEING NEUTRALIZED",
          own ? "good" : "bad",
        );
        return;
      }
      case "upgradeUnlocked": {
        // T3's one-shot revives that faction's turrets server-side; mirror
        // it here (turret HP is not replicated) so the TurretViews un-stump.
        if (e.effect === "turretOverdrive") {
          for (const t of this.carrierSims[e.faction].turrets) {
            t.hp = t.maxHp;
          }
        }
        const own = e.faction === this.playerFaction;
        const label = UPGRADE_LABELS[e.effect];
        this.hud.showStrategicToast(
          own ? `UPGRADE ONLINE — ${label}` : `ENEMY UPGRADE — ${label}`,
          own ? "good" : "bad",
        );
        return;
      }
      case "jumpSpoolStarted": {
        const pose = this.poseOf(e.ship);
        // Shadow spool state: the radar's filling ring + the HUD's own jump
        // gauge + the sensors' signature-spike rule all read it.
        const stub = this.shadows.get(e.ship);
        if (stub) stub.spoolStartMs = performance.now();
        // A sensor-hidden spooler has no pose yet (the spool spike makes the
        // server replicate it within a sweep) — starting the clip poseless
        // would play it NON-SPATIAL, i.e. as loud as our own drive. Skip it.
        if (e.ship !== this.myKey && !pose) return;
        this.sound.startJumpDrive(
          this.jumpKey(e.ship),
          e.ship === this.myKey ? null : pose!.position.clone(),
        );
        return;
      }
      case "jumpCancelled": {
        const stub = this.shadows.get(e.ship);
        if (stub) stub.spoolStartMs = null;
        this.sound.stopJumpDrive(this.jumpKey(e.ship));
        return;
      }
      case "asteroidShattered": {
        this.fxVec.set(e.x, e.y, e.z);
        this.explosions.spawn(this.fxVec);
        this.sound.playExplosion(this.fxVec);
        this.cameraRig.addTrauma(
          this.traumaAtDistance(GameConfig.asteroids.shatterTrauma, e.x, e.z) *
            Math.min(1, e.r / GameConfig.asteroids.radiusMax),
        );
        return;
      }
      case "shipRammedAsteroid": {
        // Offline parity: the heavy cue is for the local pilot only.
        if (e.ship === this.myKey) {
          this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerLaserHit);
          const pose = this.poseOf(e.ship);
          if (pose) this.sound.playHit(pose.position);
        }
        return;
      }
      case "shipRammedHulk": {
        // Wreck scrape: same ram-weight cue, local pilot only (offline parity).
        if (e.ship === this.myKey) {
          this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerLaserHit);
          const pose = this.poseOf(e.ship);
          if (pose) this.sound.playHit(pose.position);
        }
        return;
      }
      case "stormZap": {
        // Lightning + spark at the victim, but ONLY if we hold a pose for it
        // — a storm conceals, so a sensor-hidden victim never replicated here
        // and depicting its strike would leak the stealth picture.
        const pose = this.poseOf(e.ship);
        if (pose) {
          this.lightning.strike(pose.position);
          this.explosions.spawnSpark(pose.position);
        }
        // Offline parity: the heavy cue is for the local pilot only.
        if (e.ship === this.myKey) {
          this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerLaserHit);
          if (pose) this.sound.playHit(pose.position);
        }
        return;
      }
      case "jumpFired": {
        const stub = this.shadows.get(e.ship);
        if (stub) stub.spoolStartMs = null;
        this.sound.releaseJumpDrive(this.jumpKey(e.ship));
        this.visuals.get(e.ship)?.glow?.resetTrails();
        const from = new Vector3(e.fromX, 0, e.fromZ);
        const to = new Vector3(e.toX, 0, e.toZ);
        // BSG "FTL crack" at BOTH ends (offline parity): flash + shockwave
        // where the ship left AND where it arrived — for our OWN jump the
        // camera snaps to the arrival, so the `to` ripple is the one we see.
        this.jumpFlashes.spawn(from);
        this.jumpFlashes.spawn(to);
        this.jumpRipple.spawn(from);
        this.jumpRipple.spawn(to);
        // Spectral hull ghosts (offline parity): snapshot the depicted root
        // in place for the phase-out streak, and re-pose it at the arrival
        // for the phase-in. A sensor-hidden jumper has no (enabled) view —
        // skip rather than leak a ghost of a ship we never depicted.
        // Arrival heading = the home carrier's (humans 0, machines π).
        const jumperView = this.views.get(e.ship);
        if (jumperView?.root.isEnabled()) {
          const faction = this.meta.get(e.ship)?.faction;
          this.jumpGhosts.spawnDeparture(jumperView.root);
          this.jumpGhosts.spawnArrival(
            jumperView.root,
            e.toX,
            e.toZ,
            faction === "machines" ? Math.PI : 0,
          );
        }
        if (e.ship === this.myKey) {
          // Our own teleport: hard-snap the camera across the discontinuity
          // (mirrors offline) and zero the velocity lead so it doesn't whip.
          this.cameraRig.snapTo(to);
          this.cameraRig.addTrauma(GameConfig.jump.arrivalTrauma);
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
   * Reconcile the local rock set with the replicated map: new entries (the
   * initial field, later shatter chunks) become REAL AsteroidSims rebuilt from
   * their spawn state — no RNG draws, view + collision shape included; entries
   * gone from the map (shattered/destroyed) are disposed. Death FX arrive
   * separately as asteroidShattered events.
   */
  private syncRocks(map: { forEach: (cb: (v: NetRock, k: string) => void) => void }): void {
    const seen = new Set<string>();
    map.forEach((r, id) => {
      seen.add(id);
      if (this.rocks.has(id)) return;
      const sim = new AsteroidSim({
        position: new Vector3(r.x, GameConfig.asteroids.yLevel, r.z),
        drift: new Vector3(r.driftX, 0, r.driftZ),
        visualRadius: r.visualRadius,
        spin: new Vector3(r.spinX, r.spinY, r.spinZ),
        squash: { x: r.squashX, y: r.squashY },
        orientation: { x: r.rotX, y: r.rotY, z: r.rotZ },
      });
      // Life/death is authoritative via map add/remove — make the local copy
      // unkillable so cosmetic bolt damage can't kill it early.
      sim.hp = Number.MAX_SAFE_INTEGER;
      this.rocks.set(id, {
        sim,
        view: new AsteroidView(this.scene, this.rockMaterial, sim),
        simT: r.t0,
      });
      this.rockObstacles.push(sim);
      this.cosmeticObstacles.push(sim);
    });
    for (const [id, entry] of this.rocks) {
      if (seen.has(id)) continue;
      entry.view.dispose();
      const i = this.rockObstacles.indexOf(entry.sim);
      if (i >= 0) this.rockObstacles.splice(i, 1);
      const j = this.cosmeticObstacles.indexOf(entry.sim);
      if (j >= 0) this.cosmeticObstacles.splice(j, 1);
      this.rocks.delete(id);
    }
  }

  /** Mirror AsteroidFieldSim.wrap at the same arena bounds the server uses. */
  private wrapRock(a: AsteroidSim): void {
    const mx = GameConfig.arena.halfWidth + a.visualRadius;
    const mz = GameConfig.arena.halfDepth + a.visualRadius;
    if (a.position.x > mx) a.position.x = -mx;
    else if (a.position.x < -mx) a.position.x = mx;
    if (a.position.z > mz) a.position.z = -mz;
    else if (a.position.z < -mz) a.position.z = mz;
  }

  /**
   * Light one ship's exhaust from this frame's rendered pose (this.pose must
   * hold it — call right after view.update). Our own ship burns on REAL input
   * (predicted sim speed + held keys, RCS plumes included) and hides the glow
   * in the launch tube like offline (a lit glow bleeds through the carrier
   * hull via the GlowLayer). Remote MAIN-engine intensity rides a speed
   * estimate from pose deltas (thrust isn't on the wire): above half throttle
   * reads as burning, below as coasting. Remote RCS plumes (friendly ships
   * only — see makeView) DO ride the wire: the reverse/strafe bits of the
   * applied input replicate per ship and interpolate with the pose. Dead
   * ships taper the plumes to zero (the disabled root hides them, but a
   * respawn would otherwise re-enable a frozen mid-glow plume).
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
      vis.thrusters?.update(dt, this.pose.reverse, this.pose.strafeLeft, this.pose.strafeRight);
    } else {
      vis.thrusters?.update(dt, false, false, false);
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
    // Built eagerly (not just when prediction activates): the HUD reads
    // HP/ammo/pos off this Ship from the first snapshot, launch tube included.
    if (!this.predicted) this.predicted = this.buildPredictedShip(meta);
    const shouldPredict =
      this.myAlive &&
      !this.myLaunching &&
      !this.ended &&
      !this.connectionLost &&
      // While the connection is down the prediction would fly blind (no acks,
      // no reconciliation) and snap on resume — freeze at the last-known pose
      // instead; onReconnected re-seeds from the first authoritative patch.
      !this.reconnecting;
    if (!shouldPredict) {
      this.predictionActive = false;
      this.pendingInputs.length = 0;
      return;
    }
    if (!this.predictionActive) {
      if (!this.myServer.valid) return;
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
    }
    const ship = this.predicted!;
    ship.update(dt, this.input.state);

    // Predict the solid-world bumps the server will apply — without these,
    // rocks and carrier hulls are invisible rubber-band walls (the server
    // corrects you but the prediction keeps flying into them). Same shared
    // math as BattleSim; ram damage/FX stay server-side (events).
    for (const entry of this.rocks.values()) {
      if (collideShipWithAsteroid(ship, entry.sim)) break; // one bump per frame
    }
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const s of this.carrierSims[f].hullSections) {
        bumpShipOutOfSection(ship, s);
      }
    }
    for (const hulk of this.hulks) {
      for (const s of hulk.sections) {
        bumpShipOutOfHulkSection(ship, s);
      }
    }

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
      const missilePositions = ship.tryFireMissile();
      if (missilePositions.length > 0) {
        // The depicted rounds home on the same lock the HUD advertises (the
        // server computes its own identical lock — BattleSim.computeLockFor).
        for (const p of missilePositions) {
          this.cosmeticMissiles[meta.faction].spawn(
            p,
            ship.rotationY,
            this.lockStub ? (this.lockStub as unknown as Ship) : null,
            null,
          );
        }
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
    // Replay re-runs MOVEMENT only — preserve the weapon cooldowns across it,
    // or every reconciliation drains extra (replayed) time from the fire
    // timers and the held-fire cadence wobbles with the pending-input count.
    const timers = ship.saveWeaponTimers();
    const dt = NetworkGame.SEND_INTERVAL_MS / 1000;
    for (const p of this.pendingInputs) ship.update(dt, p.input);
    ship.restoreWeaponTimers(timers);
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

  /**
   * The enemy shadow a missile fired now would lock: nearest live enemy in
   * lockRange + lock cone, not concealed — the client mirror of
   * BattleSim.computeLockFor over the shadow roster (HUD cue + the predicted
   * round's homing; the authoritative lock stays server-side).
   */
  private computeNetLock(): ShadowShip | null {
    const me = this.myKey !== null ? this.shadows.get(this.myKey) : undefined;
    if (!me || !me.isAlive || !this.myAlive || this.myLaunching) return null;
    const cfg = GameConfig.missile;
    const px = me.position.x;
    const pz = me.position.z;
    // Aim from the PREDICTED heading when flying it — that's the nose the
    // player sees (the shadow's rendered rotation includes the correction).
    const heading =
      this.predictionActive && this.predicted ? this.predicted.rotationY : me.rotationY;
    let best: ShadowShip | null = null;
    let bestDist = Infinity;
    for (const enemy of this.shadowStubs[this.enemyFaction]) {
      if (!enemy.isAlive) continue;
      const dx = enemy.position.x - px;
      const dz = enemy.position.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.lockRange || dist >= bestDist) continue;
      if (this.sensors.isConcealed(enemy.position)) continue;
      const angleToEnemy = Math.atan2(dx, dz);
      if (Math.abs(wrapAngle(angleToEnemy - heading)) > cfg.lockConeAngle) continue;
      best = enemy;
      bestDist = dist;
    }
    return best;
  }

  /**
   * Tally a shipDied event onto the kill/score board (mirrors Game.recordKill:
   * only enemy fighters count; only OUR OWN kills score + roll the shared
   * persistent best; other friendly shooters — human or AI — tally as wing).
   * Victim identity rides the event (`vf`/`vt`) — under sensor-filtered
   * replication the victim may never have replicated to this client (a wing
   * kill deep in enemy territory), so `meta` can't be relied on.
   */
  private recordKill(e: { by: string; vf: Faction; vt: ShipTypeId }): void {
    const shooterId = e.by;
    if (e.vf !== this.enemyFaction || shooterId === "") return;
    if (shooterId === this.myKey) {
      this.playerKills++;
      this.score += GameConfig.shipTypes[e.vt].maxHp;
      if (this.score > this.bestScore) {
        this.bestScore = this.score;
        try {
          localStorage.setItem(BEST_SCORE_KEY, String(this.bestScore));
        } catch {
          // Storage unavailable — the in-session best still shows.
        }
      }
    } else if (this.meta.get(shooterId)?.faction === this.playerFaction) {
      this.wingKills++;
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
      missileSalvo: type.missileSalvo,
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

  /**
   * Predictive contact fuse for OUR faction's depicted missiles. Our own
   * rounds launch from the PREDICTED ship the instant the key acts
   * (updatePrediction), which puts them ~a round trip + interp delay ahead
   * of the render timeline — left alone they visibly fly THROUGH the enemy
   * and the server's missileHit boom pops behind them. Detonate the
   * depiction the moment a round touches a rendered enemy hull (the same
   * hitRadius the server tests), and log it so the echoing missileHit event
   * is consumed instead of double-popping. DAMAGE IS NEVER PREDICTED — if
   * the server disagrees (a last-instant juke), we showed a boom that dealt
   * nothing, the standard client-prediction trade. Teammates' rounds ride
   * the render timeline, so for them this fires ≤ a frame before their
   * event would — the dedup absorbs it either way.
   */
  private fuseFriendlyMissiles(nowMs: number): void {
    const rounds = this.cosmeticMissiles[this.playerFaction].rounds;
    if (rounds.length === 0) return;
    const enemies = this.shadowStubs[this.enemyFaction];
    for (const round of rounds) {
      if (!round.isAlive) continue;
      for (const shadow of enemies) {
        if (!shadow.isAlive || shadow.launching) continue;
        const dx = round.position.x - shadow.position.x;
        const dz = round.position.z - shadow.position.z;
        const r = shadow.hitRadius;
        if (dx * dx + dz * dz > r * r) continue;
        round.kill();
        this.fxVec.set(round.position.x, 0, round.position.z);
        this.explosions.spawn(this.fxVec);
        this.sound.playExplosion(this.fxVec);
        this.cameraRig.addTrauma(
          this.traumaAtDistance(GameConfig.shake.traumaMissileHit, this.fxVec.x, this.fxVec.z),
        );
        this.localDetonations.push({
          x: this.fxVec.x,
          z: this.fxVec.z,
          expiresMs: nowMs + 600,
        });
        break;
      }
    }
  }

  /**
   * Match a server missileHit against a recent predictive detonation
   * (fuseFriendlyMissiles) and consume it — true means the boom was already
   * depicted locally and the event should skip its own. Expired entries
   * (server never confirmed — it missed) are pruned as encountered.
   */
  private consumeLocalDetonation(x: number, z: number): boolean {
    const now = performance.now();
    for (let i = this.localDetonations.length - 1; i >= 0; i--) {
      const d = this.localDetonations[i];
      if (now > d.expiresMs) {
        this.localDetonations.splice(i, 1);
        continue;
      }
      const dx = d.x - x;
      const dz = d.z - z;
      if (dx * dx + dz * dz <= 6 * 6) {
        this.localDetonations.splice(i, 1);
        return true;
      }
    }
    return false;
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
      // Our own seat's burn wears the own-ship tint (teal); everyone else
      // burns their FACTION's exhaust color (blue vs red — the friend-or-foe
      // cue, client-only depiction, remote peers never see it). myKey is
      // always known by now: it's set while the patch that first carries our
      // ship ingests, and views are only built afterwards, in the render
      // pass over that patch's snapshots.
      glow: hasTemplate
        ? new EngineGlow(
            this.scene,
            view.root,
            this.glowLayer,
            nozzles.length > 0 ? nozzles : this.rearEmitters(view.root),
            key === this.myKey
              ? GameConfig.ownShipTint
              : factionExhaust(m.faction),
          )
        : null,
      // RCS plumes ride the replicated reverse/strafe bits — FRIENDLY ships
      // only, mirroring offline (the wing depicts its pilots' input; the
      // enemy fleet doesn't). Config nozzle positions; MP templates don't
      // expose the GLB rcs markers.
      thrusters:
        m.faction === this.playerFaction
          ? new SecondaryThrusters(this.scene, view.root, this.glowLayer, {})
          : null,
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

  /** This faction's respawn-delay multiplier over replicated state — the
   *  GRADUATED hangar penalty (replicated bay HP → carrier sim) × the
   *  fasterRespawn upgrade (replicated tier). Mirrors
   *  StrategicSystem.respawnScale; drives the cosmetic redeploy countdown
   *  only. */
  private respawnScaleFor(f: Faction): number {
    let total = 0;
    let dead = 0;
    for (const s of this.carrierSims[f].subsystems) {
      if (s.kind !== "hangar") continue;
      total++;
      if (!s.isAlive) dead++;
    }
    const hangarPenalty =
      total === 0
        ? 1
        : 1 +
          (GameConfig.mothership.subsystems.hangar.destroyedRespawnDelayScale - 1) *
            (dead / total);
    const thresholds = GameConfig.energy.thresholds;
    const tier = Math.min(this.netTier[f], thresholds.length);
    let upgrade = 1;
    for (let i = 0; i < tier; i++) {
      if (thresholds[i].effect === "fasterRespawn") {
        upgrade = GameConfig.energy.fasterRespawnScale;
      }
    }
    return hangarPenalty * upgrade;
  }

  /** This faction's radar-range multiplier from its replicated upgrade tier
   *  (mirrors StrategicSystem.applyEffects's sensorBoost half). */
  private sensorScaleFor(f: Faction): number {
    const thresholds = GameConfig.energy.thresholds;
    const tier = Math.min(this.netTier[f], thresholds.length);
    for (let i = 0; i < tier; i++) {
      if (thresholds[i].effect === "sensorBoost") {
        return GameConfig.energy.sensorRangeScale;
      }
    }
    return 1;
  }

  /**
   * Copy the replicated subsystem HP slot (the hangar) into the local
   * carrier sim's subsystem objects — mirrors BattleRoom.syncSubsystems.
   * An undefined field (pre-first-patch) leaves the local full-HP default
   * untouched.
   */
  private applySubsystemHp(
    carrier: Mothership,
    ms: { hangar0Hp?: number; hangar1Hp?: number },
  ): void {
    let bay = 0;
    for (const sub of carrier.subsystems) {
      if (sub.kind !== "hangar") continue;
      // Index-aligned with BattleRoom.syncSubsystems (buildSubsystems order).
      const v = bay === 0 ? ms.hangar0Hp : bay === 1 ? ms.hangar1Hp : undefined;
      if (v !== undefined) sub.hp = v;
      bay++;
    }
  }

  /**
   * The replicated per-pilot tallies (BattleState.scores) as view rows for
   * the scoreboard panel + end-of-game board. The scores map is UNFILTERED
   * root state, so every pilot is here — never-seen stealthed enemies and
   * all history a late joiner missed included. Empty until the first patch.
   */
  private scoreRows(): ScoreRow[] {
    const state = this.net.room.state as unknown as {
      scores?: {
        forEach(
          cb: (entry: {
            id: string;
            callsign: string;
            faction: string;
            isAI: boolean;
            kills: number;
            deaths: number;
            score: number;
          }) => void,
        ): void;
      };
    };
    const rows: ScoreRow[] = [];
    state.scores?.forEach((e) => {
      rows.push({
        callsign: e.callsign,
        faction: e.faction as Faction,
        kills: e.kills,
        deaths: e.deaths,
        score: e.score,
        isPlayer: e.id === this.myKey,
        isHuman: !e.isAI,
      });
    });
    return rows;
  }

  private updatePhase(phase: string, winner: string): void {
    // Once the end banner is up, nothing may overwrite it: the server locks
    // an ended room and disposes it after net.endedRoomLingerSec, so the
    // connection dying underneath us here is EXPECTED — Enter (rematch) and
    // Esc (menu) both keep working without the room.
    if (this.ended) return;
    if (this.connectionLost) {
      this.hud.setLaunchOverlay("CONNECTION LOST · refresh to rejoin");
      return;
    }
    if (this.reconnecting) {
      this.hud.setLaunchOverlay("CONNECTION LOST — RECONNECTING…");
      return;
    }
    if (phase === "ended") {
      this.ended = true;
      this.hud.setLaunchOverlay(null);
      this.hud.setEndBanner(
        winner === this.playerFaction ? "victory" : "defeat",
        `KILLS ${this.playerKills} · SCORE ${this.score}${
          this.score > 0 && this.score >= this.bestScore ? " · NEW BEST" : ""
        }`,
        // The match leaderboard, straight from the replicated tallies — a
        // late joiner's board is complete because it's state, not events.
        this.scoreRows(),
      );
      return;
    }
    this.hud.setLaunchOverlay(phase === "launching" ? "STAND BY" : null);
  }

  handleResize(): void {
    this.engine.resize();
  }

  private readonly onPageHide = (): void => {
    // Best-effort consented leave — frees the seat immediately server-side.
    void this.net.leave();
  };

  dispose(): void {
    this.disposing = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("pagehide", this.onPageHide);
    this.netDebug.dispose();
    this.nameplates.dispose(); // DOM layer — scene.dispose won't remove it
    this.input.detach();
    this.mouse.detach();
    this.gamepad.detach();
    void this.net.leave();
    // Stop the track explicitly — a queued locked-context play or the
    // onEnded chain would otherwise outlive scene.dispose().
    this.music.stop();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
