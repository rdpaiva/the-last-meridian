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

Continue the multiplayer work. **Phase 3 is feature-complete and MERGED**:
`feat/reconnect-hosting` landed in `main` (`d352660`, 2026-07-06; 20/20
tests green) and the repo was branch-cleaned the same day — only `main`
exists locally; `origin/dev` is the off-machine backup; every stale
local + remote feature branch was deleted. Work from `main` (branch off
it for anything nontrivial).

**Read `docs/PHASE1_OPEN_ISSUES.md` first and trust it** — do NOT re-survey
the codebase; that doc's Architecture notes + the anchors below are accurate.

**State**: online co-op is playable and feels close to single-player on
LOCALHOST. Merged + owner-verified: Phases 1–2 core, the Phase 2 tail
(netsim + NetDebugOverlay + sensor-filtered replication), the identity
slice (own-ship teal engine tint + callsigns/nameplates). Owner-verified on
`feat/reconnect-hosting`: **reconnection** (tab close → RECONNECTING → seat
back with callsign) and the **latency/jitter feel** at up to 120ms + 20ms
jitter (expected cross-tab delay only — feel-tuning loop PARKED, no knob
changes requested). Built 2026-07-06: **room
lifecycle** (victory → room locks instantly + disposes after
`GameConfig.net.endedRoomLingerSec` 60s; Enter on the banner clears the
`#join=` hash and quick-matches into a FRESH room — this fixes my "Enter
doesn't restart after Victory" finding, whose root cause was the reload's
hash rejoining the still-alive ended room; post-end leaves skip the
reconnection seat-hold; the end banner survives the room's disposal) and
**copy-invite-link** (the **I** key in an online match copies the address
bar; MP-only HUD row flashes LINK COPIED; rejoin-last-match prompt
deliberately skipped — see PHASE1_OPEN_ISSUES). OWNER-VERIFIED 2026-07-06:
Enter after Victory lands in the right (fresh) room. Not individually
exercised (low risk, integration-tested): the I key and the 60s banner
linger. Hosting artifacts are in `docs/DEPLOY.md`. PROTOCOL_VERSION **22**
(18 = 2026-07-07 match scoreboard; 19 = 2026-07-07 gunship balance pass;
20 = 2026-07-07 wing-composition GameConfig restructure; 21 = 2026-07-08
ion storms; 22 = 2026-07-08 online arena selection — config lives in
shared, so it's a both-sides deploy; the DEPLOYED server still answers
v17 until the next "Deploy game" dispatch — old clients get the refresh
prompt, so deploy both halves together as always).

**Built 2026-07-07 — match scoreboard/leaderboard** (owner-requested):
every pilot ranked by kills (K/D/score columns), player row gold, human
names bright vs dim AI (nameplate honesty language). End-of-game board in
the victory/defeat banner in BOTH modes; MP adds an always-visible
bottom-left running-tally panel. Anchors: offline tally
`client/src/game/ScoreBoard.ts` (mirrors the server's `lastHitBy`
semantics; fed from `Game.onLaserHit`/`onMissileHit`/the `shipDied` sub);
view `client/src/game/Hud.ts` (`ScoreRow` + `compareScoreRows` +
`renderScoreRows`/`setScoreboard`, third arg on `setEndBanner`) + the
`.score-row`/`#scoreboard`/`.end-board` blocks in `client/src/style.css`;
server `server/src/schema/BattleState.ts` (`ScoreSchema`, UNFILTERED root
`scores` map — see MULTIPLAYER.md Decisions) +
`server/src/rooms/BattleRoom.ts` (`makeScoreSchema`/`syncScoreIdentity`,
tally in the `shipDied` relay); client feed `NetworkGame.scoreRows()`;
knob `GameConfig.scoreboard.panelMaxRows`. Test: "replicates the match
scoreboard…" in `tests/server/battleRoom.test.ts`. OWNER-VERIFIED
2026-07-07 in-game — good.

**Built 2026-07-07 — gamepad input** (owner-requested): left stick =
desired heading, screen-relative (honors the flipped north-end view),
driving the same `InputState.turn` P-controller as the mouse — no new
sim/protocol surface, NO PROTOCOL_VERSION bump needed (client-only, same
precedent as the mouse commit `9cba35f`). RT/LT thrust/reverse, A fire,
X missile, Y jump (edge), LB/RB strafe, d-pad zoom; stick self-gates vs
keyboard/mouse (deflected = wins, centered = leaves the channel alone).
Anchors: `client/src/game/GamepadSteering.ts` (the whole feature);
merge sites `Game.tick` + `NetworkGame.tick` right after `mouse.apply()`;
knobs `shared/src/GameConfig.ts` → `gamepad`; controls overlay rows in
`client/index.html`; doc `docs/SUBSYSTEMS.md` → GamepadSteering.
OWNER-VERIFIED 2026-07-07 with a physical pad — good (menu/splash stays
keyboard-only by design).

**Built 2026-07-07 — gunship balance pass + honest weapon ranges**
(owner-requested, commit `ca47f4b`): the Reaver now fires a TWIN missile
salvo (new per-type `shipTypes[*].missileSalvo`, Reaver 2 / others 1; two
rounds per pull, one ammo each, same lock, spread by `missile.salvoSpread`);
BOTH gunships turn at 3.2 (Breaker raised from 2.9, Reaver from 2.7 — turn
parity; Breaker keeps speed/strafe/reverse, Reaver keeps armor + ordnance);
`missile.lockRange` 400→130 so HUD LOCK ≈ the seeker's real ~144-unit
endurance; carrier `turrets.range` 320→180 + new `turrets.boltLifetimeMs`
2200 so flak only engages what its rounds reach (still out-ranges the
fighters' ~114). Anchors: `shared/src/GameConfig.ts` (`shipTypes`,
`missile`, `mothership.turrets`); `shared/src/sim/Ship.ts`
`tryFireMissile` (returns `Vector3[]` now) + the three spawn-loop call
sites (`shared/src/sim/BattleSim.ts`, `client/src/game/Game.ts` tick,
`client/src/game/NetworkGame.ts` prediction); salvo knob in
`client/src/game/TuningSchema.ts`. AI fighters were audited and already
fire honestly (gate 26 « 114 reach — no change). Sim baseline recaptured.
Evidence: 40-seed headless duel harness (scratchpad, not committed) —
pre-buff Reaver won 0/40 vs the Breaker (all stalemates); final config
decides 18/40 AI merges, all Reaver by ~one twin salvo of hull. NOT yet
owner-verified in-game; feel-check levers if the Reaver oppresses: the
"Missiles per launch" match-settings slider, `ai.missileCooldownSec`, or
Reaver rack 24→20. PROTOCOL_VERSION bumped to **19** (balance lives in
shared GameConfig = both-sides deploy, per the protocol.ts rule).

**Built 2026-07-07 — match-settings "Fleets & Wing" redesign**
(owner-requested; the old section was hard to use AND mostly dead): the 19
wing rows (count + 6 per-slot order dropdowns + 12 per-faction ship
dropdowns) edited the LEGACY `player.wingmen.orders`/`shipTypes` arrays,
which the sim only read when `composition` was emptied — and nothing could
empty it, so those dropdowns did NOTHING. Replaced by structure:
`GameConfig.player.wingmen` is now ROLE COUNTS
(`composition: { self: 2, other: 2, gunship: 2 }`; `count`/`orders`/
`shipTypes` deleted), resolved by the NEW shared
`resolveWingPlan(faction, shipType)` in `shared/src/WingPlan.ts` — the one
resolver for both `Game.start` (private copy deleted) and
`tests/sim/HeadlessBattle.ts` (duplicated loop deleted). Settings screen:
"Fleets & Wing" split into "Your Wing" (3 count rows,
`player.wingmen.composition.*`) + "Enemy Fleet" (the per-faction
count rows), each with a new one-line group `note` (rendered by
`SettingsMenu.render`, styled `.set-group-note` in `client/src/style.css`)
carrying the "AI flies the side you didn't pick" context once.
`TuningSchema.choice()` helper deleted (no entries left; the `choice` KIND
is still supported end-to-end). Old persisted per-slot overrides in
`lastMeridian_tuning` drop harmlessly on load (unknown paths are skipped —
they never worked anyway). 22/22 tests green, smoke baseline UNCHANGED
(the default plan expands to the identical 6-ship wing in the same order —
that's the proof the restructure is behavior-neutral). PROTOCOL_VERSION
bumped to **20** (GameConfig shape change). Docs synced: CLAUDE.md
`player.wingmen` row, SUBSYSTEMS.md (wingmen + match-settings sections),
RECIPES.md, ROADMAP.md. NOT yet owner-verified in the browser (the new
rows + notes need one visual pass).

**Built 2026-07-08 — Field Manual** (owner-requested "hit the ground
running" guide): a 6-card self-paced deck (flight / weapons / carrier ops +
Meridian Drive / ship roles / battlefield / HUD-sensors) as a splash
overlay. ALL text lives in `buildCards()` in
`client/src/game/FieldManual.ts` — the owner wants to revise copy over
time; edit lines there, timing numbers (spool/cooldown/commit seconds,
missile burn, ghost memory) interpolate live from GameConfig so retuning
re-words the manual. Visuals are game-rendered, no art assets: ShipPreview
thumbnail captures (`preview.thumbnail(id)`), HUD-color specimen chips,
inline SVG diagrams (`visual*()` builders, same file). Wiring: footer-rail
"Field Manual" link (`LoadoutMenu.railBottom` + `LoadoutActions.openManual`
→ `main.ts openManual()`); first-timers are pointed at it by the gold
"ROOKIE PILOTS — review the FIELD MANUAL" strip above the footer rail
(`LoadoutMenu.rookieCallout`, `.lo-rookie` styles) which shows until the
manual is first opened (key `lastMeridian_guideSeen` in
`client/src/game/Loadout.ts`; opening marks it seen — there is NO forced
auto-open, owner picked callout-over-interruption 2026-07-08);
`#field-manual` root in `client/index.html`;
`.fm-*` styles in `client/src/style.css` (controls-overlay dress).
Keyboard: ←/→/Enter page, Esc closes; `LoadoutMenu.onKeyDown` yields while
the manual is open (same pattern as the controls overlay). Typecheck +
22/22 tests green. Deck layout owner-verified 2026-07-08 (font scale
bumped on feedback — `.fm-*` sizes); the rookie callout is NOT yet
owner-verified (clear `lastMeridian_guideSeen` to see it). CLAUDE.md file map
was also rewritten this session to the REAL workspace layout
(client/shared/server split) — it had still shown the pre-multiplayer
`src/` tree.

Built 2026-07-08 (this session): **ION STORMS** — damaging terrain, the
electric sibling of the stealth nebulas. A ship inside a storm zone takes a
lightning zap (`GameConfig.storms.zapDamage` every `zapIntervalSec`, first
zap on entry) AND is concealed exactly like a nebula (hurt-to-hide); AI
pilots steer around the banks, so storms carve maps into navigation lanes.
Anchors — sim: `shared/src/sim/StormSystem.ts` (tryZap, ram-cooldown
pattern) + `StormZones.ts` (footprint math), `stormZap` in
`shared/src/sim/SimEvents.ts`, zap loops = `resolveStormZaps` in BOTH
`BattleSim.advance` and `Game.advanceSim`; concealment = the
`[...nebulas, ...storms]` concat where each wires
`sensors.concealmentZones`; keep-outs pushed in each `refreshAiObstacles`.
View: `client/src/game/StormClouds.ts` (CombatNebulas recipe, one blue-cyan
tint + interior flicker w/ `pop()`), `LightningSystem.ts`/`LightningBolt.ts`
(ambient in-cloud bolts + `strike()` on every zap; jagged emissive ribbons),
`Radar.plotStormZone` (cyan discs; radar.update grew a `stormZones` param —
both call sites updated). Config: `GameConfig.storms` (sim) + `stormFx`
(view); 2 knobs in `TuningSchema` (Arena & Asteroids). Maps:
`MapConfig.stormZones` + the new **"The Tempest"** preset (`Maps.ts`
`theTempest` — midline storm wall, center lane w/ a stealth nebula, picket
storms on the flanks). Online: `stormZap` NetEvent relayed
(`BattleRoom` → `NetworkGame.playEvent`; ship id ONLY — the client depicts
a strike only when it holds a pose, so sensor-hidden victims don't leak) —
**PROTOCOL_VERSION bumped to 21**. Storm kills award no kill credit
(no weapon attribution; the death still counts). Stock config has ZERO
storm zones so the headless baseline is untouched (22/22 green). Docs:
SUBSYSTEMS "Ion storms", ARENA-MAPS table, ROADMAP, CLAUDE.md file map +
config table, Field Manual terrain card grew a storm line. NOT yet
owner-verified in-game (pick The Tempest on the MISSION step).

**Built 2026-07-08 — online arena selection (the ROOM owns the map)**
(owner-requested; online matches previously always ran the stock vanilla
board — `applyMap` was solo-only and `BattleRoom` had no map concept).
Flow: the arena picker now ALSO shows on the online MISSION step
(`LoadoutMenu.rows()`/`stageMission()`); the saved selection rides
`JoinOptions.mapSelection` (`NetClient.options`, fed by `main.ts`
`startOnline`); `BattleRoom.onCreate(options)` validates
(`isMapSelection`) + resolves "random" + `applyMap(mapId)` BEFORE
`new BattleSim()`, then replicates `BattleState.mapId`; the client awaits
`NetClient.mapId()` (first-state race guard) and applies the server's map
into local GameConfig before constructing `NetworkGame`. Joiners inherit
the host's board; a joiner's selection is ignored. Anchors: catalog +
applier MOVED to `shared/src/Maps.ts` (injectable `MapOverrideHooks` —
solo passes the ConfigOverrides predicates via the client shim
`client/src/game/Maps.ts`, server/online pass none so local tuning can't
desync the board); `server/src/rooms/BattleRoom.ts` onCreate;
`server/src/schema/BattleState.ts` `mapId`; `client/src/net/NetClient.ts`
`mapId()`; `client/src/main.ts` `startOnline`. NetworkGame grew WRECK
support (The Wreck online): local `Hulk` sims + `HulkView`s from
`GameConfig.hazards`, poses integrated on the render clock like the
replicated rocks, sections in the cosmetic-bolt obstacle list
(`cosmeticObstacles` — separate from `rockObstacles`, which the radar
draws), prediction bump via the NEW shared `bumpShipOutOfHulkSection`
(extracted from `BattleSim.resolveHulkCollisions`). PROTOCOL_VERSION
**22**. Multi-room caveat documented on the shared `applyMap` (GameConfig
is process-global; all map fields are construction-time reads). Tests: the
server suite pins `mapSelection: "openVoid"` in `joinOpts`
(`tests/server/battleRoom.test.ts`); 22/22 green + typecheck.
**Found+fixed in browser verification (blank-screen bug)**: The Belt's
95-rock initial state overflowed @colyseus/schema's 8KB
`Encoder.BUFFER_SIZE` — and `encodeAllView` (the StateView path our
sensor-filtered `ships` map forces every client through) slices the STALE
pre-resize buffer, silently TRUNCATING the joining client's full state
(upstream bug; the last ~18 rocks decoded with undefined fields → NaN
AsteroidSims → the prediction's collision bump NaN-poisoned the camera →
blank scene, live HUD). Fix: `Encoder.BUFFER_SIZE = 64 * 1024` set in
`server/src/schema/BattleState.ts` (imported by the server entry AND the
test boot). Verified 2026-07-08 in-browser: Belt online joins with 95/95
healthy rocks, zero NaN, scene renders. Symptom signature if a future map
outgrows 64KB: same blank screen + "@colyseus/schema buffer overflow"
warning in the server log.
OWNER-VERIFIED 2026-07-08: Belt online (post buffer fix), invite join
inherits the host's arena, and the invite MISSION step now HIDES the
picker (a joiner's pick can't apply — quick match keeps it, since that
join may create the room). Two-tab run also exercised The Wreck online
(hulk replicated + depicted on both clients).

**Built 2026-07-08 — MAP EDITOR** (owner-requested admin authoring tool;
Tier 1 of the scoping discussion — output is CODE, maps stay compile-time
presets, no runtime custom maps, no protocol change): splash state
`mapEditor` via the loadout footer's "Map Editor" link. Top-down 2D canvas
(+X right, +Z up) + brush palette: nebula / storm / rock field / wreck
circles (click stamps + hold-drags, scroll resizes, right-click/Delete
erases), the two carriers drag along the lane (x=0). Side panel: name/blurb
(id auto-derives camelCase), carrier Z, asteroid scalars, selected-object
fields (wreck: heading/scale/spin rates/source faction). COPY MAP emits a
paste-ready MAPS entry as catalog-style TS source (bare keys; owner
rejected the earlier quoted-key JSON as ugly to paste — `tsSource`/
`quoteBareKeys` in MapEditor.ts are the emit/import pair, + reminder
comment to extend `ConcreteMapId`); IMPORT round-trips it. Draft auto-saves
(`lastMeridian_mapDraft`, stored AS the exported MapConfig shape). TEST
FLIGHT solo-launches the draft via the NEW shared `applyMapConfig`
(refactored applier body of `applyMap` in `shared/src/Maps.ts`; no
override hooks — the draft plays as designed); a `lastMeridian_testFlight`
sessionStorage flag makes Enter-restarts replay the draft, any normal solo
launch clears it. Fractional-vs-world unit split (nebula/storm zones vs
regions/hazards) is hidden — editor is world-units throughout, converts on
export/import. Anchors: `client/src/game/MapEditor.ts` (the whole tool +
`loadDraftMap`); `client/src/main.ts` (state `mapEditor`, `testFlightMap` +
`TEST_FLIGHT_FLAG` in `startGame`/the restart path); `LoadoutMenu.ts`
(`LoadoutActions.openMapEditor` + footer button); `#map-editor` root in
`client/index.html`; `.med-*` styles in `client/src/style.css`; docs
CLAUDE.md (file map + out-of-scope menu exception now TWO) +
SUBSYSTEMS.md "Map editor". Typecheck + 22/22 green. NOT yet
owner-verified in the browser.

**Built 2026-07-08 — projectile tunneling fix (both-body swept collision)**
(from the owner's friends-playtest finding: missiles flew straight through
opposing players and looped back). ROOT CAUSE: `MissileSystem` tested a
point at the missile's end-of-tick position; at the server's 30Hz a head-on
pass closes ~2.4 u/tick vs a fighter's 2.0u capture diameter, so dead-center
hits skipped the circle entirely (~25% of true hits ghosted); `LaserSystem`
swept only the bolt while pinning the target at end-of-tick (~7.5% ghosted).
FIX: both weapon systems now sweep the closest approach of BOTH bodies'
per-tick paths — `sweptClosestT` in `shared/src/math.ts`; the target's
tick-start is reconstructed `position - velocity * dt` (new optional
`DamageTarget.velocity`; teleports zero velocity so the sweep collapses to
a point — jump drive can't smear a phantom hitbox). Hits now report the
CONTACT POINT (kills the "explosion pops behind the ship" client depiction).
Regression suite `tests/sim/missileTunneling.test.ts` pins the sim against
an independent dense-sampling continuous-time oracle (it FAILS on the old
code: 3/6). Baseline recaptured (18,349 → 35,575 ticks — more shots land,
fleet attrition changed; outcome still victory). NOTE: an identical fix was
built + verified earlier on 2026-07-08 but never committed; the owner
retested against code that couldn't have contained it (the DEPLOYED server
runs the collision test) and discarded it as ineffective. THE RETEST MUST
RUN ON A SERVER BUILT FROM THIS CODE: local `npm run server` + two tabs, or
owner-dispatched "Deploy game" first. 32/32 tests green. NO protocol bump
(sim behavior, no wire shape change) — but server redeploy required to take
effect online.

**Built 2026-07-08 — predictive missile contact fuse (client depiction)**:
owner's local retest of the tunneling fix confirmed the SERVER hit lands,
but exposed the depiction seam it had been masking: our OWN missiles launch
from the PREDICTED ship (`NetworkGame.updatePrediction`) ~a round trip +
`net.interpDelayMs` ahead of the render timeline, so the depicted round
visibly flew THROUGH the enemy and the `missileHit` boom popped behind it
~130ms later. Fix (client-only, no protocol change): `fuseFriendlyMissiles`
detonates our faction's depicted rounds on contact with a rendered enemy
hull (`ShadowShip` now carries the type's `hitRadius`), logs the boom in
`localDetonations`, and the echoing `missileHit` event is consumed by
`consumeLocalDetonation` instead of double-popping. Damage is never
predicted; hits ON US never consume (enemy-pool rounds are untouched —
being hit stays authoritative). If the server misses after a fuse pop, the
entry just expires (600ms): one boom that dealt nothing, the standard
prediction trade. Anchors: `client/src/game/NetworkGame.ts`
(`fuseFriendlyMissiles` / `consumeLocalDetonation` / `localDetonations`,
fuse call after the cosmetic pools in `tick`, dedup atop the `missileHit`
case in `applyFxEvent`, `ShadowShip.hitRadius`). Known remaining seams,
deliberately unfixed: our own LASER bolts overfly the same way (~12u at 95
u/s) before `killNearestBolt` — fainter artifact, watch for owner reports;
missiles into CARRIER hulls/turrets/rocks still boom event-late (fuse only
covers ship shadows).

**Built 2026-07-17 — strategic layer M1: mothership subsystems**
(owner-approved plan, trimmed core of
`docs/the-last-meridian-strategic-persistence-design.md`; M2/M3 queued
below as item 5). Each carrier now mounts 2 destructible SHIELD GENERATORS
+ 1 HANGAR (the Turret pattern minus the gun —
`shared/src/sim/MothershipSubsystem.ts`, config
`GameConfig.mothership.subsystems`): while any generator lives, hull
damage is ×`shieldedHullDamageFactor` (0.2, nonzero = anti-stall;
gate lives in `Mothership.takeDamage`); hangar death multiplies the
faction's respawn delay (`Ship.respawnDelayScale`, applied by the
death-latch scans in `BattleSim.advance` + solo `Game.advanceSim` —
BOTH loops, as ever). Strike AI + carrier missile doctrine prefer the
nearest live generator while shields are up
(`AIController.nearestLiveShieldGenerator`); FleetCommander's carrier
alert now sums subsystem HP. New SimEvents `subsystemDestroyed`/
`shieldsDown` → NetEvents + relay (`BattleRoom.wireEventRelay`) + schema
slots `shield0Hp/shield1Hp/hangarHp` on `MothershipSchema` (mid-match
joiners correct; netsim clone untouched on purpose — mothership state
rides the live-root path like HP). Client: `SubsystemView` (procedural
dome/bay-strip, dies to a stump; GLB empties can re-seat later),
`MothershipView.syncSubsystems`, HUD pips under the carrier bars +
strategic toasts (`Hud.setSubsystems`/`showStrategicToast`).
PROTOCOL_VERSION **24**. Baseline RECAPTURED (intended gameplay change:
24147→28095 ticks, 55→69 deaths — shields lengthen the carrier kill);
`tests/sim/subsystems.test.ts` covers gating/latch/respawn-scale. NOT
owner-verified in-game yet (see work item 0d); shield/hangar MOUNT
POSITIONS are config-eyeballed, not GLB-fitted — expect to nudge them.

**Built 2026-07-18 — STATION-POWERED carrier shields** (owner-decided
redesign SUPERSEDING M1's destructible shield generators — the owner
disliked the generator placeholder hardware + a prototyped shield-bubble
visual, and the fighters-have-no-shields fiction gap; carriers' shields now
draw power from the strategic layer instead). The two "shield"
MothershipSubsystems are REMOVED (hangar stays); hull damage is multiplied
by `Mothership.stationShieldFactor` — graduated by capture-station
ownership: `1 - (1 - stations.shield.minFactor) × (owned/total)`, so 0
stations = full damage, all 3 = 0.2 (= the old shielded factor; NONZERO
floor keeps the anti-stall guarantee). Written declaratively each tick by
`StrategicSystem.applyEffects` (both loops; solo Game owns its own
StrategicSystem) and mirrored client-side in online play from the
replicated station owners (`NetworkGame.mirrorStations`, runs BEFORE FX
playback) — ZERO new wire data. Station-free maps (The Veil, The Wreck,
headless smoke) fly unshielded by design. New SimEvents/NetEvents
`shieldsOnline`/`shieldsDown` fire on the per-faction 0↔≥1 owned-station
edges (StrategicSystem edge detection; toasts "SHIELDS ONLINE — STATION
POWER" / "SHIELDS OFFLINE — NO STATION POWER"). HUD: station-power shield
segments under each carrier bar (`Hud.setShieldPower`, one per station, lit
while owned) + the hangar pip. In-field FX: ONLY the shield hit-splash
(`ShieldHitFlash{,System}.ts` — faction-tinted translucent splash where
shots land on a shielded hull; solo from `Game.onLaserHit/onMissileHit` via
`MothershipSection.owner.shieldsUp`, online via
`NetworkGame.shieldedCarrierAt`); the shield bubble, generator hardware, and
shield GLB seam were all deleted. AI: generator-targeting removed
(strikers press hull/turrets; the commander's capture rung is now also the
shield fight). Schema: `shield0Hp/shield1Hp` slots removed (hangarHp
stays). PROTOCOL_VERSION **26**. Baseline RECAPTURED: 28095→24187 ticks,
69→55 deaths (unshielded smoke map ≈ pre-M1 pacing; battle still ends).
Tests: `subsystems.test.ts` rewritten (graduation/edges/hangar),
`stations.test.ts` repair test now wounds the hangar. NOT owner-verified
in-game yet — see work item 0d.

**Built 2026-07-18 — 20s respawn bench + redeploy countdown + T3 =
TURRET OVERDRIVE** (owner-decided rebalance, second 07-18 session).
(1) Respawns: `combat.playerRespawnDelayMs`/`enemyRespawnDelayMs`
1.5s/3s → **20s BOTH** — a death benches you; kills buy real board time;
the T1 ×0.6 upgrade and the hangar ×2.5 penalty now bite against a base
worth scaling. Match-settings respawn sliders now go to 60s. (2) HUD: respawn countdown ring
(`Hud.setRespawnCountdown` + `.respawn-ring` in `style.css` — the
jump-ring recipe in warning red, upper-center, whole seconds then tenths
under 10s, REDEPLOY label). Solo wired in `Game.updateViews` off new
`Ship.respawnRemainingMs(nowMs)`/`respawnTotalMs`; online in
NetworkGame's predicted-ship block, timed locally from the alive→dead
edge × `NetworkGame.respawnScaleFor` (hangar penalty × replicated
fasterRespawn tier — mirrors StrategicSystem.respawnScale; cosmetic, the
server owns the real clock; online seats all spawn with
`enemyRespawnDelayMs`). (3) T3 effect renamed `subsystemRepair` →
**`turretOverdrive`** (PROTOCOL_VERSION **27** — deploy both halves
together): on unlock, one-shot revive/refill of that faction's carrier
TURRETS (`StrategicSystem.repairTurrets`; the turret death latch is now
the per-turret `explosionFired` flag in BOTH loops — BattleSim's
`deadTurretsAnnounced` Set removed; `TurretView` un-stumps on revive);
persistently after, a FULL-hp turret fires at
`energy.overdriveCooldownScale` (0.8) × cooldown for
`overdriveDamageScale` (1.3) × damage (`Turret.update` 4th arg; flag =
`Mothership.turretOverdrive`, written declaratively by
`StrategicSystem.applyEffects` — chip a gun below full and it drops to
stock stats, so the counterplay stays "shoot the guns"). The HANGAR now
has NO repairer — destroyed is destroyed. Toast label "TURRET
OVERDRIVE"; overdrive knobs in the Carrier Turrets match-settings group.
Tests: the stations.test.ts T3 test wounds a turret now. Known
pre-existing gap (unchanged): turret HP is NOT replicated online, so
mirror turrets never die/un-stump client-side. (4) HANGAR GOES DIEGETIC
(the session's original ask — owner disliked the placeholder box bolted
to the deck, and it wasn't even at the real bay): the box + bay-light
strip are DELETED from `SubsystemView` — while healthy, the carrier
GLB's own modelled launch bays ARE the hangar. The sim mounts are
RE-ANCHORED from the eyeballed spots (Bastion bow tip 0/138!) to BOTH
bays: humans (±38.2, z 110 — the BAY-FLOOR center biased toward the
mouth, NOT the measured launch empty at z 86.9: there the hit circle
stopped short of the bow-taper hullRect, so shots INTO the bay entrance
died on the hull first — owner-reported), machines (±41.3, 23.3);
`hitRadius` 16→22 so each circle pokes past the hullRects halfWidth on
its flank (38.2+22>51 / 41.3+22>53 — subsystems must overhang the
silhouette to out-prioritize hull sections) and past the humans
bow-taper boundary for mouth shots. The two
mounts are INDEPENDENT destructibles (owner rejected a shared pool:
"one bay dies → both die" felt wrong): own 350-hp pool PER BAY
(`subsystems.hangar.hp` is per bay now; was briefly 200 — owner: "died
in 3-4 hits", a Breaker volley run), and the respawn penalty
GRADUATES — `StrategicSystem.respawnScale` computes
`1 + (destroyedRespawnDelayScale-1) × dead/total` (one of two bays
down = ×1.75, both = ×2.5; `NetworkGame.respawnScaleFor` mirrors it for
the redeploy countdown). Respawn relaunches RE-ROUTE around dead bays:
`Mothership.getLiveLaunchBayIndices()` (nearest-hangar-mount pairing;
falls back to ALL bays when the whole complex is down — launches never
stop, anti-stall), consumed by both respawnShip sites (solo
Game.respawnShip / BattleSim.respawnShip). Wire: the `hangarHp` slot →
`hangar0Hp`/`hangar1Hp` (index-aligned with the config mounts;
BattleRoom.syncSubsystems ↔ NetworkGame.applySubsystemHp), and the
subsystemDestroyed NetEvent carries `remaining` (bays still alive) —
toast copy graduates in BOTH toast sites: "HANGAR BAY DESTROYED" per
bay, "HANGAR DESTROYED — LAUNCH CREWS CRIPPLED" on the last. HUD shows
one pip PER BAY. DAMAGE FEEDBACK is pure SPARK FX (owner rejected the
first-pass ember cluster, then a subtle boosted-glint pass — "too
subtle, needs to be constantly emitting and much larger"):
`ExplosionSystem.spawnSpark(pos, profile)` takes a spark PROFILE, and
`GameConfig.impactSpark.hangar` is a CARRIER-SCALE one (1.1-unit
slivers, 650ms, flashRadius 2.2 — the stock impactSpark is
fighter-scale 0.18-unit glints and reads as nothing on a carrier) with
a per-sliver FIRE `palette` (white-hot/yellow/orange/deep-red,
components >1 for bloom punch; `ExplosionSystem.matsForPalette` caches
the materials). `SubsystemView.update` reads the bay's hp fraction
(via MothershipView.syncSubsystems): every hp DROP throws an immediate
fire burst; ONLY a fully DESTROYED bay burns continuously
(`hangar.emitIntervalMs` 260, jittered — owner call: the constant burn
is the "it's dead" read, not a damage meter; a wounded bay is quiet
between hits). DEAD TURRETS run the SAME burn (TurretView dead
branch, same profile). The ExplosionSystem reaches both view kinds via
`MothershipView.setExplosions` (carrier views construct BEFORE the FX
block in both loops — wired right after `new ExplosionSystem`). ONLINE
turret-death gap CLOSED: turret HP isn't replicated, so NetworkGame's
`turretDestroyed` handler now kills the nearest MIRROR turret (stump +
burn appear online) and `upgradeUnlocked(turretOverdrive)` revives
that faction's mirror turrets (un-stump on T3). Bay HP was already
replicated, so hangar FX replay online unchanged. TURRETS WERE
GENUINELY IMMUNE (owner-reported, confirmed vs the hull-collider
boxes): the turret mounts had moved inboard to the GLB
pod-ridge/sponson positions (humans |x|=38 vs pod-box edge 50.9,
machines |x|=42 vs sponson edge 53) while `turrets.hitRadius` stayed 8
— the hit circle sat fully INSIDE the hull silhouette, so hull
sections ate every bolt first (registration order only helps when the
same tick-segment crosses both). FIX: `hitRadius` 8→15 (needs >12.9 /
>11 — the config comment now documents the bound; re-check when
mounts or hull colliders move). Related: a LIVE hangar circle (r22)
still shadows bolts crossing it (frontal runs at the fore turrets) —
off-axis approaches are clean, dead subsystems stop absorbing.
Baseline RECAPTURED three times (respawn+anchor 24187→25409,
mouth-anchor/r22 →26986, turret-hitRadius →28961 ticks, 56 deaths;
battle still ends — flak dies mid-battle now, as designed). REMEMBER
friendly fire doesn't exist
for subsystems: only OPPOSING weapons register them — shooting your own
carrier's bay does nothing (likely part of the owner's confusion; the
other part: they shot the starboard bay when only port was mounted).
NOT owner-verified in-game yet: check each bay takes damage + smolders
independently, per-bay toasts, respawns re-routing to the surviving
bay, and how the graduated bench feels (35s one bay / 50s both, off the
20s base) — "Hangar bay HP" and "Hangar-down respawn ×" are the
match-settings knobs.

**Built 2026-07-17 — strategic layer M2: capture stations + Energy +
upgrade thresholds** (same session as M1; full design in
`docs/strategic-layer-plan.md`). Neutral stations a faction flips by
DOCKING (inside `stations.captureRadius` below `stations.dockMaxSpeed` —
the service-bubble loiter gate; contested = frozen; enemy flips are
two-stage drain→neutral→capture): `shared/src/sim/CaptureStation.ts` +
`StrategicSystem.ts` (stations, per-faction Energy, auto thresholds
100/250/500 → fasterRespawn / sensorBoost / subsystemRepair, and the
DECLARATIVE per-tick effect application — Ship.respawnDelayScale is now
recomputed every tick as hangarPenalty × upgrade, the M1 latch write is
gone, and subsystem death latches moved to `explosionFired` so repair
re-arms them). Map opt-in like storms: `GameConfig.stations.placements`
empty on stock config (baseline UNTOUCHED — the M2 acceptance gate),
`MapConfig.stations` via applyMapConfig; layouts added to The Void, The
Belt, The Tempest. AI: new `"capture"` AIOrder + `setCaptureTarget`
(guard bubble = `ai.captureEngageRange`), FleetCommander tasks
`commander.captureCount` pool ships (priority: defend > capture > hunt),
`ControllerWorld.stations`. Sensors: `SensorSystem.rangeScale` per
faction. Wire: `StationSchema` map + energy/tier root fields,
NetEvents stationCaptured/stationNeutralized/upgradeUnlocked,
PROTOCOL_VERSION **25**. Client: `StationView` (procedural pylon/beacon +
dock-radius ring; GLB seam ready via `stations.model.file`, null today —
owner authors the model later), radar station squares w/ capture arcs
(`Radar.plotStation`), HUD Energy lines + tier pips (`Hud.setEnergy`) +
toasts, SubsystemView revival, "Subsystems & Stations" match-settings
group (TuningSchema). Tests: `tests/sim/stations.test.ts` (9). M3 (Loom
event) still queued in item 5. Post-M2 refinements from owner feedback
same session: (a) **capture-status HUD line** — bottom-center above the
jump ring while docked ("CAPTURING STATION 43%" / "NEUTRALIZING…" /
"DRAINING ENEMY PROGRESS…" / "CAPTURE CONTESTED" / "REDUCE SPEED TO
DOCK"), shared composer `captureStatusFor` in `client/src/game/Hud.ts`
(+ `setCaptureStatus`), computed per frame in `Game.updateViews` and
NetworkGame's predicted-ship block; (b) **faction identity colors** —
StationView + SubsystemView ownership tint now uses
`FACTION_THEME.engineHot` (Commonwealth blue / Novari red, matching
radar + HUD), NOT `laserEmissive` (humans' pink lasers made a
human-owned station read RED — owner caught it). Owner has flown
stations at least once (color bug report); full check still item 0e.

**Built 2026-07-18 — map-editor stations + sticky brushes + "The Eye"**
(owner-requested, third 07-18 session). (1) STATION BRUSH: the map editor
can now paint capture stations — green wheel-and-spokes markers with the
dashed dock ring drawn at the real `GameConfig.stations.captureRadius`
(global knob, so stations are position-only: no scroll-resize, panel shows
X/Z + delete). Full round-trip: COPY MAP exports `stations` fractions,
IMPORT/LOAD PRESET/draft autosave all carry them (station presets like The
Void now load their rows into the editor). TEST FLIGHT needed zero changes
(`applyMapConfig` already wrote `map.stations`). N stations is naturally
supported everywhere (StrategicSystem/views/radar all iterate; the shield
factor is owned/total-graduated) — but Energy income scales with station
COUNT against fixed 100/250/500 thresholds, so dense-station maps climb
the upgrade ladder faster; a balance lever to watch, not a bug. (2) STICKY
BRUSHES (owner: "stop re-typing the same radius"): editing a placed
shape's attributes — zone radius via panel or scroll, any wreck field
(heading/scale/spin/source) — re-seeds that kind's brush; next stamps +
the ghost preview repeat the last-tuned values. Per-kind, session-only
(not part of the persisted draft). (3) **The Eye** (`theEye`): first
editor-authored catalog map, byte-exact from the owner's draft (pulled
from `lastMeridian_mapDraft` via the browser). Four huge corner storms
(r 335–400) pinch a cross of lanes; one big center nebula (r 145, the
"eye") where the carrier corridors converge; four rock clusters ringing
it; TWO stations at the flank-lane mouths. Anchors: brush + sticky work
all in `client/src/game/MapEditor.ts` (Tool/Selection unions, `stations`
array, `brushRadius`/`brushHulk`, `drawStation`, buildMap/loadMap);
catalog entry + `ConcreteMapId` in `shared/src/Maps.ts`; docs ARENA-MAPS
table / ROADMAP / SUBSYSTEMS "Map editor" / CLAUDE.md file map. Typecheck
+ 52/52 green (map is data-only — no protocol bump, but online it needs
both halves deployed so server + client both know `theEye`). NOT yet
owner-verified: The Eye in the picker + a full flight on it (does the eye
funnel fights as designed? two stations = slower Energy than the
3-station maps — intended?), and the station brush/sticky-brush feel.

**Owner goal**: a friends playtest — HOSTING IS LIVE (provisioned
2026-07-06, CI-path verified same day). Topology in `docs/DEPLOY.md`
("Provisioned state" section has every detail): ONE DigitalOcean droplet
(1GB, Ubuntu 24.04, `Meridian-Multiplayer-Server`) serving both halves via
Caddy — client = static bundle at `https://the-last-meridian.com`
(`/var/www/the-last-meridian`, `wss://` URL verified baked in), server =
systemd unit `space-duel` on :2567 behind
`wss://play.the-last-meridian.com`, protocol v17 answering "Colyseus
0.17.44". The client MOVED OFF GitHub Pages 2026-07-06 (Pages workflow
deleted; Vite `base` is now `/`). CI deploy = Actions → **"Deploy game"**
(manual dispatch, ships client + server from ONE checkout — the
same-commit PROTOCOL_VERSION rule is automatic; agents' local `gh` token
can NOT dispatch it, owner clicks). The old "don't push main" constraint
is RETIRED; nothing auto-deploys on push anymore.

**My playtest findings**: <fill in — deployment progress / friends
playtest results: what broke, what felt off, overlay numbers if netcode>

**Work order**:

0a. **Verify the tunneling fix ON A SERVER RUNNING IT** (built 2026-07-08,
   see the state paragraph above — this is the second landing of this fix;
   the first was discarded after a retest that never exercised it): deploy
   both halves ("Deploy game" dispatch, owner clicks) or run
   `npm run server` locally with two browser tabs, then joust head-on with
   missiles. Missiles should now detonate ON the hull; designed near-misses
   (hard jukes beating `missile.turnRate`) still loop back but pass to the
   SIDE, never through the centerline. Anchors:
   `shared/src/sim/MissileSystem.ts` + `LaserSystem.ts` target loops,
   `sweptClosestT` in `shared/src/math.ts`,
   `tests/sim/missileTunneling.test.ts`.
0. **Owner check of the ion storms** (built 2026-07-08, see the state
   paragraph above for anchors): launch The Tempest, verify the storm
   clouds read as danger (cyan + lightning), zap pacing feels fair
   (`storms.zapDamage`/`zapIntervalSec` are match-settings knobs), the AI
   actually flies the lanes, and hiding in a storm breaks lock/track.
   Balance findings → GameConfig/`Maps.ts` `theTempest` zone tweaks.
0b. ~~Owner check of online arena selection~~ DONE 2026-07-08 (see the
   state paragraph): Belt + Wreck verified online two-tab; The Tempest
   online not individually exercised (low risk — same zone/replication
   path as nebulas, stormZap event predates this work). Remember: both
   halves must be deployed together (v22).
0c. ~~Owner check of the map editor~~ DONE in practice 2026-07-18: the
   owner authored a full map in it (The Eye — storms, nebula, rock
   regions, stations, name + blurb) and it's now in the catalog. Remaining
   editor-adjacent checks folded into 0g.
0g. **Owner check of The Eye + the new editor brushes** (built 2026-07-18,
   see the state paragraph): pick The Eye on the MISSION step and fly it —
   does the center eye funnel the fight, do the AI lanes read, is
   two-station Energy pacing right (vs the 3-station maps)? In the editor:
   stamp a few stations (green ring markers), confirm sticky brushes
   (resize one nebula, next stamps match). Online it needs both halves
   deployed (new `ConcreteMapId`).
0d. **Owner check of the hangar subsystem + station-powered shields**
   (M1 built 2026-07-17, shields redesigned 2026-07-18 — see the state
   paragraphs): solo on a STATION map (The Void / The Belt / The Tempest) —
   pre-capture, carriers take full damage and show hollow shield segments
   under their HUD bars; capture a station → "SHIELDS ONLINE" toast + a lit
   segment + faction-tinted splashes where shots land on the shielded hull
   (distinct from bare-hull sparks); segments/damage scale per station
   (knob: `stations.shield.minFactor`); losing the last station → "SHIELDS
   OFFLINE — NO STATION POWER" and the splashes stop. Check the enemy AI
   still contests stations (`commander.captureCount`) and the hangar
   (NOTE 2026-07-18: no placeholder box anymore — the hangar is the
   carrier's OWN port launch bay, destruction shows as a burning breach
   there; it is no longer repairable, T3 is TURRET OVERDRIVE now; mounts:
   `GameConfig.mothership.subsystems.hangar.mounts`). The Veil /
   The Wreck: no segments, no shield toasts, unshielded carriers. Deploy
   note: v26 — both halves together, as always.
0f. **The freeze bug — STILL OPEN** (2026-07-17): multi-second freeze
   every ~20–30s. CRITICAL re-rank: the owner reproduced it LOCALLY in
   SOLO mode, which rules out the server-GC hypothesis and clears the
   already-landed client fixes as the root cause (his dev run included
   them) — the cause lives in solo+online shared code (view stack / FX /
   sim) or the environment. Full record + the next evidence step (a
   DevTools Performance recording across two freezes, and a clean-tree
   control run) at the TOP of **`docs/perf-freeze-investigation.md`**.
   What landed anyway as hygiene (commit `56837f2`, this branch): the
   droplet heap cap (`deploy/space-duel.service`; reinstall BY HAND —
   one-liner in the unit header, the deploy workflow doesn't ship unit
   files), the GlowLayer include-list leak fix
   (`client/src/game/GlowInclude.ts` `includeInGlow`, all former
   `addIncludedOnlyMesh` sites converted — a grep for the raw call
   should stay empty), the scoreboard-cadence + fxQueue-drain-cap fixes
   in `NetworkGame.ts`. Rollback if ever needed: `git revert 56837f2`.
0e. **Owner check of capture stations + Energy** (built 2026-07-17, see
   the state paragraph): launch The Void solo — three station beacons on
   the midline; slow down inside a dock ring to flip one (toast + radar
   arc + Energy line under your carrier bar); watch enemy pilots contest
   (commander sends `commander.captureCount` = 2); let Energy cross
   100/250/500 and feel each upgrade. Pace knobs live in the new
   "Subsystems & Stations" match-settings group. Deploy note: v25 — both
   halves together.
1. **The friends playtest** — everything before it is DONE and
   owner-verified working (2026-07-06): apex DNS + cert live, Pages
   unpublished (old URL 404s), unified "Deploy game" workflow proven
   end-to-end, matches join at `https://the-last-meridian.com`. Just
   invite friends and play; bring findings back as work items.
2. **Fixes from the friends playtest, if any** — rematch/lifecycle seams
   if something surfaces there: server `BattleRoom.onMatchEnded` (lock +
   delayed `disconnect()`), the `matchEnded` branch in `onLeave`, the
   `this.sim.ended` check in `step()`; client `NetworkGame.onKeyDown`
   (Enter/Esc + `clearInviteHash`) and the `this.ended` early-return atop
   `NetworkGame.updatePhase`. Test: "locks + disposes an ended match…" in
   `tests/server/battleRoom.test.ts` (it shrinks
   `GameConfig.net.endedRoomLingerSec` and restores it in `finally`).
   - **FIXED 2026-07-07 — honest join-failure messaging**: faction-full is
     now the typed `FACTION_FULL` (4002) in `shared/src/protocol.ts`.
     Client (`client/src/main.ts` startOnline) differentiates: invite +
     faction-full → stays on splash with "switch factions to join" (the
     `#join=` hash survives, so relaunch retries the friend's room); invite
     room gone/locked/full → STOPS on the splash with "FRIEND'S MATCH
     UNAVAILABLE — relaunch for a new room" + drops the dead hash
     (`clearInviteHash`, hoisted into `NetClient.ts`) so the next launch
     press quick-matches (NO auto-fallback: a successful fallback hides the
     splash in ~200ms, the message was unreadable — owner caught this);
     quick-match faction-full → `NetClient.createMatch` (fresh room via
     `Client.create` — joinOrCreate would re-match the same full room).
     Test: "refuses a faction-full join…" in
     `tests/server/battleRoom.test.ts`. NO protocol bump (4002 was already
     on the wire; only newly named/handled). NOT owner-verified in-game.
3. **Feel-tuning loop** (parked, reopen only if the DEPLOYED game feels
   worse than the netsim predicted): knob → symptom map — remote ships
   stutter → `interpDelayMs` (overlay "headroom" ≤0 = buffer starvation);
   own-ship micro-jerks → `correctionRate`/`correctionSnapUnits`; input
   feel under jitter → server `inputBacklogMax` (overlay "ack lag" creeping
   = too high). Anchors: `shared/src/GameConfig.ts` → `net`;
   `client/src/game/NetworkGame.ts` → `recordSnapshot`/`reconcile`/
   `updatePrediction`; `client/src/game/NetDebugOverlay.ts`;
   `client/src/net/NetClient.ts` `send` + `client/src/net/DelayQueue.ts`.
   The committed `net.sim` profile is the owner's 120/20 (dormant,
   `enabled: false`).
4. **Post-deploy niceties, only if asked**: player count / room browser,
   spectate, persistent stats — none are scoped; propose before building.
5. **Strategic layer M3 (queued; M2 SHIPPED 2026-07-17 — see the state
   paragraph)**: the one remaining milestone from
   `docs/strategic-layer-plan.md` — a mid-match Loom Fragment event
   (deterministic sim-clock spawn, fast capture, temporary
   sensor-omniscience "Loom Resonance" buff, bump → 26) + polish (Field
   Manual card for the strategic layer, subsystem damage smoke,
   docs/SUBSYSTEMS.md entries). The M2 plan summary below is now the
   RECORD of what shipped: new
   `shared/src/sim/CaptureStation.ts` + `StrategicSystem.ts` (storms-style
   map opt-in: `GameConfig.stations.placements` `[]` by default so the
   baseline stays untouched; `MapConfig.stations` via `applyMapConfig`);
   DOCKING-style capture (presence = inside radius AND below
   `stations.dockMaxSpeed`, the service-bubble loiter gate — owner
   requirement); new `AIOrder` `"capture"` + `setCaptureTarget` (defend
   anchored on the station, throttled down inside the radius) +
   FleetCommander `captureCount` tasking; effects = respawnDelayScale /
   `SensorSystem.rangeScale` / subsystem repair; `StationSchema` map +
   per-faction energy/tier root fields (bump → 25); `StationView` = GLB
   via AssetLoader w/ procedural ring fallback (owner authors the Blender
   model later). M3 after: one Loom Fragment event (sensor-omniscience
   buff, bump → 26). Both milestones wire BOTH loops (BattleSim + solo
   Game.advanceSim), no Game→BattleSim convergence (decided 2026-07-17:
   new systems are self-contained shared classes; revisit post-playtest).

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
