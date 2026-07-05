import type { ShipController } from "./ShipController";
import type { InputState } from "./types";
import { GameConfig } from "./GameConfig";

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

/** Hard cap on queued frames — a stalled sim can't hoard input forever. */
const QUEUE_HARD_CAP = 30;

/**
 * The network seam: a ShipController whose input is pushed in from OUTSIDE the
 * sim (the server replays a connected client's sampled InputState into the
 * Ship through this). The mirror image of LocalInputController — same Ship sim,
 * different input source — which is what makes the player just "a Ship wearing a
 * controller" and the whole design multiplayer-ready.
 *
 * Input frames are QUEUED and consumed exactly one per sim tick (the client
 * sends at the sim rate), so each acked seq corresponds to exactly one fixed
 * sim step — the invariant the client's prediction replay assumes (it replays
 * one 1/SIM_HZ step per unacked input). The old "hold the latest frame"
 * semantics made the applied-time-per-seq oscillate with message-arrival vs
 * tick-boundary phase, which reconciliation rendered as a speed-proportional
 * judder at full thrust. `lastConsumedSeq` is the ack the room replicates.
 *
 * Jitter policy: a small backlog (GameConfig.net.inputBacklogMax) rides out
 * bursty delivery; anything beyond it is discarded oldest-first (acked — the
 * client must not replay a frame the server skipped; the skipped time is a
 * one-off reconciliation correction). When the queue runs dry the last
 * applied controls repeat for the tick — correct pass-through under loss.
 *
 * `jumpPressed` is an EDGE intent (true for one frame), so it is consumed
 * one-shot: a queued frame's edge fires on the tick that applies it (discards
 * carry the edge forward to the next applied frame), and a starved repeat
 * never re-arms the jump drive.
 */
export class NetworkController implements ShipController {
  private readonly queue: Array<{ seq: number; input: InputState }> = [];
  /** Last applied controls — repeated on ticks the queue runs dry. */
  private held: InputState = { ...NEUTRAL_INPUT };
  /** A jump edge from a discarded frame, carried to the next applied one. */
  private pendingJumpEdge = false;
  /** Seq of the newest frame consumed OR discarded (the prediction ack). */
  lastConsumedSeq = 0;

  /** Queue one sampled client frame for the next free sim tick. */
  pushInput(seq: number, input: InputState): void {
    this.queue.push({ seq, input });
    if (this.queue.length > QUEUE_HARD_CAP) this.discardOldest();
  }

  /**
   * Replace everything with `input` held: clears the queue (stale frames from
   * before a seat handover / launch-tube suppression must not replay later).
   */
  setInput(input: InputState): void {
    this.queue.length = 0;
    this.pendingJumpEdge = false;
    this.held = input;
  }

  update(): InputState {
    // Burn stale backlog down to the jitter allowance before consuming.
    while (this.queue.length > GameConfig.net.inputBacklogMax + 1) {
      this.discardOldest();
    }
    const next = this.queue.shift();
    if (next) {
      this.lastConsumedSeq = next.seq;
      const jump = next.input.jumpPressed || this.pendingJumpEdge;
      this.pendingJumpEdge = false;
      // The edge is consumed by THIS application — a starved repeat of these
      // controls must not re-arm the jump drive.
      this.held = { ...next.input, jumpPressed: false };
      return jump ? { ...next.input, jumpPressed: true } : next.input;
    }
    // Starved (or legacy setInput path): repeat the held controls, consuming
    // a held jump edge one-shot exactly like before.
    const out = this.held;
    if (out.jumpPressed) this.held = { ...out, jumpPressed: false };
    return out;
  }

  private discardOldest(): void {
    const drop = this.queue.shift()!;
    if (drop.input.jumpPressed) this.pendingJumpEdge = true;
    this.lastConsumedSeq = drop.seq;
  }
}
