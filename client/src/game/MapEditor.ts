import {
  GameConfig,
  MAPS,
  type ConcreteMapId,
  type Faction,
  type HulkHazard,
  type MapConfig,
} from "@space-duel/shared";

/**
 * The map editor (data-state="mapEditor") — ADMIN/AUTHORING tooling, a
 * sibling of SettingsMenu in the splash flow. A top-down 2D canvas of the
 * board plus a side panel: pick a brush (nebula / storm / rock field /
 * wreck), paint circles onto the arena, drag the two carriers along the
 * lane, tune the scalars, then COPY MAP emits a paste-ready `MapConfig`
 * entry for the MAPS catalog (shared/src/Maps.ts). Maps stay compile-time
 * presets — the editor authors them, it does not add them at runtime — so
 * a committed map works everywhere (solo AND online) with no wire changes.
 *
 * Conventions hidden from the author: nebula/storm zones are stored as
 * FRACTIONS of the arena half-extents while asteroid regions and hazards are
 * world-space (see MapConfig) — the editor works in world units everywhere
 * and converts on export/import. The canvas view is +X right, +Z up (enemy
 * carrier at the top), matching the radar's pilot-at-south orientation.
 *
 * The draft auto-saves to localStorage on every edit (as the exported
 * MapConfig shape), so work survives reloads — and TEST FLIGHT launches a
 * solo match on the draft via the same seam (loadDraftMap + shared
 * applyMapConfig; end-of-match Enter-restarts replay the draft too).
 */

/** Editor-side zone circle, WORLD coords (fractions only exist on export). */
interface EditorZone {
  kind: "nebula" | "storm" | "region";
  x: number;
  z: number;
  radius: number;
}

/** Editor-side wreck — HulkHazard with every optional field made concrete. */
interface EditorHulk {
  source: Faction;
  x: number;
  z: number;
  rotationY: number;
  rotationRate: number;
  pitchRate: number;
  rollRate: number;
  scale: number;
}

type Tool = "select" | "nebula" | "storm" | "region" | "hulk" | "station";
type Selection =
  | { kind: "zone"; i: number }
  | { kind: "hulk"; i: number }
  | { kind: "station"; i: number }
  | { kind: "carrier"; side: "player" | "enemy" }
  | null;

/** A draft that isn't in the catalog — everything but the union-typed id. */
export type DraftMap = Omit<MapConfig, "id">;

const DRAFT_KEY = "lastMeridian_mapDraft";

/** World extents the canvas frames: the ±600 arena plus the carrier lane. */
const VIEW_HX = 650;
const VIEW_HZ = 1000;

/** Initial brush radii (world units) per placeable kind — the brushes are
 *  STICKY: editing a placed shape's attributes re-seeds its brush, so the
 *  next stamp of that kind repeats the last-tuned values. */
const BRUSH_RADIUS: Record<EditorZone["kind"], number> = {
  nebula: 60,
  storm: 80,
  region: 150,
};
const ZONE_RADIUS_MIN = 15;
const ZONE_RADIUS_MAX = 400;

/** Palette per paintable kind (stroke; fills derive with low alpha). */
const KIND_COLOR: Record<EditorZone["kind"] | "hulk" | "station", string> = {
  nebula: "#cba6f7",
  storm: "#74c7ec",
  region: "#9399b2",
  hulk: "#fab387",
  station: "#a6e3a1",
};

/** Approximate carrier hull footprint (world units) for markers — close to
 *  mothership.hullRects extents; markers, not colliders, so rough is fine. */
const HULL_LEN = 280;
const HULL_WIDTH = 104;

/** Read the persisted draft back as an applyMapConfig-ready map (null when
 *  none saved / unparseable). Used by main.ts for test-flight (re)launches. */
export function loadDraftMap(): DraftMap | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as DraftMap;
    return v && typeof v === "object" && v.carrierZ ? v : null;
  } catch {
    return null;
  }
}

export class MapEditor {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // ── The draft being edited (world coords throughout) ──
  private name = "New Map";
  private blurb = "";
  private carrierZ = { player: -700, enemy: 700 };
  private asteroids = {
    count: GameConfig.asteroids.count,
    radiusMin: GameConfig.asteroids.radiusMin,
    radiusMax: GameConfig.asteroids.radiusMax,
    driftSpeedMin: GameConfig.asteroids.driftSpeedMin,
    driftSpeedMax: GameConfig.asteroids.driftSpeedMax,
  };
  private zones: EditorZone[] = [];
  private hulks: EditorHulk[] = [];
  /** Capture stations — position-only (the capture ring radius is a global
   *  GameConfig.stations knob, not per-station, so nothing to resize). */
  private stations: { x: number; z: number }[] = [];

  // ── Sticky brushes: the last-edited attributes per kind, stamped onto the
  // next placement so a run of same-sized shapes doesn't need re-tuning. ──
  private readonly brushRadius: Record<EditorZone["kind"], number> = { ...BRUSH_RADIUS };
  private brushHulk: Omit<EditorHulk, "x" | "z"> = {
    source: "humans",
    rotationY: Math.PI / 2,
    rotationRate: 0,
    pitchRate: 0,
    rollRate: 0.06,
    scale: 0.5,
  };

  // ── UI state ──
  private tool: Tool = "select";
  private selection: Selection = null;
  private hover: { x: number; z: number } | null = null;
  private dragging = false;
  private dragOffset = { x: 0, z: 0 };
  private statusTimer: number | undefined;
  /** CLEAR is two-click (arm, then confirm) — mirrors SettingsMenu RESET ALL. */
  private clearArmed = false;
  private clearArmTimer: number | undefined;

  constructor(
    private readonly root: HTMLElement,
    /** Is the editor the active splash state? Gates the document-level keys. */
    private readonly isActive: () => boolean,
    private readonly onBack: () => void,
    /** Launch a solo match on the draft (main.ts owns the launch path). */
    private readonly onTestFlight: (map: DraftMap) => void,
  ) {
    const draft = loadDraftMap();
    if (draft) this.loadMap(draft);

    this.render();
    this.canvas = this.root.querySelector<HTMLCanvasElement>("#med-canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.bindCanvas();

    // Delete/Backspace removes the selection — document-level (the canvas
    // isn't focusable), gated to the editor state and off while typing.
    document.addEventListener("keydown", (e) => {
      if (!this.isActive()) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        this.deleteSelection();
      }
    });
    window.addEventListener("resize", () => {
      if (this.isActive()) this.resize();
    });
  }

  /** Called by main.ts every time the splash enters the editor state — the
   *  root was display:none at construction, so sizes only exist now. */
  onShown(): void {
    this.resize();
  }

  // ── DOM scaffold ───────────────────────────────────────────────────────

  private render(): void {
    const presets = (Object.keys(MAPS) as ConcreteMapId[])
      .map((id) => `<option value="${id}">${MAPS[id].name}</option>`)
      .join("");
    this.root.innerHTML = `
      <div class="settings-head">
        <span class="settings-title">MAP EDITOR</span>
        <span class="settings-status"></span>
        <div class="settings-actions">
          <select id="med-preset" class="med-preset" title="Load a catalog map as a starting point (replaces the draft)">
            <option value="">LOAD PRESET…</option>${presets}
          </select>
          <button id="med-import" class="set-btn" title="Paste a previously copied map entry">IMPORT</button>
          <button id="med-copy" class="set-btn" title="Copy a paste-ready MAPS entry for shared/src/Maps.ts">COPY MAP</button>
          <button id="med-clear" class="set-btn">CLEAR</button>
          <button id="med-test" class="set-btn primary" title="Launch a solo match on this draft">TEST FLIGHT</button>
          <button id="med-back" class="set-btn primary">BACK</button>
        </div>
      </div>
      <div class="settings-note">
        Click paints the selected brush · drag moves · scroll over a shape resizes · right-click or Delete removes · carriers drag along the lane · draft auto-saves in this browser
      </div>
      <div class="settings-io" hidden>
        <textarea id="med-io-text" rows="9" spellcheck="false" placeholder="Paste a copied map entry here"></textarea>
        <div class="settings-io-actions">
          <button id="med-io-apply" class="set-btn primary">APPLY</button>
          <button id="med-io-cancel" class="set-btn">CLOSE</button>
        </div>
      </div>
      <div class="med-body">
        <div class="med-canvas-wrap"><canvas id="med-canvas"></canvas></div>
        <div class="med-panel">
          <div class="med-section">
            <div class="med-sec-title">MAP</div>
            <div class="med-row"><span>Name</span><input id="med-name" type="text" maxlength="24" spellcheck="false"></div>
            <div class="med-row"><span>Blurb</span><input id="med-blurb" type="text" maxlength="90" spellcheck="false"></div>
            <div class="med-id">id: <span id="med-id"></span></div>
          </div>
          <div class="med-section">
            <div class="med-sec-title">BRUSH</div>
            <div class="med-tools">
              <button class="med-tool" data-tool="select">SELECT</button>
              <button class="med-tool" data-tool="nebula"><span class="med-swatch" style="background:${KIND_COLOR.nebula}"></span>NEBULA</button>
              <button class="med-tool" data-tool="storm"><span class="med-swatch" style="background:${KIND_COLOR.storm}"></span>STORM</button>
              <button class="med-tool" data-tool="region"><span class="med-swatch" style="background:${KIND_COLOR.region}"></span>ROCK FIELD</button>
              <button class="med-tool" data-tool="hulk"><span class="med-swatch" style="background:${KIND_COLOR.hulk}"></span>WRECK</button>
              <button class="med-tool" data-tool="station"><span class="med-swatch" style="background:${KIND_COLOR.station}"></span>STATION</button>
            </div>
            <div class="med-hint">Nebulas hide ships · storms zap and wall the AI out · rock fields seed the asteroid count into circles (none painted = full-arena scatter) · wrecks are indestructible cover · stations are capture points that feed faction Energy + carrier shields (none = the strategic layer stays off)</div>
          </div>
          <div class="med-section">
            <div class="med-sec-title">CARRIERS</div>
            <div class="med-row"><span>Player Z</span><input id="med-cz-player" type="number" step="10"></div>
            <div class="med-row"><span>Enemy Z</span><input id="med-cz-enemy" type="number" step="10"></div>
            <div class="med-hint">Tighter = brawl, wider = a long approach where the jump drive matters. Carriers sit on the lane (x = 0).</div>
          </div>
          <div class="med-section">
            <div class="med-sec-title">ASTEROIDS</div>
            <div class="med-row"><span>Count</span><input id="med-a-count" type="number" min="0" max="300" step="5"></div>
            <div class="med-row"><span>Radius min</span><input id="med-a-rmin" type="number" min="2" max="40" step="1"></div>
            <div class="med-row"><span>Radius max</span><input id="med-a-rmax" type="number" min="2" max="60" step="1"></div>
            <div class="med-row"><span>Drift min</span><input id="med-a-dmin" type="number" min="0" max="30" step="0.5"></div>
            <div class="med-row"><span>Drift max</span><input id="med-a-dmax" type="number" min="0" max="30" step="0.5"></div>
          </div>
          <div class="med-section" id="med-selected"></div>
        </div>
      </div>`;

    this.byId("med-back").addEventListener("click", () => this.onBack());
    this.byId("med-copy").addEventListener("click", () => void this.copySnippet());
    this.byId("med-import").addEventListener("click", () => this.openIo(""));
    this.byId("med-io-apply").addEventListener("click", () => this.applyIo());
    this.byId("med-io-cancel").addEventListener("click", () => this.closeIo());
    this.byId("med-clear").addEventListener("click", () => this.clearAll());
    this.byId("med-test").addEventListener("click", () => this.onTestFlight(this.buildMap()));
    this.byId<HTMLSelectElement>("med-preset").addEventListener("change", (e) => {
      const sel = e.target as HTMLSelectElement;
      const id = sel.value as ConcreteMapId | "";
      sel.value = ""; // a load action, not a persistent selection
      if (!id) return;
      this.loadMap(MAPS[id]);
      this.selection = null;
      this.syncPanel();
      this.touch();
      this.status(`Loaded "${MAPS[id].name}" — now editing a copy`);
    });

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>(".med-tool")) {
      btn.addEventListener("click", () => this.setTool(btn.dataset.tool as Tool));
    }

    this.bindText("med-name", (v) => {
      this.name = v.trim() || "New Map";
      this.byId<HTMLElement>("med-id").textContent = this.mapId();
    });
    this.bindText("med-blurb", (v) => (this.blurb = v.trim()));
    this.bindNum("med-cz-player", -VIEW_HZ, -100, (v) => (this.carrierZ.player = v));
    this.bindNum("med-cz-enemy", 100, VIEW_HZ, (v) => (this.carrierZ.enemy = v));
    this.bindNum("med-a-count", 0, 300, (v) => (this.asteroids.count = Math.round(v)));
    this.bindNum("med-a-rmin", 2, 60, (v) => (this.asteroids.radiusMin = v));
    this.bindNum("med-a-rmax", 2, 60, (v) => (this.asteroids.radiusMax = v));
    this.bindNum("med-a-dmin", 0, 30, (v) => (this.asteroids.driftSpeedMin = v));
    this.bindNum("med-a-dmax", 0, 30, (v) => (this.asteroids.driftSpeedMax = v));

    this.syncPanel();
  }

  /** Push draft values into every panel field (after load/import/clear). */
  private syncPanel(): void {
    this.byId<HTMLInputElement>("med-name").value = this.name;
    this.byId<HTMLInputElement>("med-blurb").value = this.blurb;
    this.byId<HTMLElement>("med-id").textContent = this.mapId();
    this.byId<HTMLInputElement>("med-cz-player").value = String(this.carrierZ.player);
    this.byId<HTMLInputElement>("med-cz-enemy").value = String(this.carrierZ.enemy);
    this.byId<HTMLInputElement>("med-a-count").value = String(this.asteroids.count);
    this.byId<HTMLInputElement>("med-a-rmin").value = String(this.asteroids.radiusMin);
    this.byId<HTMLInputElement>("med-a-rmax").value = String(this.asteroids.radiusMax);
    this.byId<HTMLInputElement>("med-a-dmin").value = String(this.asteroids.driftSpeedMin);
    this.byId<HTMLInputElement>("med-a-dmax").value = String(this.asteroids.driftSpeedMax);
    this.setTool(this.tool);
    this.renderSelected();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>(".med-tool")) {
      btn.classList.toggle("active", btn.dataset.tool === tool);
    }
    this.canvas?.style.setProperty("cursor", tool === "select" ? "default" : "crosshair");
    this.draw();
  }

  // ── Selected-object panel ────────────────────────────────────────────────

  private renderSelected(): void {
    const box = this.byId<HTMLElement>("med-selected");
    const sel = this.selection;
    if (!sel) {
      box.innerHTML = `<div class="med-sec-title">SELECTED</div><div class="med-hint">Nothing selected — click a shape with the SELECT brush.</div>`;
      return;
    }
    if (sel.kind === "carrier") {
      box.innerHTML = `<div class="med-sec-title">SELECTED · ${sel.side.toUpperCase()} CARRIER</div>
        <div class="med-hint">Drag along the lane, or set its Z in the CARRIERS section.</div>`;
      return;
    }
    if (sel.kind === "zone") {
      const z = this.zones[sel.i];
      const label = { nebula: "NEBULA", storm: "STORM", region: "ROCK FIELD" }[z.kind];
      box.innerHTML = `
        <div class="med-sec-title">SELECTED · ${label}</div>
        <div class="med-row"><span>X</span><input id="med-s-x" type="number" step="10"></div>
        <div class="med-row"><span>Z</span><input id="med-s-z" type="number" step="10"></div>
        <div class="med-row"><span>Radius</span><input id="med-s-r" type="number" step="5"></div>
        <button id="med-s-del" class="set-btn med-del">DELETE</button>`;
      this.bindNum("med-s-x", -VIEW_HX, VIEW_HX, (v) => (z.x = v));
      this.bindNum("med-s-z", -VIEW_HZ, VIEW_HZ, (v) => (z.z = v));
      this.bindNum("med-s-r", ZONE_RADIUS_MIN, ZONE_RADIUS_MAX, (v) => {
        z.radius = v;
        this.brushRadius[z.kind] = v;
      });
      this.byId<HTMLInputElement>("med-s-x").value = String(z.x);
      this.byId<HTMLInputElement>("med-s-z").value = String(z.z);
      this.byId<HTMLInputElement>("med-s-r").value = String(z.radius);
    } else if (sel.kind === "station") {
      const st = this.stations[sel.i];
      box.innerHTML = `
        <div class="med-sec-title">SELECTED · STATION</div>
        <div class="med-row"><span>X</span><input id="med-s-x" type="number" step="10"></div>
        <div class="med-row"><span>Z</span><input id="med-s-z" type="number" step="10"></div>
        <div class="med-hint">Neutral capture point. The dashed ring is the dock/capture radius — a global GameConfig.stations knob, same for every station.</div>
        <button id="med-s-del" class="set-btn med-del">DELETE</button>`;
      this.bindNum("med-s-x", -VIEW_HX, VIEW_HX, (v) => (st.x = v));
      this.bindNum("med-s-z", -VIEW_HZ, VIEW_HZ, (v) => (st.z = v));
      this.byId<HTMLInputElement>("med-s-x").value = String(st.x);
      this.byId<HTMLInputElement>("med-s-z").value = String(st.z);
    } else {
      const h = this.hulks[sel.i];
      box.innerHTML = `
        <div class="med-sec-title">SELECTED · WRECK</div>
        <div class="med-row"><span>X</span><input id="med-s-x" type="number" step="10"></div>
        <div class="med-row"><span>Z</span><input id="med-s-z" type="number" step="10"></div>
        <div class="med-row"><span>Heading °</span><input id="med-s-head" type="number" step="15"></div>
        <div class="med-row"><span>Scale</span><input id="med-s-scale" type="number" min="0.2" max="1.5" step="0.05"></div>
        <div class="med-row"><span>Yaw spin</span><input id="med-s-yaw" type="number" step="0.01" title="rad/sec — flat rotation of hull + cover"></div>
        <div class="med-row"><span>Roll rate</span><input id="med-s-roll" type="number" step="0.01" title="rad/sec — barrel-roll about the keel (view-only)"></div>
        <div class="med-row"><span>Pitch rate</span><input id="med-s-pitch" type="number" step="0.01" title="rad/sec — nose-over somersault (view-only)"></div>
        <div class="med-row"><span>Wreck of</span><select id="med-s-src">
          <option value="humans">Bastion (humans)</option>
          <option value="machines">Choirship (machines)</option>
        </select></div>
        <button id="med-s-del" class="set-btn med-del">DELETE</button>`;
      this.bindNum("med-s-x", -VIEW_HX, VIEW_HX, (v) => (h.x = v));
      this.bindNum("med-s-z", -VIEW_HZ, VIEW_HZ, (v) => (h.z = v));
      this.bindNum("med-s-head", -360, 360, (v) => {
        h.rotationY = (v * Math.PI) / 180;
        this.brushHulk.rotationY = h.rotationY;
      });
      this.bindNum("med-s-scale", 0.2, 1.5, (v) => {
        h.scale = v;
        this.brushHulk.scale = v;
      });
      this.bindNum("med-s-yaw", -0.5, 0.5, (v) => {
        h.rotationRate = v;
        this.brushHulk.rotationRate = v;
      });
      this.bindNum("med-s-roll", -0.5, 0.5, (v) => {
        h.rollRate = v;
        this.brushHulk.rollRate = v;
      });
      this.bindNum("med-s-pitch", -0.5, 0.5, (v) => {
        h.pitchRate = v;
        this.brushHulk.pitchRate = v;
      });
      this.byId<HTMLInputElement>("med-s-x").value = String(h.x);
      this.byId<HTMLInputElement>("med-s-z").value = String(h.z);
      this.byId<HTMLInputElement>("med-s-head").value = String(Math.round((h.rotationY * 180) / Math.PI));
      this.byId<HTMLInputElement>("med-s-scale").value = String(h.scale);
      this.byId<HTMLInputElement>("med-s-yaw").value = String(h.rotationRate);
      this.byId<HTMLInputElement>("med-s-roll").value = String(h.rollRate);
      this.byId<HTMLInputElement>("med-s-pitch").value = String(h.pitchRate);
      const src = this.byId<HTMLSelectElement>("med-s-src");
      src.value = h.source;
      src.addEventListener("change", () => {
        h.source = src.value as Faction;
        this.brushHulk.source = h.source;
        this.touch();
      });
    }
    this.root
      .querySelector<HTMLButtonElement>("#med-s-del")
      ?.addEventListener("click", () => this.deleteSelection());
  }

  // ── Canvas: transforms + interaction ─────────────────────────────────────

  /** Pixels per world unit at the current canvas CSS size. */
  private scale(): number {
    const r = this.canvas.getBoundingClientRect();
    return Math.min(r.width / (2 * VIEW_HX), r.height / (2 * VIEW_HZ));
  }

  private toWorld(px: number, py: number): { x: number; z: number } {
    const r = this.canvas.getBoundingClientRect();
    const s = this.scale();
    return { x: (px - r.width / 2) / s, z: (r.height / 2 - py) / s };
  }

  private resize(): void {
    const wrap = this.canvas.parentElement!;
    const availH = wrap.clientHeight - 8;
    const availW = wrap.clientWidth - 8;
    const s = Math.min(availW / (2 * VIEW_HX), availH / (2 * VIEW_HZ));
    const cssW = Math.max(200, Math.floor(2 * VIEW_HX * s));
    const cssH = Math.max(300, Math.floor(2 * VIEW_HZ * s));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.draw();
  }

  private bindCanvas(): void {
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const p = this.toWorld(e.offsetX, e.offsetY);
      const tool = this.tool;
      if (tool !== "select") {
        this.place(tool, p.x, p.z);
        return;
      }
      const hit = this.hitTest(p.x, p.z);
      this.selection = hit;
      if (hit) {
        const pos = this.selectionPos()!;
        this.dragOffset = { x: pos.x - p.x, z: pos.z - p.z };
        this.dragging = true;
      }
      this.renderSelected();
      this.draw();
    });
    c.addEventListener("mousemove", (e) => {
      const p = this.toWorld(e.offsetX, e.offsetY);
      this.hover = p;
      if (this.dragging && this.selection) {
        this.moveSelection(p.x + this.dragOffset.x, p.z + this.dragOffset.z);
      } else if (this.tool !== "select") {
        this.draw(); // ghost brush follows the cursor
      } else {
        c.style.cursor = this.hitTest(p.x, p.z) ? "pointer" : "default";
      }
    });
    window.addEventListener("mouseup", () => {
      if (this.dragging) {
        this.dragging = false;
        this.touch();
      }
    });
    c.addEventListener("mouseleave", () => {
      this.hover = null;
      this.draw();
    });
    // Scroll resizes the hovered (or selected) shape — radius for zones,
    // scale for wrecks.
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = this.toWorld(e.offsetX, e.offsetY);
        const target = this.hitTest(p.x, p.z) ?? this.selection;
        // Carriers aren't resizable; neither are stations (global capture radius).
        if (!target || target.kind === "carrier" || target.kind === "station") return;
        const dir = e.deltaY < 0 ? 1 : -1;
        if (target.kind === "zone") {
          const z = this.zones[target.i];
          z.radius = clamp(z.radius + dir * 5, ZONE_RADIUS_MIN, ZONE_RADIUS_MAX);
          this.brushRadius[z.kind] = z.radius;
        } else {
          const h = this.hulks[target.i];
          h.scale = clamp(Math.round((h.scale + dir * 0.05) * 100) / 100, 0.2, 1.5);
          this.brushHulk.scale = h.scale;
        }
        this.selection = target;
        this.renderSelected();
        this.touch();
      },
      { passive: false },
    );
    // Right-click erases — the other half of the brush metaphor.
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const p = this.toWorld(e.offsetX, e.offsetY);
      const hit = this.hitTest(p.x, p.z);
      if (hit && hit.kind !== "carrier") {
        this.selection = hit;
        this.deleteSelection();
      }
    });
  }

  private place(tool: Exclude<Tool, "select">, x: number, z: number): void {
    x = Math.round(x);
    z = Math.round(z);
    if (tool === "hulk") {
      this.hulks.push({ ...this.brushHulk, x, z });
      this.selection = { kind: "hulk", i: this.hulks.length - 1 };
    } else if (tool === "station") {
      this.stations.push({ x, z });
      this.selection = { kind: "station", i: this.stations.length - 1 };
    } else {
      this.zones.push({ kind: tool, x, z, radius: this.brushRadius[tool] });
      this.selection = { kind: "zone", i: this.zones.length - 1 };
    }
    // Stamp-and-position: keep holding to drag the fresh shape into place.
    this.dragging = true;
    this.dragOffset = { x: 0, z: 0 };
    this.renderSelected();
    this.touch();
  }

  /** Topmost-drawn wins: carriers, then stations, then wrecks, then zones
   *  (newest first). */
  private hitTest(x: number, z: number): Selection {
    for (const side of ["player", "enemy"] as const) {
      const cz = this.carrierZ[side];
      if (Math.abs(x) < HULL_WIDTH / 2 + 15 && Math.abs(z - cz) < HULL_LEN / 2 + 15) {
        return { kind: "carrier", side };
      }
    }
    const stationR = GameConfig.stations.captureRadius;
    for (let i = this.stations.length - 1; i >= 0; i--) {
      const st = this.stations[i];
      if ((x - st.x) ** 2 + (z - st.z) ** 2 < stationR * stationR) {
        return { kind: "station", i };
      }
    }
    for (let i = this.hulks.length - 1; i >= 0; i--) {
      const h = this.hulks[i];
      const r = (HULL_LEN / 2) * h.scale;
      if ((x - h.x) ** 2 + (z - h.z) ** 2 < r * r) return { kind: "hulk", i };
    }
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const zn = this.zones[i];
      if ((x - zn.x) ** 2 + (z - zn.z) ** 2 < zn.radius ** 2) return { kind: "zone", i };
    }
    return null;
  }

  private selectionPos(): { x: number; z: number } | null {
    const s = this.selection;
    if (!s) return null;
    if (s.kind === "zone") return this.zones[s.i];
    if (s.kind === "hulk") return this.hulks[s.i];
    if (s.kind === "station") return this.stations[s.i];
    return { x: 0, z: this.carrierZ[s.side] };
  }

  private moveSelection(x: number, z: number): void {
    const s = this.selection;
    if (!s) return;
    x = clamp(Math.round(x), -VIEW_HX, VIEW_HX);
    z = clamp(Math.round(z), -VIEW_HZ, VIEW_HZ);
    if (s.kind === "carrier") {
      // Carriers live on the lane: x is fixed at 0, Z stays on their half.
      const v = s.side === "player" ? clamp(z, -VIEW_HZ, -100) : clamp(z, 100, VIEW_HZ);
      this.carrierZ[s.side] = v;
      this.byId<HTMLInputElement>(`med-cz-${s.side}`).value = String(v);
    } else {
      const o =
        s.kind === "zone"
          ? this.zones[s.i]
          : s.kind === "hulk"
            ? this.hulks[s.i]
            : this.stations[s.i];
      o.x = x;
      o.z = z;
      const sx = this.root.querySelector<HTMLInputElement>("#med-s-x");
      const sz = this.root.querySelector<HTMLInputElement>("#med-s-z");
      if (sx) sx.value = String(x);
      if (sz) sz.value = String(z);
    }
    this.draw();
  }

  private deleteSelection(): void {
    const s = this.selection;
    if (!s || s.kind === "carrier") return;
    if (s.kind === "zone") this.zones.splice(s.i, 1);
    else if (s.kind === "hulk") this.hulks.splice(s.i, 1);
    else this.stations.splice(s.i, 1);
    this.selection = null;
    this.renderSelected();
    this.touch();
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  private draw(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const s = this.scale();
    const cx = (x: number): number => r.width / 2 + x * s;
    const cy = (z: number): number => r.height / 2 - z * s;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.fillStyle = "#070a12";
    ctx.fillRect(0, 0, r.width, r.height);

    // Grid every 200 world units + the ±600 arena reference border.
    ctx.strokeStyle = "rgba(120, 140, 200, 0.08)";
    ctx.lineWidth = 1;
    for (let x = -600; x <= 600; x += 200) {
      ctx.beginPath();
      ctx.moveTo(cx(x), cy(-VIEW_HZ));
      ctx.lineTo(cx(x), cy(VIEW_HZ));
      ctx.stroke();
    }
    for (let z = -1000; z <= 1000; z += 200) {
      ctx.beginPath();
      ctx.moveTo(cx(-VIEW_HX), cy(z));
      ctx.lineTo(cx(VIEW_HX), cy(z));
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(137, 180, 250, 0.22)";
    ctx.strokeRect(cx(-600), cy(600), 1200 * s, 1200 * s);

    // Zones, oldest first (so newest paints on top, matching hitTest).
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const selected = this.selection?.kind === "zone" && this.selection.i === i;
      this.drawZone(ctx, cx(z.x), cy(z.z), z.radius * s, z.kind, selected, 1);
    }

    // Wrecks.
    for (let i = 0; i < this.hulks.length; i++) {
      const h = this.hulks[i];
      const selected = this.selection?.kind === "hulk" && this.selection.i === i;
      this.drawHull(
        ctx, cx(h.x), cy(h.z), h.rotationY, h.scale * s,
        "rgba(60, 56, 54, 0.75)", KIND_COLOR.hulk, selected,
      );
    }

    // Capture stations.
    for (let i = 0; i < this.stations.length; i++) {
      const st = this.stations[i];
      const selected = this.selection?.kind === "station" && this.selection.i === i;
      this.drawStation(ctx, cx(st.x), cy(st.z), s, selected, 1);
    }

    // Carriers — fixed fixtures on the lane, labelled.
    for (const side of ["player", "enemy"] as const) {
      const color = side === "player" ? "#89b4fa" : "#f38ba8";
      const z = this.carrierZ[side];
      const selected = this.selection?.kind === "carrier" && this.selection.side === side;
      this.drawHull(ctx, cx(0), cy(z), 0, s, "rgba(20, 28, 48, 0.9)", color, selected);
      ctx.fillStyle = color;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        side === "player" ? "PLAYER CARRIER" : "ENEMY CARRIER",
        cx(0),
        cy(z) + (side === "player" ? (HULL_LEN / 2) * s + 14 : -(HULL_LEN / 2) * s - 8),
      );
    }

    // Ghost brush preview under the cursor.
    const hover = this.hover;
    const tool = this.tool;
    if (hover && tool !== "select" && !this.dragging) {
      if (tool === "hulk") {
        this.drawHull(
          ctx, cx(hover.x), cy(hover.z), this.brushHulk.rotationY, this.brushHulk.scale * s,
          "rgba(60, 56, 54, 0.3)", KIND_COLOR.hulk, false, 0.45,
        );
      } else if (tool === "station") {
        this.drawStation(ctx, cx(hover.x), cy(hover.z), s, false, 0.45);
      } else {
        this.drawZone(
          ctx, cx(hover.x), cy(hover.z),
          this.brushRadius[tool] * s, tool, false, 0.45,
        );
      }
    }
  }

  private drawZone(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, r: number,
    kind: EditorZone["kind"], selected: boolean, alpha: number,
  ): void {
    const color = KIND_COLOR[kind];
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `${color}26`; // ~15% fill
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.setLineDash(kind === "region" ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    if (selected) this.drawSelectionRing(ctx, x, y, r + 5);
    ctx.globalAlpha = 1;
  }

  /** A capture-station marker: dashed dock/capture ring at the global
   *  GameConfig.stations.captureRadius plus a small "wheel" hub with spokes
   *  (≈ the GLB's wheel footprint). `s` = world→px scale. */
  private drawStation(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, s: number,
    selected: boolean, alpha: number,
  ): void {
    const color = KIND_COLOR.station;
    const ringR = GameConfig.stations.captureRadius * s;
    const hubR = 26 * s;
    ctx.globalAlpha = alpha;
    // Dock/capture ring — dashed, faint fill so the footprint reads on the board.
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, Math.PI * 2);
    ctx.fillStyle = `${color}1a`; // ~10% fill
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Wheel hub + spokes.
    ctx.beginPath();
    ctx.arc(x, y, hubR, 0, Math.PI * 2);
    ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * hubR, y + Math.sin(a) * hubR);
      ctx.stroke();
    }
    if (selected) this.drawSelectionRing(ctx, x, y, ringR + 5);
    ctx.globalAlpha = 1;
  }

  /** A carrier/wreck hull marker: rotated rect + nose tick. `s` here is the
   *  combined world→px scale (wrecks fold their own scale factor in). */
  private drawHull(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, rotY: number, s: number,
    fill: string, stroke: string, selected: boolean, alpha = 1,
  ): void {
    const len = HULL_LEN * s;
    const wid = HULL_WIDTH * s;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    // rotationY=0 faces +Z (canvas up): rotate so the length axis tracks it.
    ctx.rotate(rotY - Math.PI / 2);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.beginPath();
    // Hexagonal hull silhouette: tapered nose (+x end), blunt stern.
    ctx.moveTo(len / 2, 0);
    ctx.lineTo(len / 4, -wid / 2);
    ctx.lineTo(-len / 2, -wid / 2.6);
    ctx.lineTo(-len / 2, wid / 2.6);
    ctx.lineTo(len / 4, wid / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (selected) this.drawSelectionRing(ctx, x, y, Math.max(len, wid) / 2 + 6);
  }

  private drawSelectionRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#f9e2af";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Draft ↔ MapConfig conversion ─────────────────────────────────────────

  /** camelCase id derived from the name ("Broken Crown" → "brokenCrown"). */
  private mapId(): string {
    const words = this.name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
    if (words.length === 0) return "customMap";
    const id = words
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join("");
    return /^[0-9]/.test(id) ? `map${id}` : id;
  }

  /** The draft as a MapConfig value (world→fractional conversion happens
   *  here; optional sections are omitted when empty, like the catalog). */
  private buildMap(): DraftMap {
    const hx = GameConfig.arena.halfWidth;
    const hz = GameConfig.arena.halfDepth;
    const frac = (v: number, half: number): number => Math.round((v / half) * 1000) / 1000;
    const toFracZone = (z: EditorZone): { xFrac: number; zFrac: number; radius: number } => ({
      xFrac: frac(z.x, hx),
      zFrac: frac(z.z, hz),
      radius: Math.round(z.radius),
    });

    const regions = this.zones.filter((z) => z.kind === "region");
    const map: DraftMap = {
      name: this.name,
      blurb: this.blurb || "Custom arena.",
      carrierZ: { player: this.carrierZ.player, enemy: this.carrierZ.enemy },
      asteroids: {
        count: this.asteroids.count,
        radiusMin: this.asteroids.radiusMin,
        radiusMax: this.asteroids.radiusMax,
        ...(regions.length > 0
          ? { regions: regions.map((z) => ({ x: z.x, z: z.z, radius: Math.round(z.radius) })) }
          : {}),
        driftSpeedMin: this.asteroids.driftSpeedMin,
        driftSpeedMax: this.asteroids.driftSpeedMax,
      },
      nebulaZones: this.zones.filter((z) => z.kind === "nebula").map(toFracZone),
    };
    const storms = this.zones.filter((z) => z.kind === "storm").map(toFracZone);
    if (storms.length > 0) map.stormZones = storms;
    if (this.stations.length > 0) {
      map.stations = this.stations.map((st) => ({
        xFrac: frac(st.x, hx),
        zFrac: frac(st.z, hz),
      }));
    }
    if (this.hulks.length > 0) {
      map.hazards = this.hulks.map((h) => {
        const spec: HulkHazard = { kind: "hulk", source: h.source, x: h.x, z: h.z };
        if (h.rotationY !== 0) spec.rotationY = round3(h.rotationY);
        if (h.rotationRate !== 0) spec.rotationRate = h.rotationRate;
        if (h.pitchRate !== 0) spec.pitchRate = h.pitchRate;
        if (h.rollRate !== 0) spec.rollRate = h.rollRate;
        if (h.scale !== 1) spec.scale = h.scale;
        return spec;
      });
    }
    return map;
  }

  /** Load a catalog/imported/draft map into the editor (fractional→world). */
  private loadMap(map: Partial<DraftMap>): void {
    const hx = GameConfig.arena.halfWidth;
    const hz = GameConfig.arena.halfDepth;
    this.name = map.name ?? "New Map";
    this.blurb = map.blurb ?? "";
    this.carrierZ = {
      player: map.carrierZ?.player ?? -700,
      enemy: map.carrierZ?.enemy ?? 700,
    };
    this.asteroids = {
      count: map.asteroids?.count ?? GameConfig.asteroids.count,
      radiusMin: map.asteroids?.radiusMin ?? GameConfig.asteroids.radiusMin,
      radiusMax: map.asteroids?.radiusMax ?? GameConfig.asteroids.radiusMax,
      driftSpeedMin: map.asteroids?.driftSpeedMin ?? GameConfig.asteroids.driftSpeedMin,
      driftSpeedMax: map.asteroids?.driftSpeedMax ?? GameConfig.asteroids.driftSpeedMax,
    };
    this.zones = [];
    const fromFrac = (kind: EditorZone["kind"], z: { xFrac: number; zFrac: number; radius: number }): EditorZone => ({
      kind,
      x: Math.round(z.xFrac * hx),
      z: Math.round(z.zFrac * hz),
      radius: z.radius,
    });
    for (const z of map.nebulaZones ?? []) this.zones.push(fromFrac("nebula", z));
    for (const z of map.stormZones ?? []) this.zones.push(fromFrac("storm", z));
    for (const rg of map.asteroids?.regions ?? []) {
      this.zones.push({ kind: "region", x: rg.x, z: rg.z, radius: rg.radius });
    }
    this.stations = (map.stations ?? []).map((st) => ({
      x: Math.round(st.xFrac * hx),
      z: Math.round(st.zFrac * hz),
    }));
    this.hulks = (map.hazards ?? [])
      .filter((h): h is HulkHazard => h.kind === "hulk")
      .map((h) => ({
        source: h.source,
        x: h.x,
        z: h.z,
        rotationY: h.rotationY ?? 0,
        rotationRate: h.rotationRate ?? 0,
        pitchRate: h.pitchRate ?? 0,
        rollRate: h.rollRate ?? 0,
        scale: h.scale ?? 1,
      }));
  }

  // ── Persistence + header actions ─────────────────────────────────────────

  /** Every mutation funnels here: persist the draft, repaint. */
  private touch(): void {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this.buildMap()));
    } catch {
      // Storage unavailable — editing still works, it just won't survive reload.
    }
    this.draw();
  }

  /** COPY MAP: a paste-ready MAPS entry, formatted as TS SOURCE in the same
   *  style as the hand-written catalog (bare keys, flat objects like zones
   *  inline one per line) — it drops into shared/src/Maps.ts as-is. IMPORT
   *  round-trips it by re-quoting the bare keys (quoteBareKeys). */
  private async copySnippet(): Promise<void> {
    const id = this.mapId();
    const snippet =
      `// Map editor export — paste this entry into MAPS in shared/src/Maps.ts\n` +
      `// and add "${id}" to the ConcreteMapId union at the top of that file.\n` +
      `${id}: ${tsSource({ id, ...this.buildMap() }, "")},`;
    try {
      await navigator.clipboard.writeText(snippet);
      this.status(`Copied "${id}" — paste into MAPS in shared/src/Maps.ts`);
    } catch {
      this.openIo(snippet);
      this.status("Clipboard unavailable — copy from the box below");
    }
  }

  /** IMPORT: accepts a COPY MAP snippet (TS-style, bare keys) or a MapConfig
   *  JSON object. Catalog entries with computed values (`Math.PI / 2`) won't
   *  parse — use LOAD PRESET for those. */
  private applyIo(): void {
    let text = this.byId<HTMLTextAreaElement>("med-io-text").value;
    text = text
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .trim()
      .replace(/,\s*$/, "")
      .replace(/^"?[\w$]+"?\s*:\s*(?=\{)/, ""); // strip the `id:` entry label
    try {
      const parsed = JSON.parse(quoteBareKeys(text)) as Partial<DraftMap>;
      if (!parsed || typeof parsed !== "object" || !parsed.carrierZ) {
        this.status("Not a map entry — paste a COPY MAP export");
        return;
      }
      this.loadMap(parsed);
      this.selection = null;
      this.closeIo();
      this.syncPanel();
      this.touch();
      this.status(`Imported "${this.name}"`);
    } catch {
      this.status("Couldn't parse that — paste a COPY MAP export");
    }
  }

  private clearAll(): void {
    const btn = this.byId<HTMLButtonElement>("med-clear");
    if (!this.clearArmed) {
      this.clearArmed = true;
      btn.textContent = "CLICK TO CONFIRM";
      btn.classList.add("armed");
      window.clearTimeout(this.clearArmTimer);
      this.clearArmTimer = window.setTimeout(() => {
        this.clearArmed = false;
        btn.textContent = "CLEAR";
        btn.classList.remove("armed");
      }, 3000);
      return;
    }
    window.clearTimeout(this.clearArmTimer);
    this.clearArmed = false;
    btn.textContent = "CLEAR";
    btn.classList.remove("armed");
    this.loadMap({});
    this.selection = null;
    this.syncPanel();
    this.touch();
    this.status("Cleared — blank board");
  }

  // ── Small helpers ────────────────────────────────────────────────────────

  private bindNum(id: string, min: number, max: number, set: (v: number) => void): void {
    const input = this.byId<HTMLInputElement>(id);
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (Number.isNaN(v)) return;
      const clamped = clamp(v, min, max);
      input.value = String(clamped);
      set(clamped);
      this.touch();
    });
  }

  private bindText(id: string, set: (v: string) => void): void {
    const input = this.byId<HTMLInputElement>(id);
    input.addEventListener("input", () => {
      set(input.value);
      this.touch();
    });
  }

  private openIo(text: string): void {
    const io = this.root.querySelector<HTMLElement>(".settings-io")!;
    io.hidden = false;
    const ta = this.byId<HTMLTextAreaElement>("med-io-text");
    ta.value = text;
    ta.focus();
  }

  private closeIo(): void {
    this.root.querySelector<HTMLElement>(".settings-io")!.hidden = true;
  }

  private status(text: string): void {
    const el = this.root.querySelector<HTMLElement>(".settings-status")!;
    el.textContent = text;
    window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => (el.textContent = ""), 4500);
  }

  private byId<T extends HTMLElement = HTMLButtonElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Serialize a value as TS source in the MAPS catalog's hand-written style:
 * bare identifier keys, flat objects (zones, carrierZ, hazard specs) inline
 * on one line, nested structures indented. Strings/numbers via
 * JSON.stringify, so the output is also JSON apart from the bare keys.
 */
function tsSource(v: unknown, indent: string): string {
  const pad = indent + "  ";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((e) => `${pad}${tsSource(e, pad)},`).join("\n")}\n${indent}]`;
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(
      ([, x]) => x !== undefined,
    );
    if (entries.length === 0) return "{}";
    const flat = entries.every(([, x]) => x === null || typeof x !== "object");
    if (flat) {
      return `{ ${entries.map(([k, x]) => `${k}: ${tsSource(x, pad)}`).join(", ")} }`;
    }
    return `{\n${entries.map(([k, x]) => `${pad}${k}: ${tsSource(x, pad)},`).join("\n")}\n${indent}}`;
  }
  return JSON.stringify(v);
}

/**
 * Turn a TS-style object literal back into strict JSON: quote the bare
 * identifier keys and drop trailing commas (tsSource's two JSON deviations).
 * A tiny scanner, not a regex pass, so colons/commas INSIDE string values
 * (a blurb like "Danger: keep out") never get mangled.
 */
function quoteBareKeys(src: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += src[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ",") {
      const next = /^\s*([\]}])?/.exec(src.slice(i + 1));
      if (next?.[1]) continue; // trailing comma before ] or } — drop it
      out += ch;
      continue;
    }
    const key = /^[A-Za-z_$][\w$]*(?=\s*:)/.exec(src.slice(i));
    if (key) {
      out += `"${key[0]}"`;
      i += key[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}
