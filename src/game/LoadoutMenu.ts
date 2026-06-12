import { GameConfig, type ShipTypeId } from "./GameConfig";
import { FACTION_THEME, opposing, type Faction } from "./Faction";
import { loadSavedLoadout, saveLoadout, type PlayerLoadout } from "./Loadout";
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

export class LoadoutMenu {
  private faction: Faction;
  private shipType: ShipTypeId;
  /** Which row ←/→ act on; ↑/↓ toggle it. */
  private activeRow: "faction" | "ship" = "faction";
  private detached = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly preview: ShipPreview,
    private readonly onPlay: () => void,
  ) {
    const saved = loadSavedLoadout();
    this.faction = saved.faction;
    this.shipType = saved.shipType;
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
    }
    return this.loadout;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // A focused form control owns the arrow keys (the match-settings overlay
    // can sit on top of this menu, and its sliders/number fields would be
    // frozen by the preventDefault below).
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    switch (e.code) {
      case "ArrowUp":
      case "ArrowDown":
        this.activeRow = this.activeRow === "faction" ? "ship" : "faction";
        e.preventDefault();
        this.render();
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        if (this.activeRow === "faction") {
          // Only two sides — either arrow toggles.
          this.setFaction(opposing(this.faction));
        } else {
          const ships = GameConfig.factionShips[this.faction];
          const dir = e.code === "ArrowRight" ? 1 : -1;
          const idx = (ships.indexOf(this.shipType) + dir + ships.length) % ships.length;
          this.shipType = ships[idx];
        }
        e.preventDefault();
        this.saveAndRender();
        break;
      }
    }
  };

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

    this.root.innerHTML = `
      <div class="loadout-heading">Choose your side</div>
      <div class="loadout-row${this.activeRow === "faction" ? " active" : ""}" id="loadout-factions">${factionCards}</div>
      <div class="faction-desc">${FACTION_DESC[this.faction]}</div>
      <div class="loadout-row${this.activeRow === "ship" ? " active" : ""}" id="loadout-ships">${shipCards}</div>
      ${this.previewPanel()}
      <button id="loadout-play" class="${this.faction}">PLAY</button>
      <div class="loadout-hint">←/→ SELECT · ↑/↓ ROW · ENTER TO LAUNCH</div>`;

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
    this.root
      .querySelector<HTMLButtonElement>("#loadout-play")!
      .addEventListener("click", () => this.onPlay());

    // Re-adopt the live preview canvas (one shared element across renders)
    // and point it at the current selection.
    this.root
      .querySelector<HTMLElement>("#ship-preview-stage")!
      .appendChild(this.preview.canvas);
    this.preview.resize();
    void this.preview.show(this.shipType);

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
