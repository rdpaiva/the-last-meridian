import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { InputState } from "@space-duel/shared";
import { GameConfig, clamp, wrapAngle } from "@space-duel/shared";

/**
 * Mouse input for the local pilot — a CLIENT-ONLY input source that merges
 * into the same InputState the keyboard produces, so the sim, the netcode,
 * and the server never know a mouse exists.
 *
 * Steering model: the cursor sets a DESIRED HEADING, not an aim point with
 * authority. The cursor is unprojected onto the fighter plane (y = 0), the
 * bearing from the ship to that point becomes the target heading, and the
 * heading error drives `InputState.turn` through the same proportional
 * P-controller shape the AI uses (`ai.steerBand`) — so the ship still turns
 * at its normal per-type rotation rate and a mouse pilot has exactly the
 * same physical capability as a keyboard pilot.
 *
 * Device arbitration is "last touched wins": steering engages while the
 * mouse moved (or clicked) within `mouse.activeTimeoutMs`, and any held
 * rotate key both wins immediately and disengages mouse steering until the
 * mouse moves again — a parked cursor never fights the keyboard.
 *
 * Buttons: left = fire lasers, right = fire missile (context menu suppressed
 * on the canvas). Button presses only register when they start ON the game
 * canvas, so clicks on DOM HUD overlays never fire the guns; releases are
 * tracked window-wide so a drag off-canvas can't stick a button held.
 */
export class MouseSteering {
  private canvas: HTMLCanvasElement | null = null;

  /** Latest cursor position (viewport CSS pixels). */
  private cursorX = 0;
  private cursorY = 0;
  /** performance.now() of the last mouse move/press; -Infinity = disengaged. */
  private lastIntentMs = -Infinity;
  private fireHeld = false;
  private missileHeld = false;

  // Scratch vectors for the per-frame unprojection (no hot-path allocation).
  private readonly srcScratch = new Vector3();
  private readonly nearScratch = new Vector3();
  private readonly farScratch = new Vector3();

  constructor(private readonly camera: Camera) {}

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    // Move tracking is window-wide (the cursor stays meaningful over HUD
    // overlays — it's a world point, not a widget), but presses must START
    // on the canvas (see onPointerDown).
    window.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    window.removeEventListener("pointermove", this.onPointerMove);
    this.canvas?.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas?.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("blur", this.onBlur);
    this.canvas = null;
  }

  /**
   * Merge mouse input into this frame's InputState. Call once per frame,
   * AFTER InputManager.update() (which owns resetting the fields) and BEFORE
   * anything reads the state. `ship` is the local pilot's pose source — the
   * offline sim Ship or the multiplayer predicted Ship; pass null when there
   * is no flyable ship yet (steering no-ops, buttons still merge).
   */
  apply(
    state: InputState,
    ship: {
      position: { x: number; z: number };
      rotationY: number;
      isAlive: boolean;
    } | null,
    nowMs: number,
  ): void {
    // Buttons merge unconditionally (OR with the keyboard's Space/Shift).
    if (this.fireHeld) state.fire = true;
    if (this.missileHeld) state.fireMissile = true;

    // A held rotate key wins outright AND disengages mouse steering, so the
    // ship doesn't snap back toward a stale cursor when the key is released.
    if (state.rotateLeft || state.rotateRight) {
      this.lastIntentMs = -Infinity;
      return;
    }

    const cfg = GameConfig.mouse;
    if (nowMs - this.lastIntentMs > cfg.activeTimeoutMs) return;
    if (!this.canvas || !ship || !ship.isAlive) return;

    // Unproject the cursor onto the fighter plane (y = 0): near/far points
    // through the cursor pixel, then intersect the segment with the plane.
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const px = this.cursorX - rect.left;
    const py = this.cursorY - rect.top;
    this.srcScratch.set(px, py, 0);
    Vector3.UnprojectToRef(
      this.srcScratch,
      rect.width,
      rect.height,
      Matrix.IdentityReadOnly,
      this.camera.getViewMatrix(),
      this.camera.getProjectionMatrix(),
      this.nearScratch,
    );
    this.srcScratch.set(px, py, 1);
    Vector3.UnprojectToRef(
      this.srcScratch,
      rect.width,
      rect.height,
      Matrix.IdentityReadOnly,
      this.camera.getViewMatrix(),
      this.camera.getProjectionMatrix(),
      this.farScratch,
    );
    const dirY = this.farScratch.y - this.nearScratch.y;
    if (Math.abs(dirY) < 1e-6) return; // ray parallel to the plane
    const t = -this.nearScratch.y / dirY;
    if (t < 0 || t > 1) return; // plane not between near and far clip
    const worldX =
      this.nearScratch.x + (this.farScratch.x - this.nearScratch.x) * t;
    const worldZ =
      this.nearScratch.z + (this.farScratch.z - this.nearScratch.z) * t;

    const dx = worldX - ship.position.x;
    const dz = worldZ - ship.position.z;
    // Inside the deadzone the nose just holds — a cursor sitting on/near the
    // ship would otherwise command wild bearing swings as the ship drifts.
    if (Math.hypot(dx, dz) < cfg.deadzoneWorldUnits) return;

    // Same proportional steering the AI flies with: full rate beyond
    // steerBand of error, easing linearly to zero as the nose lines up.
    const headingError = wrapAngle(Math.atan2(dx, dz) - ship.rotationY);
    if (Math.abs(headingError) > cfg.steerDeadband) {
      state.turn = clamp(headingError / cfg.steerBand, -1, 1);
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    this.cursorX = e.clientX;
    this.cursorY = e.clientY;
    this.lastIntentMs = performance.now();
  };

  private onPointerDown = (e: PointerEvent): void => {
    // Attached to the canvas itself, so DOM HUD overlays swallow their own
    // clicks before this ever sees them.
    e.preventDefault();
    this.cursorX = e.clientX;
    this.cursorY = e.clientY;
    this.lastIntentMs = performance.now(); // a click is steering intent too
    if (e.button === 0) this.fireHeld = true;
    if (e.button === 2) this.missileHeld = true;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button === 0) this.fireHeld = false;
    if (e.button === 2) this.missileHeld = false;
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault(); // right button is the missile trigger
  };

  private onBlur = (): void => {
    this.fireHeld = false;
    this.missileHeld = false;
    this.lastIntentMs = -Infinity;
  };
}
