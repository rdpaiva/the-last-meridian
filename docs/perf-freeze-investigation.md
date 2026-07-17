# Periodic multi-second freeze on production — investigation record

**Status: OPEN — the coded fixes did NOT resolve it (see the 2026-07-17
update below). They live on branch `fix/prod-freeze` (`56837f2`) as
hygiene + rollback-able mitigation.**

## 2026-07-17 UPDATE — owner repro: the freeze happens LOCALLY, in SOLO mode

The owner reproduced the periodic freeze on a local dev run in solo play.
This re-ranks everything below (kept for the record):

- Solo has no server and no NetworkGame → **hypothesis 1 (server GC +
  swap) cannot explain the solo repro** and is no longer the best guess.
  The heap cap stays (free, still sane on a 1GB box) but is not THE fix.
- The local test ran the working tree WITH the client fixes → the
  GlowLayer leak + scoreboard cadence aren't the root cause either (the
  leak fix stays — it's real, just not this bug).
- The cause therefore lives in code shared by solo and online — the
  Babylon view stack, FX systems, sim/AI — or in the environment (GPU /
  driver / machine memory pressure), and the prod report may be the SAME
  client-side bug, not a server one.
- **Next evidence step (owner, ~60s):** DevTools → Performance tab →
  record across two freezes in a solo match. Read the gap:
  - Long **Major GC** bars filling it → allocation churn still, somewhere
    unfixed; follow with two heap snapshots 30s apart.
  - One long yellow **scripting** block → expand it; the function name at
    the bottom of the flame IS the bug. (A ~20–30s period could also be a
    periodic game event — e.g. AI jump-drive cycles — hitting a slow path.)
  - **Nothing at all** in the trace during the gap → compositor/GPU
    stall: check chrome://gpu, and try a run with the glow/bloom knobs
    zeroed in match settings to isolate the post pipeline.
- Worth one control run: does committed `main` (or `fix/prod-freeze`,
  without the strategic-layer WIP) freeze too? The prod report pre-dates
  M1/M2, but the local repro ran WITH the WIP in the tree — a clean-tree
  run rules the WIP in or out cheaply.

---

Original record below (pre-solo-repro ranking).
The droplet unit reinstall +
"Deploy game" + a live retest remain (owner steps).
Owner report (2026-07-17): on the production site
(the-last-meridian.com, online multiplayer), the game freezes for a few
seconds roughly every 20–30 seconds, then continues. Pre-dates the
strategic-layer work (M1/M2).

This doc is the work record for fixing it separately — findings from a
full code-analysis pass over committed HEAD (2026-07-17). Work item lives
in `docs/AGENT_KICKOFF.md` (the queue SOT); this file holds the detail.

---

## Key framing result

Every timer, interval, and sim cadence in the codebase was traced.
**Nothing in game logic runs on a ~20–30s period** — respawn delays are
1.5s/3s, music tracks are minutes long, `READY_SAFETY_MS` (20s) is
one-shot, and the dev netsim delay queue is inert in prod
(`GameConfig.net.sim.enabled = false`; `DelayQueue` is only fed when that
flag is true — `NetworkGame.ts` ~683/692). A clean 20–30s period mapping
to no game timer is the signature of **garbage-collection / memory
pressure**, not a logic bug.

## THE DISAMBIGUATING TEST (do this first, in-game)

During a freeze: **does your own ship still respond to thrust/turn?**

- **Yes — world freezes, own ship flies** → SERVER-side stall (the own
  ship runs on local prediction, `NetworkGame.updatePrediction`, which
  doesn't need server patches). → Hypothesis 1.
- **No — everything halts, then snaps** → CLIENT main-thread block (GC).
  → Hypothesis 2 becomes primary.

## Hypothesis 1 (most likely): server event-loop stall — V8 major GC amplified by swap on the 1GB droplet

- The sim is single-threaded on `setSimulationInterval`
  (`server/src/rooms/BattleRoom.ts:205`); `step()` runs the whole 16-ship
  sim + `syncState` + per-client `syncClientViews` diffing + Colyseus
  encoding at 20Hz, allocating steadily. `server/src/index.ts` starts Node
  with **no `--max-old-space-size` / GC tuning**. On a 1GB box shared
  with Caddy + OS, a major GC that touches swapped-out pages blocks the
  event loop for SECONDS (in-RAM major GC would be 50–200ms; multi-second
  means paging).
- Why it matches: period = the allocation-fill cadence (roughly constant
  → roughly constant ~20–30s interval). When the loop stalls, patches
  stop → every client's interpolated world freezes; `MAX_CATCHUP_TICKS=3`
  (`BattleRoom.ts:72`) drops the lost time; on resume the client clock
  offset jumps >250ms and hard-resyncs (`NetworkGame.ts` ~838), snapping
  the world forward — exactly "freeze, then continues".
- **Confirm on the droplet** (ssh aliases in the owner's notes /
  `docs/DEPLOY.md`):
  - `vmstat 1` / `htop` during a match — do `si`/`so` (swap) spike in
    lockstep with each freeze? Node RSS vs 1GB?
  - Add `--trace-gc` to the systemd `ExecStart`, then
    `journalctl -u space-duel -f | grep -i 'mark-sweep'` — a
    multi-second Mark-sweep line at each freeze is the smoking gun.
  - `free -m`; check the unit for `MemoryMax`/swap config.
- **Minimal fix:** set `NODE_OPTIONS=--max-old-space-size=512` (or the
  actual working-set size) in the systemd unit so V8 collects before the
  OS swaps. Verify with `--trace-gc` that Mark-sweep drops under ~150ms.

## Hypothesis 2: client major GC — allocation churn + a REAL GlowLayer leak

Three compounding sources, all in the committed hot path:

1. **GlowLayer leak (confirmed by grep, fix regardless):** every FX mesh
   calls `glowLayer.addIncludedOnlyMesh(...)`
   (`client/src/game/ExplosionSystem.ts:94,113,150,165,177`;
   `EngineGlow.ts:138`; JumpFlashSystem) but **`removeIncludedOnlyMesh`
   is never called anywhere** — `Explosion.dispose()` /
   `JumpFlash.dispose()` only dispose the mesh. Babylon does not
   auto-prune disposed ids from the include list, so it grows for the
   whole match: heap growth + progressively heavier glow membership
   checks. Fix: pass the layer into the FX objects and remove on dispose.
2. **Per-frame allocation:** `NetworkGame.tick` calls `this.scoreRows()`
   **every frame unconditionally** (`NetworkGame.ts` ~1293) — a fresh
   array + ~16 row objects at 60fps. Fix: gate behind change detection or
   a low cadence. Also `{ ...this.input.state }` per input send (~1089).
3. **Combat mesh churn:** `ExplosionSystem.spawn/spawnSpark/
   spawnMuzzleFlash` build real per-instance geometry
   (`CreateSphere`/`CreateBox`) per hit/death and dispose it shortly
   after — allocation + GPU buffer churn. Fix later (pooling) if
   profiling says it matters.

**Confirm in the browser:** DevTools Performance recording across two
freezes — look for long Major GC bars filling the gap + a JS-heap
sawtooth dropping at each freeze. Heap snapshots 30s apart: climbing
`Geometry`/`Mesh` counts; a growing array retained by GlowLayer.
`window.__BABYLON_SCENE__` and `__netGame` are exposed for live checks
(`__BABYLON_SCENE__.meshes.length` climbing = leak).

## Hypothesis 3 (compounding, not root): burst-on-resume

After any stall, the client drains ALL now-past FX events in one frame
(`while` loop over `fxQueue`, `NetworkGame.ts` ~1238) — spawning meshes/
sounds on the same frame the clock hard-resyncs. Lengthens the perceived
freeze tail. Cheap smoothing: cap events applied per frame.

## Ruled out

- Server-side unbounded growth (`lastHitBy` deleted on death, rosters
  rebuilt in place, `pendingEvents` cleared per tick) — clean.
- Client `snaps` bounded; `localDetonations` pruned.
- MusicSystem track-change decode (cadence is minutes, not 20–30s).
- Dev netsim/DelayQueue (disabled in prod).

## Recommended work order

1. Run the disambiguating test + droplet `vmstat`/`--trace-gc` check.
2. Apply the droplet heap cap (likely THE fix; config-only, no deploy of
   game code).
3. Apply the two client fixes regardless (GlowLayer leak + scoreRows
   per-frame allocation) — they matter for long matches either way.
4. Optional: cap fxQueue drain per frame.

## What was applied (2026-07-17, this working tree)

All four items above are coded; typecheck + all 48 sim tests green.

- **Heap cap (hyp. 1):** `deploy/space-duel.service` now sets
  `Environment=NODE_OPTIONS=--max-old-space-size=512`. NOTE the deploy
  workflow does NOT ship unit files — reinstall by hand on the droplet
  (one-liner in the unit's header comment), then restart. Optionally add
  `--trace-gc` temporarily to verify Mark-sweep < ~150ms.
- **GlowLayer leak (hyp. 2.1):** new `client/src/game/GlowInclude.ts`
  exports `includeInGlow(glowLayer, mesh)` — adds to the include list and
  removes again via `onDisposeObservable`. All 20 former
  `addIncludedOnlyMesh` call sites across 10 files converted; a grep for
  `addIncludedOnlyMesh` outside GlowInclude.ts should stay empty. The
  leak was re-verified against the installed Babylon 7.54.3 source:
  `ThinEffectLayer` stores raw uniqueIds and only auto-prunes meshes
  registered through `referenceMeshToUseItsOwnMaterial` — the old code
  comments claiming "GlowLayer handles disposed meshes safely" were
  wrong (now corrected). Biggest offender was `spawnSpark` (~4–9 stale
  ids per laser hit, all match long).
- **scoreRows churn (hyp. 2.2):** `NetworkGame.tick` now rebuilds the
  scoreboard rows on a 500ms cadence (`SCOREBOARD_INTERVAL_MS`) instead
  of every frame. The `{ ...input.state }` per-send copy was left alone:
  30 small objects/sec is noise next to the above, and `pendingInputs`
  replay needs a stable snapshot anyway.
- **Burst-on-resume (hyp. 3):** fxQueue drain capped at 24 events/frame
  (`MAX_FX_EVENTS_PER_FRAME`); the remainder plays on following frames.
  Normal frames see 0–3 due events, so the cap only bites after a stall.
- Combat mesh churn (hyp. 2.3, pooling) intentionally NOT done — profile
  first if freezes persist after the above.

Still open: the disambiguating test + live confirmation. If freezes
persist with everything deployed, next probes are the droplet
`vmstat`/`--trace-gc` checks above and a DevTools performance recording.
