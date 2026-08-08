import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { GameConfig, clamp, lerp } from "@space-duel/shared";

// Cosmetic landscape noise is shared with WallView so a cut-bank wall's
// ground-textured rim lands on the same mesa height as the terrain. Module-
// local phases keep the landscape fresh per match without affecting the sim.
const PLANET_NOISE_PHASE_1 = Math.random() * 1000;
const PLANET_NOISE_PHASE_2 = Math.random() * 1000;

function planetValueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const hash = (hx: number, hz: number): number => {
    const n =
      Math.sin(hx * 127.1 + hz * 311.7 + PLANET_NOISE_PHASE_1) *
      (43758.5453 + PLANET_NOISE_PHASE_2);
    return (n - Math.floor(n)) * 2 - 1;
  };
  const a = lerp(hash(ix, iz), hash(ix + 1, iz), ux);
  const b = lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), ux);
  return lerp(a, b, uz);
}

/** Shared cosmetic height sample used by the landscape and canyon rims. */
export function samplePlanetFbm(x: number, z: number): number {
  const cfg = GameConfig.planet;
  let sum = 0;
  let weight = 1;
  let norm = 0;
  let freq = 1 / cfg.featureSize;
  for (let o = 0; o < cfg.octaves; o++) {
    sum += weight * planetValueNoise(x * freq, z * freq);
    norm += weight;
    weight *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * The "planet" environment's landscape (scenery.environment = "planet" — see
 * GameConfig.planet): a gently-relieved ground mesh far below the flight
 * plane, replacing the whole deep-space stack (Backdrop / Starfield / scenery
 * Nebulas / CapitalShips) on maps that opt in. Fire-and-forget like Nebulas:
 * built once in the constructor, world matrix frozen, never ticked.
 *
 * Why world geometry and not a backdrop image: the "low-level flight" feel IS
 * parallax, and a screen-space Layer has none — a mesh at real depth scrolls
 * correctly under the camera for free.
 *
 * SURFACE: the owner-authored seamless tile (`planet.texture.file`, applied
 * to DIFFUSE under the scene lights — never emissive, gotcha #9) draped over
 * a smooth-shaded low-relief value-noise heightfield. Near a terrain WALL the
 * TRENCH-side ground swells up to `wallFootY` to meet the ridge's skirt; on
 * a wall's MESA side (WallHazard.mesa) the ground instead rises to
 * `planet.mesaTopY` — trench-rim height, ABOVE the flight plane — and stays
 * there, so the wall reads as the carved edge of a trench the pilots fly
 * inside (mesa top: ground tile → canyon face: rock tile → trench floor:
 * ground tile again). Wall footprints come straight from GameConfig.hazards
 * (the same WallHazard spec the sim + WallView read), so the seam can never
 * desync. Failure paths never go black: a missing/broken texture file falls
 * back to a plain sand color, and `texture.file: ""` opts into the old
 * texture-less faceted look (flat-shaded facets + height-banded palette +
 * per-face jitter — the WallView/asteroid recipe).
 *
 * Noise phases use Math.random by design (cosmetic only, like the asteroids'
 * meshes — it can never shift a seeded battle).
 */
export class PlanetTerrain {
  private readonly mesh: Mesh;
  private readonly material: StandardMaterial;

  constructor(scene: Scene) {
    const cfg = GameConfig.planet;
    const textured = cfg.texture.file !== "";

    this.material = new StandardMaterial("planet_mat", scene);
    const e = cfg.emissive;
    this.material.emissiveColor = new Color3(e.r, e.g, e.b);
    // Matte — specular across kilometers of sand reads as wet plastic.
    this.material.specularColor = Color3.Black();

    if (textured) {
      // The image carries the surface detail; the tint is the brightness/
      // warmth dial (multiplied into the texture by StandardMaterial).
      const t = cfg.texture.tint;
      this.material.diffuseColor = new Color3(t.r, t.g, t.b);
      const tex = new Texture(
        `${import.meta.env.BASE_URL}textures/${cfg.texture.file}`,
        scene,
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          // Missing/broken file → plain sand, never a black hole under the
          // whole map. Self-heals the moment the owner drops the file in.
          this.material.diffuseTexture = null;
          const p = cfg.paletteHigh;
          this.material.diffuseColor = new Color3(p.r, p.g, p.b);
        },
      );
      // The mesh's UVs advance 1 per tileSize world units; WRAP tiles the
      // (seamless) image endlessly. Anisotropy keeps the shallow-angle far
      // ground from smearing under the tilted top-down camera.
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      tex.anisotropicFilteringLevel = 8;
      this.material.diffuseTexture = tex;
    } else {
      // Texture-less faceted mode: vertex colors carry ALL the tone
      // (palette bands + jitter) — keep the diffuse white so they multiply
      // through unchanged.
      this.material.diffuseColor = Color3.White();
    }

    this.mesh = this.buildMesh(scene, textured);
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.freezeWorldMatrix(); // static landscape — skip per-frame matrix work
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }

  private buildMesh(scene: Scene, textured: boolean): Mesh {
    const cfg = GameConfig.planet;

    // ── Wall faces: every `wall` hazard's polyline edges. Each face carries
    // its hazard's mesa side (+1 = right of the point order, -1 = left, 0 =
    // none) so the heightfield knows which flank is trench and which is the
    // raised mesa top. ─────────────────────────────────────────────────────
    const faces: {
      ax: number;
      az: number;
      ex: number;
      ez: number;
      len: number;
      hw: number;
      mesaSign: number;
    }[] = [];
    for (const hazard of GameConfig.hazards) {
      if (hazard.kind !== "wall") continue;
      const hw = (hazard.width ?? GameConfig.walls.width) / 2;
      const mesaSign = hazard.mesa === "right" ? 1 : hazard.mesa === "left" ? -1 : 0;
      const pts = hazard.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const ex = pts[i + 1].x - pts[i].x;
        const ez = pts[i + 1].z - pts[i].z;
        const len = Math.hypot(ex, ez);
        if (len < 1e-6) continue;
        faces.push({ ax: pts[i].x, az: pts[i].z, ex, ez, len, hw, mesaSign });
      }
    }
    /** Nearest-face query result (scratch object, refilled per vertex):
     *  d = distance to the face (core distance − halfWidth), and for the
     *  winning face: lat = signed lateral offset from its core LINE
     *  (+ = the polyline's right side), overshoot = how far past the
     *  segment's ends the point projects, mesaSign/hw = that face's spec. */
    const q = { d: Infinity, lat: 0, overshoot: 0, mesaSign: 0, hw: 0 };
    const queryFaces = (x: number, z: number): void => {
      q.d = Infinity;
      q.mesaSign = 0;
      for (const f of faces) {
        const px = x - f.ax;
        const pz = z - f.az;
        const tRaw = (px * f.ex + pz * f.ez) / (f.len * f.len);
        const t = clamp(tRaw, 0, 1);
        const dx = px - f.ex * t;
        const dz = pz - f.ez * t;
        const d = Math.hypot(dx, dz) - f.hw;
        if (d < q.d) {
          q.d = d;
          q.hw = f.hw;
          q.mesaSign = f.mesaSign;
          // + = right of the edge direction (dot with the right vector
          // (ez, -ex) — same frame as WallView's ring "right").
          q.lat = (px * f.ez - pz * f.ex) / f.len;
          q.overshoot = f.len * (tRaw < 0 ? -tRaw : Math.max(0, tRaw - 1));
        }
      }
    };

    // ── Heightfield verts (+ planar world-space UVs for the texture) ────────
    const cells = Math.max(2, Math.round((cfg.halfExtent * 2) / cfg.cellSize));
    const n = cells + 1; // verts per side
    const step = (cfg.halfExtent * 2) / cells;
    const positions = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = -cfg.halfExtent + ix * step;
        const z = -cfg.halfExtent + iz * step;
        queryFaces(x, z);
        const noise = samplePlanetFbm(x, z);
        const noiseY = cfg.baseY + cfg.amplitude * noise;
        // Trench side: swell up to the wall foot over wallBlend (d<=0 =
        // under the wall itself → pinned at the foot so the skirt is
        // always sealed).
        const tFoot = 1 - clamp(q.d / cfg.wallBlend, 0, 1);
        const sFoot = tFoot * tFoot * (3 - 2 * tFoot);
        let y = lerp(noiseY, cfg.wallFootY, sFoot);
        // Mesa side: rise to the trench-rim plateau. The ramp is centered
        // on the wall CORE and spans ±rampHalf, so within a wall's run it
        // sits entirely inside the slab footprint (hidden by the rock);
        // past a wall TIP there is no rock to hide it, so the ramp widens
        // with overshoot and the headland sinks away as a gentle slope.
        if (q.mesaSign !== 0) {
          const lat = q.mesaSign * q.lat; // + = toward the mesa side
          const rampHalf = q.hw + cfg.mesaTipSoften * q.overshoot;
          const tMesa = clamp((lat + rampHalf) / (2 * rampHalf), 0, 1);
          const sMesa = tMesa * tMesa * (3 - 2 * tMesa);
          y = lerp(y, cfg.mesaTopY + cfg.mesaAmplitude * noise, sMesa);
        }
        const o = (iz * n + ix) * 3;
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        const uo = (iz * n + ix) * 2;
        uvs[uo] = x / cfg.texture.tileSize;
        uvs[uo + 1] = z / cfg.texture.tileSize;
      }
    }

    // ── Indices: alternating quad diagonals (diamond pattern — an aligned
    // diagonal reads as corduroy across a whole landscape). WINDING: Babylon's
    // front face is COUNTER-clockwise in the (x-right, z-up) plane viewed from
    // +Y (the CreateGround convention) — wind the wrong way and the whole
    // landscape is back-face-culled from above, i.e. invisible. ─────────────
    const indices: number[] = [];
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const a = iz * n + ix;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        if ((ix + iz) % 2 === 0) {
          indices.push(a, b, c, b, d, c);
        } else {
          indices.push(a, d, c, a, b, d);
        }
      }
    }

    const mesh = new Mesh("planetTerrain", scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.uvs = uvs;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh);

    // Textured mode stops here: SMOOTH shading under the image (facet creases
    // fighting a photographic tile read as glitches, not style).
    if (textured) return mesh;

    // Texture-less mode: the faceted procedural look — flat shading, then
    // per-face height-banded palette + tonal jitter (after flat shading every
    // face owns 3 consecutive verts).
    mesh.convertToFlatShadedMesh();
    const flat = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (flat) {
      const lo = cfg.paletteLow;
      const hi = cfg.paletteHigh;
      const yMin = cfg.baseY - cfg.amplitude;
      const ySpan =
        Math.max(cfg.wallFootY, cfg.baseY + cfg.amplitude, cfg.mesaTopY) - yMin;
      const vertCount = flat.length / 3;
      const colors = new Float32Array(vertCount * 4);
      for (let v = 0; v < vertCount; v += 3) {
        // Band by the face's mean height: valleys dark, crests sunstruck.
        const yAvg =
          (flat[v * 3 + 1] + flat[(v + 1) * 3 + 1] + flat[(v + 2) * 3 + 1]) / 3;
        const band = clamp((yAvg - yMin) / ySpan, 0, 1);
        const jitter = 1 - Math.random() * cfg.faceTintJitter;
        const r = lerp(lo.r, hi.r, band) * jitter;
        const g = lerp(lo.g, hi.g, band) * jitter;
        const b = lerp(lo.b, hi.b, band) * jitter;
        for (let k = 0; k < 3 && v + k < vertCount; k++) {
          const o = (v + k) * 4;
          colors[o] = r;
          colors[o + 1] = g;
          colors[o + 2] = b;
          colors[o + 3] = 1;
        }
      }
      mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    }
    return mesh;
  }
}
