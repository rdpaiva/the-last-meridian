// Bakes the wreck colliders for GameConfig.hulk.colliders from the wreck GLBs —
// the collider analogue of measure-carrier-footprint.mjs. A single symmetric
// hullRect can't capture a concave hull (the Aegis trident's prongs have a big
// empty gap between them), so we cluster the model's PARTS into lateral lanes
// (k-means on each part's X centre — finds the two prongs/sponsons vs. the
// spine) and emit one tight oriented box per lane.
//
// Run from the repo root:  node scripts/measure-hulk-colliders.mjs
// Then paste the printed arrays into GameConfig.hulk.colliders. Visualize/tune
// with the green debug overlay (window.__showHulkColliders(true)).
//
// Output frame matches hullRects: the GLB is parked with the model correction
// (rotY=π, scale 10.6), so world coords are the game's collision frame; the
// hulk's own `scale` is applied on top at runtime.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import "@babylonjs/loaders/glTF/index.js";
import fs from "node:fs";

const engine = new NullEngine();
const CONFIG = { rotX: 0, rotY: Math.PI, rotZ: 0, scale: 10.6 }; // GameConfig.hulk.model
const LANES = 3; // prong / spine / prong

const FILES = { humans: "aegis_wreck.glb", machines: "choirship_wreck.glb" };
const out = {};

for (const [faction, file] of Object.entries(FILES)) {
  const scene = new Scene(engine);
  const b64 = fs.readFileSync("public/models/" + file).toString("base64");
  const result = await SceneLoader.ImportMeshAsync(
    "", "", "data:;base64," + b64, scene, undefined, ".glb",
  );
  const root = new TransformNode("root", scene);
  const modelRoot = new TransformNode("model", scene);
  const gltfRoot = result.transformNodes.find((n) => n.name === "__root__");
  if (gltfRoot) gltfRoot.parent = modelRoot;
  else for (const m of result.meshes) if (m.parent === null) m.parent = modelRoot;
  modelRoot.rotation.set(CONFIG.rotX, CONFIG.rotY, CONFIG.rotZ);
  modelRoot.scaling.setAll(CONFIG.scale);
  modelRoot.parent = root;
  root.computeWorldMatrix(true);

  // Per-part world AABB.
  const parts = [];
  for (const m of result.meshes) {
    if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    const b = {
      minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
      minZ: Infinity, maxZ: -Infinity,
    };
    for (const v of bb.vectorsWorld) {
      b.minX = Math.min(b.minX, v.x); b.maxX = Math.max(b.maxX, v.x);
      b.minY = Math.min(b.minY, v.y); b.maxY = Math.max(b.maxY, v.y);
      b.minZ = Math.min(b.minZ, v.z); b.maxZ = Math.max(b.maxZ, v.z);
    }
    b.cxPart = (b.minX + b.maxX) / 2;
    parts.push(b);
  }

  // k-means (1-D, on part X centre) seeded across the beam → lateral lanes.
  const maxAbsX = Math.max(...parts.map((p) => Math.abs(p.cxPart)));
  let centers = [-maxAbsX, 0, maxAbsX].slice(0, LANES);
  for (let iter = 0; iter < 12; iter++) {
    const sums = new Array(centers.length).fill(0);
    const counts = new Array(centers.length).fill(0);
    for (const p of parts) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = Math.abs(p.cxPart - centers[i]);
        if (d < bd) { bd = d; bi = i; }
      }
      p.lane = bi;
      sums[bi] += p.cxPart; counts[bi] += 1;
    }
    for (let i = 0; i < centers.length; i++) {
      if (counts[i]) centers[i] = sums[i] / counts[i];
    }
  }

  // Union each lane's parts → one box; drop empty lanes.
  const boxes = [];
  for (let lane = 0; lane < centers.length; lane++) {
    const ps = parts.filter((p) => p.lane === lane);
    if (ps.length === 0) continue;
    const u = {
      minX: Math.min(...ps.map((p) => p.minX)), maxX: Math.max(...ps.map((p) => p.maxX)),
      minY: Math.min(...ps.map((p) => p.minY)), maxY: Math.max(...ps.map((p) => p.maxY)),
      minZ: Math.min(...ps.map((p) => p.minZ)), maxZ: Math.max(...ps.map((p) => p.maxZ)),
    };
    boxes.push({
      cx: +((u.minX + u.maxX) / 2).toFixed(1),
      cy: +((u.minY + u.maxY) / 2).toFixed(1),
      cz: +((u.minZ + u.maxZ) / 2).toFixed(1),
      hx: +((u.maxX - u.minX) / 2).toFixed(1),
      hy: +((u.maxY - u.minY) / 2).toFixed(1),
      hz: +((u.maxZ - u.minZ) / 2).toFixed(1),
    });
  }
  boxes.sort((a, b) => a.cx - b.cx);
  out[faction] = boxes;
  console.log(`\n=== ${faction} (${file}) — ${parts.length} parts → ${boxes.length} boxes ===`);
}

const fmt = (boxes) =>
  boxes
    .map((b) => `        { cx: ${b.cx}, cy: ${b.cy}, cz: ${b.cz}, hx: ${b.hx}, hy: ${b.hy}, hz: ${b.hz} },`)
    .join("\n");
console.log("\n--- paste into GameConfig.hulk.colliders ---\n");
console.log(`      humans: [\n${fmt(out.humans)}\n      ],`);
console.log(`      machines: [\n${fmt(out.machines)}\n      ],`);

engine.dispose();
