import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Registers MeshBuilder.CreateRibbon (the bolt body — opt-in to tree-shaking).
import "@babylonjs/core/Meshes/Builders/ribbonBuilder";

import { GameConfig } from "@space-duel/shared";
import { LightningBolt } from "./LightningBolt";
import type { StormClouds } from "./StormClouds";

/**
 * Procedural lightning inside the ion storms (GameConfig.stormFx.bolt).
 * Two spawn paths:
 *
 *  - AMBIENT: each storm zone rolls a random interval and cracks a bolt
 *    between two random points inside its cloud — the storm is alive even
 *    when nobody is in it (and warns the player off before the first zap).
 *  - STRIKE: `strikeShip(ship)` — wired to the stormZap SimEvent — cracks a
 *    bolt from the cloud layer down onto the zapped ship, tying the damage
 *    tick to a visible cause.
 *
 * Every bolt also `pop()`s its zone in StormClouds so the cloud flashes from
 * within. Geometry is a jagged ribbon lying mostly in the XZ plane (the
 * camera is top-down; a plan-view zigzag reads, a vertical hairline doesn't),
 * one fresh mesh + material per bolt disposed on expiry — bolts are brief and
 * ~1/sec across the field, the JumpFlashSystem allocation pattern. View-only:
 * Math.random throughout (the sim RNG stays reserved for the sim).
 */
export class LightningSystem {
  private readonly active: LightningBolt[] = [];
  /** Per-zone countdown (sec) to the next ambient bolt. */
  private readonly nextAmbientSec: number[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly glowLayer: GlowLayer,
    private readonly clouds: StormClouds,
  ) {
    for (let i = 0; i < clouds.zones.length; i++) {
      this.nextAmbientSec.push(this.rollInterval());
    }
  }

  /** Crack a bolt from the cloud layer down onto a zapped ship's position
   *  (any pose source — the offline Ship or a networked stub). */
  strike(position: { x: number; y: number; z: number }): void {
    const zones = this.clouds.zones;
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      const dx = position.x - zone.x;
      const dz = position.z - zone.z;
      if (dx * dx + dz * dz > zone.radius * zone.radius) continue;
      // Strike origin: up in the cloud layer, offset sideways from the ship
      // so the bolt slants — a slanted bolt reads from the top-down camera
      // where a plumb-vertical one is seen end-on and vanishes.
      const angle = Math.random() * Math.PI * 2;
      const reach = 10 + Math.random() * 14;
      const from = new Vector3(
        position.x + Math.cos(angle) * reach,
        GameConfig.stormFx.yLevel,
        position.z + Math.sin(angle) * reach,
      );
      const to = new Vector3(position.x, position.y + 0.5, position.z);
      this.spawnBolt(from, to);
      this.clouds.pop(i);
      return;
    }
  }

  update(deltaSeconds: number, deltaMs: number): void {
    // Ambient bolts, per zone on independent random cadences.
    const zones = this.clouds.zones;
    for (let i = 0; i < zones.length; i++) {
      this.nextAmbientSec[i] -= deltaSeconds;
      if (this.nextAmbientSec[i] > 0) continue;
      this.nextAmbientSec[i] = this.rollInterval();
      this.spawnAmbient(i);
    }
    // Age out live bolts.
    for (const b of this.active) b.update(deltaMs);
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].isExpired) {
        this.active[i].dispose();
        this.active.splice(i, 1);
      }
    }
  }

  private rollInterval(): number {
    const cfg = GameConfig.stormFx.bolt;
    return (
      cfg.ambientIntervalMinSec +
      Math.random() * (cfg.ambientIntervalMaxSec - cfg.ambientIntervalMinSec)
    );
  }

  /** A bolt between two random points inside zone i's cloud. */
  private spawnAmbient(zoneIndex: number): void {
    const zone = this.clouds.zones[zoneIndex];
    const y = GameConfig.stormFx.yLevel;
    const a = this.randomPointInZone(zone.x, zone.z, zone.radius * 0.75, y);
    const b = this.randomPointInZone(zone.x, zone.z, zone.radius * 0.75, y);
    // Degenerate roll (both points together) just makes a stubby flash — fine.
    this.spawnBolt(a, b);
    this.clouds.pop(zoneIndex);
  }

  private randomPointInZone(cx: number, cz: number, radius: number, y: number): Vector3 {
    // sqrt for area-uniform sampling (plain r would clump at the center).
    const r = Math.sqrt(Math.random()) * radius;
    const angle = Math.random() * Math.PI * 2;
    return new Vector3(cx + Math.cos(angle) * r, y, cz + Math.sin(angle) * r);
  }

  /** Build one jagged emissive ribbon from `from` to `to` and set it live. */
  private spawnBolt(from: Vector3, to: Vector3): void {
    const cfg = GameConfig.stormFx.bolt;

    // Jagged polyline: endpoints fixed, interior points jittered sideways
    // with a sin(πt) envelope so the middle wanders and the ends anchor.
    const dir = to.subtract(from);
    const length = dir.length();
    // Sideways = horizontal perpendicular of the XZ heading (the camera looks
    // straight down, so only XZ zigzag reads). Near-vertical bolts fall back
    // to +X so the perp never degenerates.
    const xzLen = Math.hypot(dir.x, dir.z);
    const perp =
      xzLen > 0.001
        ? new Vector3(-dir.z / xzLen, 0, dir.x / xzLen)
        : new Vector3(1, 0, 0);
    const pointCount = cfg.segments + 2;
    const points: Vector3[] = [];
    for (let i = 0; i < pointCount; i++) {
      const t = i / (pointCount - 1);
      const p = Vector3.Lerp(from, to, t);
      const envelope = Math.sin(Math.PI * t);
      const offset = (Math.random() * 2 - 1) * cfg.jaggedness * length * envelope;
      points.push(p.add(perp.scale(offset)));
    }

    // Ribbon body: the polyline extruded ±width/2 along the same horizontal
    // perp — a flat glowing strip facing the top-down camera.
    const half = perp.scale(cfg.width / 2);
    const left = points.map((p) => p.add(half));
    const right = points.map((p) => p.subtract(half));
    const mesh = MeshBuilder.CreateRibbon(
      "lightning_bolt",
      { pathArray: [left, right] },
      this.scene,
    );
    mesh.isPickable = false;

    const mat = new StandardMaterial("lightning_bolt_mat", this.scene);
    mat.emissiveColor = new Color3(cfg.color.r, cfg.color.g, cfg.color.b);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mesh.material = mat;
    this.glowLayer.addIncludedOnlyMesh(mesh);

    this.active.push(new LightningBolt(mesh, cfg.durationMs));
  }
}
