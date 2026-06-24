import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
// ACES tone-mapping constant lives on ImageProcessingConfiguration.
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
// Builds a cube/IBL environment from an equirectangular image — used to light
// the PBR (metallic) GLB ships, which need an environment to reflect.
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture";

import { GameConfig, type ShipTypeId, type WingOrder } from "./GameConfig";
import { InputManager } from "./InputManager";
import { Arena } from "./Arena";
import { AssetLoader } from "./AssetLoader";
import { Ship } from "./sim/Ship";
import type { ShipTypeConfig } from "./sim/Ship";
import { ShipView } from "./view/ShipView";
import { LaserSystem } from "./sim/LaserSystem";
import { LaserSystemView } from "./view/LaserSystemView";
import { MissileSystem } from "./sim/MissileSystem";
import { MissileSystemView } from "./view/MissileSystemView";
import { SimEventBus } from "./sim/SimEvents";
import { wrapAngle } from "./math";
import { CameraRig } from "./CameraRig";
import { Hud } from "./Hud";
import { Radar } from "./Radar";
import { MissileWarning } from "./MissileWarning";
import { Starfield } from "./Starfield";
import { EngineGlow } from "./EngineGlow";
import { SecondaryThrusters } from "./SecondaryThrusters";
import { CapitalShips } from "./CapitalShips";
import { AsteroidField } from "./AsteroidField";
import { Nebulas } from "./Nebulas";
import { CombatNebulas } from "./CombatNebulas";
import { Backdrop } from "./Backdrop";
import { ExplosionSystem } from "./ExplosionSystem";
import { JumpFlashSystem } from "./JumpFlashSystem";
import { JumpRipple } from "./JumpRipple";
import { SoundSystem } from "./SoundSystem";
import { MusicSystem } from "./MusicSystem";
import { DamageFlash } from "./DamageFlash";
import { Mothership } from "./sim/Mothership";
import { MothershipSection } from "./sim/MothershipSection";
import { Turret } from "./sim/Turret";
import { MothershipView } from "./view/MothershipView";
import { Hulk } from "./sim/Hulk";
import { HulkView } from "./view/HulkView";
import { LaunchSequence } from "./LaunchSequence";
import { opposing, FACTION_THEME, type Faction } from "./Faction";
import { LocalInputController } from "./LocalInputController";
import { AIController } from "./AIController";
import type { PlayerLoadout } from "./Loadout";
import { SensorSystem } from "./SensorSystem";
import { FleetCommander, type CommandedPilot } from "./FleetCommander";
import type { ShipController, ControllerWorld, AvoidObstacle } from "./ShipController";
import { buildFighterMesh } from "./FighterMesh";
import type { DamageTarget, InputState } from "./types";

/** Match lifecycle. The match has a beginning (launch), middle (playing), end. */
type GameState = "launching" | "playing" | "victory" | "defeat";

/**
 * sessionStorage flag set just before the end-of-match restart reload.
 * main.ts checks it on load to skip the splash and start the game directly.
 */
export const RESTART_FLAG = "space-duel-restart";

/** localStorage key for the all-time best score (survives reloads/sessions). */
const BEST_SCORE_KEY = "space-duel-best-score";

/** A ship plus whatever drives it (keyboard / AI / future network). */
interface Combatant {
  ship: Ship;
  /**
   * The ship's Babylon depiction. The sim half (`ship`) never touches the
   * scene; tick()'s view section copies ship → view once per frame.
   */
  view: ShipView;
  controller: ShipController;
  /**
   * Active catapult launch, or null once flying normally. While set (and not
   * complete) the sequence drives the ship and its controller is suppressed —
   * this is what freezes every ship in the tube until its own launch fires.
   */
  launch: LaunchSequence | null;
  /**
   * Which carrier launch bay this ship flies from (index into
   * GameConfig.mothership.launchBays). Assigned at launch; reused so a respawn
   * streams back out of the same tube.
   */
  bayIndex: number;
  /**
   * The InputState this ship flew on in the last advanced sim step — the bridge
   * that lets updateViews drive the ship's engine FX (glow + maneuvering plumes)
   * from the inputs the (scene-free) sim already consumed. `null` means the ship
   * was mid-launch this step, where the engine FX is forced dark (it's occluded
   * by the carrier; a lit glow bleeds through the hull via the GlowLayer).
   */
  lastInput: InputState | null;
}

/**
 * Top-level game coordinator. Owns the engine, scene, and every subsystem; runs
 * a single render loop that ticks input → combatants (player + AI) → lasers →
 * missiles → explosions → win/lose → camera → hud → render.
 *
 * The two factions (humans vs machines) are symmetric: each ship is a `Ship`
 * sim driven by a `ShipController`, and the "player" is just the ship wearing a
 * LocalInputController. Which side that is comes from GameConfig.player.faction.
 *
 * Objective: destroy the opposing mothership (victory); lose yours (defeat).
 *
 * Babylon coordinate system: default left-handed. Forward = +Z, up = +Y.
 */
export class Game {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly glowLayer: GlowLayer;
  private readonly input: InputManager;
  private readonly arena: Arena;
  private readonly asteroids: AsteroidField;
  /** Placed derelict wrecks (map hazards) — indestructible, slowly-rotating
   *  cover. Empty unless the active map configures hazards. Their circles wire
   *  into the weapon-obstacle list (LOS cover), the keep-out bump, and AI
   *  avoidance; update() spins them each sim step. */
  private readonly hulks: Hulk[] = [];
  private readonly hulkViews: HulkView[] = [];
  /**
   * Combined weapon line-of-sight cover: the asteroid field's live rocks plus
   * every hulk's cover circles. Rebuilt in place each sim step (the weapon
   * systems hold it BY REFERENCE). Without hulks it's a per-frame copy of the
   * rocks — same contents/order, so the headless baseline is unaffected.
   */
  private readonly weaponObstacles: DamageTarget[] = [];
  private readonly explosions: ExplosionSystem;
  private readonly jumpFlashes: JumpFlashSystem;
  private readonly jumpRipple: JumpRipple;
  private readonly sound: SoundSystem;
  /**
   * Sim→view event channel. Sim sites EMIT facts; the client-side feedback
   * listeners (wireSimEventFeedback) depict them. See sim/SimEvents.ts.
   */
  private readonly events = new SimEventBus();
  private readonly music: MusicSystem;
  private readonly cameraRig: CameraRig;
  private readonly starfield: Starfield;
  private readonly backdrop: Backdrop;
  private readonly hud: Hud;
  private readonly radar: Radar;
  /** Player's RWR — beep + HUD pulse + radar blips while a missile homes on them. */
  private readonly missileWarning: MissileWarning;

  /** Which side the human pilot flies, and the side they fight. */
  private readonly playerFaction: Faction;
  private readonly enemyFaction: Faction;
  /** Which catalog ship the pilot (and, by default, their wing) flies. */
  private readonly playerShipTypeId: ShipTypeId;

  /** Each faction's own laser bolts (humans fire humansLasers, etc.). */
  private readonly factionLasers: Record<Faction, LaserSystem>;
  /** Mesh-pooling depictions of the two laser systems (sim/view split). */
  private readonly factionLaserViews: Record<Faction, LaserSystemView>;
  /** Each faction's heat-seekers — any ship whose type carries a rack fires. */
  private readonly factionMissiles: Record<Faction, MissileSystem>;
  /** Per-round mesh+trail depictions of the two missile systems. */
  private readonly factionMissileViews: Record<Faction, MissileSystemView>;
  private readonly motherships: Record<Faction, Mothership>;
  /** Babylon depictions of the two carriers (sim/view split); the GLB swap lives here. */
  private readonly mothershipViews: Record<Faction, MothershipView>;

  /** All ships, regardless of side, plus their controllers. */
  private readonly combatants: Combatant[] = [];
  /**
   * Engine visuals for AI ships (glow + optional maneuvering-thruster plumes),
   * keyed by Ship. Driven each frame from that ship's emitted input so its
   * exhaust lights when it burns. Wingmen get both glow + thrusters (glow is
   * absent for a procedural mixed-wing type, which carries its own emissive
   * engine); enemy GLB fighters get a glow only (they don't strafe). The
   * player uses the standalone engineGlow/secondaryThrusters fields instead.
   */
  private readonly aiVisuals = new Map<
    Ship,
    { glow?: EngineGlow; thrusters?: SecondaryThrusters }
  >();
  /** Live roster per faction, refilled each frame; backs the controller world. */
  private readonly shipsByFaction: Record<Faction, Ship[]> = {
    humans: [],
    machines: [],
  };
  /**
   * Per-faction sensor picture. AI controllers (and, for the player's side,
   * the radar) target what THEIR faction's sensors report — last-known
   * contact positions — never the opposing ships' ground truth.
   */
  private readonly sensors: SensorSystem;
  /** Gameplay stealth clouds; their zones feed the sensors and the radar. */
  private readonly combatNebulas: CombatNebulas;
  /** Runtime re-tasking for the ENEMY fleet (built with it in start()). */
  private fleetCommander: FleetCommander | null = null;
  /** Per-faction read-only world view handed to that faction's controllers. */
  private readonly worldByFaction: Record<Faction, ControllerWorld>;
  /**
   * Combined obstacle list the AI avoidance pass flies around: live asteroids
   * plus BOTH carriers' hull sections. Rebuilt in place each frame (the
   * asteroid array mutates as rocks shatter); both factions share it — every
   * pilot should steer around every carrier, its own included.
   */
  private readonly aiObstacles: AvoidObstacle[] = [];

  /** The locally-controlled ship (built on async asset load). */
  private playerShip: Ship | null = null;
  private readonly playerController: LocalInputController;

  /** DEBUG god mode (Backquote toggle): player invuln + boosted speed. */
  private debugGodMode = false;
  private debugBadgeEl: HTMLElement | null = null;
  private engineGlow: EngineGlow | null = null;
  private secondaryThrusters: SecondaryThrusters | null = null;
  private playerDamageFlash: DamageFlash | null = null;
  /** Hit-confirm flash for every non-player ship (enemies + wingmen). */
  private readonly aiDamageFlashes = new Map<Ship, DamageFlash>();

  private state: GameState = "launching";
  private started = false;
  /**
   * The player's combatant, set once the ship loads. Its `launch` field is the
   * cinematic launch sequence the camera zoom + 3-2-1 overlay read from (via the
   * `playerLaunch` getter) — every other ship's launch is silent.
   */
  private playerCombatant: Combatant | null = null;

  /**
   * Run stats — the progression readout. Kills the player personally landed
   * (lasers tagged fromPlayer + all missiles) score points; the wing's kills
   * are tallied separately and don't score. Score per kill = the victim's max
   * hull, so heavies are worth more. Best score persists in localStorage.
   */
  private playerKills = 0;
  private wingKills = 0;
  private score = 0;
  /** Player's carrier-service state this frame (HUD cue); null = not docked. */
  private playerServiceState: "servicing" | "docked" | null = null;
  private bestScore = 0;

  /**
   * Wall-clock timestamp until which the simulation is paused. While
   * `nowMs < hitstopUntilMs`, the tick skips simulation but still updates the
   * camera (so shake animates) and renders.
   */
  private hitstopUntilMs = 0;

  /**
   * The enemy a player missile would currently lock onto (computeLockTarget),
   * refreshed every frame in advanceSim. Drives both the launched missile's
   * homing target (sim) and the HUD lock indicator (view), so it's cached here
   * rather than threaded as a local.
   */
  private lockTarget: Ship | null = null;

  /**
   * Per-ship wall-clock timestamp of the last asteroid ram-damage, so a ship
   * pinned against a rock takes damage on a cooldown (asteroids.bumpCooldownSec)
   * instead of every frame.
   */
  private readonly lastBumpMs = new Map<Ship, number>();

  constructor(
    canvas: HTMLCanvasElement,
    hudRoot: HTMLDivElement,
    loadout?: PlayerLoadout,
  ) {
    this.engine = new Engine(
      canvas,
      true,
      {
        preserveDrawingBuffer: false,
        stencil: false,
        audioEngine: true,
      },
      true,
    );
    this.engine.setHardwareScalingLevel(1 / window.devicePixelRatio);

    this.scene = new Scene(this.engine);
    // Exposed for the Babylon Inspector recipe in CLAUDE.md and ad-hoc debugging.
    (window as unknown as { __BABYLON_SCENE__: Scene }).__BABYLON_SCENE__ =
      this.scene;
    // Live debug toggle for the wreck collider wireframes (see GameConfig.hulk
    // .debugColliders): `window.__showHulkColliders(true)` from the console.
    (window as unknown as { __showHulkColliders: (on: boolean) => void })
      .__showHulkColliders = (on: boolean) => {
      for (const v of this.hulkViews) v.setDebugColliders(on);
    };
    this.scene.skipPointerMovePicking = true;
    const c = GameConfig.scene.clearColor;
    this.scene.clearColor = new Color4(c.r, c.g, c.b, 1);

    this.glowLayer = new GlowLayer("glow", this.scene, {
      mainTextureRatio: GameConfig.glow.mainTextureRatio,
      blurKernelSize: GameConfig.glow.blurKernelSize,
    });
    this.glowLayer.intensity = GameConfig.glow.intensity;

    // --- Lights ---
    // Intensities/colors live in GameConfig.lighting — tuned together with
    // postProcess.exposure so lit hulls stay bright while the frame is pulled
    // down to keep the background dark.
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

    // --- Environment (IBL) ---
    // The GLB ships use PBR materials — the spitfire's are fully metallic — and
    // a metal surface is rendered almost entirely by what it REFLECTS. With no
    // environment those metals come out flat/dark. Reuse the space backdrop as
    // the environment map so ships pick up a subtle space-colored sheen (and any
    // future PBR model benefits automatically). This sets reflections only — it
    // does NOT draw a skybox, so the visible background (Backdrop) is unchanged.
    this.scene.environmentTexture = new EquiRectangularCubeTexture(
      `${import.meta.env.BASE_URL}textures/space-backdrop.jpg`,
      this.scene,
      256,
    );
    this.scene.environmentIntensity = lcfg.environmentIntensity;

    // --- Factions + loadout ---
    // The splash menu hands in the pilot's chosen side + ship; GameConfig
    // holds the defaults (used in tests/dev paths with no menu). Copied here
    // once — GameConfig itself stays read-only at runtime.
    this.playerFaction = loadout?.faction ?? GameConfig.player.faction;
    this.enemyFaction = opposing(this.playerFaction);
    this.playerShipTypeId = loadout?.shipType ?? GameConfig.player.shipType;

    try {
      this.bestScore = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
    } catch {
      this.bestScore = 0; // storage unavailable — best just won't persist
    }

    // --- Subsystems ---
    this.input = new InputManager();
    this.input.attach();
    this.playerController = new LocalInputController(this.input);
    window.addEventListener("keydown", this.onKeyDown);

    this.arena = new Arena(this.scene);
    this.backdrop = new Backdrop(this.scene);
    new Nebulas(this.scene, this.arena.halfWidth, this.arena.halfDepth);
    this.combatNebulas = new CombatNebulas(
      this.scene,
      this.arena.halfWidth,
      this.arena.halfDepth,
    );
    new CapitalShips(
      this.scene,
      this.arena.halfWidth,
      this.arena.halfDepth,
      this.glowLayer,
    );

    // Two BSG-style motherships — humans at the south end (bow faces +Z, into
    // the arena), machines at the north (bow faces -Z). Built now so they
    // appear immediately, before asset load.
    const ms = GameConfig.mothership;
    this.motherships = {
      humans: new Mothership(new Vector3(0, ms.yLevel, ms.playerZ), 0, "humans"),
      machines: new Mothership(new Vector3(0, ms.yLevel, ms.enemyZ), Math.PI, "machines"),
    };
    // Depictions of the carriers: the sim objects above hold no scene state, so
    // each view owns the procedural mesh build (and the later GLB swap), reading
    // its carrier's static position/rotationY. Built now so the carriers appear
    // immediately, before asset load.
    this.mothershipViews = {
      humans: new MothershipView(this.scene, this.glowLayer, this.motherships.humans),
      machines: new MothershipView(this.scene, this.glowLayer, this.motherships.machines),
    };

    // Drifting destructible asteroid field — the arena terrain. Rocks keep
    // clear of both carriers at spawn so nobody launches into one. Its obstacle
    // list is handed to the weapon systems below for line-of-sight cover.
    this.asteroids = new AsteroidField(
      this.scene,
      this.arena.halfWidth,
      this.arena.halfDepth,
      [
        { x: this.motherships.humans.position.x, z: this.motherships.humans.position.z, radius: GameConfig.asteroids.mothershipClearance },
        { x: this.motherships.machines.position.x, z: this.motherships.machines.position.z, radius: GameConfig.asteroids.mothershipClearance },
      ],
    );

    // Placed wrecks (map hazards). Sim entities built now (their sections wire
    // into weapons + collision in start()); each gets a dead-block view. Empty
    // unless the active map configured hazards, so stock runs build no hulks.
    for (const hazard of GameConfig.hazards) {
      if (hazard.kind === "hulk") {
        const hulk = new Hulk(hazard);
        this.hulks.push(hulk);
        this.hulkViews.push(new HulkView(this.scene, this.glowLayer, hulk));
      }
    }

    this.sound = new SoundSystem(this.scene);
    this.music = new MusicSystem(this.scene);

    // Faction-keyed heat-seeker systems (sim, parallel to the lasers) + their
    // per-round views. Each side fires from its own pool — the player and any
    // wingman with a rack on the player faction's system, the enemy fleet on
    // theirs — and every missile carries its shooter, so onMissileHit
    // attributes kills and scales feedback exactly like the laser path.
    // Built BEFORE the lasers so each laser system can hold the opposing
    // pool's live missiles by reference for point defense (see below).
    const humansMissiles = new MissileSystem({
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      obstacles: this.weaponObstacles,
      onHit: (pos, struck, shooter) =>
        this.events.emit("missileHit", { position: pos, struck, shooter }),
    });
    const machinesMissiles = new MissileSystem({
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      obstacles: this.weaponObstacles,
      onHit: (pos, struck, shooter) =>
        this.events.emit("missileHit", { position: pos, struck, shooter }),
    });
    this.factionMissiles = { humans: humansMissiles, machines: machinesMissiles };
    // Visuals are faction-themed: Commonwealth rounds keep the classic
    // gray/red hull with a hot orange exhaust; Novari rounds fly darker hulls
    // with the Ascendancy's electric-green exhaust (matching their lasers).
    this.factionMissileViews = {
      humans: new MissileSystemView(this.scene, humansMissiles, {
        bodyColor: new Color3(0.62, 0.66, 0.7),
        finColor: new Color3(0.78, 0.16, 0.16),
        trailEmissive: new Color3(2.2, 0.7, 0.1),
        materialName: "humans_missile_mat",
      }),
      machines: new MissileSystemView(this.scene, machinesMissiles, {
        bodyColor: new Color3(0.4, 0.38, 0.44),
        finColor: new Color3(0.5, 0.12, 0.14),
        trailEmissive: new Color3(0.5, 2.2, 0.6),
        materialName: "machines_missile_mat",
      }),
    };

    // Faction-keyed laser systems (sim) + their mesh-pooling views. onHit
    // scales feedback by what was struck: hitting the player's ship flashes +
    // jolts hard; chipping the (huge, stationary) mothership only plays a
    // light hit cue so sustained fire on it doesn't spam hitstop and crawl
    // the whole game.
    // Each side's bolts also act as point defense against the OPPOSING
    // faction's missiles (interceptables): a led shot can swat an incoming
    // heat-seeker out of the air. Symmetric, so the AI's fire can clip yours
    // too — though it doesn't aim for them on purpose.
    const humansLasers = new LaserSystem({
      damage: GameConfig.combat.laserDamage,
      onHit: (target, shooter) =>
        this.events.emit("laserHit", { target, shooter }),
      obstacles: this.weaponObstacles,
      interceptables: machinesMissiles.interceptables,
      onIntercept: (pos) =>
        this.events.emit("missileIntercepted", { position: pos }),
    });
    const machinesLasers = new LaserSystem({
      damage: GameConfig.combat.laserDamage,
      onHit: (target, shooter) =>
        this.events.emit("laserHit", { target, shooter }),
      obstacles: this.weaponObstacles,
      interceptables: humansMissiles.interceptables,
      onIntercept: (pos) =>
        this.events.emit("missileIntercepted", { position: pos }),
    });
    this.factionLasers = { humans: humansLasers, machines: machinesLasers };
    // Dark-orange flak tint shared by both carriers' turret bolts (distinct from
    // each faction's fighter laser colour) — see GameConfig.mothership.turrets.
    const tb = GameConfig.mothership.turrets.boltEmissive;
    const turretBoltEmissive = new Color3(tb.r, tb.g, tb.b);
    this.factionLaserViews = {
      humans: new LaserSystemView(this.scene, humansLasers, {
        emissive: FACTION_THEME.humans.laserEmissive,
        heavyEmissive: FACTION_THEME.humans.laserHeavyEmissive,
        materialName: FACTION_THEME.humans.laserMaterialName,
        turretEmissive: turretBoltEmissive,
      }),
      machines: new LaserSystemView(this.scene, machinesLasers, {
        emissive: FACTION_THEME.machines.laserEmissive,
        heavyEmissive: FACTION_THEME.machines.laserHeavyEmissive,
        materialName: FACTION_THEME.machines.laserMaterialName,
        turretEmissive: turretBoltEmissive,
      }),
    };

    this.explosions = new ExplosionSystem(this.scene, this.glowLayer);
    this.jumpFlashes = new JumpFlashSystem(this.scene, this.glowLayer);

    // A rock shattered — the feedback (explosion + sound + trauma) is depicted
    // by the asteroidShattered listener.
    this.asteroids.onShatter = (pos, radius) =>
      this.events.emit("asteroidShattered", { position: pos, radius });

    // Wire the client-side feedback listeners now that the FX systems exist.
    this.wireSimEventFeedback();

    // Enemy AI fighters are built in start(), not here: each fleet type
    // (GameConfig.fleets → GameConfig.shipTypes) clones a GLB template
    // that has to be loaded async first, the same way the player's wingmen
    // clone the player's loaded ship.

    this.cameraRig = new CameraRig(this.scene);
    // Jump shockwave refraction — needs the camera, so it's built after the rig
    // (the jumpFired handler wired above reads it lazily, only at jump time).
    this.jumpRipple = new JumpRipple(this.scene, this.cameraRig.camera);
    // Self-registers with the scene (like Nebulas/CapitalShips) — no handle kept.
    this.buildPostPipeline();
    this.starfield = new Starfield(this.scene, this.cameraRig.camera);
    this.hud = new Hud(hudRoot);
    this.radar = new Radar();
    this.missileWarning = new MissileWarning(this.sound, this.hud);

    // Per-faction sensor pictures — built before the controller worlds, which
    // hold the contact arrays by reference. The combat nebulas' footprints
    // are what the sensors treat as concealment.
    this.sensors = new SensorSystem(this.motherships);
    this.sensors.concealmentZones = this.combatNebulas.zones;

    // Each faction's controllers see the OTHER faction as opponents — through
    // their own faction's SENSOR PICTURE, not ground truth. The contact
    // arrays are rebuilt in place each frame, so these views stay current
    // without reallocation.
    this.worldByFaction = {
      humans: {
        opponents: this.sensors.contacts.humans,
        opponentMothership: this.motherships.machines,
        homeMothership: this.motherships.humans,
        leader: null, // set in start(): the player ship (player side) or the lead striker (AI side)
        obstacles: this.aiObstacles,
        arenaHalfX: this.arena.halfWidth,
        arenaHalfZ: this.arena.halfDepth,
      },
      machines: {
        opponents: this.sensors.contacts.machines,
        opponentMothership: this.motherships.humans,
        homeMothership: this.motherships.machines,
        leader: null, // set in start(): the player ship (player side) or the lead striker (AI side)
        obstacles: this.aiObstacles,
        arenaHalfX: this.arena.halfWidth,
        arenaHalfZ: this.arena.halfDepth,
      },
    };
  }

  /**
   * Build the full-frame post pipeline: ACES tone mapping + FXAA. Returns null
   * if disabled in config. HDR target (`true`) so the tone-mapper has float
   * headroom to roll off the >1.0 emissive highlights instead of clipping. This
   * runs AFTER the GlowLayer's per-mesh bloom — both passes coexist: glow blooms
   * individual emissive meshes, this tone-maps + antialiases the composite.
   *
   * The pipeline self-registers with the scene's render-pipeline manager, so no
   * handle is kept (same fire-and-forget pattern as Nebulas/CapitalShips).
   */
  private buildPostPipeline(): void {
    const cfg = GameConfig.postProcess;
    if (!cfg.enabled) return;

    const pipeline = new DefaultRenderingPipeline(
      "post",
      true, // HDR: float texture, needed for tone mapping to have headroom
      this.scene,
      [this.cameraRig.camera],
    );

    // We only want tone mapping + FXAA here; the DefaultRenderingPipeline's own
    // bloom stays off (the GlowLayer already owns bloom).
    pipeline.bloomEnabled = false;
    pipeline.fxaaEnabled = cfg.fxaa;

    const ip = pipeline.imageProcessing;
    ip.toneMappingEnabled = cfg.toneMapping;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    // exposure + contrast counter ACES lifting the dark backdrop: pull the
    // global level down and deepen shadows so the fighters keep their contrast.
    ip.exposure = cfg.exposure;
    ip.contrast = cfg.contrast;

    // Black multiply vignette: darkens the frame edges (where the bright nebulas
    // sit) and frames the action toward center. Multiply blend with the default
    // black vignetteColor just attenuates the corners.
    ip.vignetteEnabled = cfg.vignette;
    ip.vignetteWeight = cfg.vignetteWeight;
    ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
  }

  /**
   * Resolve the player's wing for this match from the RUNTIME loadout. The
   * default `player.wingmen.composition` is role-based ("self"/"other"/
   * "gunship") because a static type list can't express "the same ship the
   * player chose" — so the roles are mapped to concrete catalog types here,
   * given the picked faction + ship:
   *   self    → the player's chosen type (a clone of the loaded model)
   *   other   → the other ship type in the player's faction
   *   gunship → the faction's heavy gunship (factionShips[*] last entry)
   * `count` ships are taken from the composition (wrapping). When the
   * composition is emptied, the legacy per-slot `shipTypes`/`orders` lists
   * (and their match-settings dropdowns) drive the wing instead.
   */
  private resolveWingPlan(): { typeId: ShipTypeId; order: WingOrder }[] {
    const w = GameConfig.player.wingmen;
    const ships = GameConfig.factionShips[this.playerFaction];
    const self = this.playerShipTypeId;
    const other = ships.find((t) => t !== self) ?? self;
    const gunship = ships[ships.length - 1];
    const resolveRole = (role: "self" | "other" | "gunship"): ShipTypeId =>
      role === "self" ? self : role === "other" ? other : gunship;

    const plan: { typeId: ShipTypeId; order: WingOrder }[] = [];
    for (let i = 0; i < w.count; i++) {
      if (w.composition.length > 0) {
        const c = w.composition[i % w.composition.length];
        plan.push({ typeId: resolveRole(c.role), order: c.order });
      } else {
        const types = w.shipTypes[this.playerFaction];
        const typeId = types.length > 0 ? types[i % types.length] : self;
        plan.push({ typeId, order: w.orders[i % w.orders.length] });
      }
    }
    return plan;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // start() is called from the splash Start-button click, so this runs
    // inside a user gesture — resume the WebAudio context NOW. Waiting for
    // the first gameplay keypress (the tick() unlock) leaves the context
    // suspended when the music's play() fires, and Babylon drops a locked
    // play() for non-loop/non-autoplay sounds instead of queueing it,
    // showing the unmute icon and silencing music for the whole match.
    this.sound.unlock();

    const loader = new AssetLoader(this.scene);
    // Resolve the player's ship TYPE from the catalog — every stat (movement,
    // HP, per-bolt damage, missile rack, hit radius, model, fire sound) flows
    // from this one entry, chosen on the splash loadout menu.
    const playerType = GameConfig.shipTypes[this.playerShipTypeId];
    const loaded = await loader.loadPlayerShip(playerType.model);
    // The AI opposition flies the OTHER faction's fleet; the wing list is the
    // player's faction's.
    const enemyFleet = GameConfig.fleets[this.enemyFaction];
    // The wing is resolved from the RUNTIME loadout (roles → concrete types),
    // so "2 of your ship + 2 of the other type + 2 gunship guards" tracks the
    // ship you actually picked. See resolveWingPlan.
    const wingPlan = this.resolveWingPlan();
    // One clone template per unique GLB an AI ship needs: the enemy fleet
    // composition, plus any wingman flying a type OTHER than the player's
    // (same-type wingmen clone the player's loaded model instead). A type
    // with model: null falls back to the procedural FighterMesh.
    const templateTypeIds: ShipTypeId[] = [
      ...enemyFleet.fleet.map((e) => e.type),
      ...wingPlan.filter((w) => w.typeId !== this.playerShipTypeId).map((w) => w.typeId),
    ];
    const shipTemplates = new Map<string, TransformNode | null>();
    for (const id of templateTypeIds) {
      const file = GameConfig.shipTypes[id].model;
      if (file && !shipTemplates.has(file)) {
        shipTemplates.set(file, await loader.loadModelTemplate(file));
      }
    }
    // Mount points authored into the player model (empties named thruster*/
    // muzzle*/rcs.*). Empty when the model has none → systems use their config
    // defaults. Wingmen clone the same model, so they share these markers.
    const markers = loaded.markers;
    // Sim and depiction built side by side: the Ship never sees the scene;
    // the ShipView owns the loaded model root and copies the pose each frame.
    const playerShipView = new ShipView(loaded.root);
    this.playerShip = new Ship({
      faction: this.playerFaction,
      maxHp: playerType.maxHp,
      respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
      startMissileAmmo: playerType.missileAmmo,
      startCannonAmmo: playerType.cannonAmmo,
      movement: playerType,
      laserDamage: playerType.laserDamage,
      hitRadius: playerType.hitRadius,
      muzzles: markers.muzzles.length > 0 ? markers.muzzles : undefined,
      fireSound: playerType.fireSound,
      heavy: playerType.heavy,
    });

    // Player-side AI wingmen (Phase 5): real fighters like the player, each
    // carrying a standing order/slot. By default (wingmen.shipTypes empty) a
    // wingman flies the player's TYPE and gets a CLONE of the player's actual
    // loaded model, so the wing always looks like whatever you fly. A wingman
    // assigned a DIFFERENT type via wingmen.shipTypes is built like an enemy
    // fleet clone of that type instead (config muzzles, derived rear glow).
    const wcfg = GameConfig.player.wingmen;
    for (let i = 0; i < wingPlan.length; i++) {
      const typeId = wingPlan[i].typeId;
      let ship: Ship;
      let view: ShipView;
      if (typeId === this.playerShipTypeId) {
        // Two-tier root like the player's: gameplay drives `root.rotation.y`, the
        // cloned model carries its own alignment. Clone modelRoot (the visual) — NOT
        // the player root — so the player-only engine glow / thrusters / damage
        // flash don't tag along. doNotInstantiate = independent copies (not GPU
        // instances), so a wingman stays visible when the player ship is disabled
        // on death.
        const root = new TransformNode(`wingmanRoot${i}`, this.scene);
        loaded.modelRoot.instantiateHierarchy(root, { doNotInstantiate: true });
        view = new ShipView(root);
        ship = new Ship({
          faction: this.playerFaction,
          maxHp: playerType.maxHp,
          respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
          startMissileAmmo: playerType.missileAmmo,
          startCannonAmmo: playerType.cannonAmmo,
          movement: playerType,
          laserDamage: playerType.laserDamage,
          hitRadius: playerType.hitRadius,
          muzzles: markers.muzzles.length > 0 ? markers.muzzles : undefined,
          fireSound: playerType.fireSound,
          heavy: playerType.heavy,
        });
        // Each wingman gets its own engine glow + RCS plumes on its outer root,
        // so it reads as a real fighter under thrust instead of floating. Driven
        // from the wingman's emitted input in the sim loop (see tick()). Same
        // model as the player = same thruster/RCS markers.
        this.aiVisuals.set(ship, {
          glow: new EngineGlow(this.scene, view.root, this.glowLayer, markers.thrusters),
          thrusters: new SecondaryThrusters(this.scene, view.root, this.glowLayer, markers.rcs),
        });
      } else {
        // Mixed-wing type: built exactly like an enemy fleet clone of that
        // type, just on the player's faction. No GLB markers — the engine glow
        // nozzle is derived from the mesh bounds (GLB) or skipped (procedural,
        // which carries its own emissive engine); RCS plumes fall back to the
        // config nozzle positions.
        const type = GameConfig.shipTypes[typeId];
        const template = type.model ? (shipTemplates.get(type.model) ?? null) : null;
        ({ ship, view } = this.makeFighter(this.playerFaction, type, template));
        this.aiVisuals.set(ship, {
          glow: template
            ? new EngineGlow(this.scene, view.root, this.glowLayer, this.rearEmitters(view.root))
            : undefined,
          thrusters: new SecondaryThrusters(this.scene, view.root, this.glowLayer, {}),
        });
      }
      const controller = new AIController({
        order: wingPlan[i].order,
        slot: wcfg.formationSlot(i),
      });
      this.combatants.push({ ship, view, controller, launch: null, bayIndex: 0, lastInput: null });
      this.aiDamageFlashes.set(ship, new DamageFlash(this.scene, view.root, this.glowLayer, new Color3(2.5, 1.5, 0.2)));
    }

    this.engineGlow = new EngineGlow(
      this.scene,
      loaded.root,
      this.glowLayer,
      markers.thrusters,
    );
    this.secondaryThrusters = new SecondaryThrusters(
      this.scene,
      loaded.root,
      this.glowLayer,
      markers.rcs,
    );
    this.playerDamageFlash = new DamageFlash(this.scene, loaded.root, this.glowLayer);

    this.playerCombatant = {
      ship: this.playerShip,
      view: playerShipView,
      controller: this.playerController,
      launch: null,
      bayIndex: 0,
      lastInput: null,
    };
    this.combatants.push(this.playerCombatant);

    // The player ship is the wing leader its faction's wingmen form on.
    this.worldByFaction[this.playerFaction].leader = this.playerShip;

    // Enemy AI fleet, composed from the opposing faction's fleet default.
    // Initial orders implement the FleetCommander's role split: the first
    // `strikeCount` ships fly "strike" at the player's mothership (the first
    // of them doubles as the fleet's wing LEADER), the next
    // `commander.escortCount` fly "cover" on that leader (an escorted strike
    // package), and the rest start on "patrol" — the dynamic pool the
    // commander re-tasks at runtime (hunt/defend/patrol). Each ship is a
    // clone of its TYPE's GLB template (or the procedural mesh if none).
    const enemyPilots: CommandedPilot[] = [];
    const escortEnd = enemyFleet.strikeCount + GameConfig.commander.escortCount;
    let fleetIndex = 0;
    for (const entry of enemyFleet.fleet) {
      const type = GameConfig.shipTypes[entry.type];
      const template = type.model ? (shipTemplates.get(type.model) ?? null) : null;
      for (let i = 0; i < entry.count; i++, fleetIndex++) {
        const { ship, view } = this.makeFighter(this.enemyFaction, type, template);
        let controller: AIController;
        if (fleetIndex < enemyFleet.strikeCount) {
          controller = new AIController({ order: "strike" });
        } else if (fleetIndex < escortEnd) {
          // Escorts reuse the wing's slot generator — a generic expanding V
          // around any leader, not something player-specific.
          controller = new AIController({
            order: "cover",
            slot: GameConfig.player.wingmen.formationSlot(
              fleetIndex - enemyFleet.strikeCount,
            ),
          });
        } else {
          controller = new AIController({ order: "patrol" });
        }
        enemyPilots.push({ ship, ai: controller });
        this.combatants.push({
          ship,
          view,
          controller,
          launch: null,
          bayIndex: 0,
          lastInput: null,
        });
        // GLB enemies have no emissive engine of their own, so give them an
        // EngineGlow at their rear so they read in combat. Procedural fighters
        // already carry an emissive engine box, so skip those. Fleet clones
        // carry no thruster markers, so derive the rear nozzle from the mesh
        // bounding box.
        if (template) {
          this.aiVisuals.set(ship, {
            glow: new EngineGlow(
              this.scene,
              view.root,
              this.glowLayer,
              this.rearEmitters(view.root),
            ),
          });
        }
        this.aiDamageFlashes.set(ship, new DamageFlash(this.scene, view.root, this.glowLayer, new Color3(2.5, 1.5, 0.2)));
      }
    }

    // The lead striker is the enemy wing leader its escorts form on; the
    // doctrine that re-tasks the rest of the fleet is the FleetCommander's,
    // reading the SAME sensor picture the fleet flies on (fair play).
    if (enemyPilots.length > 0) {
      this.worldByFaction[this.enemyFaction].leader = enemyPilots[0].ship;
    }
    this.fleetCommander = new FleetCommander(
      enemyPilots,
      enemyFleet.strikeCount,
      this.worldByFaction[this.enemyFaction],
    );

    // Wire combat targets: every ship is a target of the opposing faction's
    // lasers AND missiles.
    for (const c of this.combatants) {
      this.factionLasers[opposing(c.ship.faction)].addTarget(c.ship);
      this.factionMissiles[opposing(c.ship.faction)].addTarget(c.ship);
    }
    // Carrier turrets are shootable: register each on the opposing faction's
    // weapons BEFORE the hull sections so a bolt grazing a turret destroys it
    // (the turret sits proud of the hull) rather than passing through to the
    // carrier behind it — first-overlap-consumes ordering.
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const turret of this.motherships[f].turrets) {
        this.factionLasers[opposing(f)].addTarget(turret);
        this.factionMissiles[opposing(f)].addTarget(turret);
      }
    }
    // Carriers are targeted per HULL SECTION (overlapping circles covering the
    // full hull, each forwarding damage to the one HP pool) — not via the
    // center hitRadius, which left the bow/stern intangible.
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const section of this.motherships[f].hullSections) {
        this.factionLasers[opposing(f)].addTarget(section);
        this.factionMissiles[opposing(f)].addTarget(section);
      }
    }
    // (Wrecks block fire as NEUTRAL cover via the shared weaponObstacles list —
    // see refreshWeaponObstacles — not as weapon TARGETS, since they're
    // indestructible and their circular footprint rotates with the wreck.)

    // Upgrade both carriers from the procedural box build to their faction's
    // Blender GLB — Bastion Carrier for the humans, Choirship for the Novari
    // (the launch bays are read from `launch.*` empties authored into each
    // model). Awaited BEFORE assigning launches so the fleet stages in the
    // model's bays. Falls back to the procedural carrier if a file is missing.
    await Promise.all(
      (["humans", "machines"] as Faction[]).map((f) => {
        const file = GameConfig.mothership.model.file[f];
        return file ? this.mothershipViews[f].applyModel(file) : Promise.resolve(false);
      }),
    );

    // Swap each carrier's procedural box turrets for the shared turret GLB
    // (static base + rotating gun, tinted per faction). The model's `muzzle`
    // empty gives the fire-point distance, fed back to each sim turret so bolts
    // spawn at the barrel tip. Falls back to the procedural turrets per carrier.
    await Promise.all(
      (["humans", "machines"] as Faction[]).map(async (f) => {
        const fire = await this.mothershipViews[f].applyTurretModel();
        if (fire !== null) {
          for (const turret of this.motherships[f].turrets) {
            turret.setMuzzleData(fire.forward, fire.height);
          }
        }
      }),
    );

    // Swap each wreck's placeholder blocks for its battle-damaged GLB (per
    // source faction). Falls back to the procedural placeholder if the file is
    // missing/fails. Not gated on launches — wrecks don't launch.
    await Promise.all(
      this.hulks.map((hulk, i) =>
        this.hulkViews[i].applyModel(GameConfig.hulk.model.file[hulk.source]),
      ),
    );

    // Both fleets launch from their carriers (the player runs the full
    // cinematic; everyone else holds and streams out behind them). This freezes
    // every ship in the tube until its own catapult fires and keeps the enemy
    // wing on its own carrier instead of pre-scattered next to the player.
    this.state = "launching";
    this.assignInitialLaunches();

    this.music.playPlaylist("game");
    this.engine.runRenderLoop(this.tick);
  }

  // ─── Combat feedback ───────────────────────────────────────────────────────

  /**
   * Subscribe the client-side feedback (sound, explosions, camera trauma,
   * hitstop, damage flash) to the sim event channel. The sim sites only
   * EMIT facts; everything depicted here is presentation, so a headless/
   * server run never registers these (sim/SimEvents.ts). Listeners run
   * synchronously in emit order, so this is a behavior-identical move of
   * the formerly-inline FX calls.
   */
  private wireSimEventFeedback(): void {
    this.events.on("laserHit", ({ target, shooter }) =>
      this.onLaserHit(target, shooter),
    );
    this.events.on("missileHit", ({ position, struck, shooter }) =>
      this.onMissileHit(position, struck, shooter),
    );
    this.events.on("missileIntercepted", ({ position }) =>
      this.onMissileIntercepted(position),
    );

    // Fire SFX — player fire is full-volume (no position); everyone else is
    // spatial, attenuating with distance from the player/listener.
    this.events.on("shipFiredLaser", ({ ship }) => {
      const isPlayer = ship === this.playerShip;
      this.sound.playFireSound(
        ship.fireSound,
        isPlayer ? undefined : ship.position,
      );
    });
    this.events.on("missileFired", ({ ship }) => {
      const isPlayer = ship === this.playerShip;
      this.sound.playMissileLaunch(isPlayer ? undefined : ship.position);
    });

    // Catapult fire: the player's launch is full-volume trauma; everyone
    // else's scales with distance (a far enemy catapult barely registers).
    this.events.on("shipLaunched", ({ ship }) => {
      const isPlayer = ship === this.playerShip;
      this.cameraRig.addTrauma(
        isPlayer
          ? GameConfig.launch.launchTrauma
          : this.traumaAtDistance(GameConfig.launch.launchTrauma, ship.position),
      );
    });

    // Ram: the player gets the heavy cue (trauma + flash + hit SFX); an AI
    // ship just flashes so the impact is still visible.
    this.events.on("shipRammedAsteroid", ({ ship }) => {
      if (ship === this.playerShip) {
        this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerLaserHit);
        this.playerDamageFlash?.trigger();
        this.sound.playHit(ship.position);
      } else {
        this.aiDamageFlashes.get(ship)?.trigger();
      }
    });

    // Ship death: explosion + sound + (distance-scaled for AI) trauma/hitstop.
    this.events.on("shipDied", ({ ship }) => {
      const isPlayer = ship === this.playerShip;
      // Destroyed mid-spool: cut its jump-drive clip (no-op if it wasn't
      // spooling — a ship that already jumped was released and rings out).
      this.sound.stopJumpDrive(ship);
      this.explosions.spawn(ship.position);
      this.sound.playExplosion(ship.position);
      this.cameraRig.addTrauma(
        isPlayer
          ? GameConfig.shake.traumaPlayerExplosion
          : this.traumaAtDistance(GameConfig.shake.traumaEnemyExplosion, ship.position),
      );
      this.applyHitstop(
        isPlayer
          ? GameConfig.hitstop.playerExplosionMs
          : GameConfig.hitstop.enemyExplosionMs,
      );
    });

    // Mothership death spectacle: a scatter of explosions + sound + the
    // heaviest trauma/hitstop in the game.
    this.events.on("mothershipDied", ({ mothership }) => {
      const cfg = GameConfig.mothership;
      const center = mothership.position;
      for (let i = 0; i < cfg.deathExplosionCount; i++) {
        const ox = (Math.random() * 2 - 1) * cfg.deathExplosionSpread;
        const oz = (Math.random() * 2 - 1) * cfg.deathExplosionSpread;
        this.explosions.spawn(
          new Vector3(center.x + ox, center.y, center.z + oz),
        );
      }
      this.sound.playExplosion(center);
      this.cameraRig.addTrauma(cfg.deathTrauma);
      this.applyHitstop(cfg.deathHitstopMs);
    });

    // Carrier turret fire: a spatial cannon report at the muzzle (attenuates
    // with distance from the player) plus a brief muzzle flash. The bolt itself
    // is the main read; these give the carriers some presence. The pooled sound
    // caps overlap so a full battery can't drown the mix.
    this.events.on("turretFired", ({ origin }) => {
      this.sound.playTurretFire(origin);
      this.explosions.spawnMuzzleFlash(origin);
    });
    // A turret was shot off: explosion + sound + distance-scaled trauma (a
    // smaller cue than a ship death — it's a sub-part, not a kill).
    this.events.on("turretDestroyed", ({ position }) => {
      this.explosions.spawn(position);
      this.sound.playExplosion(position);
      this.cameraRig.addTrauma(
        this.traumaAtDistance(GameConfig.mothership.turrets.destroyTrauma, position),
      );
    });

    // Jump drive. The PLAYER's own drive sound is the 8s clip (build = spool,
    // trigger on teleport, 2s tail = whoosh); a cancel fades it. On a completed
    // jump the trails are flushed so no streak follows the teleport across the
    // map, and the player's camera hard-snaps to the arrival point. (The RWR
    // whine + radar ring for DETECTING an enemy spool are the detection slice.)
    this.events.on("jumpSpoolStarted", ({ ship }) => {
      // Your own drive is full-volume at the listener; everyone else's winds up
      // spatially (the "runner charging" telegraph — distinct from the RWR).
      this.sound.startJumpDrive(
        ship,
        ship === this.playerShip ? null : ship.position,
      );
    });
    this.events.on("jumpCancelled", ({ ship }) => {
      this.sound.stopJumpDrive(ship);
    });
    this.events.on("jumpFired", ({ ship, fromX, fromZ, toX, toZ }) => {
      // BSG "FTL crack" at BOTH ends — where the ship left and where it
      // arrived — so it reads whether you watch a ship vanish or appear.
      const y = ship.position.y;
      const fromPos = new Vector3(fromX, y, fromZ);
      const toPos = new Vector3(toX, y, toZ);
      this.jumpFlashes.spawn(fromPos);
      this.jumpFlashes.spawn(toPos);
      this.jumpRipple.spawn(fromPos);
      this.jumpRipple.spawn(toPos);
      // Completed jump: let the drive ring out (trigger hit + departure tail).
      this.sound.releaseJumpDrive(ship);
      if (ship === this.playerShip) {
        this.engineGlow?.resetTrails();
        this.cameraRig.snapTo(ship.position);
        this.cameraRig.addTrauma(GameConfig.jump.arrivalTrauma);
      } else {
        this.aiVisuals.get(ship)?.glow?.resetTrails();
      }
    });

    // Rock shatter: explosion + sound + trauma scaled by distance AND size.
    this.events.on("asteroidShattered", ({ position, radius }) => {
      this.explosions.spawn(position);
      this.sound.playExplosion(position);
      this.cameraRig.addTrauma(
        this.traumaAtDistance(GameConfig.asteroids.shatterTrauma, position) *
          Math.min(1, radius / GameConfig.asteroids.radiusMax),
      );
    });
  }

  /**
   * A laser struck `target`; scale feedback to the hit (and to who fired).
   * `shooter` is the firing SHIP — "is this the local pilot's shot" is
   * derived here by comparing against the local player ship, so attribution
   * stays per-pilot (multiplayer-ready) rather than a baked-in boolean.
   */
  private onLaserHit(target: DamageTarget, shooter: Ship | null): void {
    const fromPlayer = shooter !== null && shooter === this.playerShip;
    this.sound.playHit(target.position);
    // Chipping a mothership: light cue only (avoid hitstop spam on the
    // objective). Carriers are hit through their hull-section proxies.
    if (target instanceof MothershipSection) {
      return;
    }
    // Chipping a carrier turret: light cue (no hitstop spam). The player gets a
    // subtle camera confirm; the turret's destruction explosion is the payoff.
    if (target instanceof Turret) {
      if (fromPlayer) this.cameraRig.addTrauma(GameConfig.shake.traumaEnemyLaserHit);
      return;
    }
    if (target === this.playerShip) {
      // The player's own ship took a hit — the heavy feedback.
      this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerLaserHit);
      this.applyHitstop(GameConfig.hitstop.playerLaserHitMs);
      this.playerDamageFlash?.trigger();
    } else {
      // A non-player ship was hit — flash it so impacts are always visible.
      this.aiDamageFlashes.get(target as Ship)?.trigger();
      if (fromPlayer) {
        // The player (not an AI wingman) landed the hit — add camera confirm.
        this.cameraRig.addTrauma(GameConfig.shake.traumaEnemyLaserHit);
        this.applyHitstop(GameConfig.hitstop.enemyLaserHitMs);
      }
      // The bolt landed on a live target (LaserSystem skips dead ones), so
      // "dead now" means THIS shot was the killing blow.
      if (
        target instanceof Ship &&
        target.faction === this.enemyFaction &&
        !target.isAlive
      ) {
        this.recordKill(target, shooter);
      }
    }
  }

  /**
   * A missile from `shooter` detonated at `pos`, striking `struck` (null =
   * it spent itself on an asteroid). Every detonation pops an explosion +
   * proximity-scaled shake (it IS an explosion); attribution then follows
   * the laser rules — the player TAKING a missile gets the heaviest non-death
   * feedback, the player LANDING one gets the hit-confirm freeze, and
   * AI-on-AI impacts just flash the victim.
   */
  private onMissileHit(
    pos: Vector3,
    struck: DamageTarget | null,
    shooter: Ship | null,
  ): void {
    const fromPlayer = shooter !== null && shooter === this.playerShip;
    this.explosions.spawn(pos);
    this.sound.playExplosion(pos);
    if (struck !== null && struck === this.playerShip) {
      this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerMissileHit);
      this.applyHitstop(GameConfig.hitstop.playerMissileHitMs);
      this.playerDamageFlash?.trigger();
      return;
    }
    this.cameraRig.addTrauma(
      this.traumaAtDistance(GameConfig.shake.traumaMissileHit, pos),
    );
    if (fromPlayer) this.applyHitstop(GameConfig.hitstop.missileHitMs);
    if (struck instanceof Ship) {
      this.aiDamageFlashes.get(struck)?.trigger();
      if (struck.faction === this.enemyFaction && !struck.isAlive) {
        this.recordKill(struck, shooter);
      }
    }
  }

  /**
   * A laser bolt shot a missile out of the air (point defense). Pop a small
   * explosion + sound at the kill and a light, proximity-scaled jolt — the
   * same vocabulary as a missile detonation, just no damage/kill bookkeeping
   * since the round died harmlessly. Trauma is distance-scaled so the AI
   * swatting a round across the arena doesn't shake the player's camera.
   */
  private onMissileIntercepted(pos: Vector3): void {
    this.explosions.spawn(pos);
    this.sound.playExplosion(pos);
    this.cameraRig.addTrauma(
      this.traumaAtDistance(GameConfig.shake.traumaMissileHit, pos),
    );
  }

  /**
   * Credit a confirmed kill of an enemy fighter to `shooter`. Only the LOCAL
   * pilot's own kills score (and roll the persistent best); other
   * player-faction shooters tally as wing kills. Attribution is per-SHIP so
   * a future networked build can credit any human pilot the same way.
   */
  private recordKill(target: Ship, shooter: Ship | null): void {
    if (shooter === null || shooter !== this.playerShip) {
      this.wingKills++;
      return;
    }
    this.playerKills++;
    this.score += target.maxHp;
    if (this.score > this.bestScore) {
      this.bestScore = this.score;
      try {
        localStorage.setItem(BEST_SCORE_KEY, String(this.bestScore));
      } catch {
        // Storage unavailable — the in-session best still shows.
      }
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // A real keydown is a user gesture, so resuming the audio context here
    // always succeeds. Covers the restart path, where start() runs on page
    // load without a gesture. No-op once unlocked.
    this.sound.unlock();
    if (e.code === "KeyM") {
      this.sound.toggleMute();
      this.hud.setMuted(this.sound.isMuted);
    }
    // Restart after the match ends. Enter isn't a gameplay key, so no conflict.
    // A full reload is the reset (guaranteed-clean state); the flag tells
    // main.ts to skip the splash and drop the player straight back in.
    if (e.code === "Enter" && (this.state === "victory" || this.state === "defeat")) {
      sessionStorage.setItem(RESTART_FLAG, "1");
      window.location.reload();
    }
    // Escape returns to the splash menu at any time. Same clean-reset reload as
    // the restart above, but WITHOUT the RESTART_FLAG — so main.ts shows the
    // splash flow (quick play / landing) instead of dropping straight back in.
    if (e.code === "Escape") {
      window.location.reload();
    }
  };

  /**
   * Scale a base trauma value by how close `pos` is to the player.
   * Returns the full value at distance 0, zero at GameConfig.sound.maxDistance.
   * Used so distant explosions and missile impacts don't shake the camera.
   */
  private traumaAtDistance(base: number, pos: Vector3): number {
    const player = this.playerShip;
    if (!player) return base;
    const dx = pos.x - player.position.x;
    const dz = pos.z - player.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    return base * Math.max(0, 1 - dist / GameConfig.sound.maxDistance);
  }

  /**
   * Extend the hitstop window. Stacked impacts in one frame don't compound past
   * `maxStackedMs` — keeps long chains from freezing the action for too long.
   */
  private applyHitstop(durationMs: number): void {
    const nowMs = performance.now();
    const desiredEnd = nowMs + durationMs;
    const maxEnd = nowMs + GameConfig.hitstop.maxStackedMs;
    this.hitstopUntilMs = Math.min(maxEnd, Math.max(this.hitstopUntilMs, desiredEnd));
  }

  /**
   * The enemy a missile would lock onto right now, or null: the nearest live
   * enemy fighter within lockRange and inside the frontal lock cone. Drives
   * both the launched missile's homing target and the HUD lock indicator.
   */
  private computeLockTarget(): Ship | null {
    if (!this.playerShip || !this.playerShip.isAlive) return null;
    const cfg = GameConfig.missile;
    const px = this.playerShip.position.x;
    const pz = this.playerShip.position.z;

    let best: Ship | null = null;
    let bestDist = Infinity;
    for (const enemy of this.shipsByFaction[this.enemyFaction]) {
      if (!enemy.isAlive) continue;
      const dx = enemy.position.x - px;
      const dz = enemy.position.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.lockRange || dist >= bestDist) continue;
      // A nebula denies the seeker head its sensor return: concealed ships
      // can't be locked from outside eyeball range. (Symmetric with the AI's
      // radar — hiding breaks missile locks too.)
      if (
        this.sensors.isConcealed(enemy.position) &&
        dist > GameConfig.sensors.visualRange
      ) {
        continue;
      }
      const angleToEnemy = Math.atan2(dx, dz);
      if (Math.abs(wrapAngle(angleToEnemy - this.playerShip.rotationY)) > cfg.lockConeAngle) {
        continue;
      }
      best = enemy;
      bestDist = dist;
    }
    return best;
  }

  /**
   * Hard-bump any ship overlapping a rock back to the rock's surface, kill the
   * inward velocity component (so it doesn't keep boring in), and deal ram
   * damage on a per-ship cooldown. Ships still in the launch tube are exempt
   * (their catapult drives them past the carrier's keep-clear zone anyway).
   */
  private resolveAsteroidCollisions(nowMs: number): void {
    const cfg = GameConfig.asteroids;
    const bumpCooldownMs = cfg.bumpCooldownSec * 1000;
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      for (const rock of this.asteroids.asteroids) {
        if (!rock.isAlive) continue;
        const dx = ship.position.x - rock.position.x;
        const dz = ship.position.z - rock.position.z;
        const distSq = dx * dx + dz * dz;
        // Broad phase vs. the conservative max-extent circle, then the exact
        // directional silhouette — a squashed rock's short axis shouldn't
        // bump a ship that's visibly clear of it.
        const maxDist = ship.hitRadius + rock.radius;
        if (distSq >= maxDist * maxDist) continue;
        const minDist = ship.hitRadius + rock.surfaceRadiusToward(dx, dz);
        if (distSq >= minDist * minDist) continue;

        const dist = Math.sqrt(distSq) || 0.0001;
        const nx = dx / dist;
        const nz = dz / dist;
        // Shove the ship out to the rock's surface (its view re-reads the
        // pose at the end of the frame).
        ship.position.x = rock.position.x + nx * minDist;
        ship.position.z = rock.position.z + nz * minDist;
        // Cancel the velocity component pointing INTO the rock (vn < 0 = inward).
        const vn = ship.velocity.x * nx + ship.velocity.z * nz;
        if (vn < 0) {
          ship.velocity.x -= vn * nx;
          ship.velocity.z -= vn * nz;
        }

        // Ram damage, cooldowned so a ship pinned against a rock isn't shredded.
        const last = this.lastBumpMs.get(ship) ?? -Infinity;
        if (nowMs - last >= bumpCooldownMs) {
          this.lastBumpMs.set(ship, nowMs);
          ship.takeDamage(cfg.collisionDamage, nowMs);
          this.events.emit("shipRammedAsteroid", { ship });
        }
        break; // one bump per ship per frame
      }
    }
  }

  /** Refill the per-faction ship rosters that back the controller world. */
  private refreshRosters(): void {
    this.shipsByFaction.humans.length = 0;
    this.shipsByFaction.machines.length = 0;
    for (const c of this.combatants) {
      this.shipsByFaction[c.ship.faction].push(c.ship);
    }
  }

  /**
   * Rebuild the shared AI obstacle list in place: the asteroid field's live
   * rocks (its array mutates as rocks shatter into chunks) plus both
   * carriers' steering circles, so pilots steer around the motherships with
   * the same avoidance pass that dodges asteroids. (The circles deliberately
   * over-cover the hull boxes — see Mothership.avoidanceCircles.)
   */
  private refreshAiObstacles(): void {
    this.aiObstacles.length = 0;
    for (const rock of this.asteroids.asteroids) this.aiObstacles.push(rock);
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const circle of this.motherships[f].avoidanceCircles) {
        this.aiObstacles.push(circle);
      }
    }
    // Wrecks steer pilots the same way carriers do. Their cover circles double
    // as the steering circles (same objects), and they move as the wreck spins,
    // so the list is rebuilt each frame to pick up the current positions.
    for (const hulk of this.hulks) {
      for (const section of hulk.sections) this.aiObstacles.push(section);
    }
  }

  /**
   * Rebuild the combined weapon line-of-sight cover in place: the asteroid
   * field's live rocks plus every wreck's (rotated) cover circles. The weapon
   * systems hold this array BY REFERENCE. Pushing the rocks in their existing
   * order means that without wrecks this is contents-identical to the old
   * `asteroids.obstacles` reference, so the headless baseline is unchanged.
   */
  private refreshWeaponObstacles(): void {
    this.weaponObstacles.length = 0;
    for (const rock of this.asteroids.obstacles) this.weaponObstacles.push(rock);
    for (const hulk of this.hulks) {
      for (const section of hulk.sections) this.weaponObstacles.push(section);
    }
  }

  /**
   * Bump any ship overlapping a carrier hull box back to its surface and
   * cancel the inward velocity component — the carriers are solid, so nothing
   * can sit inside the model (where the top-down camera loses it under the
   * superstructure). Unlike asteroid bumps this deals no ram damage: brushing
   * the objective shouldn't shred a fighter, it just can't get in. Ships in
   * the launch tube are exempt — the catapult starts them INSIDE the hull and
   * its exit distance hands control back past the bow boxes.
   */
  private resolveMothershipCollisions(): void {
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      for (const f of ["humans", "machines"] as Faction[]) {
        for (const s of this.motherships[f].hullSections) {
          this.bumpShipOutOfSection(ship, s);
        }
      }
    }
  }

  /**
   * Keep ships out of every wreck: bump a ship overlapping any hulk cover
   * circle out to the circle's surface and cancel the inward velocity — like
   * the carrier keep-out, but circular (so it stays valid as the wreck spins)
   * and damage-free (brushing a derelict shouldn't shred a fighter). Ships
   * mid-launch are exempt, same as the carrier/asteroid passes.
   */
  private resolveHulkCollisions(): void {
    for (const c of this.combatants) {
      const ship = c.ship;
      if (!ship.isAlive) continue;
      if (c.launch && !c.launch.isComplete) continue;
      for (const hulk of this.hulks) {
        for (const section of hulk.sections) {
          const dx = ship.position.x - section.position.x;
          const dz = ship.position.z - section.position.z;
          const distSq = dx * dx + dz * dz;
          // Broad phase against the box's bounding circle, then push out to the
          // ORIENTED hull surface along the contact direction — so the keep-out
          // hugs the rectangle and thins as the wreck rolls (surfaceRadiusToward).
          const bound = ship.hitRadius + section.hitRadius;
          if (distSq >= bound * bound || distSq === 0) continue;
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const nz = dz / dist;
          const r = ship.hitRadius + section.surfaceRadiusToward(dx, dz);
          if (dist >= r) continue;
          ship.position.x = section.position.x + nx * r;
          ship.position.z = section.position.z + nz * r;
          const vn = ship.velocity.x * nx + ship.velocity.z * nz;
          if (vn < 0) {
            ship.velocity.x -= vn * nx;
            ship.velocity.z -= vn * nz;
          }
        }
      }
    }
  }

  /**
   * Push one ship out of one solid hull box and cancel the velocity component
   * driving it in. No early-out across boxes: at a seam between two the next
   * call resolves any remaining penetration. (The ship's view re-reads the
   * corrected pose at end of frame.)
   */
  private bumpShipOutOfSection(ship: Ship, s: MothershipSection): void {
    const r = ship.hitRadius;
    // Closest point on the box to the ship center.
    const px = Math.min(Math.max(ship.position.x, s.minX), s.maxX);
    const pz = Math.min(Math.max(ship.position.z, s.minZ), s.maxZ);
    const dx = ship.position.x - px;
    const dz = ship.position.z - pz;
    const distSq = dx * dx + dz * dz;
    if (distSq > 0) {
      // Center outside the box: overlapping iff closer than the ship's radius.
      // Push out along the surface normal and kill the inward velocity (vn < 0).
      if (distSq >= r * r) return;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      ship.position.x = px + nx * r;
      ship.position.z = pz + nz * r;
      const vn = ship.velocity.x * nx + ship.velocity.z * nz;
      if (vn < 0) {
        ship.velocity.x -= vn * nx;
        ship.velocity.z -= vn * nz;
      }
    } else {
      // Center INSIDE the box (deep overlap in one frame): exit through the
      // nearest face and zero the velocity component driving in.
      const left = ship.position.x - s.minX;
      const right = s.maxX - ship.position.x;
      const near = ship.position.z - s.minZ;
      const far = s.maxZ - ship.position.z;
      const min = Math.min(left, right, near, far);
      if (min === left) {
        ship.position.x = s.minX - r;
        if (ship.velocity.x > 0) ship.velocity.x = 0;
      } else if (min === right) {
        ship.position.x = s.maxX + r;
        if (ship.velocity.x < 0) ship.velocity.x = 0;
      } else if (min === near) {
        ship.position.z = s.minZ - r;
        if (ship.velocity.z > 0) ship.velocity.z = 0;
      } else {
        ship.position.z = s.maxZ + r;
        if (ship.velocity.z < 0) ship.velocity.z = 0;
      }
    }
  }

  /**
   * DEBUG/test cheat (Backquote `` ` ``): toggle player invulnerability +
   * boosted speed so you can blaze across a live match to inspect things (e.g.
   * carrier turrets up close) without being shot down. Client-only — flips
   * fields on the player Ship and shows a corner badge. Persists across
   * respawns; no effect on the AI or the headless sim.
   */
  private toggleGodMode(): void {
    this.debugGodMode = !this.debugGodMode;
    const ship = this.playerShip;
    if (ship) {
      ship.debugInvulnerable = this.debugGodMode;
      ship.debugSpeedMultiplier = this.debugGodMode
        ? GameConfig.debug.godSpeedMultiplier
        : 1;
      if (this.debugGodMode) ship.hp = ship.maxHp;
    }
    if (!this.debugBadgeEl) {
      const el = document.createElement("div");
      el.style.cssText =
        "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:50;" +
        "font:600 13px/1.4 monospace;letter-spacing:1px;color:#ffd166;" +
        "background:rgba(0,0,0,0.55);border:1px solid #ffd166;border-radius:4px;" +
        "padding:3px 10px;pointer-events:none;text-shadow:0 0 6px #ffae00;";
      document.body.appendChild(el);
      this.debugBadgeEl = el;
    }
    this.debugBadgeEl.textContent = `GOD MODE — invuln + ${GameConfig.debug.godSpeedMultiplier}× speed`;
    this.debugBadgeEl.style.display = this.debugGodMode ? "block" : "none";
    console.info(`[debug] god mode ${this.debugGodMode ? "ON" : "OFF"}`);
  }

  private readonly tick = (): void => {
    try {
      const deltaSeconds = Math.min(
        this.engine.getDeltaTime() / 1000,
        GameConfig.scene.maxDeltaSeconds,
      );
      const deltaMs = deltaSeconds * 1000;
      const nowMs = performance.now();
      const inHitstop = nowMs < this.hitstopUntilMs;
      const ended = this.state === "victory" || this.state === "defeat";
      // Did the gameplay sim actually advance this frame? Drives the engine-FX
      // gate in updateViews (those used to live inside the now-extracted sim
      // loop, so they only ran when it did).
      const simStepRan = !inHitstop && !ended;

      this.input.update();
      if (this.input.consumeDebugToggle()) this.toggleGodMode();

      const anyInputHeld =
        this.input.state.thrust ||
        this.input.state.reverse ||
        this.input.state.rotateLeft ||
        this.input.state.rotateRight ||
        this.input.state.fire;
      if (anyInputHeld) this.sound.unlock();

      // --- Simulation (server-safe). Hitstop is a CLIENT-only freeze, so the
      // browser gates it here rather than inside advanceSim: during a freeze
      // frame we still refresh the sensor picture (so the radar keeps aging
      // tracks honestly) and the player's missile lock, but hold the rest of
      // the sim. Otherwise advance the full step — which itself no-ops the
      // gameplay body once the match has ended. The headless harness has no
      // hitstop and calls advanceSim() unconditionally.
      if (inHitstop) {
        this.updateSensorPicture(nowMs);
        this.lockTarget = this.computeLockTarget();
      } else {
        this.advanceSim(deltaSeconds, deltaMs, nowMs);
      }

      this.updateViews(deltaSeconds, deltaMs, nowMs, inHitstop, simStepRan);

      this.scene.render();
    } catch (err) {
      console.error("[Game] render loop frame failed", err);
    }
  };

  /**
   * Refresh the sensor picture: the per-faction rosters that back the
   * controller world, the shared AI avoidance obstacles, then the sensor
   * sweep. Runs even during a client hitstop freeze (the radar keeps aging
   * tracks honestly while the sim is paused); detection itself is throttled
   * inside SensorSystem.
   */
  private updateSensorPicture(nowMs: number): void {
    this.refreshRosters();
    this.refreshAiObstacles();
    this.sensors.update(nowMs, this.shipsByFaction);
  }

  /**
   * Advance the gameplay simulation one fixed step — the server-safe half of
   * the old monolithic tick(). Touches NO scene/view state: controllers →
   * ships → weapons fire → collisions → death/respawn → projectile sim →
   * win/lose, all driving sim objects only. Transient FX (explosions, SFX,
   * shake, hitstop, damage flash) are EMITTED on the SimEventBus, never fired
   * inline; the engine-glow/plume visuals are bridged to updateViews via each
   * combatant's `lastInput`. This is the method a future Colyseus room runs on
   * its tick, and the method the headless smoke harness mirrors.
   */
  private advanceSim(deltaSeconds: number, deltaMs: number, nowMs: number): void {
    this.updateSensorPicture(nowMs);
    this.lockTarget = this.computeLockTarget();

    // The match is over — the sensor picture above keeps ticking, but the
    // gameplay sim freezes on the end screen.
    if (this.state === "victory" || this.state === "defeat") return;

    // Drift-spin every wreck, then rebuild the combined weapon-cover list (the
    // asteroid field's live rocks + the wrecks' freshly-rotated cover circles)
    // the weapon systems read this step. Runs every active step so the list is
    // populated with rocks even when there are no wrecks.
    for (const hulk of this.hulks) hulk.update(deltaSeconds);
    this.refreshWeaponObstacles();

    // Enemy fleet doctrine: re-task the dynamic pool (throttled internally).
    this.fleetCommander?.update(nowMs);

    for (const c of this.combatants) {
      const ship = c.ship;
      const isPlayer = ship === this.playerShip;

      // Catapult launch: the sequence drives the ship and its controller is
      // suppressed (frozen in the tube, then flung out) until it clears the
      // bow. Every launching ship runs this — player, wingmen, and enemy
      // fleet alike — so nobody moves until their own launch fires.
      if (c.launch && !c.launch.isComplete) {
        if (ship.isAlive) {
          c.launch.update(deltaSeconds, ship);
          if (c.launch.justLaunched) {
            this.events.emit("shipLaunched", { ship });
          }
          // Engine FX stays dark for the whole launch (updateViews reads this):
          // the ship is occluded by the carrier, and the GlowLayer composites
          // emissive over the hull with no depth test, so a lit glow would
          // bleed through as "ghost lights". Cleared input = forced-off FX.
          c.lastInput = null;
          if (c.launch.isComplete) {
            // The match goes live the instant the PLAYER clears the bow;
            // the rest of the wing may still be launching behind them.
            if (isPlayer && this.state === "launching") this.state = "playing";
            c.launch = null;
          }
          continue;
        }
        // Died mid-launch (a stray hit) — abandon the catapult and fall
        // through to normal death handling below.
        c.launch = null;
      }

      const input = c.controller.update(deltaSeconds, ship, this.worldByFaction[ship.faction]);
      ship.update(deltaSeconds, input);
      // Record the input the ship flew on so updateViews can light its exhaust
      // from it (the engine glow + maneuvering plumes are view-only).
      c.lastInput = input;

      if (ship.isAlive && input.fire) {
        const positions = ship.tryFire();
        for (const p of positions) {
          // Each bolt carries ITS shooter + per-type damage (a Breaker's
          // bolts hit harder than a Spitfire's on the same faction system).
          this.factionLasers[ship.faction].spawn(p, ship.rotationY, ship, ship.laserDamage);
        }
        if (positions.length > 0) {
          this.events.emit("shipFiredLaser", { ship });
        }
      }

      // Missiles: any ship whose type carries a rack. The player's round
      // homes on their HUD lock; an AI pilot's homes on the fresh contact
      // its controller chose (AIController.missileTarget). No lock =
      // ballistic (it may still reacquire mid-flight). Like the lasers,
      // the round spawns into the SHOOTER's faction system carrying the
      // shooter for attribution.
      if (ship.isAlive && input.fireMissile) {
        const missilePos = ship.tryFireMissile();
        if (missilePos) {
          const homing = isPlayer
            ? this.lockTarget
            : c.controller instanceof AIController
              ? c.controller.missileTarget
              : null;
          this.factionMissiles[ship.faction].spawn(
            missilePos,
            ship.rotationY,
            homing,
            ship,
          );
          this.events.emit("missileFired", { ship });
        }
      }

      // Jump drive: a key edge (player) or the AI jump-out doctrine arms or
      // cancels the spool; completing it teleports the ship home into its
      // service bubble at zero velocity (docs/JUMP-DRIVE-AND-RESUPPLY.md).
      if (ship.isAlive) {
        if (input.jumpPressed) {
          const ev = ship.onJumpIntent();
          if (ev === "spool-started") {
            this.events.emit("jumpSpoolStarted", { ship });
          } else if (ev === "spool-cancelled") {
            this.events.emit("jumpCancelled", { ship });
          }
        }
        if (ship.tickJump(deltaSeconds)) {
          const home = this.motherships[ship.faction];
          if (home.isAlive) {
            const fromX = ship.position.x;
            const fromZ = ship.position.z;
            const bay = home.getLaunchStartPosition(c.bayIndex);
            ship.jumpTeleport(bay.x, bay.z, home.rotationY);
            this.events.emit("jumpFired", {
              ship,
              fromX,
              fromZ,
              toX: ship.position.x,
              toZ: ship.position.z,
            });
          }
        }
      }

      // Carrier service: a ship loitering (slowed below loiterMaxSpeed) inside
      // its OWN carrier's service bubble repairs + rearms over time. The same
      // service a jump arrival drops into (docs/JUMP-DRIVE-AND-RESUPPLY.md).
      if (ship.isAlive) {
        const home = this.motherships[ship.faction];
        const docked =
          home.isAlive &&
          ship.speed <= GameConfig.service.loiterMaxSpeed &&
          home.serviceZoneContains(ship.position.x, ship.position.z);
        const state: "servicing" | "docked" | null = docked
          ? ship.serviceTick(deltaSeconds)
            ? "servicing"
            : "docked"
          : null;
        if (isPlayer) this.playerServiceState = state;
      }
    }

    // Carrier defense turrets: each live turret tracks its faction's sensor
    // picture and fires into that faction's LaserSystem (shooter = null — a
    // turret isn't a Ship; onHit/feedback handle a null shooter). Bolts go
    // into the carrier's OWN faction system, so a humans turret hits machines.
    for (const f of ["humans", "machines"] as Faction[]) {
      const ms = this.motherships[f];
      const fires = ms.updateTurrets(deltaSeconds, this.sensors.contacts[f], nowMs);
      for (const cmd of fires) {
        this.factionLasers[f].spawn(cmd.origin, cmd.rotationY, null, cmd.damage, true, cmd.velocityY);
        this.events.emit("turretFired", { faction: f, origin: cmd.origin });
      }
    }

    // Ships that rammed a rock this frame: hard-bump them off it + damage.
    this.resolveAsteroidCollisions(nowMs);
    // The carriers are solid: bump out anyone overlapping a hull section.
    this.resolveMothershipCollisions();
    // Wrecks are solid too (circular keep-out, no damage).
    this.resolveHulkCollisions();

    // Death FX + respawn, per combatant.
    for (const c of this.combatants) {
      const ship = c.ship;
      const isPlayer = ship === this.playerShip;
      if (!ship.isAlive && !ship.explosionFired) {
        this.events.emit("shipDied", { ship });
        ship.explosionFired = true;
      }
      if (ship.shouldRespawn(nowMs)) this.respawnShip(c, isPlayer);
    }

    // Turret death FX (fires once per turret, gated by its explosionFired
    // latch — same shape as ship death). No respawn: a shot-off gun stays gone.
    for (const f of ["humans", "machines"] as Faction[]) {
      for (const turret of this.motherships[f].turrets) {
        if (!turret.isAlive && !turret.explosionFired) {
          this.events.emit("turretDestroyed", { position: turret.position });
          turret.explosionFired = true;
        }
      }
    }

    this.factionLasers.humans.update(deltaSeconds, deltaMs, nowMs);
    this.factionLasers.machines.update(deltaSeconds, deltaMs, nowMs);
    this.factionMissiles.humans.update(deltaSeconds, deltaMs, nowMs);
    this.factionMissiles.machines.update(deltaSeconds, deltaMs, nowMs);

    // Drift/tumble the rocks + process any shattered by the fire above.
    this.asteroids.update(deltaSeconds);

    this.checkObjectives();
  }

  /**
   * Depict the current sim state — the client-only half of the old tick().
   * Copies sim poses into scene nodes, drives every transient/continuous FX,
   * camera, HUD, radar, and renders. `inHitstop` is the freeze frame (sim
   * static, but camera shake / audio / HUD keep animating — the intentional
   * hitstop asymmetry); `simStepRan` is whether advanceSim advanced the
   * gameplay body this frame, which gates the engine FX that used to live
   * inside the sim loop.
   */
  private updateViews(
    deltaSeconds: number,
    deltaMs: number,
    nowMs: number,
    inHitstop: boolean,
    simStepRan: boolean,
  ): void {
    // --- Depictions: copy every ship's sim pose into its scene root, and
    // every weapon system's live projectiles onto its mesh pool. Runs
    // every frame (during hitstop the poses simply haven't changed) and
    // BEFORE the camera/FX below so anything parented to a ship root sees
    // this frame's transform.
    for (const c of this.combatants) c.view.update(c.ship);
    // Spin each wreck's mesh to match its (sim-owned) rotation. Reads rotationY
    // every frame so the drift-spin is smooth even though it only advances in
    // advanceSim (frozen during hitstop / after the match, like the rest).
    for (let i = 0; i < this.hulks.length; i++) {
      this.hulkViews[i].update(
        this.hulks[i].rotationY,
        this.hulks[i].rotationX,
        this.hulks[i].rotationZ,
      );
    }
    // Swing each carrier's turret barrels to their sim aim (carriers are static,
    // so only the turrets need a per-frame sync).
    this.mothershipViews.humans.syncTurrets();
    this.mothershipViews.machines.syncTurrets();
    this.factionLaserViews.humans.update();
    this.factionLaserViews.machines.update();
    this.factionMissileViews.humans.update();
    this.factionMissileViews.machines.update();

    // Light each AI ship's exhaust (engine glow + maneuvering plumes) from the
    // input it flew on this sim step. Only when the sim actually advanced —
    // these used to sit inside the sim loop, so they froze during hitstop and
    // after the match ends. Dead ships pass all-false (the AIController emits
    // that), so the FX tapers off rather than freezing lit. The player uses the
    // standalone engineGlow/secondaryThrusters below, so it has no aiVisuals
    // entry and is skipped here.
    if (simStepRan) {
      for (const c of this.combatants) {
        const vis = this.aiVisuals.get(c.ship);
        if (!vis) continue;
        if (c.lastInput === null) {
          // Mid-launch: keep the glow dark (occluded by the carrier; a lit glow
          // bleeds through the hull via the GlowLayer). Re-shows next step.
          vis.glow?.hide();
          vis.thrusters?.update(deltaSeconds, false, false, false);
        } else {
          const alive = c.ship.isAlive;
          vis.glow?.update(
            deltaSeconds,
            c.ship.speed,
            c.ship.maxSpeed,
            alive && c.lastInput.thrust,
          );
          vis.thrusters?.update(
            deltaSeconds,
            alive && c.lastInput.reverse,
            alive && c.lastInput.strafeLeft,
            alive && c.lastInput.strafeRight,
          );
        }
      }
    }

    // Explosions animate through the end screen (so the death spectacle plays
    // out) but pause during hitstop, like the rest of the sim.
    if (!inHitstop) this.explosions.update(deltaSeconds, deltaMs);
    // Jump cracks ride the same hitstop gate as explosions.
    if (!inHitstop) this.jumpFlashes.update(deltaMs);
    // The shockwave refraction animates THROUGH hitstop (like camera shake —
    // it's a screen distortion, not a simulated object).
    this.jumpRipple.update(deltaMs);

    // --- Animations that continue THROUGH hitstop ---
    if (this.playerShip && this.playerShip.isAlive) {
      const playerLaunch = this.playerLaunch;
      if (playerLaunch) {
        this.cameraRig.setZoom(playerLaunch.desiredZoom);
      }
      const zoomInput =
        (this.input.state.zoomIn ? 1 : 0) - (this.input.state.zoomOut ? 1 : 0);
      this.cameraRig.update(
        deltaSeconds,
        this.playerShip.position,
        this.playerShip.velocity,
        zoomInput,
      );
      this.starfield.update();
      this.backdrop.update(this.cameraRig.camera.getTarget());
      if (!inHitstop) {
        // Keep the glow off through the player's launch (it's occluded by the
        // carrier; a lit glow would bleed through the hull via the GlowLayer).
        // update() re-shows it the first frame after the catapult completes.
        if (playerLaunch) {
          this.engineGlow?.hide();
        } else {
          this.engineGlow?.update(
            deltaSeconds,
            this.playerShip.speed,
            this.playerShip.maxSpeed,
            this.input.state.thrust,
          );
        }
        const alive = this.playerShip.isAlive;
        this.secondaryThrusters?.update(
          deltaSeconds,
          alive && this.input.state.reverse,
          alive && this.input.state.strafeLeft,
          alive && this.input.state.strafeRight,
        );
      }
    }
    this.playerDamageFlash?.update();
    for (const flash of this.aiDamageFlashes.values()) flash.update();

    const engineIntensity =
      this.playerShip && this.playerShip.isAlive
        ? (this.engineGlow?.currentIntensity ?? 0)
        : 0;
    this.sound.updateEngine(deltaSeconds, engineIntensity);

    // Incoming-missile warning (RWR). Presentation, so it runs THROUGH
    // hitstop with the rest of this block (audio + HUD continue during
    // freeze frames; the threat picture is simply static while the sim is
    // paused). Passing player = null outside live play — launch countdown,
    // end screens, death gaps — forces it quiet, fading any active pulse.
    const rwrActive =
      this.state === "playing" &&
      this.playerShip !== null &&
      this.playerShip.isAlive;
    this.missileWarning.update(
      deltaSeconds,
      nowMs,
      this.factionMissiles[this.enemyFaction],
      rwrActive ? this.playerShip : null,
    );

    // HUD.
    if (this.playerShip) {
      // The stealth cue asks the ENEMY's sensor picture about the player.
      const signature = this.sensors.isTracked(this.enemyFaction, this.playerShip)
        ? "detected"
        : this.sensors.isConcealed(this.playerShip.position)
          ? "hidden"
          : "untracked";
      this.hud.update(
        this.playerShip,
        nowMs,
        this.lockTarget !== null,
        this.cameraRig.currentZoom,
        signature,
        this.playerKills,
        this.wingKills,
        this.score,
        this.bestScore,
      );
      this.hud.setServiceStatus(this.playerServiceState);
      this.hud.setJumpSpool(
        this.playerShip.isSpoolingJump ? this.playerShip.jumpSpoolProgress : null,
      );
    }
    this.hud.setMothershipHp(
      this.motherships.humans.hp / this.motherships.humans.maxHp,
      this.motherships.machines.hp / this.motherships.machines.maxHp,
    );
    if (this.playerShip) {
      this.radar.update(
        this.playerShip,
        this.shipsByFaction[this.playerFaction],
        this.sensors.contacts[this.playerFaction],
        this.missileWarning.threats,
        this.motherships,
        this.asteroids.asteroids,
        this.combatNebulas.zones,
        nowMs,
      );
    }
    this.hud.setLaunchOverlay(this.playerLaunch?.overlayText ?? null);
    this.hud.setEndBanner(
      this.state === "victory" ? "victory" : this.state === "defeat" ? "defeat" : null,
      `KILLS ${this.playerKills} · SCORE ${this.score}${
        this.score > 0 && this.score >= this.bestScore ? " · NEW BEST" : ""
      }`,
    );
  }

  /** The player's active launch sequence — what the camera zoom + overlay read. */
  private get playerLaunch(): LaunchSequence | null {
    return this.playerCombatant?.launch ?? null;
  }

  /**
   * Build a catapult sequence for the given carrier, derived from its facing so
   * either mothership launches correctly (humans fire +Z, machines fire -Z).
   * `holdSec` is the time frozen in the tube before the catapult fires (the
   * player's cinematic countdown, plus a per-ship stagger for the rest of the
   * wing); `cinematic` (player only) drives the camera zoom + 3-2-1 overlay.
   */
  private makeLaunchSequence(
    home: Mothership,
    holdSec: number,
    cinematic: boolean,
    skipIntro = false,
  ): LaunchSequence {
    const fwd = home.getLaunchForward();
    return new LaunchSequence(
      fwd.x,
      fwd.z,
      home.position.x,
      home.position.z,
      home.getLaunchExitDistance(),
      holdSec,
      cinematic,
      skipIntro,
    );
  }

  /**
   * Launch both fleets from their carriers at match start. The player runs the
   * full cinematic and catapults first; their wingmen stream out one behind the
   * other, and the enemy fleet does the same from its own carrier — so no ship
   * moves until its own catapult fires (the wing no longer leaks out during the
   * countdown), and the enemy starts at its carrier instead of beside the
   * player.
   */
  private assignInitialLaunches(): void {
    // The player's queue: the player first (cinematic), then their wingmen.
    const friendly: Combatant[] = [];
    if (this.playerCombatant) friendly.push(this.playerCombatant);
    for (const c of this.combatants) {
      if (c.ship.faction === this.playerFaction && c !== this.playerCombatant) {
        friendly.push(c);
      }
    }
    const enemy = this.combatants.filter((c) => c.ship.faction === this.enemyFaction);

    const base = LaunchSequence.cinematicHoldSec();
    this.launchFleet(friendly, this.motherships[this.playerFaction], base);
    this.launchFleet(enemy, this.motherships[this.enemyFaction], base);
  }

  /**
   * Stage a fleet `queue` in the bays of `home` and give each ship a launch
   * sequence. Bays fill in contiguous blocks of `shipsPerBay` (the first block
   * launches from bay 0, the next from bay 1, …) so a small wing all streams out
   * of the same tube and arrives together instead of one ship peeling off the
   * far bay. Each ship launches `staggerSec` after the previous (the first at
   * `baseHoldSec`, which for the player side is the cinematic countdown). The
   * player's own launch is the cinematic one.
   */
  private launchFleet(queue: Combatant[], home: Mothership, baseHoldSec: number): void {
    const bays = home.getLaunchBayCount();
    const perBay = GameConfig.launch.shipsPerBay;
    const stagger = GameConfig.launch.staggerSec;
    queue.forEach((c, i) => {
      const bayIndex = Math.min(Math.floor(i / perBay), bays - 1);
      c.bayIndex = bayIndex;
      const start = home.getLaunchStartPosition(bayIndex);
      c.ship.respawn(start.x, start.z, home.rotationY);
      const isPlayer = c === this.playerCombatant;
      c.launch = this.makeLaunchSequence(home, baseHoldSec + i * stagger, isPlayer);
    });
  }

  /**
   * Derives a single engine-glow emitter at the rear-center of a ship's mesh,
   * in ship-local coordinates. Used for GLB enemies that carry no thruster
   * markers: places the glow at the model's tail (min Z, since forward is +Z)
   * regardless of the model's size. Call before the root is positioned (it's at
   * identity then, so the mesh bounds are already in ship-local space).
   */
  private rearEmitters(
    root: TransformNode,
  ): Array<{ x: number; y: number; z: number }> {
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
    // Rear = min Z; nudge slightly forward so the glow sits at the nozzle plane
    // rather than poking out behind. Centered in X, mid-height in Y.
    return [
      { x: (min.x + max.x) * 0.5, y: (min.y + max.y) * 0.5, z: min.z + 0.15 },
    ];
  }

  /**
   * Build an AI fighter — the Ship sim plus its ShipView depiction — of the
   * given catalog `type` for a faction. If `template` is given, the fighter's
   * view is a CLONE of that loaded GLB (two-tier root like the player's, so
   * the view drives the outer root while the clone carries the model's
   * alignment); otherwise it gets the procedural faction-themed FighterMesh.
   */
  private makeFighter(
    faction: Faction,
    type: ShipTypeConfig,
    template: TransformNode | null = null,
  ): { ship: Ship; view: ShipView } {
    let root: TransformNode;
    if (template) {
      root = new TransformNode(`fighter_${faction}_root`, this.scene);
      template.instantiateHierarchy(root, { doNotInstantiate: true });
      // The template is disabled so it never renders as a stray ship; force the
      // clone's whole subtree back on (clones can inherit the disabled flag).
      root.setEnabled(true);
      for (const n of root.getDescendants()) n.setEnabled(true);
    } else {
      root = buildFighterMesh(this.scene, this.glowLayer, faction);
    }
    const ship = new Ship({
      faction,
      maxHp: type.maxHp,
      respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
      startMissileAmmo: type.missileAmmo,
      startCannonAmmo: type.cannonAmmo,
      movement: type,
      laserDamage: type.laserDamage,
      hitRadius: type.hitRadius,
      fireSound: type.fireSound,
      heavy: type.heavy,
    });
    return { ship, view: new ShipView(root) };
  }

  /**
   * Respawn a dead ship by relaunching it from its own carrier: every ship —
   * the player, their wingmen, and the enemy fleet — streams back out of its
   * mothership's bay via a streamlined (skip-intro) catapult out of the bay it
   * was assigned at match start, so reinforcements always re-enter from the
   * carrier rather than popping into the arena.
   */
  private respawnShip(c: Combatant, isPlayer: boolean): void {
    const ship = c.ship;
    const home = this.motherships[ship.faction];
    // No respawn once a carrier is gone (for the player that path ends in defeat,
    // and a fallen enemy carrier means the match is already won).
    if (!home.isAlive) return;
    const start = home.getLaunchStartPosition(c.bayIndex);
    ship.respawn(start.x, start.z, home.rotationY);
    // Flush the trail history so no streak appears on the first thrust after
    // teleporting to the respawn position.
    if (isPlayer) {
      this.engineGlow?.resetTrails();
    } else {
      this.aiVisuals.get(ship)?.glow?.resetTrails();
    }
    // skipIntro = immediate catapult, no wide shot / countdown on a respawn.
    c.launch = this.makeLaunchSequence(home, 0, isPlayer, true);
  }

  /** Win when the enemy mothership falls; lose when yours does. */
  private checkObjectives(): void {
    if (this.state !== "playing" && this.state !== "launching") return;
    if (!this.motherships[this.enemyFaction].isAlive) {
      this.endMatch("victory", this.motherships[this.enemyFaction]);
    } else if (!this.motherships[this.playerFaction].isAlive) {
      this.endMatch("defeat", this.motherships[this.playerFaction]);
    }
  }

  /** Freeze the sim, play the mothership death spectacle, show the banner. */
  private endMatch(outcome: "victory" | "defeat", destroyed: Mothership): void {
    this.state = outcome;
    // Kill any in-progress launch (e.g. the player's cinematic) so its overlay
    // clears and the catapult stops driving a ship under the end banner.
    for (const c of this.combatants) c.launch = null;

    this.events.emit("mothershipDied", { mothership: destroyed });
  }

  handleResize(): void {
    this.engine.resize();
  }
}
