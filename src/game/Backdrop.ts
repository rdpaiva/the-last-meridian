import type { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Layer } from "@babylonjs/core/Layers/layer";

import { GameConfig } from "./GameConfig";

/**
 * The deep-space backdrop image, rendered as a full-screen background `Layer`
 * rather than a 3D plane.
 *
 * Why a Layer and not a mesh: a large emissive ground/plane gets multiplied by
 * its emissive color and amplified by the GlowLayer, which washes a normal
 * photographic image out to white. A background Layer is a straight 2D blit
 * behind the whole scene — untouched by lighting, glow, or perspective — so the
 * image shows faithfully and fills the frame exactly (its colorful edges are
 * visible too, which a top-down 3D plane would push off-screen).
 *
 * The 3D starfield / nebulas / capital ships still render in the scene pass on
 * top of this, so they parallax in front of the static backdrop for depth.
 */
export class Backdrop {
  constructor(scene: Scene) {
    if (!GameConfig.scenery.backdrop.enabled) return;

    const layer = new Layer("backdrop", "/textures/space-backdrop.jpg", scene, true);
    // `color` tints the blit (RGBA multiply). Dim slightly so the backdrop
    // reads as deep background and the gameplay layer stays dominant.
    const t = GameConfig.scenery.backdrop.tint;
    layer.color = new Color4(t, t, t, 1);
  }
}
