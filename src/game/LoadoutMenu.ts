import { GameConfig, type ShipTypeId } from "./GameConfig";
import { FACTION_THEME, opposing, type Faction } from "./Faction";
import { loadSavedLoadout, saveLoadout, type PlayerLoadout } from "./Loadout";

/**
 * Splash-screen loadout select: pick a side, pick a ship, launch. Plain DOM
 * like the HUD (no framework). Built for fast entry:
 *
 *   - the saved loadout (localStorage) is preselected, so a returning player
 *     just hits Enter to relaunch their last setup without touching the menu;
 *   - fully keyboard-driven: ←/→ select within the active row, ↑/↓ switch
 *     rows. Enter = START (main.ts owns Enter so it shares the button path);
 *   - mouse clicking any card works too.
 *
 * Ship stats on the cards are read straight from GameConfig.shipTypes and
 * normalized against the catalog maxima — no duplicated numbers to drift.
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

/** Display strings per catalog ship (canon naming — story bible §8). */
const SHIP_INFO: Record<ShipTypeId, { name: string; role: string; blurb: string }> = {
  spitfire: {
    name: "Spitfire",
    role: "Interceptor",
    blurb: "Fast and agile — the Commonwealth dogfighter.",
  },
  breaker: {
    name: "Breaker",
    role: "Heavy Gunship",
    blurb: "Armored weapons truck. Heavy bolts, double missile rack.",
  },
  wraith: {
    name: "Wraith",
    role: "Interceptor",
    blurb: "Quick Novari knife-fighter — light hull, no missiles.",
  },
  reaver: {
    name: "Reaver",
    role: "Heavy Gunship",
    blurb: "Scythe-winged siege platform. Hits hardest, turns slowest.",
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

  constructor(private readonly root: HTMLElement) {
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
        this.render();
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

  /**
   * Full re-render on every change — a handful of cards on a pre-game screen,
   * nowhere near a hot path. Re-renders also re-bind the click handlers.
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
      <div class="loadout-row${this.activeRow === "ship" ? " active" : ""}" id="loadout-ships">${shipCards}</div>
      <div class="loadout-hint">←/→ SELECT · ↑/↓ ROW · ENTER TO LAUNCH</div>`;

    for (const el of this.root.querySelectorAll<HTMLElement>(".faction-card")) {
      el.addEventListener("click", () => {
        this.activeRow = "faction";
        this.setFaction(el.dataset.faction as Faction);
        this.render();
      });
    }
    for (const el of this.root.querySelectorAll<HTMLElement>(".ship-card")) {
      el.addEventListener("click", () => {
        this.activeRow = "ship";
        this.shipType = el.dataset.ship as ShipTypeId;
        this.render();
      });
    }
  }

  private shipCard(id: ShipTypeId): string {
    const t = GameConfig.shipTypes[id];
    const info = SHIP_INFO[id];
    const sel = id === this.shipType ? " selected" : "";
    const bars: Array<[string, number, number]> = [
      ["SPD", t.maxSpeed, MAX_STAT.speed],
      ["TRN", t.rotationSpeed, MAX_STAT.turn],
      ["HULL", t.maxHp, MAX_STAT.hull],
      ["GUNS", gunsDps(id), MAX_STAT.guns],
      ["MSLS", t.missileAmmo, MAX_STAT.missiles],
    ];
    const statRows = bars
      .map(
        ([label, value, max]) => `
          <div class="stat-row">
            <span class="stat-label">${label}</span>
            <div class="stat-track"><div class="stat-fill" style="width: ${Math.round((value / max) * 100)}%"></div></div>
          </div>`,
      )
      .join("");
    return `
      <div class="loadout-card ship-card ${this.faction}${sel}" data-ship="${id}">
        <div class="card-title">${info.name.toUpperCase()}</div>
        <div class="card-sub">${info.role}</div>
        <div class="card-blurb">${info.blurb}</div>
        ${statRows}
      </div>`;
  }
}
