# Agent kickoff prompt

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

Continue the multiplayer work. **Phase 3 is feature-complete** on
`feat/reconnect-hosting` (2026-07-06, latest commits `cf0a2a7` room
lifecycle + `fc3fcb8` invite key, on top of `a0caf6d` reconnection +
`2200f5e` hosting artifacts; 20/20 tests green). The lifecycle + invite
slices await my in-browser check — if I've merged the branch by the time
you read this, branch off `main`; otherwise continue on that branch.

**Read `docs/PHASE1_OPEN_ISSUES.md` first and trust it** — do NOT re-survey
the codebase; that doc's Architecture notes + the anchors below are accurate.

**State**: online co-op is playable and feels close to single-player on
LOCALHOST. Merged + owner-verified: Phases 1–2 core, the Phase 2 tail
(netsim + NetDebugOverlay + sensor-filtered replication), the identity
slice (own-ship teal engine tint + callsigns/nameplates). Owner-verified on
`feat/reconnect-hosting`: **reconnection** (tab close → RECONNECTING → seat
back with callsign) and the **latency/jitter feel** at up to 120ms + 20ms
jitter (expected cross-tab delay only — feel-tuning loop PARKED, no knob
changes requested). Built 2026-07-06, awaiting my check: **room
lifecycle** (victory → room locks instantly + disposes after
`GameConfig.net.endedRoomLingerSec` 60s; Enter on the banner clears the
`#join=` hash and quick-matches into a FRESH room — this fixes my "Enter
doesn't restart after Victory" finding, whose root cause was the reload's
hash rejoining the still-alive ended room; post-end leaves skip the
reconnection seat-hold; the end banner survives the room's disposal) and
**copy-invite-link** (the **I** key in an online match copies the address
bar; MP-only HUD row flashes LINK COPIED; rejoin-last-match prompt
deliberately skipped — see PHASE1_OPEN_ISSUES). Hosting artifacts are in
`docs/DEPLOY.md`. PROTOCOL_VERSION **17**.

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

**My playtest findings**: <fill in — the rematch flow: win a match, hit
Enter → lands in a NEW match (not the old banner); two tabs: both hit
Enter after the end → both land in the SAME fresh room; press I mid-match
→ invite link on the clipboard, LINK COPIED flashes; idle on the end
banner ~60s → banner stays up (no CONNECTION LOST repaint), Enter still
rematches>

**Work order**:

1. **Fixes from my rematch-flow check, if any**: server seam is
   `BattleRoom.onMatchEnded` (lock + delayed `disconnect()`), the
   `matchEnded` branch in `onLeave`, and the `this.sim.ended` check in
   `step()`; client seam is `NetworkGame.onKeyDown` (Enter/Esc +
   `clearInviteHash`) and the `this.ended` early-return atop
   `NetworkGame.updatePhase`. Test: "locks + disposes an ended match…" in
   `tests/server/battleRoom.test.ts` (it shrinks
   `GameConfig.net.endedRoomLingerSec` and restores it in `finally`).
2. **`[human]` provisioning checklist** (docs/DEPLOY.md) — now the
   headline: DNS for `play.<domain>`, proxy (Caddy or existing nginx),
   systemd unit, CI secrets/vars, first same-commit deploy. Agent support
   as asked (debugging a failed unit, tweaking configs), then merge
   `feat/reconnect-hosting` → `main` and ship.
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
