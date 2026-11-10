// Fit symmetric collision boxes to a footprint.json (from footprint.mjs).
//   node fitboxes.mjs fp.json [closeR=6] [coverage=0.985] [minArea=12]
// Closing (dilate→erode, radius closeR cells) fills slots narrower than ~2·closeR so fighters can't wedge into them.
import fs from 'node:fs';
const [f, R = '6', COV = '0.985', MINA = '12'] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(f)); const { W, H, x0, z0, cell } = g;
let m = g.top.map((v) => v !== null);
// symmetric about x = 0
const ix = (x) => Math.round((x - x0) / cell - 0.5);
const xc = (i) => x0 + (i + 0.5) * cell;
const mir = (i) => ix(-xc(i));
m = m.map((v, k) => { const i = k % W, j = (k / W) | 0, mi = mir(i); return v || (mi >= 0 && mi < W && g.top[j * W + mi] !== null); });
const morph = (a, r, dil) => { const o = new Array(W * H); for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  let hit = !dil; for (let dj = -r; dj <= r && hit !== dil; dj++) for (let di = -r; di <= r; di++) { if (di * di + dj * dj > r * r) continue;
    const ii = i + di, jj = j + dj, v = ii >= 0 && jj >= 0 && ii < W && jj < H && a[jj * W + ii]; if (dil ? v : !v) { hit = dil; break; } }
  o[j * W + i] = hit; } return o; };
const r = +R; if (r > 0) m = morph(morph(m, r, true), r, false);
// open (erode→dilate, r=1) to drop 1-cell slivers (antennas, nav strips)
m = morph(morph(m, 1, false), 1, true);
const total = m.filter(Boolean).length;
// greedy largest-rectangle on the uncovered mask, mirrored pairs
const cov = new Array(W * H).fill(false); const boxes = []; let covered = 0;
const largest = () => { // maximal rectangle of (m && !cov) via histogram method
  const h = new Array(W).fill(0); let best = { a: 0 };
  for (let j = 0; j < H; j++) { for (let i = 0; i < W; i++) h[i] = m[j * W + i] && !cov[j * W + i] ? h[i] + 1 : 0;
    const st = []; for (let i = 0; i <= W; i++) { const hh = i < W ? h[i] : 0; let s = i;
      while (st.length && st[st.length - 1][1] >= hh) { const [si, sh] = st.pop(); const a = sh * (i - si); if (a > best.a) best = { a, i0: si, i1: i - 1, j0: j - sh + 1, j1: j }; s = si; }
      st.push([s, hh]); } }
  return best; };
const fill = (b) => { let n = 0; for (let j = b.j0; j <= b.j1; j++) for (let i = b.i0; i <= b.i1; i++) { const k = j * W + i; if (m[k] && !cov[k]) { cov[k] = true; n++; } } return n; };
while (covered / total < +COV) {
  const b = largest(); if (b.a < +MINA) break;
  covered += fill(b); boxes.push(b);
  const mb = { i0: mir(b.i1), i1: mir(b.i0), j0: b.j0, j1: b.j1 };   // mirror twin unless it overlaps itself
  if (mb.i0 > b.i1 || mb.i1 < b.i0) { covered += fill(mb); boxes.push(mb); }
}
const out = boxes.map((b) => {
  let ylo = Infinity, yhi = -Infinity;
  for (let j = b.j0; j <= b.j1; j++) for (let i = b.i0; i <= b.i1; i++) { const k = j * W + i; if (g.top[k] !== null) { yhi = Math.max(yhi, g.top[k]); ylo = Math.min(ylo, g.bot[k]); } }
  if (!isFinite(yhi)) { ylo = -5; yhi = 5; }
  const X0 = x0 + b.i0 * cell, X1 = x0 + (b.i1 + 1) * cell, Z0 = z0 + b.j0 * cell, Z1 = z0 + (b.j1 + 1) * cell;
  const r1 = (v) => Math.round(v * 10) / 10;
  if (X0 < 0 && X1 > 0) { const hx = Math.max(-X0, X1); return { cx: 0, cy: r1((ylo + yhi) / 2), cz: r1((Z0 + Z1) / 2), hx: r1(hx), hy: r1((yhi - ylo) / 2), hz: r1((Z1 - Z0) / 2) }; }
  return { cx: r1((X0 + X1) / 2), cy: r1((ylo + yhi) / 2), cz: r1((Z0 + Z1) / 2), hx: r1((X1 - X0) / 2), hy: r1((yhi - ylo) / 2), hz: r1((Z1 - Z0) / 2) };
});
console.error(`${boxes.length} boxes cover ${(100 * covered / total).toFixed(1)}% of ${total} cells`);
console.log(JSON.stringify(out));
