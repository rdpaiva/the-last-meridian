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
import { PlayerShip } from "./PlayerShip";
import { LaserSystem } from "./LaserSystem";
import { MissileSystem } from "./MissileSystem";
import { wrapAngle } from "./math";
import { CameraRig } from "./CameraRig";
import { Hud } from "./Hud";
import { Starfield } from "./Starfield";
import { EngineGlow } from "./EngineGlow";
import { SecondaryThrusters } from "./SecondaryThrusters";
import { CapitalShips } from "./CapitalShips";
import { Nebulas } from "./Nebulas";
import { Backdrop } from "./Backdrop";
import { EnemyShip } from "./EnemyShip";
import { ExplosionSystem } from "./ExplosionSystem";
import { SoundSystem } from "./SoundSystem";
import { DamageFlash } from "./DamageFlash";
import { Mothership } from "./Mothership";
import { LaunchSequence } from "./LaunchSequence";

/**
 * Top-level game coordinator. Owns the engine, scene, and every subsystem;
 * runs a single render loop that ticks input → player → enemy AI → lasers
 * → explosions → camera → hud → render in that order.
 *
 * Two LaserSystem instances (one per faction) handle friendly-fire-free
 * combat: playerLasers target the enemy, enemyLasers target the player.
 * Each system tests its bolts against a single registered DamageTarget
 * per frame.
 *
 * Juice features:
 *   - Camera shake via CameraRig.addTrauma() (each impact adds trauma).
 *   - Hitstop via applyHitstop(ms): the simulation freezes briefly but
 *     the camera shake, damage flash, and rendering keep animating, so
 *     the freeze-frame is visually alive.
 *   - Damage flash via DamageFlash.trigger(): a red emissive sphere
 *     pulses around the player ship on damage.
 *
 * Babylon coordinate system: default left-handed. Forward = +Z, up = +Y.
 */
export class Game {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly glowLayer: GlowLayer;
  private readonly input: InputManager;
  private readonly arena: Arena;
  private readonly playerLasers: LaserSystem;
  private readonly enemyLasers: LaserSystem;
  private readonly playerMissiles: MissileSystem;
  private readonly explosions: ExplosionSystem;
  private readonly sound: SoundSystem;
  private readonly cameraRig: CameraRig;
  private readonly starfield: Starfield;
  private readonly backdrop: Backdrop;
  private readonly hud: Hud;

  private player: PlayerShip | null = null;
  private engineGlow: EngineGlow | null = null;
  private secondaryThrusters: SecondaryThrusters | null = null;
  private playerDamageFlash: DamageFlash | null = null;
  private readonly enemies: EnemyShip[] = [];
  private started = false;
  private readonly enemyLaserSpawnPos = new Vector3();
  private launchSequence: LaunchSequence | null = null;
  private playerMothership: Mothership | null = null;

  private playerExplosionFired = false;

  /**
   * Wall-clock timestamp until which the simulation is paused. While
   * `nowMs < hitstopUntilMs`, the tick function skips simulation but
   * still updates the camera (so shake animates) and renders.
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
    const hemi = new HemisphericLight(
      "hemi",
      new Vector3(0, 1, 0),
      this.scene,
    );
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

    // --- Subsystems ---
    this.input = new InputManager();
    this.input.attach();
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code === "KeyM") {
        this.sound.toggleMute();
        this.hud.setMuted(this.sound.isMuted);
      }
    });

    this.arena = new Arena(this.scene);
    this.backdrop = new Backdrop(this.scene);
    new Nebulas(this.scene, this.arena.halfWidth, this.arena.halfDepth);
    new CapitalShips(
      this.scene,
      this.arena.halfWidth,
      this.arena.halfDepth,
      this.glowLayer,
    );

    // Two BSG-style motherships — player's at the south end, enemy's at north.
    // Built in the constructor so they appear immediately (before asset load).
    const ms = GameConfig.mothership;
    this.playerMothership = new Mothership(
      this.scene,
      this.glowLayer,
      new Vector3(0, ms.yLevel, ms.playerZ),
      0,        // bow faces +Z (into the arena)
      "player",
    );
    new Mothership(
      this.scene,
      this.glowLayer,
      new Vector3(0, ms.yLevel, ms.enemyZ),
      Math.PI,  // bow faces -Z (toward the player)
      "enemy",
    );

    this.sound = new SoundSystem(this.scene);

    // Laser systems. Each onHit callback fires SFX + adds camera trauma
    // + queues hitstop. The player-hit case ALSO triggers the player's
    // red damage flash (wired in start() once the flash exists).
    this.playerLasers = new LaserSystem(this.scene, {
      damage: GameConfig.combat.laserDamage,
      emissive: new Color3(2.0, 0.6, 0.9), // hot pink
      materialName: "player_laser_mat",
      onHit: () => {
        this.sound.playHit();
        this.cameraRig.addTrauma(GameConfig.shake.traumaEnemyLaserHit);
        this.applyHitstop(GameConfig.hitstop.enemyLaserHitMs);
      },
    });
    this.enemyLasers = new LaserSystem(this.scene, {
      damage: GameConfig.combat.laserDamage,
      emissive: new Color3(0.3, 2.0, 0.6), // electric green
      materialName: "enemy_laser_mat",
      onHit: () => {
        this.sound.playHit();
        this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerLaserHit);
        this.applyHitstop(GameConfig.hitstop.playerLaserHitMs);
        this.playerDamageFlash?.trigger();
      },
    });

    // Player heat-seeking missiles. Heavier hit than a laser: pops an
    // explosion at the impact point plus bigger trauma/hitstop.
    this.playerMissiles = new MissileSystem(this.scene, {
      minDamage: GameConfig.missile.minDamage,
      maxDamage: GameConfig.missile.maxDamage,
      bodyColor: new Color3(0.62, 0.66, 0.7), // gray hull
      finColor: new Color3(0.78, 0.16, 0.16), // red fins
      trailEmissive: new Color3(2.2, 0.7, 0.1), // orange exhaust
      materialName: "player_missile_mat",
      onHit: (pos) => {
        this.explosions.spawn(pos);
        this.sound.playExplosion();
        this.cameraRig.addTrauma(GameConfig.shake.traumaMissileHit);
        this.applyHitstop(GameConfig.hitstop.missileHitMs);
      },
    });

    this.explosions = new ExplosionSystem(this.scene, this.glowLayer);

    for (let i = 0; i < GameConfig.enemy.count; i++) {
      this.enemies.push(new EnemyShip(this.scene, this.glowLayer));
    }

    this.cameraRig = new CameraRig(this.scene);
    // Starfield is camera-locked (wraps around the view), so it needs the
    // camera, not the arena size — its cost is independent of arena size.
    this.starfield = new Starfield(this.scene, this.cameraRig.camera);
    this.hud = new Hud(hudRoot);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const loader = new AssetLoader(this.scene);
    const loaded = await loader.loadPlayerShip();
    this.player = new PlayerShip(loaded.root);
    this.engineGlow = new EngineGlow(this.scene, loaded.root, this.glowLayer);
    this.secondaryThrusters = new SecondaryThrusters(this.scene, loaded.root, this.glowLayer);
    this.playerDamageFlash = new DamageFlash(
      this.scene,
      loaded.root,
      this.glowLayer,
    );
    this.hud.setModelLabel(loaded.usingFallback ? "fallback" : "fighter.glb");

    for (const enemy of this.enemies) {
      this.playerLasers.addTarget(enemy);
      this.playerMissiles.addTarget(enemy);
    }
    this.enemyLasers.setTarget(this.player);

    // Place the player inside the starboard launch tube.
    if (this.playerMothership) {
      const launchStart = this.playerMothership.getLaunchStartPosition();
      this.player.respawn(launchStart.x, launchStart.z, 0); // rotationY=0 → faces +Z
      this.launchSequence = new LaunchSequence(this.playerMothership.getLaunchExitZ());
    }

    for (const enemy of this.enemies) {
      const spawn = EnemyShip.randomSpawnPosition(
        this.arena.halfWidth,
        this.arena.halfDepth,
        this.player.position,
      );
      enemy.respawn(spawn.x, spawn.z);
    }

    this.engine.runRenderLoop(this.tick);
  }

  /**
   * Extend the hitstop window. Multiple stacked impacts in one frame
   * don't compound past `maxStackedMs` — keeps long chains from freezing
   * the action for too long.
   */
  private applyHitstop(durationMs: number): void {
    const nowMs = performance.now();
    const desiredEnd = nowMs + durationMs;
    const maxEnd = nowMs + GameConfig.hitstop.maxStackedMs;
    this.hitstopUntilMs = Math.min(
      maxEnd,
      Math.max(this.hitstopUntilMs, desiredEnd),
    );
  }

  /**
   * Returns the enemy a missile would lock onto right now, or null if no lock
   * is available: the nearest live enemy that is both within lockRange and
   * inside the frontal lock cone (same idea as the enemy's own fire cone).
   * Used both to choose a launched missile's homing target and to drive the
   * HUD lock indicator, so it's computed once per tick.
   */
  private computeLockTarget(): EnemyShip | null {
    if (!this.player || !this.player.isAlive) return null;
    const cfg = GameConfig.missile;
    const px = this.player.position.x;
    const pz = this.player.position.z;

    let best: EnemyShip | null = null;
    let bestDist = Infinity;
    for (const enemy of this.enemies) {
      if (!enemy.isAlive) continue;
      const dx = enemy.position.x - px;
      const dz = enemy.position.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.lockRange || dist >= bestDist) continue;
      const angleToEnemy = Math.atan2(dx, dz);
      if (Math.abs(wrapAngle(angleToEnemy - this.player.rotationY)) > cfg.lockConeAngle) {
        continue;
      }
      best = enemy;
      bestDist = dist;
    }
    return best;
  }

  private readonly tick = (): void => {
    try {
      const deltaMsRaw = this.engine.getDeltaTime();
      const deltaSeconds = Math.min(
        deltaMsRaw / 1000,
        GameConfig.scene.maxDeltaSeconds,
      );
      const deltaMs = deltaSeconds * 1000;
      const nowMs = performance.now();
      const inHitstop = nowMs < this.hitstopUntilMs;

      this.input.update();

      const anyInputHeld =
        this.input.state.thrust ||
        this.input.state.reverse ||
        this.input.state.rotateLeft ||
        this.input.state.rotateRight ||
        this.input.state.fire;
      if (anyInputHeld) this.sound.unlock();

      // Lock target for this frame — drives both the missile launch (below)
      // and the HUD lock indicator, so compute it once.
      const lockTarget = this.computeLockTarget();

      // --- Simulation (skipped during hitstop) ---
      if (!inHitstop) {
        // Player movement / firing
        if (this.player) {
          const inLaunch = this.launchSequence !== null && !this.launchSequence.isComplete;

          if (inLaunch) {
            // Drive the ship automatically; suppress all player input.
            this.launchSequence!.update(deltaSeconds, this.player);

            // Camera trauma burst at the catapult-fire moment.
            if (this.launchSequence!.justLaunched) {
              this.cameraRig.addTrauma(GameConfig.launch.launchTrauma);
            }

            // Sequence just completed this frame — discard it.
            if (this.launchSequence!.isComplete) {
              this.launchSequence = null;
            }
          } else {
            // Normal player control.
            this.player.update(
              deltaSeconds,
              this.input.state,
              this.arena.halfWidth,
              this.arena.halfDepth,
            );

            if (this.player.isAlive && this.input.state.fire) {
              const spawnPositions = this.player.tryFire();
              for (const pos of spawnPositions) {
                this.playerLasers.spawn(pos, this.player.rotationY);
              }
              if (spawnPositions.length > 0) {
                this.sound.playPlayerGuns();
              }
            }

            // Missile launch. Always fires when ammo/cooldown allow; homes onto
            // the locked enemy if there is one, otherwise flies ballistic (null).
            if (this.player.isAlive && this.input.state.fireMissile) {
              const missilePos = this.player.tryFireMissile();
              if (missilePos) {
                this.playerMissiles.spawn(
                  missilePos,
                  this.player.rotationY,
                  lockTarget,
                );
                this.sound.playMissileLaunch();
              }
            }
          }

          // Player death FX + respawn (runs regardless of launch state).
          if (!this.player.isAlive && !this.playerExplosionFired) {
            this.explosions.spawn(this.player.position);
            this.sound.playExplosion();
            this.cameraRig.addTrauma(GameConfig.shake.traumaPlayerExplosion);
            this.applyHitstop(GameConfig.hitstop.playerExplosionMs);
            this.playerExplosionFired = true;
          }
          if (this.player.shouldRespawn(nowMs)) {
            this.player.respawn(0, 0, 0);
            this.playerExplosionFired = false;
          }
        }

        // Enemy AI / firing — each enemy ticks independently.
        if (this.player) {
          for (const enemy of this.enemies) {
            const ai = enemy.update(
              deltaSeconds,
              deltaMs,
              this.player,
              this.arena.halfWidth,
              this.arena.halfDepth,
            );
            if (ai.wantsFire) {
              this.enemyLasers.spawn(
                enemy.getLaserSpawnPosition(this.enemyLaserSpawnPos),
                enemy.rotationY,
              );
              this.sound.playEnemyLaser();
            }

            if (!enemy.isAlive && !enemy.explosionFired) {
              this.explosions.spawn(enemy.position);
              this.sound.playExplosion();
              this.cameraRig.addTrauma(GameConfig.shake.traumaEnemyExplosion);
              this.applyHitstop(GameConfig.hitstop.enemyExplosionMs);
              enemy.explosionFired = true;
            }
            if (enemy.shouldRespawn(nowMs)) {
              const spawn = EnemyShip.randomSpawnPosition(
                this.arena.halfWidth,
                this.arena.halfDepth,
                this.player.position,
              );
              enemy.respawn(spawn.x, spawn.z);
            }
          }
        }

        this.playerLasers.update(deltaSeconds, deltaMs);
        this.enemyLasers.update(deltaSeconds, deltaMs);
        this.playerMissiles.update(deltaSeconds, deltaMs);
        this.explosions.update(deltaSeconds, deltaMs);
      }

      // --- Animations that continue THROUGH hitstop ---
      // Camera shake, damage flash, and rendering all keep running so the
      // freeze-frame still feels alive.
      if (this.player && this.player.isAlive) {
        // During the launch sequence, override zoom: wide (maxZoom) during
        // intro to show the full mothership, then smoothly zoom in to normal
        // framing as the 3-2-1 countdown plays. Once the sequence is null the
        // player's +/- keys drive zoom normally.
        if (this.launchSequence) {
          this.cameraRig.setZoom(this.launchSequence.desiredZoom);
        }
        const zoomInput =
          (this.input.state.zoomIn ? 1 : 0) -
          (this.input.state.zoomOut ? 1 : 0);
        this.cameraRig.update(
          deltaSeconds,
          this.player.position,
          this.player.velocity,
          zoomInput,
        );
        // Re-anchor the wrapping starfield on the (now-updated) camera focus,
        // and drift the deep-space backdrop a hair against that same focus.
        this.starfield.update();
        this.backdrop.update(this.cameraRig.camera.getTarget());
        if (!inHitstop) {
          // Engine glow tracks per-frame thrust input — pausing during
          // hitstop avoids the brief frozen "stuck in mid-burn" look.
          // Force glow on during the catapult launch phase.
          const thrustActive =
            this.input.state.thrust ||
            (this.launchSequence?.isLaunching ?? false);
          this.engineGlow?.update(
            deltaSeconds,
            this.player.speed,
            GameConfig.player.maxSpeed,
            thrustActive,
          );
          // Secondary (RCS) thruster vapour — pass false for all axes when
          // the player is dead so the nozzle glows fade out gracefully.
          const alive = this.player?.isAlive ?? false;
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
        this.player && this.player.isAlive
          ? (this.engineGlow?.currentIntensity ?? 0)
          : 0;
      this.sound.updateEngine(deltaSeconds, engineIntensity);

      if (this.player) {
        this.hud.update(
          this.player,
          this.playerLasers,
          nowMs,
          lockTarget !== null,
          this.cameraRig.currentZoom,
        );
        this.hud.setLaunchOverlay(this.launchSequence?.overlayText ?? null);
      }

      this.scene.render();
    } catch (err) {
      console.error("[Game] render loop frame failed", err);
    }
  };

  handleResize(): void {
    this.engine.resize();
  }
}
