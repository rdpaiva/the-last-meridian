import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

/**
 * Add a mesh to a GlowLayer's include list AND remove it again when the mesh
 * is disposed. Always use this instead of calling `addIncludedOnlyMesh`
 * directly.
 *
 * Why: Babylon's include list stores mesh uniqueIds and does NOT prune them
 * on mesh dispose (verified against @babylonjs/core 7.54 — ThinEffectLayer
 * only auto-prunes meshes registered via referenceMeshToUseItsOwnMaterial).
 * Every transient FX mesh (impact sparks, explosion debris, muzzle flashes,
 * lightning bolts, jump flashes) that adds itself directly leaks a stale id
 * for the rest of the match: the list grows by thousands of entries, every
 * glow-pass `hasMesh` check is an indexOf over it, and it was a suspect in
 * the production periodic-freeze investigation
 * (docs/perf-freeze-investigation.md).
 */
export function includeInGlow(glowLayer: GlowLayer, mesh: Mesh): void {
  glowLayer.addIncludedOnlyMesh(mesh);
  // uniqueId is still readable during dispose, so removal-by-id works here.
  mesh.onDisposeObservable.addOnce(() => {
    glowLayer.removeIncludedOnlyMesh(mesh);
  });
}
