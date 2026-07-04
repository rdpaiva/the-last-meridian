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

## OPEN ISSUE 2 — no visible launch in MP (minor, understood)

In multiplayer there's no cinematic launch: `BattleSim.assignInitialLaunches`
uses base hold = 0 when there's no cinematic seat (which MP rooms don't have),
so ships shoot out of the bay in the first ~2s, before the player is watching.
Single-player uses the slow `cinematicHoldSec` countdown. Fix direction: give MP
a short non-zero launch hold / a brief countdown so the launch reads, or mark
the local human's seat cinematic. Code: `shared/src/sim/BattleSim.ts`.

## NON-ISSUE — "background doesn't move, only stars"

The deep-space backdrop is a fixed full-screen 2D `Layer` by design (same in
offline play — see CLAUDE.md gotcha #9); only the in-world nebulas / capital
ships parallax and the starfield scrolls. Likely a misread, not a bug. Confirm
after the jitter fix.

## KNOWN GAPS — genuinely Phase 2 (expected, not bugs)

- **No weapons fire / explosions visible, no sound.** The client isn't told
  when shots fire. Needs the server→client **event replication** (Phase 2's
  first task): have `BattleRoom` subscribe to the sim's `SimEventBus` and relay
  `shipFiredLaser` / `laserHit` / `missileFired` / `shipDied` / explosion events
  as Colyseus messages; client plays SFX + spawns FX reusing
  `LaserSystemView` / `ExplosionSystem` / `SoundSystem`. **This is the biggest
  single step toward it feeling like a real game.**
- **Your own ship lags input ~110ms** (interpolation delay, no prediction).
  Phase 2 client-prediction + reconciliation hides it. Until then the local
  ship feels floaty — acceptable only as a stopgap.

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
2. Phase 2 **FX + sound event replication** — makes combat visible/audible.
3. Local-ship **prediction** — makes your own flying feel immediate.
4. Then the Phase 1 polish list above, and merge `feat/phase1-multiplayer`.
