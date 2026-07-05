import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { GameConfig, type Faction } from "@space-duel/shared";

/** How a plate is styled: a human pilot's typed name vs a bot's generated
 *  callsign — the honesty rule says the two must read differently at a
 *  glance (CSS classes carry the distinction). */
export type PlateKind = "human" | "ai";

/**
 * Ship nameplates: plain-DOM callsign labels (no framework, like the HUD)
 * projected under the ships each frame. The CALLER decides which ships get
 * a plate each frame (friendlies always, enemies only while lock-targeted,
 * never your own ship — GameConfig.nameplates doc) via the begin/show/end
 * protocol:
 *
 *   begin(zoom)              — starts a frame; zoom drives the global fade
 *   show(id, label, …)       — one visible plate, world position projected
 *                              to CSS pixels against the live camera
 *   end()                    — hides every plate not shown this frame
 *
 * Elements are pooled by id (a ship's plate div lives as long as the ship);
 * labels land via textContent, so a player-typed name can never inject
 * markup. Knobs in GameConfig.nameplates.
 */
export class Nameplates {
  private readonly host: HTMLDivElement;
  private readonly plates = new Map<string, HTMLDivElement>();
  private readonly shownThisFrame = new Set<string>();
  /** Scratch (no per-frame allocation). */
  private readonly world = new Vector3();
  private readonly screen = new Vector3();
  /** This frame's zoom fade — 0 hides everything, so show() can early-out. */
  private frameAlpha = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    hudRoot: HTMLElement,
  ) {
    this.host = document.createElement("div");
    this.host.id = "nameplates";
    hudRoot.appendChild(this.host);
  }

  /** Start a frame: derive the global fade from the camera zoom (pulled back
   *  past zoomFadeEnd the text is clutter, so it goes away entirely). */
  begin(zoom: number): void {
    const cfg = GameConfig.nameplates;
    const t = (zoom - cfg.zoomFadeStart) / (cfg.zoomFadeEnd - cfg.zoomFadeStart);
    this.frameAlpha = cfg.maxAlpha * Math.min(1, Math.max(0, 1 - t));
    this.host.style.opacity = String(this.frameAlpha);
    this.shownThisFrame.clear();
  }

  /**
   * Render one plate this frame at the ship's world position. `id` is any
   * key stable for the ship's lifetime; `kind`/`faction` pick the CSS class
   * (human name vs AI callsign, friend-vs-foe tint is the caller's faction).
   */
  show(id: string, label: string, x: number, z: number, kind: PlateKind, faction: Faction): void {
    if (this.frameAlpha <= 0.01) return; // zoomed out — nothing to place
    this.world.set(x, 0, z);
    const engine = this.scene.getEngine();
    const rw = engine.getRenderWidth();
    const rh = engine.getRenderHeight();
    Vector3.ProjectToRef(
      this.world,
      Matrix.IdentityReadOnly,
      this.scene.getTransformMatrix(),
      this.camera.viewport.toGlobal(rw, rh),
      this.screen,
    );
    if (this.screen.z < 0 || this.screen.z > 1) return; // outside the frustum
    // Render-buffer pixels → CSS pixels (hardware scaling / DPR aware).
    const canvas = engine.getRenderingCanvas();
    const sx = this.screen.x * ((canvas?.clientWidth ?? rw) / rw);
    const sy = this.screen.y * ((canvas?.clientHeight ?? rh) / rh);

    let el = this.plates.get(id);
    if (!el) {
      el = document.createElement("div");
      this.plates.set(id, el);
      this.host.appendChild(el);
    }
    const cls = `nameplate ${kind} ${faction}`;
    if (el.className !== cls) el.className = cls;
    if (el.textContent !== label) el.textContent = label;
    el.style.transform = `translate(-50%, 0) translate(${sx.toFixed(1)}px, ${
      (sy + GameConfig.nameplates.offsetPx).toFixed(1)}px)`;
    el.style.display = "block";
    this.shownThisFrame.add(id);
  }

  /** Hide every pooled plate that wasn't shown this frame. */
  end(): void {
    for (const [id, el] of this.plates) {
      if (!this.shownThisFrame.has(id) && el.style.display !== "none") {
        el.style.display = "none";
      }
    }
  }

  dispose(): void {
    this.host.remove();
    this.plates.clear();
  }
}
