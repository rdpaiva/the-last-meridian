import type { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
// Registers MeshBuilder.CreateCylinder (body + nose cone) and CreateBox (fins).
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { GameConfig } from "../GameConfig";
import type { Missile } from "../sim/Missile";
import type { MissileSystem } from "../sim/MissileSystem";

export type MissileSystemViewOptions = {
  /** Diffuse color of the missile body + nose cone (the gray hull). */
  bodyColor: Color3;
  /** Diffuse color of the tail fins (the red accent). */
  finColor: Color3;
  /** Emissive RGB of the exhaust trail (components > 1.0 bloom harder). */
  trailEmissive: Color3;
  /** Optional material name prefix — handy when debugging in the inspector. */
  materialName?: string;
};

/** One live round's scene objects: the composite mesh + its exhaust trail. */
interface RoundView {
  root: TransformNode;
  trail: TrailMesh;
}

/**
 * Babylon depiction of one faction's MissileSystem — the view half of the
 * Missile/MissileSystem split (docs/MULTIPLAYER.md Phase 0). The sim owns
 * flight state; this builds a composite mesh + exhaust trail when a round
 * appears in `rounds`, copies position/heading out of the sim each frame,
 * and disposes the pair when the round disappears (detonation or timeout).
 *
 * Unlike LaserSystemView's index pool, rounds map 1:1 to their scene objects
 * (a Map keyed by the sim Missile): a TrailMesh records its generator's
 * movement history, so handing a used trail to a NEW missile would smear a
 * streak from the old position to the new spawn point. Create/dispose per
 * round is exactly the lifecycle the pre-split code had.
 */
export class MissileSystemView {
  private readonly bodyMaterial: StandardMaterial;
  private readonly finMaterial: StandardMaterial;
  private readonly trailMaterial: StandardMaterial;
  private readonly views = new Map<Missile, RoundView>();

  constructor(
    private readonly scene: Scene,
    private readonly system: MissileSystem,
    options: MissileSystemViewOptions,
  ) {
    const name = options.materialName ?? "missile_mat";

    // Body: a lit gray hull with a faint self-emissive so it still reads as a
    // solid object against the dark backdrop (not added to the GlowLayer — the
    // hull shouldn't bloom; only the exhaust does).
    const body = new StandardMaterial(`${name}_body`, scene);
    body.diffuseColor = options.bodyColor;
    body.emissiveColor = options.bodyColor.scale(0.25);
    body.specularColor = new Color3(0.2, 0.2, 0.22);
    this.bodyMaterial = body;

    // Fins: red accent, same lit-with-faint-emissive treatment.
    const fin = new StandardMaterial(`${name}_fin`, scene);
    fin.diffuseColor = options.finColor;
    fin.emissiveColor = options.finColor.scale(0.3);
    fin.specularColor = new Color3(0.1, 0.1, 0.1);
    this.finMaterial = fin;

    // Trail emissive blooms via the GlowLayer into a hot streak. Semi-
    // transparent so it reads as exhaust, not a solid tube.
    const trail = new StandardMaterial(`${name}_trail`, scene);
    trail.diffuseColor = new Color3(0, 0, 0);
    trail.specularColor = new Color3(0, 0, 0);
    trail.emissiveColor = options.trailEmissive;
    trail.disableLighting = true;
    trail.alpha = 0.7;
    this.trailMaterial = trail;
  }

  /**
   * Reconcile scene objects with the sim's live rounds, then copy each
   * round's pose in. Call once per frame, before render.
   */
  update(): void {
    const rounds = this.system.rounds;

    // New rounds → build mesh + trail at the round's CURRENT pose.
    for (const round of rounds) {
      if (!this.views.has(round)) {
        this.views.set(round, this.buildRoundView(round));
      }
    }

    // Disappeared rounds → dispose mesh + trail.
    if (this.views.size > rounds.length) {
      const live = new Set(rounds);
      for (const [round, view] of this.views) {
        if (!live.has(round)) {
          this.disposeRoundView(view);
          this.views.delete(round);
        }
      }
    }

    // Pose sync.
    for (const [round, view] of this.views) {
      view.root.position.copyFrom(round.position);
      view.root.rotation.y = round.heading;
    }
  }

  private buildRoundView(round: Missile): RoundView {
    const cfg = GameConfig.missile;

    const root = this.buildMissileMesh();
    root.position.copyFrom(round.position);
    root.rotation.y = round.heading;

    // Bake the world matrix NOW. The root was created this frame, so its world
    // matrix is still identity until the next render — and TrailMesh seeds all
    // its segments from the generator's world position at construction. Without
    // this, every trail starts as a stray streak from the world origin (0,0,0)
    // to the spawn point on the first frame.
    root.computeWorldMatrix(true);

    // Trail generator = the missile root; autoStart records immediately.
    const trail = new TrailMesh(
      "missile_trail",
      root,
      this.scene,
      cfg.trailDiameter,
      cfg.trailLength,
      true,
    );
    trail.material = this.trailMaterial;
    trail.isPickable = false;

    return { root, trail };
  }

  private disposeRoundView(view: RoundView): void {
    // Trail first — it's not a child of the mesh, so disposing the mesh alone
    // would leak the tube (CLAUDE.md gotcha #4).
    //
    // stop() BEFORE dispose() is mandatory: TrailMesh registers a per-frame
    // scene.onBeforeRenderObservable callback in start()/autoStart and does NOT
    // remove it in dispose() (no dispose override — it inherits Mesh.dispose).
    // Only stop() unhooks that observer. Skip this and every fired missile
    // leaks a permanent per-frame callback updating dead geometry, which piles
    // up into progressive slowdown/choppiness.
    view.trail.stop();
    view.trail.dispose();
    view.root.dispose();
  }

  /**
   * Builds one missile as a small composite parented to a root TransformNode:
   * a gray cylindrical body, a tapered nose cone, and four red tail fins in a
   * `+` cross — oriented along local +Z (forward), tip toward +Z.
   *
   * Kept deliberately small (~0.7 long) so it reads as a sub-munition next to
   * the ~1.6-unit player ship. Disposing the root recurses into the children
   * (shared materials survive — disposeMaterialAndTextures defaults to false).
   */
  private buildMissileMesh(): TransformNode {
    const cfg = GameConfig.missile;
    const scene = this.scene;
    const root = new TransformNode("missile", scene);

    const bodyDia = cfg.radius * 2;
    const bodyLen = cfg.length;
    const noseLen = cfg.length * 0.36;

    // Body tube — cylinder's height axis (Y) rotated onto +Z.
    const body = MeshBuilder.CreateCylinder(
      "missile_body",
      { height: bodyLen, diameter: bodyDia, tessellation: 10 },
      scene,
    );
    body.rotation.x = Math.PI / 2;
    body.material = this.bodyMaterial;
    body.isPickable = false;
    body.parent = root;

    // Nose cone — slightly blunt tip, seated on the body's front face.
    const nose = MeshBuilder.CreateCylinder(
      "missile_nose",
      {
        height: noseLen,
        diameterTop: bodyDia * 0.12,
        diameterBottom: bodyDia,
        tessellation: 10,
      },
      scene,
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.z = bodyLen / 2 + noseLen / 2;
    nose.material = this.bodyMaterial;
    nose.isPickable = false;
    nose.parent = root;

    // Four fins around the aft body. Rotating each box about +Z puts its width
    // along the radial direction; depth stays along the body (chord).
    const finSpan = bodyDia;
    const finChord = bodyLen * 0.4;
    const finThick = bodyDia * 0.18;
    const off = bodyDia / 2 + finSpan / 2;
    const tailZ = -bodyLen / 2 + finChord / 2;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const fin = MeshBuilder.CreateBox(
        "missile_fin",
        { width: finSpan, height: finThick, depth: finChord },
        scene,
      );
      fin.position.set(Math.cos(a) * off, Math.sin(a) * off, tailZ);
      fin.rotation.z = a;
      fin.material = this.finMaterial;
      fin.isPickable = false;
      fin.parent = root;
    }

    return root;
  }

  dispose(): void {
    for (const view of this.views.values()) this.disposeRoundView(view);
    this.views.clear();
    this.bodyMaterial.dispose();
    this.finMaterial.dispose();
    this.trailMaterial.dispose();
  }
}
