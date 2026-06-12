# Subsystem deep-dives

> Reference detail for individual subsystems. Read the relevant entry
> **before editing that subsystem** — each documents non-obvious
> invariants you can't recover from the code alone. For orientation
> (architecture, render loop, gotchas, conventions) start in `CLAUDE.md`.

---

## Ship + Controllers (the faction spine)

> Replaces the old `PlayerShip`/`EnemyShip` split. The key idea:
> **control is decoupled from the ship.** One `Ship` sim is driven by a
> `ShipController` that *emits* an `InputState` — keyboard, AI, or (future)
> network. The "player" is just the Ship wearing a `LocalInputController`.
> That decoupling is what makes the two factions interchangeable and the
> game multiplayer-ready.

- **`Faction`** (`Faction.ts`) — `"humans" | "machines"`. `opposing()` flips
  it; `FACTION_THEME` holds per-side laser color + fighter-mesh colors + label.
  Humans = blue/pink (old player), machines = crimson/green (old enemy).
- **`Ship`** (`Ship.ts`) — self-controlled sim (NOT Babylon physics). Owns
  position, velocity, rotationY, HP, cooldowns, missile ammo, muzzle index, and
  a `faction`. `update(dt, input, …)` integrates motion from an `InputState`
  and syncs the visual `root`. `tryFire()` returns world-space muzzle positions
  (0 = on cooldown, 1 = alternate, N = salvo). Movement/weapon tuning is
  **injected** via `ShipOptions.movement` (a `ShipMovementConfig`); every
  entry in the `GameConfig.shipTypes` catalog satisfies that shape, so the
  same sim drives the human pilot and the AI fighters — Game just wires in a
  different catalog entry. Per-type combat knobs (`maxHp`, `laserDamage`,
  `missileAmmo`, `hitRadius`, `fireSound`, `model`) ride along in
  `ShipTypeConfig`; `laserDamage`/`hitRadius` land on the Ship as readonly
  fields (defaulting to `GameConfig.combat` when absent). Implements
  `DamageTarget`.
- **`ShipController`** (`ShipController.ts`) — interface: `update(dt, self,
  world) → InputState`. `ControllerWorld` is a per-faction read-only view
  (opposing ships + opposing mothership + arena bounds + a `leader` ref — the
  human pilot's ship for that faction, used by cover/formation wingmen, else
  null). Implementations must return a **stable** `InputState` (mutate in place —
  no per-frame allocation).
- **`LocalInputController`** — surfaces `InputManager.state` (the keyboard).
- **`AIController`** (`AIController.ts`) — the computer pilot for BOTH sides'
  fighters; **emits an `InputState`** instead of mutating the ship (inputs are
  exactly what a network controller sends). Steering is the one **analog** input:
  the controller sets `InputState.turn` ∈ [-1, 1] (the rest stay boolean
  buttons). Constructed with a standing **order**
  (`AIOrder`) + optional formation slot:
  - `patrol` (default = the original enemy behavior): wander leashed toward the
    objective mothership, engage the nearest opponent in `engagementRange`.
  - `strike`: press the enemy mothership and fire on it (fire range widens to the
    carrier's `hitRadius` so it strafes from stand-off), self-defense fire only.
  - `hunt`: chase the nearest enemy fighter, ignore the carrier; with no prey,
    **loiter on the leader** (station-keep on an escort slot trailing it via the
    shared `stationKeep` servo) instead of charging its position and looping back.
  - `cover` / `formation`: hold a slot on the leader's wing (`cover` also breaks
    to engage threats within `ai.coverBreakRange` of the leader, then reforms).
  Most orders resolve to a steer-heading + thrust + aim target, then a shared tail
  turns that into thrust/reverse/strafe/fire and a **proportional turn command**.
  Decision tuning is shared in `GameConfig.ai`. **Formation is the subtle part** —
  see the next entry.
  - **Steering is proportional, not bang-bang.** The shared tail sets
    `out.turn = clamp(headingDiff / ai.steerBand, -1, 1)` above a thin
    `ai.steerDeadband`: full turn rate beyond `steerBand` of heading error, easing
    linearly to zero as the nose lines up, so the pilot *decelerates into* its
    target heading. This is what makes turns smooth. A purely boolean (full-rate
    on/off) tail can't track a moving heading without a limit cycle — a tight
    deadband shows it as a high-frequency **shake**, a wide one as a low-frequency
    **"clock-hands" stepping** (snap to target, stop, wait for the error to
    rebuild, snap again). Both are the same bug; proportional control removes it.
    `Ship.update` sums `turn` with the keyboard's rotate booleans, so the human
    still turns full-rate (keyboard leaves `turn` at 0) while the AI eases.
- **Player wingmen** (Phase 5) — there is no separate wingman class: a wingman is
  a player-faction `Ship` wearing an `AIController` with a `cover`/`hunt`/etc.
  order, built in `Game.start()` from `GameConfig.player.wingmen`. Two non-obvious
  invariants:
  - **They CLONE the player's loaded ship mesh** (`loaded.modelRoot.instantiate
    Hierarchy(root, { doNotInstantiate: true })`), not a separate mesh, so they
    track whatever the player flies (procedural `shipDesign` or a real
    `fighter.glb`). Clone the *model* root (not the ship root) so the player-only
    damage-flash doesn't tag along; `doNotInstantiate` = real meshes (not GPU
    instances) so a wingman survives the player ship being disabled on death.
    Each wingman is then given its **own** `EngineGlow` + `SecondaryThrusters` on
    its root (the player's are separate instances), driven from the inputs the
    wingman emits each frame — so it lights its exhaust under thrust instead of
    floating silently.
  - **By default they fly the player's EXACT ship type** (`movement:
    GameConfig.shipTypes[player.shipType]`), so an ally is mechanically
    identical to you — same thrust, drag (currently none), top speed, guns,
    HP. `player.wingmen.shipTypes` assigns per-wingman types instead (wraps
    like `orders`); a wingman on a DIFFERENT type than the player's is built
    like an enemy fleet clone (config muzzles, bounds-derived engine glow,
    config-position RCS plumes), and one slower than your ship can't hold a
    slot at your full speed.
    This is deliberate: they can never out-run you, and with the player's zero
    drag a wingman coasts at your velocity once matched and doesn't have to puff
    its engine on an interval just to hold a cruise speed.
  - **Formation follows the leader's PATH, not its nose** — and this holds for the
    SLOT too: the slot is placed relative to the leader's *course* (velocity
    direction), NOT its facing (`leader.rotationY`). That matters because the
    player constantly nudges their nose to hold a line; if the slot rode the
    facing, every nose-twitch would whip the slots sideways and the wing would
    scramble to chase them (the "shake at certain angles while following"). Riding
    the course, a nose-swing with no course change leaves the slots — and the wing
    — completely still. Below `ai.formationHeadingMinSpeed` velocity stops
    defining a course, so the servo **holds the last well-defined course**
    (`lastCourse`) rather than falling back to the leader's facing — a slow
    leader pivoting in place (a hovering Breaker lining up a shot) would
    otherwise sweep the slots around itself faster than a wingman can fly and
    send the wing orbiting through the leader's position. Each frame the wingman then computes the velocity it needs
    (`leaderVel + speed-capped approach to the slot`), points its nose along *that*
    (`steerHeading = atan2(desiredVel)`), and
    flies there like a pilot, trimming cross-track error with strafe. Because it
    steers by where it needs to **go**, a turn the leader makes without changing
    course doesn't drag the wing around — it only banks when the leader's actual
    travel direction shifts. The forward thrusters are gated to a cone around the
    desired-velocity direction (`formationThrustConeAngle`) so it coasts while
    turning to line up rather than thrusting off-course, and each jet runs through
    a **Schmitt trigger** (`formationVelEngageBand` to light / `formationVel
    Deadband` to release) so a stable slot doesn't chatter. Crucially the heading
    is steered by the leader's *velocity* (the path), **not** the desired velocity
    — the slot-approach (a position correction) is left out of the nose so it
    doesn't yaw back and forth chasing small off-slot errors; it's blended into
    the heading only as the wingman gets far from its slot (`formationHeading
    BlendRange`), so it still turns nose-first to fly up to formation. Tuning lives
    in `GameConfig.ai` (`formationPosGain`, `formationApproachSpeed`, `formationVel
    Deadband`, `formationVelEngageBand`, `formationHeadingMinSpeed`,
    `formationHeadingBlendRange`, `formationThrustConeAngle`,
    `formationCourseSmooth`). One more subtlety: the whole formation flies off a
    **low-passed** copy of the leader's velocity (`formationCourseSmooth`), not
    the raw value — a hand-flown leader holding a line at speed thrusts while
    tapping its nose, so the raw velocity (and the course-placed slot) wobbles,
    and wingmen at their speed limit would chase the wobble and weave. The
    low-pass makes them follow the average path instead. This whole servo lives in
  `AIController.stationKeep` and is SHARED: the `hunt` order's no-prey loiter
  calls it too (with an escort slot), so an idle hunter holds a trailing station
  on the leader with the same easing/braking instead of ramming it. It must run
  every frame (the low-pass and Schmitt jets need continuity), which is why
  `hunt` joins `cover`/`formation` in the per-frame set (exempt from the
  reaction-timer cache).
- **`FighterMesh.ts`** — `buildFighterMesh(scene, glow, faction)` is the old
  `EnemyShip.buildMesh`, themed by faction (used for ENEMY AI fighters; the human
  player and its wingmen come from `AssetLoader`). `randomFighterSpawn()` is
  the spawn-away-from-player helper (was `EnemyShip.randomSpawnPosition`).

Game wires each Ship as a target of the **opposing** faction's `LaserSystem`
(+ the player's `MissileSystem`), so collisions are faction-correct and
friendly-fire-free without per-bolt faction checks.

## SensorSystem (per-faction awareness)
- The keystone of the stealth loop: each faction has ONE shared sensor picture
  (`sensors.contacts[faction]`, an array of `SensorContact`), and **every AI
  pilot targets that picture, never ground truth** — `ControllerWorld.opponents`
  is the contact array, held by reference and rebuilt in place each frame.
- A `SensorContact.position` is the **last-known** position: it follows the
  real ship only while the track is `fresh`, then freezes where contact was
  lost. `contact.isAlive` mirrors `DamageTarget.isAlive` (ship alive AND track
  unexpired) so contacts slot into the same nearest-target scans Ships did.
- Detection rule (per sweep, throttled by `sensors.sweepIntervalSec`; fresh
  positions still copy **every frame** so AI aim doesn't lag a sweep): a ship
  is detected if within `shipRange` of any live enemy fighter or
  `mothershipRange` of the enemy carrier (the AWACS). **Concealment**: inside
  a combat-nebula zone a ship is invisible to radar entirely — only the
  unconditional `visualRange` eyeball check finds it — and its own radar is
  degraded by `nebulaSensorFactor` (hiding costs awareness). Lost tracks
  linger `memorySec` as targetable ghosts (AI flies there and searches), then
  expire. Dead ships drop instantly (the explosion is observable).
- Symmetric by construction: the player hides from the machines exactly the
  way machines hide from the player's wing. The player-facing consequences:
  the radar draws the picture, the HUD `sig` cue asks the ENEMY's picture
  about the player, and missile locks are denied on concealed ships beyond
  visual range (`Game.computeLockTarget`).

## FleetCommander (enemy doctrine)
- Runtime re-tasking for the AI fleet — `AIController.setOrder()` is the seam
  (it zeroes the reaction timer and clears the formation servo's jet latches).
  The player's own wing keeps its static configured orders.
- Role split by spawn order, set at construction: the first
  `fleets.*.strikeCount` ships are permanent **strikers** (the first one is
  the fleet's wing leader, wired into `ControllerWorld.leader`), the next
  `commander.escortCount` fly **cover** on that leader (escorted strike
  package), and the rest form the dynamic **pool**.
- Every `commander.thinkIntervalSec` the pool re-tasks by priority: carrier
  threatened (hull dropped since last think, or a contact within
  `defendAlertRadius`) → up to `defendCount` nearest ships `defend` (held for
  `defendHoldThinks` thinks); any live contact → up to `huntCount` ships
  `hunt` (ghost contacts make this a search of the last-known position); rest
  `patrol`.
- **Fair play:** the commander reads only its faction's `ControllerWorld` —
  the same sensor picture its pilots fly on. Break contact and the commander
  is as blind as the fleet.

## Mothership (the objective)
- Implements `DamageTarget`: large `maxHp` + generous single `hitRadius`
  (`GameConfig.mothership`) covering the central hull. Per-part hitboxes are a
  later defenses pass.
- It is registered as a target of the **opposing** faction's lasers/missiles.
  Destroying the enemy's mothership → **victory**; losing yours → **defeat**
  (see `Game.checkObjectives` / `endMatch`).
- `onLaserHit` deliberately gives mothership chips only a light hit cue (no
  trauma/hitstop) — otherwise sustained fire on the stationary 1500-HP target
  would spam hitstop and crawl the whole game.

## Radar
- Player-centered, **north-up** circular minimap on its own canvas
  (bottom-right), redrawn every frame (read-only — it never feeds gameplay).
- **Friendlies draw from ground truth** (your wing shares telemetry);
  **hostiles draw from the player faction's sensor picture**: fresh contacts
  are solid dots, stale tracks are hollow ghost rings fading out over the
  memory window at their last-known position, and ships that broke contact
  simply aren't there. Motherships are always-known diamonds (stationary,
  pre-briefed). Nebula concealment zones render as faint violet discs so the
  player can see where hiding is possible.
- Orientation matches the world camera (which doesn't rotate with the ship):
  world +Z → screen up, +X → right. `project(dx,dz)` maps a world offset from
  the player to a radar pixel and **clamps** beyond `GameConfig.radar.rangeWorld`
  to the rim (clamped contacts drawn dimmer) so you always get a bearing to far
  things — chiefly the enemy mothership objective.
- Player = heading triangle at center; fighters = faction dots; motherships =
  faction diamonds. Blip colors are canvas-friendly (`Radar.BLIP`), NOT the
  emissive `FACTION_THEME` values (those blow out > 1.0).
- Canvas backing store is sized at `devicePixelRatio` and the ctx pre-scaled, so
  draw code works in logical pixels and stays crisp on HiDPI.

## LaserSystem
- One instance **per faction** (`humansLasers` pink, `machinesLasers` green),
  each firing that faction's bolts and targeting every opposing-faction ship +
  the opposing mothership (`addTarget` supports many targets).
- Shared material per system; one `Laser` instance per bolt with its
  own mesh.
- `spawn(origin, rotationY, shooter?, damage?)` creates a bolt with velocity
  along forward. `shooter` is the firing **Ship reference** — per-pilot
  attribution, deliberately NOT a "was it the player" boolean, so it stays
  correct with any number of human pilots (multiplayer-ready). `damage` is
  carried **per bolt** (the firing ship's `shipTypes[*].laserDamage`) because
  one faction system serves mixed ship types — a Breaker's bolts hit harder
  than a Spitfire's; omitted = the system's default (`combat.laserDamage`).
- `update()` advances bolts, runs a **swept** X/Z segment-vs-target collision
  (the bolt's pre-move→post-move path is tested against each circle, not just
  its end position), calls `onHit(target, shooter)` on impact. The struck
  target lets Game scale feedback (heavy flash/hitstop for the player's own
  ship, light cue for a mothership); Game derives `fromPlayer` by comparing
  `shooter === playerShip` at the edge, gating the "you landed a hit" jolt +
  hitstop to the LOCAL pilot's own shots (3 wingmen firing don't spam hitstop
  on the shared system) and crediting kills to the shooter (`recordKill`).
- `Laser.kill()` marks a bolt expired (it'll be swept on the next pass).

## MissileSystem
- Player-only scarce weapon (key **R**), parallel to `LaserSystem` but each
  projectile homes and carries its own exhaust trail. One instance, registers
  every enemy as a target.
- **Ammo + cooldown live on `PlayerShip`**, not the system: `missileAmmo`
  (starts at the ship type's `missileAmmo`, refilled in `respawn()`) and a
  `fireCooldownMs` gate so a held key can't dump the pool in one frame.
  `PlayerShip.tryFireMissile()` returns the nose spawn point or `null`.
- **Lock is computed in `Game.computeLockTarget()`** (once per tick, shared by
  the launch and the HUD): nearest live enemy within `missile.lockRange` AND
  inside the frontal `lockConeAngle` (same idea as the enemy fire cone). The
  HUD shows green `LOCK` only when a lock exists AND ammo > 0.
- `spawn(origin, rotationY, target)` — pass the locked enemy to home, or `null`
  to fire ballistic. **A no-lock missile still flies and still detonates** on
  any enemy it contacts (collision tests all targets, same X/Z **point**-test as
  lasers *used* to use).
- **TODO (known gap):** unlike `LaserSystem`, this still uses a point-at-new-
  position collision test, which can tunnel through a target on a large step.
  Missiles are slow (`missile.speed` 45 u/s) and homing, so the gap is tiny in
  practice — but if missile speed is ever raised, port `LaserSystem`'s swept
  segment-vs-circle test here.
- **Homing** (`Missile.update`): while it has a live target it steers
  `rotationY` toward the bearing to that target, capped at `turnRate`/sec (the
  same `wrapAngle` + `turnStep` math as the enemy AI). If the target dies it
  drops to `null` and coasts straight from there.
- **Damage is rolled per hit** in `[minDamage, maxDamage]`. `onHit(position)`
  carries the impact point (unlike `LaserSystem`'s parameterless `onHit`) so
  `Game` pops an `explosions.spawn(pos)` plus heavier trauma/hitstop than a
  laser.
- **Mesh** is a small composite (root `TransformNode` named `missile`): gray
  cylinder body + tapered nose cone + four red `+`-cross tail fins, oriented
  along local +Z, built in `buildMissileMesh()`. Kept ~0.7 long so it reads as
  a sub-munition next to the ~1.6-unit ship. Body/fins are lit (faint emissive
  so they read in the dark) and are NOT in the GlowLayer — only the exhaust
  blooms. Disposing the root recurses into the children; shared materials
  survive.
- **Trail = a per-missile `TrailMesh`** generated from the root, with its own
  orange emissive (`trailEmissive`, picked up by GlowLayer). Three gotchas:
  (1) it's NOT parented to its generator (gotcha #4), so `Missile.dispose()`
  disposes it explicitly or it lingers after detonation; (2) the root is built
  this frame, so `spawn()` calls `computeWorldMatrix(true)` before constructing
  the trail — otherwise the trail seeds at the world origin and the first frame
  draws a stray streak from (0,0,0) to the spawn point; (3) **`Missile.dispose()`
  must call `trail.stop()` BEFORE `trail.dispose()`** — `TrailMesh` registers a
  per-frame `onBeforeRenderObservable` callback in `start()`/autoStart and has
  no `dispose()` override to remove it (it inherits `Mesh.dispose`). Only
  `stop()` unhooks the observer; skip it and every fired missile leaks a
  permanent per-frame callback, piling up into progressive slowdown.

## ExplosionSystem
- Spawns short-lived explosions: 1 flash sphere + 8 debris cubes.
- Shared materials (one flash mat, one debris mat) reused across every
  active explosion. To fade per-explosion without per-material alpha,
  we scale meshes toward 0 instead of fading alpha.
- All meshes opt into GlowLayer on spawn for bloom.

## SoundSystem
- 4 one-shot pools (player_laser × 4, enemy_laser × 4, hit × 4, explosion × 2).
- Pools use N independent Sound instances (not clones).
- Engine hum: looping `Sound` with volume modulated by `EngineGlow.currentIntensity`.
- `unlock()` is idempotent and self-healing: it retries each frame until
  the audio context's `state === "running"` (some browsers need
  `audioContext.resume()` after Babylon's `unlock()`).
- Two `console.info` lines confirm unlock + engine-hum start in DevTools.

## CameraRig
- Top-down with `(offsetY, -offsetZ)` from player position.
- Position smooths toward `playerPos + velocity * velocityLead`.
- **Zoom**: the `+`/`-` keys drive a live `zoom` factor that multiplies the
  base offset (1.0 = default; clamped to `camera.minZoom..maxZoom`, changed
  at `camera.zoomRate`/sec). `update()` takes a `zoomInput` of -1/0/+1 from
  `Game.tick`. Shake rides on top unscaled, no HUD element.
- **Shake**: trauma 0..1, decays at `decayRate`/sec. Per-frame offset =
  `maxOffset × trauma² × sine-noise`. Position-only shake (target stays
  on `trackedTarget`) gives a slight angular tilt that reads as a
  camera-mount jolt.
- Continues updating during hitstop so the freeze-frame trembles.

## EngineGlow
- Core sphere + TrailMesh parented to an anchor at the ship's tail.
- Materials use emissive components > 1.0 for hot bloom.
- `intensity` (core sphere brightness/scale + audio) smooths toward
  `thrusting ? 1 : speed/maxSpeed * 0.4`, so the core keeps a soft coast glow.
- The **trail** ("thruster line") is gated separately on `trailIntensity`,
  which targets thrust input ONLY (never speed). Its alpha fades with that
  value and the mesh is `setEnabled(false)` once it's ~invisible, so the
  exhaust streak appears only while actively burning and not while coasting.
- Exposed via `currentIntensity` getter so SoundSystem can match the audio.

## DamageFlash
- One sphere parented to the player ship root, normally `setEnabled(false)`.
- `trigger()` enables + starts a 220ms linear-alpha fade from 0.7 to 0.
- Depth writes off so it doesn't occlude opaque geometry behind it.
- Opts into GlowLayer; emissive `(2.5, 0.2, 0.2)` blooms hot red.

## Scenery
- **Backdrop** (deepest, behind everything): the `space-backdrop.jpg`
  deep-space image rendered as a Babylon background `Layer` — a 2D blit,
  NOT a 3D plane. A large emissive plane gets multiplied by emissive +
  amplified by the GlowLayer and washes to white; a Layer is immune to
  lighting/glow and shows the whole image. See gotcha #9 and `Backdrop.ts`.
  **Subtle parallax:** `Backdrop.update(cameraFocus)` (called each frame from
  `Game.tick`, right after `Starfield.update()`) drifts the image a hair
  against the camera so it reads as impossibly distant — the slowest-moving
  layer, behind even the far stars. It pans the TEXTURE's `uOffset/vOffset`,
  NOT `layer.offset` (that moves the on-screen quad and exposes a black edge —
  the shader applies `offset` to `gl_Position`). Two modes via
  `GameConfig.scenery.backdrop.parallaxMode`: `"clamp"` (default, bounded
  arena) zooms the texture in by `parallaxZoom` and clamps the pan to that
  margin with CLAMP addressing — works with any image, costs a slight edge
  crop; `"wrap"` (unbounded arena) lets the offset run free and tiles via WRAP
  addressing — needs a seamless image. Either way the edge never shows.
  `parallaxFactor: 0` disables it entirely.
- **Nebulas** (Y per `GameConfig.scenery.nebulas.yLevel`): alpha-blended
  quads textured from the `nebula-*.png` files. Count, depth, size, and
  opacity are all in GameConfig. The PNGs come through the emissive channel
  as **luminance/detail only** — COLOR is supplied per-nebula via
  `emissiveColor` (the `COLORS` array in `Nebulas.ts`), NOT read from the
  texture (white tint would blow the pale art out). `TEXTURE_FILES`,
  `COLORS`, and `POSITIONS` are priority-ordered; `count` takes the first N.
- **Starfield** (Y -8 and -18): two parallax layers, thin-instanced
  spheres, 2 draw calls. **Camera-locked wrapping field** — NOT scattered
  across the arena. Each layer holds a periodic lattice of stars sized to the
  camera footprint; `Starfield.update()` (called each frame from `Game.tick`
  after the camera updates) re-anchors every star to the lattice image nearest
  the camera, so stars wrap off one screen edge onto the other. Star cost is
  therefore independent of arena size (multiplayer-safe). The active count is
  density × visible-area, capped at `GameConfig.starfield.maxNearCount/maxFarCount`
  via `thinInstanceCount` over a max-sized buffer, so zooming out keeps density
  constant up to a hard ceiling. Needs the camera, so it's constructed after
  `CameraRig`.
- **CombatNebulas** (Y = `scenery.combatNebulas.yLevel`, just ABOVE the
  fighter plane — these are gameplay, not background): painted alpha quads
  using the same nebula PNGs + emissiveColor-tint recipe, rendered over the
  ships so anything flying in is visibly veiled. Each quad's X/Z footprint is
  exported via `zones` as a `ConcealmentZone` consumed by the SensorSystem
  (the actual stealth mechanic) and drawn on the radar. `visualScale` keeps
  the painted cloud roughly covering the hard sensor footprint — tune it
  against `radius` if hiding "looks wrong".
- **CapitalShips** (Y ≈ -26): 3 procedural destroyers built from boxes
  (hull + spine + tower + engine + 6 running lights). Engines and
  lights are emissive and opt into GlowLayer.

## Splash flow (landing / intro / faction select / quick play)
- `main.ts` owns a small state machine; the current state lives in
  `data-state` on `#splash` and ALL visibility is CSS keyed off that
  attribute (no JS show/hide). States: `landing` (ENTER THE MERIDIAN +
  always-visible Skip Intro), `intro` (color fade-up + music + one-iteration
  story crawl; `animationend` on `#splash-story` advances), `factionSelect`
  (the right panel reveals), `quickPlay` (returning players: Continue line +
  PLAY + Change Faction / Replay Intro).
- Returning-player gate: `hasSeenIntro() && hasSavedLoadout()` → `quickPlay`;
  otherwise `landing`. Skip Intro is ALWAYS on the landing screen — never
  assume the game knows whether the player is new.
- `unlockAudio()` in main.ts is the centralized browser audio unlock; every
  splash button routes through it (the click is the required user gesture).
  Splash music goes through a raw Web Audio `AudioContext` (NOT `<audio>`,
  which extensions auto-mute) and is idempotent across repeat clicks.
- The `.begun` class still drives the grayscale→color "interface wakes up"
  fade; `quickPlay` deliberately stays dormant/gray (its PLAY cuts straight
  to the game).
- The story crawl runs ONE iteration (`forwards`), paused except in the
  `intro` state; Replay Intro re-arms it by resetting the inline animation
  (`restartCrawl()`).

## Loadout + LoadoutMenu + ShipPreview (splash side/ship select)
- `Loadout.ts`: the `PlayerLoadout {faction, shipType}` type + localStorage
  persistence under `lastMeridian_faction` / `lastMeridian_ship` /
  `lastMeridian_introSeen` (the old single-JSON `space-duel-loadout` key is
  still read as a fallback and removed on save). Loads are validated against
  `GameConfig.factionShips` (a saved ship that no longer exists falls back to
  the faction's first ship). `hasSavedLoadout()` ("did the player ever pick?")
  is deliberately separate from `loadSavedLoadout()` (which falls back to
  GameConfig defaults) — only a real save unlocks the quick-play screen.
  `Game` takes the loadout as a constructor param and copies it —
  `GameConfig.player.faction/shipType` remain the build-time DEFAULTS only.
- `LoadoutMenu.ts`: plain-DOM progressive reveal injected into `#loadout`:
  faction cards → selected-faction description → ONLY that faction's ship
  cards (thumbnail + role + 2 key bars) → the hangar preview panel (live 3D +
  full stat bars) → PLAY. Fully keyboard-driven (←/→ select, ↑/↓ row; Enter
  is owned by main.ts and shares the PLAY path). Stats read straight from
  `GameConfig.shipTypes`, normalized against catalog maxima. Every selection
  change saves immediately; `commit()` persists + detaches the key handler
  before the Game's own keys come up.
- `ShipPreview.ts`: a SECOND, standalone Babylon engine/scene for the splash
  only — one live rotating GLB ("hangar" turntable) + cached one-frame
  data-URL thumbnails for the ship cards (never a render loop per card).
  Reuses `AssetLoader.loadModelTemplate` so the same `GameConfig.shipModels`
  corrections apply, and the same space-backdrop IBL so the PBR metal hulls
  don't render flat. Created lazily on first `factionSelect`, `stop()`ed when
  leaving the state, `dispose()`d at game launch. Its canvas is ONE shared
  element that LoadoutMenu re-adopts after every innerHTML re-render (engine
  needs `preserveDrawingBuffer` for the thumbnail readback). Tuning lives in
  `GameConfig.shipPreview`.
- Fast entry invariants: the saved loadout is preselected everywhere, quick
  play is a single click/Enter, and the end-of-match restart (`RESTART_FLAG`)
  skips the splash entirely and replays the saved loadout.
