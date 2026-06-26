import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import type { ShipPose } from "@space-duel/shared";

/**
 * The Babylon depiction of one ship — the view half of the Ship/ShipView
 * split (docs/MULTIPLAYER.md, Phase 0). Owns the ship's scene root (the
 * loaded GLB clone or procedural mesh hierarchy) and, once per frame, copies
 * a ShipPose into it: position, heading, bank roll, enabled state.
 *
 * It reads the POSE INTERFACE, not the Ship class — today Game feeds it the
 * local sim's ships; in Phase 2 a network snapshot interpolation buffer
 * feeds remote ships through the exact same seam.
 *
 * Client-only player extras (EngineGlow, SecondaryThrusters, DamageFlash)
 * attach to `root` exactly as they did when Ship owned it.
 */
export class ShipView {
  constructor(readonly root: TransformNode) {}

  /** Copy the pose into the scene node. Call once per frame, before render. */
  update(pose: ShipPose): void {
    this.root.position.x = pose.position.x;
    this.root.position.y = pose.position.y;
    this.root.position.z = pose.position.z;
    this.root.rotation.y = pose.rotationY;
    this.root.rotation.z = -pose.bankAngle;
    // setEnabled only on change: Babylon walks descendants on every call.
    if (this.root.isEnabled(false) !== pose.isAlive) {
      this.root.setEnabled(pose.isAlive);
    }
  }

  /** Tear down the scene nodes (match end / ship removal). */
  dispose(): void {
    this.root.dispose(false, false);
  }
}
