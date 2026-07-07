import type { InputState } from "@space-duel/shared";
import { GameConfig, clamp, wrapAngle } from "@space-duel/shared";

/**
 * Gamepad input for the local pilot — a CLIENT-ONLY input source that merges
 * into the same InputState the keyboard produces, so the sim, the netcode,
 * and the server never know a pad exists (same contract as MouseSteering).
 *
 * Steering model: the LEFT STICK sets a DESIRED HEADING relative to the
 * SCREEN (twin-stick style — push the stick where you want the nose to
 * point). The stick direction is mapped into world X/Z through the view's
 * `flipped` flag (the north-end pilot's 180° camera, see CameraRig), and the
 * heading error drives `InputState.turn` through the same proportional
 * P-controller shape the mouse and the AI use — so the ship still turns at
 * its normal per-type rotation rate and a pad pilot has exactly the same
 * physical capability as a keyboard or mouse pilot. Don't "upgrade" this to
 * heading snaps; that's the balance invariant.
 *
 * Device arbitration: the stick self-gates — released, it returns to center
 * (inside `gamepad.stickDeadzone`) and leaves the turn channel to whatever
 * the keyboard/mouse wrote; deflected, it's explicit intent and overwrites
 * the mouse's turn. A held rotate key still wins outright, mirroring the
 * mouse rule. Buttons always merge (OR) regardless of stick state.
 *
 * Standard-mapping buttons (Xbox names; PlayStation equivalents in order):
 *   RT = thrust, LT = reverse, A/Cross = fire lasers, X/Square = missile,
 *   Y/Triangle = jump (edge-detected like the J key), LB/RB = strafe,
 *   d-pad up/down = zoom.
 *
 * The Gamepad API is poll-based: `apply()` snapshots the pad each frame via
 * navigator.getGamepads(); the connect/disconnect listeners only maintain a
 * cheap "is any pad present" early-out so padless players never pay the
 * per-frame poll.
 */
export class GamepadSteering {
  /** True while at least one pad is connected — early-out gate for apply(). */
  private padPresent = false;
  /** Previous frame's jump-button state, for the one-frame jumpPressed edge. */
  private prevJumpHeld = false;

  constructor(private readonly flipped: boolean) {}

  attach(): void {
    window.addEventListener("gamepadconnected", this.onPadChange);
    window.addEventListener("gamepaddisconnected", this.onPadChange);
    // A pad connected before this page loaded only surfaces after its first
    // button press (browser privacy rule), which fires gamepadconnected —
    // so the listener alone is enough; still probe once for hot reloads.
    this.padPresent = this.findPad() !== null;
  }

  detach(): void {
    window.removeEventListener("gamepadconnected", this.onPadChange);
    window.removeEventListener("gamepaddisconnected", this.onPadChange);
    this.padPresent = false;
  }

  /**
   * Merge gamepad input into this frame's InputState. Call once per frame,
   * AFTER InputManager.update() and MouseSteering.apply() (a deflected stick
   * deliberately overrides a parked-but-recent mouse). `ship` is the local
   * pilot's pose source — offline sim Ship or multiplayer predicted Ship;
   * pass null when there is no flyable ship yet (steering no-ops, buttons
   * still merge).
   */
  apply(
    state: InputState,
    ship: {
      position: { x: number; z: number };
      rotationY: number;
      isAlive: boolean;
    } | null,
  ): void {
    if (!this.padPresent) return;
    const pad = this.findPad();
    if (!pad) return;
    const cfg = GameConfig.gamepad;

    // --- Buttons merge unconditionally (OR with keyboard + mouse). ---
    const held = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
    // Analog triggers report partial travel; count them held past the
    // threshold so a light squeeze still thrusts.
    const trigger = (i: number): boolean => {
      const b = pad.buttons[i];
      return b !== undefined && (b.pressed || b.value > cfg.triggerThreshold);
    };
    if (trigger(7)) state.thrust = true; // RT
    if (trigger(6)) state.reverse = true; // LT
    if (held(0)) state.fire = true; // A / Cross
    if (held(2)) state.fireMissile = true; // X / Square
    if (held(4)) state.strafeLeft = true; // LB
    if (held(5)) state.strafeRight = true; // RB
    if (held(12)) state.zoomIn = true; // d-pad up
    if (held(13)) state.zoomOut = true; // d-pad down
    // Jump is an EDGE (one frame per fresh press), matching the J key.
    const jumpHeld = held(3); // Y / Triangle
    if (jumpHeld && !this.prevJumpHeld) state.jumpPressed = true;
    this.prevJumpHeld = jumpHeld;

    // --- Left-stick steering. ---
    // A held rotate key wins outright, same rule as MouseSteering.
    if (state.rotateLeft || state.rotateRight) return;
    if (!ship || !ship.isAlive) return;
    const sx = pad.axes[0] ?? 0;
    const sy = pad.axes[1] ?? 0;
    // Inside the radial deadzone the stick is centered: leave the turn
    // channel to the keyboard/mouse rather than writing a zero over it.
    if (Math.hypot(sx, sy) < cfg.stickDeadzone) return;

    // Screen → world: stick-up is -Y in the Gamepad API and screen-up is +Z
    // world in the default view; the flipped (north-end) view negates both
    // axes — one sign carries the whole 180°, same trick as CameraRig.
    const dirX = this.flipped ? -sx : sx;
    const dirZ = this.flipped ? sy : -sy;

    // Same proportional steering as mouse/AI: full rate beyond steerBand of
    // heading error, easing linearly to zero as the nose lines up. Inside
    // the deadband hold the nose (turn stays 0 — the stick owns the channel
    // while deflected, so a stale mouse turn can't leak through).
    const headingError = wrapAngle(Math.atan2(dirX, dirZ) - ship.rotationY);
    state.turn =
      Math.abs(headingError) > cfg.steerDeadband
        ? clamp(headingError / cfg.steerBand, -1, 1)
        : 0;
  }

  private readonly onPadChange = (): void => {
    this.padPresent = this.findPad() !== null;
  };

  private findPad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    // Prefer a standard-mapping pad (known button/axis layout); fall back to
    // the first connected pad and hope its layout is close.
    let fallback: Gamepad | null = null;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      if (pad.mapping === "standard") return pad;
      fallback ??= pad;
    }
    return fallback;
  }
}
