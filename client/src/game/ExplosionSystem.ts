import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Constants } from "@babylonjs/core/Engines/constants";
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
  private readonly debrisMat: StandardMaterial;
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

  constructor(
    private readonly scene: Scene,
    private readonly glowLayer: GlowLayer,
  ) {
    this.flareTexture = createFlareTexture(scene);

    // Flash: nearly white flare, > 1 emissive components so the core burns hot.
    this.flashMat = this.makeFlareMat("explosion_flash_mat", 2.5, 2.0, 1.2);

    // Debris: warm orange.
    this.debrisMat = new StandardMaterial("explosion_debris_mat", scene);
    this.debrisMat.diffuseColor = new Color3(0, 0, 0);
    this.debrisMat.specularColor = new Color3(0, 0, 0);
    this.debrisMat.emissiveColor = new Color3(1.8, 0.6, 0.15);
    this.debrisMat.disableLighting = true;

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

    const debris: Debris[] = [];
    for (let i = 0; i < cfg.debrisCount; i++) {
      const mesh = MeshBuilder.CreateBox(
        `explosion_debris_${i}`,
        { size: cfg.debrisSize },
        this.scene,
      );
      mesh.position.copyFrom(position);
      mesh.material = this.debrisMat;
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

  update(deltaSeconds: number, deltaMs: number): void {
    for (const e of this.active) {
      e.update(deltaSeconds, deltaMs);
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
