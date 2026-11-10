import fs from 'node:fs';
const B = JSON.parse(fs.readFileSync(process.argv[2]));
const zs = [...new Set(B.flatMap((b) => [b.cz - b.hz, b.cz + b.hz]).map((v) => Math.round(v)))].sort((a, b) => a - b);
let rects = [];
for (let i = 0; i < zs.length - 1; i++) { const z0 = zs[i], z1 = zs[i + 1], m = (z0 + z1) / 2;
  const w = Math.max(0, ...B.filter((b) => b.cz - b.hz <= m && b.cz + b.hz >= m).map((b) => Math.abs(b.cx) + b.hx));
  if (w > 0) rects.push({ z0, z1, halfWidth: Math.ceil(w) }); }
const merged = []; for (const r of rects) { const p = merged[merged.length - 1];
  if (p && p.z1 === r.z0 && Math.abs(p.halfWidth - r.halfWidth) <= 2) { p.z1 = r.z1; p.halfWidth = Math.max(p.halfWidth, r.halfWidth); } else merged.push({ ...r }); }
console.log(JSON.stringify(merged));
