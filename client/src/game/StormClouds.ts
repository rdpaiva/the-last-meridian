import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
// Registers MeshBuilder.CreatePlane (planes are opt-in to tree-shaking).
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import { GameConfig } from "@space-duel/shared";
import type { ConcealmentZone } from "@space-duel/shared";
import { computeStormZones } from "@space-duel/shared";

/**
 * Ion-storm cloud VISUALS — the electric sibling of CombatNebulas, same
 * recipe (premultiplied cloud PNG through the emissive channel, COLOR from
 * emissiveColor — gotchas #9/#10) with two deliberate differences:
 *
 *  - ONE uniform blue-cyan tint for every storm (GameConfig.stormFx
 *    .cloudColor) instead of the stealth clouds' varied violet palette. A
 *    hazard needs one consistent color read: cyan hurts, violet hides.
 *  - A per-frame interior FLICKER: the emissive intensity shimmers slowly
 *    (a storm from orbit, lit from within) and `pop(i)` spikes it when
 *    LightningSystem cracks a bolt in zone i, then decays back — the cloud
 *    itself flashes with its lightning.
 *
 * The gameplay truth (damage, concealment, AI keep-out) lives in the shared
 * StormSystem; `zones` here is the same computeStormZones math, exported for
 * the radar. Zero configured zones builds nothing.
 */
export class StormClouds {
  /** World-space storm footprints (drawn on the radar; same math as the sim). */
  readonly zones: ConcealmentZone[];

  private readonly mats: StandardMaterial[] = [];
  /** Random per-zone phase offsets so the clouds don't shimmer in sync. */
  private readonly phases: Array<{ a: number; b: number }> = [];
  /** Per-zone lightning "pop" level, decaying toward 0 (see pop()). */
  private readonly pops: number[] = [];
  private timeSec = 0;

  // Different silhouettes, same tint — the texture only carries shape.
  // nebula-3-plum leads: it's otherwise unused, so the lead storm cloud
  // doesn't share a silhouette with any stealth nebula on the field.
  private static readonly TEXTURE_FILES = [
    "nebula-3-plum.png",
    "nebula-1-deep-purple.png",
    "nebula-2-violet-indigo.png",
  ];

  constructor(scene: Scene, arenaHalfWidth: number, arenaHalfDepth: number) {
    const fx = GameConfig.stormFx;
    this.zones = computeStormZones(arenaHalfWidth, arenaHalfDepth);

    this.zones.forEach((zone, i) => {
      const file = StormClouds.TEXTURE_FILES[i % StormClouds.TEXTURE_FILES.length];
      const tex = new Texture(`${import.meta.env.BASE_URL}textures/${file}`, scene);
      tex.hasAlpha = true;

      const mat = new StandardMaterial(`storm_cloud_${i}_mat`, scene);
      mat.emissiveTexture = tex;
      mat.opacityTexture = tex; // per-pixel opacity from the PNG's feathered alpha
      mat.emissiveColor = new Color3(fx.cloudColor.r, fx.cloudColor.g, fx.cloudColor.b);
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.specularColor = new Color3(0, 0, 0);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.alpha = fx.alpha;

      const quad = MeshBuilder.CreatePlane(
        `storm_cloud_${i}`,
        { size: zone.radius * fx.visualScale },
        scene,
      );
      quad.position = new Vector3(zone.x, fx.yLevel, zone.z);
      // Lie flat, normal +Y, facing the top-down camera.
      quad.rotation.x = -Math.PI / 2;
      // Vary the art's rotation so repeated textures don't read as copies.
      quad.rotation.z = i * 1.7;
      quad.material = mat;
      quad.isPickable = false;
      // Composite over engine trails / bolts beneath, like the stealth clouds.
      quad.alphaIndex = 200;

      this.mats.push(mat);
      // View-only randomness — the sim RNG stays reserved for the sim.
      this.phases.push({ a: Math.random() * Math.PI * 2, b: Math.random() * Math.PI * 2 });
      this.pops.push(0);
    });
  }

  /** Spike zone i's interior glow (a bolt just cracked inside it). */
  pop(zoneIndex: number): void {
    if (zoneIndex >= 0 && zoneIndex < this.pops.length) {
      this.pops[zoneIndex] = GameConfig.stormFx.popBoost;
    }
  }

  /** Animate the interior flicker: slow two-sine shimmer + decaying pops. */
  update(deltaSeconds: number): void {
    if (this.mats.length === 0) return;
    const fx = GameConfig.stormFx;
    this.timeSec += deltaSeconds;
    const t = this.timeSec * Math.PI * 2;
    const decay = Math.exp(-fx.popDecayRate * deltaSeconds);
    for (let i = 0; i < this.mats.length; i++) {
      this.pops[i] *= decay;
      const p = this.phases[i];
      // Two incommensurate frequencies read as organic wander, not a pulse.
      const shimmer =
        fx.shimmerAmplitude *
        (0.6 * Math.sin(t * 0.5 + p.a) + 0.4 * Math.sin(t * 1.3 + p.b));
      const intensity = 1 + shimmer + this.pops[i];
      this.mats[i].emissiveColor.set(
        fx.cloudColor.r * intensity,
        fx.cloudColor.g * intensity,
        fx.cloudColor.b * intensity,
      );
    }
  }
}
