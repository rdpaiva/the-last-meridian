import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { GameConfig } from "@space-duel/shared";

/** Which end of the jump this ghost plays: "out" = departure, "in" = arrival. */
export type JumpGhostMode = "out" | "in";

/**
 * One spectral hull snapshot at a jump end (docs/JUMP-DRIVE-AND-RESUPPLY.md →
 * jump FX): a frozen clone of the ship's meshes wearing a single additive
 * ghost material. Departure ("out") starts solid in the ship's last pose,
 * stretches into a light streak along its heading, and dissolves; arrival
 * ("in") plays the reverse — a streak condenses onto the materialized ship.
 *
 * Pure lifecycle, same entity shape as JumpFlash/LightningBolt —
 * JumpGhostSystem builds the clone + material and owns spawning/disposal.
 */
export class JumpGhost {
  ageMs = 0;

  /** Spawn pose, captured so update() can restate position/scale from t. */
  private readonly baseX: number;
  private readonly baseZ: number;
  private readonly baseScaleX: number;
  private readonly baseScaleY: number;
  private readonly baseScaleZ: number;
  /** World-space heading the streak smears along (forward = +Z at 0). */
  private readonly sinHeading: number;
  private readonly cosHeading: number;

  constructor(
    private readonly root: TransformNode,
    private readonly material: StandardMaterial,
    private readonly mode: JumpGhostMode,
  ) {
    this.baseX = root.position.x;
    this.baseZ = root.position.z;
    this.baseScaleX = root.scaling.x;
    this.baseScaleY = root.scaling.y;
    this.baseScaleZ = root.scaling.z;
    this.sinHeading = Math.sin(root.rotation.y);
    this.cosHeading = Math.cos(root.rotation.y);
  }

  update(deltaMs: number): void {
    this.ageMs += deltaMs;
    if (this.isExpired) return;
    const g = GameConfig.jumpFx.ghost;
    const t = this.ageMs / g.durationMs; // 0..1

    let stretch: number;
    let slide: number;
    let alpha: number;
    if (this.mode === "out") {
      // Accelerate into the smear: hold near the hull shape, then whip the
      // nose forward. Solid at the instant of departure, dissolving as it goes.
      const ease = t * t;
      stretch = 1 + (g.stretch - 1) * ease;
      slide = g.slide * ease;
      alpha = g.peakAlpha * Math.pow(1 - t, 1.5);
    } else {
      // Reverse: the streak decelerates in from astern and settles onto the
      // (already rendered) real ship while it dissolves.
      const ease = (1 - t) * (1 - t);
      stretch = 1 + (g.stretch - 1) * ease;
      slide = -g.slide * ease;
      alpha = g.peakAlpha * (1 - t);
    }

    // Stretch is along the root's LOCAL +Z (the hull's long axis — node scale
    // applies before its yaw), so the smear always follows the ship's facing.
    this.root.scaling.set(
      this.baseScaleX,
      this.baseScaleY,
      this.baseScaleZ * stretch,
    );
    this.root.position.x = this.baseX + this.sinHeading * slide;
    this.root.position.z = this.baseZ + this.cosHeading * slide;
    this.material.alpha = alpha;
  }

  get isExpired(): boolean {
    return this.ageMs >= GameConfig.jumpFx.ghost.durationMs;
  }

  dispose(): void {
    this.material.dispose();
    this.root.dispose(false, false);
  }
}
