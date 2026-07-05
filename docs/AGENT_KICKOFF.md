# Agent kickoff prompt

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

Continue the multiplayer work. The identity slice (own-ship engine tint +
callsigns/nameplates) is MERGED to `main` and OWNER-VERIFIED (2026-07-05).
Branch off `main`.

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
haloed vs dimmer faction-tinted AI callsigns, dark backing pill so labels
read over exhaust plumes). PROTOCOL_VERSION 15. Typecheck + 18/18 tests
green (join test now also proves the callsign lifecycle over the wire).
The identity slice is OWNER-VERIFIED; the netsim feel pass is STILL
pending — that's the headline task.

**Owner goal (2026-07-05)**: a friends playtest — GitHub Pages client +
Colyseus on the owner's existing DigitalOcean VM. Constraint that shapes
the hosting work: Pages is HTTPS, so the socket must be `wss://` ⇒
subdomain + TLS reverse proxy (Caddy or the VM's existing nginx) in front
of `localhost:2567`; the client bakes the endpoint at build time via
`VITE_SERVER_URL` (`client/src/net/NetClient.ts`). Deploy client + server
from the SAME commit (protocol check refuses mismatches). NOTE —
DELIBERATE, do not suggest pushing: local `main` is ~54 commits ahead of
`origin/main` and stays that way until the MP server is hosted. The
deployed Pages build is the owner's LIVE single-player test channel
(friends are actively playtesting it); pushing main would ship a client
with online entry points and no server behind them. Backup-without-deploy
option if wanted: push to a side branch (e.g. `origin/dev`) — Pages only
tracks main.

**My playtest findings**: <fill in — fly at netsim 40/80/120ms ± jitter
and report what feels wrong, with overlay numbers when something spikes>

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
   (Identity-slice retune anchors, if playtests surface polish:
   `GameConfig.ownShipTint` / `GameConfig.nameplates`; styling in
   `client/src/style.css` (`#nameplates`, `.pilot-name-row`); word lists in
   `shared/src/Callsigns.ts`; wiring in `EngineGlow.ts` (palette param) /
   `Nameplates.ts` / `NetworkGame.ts` (tint in `makeView`; plate loop) /
   `Game.ts` (tinted `engineGlow`; plate loop).)
2. **Reconnection** (Phase 3): `allowReconnection` in
   `BattleRoom.onLeave` — AI takes the seat meanwhile (the seat handback
   already exists there: controller/isAI/owner/callsign), reclaim restores
   occupant + name; `retaskLeader` runs on both edges; note `Room` already
   copies `client.view` across a reconnection (the sensor-filter StateView
   survives). Client side: `NetClient.leave`/error path +
   `NetworkGame.connectionLost` is the resume seam. Integration test like
   the leave-handback one in `tests/server/battleRoom.test.ts`.
3. **Hosting artifacts** (Phase 3, pulled forward by the friends-test
   goal — see docs/MULTIPLAYER.md → Phase 3 "Hosting artifacts" for the
   full list): esbuild server bundle, systemd unit, Caddyfile (or nginx
   block — the owner's VM may already run nginx), deploy notes/workflow,
   `VITE_SERVER_URL` build wiring. Then the `[human]` provisioning
   checklist (DNS, certs, first deploy) is the owner's.
4. Then the rest of Phase 3 (separate sessions): room lifecycle/rematch.

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
