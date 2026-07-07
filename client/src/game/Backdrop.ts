import type { Scene } from "@babylonjs/core/scene";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Layer } from "@babylonjs/core/Layers/layer";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

import { GameConfig } from "@space-duel/shared";
import { clamp } from "@space-duel/shared";

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
 * we shift `texture.uOffset/vOffset`. Result: an impossibly-distant drift
 * opposite the ship's motion — the slowest layer in the scene. Two modes keep
 * the texture edge from ever showing (`GameConfig.scenery.backdrop.parallaxMode`):
 *
 *   "clamp" — bounded-arena default. Zoom the texture in by `parallaxZoom`
 *             (`uScale/vScale < 1`) to leave an off-screen margin, then clamp
 *             the pan to half that margin with CLAMP addressing. No seam, works
 *             with any image; costs a slight edge crop.
 *   "wrap"  — unbounded-arena mode. No zoom; the offset grows freely and WRAP
 *             addressing tiles the texture. REQUIRES a seamless image. The pan
 *             can run forever without ever revealing an edge.
 *
 * Set `parallaxFactor` to 0 to disable and pin the backdrop static.
 */
export class Backdrop {
  private readonly texture: Texture | null = null;
  private readonly factor: number = 0;
  private readonly wrap: boolean = false;
  /**
   * "clamp" mode only: half the pan headroom (parallaxZoom / 2) — both the
   * clamp bound and the centered base offset. Zero in "wrap" mode.
   */
  private readonly half: number = 0;

  /**
   * `viewSign` is +1 for the default camera and -1 when the player's view is
   * flipped 180° (north-end pilot, see CameraRig). The parallax pan is a
   * SCREEN-space effect fed WORLD-space focus coordinates: under the flipped
   * camera, world +X moves the ship screen-LEFT, so the drift sign must flip
   * with it or the backdrop parallaxes the wrong way (moves WITH the ship).
   */
  constructor(scene: Scene, viewSign: 1 | -1 = 1) {
    if (!GameConfig.scenery.backdrop.enabled) return;

    const layer = new Layer("backdrop", `${import.meta.env.BASE_URL}textures/space-backdrop.jpg`, scene, true);
    // `color` tints the blit (RGBA multiply). Dim slightly so the backdrop
    // reads as deep background and the gameplay layer stays dominant.
    const t = GameConfig.scenery.backdrop.tint;
    layer.color = new Color4(t, t, t, 1);

    const cfg = GameConfig.scenery.backdrop;
    // Layer constructs its image as a Texture (BaseTexture has no uOffset/uScale);
    // the cast unlocks the texture-matrix pan we drive in update().
    const tex = layer.texture as Texture | null;
    if (cfg.parallaxFactor === 0 || !tex) return;

    this.texture = tex;
    this.factor = cfg.parallaxFactor * viewSign;
    this.wrap = cfg.parallaxMode === "wrap";

    if (this.wrap) {
      // Free-running offset; WRAP tiles the (seamless) image with no edge.
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
    } else {
      // Zoom in to leave a pan margin on every side, then center the window.
      // CLAMP addressing so an exactly-on-edge sample can't bleed/wrap.
      this.half = cfg.parallaxZoom / 2;
      tex.uScale = 1 - cfg.parallaxZoom;
      tex.vScale = 1 - cfg.parallaxZoom;
      tex.uOffset = this.half;
      tex.vOffset = this.half;
      tex.wrapU = Texture.CLAMP_ADDRESSMODE;
      tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    }
  }

  /**
   * Drift the backdrop a hair against the camera focus for a sense of depth.
   * `focus` is the camera's tracked target (X/Z on the play plane). No-op when
   * the backdrop is disabled or parallax is off (`parallaxFactor === 0`).
   *
   * uOffset increases → the sampling window slides right → image content
   * shifts LEFT on screen, matching the way fixed-world stars drift left as the
   * ship moves right. In "clamp" mode the pan is bounded to the zoom margin so
   * no edge shows; in "wrap" mode it runs free and the texture tiles.
   */
  update(focus: Vector3): void {
    if (!this.texture) return;
    if (this.wrap) {
      this.texture.uOffset = focus.x * this.factor;
      this.texture.vOffset = focus.z * this.factor;
    } else {
      this.texture.uOffset =
        this.half + clamp(focus.x * this.factor, -this.half, this.half);
      this.texture.vOffset =
        this.half + clamp(focus.z * this.factor, -this.half, this.half);
    }
  }
}
