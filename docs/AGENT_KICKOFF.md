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

**State (2026-07-18)**: `feat/strategic-layer` MERGED to `main`
(`2a2a11e`, fast-forward, 14 commits) and the repo branch-cleaned — only
`main` exists locally; `origin/dev` is the off-machine backup. The owner
reviewed everything and **CLEARED THE QUEUE**: all pending owner-check
items are closed as accepted ("happy with the way everything is right
now; if I find something wrong down the road, we'll address it"). Do NOT
resurrect old check items — anything found later gets filed here fresh,
from play.

**What the game is now**: solo + online fleet-vs-fleet with the full
strategic layer — capture stations, per-faction Energy with auto upgrade
tiers (RAPID REDEPLOY / SENSOR UPLINK / TURRET OVERDRIVE),
station-powered carrier shields, destructible per-bay hangars with
graduated respawn penalties, the 20s respawn bench + HUD redeploy ring,
ion storms, the map editor (station brush + sticky brushes), a 6-map
catalog (The Eye is the first editor-authored entry), and a 7-card Field
Manual covering all of it. Feature-by-feature status: `docs/ROADMAP.md`.
At merge: typecheck green across all workspaces, **52/52 tests green**.

**Deploy state**: PROTOCOL_VERSION is **27**; the LIVE droplet still
answers **v17** — the strategic layer has never been deployed. The next
Actions → **"Deploy game"** dispatch (owner clicks; agents' `gh` token
cannot) ships client + server from one checkout, so the both-halves rule
is automatic; old clients get the refresh prompt. Topology + provisioned
state: `docs/DEPLOY.md`. Nothing auto-deploys on push.

**Owner goal (standing, owner-owned)**: deploy, then the friends
playtest at `https://the-last-meridian.com`. Findings come back as new
work items here.

**Parked records** (pointers, not open loops — reopen only if symptoms
recur):

- **Periodic freeze**: multi-second freeze every ~20–30s, last
  owner-reproduced 2026-07-17 locally in SOLO mode (rules out the
  server). Parked 2026-07-18 by the queue-clear. Full record + next
  evidence step at the top of `docs/perf-freeze-investigation.md`;
  hygiene fixes already landed in `56837f2` (droplet heap cap, GlowLayer
  include-list leak, scoreboard cadence + fxQueue drain cap).
- **Netcode feel-tuning knob map**: remote-ship stutter →
  `net.interpDelayMs` (overlay "headroom" ≤0 = buffer starvation);
  own-ship micro-jerks → `correctionRate`/`correctionSnapUnits`; input
  feel under jitter → server `inputBacklogMax` (overlay "ack lag"
  creeping = too high). Anchors: `GameConfig.net`,
  `NetworkGame.recordSnapshot`/`reconcile`/`updatePrediction`,
  `NetDebugOverlay.ts`, `NetClient.send` + `DelayQueue.ts`. The committed
  `net.sim` profile is the owner's 120/20 (dormant, `enabled: false`).
- **Known deliberate seams** (accepted behavior, not bugs): own laser
  bolts visibly overfly a remote target ~12u before the server hit lands
  (fainter cousin of the missile-fuse artifact — fix only on owner
  report); a LIVE hangar circle (r22) shadows bolts crossing it on
  frontal carrier runs (off-axis is clean; dead subsystems stop
  absorbing); subsystems ignore friendly fire by design; dense-station
  maps climb the fixed 100/250/500 Energy ladder faster (balance lever,
  not a bug); station-free maps (The Veil, The Wreck) run with the whole
  strategic system inert by design.
- **Strategic layer M3 (Loom Fragment event)**: moved to the ROADMAP
  backlog by the queue-clear. Design sketch in
  `docs/strategic-layer-plan.md`.
- Detailed per-feature build notes (anchors, protocol history 17→27,
  owner-feedback trail) that used to fill this file: git history of this
  doc (`git log -p --follow docs/AGENT_KICKOFF.md`) and the dated entries
  in `docs/PHASE1_OPEN_ISSUES.md`.

**Work order**:

_Nothing queued (owner cleared the queue 2026-07-18)._ New items come
from the deploy + friends playtest, or whatever the owner asks for next.
File them here with anchors as they surface.

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
