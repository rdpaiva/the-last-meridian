// Film GLB → game GLB: scale to the game's footprint, drop parts the top-down camera never sees,
// simplify, shrink textures to WebP, quantize, and add the marker empties the game reads
// (thruster.* / muzzle.* / rcs.* for fighters).
//   node make-game-model.mjs spitfire
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsTransmission } from '@gltf-transform/extensions';
import { dedup, flatten, join, weld, simplify, prune, quantize, textureCompress, getBounds, resample, normals } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';

const FILM = '/Users/ryan/Projects/The Last Meridian/Video Series/Episode 01/Blender';
const MODELS = {
  spitfire: {
    src: `${FILM}/Spitfire Hero/Spitfire_v26.glb`,
    length: 3.85,                 // match the current game model's nose-to-tail length (units)
    drop: /• Cockpit • (?!Canopy_Frame)|^Screen_|^Button_|Cockpit_Tub|Cockpit_Panel/,  // cockpit interior (by material): invisible from above
    ratio: 0.3, error: 0.005,    // simplify target
    texSize: 512,
    solid: /Hardware/,            // small metal parts: flatten to one colour so they can be simplified hard
    solidRatio: 0.15,
    minPart: 0.025,               // drop parts whose size is under 2.5% of ship length (~1.5 px on screen)
    markers(film, s) {            // film-space positions (named parts) → scaled game positions
      const p = (n) => film(n).map((v) => v * s);
      const mz = p('Gun_Muzzle_1_PBR'), mzR = p('Gun_Muzzle_-1_PBR');
      const ex = ['Exhaust_Glow_+1_0_PBR', 'Exhaust_Glow_+1_1_PBR'].map(p), exR = ['Exhaust_Glow_-1_0_PBR', 'Exhaust_Glow_-1_1_PBR'].map(p);
      const avg = (a) => a[0].map((_, i) => (a[0][i] + a[1][i]) / 2);
      return { 'muzzle.L': mz, 'muzzle.R': mzR, 'thruster.L': avg(ex), 'thruster.R': avg(exR) };
    },
    rcs: true,
  },
  reaver: {
    // Film export is flat-split per face, so meshopt can't collapse it: decimate in Blender first
    // (decimate.py welds by position — UVs live on loops there — then collapses to 3.5%).
    src: new URL('./reaver_dec.glb', import.meta.url).pathname,
    center: true,
    paintGain: 2.5,               // film paint averages ~27/255 (studio-lit); the game pulls exposure down to keep space black
    selfLit: 0.12, metallic: 0.5,  // faint self-lit paint like the old game model; less metal so it isn't all reflection                 // film model's origin sits behind the bbox centre
    length: 9.1,                  // current game model's nose-to-tail length (cannon tips included)
    rotY: true,                   // film nose is -Z; the game's reaver.glb is nose +Z with rotY 0 in shipModels
    drop: /^$/,                   // no interior; parts are already merged by material
    ratio: 1, error: 0,
    texSize: 512,
    markers(film, s, box) {
      const cn = box('RV13 • portable Drives • Reaver_CTRL_Cannon_PORT'), cnR = box('RV13 • portable Drives • Reaver_CTRL_Cannon_STBD');
      const pd = box('RV13 • portable Hardware • Reaver_CTRL_GunPod_PORT'), pdR = box('RV13 • portable Hardware • Reaver_CTRL_GunPod_STBD');
      const ex = box('RV09 • recessed exhaust core • Reaver_ROOT');
      const tip = (b) => [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, b.lo[2]].map((v) => v * s);
      const q = (ex.hi[0] - ex.lo[0]) / 4, ey = (ex.lo[1] + ex.hi[1]) / 2, ez = ex.hi[2];
      return { 'muzzle.N1': tip(cn), 'muzzle.N2': tip(cnR), 'muzzle.W1': tip(pd), 'muzzle.W2': tip(pdR),
        'thruster.1': [-q, ey, ez].map((v) => v * s), 'thruster.2': [q, ey, ez].map((v) => v * s),
        // RCS: the old game model's placements (game units, pre-rotation: nose is -Z)
        'rcs.nose': [0, -0.15, -3], 'rcs.port': [1.7, 0, 0.6], 'rcs.stbd': [-1.7, 0, 0.6] };
    },
  },
  // Carriers: bow is -Z in the film AND in the game file (GameConfig.mothership.model rotY π turns it bow +Z).
  // Lengths match the old game carriers so hullLength / scale 10.6 / launch exits stay in the same range.
  aegis: {
    src: new URL('./aegis_dec.glb', import.meta.url).pathname,          // decimate.py … Aegis_v15.glb aegis_dec.glb 0.05
    out: 'bastion_carrier.glb',
    // Turrets on the outer flight pods' top deck (game carrier-local ±43, y 6.6, z −45/+50 → file coords).
    turrets: { 'turret.0': [4.057, 0.623, 4.245], 'turret.1': [4.057, 0.623, -4.717], 'turret.2': [-4.057, 0.623, 4.245], 'turret.3': [-4.057, 0.623, -4.717] },
    length: 25.8, center: 'z',
    paintGain: 1.7, selfLit: 0.2, metallic: 0.4,   // old carrier skins self-lit at 0.06–0.3; the game has little to reflect
    drop: /^$/, ratio: 1, error: 0, texSize: 1024,
    markers(film, s, box) {
      const door = (n) => { const b = box(`${n}_LaunchDoor • portable Structure`); return [(b.lo[0] + b.hi[0]) / 2 * s, 0, (b.lo[2] + b.hi[2]) / 2 * s]; };
      return { 'launch.0': door('Starboard'), 'launch.1': door('Port'), ...(this.turrets || {}) };
    },
  },
  choirship: {
    src: new URL('./choirship_dec.glb', import.meta.url).pathname,      // decimate.py … Choirship_v08.glb choirship_dec.glb 0.05
    out: 'choirship.glb',
    // Turrets on the side sponsons' top deck (game carrier-local ±54, y 12.9, z −95/−20 → file coords).
    turrets: { 'turret.0': [5.094, 1.217, 8.962], 'turret.1': [5.094, 1.217, 1.887], 'turret.2': [-5.094, 1.217, 8.962], 'turret.3': [-5.094, 1.217, 1.887] },
    length: 27.72, center: 'z',
    paintGain: 1.7, selfLit: 0.2,
    drop: /^$/, ratio: 1, error: 0, texSize: 1024,
    markers(film, s, box) {
      const door = (n) => { const b = box(`${n}_LaunchDoor • slate blue titanium armour`); return [(b.lo[0] + b.hi[0]) / 2 * s, 0, (b.lo[2] + b.hi[2]) / 2 * s]; };
      return { 'launch.0': door('Starboard'), 'launch.1': door('Port'), ...(this.turrets || {}) };
    },
  },
};

const name = process.argv[2];
const cfg = MODELS[name];
if (!cfg) throw new Error(`unknown model ${name}`);
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(cfg.src);
const root = doc.getRoot();
const scene = root.getDefaultScene() || root.listScenes()[0];
for (const sc of root.listScenes()) if (sc !== scene) sc.dispose();

// Positions of named parts, read before flattening (a part's position = its mesh-bounds centre).
const filmPos = (n) => {
  const node = root.listNodes().find((x) => x.getName() === n);
  if (!node) throw new Error(`no node ${n}`);
  if (!node.getMesh()) return node.getWorldTranslation();
  const M = node.getWorldMatrix(); // column-major
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const prim of node.getMesh().listPrimitives()) {
    const a = prim.getAttribute('POSITION'), mn = a.getMin([]), mx = a.getMax([]);
    for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]]) {
      const w = [0, 1, 2].map((i) => M[i] * x + M[4 + i] * y + M[8 + i] * z + M[12 + i]);
      w.forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
    }
  }
  return lo.map((v, i) => (v + hi[i]) / 2);
};

const filmBox = (n) => {
  const node = root.listNodes().find((x) => x.getName() === n);
  if (!node) throw new Error(`no node ${n}`);
  const M = node.getWorldMatrix(); const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const prim of node.getMesh().listPrimitives()) {
    const a = prim.getAttribute('POSITION'), mn = a.getMin([]), mx = a.getMax([]);
    for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]])
      [0, 1, 2].forEach((i) => { const v = M[i] * x + M[4 + i] * y + M[8 + i] * z + M[12 + i]; lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  }
  return { lo, hi };
};

const before = getBounds(scene);
const filmLen = before.max[2] - before.min[2];
const s = cfg.length / filmLen;
const markers = cfg.markers(filmPos, s, filmBox);
const c = cfg.center ? before.min.map((v, i) => i === 2 || (i === 0 && cfg.center !== 'z') ? (v + before.max[i]) / 2 : 0) : [0, 0, 0]; // never y: keep the film's flight-plane height
for (const k in markers) if (!/^(rcs|turret)\./.test(k)) markers[k] = markers[k].map((v, i) => v - c[i] * s); // rcs.* are given in game units
if (cfg.rotY) for (const k in markers) markers[k] = [-markers[k][0], markers[k][1], -markers[k][2]];

// 1. Drop invisible parts: cockpit interior (by material) and anything too small to see at game scale.
const partSize = (node) => { // world-space bbox diagonal of one mesh node
  const M = node.getWorldMatrix(); const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const prim of node.getMesh().listPrimitives()) {
    const a = prim.getAttribute('POSITION'), mn = a.getMin([]), mx = a.getMax([]);
    for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]])
      [0, 1, 2].forEach((i) => { const v = M[i] * x + M[4 + i] * y + M[8 + i] * z + M[12 + i]; lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  }
  return Math.hypot(...hi.map((v, i) => v - lo[i]));
};
let dropped = 0, tiny = 0;
for (const n of root.listNodes()) {
  const m = n.getMesh(); if (!m) continue;
  const mats = m.listPrimitives().map((p) => p.getMaterial()?.getName() || '');
  const glow = mats.some((x) => /exhaust|nav_light|light/i.test(x));
  if (mats.every((x) => cfg.drop.test(x))) { n.dispose(); dropped++; }
  else if (!glow && cfg.minPart && partSize(n) < cfg.minPart * filmLen) { n.dispose(); tiny++; }
}
// 2. Glass: transmission costs a refraction pass per frame in Babylon; a dark glossy canopy reads the same from above.
for (const mat of root.listMaterials()) {
  if (mat.getExtension('KHR_materials_transmission')) {
    mat.setExtension('KHR_materials_transmission', null);
    mat.setBaseColorFactor([0.05, 0.07, 0.1, 1]).setRoughnessFactor(0.08).setMetallicFactor(0.2);
  }
}
doc.createExtension(KHRMaterialsTransmission).dispose();

// 3. Scale the whole model into game units.
for (const n of scene.listChildren()) {
  n.setTranslation(n.getTranslation().map((v, i) => (v - c[i]) * s));
  n.setScale(n.getScale().map((v) => v * s));
  if (cfg.rotY) { // 180° about Y: q' = (0,1,0,0) * q ; t' = (-x, y, -z)
    const t = n.getTranslation(); n.setTranslation([-t[0], t[1], -t[2]]);
    const [x, y, z, w] = n.getRotation(); n.setRotation([z, w, -x, -y]);
  }
}

// 4. Geometry: bake transforms, merge by material, weld, simplify.
await doc.transform(
  dedup(), flatten(), join(), weld(),
  ...(cfg.ratio < 1 ? [simplify({ simplifier: MeshoptSimplifier, ratio: cfg.ratio, error: cfg.error })] : []),
  resample(), prune(), dedup(),
);

// 4b. Solid-colour parts: drop texture + per-face attributes, weld by position, simplify hard, smooth normals.
if (cfg.solid) {
  for (const mat of root.listMaterials().filter((m) => cfg.solid.test(m.getName()))) {
    const tex = mat.getBaseColorTexture();
    if (tex) {
      const { channels } = await sharp(Buffer.from(tex.getImage())).stats();
      const lin = (c) => Math.pow(c / 255, 2.2);
      mat.setBaseColorFactor([lin(channels[0].mean), lin(channels[1].mean), lin(channels[2].mean), 1]);
    }
    mat.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null).setOcclusionTexture(null);
    for (const m of root.listMeshes()) for (const p of m.listPrimitives()) if (p.getMaterial() === mat)
      for (const sem of ['NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1']) p.setAttribute(sem, null);
  }
  await doc.transform(prune(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: cfg.solidRatio, error: 0.01 }));
  await doc.transform(normals({ overwrite: false }));
}

// 4c. Readability under the game's lighting: a faint self-lit copy of the paint (like the old game models) and less metal.
if (cfg.paintGain) {
  const done = new Set();
  for (const mat of root.listMaterials()) {
    const tex = mat.getBaseColorTexture(); if (!tex || done.has(tex)) continue; done.add(tex);
    tex.setImage(new Uint8Array(await sharp(Buffer.from(tex.getImage())).linear(cfg.paintGain, 0).png().toBuffer())).setMimeType('image/png');
  }
}
if (cfg.selfLit) for (const mat of root.listMaterials()) {
  const tex = mat.getBaseColorTexture(); if (!tex || mat.getEmissiveTexture()) continue;
  mat.setEmissiveTexture(tex).setEmissiveFactor([cfg.selfLit, cfg.selfLit, cfg.selfLit]);
  if (cfg.metallic != null) mat.setMetallicFactor(cfg.metallic);
}

// 5. Textures → WebP at game size.
await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [cfg.texSize, cfg.texSize], quality: 82 }));

// 6. Markers (empties) the game reads.
const g = getBounds(scene);
if (cfg.rcs) {
  const halfSpan = (g.max[0] - g.min[0]) / 2;
  markers['rcs.nose'] = [0, 0, g.min[2] * 0.7];
  markers['rcs.port'] = [halfSpan * 0.75, 0, (g.min[2] + g.max[2]) / 2 + 0.35];
  markers['rcs.stbd'] = [-halfSpan * 0.75, 0, (g.min[2] + g.max[2]) / 2 + 0.35];
}
for (const [n, pos] of Object.entries(markers)) scene.addChild(doc.createNode(n).setTranslation(pos.map((v) => +v.toFixed(3))));

// Tangents: Babylon derives them from screen-space derivatives; storing them costs ~20% of the file.
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { const t = p.getAttribute('TANGENT'); if (t) { p.setAttribute('TANGENT', null); } }
await doc.transform(prune({ keepLeaves: true }));

// 7. Quantize vertex data (KHR_mesh_quantization, decoded natively by Babylon; no decoder download).
await doc.transform(quantize());

const out = process.argv[3] || `${name}.glb`;
await io.write(out, doc);
let tris = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
const sz = (x) => `${x.map((v) => v.toFixed(2)).join(' × ')}`;
console.log(`${name}: film ${sz(before.max.map((m, i) => m - before.min[i]))} → game ${sz(g.max.map((m, i) => m - g.min[i]))}`);
console.log(`dropped ${dropped} interior + ${tiny} tiny parts · ${root.listMeshes().length} meshes · ${Math.round(tris).toLocaleString()} tris · ${root.listTextures().length} textures · ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
console.log('markers', JSON.stringify(Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, v.map((x) => +x.toFixed(2))]))));
