import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { GameConfig } from "@space-duel/shared";
import type { SubsystemKind } from "@space-duel/shared";
import type { ExplosionSystem } from "../ExplosionSystem";

/**
 * Depiction of ONE carrier subsystem mount (a hangar bay) — the VIEW half of
 * the MothershipSubsystem split. DIEGETIC by design (owner calls,
 * 2026-07-18): NO marker geometry ever — while healthy, the carrier GLB's
 * own modelled launch bay IS the hangar (the sim mount is anchored to the
 * bay footprint, see GameConfig.mothership.subsystems.hangar.mounts), and
 * damage feedback is pure spark FX (the owner rejected a first-pass ember
 * cluster, then a subtle boosted-glint pass): every HP drop throws an
 * immediate carrier-scale FIRE burst (the impactSpark.hangar profile —
 * white/yellow/orange/red palette slivers), and a fully DESTROYED bay
 * burns continuously (a burst every ~emitIntervalMs). A wounded-but-alive
 * bay stays quiet between hits (owner call — the constant burn is the
 * "it's dead" read, not a damage meter).
 *
 * Holds no gameplay truth; each frame it reads the sim subsystem's hp
 * fraction from MothershipView.syncSubsystems(). Works online unchanged:
 * bay HP is replicated, so the drop edges and the dead state replay here.
 * The ExplosionSystem arrives via setExplosions() after construction (the
 * carrier views are built before the FX systems in both loops).
 */
export class SubsystemView {
  private readonly mount: TransformNode;
  private explosions: ExplosionSystem | null = null;
  /** hp fraction last frame; null until the first read so a mid-match join
   *  (or a pre-wounded replicated state) doesn't fire a phantom burst. */
  private lastFrac: number | null = null;
  private nextEmitAtMs = 0;
  private readonly scratch = new Vector3();

  constructor(
    scene: Scene,
    root: TransformNode,
    readonly kind: SubsystemKind,
    mountX: number,
    mountY: number,
    mountZ: number,
  ) {
    this.mount = new TransformNode(`subsys_${kind}_${mountX}_${mountZ}`, scene);
    this.mount.parent = root;
    this.mount.position.set(mountX, mountY, mountZ);
  }

  /** FX hookup — called by MothershipView.setExplosions once the system exists. */
  setExplosions(explosions: ExplosionSystem): void {
    this.explosions = explosions;
  }

  /**
   * Re-seat this subsystem at a new carrier-LOCAL mount (x/y/z under the
   * carrier root) — the seam for a carrier GLB authoring `hangar.*` empties
   * (the sim side re-seats in lockstep via
   * Mothership.setModelSubsystemMounts).
   */
  setMount(x: number, y: number, z: number): void {
    this.mount.position.set(x, y, z);
  }

  /**
   * Compare this bay's hp fraction against last frame: a drop throws an
   * immediate burst (hit feedback); only a fully DESTROYED bay runs the
   * continuous burn. View-only wall clock — never sim state. Called each
   * view frame from MothershipView.syncSubsystems().
   */
  update(hpFrac: number): void {
    const frac = Math.max(0, Math.min(1, hpFrac));
    const prev = this.lastFrac;
    this.lastFrac = frac;
    if (!this.explosions) return;
    const now = performance.now();
    if (prev !== null && frac < prev - 1e-6) {
      this.burst();
      this.nextEmitAtMs = now + this.emitDelay();
      return;
    }
    if (frac <= 0 && now >= this.nextEmitAtMs) {
      this.burst();
      this.nextEmitAtMs = now + this.emitDelay();
    }
  }

  /** Jittered continuous-burn period so the bays (and dead turrets) desync. */
  private emitDelay(): number {
    return (
      GameConfig.impactSpark.hangar.emitIntervalMs * (0.7 + Math.random() * 0.6)
    );
  }

  /** Carrier-scale spark burst, scattered around the bay so it doesn't stamp. */
  private burst(): void {
    const p = this.mount.getAbsolutePosition();
    this.scratch.set(
      p.x + (Math.random() - 0.5) * 12,
      p.y,
      p.z + (Math.random() - 0.5) * 12,
    );
    this.explosions!.spawnSpark(this.scratch, GameConfig.impactSpark.hangar);
  }

  dispose(): void {
    this.mount.dispose(false, true);
  }
}
