import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { GameConfig } from "@space-duel/shared";

/**
 * The central "pop" of a jump (docs/JUMP-DRIVE-AND-RESUPPLY.md → jump FX): a
 * small cool flash sphere that snaps to a peak then collapses to nothing. The
 * EXPANDING SHOCKWAVE is a separate screen-space ripple (JumpRipple) — this is
 * just the bright core at the jump point, kept modest so it doesn't read as a
 * solid white ball. Plays at both the departure and arrival ends of a jump.
 *
 * Owns its mesh + material (jumps are rare, so per-instance is cheap);
 * JumpFlashSystem creates it in spawn() and disposes it on expiry.
 */
export class JumpFlash {
  ageMs = 0;

  constructor(
    private readonly flash: Mesh,
    private readonly durationMs: number,
  ) {}

  update(deltaMs: number): void {
    this.ageMs += deltaMs;
    if (this.isExpired) return;
    const fx = GameConfig.jumpFx;
    const t = this.ageMs / this.durationMs; // 0..1

    // Snap up to peak in the first ~15%, then collapse to nothing.
    const peakAt = 0.15;
    let s: number;
    if (t < peakAt) {
      s = (t / peakAt) * fx.flashPeakScale;
    } else {
      s = fx.flashPeakScale * Math.max(0, 1 - (t - peakAt) / (1 - peakAt));
    }
    this.flash.scaling.set(s, s, s);
  }

  get isExpired(): boolean {
    return this.ageMs >= this.durationMs;
  }

  dispose(): void {
    this.flash.material?.dispose();
    this.flash.dispose();
  }
}
