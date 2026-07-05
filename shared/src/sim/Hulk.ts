import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig, type HulkHazard } from "../GameConfig";
import type { AvoidObstacle } from "../ShipController";
import { HulkSection } from "./HulkSection";

/** A world-space basis vector (the world direction of a hull-local axis). */
interface Basis {
  x: number;
  y: number;
  z: number;
}

/** One UNSCALED hull-local collision box (carrier-world units; the hulk's own
 *  `scale` is applied when sections/wireframes are built). */
export interface HulkBox {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
}

/**
 * A faction's UNSCALED hull collision boxes — the SHARED source of truth for the
 * live carrier (Mothership builds MothershipSections), its wreck (Hulk builds
 * HulkSections), and the debug overlay (HulkView draws matching wireframes). The
 * carrier and its wreck are the same geometry, so they collide off one fit.
 * Prefers the authored `GameConfig.mothership.colliders` OBB list; falls back to
 * one box per `mothership.hullRects` rectangle (centred, full-beam — looser, but
 * every faction still collides without an explicit fit).
 */
export function hullColliderBoxes(source: HulkHazard["source"]): HulkBox[] {
  const fitted = GameConfig.mothership.colliders[source];
  if (fitted && fitted.length > 0) return fitted.map((b) => ({ ...b }));
  const hy = GameConfig.hulk.hullHalfHeight;
  return GameConfig.mothership.hullRects[source].map((r) => ({
    cx: 0,
    cy: 0,
    cz: (r.z0 + r.z1) / 2,
    hx: r.halfWidth,
    hy,
    hz: (r.z1 - r.z0) / 2,
  }));
}

/**
 * Hulk SIM — a derelict capital-ship wreck as gameplay truth, with NO Babylon
 * scene objects (its depiction is a client-side HulkView). A placed map hazard
 * (docs/ARENA-MAPS.md slice 5): INDESTRUCTIBLE static cover that blocks weapons
 * line-of-sight and keeps ships out.
 *
 * Collision is a stack of ORIENTED HULL BOXES (HulkSection) built from the
 * source carrier's `GameConfig.mothership.colliders` — the SAME boxes the live
 * carrier collides with (shared geometry). Unlike the static carrier
 * sections, a wreck rotates on all three axes (yaw + pitch + roll), so each tick
 * `recompute` rebuilds the world basis (ex/ey/ez = the world directions of the
 * hull-local X/Y/Z axes) and the sections read it to track the full orientation.
 * Because gameplay is on the y=0 plane, the sections' surface radius naturally
 * THINS as the hull rolls edge-on (a sideways ray exits the thin vertical face),
 * so cover/keep-out follow the visible silhouette. A dynamic sim entity:
 * `update(dt)` must run every sim step (Game.advanceSim + the headless harness).
 */
export class Hulk {
  /** World center on the gameplay plane (Y = the view's deck level). */
  readonly center: Vector3;
  /** Current yaw facing (radians) — advances slowly each tick. */
  rotationY: number;
  readonly rotationRate: number;
  /** Current pitch (radians) — beam-axis somersault. */
  rotationX: number;
  readonly pitchRate: number;
  /** Current roll (radians) — keel-axis barrel roll (deck→belly). */
  rotationZ: number;
  readonly rollRate: number;
  readonly scale: number;
  readonly source: HulkHazard["source"];

  /** World directions of the hull-local X (beam), Y (up), Z (keel) axes —
   *  rebuilt from yaw/pitch/roll each tick; the sections collide against these. */
  readonly ex: Basis = { x: 1, y: 0, z: 0 };
  readonly ey: Basis = { x: 0, y: 1, z: 0 };
  readonly ez: Basis = { x: 0, y: 0, z: 1 };

  /** Oriented hull boxes (poses mutate as the hulk rotates). Held BY REFERENCE
   *  by Game's weapon-obstacle + AI-obstacle lists. */
  readonly sections: ReadonlyArray<HulkSection>;

  constructor(spec: HulkHazard) {
    this.source = spec.source;
    this.rotationY = spec.rotationY ?? 0;
    this.rotationRate = spec.rotationRate ?? 0.03; // rad/sec — a slow drift
    this.rotationX = spec.rotationX ?? 0;
    this.pitchRate = spec.pitchRate ?? 0; // rad/sec — beam-axis somersault
    this.rotationZ = spec.rotationZ ?? 0;
    this.rollRate = spec.rollRate ?? 0; // rad/sec — keel-axis barrel roll
    this.scale = spec.scale ?? 1;
    this.center = new Vector3(spec.x, GameConfig.mothership.yLevel, spec.z);

    // One oriented box per fitted collider (or hullRect fallback), scaled by the
    // hulk's own scale. hy makes the box thin to a slab when rolled edge-on
    // rather than staying a full-width wall.
    const s = this.scale;
    this.sections = hullColliderBoxes(this.source).map(
      (b) =>
        new HulkSection(this, b.hx * s, b.hy * s, b.hz * s, b.cx * s, b.cy * s, b.cz * s),
    );
    this.recompute();
  }

  /** Advance the slow rotation (all three axes) and refresh the hull boxes. */
  update(dtSeconds: number): void {
    this.rotationY += this.rotationRate * dtSeconds;
    this.rotationX += this.pitchRate * dtSeconds;
    this.rotationZ += this.rollRate * dtSeconds;
    this.recompute();
  }

  /** Rebuild the world basis from yaw/pitch/roll, then refresh every section's
   *  pose. The basis columns are R·e_i for R = Ry(yaw)·Rx(pitch)·Rz(roll), the
   *  same Euler composition HulkView applies to the mesh root, so collision and
   *  visuals stay locked together. */
  private recompute(): void {
    const ca = Math.cos(this.rotationY);
    const sa = Math.sin(this.rotationY);
    const cb = Math.cos(this.rotationX);
    const sb = Math.sin(this.rotationX);
    const cc = Math.cos(this.rotationZ);
    const sc = Math.sin(this.rotationZ);

    // ex = R·(1,0,0), ey = R·(0,1,0), ez = R·(0,0,1).
    this.ex.x = cc * ca + sc * sb * sa;
    this.ex.y = sc * cb;
    this.ex.z = sc * sb * ca - cc * sa;

    this.ey.x = cc * sb * sa - sc * ca;
    this.ey.y = cc * cb;
    this.ey.z = cc * sb * ca + sc * sa;

    this.ez.x = sa * cb;
    this.ez.y = -sb;
    this.ez.z = ca * cb;

    for (const section of this.sections) section.refresh();
  }

  /** AI steering obstacles — the same section objects (AvoidObstacle-shaped). */
  get avoidObstacles(): ReadonlyArray<AvoidObstacle> {
    return this.sections;
  }
}
