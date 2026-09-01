import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Constants } from "@babylonjs/core/Engines/constants";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
// Plane builder registration — every flash renders as a billboarded flare
// plane (soft radial sprite), not a sphere.
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import { GameConfig } from "@space-duel/shared";
import { Explosion, type Debris } from "./Explosion";
import { BurnFX } from "./BurnFX";
import { createFlareTexture } from "./FlareTexture";
import { includeInGlow } from "./GlowInclude";

/**
 * The knobs one spark burst reads — GameConfig.impactSpark itself (the
 * fighter-scale default) or a sub-profile like impactSpark.hangar (the
 * carrier-scale hangar-bay burn).
 */
type SparkProfile = {
  countMin: number;
  countMax: number;
  durationMs: number;
  durationJitter: number;
  speedMin: number;
  speedMax: number;
  size: number;
  sizeVarMin: number;
  sizeVarMax: number;
  flashRadius: number;
  flashPeakMin: number;
  flashPeakMax: number;
  /**
   * Optional per-sliver emissive palette (fire mix: white/yellow/orange/red).
   * Absent = every sliver uses the stock white-gold spark material.
   */
  palette?: ReadonlyArray<{ r: number; g: number; b: number }>;
};

/**
 * Spawns and ticks short-lived explosion effects. Shared materials are
 * reused across every explosion; every FLASH is a camera-facing plane
 * carrying the shared procedural flare sprite (FlareTexture.ts), blended
 * additively — a soft glow that pops and fades, not a hard expanding circle.
 *
 * GlowLayer is opt-in per mesh: each new debris piece joins it on spawn
 * (via includeInGlow, which also removes the mesh from the include list on
 * dispose — Babylon does NOT prune disposed ids itself, and sparks spawn on
 * every laser hit, so direct adds leak the list unboundedly). Flare planes
 * deliberately stay OUT of the glow layer: the sprite's gradient IS the
 * glow falloff, and the layer would re-bloom the plane's square silhouette.
 */
export class ExplosionSystem {
  private readonly active: Explosion[] = [];
  /** Shared soft radial sprite behind every flare + the BurnFX particles. */
  private readonly flareTexture: DynamicTexture;
  private readonly flashMat: StandardMaterial;
  /** Hot-orange flash for turret muzzle pops (spawnMuzzleFlash). */
  private readonly muzzleFlashMat: StandardMaterial;
  /** Hot white-gold glint for impact-spark flashes (spawnSpark). */
  private readonly sparkMat: StandardMaterial;
  /** Opaque white-gold emissive for the burst's streak slivers. */
  private readonly streakMat: StandardMaterial;
  /**
   * Materials for palette-bearing spark profiles (the hangar/turret fire
   * burn), one per palette color, built lazily and cached by palette
   * reference — config palettes are stable arrays, so this stays tiny.
   */
  private readonly paletteMats = new Map<object, StandardMaterial[]>();
  /**
   * Ember pops scheduled onto flying breakup pieces: when a countdown
   * expires, a small fire-palette spark burst fires at the piece's current
   * position (a chunk cooking off mid-flight). The piece mesh is owned by
   * its Explosion — a disposed mesh just skips its ember.
   */
  private readonly pendingEmbers: { delayMs: number; mesh: Mesh }[] = [];
  /**
   * Secondary explosions scheduled around a kill (spawnShipBreakup): fixed
   * points near the death center where fire-palette pops fire after a
   * rolled delay — the hull cooking off after the main flash.
   */
  private readonly pendingSecondaries: {
    delayMs: number;
    position: Vector3;
  }[] = [];
  // Scratch for spawnShipBreakup's world-transform bake (death-time only,
  // but kept off the per-piece loop all the same).
  private readonly scratchScale = new Vector3();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchPos = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly glowLayer: GlowLayer,
  ) {
    this.flareTexture = createFlareTexture(scene);

    // Flash: nearly white flare, > 1 emissive components so the core burns hot.
    this.flashMat = this.makeFlareMat("explosion_flash_mat", 2.5, 2.0, 1.2);

    // Muzzle flash: hot orange, tinted to match the turret bolt (config-driven).
    const mf = GameConfig.mothership.turrets.muzzleFlash.color;
    this.muzzleFlashMat = this.makeFlareMat(
      "turret_muzzle_flash_mat",
      mf.r,
      mf.g,
      mf.b,
    );

    // Spark flash: hot white-gold, brighter than debris so each burst's
    // flash punches as a glint rather than reading as a tiny ember.
    this.sparkMat = this.makeFlareMat("impact_spark_mat", 3.0, 2.6, 1.6);

    // Spark streaks: the same white-gold as an OPAQUE emissive — streak
    // boxes can't wear the flare material (its sprite/alpha belong on a
    // camera-facing plane, not a stretched box).
    this.streakMat = new StandardMaterial("impact_streak_mat", scene);
    this.streakMat.diffuseColor = new Color3(0, 0, 0);
    this.streakMat.specularColor = new Color3(0, 0, 0);
    this.streakMat.emissiveColor = new Color3(3.0, 2.6, 1.6);
    this.streakMat.disableLighting = true;
  }

  /**
   * An unlit ADDITIVE flare material: the shared radial sprite through the
   * emissive channel, tinted by the emissive color (sprite is white-core so
   * the tint owns the hue), its alpha gradient fading the added light to
   * nothing at the rim.
   */
  private makeFlareMat(
    name: string,
    r: number,
    g: number,
    b: number,
  ): StandardMaterial {
    const mat = new StandardMaterial(name, this.scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(r, g, b);
    mat.emissiveTexture = this.flareTexture;
    mat.opacityTexture = this.flareTexture;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    return mat;
  }

  /**
   * A persistent burn-site fire (destroyed hangar bay, dead turret) sharing
   * this system's flare sprite. Caller owns the lifecycle (start/stop/
   * dispose); `scale` shrinks the carrier-scale GameConfig.burnFx profile
   * for smaller sites.
   */
  createBurnFX(scale = 1): BurnFX {
    return new BurnFX(this.scene, this.flareTexture, scale);
  }

  /**
   * A camera-facing flare plane — the flash of every explosion/spark/muzzle
   * pop. `radius` matches the old flash-sphere radius; the plane is oversized
   * by explosion.flareSizeFactor because the sprite's visible hot core is
   * only ~half the quad. NOT added to the glow layer (see class doc).
   */
  private createFlare(
    name: string,
    radius: number,
    material: StandardMaterial,
    position: Vector3,
  ): Mesh {
    const flare = MeshBuilder.CreatePlane(
      name,
      { size: radius * 2 * GameConfig.explosion.flareSizeFactor },
      this.scene,
    );
    flare.billboardMode = Mesh.BILLBOARDMODE_ALL;
    flare.position.copyFrom(position);
    flare.material = material;
    flare.isPickable = false;
    return flare;
  }

  /**
   * A spark burst at a point of impact — a flash plus fast slivers that fly
   * out and shrink. Wired off every laserHit so an impact reads on the hull
   * surface, not just via the ship's damage flash. Reuses the Explosion
   * entity (same tween + dispose) at a fraction of a kill's scale.
   *
   * `cfg` selects the spark PROFILE: default is the subtle fighter-scale
   * `GameConfig.impactSpark`; the hangar-bay damage FX passes
   * `impactSpark.hangar` (carrier-scale slivers/flash/spray) instead.
   */
  spawnSpark(position: Vector3, cfg: SparkProfile = GameConfig.impactSpark): void {
    // Roll the burst's shape so no two impacts look stamped from one mold:
    // count, flash punch, and lifetime all vary per hit.
    const count =
      cfg.countMin +
      Math.floor(Math.random() * (cfg.countMax - cfg.countMin + 1));
    const flashPeak =
      cfg.flashPeakMin +
      Math.random() * (cfg.flashPeakMax - cfg.flashPeakMin);
    const duration =
      cfg.durationMs * (1 + (Math.random() * 2 - 1) * cfg.durationJitter);

    const flash = this.createFlare(
      "impact_spark_flash",
      cfg.flashRadius,
      this.sparkMat,
      position,
    );

    // Give the slivers a random base bearing so the spray isn't anchored to a
    // fixed axis, then scatter each one freely around the disc from there.
    const baseAngle = Math.random() * Math.PI * 2;
    const fireMats = cfg.palette ? this.matsForPalette(cfg.palette) : null;
    const debris: Debris[] = [];
    for (let i = 0; i < count; i++) {
      // Per-sliver size: a burst mixes fine glints with chunkier flecks.
      const sliverSize =
        cfg.size *
        (cfg.sizeVarMin + Math.random() * (cfg.sizeVarMax - cfg.sizeVarMin));
      // Streak geometry: a filament along +Z, oriented to the fling
      // direction below — reads as a spark ARC, not a tumbling square.
      const mesh = MeshBuilder.CreateBox(
        `impact_spark_${i}`,
        {
          width: sliverSize * 0.16,
          height: sliverSize * 0.16,
          depth: sliverSize * 3.2,
        },
        this.scene,
      );
      mesh.position.copyFrom(position);
      // Fire profiles roll each sliver's color from the palette; the stock
      // profile keeps the single white-gold glint. The palette materials are
      // opaque emissives — only these debris meshes join the glow layer.
      mesh.material = fireMats
        ? fireMats[Math.floor(Math.random() * fireMats.length)]
        : this.streakMat;
      mesh.isPickable = false;
      includeInGlow(this.glowLayer, mesh);

      // Slivers spray outward in the X/Z plane with a small vertical kick.
      const angle = baseAngle + Math.random() * Math.PI * 2;
      const speed =
        cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin);
      const velocity = new Vector3(
        Math.cos(angle) * speed,
        (Math.random() - 0.3) * 6,
        Math.sin(angle) * speed,
      );
      // Align the streak's long axis with its velocity and hold that line
      // (no tumble) — a spark traces its own trajectory.
      mesh.rotation.y = Math.atan2(velocity.x, velocity.z);
      mesh.rotation.x = -Math.atan2(
        velocity.y,
        Math.hypot(velocity.x, velocity.z),
      );
      debris.push({ mesh, velocity, rotationVel: Vector3.Zero() });
    }

    this.active.push(new Explosion(flash, debris, duration, flashPeak));
  }

  /** Lazily build (and cache) one unlit emissive material per palette color. */
  private matsForPalette(
    palette: ReadonlyArray<{ r: number; g: number; b: number }>,
  ): StandardMaterial[] {
    let mats = this.paletteMats.get(palette);
    if (!mats) {
      mats = palette.map((c, i) => {
        const mat = new StandardMaterial(`spark_palette_${i}`, this.scene);
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.specularColor = new Color3(0, 0, 0);
        mat.emissiveColor = new Color3(c.r, c.g, c.b);
        mat.disableLighting = true;
        return mat;
      });
      this.paletteMats.set(palette, mats);
    }
    return mats;
  }

  /**
   * A brief, debris-less flash sphere at a carrier turret's fire point — the
   * muzzle pop wired off the turretFired sim event. Reuses the Explosion entity
   * (flash-only: empty debris list) so it tweens + disposes like any other.
   */
  spawnMuzzleFlash(position: Vector3): void {
    const cfg = GameConfig.mothership.turrets.muzzleFlash;
    const flash = this.createFlare(
      "turret_muzzle_flash",
      cfg.radius,
      this.muzzleFlashMat,
      position,
    );
    this.active.push(new Explosion(flash, [], cfg.durationMs, cfg.peakScale));
  }

  spawn(position: Vector3): void {
    const cfg = GameConfig.explosion;

    const flash = this.createFlare(
      "explosion_flash",
      cfg.flashRadius,
      this.flashMat,
      position,
    );

    const fireMats = this.matsForPalette(cfg.debrisPalette);
    const debris: Debris[] = [];
    for (let i = 0; i < cfg.debrisCount; i++) {
      // Per-piece size + fire color: the burst mixes fine white-hot embers
      // with chunky deep-red fragments instead of uniform orange cubes.
      const size =
        cfg.debrisSize *
        (cfg.debrisSizeVarMin +
          Math.random() * (cfg.debrisSizeVarMax - cfg.debrisSizeVarMin));
      const mesh = MeshBuilder.CreateBox(
        `explosion_debris_${i}`,
        { size },
        this.scene,
      );
      mesh.position.copyFrom(position);
      mesh.material = fireMats[Math.floor(Math.random() * fireMats.length)];
      mesh.isPickable = false;
      includeInGlow(this.glowLayer, mesh);

      // Spread outward in a roughly disc-shaped pattern on the X/Z plane,
      // with a small vertical kick for visual depth.
      const angle = (i / cfg.debrisCount) * Math.PI * 2 + Math.random() * 0.4;
      const speed =
        cfg.debrisSpeedMin +
        Math.random() * (cfg.debrisSpeedMax - cfg.debrisSpeedMin);
      const velocity = new Vector3(
        Math.cos(angle) * speed,
        (Math.random() - 0.4) * 4,
        Math.sin(angle) * speed,
      );
      const rotationVel = new Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      );
      debris.push({ mesh, velocity, rotationVel });
    }

    this.active.push(
      new Explosion(flash, debris, cfg.durationMs, cfg.flashPeakScale),
    );
  }

  /**
   * The dying ship comes APART: its larger hull meshes are cloned (clones
   * share geometry + materials — no new buffers), unparented at their exact
   * world pose, and flung outward with the ship's momentum, tumbling and
   * shrinking away as breakup debris. Fired alongside the stock kill flash
   * (`spawn()`), which still carries the light; this carries the wreckage.
   *
   * `shipRoot` is the ship's VIEW root (still holding its last rendered
   * pose — a dead view is disabled, not moved); `center` is the sim's death
   * position, which the pieces are re-anchored on since the rendered pose
   * can trail the sim by a frame offline or an interpolation beat online.
   */
  spawnShipBreakup(
    shipRoot: TransformNode,
    center: Vector3,
    velocity: { x: number; z: number },
  ): void {
    const cfg = GameConfig.explosion.breakup;

    // Schedule the kill's secondary explosions FIRST (before the piece scan
    // can early-return): staggered fire pops scattered around the death
    // point, so every kill rolls into a short chain of blasts rather than
    // one beat. Positions drift with a fraction of the ship's momentum so
    // the chain trails the wreck instead of popping behind it.
    const sec = cfg.secondaries;
    for (let i = 0; i < sec.count; i++) {
      const delayMs = sec.delayMinMs + Math.random() * (sec.delayMaxMs - sec.delayMinMs);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * sec.spreadRadius;
      const drift = cfg.inheritVelocityFactor * (delayMs / 1000);
      this.pendingSecondaries.push({
        delayMs,
        position: new Vector3(
          center.x + Math.cos(a) * r + velocity.x * drift,
          center.y,
          center.z + Math.sin(a) * r + velocity.z * drift,
        ),
      });
    }

    // Candidate pieces: real hull geometry only. The FX meshes riding the
    // ship root (damage-flash shell, engine/RCS glow cores + plumes) are
    // excluded by name — cloning those would fling invisible spheres that
    // light up whenever their shared material animates.
    const fxMesh = /damage_flash|engine_core|engine_trail|_core$|_plume$/i;
    const parts: { mesh: Mesh; volume: number }[] = [];
    for (const m of shipRoot.getChildMeshes(false)) {
      if (!(m instanceof Mesh)) continue;
      if (m.getTotalVertices() === 0) continue;
      if (fxMesh.test(m.name)) continue;
      m.computeWorldMatrix(true);
      const half = m.getBoundingInfo().boundingBox.extendSizeWorld;
      parts.push({ mesh: m, volume: half.x * half.y * half.z });
    }
    if (parts.length === 0) return;

    // Fling the biggest pieces (wings, nacelles, hull), skip the trim.
    parts.sort((a, b) => b.volume - a.volume);
    const minVolume = parts[0].volume * cfg.minVolumeRatio;
    const picked = parts
      .slice(0, cfg.maxPieces)
      .filter((p) => p.volume >= minVolume);

    // Union bounds of EVERY candidate part = the ship's whole envelope. A
    // picked piece spanning most of it IS the intact ship (material-shell
    // GLBs like the Spitfire and Wraith come through as a few overlapping,
    // full-ship meshes). Flinging that clone reads as the whole ship tumbling
    // away, so its actual triangles are divided into hull sections below.
    let unionVolume = 0;
    {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const p of parts) {
        const bb = p.mesh.getBoundingInfo().boundingBox;
        minX = Math.min(minX, bb.minimumWorld.x);
        minY = Math.min(minY, bb.minimumWorld.y);
        minZ = Math.min(minZ, bb.minimumWorld.z);
        maxX = Math.max(maxX, bb.maximumWorld.x);
        maxY = Math.max(maxY, bb.maximumWorld.y);
        maxZ = Math.max(maxZ, bb.maximumWorld.z);
      }
      unionVolume =
        ((maxX - minX) / 2) * ((maxY - minY) / 2) * ((maxZ - minZ) / 2);
    }

    // Re-anchor on the sim death position (see method doc).
    shipRoot.computeWorldMatrix(true);
    const rootPos = shipRoot.getAbsolutePosition();
    const offsetX = center.x - rootPos.x;
    const offsetZ = center.z - rootPos.z;

    const debris: Debris[] = [];
    // Fracture budget: fragmentCount is a per-KILL total, split across every
    // qualifying material shell proportionally to volume. Each fragment is
    // made from the source mesh's real triangles, so an outboard sector still
    // reads as a wing instead of the old random-box fallback.
    const shattering = picked.filter(
      (p) => p.volume >= cfg.shatter.wholeShipRatio * unionVolume,
    );
    const shatterVolume = shattering.reduce((sum, p) => sum + p.volume, 0);
    for (const { mesh, volume } of picked) {
      if (volume >= cfg.shatter.wholeShipRatio * unionVolume) {
        const share = Math.max(
          1,
          Math.round(cfg.shatter.fragmentCount * (volume / shatterVolume)),
        );
        this.fracturePiece(
          mesh,
          center,
          offsetX,
          offsetZ,
          velocity,
          share,
          debris,
        );
        continue;
      }
      const clone = mesh.clone(`breakup_${mesh.name}`, null, true);
      clone.parent = null;
      // Bake the piece's WORLD transform into the clone's local one: the
      // source sits under rotated/scaled correction nodes (two-tier root,
      // glTF mirror), all of which the unparented clone must carry itself.
      mesh
        .getWorldMatrix()
        .decompose(this.scratchScale, this.scratchQuat, this.scratchPos);
      clone.position.set(
        this.scratchPos.x + offsetX,
        this.scratchPos.y,
        this.scratchPos.z + offsetZ,
      );
      // Euler, not quaternion: the debris tumble integrates mesh.rotation,
      // which Babylon ignores while rotationQuaternion is set.
      clone.rotationQuaternion = null;
      clone.rotation = this.scratchQuat.toEulerAngles();
      clone.scaling.copyFrom(this.scratchScale);
      clone.setEnabled(true);
      clone.isPickable = false;

      const fling = this.rollFling(
        clone.position.x,
        clone.position.z,
        center,
        velocity,
      );
      debris.push({
        mesh: clone,
        velocity: fling.velocity,
        rotationVel: fling.rotationVel,
        baseScaling: clone.scaling.clone(),
      });
    }
    if (debris.length === 0) return;

    // A couple of pieces cook off mid-flight: schedule small fire-palette
    // ember bursts at random beats of the scatter.
    for (let i = 0; i < Math.min(cfg.emberCount, debris.length); i++) {
      const frac =
        cfg.emberDelayMinFraction +
        Math.random() *
          (cfg.emberDelayMaxFraction - cfg.emberDelayMinFraction);
      this.pendingEmbers.push({
        delayMs: cfg.durationMs * frac,
        mesh: debris[Math.floor(Math.random() * debris.length)].mesh,
      });
    }

    // Flash-less: spawn()'s flare already carries the kill's light.
    this.active.push(
      new Explosion(null, debris, cfg.durationMs, 0, cfg.holdFraction),
    );
  }

  /**
   * The breakup fling recipe: inherited ship momentum + a radial kick away
   * from the death center (a centered piece kicks a random way) + vertical
   * scatter + tumble. Shared by real hull-piece clones and shatter fragments.
   */
  private rollFling(
    px: number,
    pz: number,
    center: Vector3,
    velocity: { x: number; z: number },
  ): { velocity: Vector3; rotationVel: Vector3 } {
    const cfg = GameConfig.explosion.breakup;
    let dirX = px - center.x;
    let dirZ = pz - center.z;
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-3) {
      dirX /= len;
      dirZ /= len;
    } else {
      const a = Math.random() * Math.PI * 2;
      dirX = Math.cos(a);
      dirZ = Math.sin(a);
    }
    const speed = cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin);
    return {
      velocity: new Vector3(
        velocity.x * cfg.inheritVelocityFactor + dirX * speed,
        (Math.random() - 0.35) * cfg.verticalKick,
        velocity.z * cfg.inheritVelocityFactor + dirZ * speed,
      ),
      rotationVel: new Vector3(
        (Math.random() - 0.5) * 2 * cfg.tumbleMax,
        (Math.random() - 0.5) * 2 * cfg.tumbleMax,
        (Math.random() - 0.5) * 2 * cfg.tumbleMax,
      ),
    };
  }

  /**
   * The material-shell fallback (`breakup.shatter`): divide a mesh that spans
   * the whole ship into angular sectors around its local X/Z center. Those
   * sectors retain the source's actual vertices, UVs, normals, material, and
   * silhouette; the port/starboard sectors therefore look like torn-off
   * wings rather than anonymous boxes. Each section is recentered around its
   * own geometry so it tumbles naturally.
   *
   * `count` is this material shell's share of the per-kill fragment budget
   * (see the caller's split). A minimum of two sectors prevents a small shell
   * share from degenerating back into one intact tumbling ship.
   */
  private fracturePiece(
    source: Mesh,
    center: Vector3,
    offsetX: number,
    offsetZ: number,
    velocity: { x: number; z: number },
    count: number,
    out: Debris[],
  ): void {
    const s = GameConfig.explosion.breakup.shatter;
    const positions = source.getVerticesData(VertexBuffer.PositionKind);
    const sourceIndices = source.getIndices();
    if (!positions || positions.length < 9) return;

    // Babylon permits unindexed meshes; normalize both cases to triangle
    // indices so the grouping/copy path stays identical.
    const indices = sourceIndices
      ? Array.from(sourceIndices, Number)
      : Array.from({ length: positions.length / 3 }, (_, i) => i);
    const triangleCount = Math.floor(indices.length / 3);
    if (triangleCount === 0) return;

    const bb = source.getBoundingInfo().boundingBox;
    const localCenter = bb.center;
    const localExtent = bb.extendSize;
    const sectorCount = Math.min(
      triangleCount,
      s.maxFragmentsPerMesh,
      Math.max(2, count),
    );
    const sectors: number[][] = Array.from({ length: sectorCount }, () => []);

    // Offset sectors by half their width so +X/-X (the two wings in every
    // ship asset's authored frame) sit at the center of a sector rather than
    // on a split boundary. Normalize by footprint extents so a long narrow
    // fighter does not put nearly every triangle into its nose/tail sectors.
    for (let tri = 0; tri < triangleCount; tri++) {
      const ia = indices[tri * 3];
      const ib = indices[tri * 3 + 1];
      const ic = indices[tri * 3 + 2];
      const cx =
        (positions[ia * 3] + positions[ib * 3] + positions[ic * 3]) / 3;
      const cz =
        (positions[ia * 3 + 2] +
          positions[ib * 3 + 2] +
          positions[ic * 3 + 2]) /
        3;
      const nx = (cx - localCenter.x) / Math.max(localExtent.x, 1e-5);
      const nz = (cz - localCenter.z) / Math.max(localExtent.z, 1e-5);
      const angle = Math.atan2(nz, nx);
      const wrapped =
        (angle + Math.PI / sectorCount + Math.PI * 2) % (Math.PI * 2);
      const sector = Math.floor((wrapped / (Math.PI * 2)) * sectorCount);
      sectors[sector].push(ia, ib, ic);
    }

    source.computeWorldMatrix(true);
    for (let i = 0; i < sectors.length; i++) {
      const triangleIndices = sectors[i];
      if (triangleIndices.length / 3 < s.minFragmentTriangles) continue;
      const fragment = this.createMeshFragment(source, triangleIndices, i);
      if (!fragment) continue;
      const { mesh: frag, localCenter: fragmentCenter } = fragment;

      // The fragment geometry has been recentered locally. Transform that
      // center through the source's complete glTF/model/gameplay chain to
      // recover its exact world pose, then re-anchor it on the sim death.
      const worldCenter = Vector3.TransformCoordinates(
        fragmentCenter,
        source.getWorldMatrix(),
      );
      frag.position.set(
        worldCenter.x + offsetX,
        worldCenter.y,
        worldCenter.z + offsetZ,
      );
      source
        .getWorldMatrix()
        .decompose(this.scratchScale, this.scratchQuat, this.scratchPos);
      frag.rotationQuaternion = null;
      frag.rotation = this.scratchQuat.toEulerAngles();
      frag.scaling.copyFrom(this.scratchScale);
      frag.setEnabled(true);
      frag.isPickable = false;

      const fling = this.rollFling(
        frag.position.x,
        frag.position.z,
        center,
        velocity,
      );
      out.push({
        mesh: frag,
        velocity: fling.velocity,
        rotationVel: fling.rotationVel,
        baseScaling: frag.scaling.clone(),
      });
    }
  }

  /**
   * Copy selected source triangles into a standalone mesh while retaining all
   * available vertex streams (UVs, colors, tangents, etc.). Positions are
   * recentered around the section's own local bounds so subsequent rotation
   * tumbles the wreckage around the part rather than the original ship pivot.
   */
  private createMeshFragment(
    source: Mesh,
    triangleIndices: number[],
    fragmentIndex: number,
  ): { mesh: Mesh; localCenter: Vector3 } | null {
    const kinds = source.getVerticesDataKinds();
    const streams = new Map<string, { data: ArrayLike<number>; stride: number }>();
    for (const kind of kinds) {
      const data = source.getVerticesData(kind);
      const stride = source.getVertexBuffer(kind)?.getSize() ?? 0;
      if (data && stride > 0) streams.set(kind, { data, stride });
    }
    if (!streams.has(VertexBuffer.PositionKind)) return null;

    const copied = new Map<string, number[]>();
    for (const kind of streams.keys()) copied.set(kind, []);
    for (const sourceIndex of triangleIndices) {
      for (const [kind, stream] of streams) {
        const target = copied.get(kind)!;
        const start = sourceIndex * stream.stride;
        for (let c = 0; c < stream.stride; c++) {
          target.push(stream.data[start + c]);
        }
      }
    }

    const fragmentPositions = copied.get(VertexBuffer.PositionKind)!;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < fragmentPositions.length; i += 3) {
      minX = Math.min(minX, fragmentPositions[i]);
      minY = Math.min(minY, fragmentPositions[i + 1]);
      minZ = Math.min(minZ, fragmentPositions[i + 2]);
      maxX = Math.max(maxX, fragmentPositions[i]);
      maxY = Math.max(maxY, fragmentPositions[i + 1]);
      maxZ = Math.max(maxZ, fragmentPositions[i + 2]);
    }
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    for (let i = 0; i < fragmentPositions.length; i += 3) {
      fragmentPositions[i] -= centerX;
      fragmentPositions[i + 1] -= centerY;
      fragmentPositions[i + 2] -= centerZ;
    }

    const frag = new Mesh(
      `breakup_hull_${source.name}_${fragmentIndex}`,
      this.scene,
    );
    for (const [kind, data] of copied) {
      frag.setVerticesData(kind, data, false, streams.get(kind)!.stride);
    }
    frag.setIndices(
      Array.from({ length: triangleIndices.length }, (_, i) => i),
    );
    frag.material = source.material;
    frag.refreshBoundingInfo();
    return {
      mesh: frag,
      localCenter: new Vector3(centerX, centerY, centerZ),
    };
  }

  update(deltaSeconds: number, deltaMs: number): void {
    for (const e of this.active) {
      e.update(deltaSeconds, deltaMs);
    }
    // Due ember pops ride the flying breakup pieces (walked backwards for
    // the splice). Runs BEFORE the expiry sweep so an ember due this frame
    // still finds its piece; a piece disposed earlier just skips its pop.
    for (let i = this.pendingEmbers.length - 1; i >= 0; i--) {
      const ember = this.pendingEmbers[i];
      ember.delayMs -= deltaMs;
      if (ember.delayMs > 0) continue;
      if (!ember.mesh.isDisposed()) {
        this.spawnSpark(ember.mesh.position, {
          ...GameConfig.impactSpark,
          palette: GameConfig.explosion.breakup.emberPalette,
        });
      }
      this.pendingEmbers.splice(i, 1);
    }
    // Due secondary explosions (kill cook-off pops) fire at their pre-rolled
    // positions — each is a fire-palette spark burst with its own flash.
    for (let i = this.pendingSecondaries.length - 1; i >= 0; i--) {
      const secondary = this.pendingSecondaries[i];
      secondary.delayMs -= deltaMs;
      if (secondary.delayMs > 0) continue;
      this.spawnSpark(secondary.position, {
        ...GameConfig.explosion.breakup.secondaries.burst,
        palette: GameConfig.explosion.breakup.emberPalette,
      });
      this.pendingSecondaries.splice(i, 1);
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].isExpired) {
        this.active[i].dispose();
        this.active.splice(i, 1);
      }
    }
  }

  get count(): number {
    return this.active.length;
  }
}
