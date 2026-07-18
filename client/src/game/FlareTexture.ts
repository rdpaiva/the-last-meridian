import type { Scene } from "@babylonjs/core/scene";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";

/**
 * A procedural soft radial "flare" sprite — white-hot core easing through a
 * warm halo to a fully transparent rim — drawn once onto a DynamicTexture.
 * Deliberately code-generated, not a repo asset (textures are user-authored;
 * this is math). Shared by every fire consumer: the BurnFX particle systems
 * and ExplosionSystem's flash billboards sample it so a "flash" reads as a
 * glow with falloff instead of a hard-edged expanding circle.
 *
 * The alpha channel carries the same gradient as the RGB, so it works both
 * additively (particles, ALPHA_ADD flares — alpha scales the added light)
 * and as an opacityTexture.
 */
export function createFlareTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const tex = new DynamicTexture(
    "fx_flare",
    { width: size, height: size },
    scene,
    false,
  );
  const ctx = tex.getContext();
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.22, "rgba(255,244,214,0.85)");
  gradient.addColorStop(0.55, "rgba(255,170,80,0.28)");
  gradient.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}
