# Roadmap

Snapshot of what's built, what's pending, and what's been considered
and explicitly skipped. Update this when you finish or start work.

---

## ✅ Done

### Core
- Vite + TypeScript + Babylon.js 7.x scaffold
- LHS coordinate system pinned (forward = +Z, up = +Y)
- Single render loop in `Game.tick` with delta-time clamp (1/30 s max)
- `GameConfig` as the single source of truth for tuning
- Rate-based exponential decay helpers in `math.ts` (no per-frame multipliers)

### Player
- `PlayerShip` simulation: thrust, reverse thrust, drag, rotation, speed cap
- Forward direction math (sin/cos rotationY)
- Arena bounds clamping
- HP system + `DamageTarget` interface impl
- Death → mesh disabled → respawn after delay
- Multi-muzzle firing system with ship-local coordinates
- `fireMode: "alternate" | "salvo"` — round-robin vs simultaneous
- Default config: dual wing blasters at (±0.85, 0, 0.1)
- `worldFromLocal()` helper for muzzle position transforms

### Enemy
- `EnemyShip` with same physics base as PlayerShip
- AI: wander (with center bias jitter) when out of range, engage when in range
- Fire test: distance < `fireRange` AND |angle| < `fireConeAngle` AND cooldown ready
- Procedural red mesh (crimson body, dark wings, hot-red engine, red "eye" sphere)
- Random respawn position helper (kept far from player)
- Tuning: slower than the player so the duel is beatable

### Combat
- Two `LaserSystem` instances per faction (player → enemy, enemy → player)
- Per-bolt X/Z sphere collision against a single target
- `Laser.kill()` for hit-induced disposal
- Faction-colored materials with emissive > 1.0 for hot bloom
- `onHit` callback on each system (used to wire SFX + juice)

### Explosions
- `ExplosionSystem` with shared materials (flash + debris)
- Per-explosion: 1 flash sphere (scales up then collapses) + 8 debris cubes
  (random outward velocity, spin, linear shrink to 0)
- 700ms duration; spawned on either ship's death

### Camera
- Top-down with configurable offset (Y, Z)
- Smooth follow with `playerPos + velocity * velocityLead`
- World-aligned (does NOT rotate with the ship)
- Disabled default Babylon camera inputs

### Visuals / FX
- `GlowLayer` for global bloom on emissive surfaces
- `Starfield`: 2 parallax layers of thin-instanced spheres (~1500 stars)
- `Nebulas`: 4 alpha-blended `NoiseProceduralTexture` quads, muted purples
- `CapitalShips`: 3 procedural box-built destroyers in deep background
- `EngineGlow`: core sphere + TrailMesh, thrust-modulated emissive intensity
- Arena wireframe grid (no opaque ground so stars show through)

### Juice
- Trauma-based camera shake in `CameraRig` (decays at 1.8/sec; per-impact trauma values configurable)
- Squared trauma for nice intensity falloff
- Two-sine pseudo-noise per axis
- Position-only shake (introduces slight angular tilt)
- Hitstop system in `Game` with `applyHitstop(ms)` and `maxStackedMs` cap
- During hitstop: simulation pauses; camera shake, damage flash, audio, render continue
- `DamageFlash`: red emissive sphere pulses around player on damage (220ms fade)

### Audio
- `SoundSystem` with 5 CC0 sounds from freesound.org
- `PooledSound` for overlap support (4 instances per short SFX)
- Engine hum loop with thrust-driven volume modulation
- `unlock()` method that retries until WebAudio context is `running`
- DevTools console.info confirmations on unlock + hum start
- **Critical**: Engine constructed with `audioEngine: true`

### HUD
- Plain DOM HUD throttled to 10 Hz
- HP readout with color cue (green/yellow/red/dimmed-on-death)
- Position, velocity, laser count, model label (fallback or fighter.glb)

### Asset pipeline
- `AssetLoader` with GLB import → procedural fallback ship
  (two designs: `"classic"` / `"viper"`, picked by `GameConfig.player.shipDesign`)
- Two-tier root: outer for gameplay rotation, inner for fixed model alignment
- `MODEL_ROTATION_X/Y/Z` + `MODEL_SCALE` consts for tuning
- `@babylonjs/inspector` installed as dev dep for live mesh debugging

### Docs
- `CLAUDE.md` (comprehensive architecture primer for AI agents)
- `README.md` (human-facing setup + features)
- `docs/ROADMAP.md` (this file)
- `docs/AGENT_KICKOFF.md` (prompt template for new agent sessions)
- `public/sounds/SOURCES.md` (CC0 audio attribution)

---

## 🚧 In flight

_Nothing currently in flight._

When you start something multi-step, list it here with a checkbox state
so the next agent (or you, in a future session) doesn't redo work.

---

## 📋 Backlog / candidate features

Things that have come up in conversation as good ideas but haven't been
implemented yet. Roughly ordered by gameplay value.

- **Score + combo multiplier** — kills earn points; quick consecutive
  kills build a multiplier. Persist best score to localStorage.
- **Wave system** — replace single respawning enemy with escalating
  waves (1 enemy → 2 → 3 → 4, capped at 4). Wave counter in HUD.
- **Invulnerability frames on respawn** — 1.5s with ship flicker so
  the respawn moment isn't a free kill.
- **Tighter player feel pass** — bump thrust, reduce rotation latency,
  sharpen laser fire response.
- **Heat-seeking missiles** — second weapon system. Limited turn rate,
  longer cooldown, more damage. Launcher positions mirror the muzzle
  config pattern.
- **Multiple enemy types** — strafer, charger, dropper. Different AI
  states + meshes; share the `DamageTarget` interface.
- **Power-ups** — drop from killed enemies. Temporary muzzle config swaps
  (spread shot, rapid fire), shield charges.
- **Enemy multi-gun** — give EnemyShip the same `muzzles`/`fireMode`
  system as PlayerShip.
- **Positional 3D audio** — Babylon `spatialSound = true` on explosion
  and hit sounds, with the camera as the listener.
- **Mute toggle (M key)** — master volume control persisted to localStorage.
- **Visible audio status indicator** — small HUD line showing
  `AUDIO: LOCKED | ON` so users can tell whether unlock fired.
- **Differentiated hit sounds** — one for "you hit them", one for
  "they hit you".
- **Capital ship drift** — subtle parallax movement on the background
  destroyers so they don't feel painted-on.
- **Animated nebula breathing** — set `NoiseProceduralTexture.animationSpeedFactor`
  to a small non-zero value.
- **Particle explosion** — replace the cube-debris explosion with a
  Babylon ParticleSystem for more density.

---

## 🚫 Out of scope

These were considered and deliberately rejected. Don't implement them
without an explicit user request — they add complexity without arcade-feel
benefit.

- **React or any UI framework**. HUD is plain DOM. The game doesn't have
  a complex UI layer.
- **Multiplayer / networking**. Single-player arcade duel.
- **Physics engine** (cannon, ammo, havok). Motion is hand-rolled in
  PlayerShip/EnemyShip and that's a feature, not a bug — keeps the
  control feel tunable.
- **ECS framework** (bitecs, etc.). The entity count is too small to
  benefit; the explicit class-per-entity pattern is easier to read.
- **Mobile / touch controls**. Game is keyboard-only.
- **Gamepad input** (could be added later, not core).
- **Complex menu system** (main menu, options screen, pause). Game
  starts directly into play.
- **Asset preloading splash screen**. Sounds load lazily; the procedural
  fallback ship is available instantly.
- **Authoritative server / cheat-resistant logic**. There's no server
  and no plans for one.

---

## 📐 Architecture decisions worth noting

- **Two LaserSystems instead of one with owner tags.** Simpler ownership,
  no friendly-fire bugs, faction-specific config (color, damage curve in
  the future).
- **Game-state-driven physics (not Babylon physics).** Keeps the feel
  tunable and the math obvious. Trade-off: no rigid-body interactions,
  but the game doesn't need them.
- **Hitstop pauses sim but not camera/audio.** The asymmetry is what
  makes hitstop feel impactful instead of laggy.
- **Per-instance Sound pools, not clones.** Avoids Babylon `Sound.clone()`
  edge cases (returns null in some setups). Costs ~1 KB of audio buffer
  reuse per pool — negligible.
- **Procedural fallback ship as the default.** No asset pipeline means
  zero orientation problems and zero file-format questions.
