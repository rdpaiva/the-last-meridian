import type { InputState } from "./types";
import type { InputManager } from "./InputManager";
import type { ShipController } from "./ShipController";

/**
 * Drives a Ship from the local keyboard. The "player" is just the Ship wearing
 * one of these. Game still suppresses this controller during the catapult
 * launch sequence (the launch drives the ship directly).
 */
export class LocalInputController implements ShipController {
  constructor(private readonly input: InputManager) {}

  update(): InputState {
    // InputManager.update() is already called once per frame by Game; we just
    // surface its live state object (mutated in place, so no allocation).
    return this.input.state;
  }
}
