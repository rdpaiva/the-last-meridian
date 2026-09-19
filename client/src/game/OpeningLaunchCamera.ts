import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { GameConfig, type Mothership } from "@space-duel/shared";
import type { CameraRig } from "./CameraRig";

export interface OpeningLaunchMember {
  bayIndex: number;
  /** Capture the initial launch, so a later respawn cannot extend the shot. */
  isFinished(): boolean;
}

/** View-only opening roster, shared by solo and replicated multiplayer. */
export class OpeningLaunchCamera {
  private readonly pending: OpeningLaunchMember[];
  private returning = false;

  constructor(
    private readonly rig: CameraRig,
    home: Mothership,
    members: readonly OpeningLaunchMember[],
  ) {
    this.pending = [...members];
    if (members.length === 0) return;
    const cfg = GameConfig.camera.launchShot;
    const forward = home.getLaunchForward();
    const right = new Vector3(forward.z, 0, -forward.x);
    const bays = [...new Set(members.map(m => m.bayIndex))].map(i => home.getLaunchStartPosition(i));
    const first = bays[0];
    let min = 0, max = 0;
    for (const bay of bays) {
      const lateral = (bay.x - first.x) * right.x + (bay.z - first.z) * right.z;
      min = Math.min(min, lateral);
      max = Math.max(max, lateral);
    }
    const target = first.add(right.scale((min + max) / 2));
    target.x += forward.x * cfg.targetForward;
    target.z += forward.z * cfg.targetForward;
    // A normal wing can spill into the other tube. Frame both entrances in
    // that case; a single-bay launch keeps the closer interior showcase.
    const camera = rig.camera;
    const aspect = camera.getScene().getEngine().getAspectRatio(camera);
    const halfWidth = (max - min) / 2 + cfg.bayFrameMargin;
    const distance = Math.max(cfg.forward,
      halfWidth / (Math.tan(camera.fov / 2) * aspect) + cfg.bayMouthForward);
    const scale = distance / cfg.forward;
    const side = (first.x - home.position.x) * right.x + (first.z - home.position.z) * right.z < 0 ? -1 : 1;
    const position = target.add(new Vector3(
      forward.x * distance + right.x * cfg.outboard * scale * side,
      cfg.height * scale,
      forward.z * distance + right.z * cfg.outboard * scale * side,
    ));
    rig.holdLaunchView(position, target, -side);
  }

  get active(): boolean {
    return this.rig.showingLaunch;
  }

  update(): void {
    if (this.returning || !this.active) return;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].isFinished()) this.pending.splice(i, 1);
    }
    if (this.pending.length === 0) {
      this.returning = true;
      this.rig.returnFromLaunch();
    }
  }

  cancel(): void {
    this.pending.length = 0;
    this.rig.cancelLaunchView();
  }
}
