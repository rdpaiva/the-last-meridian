# Space Duel

A browser-based top-down arcade space combat game. You launch from a
carrier and pilot a fighter — backed by a wing of AI escorts — against an
enemy fighter group, racing to destroy their mothership before they
destroy yours, amid glowing laser fire, engine trails, and distant
capital-ship silhouettes.

Built with **Vite + TypeScript + Babylon.js**.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts:

```bash
npm run build        # type-check + Vite production build into dist/
npm run preview      # serve the production build locally
npm run typecheck    # tsc --noEmit
```

Node 20.19+ or Node 22 LTS is recommended.

---

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Thrust forward |
| `S` / `↓` | Reverse thrust |
| `A` / `←` | Rotate left |
| `D` / `→` | Rotate right |
| `Q` | Strafe left |
| `E` | Strafe right |
| `Space` | Fire lasers |
| `R` | Launch heat-seeking missile (limited ammo; homes when locked) |
| `+` / `-` | Zoom camera in / out |

The first keypress also unlocks the WebAudio context (browsers block
audio until a user gesture).

---

## Features

- **Player ship** with thrust, reverse, drag, rotation, and dual wing-mounted
  blasters (alternate or salvo firing modes, configurable).
- **Procedural fallback ship** — no asset pipeline required, in two
  selectable low-poly designs (`GameConfig.player.shipDesign`): a sleek
  `"classic"` dart with a blue cockpit, or a Colonial-Viper-style
  `"viper"` (default) with a long nose, triple engines, and red stripes.
  You can still drop a `fighter.glb` into `public/models/` for a custom model.
- **Enemy AI** with wander → engage → fire-cone behavior, including a
  configurable number of **strikers** (`enemy.strikeCount`) that press your
  mothership instead of only dogfighting.
- **AI wingmen** on your side (`GameConfig.player.wingmen`) — fighters that look
  like your ship (cloned from it) and fly it the same way, with standing orders
  (escort/cover, hold formation, hunt enemy fighters, strike the enemy carrier).
  They hold formation on your wing and bank into your turns a beat behind you.
- **HP system** with respawn after death.
- **Faction-colored lasers** (pink = player, green = enemy) with bloom and
  per-faction collision targeting (no friendly fire).
- **Heat-seeking missiles** — limited-ammo secondary (`R`) that homes onto a
  locked target and flies ballistic without one. HUD shows ammo + a `LOCK`
  indicator; gray-and-red missile with an orange exhaust trail.
- **Incoming-missile warning** — an RWR for your fighter: while an enemy
  missile is tracking you, a warning beep accelerates as it closes, the
  viewport edge pulses red in the same rhythm (plus an `INCOMING` readout),
  and the radar marks the inbound rounds in amber — so out-turning a missile
  or dragging it into an asteroid is a timed move instead of luck.
- **Arcade juice**: trauma-based camera shake, hitstop on every impact,
  damage flash on the player ship.
- **Sound**: 5 CC0 effects (laser fire × 2, hit, explosion, engine hum)
  with thrust-modulated engine volume.
- **Scenery**: starfield (2 parallax layers, a camera-locked wrapping field
  whose star count is independent of arena size), purple nebula clouds, 3
  background capital-ship silhouettes.
- **GlowLayer bloom** on every emissive surface.

---

## Project structure

```
public/
  models/       drop fighter.glb here if you want a custom ship
  sounds/       5 CC0 MP3s + SOURCES.md attribution
src/
  main.ts       entry
  style.css     full-viewport layout + HUD CSS
  game/         all gameplay code, one class per file
CLAUDE.md       primer for AI coding agents (read this first)
docs/
  ROADMAP.md    done / in flight / out-of-scope features
  AGENT_KICKOFF.md  template prompt for handing off to a new AI agent
```

For a deep architectural tour, see **`CLAUDE.md`**.

---

## Tuning

Every gameplay value lives in `src/game/GameConfig.ts`. Want a tighter
duel? A more vicious enemy? More dramatic explosions? Edit constants
there — no other file needs to change for routine tuning.

Frequent knobs:

- `player.thrust`, `player.maxSpeed`, `player.fireCooldownMs`
- `ai.engagementRange`, `ai.fireConeAngle` (shared by enemy fighters + wingmen)
- `player.wingmen.count` / `.orders`, `enemy.strikeCount`
- `combat.playerMaxHp`, `combat.enemyMaxHp`, `combat.laserDamage`
- `shake.traumaXxx` (more juice ↑, calmer ↓)
- `hitstop.xxxMs` (longer = heavier impact feel)

---

## Asset credits

Sound effects are CC0 from [freesound.org](https://freesound.org) —
attribution is not required under CC0 but is documented in
`public/sounds/SOURCES.md` as a courtesy to the authors:

- `player_laser.mp3` — hotpin7
- `enemy_laser.mp3` — xkeril
- `hit.mp3` — SeanSecret
- `explosion.mp3` — OwlStorm
- `engine_hum.mp3` — cabled_mess

No model asset is shipped; the procedural fallback ship is used by
default. Drop your own GLB into `public/models/fighter.glb` to use one.

---

## License

This project doesn't ship a `LICENSE` file yet. Pick one before
publishing:

- **MIT** (permissive, most common for prototypes)
- **Apache-2.0** (permissive with explicit patent grant)
- **GPL-3.0** (copyleft — derivatives must also be GPL)
- **Proprietary** / no license (others can't legally reuse)

The CC0 sound assets in `public/sounds/` are independently licensed and
can be reused under any project license.

---

## Contributing

If you're using AI tools (Claude Code, Cursor, etc.) to work on this:
they'll automatically read **`CLAUDE.md`** for context. For new sessions,
the **`docs/AGENT_KICKOFF.md`** template gets a fresh agent productive
quickly.

For human contributors, the same `CLAUDE.md` plus the inline comments
in each `src/game/*.ts` file cover the architecture in depth.
