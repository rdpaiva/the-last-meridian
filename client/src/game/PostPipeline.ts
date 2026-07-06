import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
// ACES tone-mapping constant lives on ImageProcessingConfiguration.
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";

import { GameConfig } from "@space-duel/shared";

/**
 * Build the full-frame post pipeline: ACES tone mapping + FXAA. No-op if
 * disabled in config. HDR target (`true`) so the tone-mapper has float
 * headroom to roll off the >1.0 emissive highlights instead of clipping. This
 * runs AFTER the GlowLayer's per-mesh bloom — both passes coexist: glow blooms
 * individual emissive meshes, this tone-maps + antialiases the composite.
 *
 * Shared by BOTH game clients (offline `Game` and online `NetworkGame`) so the
 * two modes grade identically — a mode-local copy is exactly how the colors
 * drifted apart once already.
 *
 * The pipeline self-registers with the scene's render-pipeline manager, so no
 * handle is kept (same fire-and-forget pattern as Nebulas/CapitalShips).
 */
export function buildPostPipeline(scene: Scene, camera: Camera): void {
  const cfg = GameConfig.postProcess;
  if (!cfg.enabled) return;

  const pipeline = new DefaultRenderingPipeline(
    "post",
    true, // HDR: float texture, needed for tone mapping to have headroom
    scene,
    [camera],
  );

  // We only want tone mapping + FXAA here; the DefaultRenderingPipeline's own
  // bloom stays off (the GlowLayer already owns bloom).
  pipeline.bloomEnabled = false;
  pipeline.fxaaEnabled = cfg.fxaa;

  const ip = pipeline.imageProcessing;
  ip.toneMappingEnabled = cfg.toneMapping;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  // exposure + contrast counter ACES lifting the dark backdrop: pull the
  // global level down and deepen shadows so the fighters keep their contrast.
  ip.exposure = cfg.exposure;
  ip.contrast = cfg.contrast;

  // Black multiply vignette: darkens the frame edges (where the bright nebulas
  // sit) and frames the action toward center. Multiply blend with the default
  // black vignetteColor just attenuates the corners.
  ip.vignetteEnabled = cfg.vignette;
  ip.vignetteWeight = cfg.vignetteWeight;
  ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
}
