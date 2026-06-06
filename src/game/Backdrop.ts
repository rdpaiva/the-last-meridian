import type { Scene } from "@babylonjs/core/scene";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Layer } from "@babylonjs/core/Layers/layer";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

import { GameConfig } from "./GameConfig";
import { clamp } from "./math";

/**
 * The deep-space backdrop image, rendered as a full-screen background `Layer`
 * rather than a 3D plane.
 *
 * Why a Layer and not a mesh: a large emissive ground/plane gets multiplied by
 * its emissive color and amplified by the GlowLayer, which washes a normal
 * photographic image out to white. A background Layer is a straight 2D blit
 * behind the whole scene — untouched by lighting, glow, or perspective — so the
 * image shows faithfully and fills the frame exactly.
 *
 * The 3D starfield / nebulas / capital ships still render in the scene pass on
 * top of this, so they parallax in front of the backdrop for depth.
 *
 * **Subtle parallax — done through the TEXTURE matrix, not the layer quad.**
 * A Layer has no world position, so it can't move with the camera on its own.
 * The naive fix — nudging `layer.offset` — is wrong: the layer shader applies
 * `offset` to `gl_Position`, so it slides the whole on-screen quad and exposes
 * the empty clear color behind it (a black bar at the leading edge).
 *
 * Instead we pan the texture's sampling window: the quad stays full-screen and
 * we shift `texture.uOffset/vOffset`. To have image to pan INTO, the texture is
 * zoomed in by `parallaxZoom` (`uScale/vScale < 1`), leaving an off-screen
 * margin on every side; the pan is clamped to half that margin so the texture
 * edge is never reached. Result: an impossibly-distant drift opposite the
 * ship's motion — the slowest layer in the scene — with no black bar, no seam,
 * and no wrapping. Since the arena is bounded the clamp is rarely hit; it's
 * just a guarantee. Set `parallaxFactor` to 0 to disable and pin it static.
 */
export class Backdrop {
  private readonly texture: Texture | null = null;
  /** Half the pan headroom (parallaxZoom / 2) — the clamp bound and center. */
  private readonly half: number = 0;

  constructor(scene: Scene) {
    if (!GameConfig.scenery.backdrop.enabled) return;

    const layer = new Layer("backdrop", "/textures/space-backdrop.jpg", scene, true);
    // `color` tints the blit (RGBA multiply). Dim slightly so the backdrop
    // reads as deep background and the gameplay layer stays dominant.
    const t = GameConfig.scenery.backdrop.tint;
    layer.color = new Color4(t, t, t, 1);

    const cfg = GameConfig.scenery.backdrop;
    // Layer constructs its image as a Texture (BaseTexture has no uOffset/uScale);
    // the cast unlocks the texture-matrix pan we drive in update().
    const tex = layer.texture as Texture | null;
    if (cfg.parallaxFactor !== 0 && tex) {
      // Zoom in to leave a pan margin on every side, then center the window.
      // Clamp addressing so an exactly-on-edge sample can't bleed/wrap.
      this.half = cfg.parallaxZoom / 2;
      tex.uScale = 1 - cfg.parallaxZoom;
      tex.vScale = 1 - cfg.parallaxZoom;
      tex.uOffset = this.half;
      tex.vOffset = this.half;
      tex.wrapU = Texture.CLAMP_ADDRESSMODE;
      tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.texture = tex;
    }
  }

  /**
   * Drift the backdrop a hair against the camera focus for a sense of depth.
   * `focus` is the camera's tracked target (X/Z on the play plane). No-op when
   * the backdrop is disabled or parallax is off (`parallaxFactor === 0`).
   *
   * uOffset increases → the sampling window slides right → image content
   * shifts LEFT on screen, matching the way fixed-world stars drift left as the
   * ship moves right. The clamp keeps the window inside [0,1] so no edge shows.
   */
  update(focus: Vector3): void {
    if (!this.texture) return;
    const factor = GameConfig.scenery.backdrop.parallaxFactor;
    this.texture.uOffset =
      this.half + clamp(focus.x * factor, -this.half, this.half);
    this.texture.vOffset =
      this.half + clamp(focus.z * factor, -this.half, this.half);
  }
}
