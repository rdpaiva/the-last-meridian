import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig } from "../GameConfig";
import { MothershipSection } from "./MothershipSection";
import { MothershipSubsystem, type SubsystemKind } from "./MothershipSubsystem";
import { Turret, type TurretFireCommand } from "./Turret";
import { hullColliderBoxes } from "./Hulk";
import type { DamageTarget } from "../types";
import type { Faction } from "../Faction";
import type { SensorContact } from "../SensorSystem";
import type { AvoidObstacle } from "../ShipController";

/**
 * Mothership SIM — the carrier as gameplay truth, with NO Babylon scene
 * objects (the sim half of the Mothership/MothershipView split,
 * docs/MULTIPLAYER.md Phase 0). It runs anywhere: the browser, the headless
 * smoke harness, and (Phase 1) the server. Its Babylon depiction is a
 * client-side MothershipView (src/game/view/MothershipView.ts) that reads this
 * object's `position`/`rotationY` to place its scene root and, after swapping
 * in the GLB, feeds the model's launch geometry back here via
 * `setModelLaunchData()`.
 *
 * It implements DamageTarget: it is the match objective. Destroying the
 * opposing faction's mothership wins; losing yours ends the game. Collision is
 * per HULL SECTION — world-space axis-aligned rectangles stacked along the keel
 * (`hullSections`, from GameConfig.mothership.hullRects[faction]) that match
 * the visible hull near-exactly. Weapons and the ship keep-out consume the
 * boxes; the AI's circle-based avoidance steers around `avoidanceCircles`
 * (coarse circles derived from the boxes). Damage on any section lands on
 * this one shared HP pool. The legacy single `hitRadius` remains only for the
 * DamageTarget interface.
 *
 * Facing: at rotationY=0 (player) the bow faces world +Z; at rotationY=π
 * (enemy) the bow faces world -Z. The carrier is static — position and
 * rotationY never change after construction, so the hull sections are computed
 * once and the proxy is fully static.
 */
export class Mothership implements DamageTarget {
  readonly faction: Faction;

  /** World-space position on the gameplay plane (Y = carrier deck level). */
  readonly position: Vector3;
  /** Facing (radians): humans 0 (bow +Z), machines π (bow -Z). */
  readonly rotationY: number;

  hp: number = GameConfig.mothership.maxHp;
  readonly maxHp: number = GameConfig.mothership.maxHp;
  /** Legacy single circle — weapons/avoidance use `hullSections` instead. */
  readonly hitRadius: number = GameConfig.mothership.hitRadius;
  /**
   * The solid hull footprint: world-space axis-aligned boxes along the keel
   * (carriers never move and face ±Z, so the rects stay axis-aligned). What
   * lasers/missiles actually test and what ships are bumped out of. Every
   * section forwards its damage here — one HP pool for the whole ship.
   */
  readonly hullSections: ReadonlyArray<MothershipSection>;
  /**
   * Coarse circles circumscribing slices of the hull boxes — what the AI's
   * (circle-only) avoidance pass steers around. Deliberately oversized
   * relative to hullSections: a pilot giving the hull a wide berth looks
   * natural, while weapons stopping in that same phantom space would look
   * broken, which is why steering and damage use different shapes.
   */
  readonly avoidanceCircles: ReadonlyArray<AvoidObstacle>;
  /**
   * Defensive gun turrets bolted to the hull — auto-tracking sub-emitters with
   * their OWN hp (shootable off the pods), built from
   * GameConfig.mothership.turrets.mounts[faction]. The carrier owns them
   * (natural sim ownership); the CALLER (Game.advanceSim / the headless
   * harness) ticks them via updateTurrets() and spawns the returned bolts into
   * this faction's LaserSystem — Turret never references the weapon system, so
   * the sim stays free of a construction-order coupling. See sim/Turret.ts.
   */
  readonly turrets: ReadonlyArray<Turret>;
  /**
   * Destructible named subsystems (the hangar) — like turrets, individually
   * shootable DamageTargets with their OWN hp, built from
   * GameConfig.mothership.subsystems.*.mounts[faction]. The HANGAR's
   * destruction effect (slower faction respawns) is applied by the sim
   * loop's death-latch scan. Carrier shields are NOT a subsystem — they're
   * station-powered (see stationShieldFactor).
   */
  readonly subsystems: ReadonlyArray<MothershipSubsystem>;

  // Shared geometry constants — used by the view's procedural build and by the
  // launch-geometry helpers below.
  static readonly HULL_HALF_DEPTH = 140; // half of hull Z length
  static readonly POD_HALF_DEPTH = 110;  // half of pod Z length
  static readonly STARBOARD_X = 65;      // local X center of the starboard pod

  /**
   * Launch-bay positions (carrier-LOCAL x/z) read from the GLB's `launch.*`
   * empties by the view, or null while running the procedural carrier (then
   * the query helpers fall back to GameConfig.mothership.launchBays). Set by
   * MothershipView via setModelLaunchData() after the model loads.
   */
  private modelLaunchBays: ReadonlyArray<{ x: number; z: number }> | null = null;

  /** Bow-clearing exit distance derived from the GLB's forward extent, or null. */
  private modelExitDistance: number | null = null;

  constructor(worldPosition: Vector3, rotationY: number, faction: Faction) {
    this.faction = faction;
    this.position = new Vector3(worldPosition.x, worldPosition.y, worldPosition.z);
    this.rotationY = rotationY;

    // Hull footprint boxes (per-faction — the two carriers are different shapes;
    // the shared OBB fit, or the hullRects fallback), rotated into world space
    // once: the carrier is static, so the sections are too. The boxes are the
    // SAME geometry the wreck collides with (hullColliderBoxes). The carrier
    // lives on the flat plane, so only each box's X/Z FOOTPRINT matters here
    // (cy/hy are the wreck's roll concern) — its four planar corners are rotated
    // and min/maxed into a world AABB (exact for the 0/π facings carriers use).
    const sin = Math.sin(rotationY);
    const cos = Math.cos(rotationY);
    this.hullSections = hullColliderBoxes(faction).map((b) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          const lx = b.cx + sx * b.hx;
          const lz = b.cz + sz * b.hz;
          const wx = worldPosition.x + cos * lx + sin * lz;
          const wz = worldPosition.z - sin * lx + cos * lz;
          if (wx < minX) minX = wx;
          if (wx > maxX) maxX = wx;
          if (wz < minZ) minZ = wz;
          if (wz > maxZ) maxZ = wz;
        }
      }
      return new MothershipSection(this, minX, maxX, minZ, maxZ);
    });
    this.avoidanceCircles = this.buildAvoidanceCircles();
    this.turrets = this.buildTurrets(worldPosition, sin, cos);
    this.subsystems = this.buildSubsystems(worldPosition, sin, cos);

    // Seed the launch geometry with the values MEASURED off this faction's
    // carrier GLB (scripts/measure-carrier-footprint.mjs), so a HEADLESS sim
    // (Colyseus server, tests) stages launches in the same tubes the browser
    // shows. The browser refines these live once its model loads — measured
    // and live agree to rounding, so there is no visible re-stage.
    const measured = GameConfig.mothership.measuredLaunch[faction];
    if (measured) this.setModelLaunchData(measured.bays, measured.exitDistance);
  }

  /**
   * Builds the hull turrets from GameConfig.mothership.turrets.mounts[faction],
   * rotating each carrier-LOCAL mount into world space with the same sin/cos
   * the hull boxes used (the carrier is static, so the mounts are too). Each
   * turret gets a closure over this carrier's `isAlive` so it goes silent the
   * instant the carrier dies, plus its index/count for the deterministic
   * fire-stagger.
   */
  private buildTurrets(
    worldPosition: Vector3,
    sin: number,
    cos: number,
  ): Turret[] {
    const cfg = GameConfig.mothership.turrets;
    const mounts = cfg.mounts[this.faction] ?? [];
    const carrierAlive = () => this.isAlive;
    return mounts.map((m, i) => {
      const wx = worldPosition.x + cos * m.x + sin * m.z;
      const wz = worldPosition.z - sin * m.x + cos * m.z;
      const restAngle = this.rotationY + (m.restAngle ?? 0);
      const arcHalf = m.arcHalf ?? cfg.arcHalf;
      return new Turret(
        carrierAlive,
        wx,
        worldPosition.y + (m.y ?? cfg.mountY),
        wz,
        restAngle,
        arcHalf,
        i,
        mounts.length,
      );
    });
  }

  /**
   * Builds the named subsystems (the hangar) from
   * GameConfig.mothership.subsystems.*.mounts[faction], rotating each
   * carrier-LOCAL mount into world space exactly like buildTurrets. The
   * carrier is static, so the mounts are too.
   */
  private buildSubsystems(
    worldPosition: Vector3,
    sin: number,
    cos: number,
  ): MothershipSubsystem[] {
    const cfg = GameConfig.mothership.subsystems;
    const built: MothershipSubsystem[] = [];
    for (const kind of ["hangar"] as const satisfies readonly SubsystemKind[]) {
      const mounts = cfg[kind].mounts[this.faction] ?? [];
      for (const m of mounts) {
        built.push(
          new MothershipSubsystem(
            kind,
            worldPosition.x + cos * m.x + sin * m.z,
            worldPosition.y + (m.y ?? cfg.mountY),
            worldPosition.z - sin * m.x + cos * m.z,
          ),
        );
      }
    }
    return built;
  }

  /**
   * Hull damage multiplier from STATION POWER (GameConfig.stations.shield):
   * 1 = unshielded, down to minFactor with every station held. Written
   * DECLARATIVELY each tick by StrategicSystem.applyEffects (both loops) and
   * by NetworkGame's client mirror (derived from replicated station owners).
   * Default 1 is correct pre-first-tick and on station-free maps.
   */
  stationShieldFactor = 1;

  /** True while station power shields the hull at all (any station held). */
  get shieldsUp(): boolean {
    return this.stationShieldFactor < 1;
  }

  /** True while the hangar subsystem is alive (no hangar mounted = true). */
  get hangarAlive(): boolean {
    for (const s of this.subsystems) {
      if (s.kind === "hangar" && !s.isAlive) return false;
    }
    return true;
  }

  /**
   * Tick every live turret on this carrier and collect the bolts they want to
   * fire this step. `contacts` is THIS faction's sensor picture (turrets shoot
   * what their side can see, never ground truth). The caller spawns each
   * command into this faction's LaserSystem. No allocation when nothing fires.
   */
  updateTurrets(
    deltaSeconds: number,
    contacts: readonly SensorContact[],
    nowMs: number,
  ): TurretFireCommand[] {
    const fires: TurretFireCommand[] = [];
    for (const turret of this.turrets) {
      const cmd = turret.update(deltaSeconds, contacts, nowMs);
      if (cmd) fires.push(cmd);
    }
    return fires;
  }

  /**
   * Derives the AI steering circles from the hull boxes: each box is split
   * into roughly-square slices along its long axis, each circumscribed by a
   * circle. Coverage is guaranteed (no gap a pilot could thread into a wall
   * — the keep-out bump backstops any residual contact) at the cost of ~40%
   * corner overshoot, which for steering just reads as a healthy berth.
   */
  private buildAvoidanceCircles(): AvoidObstacle[] {
    const owner = this;
    const circles: AvoidObstacle[] = [];
    for (const s of this.hullSections) {
      const halfX = (s.maxX - s.minX) / 2;
      const halfZ = (s.maxZ - s.minZ) / 2;
      const alongZ = halfZ >= halfX;
      const longHalf = alongZ ? halfZ : halfX;
      const shortHalf = alongZ ? halfX : halfZ;
      const n = Math.max(1, Math.ceil(longHalf / Math.max(shortHalf, 1)));
      const sliceHalf = longHalf / n;
      const radius = Math.hypot(shortHalf, sliceHalf);
      for (let i = 0; i < n; i++) {
        const t = -longHalf + sliceHalf * (2 * i + 1);
        circles.push({
          position: {
            x: s.position.x + (alongZ ? 0 : t),
            z: s.position.z + (alongZ ? t : 0),
          },
          radius,
          get isAlive() {
            return owner.isAlive;
          },
        });
      }
    }
    return circles;
  }

  // ─── DamageTarget ─────────────────────────────────────────────────────────

  get isAlive(): boolean {
    return this.hp > 0;
  }

  takeDamage(amount: number, _nowMs: number): void {
    if (this.hp <= 0) return;
    // Station-powered shields: hull damage scales by the graduated factor
    // StrategicSystem writes each tick (1 with no stations held, down to
    // stations.shield.minFactor with all of them). The floor is nonzero by
    // design (anti-stall: a battle must still end even against a faction
    // that holds every station).
    amount *= this.stationShieldFactor;
    this.hp = Math.max(0, this.hp - amount);
  }

  // ─── Service bubble ───────────────────────────────────────────────────────

  /**
   * True if world X/Z is inside this carrier's SERVICE bubble — a generous
   * radius (GameConfig.service.radius) around any launch bay's staging point,
   * i.e. the bow/bays on the contested front. A ship loitering here (the
   * caller also gates on speed) repairs + rearms over time, and jump arrivals
   * drop in here at zero velocity (docs/JUMP-DRIVE-AND-RESUPPLY.md). No
   * allocation — inlines the bay→world rotation like getLaunchStartPosition.
   */
  serviceZoneContains(x: number, z: number): boolean {
    const r = GameConfig.service.radius;
    const r2 = r * r;
    const sin = Math.sin(this.rotationY);
    const cos = Math.cos(this.rotationY);
    for (const bay of this.launchBays()) {
      const bx = this.position.x + cos * bay.x + sin * bay.z;
      const bz = this.position.z - sin * bay.x + cos * bay.z;
      const dx = x - bx;
      const dz = z - bz;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  }

  // ─── Launch geometry ──────────────────────────────────────────────────────

  /**
   * Records the launch geometry the view read off the loaded GLB: bay offsets
   * (carrier-LOCAL x/z, from the `launch.*` empties) and the bow-clearing exit
   * distance (from the model's forward extent). Either may be null — the
   * query helpers keep their GameConfig procedural fallback for whichever the
   * model didn't author. The headless sim never calls this (no GLB), so it
   * runs on the config bays exactly as the browser does pre-model-load.
   */
  setModelLaunchData(
    bays: ReadonlyArray<{ x: number; z: number }> | null,
    exitDistance: number | null,
  ): void {
    if (bays && bays.length > 0) this.modelLaunchBays = bays;
    if (exitDistance !== null && Number.isFinite(exitDistance)) {
      this.modelExitDistance = exitDistance;
    }
  }

  /**
   * Re-seats the turrets on the mount points the view read off the loaded
   * carrier GLB's `turret.*` empties (carrier-LOCAL x/y/z — the launch-bay
   * pattern, but with Y kept: the empty's height drives where bolts spawn and
   * therefore how steeply turret fire slopes down onto the Y=0 fighter plane;
   * an empty AT deck level ⇒ velocityY ≈ 0 ⇒ flat bolts). Repositions the
   * EXISTING Turret objects in place (they're already registered by reference
   * as DamageTargets on the opposing weapons), so this must not rebuild the
   * array. Extra empties beyond the config mount count are ignored — the
   * turret COUNT is a balance knob that must match headless (the server has
   * no GLB); re-fit GameConfig.mothership.turrets.mounts from
   * `node scripts/measure-carrier-footprint.mjs` after re-exporting a model.
   * Per-mount restAngle/arcHalf keep their config values (uniform today).
   */
  setModelTurretMounts(
    mounts: ReadonlyArray<{ x: number; y: number; z: number }> | null,
  ): void {
    if (!mounts || mounts.length === 0) return;
    const sin = Math.sin(this.rotationY);
    const cos = Math.cos(this.rotationY);
    const n = Math.min(mounts.length, this.turrets.length);
    for (let i = 0; i < n; i++) {
      const m = mounts[i];
      this.turrets[i].setMountPosition(
        this.position.x + cos * m.x + sin * m.z,
        this.position.y + m.y,
        this.position.z - sin * m.x + cos * m.z,
      );
    }
  }

  /**
   * Re-seats the subsystems of one kind on the mount points the view read off
   * the loaded carrier GLB's empties (a future `hangar.*` seam —
   * carrier-LOCAL x/y/z, the setModelTurretMounts recipe exactly). Repositions
   * the EXISTING MothershipSubsystem objects in place (they're registered by
   * reference as DamageTargets on the opposing weapons); extra empties beyond
   * the config mount count are ignored — the subsystem COUNT is a balance
   * knob that must match headless (the server has no GLB, it collides at
   * GameConfig.mothership.subsystems mounts). When empties are authored,
   * re-fit the config mounts to match so server and client agree.
   */
  setModelSubsystemMounts(
    kind: SubsystemKind,
    mounts: ReadonlyArray<{ x: number; y: number; z: number }> | null,
  ): void {
    if (!mounts || mounts.length === 0) return;
    const sin = Math.sin(this.rotationY);
    const cos = Math.cos(this.rotationY);
    const ofKind = this.subsystems.filter((s) => s.kind === kind);
    const n = Math.min(mounts.length, ofKind.length);
    for (let i = 0; i < n; i++) {
      const m = mounts[i];
      ofKind[i].setMountPosition(
        this.position.x + cos * m.x + sin * m.z,
        this.position.y + m.y,
        this.position.z - sin * m.x + cos * m.z,
      );
    }
  }

  /**
   * Launch-bay offsets (carrier-LOCAL x/z): the GLB's `launch.*` empties once
   * the model has loaded, else the GameConfig procedural-fallback positions.
   */
  private launchBays(): ReadonlyArray<{ x: number; z: number }> {
    return this.modelLaunchBays ?? GameConfig.mothership.launchBays;
  }

  /** How many catapult launch bays (tubes) this carrier has. */
  getLaunchBayCount(): number {
    return this.launchBays().length;
  }

  /**
   * World-space start position inside launch bay `bayIndex` (wraps if it runs
   * past the available bays). Y is forced to 0 so the fighter sits on the
   * gameplay plane. Works for either carrier — the local bay offset is rotated
   * by the carrier's facing. Bay positions come from the model's `launch.*`
   * empties (else GameConfig.mothership.launchBays); see launchBays().
   */
  getLaunchStartPosition(bayIndex = 0): Vector3 {
    const bays = this.launchBays();
    const bay = bays[bayIndex % bays.length];
    const sin = Math.sin(this.rotationY);
    const cos = Math.cos(this.rotationY);
    return new Vector3(
      this.position.x + cos * bay.x + sin * bay.z,
      0,
      this.position.z - sin * bay.x + cos * bay.z,
    );
  }

  /**
   * World-space JUMP-ARRIVAL point for bay `bayIndex`: the bay's staging
   * coordinate pushed OUTBOARD (away from the keel) until it clears every
   * hull collider box by GameConfig.jump.arrivalClearance. The raw staging
   * point sits inside the solid hull (fine for catapult launches, which
   * suspend the keep-out — see BattleSim.resolveMothershipCollisions), but a
   * jump arrival is unprotected: teleporting there wedged the ship between
   * overlapping colliders. INVARIANT: the cleared point must stay inside the
   * service bubble (service.radius around the bay) so an arrival still gets
   * serviced, per docs/JUMP-DRIVE-AND-RESUPPLY.md ("arrive stopped in the
   * bubble"); both carriers clear within ~20 units, radius is 40. Computed on
   * demand (jumps are rare) — no cache to go stale when setModelLaunchData
   * refines the bays off the loaded GLB. Y forced to 0 like
   * getLaunchStartPosition.
   */
  getJumpArrivalPosition(bayIndex = 0): Vector3 {
    const bays = this.launchBays();
    const bay = bays[bayIndex % bays.length];
    const sin = Math.sin(this.rotationY);
    const cos = Math.cos(this.rotationY);
    // Outboard = the bay's side of the keel, in carrier-local ±x rotated to
    // world (a centerline bay defaults starboard).
    const side = bay.x < 0 ? -1 : 1;
    const outX = cos * side;
    const outZ = -sin * side;
    const clearance = GameConfig.jump.arrivalClearance;
    const step = 2;
    const maxSteps = 64;
    let x = this.position.x + cos * bay.x + sin * bay.z;
    let z = this.position.z - sin * bay.x + cos * bay.z;
    for (let i = 0; i <= maxSteps; i++) {
      let clear = true;
      for (const s of this.hullSections) {
        if (
          x >= s.minX - clearance &&
          x <= s.maxX + clearance &&
          z >= s.minZ - clearance &&
          z <= s.maxZ + clearance
        ) {
          clear = false;
          break;
        }
      }
      if (clear) return new Vector3(x, 0, z);
      x += outX * step;
      z += outZ * step;
    }
    // Paranoia fallback: the catapult exit point, which the hullRects/colliders
    // invariant already guarantees is outside the keep-out.
    const fwd = this.getLaunchForward();
    const exit = this.getLaunchExitDistance();
    return new Vector3(
      this.position.x + fwd.x * exit,
      0,
      this.position.z + fwd.z * exit,
    );
  }

  /**
   * Unit forward direction (world X/Z) the catapult fires along — the carrier's
   * facing. Humans (rotationY=0) launch toward +Z; machines (rotationY=π) toward
   * -Z. Pairs with getLaunchExitDistance() so the launch works for either side.
   */
  getLaunchForward(): { x: number; z: number } {
    return { x: Math.sin(this.rotationY), z: Math.cos(this.rotationY) };
  }

  /**
   * Distance (world units) along the launch-forward axis, measured from the
   * carrier center, that a fighter must travel to fully clear the bow.
   */
  getLaunchExitDistance(): number {
    // From the model's measured forward extent once loaded; else the procedural
    // hull: bridge cap overhangs to roughly localZ = +148, plus a margin.
    return this.modelExitDistance ?? Mothership.HULL_HALF_DEPTH + 25;
  }
}
