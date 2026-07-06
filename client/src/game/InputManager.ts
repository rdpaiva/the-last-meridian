import type { InputState } from "@space-duel/shared";

/**
 * Keyboard input abstraction. Tracks held keys via keydown/keyup, and
 * exposes a derived InputState. Call update() once per frame before
 * consumers read state.
 *
 * On window blur (tab switch, alt-tab) all keys are cleared so nothing
 * sticks pressed when the user returns.
 */
export class InputManager {
  private readonly held = new Set<string>();
  readonly state: InputState = {
    thrust: false,
    reverse: false,
    rotateLeft: false,
    rotateRight: false,
    turn: 0, // keyboard turns via the booleans; MouseSteering writes this.
    strafeLeft: false,
    strafeRight: false,
    fire: false,
    fireMissile: false,
    jumpPressed: false,
    zoomIn: false,
    zoomOut: false,
  };

  /**
   * Set on the keydown that FIRST presses the jump key (auto-repeat guarded),
   * surfaced as the one-frame `jumpPressed` edge by update(), then cleared.
   */
  private jumpQueued = false;

  /**
   * Set on a fresh press of the debug key (Backquote `` ` ``). Polled +
   * consumed via consumeDebugToggle() — kept OFF the InputState wire format
   * (it's a client-only test cheat, not ship input).
   */
  private debugToggleQueued = false;

  attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }

  update(): void {
    // Reset the analog channel every frame — MouseSteering re-writes it
    // AFTER update() when engaged; without this a last mouse-commanded turn
    // would stick forever once the mouse goes idle.
    this.state.turn = 0;
    this.state.thrust = this.held.has("KeyW") || this.held.has("ArrowUp");
    this.state.reverse = this.held.has("KeyS") || this.held.has("ArrowDown");
    this.state.rotateLeft = this.held.has("KeyA") || this.held.has("ArrowLeft");
    this.state.rotateRight = this.held.has("KeyD") || this.held.has("ArrowRight");
    this.state.strafeLeft = this.held.has("KeyQ");
    this.state.strafeRight = this.held.has("KeyE");
    this.state.fire = this.held.has("Space");
    this.state.fireMissile = this.held.has("ShiftLeft") || this.held.has("ShiftRight");
    // "+" is Shift+Equal on most layouts, so the Equal key doubles as zoom-in.
    this.state.zoomIn = this.held.has("Equal") || this.held.has("NumpadAdd");
    this.state.zoomOut =
      this.held.has("Minus") || this.held.has("NumpadSubtract");
    // Jump is an EDGE (true for one frame on a fresh press), not a held bool —
    // a toggle that arms or cancels the spool. Consume the queued press.
    this.state.jumpPressed = this.jumpQueued;
    this.jumpQueued = false;
  }

  /** Returns true once per fresh press of the debug key, then clears it. */
  consumeDebugToggle(): boolean {
    const q = this.debugToggleQueued;
    this.debugToggleQueued = false;
    return q;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isGameKey(e.code)) {
      e.preventDefault();
      // Edge-detect the jump key: queue only on the transition into held, so
      // key auto-repeat doesn't re-arm/cancel the spool every repeat tick.
      if (e.code === "KeyJ" && !this.held.has("KeyJ")) {
        this.jumpQueued = true;
      }
      // Debug god-mode toggle — fresh press only (guard auto-repeat).
      if (e.code === "Backquote" && !this.held.has("Backquote")) {
        this.debugToggleQueued = true;
      }
      this.held.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.isGameKey(e.code)) {
      e.preventDefault();
      this.held.delete(e.code);
    }
  };

  private onBlur = (): void => {
    this.held.clear();
    this.jumpQueued = false; // don't fire a stale jump when focus returns
  };

  private isGameKey(code: string): boolean {
    switch (code) {
      case "KeyW":
      case "KeyA":
      case "KeyS":
      case "KeyD":
      case "KeyQ":
      case "KeyE":
      case "ShiftLeft":
      case "ShiftRight":
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
      case "Space":
      case "Equal":
      case "Minus":
      case "NumpadAdd":
      case "NumpadSubtract":
      case "KeyM":
      case "KeyJ":
      case "Backquote":
        return true;
      default:
        return false;
    }
  }
}
