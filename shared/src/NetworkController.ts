import type { ShipController } from "./ShipController";
import type { InputState } from "./types";

/** A do-nothing input frame (all controls released). */
export const NEUTRAL_INPUT: InputState = {
  thrust: false,
  reverse: false,
  rotateLeft: false,
  rotateRight: false,
  turn: 0,
  strafeLeft: false,
  strafeRight: false,
  fire: false,
  fireMissile: false,
  jumpPressed: false,
  zoomIn: false,
  zoomOut: false,
};

/**
 * The network seam: a ShipController whose input is pushed in from OUTSIDE the
 * sim (the server replays a connected client's sampled InputState into the
 * Ship through this). The mirror image of LocalInputController — same Ship sim,
 * different input source — which is what makes the player just "a Ship wearing a
 * controller" and the whole design multiplayer-ready.
 *
 * `jumpPressed` is an EDGE intent (true for one frame), so it is consumed
 * one-shot: returned once, then cleared, so a stale held message can't re-arm
 * the jump drive every tick. Held controls (thrust/fire/…) persist until the
 * next message replaces them — correct pass-through under packet loss.
 */
export class NetworkController implements ShipController {
  private input: InputState = { ...NEUTRAL_INPUT };

  /** Replace the held input with the latest sampled client frame. */
  setInput(input: InputState): void {
    this.input = input;
  }

  update(): InputState {
    const out = this.input;
    // Consume the one-shot jump edge so it fires for a single sim step only.
    if (out.jumpPressed) this.input = { ...out, jumpPressed: false };
    return out;
  }
}
