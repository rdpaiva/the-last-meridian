# Phase 0 — Local eyeball pass checklist

> **SPENT — Phase 0 was signed off (see `docs/MULTIPLAYER.md`, all Phase 0
> boxes ticked). Kept as a template for future sim/view-split eyeball
> passes; nothing here is queued work. Live queue: `docs/AGENT_KICKOFF.md`.**

> The `[human]` task that closes Phase 0 (`docs/MULTIPLAYER.md`). Headless
> proves the **sim** didn't change (baseline trace clean); this proves the
> **depiction** didn't. Phase 0 cut the sim away from its Babylon view across
> `Ship`, `Laser`, `Missile`, `Mothership`, the sim→view event channel, the
> `Game.tick` split (`advanceSim` / `updateViews`), and the combat-nebula
> zones. Every item below is something one of those cuts could plausibly have
> broken without the typecheck or the smoke test noticing.
>
> Play at least **one full match to a victory AND one to a defeat** (let your
> carrier die once). ~10 min. Tick boxes; note anything off with the section
> letter so it's easy to file.

---

## Setup

```bash
git switch feat/phase0-smoke-harness   # this branch
npm install                            # if deps drifted
npm run dev                            # http://localhost:5173
```

Pick a side + ship on the splash, PLAY. Sound on (the event channel drives
SFX — you're verifying audio too). If you want a quick second run, the
end-screen **Enter** restart skips the splash.

### Controls

| Action | Keys |
|---|---|
| Thrust / reverse | `W` / `S` (or `↑` / `↓`) |
| Turn L / R | `A` / `D` (or `←` / `→`) |
| Strafe L / R | `Q` / `E` |
| Fire lasers | `Space` |
| Fire missile | `Shift` |
| Zoom in / out | `+` / `-` |
| Mute | `M` |
| Restart (end screen) | `Enter` |

---

## A. Launch sequence (player cinematic + staggered fleet)

- [ ] Match opens zoomed-in on your carrier bay; the **3‑2‑1 countdown** overlay
      shows, then your fighter catapults out and the camera settles to gameplay
      zoom.
- [ ] During your hold + launch streak, your engine glow is **dark** (no glowing
      dots bleeding through the carrier hull), then the engine **spools up** the
      instant you clear the bow. *(Game.tick split — player launch glow gating.)*
- [ ] Your wingmen and the enemy fleet **stream out of their own carriers'
      bays**, one behind the other — nobody is pre-scattered in open space, and
      none of them glow while still in the tube. *(Game.tick split — the
      `lastInput === null` launch-dark bridge for AI ships.)*
- [ ] Both carriers (your Bastion Carrier / the enemy Choirship) render as the
      **GLB models**, not plain boxes, and sit at opposite ends. *(Mothership
      view split + GLB swap.)*

## B. Ship motion & depiction

- [ ] Every fighter **mesh sits exactly on the ship it represents** — no mesh
      lagging, leading, or drifting off its position. *(Ship/ShipView pose copy.)*
- [ ] Ships **bank/roll into their turns** (hold `A`/`D` and watch the model
      tilt), and roll back to level when straight. Roll direction matches the
      turn (turning right banks right). *(ShipPose `bankAngle` → `rotation.z`.)*
- [ ] Nose points where the ship flies; strafing (`Q`/`E`) slides sideways
      without spinning the hull.

## C. Engine FX — the `lastInput` bridge (highest-risk change)

> The AI engine glow + maneuvering plumes used to update *inside* the sim loop;
> they now run in `updateViews` off each ship's recorded `lastInput`. Watch
> these closely.

- [ ] **Your** engine glow + trail brighten under thrust (`W`) and fade when you
      coast — smooth, not popping.
- [ ] **Wingmen and enemy fighters** light their exhaust when they accelerate
      and dim when they don't — i.e. the glow tracks what each AI ship is
      *doing*, not stuck on or off.
- [ ] AI ships that **strafe / reverse** fire their small RCS maneuvering plumes
      (most visible on your same-type wingmen).
- [ ] When a fighter **dies**, its glow/plumes **taper off** rather than freezing
      lit at full brightness.
- [ ] No fighter's glow is **stuck on while sitting in a launch tube** during a
      respawn (see H).

## D. Weapons FX

- [ ] Your lasers spawn **at the muzzles** and fly forward; enemy/wingman bolts
      do too. Bolt color matches faction. *(Laser/LaserSystem view pool.)*
- [ ] Sustained fire doesn't leave **stuck or orphaned bolts** hanging in air,
      and bolt count looks bounded (the mesh pool recycles). 
- [ ] Missiles (`Shift` with a lock) launch from the ship, **trail smoke/exhaust**,
      and **curve toward** their target. *(Missile/MissileSystem view: mesh +
      trail are view, homing is sim.)*
- [ ] **Point defense:** a laser bolt crossing an incoming missile pops it
      (small flash + bang) instead of the missile reaching its target. Try to
      catch one; AI does it to your missiles too.

## E. Combat feedback — the sim→view event channel

> Hits/deaths/launches now **emit** on the bus; the client FX subscribe. Verify
> each fact still produces its sound + shake + flash, attributed correctly.

- [ ] **You take a laser hit:** heavy camera jolt + red damage flash on your
      ship + hit sound. *(`laserHit` → player branch.)*
- [ ] **You land a hit on an enemy:** the enemy flashes + a lighter camera
      confirm + hit sound. *(`laserHit` → AI flash + fromPlayer confirm.)*
- [ ] **Wingman/enemy trade fire (not involving you):** the struck ship flashes,
      but **no** big player-camera jolt for distant exchanges (trauma scales
      with distance).
- [ ] **A fighter explodes:** debris/flash explosion + boom + camera shake;
      distant kills shake **less** than nearby ones.
- [ ] **Missile impact:** explosion + boom at the detonation point; you taking
      one is the heaviest non-death feedback.
- [ ] **Chipping a carrier hull** gives only a **light hit cue** — sustained fire
      on a mothership does NOT spam hitstop / crawl the framerate. *(MothershipSection
      hit path.)*
- [ ] **Asteroid ram:** clipping a rock bumps you off it, flashes + shakes, and
      shooting a rock shatters it into chunks with an explosion.

## F. Hitstop asymmetry (intentional — don't mistake it for a bug)

- [ ] On a big hit/kill there's a **brief freeze-frame**: ships stop mid-air for
      a beat — but the **camera shake, the explosion, and audio keep animating
      through it**. That mix is correct (sim pauses, presentation doesn't).
      *(Game.tick split keeps hitstop a client-only gate.)*
- [ ] After the freeze, action resumes smoothly — no teleport/jump.

## G. Sensors, nebula stealth & radar — combat-nebula zone extraction

> The concealment-zone math moved to scene-free `computeConcealmentZones`. The
> **painted clouds must still line up with the gameplay zones** they came from.

- [ ] The radar (minimap) draws **nebula zone circles**; on the playfield each
      circle has a **painted cloud quad sitting over it** in the same spot/size.
      *(View quad vs. shared zone — they must coincide.)*
- [ ] Fly **into a cloud:** your HUD signature flips toward **HIDDEN/untracked**
      and enemies lose track of you (they stop bee-lining at you from across the
      map). Fly out: you read **DETECTED** again.
- [ ] Enemies hiding in a cloud go **ghosted on your radar** (last-known blip
      with a decay ring) rather than a live position.
- [ ] **Missile lock** won't acquire an enemy concealed in a cloud from long
      range (the lock cue stays off until you're close / they're in the open).

## H. Respawn

- [ ] When you die, after the delay you **relaunch from your carrier bay** (not
      a mid-arena pop-in) via a quick catapult — no countdown on respawns.
- [ ] On respawn your **trail doesn't streak** from the old death spot to the bay
      (trail history is flushed). Same for AI ships respawning.
- [ ] A respawned ship's engine glow behaves like a fresh launch (dark in tube →
      spools up on exit), not stuck lit. *(C + A cross-check.)*

## I. Victory / defeat

- [ ] Kill the enemy carrier → **VICTORY** banner with `KILLS · SCORE` (and
      `NEW BEST` if you beat the stored best). Mothership death = a **scatter of
      explosions + the heaviest shake/freeze** in the game. *(`mothershipDied`
      event.)*
- [ ] Let your carrier die once → **DEFEAT** banner, same death spectacle on
      your carrier.
- [ ] After the banner, the sim is **frozen** but explosions finish playing; no
      ships keep flying under the banner. **Enter** restarts cleanly.

## J. HUD / RWR

- [ ] HP cue, kills, score, and **both mothership HP bars** update live and match
      what you see happen.
- [ ] **Missile lock indicator** lights when an enemy is in your frontal cone +
      range, clears when they leave it.
- [ ] **Incoming-missile warning (RWR):** when an enemy missile homes on you,
      you get the beep (tempo ramps as it closes) + HUD border pulse + radar
      threat blip. It goes quiet when you're dead / between lives / on the end
      screen.

---

## Sign-off

- [ ] One full match to **VICTORY** clean.
- [ ] One full match to **DEFEAT** clean.
- [ ] No view regression vs. how it played before Phase 0 (motion, FX timing,
      audio, shake, launch/respawn, menus).

If all boxes pass, Phase 0 is **done** — tick the last `[ ]` in
`docs/MULTIPLAYER.md` (Phase 0 → Local eyeball pass) and Phase 1 (workspace
restructure → Colyseus) is clear to start. Anything off: note the section
letter + what you saw; it points straight at the offending split.
