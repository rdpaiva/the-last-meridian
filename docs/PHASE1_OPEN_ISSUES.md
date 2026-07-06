# Phase 1/2 — status + handoff notes

Snapshot for resuming the multiplayer work. Phases 1–2 core, the Phase 2
tail (netsim + overlay + sensor-filtered replication), AND the identity
slice (own-ship tint + callsigns/nameplates) are MERGED to `main`
(`5c162e8`, 2026-07-05, owner-verified); the PHASE 3 work below
(reconnection + hosting artifacts + room lifecycle + lobby polish) lives
on **`feat/reconnect-hosting`**. Everything builds + typechecks; the full
test suite is **20/20 green** (`npm test`). PROTOCOL_VERSION is **17** —
stale tabs get a clean join rejection (rendered as "NEW VERSION —
refresh"), so always reload after pulling.

## DONE 2026-07-06 — Phase 3 remainder: room lifecycle + lobby polish (`feat/reconnect-hosting`, awaiting owner check)

Phase 3 is now feature-complete; docs/MULTIPLAYER.md Phase 3 items are all
checked. Owner-verified the same session's earlier slice: reconnection
works in-browser (tab close → seat reclaimed), latency/jitter at
40–120ms + jitter felt as expected (feel-tuning loop parked — no knob
changes requested).

- **End-of-match room lifecycle** (`cf0a2a7`) — root-caused the owner's
  "Enter doesn't restart after Victory" finding: nothing ended the ROOM,
  so the Enter-reload's `#join=<roomId>` hash rejoined the same finished
  match and the banner just came back. Server: the `playing → ended`
  transition (`BattleRoom.step` → `onMatchEnded`) **locks** the room — a
  decided match accepts no new pilots (the staleness rule), so rematch
  quick-matches create FRESH rooms and stale invite joinByIds are refused
  (the client already degrades those to a quick match) — then **disposes**
  it after `GameConfig.net.endedRoomLingerSec` (new shared knob, 60s ⇒
  PROTOCOL 16→17) via `this.disconnect()`. Leaves after the end skip the
  reconnection seat-hold (`onLeave` treats them as consented — nothing to
  reclaim into, and a reservation would delay disposal). Client: Enter/Esc
  on the end banner clear the invite hash before reloading
  (`NetworkGame.clearInviteHash`), and `updatePhase` early-returns once
  `ended` — the room disconnecting under the banner is EXPECTED and may
  not repaint it as CONNECTION LOST. Friends rematch flow: both hit Enter
  → both quick-match → joinOrCreate lands them in the same fresh room.
  Integration test ("locks + disposes an ended match…"): forced win →
  lock + joinById refusal + fresh joinOrCreate room + reservation-free
  post-end drop + timed disposal kicking the banner-watcher.
- **Copy-invite-link key** (`fc3fcb8`): **I** in an online match copies
  the address bar (which IS the invite link) — dim MP-only HUD row
  (`Hud.showInviteHint`, pilots-row pattern) flashes LINK COPIED / COPY
  FAILED. Disabled after the end (room locked). Rejoin-last-match prompt
  DELIBERATELY skipped — reload keeps the hash, drops auto-reconnect,
  crash + quick match lands in the only live room; a stored-roomId prompt
  would only add a stale-room failure mode.
- **Still pending**: owner in-browser check of the rematch flow (win →
  Enter → NEW match; two-tab: both Enter → same fresh room; I → link on
  the clipboard), then the `[human]` provisioning checklist (DEPLOY.md).
  The netsim feel pass came back clean at 120/20 — `GameConfig.net.sim`
  keeps those values committed as the dormant profile (`enabled: false`).

## DONE 2026-07-05 — Phase 3 slice: reconnection + hosting artifacts (`feat/reconnect-hosting`, awaiting owner check)

- **Reconnection** (`a0caf6d`): server holds a NON-consented leaver's seat
  for `GameConfig.net.reconnectGraceSec` (60s, new shared knob ⇒ PROTOCOL
  15→16) via `allowReconnection` in `BattleRoom.onLeave` — the AI takes the
  ship immediately (match stays balanced), `claimSeat` skips reserved seats,
  the `clientViews` entry stays alive through the window (sessionId +
  `client.view` survive a Colyseus reconnection), and reclaim restores
  occupant/controller/callsign (`seat.pilotCallsign`) + re-tasks the
  formation leader on both edges. Colyseus 0.17 note: `onLeave(client,
  code)` — branch on `CloseCode.CONSENTED` (4000); there is no `consented`
  boolean anymore. CLIENT rides the 0.17 SDK's BUILT-IN auto-reconnect (the
  same Room object retries with backoff ~60s and keeps every handler — do
  NOT hand-roll a token/room-swap loop, we deleted one): `room.onDrop` →
  RECONNECTING overlay + input/prediction freeze; `room.onReconnect` →
  `NetworkGame.onReconnected()` wipes every timeline-derived buffer
  (snapshots, clock offset hard-resync, pending inputs/correction, fx +
  netsim queues); `room.onLeave` is TERMINAL. Page unloads (reload, ESC)
  now leave CONSENTED via `pagehide` so the seat frees immediately.
  Integration test ("holds a dropped seat…"): drop without consent → AI
  handback + reservation denies a poaching joiner → `colyseus.sdk.reconnect`
  restores seat/callsign/leadership. Test gotcha: disable the test client's
  `reconnection.enabled` before `leave(false)` or the SDK auto-reconnects
  under the assertions.
- **Hosting artifacts** (`2200f5e`): everything agent-preparable for the
  friends playtest — see **docs/DEPLOY.md** (topology, artifact table, the
  `[human]` provisioning checklist, per-deploy procedure). Highlights:
  `npm run build:server` → `server/dist/server.mjs` (self-contained ESM;
  esbuild CJS breaks on deps' `import.meta.url`, hence ESM + aliased
  `createRequire` banner; smoke-verified serving a real SDK join),
  systemd unit + Caddy/nginx configs under `deploy/`, manual-only
  `deploy-server.yml` (same-commit rule), Pages workflow bakes
  `VITE_SERVER_URL` from a repo variable (NetClient falls back via `||` —
  an unset repo var arrives as an EMPTY string, `??` would bake it).
- **Still pending**: the `[human]` netsim feel pass (headline), the
  `[human]` provisioning checklist (DEPLOY.md), owner in-browser check of
  reconnection (kill the server tab-side mid-match → RECONNECTING → seat
  back with callsign).

## DONE + OWNER-VERIFIED 2026-07-05 — identity slice

Both owner asks from the 2026-07-05 session, built on `feat/own-ship-marker`
and accepted in-browser the same day after three owner review rounds:
ring → TEAL ENGINE TINT (owner call), numbered callsigns → TWO-WORD handles
(owner call), and a dark backing pill so plates read over exhaust plumes
(owner finding, `b54d7a4`):

- **Own-ship engine tint** (owner-decided 2026-07-05, replacing the ring
  marker first built as `4fba536`): the ship YOU fly burns TEAL exhaust —
  every other burn is ember-to-orange, RCS plumes are blue-white, so
  nothing else on the field wears this color. `EngineGlow` grew an optional
  idle/hot palette param; the player's own glow (offline `Game`, online the
  `myKey` view in `NetworkGame.makeView`) passes `GameConfig.ownShipTint`,
  everyone else defaults. Wingmen flying the SAME model keep orange. Known
  trade (owner accepted): the cue fades while coasting and hides in the
  launch tube — it's a burn, not a beacon.
- **Callsigns + nameplates** (`ebfed8d`): `shared/src/Callsigns.ts` names
  AI seats deterministically per (faction, seat index) — Commonwealth
  pilot handles ("Blue Fox", "Iron Wolf"…) vs Novari choir names
  ("Silent Psalm", "Glass Hymn"…) — two-word, no numbers (owner call), per
  the story bible; the offline Game names its wing/fleet with the SAME
  generator. Humans wear a typed pilot name: CALLSIGN field on loadout
  page 2 → `lastMeridian_pilotName` → `JoinOptions.pilotName` (sanitized
  BOTH sides) → `ShipSchema.callsign`, which swaps with `isAI` on
  join/leave (a leaver's name never lingers on the bot; integration-tested
  over the transport). `Nameplates.ts`: pooled plain-DOM labels projected
  per frame, zoom-faded (`GameConfig.nameplates`), friendlies-always +
  enemies-only-while-lock-targeted + never your own ship, launch-gated
  (DOM ignores occlusion); human names bright/haloed vs dimmer
  faction-tinted AI callsigns (honesty rule). Online rides new ShadowShip
  stub fields (`callsign`/`isHumanPilot`/`launching`) fed per patch —
  and note `cloneNetState` (the netsim copy) must carry every new
  `ShipSchema` field.

## FIXED + OWNER-VERIFIED 2026-07-05 — MP parity: dock cue + jump ripple

Two owner playtest findings against this branch, both online-only gaps vs
Game.tick, fixed in `28dac09` and re-verified by the owner in-browser:

- **Dock cue**: NetworkGame never called `Hud.setServiceStatus` — the
  server refuelled fine (authoritative), the HUD just never said so. Now
  mirrors the offline gate over the predicted ship; SERVICING/DOCKED
  derives from replicated hp/ammo vs the type caps (no client serviceTick).
- **Jump ripple**: only the DEPARTURE ripple spawned, and the own-jump
  camera snaps to the arrival — the effect was always off-screen. Now both
  endpoints (offline parity) + the missing `arrivalTrauma` kick.

The owner's pass on this branch otherwise came back clean.

## DONE 2026-07-05 — sensor-filtered replication (the anti-wallhack gate)

Nebula stealth + sensor range now filter the WIRE, not just the radar. With
both Phase 2 tail items landed, what's left before Phase 3 is only the
`[human]` feel pass.

- **Server**: `BattleState.ships` is view-tagged (`view: true`); every
  client gets a Colyseus `StateView` in `onJoin` — all FRIENDLY ships
  permanently, ENEMY ships diffed in/out each tick by
  `BattleRoom.syncClientViews` from `sim.sensors.isTracked` (the same
  fresh-track rule the server AI flies on; a spooling jump drive
  force-detects, so runners still telegraph). Death drops the entry
  (explosion arrives as the unfiltered shipDied event, like offline).
- **Events are unfiltered but self-contained** (a shooter may never have
  replicated to a given client): `laserFired` carries shooter faction+type,
  `missileFired` carries faction + launch pose (depiction falls back to it
  when the shooter is hidden — the round is visible even when the ship
  isn't), `shipDied` carries victim faction+type for the kill board. Pilot
  counts are unfiltered root fields (`pilotHumans`/`pilotBots`).
- **Client**: `ShadowShip.present` mirrors map membership. Absence freezes
  the stub at its last rendered pose, pulls it from the sensor rosters,
  hides the view + engine glow (trail is unparented — gotcha #4), and wipes
  the snapshot buffer so reappearance can't interpolate across the hidden
  gap. The shared `SensorSystem` sweep now clears freshness for ships
  absent from the opposing roster (a no-op for stable offline/server
  rosters — smoke baseline untouched), which is what ages a de-replicated
  enemy into an honest last-known-position radar ghost.
- **Proven over a real transport** (tests/server/battleRoom.test.ts): a
  first-patch client receives ONLY its own fleet (the parked enemy fleet is
  off the wire); an enemy dragged into AWACS range appears; a killed enemy
  leaves the map; a killed friendly stays (alive=false).
- **Known deliberate quirks**: no hidden-enemy ship meshes on screen even
  inside the visual nebula (eyeball `visualRange` keeps knife-fights
  replicated); bolts can emerge from empty space when a concealed ship
  fires from beyond visual range — that's the stealth fantasy, not a bug;
  the DETECTED/HIDDEN cue is the client's mirror and can briefly disagree
  with the server picture for hidden observers.

## DONE 2026-07-05 — netcode tooling (network-condition simulator + debug overlay)

The Phase 2 tail's tooling pair, built so the `[human]` feel-tuning loop can
run on localhost:

- **Netsim** (`GameConfig.net.sim` — dev section, OFF by default; flip
  `enabled` and reload): `latencyMs` is the simulated ROUND TRIP (half
  applied to each direction), `jitterMs` adds 0..j per-message randomness.
  Outbound: `NetClient.send` holds input/ready sends (monotonic release —
  TCP never reorders). Inbound: `NetworkGame` holds arriving state patches
  and `MSG.events` batches in `DelayQueue`s (client/src/net/DelayQueue.ts,
  unit-tested) drained at the top of the tick — patches are CLONED at
  arrival (`cloneNetState`) because Colyseus decodes into the same live
  object. Direct-state reads (carrier HP, phase, winner) stay realtime;
  slow-changing, not feel-relevant. It cannot run silently: console banner
  on join + a pinned amber NETSIM badge for the whole match.
- **Netcode overlay** (`NetDebugOverlay`, plain DOM): press **Backquote**
  in an online match (offline that key is god mode) for a top-right
  readout — clock offset, configured interp delay, own-ship snapshot
  buffer depth + HEADROOM (newest sample minus render time; ≤0 = buffer
  starvation, the interp-delay smoking gun), pending inputs + ack lag
  (`inputSeq − acked seq`), correction offset magnitude (units + degrees),
  fx-queue depth, ships tracked, netsim status. Stats are gathered in
  `NetworkGame.tick` only while visible; the panel rewrites at 5Hz.

Next: the `[human]` feel pass at 40/80/120ms ± jitter — knob→symptom map
and anchors are in `docs/AGENT_KICKOFF.md`.

## How to run / reproduce

```bash
npm run server     # Colyseus on :2567 (tsx watch — restarts on code change)
npm run dev        # Vite client on :5173
```
Open `http://localhost:5173/` and press **PLAY ONLINE** (quick-play screen,
or the loadout's mission page next to PLAY SOLO). The old `?online` flag is
GONE — entry is buttons now. Joining writes `#join=<roomId>` into the address
bar; that URL is the WITH FRIENDS invite link.

See `docs/PHASE1_TWOTAB_CHECKLIST.md` for the full acceptance checklist
(rewritten 2026-07-04 for this build).

## FIXED 2026-07-05 — remote RCS plumes (owner two-tab finding)

Other players' reverse/strafe thrusters were invisible (only your own showed):
RCS plumes depict INPUT, which wasn't replicated for remotes. Now the sim
records the applied input per combatant (`SimCombatant.lastInput` — the same
fact the offline Game drives its wing FX from), `ShipSchema` replicates the
three RCS bits (`reverse`/`strafeLeft`/`strafeRight`, false while dead or in
the tube), they ride the snapshot buffer like `alive` (discrete, interpolated
with the pose), and FRIENDLY ships get `SecondaryThrusters` views driven from
them — offline parity: your faction's wing shows plumes, the enemy fleet
doesn't. Dead ships taper plumes to zero so a respawn can't re-enable a
frozen glow. PROTOCOL_VERSION 9 → 10. Remote MAIN-engine glow still rides
the speed proxy (thrust itself is deliberately not on the wire).

## STATE AS OF 2026-07-04 (second session — jitter fix + entry polish)

Two more slices landed on top of the HUD slice (commits `2729878`, `13cee3f`),
both awaiting owner playtest:

- **Full-thrust judder FIXED (root-caused).** Owner playtest reported a
  slight jitter at full forward thrust, own ship only. Two speed-proportional
  causes: (1) the server held the LATEST input, applied it per tick with a
  MEASURED delta, and acked seqs on arrival — while the client replays one
  fixed 1/30s step per unacked input, so message-arrival vs tick-boundary
  phase made reconciliation see ±speed×33ms errors every patch. Now
  `NetworkController` QUEUES input frames and consumes exactly one per tick
  (jitter backlog `GameConfig.net.inputBacklogMax`, oldest-discarded beyond
  it, jump edges carried), `BattleRoom.step` runs a fixed-dt accumulator
  (TICK_MS exactly, ≤3 catch-up ticks), acks ride the consumed seq, and the
  client's send pacing is drift-free. (2) the camera lead finite-differenced
  the rendered pose (predicted + decaying correction) — every ripple was
  amplified by `camera.velocityLead`; it now reads the predicted SIM velocity
  (offline parity). PROTOCOL_VERSION 8 → 9.
- **Online entry polish DONE** (work-order item 2, all three parts):
  PLAY SOLO / PLAY ONLINE buttons (quick-play + loadout page 2 —
  `LoadoutMenu.onPlay(mode)`, status/errors land on the pressed button);
  WITH FRIENDS invite links (`NetClient.quickMatch`/`joinById` split,
  `#join=<roomId>` written to the address bar on join, hash-joins take the
  primary action, stale rooms fall back to quick match + self-heal the
  hash); Enter-restart after an online match rejoins ONLINE
  (`RESTART_FLAG` value = mode); and a joining human becomes their
  faction's formation leader (`BattleRoom.retaskLeader`) so the commander's
  cover escorts + loitering hunters fly the wing on the PLAYER, restored to
  the AI default on leave (new integration test proves the handoff).

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

1. **`[human]` acceptance pass** (`docs/PHASE1_TWOTAB_CHECKLIST.md`, rewritten
   for this build): solo-online first — specifically confirm the full-thrust
   judder is gone, the HUD slice behaves (radar/RWR/kills/lock/sig), the
   escorts form on YOU — then the two-tab half (invite link → same room,
   both see each other move/fire + white halos, leave hands the seat back).
   Known non-bugs: **no hitstop online** (deliberate); remote engine glow
   rides a speed proxy, not real thrust input. Feel knobs in
   `GameConfig.net`; `window.__netGame` is the live debug handle.
2. **Merge `feat/phase1-multiplayer` → `main`** once the pass is clean.
3. Later (Phase 2 tail, pre-deploy): **sensor-filtered replication**
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
- **Input timing invariant (the judder fix — don't regress it)**: one acked
  input frame == one fixed 1/SIM_HZ server tick. `NetworkController` queues
  frames and consumes one per tick; `BattleRoom.step` is a fixed-dt
  accumulator; the ack is the CONSUMED seq (launch tube: hold-latest +
  ack-on-arrival, nothing predicts there); the client sends drift-free at
  the sim rate. Camera lead reads the predicted SIM velocity, never a
  finite difference of the rendered pose.
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
