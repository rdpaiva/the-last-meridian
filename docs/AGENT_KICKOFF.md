# Agent kickoff prompt

Copy/paste the block below to start the next coding-agent session with zero
re-discovery. **Maintenance rule**: whoever ends a session updates this
prompt as part of the handoff commit — refresh the state line, the commit
hash, the work order, and the ANCHORS (exact files/functions the next tasks
touch). The anchors are the whole point: `PHASE1_OPEN_ISSUES.md` records
*what* and *why*; this file records *where*, so the next session starts
editing instead of searching.

---

Continue the multiplayer work. The Phase 2 tail is CODE-COMPLETE on
`feat/phase2-net-tools` (2026-07-05): netcode tooling (network-condition
simulator + debug overlay) AND sensor-filtered replication (the
anti-wallhack gate). If that branch is merged, branch off `main`;
otherwise continue on it.

**Read `docs/PHASE1_OPEN_ISSUES.md` first and trust it** — do NOT re-survey
the codebase; that doc's Architecture notes + the anchors below are accurate.

**State**: online co-op is playable and feels close to single-player on
LOCALHOST. This session added: `GameConfig.net.sim` (dev netsim —
enabled/latencyMs = simulated RTT, half per direction/jitterMs; flip
`enabled` + reload; console banner + pinned amber NETSIM badge while on),
`NetDebugOverlay` (Backquote in an online match: clock offset, snap
buffer depth/headroom, pending inputs + ack lag, correction magnitude, fx
queue), and server-side sensor-filtered replication (hidden enemies are
absent from the wire; presence = fresh faction track; radar ghosts +
view hiding handled client-side). PROTOCOL_VERSION 12. Typecheck + 18/18
tests green. NEITHER the feel under simulated latency NOR the filtering
has been owner-playtested yet.

**Owner playtest 2026-07-05 on this branch**: came back clean after two
MP-parity fixes (dock cue + arrival-side jump ripple, `28dac09` — see
PHASE1_OPEN_ISSUES). Still untested: the netsim feel pass at real
latencies (work-order item 1).

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
2. **Own-ship marker** (owner ask 2026-07-05: in a dogfight it's easy to
   lose track of which ship you're flying). CLIENT-ONLY depiction, works
   offline AND online, no wire change: a persistent, subtle marker on the
   player's own hull — ring/chevron under the ship or a distinct own-ship
   engine-glow tint; readable at a half-second glance, unlike text.
   Anchors: offline `Game` (the player ship root + `EngineGlow`
   construction), online `NetworkGame.makeView` (`key === this.myKey`);
   one new class per the style rules (e.g. `OwnShipMarker.ts`), knobs in a
   new `GameConfig` section (config change ⇒ PROTOCOL_VERSION bump).
   Don't conflate this with callsigns (item 3) — this is the fast fix for
   the control-confusion problem; names are identity, not disambiguation.
3. **Callsigns + nameplates** (Phase 3, sits with lobby polish — owner
   ask, same date): every ship gets a callsign; humans enter/persist a
   pilot name, AI pilots get a naming scheme so bots aren't anonymous.
   NAMING CANON: draw AI callsign schemes from
   `docs/The-Last-Meridian-Story-Bible.md` (squadron-style for humans'
   side, choir/machine-flavored for machines). Honesty rule: style AI
   callsigns visibly differently from human names (isAI already
   replicates; radar already halos humans). Nameplates: plain-DOM labels
   projected per frame, zoom/distance-faded, friendlies-always +
   enemies-only-when-targeted (avoid furball text clutter). Wire/UX:
   `callsign` on `ShipSchema` (set once), pilot name in `JoinOptions`
   (`shared/src/protocol.ts` ⇒ bump), persisted next to the loadout
   (`Loadout.ts` `lastMeridian_*` keys), one name input on the online
   entry flow (`LoadoutMenu.onPlay` page — a field, not a menu; the
   no-complex-menus ceiling stands).
4. Then the rest of Phase 3 (separate sessions): reconnection via
   `allowReconnection` (AI takes the seat meanwhile —
   `BattleRoom.retaskLeader` is the join/leave seam; note `Room` already
   copies `client.view` across a reconnection), room lifecycle/rematch,
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
- Verify with `npm run typecheck` + `npm test` only — I run the dev server
  and playtest myself. Commit each landed change like previous sessions.
