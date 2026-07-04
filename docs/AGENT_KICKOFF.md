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
commit `75544be` (2026-07-04, MP HUD slice). Do NOT re-survey the codebase;
that doc's Architecture notes + the anchors below are accurate.

**State**: solo-online has full HUD parity (radar on a client-side sensor
picture, RWR, kills/score, lock/sig cues, pilot counts, homing missile
depiction). PROTOCOL_VERSION 8. Typecheck + 10/10 tests green.

**My playtest of the HUD slice**: [PASTE FINDINGS HERE — or "not done yet,
start on item 2"]

**Work order**:

1. Fix my playtest findings. Feel knobs: `GameConfig.net`; live debug
   handle: `window.__netGame`. Known non-bugs: no hitstop online
   (deliberate); remote engine glow rides a speed proxy, not thrust input.
2. Online entry polish:
   - **PLAY SOLO / PLAY ONLINE splash buttons** replacing the `?online`
     flag. Entry seam: `client/src/main.ts` — the `ONLINE` const (~line
     143), `startGame()` → `startOnline(loadout)`, splash state machine +
     `primaryBtn` all in that file; the menu UI itself is `LoadoutMenu.ts`
     (owns Enter/arrows during factionSelect).
   - **WITH FRIENDS invite link** (`#join=<roomId>`):
     `client/src/net/NetClient.quickMatch` currently does `joinOrCreate` —
     needs a create/joinById split and the roomId surfaced for the link.
   - **Friendly-side FleetCommander escorts**: both factions ALREADY get a
     commander (`BattleRoom.buildFleet`) — the remaining work is assigning
     AI escorts to human players: `cover` orders with the human's ship as
     leader via `AIController.setOrder()`, re-tasked on join/leave
     (`BattleRoom.onJoin/onLeave` already swap the seat's controller).
3. Two-tab acceptance pass (`docs/PHASE1_TWOTAB_CHECKLIST.md`), then merge
   to `main`.

**Rules of the road** (already true in code — don't relearn them):

- Any change to `NetEvent` shapes, MSG payloads, or GameConfig → bump
  `PROTOCOL_VERSION` (`shared/src/protocol.ts`).
- New online HUD/depiction feature? Extend the `ShadowShip` stub pattern in
  `NetworkGame.ts`; don't fork the offline system.
- Never timestamp anything by arrival — everything rides `state.timeMs`.
- Weapon cooldowns are exempt from prediction rewind/replay; keep it that
  way.
- Verify with `npm run typecheck` + `npm test` only — I run the dev server
  and playtest myself. Commit each landed change like previous sessions.
