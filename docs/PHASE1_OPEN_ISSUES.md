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

## OPEN ISSUE 1 — online client jitter (PRIMARY, unresolved)

Ships/camera visibly jitter in the browser. **Not yet root-caused.** What we
know and tried:

- The server data is smooth (confirmed via headless probe), so it's a
  **client render / interpolation** problem, not the network feed.
- Attempt 1 (commit `89b5ba6`): exponential smoothing of poses toward the
  latest server value. User: no real improvement.
- Attempt 2 (commit `9b2840a`): proper **snapshot interpolation** —
  `NetworkGame` buffers timestamped poses per ship (`room.onStateChange`) and
  renders at `now - 110ms`, lerping between the two bracketing samples; server
  patch rate raised 15→20Hz. User: "didn't seem to fix anything."
- **Untested hypothesis: stale browser build.** Vite HMR doesn't cleanly swap a
  runtime-instantiated class like `NetworkGame`, so the tab may have been
  running pre-fix code across BOTH attempts. **First thing to try next session:
  hard-refresh (Cmd+Shift+R) and confirm whether the interpolation actually
  took effect** before assuming the code is wrong.
- If it's genuinely still jittery after a hard refresh, instrument it: expose
  `window.__netGame` (or a debug overlay) and sample `camera.position` + a ship
  mesh position across frames to see whether the jitter is the camera, the
  ship poses, or rotational. Candidate culprits if real: the camera velocity
  lead fed from interpolated-position deltas (`CameraRig.update` already
  double-smooths, but try passing zero velocity to rule it out); or the
  interpolation buffer timing.
- Relevant code: `client/src/game/NetworkGame.ts` (`recordSnapshot`,
  `sampleInto`, the `tick` camera block), `client/src/game/CameraRig.ts`.
- Owner-driven self-debugging note: the project owner runs the dev server and
  eyeballs in the browser himself (cloud/agent sessions should NOT drive the
  browser). Prepare instrumentation + a "what to look for" list for him instead.

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

1. Hard-refresh + confirm whether jitter persists with the interpolation code
   actually loaded. Instrument if needed. (Issue 1 — the real blocker.)
2. Phase 2 **FX + sound event replication** — makes combat visible/audible.
3. Local-ship **prediction** — makes your own flying feel immediate.
4. Then the Phase 1 polish list above, and merge `feat/phase1-multiplayer`.
