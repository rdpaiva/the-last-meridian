import type { Mesh } from "@babylonjs/core/Meshes/mesh";

/**
 * One live lightning bolt: a short-lived jagged emissive ribbon inside (or
 * striking out of) a storm cloud. Pure lifecycle — LightningSystem builds the
 * mesh (the jagged geometry) and owns spawning/disposal; this just plays the
 * flash-then-fade and reports expiry. Same entity shape as JumpFlash.
 */
export class LightningBolt {
  ageMs = 0;

  constructor(
    private readonly mesh: Mesh,
    private readonly durationMs: number,
  ) {}

  update(deltaMs: number): void {
    this.ageMs += deltaMs;
    if (this.isExpired) return;
    const t = this.ageMs / this.durationMs; // 0..1
    // Full-bright strike for the first ~30% of life, then a fast fade-out —
    // lightning flashes on instantly and dies, it doesn't ease in.
    const holdUntil = 0.3;
    this.mesh.visibility = t < holdUntil ? 1 : 1 - (t - holdUntil) / (1 - holdUntil);
  }

  get isExpired(): boolean {
    return this.ageMs >= this.durationMs;
  }

  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }
}
