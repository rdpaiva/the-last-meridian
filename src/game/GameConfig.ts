/**
 * Central tuning constants. Adjust to tune feel.
 *
 * IMPORTANT: rates are expressed per second (not per frame), so behavior is
 * identical at 60 Hz, 144 Hz, or any other refresh rate. Anything that ends
 * in `Rate` should be fed into the helpers in `math.ts` (exponentialDecay /
 * exponentialMultiplier), never multiplied raw per frame.
 */
export const GameConfig = {
  player: {
    /** Forward acceleration (units / sec^2) while thrust is held. */
    thrust: 48,
    /** Reverse acceleration (units / sec^2) while reverse is held. */
    reverseThrust: 18,
    /**
     * Lateral (sideways) acceleration (units / sec^2) while strafe is held.
     * Strafe pushes perpendicular to facing without changing heading, so the
     * pilot can sidestep while keeping the nose — and guns — on the enemy.
     * Tuned below forward thrust so strafing reads as a dodge, not a sprint.
     */
    strafeThrust: 34,
    /** Cap on velocity magnitude (units / sec). */
    maxSpeed: 35,
    /**
     * Exponential drag rate (1/sec). With dragRate = 1.5, velocity decays
     * to ~22% of its value after 1 second of no input.
     */
    dragRate: 0,
    /** Angular speed (radians / sec). */
    rotationSpeed: 4.5,
    /** Minimum time between consecutive laser shots. */
    fireCooldownMs: 120,

    /**
     * Where laser bolts spawn, in SHIP-LOCAL coordinates.
     *   +Z = forward (toward the nose)
     *   +X = right (starboard)
     *   +Y = up (vertical — usually 0 since we're top-down)
     *
     * Add as many entries as you want; fireMode below decides whether
     * each shot fires from all of them at once or alternates through
     * the list. Easy weapon archetypes to try:
     *
     *   Single nose cannon:   [{ x: 0,     y: 0, z: 1.2 }]
     *   Dual wing blasters:   [{ x: -0.85, y: 0, z: 0.1 },
     *                          { x:  0.85, y: 0, z: 0.1 }]   (current default)
     *   Triple-spread mount:  [{ x: 0,     y: 0, z: 1.2 },
     *                          { x: -0.6,  y: 0, z: 0.5 },
     *                          { x:  0.6,  y: 0, z: 0.5 }]
     *
     * The fallback ship's wings sit at x≈±0.55 with body width 0.7, so
     * dual muzzles at ±0.85 are just outside the wing tips. Tune to taste.
     */
    muzzles: [
      { x: -0.85, y: 0, z: 0.1 },
      { x: 0.85, y: 0, z: 0.1 },
    ],

    /**
     * "alternate"  — round-robin one muzzle per shot. Visual dual-fire,
     *                same DPS as a single muzzle (fireCooldownMs governs
     *                total fire rate). Classic X-wing feel.
     * "salvo"      — every muzzle fires on the same tryFire(). Doubles
     *                DPS at 2 muzzles, triples at 3, etc. If you switch
     *                to "salvo" you'll want to bump fireCooldownMs to
     *                rebalance the duel.
     */
    fireMode: "alternate" as "alternate" | "salvo",

    /**
     * Which procedural fallback ship to build (used when no
     * /models/fighter.glb is present).
     *   "classic" — sleek dart: tapered body, flat wings, blue cockpit dome,
     *               canted wingtip fins.
     *   "viper"   — Colonial-Viper silhouette: long nose, triple-engine
     *               cluster, short swept wings with winglets, red stripes.
     * Flip this value to switch between the two designs.
     */
    shipDesign: "viper" as "classic" | "viper",
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
    /** Offset from ship origin where the laser spawns (along ship forward). */
    spawnOffset: 1.2,
  },

  missile: {
    /** Missiles the player starts with; refills to this on respawn. */
    maxAmmo: 30,
    /** Travel speed (world units / sec). Constant — no acceleration. */
    speed: 35,
    /** Time before an in-flight missile self-destructs. */
    lifetimeMs: 4000,
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
     * Homing turn limit (radians / sec). Below the player's rotationSpeed
     * (4.5) so a missile can be out-maneuvered if the target jukes hard.
     */
    turnRate: 3.2,
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

  arena: {
    halfWidth: 600,
    halfDepth: 400,
    /** Show the wireframe reference grid floor. Off for now. */
    showGrid: false,
  },

  camera: {
    /** World-space Y offset above the gameplay plane. */
    offsetY: 35,
    /**
     * World-space Z offset behind the player. Camera does NOT rotate with
     * the ship — this is a fixed world-space offset, not a chase-cam length.
     */
    offsetZ: 28,
    /**
     * Smoothing rate (1/sec). With rate = 8, camera covers ~63% of remaining
     * distance every 1/8 sec. Higher = stiffer, lower = floatier.
     */
    smoothingRate: 8,
    /**
     * Seconds of look-ahead based on velocity. At velocityLead=0.25 and
     * maxSpeed=35, the camera leads the ship by up to ~8.75 units in the
     * direction it's moving. Subtle — gives a feel of forward momentum
     * without sliding the ship around the frame.
     */
    velocityLead: 0.25,

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

  engineGlow: {
    /** Trail tube diameter. */
    trailDiameter: 0.3,
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

  glow: {
    /** Overall bloom strength. 0.5 = subtle, 1.0 = vivid, 1.5+ = neon. */
    intensity: 0.75,
    /** Bloom blur radius. Bigger = softer/wider haloes. */
    blurKernelSize: 32,
    /** GlowLayer internal texture scale. 0.5 = half-res = faster. */
    mainTextureRatio: 0.5,
  },

  combat: {
    /** Hit radius for ship vs. laser tests (units). */
    shipHitRadius: 1.2,
    /** Damage dealt per laser hit. Both factions share the same damage. */
    laserDamage: 20,

    playerMaxHp: 100,
    enemyMaxHp: 60,

    /** Delay before a dead player ship comes back. */
    playerRespawnDelayMs: 1500,
    /** Delay before a dead enemy ship comes back. */
    enemyRespawnDelayMs: 3000,
  },

  enemy: {
    /** How many enemy fighters share the arena at once. */
    count: 10,
    /** Forward acceleration (units / sec^2). Lower than the player. */
    thrust: 18,
    /** Velocity cap. */
    maxSpeed: 22,
    /** Drag rate as in player. */
    dragRate: 1.4,
    /** Angular speed (rad / sec). */
    rotationSpeed: 2.0,

    /** Range at which the enemy stops wandering and turns toward the player. */
    engagementRange: 35,
    /** Range below which the enemy will fire when its cone is on target. */
    fireRange: 26,
    /** Half-angle of the fire cone (rad). 0.22 ≈ 12.6°. */
    fireConeAngle: 0.22,
    /** Minimum time between shots. Slower than the player's 180ms. */
    fireCooldownMs: 700,

    /** How often the wander heading gets nudged (seconds). */
    wanderRetargetSec: 1.4,
    /** Magnitude of a wander nudge (radians). */
    wanderJitter: 0.9,
    /** Bias strength pulling the wander heading back toward arena center. */
    centerBias: 0.35,
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

  scene: {
    clearColor: { r: 0.02, g: 0.03, b: 0.06 },
    /**
     * Cap on per-frame delta time. Prevents teleporting ships and
     * laser-through-wall bugs when the tab refocuses after being backgrounded.
     */
    maxDeltaSeconds: 1 / 30,
  },
};
