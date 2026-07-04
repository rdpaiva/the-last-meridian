# Agent kickoff prompt

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

Continue the multiplayer work on branch `feat/phase1-multiplayer`.

**Read `docs/PHASE1_OPEN_ISSUES.md` first and trust it** — current as of
commit `13cee3f` (2026-07-04, jitter fix + entry polish). Do NOT re-survey
the codebase; that doc's Architecture notes + the anchors below are accurate.

**State**: full-thrust judder root-caused and fixed (tick-aligned input
queue + fixed-dt server steps + sim-velocity camera lead); online entry is
buttons now — PLAY SOLO / PLAY ONLINE (quick-play screen + loadout page 2),
`#join=<roomId>` invite links (the address bar IS the link), online
Enter-restart, and AI escorts fly cover on joining humans (faction-leader
retask). PROTOCOL_VERSION 9. Typecheck + 14/14 tests green.
`?online` is GONE — don't reintroduce it.

**My playtest findings**: <fill in after running the checklist>

**Work order**:

1. Fix my playtest findings. Feel knobs: `GameConfig.net` (incl. the new
   `inputBacklogMax`); live debug handle: `window.__netGame`. Known
   non-bugs: no hitstop online (deliberate); remote engine glow rides a
   speed proxy, not thrust input. The input-timing invariant (one acked
   frame == one fixed tick) is documented in PHASE1_OPEN_ISSUES.md →
   Architecture notes — don't regress it. Anchors:
   `shared/src/NetworkController.ts` (queue/ack), `BattleRoom.step`
   (fixed-dt accumulator), `NetworkGame.reconcile`/`updatePrediction`
   (client replay), `NetworkGame` tick step 3 (camera velocity).
2. If the pass is clean: **merge `feat/phase1-multiplayer` → `main`**.
3. Then the Phase 2 tail (pre-deploy): sensor-filtered replication
   (anti-wallhack stealth — seam: `BattleRoom.syncState` currently
   replicates every ship to everyone; the client radar already runs on its
   own SensorSystem so filtering is server-only), clock-sync debug overlay,
   network-condition simulator. Then Phase 3 (room lifecycle, reconnection,
   hosting) per `docs/MULTIPLAYER.md`.

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
