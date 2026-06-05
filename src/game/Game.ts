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
import { CameraRig } from "./CameraRig";
import { Hud } from "./Hud";
import { Starfield } from "./Starfield";
import { EngineGlow } from "./EngineGlow";
import { CapitalShips } from "./CapitalShips";
import { Nebulas } from "./Nebulas";
import { EnemyShip } from "./EnemyShip";
import { ExplosionSystem } from "./ExplosionSystem";
import { SoundSystem } from "./SoundSystem";
import { DamageFlash } from "./DamageFlash";

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
  private readonly explosions: ExplosionSystem;
  private readonly sound: SoundSystem;
  private readonly cameraRig: CameraRig;
  private readonly hud: Hud;

  private player: PlayerShip | null = null;
  private engineGlow: EngineGlow | null = null;
  private playerDamageFlash: DamageFlash | null = null;
  private readonly enemy: EnemyShip;
  private started = false;
  private readonly enemyLaserSpawnPos = new Vector3();

  private playerExplosionFired = false;
  private enemyExplosionFired = false;

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

    this.arena = new Arena(this.scene);
    new Nebulas(this.scene, this.arena.halfWidth, this.arena.halfDepth);
    new Starfield(this.scene, this.arena.halfWidth);
    new CapitalShips(
      this.scene,
      this.arena.halfWidth,
      this.arena.halfDepth,
      this.glowLayer,
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

    this.explosions = new ExplosionSystem(this.scene, this.glowLayer);

    this.enemy = new EnemyShip(this.scene, this.glowLayer);

    this.cameraRig = new CameraRig(this.scene);
    this.hud = new Hud(hudRoot);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const loader = new AssetLoader(this.scene);
    const loaded = await loader.loadPlayerShip();
    this.player = new PlayerShip(loaded.root);
    this.engineGlow = new EngineGlow(this.scene, loaded.root, this.glowLayer);
    this.playerDamageFlash = new DamageFlash(
      this.scene,
      loaded.root,
      this.glowLayer,
    );
    this.hud.setModelLabel(loaded.usingFallback ? "fallback" : "fighter.glb");

    this.playerLasers.setTarget(this.enemy);
    this.enemyLasers.setTarget(this.player);

    const spawn = EnemyShip.randomSpawnPosition(
      this.arena.halfWidth,
      this.arena.halfDepth,
      this.player.position,
    );
    this.enemy.respawn(spawn.x, spawn.z);

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

      // --- Simulation (skipped during hitstop) ---
      if (!inHitstop) {
        // Player movement / firing
        if (this.player) {
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
              this.sound.playPlayerLaser();
            }
          }

          // Player death FX + respawn
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

        // Enemy AI / firing
        if (this.player) {
          const ai = this.enemy.update(
            deltaSeconds,
            deltaMs,
            this.player,
            this.arena.halfWidth,
            this.arena.halfDepth,
          );
          if (ai.wantsFire) {
            this.enemyLasers.spawn(
              this.enemy.getLaserSpawnPosition(this.enemyLaserSpawnPos),
              this.enemy.rotationY,
            );
            this.sound.playEnemyLaser();
          }

          if (!this.enemy.isAlive && !this.enemyExplosionFired) {
            this.explosions.spawn(this.enemy.position);
            this.sound.playExplosion();
            this.cameraRig.addTrauma(GameConfig.shake.traumaEnemyExplosion);
            this.applyHitstop(GameConfig.hitstop.enemyExplosionMs);
            this.enemyExplosionFired = true;
          }
          if (this.enemy.shouldRespawn(nowMs)) {
            const spawn = EnemyShip.randomSpawnPosition(
              this.arena.halfWidth,
              this.arena.halfDepth,
              this.player.position,
            );
            this.enemy.respawn(spawn.x, spawn.z);
            this.enemyExplosionFired = false;
          }
        }

        this.playerLasers.update(deltaSeconds, deltaMs);
        this.enemyLasers.update(deltaSeconds, deltaMs);
        this.explosions.update(deltaSeconds, deltaMs);
      }

      // --- Animations that continue THROUGH hitstop ---
      // Camera shake, damage flash, and rendering all keep running so the
      // freeze-frame still feels alive.
      if (this.player && this.player.isAlive) {
        this.cameraRig.update(
          deltaSeconds,
          this.player.position,
          this.player.velocity,
        );
        if (!inHitstop) {
          // Engine glow tracks per-frame thrust input — pausing during
          // hitstop avoids the brief frozen "stuck in mid-burn" look.
          this.engineGlow?.update(
            deltaSeconds,
            this.player.speed,
            GameConfig.player.maxSpeed,
            this.input.state.thrust,
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
        this.hud.update(this.player, this.playerLasers, nowMs);
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
