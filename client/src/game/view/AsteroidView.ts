import type { Scene } from "@babylonjs/core/scene";
import type { Material } from "@babylonjs/core/Materials/material";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
// Registers MeshBuilder.CreateIcoSphere (the rock body).
import "@babylonjs/core/Meshes/Builders/icoSphereBuilder";

import { GameConfig, type AsteroidSim } from "@space-duel/shared";

/**
 * The VIEW half of a rock (sim is shared/sim/AsteroidSim). Builds the faceted
 * low-poly mesh once and, each frame, copies the sim's `position` + `rotation`
 * onto it so the rendered rock tracks the collision silhouette exactly.
 *
 * All randomness here is PURELY COSMETIC (surface noise lobes, crater
 * sculpting, per-face tint) and deliberately stays on Math.random(): it never
 * touches the sim, so it can't shift a seeded battle. The SIM-affecting squash
 * factors come from the sim (`sim.squashX/squashY`) — the mesh is squashed to
 * match the collision ellipsoid the sim already rolled. Owned by
 * AsteroidFieldView — do not construct directly.
 */
export class AsteroidView {
  private readonly mesh: Mesh;

  constructor(
    scene: Scene,
    material: Material,
    private readonly sim: AsteroidSim,
  ) {
    this.mesh = this.buildMesh(scene, sim.visualRadius);
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.sync();
  }

  /** Copy the sim's position + tumble orientation onto the mesh. */
  sync(): void {
    this.mesh.position.copyFrom(this.sim.position);
    this.mesh.rotation.set(
      this.sim.rotation.x,
      this.sim.rotation.y,
      this.sim.rotation.z,
    );
  }

  dispose(): void {
    this.mesh.dispose();
  }

  /**
   * Builds a faceted low-poly rock: an icosphere squashed into the sim's
   * ellipsoid, dented with craters, vertices pushed in/out along their radius,
   * then flat-shaded for the chunky look with per-face tonal variation.
   *
   * The displacement is a SMOOTH function of each vertex's DIRECTION (a sum of
   * a few low-frequency lobes with per-rock random phases), so neighbouring
   * vertices move almost together — a lumpy-but-watertight potato. An earlier
   * version jittered each vertex independently, which tore adjacent faces apart
   * and let you see through the notches to the backfaces (it looked hollow).
   *
   * Craters are smooth inward dents: each picks a random surface direction,
   * angular footprint, and depth; verts inside the footprint sink along their
   * radius with a cosine falloff (deepest at center, flush at the rim).
   */
  private buildMesh(scene: Scene, radius: number): Mesh {
    const cfg = GameConfig.asteroids;
    const mesh = MeshBuilder.CreateIcoSphere(
      "asteroid",
      { radius, subdivisions: cfg.meshDetail },
      scene,
    );

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      // Per-rock random noise basis so no two rocks share a silhouette.
      const p1 = Math.random() * Math.PI * 2;
      const p2 = Math.random() * Math.PI * 2;
      const p3 = Math.random() * Math.PI * 2;
      const f1 = 1.5 + Math.random() * 1.5;
      const f2 = 2.0 + Math.random() * 2.0;
      const f3 = 3.0 + Math.random() * 2.0;

      // Ellipsoid squash from the SIM (surfaceRadiusToward uses the same
      // factors) — the mesh max extent stays at visualRadius on the z axis.
      const sx = this.sim.squashX;
      const sy = this.sim.squashY;

      // Crater set: random surface direction + footprint + depth per crater.
      const craterCount =
        cfg.craterCountMin +
        Math.floor(Math.random() * (cfg.craterCountMax - cfg.craterCountMin + 1));
      const craters: { x: number; y: number; z: number; r: number; depth: number }[] = [];
      for (let c = 0; c < craterCount; c++) {
        // Uniform random direction on the unit sphere.
        const theta = Math.random() * Math.PI * 2;
        const cz = Math.random() * 2 - 1;
        const cs = Math.sqrt(1 - cz * cz);
        craters.push({
          x: cs * Math.cos(theta),
          y: cs * Math.sin(theta),
          z: cz,
          r: cfg.craterRadiusMin + Math.random() * (cfg.craterRadiusMax - cfg.craterRadiusMin),
          depth: radius * cfg.craterDepth * (0.6 + Math.random() * 0.8),
        });
      }

      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        const len = Math.hypot(x, y, z) || 1;
        const ux = x / len;
        const uy = y / len;
        const uz = z / len;
        // Smooth lobes in ~[-1, 1] — coherent across neighbouring verts.
        let n = Math.sin(ux * f1 + p1) * Math.cos(uy * f1 + p2);
        n += 0.5 * Math.sin(uy * f2 + p2) * Math.cos(uz * f2 + p3);
        n += 0.35 * Math.sin(uz * f3 + p3) * Math.cos(ux * f3 + p1);
        n /= 1.85;
        let scale = 1 + n * cfg.lumpiness;
        // Crater dents: sink verts inside each footprint, cosine falloff.
        for (const crater of craters) {
          const dot = ux * crater.x + uy * crater.y + uz * crater.z;
          const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
          if (angle < crater.r) {
            const falloff = 0.5 + 0.5 * Math.cos((Math.PI * angle) / crater.r);
            scale -= (crater.depth * falloff) / len;
          }
        }
        positions[i] = x * scale * sx;
        positions[i + 1] = y * scale * sy;
        positions[i + 2] = z * scale;
      }
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    }
    // Flat shading: duplicates verts + recomputes per-face normals → faceted.
    mesh.convertToFlatShadedMesh();

    // Per-face mineral tint: after flat shading every face owns 3 consecutive
    // verts, so a shared random darkening per triple reads as rock patchiness
    // (StandardMaterial multiplies vertex color into the diffuse).
    if (cfg.faceTintJitter > 0) {
      const flat = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (flat) {
        const vertCount = flat.length / 3;
        const colors = new Float32Array(vertCount * 4);
        for (let v = 0; v < vertCount; v += 3) {
          const tint = 1 - Math.random() * cfg.faceTintJitter;
          for (let k = 0; k < 3 && v + k < vertCount; k++) {
            const o = (v + k) * 4;
            colors[o] = tint;
            colors[o + 1] = tint;
            colors[o + 2] = tint;
            colors[o + 3] = 1;
          }
        }
        mesh.setVerticesData(VertexBuffer.ColorKind, colors);
      }
    }
    return mesh;
  }
}
