# Phase 1 — open issues / handoff notes

Snapshot for resuming the multiplayer work. Branch: **`feat/phase1-multiplayer`**
(not yet merged to `main`). Everything below builds + typechecks; the full test
suite is **9/9 green** (`npm test`). The blockers are all in the **online client
experience**, not the server.

## How to run / reproduce

```bash
npm run server     # Colyseus on :2567
npm run dev        # Vite client on :5173
```
Open `http://localhost:5173/?online`, pick side + ship, PLAY. No `?online` =
the normal offline single-player game (works fine).

See `docs/PHASE1_TWOTAB_CHECKLIST.md` for the full acceptance checklist.

## What is CONFIRMED WORKING

- **Server is correct.** Verified by joining the live server with a headless
  `@colyseus/sdk` client: the local player's ship is identified (`owner` =
  sessionId, `isAI: false`), all 14 ships replicate, positions update smoothly
  at ~20Hz, the match reaches `phase: "playing"`. The Node integration test
  (`tests/server/battleRoom.test.ts`) also passes (replication, sim advance,
  input-over-the-wire, protocol gate).
- **Offline single-player** is unaffected by all the restructure work.

## RESOLVED — online client jitter (fixed 2026-07-04)

**Root cause: sim/patch rate aliasing + arrival-time snapshot timestamps.**
The server sim runs at 30Hz but patches at 20Hz, so consecutive patches carry
alternating 1-or-2 sim ticks of motion (33ms vs 67ms worth) — while the client
timestamped snapshots by arrival time (~50ms apart). Interpolating on that
axis made apparent ship speed oscillate ±33% at 10Hz: a judder no amount of
arrival-time smoothing could fix, which is why attempts 1 (`89b5ba6`, pose
smoothing) and 2 (`9b2840a`, arrival-time snapshot interpolation) changed
nothing. The stale-HMR-build hypothesis was a red herring.

**Fix:** interpolate on the server sim-time axis. `BattleState.timeMs`
replicates accumulated sim time; `NetworkGame.recordSnapshot` timestamps
snapshots with it and maintains a smoothed wall↔sim clock offset (EMA,
hard-resync on >250ms jumps); render time = `now − offset − 110ms`.
Duplicate-sim-time patches are dropped. `PROTOCOL_VERSION` bumped to 2.
`window.__netGame` is now exposed for live netcode debugging. Confirmed
smooth in-browser by the owner.

## RESOLVED — no visible launch in MP (fixed 2026-07-04)

MP rooms started simulating at creation, before clients finished joining and
loading, so the whole fleet launched unseen (base hold was 0 with no cinematic
seat). Fixed: `GameConfig.launch.mpHoldSec` (4s) holds both fleets in their
tubes long enough for the first client to load and watch the catapults fire.

## NON-ISSUE — "background doesn't move, only stars"

The deep-space backdrop is a fixed full-screen 2D `Layer` by design (same in
offline play — see CLAUDE.md gotcha #9); only the in-world nebulas / capital
ships parallax and the starfield scrolls. Likely a misread, not a bug. Confirm
after the jitter fix.

## RESOLVED — the Phase 2 core gaps (both done 2026-07-04)

- **FX + sound event replication: DONE.** `BattleSim` owns a `SimEventBus`;
  `BattleRoom` broadcasts batched, sim-timestamped `NetEvent`s; `NetworkGame`
  plays each when the render clock reaches its sim time (cosmetic laser/
  missile pools, explosions, sparks, jump flash/ripple, full SoundSystem,
  distance-scaled camera trauma). Deliberate MP differences: no hitstop, no
  kill/score bookkeeping yet.
- **Local-ship prediction + reconciliation: DONE.** Sequenced inputs acked
  via `ShipSchema.lastInputSeq` (+ replicated `vx`/`vz`); shared `Ship` math
  runs locally each frame; rewind + replay on every patch with a decaying
  visual correction offset. Feel knobs live in `GameConfig.net` — the
  `[human]` feel-tuning loop (docs/MULTIPLAYER.md Phase 2) is still ahead.

## KNOWN GAPS — remaining (expected, not bugs)

- **Asteroids don't render online** (and their ram/shatter events aren't
  relayed): ships can visibly bump off invisible rocks on maps with dense
  fields. Needs asteroid replication.
- **Cosmetic missiles fly ballistic** (the lock target isn't on the wire);
  the detonation still lands at the server's true impact point.
- **No MP kills/score, radar, missile warning, HUD ship-HP cue.**

## REMAINING Phase 1 polish (deferred, low risk)

- Explicit splash **PLAY SOLO / PLAY ONLINE** buttons (currently the `?online`
  query flag) + **WITH FRIENDS** invite link (`#join=<roomId>`). Task #9.
- **Friendly-side FleetCommander** distributing AI as escort wings to humans
  (`setOrder` cover). Task #6. (Both factions currently get a standard
  commander.)
- HUD **human/AI counts + radar bot tags** (the honesty rule; `isAI` is already
  replicated). Client "new version — refresh" string keyed to the protocol
  mismatch code specifically.
- Per-type ship GLBs load in MP now; carrier GLB + turret models too.

## Suggested order to resume

1. ~~Jitter~~ — RESOLVED (see above).
2. ~~Phase 2 FX + sound event replication~~ — DONE 2026-07-04.
3. ~~Local-ship prediction~~ — DONE 2026-07-04.
4. Then the Phase 1 polish list above, and merge `feat/phase1-multiplayer`.
