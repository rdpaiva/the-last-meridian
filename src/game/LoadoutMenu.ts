import { GameConfig, type ShipTypeId } from "./GameConfig";
import { FACTION_THEME, opposing, type Faction } from "./Faction";
import { loadSavedLoadout, saveLoadout, type PlayerLoadout } from "./Loadout";
import {
  MAPS,
  loadSavedMapSelection,
  saveMapSelection,
  type ConcreteMapId,
  type MapId,
} from "./Maps";
import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  loadSavedDifficulty,
  saveDifficulty,
  type DifficultyId,
} from "./Difficulty";
import type { ShipPreview } from "./ShipPreview";

/**
 * The faction-select stage of the splash flow: pick a side, pick a ship,
 * launch. Plain DOM like the HUD (no framework). Shown only after the intro
 * crawl completes / is skipped (main.ts owns the state machine).
 *
 * Layout (progressive reveal — never everything at once):
 *   CHOOSE YOUR SIDE
 *   [faction card] [faction card]      ← headline choice
 *   selected-faction description
 *   [ship card] [ship card]            ← only the SELECTED faction's roster
 *   hangar preview panel               ← live rotating 3D model (ShipPreview)
 *   [ PLAY ]
 *
 * Interaction:
 *   - the saved loadout (localStorage) is preselected, and every change is
 *     saved immediately, so quick play always reflects the latest choice;
 *   - fully keyboard-driven: ←/→ select within the active row, ↑/↓ switch
 *     rows, Enter = PLAY (main.ts owns Enter so it shares the button path);
 *   - mouse clicking any card or PLAY works too.
 *
 * Ship stats are read straight from GameConfig.shipTypes and normalized
 * against the catalog maxima — no duplicated numbers to drift. Ship card
 * thumbnails + the big preview come from ShipPreview (one live 3D view only;
 * cards get cached static captures).
 */

/**
 * Portrait art per side — the big, pronounced faces on the faction cards.
 * Resolved against BASE_URL (like the splash poster) so it loads under the
 * GitHub Pages sub-path too.
 */
const FACTION_PORTRAIT: Record<Faction, string> = {
  humans: "images/Human-Pilot.jpg",
  machines: "images/Novari.jpg",
};

/** One-word flavor tag shown above each faction's name on its card. */
const FACTION_TAG: Record<Faction, string> = {
  humans: "BASELINE HUMANITY",
  machines: "THE ASCENDANCY",
};

/** One-line pitch for the selected side (story bible §2). */
const FACTION_DESC: Record<Faction, string> = {
  humans:
    "Surviving baseline humanity. Disciplined carrier fleets holding the line of the Severance — fighting to prevent a second collapse.",
  machines:
    "Enhanced humans bound by the Thread the Loom wove into them. Cast out as a threat — fighting for their freedom along the Last Meridian.",
};

/** Display strings per catalog ship (canon naming — story bible §8). */
export const SHIP_INFO: Record<
  ShipTypeId,
  { name: string; role: string; summary: string; blurb: string }
> = {
  spitfire: {
    name: "Spitfire",
    role: "Interceptor",
    summary: "Fast Commonwealth dogfighter",
    blurb:
      "Fast and agile, with a forgiving hull and a full heat-seeker rack — the Commonwealth's all-rounder.",
  },
  breaker: {
    name: "Breaker",
    role: "Heavy Gunship",
    summary: "Armored Commonwealth weapons truck",
    blurb:
      "Armored weapons truck. The best sustained guns in the catalog, double missile rack, ponderous turn — lead your targets.",
  },
  wraith: {
    name: "Wraith",
    role: "Interceptor",
    summary: "Fast Novari strike craft",
    blurb:
      "Novari knife-fighter built for speed, precision, and close-range dogfighting. Fastest ship there is — light hull, no missiles.",
  },
  reaver: {
    name: "Reaver",
    role: "Heavy Gunship",
    summary: "Heavy Novari siege platform",
    blurb:
      "Scythe-winged siege platform. The toughest hull, the heaviest bolts, and the biggest missile rack — paid for in speed.",
  },
};

/** The arena-picker options: the concrete maps (catalog order) then Random. */
const MAP_OPTIONS: MapId[] = [
  ...(Object.keys(MAPS) as ConcreteMapId[]),
  "random",
];

/** Card title + blurb for a map option (Random is synthetic; the rest read
 *  straight from the catalog so there's no duplicated copy to drift). */
function mapCardInfo(id: MapId): { name: string; blurb: string } {
  if (id === "random") {
    return { name: "Random", blurb: "A different arena every match." };
  }
  const m = MAPS[id];
  return { name: m.name, blurb: m.blurb };
}

/** Half-extent (world units) the thumbnail maps onto its 100×100 viewBox —
 *  big enough to frame the most-separated carriers (The Void's ±850). */
const THUMB_WORLD_HALF = 900;

/**
 * A top-down tactical schematic of a map, drawn straight from its MapConfig:
 * the two carriers, asteroid regions (or a scatter speckle for an unregioned
 * field), and nebula blobs — all in their real relative positions, so the card
 * actually previews the battlefield with no art assets. +Z (the machine
 * carrier) is up, matching the in-game north-up radar. Random gets a "?".
 */
function mapThumbnailSvg(id: MapId): string {
  const back = `<rect x="2" y="2" width="96" height="96" rx="4" fill="#0a0c15" stroke="rgba(120,140,200,0.3)" stroke-width="1"/>`;
  const wrap = (inner: string): string =>
    `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${back}${inner}</svg>`;

  if (id === "random") {
    return wrap(
      `<text x="50" y="50" dy="0.35em" text-anchor="middle" font-size="46" font-weight="700" fill="rgba(180,190,254,0.85)" font-family="ui-sans-serif, system-ui, sans-serif">?</text>`,
    );
  }

  const m = MAPS[id];
  const ax = GameConfig.arena.halfWidth;
  const az = GameConfig.arena.halfDepth;
  const sx = (x: number): string => (50 + (x / THUMB_WORLD_HALF) * 48).toFixed(1);
  const sy = (z: number): string => (50 - (z / THUMB_WORLD_HALF) * 48).toFixed(1);
  const sr = (r: number): string => ((r / THUMB_WORLD_HALF) * 48).toFixed(1);

  const parts: string[] = [];
  // Nebula stealth blobs (drawn under the rocks).
  for (const z of m.nebulaZones) {
    parts.push(
      `<circle cx="${sx(z.xFrac * ax)}" cy="${sy(z.zFrac * az)}" r="${sr(z.radius)}" fill="rgba(150,90,210,0.32)"/>`,
    );
  }
  // Asteroids: real region circles, or a deterministic spiral speckle standing
  // in for a full-arena scatter field (no regions but count > 0).
  const regions = m.asteroids.regions;
  if (regions && regions.length > 0) {
    for (const rg of regions) {
      parts.push(
        `<circle cx="${sx(rg.x)}" cy="${sy(rg.z)}" r="${sr(rg.radius)}" fill="rgba(150,150,165,0.28)"/>`,
      );
    }
  } else if (m.asteroids.count > 0) {
    const n = Math.min(18, m.asteroids.count);
    for (let i = 0; i < n; i++) {
      const ang = i * 2.4; // golden-angle spiral → even fill
      const rad = Math.sqrt((i + 0.5) / n) * 520;
      parts.push(
        `<circle cx="${sx(Math.cos(ang) * rad)}" cy="${sy(Math.sin(ang) * rad)}" r="1.6" fill="rgba(150,150,165,0.5)"/>`,
      );
    }
  }
  // Wrecks — a dark slab at the hulk's footprint (drawn under the carriers).
  // Assumes the rotationY 0/π facings the presets use (axis-aligned footprint).
  for (const h of m.hazards ?? []) {
    if (h.kind !== "hulk") continue;
    const rects = GameConfig.mothership.hullRects[h.source];
    let hw = 0;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const rc of rects) {
      hw = Math.max(hw, rc.halfWidth);
      z0 = Math.min(z0, rc.z0);
      z1 = Math.max(z1, rc.z1);
    }
    const sc = h.scale ?? 1;
    const wpx = (2 * hw * sc) / THUMB_WORLD_HALF * 48;
    const dpx = ((z1 - z0) * sc) / THUMB_WORLD_HALF * 48;
    parts.push(
      `<rect x="${(parseFloat(sx(h.x)) - wpx / 2).toFixed(1)}" y="${(parseFloat(sy(h.z)) - dpx / 2).toFixed(1)}" width="${wpx.toFixed(1)}" height="${dpx.toFixed(1)}" rx="1" fill="rgba(70,72,82,0.9)"/>`,
    );
  }
  // Carriers — neutral steel bars (the schematic is faction-agnostic).
  const cx = (parseFloat(sx(0)) - 8).toFixed(1);
  for (const cz of [m.carrierZ.player, m.carrierZ.enemy]) {
    parts.push(
      `<rect x="${cx}" y="${(parseFloat(sy(cz)) - 2).toFixed(1)}" width="16" height="4" rx="1.5" fill="#9aa6c8"/>`,
    );
  }
  return wrap(parts.join(""));
}

/** Sustained gun output (damage/sec) — what the GUNS bar shows. */
function gunsDps(id: ShipTypeId): number {
  const t = GameConfig.shipTypes[id];
  return (t.laserDamage * 1000) / t.fireCooldownMs;
}

/** Catalog maxima the stat bars normalize against. */
const ALL_IDS = Object.keys(GameConfig.shipTypes) as ShipTypeId[];
const MAX_STAT = {
  speed: Math.max(...ALL_IDS.map((id) => GameConfig.shipTypes[id].maxSpeed)),
  turn: Math.max(...ALL_IDS.map((id) => GameConfig.shipTypes[id].rotationSpeed)),
  hull: Math.max(...ALL_IDS.map((id) => GameConfig.shipTypes[id].maxHp)),
  guns: Math.max(...ALL_IDS.map(gunsDps)),
  missiles: Math.max(...ALL_IDS.map((id) => GameConfig.shipTypes[id].missileAmmo)),
};

type Row = "faction" | "ship" | "difficulty" | "map";

/**
 * The loadout is split across two pages so neither feels busy:
 *   1 — your craft: faction + ship (+ the hangar preview)
 *   2 — the mission: difficulty + arena
 * Each page's keyboard-walkable rows (↑/↓ move between them); ENTER advances
 * page 1 → 2 then launches, ESC steps back.
 */
type Step = 1 | 2;
const STEP_ROWS: Record<Step, readonly Row[]> = {
  1: ["faction", "ship"],
  2: ["difficulty", "map"],
};

export class LoadoutMenu {
  private faction: Faction;
  private shipType: ShipTypeId;
  /** Enemy-skill preset — easy / medium / hard. */
  private difficulty: DifficultyId;
  /** The arena selection — a concrete map (pinned) or "random" (re-rolls). */
  private mapSelection: MapId;
  /** Which page of the loadout is showing. */
  private step: Step = 1;
  /** Which row ←/→ act on; ↑/↓ move between them. */
  private activeRow: Row = "faction";
  private detached = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly preview: ShipPreview,
    private readonly onPlay: () => void,
  ) {
    const saved = loadSavedLoadout();
    this.faction = saved.faction;
    this.shipType = saved.shipType;
    this.difficulty = loadSavedDifficulty();
    this.mapSelection = loadSavedMapSelection();
    this.render();
    window.addEventListener("keydown", this.onKeyDown);
  }

  get loadout(): PlayerLoadout {
    return { faction: this.faction, shipType: this.shipType };
  }

  /**
   * Persist the selection and detach the keyboard handler. Call exactly when
   * the game launches — after this the arrow keys belong to the ship.
   */
  commit(): PlayerLoadout {
    if (!this.detached) {
      this.detached = true;
      window.removeEventListener("keydown", this.onKeyDown);
      saveLoadout(this.loadout);
      saveDifficulty(this.difficulty);
      saveMapSelection(this.mapSelection);
    }
    return this.loadout;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Only act while the loadout is the active splash page — never behind the
    // match-settings overlay (whose Enter would otherwise launch the game), nor
    // on the landing/quick-play screens.
    if (document.getElementById("splash")?.dataset.state !== "factionSelect") return;
    // A focused form control owns the arrow keys (the match-settings overlay
    // can sit on top of this menu, and its sliders/number fields would be
    // frozen by the preventDefault below).
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    switch (e.code) {
      case "Enter":
        // Page 1 advances to the mission setup; page 2 launches (the same
        // path the NEXT/PLAY buttons take). main.ts no longer launches on
        // Enter in factionSelect — this owns it.
        e.preventDefault();
        if (this.step === 1) this.goStep(2);
        else this.onPlay();
        break;
      case "Escape":
      case "Backspace":
        if (this.step === 2) {
          e.preventDefault();
          this.goStep(1);
        }
        break;
      case "ArrowUp":
      case "ArrowDown": {
        const dir = e.code === "ArrowDown" ? 1 : -1;
        const rows = STEP_ROWS[this.step];
        const i = Math.max(0, rows.indexOf(this.activeRow));
        this.activeRow = rows[(i + dir + rows.length) % rows.length];
        e.preventDefault();
        this.render();
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = e.code === "ArrowRight" ? 1 : -1;
        if (this.activeRow === "faction") {
          // Only two sides — either arrow toggles.
          this.setFaction(opposing(this.faction));
        } else if (this.activeRow === "ship") {
          const ships = GameConfig.factionShips[this.faction];
          const idx = (ships.indexOf(this.shipType) + dir + ships.length) % ships.length;
          this.shipType = ships[idx];
        } else if (this.activeRow === "difficulty") {
          const idx =
            (DIFFICULTY_ORDER.indexOf(this.difficulty) + dir + DIFFICULTY_ORDER.length) %
            DIFFICULTY_ORDER.length;
          this.difficulty = DIFFICULTY_ORDER[idx];
        } else {
          const idx =
            (MAP_OPTIONS.indexOf(this.mapSelection) + dir + MAP_OPTIONS.length) %
            MAP_OPTIONS.length;
          this.mapSelection = MAP_OPTIONS[idx];
        }
        e.preventDefault();
        this.saveAndRender();
        break;
      }
    }
  };

  /** Move to a loadout page, landing the cursor on its first row. */
  private goStep(next: Step): void {
    this.step = next;
    this.activeRow = STEP_ROWS[next][0];
    this.render();
  }

  /** Switch sides, carrying the ship ROLE across (fighter ↔ fighter, etc.). */
  private setFaction(f: Faction): void {
    if (f === this.faction) return;
    const roleIdx = Math.max(
      0,
      GameConfig.factionShips[this.faction].indexOf(this.shipType),
    );
    this.faction = f;
    const ships = GameConfig.factionShips[f];
    this.shipType = ships[Math.min(roleIdx, ships.length - 1)];
  }

  /** Every user-driven selection change persists immediately (quick play
   *  reads the same keys next session). Row toggles use plain render(). */
  private saveAndRender(): void {
    saveLoadout(this.loadout);
    saveDifficulty(this.difficulty);
    saveMapSelection(this.mapSelection);
    this.render();
  }

  /**
   * Full re-render on every change — a handful of cards on a pre-game screen,
   * nowhere near a hot path. Re-renders also re-bind the click handlers and
   * re-adopt the preview canvas (innerHTML would otherwise orphan it).
   */
  private render(): void {
    const factionCards = (["humans", "machines"] as Faction[])
      .map((f) => {
        const t = FACTION_THEME[f];
        const sel = f === this.faction ? " selected" : "";
        const portrait = `${import.meta.env.BASE_URL}${FACTION_PORTRAIT[f]}`;
        return `
          <div class="loadout-card faction-card ${f}${sel}" data-faction="${f}">
            <div class="faction-portrait" style="background-image: url('${portrait}')"></div>
            <div class="faction-scrim"></div>
            <div class="faction-check">▶ SELECTED</div>
            <div class="faction-body">
              <div class="faction-tag">${FACTION_TAG[f]}</div>
              <div class="faction-name">${t.fullName.toUpperCase()}</div>
              <div class="faction-mothership">${t.mothershipClass} · ${t.mothershipName}</div>
            </div>
          </div>`;
      })
      .join("");

    const shipCards = GameConfig.factionShips[this.faction]
      .map((id) => this.shipCard(id))
      .join("");

    const diffCards = DIFFICULTY_ORDER.map((id) => this.diffCard(id)).join("");
    const mapCards = MAP_OPTIONS.map((id) => this.mapCard(id)).join("");

    // Page 1 — your craft (faction + ship + hangar); page 2 — the mission
    // (difficulty + arena). Splitting them keeps either page from feeling busy.
    // The step drives the page-specific CSS (vertical centering + card sizing).
    this.root.dataset.step = String(this.step);
    this.root.innerHTML =
      this.step === 1
        ? `
      <div class="loadout-heading">Choose your craft</div>
      <div class="loadout-row${this.activeRow === "faction" ? " active" : ""}" id="loadout-factions">${factionCards}</div>
      <div class="faction-desc">${FACTION_DESC[this.faction]}</div>
      <div class="loadout-row${this.activeRow === "ship" ? " active" : ""}" id="loadout-ships">${shipCards}</div>
      ${this.previewPanel()}
      <div class="loadout-step">STEP 1 OF 2</div>
      <button id="loadout-next" class="loadout-cta ${this.faction}">NEXT ▸</button>
      <div class="loadout-hint">←/→ SELECT · ↑/↓ ROW · ENTER NEXT</div>`
        : `
      <div class="loadout-heading">Mission setup</div>
      <div class="loadout-subheading">Difficulty</div>
      <div class="loadout-row${this.activeRow === "difficulty" ? " active" : ""}" id="loadout-difficulty">${diffCards}</div>
      <div class="loadout-subheading">Arena</div>
      <div class="loadout-row${this.activeRow === "map" ? " active" : ""}" id="loadout-maps">${mapCards}</div>
      <div class="loadout-step">STEP 2 OF 2</div>
      <div class="loadout-actions">
        <button id="loadout-back" class="loadout-back">◂ BACK</button>
        <button id="loadout-play" class="loadout-cta ${this.faction}">PLAY</button>
      </div>
      <div class="loadout-hint">←/→ SELECT · ↑/↓ ROW · ESC BACK · ENTER LAUNCH</div>`;

    for (const el of this.root.querySelectorAll<HTMLElement>(".faction-card")) {
      el.addEventListener("click", () => {
        this.activeRow = "faction";
        this.setFaction(el.dataset.faction as Faction);
        this.saveAndRender();
      });
    }
    for (const el of this.root.querySelectorAll<HTMLElement>(".ship-card")) {
      el.addEventListener("click", () => {
        this.activeRow = "ship";
        this.shipType = el.dataset.ship as ShipTypeId;
        this.saveAndRender();
      });
    }
    for (const el of this.root.querySelectorAll<HTMLElement>(".diff-card")) {
      el.addEventListener("click", () => {
        this.activeRow = "difficulty";
        this.difficulty = el.dataset.diff as DifficultyId;
        this.saveAndRender();
      });
    }
    for (const el of this.root.querySelectorAll<HTMLElement>(".map-card")) {
      el.addEventListener("click", () => {
        this.activeRow = "map";
        this.mapSelection = el.dataset.map as MapId;
        this.saveAndRender();
      });
    }
    // Page navigation buttons (only one page's buttons exist per render).
    this.root
      .querySelector<HTMLButtonElement>("#loadout-next")
      ?.addEventListener("click", () => this.goStep(2));
    this.root
      .querySelector<HTMLButtonElement>("#loadout-back")
      ?.addEventListener("click", () => this.goStep(1));
    this.root
      .querySelector<HTMLButtonElement>("#loadout-play")
      ?.addEventListener("click", () => this.onPlay());

    // Re-adopt the live preview canvas (one shared element across renders) and
    // point it at the current selection. The hangar only exists on page 1.
    const stage = this.root.querySelector<HTMLElement>("#ship-preview-stage");
    if (stage) {
      stage.appendChild(this.preview.canvas);
      this.preview.resize();
      void this.preview.show(this.shipType);
    }

    // Static thumbnails for the visible ship cards — cached after first
    // capture, so this is async exactly once per ship.
    for (const el of this.root.querySelectorAll<HTMLElement>(".ship-thumb")) {
      const id = el.dataset.thumbFor as ShipTypeId;
      void this.preview.thumbnail(id).then((url) => {
        if (url && el.isConnected) el.style.backgroundImage = `url(${url})`;
      });
    }
  }

  /** Compact roster card: thumbnail + name/role/one-liner + two key bars. */
  private shipCard(id: ShipTypeId): string {
    const t = GameConfig.shipTypes[id];
    const info = SHIP_INFO[id];
    const sel = id === this.shipType ? " selected" : "";
    const miniBars = this.statRows([
      ["SPD", t.maxSpeed, MAX_STAT.speed],
      ["HULL", t.maxHp, MAX_STAT.hull],
    ]);
    return `
      <div class="loadout-card ship-card ${this.faction}${sel}" data-ship="${id}">
        <div class="ship-thumb" data-thumb-for="${id}"></div>
        <div class="ship-card-info">
          <div class="card-title">${info.name.toUpperCase()}</div>
          <div class="card-sub">${info.role}</div>
          <div class="card-blurb">${info.summary}</div>
          ${miniBars}
        </div>
      </div>`;
  }

  /** Compact difficulty card: name + one-line blurb. Drives the enemy-skill
   *  preset (Difficulty.ts); the player's own wing is unaffected. */
  private diffCard(id: DifficultyId): string {
    const d = DIFFICULTIES[id];
    const sel = id === this.difficulty ? " selected" : "";
    return `
      <div class="loadout-card diff-card${sel}" data-diff="${id}">
        <div class="card-title">${d.name.toUpperCase()}</div>
        <div class="card-blurb">${d.blurb}</div>
      </div>`;
  }

  /** Compact arena card: a top-down schematic thumbnail (drawn from the map's
   *  config) + name + one-line blurb. No 3D turntable for maps in v1. */
  private mapCard(id: MapId): string {
    const info = mapCardInfo(id);
    const sel = id === this.mapSelection ? " selected" : "";
    return `
      <div class="loadout-card map-card${sel}" data-map="${id}">
        <div class="map-thumb">${mapThumbnailSvg(id)}</div>
        <div class="ship-card-info">
          <div class="card-title">${info.name.toUpperCase()}</div>
          <div class="card-blurb">${info.blurb}</div>
        </div>
      </div>`;
  }

  /** The "hangar" panel: live 3D turntable + expanded stats for the pick. */
  private previewPanel(): string {
    const t = GameConfig.shipTypes[this.shipType];
    const info = SHIP_INFO[this.shipType];
    const theme = FACTION_THEME[this.faction];
    const bars = this.statRows([
      ["SPD", t.maxSpeed, MAX_STAT.speed],
      ["TRN", t.rotationSpeed, MAX_STAT.turn],
      ["HULL", t.maxHp, MAX_STAT.hull],
      ["GUNS", gunsDps(this.shipType), MAX_STAT.guns],
      ["MSLS", t.missileAmmo, MAX_STAT.missiles],
    ]);
    return `
      <div id="ship-preview" class="${this.faction}">
        <div id="ship-preview-stage"></div>
        <div id="ship-preview-info">
          <div class="preview-name">${info.name.toUpperCase()} ${info.role.toUpperCase()}</div>
          <div class="preview-role">${theme.fullName}</div>
          <div class="preview-blurb">${info.blurb}</div>
          ${bars}
        </div>
      </div>`;
  }

  private statRows(bars: Array<[string, number, number]>): string {
    return bars
      .map(
        ([label, value, max]) => `
          <div class="stat-row">
            <span class="stat-label">${label}</span>
            <div class="stat-track"><div class="stat-fill" style="width: ${Math.min(100, Math.round((value / max) * 100))}%"></div></div>
          </div>`,
      )
      .join("");
  }
}
