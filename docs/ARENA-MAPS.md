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

  /** Ion-storm footprints (GameConfig.storms.zones — same fractional shape).
   *  Storms zap loitering ships, conceal like nebulas, and the AI steers
   *  around them, so banks of these carve navigation lanes. Omitted = none. */
  stormZones?: ReadonlyArray<{ xFrac: number; zFrac: number; radius: number }>;

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
| `theTempest` | The Tempest | ~20 | 1 (center lane) | wide | stock + 6 ion storms — a midline storm wall with lanes (2026-07-08) |

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
     is indestructible (`takeDamage` no-op) and slowly rotates on all three axes
     (`rotationRate` yaw / `pitchRate` / `rollRate`). Collision is a stack of
     ORIENTED HULL BOXES (`sim/HulkSection.ts`). They come from
     `GameConfig.mothership.colliders` (per faction) — a list of off-centre OBBs
     `{cx,cy,cz,hx,hy,hz}`, the SAME boxes the LIVE carrier collides with (the
     wreck is the carrier geometry reskinned, so one fit serves both). Authored
     visually from the carrier mesh parts (one box per structural element — hull,
     pods, necks, keel, decks, bridge, stern) via `scripts/hulk_colliders.py` in
     Blender. An empty list falls back to one box per `mothership.hullRects` rect
     (centred/full-beam — looser but always present). `hullColliderBoxes(source)`
     is the shared source of truth for the live carrier (Mothership), the wreck
     sim, and the debug overlay. Each tick `recompute` rebuilds the world basis
     (ex/ey/ez from yaw·pitch·roll, matching HulkView's mesh root) and refreshes
     the boxes, so the collider tracks the full orientation; because play is on
     the y=0 plane, each box's `surfaceRadiusToward` THINS as the hull rolls
     edge-on (the sideways ray exits the thin vertical face — `hulk.hullHalfHeight`
     sets that thickness), matching the visible silhouette. The sections feed
     three consumers: the combined `weaponObstacles` list (LOS cover via the
     existing `surfaceRadiusToward` obstacle path — no weapon-system changes),
     the oriented keep-out bump (`resolveHulkCollisions` — nearest-face eject +
     cooldowned scrape damage, `hulk.collisionDamage`/`bumpCooldownSec`), and AI
     avoidance (coarse bounding circle per box). View = the wreck GLB under a
     yaw/pitch/roll root (`view/HulkView.ts`). Mirrored in the headless harness
     (inert under stock = baseline byte-identical, verified).
   - **5b — destroyed mesh (DONE — GLBs built 2026-06-18).** The two wreck GLBs
     ship in `public/models/` (`aegis_wreck.glb` ~0.35 MB / `choirship_wreck.glb`
     ~0.26 MB). They REUSE THE CARRIER GEOMETRY (not a flat card — a flat card
     read as a 2-D decal on the ~38°-tilted camera, with no depth). Built by
     `scripts/build_wreck.py` following the deck-skin recipe (docs/RECIPES.md →
     "Apply a top-down deck skin to a carrier", scripts/skin_carrier.py): swap the
     carrier's skin image → the `*-destroyed-top.jpeg` render, reproject the skin
     UVs to its ship-rect (which matches the intact livery's framing to ~2 px), and
     BURN the materials — darken the hull, kill EVERY emitter (run-lights, bay
     glow, viewports, spine/cheek cells, engines) so it's a dead husk lit only by
     the scene (a tiny 0.18 self-emission keeps it off pure black; the real
     geometry's relief is what reads as 3-D). Re-run the script (it + the textures
     are the source of truth; no wreck `.blend`) if the renders change — the
     Bastion hull builds in the open `bastion_carrier.blend`, the Choirship is
     appended from `art/choirship.blend` then removed. Same +Y-up export as the
     carriers, so `GameConfig.hulk.model` rotY=π + scale 10.6 lands it on the
     collision circles unchanged, and Babylon preserves the UV orientation (deck
     text reads forward — do NOT pre-mirror). The `-underneath` renders ARE used:
     `skin_carrier.skin_bottom_faces` projects them onto the belly (NO flip — they
     are see-through belly diagrams framed bow-up like the deck, so belly maps the
     same as top; an early flip_v put the nose at the tail) so the underside reads
     when the wreck tumbles. Rotation: three view-only
     spin axes on `HulkHazard` (all advance `Hulk.rotationX/Y/Z` — collision stays
     the flat XZ footprint regardless): `rotationRate` = yaw (flat compass spin,
     deck stays up), `pitchRate` = beam-axis somersault (nose dives), `rollRate` =
     keel-axis BARREL ROLL (deck turns to belly, nose holds heading). The Wreck
     preset lays it nose-SIDEWAYS (`rotationY: π/2`) to wall the corridor and uses
     `rollRate` so it rolls top→belly while lying across the lane.
   - **5b — destroyed mesh (DONE, pipeline).** `HulkView.applyModel` loads the
     battle-damaged carrier GLB (per `source` faction, from `GameConfig.hulk.model`)
     under the spinning root, keeping the burned-out materials and bloom-ing only
     ember/breach meshes (name-tagged via `GameConfig.hulk.emberTags`); falls back
     to the placeholder blocks if the file is missing/fails. Game awaits it in
     `start()` alongside the carrier swaps. Drop `aegis_wreck.glb` (humans) /
     `choirship_wreck.glb` (machines) in `public/models/`; tune orientation/scale
     in `GameConfig.hulk.model` if a re-export lands differently.
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

---

## Session handoff — hull collider unification (updated 2026-06-18)

**Status:** slice 5 functionally COMPLETE on `feat/phase0-smoke-harness` (NOT yet
merged to `main`). Done: both wreck GLBs, the yaw/pitch/**roll** spin, and the
collider rework — circles → **oriented hull boxes** (`sim/HulkSection.ts`).

**UNIFIED on OBB boxes (this session).** The live carrier and its wreck now share
ONE collider list, `GameConfig.mothership.colliders[faction]` (the wreck is the
carrier geometry reskinned). `hullColliderBoxes(source)` is the single source of
truth feeding the live carrier (`MothershipSection`, X/Z footprint only — flat
plane), the wreck sim (`HulkSection`, full OBB — it rolls), and the green debug
overlay (`window.__showHulkColliders(true)`). An empty list falls back to the
`hullRects`-derived boxes. The old `hulk.colliders` field and the k-means
auto-baker are RETIRED in favour of the per-part visual fit below.

**HUMANS (Bastion) — DONE.** 18 structural boxes (hull, both pods + pod
keels/ridges, neck wings, keel, dorsal spine, low/upper decks, stern, engine
mount, bridge base/mid/cap) read directly from `bastion_carrier.blend` parts.
Cosmetic detail (windows, lights, masts, turret barrels, engine disks) excluded;
launch bays are pod recesses already covered by the pod boxes. The live humans
carrier collision changed, so the smoke baseline was RE-CAPTURED (`npm run
baseline`) — intended, not a regression. Typecheck + smoke green.

**MACHINES (Choirship) — DONE.** 31 structural boxes (hull, keel, dorsal spine,
stern main/deck/cap + corners + engine block, aft module, both sponsons + steps,
both nacelles + noses, bridge base + cheeks + head base/cap, prow body/plate/tip)
read directly from `choirship.blend` parts. Cosmetic detail (spine/cheek cells,
lamps, run lights, viewports, engine disks, thin trim) excluded; the side
launch-bay housings are each merged from floor/roof/walls/back into one solid box.
The live machines carrier collision changed, so the smoke baseline was RE-CAPTURED
again — intended. Typecheck + smoke green.

**Both factions now fitted → ready to merge `feat/phase0-smoke-harness` → `main`.**
To RE-AUTHOR either later: open the carrier `.blend` (clean — bow +Y, NOT a
re-imported GLB), I run `hc.spawn(hc.HUMANS|hc.MACHINES)` (or regenerate per-part
from the mesh) → you grab (`G`)/scale (`S`) boxes to taste, KEEP AXIS-ALIGNED →
`hc.read()` → paste into `mothership.colliders[faction]`. NEVER save the `.blend`;
the colliders are throwaway viewport objects.

**Visibility tip (Blender):** `WIRE`-display objects ignore the material colour —
set Solid shading + `space.shading.wireframe_color_type='OBJECT'` and each box's
`o.color` green, else the boxes draw dark and look "missing." (The in-band MCP
screenshot tool errors on this box; render the VIEWPORT via
`bpy.ops.render.opengl(write_still=True, view_context=True)` to a file and read
that instead — a camera render won't show wireframes.)

**Frames / knobs:**
- Collider OBBs are in the carrier-world (`hullRects`) frame; runtime applies the
  hulk's own `scale`. Blender↔game = ×10.6 with gameZ=BlenderY (keel), gameY=
  BlenderZ (up), gameX=BlenderX (beam) — handled by `hulk_colliders.py`.
- `HulkSection` boxes are AXIS-ALIGNED to the hull (no per-box yaw yet). A swept
  hull would need a local-yaw field on HulkSection + the authoring.
- `GameConfig.hulk.hullHalfHeight` only feeds the hullRects FALLBACK now; fitted
  lists carry their own per-box `hy`.
- The roll spin is `Maps.theWreck` `rollRate` (+ `rotationY: π/2` sideways).

**When machines is fitted:** merge `feat/phase0-smoke-harness` → `main`.

---

## Multiplayer: the ROOM owns the arena (implemented 2026-07-08)

Online, the map is a **room property**, not a per-client choice — the sim is
server-authoritative, so every client must render the board the server built.
The flow (PROTOCOL_VERSION 22):

- The catalog + `applyMap` moved to **`shared/src/Maps.ts`** so the server can
  run them; `client/src/game/Maps.ts` is now the client shim (localStorage
  persistence + the SOLO applier that wires the ConfigOverrides precedence
  hooks in). The override check is an injectable `MapOverrideHooks` param on
  the shared `applyMap` — server/online pass nothing ("no overrides").
- The player's saved arena selection rides `JoinOptions.mapSelection` on
  every join. It is consulted only when that join **creates** the room
  (Colyseus hands the creating client's options to `onCreate`): `BattleRoom`
  validates it (`isMapSelection`, fallback `"random"`), resolves `"random"`,
  runs `applyMap(mapId)` **before** constructing `BattleSim`, and replicates
  the concrete id as `BattleState.mapId`. Joiners inherit; their value is
  ignored.
- The client (`main.ts` `startOnline`) awaits `NetClient.mapId()` (the join
  promise can settle before the first full state decodes) and applies the
  server's map into its local GameConfig before constructing `NetworkGame` —
  carrier placement, nebula/storm zones, and wreck hazards are all read from
  config at construction.
- `NetworkGame` gained wreck support for The Wreck: local `Hulk` sims +
  `HulkView`s built from `GameConfig.hazards`, poses integrated on the render
  clock (constant rates — same trick as the replicated rocks), hull sections
  added to the cosmetic-bolt obstacle list, and the predicted own-ship bumped
  out via the shared `bumpShipOutOfHulkSection` (extracted from
  `BattleSim.resolveHulkCollisions`).
- The loadout menu shows the arena picker on the online MISSION step too,
  with the briefing spelling out host-picks/joiners-inherit. Difficulty stays
  solo-only (server bots fly stock `ai`/`commander` knobs).

**Server caveat** (documented on `applyMap`): GameConfig is process-global, so
on a multi-room server the last-created room's map owns the globals. Every
map-driven field is read at construction, so existing rooms keep their board;
the one mid-match read is shatter-chunk drift speed, which is cosmetic-only
(chunks replicate with their actual drift).
