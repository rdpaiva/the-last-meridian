import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { InputState } from "@space-duel/shared";
import { GameConfig } from "@space-duel/shared";

import type { CameraRig } from "./CameraRig";

/**
 * Anything the death-cam can follow. Offline these are thin adapters over the
 * sim Ships (Game builds one per combatant); online the replicated ShadowShip
 * satisfies the shape directly. Position is read LIVE each frame (the fields
 * are getters/references, not snapshots).
 */
export interface SpectateSubject {
  readonly position: Vector3;
  readonly isAlive: boolean;
  /** Pilot label for the HUD "SPECTATING" line. */
  readonly callsign: string;
}

/**
 * Death spectate: while the player is dead, drives the CameraRig from a live
 * ship's position instead of letting the camera freeze on the wreck.
 *
 * Owns target selection only — the OWNING coordinator (Game / NetworkGame)
 * decides WHEN spectating applies (dead + match still playing), builds the
 * per-frame roster of watchable ships, and detects the death/respawn edges:
 *
 *   death edge   → begin(nowMs, deathPosition, killer-if-known)
 *   every frame  → update(dt, nowMs, rig, zoomInput, input, roster)
 *   respawn edge → end(), then rig.snapTo(own ship) for a clean cut back
 *
 * Behavior: linger on the wreck for spectator.deathHoldMs (the explosion
 * beat), then hard-cut (rig.snapTo — reads better than a cross-arena pan) to
 * the killer if they're in the roster, else the nearest live ship. Cycle
 * inputs (rotate keys = prev/next, fire = next) step through the roster; any
 * cycle press during the wreck-hold cuts away early. If the followed ship
 * dies, auto-cut to whoever is nearest to it (spatial continuity); zoom keys
 * pass straight through to the rig throughout.
 *
 * Follow velocity is finite-differenced from the subject's rendered position
 * (subjects don't all expose a sim velocity — online shadows are interpolated
 * poses); the rig's velocity-lead smoothing absorbs the resulting noise.
 */
export class SpectatorCamera {
  private isActive = false;
  private subject: SpectateSubject | null = null;
  /** Preferred first subject (the killer); consumed by the first pick. */
  private preferred: SpectateSubject | null = null;
  /** Wall-clock end of the linger-on-wreck beat. */
  private holdUntilMs = 0;
  private readonly deathPos = new Vector3();
  /** Last followed position — velocity estimate + fallback when nobody is watchable. */
  private readonly lastPos = new Vector3();
  private readonly velocity = new Vector3();
  private readonly zeroVelocity = new Vector3();
  /** False right after a cut so the first frame doesn't difference across it. */
  private hasLast = false;
  // Previous-frame button state for cycle edge detection.
  private prevLeft = false;
  private prevRight = false;
  private prevFire = false;

  get active(): boolean {
    return this.isActive;
  }

  /** Callsign for the HUD line, or null while still lingering on the wreck. */
  get subjectLabel(): string | null {
    return this.isActive && this.subject !== null ? this.subject.callsign : null;
  }

  /** The player died: start the wreck-hold beat at their death position. */
  begin(nowMs: number, deathPosition: Vector3, killer: SpectateSubject | null): void {
    this.isActive = true;
    this.subject = null;
    this.preferred = killer;
    this.holdUntilMs = nowMs + GameConfig.spectator.deathHoldMs;
    this.deathPos.copyFrom(deathPosition);
    this.lastPos.copyFrom(deathPosition);
    this.hasLast = false;
    // Treat everything as already-held so buttons pressed while dying (the
    // fire key, usually) must be released before they read as a cycle.
    this.prevLeft = true;
    this.prevRight = true;
    this.prevFire = true;
  }

  /**
   * Late killer attribution — online the shipDied event (which carries the
   * killer id) rides the FX queue and can land a beat after the alive→dead
   * patch that triggered begin(). No-op once a subject has been picked.
   */
  setPreferred(killer: SpectateSubject | null): void {
    if (this.subject === null) this.preferred = killer;
  }

  /** The player respawned (or the match ended): release everything. */
  end(): void {
    this.isActive = false;
    this.subject = null;
    this.preferred = null;
  }

  /**
   * Drive the rig for one spectating frame. `roster` is this frame's list of
   * watchable ships (live, launched, not the player); order just needs to be
   * stable frame-to-frame for cycling to feel sane.
   */
  update(
    deltaSeconds: number,
    nowMs: number,
    rig: CameraRig,
    zoomInput: number,
    input: InputState,
    roster: readonly SpectateSubject[],
  ): void {
    if (!this.isActive) return;
    let cycle = this.readCycleInput(input);

    // Wreck-hold beat: sit on the death position until the timer (or an
    // impatient cycle press) ends it.
    if (this.subject === null) {
      if (nowMs < this.holdUntilMs && cycle === 0) {
        rig.update(deltaSeconds, this.deathPos, this.zeroVelocity, zoomInput);
        return;
      }
      const first =
        (this.preferred !== null && roster.includes(this.preferred)
          ? this.preferred
          : null) ?? this.nearestTo(this.deathPos, roster);
      this.preferred = null;
      if (first === null) {
        // Nobody watchable (everyone dead or in the launch tubes) — keep
        // holding the wreck shot and retry next frame.
        rig.update(deltaSeconds, this.deathPos, this.zeroVelocity, zoomInput);
        return;
      }
      this.cutTo(first, rig);
      cycle = 0; // an early-cut press picked the first subject, not the second
    }

    // Followed ship died / despawned: cut to whoever is nearest to where we
    // were looking. Empty roster = freeze at the last framed position (do NOT
    // keep reading the subject — its respawn teleports it across the map).
    if (!roster.includes(this.subject!)) {
      const next = this.nearestTo(this.lastPos, roster);
      if (next === null) {
        rig.update(deltaSeconds, this.lastPos, this.zeroVelocity, zoomInput);
        return;
      }
      this.cutTo(next, rig);
    } else if (cycle !== 0) {
      const i = roster.indexOf(this.subject!);
      const n = roster.length;
      this.cutTo(roster[(i + cycle + n) % n], rig);
    }

    // Follow: finite-difference velocity feeds the rig's lead offset.
    const pos = this.subject!.position;
    if (this.hasLast && deltaSeconds > 0) {
      this.velocity.set(
        (pos.x - this.lastPos.x) / deltaSeconds,
        0,
        (pos.z - this.lastPos.z) / deltaSeconds,
      );
    } else {
      this.velocity.set(0, 0, 0);
    }
    this.lastPos.copyFrom(pos);
    this.hasLast = true;
    rig.update(deltaSeconds, pos, this.velocity, zoomInput);
  }

  /** -1 = previous, +1 = next, 0 = no fresh cycle press this frame. */
  private readCycleInput(input: InputState): number {
    const left = input.rotateLeft;
    const right = input.rotateRight;
    const fire = input.fire;
    const next = (right && !this.prevRight) || (fire && !this.prevFire);
    const prev = left && !this.prevLeft;
    this.prevLeft = left;
    this.prevRight = right;
    this.prevFire = fire;
    return (next ? 1 : 0) - (prev ? 1 : 0);
  }

  private cutTo(subject: SpectateSubject, rig: CameraRig): void {
    this.subject = subject;
    this.lastPos.copyFrom(subject.position);
    this.hasLast = false;
    rig.snapTo(subject.position);
  }

  private nearestTo(
    point: Vector3,
    roster: readonly SpectateSubject[],
  ): SpectateSubject | null {
    let best: SpectateSubject | null = null;
    let bestD = Infinity;
    for (const s of roster) {
      const dx = s.position.x - point.x;
      const dz = s.position.z - point.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}
