# Agent kickoff prompt

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

Continue the multiplayer work. The Phase 3 slice (reconnection + hosting
artifacts) is BUILT on `feat/reconnect-hosting` (2026-07-05, commits
`a0caf6d` + `2200f5e`, 19/19 tests green) and awaits my in-browser check —
if I've merged it by the time you read this, branch off `main`; otherwise
continue on that branch.

**Read `docs/PHASE1_OPEN_ISSUES.md` first and trust it** — do NOT re-survey
the codebase; that doc's Architecture notes + the anchors below are accurate.

**State**: online co-op is playable and feels close to single-player on
LOCALHOST. Merged + owner-verified: Phases 1–2 core, the Phase 2 tail
(netsim + NetDebugOverlay + sensor-filtered replication), and the identity
slice (own-ship teal engine tint + callsigns/nameplates). Built this
session on `feat/reconnect-hosting`: **reconnection** (server holds a
dropped seat 60s — `GameConfig.net.reconnectGraceSec` — AI flies it
meanwhile, reclaim restores occupant/callsign/leadership; client rides the
0.17 SDK's built-in auto-reconnect on the SAME Room object — do NOT
hand-roll a token loop; page unloads leave consented via `pagehide`) and
**hosting artifacts** (esbuild ESM server bundle, systemd unit, Caddy +
nginx configs, manual-only server-deploy workflow, `VITE_SERVER_URL` wired
into the Pages build from a repo variable — full map in `docs/DEPLOY.md`).
PROTOCOL_VERSION **16**.

**Owner goal**: a friends playtest — GitHub Pages client + Colyseus on the
owner's DigitalOcean VM behind `wss://play.<domain>` (Caddy or the VM's
existing nginx). Everything agent-preparable is DONE; what remains is the
`[human]` provisioning checklist in `docs/DEPLOY.md` (DNS, proxy, unit, CI
secrets, first deploy) and deploys always ship client + server from the
SAME commit. NOTE — DELIBERATE, do not suggest pushing: local `main` stays
ahead of `origin/main` until the MP server is hosted. The deployed Pages
build is the owner's LIVE single-player test channel; pushing main would
ship a client with online entry points and no server behind them.
Backup-without-deploy option: push a side branch (e.g. `origin/dev`) —
Pages only tracks main.

**My playtest findings**: <fill in — (a) reconnection check: kill the
server / drop a tab mid-match → RECONNECTING overlay → seat back with my
callsign; (b) netsim feel at 40/80/120ms ± jitter, with overlay numbers
when something spikes>

**Work order**:

1. **`[human]` feel-tuning loop** (Phase 2 tail, docs/MULTIPLAYER.md — STILL
   the headline): I fly with `GameConfig.net.sim` at 40/80/120ms
   (+ `jitterMs` 10–30) and report; you translate reports into
   `GameConfig.net` changes. Knob → symptom map:
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
2. **Reconnection polish, if my check surfaces it**: server seam is
   `BattleRoom.onLeave` (branch on `CloseCode.CONSENTED`; reserve/reclaim
   around `allowReconnection`; `seat.pilotCallsign`/`seat.reserved`);
   client seam is the `onDrop`/`onReconnect`/`onLeave` handlers in the
   `NetworkGame` constructor + `NetworkGame.onReconnected()` (the buffer
   wipe) + the `reconnecting` gates (input send, `updatePrediction`,
   `updatePhase` overlay). Test: "holds a dropped seat…" in
   `tests/server/battleRoom.test.ts` (gotcha: disable the test client's
   `reconnection.enabled` before `leave(false)` or the SDK auto-reconnects
   under your assertions).
3. **Room lifecycle / rematch** (Phase 3 remainder): victory → room
   disposal + Enter-rematch flow (today Enter reloads into a NEW quick
   match — `NetworkGame.onKeyDown` `RESTART_FLAG`; `main.ts` `startOnline`
   reads the `#join=` hash, so a disposed room falls back to quick match
   already). Mid-match join already works (AI backfill); decide staleness
   rules (join a nearly-decided match?), maybe `BattleRoom.onBeforeShutdown`.
   Server room-side anchors: `BattleRoom.onCreate` (autoDispose default),
   `step()` → `this.sim.state`/`winner`.
4. **Lobby polish** (Phase 3 remainder, small): connecting/error states on
   the PLAY ONLINE buttons (`LoadoutMenu.onPlay`, `main.ts startOnline`),
   copy-invite-link button, rejoin-last-match prompt.

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
  options) — work WITH it, never around it.
- Verify with `npm run typecheck` + `npm test` only — I run the dev server
  and playtest myself. Commit each landed change like previous sessions.
