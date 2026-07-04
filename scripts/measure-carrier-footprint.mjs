// Measures each carrier GLB's world-space X/Z footprint exactly as the game
// builds it (Mothership.applyModel: glTF __root__ parked under a correction
// node with rotY=π, scale 10.6, root at rotY=0 = humans convention, bow
// toward +Z). Prints overall extents plus a Z-binned half-width profile.
//
// Run from the repo root:  node scripts/measure-carrier-footprint.mjs
//
// Use it whenever a carrier GLB is re-exported, to re-fit
// GameConfig.mothership.hullRects (the solid hull footprint) and verify
// the launch-exit invariant (forward circle reach < bow extent + 25).
// Keep CONFIG below in sync with GameConfig.mothership.model.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import "@babylonjs/loaders/glTF/index.js";
import fs from "node:fs";

const engine = new NullEngine();

const CONFIG = { rotX: 0, rotY: Math.PI, rotZ: 0, scale: 10.6 }; // GameConfig.mothership.model

for (const file of ["bastion_carrier.glb", "choirship.glb"]) {
  const scene = new Scene(engine);
  const b64 = fs.readFileSync("client/public/models/" + file).toString("base64");
  const result = await SceneLoader.ImportMeshAsync(
    "", "", "data:;base64," + b64, scene, undefined, ".glb",
  );

  // Replicate Mothership.applyModel with the carrier root at the origin,
  // rotation 0 (the humans carrier; machines is the same shape rotated π).
  const root = new TransformNode("carrier_root", scene);
  const modelRoot = new TransformNode("model_root", scene);
  const gltfRoot = result.transformNodes.find((n) => n.name === "__root__");
  if (gltfRoot) gltfRoot.parent = modelRoot;
  else for (const m of result.meshes) if (m.parent === null) m.parent = modelRoot;
  modelRoot.rotation.set(CONFIG.rotX, CONFIG.rotY, CONFIG.rotZ);
  modelRoot.scaling.setAll(CONFIG.scale);
  modelRoot.parent = root;
  root.computeWorldMatrix(true);

  // Collect every mesh's world AABB (the models are ~100+ small parts, so the
  // union of per-part boxes is a good approximation of the silhouette).
  const boxes = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const m of result.meshes) {
    if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    const b = {
      minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
      minY: Infinity, maxY: -Infinity,
    };
    for (const v of bb.vectorsWorld) {
      b.minX = Math.min(b.minX, v.x); b.maxX = Math.max(b.maxX, v.x);
      b.minZ = Math.min(b.minZ, v.z); b.maxZ = Math.max(b.maxZ, v.z);
      b.minY = Math.min(b.minY, v.y); b.maxY = Math.max(b.maxY, v.y);
    }
    boxes.push(b);
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
    minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ);
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
  }

  console.log(`\n=== ${file} (${boxes.length} parts) ===`);
  console.log(
    `X: ${minX.toFixed(1)} .. ${maxX.toFixed(1)}  (width ${(maxX - minX).toFixed(1)})`,
  );
  console.log(
    `Z: ${minZ.toFixed(1)} .. ${maxZ.toFixed(1)}  (length ${(maxZ - minZ).toFixed(1)}; bow=+Z)`,
  );
  console.log(
    `Y: ${minY.toFixed(1)} .. ${maxY.toFixed(1)}  (launch exit dist = maxZ+25 = ${(maxZ + 25).toFixed(1)})`,
  );

  // launch.* empties in carrier-LOCAL x/z (root at origin, rotation 0, so
  // world == local here) — the same capture MothershipView.captureLaunchMarkers
  // does in the browser. Paste these into GameConfig.mothership.measuredLaunch
  // so HEADLESS sims (Colyseus server, tests) stage launches in the same tubes
  // the loaded model shows.
  const bays = [];
  for (const n of result.transformNodes) {
    if (!n.name || !n.name.toLowerCase().startsWith("launch")) continue;
    n.computeWorldMatrix(true);
    const p = n.getAbsolutePosition();
    bays.push({ x: p.x, z: p.z });
  }
  bays.sort((a, b) => a.x - b.x);
  console.log(
    `launch.* empties (carrier-local, sorted by x): ` +
      (bays.length === 0
        ? "NONE"
        : bays.map((b) => `{ x: ${b.x.toFixed(1)}, z: ${b.z.toFixed(1)} }`).join(", ")),
  );

  // Z-binned half-width profile: for each 10-unit Z slice, the widest |x|
  // any part reaches. This is the top-down silhouette to fit circles to.
  const BIN = 10;
  const z0 = Math.floor(minZ / BIN) * BIN;
  const bins = Math.ceil((maxZ - z0) / BIN);
  const profile = new Array(bins).fill(0);
  for (const b of boxes) {
    const halfW = Math.max(Math.abs(b.minX), Math.abs(b.maxX));
    const i0 = Math.max(0, Math.floor((b.minZ - z0) / BIN));
    const i1 = Math.min(bins - 1, Math.floor((b.maxZ - z0) / BIN));
    for (let i = i0; i <= i1; i++) profile[i] = Math.max(profile[i], halfW);
  }
  console.log("Z-slice -> half-width:");
  for (let i = 0; i < bins; i++) {
    const z = z0 + i * BIN;
    const w = profile[i];
    console.log(
      `  z ${String(z).padStart(5)}..${String(z + BIN).padStart(4)}: ${w.toFixed(1).padStart(6)}  ${"#".repeat(Math.round(w / 3))}`,
    );
  }
  scene.dispose();
}

engine.dispose();
