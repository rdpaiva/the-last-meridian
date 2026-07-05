# Agent kickoff prompt

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

Continue the multiplayer work. The identity slice is CODE-COMPLETE on
`feat/own-ship-marker` (2026-07-05): own-ship marker ring AND
callsigns + nameplates. If that branch is merged, branch off `main`;
otherwise continue on it.

**Read `docs/PHASE1_OPEN_ISSUES.md` first and trust it** — do NOT re-survey
the codebase; that doc's Architecture notes + the anchors below are accurate.

**State**: online co-op is playable and feels close to single-player on
LOCALHOST; the Phase 2 tail (netsim + NetDebugOverlay + sensor-filtered
replication) is merged to `main` and owner-verified clean. This session
added, on `feat/own-ship-marker`: the **own-ship engine tint** (YOUR ship
burns teal exhaust vs everyone's orange — owner picked this over a hull
ring; `EngineGlow` palette param + `GameConfig.ownShipTint`) and
**callsigns + nameplates** (`shared/src/Callsigns.ts` schemes from the story
bible — two-word handles, no numbers (owner call): Commonwealth pilot
handles ("Blue Fox") vs Novari choir names ("Silent Psalm");
`ShipSchema.callsign` swaps with `isAI` on join/leave; CALLSIGN field on
loadout page 2 → `lastMeridian_pilotName` → `JoinOptions.pilotName`;
`Nameplates.ts` pooled DOM labels, zoom-faded, friendlies-always +
enemies-only-when-lock-targeted + never your own, launch-gated, human names
haloed vs dimmer faction-tinted AI callsigns). PROTOCOL_VERSION 15.
Typecheck + 18/18 tests green (join test now also proves the callsign
lifecycle over the wire). NONE of this session's work is owner-playtested
yet, and the netsim feel pass is STILL pending.

**My playtest findings**: <fill in — (a) fly at netsim 40/80/120ms ± jitter
and report what feels wrong, with overlay numbers when something spikes;
(b) eyeball the new marker + nameplates offline AND in a two-tab match:
ring readable but subtle? plates clutter-free in a furball? names styled
clearly human-vs-AI?>

**Work order**:

1. **`[human]` feel-tuning loop** (Phase 2 tail, docs/MULTIPLAYER.md): I fly
   with `GameConfig.net.sim` at 40/80/120ms (+ `jitterMs` 10–30) and report;
   you translate reports into `GameConfig.net` changes. Knob → symptom map:
   - remote ships stutter/hitch → `interpDelayMs` (raise toward
     patch-interval × 2 + worst jitter; overlay "headroom" going ≤0 =
     buffer starvation, the smoking gun)
   - own ship micro-jerks after bumps/combat → `correctionRate` (lower =
     softer) or `correctionSnapUnits`
   - own-input feel under jitter → server `inputBacklogMax` (each queued
     frame ≈ 33ms hidden input latency; overlay "ack lag" creeping = too
     high, reconciliation blips = too low)
   Anchors: `shared/src/GameConfig.ts` → `net` (all knobs, commented);
   `client/src/game/NetworkGame.ts` → `recordSnapshot`/`reconcile`/
   `updatePrediction`; `client/src/game/NetDebugOverlay.ts` (readout);
   `client/src/net/NetClient.ts` `send` + `client/src/net/DelayQueue.ts`
   (the netsim halves). Pure retunes of `GameConfig.net` numbers still
   bump PROTOCOL_VERSION (GameConfig is shared).
2. **`[human]` identity-slice acceptance** (this session's work): own-ship
   tint + nameplates offline and two-tab; retune from my report. Anchors:
   `GameConfig.ownShipTint` (idle/hot exhaust colors) +
   `GameConfig.nameplates` (offset/zoom fade); styling in
   `client/src/style.css` (`#nameplates`, `.pilot-name-row`); scheme
   wording in `shared/src/Callsigns.ts`; depiction wiring in
   `client/src/game/EngineGlow.ts` (palette param) / `Nameplates.ts` /
   `NetworkGame.ts` (tint in `makeView`; plate loop before the netdebug
   block; stub fields fed in `recordSnapshot`) / `Game.ts` (tinted
   `engineGlow` construction; plate loop before `setLaunchOverlay`).
3. **Reconnection** (Phase 3): `allowReconnection` in
   `BattleRoom.onLeave` — AI takes the seat meanwhile (the seat handback
   already exists there: controller/isAI/owner/callsign), reclaim restores
   occupant + name; `retaskLeader` runs on both edges; note `Room` already
   copies `client.view` across a reconnection (the sensor-filter StateView
   survives). Client side: `NetClient.leave`/error path +
   `NetworkGame.connectionLost` is the resume seam. Integration test like
   the leave-handback one in `tests/server/battleRoom.test.ts`.
4. Then the rest of Phase 3 (separate sessions): room lifecycle/rematch,
   hosting + `VITE_SERVER_URL`.

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
- Verify with `npm run typecheck` + `npm test` only — I run the dev server
  and playtest myself. Commit each landed change like previous sessions.
