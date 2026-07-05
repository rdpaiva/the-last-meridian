# Multiplayer plan

Task list and decisions for taking space-duel from single-player to
online multiplayer. Update checkboxes as work lands; record new
decisions in the Decisions section so future sessions don't re-litigate
them. Status summary belongs in `docs/ROADMAP.md` as phases complete.

---

## Decisions (made 2026-06-12)

- **Framework: Colyseus.** Rooms + schema-based state sync over
  WebSockets; pairs cleanly with Babylon (Babylon stays render-only).
- **Server-authoritative.** The server runs the real sim at a fixed
  tick; clients send `InputState` and render what the server says.
  No lockstep, no client authority.
- **First mode: co-op fleet battle.** 1–4 humans + AI wingmen vs. the
  machine fleet — reuses `AIController`/`FleetCommander` server-side and
  avoids the empty-server problem (playable solo from day one). PvP
  duels come after, nearly for free.
- **Babylon math is allowed in shared/server code.** `Vector3` etc. are
  pure math modules and run fine in Node (see
  `scripts/measure-carrier-footprint.mjs` for the NullEngine precedent).
  Scene/mesh/engine imports are NOT allowed in sim code.
- **Monorepo: npm workspaces, three packages.** `shared/` (the sim:
  Ship, math, GameConfig, types, Faction, AIController, SensorSystem,
  FleetCommander, weapon-sim halves), `client/` (the current Vite app,
  moved wholesale: index.html, vite.config, public/, all View/HUD/menu
  code), `server/` (Colyseus). `docs/`, `art/`, `scripts/` stay at repo
  root. No Turborepo/Nx/pnpm — three packages don't need them. Root
  scripts preserve muscle memory (`npm run dev` / `typecheck` keep
  working from the root).
- **`shared/` ships TypeScript source — no build step.** Its
  `"exports"` points at `./src/index.ts`; Vite bundles it directly
  through the workspace symlink, the server runs `tsx` in dev and
  esbuild-bundles for prod. Never compile shared to a dist/ that
  consumers import — that watch/rebuild step poisons the dev loop.
  `@babylonjs/core` (math only — NO scene/mesh/engine imports) is a
  `shared` dependency; the server bundle and the Phase 0 headless smoke
  test are what make violations loud.
- **Restructure timing: first Phase 1 task, not before.** Phase 0's
  sim/view split happens in place in the flat app so each refactor PR
  is reviewable without a 60-file move polluting diffs. As files split,
  sim halves land in `src/game/sim/`, views in `src/game/view/` — the
  Phase 1 restructure is then a history-preserving `git mv` in a
  commit with zero content changes.
- **Hosting/deploy: single small VPS, kept boring.** Server = ONE
  esbuild bundle (`--platform=node --bundle` over server+shared) run
  under a systemd unit (`Restart=always`, logs in journald — no pm2,
  no Docker at this scale). Caddy in front for auto-TLS:
  `play.<domain> → reverse_proxy localhost:2567` gives `wss://`; the
  Node app never touches certificates. Deploy = GitHub Action on main:
  typecheck + build all packages, scp the bundle, restart the unit,
  publish the client static build. Client stays a static site
  (GitHub/Cloudflare Pages); `VITE_SERVER_URL` baked at build time.
  **Hard requirement: PLAY SOLO works with the server down.** Colyseus
  Cloud is the fallback if ops becomes a drag.
- **Protocol version guards client/server skew.** `GameConfig` + the
  message protocol live in `shared`, so client and server must deploy
  together — but a cached old client WILL meet a new server. Join
  options carry a manually-bumped `protocolVersion`; the server rejects
  mismatches and the client renders "new version — refresh". Turns
  undebuggable desyncs into a clean refresh prompt. Corollary: a
  balance tweak (GameConfig) is a both-sides deploy. Rooms live
  in-memory, so deploy when traffic is quiet; draining rooms before
  restart is a later nicety.
- **AI wingmen stay in multiplayer** (decided 2026-06-12). Quick-match
  rooms backfill every empty seat with `AIController` ships: solo join =
  today's single-player on the server, humans silently replace AI as
  they join, and an AI takes over a disconnected player's ship so the
  match stays balanced. Two constraints: (1) backfill is a per-room-type
  flag, not a global — a later pure-PvP/duel room type sets
  `aiBackfill: false` (no bots in competitive, industry-standard);
  (2) the UI is always honest about it — HUD shows human vs. AI counts
  and bots are tagged on radar/HUD. Trust can't be patched in later.
- **No server browser — quick match + friend invite.** Session-based
  arcade game, not community servers; an empty room list is the loudest
  "nobody plays this" signal. Quick match = Colyseus
  `joinOrCreate("battle", { faction, shipType })` (the existing loadout
  menu's choice becomes the join options payload). Friend play = create
  a room, share the room ID as a URL (`#join=<roomId>`). PLAY SOLO stays
  a genuinely offline path (today's game, no server required).
- **Room ceiling: 8–16 humans** (e.g. up to 8v8), AI backfill keeping
  total ship count at the current tuned fleet scale regardless of human
  count. 100-player rooms are explicitly out: the N²-shaped
  serialization/bandwidth costs land outside Colyseus's sweet spot, and
  the game's legibility (radar, commander doctrine, sensor play) is
  tuned for fleet scale, not battle-royale scale. 100 concurrent
  players = many parallel rooms, not one big one.
- **Team fleets, not personal wings — and sizing is a formula knob.**
  Players do NOT bring their own wingmen (fleet size scaling with human
  count breaks balance and amplifies uneven teams). Each side has ONE
  fleet sized by room config:
  `teamFleetSize = baseFleet + wingPerHuman × humanCount`, capped by
  `maxFleet`. Fixed-fleet (Model A) is `{ baseFleet: N, wingPerHuman: 0 }`;
  per-player wings (Model B) is expressible but not the launch config.
  Tunable in code, SINGLE preset at launch (at/near fixed-fleet) —
  every preset is a different game to balance, so prove one point in
  the space before exposing the knob (a "big battle" preset for
  friend rooms can come later). Defaults extend `GameConfig.fleets`.
- **Wingman feel comes from doctrine, not ownership.** A friendly-side
  `FleetCommander` (the enemy side already has one) distributes the
  team's AI ships across human players as escort wings (`cover` orders
  with that human as leader, via the existing `setOrder()` seam),
  re-assigning as humans join/leave. Solo = the whole AI fleet escorts
  you (≈ today's single-player); full room = no AI, pure squad play.
  Orthogonal to fleet sizing by design. Human-issued wing orders
  ("attack my target") are a future feature this sets up, not launch.

---

## Verification (read me before starting any phase in the cloud)

This plan is designed to be executed largely by cloud agent sessions
**without a browser**. The split of responsibilities:

**Headless-provable (cloud sessions own this):**
- `npm run typecheck` + `npm run build` after every task, as always.
- **The sim smoke harness is the backbone** (Phase 0's FIRST task —
  build it before splitting anything). It runs two AI fleets headless
  for N fixed-dt ticks and asserts the battle plays out. Because the
  sim is deterministic with fixed dt + seeded RNG, capture a BASELINE
  trace (positions/HP at sampled ticks) on the unmodified code, then
  diff against it after every split task: "refactor changed nothing"
  becomes a mechanical check, not a visual one.
- **vitest** (decided 2026-06-12) is the test runner — Vite-native,
  zero config here. `npm test` joins typecheck in the green-pipeline
  definition. Unit-test the headless-testable math as it's written
  (interpolation buffer, reconciliation, sensor filtering).
- Phase 1 integration tests run in Node: `@colyseus/testing` (or a
  plain `colyseus.js` client — no browser needed) joins rooms, sends
  `InputState`, asserts the state patches that come back.

**Human-only (tasks tagged `[human]` below):** the project owner runs
the dev server and eyeballs each phase locally (view sync, FX timing,
menu flow); drives the Phase 2 feel-tuning loops; provisions accounts/
DNS/secrets; playtests with real humans. Cloud sessions must NOT
attempt `[human]` tasks — prepare the artifacts and a step-by-step
checklist for them instead, and stop there. Definition of done for a
cloud session: green typecheck + green tests + smoke baseline intact,
on a branch ready for local eyeball QA.

---

## Phase 0 — Sim/view split (no networking yet)

> **Status (2026-06-17): Phase 0 COMPLETE.** Smoke harness + the `Ship`,
> `Laser`/`LaserSystem`, `Missile`/`MissileSystem`, and `Mothership` splits,
> the sim→view event channel, the `Game.tick` split (`advanceSim` /
> `updateViews`), and the AI/sensors scene-free audit all landed with the
> baseline trace clean throughout; the `[human]` eyeball pass passed (full
> matches played, depiction confirmed unchanged). Next: Phase 1 — the
> workspace restructure (`git mv src/game/sim → shared/src`, etc.).

The prerequisite refactor: separate gameplay truth (sim — runs anywhere)
from its Babylon depiction (view — client only). The game must play
identically single-player after every step. Run `npm run typecheck`
after each task as usual.

As files get split, place sim halves in `src/game/sim/` and views in
`src/game/view/` — that makes Phase 1's workspace restructure a
mechanical, history-preserving `git mv` (see Decisions → restructure
timing).

- [x] **Headless smoke harness — FIRST, before any splitting.** Add
      vitest; write a headless run (NullEngine or plain Node imports)
      that constructs the full sim with two AI fleets, runs N
      fixed-dt ticks, and asserts ships move/fire/take damage/die/
      respawn and a mothership eventually falls. Seed the AI wander
      RNG (multiplayer wants determinism anyway). Capture a baseline
      trace (sampled positions/HP per tick) from the UNMODIFIED code
      and commit it; every task below must leave the baseline diff
      clean (or explain why it legitimately changed). Doubles as a
      balance-testing harness forever after.
- [x] **`Ship` + `ShipView` split** — the pattern-setter for every
      split below.
      Remove `root: TransformNode` from `Ship`'s constructor; delete the
      four view touches (`die()` setEnabled, `respawn()` root sync,
      `update()`'s "Sync visuals" block). New `ShipView` owns the node
      and reads a `ShipPose` interface (`position`, `rotationY`,
      `bankAngle`, `isAlive`) each frame — an interface, not the `Ship`
      class, so a network snapshot buffer can feed the same view later.
      Also: `die()` takes `nowMs` as a parameter instead of calling
      `performance.now()` (the server owns sim time).
- [x] **`Laser` / `LaserSystem` split** — extract bolt sim state
      (position, age, kill flag, collision sweep) from the mesh; views
      pool the meshes.
- [x] **`Missile` / `MissileSystem` split** — same surgery; homing
      steering is sim, composite mesh + trail are view. (While in here:
      see the missile tunneling TODO — port LaserSystem's swept test if
      missile speed is ever raised.)
- [x] **Mothership split** — HP/`DamageTarget`/hull-rect logic +
      launch-bay geometry = sim; GLB, materials, death FX = view.
      `MothershipSection` is already pure math — verify, don't touch.
- [x] **Sim → view event channel** — explosions, hit/death SFX, camera
      trauma, hitstop, damage flash used to fire inline in `Game.tick`
      next to sim calls. Now the sim sites EMIT facts on a typed
      `SimEventBus` (`src/game/sim/SimEvents.ts`: `laserHit`, `missileHit`,
      `missileIntercepted`, `shipFiredLaser`, `missileFired`, `shipLaunched`,
      `shipRammedAsteroid`, `shipDied`, `mothershipDied`, `asteroidShattered`)
      and `Game.wireSimEventFeedback()` subscribes the client-side FX. The
      bus is synchronous (listeners run in emit order) so it was a
      behavior-identical move — baseline trace unchanged. A headless/server
      run simply doesn't subscribe. Payloads carry raw sim refs (ship/
      shooter/position), NOT an `isPlayer` flag — the subscriber derives
      "is this the local pilot" via `ship === playerShip`, so attribution
      stays per-SHIP. These events become the network messages for
      transient FX in Phase 2 (the live object refs are where Phase 2's
      serialization boundary lands).
- [x] **Split `Game.tick`** into `advanceSim(dt, nowMs)` (server-safe:
      sensors → commander → controllers → ships → weapons → collisions →
      death/respawn → projectiles → win/lose) and `updateViews(dt)` (poses →
      FX → camera → HUD → radar → render). Hitstop stays a client-only freeze
      the browser gates OUTSIDE advanceSim (the server never freezes); the
      end-of-match gate lives INSIDE advanceSim so a headless caller no-ops the
      gameplay body on its own. The engine-glow/maneuvering-plume visuals that
      used to sit inline in the sim loop are bridged to updateViews via each
      combatant's `lastInput`, so advanceSim touches no scene state.
- [x] **Verify AI + sensors are scene-free** — audited: `AIController`,
      `FleetCommander`, `SensorSystem`, `ShipController` and every `sim/*`
      module import only `Maths/*` from Babylon (pure). The one straggler was
      `CombatNebulas`'s concealment-zone math, trapped in the textured view
      and duplicated in the smoke harness; extracted to scene-free
      `sim/CombatNebulaZones.ts` (`computeConcealmentZones`), now the single
      source both the view and the harness consume. (`AsteroidField`/`Asteroid`
      are mesh-builders run under NullEngine headless — not on the split list;
      a later sim/view split, if ever needed.)
- [x] `[human]` **Local eyeball pass** — DONE (2026-06-17): full matches
      played on `feat/phase0-smoke-harness`; depiction confirmed unchanged
      (meshes track, bank rolls right, FX/SFX/shake/hitstop fire on cue,
      launch + respawn + victory/defeat all correct). Headless proved the
      sim didn't change; this proved the depiction didn't. Checklist:
      `docs/PHASE0_EYEBALL_CHECKLIST.md`.

## Phase 1 — Colyseus skeleton

> **Status (2026-07-04, post-playtest + HUD slice): online client PLAYS WELL
> solo** — smooth motion (sim-clock interpolation), ready-gated visible
> launches from the GLB's real tubes, full combat FX/sound, predicted local
> ship + own weapon fire (muzzle-true, steady cadence), engine
> glow/trails/RCS, a replicated asteroid field with locally-predicted
> collisions (no invisible walls), and the FULL HUD online: radar w/ sensor
> picture + stealth + human halos, RWR, kills/score, lock/sig cues, pilot
> counts, homing missile depiction, server-side human missile locks.
> Branch `feat/phase1-multiplayer` (not yet merged); 10/10 tests green;
> PROTOCOL_VERSION 8. Remaining before merge: PLAY ONLINE/invite entry,
> friendly commander, the `[human]` two-tab acceptance pass + feel tuning.
> **Resume notes: `docs/PHASE1_OPEN_ISSUES.md`.**

- [x] **Restructure into workspaces** (first task of this phase): npm
      workspaces with `shared/` + `client/` + `server/` per the layout
      in Decisions. `git mv src/game/sim → shared/src` etc. (history
      preserved; only content change is client imports rewritten to
      `@space-duel/shared`); added root `tsconfig.base.json` the three
      packages extend; `shared`'s `"exports"` → `./src/index.ts` (source,
      no build step, barrel public surface); root `npm run dev` (→ client)
      / `npm run typecheck` (→ all workspaces + root tests) / `npm test`
      keep working. Smoke baseline intact, typecheck + build green.
- [x] **Server app**: Colyseus `Server` + `WebSocketTransport` + a
      `BattleRoom` running `BattleSim.advance` on `setSimulationInterval`
      (30Hz), GameConfig delta clamp kept. (Note: also did the Phase 0
      collapse first — extracted the scene-free `shared/sim/BattleSim`
      coordinator the room/harness/client all share, proven baseline-
      identical, plus the asteroid sim/view split it required.)
- [x] **State schema** (`@colyseus/schema`, decorator-free `defineTypes`):
      ships MapSchema (pose, hp, faction, shipType, alive, launching,
      isAI), two motherships (hp/alive), phase/winner/tick. Patch rate
      15Hz.
- [x] **Input messages**: client samples input and sends `InputState`
      (`MSG.input`); the server replays it into that player's `Ship` via the
      `NetworkController` seam (`shared/NetworkController.ts`). Proven by the
      integration + unit tests (held `rotateRight` over the wire turns the
      seat; `jumpPressed` is a one-shot edge). Client-side SAMPLING/sending
      lands with the dumb-client-rendering task.
- [x] **AI fills empty seats**: every seat starts AI-flown (solo join plays
      the full battle), humans claim a free seat on their faction
      (AI→`NetworkController`), `onLeave` hands it back; the `isAI` flag is
      replicated (tested). Launch config is fixed-fleet (`GameConfig.fleets`
      per side); the `baseFleet + wingPerHuman × humans` formula knob is a
      later refinement (single preset at launch — see Decisions). Honesty
      rule shipped 2026-07-04: HUD `pilots` row (N human · M ai) + white halo
      rings on human-piloted radar blips, friend or foe.
- [ ] **Friendly-side `FleetCommander`**: the player faction gets a
      commander (enemy side already has one) whose doctrine assigns the
      team's AI ships to human players as escort wings (`cover` w/ that
      human as leader, via `setOrder()`), re-distributing on human
      join/leave/death. Replaces the static per-wingman standing orders
      in multiplayer rooms.
- [x] **Dumb client rendering**: `client/game/NetworkGame.ts` runs no sim —
      reuses the single-player view stack, builds a `ShipView` per replicated
      ship and snaps it to the raw server pose each frame (local ship found via
      the `owner` schema field), and sends `InputState` at 30Hz. Carrier HP
      bars + victory/defeat banner from state. Steppy/laggy as expected
      (interpolation + prediction are Phase 2). Fighters are procedural meshes
      for now (per-type GLBs = later polish); transient FX await Phase 2.
- [x] **Protocol version gate**: `PROTOCOL_VERSION` in `shared/protocol.ts`,
      sent in join options; the room rejects a mismatch with a typed
      `ServerError(PROTOCOL_MISMATCH)` (tested). The client keys a dedicated
      "NEW VERSION — refresh the page" splash string off the mismatch code
      (anything else stays "server unavailable").
- [~] **Join flow**: QUICK MATCH works — `?online` (or `#online`) routes the
      existing splash/loadout flow into `joinOrCreate` with the loadout as join
      options (`LoadoutMenu` reused unchanged); no flag = fully-offline PLAY
      SOLO. REMAINING: promote it to explicit splash PLAY SOLO / PLAY ONLINE
      buttons, and WITH FRIENDS (create room → `#join=<roomId>` invite URL +
      auto-join). No server browser (by design).
- [~] **Node integration tests**: DONE — `@colyseus/testing` boots the
      BattleRoom in-process and asserts replication (AI-backfilled battle to
      the client), server-side sim advance (launch→playing, ships move), input
      replay over the wire, and protocol-mismatch rejection
      (`tests/server/battleRoom.test.ts`); plus the `NetworkController→Ship`
      unit test. Full suite green (9 tests). REMAINING: the `[human]`
      checklist below.
- [ ] `[human]` **Local two-tab acceptance test** — run server + client
      on localhost, two browser tabs in the same room: both ships
      visible and moving, inputs land, AI fills the rest, match plays
      to victory/defeat. This is the phase's real definition of done;
      the Node integration tests get you to the doorstep. **Checklist +
      run instructions: `docs/PHASE1_TWOTAB_CHECKLIST.md`.**

## Phase 2 — Netcode feel

Feel is the deliverable here, and feel is a human judgment under real
latency — expect ITERATIVE `[human]` tuning loops, not a one-shot
implementation. Every feel parameter (interpolation delay, smoothing
rates, correction snap thresholds) must be a tunable, not a constant,
so tuning passes don't need code changes.

- [x] **Interpolation buffer** for remote ships/missiles: render
      ~100–150ms behind server time, lerp between snapshots (this is
      the `ShipPose` feeder that replaces the local sim for remotes).
      DONE 2026-07-04 — on the SERVER SIM CLOCK (`state.timeMs`), not
      arrival time: sim 30Hz vs patch 20Hz alias, so arrival-time
      interpolation judders (the Phase 1 jitter bug). Teleports (jump/
      respawn) pop across the discontinuity instead of streaking.
- [x] **Client prediction + reconciliation** for the local ship: run the
      shared `Ship` sim locally on pending inputs, rewind/replay on
      server correction. DONE 2026-07-04 — sequenced inputs acked via
      `ShipSchema.lastInputSeq` (+ replicated vx/vz to rewind); residual
      error absorbed into a decaying correction offset, hard snap past a
      threshold; gated off during launch/death/respawn. Feel knobs in
      `GameConfig.net` (awaiting the `[human]` tuning loop).
- [x] **Event replication for FX**: laser fired / hit / explosion /
      missile launch events → client SFX, shake, hitstop, flashes
      (reusing the Phase 0 event channel). DONE 2026-07-04 — BattleSim
      owns a SimEventBus; BattleRoom broadcasts batched, sim-timestamped
      NetEvents; NetworkGame plays each at its sim time on the render
      clock (cosmetic projectile pools, explosions, jump FX, full
      SoundSystem, distance-scaled trauma). No hitstop in MP (a frozen
      render clock would desync interpolation). Kills/score ride the
      `shipDied` event's `by` attribution (server keeps a last-hit-by
      ledger per ship); missiles carry their lock target id so the
      cosmetic round homes and the RWR hears seekers on YOU.
- [ ] **Sensor-filtered replication**: server only replicates contacts
      the player's faction `SensorSystem` can see (nebula stealth
      becomes anti-wallhack, not just UI). Friendlies always replicate.
- [x] **Clock sync + debug overlay**: RTT estimate, server-time offset,
      snapshot age, prediction error — on a hotkey, dev builds only.
      DONE 2026-07-05 — `NetDebugOverlay` (plain DOM, Backquote toggles
      online; the key is god mode offline only): clock offset, interp
      delay, snapshot buffer depth + headroom vs render time, pending
      inputs + ack lag, correction magnitude, fx-queue depth, netsim
      status. Stats gathered in `NetworkGame.tick` only while visible.
- [x] **Network-condition simulator**: artificial latency/jitter/loss
      injected on the local connection (dev-only flag), so most feel
      tuning can happen on localhost instead of needing a deployed
      remote server. DONE 2026-07-05 — `GameConfig.net.sim`
      (enabled/latencyMs = RTT halved per direction/jitterMs): NetClient
      delays outgoing sends, NetworkGame holds arriving patches (CLONED —
      the schema object mutates in place) + event batches in monotonic
      `DelayQueue`s (order preserved, like TCP; no loss — the transport
      is a WebSocket, "loss" manifests as delay). Cannot run silently:
      console banner + pinned amber NETSIM badge.
- [ ] `[human]` **Feel-tuning loops**: play under simulated (then real)
      latency, adjust the exposed tunables, repeat until remote ships
      are smooth and your own ship feels immediate. Cloud sessions
      prepare the machinery + overlay + tunables; they cannot judge
      feel.

## Phase 3 — Match flow & infrastructure

- [ ] **Room lifecycle**: countdown/launch with N players, mid-match
      join (humans replace an AI seat or spawn from a carrier bay),
      disconnect → `AIController` takes over the ship (reconnect takes
      it back), victory/defeat → room disposal.
- [ ] **Reconnection**: Colyseus `allowReconnection` for brief drops.
- [ ] **Lobby polish**: smooth out the Phase 1 join paths — connecting/
      error states, copy-invite-link button, rejoin-last-match prompt.
- [ ] **Hosting artifacts** (cloud-preparable): esbuild bundle config,
      systemd unit file, Caddyfile (`play.<domain> → reverse_proxy
      localhost:2567`), CORS config for the static-site origin, GitHub
      Action workflow (typecheck + build all packages, scp bundle +
      restart unit, publish client build with `VITE_SERVER_URL` per
      environment) — plus a step-by-step provisioning checklist for
      the `[human]` task below.
- [ ] `[human]` **Provisioning**: buy the VPS, point the subdomain's
      DNS A record at it, install Caddy + the unit file per the
      checklist, add the SSH deploy key as a repo secret, first
      deploy. Accounts/credentials work — agents must not attempt it.
- [ ] `[human]` **Playtest pass**: real humans, real latency (not
      localhost) — tune patch rate, interpolation delay, prediction
      smoothing via the Phase 2 tunables.

---

## Out of scope (same spirit as CLAUDE.md's list)

- Accounts, persistence, leaderboards beyond the existing local best.
- Multi-region / horizontal scaling (Redis presence). Single process
  until player counts force the issue.
- Voice/text chat.
- Lag compensation (rewind hit-testing) — lasers are slow projectiles,
  not hitscan; revisit only if hit registration feels unfair in
  playtests.
