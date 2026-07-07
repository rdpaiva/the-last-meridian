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
linger. Hosting artifacts are in `docs/DEPLOY.md`. PROTOCOL_VERSION **20**
(18 = 2026-07-07 match scoreboard; 19 = 2026-07-07 gunship balance pass;
20 = 2026-07-07 wing-composition GameConfig restructure — config lives in
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
