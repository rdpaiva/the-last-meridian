import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";

import { GameConfig } from "./GameConfig";
import { InputManager } from "./InputManager";
import { Arena } from "./Arena";
import { AssetLoader } from "./AssetLoader";
import { Ship } from "./Ship";
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
import { buildFighterMesh, randomFighterSpawn } from "./FighterMesh";
import type { DamageTarget } from "./types";

/** Match lifecycle. The match has a beginning (launch), middle (playing), end. */
type GameState = "launching" | "playing" | "victory" | "defeat";

/** A ship plus whatever drives it (keyboard / AI / future network). */
interface Combatant {
  ship: Ship;
  controller: ShipController;
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

  private state: GameState = "launching";
  private started = false;
  private launchSequence: LaunchSequence | null = null;

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
      onHit: (target) => this.onLaserHit("humans", target),
    });
    const machinesLasers = new LaserSystem(this.scene, {
      damage: GameConfig.combat.laserDamage,
      emissive: FACTION_THEME.machines.laserEmissive,
      materialName: FACTION_THEME.machines.laserMaterialName,
      onHit: (target) => this.onLaserHit("machines", target),
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
        this.sound.playExplosion();
        this.cameraRig.addTrauma(GameConfig.shake.traumaMissileHit);
        this.applyHitstop(GameConfig.hitstop.missileHitMs);
      },
    });

    this.explosions = new ExplosionSystem(this.scene, this.glowLayer);

    // AI fighters belong to the enemy faction. The player's own AI wingmen
    // (if any) would be added the same way later.
    for (let i = 0; i < GameConfig.enemy.count; i++) {
      const root = buildFighterMesh(this.scene, this.glowLayer, this.enemyFaction);
      const ship = new Ship(root, {
        faction: this.enemyFaction,
        maxHp: GameConfig.combat.enemyMaxHp,
        respawnDelayMs: GameConfig.combat.enemyRespawnDelayMs,
        startMissileAmmo: 0,
        movement: GameConfig.enemy,
      });
      this.combatants.push({ ship, controller: new AIController() });
    }

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
        arenaHalfX: this.arena.halfWidth,
        arenaHalfZ: this.arena.halfDepth,
      },
      machines: {
        opponents: this.shipsByFaction.humans,
        opponentMothership: this.motherships.humans,
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
    this.playerShip = new Ship(loaded.root, {
      faction: this.playerFaction,
      maxHp: GameConfig.combat.playerMaxHp,
      respawnDelayMs: GameConfig.combat.playerRespawnDelayMs,
      startMissileAmmo: GameConfig.missile.maxAmmo,
      movement: GameConfig.player,
    });
    this.engineGlow = new EngineGlow(this.scene, loaded.root, this.glowLayer);
    this.secondaryThrusters = new SecondaryThrusters(
      this.scene,
      loaded.root,
      this.glowLayer,
    );
    this.playerDamageFlash = new DamageFlash(this.scene, loaded.root, this.glowLayer);
    this.hud.setModelLabel(loaded.usingFallback ? "fallback" : "fighter.glb");

    this.combatants.push({ ship: this.playerShip, controller: this.playerController });

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

    // Place the player inside their own mothership's starboard launch tube and
    // run the full catapult cinematic.
    const home = this.motherships[this.playerFaction];
    const launchStart = home.getLaunchStartPosition();
    this.playerShip.respawn(launchStart.x, launchStart.z, home.root.rotation.y);
    this.launchSequence = this.makeLaunchSequence(home);
    this.state = "launching";

    // Scatter the enemy fighters into the arena, away from the player.
    for (const c of this.combatants) {
      if (c.ship === this.playerShip) continue;
      const spawn = randomFighterSpawn(
        this.arena.halfWidth,
        this.arena.halfDepth,
        this.playerShip.position,
      );
      c.ship.respawn(spawn.x, spawn.z, Math.random() * Math.PI * 2);
    }

    this.music.playPlaylist("game");
    this.engine.runRenderLoop(this.tick);
  }

  // ─── Combat feedback ───────────────────────────────────────────────────────

  /** A laser of `firingFaction` struck `target`; scale feedback to the hit. */
  private onLaserHit(firingFaction: Faction, target: DamageTarget): void {
    this.sound.playHit();
    // Chipping a mothership: light cue only (avoid hitstop spam on the objective).
    if (target === this.motherships.humans || target === this.motherships.machines) {
      return;
    }
    if (target === this.playerShip) {
      // The player's own ship took a hit — the heavy feedback.
      this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerLaserHit);
      this.applyHitstop(GameConfig.hitstop.playerLaserHitMs);
      this.playerDamageFlash?.trigger();
    } else if (firingFaction === this.playerFaction) {
      // The player landed a hit on an enemy fighter — lighter confirmation.
      this.cameraRig.addTrauma(GameConfig.shake.traumaEnemyLaserHit);
      this.applyHitstop(GameConfig.hitstop.enemyLaserHitMs);
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

          // Player launch: the catapult drives the ship; input is suppressed.
          if (isPlayer && this.launchSequence && !this.launchSequence.isComplete) {
            this.launchSequence.update(deltaSeconds, ship);
            if (this.launchSequence.justLaunched) {
              this.cameraRig.addTrauma(GameConfig.launch.launchTrauma);
            }
            if (this.launchSequence.isComplete) {
              if (this.state === "launching") this.state = "playing";
              this.launchSequence = null;
            }
            continue;
          }

          const input = c.controller.update(deltaSeconds, ship, this.worldByFaction[ship.faction]);
          ship.update(deltaSeconds, input);

          if (ship.isAlive && input.fire) {
            const positions = ship.tryFire();
            for (const p of positions) {
              this.factionLasers[ship.faction].spawn(p, ship.rotationY);
            }
            if (positions.length > 0) this.playFireSound(ship.faction);
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
            this.sound.playExplosion();
            this.cameraRig.addTrauma(
              isPlayer
                ? GameConfig.shake.traumaPlayerExplosion
                : GameConfig.shake.traumaEnemyExplosion,
            );
            this.applyHitstop(
              isPlayer
                ? GameConfig.hitstop.playerExplosionMs
                : GameConfig.hitstop.enemyExplosionMs,
            );
            ship.explosionFired = true;
          }
          if (ship.shouldRespawn(nowMs)) this.respawnShip(ship, isPlayer);
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
        if (this.launchSequence) {
          this.cameraRig.setZoom(this.launchSequence.desiredZoom);
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
            (this.launchSequence?.isLaunching ?? false);
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
      this.hud.setLaunchOverlay(this.launchSequence?.overlayText ?? null);
      this.hud.setEndBanner(
        this.state === "victory" ? "victory" : this.state === "defeat" ? "defeat" : null,
      );

      this.scene.render();
    } catch (err) {
      console.error("[Game] render loop frame failed", err);
    }
  };

  /** Faction-appropriate laser SFX. */
  private playFireSound(faction: Faction): void {
    if (faction === "humans") this.sound.playPlayerGuns();
    else this.sound.playEnemyLaser();
  }

  /**
   * Build a catapult sequence for the given carrier, derived from its facing so
   * either mothership launches correctly (humans fire +Z, machines fire -Z).
   */
  private makeLaunchSequence(home: Mothership, skipIntro = false): LaunchSequence {
    const fwd = home.getLaunchForward();
    return new LaunchSequence(
      fwd.x,
      fwd.z,
      home.position.x,
      home.position.z,
      home.getLaunchExitDistance(),
      skipIntro,
    );
  }

  /** Respawn a dead ship: player relaunches from its pad, fighters scatter. */
  private respawnShip(ship: Ship, isPlayer: boolean): void {
    if (isPlayer) {
      const home = this.motherships[this.playerFaction];
      // No respawn once your mothership is gone — that path ends in defeat.
      if (!home.isAlive) return;
      const start = home.getLaunchStartPosition();
      ship.respawn(start.x, start.z, home.root.rotation.y);
      // Streamlined catapult — skip the wide shot + countdown on a respawn.
      this.launchSequence = this.makeLaunchSequence(home, true);
      return;
    }
    const avoid = this.playerShip?.position ?? ship.position;
    const spawn = randomFighterSpawn(this.arena.halfWidth, this.arena.halfDepth, avoid);
    ship.respawn(spawn.x, spawn.z, Math.random() * Math.PI * 2);
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
    this.launchSequence = null;

    const cfg = GameConfig.mothership;
    const center = destroyed.position;
    for (let i = 0; i < cfg.deathExplosionCount; i++) {
      const ox = (Math.random() * 2 - 1) * cfg.deathExplosionSpread;
      const oz = (Math.random() * 2 - 1) * cfg.deathExplosionSpread;
      this.explosions.spawn(new Vector3(center.x + ox, center.y, center.z + oz));
    }
    this.sound.playExplosion();
    this.cameraRig.addTrauma(cfg.deathTrauma);
    this.applyHitstop(cfg.deathHitstopMs);
  }

  handleResize(): void {
    this.engine.resize();
  }
}
