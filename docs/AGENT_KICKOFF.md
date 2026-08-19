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

**State (2026-08-19)**: MULTIPLAYER DIFFICULTY + SOFTER EASY, uncommitted
on top of `c051f6e`. PROTOCOL_VERSION 30→**31** (JoinOptions gained
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

Prior batch: **State (2026-08-08)**: AI FLEET DOCTRINE + OBSERVE MODE, one commit on
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

- **Owner playtest: The Canyon on real walls, planetside**. Expected
  sights: a dusk desert landscape scrolling far below with real parallax
  (no stars/space backdrop/capital ships on this map), canyon ridges
  rising OUT of the terrain (ground swells to the wall feet — no floating
  ribbon), BOTH CARRIERS inside widened trench chambers (walls continue to
  z=±1200 behind them, so normal play never exposes a canyon mouth), readable
  wall faces (the new self-light), AI threading the
  bends and breaking around the bend rocks, bolts/missiles dying on
  walls, wall polylines on the radar, scrape damage + trauma cue on a
  graze. TEXTURES (owner-owned art): SEAMLESS tileable images at
  `client/public/textures/planet-surface.jpg` (ground — owner has it, looks
  good) and `client/public/textures/canyon-wall.jpg` (wall rock faces) — they
  apply automatically;
  until a file lands that surface renders in its plain fallback color
  (deliberate, never black). Wall-texture dials: `walls.texture.tileSize`
  (kept at the planet tile's 260-unit world scale) and `walls.texture.tint`
  (brightness). Wall-vs-ground integration is structural: mesa walls are
  ASYMMETRIC CUT BANKS — a trench-facing rock ribbon joins a rim cap that
  uses the planet tile, its world-planar UVs, and PlanetTerrain's exact FBM
  height sample. The symmetric stacked slabs remain only as the non-mesa /
  free-standing fallback. `planet.hemiSky` (warm dusty override
  of the blue space fill) remains the master warm/cool knob for the
  near-vertical faces. Iterate LIVE in a solo match via the dev-console
  hook `__tuneWalls({ texture: {...} })` (rebuilds views in place; shallow
  merge — pass nested objects complete), then commit the dialed values into
  GameConfig. Planet dials:
  `GameConfig.planet` —
  `texture.tint` for ground brightness/warmth (DARKEN if bolts/trails wash
  out — never touch FX), `texture.tileSize` for ground busy-ness,
  `baseY`/`amplitude` for depth feel, `wallBlend` for how wide the ground
  shoulders the walls, `clearColor`/`hemiGround` for the scene tint
  (`texture.file: ""` = the old faceted procedural look). Wall dials if
  the feel is off:
  `GameConfig.walls.chunkLength` DOWN if AI balks at bends (steering
  circles hug tighter), lane width via the `theCanyon` polylines
  (`shared/src/Maps.ts` — comments carry the offset math),
  `walls.height`/`belowDepth`/`ringSpacing` for the look,
  `walls.diffuse`/`walls.emissive` for face brightness (the emissive floor
  keeps the steep faces readable under the top-down lights — raise it if
  they still read too dark, but keep it well below diffuse or the facets
  flatten), `walls.collisionDamage` for scrape sting. Anchors:
  `shared/src/sim/Wall.ts`, `client/src/game/view/WallView.ts`,
  `resolveWallCollisions` in `Game.ts`/`BattleSim.ts`,
  `tests/sim/wallKeepOut.test.ts` (the canyon-battle invariant).

- **Owner playtest: fleet doctrine + OBSERVE mode** (this commit — the
  best lens is OBSERVE itself: solo MISSION step → Deployment → OBSERVE;
  rotate keys / fire cycle ships, HUD tracks the watched pilot). Expected
  sights: patrol/pool pilots turning in on contacts out to ~140u instead
  of drifting past; defend gunships flying a clean counter-clockwise
  racetrack at ~180u (no hull-hugging squiggle); on the leader's death the
  wing packing up behind a spearhead escort and prosecuting (not
  scattering to wander); escorts scrambling home when the carrier takes
  fire, releasing ~8s after it stops; damaged pilots tagging `· RTB` on
  the cmd row, docking at a bay mouth (`dock` row `servicing` → `docked`),
  then returning to the front — NO ship parked motionless against a hull.
  Dials if the feel is off: `ai.engagementRange` (per-difficulty
  100/140/180 in `client/src/game/Difficulty.ts` — the GameConfig default
  only bites when no preset applies), `ai.defendOrbitRadius`/
  `defendOrbitBand` (CAP ring), `commander.defendCount`/`defendHoldThinks`
  (scramble size/stickiness), `ai.coverBreakRange` 45 (raise toward
  70–90 for more aggressive escorts — deliberately left tight),
  `fleets.*.strikeCount` vs the defense knobs if matches run long.
  Anchors: `shared/src/WingCommander.ts` (whole doctrine),
  `shared/src/AIController.ts` (the `defend` case = CAP orbit;
  `retreatMovement` dock branch + `dockingHome`/`dockPoint`;
  `scanForThreat`'s carrierFaction skip; the cover dead-leader fallback),
  `shared/src/FleetCommander.ts` (leader failover), `Game.ts`
  (`isHumanSeat`, the spectate camera + HUD blocks in `updateViews`),
  `client/src/game/LoadoutMenu.ts` (the role row),
  `Hud.setCommand`/`setObserving`.

Otherwise nothing queued. New items come from the deploy + friends
playtest, or whatever the owner asks for next. File them here with
anchors as they surface.

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
