import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import { GameConfig } from "./GameConfig";

/**
 * Painted nebula backdrops rendered as large alpha-blended quads. Each quad
 * uses one of the `public/textures/nebula-N.png` images, which carry their
 * own soft feathered alpha so the cloud edges fade naturally — no hard
 * rectangular cuts. The image color drives the emissive channel (so the
 * clouds glow / bloom) and the image alpha drives per-pixel opacity.
 *
 * Palette is muted purple-violet on purpose — the user's chosen vibe. The
 * art is shown as authored (white emissive tint); bump `EMISSIVE_TINT`
 * components above 1.0 if you want the clouds to bloom hotter.
 */

// The cloud PNGs come through the emissive channel as luminance/detail; the
// COLOR is supplied here per-nebula (an emissive-white tint would multiply the
// pale art straight to white — and bloom finishes the job). Keep these
// saturated and mid-deep so texture × color lands as rich gas, not white-out.
// Ordered by priority: GameConfig.scenery.nebulas.count takes the first N.
// The two leads are the most contrasting hues (cool blue-indigo + warm
// magenta); deep-purple and plum are parked after for when count goes back up.
// (plum's source had an edge artifact — kept last on purpose.)
const COLORS: Color3[] = [
  new Color3(0.2, 0.18, 0.75), // violet-indigo (bluest)
  new Color3(0.78, 0.18, 0.42), // warm magenta (pinkest)
  new Color3(0.45, 0.15, 0.62), // deep purple / violet
  new Color3(0.58, 0.2, 0.48), // plum (rosy)
];

// Painted cloud images (transparent PNGs), paired index-for-index with COLORS.
const TEXTURE_FILES = [
  "nebula-2-violet-indigo.png",
  "nebula-4-warm-magenta.png",
  "nebula-1-deep-purple.png",
  "nebula-3-plum.png",
];

// Fractions of (arenaHalf * 1.5). The first two are flung to opposite corners
// so the clouds sit far apart; the rest fill in if count is raised.
const POSITIONS = [
  { xFrac: -0.85, zFrac: 0.6 },
  { xFrac: 0.85, zFrac: -0.55 },
  { xFrac: 0.5, zFrac: 0.85 },
  { xFrac: -0.55, zFrac: -0.8 },
];

export class Nebulas {
  constructor(scene: Scene, arenaHalfWidth: number, arenaHalfDepth: number) {
    const cfg = GameConfig.scenery.nebulas;

    for (let i = 0; i < cfg.count; i++) {
      const pos = POSITIONS[i % POSITIONS.length];

      // One painted cloud per quad, wrapping the file list if needed.
      const file = TEXTURE_FILES[i % TEXTURE_FILES.length];
      const tex = new Texture(`/textures/${file}`, scene);
      tex.hasAlpha = true;

      const mat = new StandardMaterial(`nebula_${i}_mat`, scene);
      mat.emissiveTexture = tex;
      // opacityTexture pulls per-pixel opacity from the image's own alpha
      // channel (getAlphaFromRGB stays false), giving the soft feathered
      // edges baked into the PNG.
      mat.opacityTexture = tex;
      mat.emissiveColor = COLORS[i % COLORS.length];
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
