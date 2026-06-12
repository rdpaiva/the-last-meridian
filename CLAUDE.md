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
- **Node** 20.19+ or 22 LTS, **npm**

```bash
npm install          # ~14 packages
npm run dev          # http://localhost:5173
npm run build        # tsc --noEmit + vite production build
npm run typecheck    # tsc --noEmit alone
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
├── Combatants: Ship × N, each driven by a ShipController
│     ├── player Ship    = LocalInputController (+ EngineGlow + DamageFlash)
│     ├── wingman Ships  = AIController (player faction, standing orders) [Phase 5]
│     └── enemy Ships    = AIController (enemy faction, default "patrol")
├── LaserSystem × 2 (humans faction + machines faction)
├── MissileSystem (player heat-seeking secondary; homing + limited ammo)
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
src/
  main.ts                  entry: staged splash state machine (landing → intro crawl → faction select | quick play for returning players) → construct Game with the chosen loadout; centralized unlockAudio(); handle resize
  style.css                full-viewport canvas + HUD styling
  game/
    Game.ts                top-level coordinator and render loop
    GameConfig.ts          ALL tuning constants (see "GameConfig surface" below)
    types.ts               InputState, ShipState, DamageTarget interface
    math.ts                clamp, lerp, exponentialDecay, exponentialMultiplier
    InputManager.ts        keyboard tracker with blur-safe key clearing
    Arena.ts               wireframe grid plane + position clamping helper
    Asteroid.ts            single destructible drifting rock (faceted icosphere; DamageTarget + line-of-sight cover obstacle)
    AsteroidField.ts       rock collection: spawn/drift/wrap + shatter-into-chunks; exposes obstacles[] (held by reference by the weapon systems for cover)
    AssetLoader.ts         GLB importer with procedural fallback (two-tier root); fallback has two designs (classic/viper) via GameConfig.player.shipDesign
    Faction.ts             humans|machines type + opposing() + FACTION_THEME (colors/labels)
    Loadout.ts             PlayerLoadout {faction, shipType} + localStorage persistence (lastMeridian_* keys incl. introSeen; validated vs GameConfig.factionShips; hasSavedLoadout gates quick play)
    LoadoutMenu.ts         splash faction/ship select: faction cards → per-faction ship cards w/ thumbnails → hangar preview + PLAY (plain DOM, keyboard-driven; stats read from shipTypes)
    ShipPreview.ts         standalone Babylon engine for the splash: rotating selected-ship GLB turntable + cached ship-card thumbnails (disposed at launch)
    SensorSystem.ts        per-faction sensor picture: SensorContacts w/ last-known positions, ghost decay, nebula concealment
    CombatNebulas.ts       gameplay stealth clouds above the fighter plane; zones[] feeds SensorSystem + Radar
    FleetCommander.ts      enemy fleet doctrine (strikers/escorts/dynamic pool) re-tasked ~2s via AIController.setOrder()
    Ship.ts                unified ship sim + HP + DamageTarget + muzzle/fire (config-injected; merges old PlayerShip/EnemyShip)
    ShipController.ts      controller interface + ControllerWorld (opponents/mothership/leader → InputState)
    LocalInputController.ts  keyboard controller (surfaces InputManager.state) = the player
    AIController.ts        order-driven AI (patrol/strike/hunt/cover/formation/defend), emits InputState; targets SENSOR CONTACTS; setOrder() = runtime re-task seam
    FighterMesh.ts         faction-themed procedural fighter mesh + randomFighterSpawn helper
    Laser.ts               single bolt entity (position, age, kill flag)
    LaserSystem.ts         per-faction bolt collection + collision + onHit
    Missile.ts             single homing missile (composite mesh + trail; steers to target)
    MissileSystem.ts       player missile pool: lock-fed homing, ammo, collision, onHit
    CameraRig.ts           top-down camera, velocity lead, trauma-based shake
    EngineGlow.ts          core sphere + TrailMesh behind player, thrust-driven
    DamageFlash.ts         red emissive sphere pulses around player on damage
    Explosion.ts           short-lived explosion (flash sphere + N debris)
    ExplosionSystem.ts     spawns/updates/disposes explosions
    SoundSystem.ts         5 CC0 SFX + engine hum loop + audio unlock
    Starfield.ts           camera-locked wrapping parallax field (thin-instanced; count independent of arena size)
    Nebulas.ts             alpha-blended cloud quads from PNG textures (count via GameConfig)
    Backdrop.ts            full-screen deep-space background Layer (2D blit)
    CapitalShips.ts        3 procedural destroyer composites in deep background
    Mothership.ts          BSG-style carrier; DamageTarget objective (HP) + multi-bay launch helpers (getLaunchStartPosition(bayIndex))
    LaunchSequence.ts      per-ship catapult (hold→launching→complete); player's hold is the cinematic intro+3-2-1 countdown, others a staggered wait. Both fleets launch from their carrier's two bays at match start (Game.assignInitialLaunches/launchFleet); skipIntro = respawn relaunch
    Hud.ts                 DOM HUD: HP cue + sig (DETECTED/HIDDEN) + kills/score + mothership bars + victory/defeat banner
    Radar.ts               player-centered north-up canvas minimap (friendlies = truth; hostiles = sensor picture w/ ghost rings; nebula zones)
public/
  models/                  drop fighter.glb here if you want a real ship
  sounds/                  5 CC0 MP3s + SOURCES.md attribution
  textures/                nebula cloud PNGs + space-backdrop.jpg (+ SOURCES.md)
```

---

## GameConfig: the tuning surface

The whole game's tuning lives in `src/game/GameConfig.ts`. Major sections:

| Section | What it controls |
|---|---|
| `shipTypes` | THE SHIP CATALOG: one complete profile per type (spitfire / breaker / wraith / reaver) — movement, muzzles, fireMode, `maxHp`, per-bolt `laserDamage`, `missileAmmo`, `hitRadius`, GLB `model`, fire sound. Add a ship = add an entry (see `docs/RECIPES.md` → "Add a new ship type") |
| `player` | DEFAULT `shipType` + `faction` (the splash loadout menu overrides both per run — see `Loadout.ts`), procedural fallback `shipDesign` |
| `factionShips` | Which catalog ships each faction fields (fighter, gunship) — the loadout menu's roster |
| `fleets` | PER-FACTION fleet defaults: `fleet` composition (`{ type, count }` picks) + `strikeCount`. The AI flies the fleet of whichever side the player didn't pick |
| `sensors` | Per-faction awareness: ship/carrier radar ranges, eyeball `visualRange`, ghost `memorySec`, sweep cadence, nebula penalty |
| `commander` | Enemy fleet doctrine: think cadence, escort/defend/hunt counts, carrier-alert radius |
| `ai` | Shared AI decision knobs: engage/fire ranges, fire cone, wander, leash, formation gains |
| `player.wingmen` | Wing size, per-wingman orders + formation slots + PER-FACTION `shipTypes` lists (empty list = wing clones the player's type) |
| `laser` | Bolt speed/lifetime/visuals (shared across both factions; per-bolt damage comes from the firing ship's type) |
| `missile` | Homing secondary: speed, turnRate, damage range, lock range/cone, mesh + trail dims (rack size is per ship type) |
| `arena` | Half-width, half-depth |
| `camera` | Offset, smoothing rate, velocity lead, zoom range/rate |
| `combat` | Fallback hit radius / laser damage, respawn delays (ship HP lives in `shipTypes`) |
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
  state on construction.
- **Use `disableLighting = true` on emissive materials** that should
  glow regardless of scene lighting (lasers, engines, stars, lights).

---

## Out of scope (DO NOT add unprompted)

These have been considered and deliberately left out. If the user asks
for one, do it. Otherwise: don't.

- **React or any UI framework.** HUD is plain DOM.
- **Multiplayer / networking.** No reason to add it for an arcade duel.
- **Physics engine** (cannon, ammo, havok). Motion is hand-rolled.
- **ECS framework**. The handful of entities don't need it.
- **Mobile / touch controls**. Keyboard only.
- **Gamepad input**.
- **A complex menu system**. The staged splash flow (landing → intro crawl →
  faction/ship select, with one-click quick play for returning players) is
  the deliberate ceiling — keyboard-first, saved choice, Enter back into
  play. Don't grow it into settings screens / pause menus unprompted.
- **Asset preloading splash screens**.

---

## See also

- `docs/SUBSYSTEMS.md` — per-subsystem deep-dives (read before editing one).
- `docs/RECIPES.md` — step-by-step playbooks for common extensions.
- `README.md` — project setup for humans, screenshots, contributor notes.
- `docs/ROADMAP.md` — status of every feature (done / in flight / future).
- `docs/AGENT_KICKOFF.md` — copy/paste prompt template for starting a
  fresh chat with a coding agent.
- `public/sounds/SOURCES.md` — CC0 sound asset attribution.
