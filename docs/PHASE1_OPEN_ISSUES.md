# Phase 1/2 — status + handoff notes

Snapshot for resuming the multiplayer work. Branch: **`feat/phase1-multiplayer`**
(not yet merged to `main`). Everything builds + typechecks; the full test suite
is **10/10 green** (`npm test`). PROTOCOL_VERSION is **8** — stale tabs get a
clean join rejection (now rendered as "NEW VERSION — refresh"), so always
reload after pulling.

## How to run / reproduce

```bash
npm run server     # Colyseus on :2567 (tsx watch — restarts on code change)
npm run dev        # Vite client on :5173
```
Open `http://localhost:5173/?online`, pick side + ship, PLAY. No `?online` =
the normal offline single-player game (works fine).

See `docs/PHASE1_TWOTAB_CHECKLIST.md` for the full acceptance checklist.

## STATE AS OF 2026-07-04 (end of the owner-playtest session)

Solo-online is **playable and feels close to single-player**. Confirmed by
owner playtest this session, in order fixed:

- **Jitter** — root cause sim(30Hz)/patch(20Hz) aliasing + arrival-time
  interpolation; fixed by interpolating on the replicated sim clock
  (`state.timeMs`).
- **Opening launch** — gated on the first client's MSG.ready (fleets park in
  the tubes until someone can watch); headless launch bays re-fit to the GLB
  `launch.*` empties via `GameConfig.mothership.measuredLaunch` (the measure
  script prints them now — re-fit after any carrier re-export).
- **FX + sound event replication** — combat is visible/audible online
  (bolts, missiles, explosions, jump FX, turrets, full SoundSystem, trauma).
- **Client prediction + reconciliation** — own ship answers input instantly;
  own weapon FIRE is predicted too (muzzle-true at speed, steady cadence —
  weapon cooldowns are exempt from rewind/replay).
- **Engine FX** — per-marker engine glow + trails on all ships, RCS plumes on
  own ship, trail flush on teleports.
- **Asteroid field replicated** (spawn-state-only; client integrates
  deterministically) + local collision prediction vs rocks AND carrier hulls
  — the "invisible wall" rubber-banding is gone.
- **MP HUD slice DONE** (same session, after the playtest — NOT yet
  owner-verified in browser): full HUD parity online. See "RESOLVED — MP HUD
  slice" below for what shipped and how.

**Offline single-player remains unaffected** (smoke baseline recaptured once,
intentionally, for the bay re-fit; the collision-helper extraction was proven
behavior-identical by the untouched baseline).

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

## RESOLVED — no visible launch in MP (fixed 2026-07-04, two rounds)

Round 1: a fixed pre-launch hold (`launch.mpHoldSec`) — insufficient, because
the hold started at room creation and a cold client spends longer loading
GLBs. Round 2 (the real fix): rooms park both fleets in their tubes
indefinitely; the client sends **MSG.ready** once loaded + rendering, and the
first ready restages the launch with `mpHoldSec` (now 3s of pure watch time;
20s safety timer). ALSO: the headless server was staging ships at the STALE
procedural bay coordinates — launch-geometry truth was browser-only (GLB
`launch.*` empties). Fixed via `GameConfig.mothership.measuredLaunch` (baked
by the measure script; the sim Mothership seeds itself from it).

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

## RESOLVED — MP HUD slice (built 2026-07-04, awaiting owner playtest)

Everything the offline HUD shows now works online:

- **Kills/score/best**: the server keeps a last-hit-by ledger per ship
  (`BattleRoom.lastHitBy`, fed by the hit relays) and stamps `shipDied.by`;
  the client tallies own kills (score = victim maxHp, shared
  `space-duel-best-score` localStorage best) vs wing kills. End banner
  carries the stats line, and ENTER-restart / ESC-menu / M-mute now work
  online (NetworkGame.onKeyDown).
- **Radar + stealth + sig cue + lock cue via a CLIENT-SIDE sensor picture**:
  `ShadowShip` stubs mirror each replicated ship's rendered pose into a
  shared `SensorSystem` (concealment zones are pure config math, so the
  picture matches the server's AI). Radar = offline behavior (friendly
  truth, hostile fresh dots/ghost rings, nebula discs, rocks, spool rings)
  + white halo rings on human-piloted blips; HUD gets DETECTED/HIDDEN and
  the lock cue (client mirror of the lock rule). CombatNebulas visuals now
  render online too.
- **Missiles are honest**: `missileFired` carries the lock target id, so
  cosmetic rounds HOME on the target's interpolated pose (ballistic-remote
  gap closed) and the RWR (MissileWarning: beep ramp + border pulse + radar
  threat blips) hears seekers on YOU. Server-side fix included: human seats
  now get a real launch lock (`BattleSim.computeLockFor`, the sim mirror of
  `Game.computeLockTarget`) — previously every networked player missile
  launched ballistic.
- **Pilot counts**: HUD `pilots` row (`N human · M ai`), hidden offline,
  re-derived every patch (join/leave swaps seats live).
- **Protocol mismatch** now renders "NEW VERSION — refresh the page" (keyed
  to PROTOCOL_MISMATCH); other failures keep "server unavailable".

**Sensor-filtering decision (the one flagged last session): the MP radar
runs on a client-side sensor picture** — full state still replicates, so
nebula stealth is honest UI but NOT anti-wallhack. Fine for co-op vs AI;
server-side sensor-filtered replication stays a pre-deploy Phase 2 item.

## NEXT SESSION — suggested order

1. **Owner playtest of the HUD slice** (`?online`, solo): radar picture sane
   (ghosts age out, nebula hides hostiles, human halo = just you), RWR beeps
   when a missile chases you and NOT when it chases a wingman, kills/score
   tally, lock cue lights inside range/cone, pilots row reads 1 human.
   Known non-bugs: **no hitstop online** (deliberate); remote engine glow
   rides a speed proxy, not real thrust input. Feel knobs in
   `GameConfig.net`; `window.__netGame` is the live debug handle.
2. **Phase 1 polish for real multiplayer entry**: splash **PLAY SOLO /
   PLAY ONLINE** buttons (currently the `?online` flag) + **WITH FRIENDS**
   invite link (`#join=<roomId>`); **friendly-side FleetCommander** escort
   wings on the human player (`setOrder` cover).
3. **`[human]` two-tab acceptance pass** (`docs/PHASE1_TWOTAB_CHECKLIST.md`)
   — second joiner takes a seat, both see each other move/fire (and each
   other's white radar halo), leave hands the seat back to AI. Then
   **merge `feat/phase1-multiplayer`**.
4. Later (Phase 2 tail, pre-deploy): **sensor-filtered replication**
   (decided: client-side picture for now — see above; the server filter
   makes stealth anti-wallhack before any public deploy), clock-sync
   **debug overlay**, **network-condition simulator**, then Phase 3 (room
   lifecycle, reconnection, hosting).

## Architecture notes for whoever picks this up

- **Event replication pattern**: sim emits facts on `BattleSim.events`
  (SimEventBus) → `BattleRoom.wireEventRelay` serializes to `NetEvent`s
  (ships → schema ids, Vector3 → coords) → batched per tick as
  `EventsMessage{t}` → client queues and plays each when the render clock
  reaches `t` (`NetworkGame.applyFxEvent`). Own weapon fire is the exception:
  predicted at the keypress, server echo dropped.
- **Clocks**: `state.timeMs` is THE timeline. Snapshots, FX events, and the
  replicated asteroid spawn states all live on it; the client maintains one
  EMA wall↔sim offset. Never timestamp by arrival.
- **Prediction**: sequenced inputs, `lastInputSeq` ack, rewind+replay with a
  decaying correction offset; weapon cooldowns are exempt from replay
  (cadence is real-time state); collisions vs replicated rocks + carrier
  hull sections use the SAME exported helpers the server runs
  (`collideShipWithAsteroid` / `bumpShipOutOfSection` in BattleSim.ts).
- **Asteroids replicate by spawn state only** (constant drift/spin ⇒ the
  client integrates exactly); life/death = map add/remove; local copies are
  made unkillable so cosmetic bolt damage can't desync them.
- **Carrier GLB re-export checklist grew**: re-run the measure script and
  re-fit BOTH `hullRects` AND `mothership.measuredLaunch`, and expect a
  smoke-baseline recapture if bays move.
- **Shadow roster pattern (MP HUD)**: `NetworkGame.shadows` holds one
  `ShadowShip` per replicated ship, fed the RENDERED pose each frame; every
  offline system that wants a `Ship` (SensorSystem, Radar, MissileWarning,
  cosmetic missile homing) reads the stubs `as Ship` — they carry exactly
  the fields those consumers touch (pose/life/jump-spool getters off the
  replicated spool events). New HUD feature? Extend the stub, don't fork
  the system.
