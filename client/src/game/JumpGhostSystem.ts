import { Constants } from "@babylonjs/core/Engines/constants";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import { GameConfig } from "@space-duel/shared";
import { JumpGhost, type JumpGhostMode } from "./JumpGhost";

/**
 * Spawns and ticks the spectral hull ghosts (JumpGhost) at both ends of a
 * jump. Driven off the jumpFired SimEvent next to JumpFlashSystem — view
 * only, never the sim. The DEPARTURE ghost snapshots the ship's view root
 * in place (at jumpFired time the view still holds the pre-teleport pose);
 * the ARRIVAL ghost is the same snapshot re-posed at the arrival point.
 *
 * Each ghost clones the hull meshes fresh and shares ONE additive ghost
 * material across them (jumps are rare, so per-jump clones are cheap — same
 * rationale as JumpFlash). Clones opt into the GlowLayer so the streak
 * blooms, and are disposed on expiry — the GlowLayer handles disposed meshes
 * safely (ExplosionSystem pattern).
 */
export class JumpGhostSystem {
  private readonly active: JumpGhost[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly glowLayer: GlowLayer,
  ) {}

  /** Ghost the ship's current pose in place — the phase-out streak. */
  spawnDeparture(sourceRoot: TransformNode): void {
    this.spawn(sourceRoot, "out", null);
  }

  /** Ghost the ship re-posed at the arrival point — the phase-in streak. */
  spawnArrival(
    sourceRoot: TransformNode,
    x: number,
    z: number,
    rotationY: number,
  ): void {
    this.spawn(sourceRoot, "in", { x, z, rotationY });
  }

  private spawn(
    sourceRoot: TransformNode,
    mode: JumpGhostMode,
    pose: { x: number; z: number; rotationY: number } | null,
  ): void {
    const g = GameConfig.jumpFx.ghost;

    // Snapshot only what's actually showing right now. This skips the FX
    // helpers parented to the ship root (the disabled DamageFlash sphere,
    // hidden trail anchors, idle thruster plumes faded to alpha 0) so the
    // ghost is the hull silhouette, not a shell of invisible props.
    const sources = sourceRoot.getChildMeshes(false).filter(
      (m): m is Mesh =>
        m instanceof Mesh &&
        m.isEnabled() &&
        m.isVisible &&
        m.visibility > 0 &&
        m.getTotalVertices() > 0 &&
        (m.material?.alpha ?? 1) > 0,
    );
    if (sources.length === 0) return;

    // Ship roots are scene-level, so their local transform IS the world pose.
    const ghostRoot = new TransformNode("jump_ghost", this.scene);
    ghostRoot.position.copyFrom(sourceRoot.position);
    ghostRoot.rotation.copyFrom(sourceRoot.rotation);
    ghostRoot.scaling.copyFrom(sourceRoot.scaling);
    if (pose) {
      ghostRoot.position.x = pose.x;
      ghostRoot.position.z = pose.z;
      ghostRoot.rotation.y = pose.rotationY;
      // Teleports land wings-level (Ship.jumpTeleport zeroes the bank).
      ghostRoot.rotation.z = 0;
    }

    // One shared material per ghost: additive blend (overlapping hull parts
    // brighten instead of sorting against each other) with depth writes off
    // so the streak never self-occludes mid-stretch.
    const mat = new StandardMaterial("jump_ghost_mat", this.scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(g.color.r, g.color.g, g.color.b);
    mat.disableLighting = true;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.disableDepthWrite = true;
    mat.alpha = g.peakAlpha;

    // Flatten the (possibly nested) GLB hierarchy: bake each mesh's transform
    // RELATIVE TO THE SHIP ROOT into its clone under the ghost root, so the
    // snapshot reproduces the hull exactly wherever the ghost root is posed.
    const invRoot = sourceRoot.computeWorldMatrix(true).clone().invert();
    const rel = new Matrix();
    for (const src of sources) {
      const clone = src.clone(`${src.name}_ghost`, null, true);
      src.computeWorldMatrix(true).multiplyToRef(invRoot, rel);
      clone.parent = ghostRoot;
      const scaling = new Vector3();
      const rotation = new Quaternion();
      const position = new Vector3();
      rel.decompose(scaling, rotation, position);
      clone.scaling = scaling;
      clone.rotationQuaternion = rotation;
      clone.position = position;
      clone.visibility = 1;
      clone.isPickable = false;
      clone.material = mat;
      this.glowLayer.addIncludedOnlyMesh(clone);
    }

    this.active.push(new JumpGhost(ghostRoot, mat, mode));
  }

  update(deltaMs: number): void {
    for (const ghost of this.active) ghost.update(deltaMs);
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].isExpired) {
        this.active[i].dispose();
        this.active.splice(i, 1);
      }
    }
  }

  get count(): number {
    return this.active.length;
  }
}
