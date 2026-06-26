import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Registers the builders used below.
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { FACTION_THEME, type Faction } from "@space-duel/shared";

/**
 * Builds a procedural AI fighter mesh, themed by faction (this is the old
 * EnemyShip.buildMesh, generalized). Crimson body + red "eye" for machines, a
 * cool blue variant for humans. The human *player's* ship still comes from
 * AssetLoader (the viper/GLB); this builder feeds AI fighters and any future
 * AI wingmen.
 *
 * Returns the root TransformNode; the engine box and nose "eye" are registered
 * with the GlowLayer so they bloom.
 */
export function buildFighterMesh(
  scene: Scene,
  glowLayer: GlowLayer,
  faction: Faction,
): TransformNode {
  const theme = FACTION_THEME[faction];
  const root = new TransformNode(`fighter_${faction}_root`, scene);

  // Body — cone, tip along local +Z (rotate +π/2 around X, same trick as the
  // player fallback in AssetLoader).
  const body = MeshBuilder.CreateCylinder(
    `fighter_${faction}_body`,
    { height: 1.6, diameterTop: 0, diameterBottom: 0.7, tessellation: 12 },
    scene,
  );
  body.rotation.x = Math.PI / 2;
  body.parent = root;

  const bodyMat = new StandardMaterial(`fighter_${faction}_body_mat`, scene);
  bodyMat.diffuseColor = theme.bodyColor;
  bodyMat.specularColor = new Color3(0.2, 0.1, 0.1);
  body.material = bodyMat;

  // Wings.
  const wingSpec = { width: 0.7, height: 0.08, depth: 0.6 };
  const wingL = MeshBuilder.CreateBox(`fighter_${faction}_wingL`, wingSpec, scene);
  wingL.position = new Vector3(-0.55, 0, -0.1);
  wingL.parent = root;

  const wingR = MeshBuilder.CreateBox(`fighter_${faction}_wingR`, wingSpec, scene);
  wingR.position = new Vector3(0.55, 0, -0.1);
  wingR.parent = root;

  const wingMat = new StandardMaterial(`fighter_${faction}_wing_mat`, scene);
  wingMat.diffuseColor = theme.wingColor;
  wingMat.specularColor = new Color3(0.1, 0.05, 0.05);
  wingL.material = wingMat;
  wingR.material = wingMat;

  // Engine — emissive box at the tail, glow-layer registered.
  const engine = MeshBuilder.CreateBox(
    `fighter_${faction}_engine`,
    { width: 0.4, height: 0.25, depth: 0.35 },
    scene,
  );
  engine.position = new Vector3(0, 0, -0.7);
  engine.parent = root;

  const engineMat = new StandardMaterial(`fighter_${faction}_engine_mat`, scene);
  engineMat.diffuseColor = new Color3(0, 0, 0);
  engineMat.specularColor = new Color3(0, 0, 0);
  engineMat.emissiveColor = theme.engineEmissive;
  engineMat.disableLighting = true;
  engine.material = engineMat;
  glowLayer.addIncludedOnlyMesh(engine);

  // "Eye" — small emissive sphere at the nose. Pure visual menace.
  const eye = MeshBuilder.CreateSphere(
    `fighter_${faction}_eye`,
    { diameter: 0.2, segments: 6 },
    scene,
  );
  eye.position = new Vector3(0, 0, 0.85);
  eye.parent = root;
  const eyeMat = new StandardMaterial(`fighter_${faction}_eye_mat`, scene);
  eyeMat.diffuseColor = new Color3(0, 0, 0);
  eyeMat.specularColor = new Color3(0, 0, 0);
  eyeMat.emissiveColor = theme.eyeEmissive;
  eyeMat.disableLighting = true;
  eye.material = eyeMat;
  glowLayer.addIncludedOnlyMesh(eye);

  return root;
}

/**
 * Picks a random arena position at least `minDistFromPlayer` from `avoidPos`.
 * (Moved verbatim from EnemyShip.randomSpawnPosition.)
 */
export function randomFighterSpawn(
  arenaHalfX: number,
  arenaHalfZ: number,
  avoidPos: Vector3,
  minDist = 28,
): { x: number; z: number } {
  for (let i = 0; i < 12; i++) {
    const x = (Math.random() * 2 - 1) * arenaHalfX * 0.85;
    const z = (Math.random() * 2 - 1) * arenaHalfZ * 0.85;
    const dx = x - avoidPos.x;
    const dz = z - avoidPos.z;
    if (Math.hypot(dx, dz) >= minDist) {
      return { x, z };
    }
  }
  return {
    x: -Math.sign(avoidPos.x || 1) * arenaHalfX * 0.7,
    z: -Math.sign(avoidPos.z || 1) * arenaHalfZ * 0.7,
  };
}
