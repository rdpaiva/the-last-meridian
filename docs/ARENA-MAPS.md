# Arena / Map System — Design Notes

> **Status:** design spec, not yet built. The highest-leverage anti-staleness
> move: every match currently plays out on the *same* battlefield (same scenery
> counts, same carrier positions, same fleet facing the same way). This system
> makes the *setup* vary per match by recombining what the engine already does.
>
> Read `CLAUDE.md` first. Key constraints this spec respects:
> `GameConfig` is read-only at runtime except ONE sanctioned startup writer
> (`ConfigOverrides`); the splash is a deliberately small staged flow; the sim/
> view split (Phase 0) must stay intact so the headless harness still runs.

---

## The core idea (why)

The game has rich *mechanics* (jump drive, resupply, nebula stealth,
destructible asteroids) but a *fixed scene*. Each match builds the same arena:
50 rocks, three nebula clouds at fixed fractional positions, two carriers at
`mothership.playerZ`/`enemyZ`, the same fleet compositions. The mechanics are
deep; the battlefield is static. That static setup is what reads as stale after
repeated play.

A **Map** is a named bundle of *battlefield setup* — scenery density, hazard
placement, carrier spacing, and fleet composition — selected at match start
(like the ship loadout). It changes nothing about *how* the game plays frame to
frame; it changes the board the game is played on. Maps compose with the
existing loadout (side + ship) and with the match-settings overrides.

Design goals:

- **Reuse, don't rebuild.** A map mostly *re-parameterizes* `CombatNebulas`,
  `AsteroidField`, carrier positions, and `fleets` — all things the engine
  already builds from `GameConfig`. v1 ships zero net-new entity types.
- **Authored, memorable, testable.** A small set of hand-tuned named presets
  (plus an optional "Random" that picks one), not pure per-match randomization.
  Named maps are reproducible for tuning and become identity ("the Belt").
- **One seam for future hazards.** New static obstacles (derelict hulk, mines,
  damage fields) plug into the SAME `obstacles[]` / `aiObstacles` list the
  asteroids already use, so the map is the *frame* that future content drops
  into.

---

## What a Map controls (the `MapConfig` shape)

A map is a plain data object, parallel to `PlayerLoadout`. Proposed shape
(`src/game/Maps.ts`):

```ts
export type MapId = "openVoid" | "asteroidBelt" | "nebulaVeil" | "theWreck" | "random";

export interface MapConfig {
  id: Exclude<MapId, "random">;
  name: string;            // "The Belt"        — splash card title
  blurb: string;           // one line for the card / loading flavor

  /** Carrier spacing along Z. Overrides mothership.playerZ / enemyZ.
   *  Closer = brawl; farther = long approach where jump drive matters. */
  carrierZ: { player: number; enemy: number };

  /** Asteroid field params for THIS map. A subset of GameConfig.asteroids —
   *  count 0 disables the field entirely (Open Void). */
  asteroids: {
    count: number;
    radiusMin?: number;
    radiusMax?: number;
    // (driftSpeed*, etc. default to GameConfig.asteroids if omitted)
  };

  /** Combat (stealth) nebula footprints, fractional like the config default.
   *  Empty array = no stealth clouds. */
  nebulaZones: ReadonlyArray<{ xFrac: number; zFrac: number; radius: number }>;

  /** Per-faction fleet composition override (else GameConfig.fleets default). */
  fleets?: Partial<Record<Faction, {
    fleet: ReadonlyArray<{ type: ShipTypeId; count: number }>;
    strikeCount: number;
  }>>;

  /** Net-new static obstacles/hazards. v1: empty everywhere. The frame for
   *  the derelict hulk / minefield / damage-field follow-ons (see below). */
  hazards?: ReadonlyArray<HazardSpec>;
}
```

`HazardSpec` is a discriminated union added when the first hazard type lands
(`{ kind: "hulk", x, z, rotationY }`, `{ kind: "damageField", x, z, radius,
dps }`, …). v1 leaves `hazards` undefined everywhere — the field exists so the
map system doesn't need reshaping when content arrives.

### v1 preset table

| `id` | Name | Asteroids | Nebulas | Carrier Z | Fleet flavor |
|---|---|---|---|---|---|
| `openVoid` | The Void | 0 | 0 | wide | stock — pure dogfight, jump matters most |
| `asteroidBelt` | The Belt | ~90, smaller | 1 small | tight | stock — knife-fight, cover everywhere |
| `nebulaVeil` | The Veil | ~25 | 4–5 large | mid | swarm-heavy (more light fighters) — ambush |
| `theWreck` | The Wreck | ~40 | 1 | mid | stock + 1 hulk hazard (Phase 2) |

`random` is a meta-id resolved to one concrete preset at launch (not stored as
the saved map — we persist the *resolved* choice so quick-play is stable, or
persist `random` so it re-rolls; see Open Questions).

---

## How a map is applied (the key architectural decision)

The scenery builders already read their parameters from `GameConfig`:

- `AsteroidField` reads `GameConfig.asteroids.*`.
- `CombatNebulas` reads `GameConfig.scenery.combatNebulas`, and crucially the
  **sim-side** `computeConcealmentZones()` (in `sim/CombatNebulaZones.ts`)
  reads `GameConfig.scenery.combatNebulas.zones` directly — it's called by BOTH
  `Game` and the headless smoke harness, so the zone math lives in one place.
- Carrier positions come from `GameConfig.mothership.playerZ/enemyZ`.
- Fleets come from `GameConfig.fleets`.

There are two ways to make these vary per map:

**Option A — thread map values as constructor args.** Change
`AsteroidField`, `CombatNebulas`, and `computeConcealmentZones` to take their
params instead of reading `GameConfig`. Rejected: it touches a sim-side
function the headless harness depends on, fans out signature changes across
several systems, and splits "where does scenery config come from" into two
places (config for some fields, args for others).

**Option B (recommended) — apply the map into `GameConfig` at startup,
before any system constructs.** This is exactly the seam `ConfigOverrides`
already uses ("ONE sanctioned writer... mutates GameConfig at STARTUP, before
any system constructs"). A map is the same class of write — a startup-time,
pre-construction mutation — not a mid-match one. Every existing
read-from-`GameConfig` site (including the sim-side zone math and the headless
harness) then picks up the map with **zero signature changes**.

This spec recommends **Option B**, with one explicit ask: it adds a *second*
startup writer alongside `ConfigOverrides`. CLAUDE.md currently says "don't add
others," so this needs sign-off — but it's deliberately the same *kind* of
writer (startup-only, pre-construction), and the cleanest way to keep the sim/
view split honest. Sequencing matters:

```
main.ts startup, before `new Game(...)`:
  1. applyMap(resolvedMapId)        // map sets the battlefield baseline
  2. applyStoredOverrides()         // user's manual match-settings win on top
```

Maps write the *baseline*; the player's hand-tuned overrides apply *after* so a
deliberately-dialed knob always beats a map default. (If a future map needs to
hard-lock a knob against override, that's a per-field flag — out of scope here.)

### What `applyMap` writes

`applyMap(id)` looks up the `MapConfig` and writes its fields into the matching
`GameConfig` sections (the same controlled mutation `ConfigOverrides` performs):

- `mothership.playerZ` / `mothership.enemyZ` ← `carrierZ`
- `asteroids.count` (+ optional `radiusMin/Max`) ← `asteroids`
- `scenery.combatNebulas.zones` ← `nebulaZones`  *(whole-array replace; this
  is why a map can't be expressed purely as a `ConfigOverrides` dot-path map —
  those are schema-clamped scalars, see below)*
- `fleets[faction]` ← `fleets` (when present)

Because `nebulaZones` and `fleets` are *arrays/structures*, not scalar
dot-paths, a map cannot reuse the `ConfigOverrides` mechanism verbatim (that's a
sparse `{dot-path: scalar}` map validated against the ~70-knob `TuningSchema`).
`applyMap` is therefore its own small writer over the structured sections; it
shares only the *timing and discipline* of `ConfigOverrides`, not its code.

---

## Splash integration

A map picker is the **same UI class** as the existing faction/ship cards (a row
of selectable cards), so it fits the deliberate splash ceiling — it is not a
general settings/options screen. Add it to the `factionSelect` flow as a third
step after ship select, or as a compact card row on the same screen.

Recommended minimal flow change (`main.ts` + `LoadoutMenu.ts`):

- After the ship is chosen, show a **MAP** card row (4 cards: the 3 v1 maps +
  Random). Each card shows `name` + `blurb`. Keyboard-walkable like the rest.
- `PLAY` commits faction + ship + **map** together.
- The hangar `ShipPreview` is untouched — maps don't get a 3D preview in v1 (a
  small icon/thumbnail per card is enough; reuse the card-thumbnail pattern
  from `LoadoutMenu`/`ShipPreview` if we want art later).

`LoadoutMenu.commit()` currently returns the `PlayerLoadout`; extend it to
return the chosen `MapId` too (or fold the map into the loadout — see
persistence). The `startGame()` path in `main.ts` then resolves `random` → a
concrete id, calls `applyMap(id)` *before* `applyStoredOverrides()` already runs
at module load... → see sequencing note below.

> **Sequencing wrinkle:** `applyStoredOverrides()` currently runs once at
> `main.ts` module load (line 65), long before the map is chosen. To keep
> "map first, user overrides second," move the override application to launch
> time (inside `startGame()`, after `applyMap`), OR have `applyMap` write only
> sections the override schema doesn't cover (carrier Z, nebula zones, fleets,
> asteroid count are NOT in `TuningSchema` today, so in practice they don't
> collide and order is moot for v1). Confirm no `TuningSchema` knob overlaps a
> map-written field before relying on the no-collision shortcut.

---

## Persistence

Follow the `Loadout.ts` pattern exactly — a new `lastMeridian_map` key,
validated against the known `MapId`s, defaulting to a sensible map
(`openVoid`, i.e. closest to today's behavior, or `asteroidBelt` for cover).

Two reasonable choices for *what* to store, decided by feel:

- **Store the resolved map** (recommended): quick-play and the end-of-match
  `Enter`-restart replay the *same* battlefield, matching how saved faction/
  ship work. "Random" re-rolls only when the player revisits the picker.
- **Store `random`**: quick-play re-rolls every launch for built-in variety.

Add to `Loadout.ts`:

```ts
const MAP_KEY = "lastMeridian_map";
// validate(): clamp unknown/missing → default map id
// loadSavedLoadout(): include map; saveLoadout(): persist it
```

Either fold `map` into `PlayerLoadout` (one object, one save) or keep a parallel
`loadSavedMap()`/`saveMap()`. Folding into `PlayerLoadout` is simpler and keeps
the single `commit()` → `new Game(...)` handoff intact.

The `RESTART_FLAG` path in `Game.ts` / `main.ts` (line 229–237) reloads the
saved loadout directly with no splash — it'll pick up the saved map for free as
long as `applyMap(savedMap)` runs on that path too.

---

## Game construction changes

`Game`'s constructor already builds `CombatNebulas`, `AsteroidField`, the two
`Mothership`s, and (in `start()`) the fleets — all from `GameConfig`. With
Option B, **none of those call sites change**: they read the map-mutated config.

The only `Game` change v1 needs is **consuming the `hazards` list** once it's
non-empty (Phase 2). Hazards spawn as static entities and, if they're cover,
get pushed into the same obstacle list the AI avoidance + weapon LOS already
read. The integration points already exist:

- `this.asteroids.obstacles` is held by reference by both `LaserSystem`s and
  both `MissileSystem`s for LOS cover, and `rebuildAiObstacles()` merges live
  rocks + carrier hull sections into `aiObstacles` each frame. A static hazard
  that implements the obstacle shape slots into either list with no new wiring.
- Damage-field hazards reuse the `ConcealmentZone`-style footprint math
  (circle test against ship positions) but flip the effect from "conceal" to
  "apply DPS" — a per-frame pass in `advanceSim`, modeled on
  `resolveAsteroidCollisions`.

`Game`'s constructor signature gains the map only if we *don't* take Option B
(i.e. if we thread values). Under Option B the map is consumed entirely by
`applyMap` at startup, so `new Game(canvas, hud, loadout)` is unchanged.

---

## Sim / view split compliance (must stay intact)

- `applyMap` runs at startup, before construction — identical timing to
  `ConfigOverrides`, which the Phase 0 split already tolerates.
- The headless smoke harness must call `applyMap(id)` too (with a fixed map id)
  so its deterministic run matches a client running that map. Because the
  sim-side `computeConcealmentZones` and `AsteroidField` read `GameConfig`, this
  is just "the harness picks a map" — no sim code learns about maps directly.
- Asteroid layout/drift already draws from the seeded `simRandom()` (SimRng), so
  a given map + seed is reproducible. Map *selection* itself is not part of the
  seeded sim — it's a pre-sim config choice, like the loadout.

---

## Build order (each slice independently shippable)

1. **`Maps.ts` + `applyMap` + one non-default preset.** Define `MapConfig`, the
   v1 presets, and the startup writer. Hardcode the active map in `main.ts`
   (no UI yet) and verify The Belt vs The Void visibly differ and the headless
   harness still passes with a chosen map. *This is the whole engine slice.*
2. **Persistence.** Extend `Loadout.ts` with the map key + validation; wire the
   `RESTART_FLAG` path. Still no picker — default/last map only.
3. **Splash picker.** Add the MAP card row to the loadout flow; `commit()`
   returns the map; `startGame()` resolves `random` and calls `applyMap`.
4. **Polish.** Card art/thumbnails, loading-flavor blurb, "Random" feel tuning.
5. **Hazards.** Net-new placed entities riding the frame. Done in sub-slices:
   - **5a — derelict hulk (DONE).** `HulkHazard` in `GameConfig`; `sim/Hulk.ts`
     (indestructible: `isAlive` always true, `takeDamage` no-op) reuses the
     carrier hull footprint, so its sections are `MothershipSection`s wired as
     *neutral* targets of BOTH factions' weapons (LOS cover, no damage/score)
     and its circles into AI avoidance; ships keep-out via the shared
     `bumpShipOutOfSection`. `MothershipSection.owner` widened to a structural
     `SectionOwner` so a hulk can own sections. View = a dark dead-block per
     section (`view/HulkView.ts`); "The Wreck" preset places one mid-arena.
     Mirrored in the headless harness (inert under stock = baseline unchanged).
   - **5b — destroyed mesh (TODO).** Swap the placeholder blocks for the actual
     carrier GLB rendered with a burned-out "destroyed" material (exposed
     pipes/wires, ember emissive hotspots), mirroring `MothershipView.applyModel`
     but unlit/no-glow; keep the sim footprint.
   - **Later kinds:** damage field, minefield. The map system needs no reshaping.

Slices 1–4 are the map system proper. Slice 5 is *content* that rides the frame.

---

## Considered but not adopted (or deferred)

- **Pure per-match randomization (no named maps).** Easy and adds variety, but
  not reproducible for tuning and gives no identity. Deferred to the `random`
  meta-id, which picks among *authored* presets — variety without losing
  testability.
- **Expressing maps as `ConfigOverrides` blobs.** Tempting (reuse the exact
  existing writer + JSON share format), but overrides are schema-clamped scalar
  dot-paths; nebula-zone arrays and fleet composition aren't expressible. Maps
  need a structured writer. They still *compose* with overrides at startup.
- **Threading map values as constructor args (Option A).** Rejected for
  invasiveness and for splitting scenery-config provenance; see above.
- **3D map preview on the splash.** The hangar `ShipPreview` is per-ship; a
  per-map 3D preview is a lot of engine for little payoff in v1. Card +
  thumbnail only.
- **Per-map music / lighting / backdrop themes.** Real freshness lever, but
  scope creep for v1. The `MapConfig` can grow a `theme` field later
  (clearColor, backdrop image, music playlist) without reshaping anything.

---

## Open questions

- **Store resolved map vs. `random`?** Decides whether quick-play re-rolls.
  Recommend storing the resolved map (matches saved-loadout feel); revisit if
  players want built-in variety from quick-play.
- **Map picker placement:** third step after ship select, or a compact card row
  on the same `factionSelect` screen? Same-screen is fewer clicks; a third step
  is cleaner if map art grows.
- **Carrier-Z range vs. the leash/corridor:** the AI `leashRadius`/`leashBias`
  and spawn scatter are tuned around the ~±700 corridor. Wide-spacing maps
  (The Void) may need a matching leash bump — verify the AI still commits to the
  approach instead of loitering at the far carrier. Possibly a per-map
  `ai.leashRadius` override.
- **Does `applyMap` need to run on the `RESTART_FLAG` path explicitly,** or can
  it share a single "resolve loadout + map + apply" helper used by all three
  launch paths (quick-play, picker, restart)? A shared helper is cleaner —
  factor it when slice 2 lands.
