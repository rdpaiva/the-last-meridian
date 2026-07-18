import type { Scene } from "@babylonjs/core/scene";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
// Particle scene-component registration — adds particle rendering to the
// render loop and `engine.createEffectForParticles`. Only the barrel index
// pulls it in; without this side-effect import a tree-shaken build constructs
// particle systems that silently never draw.
import "@babylonjs/core/Particles/particleSystemComponent";

import { GameConfig } from "@space-duel/shared";

/** One color ramp stop as authored in GameConfig.burnFx.*.ramp. */
type RampStop = { t: number; r: number; g: number; b: number; a: number };

/**
 * A persistent FIRE at one burn site (a destroyed hangar bay, a dead carrier
 * turret): three looping particle systems sharing the procedural flare sprite
 * (FlareTexture.ts) —
 *   flame  — additive licks, white-hot → yellow → orange → deep red over each
 *            particle's life, growing then guttering (the "realistic flame").
 *   sparks — fast stretched-billboard slivers flung outward, streaked along
 *            their velocity (the "electrical sparks").
 *   smoke  — slow dark alpha-blended puffs rising over the flame.
 *
 * All tuning lives in GameConfig.burnFx; carrier-scale numbers, multiplied by
 * the constructor `scale` for smaller sites (turrets). Created via
 * ExplosionSystem.createBurnFX (which owns the shared flare texture).
 *
 * Lifecycle: start(position) ignites (idempotent while running), stop() cuts
 * emission and lets live particles finish naturally, dispose() tears down.
 * Particles tick with scene.render(), so like camera shake they keep animating
 * through hitstop — consistent with the deliberate hitstop asymmetry.
 */
export class BurnFX {
  private readonly flame: ParticleSystem;
  private readonly sparks: ParticleSystem;
  private readonly smoke: ParticleSystem;
  /** Shared emitter anchor — all three systems emit from this point. */
  private readonly emitterPos = new Vector3();
  private running = false;

  constructor(scene: Scene, flare: DynamicTexture, scale = 1) {
    const cfg = GameConfig.burnFx;
    const spread = cfg.emitRadius * scale;

    // ── Flame core ──────────────────────────────────────────────────────
    const f = cfg.flame;
    this.flame = new ParticleSystem("burn_flame", f.capacity, scene);
    this.flame.particleTexture = flare;
    this.flame.blendMode = ParticleSystem.BLENDMODE_ADD;
    this.flame.emitter = this.emitterPos;
    this.flame.minEmitBox = new Vector3(-spread, 0, -spread);
    this.flame.maxEmitBox = new Vector3(spread, 0.5 * scale, spread);
    // Mostly-up drift with lateral wobble so licks curl instead of columning.
    this.flame.direction1 = new Vector3(-0.35, 1, -0.35);
    this.flame.direction2 = new Vector3(0.35, 1, 0.35);
    this.flame.minEmitPower = f.powerMin * scale;
    this.flame.maxEmitPower = f.powerMax * scale;
    this.flame.minLifeTime = f.lifeSecMin;
    this.flame.maxLifeTime = f.lifeSecMax;
    this.flame.emitRate = f.emitRate;
    // Size gradients are ABSOLUTE particle sizes (they override min/maxSize);
    // the (factor, factor2) pair keeps per-particle variance at each stop.
    // Shape: swell through the first third, gutter to embers at the end.
    this.flame.addSizeGradient(0, f.sizeMin * 0.4 * scale, f.sizeMax * 0.4 * scale);
    this.flame.addSizeGradient(0.35, f.sizeMin * scale, f.sizeMax * scale);
    this.flame.addSizeGradient(1, f.sizeMin * 0.25 * scale, f.sizeMax * 0.35 * scale);
    BurnFX.applyRamp(this.flame, f.ramp);
    this.flame.preWarmCycles = cfg.preWarmCycles;

    // ── Spark streaks ───────────────────────────────────────────────────
    const s = cfg.sparks;
    this.sparks = new ParticleSystem("burn_sparks", s.capacity, scene);
    this.sparks.particleTexture = flare;
    this.sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
    // Stretched billboards elongate each particle along its velocity — a hot
    // soft dot becomes an arc-like streak, speed-scaled.
    this.sparks.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    this.sparks.emitter = this.emitterPos;
    const core = 0.6 * scale;
    this.sparks.minEmitBox = new Vector3(-core, 0, -core);
    this.sparks.maxEmitBox = new Vector3(core, 0.4 * scale, core);
    // Radial spray with a slight upward bias — sparks jump OUT of the fire.
    this.sparks.direction1 = new Vector3(-1, 0.15, -1);
    this.sparks.direction2 = new Vector3(1, 0.7, 1);
    this.sparks.minEmitPower = s.powerMin * scale;
    this.sparks.maxEmitPower = s.powerMax * scale;
    this.sparks.minLifeTime = s.lifeSecMin;
    this.sparks.maxLifeTime = s.lifeSecMax;
    this.sparks.minSize = s.sizeMin * scale;
    this.sparks.maxSize = s.sizeMax * scale;
    // Shape the quad into a filament: scale.x is the width ACROSS the
    // velocity, scale.y the length ALONG it (Babylon's stretched-billboard
    // axes) — without this each spark is a full-width square smeared along
    // its path, reading as a thick line.
    this.sparks.minScaleX = s.widthScale;
    this.sparks.maxScaleX = s.widthScale;
    this.sparks.minScaleY = s.lengthScale * 0.7;
    this.sparks.maxScaleY = s.lengthScale * 1.3;
    this.sparks.emitRate = s.emitRate;
    BurnFX.applyRamp(this.sparks, s.ramp);
    this.sparks.preWarmCycles = cfg.preWarmCycles;

    // ── Smoke ───────────────────────────────────────────────────────────
    const m = cfg.smoke;
    this.smoke = new ParticleSystem("burn_smoke", m.capacity, scene);
    this.smoke.particleTexture = flare;
    this.smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    this.smoke.emitter = this.emitterPos;
    this.smoke.minEmitBox = new Vector3(-spread * 0.7, 0.5 * scale, -spread * 0.7);
    this.smoke.maxEmitBox = new Vector3(spread * 0.7, 1.5 * scale, spread * 0.7);
    this.smoke.direction1 = new Vector3(-0.2, 1, -0.2);
    this.smoke.direction2 = new Vector3(0.2, 1, 0.2);
    this.smoke.minEmitPower = m.powerMin * scale;
    this.smoke.maxEmitPower = m.powerMax * scale;
    this.smoke.minLifeTime = m.lifeSecMin;
    this.smoke.maxLifeTime = m.lifeSecMax;
    this.smoke.emitRate = m.emitRate;
    // Puffs keep growing across their whole life (smoke expands as it cools).
    this.smoke.addSizeGradient(0, m.sizeMin * 0.5 * scale, m.sizeMax * 0.5 * scale);
    this.smoke.addSizeGradient(1, m.sizeMin * scale, m.sizeMax * scale);
    // Lazy tumble so the shared radial sprite doesn't read as a static disc.
    this.smoke.minAngularSpeed = -0.6;
    this.smoke.maxAngularSpeed = 0.6;
    BurnFX.applyRamp(this.smoke, m.ramp);
    this.smoke.preWarmCycles = cfg.preWarmCycles;
  }

  private static applyRamp(
    ps: ParticleSystem,
    ramp: ReadonlyArray<RampStop>,
  ): void {
    for (const stop of ramp) {
      ps.addColorGradient(stop.t, new Color4(stop.r, stop.g, stop.b, stop.a));
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Ignite (or re-ignite) the burn at a world position. Idempotent. */
  start(position: Vector3): void {
    this.emitterPos.copyFrom(position);
    if (this.running) return;
    this.running = true;
    this.flame.start();
    this.sparks.start();
    this.smoke.start();
  }

  /** Cut emission; already-live particles burn out naturally. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.flame.stop();
    this.sparks.stop();
    this.smoke.stop();
  }

  dispose(): void {
    // dispose(false): the flare texture is SHARED (owned by ExplosionSystem);
    // the default dispose(true) would yank it out from under every other FX.
    this.flame.dispose(false);
    this.sparks.dispose(false);
    this.smoke.dispose(false);
  }
}
