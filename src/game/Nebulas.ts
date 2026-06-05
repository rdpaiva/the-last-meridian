import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { NoiseProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/noiseProceduralTexture";
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import { GameConfig } from "./GameConfig";

/**
 * Subtle nebula backdrops rendered as large alpha-blended quads with a
 * NoiseProceduralTexture driving both emissive intensity and per-pixel
 * opacity. The dark areas of the noise become fully transparent so the
 * cloud edges fade naturally — no hard rectangular cuts.
 *
 * Each nebula uses a unique `time` offset to sample a different slice of
 * the underlying 3D Perlin field, so the four patches look distinct without
 * needing separate textures. animationSpeedFactor = 0 keeps them static.
 *
 * Palette is muted purple-violet on purpose — the user's chosen vibe.
 * Bump emissiveColor components above 1.0 if you want them to bloom more.
 */

const COLORS: Color3[] = [
  new Color3(0.45, 0.18, 0.65), // deep purple
  new Color3(0.4, 0.22, 0.55), // muted plum
  new Color3(0.3, 0.18, 0.6), // violet-indigo
  new Color3(0.5, 0.22, 0.5), // warm purple
];

const POSITIONS = [
  { xFrac: -0.5, zFrac: 0.4 },
  { xFrac: 0.6, zFrac: -0.3 },
  { xFrac: -0.3, zFrac: -0.7 },
  { xFrac: 0.4, zFrac: 0.8 },
];

export class Nebulas {
  constructor(scene: Scene, arenaHalfWidth: number, arenaHalfDepth: number) {
    const cfg = GameConfig.scenery.nebulas;

    for (let i = 0; i < cfg.count; i++) {
      const color = COLORS[i % COLORS.length];
      const pos = POSITIONS[i % POSITIONS.length];

      // Procedural noise — different `time` per nebula = different pattern.
      const noise = new NoiseProceduralTexture(
        `nebula_${i}_noise`,
        256,
        scene,
      );
      noise.octaves = 4;
      noise.persistence = 0.65;
      noise.brightness = 0.42;
      noise.animationSpeedFactor = 0;
      noise.time = i * 17.3;
      // Treat the texture's luminance as alpha so the dark areas of the
      // cloud read as fully transparent.
      noise.getAlphaFromRGB = true;

      const mat = new StandardMaterial(`nebula_${i}_mat`, scene);
      mat.emissiveTexture = noise;
      mat.opacityTexture = noise;
      mat.emissiveColor = color;
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.specularColor = new Color3(0, 0, 0);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.alpha = cfg.alpha;

      const quad = MeshBuilder.CreatePlane(
        `nebula_${i}`,
        { size: cfg.size },
        scene,
      );
      quad.position = new Vector3(
        pos.xFrac * arenaHalfWidth * 1.5,
        cfg.yLevel + (i % 2) * 2,
        pos.zFrac * arenaHalfDepth * 1.5,
      );
      // Default plane normal is +Z; rotate so it lies flat with normal +Y
      // (facing the camera above).
      quad.rotation.x = -Math.PI / 2;
      // Slight Z rotation per nebula so overlapping clouds break the eye's
      // tendency to read them as a single repeating pattern.
      quad.rotation.z = i * 0.7;
      quad.material = mat;
      quad.isPickable = false;
      // Render after other transparents in the scene.
      quad.alphaIndex = 100;
    }
  }
}
