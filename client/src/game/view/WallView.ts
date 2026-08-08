import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { GameConfig, type Wall } from "@space-duel/shared";
import { samplePlanetFbm } from "../PlanetTerrain";

/** One ring station along the wall path: position + right vector + arc pos. */
interface Frame {
  x: number;
  z: number;
  rx: number;
  rz: number;
  s: number;
}

/** Per-source material info the slab builder needs alongside the material. */
interface SlabMaterial {
  mat: StandardMaterial;
  textured: boolean;
  tile: number;
}

/** Cross-section point measured from trench (-) toward mesa (+). */
interface CutBankProfilePoint {
  m: number;
  /** Rock face height from buried toe (0) to rim crest (1). */
  faceHeight?: number;
  /** Ground-cap blend from the rock crest (0) to sampled mesa terrain (1). */
  rimBlend?: number;
}

/**
 * The VIEW half of a terrain wall (sim is shared/sim/Wall). Planet-map walls
 * with a `mesa` side become ASYMMETRIC CUT BANKS: a near-vertical rock face
 * rises from the trench-side collider edge, then a ground-textured rim cap
 * joins the raised terrain on the mesa side. That topology makes the wall a
 * cut through one continuous landscape instead of a rounded rock tube placed
 * on top of it. Free-standing walls without a mesa retain the stacked-ridge
 * fallback. Both view shapes still come from the SAME WallHazard spec as the
 * collider, and all meshes are static/frozen.
 *
 * Texturing (all owner-authored art, DIFFUSE under the scene lights — never
 * emissive, gotcha #9):
 *  - The cut face wears the stratified rock tile (walls.texture), mapped by
 *    path distance + world height so strata stay horizontal instead of
 *    wrapping over a boulder profile.
 *  - Its rim cap uses the PLANET GROUND tile with the same world-planar UVs
 *    and shared height noise as PlanetTerrain, hiding the mesh/terrain join.
 *  - Free-standing fallback tiers keep their configured floor/wall sources.
 *  - UVs are world-scaled (u along the path, v across each slab's profile);
 *    end caps get DEDICATED verts with planar UVs (shared ring verts all
 *    carry the same along-path U — a fan over them smears the texture into
 *    1D streaks across the cap).
 *  - Missing/broken texture file → plain fallback color, never black;
 *    file "" → the texture-less faceted mode (flat shading + per-face tint
 *    jitter, the asteroid recipe).
 *
 * Geometry rules learned the hard way (see CLAUDE.md gotchas): front face =
 * COUNTER-clockwise in the (x-right, z-up) plane seen from +Y, and smooth
 * low-frequency noise only on shared verts BEFORE any flat shading.
 */
export class WallView {
  private readonly meshes: Mesh[] = [];
  private readonly materials: StandardMaterial[] = [];

  constructor(scene: Scene, wall: Wall) {
    const cfg = GameConfig.walls;
    const frames = this.buildFrames(wall);

    if (wall.spec.mesa) {
      const wallMaterial = this.buildMaterial(scene, "wall");
      const floorMaterial = this.buildMaterial(scene, "floor");
      const mesaSign = wall.spec.mesa === "right" ? 1 : -1;
      this.buildCutBank(scene, frames, wall, mesaSign, wallMaterial, floorMaterial);
      return;
    }

    // Free-standing fallback: one material per source used by the tier stack.
    const sources = new Map<"floor" | "wall", SlabMaterial>();
    for (const tier of cfg.tiers) {
      if (!sources.has(tier.texture)) {
        sources.set(tier.texture, this.buildMaterial(scene, tier.texture));
      }
    }

    // Stack the slabs bottom → top. The base seals at -belowDepth; each
    // upper slab's foot tucks tierOverlap into the slab below.
    const H = wall.height;
    const D = cfg.belowDepth;
    for (let i = 0; i < cfg.tiers.length; i++) {
      const tier = cfg.tiers[i];
      const yBottom = i === 0 ? -D : cfg.tiers[i - 1].topFrac * H - cfg.tierOverlap;
      const yTop = tier.topFrac * H;
      const halfW = (wall.width / 2) * tier.width;
      const slabMat = sources.get(tier.texture)!;
      const mesh = this.buildSlab(scene, frames, yBottom, yTop, halfW, slabMat);
      mesh.material = slabMat.mat;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix(); // static terrain — skip per-frame matrix work
      this.meshes.push(mesh);
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    for (const m of this.materials) m.dispose();
  }

  /** Matte slab material for one texture source, with never-black fallbacks. */
  private buildMaterial(scene: Scene, source: "floor" | "wall"): SlabMaterial {
    const cfg = GameConfig.walls;
    // "floor" = the planet ground tile so the base slab IS the terrain
    // material; "wall" = the rock tile. Fallback colors match each source.
    const tex = source === "floor" ? GameConfig.planet.texture : cfg.texture;
    const fallback = source === "floor" ? GameConfig.planet.paletteHigh : cfg.diffuse;
    const textured = tex.file !== "";

    const mat = new StandardMaterial(`wall_${source}_mat`, scene);
    // Match the source material's self-light as well as its texture/tint: the
    // ground cap must not become a brighter ribbon than PlanetTerrain.
    const e = source === "floor" ? GameConfig.planet.emissive : cfg.emissive;
    mat.emissiveColor = new Color3(e.r, e.g, e.b);
    // Matte — specular on rock reads as wet plastic.
    mat.specularColor = Color3.Black();
    // Slabs are open shells at the wall ends; double-siding is far cheaper
    // than authoring watertight geometry.
    mat.backFaceCulling = false;

    if (textured) {
      const t = tex.tint;
      mat.diffuseColor = new Color3(t.r, t.g, t.b);
      const texture = new Texture(
        `${import.meta.env.BASE_URL}textures/${tex.file}`,
        scene,
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          // Missing/broken file → the plain source color, never black.
          mat.diffuseTexture = null;
          mat.diffuseColor = new Color3(fallback.r, fallback.g, fallback.b);
        },
      );
      texture.wrapU = Texture.WRAP_ADDRESSMODE;
      texture.wrapV = Texture.WRAP_ADDRESSMODE;
      texture.anisotropicFilteringLevel = 8;
      mat.diffuseTexture = texture;
    } else {
      mat.diffuseColor = new Color3(fallback.r, fallback.g, fallback.b);
    }

    this.materials.push(mat);
    return { mat, textured, tile: tex.tileSize };
  }

  /** Resample the polyline into evenly spaced ring frames (position + right). */
  private buildFrames(wall: Wall): Frame[] {
    const cfg = GameConfig.walls;
    const pts = wall.spec.points;
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(
        cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z),
      );
    }
    const total = cum[cum.length - 1];
    const ringCount = Math.max(2, Math.round(total / cfg.ringSpacing) + 1);
    const stations: { x: number; z: number }[] = [];
    for (let r = 0; r < ringCount; r++) {
      const s = (total * r) / (ringCount - 1);
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const t = cum[i] - cum[i - 1] > 1e-6 ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
      stations.push({
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t,
      });
    }
    const frames: Frame[] = [];
    for (let r = 0; r < ringCount; r++) {
      // Central-difference tangent → in-plane right vector for the profile.
      const prev = stations[Math.max(0, r - 1)];
      const next = stations[Math.min(ringCount - 1, r + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      frames.push({
        x: stations[r].x,
        z: stations[r].z,
        rx: tz, // right = tangent rotated -90° on X/Z
        rz: -tx,
        s: (total * r) / (ringCount - 1),
      });
    }
    return frames;
  }

  /**
   * Mesa-aware canyon wall: one stratified face plus a terrain-matched rim.
   * The face crosses y=0 just outside the collision capsule's trench edge,
   * so ships never hit an invisible wall; above the flight plane it terraces
   * inward before the cap settles onto the raised mesa.
   */
  private buildCutBank(
    scene: Scene,
    frames: Frame[],
    wall: Wall,
    mesaSign: number,
    wallMaterial: SlabMaterial,
    floorMaterial: SlabMaterial,
  ): void {
    const cfg = GameConfig.walls;
    const bottomY = Math.min(GameConfig.planet.wallFootY, -cfg.belowDepth) - 2;
    const phases = {
      crest: Math.random() * Math.PI * 2,
      wander: Math.random() * Math.PI * 2,
      width: Math.random() * Math.PI * 2,
    };

    // m is measured trench → mesa. The face stays close to m=-1 through
    // the flight plane (the collider's visible flank), then leans into the
    // plateau in broad eroded benches instead of rounding over symmetrically.
    const face: ReadonlyArray<CutBankProfilePoint> = [
      { m: -1.2, faceHeight: 0 },
      { m: -1.14, faceHeight: 0.2 },
      { m: -1.08, faceHeight: 0.46 },
      { m: -1.0, faceHeight: 0.7 },
      { m: -0.76, faceHeight: 0.9 },
      { m: -0.24, faceHeight: 1 },
    ];
    const rim: ReadonlyArray<CutBankProfilePoint> = [
      { m: -0.24, rimBlend: 0 },
      { m: 0.16, rimBlend: 0.35 },
      { m: 0.68, rimBlend: 0.76 },
      { m: 1.35, rimBlend: 1 },
    ];

    this.buildCutBankRibbon(
      scene,
      "wallCutFace",
      frames,
      wall,
      mesaSign,
      face,
      bottomY,
      wallMaterial,
      false,
      phases,
    );
    this.buildCutBankRibbon(
      scene,
      "wallMesaRim",
      frames,
      wall,
      mesaSign,
      rim,
      bottomY,
      floorMaterial,
      true,
      phases,
    );
  }

  /** Build one continuous path/profile ribbon, including dedicated end caps. */
  private buildCutBankRibbon(
    scene: Scene,
    name: string,
    frames: Frame[],
    wall: Wall,
    mesaSign: number,
    canonicalProfile: ReadonlyArray<CutBankProfilePoint>,
    bottomY: number,
    slabMat: SlabMaterial,
    worldPlanarUv: boolean,
    phases: { crest: number; wander: number; width: number },
  ): void {
    const cfg = GameConfig.walls;
    const planet = GameConfig.planet;
    const halfW = wall.width / 2;
    const ringCount = frames.length;
    // Keep profile vertices ordered from world-left to world-right so the
    // surface winding remains the same for left- and right-mesa walls.
    const profile = canonicalProfile
      .map((p) => ({ ...p, u: p.m * mesaSign }))
      .sort((a, b) => a.u - b.u);
    const P = profile.length;
    const capBase = ringCount * P;
    const vertCount = capBase + 2 * P;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const tile = slabMat.tile;
    const noise = (s: number, frequency: number, phase: number): number =>
      (Math.sin(s * frequency + phase) +
        0.5 * Math.sin(s * frequency * 2.37 + phase * 1.61)) /
      1.5;

    for (let r = 0; r < ringCount; r++) {
      const fr = frames[r];
      // One shared set of low-frequency phases feeds BOTH face and rim. This
      // removes the independent-tier seams that made the old wall look built.
      const wander = cfg.faceJitter * noise(fr.s, 0.012, phases.wander);
      const widthScale = 1 + 0.045 * noise(fr.s, 0.016, phases.width);
      const crestY =
        Math.max(wall.height, planet.mesaTopY + 2) +
        wall.height * cfg.crestJitter * noise(fr.s, 0.01, phases.crest);

      for (let j = 0; j < P; j++) {
        const point = profile[j];
        const lateral = point.u * halfW * widthScale + wander;
        const x = fr.x + fr.rx * lateral;
        const z = fr.z + fr.rz * lateral;
        const mesaY = planet.mesaTopY + planet.mesaAmplitude * samplePlanetFbm(x, z);
        const y =
          point.faceHeight !== undefined
            ? bottomY + (crestY - bottomY) * point.faceHeight
            : crestY + (mesaY - crestY) * (point.rimBlend ?? 1);
        const o = (r * P + j) * 3;
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        const uo = (r * P + j) * 2;
        if (worldPlanarUv) {
          // Identical projection to PlanetTerrain: the cap is a continuation
          // of the landscape tile, not merely a similarly colored material.
          uvs[uo] = x / tile;
          uvs[uo + 1] = z / tile;
        } else {
          // Path/height mapping preserves the source image's horizontal rock
          // strata and never wraps them over a rounded cross-section.
          uvs[uo] = fr.s / tile;
          uvs[uo + 1] = (y - bottomY) / tile;
        }

        // Dedicated end-cap copy; use lateral/height projection because the
        // path coordinate is constant over an end face.
        if (r === 0 || r === ringCount - 1) {
          const ci = capBase + (r === 0 ? j : P + j);
          positions[ci * 3] = x;
          positions[ci * 3 + 1] = y;
          positions[ci * 3 + 2] = z;
          uvs[ci * 2] = lateral / tile;
          uvs[ci * 2 + 1] = y / tile;
        }
      }
    }

    const indices: number[] = [];
    for (let r = 0; r + 1 < ringCount; r++) {
      for (let j = 0; j + 1 < P; j++) {
        const a = r * P + j;
        const b = a + 1;
        const c = a + P;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    // The path ends face opposite directions, so their fan winding must too.
    for (let j = 1; j + 1 < P; j++) {
      indices.push(capBase, capBase + j + 1, capBase + j);
      const far = capBase + P;
      indices.push(far, far + j, far + j + 1);
    }

    const mesh = new Mesh(name, scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.uvs = uvs;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh);

    if (!slabMat.textured) {
      mesh.convertToFlatShadedMesh();
      const flat = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (flat && cfg.faceTintJitter > 0) {
        const flatCount = flat.length / 3;
        const colors = new Float32Array(flatCount * 4);
        for (let v = 0; v < flatCount; v += 3) {
          const tint = 1 - Math.random() * cfg.faceTintJitter;
          for (let k = 0; k < 3 && v + k < flatCount; k++) {
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
    mesh.material = slabMat.mat;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    this.meshes.push(mesh);
  }

  /** One rounded slab band extruded along the frames. */
  private buildSlab(
    scene: Scene,
    frames: Frame[],
    yBottom: number,
    yTop: number,
    halfW: number,
    slabMat: SlabMaterial,
  ): Mesh {
    const cfg = GameConfig.walls;
    const ringCount = frames.length;

    // Per-slab noise phases (cosmetic only — Math.random by design, like the
    // asteroids: it can never shift a seeded battle). DISTINCT per slab so
    // the tiers wander/swell independently — the "stacked rocks" read.
    const pTop = Math.random() * Math.PI * 2;
    const pWander = Math.random() * Math.PI * 2;
    const pWidth = Math.random() * Math.PI * 2;
    const noise = (s: number, f: number, phase: number) =>
      Math.sin(s * f + phase) + 0.5 * Math.sin(s * f * 2.7 + phase * 1.7);

    // Rounded "sitting rock" cross-section: widest near the foot, belly,
    // pulled-in shoulder, gently crowned top. `u` in slab half-widths,
    // `t` = 0 foot → 1 top (crown overshoots slightly).
    const PROFILE: ReadonlyArray<{ u: number; t: number }> = [
      { u: -1.08, t: 0 },
      { u: -1.0, t: 0.45 },
      { u: -0.82, t: 0.9 },
      { u: -0.45, t: 1.0 },
      { u: 0, t: 1.06 },
      { u: 0.45, t: 1.0 },
      { u: 0.82, t: 0.9 },
      { u: 1.0, t: 0.45 },
      { u: 1.08, t: 0 },
    ];
    const P = PROFILE.length;

    // Vert layout: rings, then 2×P dedicated end-cap verts (planar UVs — a
    // fan over shared ring verts smears the texture into 1D streaks).
    const capBase = ringCount * P;
    const vertCount = capBase + 2 * P;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const tile = slabMat.tile;

    for (let r = 0; r < ringCount; r++) {
      const fr = frames[r];
      // The slab shifts RIGID per ring (whole cross-section, not v-scaled)
      // — a boulder course drifting off-axis, not a leaning face — and its
      // top swells independently of its (pinned) foot.
      const wander = cfg.faceJitter * noise(fr.s, 0.035, pWander);
      const widthScale = 1 + 0.15 * noise(fr.s, 0.045, pWidth);
      const topJit = 1 + cfg.crestJitter * 0.35 * noise(fr.s, 0.05, pTop);

      let profCum = 0; // arc length across the profile (v axis)
      let prevLateral = 0;
      let prevY = 0;
      for (let j = 0; j < P; j++) {
        const prof = PROFILE[j];
        const lateral = prof.u * halfW * widthScale + wander;
        const y = yBottom + (yTop - yBottom) * prof.t * topJit;
        const o = (r * P + j) * 3;
        positions[o] = fr.x + fr.rx * lateral;
        positions[o + 1] = y;
        positions[o + 2] = fr.z + fr.rz * lateral;

        if (j > 0) profCum += Math.hypot(lateral - prevLateral, y - prevY);
        prevLateral = lateral;
        prevY = y;
        const uo = (r * P + j) * 2;
        uvs[uo] = fr.s / tile;
        uvs[uo + 1] = profCum / tile;

        // Dedicated end-cap copy (first + last ring) with planar UVs.
        if (r === 0 || r === ringCount - 1) {
          const ci = capBase + (r === 0 ? j : P + j);
          positions[ci * 3] = positions[o];
          positions[ci * 3 + 1] = y;
          positions[ci * 3 + 2] = positions[o + 2];
          uvs[ci * 2] = lateral / tile;
          uvs[ci * 2 + 1] = y / tile;
        }
      }
    }

    // ── Indices. WINDING: ring direction = path tangent, profile direction
    // = the right vector — the same (forward, right) frame as a ground grid,
    // so front face = counter-clockwise seen from +Y (CLAUDE.md gotcha:
    // wound the other way, ComputeNormals points INTO the rock and the sun
    // lights the inside). ────────────────────────────────────────────────
    const indices: number[] = [];
    for (let r = 0; r + 1 < ringCount; r++) {
      for (let j = 0; j + 1 < P; j++) {
        const a = r * P + j;
        const b = a + 1;
        const c = a + P;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    for (const end of [0, 1]) {
      const base = capBase + end * P;
      for (let j = 1; j + 1 < P; j++) {
        indices.push(base, base + j, base + j + 1);
      }
    }

    const mesh = new Mesh("wallSlab", scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.uvs = uvs;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh);

    // Textured mode stops here: SMOOTH shading under the image (facet
    // creases fighting a photographic tile read as glitches, not style).
    if (slabMat.textured) return mesh;

    // Texture-less mode: the faceted look — flat shading + per-face tonal
    // jitter (after flat shading every face owns 3 consecutive verts).
    mesh.convertToFlatShadedMesh();
    const flat = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (flat && cfg.faceTintJitter > 0) {
      const flatCount = flat.length / 3;
      const colors = new Float32Array(flatCount * 4);
      for (let v = 0; v < flatCount; v += 3) {
        const tint = 1 - Math.random() * cfg.faceTintJitter;
        for (let k = 0; k < 3 && v + k < flatCount; k++) {
          const o = (v + k) * 4;
          colors[o] = tint;
          colors[o + 1] = tint;
          colors[o + 2] = tint;
          colors[o + 3] = 1;
        }
      }
      mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    }
    return mesh;
  }
}
