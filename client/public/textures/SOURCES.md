# Texture sources

Background art for the scenery layers.

## Files

| File | Used by | Notes |
|---|---|---|
| `nebula-1-deep-purple.png` | `Nebulas.ts` | Cloud sprite (parked; see count) |
| `nebula-2-violet-indigo.png` | `Nebulas.ts` | Cloud sprite (active) |
| `nebula-3-plum.png` | `Nebulas.ts` | Cloud sprite (parked) |
| `nebula-4-warm-magenta.png` | `Nebulas.ts` | Cloud sprite (active) |
| `space-backdrop.jpg` | `Backdrop.ts` | Full-screen deep-space background |

`Nebulas.ts` only renders the first `GameConfig.scenery.nebulas.count`
entries from its priority-ordered list; the rest are parked.

## Origin & processing

- Generated with an AI image generator (ChatGPT) as project placeholder art.
- Nebula PNGs were authored on a transparent background. Their RGB color is
  pale; in-engine the **color comes from `emissiveColor` in `Nebulas.ts`**,
  the texture supplies shape + alpha.
- The nebula PNGs were **premultiplied (RGB × alpha)** to remove a
  light/checkerboard halo that the original soft edges left when
  alpha-blended. If you re-export any cloud, premultiply it (or expect an
  edge fringe). Pre-premultiply originals were kept outside the repo during
  editing.

Replace any of these with your own art using the same filenames (or update
the lists in `Nebulas.ts` / the path in `Backdrop.ts`).
