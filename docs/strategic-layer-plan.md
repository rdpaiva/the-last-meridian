# Strategic Layer — Trimmed Core (subsystems, capture stations, Energy, Loom event)

> **STATUS (2026-07-17): M1 + M2 SHIPPED** (same session, protocol 24 →
> 25; smoke baseline recaptured once for M1, untouched by M2 — the
> acceptance gate held). Post-M2 refinements landed from owner feedback:
> docked capture-status HUD line (`captureStatusFor` in
> `client/src/game/Hud.ts`) and ownership tint switched to the faction
> identity palette (`FACTION_THEME.engineHot`, not laserEmissive).
> **M3 (below) is the remaining milestone** — see `docs/AGENT_KICKOFF.md`
> item 5 for the live queue entry and its "Built 2026-07-17" state
> paragraphs for what-shipped-where anchors. The M1/M2 sections below are
> now the RECORD of what was built (implementation matched the plan;
> deviations: subsystem death latches use `explosionFired` so the tier-3
> repair can re-arm them, and respawn scale is recomputed declaratively
> each tick in StrategicSystem rather than latch-written).

## Context

The design doc `docs/the-last-meridian-strategic-persistence-design.md` proposes evolving the game from "grind one carrier HP bar" into a strategic arcade battle. After review, the agreed scope is the **trimmed core** — the parts that fit a 1–4-player-plus-bots game and the existing architecture:

- Mothership destructible subsystems (2 shield generators gating the core + 1 hangar), reusing the proven Turret sub-DamageTarget pattern
- 3 neutral capture stations feeding a shared per-faction **Energy** resource with 3 automatic upgrade thresholds
- One optional mid-match **Loom Fragment** event (canon per the story bible)
- AI participation on both sides (FleetCommander tasks capturers; new `capture` order), so solo and mostly-bot lobbies play the full loop
- Applies to **both solo and multiplayer**

**Explicitly out of scope** (deferred to ROADMAP backlog): campaign/sector persistence, player progression/unlocks, squadrons, scripted match phases (phases emerge from thresholds), team voting, new role systems, reinforcement-wing upgrade (MP seat churn).

**Architectural decision — no Game→BattleSim convergence refactor.** Solo `Game.advanceSim` and `BattleSim.advance` stay duplicated; all new *rules* live in self-contained shared classes (SensorSystem/StormSystem/Turret precedents), so per-loop wiring is ~30–50 lines each. Revisit convergence after the playtest.

**Cross-cutting conventions**
- Faction keys are the existing `Faction = "humans" | "machines"` (`shared/src/Faction.ts`) — never the doc's `"human"/"novari"`.
- Stations/loom follow the **storms map contract**: `GameConfig` placements default `[]` → system fully inert → headless smoke baseline untouched. Maps opt in via `MapConfig` + `applyMapConfig` (`shared/src/Maps.ts:262`).
- Determinism: no new RNG draws; SimEvents carry no RNG; new tick calls at fixed documented points in both loops.
- One `PROTOCOL_VERSION` bump per milestone (`shared/src/protocol.ts:12`): 23→24→25→26.
- No new art assets: subsystem/station/loom visuals are procedural (TurretView / JumpFlash recipes), mounts placed via GameConfig like `turrets.mounts`.
- `npm run typecheck` after every edit.

---

## M1 — Mothership subsystems (shields + hangar)

**New:** `shared/src/sim/MothershipSubsystem.ts` — Turret-minus-gun: `implements DamageTarget`, `kind: "shield" | "hangar"`, own hp/maxHp, `explosionFired` death latch, `setMountPosition()` seam for future GLB empties.

**Modified:**
- `shared/src/GameConfig.ts` — new `mothership.subsystems` section:
  - `shield: { hp, hitRadius, shieldedHullDamageFactor: 0.2, mounts: { humans: [×2], machines: [×2] } }` — factor is **nonzero** so a stalled AI battle still ends (anti-stall guarantee for the smoke test)
  - `hangar: { hp, hitRadius, destroyedRespawnDelayScale: 2.5, mounts: {…×1 each} }`
- `shared/src/sim/Mothership.ts` — build/own `subsystems` (like `buildTurrets`); `shieldsUp` / `hangarAlive` getters; **hull gate lives in `takeDamage` (:232)** — while `shieldsUp`, incoming hull damage × `shieldedHullDamageFactor` (sections already forward here). Shields protect the hull pool only, not turrets/subsystems.
- `shared/src/sim/Ship.ts` — mutable `respawnDelayScale = 1` consumed in `shouldRespawn` (:281). Hangar death sets it faction-wide; recompute as `hangarScale × upgradeScale` (M2 reuses this hook — multiply, don't overwrite).
- `shared/src/sim/BattleSim.ts` — register subsystems as opposing-weapon targets in `start()` (:307–326); canonical order: combatants → turrets → **subsystems** → hull sections. Death-latch scan next to the turret scan (:499–505) → emit events + apply hangar respawn scale.
- `shared/src/AIController.ts` — strike case (:271–311): while `opponentMothership.shieldsUp`, steer/aim at nearest **live shield generator** (same standoff/fire gates); after shields drop, existing hull behavior. Same preference for `carrierMissileShot`.
- `shared/src/FleetCommander.ts` — include subsystem HP sum in the carrier-alert delta (:75) so shield strikes scramble defenders.
- `shared/src/sim/SimEvents.ts` — `subsystemDestroyed { mothership, subsystem }`, `shieldsDown { mothership }` (once, when last generator dies).
- `shared/src/protocol.ts` — NetEvent arms `subsystemDestroyed`/`shieldsDown`; bump → 24.
- `server/src/schema/BattleState.ts` — `MothershipSchema` (:125) + `shield0Hp/shield1Hp/hangarHp` float32 (schema, not events → mid-match joiners correct).
- `server/src/rooms/BattleRoom.ts` — sync fields; relay cases in `wireEventRelay` (:384).
- `client/src/game/Game.ts` — mirror target registration (~:900) + death-latch (~:1864); subscribe events → explosion/trauma/SFX/toast.
- `client/src/game/NetworkGame.ts` — write schema HP into client-side `carrierSims` subsystem objects (pattern at :1282) so views/HUD read local sim identically in both modes; playback cases.
- **New** `client/src/game/view/SubsystemView.ts` (TurretView-style procedural pod) + hook into `MothershipView`; `client/src/game/Hud.ts` — subsystem pips on carrier bars + "SHIELDS DOWN" cue.

**Verify:** baseline WILL change (intended) → recapture via `npm run baseline`; confirm the smoke test still ends with a carrier falling (raise factor / lower shield HP if it stalls). New `tests/sim/subsystems.test.ts`: damage gating on/off, hangar respawn scaling, same-seed determinism. `npm run test`, typecheck.

---

## M2 — Capture stations + Energy + thresholds

**New:**
- `shared/src/sim/CaptureStation.ts` — id, position, radius, `owner: Faction | null`, `capturingFaction`, `progress 0..1`, `contested`; `update(dt, presence)` rules: both factions present → contested/paused; one present → drain enemy progress to neutral, then climb (so flipping an enemy station ≈ 2× a neutral grab; allies speed up to `maxAssistFactor`); absent → hold; full → flip. Indestructible in v1 (no DamageTarget).
  - **Docking-style presence (user requirement):** a ship only counts as capturing if it is inside the radius, alive, fully launched, AND flying below `stations.dockMaxSpeed` — the same loiter gate as the carrier service bubble (`Mothership.serviceZoneContains` + the `loiterMaxSpeed` check in `ship.serviceTick` wiring, `BattleSim.ts:472-481`). Fly-throughs don't capture; you must slow down and loiter, which is the vulnerability window.
- `shared/src/sim/StrategicSystem.ts` — owns stations (from `GameConfig.stations.placements` × arena), `energy` + `tier` per faction, threshold firing, effect application. `active` getter false when no placements → whole system no-op.

**Modified:**
- `shared/src/GameConfig.ts` — `stations { placements: [], captureRadius, captureTimeSec: 12, dockMaxSpeed (≈ service.loiterMaxSpeed), maxAssistFactor, energyPerSec, model: "station.glb" (GLB path + scale/correction, user-authored art) }`; `energy { thresholds: [100 fasterRespawn, 250 sensorBoost, 500 subsystemRepair], fasterRespawnScale, sensorRangeScale, repairHpFrac }`; `commander.captureCount: 2`.
  - Effects deliberately cheap: T1 → `Ship.respawnDelayScale` (M1 hook); T2 → new `SensorSystem.rangeScale` per-faction multiplier; T3 → restore that faction's shields + hangar to full. (Reinforcement wing deferred — MP seat/schema churn.)
- `shared/src/Maps.ts` — `MapConfig.stations?: {xFrac,zFrac}[]`; write in `applyMapConfig`; add 3-station layouts to 2–3 catalog maps. Maps without the field play exactly as today.
- `shared/src/ShipController.ts` — `ControllerWorld.stations` (ownership is global knowledge by design, no sensor filtering).
- `shared/src/AIController.ts` — `AIOrder` += `"capture"` + `setCaptureTarget(station)`: `defend` behavior anchored at the station — fly to it, then **throttle down below `dockMaxSpeed` inside the radius** (loiter like the retreat-dock behavior) so the AI actually accrues capture progress; break loiter to intercept nearby contacts, resume after.
- `shared/src/FleetCommander.ts` — between defend-scramble and hunt: assign up to `captureCount` pool ships to nearest not-owned stations.
- `shared/src/SensorSystem.ts` — per-faction `rangeScale` (also feeds MP anti-wallhack replication for free).
- Events/wire: SimEvents `stationCaptured` / `stationNeutralized` / `upgradeUnlocked`; NetEvent mirrors + relay + playback; `StationSchema { id, x, z, owner, capturing, progress, contested }` map on `BattleState` (unfiltered) + root `humansEnergy/machinesEnergy` f32, `humansTier/machinesTier` uint8; bump → 25.
- Wiring both loops: instantiate `StrategicSystem`; tick after `resolveStormZaps`, before death/respawn (documented). Server applies effects authoritatively; NetworkGame renders replicated results only (prediction untouched).
- Client: **new** `client/src/game/view/StationView.ts` — loads `GameConfig.stations.model` GLB via `AssetLoader` with a **procedural ring/pylon fallback** (same pattern as ships/carriers: user authors the Blender GLB later, drops in with zero code change); owner-tinted emissive accents + procedural capture-progress ring around the mesh; `Hud.ts` energy readout + tier markers + toasts (throttled — capture/loss only, not contested flicker); `Radar.ts` station icons (owner color, contested blink); optional `TuningSchema.ts` knobs.

**Verify:** smoke baseline **must NOT change** (stock placements empty — this is the acceptance gate). New `tests/sim/stations.test.ts` (set placements, restore in `afterEach` — GameConfig is a mutable singleton): capture/contest/recapture, energy accrual, threshold order, effects observable, same-seed determinism. Manual: solo on a station map; two-tab MP per `docs/PHASE1_TWOTAB_CHECKLIST.md`.

---

## M3 (optional) — Loom Fragment event + polish

- `GameConfig.loom { spawnAtSec: ~240, captureRadius, captureTimeSec: ~6, buffDurationSec: ~45 }`; map-enabled (`MapConfig.loomEvent?: {xFrac,zFrac}`); deterministic sim-clock timer inside `StrategicSystem`, gated on `state === "playing"`.
- Claim buff: **Loom Resonance** — `SensorSystem.omniscient[faction]` (force-detect all enemies) for the duration, then expires. One boolean, reversible, no damage-math risk.
- Events `loomFragmentSpawned/Claimed/BuffExpired` + NetEvent mirrors + `BattleState` root loom fields; bump → 26. Commander diverts capture-tasked ships to the fragment while active.
- Client: **new** `LoomFragmentView` (pulsing emissive shard, JumpFlash recipe), radar pulse, toasts/SFX.
- Polish: Field Manual card (`FieldManual.buildCards()`), subsystem damage smoke on MothershipView, `docs/SUBSYSTEMS.md` entries, ROADMAP/AGENT_KICKOFF updates (log the deferred items in the backlog).

**Verify:** timer fires at exact tick under fixed dt; buff expiry restores sensors; baseline untouched (loom only arms when map-enabled).

---

## Verification (end-to-end, per milestone)

1. `npm run typecheck` (all workspaces) — after every edit.
2. `npm run test` — headless vitest; M1 recaptures the baseline intentionally, M2/M3 must leave it untouched.
3. Solo test flight on a station-enabled map: AI contests stations, HUD/radar/toasts, shields gate the carrier kill.
4. Two-tab multiplayer per `docs/PHASE1_TWOTAB_CHECKLIST.md`: mid-match joiner sees correct subsystem/station state; PROTOCOL_VERSION mismatch rejects old clients.
5. Per user preference: no dev-server launches by default — typecheck + tests; the user flies it himself.

## Risks / open items

- Subsystem mount positions need eyeballing against the carrier GLBs (config-placed like turret mounts; GLB-empty seam later).
- Strike AI may pile onto one shield generator — acceptable v1, knob later.
- Commander over-committing to stations — `captureCount` is the valve; start at 2.
- Capture presence counts only launched, alive, slow-flying ("docked") ships — reuses the service-bubble loiter gate; storm-zap exemption pattern for mid-catapult ships.
- Station GLB doesn't exist yet — procedural fallback ships first; when the user's Blender model lands, only `stations.model` + scale/correction config changes.
