// Type-only import — erased at compile time, so no runtime cycle with Ship.ts
// (which imports the GameConfig value from here).
import type { ShipTypeConfig } from "./sim/Ship";
// Type-only as well — keys the per-faction records below (fleets, rosters).
import type { Faction } from "./Faction";

/**
 * Central tuning constants. Adjust to tune feel.
 *
 * IMPORTANT: rates are expressed per second (not per frame), so behavior is
 * identical at 60 Hz, 144 Hz, or any other refresh rate. Anything that ends
 * in `Rate` should be fed into the helpers in `math.ts` (exponentialDecay /
 * exponentialMultiplier), never multiplied raw per frame.
 */

/**
 * THE SHIP CATALOG — one entry per flyable ship type, each a complete,
 * self-contained profile: movement, weapons, HP, per-bolt laser damage,
 * missile rack, collision radius, model file, and fire sound. The player picks
 * a type via `GameConfig.player.shipType`; the enemy fleet mixes types via
 * `GameConfig.enemy.fleet`. Adding a ship = adding ONE entry here (plus a GLB
 * in /public/models/ and its orientation entry in `GameConfig.shipModels`).
 *
 * Muzzle coordinates are SHIP-LOCAL (+Z forward, +X starboard). When a type's
 * GLB carries `muzzle.*` empties, those markers override this list for ships
 * loaded through `AssetLoader.loadPlayerShip` (the player + wingmen); fleet
 * CLONES read only this config list, so keep it in sync with the GLB's
 * empties (scaled by the model's `shipModels` scale).
 */
const shipTypes = {
  /**
   * Spitfire — the human dogfighter. The baseline profile: fast, agile,
   * modest punch. (Values were GameConfig.player before the catalog existed.)
   */
  spitfire: {
    model: "spitfire.glb",
    /** Forward acceleration (units / sec^2) while thrust is held. */
    thrust: 48,
    /** Reverse acceleration (units / sec^2) while reverse is held. */
    reverseThrust: 18,
    /**
     * Lateral (sideways) acceleration (units / sec^2) while strafe is held.
     * Tuned below forward thrust so strafing reads as a dodge, not a sprint.
     */
    strafeThrust: 34,
    /** Cap on velocity magnitude (units / sec). */
    maxSpeed: 24,
    /** Exponential drag rate (1/sec) — see math.ts helpers. */
    dragRate: 0.9,
    /** Angular speed (radians / sec). */
    rotationSpeed: 4.5,
    /** Minimum time between consecutive laser shots. */
    fireCooldownMs: 120,
    /** Dual wing blasters (fallback — the GLB's muzzle.* markers override). */
    muzzles: [
      { x: -0.85, y: 0, z: 0.1 },
      { x: 0.85, y: 0, z: 0.1 },
    ],
    /**
     * "alternate" — round-robin one muzzle per shot (same DPS as a single
     * muzzle; fireCooldownMs governs total rate). "salvo" — every muzzle
     * fires per shot (multiplies DPS by the muzzle count; rebalance
     * fireCooldownMs if you flip this).
     */
    fireMode: "alternate",
    maxHp: 100,
    /** Damage per bolt. */
    laserDamage: 20,
    /** Heat-seeker rack size. */
    missileAmmo: 10,
    /**
     * Cannon magazine (laser rounds). ~240 ≈ 30s of sustained fire at the
     * 120ms cycle — a disciplined pilot rarely empties it; a trigger-holder
     * runs dry partway through an engagement (the anti-spam lever).
     */
    cannonAmmo: 240,
    /** X/Z collision radius (world units). */
    hitRadius: 1.2,
    fireSound: "playerGuns",
  },

  /**
   * Breaker — the human HEAVY GUNSHIP (see the story bible: built to crack
   * capital ships and mothership subsystems). Slower and far less nimble than
   * the Spitfire, but it has the best sustained gun DPS in the catalog, soaks
   * twice the damage, and carries double the missile rack. Versus the Reaver
   * it's the gunship proper: better guns and handling, smaller target — the
   * Reaver answers with more armor, heavier alpha, and a bigger rack. Four gun
   * muzzles (two nose pairs + two wing turrets) ripple in alternate mode.
   */
  breaker: {
    model: "breaker.glb",
    thrust: 34,
    reverseThrust: 14,
    strafeThrust: 22,
    /** Noticeably slower than the Spitfire's 24 — a weapons truck, not a racer. */
    maxSpeed: 17,
    dragRate: 0.9,
    /** Ponderous turn — lead your targets. */
    rotationSpeed: 2.9,
    /** Heavy bolts on a brisk cycle — 227 DPS, the catalog's best guns. */
    fireCooldownMs: 150,
    /**
     * Mirrors the GLB's muzzle.FL/FR (nose gun pairs, at the barrel tips) +
     * muzzle.WL/WR (wing turret barrel tips, slightly aft of center) empties
     * at shipModels scale 0.35 — used by fleet clones, which don't read GLB
     * markers.
     */
    muzzles: [
      { x: -0.33, y: 0, z: 1.65 },
      { x: 0.33, y: 0, z: 1.65 },
      { x: -0.89, y: 0, z: -0.26 },
      { x: 0.89, y: 0, z: -0.26 },
    ],
    fireMode: "alternate",
    /** Armored: more than twice the Spitfire's hull. */
    maxHp: 220,
    /** Heavy bolts — ~1.7× the fighter guns. */
    laserDamage: 34,
    /** Double rack for the strike role. */
    missileAmmo: 20,
    /** Big drum for the gunship's sustained-fire role (~63s at the 150ms cycle). */
    cannonAmmo: 420,
    /** Physically bigger ship, bigger capture circle. */
    hitRadius: 1.7,
    fireSound: "breakerLaser",
  },

  /**
   * Wraith — the Novari KNIFE-FIGHTER. The fastest, most agile, hardest-to-hit
   * ship in the catalog, with the best fighter guns — paid for with the
   * lightest hull and no missile rack. It out-runs and out-turns the Spitfire;
   * the Spitfire answers with +30 hull, heat-seekers, and forgiveness.
   */
  wraith: {
    model: "wraith.glb",
    /** Hottest engines in the catalog — above the Spitfire's 48. */
    thrust: 54,
    reverseThrust: 20,
    strafeThrust: 38,
    /** Fastest ship in the game (Spitfire: 24). */
    maxSpeed: 27,
    dragRate: 0.9,
    /** Out-turns everything (Spitfire: 4.5). */
    rotationSpeed: 5.4,
    /** Fastest gun cycle in the catalog — 200 DPS to the Spitfire's 167. */
    fireCooldownMs: 100,
    /** Dual wing muzzles — matches the Spitfire layout. */
    muzzles: [
      { x: -0.85, y: 0, z: 0.1 },
      { x: 0.85, y: 0, z: 0.1 },
    ],
    fireMode: "alternate",
    /** Lightest hull in the game — speed IS the Wraith's armor. */
    maxHp: 70,
    laserDamage: 20,
    /** No rack — guns and agility are the whole kit. */
    missileAmmo: 0,
    /**
     * Smaller drum than the Spitfire — a pure knife-fighter rewards burst
     * discipline (~18s at its hot 100ms cycle). No missiles to fall back on.
     */
    cannonAmmo: 180,
    /** Slim airframe, hardest target in the catalog to hit. */
    hitRadius: 1.0,
    fireSound: "laserGun",
  },

  /**
   * Reaver — the Novari HEAVY GUNSHIP (story bible: the machines' answer to
   * the Breaker — more aggressive and alien, built to crack the Bastion).
   * The ARMORED MISSILE BARGE: biggest hull, heaviest alpha per bolt, and the
   * biggest missile rack in the catalog — but the slowest guns, the slowest
   * hull, and the biggest target. Versus the Breaker it trades gun DPS and
   * handling for armor and ordnance. Four muzzles (twin long chin cannons +
   * the two wing gun pods) ripple in alternate mode. Reverse/strafe sit at
   * Breaker-class authority so a human can fly it off the loadout menu.
   */
  reaver: {
    model: "reaver.glb",
    thrust: 36,
    reverseThrust: 12,
    strafeThrust: 18,
    /** Slowest hull in the catalog (Breaker: 17) — armor over engines. */
    maxSpeed: 16,
    dragRate: 0.9,
    /** Even more ponderous than the Breaker's 2.9. */
    rotationSpeed: 2.7,
    /** Slow cycle — 190 DPS, below the Breaker; each bolt hits hardest. */
    fireCooldownMs: 200,
    /**
     * Mirrors the GLB's muzzle.NL/NR (chin cannon tips) + muzzle.WL/WR (wing
     * gun pod tips) empties at shipModels scale 0.35 — used by fleet clones,
     * which don't read GLB markers. Keep in sync with art/reaver.blend.
     */
    muzzles: [
      { x: -0.15, y: 0, z: 1.58 },
      { x: 0.15, y: 0, z: 1.58 },
      { x: -0.86, y: 0, z: 0.81 },
      { x: 0.86, y: 0, z: 0.81 },
    ],
    fireMode: "alternate",
    /** The toughest fighter-class hull in the game. */
    maxHp: 280,
    /** Heaviest bolts in the catalog — a step above the Breaker's 34. */
    laserDamage: 38,
    /** Biggest rack in the game (matters when the player flies one). */
    missileAmmo: 24,
    /** Biggest drum to match the barge role (~96s at its slow 200ms cycle). */
    cannonAmmo: 480,
    /** Big scythe-winged silhouette, big capture circle. */
    hitRadius: 1.9,
    fireSound: "breakerLaser",
  },
} satisfies Record<string, ShipTypeConfig>;

/** A key into the ship catalog: "spitfire" | "breaker" | "wraith". */
export type ShipTypeId = keyof typeof shipTypes;

export const GameConfig = {
  /** The ship catalog (see the `shipTypes` doc above). */
  shipTypes,

  player: {
    /**
     * Which catalog entry (GameConfig.shipTypes) the human pilot flies — and,
     * by extension, the player's wingmen, who clone the same ship. Every stat
     * (speed, HP, per-bolt damage, missile rack) follows the type. This is the
     * DEFAULT only: the splash loadout menu picks the ship per run and
     * persists the choice in localStorage (see Loadout.ts).
     */
    shipType: "spitfire" as ShipTypeId,

    /**
     * Which procedural fallback ship to build (used when the type's GLB is
     * missing or fails to load).
     *   "classic" — sleek dart: tapered body, flat wings, blue cockpit dome,
     *               canted wingtip fins.
     *   "viper"   — Colonial-Viper silhouette: long nose, triple-engine
     *               cluster, short swept wings with winglets, red stripes.
     * Flip this value to switch between the two designs.
     */
    shipDesign: "viper" as "classic" | "viper",

    /**
     * Which faction the human pilot flies for. The player is simply the one
     * Ship wearing a LocalInputController; this flag decides which side that
     * is and which mothership is "home" — everything mirrors when it flips.
     * Like shipType above, this is the DEFAULT only: the splash loadout menu
     * chooses the side per run.
     */
    faction: "humans" as Faction,

    /**
     * AI wingmen that fly on the player's side (Phase 5). Each is an ordinary
     * player-faction `Ship` wearing an `AIController` with a standing order —
     * the same seam that drives the enemy fighters, just on the human side.
     * Orders are STATIC (assigned at spawn, no in-game command UI yet); in a
     * future multiplayer build the wing self-organizes instead.
     *
     * By DEFAULT wingmen fly the PLAYER's ship TYPE
     * (GameConfig.shipTypes[player.shipType]) — the same guns, turn rate,
     * reverse/strafe, and HP, so an ally is mechanically identical to you and
     * never faster. Set `shipTypes` below to mix the wing instead (e.g. fly
     * the Breaker with Spitfire escorts).
     *
     * `orders[i]`, `slots[i]`, and `shipTypes[i]` configure wingman i; if
     * there are more wingmen than entries the list wraps. Orders:
     *   "cover"     — escort the leader in a slot, break to engage any opponent
     *                 within `ai.coverBreakRange` of the leader, then reform.
     *   "formation" — hold the slot on the leader's wing; fire only at targets
     *                 that wander into the cone (no breaking off).
     *   "hunt"      — seek & destroy: always chase the nearest enemy fighter
     *                 (ignores the mothership); loiter on the leader if none.
     *   "strike"    — press the enemy mothership and fire on it; engage fighters
     *                 only in close self-defense.
     *   "defend"    — loiter near the friendly mothership; intercept any enemy
     *                 that enters `ai.defendRadius` of the carrier.
     */
    wingmen: {
      /** How many AI wingmen launch on the player's side. 0 disables the wing. */
      count: 2,
      /**
       * Per-wingman SHIP TYPE, one list per side the player might fly (the
       * wing has to match the chosen faction). Within a list, entries wrap if
       * shorter than count, like `orders`. A wingman whose type matches the
       * player's flies a CLONE of the player's loaded model — mechanically
       * identical to you (never faster, same drag); an EMPTY list defaults
       * every wingman to that same clone-the-player behavior.
       *
       * One EXPLICIT entry per slot, padded to the max wing size (6) — the
       * match-settings screen exposes one ship-type dropdown per slot
       * (TuningSchema reads this array's length, mirroring `orders`). The
       * defaults give either side's pilot a light-fighter escort (fly the
       * gunship and the interceptors fly with you).
       *
       * Caveats for a wingman whose type differs from the player's:
       * - It is built like an enemy fleet clone: muzzles come from the type's
       *   config list (not GLB markers) and the engine glow sits at a nozzle
       *   derived from the mesh bounds.
       * - Formation quality depends on relative speed: a wingman SLOWER than
       *   the leader's ship (e.g. a Breaker escorting a Spitfire) cannot hold
       *   a slot at your full speed — it will trail when you burn flat-out.
       */
      shipTypes: {
        humans: ["spitfire", "spitfire", "spitfire", "spitfire", "spitfire", "spitfire"],
        machines: ["wraith", "wraith", "wraith", "wraith", "wraith", "wraith"],
      } as Record<Faction, ReadonlyArray<ShipTypeId>>,
      /**
       * Per-wingman standing order (wraps if shorter than count). One
       * explicit entry per slot, padded to the max wing size (6) — the
       * match-settings screen exposes one order dropdown per slot
       * (TuningSchema reads this array's length), and behavior is identical
       * to the old single wrapped ["cover"] entry.
       */
      orders: ["cover", "cover", "cover", "cover", "cover", "cover"] as ReadonlyArray<
        "cover" | "formation" | "hunt" | "strike" | "defend"
      >,
      /**
       * Returns the formation slot for wingman `index` in leader-local units
       * (+x = starboard, -z = behind). Generates an expanding V so any count
       * produces a reasonable layout without manual slot entries:
       *
       *   index 0,1 → close flanks  (±14, -10)
       *   index 2,3 → mid flanks    (±19, -18)
       *   index 4,5 → far flanks    (±24, -26)
       *   …and so on
       *
       * Sized for the wing to clear a HEAVY leader (the Breaker is ~3.3 units
       * long): wide enough that a return-to-slot overshoot or a slot swing
       * during a leader course change doesn't cross the leader's hull.
       *
       * Override this function if you want hand-tuned positions instead.
       */
      formationSlot(index: number): { x: number; z: number } {
        const row = Math.floor(index / 2);
        const side = index % 2 === 0 ? -1 : 1;
        return { x: side * (14 + row * 5), z: -10 - row * 8 };
      },
    },
  },

  laser: {
    /** Travel speed in world units / sec. */
    speed: 95,
    /** Time before laser is despawned. */
    lifetimeMs: 1200,
    /** Visual length along the bolt's forward axis. */
    length: 1.2,
    /** Visual half-thickness in X and Y. */
    radius: 0.08,
    /**
     * How far forward of the muzzle (along the bolt's heading) the bolt spawns.
     * The bolt mesh is centered on its position, so ~half its `length` seats the
     * rear tip at the muzzle and the streak reads as emanating from the gun.
     */
    spawnOffset: 0.6,
  },

  missile: {
    // NOTE: rack size (ammo) is PER SHIP TYPE — see shipTypes[*].missileAmmo.
    /** Travel speed (world units / sec). Constant — no acceleration. */
    speed: 45,
    /**
     * Time before an in-flight missile self-destructs. At `speed` 45 this is
     * the "outlast the motor" escape: survive ~3.2s of jukes and the missile
     * burns out. Kept above the AI launch envelope (ai.missileMaxRange 110 ≈
     * 2.4s of straight flight) so a clean, non-juking shot still connects.
     */
    lifetimeMs: 3200,
    /**
     * Body-tube length (world units). Kept well under the ~1.6-unit player
     * ship so the missile reads as a small sub-munition. Total mesh (nose +
     * body) is ~1.36× this.
     */
    length: 0.5,
    /** Body-tube radius (half its diameter). Slim hull. */
    radius: 0.06,
    /** Offset from ship origin where the missile spawns (along ship forward). */
    spawnOffset: 1.2,
    /**
     * Minimum time between launches (ms). Gates the held key so the whole
     * ammo pool can't dump in a single frame; tuned slow to read as a
     * deliberate, weighty shot vs. the laser's rapid fire.
     */
    fireCooldownMs: 600,
    /**
     * Homing turn limit (radians / sec). Well below every ship's rotationSpeed
     * (Spitfire 4.5, Wraith 5.4) so a hard juke at close range forces the
     * missile to overshoot — its turn radius (speed/turnRate ≈ 18 units) can't
     * follow the break, and it has to loop back around for another pass. This
     * is the main "out-maneuver it" lever; lower = easier to shake.
     */
    turnRate: 2.5,
    /**
     * Point-defense window: X/Z radius within which a laser bolt's path
     * destroys a missile in flight (one bolt kills it — missiles have no HP).
     * The missile mesh is tiny (radius ~0.06), so this is a deliberate aim-
     * assist bubble — generous enough that shooting one down is satisfying,
     * small enough that it still takes a led shot, not a spray. Any faction's
     * lasers can intercept the OPPOSING faction's missiles (so the AI can swat
     * yours too, incidentally — it doesn't aim at them on purpose).
     */
    interceptRadius: 0.9,
    /** Damage is rolled uniformly in [minDamage, maxDamage] per hit. */
    minDamage: 30,
    maxDamage: 50,
    /** Distance within which a lock can be acquired (world units). */
    lockRange: 400,
    /** Half-angle of the frontal lock cone (rad). 0.5 ≈ 28.6°. */
    lockConeAngle: 0.5,
    /**
     * Mid-flight re-acquisition — applies ONLY to missiles launched without a
     * lock (a locked missile stays on its original target). A ballistic missile
     * homes onto the nearest live enemy within `seekRange` and inside
     * `seekConeAngle` of its heading, i.e. one that crosses its path ahead.
     * Kept tighter than the launch lock so stray shots don't vacuum up the
     * whole arena.
     */
    seekRange: 60,
    /** Half-angle of the in-flight seeker cone (rad). 0.6 ≈ 34.4°. */
    seekConeAngle: 0.6,
    /** Exhaust TrailMesh tube diameter. Kept ≲ the body so it reads as a
     * thin exhaust, not a tube fatter than the missile. */
    trailDiameter: 0.1,
    /** Exhaust TrailMesh segment count — longer = lengthier streak. */
    trailLength: 28,
  },

  /**
   * Incoming-missile warning — the player's RWR. Active while ANY live enemy
   * missile is homing on the player's ship. The counterplay (out-turn it, drag
   * it into a rock, break the track in a nebula) already exists; this makes it
   * LEGIBLE. Three synced channels, all driven by MissileWarning:
   *   - a repeating warning beep whose tempo ramps as the nearest tracking
   *     missile closes (RWR-style: proximity through rhythm),
   *   - a red viewport-border pulse re-triggered ON each beep (a sustained
   *     rhythm for as long as a missile tracks — deliberately NOT a one-shot
   *     flash, which would be ambiguous with the damage flash), and
   *   - radar blips for the inbound rounds (size in radar.missileBlip).
   */
  missileWarning: {
    /**
     * Beep period (sec) while the nearest tracking missile is at or beyond
     * rampStartDistance — the "launch detected, you have time" tempo.
     */
    beepIntervalFarSec: 0.55,
    /**
     * Beep period (sec) once that missile is at or inside rampEndDistance —
     * the "break NOW" tempo. The interval lerps between the two across the
     * ramp band.
     */
    beepIntervalCloseSec: 0.11,
    /**
     * Distance (world units) at which the tempo ramp starts. Sized to the AI
     * launch envelope (ai.missileMaxRange 110) plus a margin, so even a
     * max-range launch opens with some urgency information in the rhythm.
     */
    rampStartDistance: 130,
    /** Distance (world units) of max urgency — the tempo pegs at the close interval. */
    rampEndDistance: 12,
    /** Peak opacity (0..1) of the red viewport-border pulse on each beep. */
    pulsePeakAlpha: 0.55,
    /**
     * Exponential decay rate (1/sec) of the border pulse between beeps. At
     * the far tempo a pulse fully fades before the next beep (discrete
     * blips); at the close tempo successive pulses overlap into a near-steady
     * red glow — the visual urgency ramps with the audio for free.
     */
    pulseDecayRate: 7,
  },

  arena: {
    /**
     * The arena is UNBOUNDED — ships are no longer position-clamped (the AI
     * leash + player piloting keep the action in the corridor). halfWidth/
     * halfDepth now only size the reference grid and seed scenery + fighter
     * spawn scatter; they don't wall anything in. Kept at 600 so spawns still
     * fan out across the ~±700 carrier-to-carrier corridor.
     */
    halfWidth: 600,
    halfDepth: 600,
    /** Show the wireframe reference grid floor. Off for now. */
    showGrid: false,
  },

  /**
   * Drifting asteroid field — the arena's terrain. Rocks are DESTRUCTIBLE
   * (HP, shatter into smaller chunks) and double as line-of-sight COVER: a
   * laser/missile that reaches a rock is consumed by it (see LaserSystem /
   * MissileSystem — asteroids are checked as obstacles BEFORE the ship target
   * loop, so a bolt can't pass through a rock to the ship behind it). Ships
   * that ram a rock are hard-bumped to its surface and take damage.
   */
  asteroids: {
    /** How many rocks seed the field at match start. 0 disables the field. */
    count: 50,
    /** Visual radius range (world units). Each rock picks one in this band. */
    radiusMin: 8,
    radiusMax: 24,
    /**
     * Collision radius as a fraction of the visual radius. < 1 so clipping a
     * rock's jagged silhouette reads as a near-miss rather than a phantom hit.
     */
    collisionScale: 0.82,
    /** Y level — on the gameplay plane so rocks are real cover, not underfoot. */
    yLevel: 0,
    /** Drift speed range (units/sec). Slow — rocks creep across the arena. */
    driftSpeedMin: 1.5,
    driftSpeedMax: 5,
    /** Per-axis tumble rate range (rad/sec). */
    spinRateMin: 0.05,
    spinRateMax: 0.3,
    /** HP per unit of visual radius — bigger rocks soak more fire. */
    hpPerRadius: 15,
    /** Damage a ship takes when it rams a rock (gated by bumpCooldownSec). */
    collisionDamage: 22,
    /** Minimum seconds between ram-damage applications to one ship. */
    bumpCooldownSec: 0.5,
    /** Rocks at/below this visual radius vanish on death instead of splitting. */
    minSplitRadius: 7,
    /**
     * Chunk count scales with the parent's visual radius (chunksPerRadius ×
     * radius), then clamps to [splitCountMin, splitCountMax]. So a small rock
     * cracks into a couple of pieces while a big boulder bursts into a whole
     * spray of rubble — the count is no longer a flat constant.
     */
    chunksPerRadius: 0.24,
    splitCountMin: 2,
    splitCountMax: 8,
    /**
     * Each chunk's visual radius is the parent's × a fraction rolled in
     * [splitRadiusMin, splitRadiusMax]. The band is wide on purpose: a single
     * shatter throws a few sizeable chunks alongside small fragments. Chunks
     * that land at/below minSplitRadius are terminal (they vanish, not re-split)
     * — that's the "fragment" tier; the bigger ones can be shot apart again.
     */
    splitRadiusMin: 0.18,
    splitRadiusMax: 0.62,
    /**
     * Bias exponent applied to the size roll (rand^bias). > 1 skews the mix
     * toward the small end — mostly little fragments with the occasional big
     * chunk, the way real rubble breaks. 1 = uniform across the size band.
     */
    splitSizeBias: 2.0,
    /** Outward speed kick (units/sec) added to each chunk on shatter. */
    splitSpeed: 18,
    /**
     * Random extra outward speed (units/sec) layered on top of splitSpeed per
     * chunk, so the debris fans out at varied velocities instead of a uniform
     * ring. Each chunk gets splitSpeed + rand(0, splitSpeedVariance).
     */
    splitSpeedVariance: 14,
    /**
     * Per-axis tumble rate range (rad/sec) for SHATTER CHUNKS — far faster than
     * the ambient field spin, so fresh debris rolls and tumbles violently from
     * the blast instead of drifting serenely like the rest of the field.
     */
    chunkSpinRateMin: 1.5,
    chunkSpinRateMax: 4.5,
    /** Keep-clear radius around each mothership where rocks won't spawn. */
    mothershipClearance: 180,
    /**
     * Icosphere subdivisions. Higher = more, smaller facets = a rounder, less
     * pointy silhouette (at more verts). 3 gives a chunky-but-rounded rock; 2 is
     * sharply faceted, 4 approaches smooth.
     */
    meshDetail: 10,
    /**
     * Radial displacement as a fraction of radius (silhouette lumpiness). The
     * displacement is smooth/coherent across the surface (see Asteroid.buildMesh),
     * so this controls how bumpy the potato is — keep it modest (~0.2-0.3) or
     * the lobes grow into sharp points. Higher = craggier, lower = rounder.
     */
    lumpiness: .28,
    /**
     * Each rock squashes two of its three axes by a random factor in
     * [squashMin, 1] — this is what kills the "ball" silhouette. One axis
     * always stays at 1 so `visualRadius` remains the true max extent (keeps
     * the collision-circle derivation honest). 1 disables squash entirely.
     */
    squashMin: 0.85,
    /** How many crater dents each rock gets (random in [min, max]). */
    craterCountMin: 25,
    craterCountMax: 75,
    /** Crater footprint, as an angular radius on the rock's surface (radians). */
    craterRadiusMin: 0.15,
    craterRadiusMax: 0.95,
    /** Crater depth as a fraction of the rock's radius (each crater varies ±40%). */
    craterDepth: 0.10,
    /**
     * Per-face brightness jitter for the flat-shaded facets: each face is
     * darkened by a random amount in [0, faceTintJitter]. Breaks the uniform
     * "grey plastic" look into mineral patchiness. 0 disables.
     */
    faceTintJitter: 0.3,
    /** Camera trauma when a rock shatters (distance-scaled like other remote FX). */
    shatterTrauma: 0.4,
  },

  mothership: {
    /** Z-axis span of the central spine (world units). */
    hullLength: 280,
    /** World Z of the player mothership center (south of the arena). */
    playerZ: -700,
    /** World Z of the enemy mothership center (north of the arena). */
    enemyZ: 700,
    /**
     * Y offset for the mothership root. Negative = below the gameplay plane,
     * so the hull's top face (at localY+3) sits flush with y=0 and the player
     * ship appears to fly off the deck.
     */
    yLevel: -3,

    /**
     * Catapult launch bays (tubes), in mothership-LOCAL coordinates:
     *   +x = starboard pod, -x = port pod (the pods sit at ±65);
     *   z runs along the keel (bow = +z). More-negative z starts the fighter
     *   deeper/aft in the tube, so it gets a longer catapult run.
     * A fighter is placed here (Y forced to the gameplay plane) and flung along
     * the carrier's forward axis. Two bays let a wing launch in PARALLEL — the
     * launch queue alternates bays, so the deck clears about twice as fast as a
     * single tube would. Both factions' carriers use these (the offsets are
     * rotated by each carrier's facing). Tweak to move where ships launch from;
     * add or remove entries to change the bay count.
     */
    launchBays: [
      { x: 65, z: -80 },  // starboard pod
      { x: -65, z: -80 }, // port pod
    ] as ReadonlyArray<{ x: number; z: number }>,

    /**
     * Detailed carrier MODELS (Blender → GLB) that replace the procedural box
     * build at runtime. Loaded once per carrier in Game.start(); on success the
     * procedural meshes are disposed and the GLB takes over. `file` is
     * PER-FACTION — the humans fly the Bastion Carrier, the Novari the
     * Choirship — set an entry to null to keep that side's procedural carrier.
     *
     * Orientation/scale correction (same convention as `shipModels`). The model
     * is authored bow-along Blender +Y; EMPIRICALLY (verified in-game, not by
     * armchair axis math — Babylon's RHS→LHS handling is subtle) it lands bow-aft
     * with the bay mouths pointing AWAY from the launch axis, so rotY=π spins the
     * whole assembly 180° to face the bays/bridge down the launch direction. The
     * correction rotates the launch empties with the geometry, so ships keep
     * spawning in the bays and now exit through the mouths. `scale` brings the
     * ~26-unit Blender model up to ~`hullLength` so the existing hitRadius and
     * launch exit distance still fit. Tune in the Inspector (expand the carrier's
     * `ms_model_*` node) if a re-export changes the orientation.
     *
     * LAUNCH BAYS come from empties named `launch.*` authored into the GLB and
     * read in the carrier's local frame, so they track the art automatically;
     * the `launchBays` offsets above are only the procedural-fallback positions.
     */
    model: {
      file: {
        humans: "bastion_carrier.glb",
        machines: "choirship.glb",
      } as Record<import("./Faction").Faction, string | null>,
      rotX: 0,
      rotY: Math.PI, // bays/bridge must face the launch axis (see note above)
      rotZ: 0,
      scale: 10.6,
    },

    // --- Combat: the mothership is the win/lose objective. ---
    /**
     * Hit points. Destroying the enemy mothership wins the match; losing yours
     * ends it. Sized so a sustained strafing run (lasers ~160 dmg/sec + the
     * occasional missile) takes several seconds, not instant.
     */
    maxHp: 1500,
    /**
     * Legacy single-circle radius. Kept only for DamageTarget interface
     * compliance on Mothership itself — weapons and the ship keep-out use
     * the hull-section rectangles below instead, which cover the full hull
     * instead of just the midship.
     */
    hitRadius: 90,
    /**
     * Solid hull footprint, PER FACTION: a stack of rectangles along the keel
     * in carrier-LOCAL coordinates (z along the keel, bow = +z; symmetric in
     * x, halfWidth each side). Each becomes a MothershipSection — a
     * world-space axis-aligned box (the carriers sit at rotY 0/π) that is a
     * DamageTarget proxy forwarding to the carrier's single HP pool and the
     * keep-out box ships are bumped out of. The AI's avoidance pass steers
     * around COARSE CIRCLES derived from these boxes (Mothership.
     * avoidanceCircles) — steering tolerates over-cover, damage doesn't.
     *
     * FITTED TO THE GLBs as the game builds them (model correction rotY=π,
     * scale 10.6), measured with scripts/measure-carrier-footprint.mjs —
     * near-exact: worst slack/phantom ≈ 1 unit (the measured silhouette is
     * itself a stack of rectangles).
     *
     * INVARIANT: the forward-most rect's z1 must stay short of the launch
     * exit (model bow extent + 25: Bastion ≈ 165, Choirship ≈ 171) so a
     * fighter completing its catapult run is already outside the keep-out.
     * Re-measure with the script if a carrier GLB is re-exported.
     * NOTE: sized to the GLBs, not the procedural fallback carrier (whose
     * pods run wider, to x≈±84) — under the fallback the pod flanks are
     * partly intangible, which is acceptable for a missing-model fallback.
     */
    hullRects: {
      humans: [
        { z0: -134, z1: -100, halfWidth: 17 }, // stern spine
        { z0: -100, z1: 120, halfWidth: 51 },  // main body (pods)
        { z0: 120, z1: 130, halfWidth: 44 },   // bow taper
        { z0: 130, z1: 140, halfWidth: 17 },   // bow tip
      ],
      machines: [
        { z0: -148, z1: -110, halfWidth: 48 }, // stern block
        { z0: -110, z1: -80, halfWidth: 40 },  // waist
        { z0: -80, z1: 60, halfWidth: 53 },    // main body
        { z0: 60, z1: 80, halfWidth: 28 },     // bow taper
        { z0: 80, z1: 120, halfWidth: 18 },    // bow spike
        { z0: 120, z1: 147, halfWidth: 12 },   // spike tip
      ],
    } as Record<
      import("./Faction").Faction,
      ReadonlyArray<{ z0: number; z1: number; halfWidth: number }>
    >,

    // --- Death spectacle (played once when a mothership is destroyed). ---
    /** Number of explosions scattered across the hull on death. */
    deathExplosionCount: 14,
    /** Half-spread (world units) over which the death explosions scatter. */
    deathExplosionSpread: 110,
    /** Camera trauma burst at the moment of destruction. */
    deathTrauma: 0.9,
    /** Hitstop (ms) at the moment of destruction. */
    deathHitstopMs: 140,

    // --- Surface detail (purely cosmetic: decks, windows, bridge glass). ---
    /**
     * Warm amber porthole glow. Faction-NEUTRAL on purpose — windows read as
     * "crew aboard" the same way on both carriers; faction color stays on the
     * hull and the running lights. Emissive (>1 components push into bloom),
     * disableLighting. NOTE: the dense window rows are deliberately NOT added to
     * the GlowLayer — a full row of glowing portholes blows out to white (see
     * the emissive/glow gotchas). Only the bridge viewport band glows.
     */
    windowColor: { r: 1.3, g: 0.85, b: 0.4 },
    /** Brighter warm amber for the command-bridge viewport glass (this one glows). */
    viewportColor: { r: 1.6, g: 1.05, b: 0.55 },
  },

  /**
   * Per-faction sensor model (SensorSystem) — what each side can SEE. Every
   * AI pilot targets its faction's shared sensor picture (not ground truth),
   * and the player's radar draws the same picture, so both sides can lose
   * track of ships that break contact — most deliberately, by hiding inside
   * a combat nebula (see scenery.combatNebulas, Phase 3).
   */
  sensors: {
    /** Radar radius (world units) of every live fighter. */
    shipRange: 220,
    /**
     * Radar radius of the carrier — the faction's long-range AWACS. Covers
     * the home half of the field so strikers approaching the objective are
     * seen coming; blind to concealed (nebula) ships at any range.
     */
    mothershipRange: 450,
    /**
     * Unconditional EYEBALL range: even a concealed ship is detected this
     * close to a live enemy fighter. You can't be invisible in a knife fight.
     */
    visualRange: 40,
    /**
     * How long (sec) a lost contact's last-known position stays on the
     * picture as a targetable "ghost" before the track fully expires. AI
     * pilots fly to the ghost and search there; the radar fades it out.
     */
    memorySec: 6,
    /**
     * Detection sweep cadence (sec). Detection doesn't need per-frame
     * precision; fresh contacts' POSITIONS still update every frame so AI
     * aim points don't lag a sweep behind a fast target.
     */
    sweepIntervalSec: 0.25,
    /**
     * Factor on a fighter's OWN shipRange while it sits inside a nebula —
     * hiding costs awareness, so cloud-camping isn't free. 1 = no penalty.
     */
    nebulaSensorFactor: 0.4,
  },

  radar: {
    /** Canvas edge length (px); the dish is a circle inscribed in it. */
    sizePx: 190,
    /** World-units radius mapped to the radar rim. Contacts beyond clamp to it. */
    rangeWorld: 600,
    /** Gap from the screen corner (px). */
    marginPx: 16,
    /** Fighter blip radius (px). */
    fighterBlip: 3,
    /** Inbound-missile blip radius (px) — smaller than a fighter blip. */
    missileBlip: 2.2,
    /** Mothership diamond half-size (px). */
    mothershipBlip: 6,
    /** Player heading-triangle size (px). */
    playerMarker: 6,
  },

  launch: {
    /**
     * Wide-shot hold time before the countdown begins. Camera stays at
     * introZoom (full mothership visible) for this duration, then smoothly
     * zooms in to normal framing as the 3-2-1 digits play.
     */
    introDuration: 2.0,
    /**
     * Camera zoom factor during the wide establishing shot. Must be larger
     * than camera.maxZoom so the whole mothership fits in frame — this is
     * a cinematic override, not accessible via the player zoom keys.
     */
    introZoom: 6.0,
    /** Seconds each countdown digit is displayed (3 → 2 → 1). */
    countdownStepSec: 1.0,
    /** Extra seconds the "LAUNCH!" banner lingers before the catapult fires. */
    launchTextSec: 0.5,
    /** Auto-catapult speed (units/sec). Well above player maxSpeed. */
    launchSpeed: 90,
    /** Camera trauma burst at the moment the catapult fires. */
    launchTrauma: 0.35,
    /**
     * Seconds between consecutive catapult firings within one fleet's launch
     * queue. At match start a whole wing streams out of the carrier one ship at
     * a time at this cadence — the player first, then each wingman; the enemy
     * fleet likewise from its own carrier. Smaller = a tighter, faster stream.
     */
    staggerSec: 0.4,
    /**
     * How many ships fill a launch bay before the queue spills to the next one.
     * Ships are assigned to bays in contiguous blocks (the first `shipsPerBay`
     * launch from bay 0, the next `shipsPerBay` from bay 1, …) rather than
     * alternating, so a small wing — the player and their wingmen — all stream
     * out of the SAME tube and arrive together instead of one wingman peeling
     * off the far side of the carrier and having to catch up. Set high enough to
     * keep a faction's whole fleet in one bay; the extra bay is used only when a
     * fleet exceeds this count (e.g. the 6-strong enemy wing → 5 + 1).
     */
    shipsPerBay: 5,
    /**
     * Distance (world units) before the bow over which the catapult eases the
     * ship from launchSpeed down to its OWN cruise speed (its maxSpeed), so
     * control hands back with no speed jump. Without this the ship snapped from
     * launchSpeed straight to its (much slower) max speed at the bow and looked
     * like it braked hard the instant it cleared the deck — most obvious on the
     * slow enemy fighters (90 → 22). The ease floors at the ship's cruise speed,
     * so the launch never drops below normal flight speed (no crawl). Larger =
     * a longer, gentler settle but a less punchy exit; 0 restores the hard snap.
     * (A separate, gentler slow-down still follows from drag as the ship settles
     * to its thrust equilibrium — tune that via the faction's dragRate.)
     */
    settleDistance: 55,
  },

  camera: {
    /**
     * Vertical field of view (radians). LOWER = more telephoto = flatter
     * perspective, so ships stay a consistent size regardless of where they are
     * on screen (a wide FOV makes near objects balloon and far ones shrink). The
     * offsets below are pulled back to compensate so the framing is preserved:
     * roughly distance ∝ 1/tan(fov/2), so halving the FOV ~doubles the offsets.
     */
    fov: 0.45,
    /** World-space Y offset above the gameplay plane. */
    offsetY: 74,
    /**
     * World-space Z offset behind the player. Camera does NOT rotate with
     * the ship — this is a fixed world-space offset, not a chase-cam length.
     */
    offsetZ: 59,
    /**
     * Smoothing rate (1/sec). With rate = 8, camera covers ~63% of remaining
     * distance every 1/8 sec. Higher = stiffer, lower = floatier.
     */
    smoothingRate: 8,
    /**
     * Seconds of look-ahead based on velocity. At velocityLead=0.25 and
     * maxSpeed=24, the camera leads the ship by up to ~6 units in the
     * direction it's moving. Subtle — gives a feel of forward momentum
     * without sliding the ship around the frame.
     */
    velocityLead: 0.25,
    /**
     * Smoothing rate (1/sec) for the velocity used in the lead calculation.
     * Raw velocity is filtered through this before the lead offset is applied,
     * so rapid direction reversals (e.g. strafing left→right) ease the lead
     * point across rather than snapping it, which would make the ship appear
     * to lurch the wrong way in the camera frame. Higher = more reactive
     * (approaches raw velocity); lower = lazier pan on direction change.
     */
    velocityLeadSmoothingRate: 5,

    /**
     * Player-controlled zoom (+/- keys). The camera's fixed offset (offsetY
     * and offsetZ) is multiplied by a live zoom factor: 1.0 = the default
     * framing above, smaller = closer in, larger = further out.
     *
     *   minZoom — closest the camera can get (most zoomed in).
     *   maxZoom — furthest the camera can pull back (most zoomed out).
     *   zoomRate — how fast the zoom factor changes per second while a
     *              zoom key is held (multiplicative units / sec).
     */
    minZoom: 0.45,
    maxZoom: 2.5,
    defaultZoom: 1.25,
    zoomRate: 1.2,

    /**
     * Camera clip planes (world units). REQUIRED — CameraRig reads these into
     * camera.minZ / camera.maxZ. If either is missing, the value becomes
     * `undefined`, the frustum collapses, and the ENTIRE 3D scene renders
     * blank (HUD survives since it's DOM). The far plane must comfortably
     * contain the deepest/farthest scenery (nebulas sit at yLevel ≈ -182 and
     * are flung ~765 units off-axis), or their far edges get sliced off by a
     * hard rectangular frustum cut — most visible when zoomed out. Keep
     * nearClip well above 0 so the near:far depth ratio stays tight enough to
     * avoid z-fighting on the gameplay plane (nearest object ~20 units away).
     */
    nearClip: 1,
    farClip: 2000,
  },

  starfield: {
    /**
     * The starfield is a CAMERA-LOCKED WRAPPING field. Instead of scattering
     * stars across the whole arena (which would force the count — and GPU
     * cost — to grow with arena area), it fills only what the camera can see:
     * stars that cross a screen edge wrap around to the opposite side, so the
     * field reads as infinite. Star cost is therefore decoupled from world
     * size — it's the multiplayer-safe design.
     *
     * Count is DENSITY-DRIVEN and CAPPED. The active star count is
     * `density × visible-area`, so the on-screen density stays constant even
     * if the camera zooms out (e.g. at high speed) — but it's clamped to
     * `maxCount`, giving a hard GPU ceiling no matter how far we zoom. A
     * buffer of `maxCount` stars is allocated once; we just render the active
     * slice via thinInstanceCount.
     *
     * Densities are stars per 10,000 world-units² of the (margin-padded)
     * field, tuned to reproduce the original on-screen look.
     */
    nearDensity: 39,
    /** Density of dim "far" stars (deeper parallax layer). */
    farDensity: 11.6,
    /** Hard ceiling on rendered "near" stars — the perf budget for zoom-out. */
    maxNearCount: 4000,
    /** Hard ceiling on rendered "far" stars. */
    maxFarCount: 3000,
    /**
     * Tile size multiplier over the visible footprint. The field wraps over a
     * square `viewMargin ×` the on-screen footprint, so the wrap boundary sits
     * safely off-screen and stars never visibly pop in/out. 1.0 = exactly the
     * footprint (risky near edges); 1.25 leaves a comfortable margin.
     */
    viewMargin: 1.25,
    /** Y level of the near star layer (below the play plane). */
    nearY: -8,
    /** Y level of the far star layer. */
    farY: -18,
  },

  scenery: {
    capitalShips: {
      /** Number of background capital ships. */
      count: 3,
      /** Approximate Y level (each ship varies slightly). */
      yLevel: -26,
      /** Hull length range (world units). Each ship picks one in this band. */
      lengthMin: 26,
      lengthMax: 38,
    },
    nebulas: {
      /**
       * Number of nebula cloud patches. Pulls the first N entries from the
       * texture/color/position lists in Nebulas.ts (so the unused ones are
       * just parked at the end — bump this to bring them back).
       */
      count: 2,
      /** Y level — pushed deep so the clouds read as distant background. */
      yLevel: -182,
      /**
       * Base opacity. Per-pixel opacity is modulated by the image's own
       * alpha channel (soft feathered edges), so this is the cap, not the
       * average.
       */
      alpha: 0.25,
      /** Visual size of each nebula plane. */
      size: 320,
    },
    /**
     * COMBAT nebulas — gameplay clouds, unlike `nebulas` above (deep
     * background scenery). Each is an alpha-blended painted cloud rendered
     * slightly ABOVE the fighter plane, so ships that fly in are visibly
     * veiled by it — and its X/Z footprint registers as a SensorSystem
     * concealment zone: inside it a ship drops off the opposing radar except
     * at eyeball range (see GameConfig.sensors). Hiding works both ways —
     * enemies use the same clouds against the player's wing.
     */
    combatNebulas: {
      /** Y level of the cloud quads: above the fighters (y=0), under the camera. */
      yLevel: 7,
      /** Opacity cap (the PNG's feathered alpha modulates per-pixel). */
      alpha: 0.6,
      /**
       * The clouds: position as fractions of the arena half-extents (like the
       * background nebulas) + the CONCEALMENT radius in world units. Placed
       * midfield-ish so breaking contact is a route choice, not a spawn camp.
       */
      zones: [
        { xFrac: -0.45, zFrac: 0.05, radius: 55 },
        { xFrac: 0.5, zFrac: 0.4, radius: 48 },
        { xFrac: 0.12, zFrac: -0.45, radius: 60 },
      ] as ReadonlyArray<{ xFrac: number; zFrac: number; radius: number }>,
      /**
       * Visual quad edge = radius × this. The painted cloud feathers out well
       * inside its quad, so >2 keeps the VISIBLE cloud roughly covering the
       * hard sensor footprint. If hiding feels off (concealed while looking
       * outside the cloud, or vice versa) tune this against `radius`.
       */
      visualScale: 2.6,
    },

    /**
     * Deep-space image rendered as a full-screen background Layer (a 2D blit
     * behind the whole scene), not a 3D plane — see Backdrop.ts for why.
     */
    backdrop: {
      /** Master toggle for the backdrop image. */
      enabled: true,
      /**
       * Brightness multiplier (0..1) applied to the backdrop blit. Lower =
       * dimmer, so the deep-space image sits behind the gameplay rather than
       * competing with it.
       */
      tint: 0.7,
      /**
       * Subtle parallax for the deep-space backdrop. The backdrop is a 2D
       * Layer with no world position, so it can't move on its own. We pan it
       * by shifting the TEXTURE's uOffset/vOffset by `cameraFocus × factor`
       * each frame (NOT layer.offset — that moves the whole on-screen quad and
       * exposes black behind it). That makes the image drift opposite the
       * ship's motion like an impossibly distant layer — the SLOWEST drift in
       * the scene, behind even the far stars.
       *
       * Keep `parallaxFactor` TINY: too large and the backdrop "sticks" to the
       * ship and reads as a painted dome rotating with you. Set it to 0 for a
       * fully static backdrop (the original behavior).
       */
      parallaxFactor: 0.0011,
      /**
       * How the pan is bounded so the texture edge never becomes visible:
       *
       *   "clamp" — the BOUNDED-ARENA default. The texture is zoomed in by
       *             `parallaxZoom` to leave an off-screen margin, and the pan
       *             is clamped to that margin (CLAMP addressing). No seam, no
       *             wrap, works with ANY image (tileable or not). The cost is a
       *             slight zoom crop of the image edges.
       *   "wrap"  — for an UNBOUNDED arena (or just to avoid the zoom crop).
       *             No zoom; `uOffset/vOffset` grow freely with the camera and
       *             the texture's WRAP addressing tiles it. REQUIRES a
       *             seamless/tileable image or the repeat shows a hard seam.
       *             `parallaxZoom` is ignored in this mode.
       */
      parallaxMode: "wrap" as "clamp" | "wrap",
      /**
       * "clamp" mode only: how far the backdrop texture is zoomed in (fraction)
       * to create pan headroom — also the hard cap on total pan travel, so the
       * image edge can never slide into view. 0.12 = zoom in 12%, giving ±6% of
       * pan room each axis. With `parallaxFactor = 0.0001` the pan hits this cap
       * right at the arena edge (halfWidth 600 × 0.0001 = 0.06 = parallaxZoom/2),
       * so the full image breadth is used across the arena.
       */
      parallaxZoom: 0.12,
    },
  },

  secondaryThrusters: {
    // Nozzle positions in ship-local space (outer shipRoot frame, nose = +Z).
    // Tuned for the spitfire (≈2.38 wide × 1.83 long, centered): nose ≈ +0.9,
    // tail ≈ -0.9, body sides ≈ ±0.55.
    /** Local Z of the reverse/nose thruster (forward of ship centre). */
    noseZ: 0.78,
    /** Absolute local X of the port/starboard strafe thrusters. */
    sideX: 0.55,
    /** Local Z of the strafe thruster nozzles (roughly mid-body). */
    sideZ: 0.0,

    // Mesh dimensions.
    /** Diameter of each nozzle glow sphere. */
    coreDiameter: 0.16,
    /** Length of the jet plume along the ejection axis (world units). */
    plumeLength: 1.05,
    /** Width / thickness of the plume ellipsoid (world units). */
    plumeWidth: 0.12,

    // Animation rates (per-second exponential).
    /** How fast a nozzle fades IN on input. Snappy — matches button press. */
    fadeInRate: 18,
    /** How fast a nozzle tapers OUT after input releases. Slow = lingering gas. */
    fadeOutRate: 4,

    // Visual.
    /** Peak trail/sphere opacity. Intentionally dim vs the main engine. */
    maxAlpha: 0.65,
    /**
     * Emissive colour. Cool blue-white (≈ compressed RCS gas) vs the hot
     * orange of the main engine. Blue component > 1 so the GlowLayer blooms
     * it into a soft halo without making it feel neon.
     */
    color: { r: 0.35, g: 0.58, b: 1.1 },
  },

  engineGlow: {
    /**
     * FALLBACK nozzle positions (ship OUTER-root frame: +x = starboard, +z =
     * forward, so aft is negative z), one glow core + trail per entry. This is
     * only used when a ship provides no thruster positions of its own: the
     * player's spitfire supplies them from its `thruster.*` model markers, and
     * GLB enemies derive theirs from the mesh bounds (Game.rearEmitters). So
     * this is just a generic single center-rear glow for a marker-less /
     * procedural fallback ship.
     */
    emitters: [
      { x: 0, y: 0, z: -0.9 },
    ] as ReadonlyArray<{ x: number; y: number; z: number }>,
    /** Diameter of each glow core sphere. */
    coreDiameter: 0.28,
    /** Trail tube diameter. */
    trailDiameter: 0.22,
    /** Number of trail segments — longer = smoother but more vertices. */
    trailLength: 40,
    /** How fast the glow intensity catches up to the target thrust state. */
    responseRate: 12,
    /** How fast the exhaust trail fades IN when thrust starts. Snappy so the
     * streak appears promptly on burn. */
    trailFadeInRate: 14,
    /** How fast the exhaust trail tapers OUT when thrust is released. Lower
     * than fade-in so the line lingers and trails off instead of snapping
     * away. */
    trailFadeOutRate: 3.5,
  },

  /**
   * Scene lighting for the non-emissive surfaces — ship hulls, the motherships,
   * asteroids. (Emissive things — lasers, engines, the backdrop/nebulas — ignore
   * lights and are governed by their own emissive color + the GlowLayer.)
   *
   * These are tuned ALONGSIDE postProcess.exposure: the post pipeline pulls the
   * whole frame down to keep the background dark, so the lights are pushed up to
   * compensate, keeping the lit objects (the mothership especially) bright. If a
   * ship/mothership reads too dark, raise the intensities here — NOT the exposure
   * (that re-brightens the background you darkened).
   */
  lighting: {
    /** Hemispheric ambient fill — the base wash on every surface. */
    hemiIntensity: 0.9,
    /** Sky-side fill color (lights surfaces facing up). */
    hemiSky: { r: 0.6, g: 0.7, b: 0.95 },
    /** Ground-side fill color (lights surfaces facing down). Cool + dim. */
    hemiGround: { r: 0.05, g: 0.05, b: 0.12 },
    /** Key directional "sun" — the main shaping light + shadows/highlights. */
    sunIntensity: 1.2,
    /** Sun travel direction (it points roughly straight down for the top view). */
    sunDirection: { x: -0.4, y: -1, z: 0.2 },
    /** Warm sun color. */
    sunColor: { r: 1, g: 0.95, b: 0.85 },
    /**
     * IBL reflection strength for PBR (metallic) GLB ships — they're rendered
     * almost entirely by what they reflect, so this is effectively their
     * brightness. Raised with the lights so metals don't go flat under exposure.
     */
    environmentIntensity: 0.75,
  },

  glow: {
    /** Overall bloom strength. 0.5 = subtle, 1.0 = vivid, 1.5+ = neon. */
    intensity: 0.75,
    /** Bloom blur radius. Bigger = softer/wider haloes. */
    blurKernelSize: 32,
    /** GlowLayer internal texture scale. 0.5 = half-res = faster. */
    mainTextureRatio: 0.5,
  },

  /**
   * Splash-screen ship preview (ShipPreview.ts) — the slowly rotating "hangar"
   * model on the loadout menu, plus the one-frame ship-card thumbnails. Runs
   * its own small Babylon engine/scene, lit hotter than the game scene (no
   * exposure-pulling post pipeline here) so the PBR hulls read against the
   * dark UI panel.
   */
  shipPreview: {
    /** Camera polar angle (rad) — ~1.1 looks slightly down on the deck. */
    cameraBeta: 1.12,
    /** Camera distance = model bounding diagonal × this. */
    radiusFactor: 1.05,
    /** Idle turntable spin (rad/sec). */
    idleRotationSpeed: 0.45,
    /** Fixed 3/4 pose used for the ship-card thumbnails (rad). */
    thumbnailYaw: -0.7,
    /** Hemispheric ambient fill. */
    hemiIntensity: 1.15,
    /** Key directional light (the hangar "worklight"). */
    keyIntensity: 1.6,
    /** Cool rim/back light — the soft glow behind the hull. */
    rimIntensity: 0.9,
    /** IBL strength for the PBR metal hulls (they're mostly reflection). */
    environmentIntensity: 0.9,
  },

  /**
   * Full-screen post-processing (DefaultRenderingPipeline). This is a SEPARATE
   * pass from the GlowLayer above: the GlowLayer blooms individual emissive
   * meshes; this pipeline tone-maps and antialiases the final composited frame.
   *
   * ACES tone mapping is the point. Without it the >1.0 emissive colors that
   * lasers/engines/explosions use clip straight to flat white; ACES rolls the
   * highlights off filmically so a hot bolt keeps its colored core. FXAA then
   * smooths the low-poly hull and wireframe-grid edges on the composited image.
   *
   * Caveat ACES introduces: its S-curve also LIFTS shadows/midtones, which
   * brightens the (previously near-black) backdrop + nebulas and eats the
   * foreground/background contrast — the fighters start to blend into the lit
   * background. exposure (down), contrast (up), and the vignette below exist to
   * pull that separation back: darken the frame globally + at the edges while
   * the rolled-off lasers/engines stay hot.
   */
  postProcess: {
    /** Master switch for the whole pipeline (cheap escape hatch if it misbehaves). */
    enabled: true,
    /** ACES filmic tone mapping — tames the emissive highlight clipping. */
    toneMapping: true,
    /**
     * Scene exposure feeding the tone-mapper. 1.0 = neutral. Set BELOW 1 to pull
     * the ACES-lifted background back down toward black: midtones darken roughly
     * linearly while the highlight rolloff keeps lasers/engines hot, so this buys
     * foreground/background separation without dimming the bolts. Raise to push
     * more of the image into the rolloff.
     */
    exposure: 0.7,
    /**
     * Tonal contrast (1.0 = neutral). Slightly >1 deepens the shadows ACES
     * lifted — re-darkens the empty space around the fighters so they pop.
     */
    contrast: 1.15,
    /** Fast-approximate antialiasing on the final frame. */
    fxaa: true,
    /**
     * Edge darkening. The brightest nebulas sit at the frame perimeter, so a
     * gentle black multiply vignette both knocks those down and frames the
     * dogfight in the center. Disable for a flat, evenly-lit frame.
     */
    vignette: true,
    /** Vignette strength. Higher = darker/wider corners. ~2-3 reads as subtle. */
    vignetteWeight: 2.0,
  },

  /**
   * Per-model orientation + scale correction for imported GLBs, keyed by
   * filename in /public/models/. AssetLoader applies these to the inner model
   * root (the two-tier root pattern) so each ship's nose points along local
   * +Z at a size consistent with the fleet. Rotations are RADIANS.
   *
   * A model not listed here loads at identity (rotation 0, scale 1).
   *
   * HOW TO TUNE: see the header comment in AssetLoader.ts — open the Inspector
   * (`I`), select the inner model root, dial rotation/scaling until the nose
   * points "north" at the right size, then copy the values here (Inspector
   * shows DEGREES; multiply by π/180 for these RADIAN fields).
   */
  shipModels: {
    // The renamed lancer — flat gunship, already nose-along-+Z; ~8u long so
    // scaled to ~2.3u to sit alongside the procedural fighters.
    "wraith.glb": { rotX: 0, rotY: 0, rotZ: 0, scale: 0.28 },
    // Player fighter (Kenney craft_speederD). ~2.8u wide at native scale;
    // brought down to fleet size. Authored facing the opposite way, so the
    // glTF RHS→LHS Z-flip leaves it nose-aft — rotY = π turns it nose-forward.
    "spitfire.glb": { rotX: 0, rotY: Math.PI, rotZ: 0, scale: 0.7 },
    // Breaker heavy gunship (Blender source: art/breaker.blend). Authored
    // nose-along-Blender--Y so the +Y-up glTF export lands nose-+Z in Babylon
    // — no rotation correction. ~9.3u long native → ~3.3u at fleet scale,
    // deliberately twice the Spitfire's footprint.
    "breaker.glb": { rotX: 0, rotY: 0, rotZ: 0, scale: 0.35 },
    // Reaver heavy gunship (Blender source: art/reaver.blend). Same fighter
    // convention as the breaker (nose-along-Blender--Y, +Y-up export) so no
    // rotation correction. ~9.1u long / 12.1u blade span native → ~3.2u long
    // at fleet scale, the widest fighter silhouette in the game.
    "reaver.glb": { rotX: 0, rotY: 0, rotZ: 0, scale: 0.35 },
  } as Record<string, { rotX: number; rotY: number; rotZ: number; scale: number }>,

  combat: {
    /**
     * FALLBACK hit radius for ship vs. laser tests (units) — used only when a
     * Ship is built without a type (each shipTypes entry carries its own).
     */
    shipHitRadius: 1.2,
    /**
     * FALLBACK damage per laser hit — per-bolt damage normally comes from the
     * firing ship's type (shipTypes[*].laserDamage).
     */
    laserDamage: 20,

    // NOTE: ship HP is PER SHIP TYPE — see shipTypes[*].maxHp.

    /** Delay before a dead player ship comes back. */
    playerRespawnDelayMs: 1500,
    /** Delay before a dead enemy ship comes back. */
    enemyRespawnDelayMs: 3000,
  },

  /**
   * Jump drive + carrier resupply (docs/JUMP-DRIVE-AND-RESUPPLY.md). Cannon
   * MAGAZINES are per ship type (shipTypes[*].cannonAmmo); the knobs here are
   * the shared jump-drive and service-bubble tuning. Starter values — owner
   * tunes later, these are not final balance.
   */
  jump: {
    /**
     * Spool-up before the teleport fires (ms). Matched 1:1 to the
     * jump-drive.mp3 build-up so the audio IS the audible countdown. You can
     * fly/fight/maneuver freely while spooling; enemy fire can't interrupt it.
     */
    spoolMs: 6000,
    /**
     * Drive recharge after EITHER a completed jump OR a cancel (ms). Gates
     * re-arming — stops chain-jumping and makes a cancel cost something (no
     * fake-jump baiting). Key is inert while cooling down.
     */
    cooldownMs: 12000,
    /**
     * Final commit window (ms before fire) during which a cancel is refused
     * ("coordinates locked"). 0 disables the flourish.
     */
    commitMs: 1000,
    /** Camera trauma kick when the player's jump fires (the "whoosh out" punch). */
    arrivalTrauma: 0.35,

    /**
     * AI jump-out doctrine (AIController). A pilot rolls its OWN thresholds
     * ONCE at spawn from the seeded sim RNG (never Math.random()), so a fleet
     * never bugs out in unison — some pilots timid, some berserkers. A single
     * 0..1 "caution" trait drives both the HP threshold and the survival-spool
     * personality (flee vs. blaze of glory). Starter values — owner tunes.
     */
    doctrine: {
      /** HP-fraction jump trigger at caution=0 (berserker waits until ~20%). */
      hpFracMin: 0.2,
      /** HP-fraction jump trigger at caution=1 (timid bugs out by ~45%). */
      hpFracMax: 0.45,
      /**
       * Cannon-ammo-fraction trigger (late is fine — low ammo doesn't kill you
       * during the no-interrupt spool; out of ammo = defenseless, so go home).
       */
      ammoFrac: 0.1,
      /** Retreat latch RELEASES once serviced back up to this HP fraction. */
      recoverHpFrac: 0.85,
      /** …and this cannon-ammo fraction (so an ammo retreat actually rearms). */
      recoverAmmoFrac: 0.6,
      /**
       * Range split: a ship needing service that's CLOSER than this to home
       * flies in & docks (cheap, no telegraph); farther, it jumps. Mirrors
       * optimal player play.
       */
      dockRange: 260,
      /**
       * caution ≥ this → FLEE during a survival spool (full throttle for open
       * space, biased home, fire only opportunistically); below → blaze of
       * glory (keep pressing the attack while the drive charges).
       */
      fleeCautionThreshold: 0.5,
      /** How hard a fleeing ship biases toward home vs. straight away (0..1). */
      homeFleeBias: 0.5,
      /** A detected, spooling opponent within this range is pressed ("kill the runner"). */
      finishRunnerRange: 400,
    },
  },

  /**
   * Carrier service bubble — ONE service (repair HP + refill cannon/missile
   * ammo), reached by flying in & docking OR by jumping home. Loiter (slow
   * down) inside a generous proximity bubble around your carrier's bow/bays
   * and everything refills OVER TIME — not instant, not precise docking. The
   * bow faces the enemy, so the bubble sits on the contested front.
   */
  service: {
    /**
     * Radius (world units) of the service bubble around each launch bay's
     * staging point. Forgiving (no precise alignment) but tight enough that you
     * have to nuzzle up to the bow/bays — the carrier hull is ~280 units long,
     * so this should keep "docked" reading as "right at the carrier", not
     * "anywhere in the neighborhood".
     */
    radius: 40,
    /**
     * Loiter gate: a ship faster than this (units/sec) is strafing past, not
     * docking, and gets no service. Forces a real slow-down decision.
     */
    loiterMaxSpeed: 7,
    /** HP healed per second while servicing. */
    healPerSec: 30,
    /** Cannon rounds refilled per second while servicing. */
    cannonRefillPerSec: 140,
    /** Missiles refilled per second while servicing. */
    missileRefillPerSec: 4,
  },

  /**
   * Jump-FX (view only — the BSG "FTL crack"). A white flash + an expanding
   * shockwave ring play at BOTH the departure point and the arrival point of a
   * jump (so it reads whether you watch a ship leave or appear). Spawned off
   * the jumpFired SimEvent; never touches the sim. (JumpFlashSystem.)
   */
  jumpFx: {
    /** Lifetime (ms) of the central flash "pop". */
    durationMs: 420,
    /** Flash sphere base radius (world units) before the peak scale-up. */
    flashRadius: 4,
    /** Flash peaks at this × base radius, then collapses (kept modest — the
     *  shockwave is carried by the ripple distortion below, not a bright ball). */
    flashPeakScale: 2.4,
    /** Cool flash tint (>1 so a small core still punches through the bloom). */
    flashColor: { r: 1.4, g: 1.7, b: 2.2 },

    /**
     * Shockwave RIPPLE — a screen-space refraction post-process (JumpRipple),
     * not a mesh. A wavefront expands from the jump point and the area BEHIND
     * it ripples and settles like a pond (it displaces the rendered scene, so
     * stars/ships warp through it). Tuning is in aspect-corrected screen UV
     * (center = 0.5,0.5; ~1.1 reaches the corners).
     */
    ripple: {
      /** How long one ripple expands + settles (ms). Outlives the flash. */
      durationMs: 850,
      /** Wavefront radius at end of life (UV; ~1.1 covers the screen). */
      maxRadius: 1.15,
      /** Peak UV displacement (refraction strength) — fades over life. */
      strength: 0.022,
      /** Wavefront band thickness (UV) — the sharp leading edge. */
      width: 0.04,
      /** Ring density of the trailing pond ripples behind the front. */
      frequency: 34,
      /** How far behind the front (UV) the trailing ripples reach. */
      trailLength: 0.4,
      /** Subtle cool brightening right at the leading edge (0 = none). */
      highlight: 0.35,
    },
  },

  /**
   * Which catalog ships each faction fields: fighter first, then gunship.
   * The loadout menu offers exactly this list for the chosen side, and saved
   * loadouts are validated against it (see Loadout.ts).
   */
  factionShips: {
    humans: ["spitfire", "breaker"],
    machines: ["wraith", "reaver"],
  } as Record<Faction, ReadonlyArray<ShipTypeId>>,

  /**
   * Per-faction fleet defaults. The AI opposition flies the fleet of whichever
   * faction the player did NOT pick on the loadout menu (the player's own side
   * fields the player + their wingmen instead — see player.wingmen).
   *
   * `fleet` is the COMPOSITION: how many of each catalog type
   * (GameConfig.shipTypes) launch. Entries spawn in order, so the strike ships
   * (below) are drawn from the first entries. Mix types freely. Each type's
   * GLB is loaded once and cloned per fighter; a type with `model: null` gets
   * the procedural faction-themed FighterMesh instead.
   *
   * `strikeCount`: how many fighters (counted across the whole fleet, in spawn
   * order) fly a "strike" order — pressing the player's mothership and firing
   * on it — instead of the default "patrol" (which only wanders toward the
   * carrier and dogfights your fighters). This is what actually threatens the
   * win/lose objective. The rest patrol/escort. Set 0 for a fleet that never
   * attacks the carrier.
   */
  fleets: {
    humans: {
      // Breakers FIRST so strikeCount's strike orders land on the heavies.
      fleet: [
        { type: "breaker", count: 2 },
        { type: "spitfire", count: 5 },
      ],
      strikeCount: 2,
    },
    machines: {
      // Reavers FIRST so strikeCount's strike orders land on the heavies —
      // they press the player's mothership while the wraith swarm escorts.
      fleet: [
        { type: "reaver", count: 2 },
        { type: "wraith", count: 5 },
      ],
      strikeCount: 2,
    },
  } as Record<
    Faction,
    {
      fleet: ReadonlyArray<{ type: ShipTypeId; count: number }>;
      strikeCount: number;
    }
  >,

  /**
   * FleetCommander doctrine knobs — the ENEMY fleet's runtime re-tasking
   * (the player's own wing keeps its static configured orders). See
   * FleetCommander.ts for the full doctrine; roles split strikers (the first
   * `fleets.*.strikeCount` ships) / escorts / a dynamic pool.
   */
  commander: {
    /** Seconds between command re-evaluations. */
    thinkIntervalSec: 2,
    /** Ships (after the strikers, in spawn order) flying "cover" on the lead striker. */
    escortCount: 2,
    /** Max pool ships scrambled to "defend" while the carrier is threatened. */
    defendCount: 2,
    /**
     * A contact this close to the home carrier (on the fleet's own sensor
     * picture) trips the defense scramble. Hull damage since the last think
     * trips it too, regardless of contacts.
     */
    defendAlertRadius: 240,
    /** Thinks the scramble persists after the last alert (4 × 2s = 8s calm-down). */
    defendHoldThinks: 4,
    /** Max pool ships sent to "hunt" while any contact (fresh or ghost) exists. */
    huntCount: 2,
  },

  /**
   * Shared AI piloting tuning, read by `AIController` for BOTH sides' computer
   * fighters: the machine fighters AND the player's human wingmen (Phase 5).
   * These are *decision* knobs (when to engage, when to fire, how to wander) —
   * the *movement* profile a fighter flies with (thrust/maxSpeed/muzzles)
   * comes from its ship type in the catalog (GameConfig.shipTypes).
   */
  ai: {
    /**
     * --- Asteroid avoidance (every order, every frame) ---
     * A pilot scans `avoidLookahead` units ahead along its intended heading;
     * if a rock's collision circle (plus the ship's radius plus avoidMargin)
     * straddles that path, the pilot steers for the tangent that clears the
     * rock on the side it's already offset toward, then resumes its order.
     */
    /** How far ahead (world units) a pilot looks for rocks on its path. */
    avoidLookahead: 55,
    /** Extra clearance (units) beyond ship + rock radii when passing a rock. */
    avoidMargin: 6,

    /** Range at which a fighter stops wandering and turns toward a target. */
    engagementRange: 35,
    /** Range below which a fighter will fire when its cone is on target. */
    fireRange: 26,
    /** Half-angle of the fire cone (rad). 0.22 ≈ 12.6°. */
    fireConeAngle: 0.22,
    /**
     * Strike order: open fire on the enemy carrier from this far off its hull
     * SURFACE (the nearest point on any hull-section rectangle, not the
     * carrier center). Set just above avoidLookahead so a striker starts
     * shooting on approach right before the avoidance pass peels it into a
     * strafing run along the hull — it never has to (and can't) enter the
     * hull to shoot.
     */
    carrierFireStandoff: 60,

    // --- Missiles (AI launch doctrine) ---
    // Any AI pilot whose ship type carries a rack (shipTypes[*].missileAmmo
    // > 0) uses it, gated so the limited ammo is SPENT WELL, not dumped:
    //   1. FRESH track only — the pilot launches at a contact its faction's
    //      sensors are tracking RIGHT NOW. Ghosts (last-known positions) and
    //      concealed ships never draw a missile; same rule that denies the
    //      player a lock on a hidden ship.
    //   2. Launch envelope — target between missileMinRange (closer than
    //      this, the guns already do the job; don't waste a seeker on a
    //      knife fight) and missileMaxRange (further out, a juking target
    //      can outlast the motor), inside missileLaunchConeAngle of the
    //      nose so the seeker starts with the target in its basket.
    //   3. Clear line of fire — no asteroid between pilot and target
    //      (missiles detonate on rocks; firing into one is a wasted round).
    //   4. Pacing — at most one launch per missileCooldownSec (jittered
    //      per-pilot), so a rack lasts a fight and a fleet doesn't volley
    //      in sync. Ship.tryFireMissile's own short cooldown still applies.
    // Strike-order pilots additionally ripple BALLISTIC missiles into the
    // enemy carrier's hull from inside the same envelope (no lock needed —
    // the hull doesn't dodge).
    /** Closest range (world units) at which an AI pilot fires a missile. */
    missileMinRange: 25,
    /** Furthest range (world units) at which an AI pilot fires a missile. */
    missileMaxRange: 110,
    /** Half-angle (rad) of the AI launch cone around the nose. 0.3 ≈ 17°. */
    missileLaunchConeAngle: 0.3,
    /** Minimum seconds between one pilot's missile launches (±20% jitter). */
    missileCooldownSec: 7,

    /** How often the wander heading gets nudged (seconds). */
    wanderRetargetSec: 1.4,
    /** Magnitude of a wander nudge (radians). */
    wanderJitter: 0.9,
    /**
     * Bias strength (0..1) pulling an idle fighter's wander heading toward its
     * leash anchor (see AIController — the anchor is role-specific). Now that
     * the arena is unbounded, this is what keeps fighters pressing the front
     * line instead of drifting off into empty space.
     */
    leashBias: 0.35,
    /**
     * Distance (world units) from the leash anchor at which the bias reaches
     * full strength. Inside it fighters roam freely; beyond it the pull ramps
     * up to leashBias so they turn back toward the fight. Sized to span the
     * ~700-unit gap between a fighter at world center and its anchor.
     */
    leashRadius: 700,

    // --- Formation (used by player wingmen flying "cover"/"formation") ---
    // A wingman flies its slot like a real pilot, following the leader's PATH
    // rather than copying its facing. Each frame it works out the velocity it
    // needs — the leader's velocity plus a speed-capped approach toward the slot
    // — then points its nose along that velocity and thrusts toward it, trimming
    // cross-track error with strafe. Because it steers by where it needs to GO
    // (not by the leader's nose), a turn the leader makes without changing course
    // doesn't drag the wing around; it only banks when the leader's actual travel
    // direction shifts. The approach is SPEED-CAPPED so the (weak) reverse
    // thruster can still brake it before it overshoots the slot.
    /** Approach speed per unit of slot offset (1/sec). Higher = snappier closing. */
    formationPosGain: 1.0,
    /**
     * Cap on the approach speed toward the slot (units/sec), ON TOP of matching
     * the leader's velocity. Keep it at/under what the reverse thruster can brake
     * (reverseThrust ≈ 18) or the wingman overshoots the slot and circles back.
     */
    formationApproachSpeed: 16,
    /**
     * Velocity-error RELEASE band (units/sec) — the lower edge of the
     * station-keeping Schmitt trigger. Once a jet is firing it keeps firing
     * until the error falls back under this; below it the wingman coasts. Pair
     * with formationVelEngageBand (the upper edge that must be crossed to light
     * a jet from rest) — the gap between the two is the anti-chatter hysteresis.
     */
    formationVelDeadband: 0.5,
    /**
     * Velocity-error ENGAGE band (units/sec) — the upper edge of the
     * station-keeping Schmitt trigger: a thruster won't light until the velocity
     * error exceeds this.
     *
     * MUST BE THIN now that wingmen carry NO drag. With drag, a wide band hid the
     * constant drag-fighting; without drag the band has the opposite effect — any
     * velocity error smaller than the band is left UNCORRECTED, and with nothing
     * to damp it the wingman drifts off its slot until the error finally grows
     * past the band, then the jet slams on and overshoots. That undamped cycle is
     * a slow back-and-forth WEAVE across the slot. A thin band nulls small
     * disturbances immediately, before they can grow into a weave; and because
     * there's no drag to fight, a wingman that's truly settled still sits with its
     * jets dark (its velocity error stays ~0, well inside the band). Keep it just
     * a hair above the release band — wide enough to avoid chatter, no wider.
     */
    formationVelEngageBand: 1.5,
    /**
     * Speed (units/sec) below which the desired-velocity direction is treated as
     * ill-defined and the wingman just holds its current heading instead of
     * steering by it. Without this floor, a wingman parked behind a near-
     * stationary leader would chase the noise in a tiny desired-velocity vector
     * and spin/jitter in place. Keep it small — a slow crawl, well under cruise.
     */
    formationHeadingMinSpeed: 4,
    /**
     * Distance (world units) over which the wingman's HEADING blends from "track
     * the leader's path" (in the slot) to "point nose-first at the slot" (far
     * out). Parked in formation the slot-approach is left OUT of the heading — it
     * is a translation job for the thrusters — so the nose tracks only the smooth
     * leader-velocity direction and doesn't yaw back and forth chasing small
     * position corrections. The further off-slot (up to this range), the more the
     * nose turns to fly in. Bigger = the nose stays path-aligned through bigger
     * excursions (calmer, but slower to point at a distant slot).
     */
    formationHeadingBlendRange: 25,
    /**
     * How fast the formation tracks the leader's velocity (1/sec, fed to
     * exponentialDecay) — i.e. the low-pass on the leader's course/speed that the
     * whole formation flies off. LOWER = smoother but laggier: it filters out the
     * high-frequency velocity wobble a hand-flown leader makes (thrusting while
     * tapping the nose to hold a line), which is what made wingmen at their speed
     * limit weave as they chased every twitch of the slot. Too low and the wing
     * reacts sluggishly to real course changes; ~3 (≈0.33s time constant) absorbs
     * the twitch while still following genuine maneuvers promptly.
     */
    formationCourseSmooth: 3,
    /**
     * Half-angle (rad) of the cone, around the desired-velocity direction, within
     * which the wingman will actually fire its forward/reverse thrusters. Outside
     * it the nose isn't yet lined up, so the wingman coasts and just turns rather
     * than thrusting (or braking) off-course. 0.6 ≈ 34°.
     */
    formationThrustConeAngle: 0.6,
    /**
     * "cover" wingmen break formation to engage any opponent within this radius
     * of the LEADER (not of themselves), then return to slot once it is clear.
     */
    coverBreakRange: 45,
    /**
     * Radius around the friendly mothership within which a "defend" wingman
     * will break off its loiter and engage an enemy fighter. Outside this
     * radius the defender patrols near the carrier; inside it, it intercepts.
     */
    defendRadius: 80,
    /**
     * How far a "defend" wingman may drift from the home carrier before it
     * turns back. Within this radius it wanders freely; beyond it, it heads
     * straight back. Keep below defendRadius so defenders don't loiter so far
     * out that they miss intruders slipping past.
     */
    defendOrbitRadius: 50,
    /**
     * Where a "hunt" wingman loiters when there's no prey AND it has no
     * configured formation slot: this far (world units) directly behind the
     * leader. It station-keeps there with the formation servo — easing in and
     * holding — instead of charging the leader's exact position and looping back
     * past it. (A hunt wingman that DOES have a slot loiters on that slot
     * instead.) Keep it comfortably outside a collision; a touch behind the wing.
     */
    huntEscortDistance: 14,

    /**
     * How often non-formation AI pilots re-evaluate their heading and target
     * (seconds). Gives pilots realistic reaction lag instead of perfect-reflex
     * every-frame targeting. Formation/cover orders are exempt — their
     * velocity-matching servo requires per-frame updates to stay stable.
     * ~0.15–0.25 feels human; 0 = every frame (original behavior).
     */
    reactionSec: 0.28,

    // --- Nose-steering (PROPORTIONAL turn control) ---
    // AI pilots steer with an analog turn rate (InputState.turn), not bang-bang
    // keys. The rate is proportional to heading error: full rate beyond
    // steerBand of error, easing linearly to zero as the nose lines up. That
    // smooth deceleration into the target heading is what fixes BOTH failure
    // modes of the old bang-bang steering — the high-frequency micro-correction
    // "shake", and the low-frequency "clock-hands" stepping when it snapped to a
    // moving heading, stopped, and snapped again. Tracking a moving heading is
    // now a continuous follow, not a series of pulses.
    /**
     * Heading error (rad) at which the turn rate saturates to full. Below it the
     * rate scales linearly with error (a P-controller on heading). SMALLER =
     * snappier, more aggressive turns that saturate sooner (good for dogfight
     * tracking but can overshoot a touch); LARGER = gentler, more damped
     * easing into the heading (calmer formation following). 0.5 ≈ 29°.
     */
    steerBand: 0.5,
    /**
     * Heading error (rad) below which the nose simply holds (no turn command).
     * A thin floor so a continuously-tracked heading doesn't induce a permanent
     * sign-flipping micro-jitter on sub-degree noise. Keep it small — the
     * proportional term already eases the rate to ~0 here. 0.02 ≈ 1.1°.
     */
    steerDeadband: 0.02,
  },

  explosion: {
    /** Pieces of debris per explosion. */
    debrisCount: 8,
    /** Total time before the explosion is disposed. */
    durationMs: 700,
    /** Outward speed of debris pieces (units / sec). */
    debrisSpeedMin: 6,
    debrisSpeedMax: 14,
    /** Initial size of each debris piece (cube edge). */
    debrisSize: 0.45,
    /** Initial radius of the bright central flash sphere. */
    flashRadius: 0.7,
    /** Peak scale multiplier of the flash. */
    flashPeakScale: 5.0,
  },

  shake: {
    /**
     * Trauma-based screen shake (Squirrel Eiserloh's pattern).
     *   Each impact adds to trauma (capped at 1.0).
     *   Trauma decays exponentially at decayRate per second.
     *   Shake offset = max_offset × trauma² × sine-noise.
     *
     * Squaring trauma gives nice falloff feel: big events feel huge,
     * small events feel subtle, and the tail of a shake feels graceful.
     */
    decayRate: 1.3,
    /** Max horizontal shake at trauma = 1.0 (world units). */
    maxOffsetXZ: 2.4,
    /** Max vertical shake at trauma = 1.0 (world units). */
    maxOffsetY: 0.7,

    /** Trauma added by each kind of impact (cap is 1.0). */
    traumaEnemyLaserHit: 0.2, // player laser landed on enemy
    traumaPlayerLaserHit: 0.35, // enemy laser landed on player
    traumaEnemyExplosion: 0.55,
    traumaPlayerExplosion: 0.75,
    /** Player missile detonated on an enemy — heavier than a laser hit. */
    traumaMissileHit: 0.5,
    /** Enemy missile detonated ON the player — between a laser hit and dying. */
    traumaPlayerMissileHit: 0.6,
  },

  hitstop: {
    /**
     * Pause-frame durations on impact (ms). The simulation freezes for
     * this long while rendering continues — gives every hit a tiny moment
     * of "weight" before the action resumes.
     */
    enemyLaserHitMs: 25,
    playerLaserHitMs: 50,
    enemyExplosionMs: 70,
    playerExplosionMs: 90,
    /** Player missile detonation — a beefier freeze than a laser hit. */
    missileHitMs: 70,
    /** Enemy missile detonated ON the player — the heaviest non-death freeze. */
    playerMissileHitMs: 90,
    /** Hard cap on accumulated hitstop so chained hits can't freeze indefinitely. */
    maxStackedMs: 140,
  },

  damageFlash: {
    /** Total duration of the red flash on the player ship (ms). */
    durationMs: 220,
    /** Peak alpha at the start of the flash. */
    peakAlpha: 0.9,
    /** Diameter of the flash sphere — should encompass the player ship. */
    diameter: 2.4,
  },

  music: {
    /**
     * Tracks played during gameplay, cycled in shuffled order.
     * Filenames are relative to /music/ — add more to grow the playlist.
     */
    gamePlaylist: ["Black Star Charge.mp3", "Black Star Charge 2.mp3", "Black Star Pursuit.mp3", "Black Star Pursuit 2.mp3"],
    /**
     * Tracks for the main menu (unused until a menu screen exists).
     * Empty = silence during any future menu phase.
     */
    menuPlaylist: [] as string[],
    /** Master volume for music (0..1), independent of SFX. */
    volume: 0.45,
  },

  sound: {
    /**
     * Beyond this distance (world units) non-player fire, hit, and explosion
     * sounds are completely inaudible. Camera trauma from remote events also
     * scales linearly to zero at this distance.
     */
    maxDistance: 500,
    /** Distance at which a spatial sound plays at full volume. */
    refDistance: 40,
  },

  bank: {
    /** Peak roll angle (radians) when turning at full rate. ~0.35 ≈ 20°. */
    maxAngle: 0.35,
    /** Smoothing rate (1/sec) for the bank lerp — higher = snappier response. */
    rate: 6,
  },

  scene: {
    clearColor: { r: 0.02, g: 0.03, b: 0.06 },
    /**
     * Cap on per-frame delta time. Prevents teleporting ships and
     * laser-through-wall bugs when the tab refocuses after being backgrounded.
     */
    maxDeltaSeconds: 1 / 30,
  },
};
