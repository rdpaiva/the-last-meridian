import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { DamageTarget } from "../types";
import type { Ship } from "./Ship";
import type { Mothership } from "./Mothership";

/**
 * The sim→view event channel (docs/MULTIPLAYER.md → Phase 0).
 *
 * Transient feedback — explosions, hit/death SFX, camera trauma, hitstop,
 * damage flash — used to fire INLINE in Game.tick right next to the sim
 * calls that caused them, welding gameplay truth to its Babylon/DOM
 * depiction. This bus is the seam: the sim ANNOUNCES what happened (a fact)
 * and client-side systems SUBSCRIBE to depict it. A headless/server run
 * simply doesn't subscribe — there is nothing to crash.
 *
 * In Phase 2 these same events become the network messages for transient
 * FX (server emits → client renders), so the payloads describe the EVENT,
 * never the reaction. Payloads carry raw sim facts (the ship/shooter/
 * position); "is this the local pilot" is derived at the edge by the
 * subscriber (`ship === playerShip`), keeping attribution per-SHIP rather
 * than baking a local-only `isPlayer` flag into the wire shape.
 *
 * NOTE on object refs: payloads pass live `Ship`/`DamageTarget`/`Vector3`
 * references — fine for a local, synchronous bus and a pure refactor. The
 * Phase 2 network boundary is where these become ids/serialized positions.
 */
export interface SimEventMap {
  /** A laser bolt struck a live target. */
  laserHit: { target: DamageTarget; shooter: Ship | null };
  /** A missile detonated (struck = null when it spent itself on an asteroid). */
  missileHit: {
    position: Vector3;
    struck: DamageTarget | null;
    shooter: Ship | null;
  };
  /** A laser shot a missile out of the air (point defense) — no damage. */
  missileIntercepted: { position: Vector3 };
  /** A ship fired its lasers this frame. */
  shipFiredLaser: { ship: Ship };
  /** A ship launched a missile this frame. */
  missileFired: { ship: Ship };
  /** A ship's catapult just flung it out of its carrier bow. */
  shipLaunched: { ship: Ship };
  /** A ship rammed an asteroid and took bump damage. */
  shipRammedAsteroid: { ship: Ship };
  /** A ship died (fires once, gated by the sim's explosionFired flag). */
  shipDied: { ship: Ship };
  /** A mothership fell — the match-ending death spectacle. */
  mothershipDied: { mothership: Mothership };
  /** A rock shattered into chunks. */
  asteroidShattered: { position: Vector3; radius: number };
}

export type SimEventName = keyof SimEventMap;
export type SimEventListener<K extends SimEventName> = (
  payload: SimEventMap[K],
) => void;

/**
 * A tiny typed pub/sub. `emit` is SYNCHRONOUS and runs listeners in
 * registration order, so rerouting an inline FX call through the bus
 * preserves tick ordering exactly (the smoke baseline stays clean).
 */
export class SimEventBus {
  // Stored loosely (the per-event listener type can't be expressed across a
  // generic K without TS collapsing the union to `never`); the public on/emit
  // signatures keep callers fully type-checked.
  private readonly listeners = new Map<SimEventName, Array<(p: never) => void>>();

  on<K extends SimEventName>(event: K, listener: SimEventListener<K>): void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = [];
      this.listeners.set(event, bucket);
    }
    bucket.push(listener as (p: never) => void);
  }

  emit<K extends SimEventName>(event: K, payload: SimEventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const listener of bucket) (listener as SimEventListener<K>)(payload);
  }
}
