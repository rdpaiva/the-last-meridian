import type { InputState } from "./types";
import type { Ship } from "./Ship";
import type { Mothership } from "./Mothership";

/**
 * Read-only view of the world a controller needs to decide its inputs. Built
 * fresh (cheaply) by Game each frame for each AI ship — a local/keyboard
 * controller ignores it.
 */
export interface ControllerWorld {
  /** Live + dead opposing-faction ships (controllers filter by isAlive). */
  opponents: Ship[];
  /** The opposing faction's mothership, or null. */
  opponentMothership: Mothership | null;
  arenaHalfX: number;
  arenaHalfZ: number;
}

/**
 * Produces the InputState that drives a Ship this frame. The Ship doesn't care
 * which implementation it gets — keyboard, AI, or (future) network — which is
 * exactly what makes the two factions interchangeable and multiplayer-ready.
 *
 * Implementations must return a stable InputState reference each frame (mutate
 * in place rather than allocating) to keep the render loop allocation-free.
 */
export interface ShipController {
  update(deltaSeconds: number, self: Ship, world: ControllerWorld): InputState;
}
