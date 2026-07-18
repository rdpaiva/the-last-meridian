import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { GameConfig } from "@space-duel/shared";

/**
 * One shield-impact splash (GameConfig.shieldFx.hitFlash): a translucent
 * faction-tinted sphere at the point a shot landed on a SHIELDED carrier —
 * the "the shield ate most of that" read, layered over the normal spark and
 * visually distinct from it (soft tinted swell vs. hot orange pop). Over its
 * life it swells from startScale to full size while the alpha fades to zero.
 *
 * Owns its mesh + material; ShieldHitFlashSystem creates it in spawn() and
 * disposes it on expiry (spawns are capped there, so per-instance is fine).
 */
export class ShieldHitFlash {
  ageMs = 0;

  constructor(private readonly flash: Mesh) {}

  update(deltaMs: number): void {
    this.ageMs += deltaMs;
    if (this.isExpired) return;
    const fx = GameConfig.shieldFx.hitFlash;
    const t = this.ageMs / fx.durationMs; // 0..1
    const s = fx.startScale + (1 - fx.startScale) * t;
    this.flash.scaling.set(s, s, s);
    if (this.flash.material) {
      this.flash.material.alpha = fx.peakAlpha * (1 - t);
    }
  }

  get isExpired(): boolean {
    return this.ageMs >= GameConfig.shieldFx.hitFlash.durationMs;
  }

  dispose(): void {
    this.flash.material?.dispose();
    this.flash.dispose();
  }
}
