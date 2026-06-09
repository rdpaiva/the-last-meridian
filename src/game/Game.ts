import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
// Builds a cube/IBL environment from an equirectangular image — used to light
// the PBR (metallic) GLB ships, which need an environment to reflect.
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture";

import { GameConfig } from "./GameConfig";
import { InputManager } from "./InputManager";
import { Arena } from "./Arena";
import { AssetLoader } from "./AssetLoader";
import { Ship } from "./Ship";
import type { ShipMovementConfig } from "./Ship";
import { LaserSystem } from "./LaserSystem";
import { MissileSystem } from "./MissileSystem";
import { wrapAngle } from "./math";
import { CameraRig } from "./CameraRig";
import { Hud } from "./Hud";
import { Radar } from "./Radar";
import { Starfield } from "./Starfield";
import { EngineGlow } from "./EngineGlow";
import { SecondaryThrusters } from "./SecondaryThrusters";
import { CapitalShips } from "./CapitalShips";
import { Nebulas } from "./Nebulas";
import { Backdrop } from "./Backdrop";
import { ExplosionSystem } from "./ExplosionSystem";
import { SoundSystem } from "./SoundSystem";
import { MusicSystem } from "./MusicSystem";
import { DamageFlash } from "./DamageFlash";
import { Mothership } from "./Mothership";
import { LaunchSequence } from "./LaunchSequence";
import { opposing, FACTION_THEME, type Faction } from "./Faction";
import { LocalInputController } from "./LocalInputController";
import { AIController } from "./AIController";
import type { ShipController, ControllerWorld } from "./ShipController";
import { buildFighterMesh } from "./FighterMesh";
import type { DamageTarget } from "./types";

/** Match lifecycle. The match has a beginning (launch), middle (playing), end. */
type GameState = "launching" | "playing" | "victory" | "defeat";

/** A ship plus whatever drives it (keyboard / AI / future network). */
interface Combatant {
  ship: Ship;
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
  private readonly playerMissiles: MissileSystem;
  private readonly explosions: ExplosionSystem;
  private readonly sound: SoundSystem;
  private readonly music: MusicSystem;
  private readonly cameraRig: CameraRig;
  private readonly starfield: Starfield;
  private readonly backdrop: Backdrop;
  private readonly hud: Hud;
  private readonly radar: Radar;

  /** Which side the human pilot flies, and the side they fight. */
  private readonly playerFaction: Faction;
  private readonly enemyFaction: Faction;

  /** Each faction's own laser bolts (humans fire humansLasers, etc.). */
  private readonly factionLasers: Record<Faction, LaserSystem>;
  private readonly motherships: Record<Faction, Mothership>;

  /** All ships, regardless of side, plus their controllers. */
  private readonly combatants: Combatant[] = [];
  /**
   * Engine visuals for AI ships (glow + optional maneuvering-thruster plumes),
   * keyed by Ship. Driven each frame from that ship's emitted input so its
   * exhaust lights when it burns. Wingmen get both glow + thrusters; enemy GLB
   * fighters get a glow only (they don't strafe, and procedural fighters already
   * carry their own emissive engine). The player uses the standalone
   * engineGlow/secondaryThrusters fields instead.
   */
  private readonly aiVisuals = new Map<
    Ship,
    { glow: EngineGlow; thrusters?: SecondaryThrusters }
  >();
  /** Live roster per faction, refilled each frame; backs the controller world. */
  private readonly shipsByFaction: Record<Faction, Ship[]> = {
    humans: [],
    machines: [],
  };
  /** Per-faction read-only world view handed to that faction's controllers. */
  private readonly worldByFaction: Record<Faction, ControllerWorld>;

  /** The locally-controlled ship (built on async asset load). */
  private playerShip: Ship | null = null;
  private readonly playerController: LocalInputController;
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
   * Wall-clock timestamp until which the simulation is paused. While
   * `nowMs < hitstopUntilMs`, the tick skips simulation but still updates the
   * camera (so shake animates) and renders.
   */
  private hitstopUntilMs = 0;

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLDivElement) {
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
    this.scene.skipPointerMovePicking = true;
    const c = GameConfig.scene.clearColor;
    this.scene.clearColor = new Color4(c.r, c.g, c.b, 1);

    this.glowLayer = new GlowLayer("glow", this.scene, {
      mainTextureRatio: GameConfig.glow.mainTextureRatio,
      blurKernelSize: GameConfig.glow.blurKernelSize,
    });
    this.glowLayer.intensity = GameConfig.glow.intensity;

    // --- Lights ---
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.55;
    hemi.groundColor = new Color3(0.05, 0.05, 0.12);
    hemi.diffuse = new Color3(0.6, 0.7, 0.95);

    const sun = new DirectionalLight(
      "sun",
      new Vector3(-0.4, -1, 0.2),
      this.scene,
    );
    sun.intensity = 0.75;
    sun.diffuse = new Color3(1, 0.95, 0.85);

    // --- Environment (IBL) ---
    // The GLB ships use PBR materials — the spitfire's are fully metallic — and
    // a metal surface is rendered almost entirely by what it REFLECTS. With no
    // environment those metals come out flat/dark. Reuse the space backdrop as
    // the environment map so ships pick up a subtle space-colored sheen (and any
    // future PBR model benefits automatically). This sets reflections only — it
    // does NOT draw a skybox, so the visible background (Backdrop) is unchanged.
    this.scene.environmentTexture = new EquiRectangularCubeTexture(
      "/textures/space-backdrop.jpg",
      this.scene,
      256,
    );
    this.scene.environmentIntensity = 0.6;

    // --- Factions ---
    this.playerFaction = GameConfig.player.faction;
    this.enemyFaction = opposing(this.playerFaction);

    // --- Subsystems ---
    this.input = new InputManager();
    this.input.attach();
    this.playerController = new LocalInputController(this.input);
    window.addEventListener("keydown", this.onKeyDown);

    this.arena = new Arena(this.scene);
    this.backdrop = new Backdrop(this.scene);
    new Nebulas(this.scene, this.arena.halfWidth, this.arena.halfDepth);
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
      humans: new Mothership(
        this.scene,
        this.glowLayer,
        new Vector3(0, ms.yLevel, ms.playerZ),
        0,
        "humans",
      ),
      machines: new Mothership(
        this.scene,
        this.glowLayer,
        new Vector3(0, ms.yLevel, ms.enemyZ),
        Math.PI,
        "machines",
      ),
    };

    this.sound = new SoundSystem(this.scene);
    this.music = new MusicSystem(this.scene);

    // Faction-keyed laser systems. onHit scales feedback by what was struck:
    // hitting the player's ship flashes + jolts hard; chipping the (huge,
    // stationary) mothership only plays a light hit cue so sustained fire on it
    // doesn't spam hitstop and crawl the whole game.
    const humansLasers = new LaserSystem(this.scene, {
      damage: GameConfig.combat.laserDamage,
      emissive: FACTION_THEME.humans.laserEmissive,
      materialName: FACTION_THEME.humans.laserMaterialName,
      onHit: (target, fromPlayer) => this.onLaserHit(target, fromPlayer),
    });
    const machinesLasers = new LaserSystem(this.scene, {
      damage: GameConfig.combat.laserDamage,
      emissive: FACTION_THEME.machines.laserEmissive,
      materialName: FACTION_THEME.machines.laserMaterialName,
      onHit: (target, fromPlayer) => this.onLaserHit(target, fromPlayer),
    });
    this.factionLasers = { humans: humansLasers, machines: machinesLasers };

    // Player heat-seeking missiles (a humans/player capability for now).
    this.playerMissiles = new MissileSystem(this.scene, {
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      bodyColor: new Color3(0.62, 0.66, 0.7),
      finColor: new Color3(0.78, 0.16, 0.16),
      trailEmissive: new Color3(2.2, 0.7, 0.1),
      materialName: "player_missile_mat",
      onHit: (pos) => {
        this.explosions.spawn(pos);
        this.sound.playExplosion(pos);
        this.cameraRig.addTrauma(this.traumaAtDistance(GameConfig.shake.traumaMissileHit, pos));
        this.applyHitstop(GameConfig.hitstop.missileHitMs);
      },
    });

    this.explosions = new ExplosionSystem(this.scene, this.glowLayer);

    // Enemy AI fighters are built in start(), not here: they clone a GLB
    // template (GameConfig.enemy.shipModel) that has to be loaded async first,
    // the same way the player's wingmen clone the player's loaded ship.

    this.cameraRig = new CameraRig(this.scene);
    this.starfield = new Starfield(this.scene, this.cameraRig.camera);
    this.hud = new Hud(hudRoot);
    this.radar = new Radar();

    // Each faction's controllers see the OTHER faction as opponents. The
    // opponents arrays are mutated in place each frame, so these views stay
    // current without reallocation.
    this.worldByFaction = {
      humans: {
        opponents: this.shipsByFaction.machines,
        opponentMothership: this.motherships.machines,
        homeMothership: this.motherships.humans,
        leader: null, // set to the player ship in start() if humans is the player side
        arenaHalfX: this.arena.halfWidth,
        arenaHalfZ: this.arena.halfDepth,
      },
      machines: {
        opponents: this.shipsByFaction.humans,
        opponentMothership: this.motherships.humans,
        homeMothership: this.motherships.machines,
        leader: null, // set to the player ship in start() if machines is the player side
        arenaHalfX: this.arena.halfWidth,
        arenaHalfZ: this.arena.halfDepth,
      },
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const loader = new AssetLoader(this.scene);
    const loaded = await loader.loadPlayerShip();
    // Enemy fighters clone this template (null → procedural FighterMesh).
    const enemyTemplate = await loader.loadModelTemplate(GameConfig.enemy.shipModel);
    // Mount points authored into the player model (empties named thruster*/
    // muzzle*/rcs.*). Empty when the model has none → systems use their config
    // defaults. Wingmen clone the same model, so they share these markers.
    const markers = loaded.markers;
    this.playerShip = new Ship(loaded.root, {
      faction: this.playerFaction,
      maxHp: GameConfig.combat.playerMaxHp,
      respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
      startMissileAmmo: GameConfig.missile.maxAmmo,
      movement: GameConfig.player,
      muzzles: markers.muzzles.length > 0 ? markers.muzzles : undefined,
      fireSound: "playerGuns",
    });

    // Player-side AI wingmen (Phase 5): real fighters like the player. Each gets a
    // CLONE of the player's actual loaded ship model, so wingmen always look like
    // whatever the player flies — change the player's ship (the `shipDesign` flag
    // or a real fighter.glb) and the wing changes with it automatically. They fly
    // the player's profile (guns/turn/HP) with drag + higher thrust so they hold
    // formation, and each carries a standing order/slot.
    const wcfg = GameConfig.player.wingmen;
    // Wingmen fly the player's exact movement/weapon profile — identical ship,
    // just AI-piloted. No overrides: whatever drag/speed/thrust the player has,
    // the wing inherits, so an ally is never faster than you and carries the
    // same (zero) drag, which is what keeps a stable slot from puffing its jets.
    const wingmanMovement: ShipMovementConfig = GameConfig.player;
    for (let i = 0; i < wcfg.count; i++) {
      // Two-tier root like the player's: gameplay drives `root.rotation.y`, the
      // cloned model carries its own alignment. Clone modelRoot (the visual) — NOT
      // the player root — so the player-only engine glow / thrusters / damage
      // flash don't tag along. doNotInstantiate = independent copies (not GPU
      // instances), so a wingman stays visible when the player ship is disabled
      // on death.
      const root = new TransformNode(`wingmanRoot${i}`, this.scene);
      loaded.modelRoot.instantiateHierarchy(root, { doNotInstantiate: true });
      const ship = new Ship(root, {
        faction: this.playerFaction,
        maxHp: GameConfig.combat.playerMaxHp,
        respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
        startMissileAmmo: 0,
        movement: wingmanMovement,
        muzzles: markers.muzzles.length > 0 ? markers.muzzles : undefined,
        fireSound: "playerGuns",
      });
      const controller = new AIController({
        order: wcfg.orders[i % wcfg.orders.length],
        slot: wcfg.formationSlot(i),
      });
      this.combatants.push({ ship, controller, launch: null, bayIndex: 0 });
      // Each wingman gets its own engine glow + RCS plumes on its outer root, so
      // it reads as a real fighter under thrust instead of floating. Driven from
      // the wingman's emitted input in the sim loop (see tick()).
      this.aiVisuals.set(ship, {
        glow: new EngineGlow(this.scene, root, this.glowLayer, markers.thrusters),
        thrusters: new SecondaryThrusters(this.scene, root, this.glowLayer, markers.rcs),
      });
      this.aiDamageFlashes.set(ship, new DamageFlash(this.scene, root, this.glowLayer, new Color3(2.5, 1.5, 0.2)));
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
    this.hud.setModelLabel(
      loaded.usingFallback
        ? "fallback"
        : GameConfig.player.shipModel ?? "fallback",
    );

    this.playerCombatant = {
      ship: this.playerShip,
      controller: this.playerController,
      launch: null,
      bayIndex: 0,
    };
    this.combatants.push(this.playerCombatant);

    // The player ship is the wing leader its faction's wingmen form on.
    this.worldByFaction[this.playerFaction].leader = this.playerShip;

    // Enemy AI fighters: the first `strikeCount` press the player's mothership
    // (the objective); the rest patrol/dogfight (the default order). Each is a
    // clone of the enemy GLB template (or the procedural mesh if none loaded).
    for (let i = 0; i < GameConfig.enemy.count; i++) {
      const ship = this.makeFighter(
        this.enemyFaction,
        GameConfig.enemy,
        GameConfig.combat.enemyMaxHp,
        enemyTemplate,
      );
      const order = i < GameConfig.enemy.strikeCount ? "strike" : "patrol";
      this.combatants.push({
        ship,
        controller: new AIController({ order }),
        launch: null,
        bayIndex: 0,
      });
      // GLB enemies (the wraith) have no emissive engine of their own, so give
      // them an EngineGlow at their rear so they read in combat. Procedural
      // fighters already carry an emissive engine box, so skip those. The wraith
      // has no thruster markers, so derive the rear nozzle from its bounding box.
      if (enemyTemplate) {
        this.aiVisuals.set(ship, {
          glow: new EngineGlow(
            this.scene,
            ship.root,
            this.glowLayer,
            this.rearEmitters(ship.root),
          ),
        });
      }
      this.aiDamageFlashes.set(ship, new DamageFlash(this.scene, ship.root, this.glowLayer, new Color3(2.5, 1.5, 0.2)));
    }

    // Wire combat targets: every ship is a target of the opposing faction's
    // lasers; the player's missiles target every enemy ship + their mothership.
    for (const c of this.combatants) {
      this.factionLasers[opposing(c.ship.faction)].addTarget(c.ship);
      if (c.ship.faction === this.enemyFaction) {
        this.playerMissiles.addTarget(c.ship);
      }
    }
    for (const f of ["humans", "machines"] as Faction[]) {
      this.factionLasers[opposing(f)].addTarget(this.motherships[f]);
    }
    this.playerMissiles.addTarget(this.motherships[this.enemyFaction]);

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

  /** A laser struck `target`; scale feedback to the hit (and to who fired). */
  private onLaserHit(target: DamageTarget, fromPlayer: boolean): void {
    this.sound.playHit(target.position);
    // Chipping a mothership: light cue only (avoid hitstop spam on the objective).
    if (target === this.motherships.humans || target === this.motherships.machines) {
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
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "KeyM") {
      this.sound.toggleMute();
      this.hud.setMuted(this.sound.isMuted);
    }
    // Restart after the match ends. Enter isn't a gameplay key, so no conflict.
    if (e.code === "Enter" && (this.state === "victory" || this.state === "defeat")) {
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
      const angleToEnemy = Math.atan2(dx, dz);
      if (Math.abs(wrapAngle(angleToEnemy - this.playerShip.rotationY)) > cfg.lockConeAngle) {
        continue;
      }
      best = enemy;
      bestDist = dist;
    }
    return best;
  }

  /** Refill the per-faction ship rosters that back the controller world. */
  private refreshRosters(): void {
    this.shipsByFaction.humans.length = 0;
    this.shipsByFaction.machines.length = 0;
    for (const c of this.combatants) {
      this.shipsByFaction[c.ship.faction].push(c.ship);
    }
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

      this.input.update();

      const anyInputHeld =
        this.input.state.thrust ||
        this.input.state.reverse ||
        this.input.state.rotateLeft ||
        this.input.state.rotateRight ||
        this.input.state.fire;
      if (anyInputHeld) this.sound.unlock();

      this.refreshRosters();
      const lockTarget = this.computeLockTarget();

      // --- Simulation (skipped during hitstop or after the match ends) ---
      if (!inHitstop && !ended) {
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
                // The player's launch is full-volume trauma; everyone else's
                // scales with distance (a far enemy catapult barely registers).
                this.cameraRig.addTrauma(
                  isPlayer
                    ? GameConfig.launch.launchTrauma
                    : this.traumaAtDistance(GameConfig.launch.launchTrauma, ship.position),
                );
              }
              // Light a launching wingman's exhaust during its catapult run (the
              // player's own glow is handled in the always-on animation block).
              const vis = this.aiVisuals.get(ship);
              if (vis) {
                vis.glow.update(
                  deltaSeconds,
                  ship.speed,
                  ship.maxSpeed,
                  c.launch.isLaunching,
                );
                vis.thrusters?.update(deltaSeconds, false, false, false);
              }
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

          // Light a wingman's exhaust from the same inputs it just flew on (the
          // player's equivalent visuals update further down). Dead ships pass
          // all-false (the AIController already emits that), so the glow/plumes
          // taper off rather than freezing lit.
          const vis = this.aiVisuals.get(ship);
          if (vis) {
            const alive = ship.isAlive;
            vis.glow.update(
              deltaSeconds,
              ship.speed,
              ship.maxSpeed,
              alive && input.thrust,
            );
            vis.thrusters?.update(
              deltaSeconds,
              alive && input.reverse,
              alive && input.strafeLeft,
              alive && input.strafeRight,
            );
          }

          if (ship.isAlive && input.fire) {
            const positions = ship.tryFire();
            for (const p of positions) {
              this.factionLasers[ship.faction].spawn(p, ship.rotationY, isPlayer);
            }
            // Player fire: no position (always full-volume at the listener).
            // All other ships: spatial — attenuates with distance from player.
            if (positions.length > 0) {
              this.sound.playFireSound(ship.fireSound, isPlayer ? undefined : ship.position);
            }
          }

          // Missiles: player capability. Homes onto the lock if any, else ballistic.
          if (isPlayer && ship.isAlive && input.fireMissile) {
            const missilePos = ship.tryFireMissile();
            if (missilePos) {
              this.playerMissiles.spawn(missilePos, ship.rotationY, lockTarget);
              this.sound.playMissileLaunch();
            }
          }
        }

        // Death FX + respawn, per combatant.
        for (const c of this.combatants) {
          const ship = c.ship;
          const isPlayer = ship === this.playerShip;
          if (!ship.isAlive && !ship.explosionFired) {
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
            ship.explosionFired = true;
          }
          if (ship.shouldRespawn(nowMs)) this.respawnShip(c, isPlayer);
        }

        this.factionLasers.humans.update(deltaSeconds, deltaMs);
        this.factionLasers.machines.update(deltaSeconds, deltaMs);
        this.playerMissiles.update(deltaSeconds, deltaMs);

        this.checkObjectives();
      }

      // Explosions animate through the end screen (so the death spectacle plays
      // out) but pause during hitstop, like the rest of the sim.
      if (!inHitstop) this.explosions.update(deltaSeconds, deltaMs);

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
          const thrustActive =
            this.input.state.thrust ||
            (playerLaunch?.isLaunching ?? false);
          this.engineGlow?.update(
            deltaSeconds,
            this.playerShip.speed,
            GameConfig.player.maxSpeed,
            thrustActive,
          );
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

      // HUD.
      if (this.playerShip) {
        this.hud.update(
          this.playerShip,
          this.factionLasers[this.playerFaction],
          nowMs,
          lockTarget !== null,
          this.cameraRig.currentZoom,
        );
      }
      this.hud.setMothershipHp(
        this.motherships.humans.hp / this.motherships.humans.maxHp,
        this.motherships.machines.hp / this.motherships.machines.maxHp,
      );
      if (this.playerShip) {
        this.radar.update(this.playerShip, this.shipsByFaction, this.motherships);
      }
      this.hud.setLaunchOverlay(this.playerLaunch?.overlayText ?? null);
      this.hud.setEndBanner(
        this.state === "victory" ? "victory" : this.state === "defeat" ? "defeat" : null,
      );

      this.scene.render();
    } catch (err) {
      console.error("[Game] render loop frame failed", err);
    }
  };

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
   * sequence. Ships alternate bays so the wing streams out in parallel, and
   * each launches `staggerSec` after the previous (the first at `baseHoldSec`,
   * which for the player side is the cinematic countdown). The player's own
   * launch is the cinematic one.
   */
  private launchFleet(queue: Combatant[], home: Mothership, baseHoldSec: number): void {
    const bays = home.getLaunchBayCount();
    const stagger = GameConfig.launch.staggerSec;
    queue.forEach((c, i) => {
      const bayIndex = i % bays;
      c.bayIndex = bayIndex;
      const start = home.getLaunchStartPosition(bayIndex);
      c.ship.respawn(start.x, start.z, home.root.rotation.y);
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
   * Build an AI fighter mesh + Ship for a faction (defaults to the enemy
   * profile). If `template` is given, the fighter is a CLONE of that loaded GLB
   * (two-tier root like the player's, so gameplay drives the outer root while
   * the clone carries the model's alignment); otherwise it gets the procedural
   * faction-themed FighterMesh.
   */
  private makeFighter(
    faction: Faction,
    movement: ShipMovementConfig = GameConfig.enemy,
    maxHp: number = GameConfig.combat.enemyMaxHp,
    template: TransformNode | null = null,
  ): Ship {
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
    return new Ship(root, {
      faction,
      maxHp,
      respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
      startMissileAmmo: 0,
      movement,
      fireSound: "laserGun",
    });
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
    ship.respawn(start.x, start.z, home.root.rotation.y);
    // Flush the trail history so no streak appears on the first thrust after
    // teleporting to the respawn position.
    if (isPlayer) {
      this.engineGlow?.resetTrails();
    } else {
      this.aiVisuals.get(ship)?.glow.resetTrails();
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

    const cfg = GameConfig.mothership;
    const center = destroyed.position;
    for (let i = 0; i < cfg.deathExplosionCount; i++) {
      const ox = (Math.random() * 2 - 1) * cfg.deathExplosionSpread;
      const oz = (Math.random() * 2 - 1) * cfg.deathExplosionSpread;
      this.explosions.spawn(new Vector3(center.x + ox, center.y, center.z + oz));
    }
    this.sound.playExplosion(center);
    this.cameraRig.addTrauma(cfg.deathTrauma);
    this.applyHitstop(cfg.deathHitstopMs);
  }

  handleResize(): void {
    this.engine.resize();
  }
}
