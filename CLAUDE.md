# CLAUDE.md — Agent primer for space-duel

> **Read this first.** It captures the architecture, conventions, and
> gotchas an AI agent needs to be productive in this codebase without
> re-deriving them. For humans, see `README.md`. For what's done vs.
> still on the table, see `docs/ROADMAP.md`.

---

## What this is

`space-duel` is a browser-based, top-down 2.5D arcade space combat game.
You pilot a fighter on a flat X/Z plane against a single AI enemy in a
bounded arena. Visual style: low-poly procedural ships, glowing lasers,
bloomed engines, soft nebula backdrops, capital-ship silhouettes far below.

Current state: single-player fleet-vs-fleet loop with respawn, combat juice
(camera shake, hitstop, damage flash), a splash loadout menu (pick side +
ship), per-faction sensors with nebula stealth, an enemy fleet commander,
and kills/score with a persistent best. No waves, no networking. See
`docs/ROADMAP.md` for the full status.

---

## Stack & commands

- **Vite** ^5.4 (vanilla TS template; no React, no UI framework)
- **TypeScript** ^5.4, strict mode, ES2022 target
- **Babylon.js** core + loaders **^7.50** (pinned to 7.x — 9.x's `@babylonjs/inspector` has a breaking peer dep)
- **`@babylonjs/inspector`** ^7.54 (dev-only; useful for live mesh debugging)
- **Node** 20.19+ or 22 LTS, **npm workspaces** — three packages:
  `shared/` (sim + config, `@space-duel/shared`), `client/` (Babylon view +
  menus), `server/` (Colyseus). Root scripts fan out to the right workspace.

```bash
npm install          # all workspaces
npm run dev          # client → http://localhost:5173
npm run server       # Colyseus dev server (tsx watch)
npm run build        # typecheck + vite production build (client)
npm run typecheck    # tsc --noEmit across ALL workspaces
npm run test         # vitest (headless sim tests)
```

**The dev/build pipeline must stay green.** Run `npm run typecheck` after
every code edit; `npm run build` before any release packaging.

---

## Coordinate system & math conventions

### Babylon left-handed (LHS)

- `+X` = right, `+Y` = up, `+Z` = forward (away from camera at rotation 0)
- **DO NOT** enable `scene.useRightHandedSystem = true`. The glTF loader
  handles RHS→LHS conversion internally; flipping the scene would invert
  every forward-direction calculation in the game.

### Ship rotation conventions

- A ship's "facing" is its `rotationY` (scalar, radians).
- At `rotationY = 0`, forward is `(0, 0, 1)` = `+Z`.
- Increasing `rotationY` rotates clockwise when viewed from above.
- "Rotate right" → `rotationY += rotationSpeed * dt`. "Rotate left" → `-=`.
- World-space forward: `(sin(rotY), 0, cos(rotY))`.

### Frame-rate-independent motion

**Every rate is per second, not per frame.** Use the helpers in `math.ts`:

```ts
// Exponential decay toward zero (e.g. drag):
velocity *= exponentialMultiplier(dragRate, deltaSeconds);

// Lerp factor for smoothing toward a target (e.g. camera tracking):
trackedTarget += (target - trackedTarget) * exponentialDecay(rate, dt);
```

**Never write `velocity *= 0.985` per frame.** That's a frame-rate-dependent
bug that gives different physics at 60Hz vs 144Hz. Look at how `PlayerShip`,
`EnemyShip`, and `CameraRig` handle it — every "rate" config name reflects
this convention.

### Delta-time clamp

`Game.tick` caps delta at `1/30` sec (`GameConfig.scene.maxDeltaSeconds`).
Without this, a tab refocus after being backgrounded for 30 seconds would
ship a single 30-second delta to every subsystem and teleport ships through
walls. Keep the clamp.

---

## Architecture

### One-screen overview

```
Game (top-level coordinator)
├── Engine + Scene + GlowLayer
├── Lights (HemisphericLight + DirectionalLight)
├── Scenery (Backdrop, Nebulas, Starfield, CapitalShips — fire-and-forget)
├── CombatNebulas (gameplay stealth clouds; exports ConcealmentZone footprints)
├── SensorSystem (per-faction contact pictures — AI + radar read THESE, not ground truth)
├── FleetCommander (enemy-side doctrine: re-tasks the fleet on its own sensor picture)
├── Arena (wireframe grid + arena bounds)
├── Motherships × 2 (humans + machines; DamageTarget = the win/lose objective)
│     └── Turrets (auto-tracking carrier flak; sub-emitters into the faction LaserSystem; own HP = shootable off)
├── Combatants: Ship × N, each driven by a ShipController
│     ├── player Ship    = LocalInputController (+ EngineGlow + DamageFlash)
│     ├── wingman Ships  = AIController (player faction, standing orders) [Phase 5]
│     └── enemy Ships    = AIController (enemy faction, default "patrol")
├── LaserSystem × 2 (humans faction + machines faction)
├── MissileSystem × 2 (per-faction heat-seekers; any ship type with a rack fires — player, wingmen, enemy fleet)
├── MissileWarning (player RWR: beep + HUD border pulse + radar blips while an enemy missile homes on the player)
├── ExplosionSystem
├── SoundSystem
├── CameraRig
├── Hud (plain DOM)
└── Radar (canvas minimap)
```

### The render loop (`Game.tick`)

Single `engine.runRenderLoop(this.tick)`. Each frame:

1. Read `engine.getDeltaTime()`, clamp it, compute `nowMs` once.
2. Check `inHitstop = nowMs < hitstopUntilMs`.
3. `input.update()` — derives bools from held key set.
4. Unlock audio on first input frame.
5. **If not in hitstop (and the match hasn't ended):** advance simulation
   (FleetCommander think → each combatant's controller → ship → fire →
   lasers → missiles → explosions → win/lose check, including respawn
   logic). Sensors update every frame just before this block (even during
   hitstop, so the radar picture stays honest).
6. **Always:** update camera (shake animates during hitstop), damage
   flash, engine hum, HUD, then `scene.render()`.

### Key abstractions

**`DamageTarget` (types.ts)** — anything a laser can damage. Has
`position`, `hitRadius`, `isAlive`, and `takeDamage(amount)`. `Ship` and
`Mothership` both implement it.

**`Ship` + `ShipController` (the faction spine)** — control is decoupled
from the ship: one `Ship` sim consumes an `InputState` produced by a
`ShipController` (`LocalInputController` = keyboard, `AIController` = the
ported enemy AI, future `NetworkController`). The "player" is just the Ship
wearing a local controller, so the two factions (`humans`/`machines`, see
`Faction.ts`) are interchangeable and the design is multiplayer-ready. See
`docs/SUBSYSTEMS.md` → "Ship + Controllers".

**`LaserSystem`** — per-faction collection of bolts with a list of
`DamageTarget`s (every opposing ship + their mothership). On hit: damages
target, kills the bolt, fires `onHit(target)` (Game scales SFX + camera
trauma + hitstop + damage flash by what was struck).

**`GameConfig`** — single source of truth for every tuning knob in the
game. Adding a new tunable? Put it here. Reading a value? Always from
`GameConfig.X`. Never hardcode magic numbers in subsystem code.

**Two-tier root pattern (AssetLoader)** — `playerShipRoot` (outer,
gameplay drives `rotation.y`) wraps `playerShipModel` (inner, holds
fixed model-alignment correction). Modifying outer root rotation
gets clobbered every frame; modifying inner root persists.

---

## File map

```
shared/src/                @space-duel/shared — the SIM + config + AI: everything a headless
                           server tick needs. Imported by client AND server; no Babylon scene
                           code (math-only imports). One package = one source of truth.
  GameConfig.ts            ALL tuning constants (see "GameConfig surface" below)
  types.ts                 InputState, ShipState, DamageTarget interface
  math.ts                  clamp, lerp, exponentialDecay, exponentialMultiplier
  Faction.ts               humans|machines type + opposing() + FACTION_THEME (colors/labels)
  ShipController.ts        controller interface + ControllerWorld (opponents/mothership/leader → InputState)
  AIController.ts          order-driven AI (patrol/strike/hunt/cover/formation/defend), emits InputState; targets SENSOR CONTACTS; missile launch doctrine (fresh-track + envelope + LOS + pacing); setOrder() = runtime re-task seam
  FleetCommander.ts        enemy fleet doctrine (strikers/escorts/dynamic pool) re-tasked ~2s via AIController.setOrder()
  SensorSystem.ts          per-faction sensor picture: SensorContacts w/ last-known positions, ghost decay, nebula concealment
  LaunchSequence.ts        per-ship catapult (hold→launching→complete); player's hold is the cinematic intro+3-2-1 countdown, others a staggered wait; skipIntro = respawn relaunch
  WingPlan.ts              resolveWingPlan: GameConfig.player.wingmen ROLE COUNTS → concrete {shipType, order} wing slots for the picked loadout (+ formationSlot, the expanding-V generator)
  NetworkController.ts     controller fed by a remote player's input (the networked seat)
  Callsigns.ts             pilot callsign pool + sanitizePilotName (PILOT_NAME_MAX)
  protocol.ts              client↔server wire types + PROTOCOL_VERSION (bump on ANY wire change) + error codes (PROTOCOL_MISMATCH, FACTION_FULL)
  index.ts                 the package's public re-export surface
  sim/
    BattleSim.ts           the whole battle as ONE headless sim (seats both fleets + weapons + commander per tick); the server's BattleRoom drives it — solo Game wires the same subsystems itself
    Ship.ts                unified ship sim + HP + DamageTarget + muzzle/fire + the jump-drive state machine (idle→spooling→cooldown; docs/JUMP-DRIVE-AND-RESUPPLY.md)
    Laser.ts               single bolt entity (position, age, kill flag)
    LaserSystem.ts         per-faction bolt collection + swept collision + onHit
    Missile.ts             single homing missile sim (steers to target)
    MissileSystem.ts       per-faction missile pool: lock-fed homing, shooter attribution, collision, onHit
    Mothership.ts          carrier sim; DamageTarget objective (HP) + multi-bay launch helpers; hullSections = solid hull footprint, avoidanceCircles = AI steering shapes
    MothershipSection.ts   one world-space rectangle of a carrier's hull footprint: weapons-collision proxy via intersectsSegmentXZ + ship keep-out box
    Turret.ts              carrier defense gun SIM: auto-tracks a fresh SensorContact, slews, returns fire commands; own HP = individually destructible; setMuzzleData = GLB fire-point seam
    AsteroidSim.ts         single destructible drifting rock (DamageTarget + line-of-sight cover obstacle)
    AsteroidFieldSim.ts    rock collection: spawn/drift/wrap + shatter-into-chunks; exposes obstacles[] (held by reference by the weapon systems for cover)
    Hulk.ts                wreck hazard: a dead carrier's hull as terrain (map "hulk" hazards)
    HulkSection.ts         the wreck's world-space collision rectangles (HulkSection ≈ MothershipSection for hulks)
    CombatNebulaZones.ts   the gameplay stealth-cloud ZONE footprints (ConcealmentZone) — feeds SensorSystem; visuals live client-side
    SimEvents.ts           sim→view event channel: typed SimEventBus (synchronous on/emit) — sim sites EMIT facts (laserHit/missileHit/shipDied/…), the client subscribes FX; headless/server runs don't
    SimRng.ts              seeded deterministic sim RNG — never Math.random() inside the sim

client/src/                @space-duel/client — the Babylon view, menus, and entry (Vite root)
  main.ts                  entry: splash state machine — the loadout frame IS the front door (factionSelect); the intro cinematic (IntroCinematic.ts) is a first-run gate between its MODE and HANGAR steps (replayable from the rail); → construct Game (solo) or NetworkGame (online) with the chosen loadout; first-gesture audio unlock + splash music; applies the active Map + Difficulty at launch; handle resize
  style.css                full-viewport canvas + HUD + splash/overlay styling
  net/
    NetClient.ts           Colyseus client wrapper: quickMatch/joinById/createMatch + the #join=<roomId> invite-hash helpers
    DelayQueue.ts          dev network-condition simulator's ordered release queue (GameConfig.net.sim)
  game/
    Game.ts                top-level SOLO coordinator and render loop
    NetworkGame.ts         the ONLINE coordinator: server state in → prediction + interpolation over the same view stack (mirrors BattleSim math where it predicts)
    InputManager.ts        keyboard tracker with blur-safe key clearing
    LocalInputController.ts  keyboard controller (surfaces InputManager.state) = the player
    MouseSteering.ts       client-only mouse input: cursor = desired heading → InputState.turn (same P-controller as the AI), LMB/RMB = fire/missile; last-touched device wins (docs/SUBSYSTEMS.md)
    GamepadSteering.ts     client-only gamepad input: left stick = desired heading → same InputState.turn channel; RT/LT thrust/reverse, A/X/Y fire/missile/jump, LB/RB strafe, d-pad zoom (docs/SUBSYSTEMS.md)
    Arena.ts               wireframe grid plane + position clamping helper
    AssetLoader.ts         GLB importer with procedural fallback (two-tier root)
    Loadout.ts             PlayerLoadout {faction, shipType} + localStorage persistence (lastMeridian_* keys incl. introSeen, guideSeen, mode solo|online, pilotName; validated vs GameConfig.factionShips; hasSavedLoadout + hasSeenIntro gate the step-1 CONTINUE relaunch). Map + difficulty selections persist under sibling lastMeridian_* keys (Maps.ts / Difficulty.ts)
    LoadoutMenu.ts         the splash front door, THREE STEPS in a fixed header-rail/stage/footer-rail frame: 1 MODE (solo/multiplayer + callsign; returning players get a gold CONTINUE CTA) → 2 HANGAR (faction cards → roster + live preview) → 3 MISSION (solo: difficulty+arena; online: quick-match/invite briefing) → LAUNCH fires onPlay(mode). MODE→HANGAR advance first offers main.ts the firstRunIntro gate. Keyboard-driven; owns ENTER in factionSelect (yields to the controls overlay and the Field Manual while they're open). Footer links = controls overlay + LoadoutActions (field manual / replay intro / match settings)
    FieldManual.ts         the "hit the ground running" guide: a self-paced card deck (one gameplay concept per card — flight, weapons, carrier ops + Meridian Drive, ship roles, terrain, HUD/sensors) opened from the loadout footer link, or the gold ROOKIE PILOTS callout strip (LoadoutMenu.rookieCallout) that shows until the manual is first opened (lastMeridian_guideSeen). ALL text lives in buildCards() — edit/add lines there; timing numbers interpolate live from GameConfig. Visuals are game-rendered (ShipPreview thumbnails, HUD-color specimens, inline SVG) — no art assets
    Maps.ts                arena presets (docs/ARENA-MAPS.md): named battlefield bundles written into GameConfig at launch via applyMap; selection persists (lastMeridian_map); match-settings overrides win
    Difficulty.ts          ENEMY-skill presets (easy/normal/hard): applyDifficulty writes ai.*/commander.* knobs at launch; persists (lastMeridian_difficulty); player's own wing unaffected
    IntroCinematic.ts      the story intro as a cinematic slideshow (data-state="intro"): full-screen images/intro/* art w/ Ken Burns drifts + caption beats (the story text lives HERE); stop() = skip-safe teardown
    ShipPreview.ts         standalone Babylon engine for the splash: rotating selected-ship GLB turntable + cached ship-card thumbnails (also feeds the Field Manual; disposed at launch)
    TuningSchema.ts        CURATED declarative tuning surface (~70 gameplay knobs w/ label+bounds+step) — the match-settings GUI renders from this; add an entry = expose a knob
    ConfigOverrides.ts     sparse {dot-path: value} override map (lastMeridian_tuning) written into the live GameConfig at startup; schema-clamped; JSON export/import
    SettingsMenu.ts        splash match-settings screen (data-state="settings"): slider+number per knob, collapsible groups, per-row/global reset, COPY/PASTE SETUP share blob
    CombatNebulas.ts       the stealth clouds' VISUALS above the fighter plane (zones come from shared CombatNebulaZones)
    FighterMesh.ts         faction-themed procedural fighter mesh + randomFighterSpawn helper
    MissileWarning.ts      player RWR: polls enemy missiles homing on the player; beep w/ proximity tempo ramp + HUD border pulse + radar threat list
    CameraRig.ts           top-down camera, velocity lead, trauma-based shake
    EngineGlow.ts          core sphere + TrailMesh behind player, thrust-driven
    SecondaryThrusters.ts  strafe/reverse puff jets (view)
    DamageFlash.ts         red emissive sphere pulses around player on damage
    Explosion.ts           short-lived explosion (flash sphere + N debris)
    ExplosionSystem.ts     spawns/updates/disposes explosions
    JumpFlash.ts           jump-drive "FTL crack" core: cool flash sphere that pops then collapses (one per jump end)
    JumpFlashSystem.ts     spawns/updates/disposes jump flashes off the jumpFired SimEvent (departure + arrival)
    JumpRipple.ts          jump shockwave: screen-space refraction post-process; detaches when idle
    PostPipeline.ts        ACES tone-mapping / rendering pipeline setup
    SoundSystem.ts         CC0 SFX + engine hum loop + audio unlock; per-ship jump-drive sound lifecycle (start/stop/release, own vs spatial)
    MusicSystem.ts         in-game background music: shuffled playlist cycling (GameConfig.music)
    Starfield.ts           camera-locked wrapping parallax field (thin-instanced)
    Nebulas.ts             alpha-blended cloud quads from PNG textures (scenery, not gameplay)
    Backdrop.ts            full-screen deep-space background Layer (2D blit)
    CapitalShips.ts        3 procedural destroyer composites in deep background
    Hud.ts                 DOM HUD: HP cue + sig (DETECTED/HIDDEN/NO TRACK) + kills/score + mothership bars + victory/defeat banner + scoreboard
    Radar.ts               player-centered canvas minimap oriented to the screen (north-up; 180°-flipped for the north-end pilot) (friendlies = truth; hostiles = sensor picture w/ ghost rings; nebula zones)
    Nameplates.ts          callsign labels projected under ships (fixed full-viewport DOM layer)
    ScoreBoard.ts          per-pilot kill/death/score ledger for the OFFLINE match (mirrors the server's lastHitBy attribution)
    NetDebugOverlay.ts     dev overlay: netcode internals gathered by NetworkGame.tick
    view/                  per-entity VIEWS: read sim state each frame, own all meshes/FX
      ShipView / LaserSystemView / MissileSystemView / MothershipView /
      TurretView / AsteroidView / AsteroidFieldView / HulkView

server/src/                @space-duel/server — Colyseus authoritative server (docs/MULTIPLAYER.md)
  index.ts                 server entry: registers BattleRoom, listens (dev: npm run server)
  rooms/BattleRoom.ts      server-authoritative room: ticks the shared BattleSim at a fixed rate, replicates per-ship state
  schema/                  Colyseus replication schema

client/public/
  models/                  ship + carrier GLBs
  sounds/                  CC0 MP3s + SOURCES.md attribution
  textures/                nebula cloud PNGs + space-backdrop.jpg (+ SOURCES.md)
  images/ music/ videos/   splash art, intro slides, menu music, faction videos
scripts/
  measure-carrier-footprint.mjs  headless (NullEngine) GLB footprint measurer — run after re-exporting a carrier model to re-fit GameConfig.mothership.hullRects
  measure-hulk-colliders.mjs / hulk_colliders.py / build_wreck.py / skin_carrier.py  wreck + carrier-skin art pipeline (Blender/py)
```

---

## GameConfig: the tuning surface

The whole game's tuning lives in `shared/src/GameConfig.ts`. Major sections:

| Section | What it controls |
|---|---|
| `shipTypes` | THE SHIP CATALOG: one complete profile per type (spitfire / breaker / wraith / reaver) — movement, muzzles, fireMode, `maxHp`, per-bolt `laserDamage`, `missileAmmo`, `hitRadius`, GLB `model`, fire sound. Add a ship = add an entry (see `docs/RECIPES.md` → "Add a new ship type") |
| `player` | DEFAULT `shipType` + `faction` (the splash loadout menu overrides both per run — see `Loadout.ts`), procedural fallback `shipDesign` |
| `factionShips` | Which catalog ships each faction fields (fighter, gunship) — the loadout menu's roster |
| `fleets` | PER-FACTION fleet defaults: `fleet` composition (`{ type, count }` picks) + `strikeCount`. The AI flies the fleet of whichever side the player didn't pick |
| `sensors` | Per-faction awareness: ship/carrier radar ranges, eyeball `visualRange`, ghost `memorySec`, sweep cadence, nebula penalty |
| `commander` | Enemy fleet doctrine: think cadence, escort/defend/hunt counts, carrier-alert radius |
| `ai` | Shared AI decision knobs: engage/fire ranges, fire cone, carrier-strike standoff, missile launch doctrine (envelope/pacing), wander, leash, formation gains |
| `mothership` | Carrier objective: HP, GLB models + correction, launch bays, death FX — and `hullRects`, the PER-FACTION solid hull footprint (fitted to the GLBs via `scripts/measure-carrier-footprint.mjs`; re-fit after re-exporting a carrier model). `mothership.turrets` = defense-gun knobs + per-faction edge mounts + per-faction skinned GLB |
| `debug` | Dev/test only: `godSpeedMultiplier` for the Backquote god-mode toggle (player invuln + boost) |
| `player.wingmen` | The wing as ROLE COUNTS (`composition: { self, other, gunship }`, default 2/2/2), resolved against the runtime loadout by the shared `resolveWingPlan` (WingPlan.ts): `self`/`other` escorts fly `cover` on your wing, `gunship`s fly `defend` at your carrier. Also `formationSlot()`, the expanding-V slot generator. These counts are the "Your Wing" rows in match settings |
| `laser` | Bolt speed/lifetime/geometry (shared across both factions; per-bolt damage comes from the firing ship's type). Bolt COLOR is per faction (`FACTION_THEME.laserEmissive`) with a heavy-gunship tint (`laserHeavyEmissive`, selected by the shipType's `heavy` flag → `Laser.heavy` → `LaserSystemView`) and a shared orange turret-flak tint |
| `missile` | Homing secondary: speed, turnRate, damage range, lock range/cone, mesh + trail dims (rack size is per ship type) |
| `arena` | Half-width, half-depth |
| `camera` | Offset, smoothing rate, velocity lead, zoom range/rate |
| `combat` | Fallback hit radius / laser damage, respawn delays (ship HP lives in `shipTypes`) |
| `jump` | Jump drive: `spoolMs` (matched to `jump-drive.mp3`), `cooldownMs`, `commitMs`, `arrivalTrauma`, + `doctrine` (AI jump-out: per-pilot HP/ammo thresholds, dock-vs-jump range split, flee/blaze caution, finish-the-runner range). Cannon magazines are per ship type (`shipTypes[*].cannonAmmo`) |
| `service` | Carrier service bubble: `radius` (per launch-bay), `loiterMaxSpeed` gate, HP/cannon/missile refill rates |
| `jumpFx` | Jump "FTL crack" (view): flash radius/scale/color + `ripple` (screen-space refraction — strength/width/frequency/trailLength/maxRadius/highlight/durationMs) |
| `shake` | Trauma per impact type, decay rate, max offsets |
| `hitstop` | Pause-frame durations per impact type, stack cap |
| `damageFlash` | Duration, peak alpha, sphere diameter |
| `glow` | Bloom intensity, blur kernel |
| `shipPreview` | Splash hangar preview: camera framing, turntable speed, lights, IBL strength, thumbnail pose |
| `starfield`, `scenery` | Counts and Y levels for backdrop layers; `scenery.combatNebulas` = the gameplay stealth clouds (zones + visuals) |
| `engineGlow` | Trail dims, response rate |
| `explosion` | Debris count, durations, flash scale |
| `scene` | Clear color, delta-time clamp |

Adding new tunables? Add a new section here, comment it well, and read from
the const. The pattern is: **dial things in via GameConfig changes, then
commit; don't sprinkle magic numbers across files.**

---

## Gotchas (read before editing)

1. **`audioEngine: true` on Engine construction is non-optional.** Without
   it, `AbstractEngine.audioEngine` stays null and every Sound is silent
   forever. Already correct in `Game.ts`; don't remove the flag.

2. **Babylon side-effect imports are required per builder.** Using
   `MeshBuilder.CreateBox`? Add `import "@babylonjs/core/Meshes/Builders/boxBuilder"`.
   Same for `cylinderBuilder`, `sphereBuilder`, `groundBuilder`, `planeBuilder`.
   The tree-shaking is fine but it leaves these out unless you opt in.

3. **`SceneLoader.ImportMeshAsync` needs a trailing slash on rootUrl.**
   `"/models/"` not `"/models"`. Subtle 404 source.

4. **Engine glow trail is NOT parented to the ship root.** TrailMesh
   uses the anchor as a "generator" node; it lives separately in the
   scene. Disabling the ship root doesn't disable the trail. Fine for
   MVP, worth knowing.

5. **Sound clones can return null.** `SoundSystem` uses N independent
   `new Sound()` instances per pool entry instead of `.clone()` for this
   reason. The browser caches the MP3 fetch so N instances are cheap.

6. **`querySelector` returns `Element | null`, not `HTMLElement`.** If
   you need `.style` access (e.g. setting color on a HUD element), use
   `querySelector<HTMLElement>(...)`.

7. **Hitstop's asymmetry is intentional.** During hitstop, simulation
   pauses but camera shake, damage flash, audio, and rendering keep
   going. That's the whole effect — don't "fix" the asymmetry by
   pausing the camera too.

8. **Don't run subagents/jobs to write the audio assets or model.**
   Audio files in `public/sounds/` are committed CC0 MP3s with
   `SOURCES.md` attribution — preserve both.

9. **Image textures render through the emissive channel as luminance,
   not color.** A pale/photographic texture on `emissiveTexture` with a
   white `emissiveColor`, plus the GlowLayer, blows out to white. For
   tinted scenery (nebulas) drive color from `emissiveColor` and let the
   texture carry shape/detail. For a faithful full-screen background image
   use a Babylon background `Layer` (2D blit, immune to lighting/glow), NOT
   a large emissive plane. See `Nebulas.ts` / `Backdrop.ts`.

10. **Transparent PNGs need premultiplied edges or they fringe.** The
    nebula PNGs were authored with a transparency background; their
    antialiased edges kept a light/checkerboard color that shows as a halo
    when alpha-blended. Fix is to premultiply RGB by alpha so edge color
    fades to black with the alpha. If you drop in new cloud art and see an
    edge halo/checker, that's the cause.

11. **`window.__BABYLON_SCENE__` is exposed from `Game.ts`** for the
    Inspector recipe below and live DevTools debugging
    (`window.__BABYLON_SCENE__.getMeshByName(...)`). Don't remove it.

12. **Blank scene but HUD still shows? Check `GameConfig.camera.nearClip`
    / `farClip` first.** `CameraRig` reads them straight into
    `camera.minZ` / `camera.maxZ`. If either field is missing from the
    config, the value becomes `undefined`, the frustum collapses, and the
    ENTIRE 3D scene renders blank — while the DOM HUD keeps showing, which
    makes it look like a render bug rather than a config one. This has
    bitten more than once during camera-config edits (the fields sit at the
    end of the `camera` section and are easy to drop when editing nearby
    zoom values). Symptom → suspect missing clip planes. They're marked
    REQUIRED in `GameConfig.ts`; `npm run typecheck` also catches it
    (`Property 'nearClip' does not exist`), so run it after config edits.

---

## Combat flow

```
Player presses Space
  └ PlayerShip.tryFire() returns Vector3[] of world-space muzzle positions
  └ Game.tick spawns one laser per position into playerLasers
  └ playerLasers.update() advances bolts, checks X/Z distance to enemy
  └ On hit: enemy.takeDamage(20), bolt.kill(), playerLasers.onHit() fires
       └ sound.playHit()
       └ cameraRig.addTrauma(0.20)
       └ applyHitstop(25ms)
  └ Enemy HP <= 0 → enemy.die() → mesh disabled, deathTimeMs set
  └ Game.tick sees !enemy.isAlive && !enemyExplosionFired
       └ explosions.spawn(enemy.position)
       └ sound.playExplosion()
       └ cameraRig.addTrauma(0.55)
       └ applyHitstop(70ms)
       └ enemyExplosionFired = true (so it doesn't re-fire next frame)
  └ After 3 sec, enemy.shouldRespawn(nowMs) → enemy.respawn(x, z)
       └ enemyExplosionFired reset to false
```

Symmetric flow for enemy lasers hitting the player, with an extra
`playerDamageFlash.trigger()` and bigger trauma/hitstop values.

---

## Detail docs (read on demand)

The orientation above (architecture, render loop, GameConfig surface,
gotchas, combat flow, conventions) is everything you need to start. Two
reference docs hold the per-area depth — pull them up when the trigger
below matches what you're about to touch:

- **Touching `PlayerShip`, `EnemyShip`, a `LaserSystem`, `ExplosionSystem`,
  `SoundSystem`, `CameraRig`, `EngineGlow`, `DamageFlash`, or any Scenery
  layer?** Read the matching entry in **`docs/SUBSYSTEMS.md`** first — each
  documents non-obvious invariants (two-tier root, hitstop asymmetry,
  trail-not-parented, nebula luminance/color split, camera-locked starfield)
  that the code alone won't tell you.
- **Adding a weapon, adding an enemy type, tuning juice, or live-editing
  the model in the Inspector?** The step-by-step playbook is in
  **`docs/RECIPES.md`**.

When you add a subsystem or a reusable extension pattern, document it in the
matching detail doc — keep CLAUDE.md to always-relevant orientation only.

---

## Style conventions

- **One class per file**, file named after the class.
- **No allocation in render-loop hot paths** where reasonable. Scratch
  Vector3s are stored on the owning class. The exception: `PlayerShip.tryFire()`
  allocates one Vector3 per muzzle per shot — fine at ~5-6 lasers/sec.
- **Every Babylon side-effect import gets a comment** explaining what it
  registers and why we need it. Future agents who'd otherwise remove
  "unused" imports will check first.
- **GameConfig is read-only at runtime.** If a value needs to change
  during play (e.g. wave difficulty), copy it into the system's own
  state on construction. ONE sanctioned writer exists: `ConfigOverrides`
  (the match-settings overrides) mutates GameConfig at STARTUP, before any
  system constructs — never mid-match. Don't add others.
- **Use `disableLighting = true` on emissive materials** that should
  glow regardless of scene lighting (lasers, engines, stars, lights).

---

## Out of scope (DO NOT add unprompted)

These have been considered and deliberately left out. If the user asks
for one, do it. Otherwise: don't.

- **React or any UI framework.** HUD is plain DOM.
- **Multiplayer / networking — now IN scope, but only via the plan.**
  Decided 2026-06-12: Colyseus, server-authoritative, co-op first. All
  work follows `docs/MULTIPLAYER.md` — don't ad-hoc networking outside it.
- **Physics engine** (cannon, ammo, havok). Motion is hand-rolled.
- **ECS framework**. The handful of entities don't need it.
- **Mobile / touch controls**. Keyboard + mouse + gamepad only (mouse added
  2026-07-06 — heading control via `MouseSteering`, not aim control; gamepad
  added 2026-07-07 — `GamepadSteering`, left stick = desired heading on the
  same `InputState.turn` channel, no parallel path).
- **A complex menu system**. The splash flow (the three-step loadout frame
  as the front door, the intro cinematic as a first-run gate, one-press CONTINUE
  for returning players, the Field Manual gameplay-guide card deck) is the
  deliberate ceiling — keyboard-first, saved choice, Enter back into play. ONE
  sanctioned exception: the match-settings tuning screen (`SettingsMenu`,
  dev/playtest tooling — see `docs/SUBSYSTEMS.md`). Don't grow it into general
  settings (audio/video/keybinds) or pause menus unprompted.
- **Asset preloading splash screens**.

---

## See also

**Task-tracking hierarchy** (decided 2026-07-06): `docs/AGENT_KICKOFF.md`
is the SINGLE SOURCE OF TRUTH for what the next session works on;
`docs/ROADMAP.md` holds feature status + the long-term idea backlog;
everything else is reference or historical record. File new work items in
AGENT_KICKOFF (queued) or the ROADMAP backlog (someday) — nowhere else.

- `docs/AGENT_KICKOFF.md` — THE next-session work queue + copy/paste
  kickoff prompt (whoever ends a session updates it — see its header).
- `docs/ROADMAP.md` — status of every feature (done / in flight / future)
  + the backlog of candidate features.
- `docs/SUBSYSTEMS.md` — per-subsystem deep-dives (read before editing one).
- `docs/RECIPES.md` — step-by-step playbooks for common extensions.
- `README.md` — project setup for humans, screenshots, contributor notes.
- `docs/MULTIPLAYER.md` — multiplayer decisions + phased task list
  (sim/view split → Colyseus skeleton → netcode feel → match flow/infra);
  the checkboxes are the phase RECORD, not the live queue.
- `docs/PHASE1_OPEN_ISSUES.md` — dated changelog + architecture notes from
  the multiplayer build-out (AGENT_KICKOFF tells you when to read it).
- `docs/DEPLOY.md` — live hosting topology + provisioned state (droplet,
  Caddy, "Deploy game" workflow).
- `public/sounds/SOURCES.md` — CC0 sound asset attribution.
