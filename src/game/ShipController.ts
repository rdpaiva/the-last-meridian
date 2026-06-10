import type { InputState } from "./types";
import type { Ship } from "./Ship";
import type { Mothership } from "./Mothership";

/**
 * Minimal view of a round obstacle (an asteroid) for AI path avoidance.
 * Structurally satisfied by `Asteroid` — `radius` is its conservative
 * max-extent collision circle, which is what a pilot should steer clear of
 * (stable under tumble, errs on the safe side).
 */
export interface AvoidObstacle {
  position: { x: number; z: number };
  radius: number;
  isAlive: boolean;
}

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
  /** This faction's own mothership — used by "defend" order. */
  homeMothership: Mothership | null;
  /**
   * The wing leader for this faction's AI fighters to escort/cover — the human
   * pilot's ship for the player side, or null (enemy fighters have no leader to
   * form on). Used by `AIController` "cover"/"formation" orders. Mutable so Game
   * can wire it once the async-loaded player ship exists.
   */
  leader: Ship | null;
  /**
   * Live asteroids to steer around (the AsteroidField's array, held by
   * reference so shatter chunks appear automatically). AIController runs an
   * avoidance pass over these after every order's plan.
   */
  obstacles: ReadonlyArray<AvoidObstacle>;
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
