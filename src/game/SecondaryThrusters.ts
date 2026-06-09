import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import { GameConfig } from "./GameConfig";

/**
 * Subtle RCS / maneuvering-thruster vapour effect for reverse and strafe inputs.
 *
 * Three nozzle points — nose (reverse), port and starboard (strafe) — each
 * built from two meshes that live as CHILDREN of an anchor node which is
 * parented to the ship root:
 *
 *   • A small sphere at the nozzle mouth (hot-spot glow).
 *   • An elongated ellipsoid extending along the ejection axis in LOCAL space.
 *
 * Because both meshes are in local anchor space they always point in the
 * correct thrust direction regardless of ship velocity/inertia. This is
 * intentional: the effect shows WHERE the thrusters are firing, not where the
 * ship is going.
 */
export class SecondaryThrusters {
  private readonly units: ThrusterUnit[];

  /**
   * `mounts` are nozzle positions in the ship's local frame, from the model's
   * `rcs.*` markers. Any mount that's missing falls back to the position built
   * from `GameConfig.secondaryThrusters` (`noseZ`/`sideX`/`sideZ`). The ejection
   * direction + plume size always come from config — markers set WHERE, not how.
   */
  constructor(
    scene: Scene,
    shipRoot: TransformNode,
    glowLayer: GlowLayer,
    mounts?: {
      nose?: { x: number; y: number; z: number };
      port?: { x: number; y: number; z: number };
      stbd?: { x: number; y: number; z: number };
    },
  ) {
    const cfg = GameConfig.secondaryThrusters;
    const hw = cfg.plumeLength / 2;
    const vec = (p?: { x: number; y: number; z: number }, fallback?: Vector3) =>
      p ? new Vector3(p.x, p.y, p.z) : (fallback as Vector3);

    // Nose — reverse thrust ejects forward (+Z in ship-local space).
    const nose = makeUnit(
      scene, shipRoot, glowLayer,
      vec(mounts?.nose, new Vector3(0, 0, cfg.noseZ)),
      new Vector3(0, 0, hw),                                // plume offset along +Z
      new Vector3(cfg.plumeWidth, cfg.plumeWidth, cfg.plumeLength),
      "sec_nose",
    );

    // Port (left side) — fires when strafing right, ejects to the left (-X).
    const port = makeUnit(
      scene, shipRoot, glowLayer,
      vec(mounts?.port, new Vector3(-cfg.sideX, 0, cfg.sideZ)),
      new Vector3(-hw, 0, 0),                               // plume offset along -X
      new Vector3(cfg.plumeLength, cfg.plumeWidth, cfg.plumeWidth),
      "sec_port",
    );

    // Starboard (right side) — fires when strafing left, ejects to the right (+X).
    const starboard = makeUnit(
      scene, shipRoot, glowLayer,
      vec(mounts?.stbd, new Vector3(cfg.sideX, 0, cfg.sideZ)),
      new Vector3(hw, 0, 0),                                // plume offset along +X
      new Vector3(cfg.plumeLength, cfg.plumeWidth, cfg.plumeWidth),
      "sec_stbd",
    );

    this.units = [nose, port, starboard];
  }

  /**
   * Call every frame — even when the player is dead (pass all false) so
   * intensities taper to zero rather than freezing mid-glow.
   */
  update(
    deltaSeconds: number,
    reverse: boolean,
    strafeLeft: boolean,
    strafeRight: boolean,
  ): void {
    const [nose, port, starboard] = this.units;
    updateUnit(nose, deltaSeconds, reverse);
    updateUnit(port, deltaSeconds, strafeRight);    // port jets when strafing right
    updateUnit(starboard, deltaSeconds, strafeLeft); // starboard jets when strafing left
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ThrusterUnit {
  coreMat: StandardMaterial;
  plumeMat: StandardMaterial;
  intensity: number;
}

function makeUnit(
  scene: Scene,
  shipRoot: TransformNode,
  glowLayer: GlowLayer,
  nozzleLocalPos: Vector3,
  plumeOffset: Vector3,    // centre of plume in anchor-local space
  plumeScaling: Vector3,   // non-uniform scale on a unit sphere
  name: string,
): ThrusterUnit {
  const cfg = GameConfig.secondaryThrusters;

  const anchor = new TransformNode(`${name}_anchor`, scene);
  anchor.parent = shipRoot;
  anchor.position = nozzleLocalPos;

  // Small emissive sphere at the nozzle mouth.
  const core: Mesh = MeshBuilder.CreateSphere(
    `${name}_core`,
    { diameter: cfg.coreDiameter, segments: 5 },
    scene,
  );
  core.parent = anchor;
  core.isPickable = false;

  const coreMat = new StandardMaterial(`${name}_core_mat`, scene);
  coreMat.diffuseColor = new Color3(0, 0, 0);
  coreMat.specularColor = new Color3(0, 0, 0);
  coreMat.emissiveColor = new Color3(0, 0, 0);
  coreMat.disableLighting = true;
  coreMat.alpha = 0; // start invisible; updateUnit fades it in with intensity
  core.material = coreMat;
  // GlowLayer is in included-only mode; explicit registration is required.
  glowLayer.addIncludedOnlyMesh(core);

  // Elongated plume ellipsoid in LOCAL anchor space — always aligned with the
  // ejection axis, never affected by ship velocity.
  const plume: Mesh = MeshBuilder.CreateSphere(
    `${name}_plume`,
    { diameter: 1, segments: 6 },
    scene,
  );
  plume.parent = anchor;
  plume.position.copyFrom(plumeOffset);
  plume.scaling.copyFrom(plumeScaling);
  plume.isPickable = false;

  const plumeMat = new StandardMaterial(`${name}_plume_mat`, scene);
  plumeMat.diffuseColor = new Color3(0, 0, 0);
  plumeMat.specularColor = new Color3(0, 0, 0);
  plumeMat.emissiveColor = new Color3(0, 0, 0);
  plumeMat.disableLighting = true;
  plumeMat.alpha = 0;
  plume.material = plumeMat;
  glowLayer.addIncludedOnlyMesh(plume);

  return { coreMat, plumeMat, intensity: 0 };
}

function updateUnit(unit: ThrusterUnit, deltaSeconds: number, active: boolean): void {
  const cfg = GameConfig.secondaryThrusters;

  const rate = active ? cfg.fadeInRate : cfg.fadeOutRate;
  const t = 1 - Math.exp(-rate * deltaSeconds);
  unit.intensity += ((active ? 1 : 0) - unit.intensity) * t;

  const i = unit.intensity;
  const { r, g, b } = cfg.color;
  unit.coreMat.emissiveColor.set(r * i, g * i, b * i);
  unit.plumeMat.emissiveColor.set(r * i, g * i, b * i);
  // Fade BOTH the plume and the core out with intensity. The core is an
  // unlit emissive sphere; left opaque it renders as a solid BLACK dot when
  // idle (emissive (0,0,0)), so it must fade to transparent too.
  unit.coreMat.alpha = i;
  unit.plumeMat.alpha = cfg.maxAlpha * i;
}
