// Top-down height map of a game GLB (file coords) → PNG + grid JSON, in GAME carrier-local units
// (× scale; Babylon z-flip + rotY π → bow = +z, x unchanged — the frame GameConfig.mothership colliders/mounts use).
//   node footprint.mjs carrier.glb out-prefix [scale=10.6] [cell=1]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
const [file, out, S = '10.6', C = '1'] = process.argv.slice(2); const scale = +S, cell = +C;
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
const root = doc.getRoot(); const scene = root.getDefaultScene() || root.listScenes()[0];
const tris = [];
scene.traverse((n) => {
  const m = n.getMesh(); if (!m) return; const M = n.getWorldMatrix();
  for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION'), idx = p.getIndices(); const v = [];
    for (let i = 0; i < pos.getCount(); i++) { const a = pos.getElement(i, []);
      const w = [0, 1, 2].map((k) => M[k] * a[0] + M[4 + k] * a[1] + M[8 + k] * a[2] + M[12 + k]);
      v.push([w[0] * scale, w[1] * scale, -w[2] * scale]); }   // glTF→Babylon z-flip + rotY π, scale → game carrier-local
    const N = idx ? idx.getCount() : pos.getCount();
    for (let i = 0; i < N; i += 3) tris.push([0, 1, 2].map((k) => v[idx ? idx.getScalar(i + k) : i + k]));
  }
});
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
for (const t of tris) for (const p of t) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
x0 = Math.floor(x0 / cell) * cell; z0 = Math.floor(z0 / cell) * cell;
const W = Math.ceil((x1 - x0) / cell) + 1, H = Math.ceil((z1 - z0) / cell) + 1;
const top = new Float32Array(W * H).fill(-Infinity), bot = new Float32Array(W * H).fill(Infinity);
// rasterize each triangle's X/Z footprint (sample-based: cell centres inside the triangle, plus its vertices)
for (const [a, b, c] of tris) {
  const ymax = Math.max(a[1], b[1], c[1]), ymin = Math.min(a[1], b[1], c[1]);
  const mark = (i, j, ytop, ybot) => { if (i < 0 || j < 0 || i >= W || j >= H) return; const k = j * W + i; top[k] = Math.max(top[k], ytop); bot[k] = Math.min(bot[k], ybot); };
  for (const p of [a, b, c]) mark(Math.floor((p[0] - x0) / cell), Math.floor((p[2] - z0) / cell), p[1], p[1]);
  const i0 = Math.floor((Math.min(a[0], b[0], c[0]) - x0) / cell), i1 = Math.floor((Math.max(a[0], b[0], c[0]) - x0) / cell);
  const j0 = Math.floor((Math.min(a[2], b[2], c[2]) - z0) / cell), j1 = Math.floor((Math.max(a[2], b[2], c[2]) - z0) / cell);
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]); if (Math.abs(d) < 1e-9) continue;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const px = x0 + (i + 0.5) * cell, pz = z0 + (j + 0.5) * cell;
    const l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / d, l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / d, l3 = 1 - l1 - l2;
    if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) mark(i, j, ymax, ymin);
  }
}
fs.writeFileSync(`${out}.json`, JSON.stringify({ x0, z0, cell, W, H, top: Array.from(top, (v) => (isFinite(v) ? +v.toFixed(2) : null)), bot: Array.from(bot, (v) => (isFinite(v) ? +v.toFixed(2) : null)) }));
// PNG: bow (+z) at the top, height as brightness
let ylo = Infinity, yhi = -Infinity; for (const v of top) if (isFinite(v)) { ylo = Math.min(ylo, v); yhi = Math.max(yhi, v); }
const px = Buffer.alloc(W * H * 3);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const v = top[j * W + i], o = ((H - 1 - j) * W + i) * 3;
  if (isFinite(v)) { const g = 60 + Math.round(195 * (v - ylo) / (yhi - ylo)); px[o] = g; px[o + 1] = g; px[o + 2] = g; } else { px[o] = 20; px[o + 1] = 10; px[o + 2] = 30; } }
await sharp(px, { raw: { width: W, height: H, channels: 3 } }).resize(W * 4, H * 4, { kernel: 'nearest' }).png().toFile(`${out}.png`);
console.log(`${file}: x ${x0.toFixed(1)}..${x1.toFixed(1)}  z ${z0.toFixed(1)}..${z1.toFixed(1)}  y ${ylo.toFixed(1)}..${yhi.toFixed(1)}  grid ${W}×${H}`);
