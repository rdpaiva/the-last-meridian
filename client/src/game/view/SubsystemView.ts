import type { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
// Box builder registration — base/housing boxes (matches the carrier's boxy
// procedural style, see MothershipView/TurretView).
import "@babylonjs/core/Meshes/Builders/boxBuilder";
// Sphere builder registration — the shield generator's emissive dome.
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { FACTION_THEME } from "@space-duel/shared";
import type { Faction, SubsystemKind } from "@space-duel/shared";

/**
 * Depiction of ONE carrier subsystem (shield generator / hangar) — the VIEW
 * half of the MothershipSubsystem split (the TurretView recipe minus the
 * traverse: subsystems don't aim). Holds no gameplay truth; each frame it
 * reads the sim subsystem's `isAlive` and, on the first dead frame, drops the
 * live structure to a charred base stump (exactly TurretView's dead state).
 *
 * Procedural-only for now: an armored base box plus a faction-emissive "live"
 * element (shield = glowing dome, hangar = bay light strip) that dies with
 * the subsystem. A future carrier GLB can author real geometry; this is the
 * fallback tier of that two-tier pattern.
 */
export class SubsystemView {
  private readonly mount: TransformNode;
  /** The live structure disabled on death (the base box stays as a stump). */
  private readonly live: TransformNode;
  private deadShown = false;

  constructor(
    scene: Scene,
    root: TransformNode,
    faction: Faction,
    readonly kind: SubsystemKind,
    mountX: number,
    mountY: number,
    mountZ: number,
  ) {
    this.mount = new TransformNode(`subsys_${kind}_${mountX}_${mountZ}`, scene);
    this.mount.parent = root;
    this.mount.position.set(mountX, mountY, mountZ);

    this.live = new TransformNode(`subsys_${kind}_live_${mountX}_${mountZ}`, scene);
    this.live.parent = this.mount;

    const hullMat = new StandardMaterial(`subsys_hull_${faction}_${kind}`, scene);
    hullMat.diffuseColor =
      faction === "humans"
        ? new Color3(0.22, 0.28, 0.4)
        : new Color3(0.34, 0.16, 0.15);
    hullMat.specularColor = new Color3(0.05, 0.05, 0.08);

    // Faction-tinted emissive for the live element — the faction IDENTITY
    // palette (engine exhaust: Commonwealth blue, Novari red — the same
    // friend-or-foe read as radar/HUD; laserEmissive would make human
    // hardware glow pink). Unlit on purpose (style rule: emissive elements
    // glow regardless of scene light).
    const glowMat = new StandardMaterial(`subsys_glow_${faction}_${kind}`, scene);
    const theme = FACTION_THEME[faction].engineHot;
    glowMat.emissiveColor = new Color3(theme.r * 0.45, theme.g * 0.45, theme.b * 0.45);
    glowMat.diffuseColor = Color3.Black();
    glowMat.disableLighting = true;

    if (kind === "shield") {
      this.buildShield(scene, hullMat, glowMat);
    } else {
      this.buildHangar(scene, hullMat, glowMat);
    }
  }

  /** Armored plinth + glowing generator dome. */
  private buildShield(
    scene: Scene,
    hullMat: StandardMaterial,
    glowMat: StandardMaterial,
  ): void {
    const base = MeshBuilder.CreateBox(
      "subsys_shield_base",
      { width: 9, height: 2.6, depth: 9 },
      scene,
    );
    base.parent = this.mount;
    base.material = hullMat;
    base.isPickable = false;

    const dome = MeshBuilder.CreateSphere(
      "subsys_shield_dome",
      { diameter: 7, segments: 12 },
      scene,
    );
    dome.parent = this.live;
    dome.position.y = 2.2;
    dome.scaling.y = 0.65; // squashed emitter dome, not a full ball
    dome.material = glowMat;
    dome.isPickable = false;
  }

  /** Deck housing + emissive bay-mouth light strip. */
  private buildHangar(
    scene: Scene,
    hullMat: StandardMaterial,
    glowMat: StandardMaterial,
  ): void {
    const housing = MeshBuilder.CreateBox(
      "subsys_hangar_housing",
      { width: 12, height: 3.2, depth: 9 },
      scene,
    );
    housing.parent = this.mount;
    housing.material = hullMat;
    housing.isPickable = false;

    const strip: Mesh = MeshBuilder.CreateBox(
      "subsys_hangar_strip",
      { width: 10, height: 1.2, depth: 0.8 },
      scene,
    );
    strip.parent = this.live;
    strip.position.set(0, 1.2, 4.6);
    strip.material = glowMat;
    strip.isPickable = false;
  }

  /**
   * First frame the sim subsystem reads dead: drop the live structure (dome/
   * lights) and leave the armored base as a stump. The strategic
   * "subsystemRepair" upgrade can REVIVE a subsystem — a live read after a
   * dead one un-stumps it. Called each view frame from
   * MothershipView.syncSubsystems().
   */
  update(isAlive: boolean): void {
    if (!isAlive && !this.deadShown) {
      this.deadShown = true;
      this.live.setEnabled(false);
    } else if (isAlive && this.deadShown) {
      this.deadShown = false;
      this.live.setEnabled(true);
    }
  }

  dispose(): void {
    this.mount.dispose(false, true);
  }
}
