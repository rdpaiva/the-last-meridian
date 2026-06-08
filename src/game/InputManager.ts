import type { InputState } from "./types";

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
    strafeLeft: false,
    strafeRight: false,
    fire: false,
    fireMissile: false,
    zoomIn: false,
    zoomOut: false,
  };

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
    this.state.thrust = this.held.has("KeyW") || this.held.has("ArrowUp");
    this.state.reverse = this.held.has("KeyS") || this.held.has("ArrowDown");
    this.state.rotateLeft = this.held.has("KeyA") || this.held.has("ArrowLeft");
    this.state.rotateRight = this.held.has("KeyD") || this.held.has("ArrowRight");
    this.state.strafeLeft = this.held.has("KeyQ");
    this.state.strafeRight = this.held.has("KeyE");
    this.state.fire = this.held.has("Space");
    this.state.fireMissile = this.held.has("KeyR");
    // "+" is Shift+Equal on most layouts, so the Equal key doubles as zoom-in.
    this.state.zoomIn = this.held.has("Equal") || this.held.has("NumpadAdd");
    this.state.zoomOut =
      this.held.has("Minus") || this.held.has("NumpadSubtract");
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isGameKey(e.code)) {
      e.preventDefault();
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
  };

  private isGameKey(code: string): boolean {
    switch (code) {
      case "KeyW":
      case "KeyA":
      case "KeyS":
      case "KeyD":
      case "KeyQ":
      case "KeyE":
      case "KeyR":
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
        return true;
      default:
        return false;
    }
  }
}
