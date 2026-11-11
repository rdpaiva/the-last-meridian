# Agent kickoff prompt

**THIS FILE IS THE SINGLE SOURCE OF TRUTH for what the next session works
on.** The Work order below is the live task queue; every other doc is a
status snapshot (`ROADMAP.md` — plus the long-term idea backlog), a phase
record (`MULTIPLAYER.md`), a dated changelog (`PHASE1_OPEN_ISSUES.md`), or
reference. If a task appears anywhere else but not here, it is not queued.

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

**State (2026-11-10)**: KEEP-WARM, code at `96328db`. Branch `spitfire-v26` was
fast-forwarded into `main` on 2026-11-10 (the owner's call), so `main` now has
the www redirect, the rebuilt ship models + tooling, the path and
canon-pointer update and a test type fix. Merged, NOT deployed.
The repo now lives at `The Last Meridian/Game` (moved 2026-11-10 from
`ai/games/space-duel`; the project's other folders are siblings: `../Canon`,
`../Video Series`, `../Website`). No gameplay or protocol change since the
2026-08-31 batch below; PROTOCOL_VERSION is **33** in `shared/src/protocol.ts`.
What landed since, oldest first:
- **Visual batch, 2026-09-01 → 09-21** (`e7efb5c`, `4e54609`, `3a75ef0`,
  `140492e`, `2d57f4b`, all on `main`): fighter art + export pipelines
  (`scripts/build_spitfire.py`, `build_wraith.py`, `skin_*.py`), destroyed
  ships fracture into hull sections (`ExplosionSystem.ts`), Canyon/Observer
  hidden from the public mission picker, Reaver materials, seamless space
  backdrops assigned per map (`docs/SPACE_BACKDROPS.md`, `Backdrop.ts`,
  `Maps.ts`), carrier textures, the opening launch camera
  (`OpeningLaunchCamera.ts`) and the build-update check (`BuildUpdates.ts`).
- **Game served under `/play/`, 2026-11-08** (`d362546`, on `main`): Vite base
  `/play/`, every runtime asset URL through `import.meta.env.BASE_URL`, the
  deploy workflow ships the client to `/var/www/meridian-play`; the domain root
  is the franchise homepage (`../Website`). Topology: `docs/DEPLOY.md`.
- **www → apex redirect, 2026-11-10** (`bb8181f`, branch only): `deploy/Caddyfile`.
  It must stay identical to `../Website/deploy/Caddyfile`, which already has
  the redirect, so `main`'s copy differs until this branch is merged.
- **Ship models rebuilt from the film models, 2026-11-10** (`2d8cb11`, branch
  only): the four ship GLBs regenerated from the series' Blender models,
  muzzles + colliders in `GameConfig.ts` re-fitted, wrecks got their own
  collider boxes (`shared/src/sim/Hulk.ts`, `HulkView.ts`), and the new
  tooling `scripts/game-models/` (`make-game-model.mjs` + README; it reads
  `../Video Series/Episode 01/Blender`, so that path must not move).
  NOT YET PLAYTESTED by the owner.
- **Paths + canon pointer, 2026-11-10** (`a4e9c73`, branch only):
  `docs/The-Last-Meridian-Story-Bible.md` is now a pointer; canon lives ONLY in
  `../Canon/Story_Bible_v0.4.md` and its supplements. Code comments citing
  "story bible §2 / §8" use the old v0.1 numbering.
- **Test type fix, 2026-11-10** (`96328db`, branch only):
  `tests/client/openingLaunchCamera.test.ts`.
Typecheck green at `96328db`; **81/81 tests** passed at `2d8cb11` and the one
file touched since passes. Nothing in this list has been deployed by this
file's author: deploys are the owner's, via the "Deploy game" workflow.

Prior batch: **State (2026-08-31)**: SCOREBOARD BUG FIXED — pilot-owned score rows.
PROTOCOL_VERSION 31→**32** (`ScoreSchema` gained fields = both-sides deploy).
THE DEFECT: `state.scores` held exactly one row per SEAT, minted in
`buildFleet`, and occupancy swaps merely RENAMED it (`syncScoreIdentity`) — so
`onLeave` handed a human's whole match to the seat's bot, and a reload (a new
sessionId → `claimSeat` gives a different seat) inherited THAT bot's ledger.
THE FIX: score identity is now separate from seat identity. Rows are keyed
`ai:<seatId>` (a seat's own bot ledger, one per seat from birth) or
`pilot:<key>` (a human's ledger, created on join, RESUMED on rejoin, following
them seat to seat). `Seat.scoreRowId` is the indirection — `lastHitBy` still
trades in seat ids, and `rowForSeat` resolves both victim and shooter through
the seat's CURRENT occupant, so credit lands on whoever is actually flying.
`attachPilotRow`/`detachPilotRow` replace `syncScoreIdentity` (deleted) at all
three occupancy sites (join / leave / reconnection reclaim); a leaving pilot's
row keeps its tally and stays on the board with `owner` cleared, never renamed.
`ScoreSchema` gained `owner` (sessionId of the live human, "" otherwise — the
client's "my row" test, replacing the `id === myKey` ship-id match) and
`frozen` (a bot ledger parked while a human holds its seat; the client hides
frozen rows with an all-zero tally, so a bot that scored BEFORE the human sat
down keeps its earned row). Third symptom fixed too: the banner's
`KILLS · SCORE` was a page-load-local counter — `NetworkGame` now reconciles
`playerKills`/`score` against its replicated row each scoreboard rebuild
(`rollBestScore` extracted), so banner and row cannot disagree. Offline
`ScoreBoard` needed no behavior change (solo has no join/leave; a Ship instance
IS a stable pilot identity) — parity documented in its header. Typecheck green,
**62/62 tests** (+1: `tests/server/battleRoom.test.ts` "a pilot rejoining after
a drop resumes their own tally, never a bot's" — leave → NEW sessionId rejoin →
same row, tally intact, no AI row wearing the kills; the existing scoreboard
test was rewritten off the old seat-owned assertions). NOT YET PLAYTESTED by
the owner on a live MP match. NOTE: protocol bump = both-sides deploy.

Prior batch: **State (2026-08-19)**: MULTIPLAYER DIFFICULTY + SOFTER EASY, committed
as `ed27049` on top of `c051f6e`. PROTOCOL_VERSION 30→**31** (JoinOptions gained
`difficulty`). The difficulty presets moved to **`shared/src/Difficulty.ts`**
(new; Maps.ts pattern — catalog + injectable-override applier;
`client/src/game/Difficulty.ts` is now the persistence + solo-apply shim
re-exporting it). Online the ROOM owns the difficulty exactly like the
arena: the creator's pick rides `JoinOptions.difficulty`
(`NetClient.options`, `main.ts startOnline`), `BattleRoom.onCreate`
validates (`isDifficultyId`, fallback "medium") + `applyDifficulty()`s it
server-side before the sim constructs, and replicates it as
`BattleState.difficulty` (display-only for clients; joiners inherit).
LoadoutMenu step 3 online now shows the difficulty + arena pickers
(`rows()`, `stageMission()` — invite joins still get no pickers). EASY
SOFTENED per the owner (too hard even on Easy): reactionSec 0.55→0.7,
engagementRange 100→85, fireRange 22→20, fireConeAngle 0.14→0.10,
missileCooldownSec 14→18, missileMaxRange 80→65 (escort/hunt stay 1/1).
Typecheck green, 61/61 tests (`tests/server/battleRoom.test.ts` joinOpts
now pins `difficulty: "medium"`). NOTE: protocol bump = both-sides deploy.
Open thread (separate, not queued): owner's gamepad RT/LT thrust dead on
his WINDOWS machine only (works on macOS) — suspected non-standard-mapping
triggers-as-axes; needs his pad's `navigator.getGamepads()` readout, then
a fallback in `GamepadSteering.trigger()`.

Earlier: **State (2026-08-08)**: AI FLEET DOCTRINE + OBSERVE MODE, one commit on
top of `3fc9b0c` (the owner's commit of the 2026-08-05 terrain-walls/
planetside batch below). PROTOCOL_VERSION 29→**30** (GameConfig changed:
`ai.engagementRange`, new `ai.defendOrbitBand`). The doctrine batch, in
play-fix order:
`ai.engagementRange` 35→**140** (sized against the SENSOR picture — the
old knife-fight value made patrol pilots fly past contacts their radar
tracked for a minute = the "aimless meandering" report; Difficulty presets
rescaled 100/140/180, TuningSchema slider max 220); the `defend` order
flies a deterministic CCW **CAP racetrack** at `defendOrbitRadius`
(`ai.defendOrbitBand` blend — the old wander-jitter aimed into the hull
half the time and fought the avoidance override, the "weird defender
pattern"); **leader failover** both sides (FleetCommander re-points
`world.leader` to the senior live striker; cover/hunt guard against
`leader === self`, and a leaderless cover pilot now PROSECUTES the nearest
contact instead of patrol-wandering); NEW `shared/src/WingCommander.ts` —
player-side doctrine (leader failover on player death: senior escort
spearheads, the wing packs on it; carrier-defense scramble on the enemy
commander's alarm rules; zero RNG = determinism-safe; wired in Game.start
AND tests/sim/HeadlessBattle.ts, `BattleSim.addCommander` widened to
`{update(nowMs)}`); **retreat-dock geometry fixed twice** off owner
screenshots (dock at the NEAREST bay's `getJumpArrivalPosition`, never the
in-hull staging point, never fixed bay 0; brake on `serviceZoneContains`;
own-carrier avoidance circles — now tagged `AvoidObstacle.carrierFaction`
— skipped ONLY within 2×`service.radius` of the dock point; full
invariants in SUBSYSTEMS → "Jump drive… Dock geometry"); and **OBSERVE
mode** (solo MISSION → Deployment FLY/OBSERVE, never persisted): AI flies
the seat, SpectatorCamera from frame one, HUD cluster follows the watched
ship (per-ship `Combatant.serviceState`, `ScoreBoard.rowFor`,
`Hud.setCommand` cmd row w/ `· RTB` tag, standalone `Hud.setObserving`
label), first-person cues gated by `Game.isHumanSeat()`. Typecheck green,
**61/61 tests**, smoke baseline RECAPTURED 3× this session (AI-behavior
changes; pinned summary swung 11k-defeat → 37k-victory → 12k-defeat across
the fixes — the pin is chaotic per seed, a determinism check, NOT a
balance metric). Dial deliberately left alone: `ai.coverBreakRange` 45
(escorts stay tight on a live player). Prior batch (2026-08-05, committed
by the owner as `3fc9b0c`): TERRAIN WALLS + The Canyon, now PLANETSIDE
(on top of `3621cbf`). NEW: the per-map ENVIRONMENT THEME
(`MapConfig.environment` → `GameConfig.scenery.environment`, view-only,
written by applyMapConfig) — The Canyon opts into `"planet"`:
`client/src/game/PlanetTerrain.ts` (procedural flat-shaded value-noise
heightfield far below the flight plane; ground swells to meet the wall
feet from the same WallHazard spec; height-banded dusk palette) replaces
the whole deep-space stack (Backdrop/Starfield/Nebulas/CapitalShips —
`starfield`/`backdrop` are now nullable in BOTH coordinators), plus scene
retints (`planet.clearColor`, warm `planet.hemiGround`). Knobs:
`GameConfig.planet` (KEEP THE PALETTE DUSK-DARK — glow FX are tuned
against black space). GOTCHA fixed twice-over in the views, worth
remembering: Babylon's front face is COUNTER-clockwise in the (x-right,
z-up) plane seen from +Y (the CreateGround convention). Both WallView and
PlanetTerrain originally wound clockwise — the terrain was back-face-culled
(invisible from above) and the walls, double-sided so they still rendered,
got reversed normals from ComputeNormals/flat-shading (sun lit their
INSIDES → the owner's "near-black walls" report). Winding flipped in both;
walls also keep a dim self-light for the steepest faces (`walls.emissive`,
diffuse 0.38→0.45). Base feature: the `wall` map-hazard kind:
`shared/src/sim/Wall.ts` (capsule chains: chunked `segments` feed
weapons+AI circles, FULL `edges` feed the ship keep-out — bump against
chunks nudges wall-huggers at seams, test-proven), `GameConfig.walls`,
`bumpShipOutOfWallSegment` (BattleSim, shared solo/server/prediction),
`shipRammedWall` SimEvent, `WallView` procedural canyon ridge, radar
polylines, wired into Game/BattleSim/NetworkGame. `theCanyon` rebuilt
from the storm-prototype onto real walls (normal-offset S-curve; lane
narrowed 220→**80** on 2026-08-05, `walls.chunkLength` 24→12 to match,
and the space-only furniture stripped — no asteroids, no stealth nebula,
no capture stations (Energy layer inert on this map); storms stay as
planetside thunderheads). Proofs:
`tests/sim/wallKeepOut.test.ts` (geometry + scrape cadence + a 30Hz
seeded canyon battle: keep-out invariant + fleets actually fight). PROTOCOL_VERSION 28→**29** (GameConfig changed). Typecheck
green, **61/61 tests**, smoke baseline untouched (stock config has no
walls). Docs: SUBSYSTEMS → "Terrain walls", ROADMAP Done + phase-2
backlog (editor wall brush / derelict-trench theme / maze needs
waypoints). Prior state: `main` at `3621cbf` — launch-bay QUEUE staging
(ships in the same tube no longer stack on one point; they hold
nose-to-tail via `launch.queueSpacing`) + the AI nose-wag fixes: wander
now blends headings circularly (`retargetWander` scalar-lerp bug),
defend rings re-fit OUTSIDE the GLB hulls (orbit 50→180, intercept
80→230 — the old rings sat inside the ~150u hull-avoidance footprint,
the source of the full-rate defender wag), and obstacle dodges are
COMMITTED with a commit-cap + refractory rhythm
(`ai.avoidCommitMaxSec`/`avoidRefractorySec` — tuned against AI-vs-AI
battle completion; the old per-frame chatter was accidentally strikers'
firing time). PROTOCOL_VERSION 27→**28** (GameConfig changed). Typecheck
green, 52/52 tests, sim baseline recaptured (pinned-seed outcome flip
verified pre-existing across seeds, not a regression). Prior state: the
strategic layer merged 2026-07-18 (`2a2a11e`) and the owner **CLEARED
THE QUEUE** — do NOT resurrect old check items; anything found later
gets filed here fresh, from play.

**What the game is now**: solo + online fleet-vs-fleet with the full
strategic layer — capture stations, per-faction Energy with auto upgrade
tiers (RAPID REDEPLOY / SENSOR UPLINK / TURRET OVERDRIVE),
station-powered carrier shields, destructible per-bay hangars with
graduated respawn penalties, the 20s respawn bench + HUD redeploy ring,
ion storms, the map editor (station brush + sticky brushes), a 6-map
catalog (The Eye is the first editor-authored entry), and a 7-card Field
Manual covering all of it. Feature-by-feature status: `docs/ROADMAP.md`.
At merge: typecheck green across all workspaces, **52/52 tests green**.

**Deploy state**: PROTOCOL_VERSION is **30**; the LIVE droplet still
answers **v17** — the strategic layer has never been deployed. The next
Actions → **"Deploy game"** dispatch (owner clicks; agents' `gh` token
cannot) ships client + server from one checkout, so the both-halves rule
is automatic; old clients get the refresh prompt. Topology + provisioned
state: `docs/DEPLOY.md`. Nothing auto-deploys on push.

**Owner goal (standing, owner-owned)**: deploy, then the friends
playtest at `https://the-last-meridian.com`. Findings come back as new
work items here.

**Parked records** (pointers, not open loops — reopen only if symptoms
recur):

- **Periodic freeze**: multi-second freeze every ~20–30s, last
  owner-reproduced 2026-07-17 locally in SOLO mode (rules out the
  server). Parked 2026-07-18 by the queue-clear. Full record + next
  evidence step at the top of `docs/perf-freeze-investigation.md`;
  hygiene fixes already landed in `56837f2` (droplet heap cap, GlowLayer
  include-list leak, scoreboard cadence + fxQueue drain cap).
- **Netcode feel-tuning knob map**: remote-ship stutter →
  `net.interpDelayMs` (overlay "headroom" ≤0 = buffer starvation);
  own-ship micro-jerks → `correctionRate`/`correctionSnapUnits`; input
  feel under jitter → server `inputBacklogMax` (overlay "ack lag"
  creeping = too high). Anchors: `GameConfig.net`,
  `NetworkGame.recordSnapshot`/`reconcile`/`updatePrediction`,
  `NetDebugOverlay.ts`, `NetClient.send` + `DelayQueue.ts`. The committed
  `net.sim` profile is the owner's 120/20 (dormant, `enabled: false`).
- **Known deliberate seams** (accepted behavior, not bugs): own laser
  bolts visibly overfly a remote target ~12u before the server hit lands
  (fainter cousin of the missile-fuse artifact — fix only on owner
  report); a LIVE hangar circle (r22) shadows bolts crossing it on
  frontal carrier runs (off-axis is clean; dead subsystems stop
  absorbing); subsystems ignore friendly fire by design; dense-station
  maps climb the fixed 100/250/500 Energy ladder faster (balance lever,
  not a bug); station-free maps (The Veil, The Wreck) run with the whole
  strategic system inert by design.
- **Strategic layer M3 (Loom Fragment event)**: moved to the ROADMAP
  backlog by the queue-clear. Design sketch in
  `docs/strategic-layer-plan.md`.
- Detailed per-feature build notes (anchors, protocol history 17→27,
  owner-feedback trail) that used to fill this file: git history of this
  doc (`git log -p --follow docs/AGENT_KICKOFF.md`) and the dated entries
  in `docs/PHASE1_OPEN_ISSUES.md`.

**Work order**:

Nothing queued. The owner cleared the queue on 2026-11-10: he will start from
a fresh review of the game. The items that were here (the scoreboard fix
record, the Canyon playtest and the fleet doctrine + OBSERVE playtest, with
their dials and anchors) are in this file's git history before that date.
File new items here with anchors as they surface.

**Rules of the road** (already true in code — don't relearn them):

- Any change to `NetEvent` shapes, MSG payloads, or GameConfig → bump
  `PROTOCOL_VERSION` (`shared/src/protocol.ts`).
- New online HUD/depiction feature? Extend the `ShadowShip` stub pattern in
  `NetworkGame.ts`; don't fork the offline system.
- Never timestamp anything by arrival — everything rides `state.timeMs`
  (the netsim relies on this: delayed ingest is just later samples).
- Weapon cooldowns are exempt from prediction rewind/replay; keep it that
  way.
- One acked input == one fixed 1/SIM_HZ tick (the judder fix invariant).
- `GameConfig.net.sim` stays OFF in every commit (`enabled: false`).
- Netsim state copies must carry EVERY replicated field — adding one to
  `ShipSchema` means adding it to `NetShip` + `cloneNetState` too.
- Colyseus 0.17 idioms: server `onLeave(client, code)` + `CloseCode`;
  client SDK auto-reconnects the same Room object (`room.reconnection`
  options) — work WITH it, never around it. An ended room LOCKS: joins are
  refused by design; reconnection reservations still work through a lock.
- Verify with `npm run typecheck` + `npm test` only — I run the dev server
  and playtest myself. Commit each landed change like previous sessions.
