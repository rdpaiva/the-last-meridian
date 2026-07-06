# Agent kickoff prompt

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
linger. Hosting artifacts are in `docs/DEPLOY.md`. PROTOCOL_VERSION **17**.

**Owner goal**: a friends playtest — HOSTING IS LIVE (provisioned
2026-07-06). Topology as designed in `docs/DEPLOY.md`: client =
`https://rdpaiva.github.io/the-last-meridian/` (Pages off `main`, deployed
bundle verified to carry `wss://play.the-last-meridian.com` — the
`VITE_SERVER_URL` repo variable took); server = DigitalOcean droplet
(1GB, Ubuntu 24.04, hostname `Meridian-Multiplayer-Server`) running Caddy
(auto-TLS) → systemd unit `space-duel` on :2567, protocol v17 answering
"Colyseus 0.17.44" at `https://play.the-last-meridian.com`. CI deploy =
Actions → "Deploy game server" (manual dispatch; secrets `DEPLOY_SSH_KEY` +
`DEPLOY_HOST` = `spaceduel-deploy@play.the-last-meridian.com`; the deploy
user's write access + passwordless `systemctl restart space-duel` are
sanity-verified). The old "don't push main" constraint is **RETIRED** —
`main` was pushed 2026-07-06 (`93a5241`) and client + hand-deployed server
are from that SAME commit. Standing rule going forward: every push to
`main` auto-deploys the Pages client, so run the server deploy workflow on
that same commit right after (the same-commit PROTOCOL_VERSION rule in
`docs/DEPLOY.md` → "Every deploy after that").

**My playtest findings**: <fill in — deployment progress / friends
playtest results: what broke, what felt off, overlay numbers if netcode>

**Work order**:

1. **Prove the CI deploy path + friends smoke test** — the last two
   checkboxes: dispatch Actions → "Deploy game server" once (owner click;
   the token agents get locally can't dispatch workflows) and confirm it
   ships + restarts cleanly (`journalctl -u space-duel` → "protocol v17
   listening"), then two-browser end-to-end match on the Pages URL and
   invite friends. Provisioning itself is DONE — droplet, DNS, Caddy,
   unit, deploy user, secrets all verified live 2026-07-06.
2. **Fixes from the friends playtest, if any** — rematch/lifecycle seams
   if something surfaces there: server `BattleRoom.onMatchEnded` (lock +
   delayed `disconnect()`), the `matchEnded` branch in `onLeave`, the
   `this.sim.ended` check in `step()`; client `NetworkGame.onKeyDown`
   (Enter/Esc + `clearInviteHash`) and the `this.ended` early-return atop
   `NetworkGame.updatePhase`. Test: "locks + disposes an ended match…" in
   `tests/server/battleRoom.test.ts` (it shrinks
   `GameConfig.net.endedRoomLingerSec` and restores it in `finally`).
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
