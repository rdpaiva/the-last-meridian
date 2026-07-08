import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { DamageTarget } from "../types";
import type { Faction } from "../Faction";
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
  /** A laser bolt struck a live target. `position` = the bolt's impact point. */
  laserHit: { target: DamageTarget; shooter: Ship | null; position: Vector3 };
  /** A missile detonated (struck = null when it spent itself on an asteroid). */
  missileHit: {
    position: Vector3;
    struck: DamageTarget | null;
    shooter: Ship | null;
  };
  /** A laser shot a missile out of the air (point defense) — no damage. */
  missileIntercepted: { position: Vector3 };
  /** A ship fired its lasers this frame. `muzzles` = the world-space muzzle
   *  positions the bolts spawned from (one per barrel) — the Phase 2 relay
   *  ships these so a networked client can spawn cosmetic bolts exactly
   *  where the server did. */
  shipFiredLaser: { ship: Ship; muzzles: readonly Vector3[] };
  /** A ship launched a missile this frame. `target` = the ship the round is
   *  homing on (null = ballistic). Rides the payload so the Phase 2 relay can
   *  ship the lock and a networked client can steer its cosmetic round —
   *  without it remote missiles depict as ballistic and the RWR can't hear
   *  the seeker. */
  missileFired: { ship: Ship; target: Ship | null };
  /** A ship's catapult just flung it out of its carrier bow. */
  shipLaunched: { ship: Ship };
  /** A ship rammed an asteroid and took bump damage. */
  shipRammedAsteroid: { ship: Ship };
  /** An ion storm zapped a ship (the periodic in-cloud damage tick landed). */
  stormZap: { ship: Ship };
  /** A ship died (fires once, gated by the sim's explosionFired flag). */
  shipDied: { ship: Ship };
  /** A mothership fell — the match-ending death spectacle. */
  mothershipDied: { mothership: Mothership };
  /** A carrier defense turret fired a bolt this frame (faction = the shooter's).
   *  `rotationY` = the bolt's heading, for networked cosmetic-bolt spawns. */
  turretFired: { faction: Faction; origin: Vector3; rotationY: number };
  /** A carrier defense turret was shot off the hull (fires once, latched). */
  turretDestroyed: { position: Vector3 };
  /** A ship armed its jump drive and began the spool-up countdown. */
  jumpSpoolStarted: { ship: Ship };
  /**
   * A ship's jump drive fired — it teleported into its carrier's service
   * bubble. Carries BOTH ends so the view can crack a flash where the ship
   * left (from*) and where it arrived (to*); `ship.position` already holds the
   * arrival point, but the pre-teleport spot is gone, so it rides the payload.
   */
  jumpFired: {
    ship: Ship;
    fromX: number;
    fromZ: number;
    toX: number;
    toZ: number;
  };
  /** A ship aborted its jump spool (pays the drive cooldown). */
  jumpCancelled: { ship: Ship };
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
