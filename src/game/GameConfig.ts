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

    /**
     * Filename of the GLB to load from /public/models/ for the player ship
     * (and, by extension, the player's wingmen — they clone it). Per-model
     * orientation/scale lives in `GameConfig.shipModels`. If the file is
     * missing or fails to load, AssetLoader falls back to the procedural
     * `shipDesign` above. Set to null to always use the fallback.
     */
    shipModel: "spitfire.glb" as string | null,

    /**
     * Which faction the human pilot flies for. The player is simply the one
     * Ship wearing a LocalInputController; this flag decides which side that
     * is and which mothership is "home". Flip to "machines" to fly the red
     * side from the north mothership — everything mirrors. No UI (by design).
     */
    faction: "humans" as import("./Faction").Faction,

    /**
     * AI wingmen that fly on the player's side (Phase 5). Each is an ordinary
     * player-faction `Ship` wearing an `AIController` with a standing order —
     * the same seam that drives the enemy fighters, just on the human side.
     * Orders are STATIC (assigned at spawn, no in-game command UI yet); in a
     * future multiplayer build the wing self-organizes instead.
     *
     * Wingmen fly the PLAYER's movement/weapon profile (guns, turn rate,
     * reverse/strafe, HP) with just maxSpeed/thrust/dragRate overridden below.
     * maxSpeed is CAPPED at the player's so an ally never out-runs you — they
     * are strong, player-grade fighters, but you stay the one ship that can't
     * be out-flown.
     *
     * `orders[i]` and `slots[i]` configure wingman i; if there are more wingmen
     * than entries the list wraps. Orders:
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
      count: 20,
      /**
       * Wingmen fly the PLAYER's ship — the SAME movement/weapon profile
       * (GameConfig.player: thrust, drag, maxSpeed, turn rate, reverse/strafe,
       * guns, HP), just piloted by an AIController instead of the keyboard. There
       * are deliberately NO per-wingman movement overrides: whatever you tune for
       * the player applies to the wing too, so an ally is mechanically identical
       * to you — never faster, and with the same drag (or none) you have.
       *
       * This is what keeps the slot quiet. With the player's zero drag a wingman
       * coasts at your velocity once matched and only fires its jets to correct a
       * real disturbance — no metronomic "keep-up" puffing to fight drag. Holding
       * formation is handled by piloting (the AIController's servo), not by giving
       * them more thrust/speed than you. The only knobs here are how many fly and
       * what each one's standing order + slot is.
       */
      /** Per-wingman standing order (wraps if shorter than count). */
      orders: ["defend"] as ReadonlyArray<
        "cover" | "formation" | "hunt" | "strike" | "defend"
      >,
      /**
       * Returns the formation slot for wingman `index` in leader-local units
       * (+x = starboard, -z = behind). Generates an expanding V so any count
       * produces a reasonable layout without manual slot entries:
       *
       *   index 0,1 → close flanks  (±10, -6)
       *   index 2,3 → mid flanks    (±15, -14)
       *   index 4,5 → far flanks    (±20, -22)
       *   …and so on
       *
       * Override this function if you want hand-tuned positions instead.
       */
      formationSlot(index: number): { x: number; z: number } {
        const row = Math.floor(index / 2);
        const side = index % 2 === 0 ? -1 : 1;
        return { x: side * (10 + row * 5), z: -6 - row * 8 };
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

    // --- Combat: the mothership is the win/lose objective. ---
    /**
     * Hit points. Destroying the enemy mothership wins the match; losing yours
     * ends it. Sized so a sustained strafing run (lasers ~160 dmg/sec + the
     * occasional missile) takes several seconds, not instant.
     */
    maxHp: 1500,
    /**
     * Flat X/Z collision radius for laser/missile tests. Generous (~central
     * hull footprint) since we use one circle for the whole ship for now;
     * per-part hitboxes (pods/turrets) come with mothership defenses later.
     */
    hitRadius: 90,

    // --- Death spectacle (played once when a mothership is destroyed). ---
    /** Number of explosions scattered across the hull on death. */
    deathExplosionCount: 14,
    /** Half-spread (world units) over which the death explosions scatter. */
    deathExplosionSpread: 110,
    /** Camera trauma burst at the moment of destruction. */
    deathTrauma: 0.9,
    /** Hitstop (ms) at the moment of destruction. */
    deathHitstopMs: 140,
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
     * fleet likewise from its own carrier. Because the queue alternates bays
     * (see mothership.launchBays), two tubes fire in parallel, so each bay
     * actually fires every 2× this. Smaller = a tighter, faster stream.
     */
    staggerSec: 0.4,
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
     * maxSpeed=35, the camera leads the ship by up to ~8.75 units in the
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

  glow: {
    /** Overall bloom strength. 0.5 = subtle, 1.0 = vivid, 1.5+ = neon. */
    intensity: 0.75,
    /** Bloom blur radius. Bigger = softer/wider haloes. */
    blurKernelSize: 32,
    /** GlowLayer internal texture scale. 0.5 = half-res = faster. */
    mainTextureRatio: 0.5,
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
  } as Record<string, { rotX: number; rotY: number; rotZ: number; scale: number }>,

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
    /**
     * Filename of the GLB every enemy fighter flies, loaded once and cloned
     * per fighter. Per-model orientation/scale lives in
     * `GameConfig.shipModels`. Set to null to use the procedural faction-themed
     * fighter mesh (FighterMesh) instead of a model.
     */
    shipModel: "wraith.glb" as string | null,
    /** How many enemy fighters share the arena at once. */
    count: 10,
    /**
     * How many of those enemy fighters fly a "strike" order — pressing the
     * player's mothership and firing on it — instead of the default "patrol"
     * (which only wanders toward the carrier and dogfights your fighters). This
     * is what actually threatens the win/lose objective. The rest patrol/escort.
     * Set 0 for the old behavior (no enemy ever attacks the mothership).
     */
    strikeCount: 3,
    /** Forward acceleration (units / sec^2). Matches player. */
    thrust: 38,
    /** Velocity cap. Matches player. */
    maxSpeed: 25,
    /** No drag — matches player's zero-drag profile. */
    dragRate: 0,
    /** Angular speed (rad / sec). Matches player. */
    rotationSpeed: 3.5,

    // --- Movement fields so this block satisfies Ship's movement config.
    // AI fighters don't strafe or reverse (their controller never sets those
    // inputs), so these stay 0; they fire dual wing cannons in alternate mode.
    /** Reverse acceleration — unused by AI (kept for Ship config shape). */
    reverseThrust: 0,
    /** Lateral acceleration — unused by AI (kept for Ship config shape). */
    strafeThrust: 0,
    /** Dual wing muzzles — matches player layout. */
    muzzles: [
      { x: -0.85, y: 0, z: 0.1 },
      { x: 0.85, y: 0, z: 0.1 },
    ],
    /** Alternate muzzles — same DPS as the player's alternate dual setup. */
    fireMode: "alternate" as "alternate" | "salvo",
    /** Matches player's fire rate. */
    fireCooldownMs: 120,
  },

  /**
   * Shared AI piloting tuning, read by `AIController` for BOTH sides' computer
   * fighters: the machine fighters AND the player's human wingmen (Phase 5).
   * These are *decision* knobs (when to engage, when to fire, how to wander) —
   * the *movement* profile a fighter flies with (thrust/maxSpeed/muzzles) still
   * comes from its faction's own block (the AI-fighter profile lives in
   * `enemy`, which both sides' fighters share so the dogfight stays symmetric).
   */
  ai: {
    /** Range at which a fighter stops wandering and turns toward a target. */
    engagementRange: 35,
    /** Range below which a fighter will fire when its cone is on target. */
    fireRange: 26,
    /** Half-angle of the fire cone (rad). 0.22 ≈ 12.6°. */
    fireConeAngle: 0.22,

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

  scene: {
    clearColor: { r: 0.02, g: 0.03, b: 0.06 },
    /**
     * Cap on per-frame delta time. Prevents teleporting ships and
     * laser-through-wall bugs when the tab refocuses after being backgrounded.
     */
    maxDeltaSeconds: 1 / 30,
  },
};
