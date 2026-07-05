# Agent kickoff prompt

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

Continue the multiplayer work. Phases 1–2 core are MERGED to `main`
(`6c119ec`, 2026-07-05, owner-accepted via the two-tab checklist) — create a
new branch off `main` for this session: `feat/phase2-net-tools`.

**Read `docs/PHASE1_OPEN_ISSUES.md` first and trust it** — do NOT re-survey
the codebase; that doc's Architecture notes + the anchors below are accurate.

**State**: online co-op is playable and feels close to single-player on
LOCALHOST — predicted own ship (tick-aligned input queue; the judder fix
invariant is documented in PHASE1_OPEN_ISSUES → Architecture notes), full
HUD parity, FX/sound replication, PLAY ONLINE / invite-link entry, escorts
on humans, replicated RCS plumes. PROTOCOL_VERSION 10. Typecheck + 14/14
tests green. Nothing has been tuned under real network conditions yet.

**My playtest findings**: <fill in if anything came up since>

**Work order** (Phase 2 tail, docs/MULTIPLAYER.md — tooling first, it
de-risks everything after):

1. **Network-condition simulator** (dev-only): client-side artificial
   latency / jitter / packet-ish delay so netcode feel is testable at
   40–100ms on localhost. Knobs in `GameConfig.net` (dev section, like
   `debug`); seams: `client/src/net/NetClient.send` (delay outgoing
   input/ready messages) and `NetworkGame` ingest — hold arriving state
   snapshots + `MSG.events` batches in a delay queue before
   `recordSnapshot` / the fxQueue consume them (everything already rides
   `state.timeMs`, so delayed ingest is just later samples). Keep it OFF
   by default and impossible to leave on silently (console banner).
2. **Clock-sync / netcode debug overlay**: a toggleable HUD readout (e.g.
   Backquote-style dev toggle) of `clockOffsetMs`, snapshot buffer depth,
   `pendingInputs.length`, correction offset magnitude, fxQueue depth,
   input-queue ack lag (`inputSeq - myServer.seq`). All fields already live
   on `NetworkGame` (`window.__netGame`); this makes them visible while
   flying. Plain DOM like the HUD.
3. **Feel-tuning pass with both**: fly at simulated 40/80/120ms + jitter,
   tune `GameConfig.net` (interpDelayMs, correctionRate, inputBacklogMax)
   — Phase 2's `[human]` loop; I'll do the flying, you wire what I report.
4. Then next in line (separate sessions): **sensor-filtered replication**
   (pre-deploy anti-wallhack gate — seam: `BattleRoom.syncState` replicates
   every ship to everyone today; the client radar already runs on its own
   SensorSystem, so it degrades gracefully), then Phase 3 (reconnection via
   `allowReconnection`, room lifecycle/rematch, hosting + `VITE_SERVER_URL`).

**Rules of the road** (already true in code — don't relearn them):

- Any change to `NetEvent` shapes, MSG payloads, or GameConfig → bump
  `PROTOCOL_VERSION` (`shared/src/protocol.ts`).
- New online HUD/depiction feature? Extend the `ShadowShip` stub pattern in
  `NetworkGame.ts`; don't fork the offline system.
- Never timestamp anything by arrival — everything rides `state.timeMs`.
- Weapon cooldowns are exempt from prediction rewind/replay; keep it that
  way.
- One acked input == one fixed 1/SIM_HZ tick (the judder fix invariant).
- Verify with `npm run typecheck` + `npm test` only — I run the dev server
  and playtest myself. Commit each landed change like previous sessions.
