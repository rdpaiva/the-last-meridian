# Video masters (git-ignored)

The near-lossless renders the shipped web encodes are derived from. This
folder is in `.gitignore` — the masters are hundreds of MB and git would keep
every byte of every revision forever. Keep them here locally / in your own
backup; only the encodes under `client/public/videos/` are tracked.

## The intro film

| | |
|---|---|
| Master | `The Last Meridian Primer.mp4` — 1920×1080 @ 24 fps, ~20 Mbps H.264, 4:30, 644 MB |
| Shipped | `client/public/videos/meridian-primer.mp4` — same resolution, ~1.7 Mbps, 54 MB |
| Played by | `client/src/game/IntroCinematic.ts` (the splash's `intro` state) |
| Also on YouTube | https://youtu.be/6i8RlS3fEh8 |

Re-encode after a re-render:

```bash
ffmpeg -i "art/video/The Last Meridian Primer.mp4" \
  -c:v libx264 -crf 27 -preset slow -profile:v high -pix_fmt yuv420p \
  -c:a copy -movflags +faststart \
  client/public/videos/meridian-primer.mp4
```

Why these flags:

- **`-crf 27 -preset slow`** — the size/quality knob. CRF 23 gave 98 MB for
  this footage, CRF 27 gives 54 MB with no visible loss on soft, AI-rendered
  frames. Lower CRF = bigger and sharper; adjust here, not by rescaling.
- **`-c:a copy`** — the master's audio is already 125 kbps AAC. Re-encoding
  it would lose quality for no size win.
- **`-movflags +faststart`** — moves the `moov` atom to the front so the
  browser can start playing after the first few hundred KB instead of
  downloading the whole file. Non-negotiable for a streamed intro.
- **`-pix_fmt yuv420p` / `-profile:v high`** — the universally decodable
  combination. Anything else risks a black frame on some browser.

No `.webm` twin: H.264 plays everywhere, and shipping both would double the
repo and deploy cost to serve exactly one of the two per visitor. (The small
faction-portrait clips in the same folder do ship both — at 400 KB the
calculus is different.)
