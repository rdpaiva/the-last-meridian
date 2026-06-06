import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { GameConfig } from "./GameConfig";
import { clamp, exponentialMultiplier, wrapAngle } from "./math";
import type { DamageTarget } from "./types";
import type { PlayerShip } from "./PlayerShip";

/**
 * Enemy fighter with a simple wander/engage AI.
 *
 * Behavior:
 *   - When the player is outside engagementRange (or dead), wander: pick a
 *     target heading periodically, jittered toward arena center.
 *   - When the player is inside engagementRange, steer to face the player.
 *   - When the player is inside fireRange AND inside the fire cone, fire
 *     on cooldown.
 *
 * Mesh is always procedural — no GLB slot for the enemy. Crimson body,
 * dark-red wings, hot-red emissive engine, single red "eye" at the nose
 * for menace. Engine and eye participate in the GlowLayer.
 *
 * Implements DamageTarget so player lasers can find it via setTarget().
 */
export class EnemyShip implements DamageTarget {
  readonly root: TransformNode;
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  rotationY = 0;

  hp: number = GameConfig.combat.enemyMaxHp;
  readonly maxHp: number = GameConfig.combat.enemyMaxHp;
  readonly hitRadius: number = GameConfig.combat.shipHitRadius;

  private deathTimeMs: number | null = null;
  private fireCooldownMs = 0;

  /**
   * Set by Game once it has fired the death explosion/FX for this ship, so
   * the per-frame death check doesn't re-fire every frame until respawn.
   * Lives here (rather than in a parallel array) so each enemy carries its
   * own flag. Reset in respawn().
   */
  explosionFired = false;
  private wanderTargetHeading = 0;
  private wanderTimerSec = 0;
  private readonly forwardScratch = new Vector3();

  constructor(scene: Scene, glowLayer: GlowLayer) {
    this.root = this.buildMesh(scene, glowLayer);
  }

  // ---------- DamageTarget ----------

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number): void {
    if (!this.isAlive) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.die();
    }
  }

  private die(): void {
    this.deathTimeMs = performance.now();
    this.root.setEnabled(false);
    this.velocity.set(0, 0, 0);
  }

  shouldRespawn(nowMs: number): boolean {
    return (
      this.deathTimeMs !== null &&
      nowMs - this.deathTimeMs >= GameConfig.combat.enemyRespawnDelayMs
    );
  }

  /**
   * Reset HP, place at the given pose, re-enable the mesh, and re-seed the
   * wander state so the enemy doesn't immediately fly toward where it just
   * died.
   */
  respawn(x: number, z: number, rotationY = Math.random() * Math.PI * 2): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.rotationY = rotationY;
    this.hp = this.maxHp;
    this.deathTimeMs = null;
    this.explosionFired = false;
    this.fireCooldownMs = 0;
    this.wanderTargetHeading = rotationY;
    this.wanderTimerSec = 0;
    this.root.position.copyFrom(this.position);
    this.root.rotation.y = this.rotationY;
    this.root.setEnabled(true);
  }

  // ---------- AI ----------

  /**
   * Tick the enemy. Returns whether it wants to fire this frame — Game.ts
   * uses this to call `enemyLasers.spawn()` at the right moment.
   */
  update(
    dt: number,
    dtMs: number,
    player: PlayerShip,
    arenaHalfX: number,
    arenaHalfZ: number,
  ): { wantsFire: boolean } {
    if (!this.isAlive) return { wantsFire: false };

    const cfg = GameConfig.enemy;

    // Vector from enemy to player on the X/Z plane.
    const dx = player.position.x - this.position.x;
    const dz = player.position.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    const angleToPlayer = Math.atan2(dx, dz); // matches our forward convention

    // Decide target heading: engage if player is alive and close, else wander.
    let targetHeading: number;
    if (player.isAlive && dist < cfg.engagementRange) {
      targetHeading = angleToPlayer;
    } else {
      this.wanderTimerSec -= dt;
      if (this.wanderTimerSec <= 0) {
        this.retargetWander(arenaHalfX, arenaHalfZ);
      }
      targetHeading = this.wanderTargetHeading;
    }

    // Steer rotationY toward targetHeading at rotationSpeed.
    const headingDiff = wrapAngle(targetHeading - this.rotationY);
    const turnStep =
      Math.sign(headingDiff) *
      Math.min(Math.abs(headingDiff), cfg.rotationSpeed * dt);
    this.rotationY += turnStep;

    // Thrust forward, with drag and speed cap (mirrors PlayerShip).
    const fwd = this.forward();
    this.velocity.x += fwd.x * cfg.thrust * dt;
    this.velocity.z += fwd.z * cfg.thrust * dt;

    const dragFactor = exponentialMultiplier(cfg.dragRate, dt);
    this.velocity.x *= dragFactor;
    this.velocity.z *= dragFactor;

    const speedSq =
      this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    const maxSpeedSq = cfg.maxSpeed * cfg.maxSpeed;
    if (speedSq > maxSpeedSq) {
      const scale = cfg.maxSpeed / Math.sqrt(speedSq);
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.x = clamp(this.position.x, -arenaHalfX, arenaHalfX);
    this.position.z = clamp(this.position.z, -arenaHalfZ, arenaHalfZ);

    this.root.position.copyFrom(this.position);
    this.root.rotation.y = this.rotationY;

    // Fire check.
    if (this.fireCooldownMs > 0) this.fireCooldownMs -= dtMs;
    let wantsFire = false;
    if (
      player.isAlive &&
      dist < cfg.fireRange &&
      Math.abs(wrapAngle(angleToPlayer - this.rotationY)) < cfg.fireConeAngle &&
      this.fireCooldownMs <= 0
    ) {
      this.fireCooldownMs = cfg.fireCooldownMs;
      wantsFire = true;
    }

    return { wantsFire };
  }

  /** Picks a new wander target heading with center bias plus jitter. */
  private retargetWander(arenaHalfX: number, arenaHalfZ: number): void {
    const cfg = GameConfig.enemy;
    const angleToCenter = Math.atan2(-this.position.x, -this.position.z);
    const distFromCenter = Math.hypot(this.position.x, this.position.z);
    const arenaRadius = Math.min(arenaHalfX, arenaHalfZ);
    const centerPull =
      clamp(distFromCenter / arenaRadius, 0, 1) * cfg.centerBias;

    const jitter = (Math.random() * 2 - 1) * cfg.wanderJitter;
    const naiveTarget = this.rotationY + jitter;
    this.wanderTargetHeading = wrapAngle(
      naiveTarget * (1 - centerPull) + angleToCenter * centerPull,
    );

    // Random interval so the wander doesn't pulse like a metronome.
    this.wanderTimerSec = cfg.wanderRetargetSec * (0.6 + Math.random() * 0.8);
  }

  forward(): Vector3 {
    this.forwardScratch.x = Math.sin(this.rotationY);
    this.forwardScratch.y = 0;
    this.forwardScratch.z = Math.cos(this.rotationY);
    return this.forwardScratch;
  }

  /** Writes the laser spawn world-position into `out` and returns it. */
  getLaserSpawnPosition(out: Vector3): Vector3 {
    const fwd = this.forward();
    const off = GameConfig.laser.spawnOffset;
    out.x = this.position.x + fwd.x * off;
    out.y = this.position.y;
    out.z = this.position.z + fwd.z * off;
    return out;
  }

  // ---------- Mesh construction ----------

  private buildMesh(scene: Scene, glowLayer: GlowLayer): TransformNode {
    const root = new TransformNode("enemyShipRoot", scene);

    // Body — cone, tip along local +Z (rotate +π/2 around X, same trick as
    // the player fallback in AssetLoader).
    const body = MeshBuilder.CreateCylinder(
      "enemy_body",
      { height: 1.6, diameterTop: 0, diameterBottom: 0.7, tessellation: 12 },
      scene,
    );
    body.rotation.x = Math.PI / 2;
    body.parent = root;

    const bodyMat = new StandardMaterial("enemy_body_mat", scene);
    bodyMat.diffuseColor = new Color3(0.5, 0.12, 0.14);
    bodyMat.specularColor = new Color3(0.2, 0.1, 0.1);
    body.material = bodyMat;

    // Wings — same dimensions as player but darker red.
    const wingSpec = { width: 0.7, height: 0.08, depth: 0.6 };
    const wingL = MeshBuilder.CreateBox("enemy_wingL", wingSpec, scene);
    wingL.position = new Vector3(-0.55, 0, -0.1);
    wingL.parent = root;

    const wingR = MeshBuilder.CreateBox("enemy_wingR", wingSpec, scene);
    wingR.position = new Vector3(0.55, 0, -0.1);
    wingR.parent = root;

    const wingMat = new StandardMaterial("enemy_wing_mat", scene);
    wingMat.diffuseColor = new Color3(0.35, 0.1, 0.12);
    wingMat.specularColor = new Color3(0.1, 0.05, 0.05);
    wingL.material = wingMat;
    wingR.material = wingMat;

    // Engine — hot-red emissive box at the tail, glow-layer registered.
    const engine = MeshBuilder.CreateBox(
      "enemy_engine",
      { width: 0.4, height: 0.25, depth: 0.35 },
      scene,
    );
    engine.position = new Vector3(0, 0, -0.7);
    engine.parent = root;

    const engineMat = new StandardMaterial("enemy_engine_mat", scene);
    engineMat.diffuseColor = new Color3(0, 0, 0);
    engineMat.specularColor = new Color3(0, 0, 0);
    engineMat.emissiveColor = new Color3(1.6, 0.25, 0.15);
    engineMat.disableLighting = true;
    engine.material = engineMat;
    glowLayer.addIncludedOnlyMesh(engine);

    // "Eye" — small emissive sphere at the nose. Pure visual menace.
    const eye = MeshBuilder.CreateSphere(
      "enemy_eye",
      { diameter: 0.2, segments: 6 },
      scene,
    );
    eye.position = new Vector3(0, 0, 0.85);
    eye.parent = root;
    const eyeMat = new StandardMaterial("enemy_eye_mat", scene);
    eyeMat.diffuseColor = new Color3(0, 0, 0);
    eyeMat.specularColor = new Color3(0, 0, 0);
    eyeMat.emissiveColor = new Color3(1.8, 0.3, 0.2);
    eyeMat.disableLighting = true;
    eye.material = eyeMat;
    glowLayer.addIncludedOnlyMesh(eye);

    return root;
  }

  // ---------- Spawn placement helper ----------

  /**
   * Picks a random arena position at least `minDistFromPlayer` from the
   * player. Returns { x, z } in world coordinates.
   */
  static randomSpawnPosition(
    arenaHalfX: number,
    arenaHalfZ: number,
    playerPos: Vector3,
    minDistFromPlayer = 28,
  ): { x: number; z: number } {
    for (let i = 0; i < 12; i++) {
      const x = (Math.random() * 2 - 1) * arenaHalfX * 0.85;
      const z = (Math.random() * 2 - 1) * arenaHalfZ * 0.85;
      const dx = x - playerPos.x;
      const dz = z - playerPos.z;
      if (Math.hypot(dx, dz) >= minDistFromPlayer) {
        return { x, z };
      }
    }
    // Fallback: opposite corner from the player.
    return {
      x: -Math.sign(playerPos.x || 1) * arenaHalfX * 0.7,
      z: -Math.sign(playerPos.z || 1) * arenaHalfZ * 0.7,
    };
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }
}
