import { GameConfig, PILOT_NAME_MAX, type ShipTypeId } from "@space-duel/shared";
import { FACTION_THEME, opposing, type Faction } from "@space-duel/shared";
import {
  hasSavedLoadout,
  hasSeenGuide,
  hasSeenIntro,
  loadPilotName,
  loadSavedLoadout,
  loadSavedMode,
  saveLoadout,
  saveMode,
  savePilotName,
  type PlayerLoadout,
} from "./Loadout";
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
import { inviteRoomId } from "../net/NetClient";
import { overrideCount } from "./ConfigOverrides";

/** How a launch leaves the splash: offline solo, or a server match. */
export type LaunchMode = "solo" | "online";

/** Splash-owned transitions the loadout hands off to — main.ts supplies
 *  them (it owns the splash state machine). */
export interface LoadoutActions {
  /** The MODE → HANGAR gate: called when step 1 advances. Returns true when
   *  main.ts intercepts with the first-run story crawl — the menu holds, and
   *  enterHangar() completes the advance after the intro. */
  firstRunIntro(): boolean;
  replayIntro(): void;
  openSettings(): void;
  /** Open the Field Manual card deck (FieldManual.ts). */
  openManual(): void;
}

/**
 * The loadout stage of the splash flow — and the splash's front door: pick a
 * mode, a side + ship, then the mission. Plain DOM like the HUD (no
 * framework). First-timers get the story crawl as a gate between MODE and
 * HANGAR (actions.firstRunIntro); returning players (intro seen + saved
 * loadout) get a gold CONTINUE CTA on step 1 that relaunches the saved
 * loadout in the selected mode with one press of Enter (the old quick-play
 * screen, folded into the frame).
 *
 * Layout — every step renders inside a fixed three-row frame so nothing can
 * overlap on short laptop screens (the old free-flowing column bug):
 *
 *   header rail    title · step dots (MODE/HANGAR/MISSION) · PILOT chip
 *   stage          the current step's cards; scrolls if it must
 *   footer rail    CONTROLS/REPLAY INTRO/MATCH SETTINGS · BACK + NEXT/LAUNCH · key hint
 *
 * The three steps:
 *   1 — MODE: solo vs. multiplayer as the headline boxes + the callsign,
 *       styled as pilot registration (it feeds the PILOT chip live).
 *   2 — HANGAR: faction cards, the selected side's roster, the live preview.
 *   3 — MISSION: solo → difficulty + arena; online → the quick-match/invite
 *       briefing (the server owns the arena, so no picker is shown).
 *
 * Interaction:
 *   - every selection (mode, faction, ship, difficulty, map, callsign) is
 *     saved immediately, so quick play always reflects the latest choice;
 *   - fully keyboard-driven: ←/→ select within the active row, ↑/↓ switch
 *     rows, ENTER next-then-launch, ESC back (or closes the controls overlay);
 *   - mouse clicking any card or button works too.
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
const FACTION_PORTRAIT: Record<Faction, string | null> = {
  humans: null,
  machines: null,
};

/** Video (no extension) played once on faction select (null = use still portrait). */
const FACTION_VIDEO: Record<Faction, string | null> = {
  humans: "videos/human-pilot-selection",
  machines: "videos/novari-pilot",
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

type Row = "mode" | "faction" | "ship" | "difficulty" | "map";

/** The three loadout steps; the header rail's dots mirror them. */
type Step = 1 | 2 | 3;
const STEP_LABELS: Record<Step, string> = { 1: "MODE", 2: "HANGAR", 3: "MISSION" };

export class LoadoutMenu {
  /** Solo vs. multiplayer — chosen first, adapts everything downstream. */
  private mode: LaunchMode;
  private faction: Faction;
  private shipType: ShipTypeId;
  /** Enemy-skill preset — easy / medium / hard (solo only). */
  private difficulty: DifficultyId;
  /** The arena selection — a concrete map (pinned) or "random" (re-rolls). */
  private mapSelection: MapId;
  /** Which page of the loadout is showing. */
  private step: Step = 1;
  /** Which row ←/→ act on; ↑/↓ move between them. */
  private activeRow: Row = "mode";
  private detached = false;
  /** Live label override for the online launch CTA ("CONNECTING…", errors). */
  private onlineStatus: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly preview: ShipPreview,
    private readonly onPlay: (mode: LaunchMode) => void,
    private readonly actions: LoadoutActions,
  ) {
    const saved = loadSavedLoadout();
    this.faction = saved.faction;
    this.shipType = saved.shipType;
    this.difficulty = loadSavedDifficulty();
    this.mapSelection = loadSavedMapSelection();
    // An invite link means the player came to join a friend — preselect
    // multiplayer (they can still switch to solo explicitly).
    this.mode = inviteRoomId() ? "online" : loadSavedMode();
    this.wireControlsOverlay();
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
      this.saveAll();
    }
    return this.loadout;
  }

  /**
   * Live label for the online launch CTA — "CONNECTING…" then an error line
   * when a join fails (null restores the launch label). A failed connect
   * hands control back to the menu, so the keyboard re-attaches too.
   */
  setOnlineStatus(text: string | null): void {
    this.onlineStatus = text;
    if (this.detached) {
      this.detached = false;
      window.addEventListener("keydown", this.onKeyDown);
    }
    this.render();
  }

  /** Re-render on external state the menu displays (the Match Settings
   *  override count in the footer) — main.ts calls it when settings change. */
  refresh(): void {
    this.render();
  }

  /** The keyboard-walkable rows of the current step. Online mission setup has
   *  none — the server owns difficulty and arena, so there's nothing to pick. */
  private rows(): readonly Row[] {
    if (this.step === 1) return ["mode"];
    if (this.step === 2) return ["faction", "ship"];
    return this.mode === "solo" ? ["difficulty", "map"] : [];
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Only act while the loadout is the active splash page — never behind the
    // match-settings overlay (whose Enter would otherwise launch the game),
    // nor during the intro crawl.
    if (document.getElementById("splash")?.dataset.state !== "factionSelect") return;
    // The controls overlay swallows Esc (close) and Enter (nothing) first.
    const overlay = document.getElementById("controls-overlay");
    if (overlay?.classList.contains("open")) {
      if (e.code === "Escape" || e.code === "Enter") {
        e.preventDefault();
        overlay.classList.remove("open");
      }
      return;
    }
    // The Field Manual owns the keyboard while it's up (its own handler pages
    // with ←/→/Enter and closes on Esc) — the menu must not also act on them.
    if (document.getElementById("field-manual")?.classList.contains("open")) return;
    // A focused form control owns the arrow keys (the match-settings overlay
    // can sit on top of this menu, and its sliders/number fields would be
    // frozen by the preventDefault below).
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    switch (e.code) {
      case "Enter":
        // A focused button (Tab navigation) keeps its native Enter-click —
        // that's how keyboard users reach NEXT past a CONTINUE default.
        if (target?.tagName === "BUTTON") return;
        // Step 1 with a saved run launches it (CONTINUE); otherwise steps 1
        // and 2 advance and step 3 launches in the chosen mode (the same
        // paths the footer buttons take). main.ts no longer launches on
        // Enter in factionSelect — this owns it.
        e.preventDefault();
        if (this.step === 1 && this.canContinue()) this.onPlay(this.mode);
        else if (this.step < 3) this.advance();
        else this.onPlay(this.mode);
        break;
      case "Escape":
      case "Backspace":
        if (this.step > 1) {
          e.preventDefault();
          this.goStep((this.step - 1) as Step);
        }
        break;
      case "ArrowUp":
      case "ArrowDown": {
        const rows = this.rows();
        if (rows.length === 0) break;
        const dir = e.code === "ArrowDown" ? 1 : -1;
        const i = Math.max(0, rows.indexOf(this.activeRow));
        this.activeRow = rows[(i + dir + rows.length) % rows.length];
        e.preventDefault();
        this.render();
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = e.code === "ArrowRight" ? 1 : -1;
        if (this.rows().length === 0) break;
        if (this.activeRow === "mode") {
          // Only two modes — either arrow toggles.
          this.mode = this.mode === "solo" ? "online" : "solo";
        } else if (this.activeRow === "faction") {
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

  /** Move to a loadout step, landing the cursor on its first row. */
  private goStep(next: Step): void {
    this.step = next;
    this.activeRow = this.rows()[0] ?? "map";
    this.render();
  }

  /** Advance one step — the MODE → HANGAR edge first offers main.ts the
   *  first-run intro gate (which resumes via enterHangar()). */
  private advance(): void {
    if (this.step === 1 && this.actions.firstRunIntro()) return;
    this.goStep((this.step + 1) as Step);
  }

  /** Complete a gated MODE → HANGAR advance — main.ts calls this when the
   *  first-run intro crawl ends or is skipped. */
  enterHangar(): void {
    this.goStep(2);
  }

  /** Whether step 1 offers the one-press CONTINUE relaunch: a returning
   *  player — intro seen, a valid saved loadout to fly. */
  private canContinue(): boolean {
    return hasSeenIntro() && hasSavedLoadout();
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

  private saveAll(): void {
    saveLoadout(this.loadout);
    saveDifficulty(this.difficulty);
    saveMapSelection(this.mapSelection);
    saveMode(this.mode);
  }

  /** Every user-driven selection change persists immediately (quick play
   *  reads the same keys next session). Row toggles use plain render(). */
  private saveAndRender(): void {
    this.saveAll();
    this.render();
  }

  /** One-time wiring for the static flight-controls overlay (index.html):
   *  CLOSE and a backdrop click dismiss it; Esc is handled in onKeyDown. */
  private wireControlsOverlay(): void {
    const overlay = document.getElementById("controls-overlay");
    if (!overlay) return;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("open");
    });
    overlay
      .querySelector<HTMLButtonElement>("#controls-close")
      ?.addEventListener("click", () => overlay.classList.remove("open"));
  }

  /**
   * Full re-render on every change — a handful of cards on a pre-game screen,
   * nowhere near a hot path. Re-renders also re-bind the click handlers and
   * re-adopt the preview canvas (innerHTML would otherwise orphan it).
   */
  private render(): void {
    this.root.dataset.step = String(this.step);
    const stage =
      this.step === 1 ? this.stageMode() : this.step === 2 ? this.stageHangar() : this.stageMission();
    this.root.innerHTML = `
      ${this.railTop()}
      <div class="lo-stage"><div class="lo-stage-inner">${stage}</div></div>
      ${this.rookieCallout()}
      ${this.railBottom()}`;
    this.bind();
  }

  /** A gold strip above the footer rail pointing first-timers at the Field
   *  Manual. Shows until the manual is opened once (lastMeridian_guideSeen) —
   *  opening it marks it seen, and the re-render on click retires the strip. */
  private rookieCallout(): string {
    if (hasSeenGuide()) return "";
    return `
      <div class="lo-rookie">
        <span class="lo-rookie-star">★</span>
        ROOKIE PILOTS — new to the cockpit? Review the
        <button class="lo-rookie-link" id="loadout-rookie-manual">FIELD MANUAL</button>
        before your first sortie.
      </div>`;
  }

  /** Header rail: title · step dots · the PILOT chip (fed by the callsign). */
  private railTop(): string {
    const dots = ([1, 2, 3] as Step[])
      .map((s) => {
        const cls = s < this.step ? " done" : s === this.step ? " now" : "";
        return `<span class="lo-step-dot${cls}">${STEP_LABELS[s]}</span>`;
      })
      .join("");
    // The chip's name is set via textContent in bind() — sanitizePilotName
    // allows <>& (printable ASCII), so it must never ride innerHTML.
    return `
      <div class="lo-rail lo-rail-top">
        <div class="lo-title">The Last Meridian</div>
        <div class="lo-steps">${dots}</div>
        <div class="lo-pilot"><span class="lo-pilot-label">PILOT ·</span> <span id="pilot-chip-name"></span></div>
      </div>`;
  }

  /** Footer rail: utility links · BACK + NEXT/LAUNCH · the key hint. */
  private railBottom(): string {
    const n = overrideCount();
    const settingsLabel = n > 0 ? `Match Settings · ${n}` : "Match Settings";
    const launchLabel =
      this.mode === "solo"
        ? "LAUNCH"
        : this.onlineStatus ?? (inviteRoomId() ? "JOIN FRIENDS" : "LAUNCH · FIND MATCH");
    // Returning players (intro seen + saved loadout) get the one-press
    // relaunch on step 1: CONTINUE is the gold primary and Enter's default;
    // NEXT steps down to the secondary dress (Tab reaches it by keyboard).
    const continueHere = this.step === 1 && this.canContinue();
    const continueLabel =
      this.mode === "online"
        ? this.onlineStatus ??
          (inviteRoomId() ? "CONTINUE ▸ JOIN FRIENDS" : "CONTINUE ▸ FIND MATCH")
        : `CONTINUE ▸ ${SHIP_INFO[this.shipType].name.toUpperCase()}`;
    const cta = continueHere
      ? `<button id="loadout-next" class="loadout-back">NEXT ▸</button>
         <button id="loadout-continue" class="loadout-cta continue">${continueLabel}</button>`
      : this.step < 3
        ? `<button id="loadout-next" class="loadout-cta ${this.faction}">NEXT ▸</button>`
        : `<button id="loadout-play" class="loadout-cta ${this.faction}">${launchLabel}</button>`;
    const hint =
      this.step === 1
        ? continueHere
          ? "←/→ SELECT · ENTER CONTINUE"
          : "←/→ SELECT · ENTER NEXT"
        : this.step === 2
          ? "←/→ SELECT · ↑/↓ ROW · ENTER NEXT · ESC BACK"
          : this.mode === "solo"
            ? "←/→ SELECT · ↑/↓ ROW · ENTER LAUNCH · ESC BACK"
            : "ENTER LAUNCH · ESC BACK";
    return `
      <div class="lo-rail lo-rail-bot">
        <div class="lo-utils">
          <button class="lo-util" id="loadout-controls">Controls</button>
          <button class="lo-util" id="loadout-manual">Field Manual</button>
          <button class="lo-util" id="loadout-replay">Replay Intro</button>
          <button class="lo-util" id="loadout-settings">${settingsLabel}</button>
        </div>
        <div class="lo-ctas">
          ${this.step > 1 ? `<button id="loadout-back" class="loadout-back">◂ BACK</button>` : ""}
          ${cta}
        </div>
        <div class="lo-hint-side"><span class="loadout-hint">${hint}</span></div>
      </div>`;
  }

  /** Step 1 — the headline choice (solo / multiplayer) + pilot registration. */
  private stageMode(): string {
    const sel = (m: LaunchMode): string => (m === this.mode ? " selected" : "");
    const active = this.activeRow === "mode" ? " active" : "";
    return `
      <div class="loadout-heading">Choose your game</div>
      <div class="loadout-row mode-row${active}" id="loadout-modes">
        <div class="loadout-card mode-card${sel("solo")}" data-mode="solo">
          <div class="mode-badge">▶ SELECTED</div>
          <div class="mode-glyph"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><path d="M32 8 L44 40 L32 34 L20 40 Z"/><circle cx="32" cy="50" r="3" fill="currentColor" stroke="none"/></svg></div>
          <div class="mode-name">SOLO</div>
          <div class="mode-desc">Fleet engagement against the enemy commander. Pick your difficulty, pick your arena, launch.</div>
        </div>
        <div class="loadout-card mode-card${sel("online")}" data-mode="online">
          <div class="mode-badge">▶ SELECTED</div>
          <div class="mode-glyph"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12 L28 34 L20 30 L12 34 Z"/><path d="M44 30 L52 52 L44 48 L36 52 Z"/><path d="M28 24 L38 38" stroke-dasharray="3 3"/></svg></div>
          <div class="mode-name">MULTIPLAYER</div>
          <div class="mode-desc">Quick-match onto the server, or share your invite link and fly against a friend.</div>
        </div>
      </div>
      <div class="callsign-block">
        <label class="callsign-label" for="pilot-name">Callsign</label>
        <input id="pilot-name" class="callsign-input" type="text" maxlength="${PILOT_NAME_MAX}"
          placeholder="ENTER CALLSIGN" autocomplete="off" spellcheck="false">
        <div class="callsign-note">Your name on the wing roster — and over the kill feed online.</div>
      </div>`;
  }

  /** Step 2 — faction cards + the selected side's roster + the live hangar. */
  private stageHangar(): string {
    const factionCards = (["humans", "machines"] as Faction[])
      .map((f) => {
        const t = FACTION_THEME[f];
        const sel = f === this.faction ? " selected" : "";
        const videoBase = FACTION_VIDEO[f];
        const portrait = FACTION_PORTRAIT[f];
        const portraitEl = videoBase
          ? `<video class="faction-portrait faction-portrait-video" muted playsinline data-faction-video="${f}">
               <source src="${import.meta.env.BASE_URL}${videoBase}.webm" type="video/webm">
               <source src="${import.meta.env.BASE_URL}${videoBase}.mp4" type="video/mp4">
             </video>`
          : `<div class="faction-portrait" style="background-image: url('${import.meta.env.BASE_URL}${portrait}')"></div>`;
        return `
          <div class="loadout-card faction-card ${f}${sel}" data-faction="${f}">
            ${portraitEl}
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

    return `
      <div class="loadout-heading">Choose your side</div>
      <div class="loadout-row${this.activeRow === "faction" ? " active" : ""}" id="loadout-factions">${factionCards}</div>
      <div class="faction-desc">${FACTION_DESC[this.faction]}</div>
      <div class="hangar-grid">
        <div class="loadout-row loadout-roster${this.activeRow === "ship" ? " active" : ""}" id="loadout-ships">${shipCards}</div>
        ${this.previewPanel()}
      </div>`;
  }

  /** Step 3 — solo: difficulty + arena; online: the quick-match briefing
   *  (the server owns the battlefield, so there's nothing to pick). */
  private stageMission(): string {
    if (this.mode === "online") {
      const invite = inviteRoomId() !== null;
      const briefing = invite
        ? `<b>JOIN FRIENDS</b> — your invite link seats you in your friend's room. If it's gone, you'll quick-match instead.`
        : `<b>QUICK MATCH</b> — you'll be seated against the next pilot on the server.<br>
           After launch the address bar becomes your <b>invite link</b> — share it and a friend joins your room.`;
      const info = SHIP_INFO[this.shipType];
      return `
        <div class="loadout-heading">Mission setup</div>
        <div class="online-note">${briefing}</div>
        <div class="mission-summary">${FACTION_THEME[this.faction].fullName} · ${info.name} ${info.role}</div>`;
    }
    const diffCards = DIFFICULTY_ORDER.map((id) => this.diffCard(id)).join("");
    const mapCards = MAP_OPTIONS.map((id) => this.mapCard(id)).join("");
    return `
      <div class="loadout-heading">Mission setup</div>
      <div class="loadout-subheading">Difficulty</div>
      <div class="loadout-row${this.activeRow === "difficulty" ? " active" : ""}" id="loadout-difficulty">${diffCards}</div>
      <div class="loadout-subheading">Arena</div>
      <div class="loadout-row${this.activeRow === "map" ? " active" : ""}" id="loadout-maps">${mapCards}</div>`;
  }

  /** Re-bind every handler after a render (innerHTML wipes the old ones). */
  private bind(): void {
    for (const el of this.root.querySelectorAll<HTMLElement>(".mode-card")) {
      el.addEventListener("click", () => {
        this.activeRow = "mode";
        this.mode = el.dataset.mode as LaunchMode;
        this.saveAndRender();
      });
    }
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
    // Step navigation + launch (only one step's buttons exist per render).
    this.root
      .querySelector<HTMLButtonElement>("#loadout-next")
      ?.addEventListener("click", () => this.advance());
    this.root
      .querySelector<HTMLButtonElement>("#loadout-back")
      ?.addEventListener("click", () => this.goStep((this.step - 1) as Step));
    this.root
      .querySelector<HTMLButtonElement>("#loadout-play")
      ?.addEventListener("click", () => this.onPlay(this.mode));
    this.root
      .querySelector<HTMLButtonElement>("#loadout-continue")
      ?.addEventListener("click", () => this.onPlay(this.mode));

    // Footer utility links: the controls overlay + the old poster-overlay
    // links (Replay Intro / Match Settings) rehomed into the rail.
    this.root
      .querySelector<HTMLButtonElement>("#loadout-controls")
      ?.addEventListener("click", () =>
        document.getElementById("controls-overlay")?.classList.add("open"),
      );
    this.root
      .querySelector<HTMLButtonElement>("#loadout-manual")
      ?.addEventListener("click", () => this.actions.openManual());
    // The rookie callout's link: open the manual (which marks it seen), then
    // re-render so the strip is gone when the overlay closes.
    this.root
      .querySelector<HTMLButtonElement>("#loadout-rookie-manual")
      ?.addEventListener("click", () => {
        this.actions.openManual();
        this.render();
      });
    this.root
      .querySelector<HTMLButtonElement>("#loadout-replay")
      ?.addEventListener("click", () => this.actions.replayIntro());
    this.root
      .querySelector<HTMLButtonElement>("#loadout-settings")
      ?.addEventListener("click", () => this.actions.openSettings());

    // Pilot-name field (step 1): value set as a PROPERTY (never interpolated
    // into the innerHTML above — no markup injection), persisted per keystroke
    // so PLAY/quick-play/Enter all read the same storage — and mirrored live
    // into the header rail's PILOT chip. The menu keydown handler already
    // ignores focused inputs, so typing never drives the rows.
    const nameInput = this.root.querySelector<HTMLInputElement>("#pilot-name");
    const chip = this.root.querySelector<HTMLElement>("#pilot-chip-name");
    const savedName = loadPilotName();
    if (chip) chip.textContent = savedName ? savedName.toUpperCase() : "UNREGISTERED";
    if (nameInput) {
      nameInput.value = savedName;
      nameInput.addEventListener("input", () => {
        savePilotName(nameInput.value);
        if (chip) {
          const clean = nameInput.value.trim();
          chip.textContent = clean ? clean.toUpperCase() : "UNREGISTERED";
        }
      });
    }

    // Play the portrait video for the selected faction from the start.
    // Non-selected faction videos stay paused on frame 0.
    for (const vid of this.root.querySelectorAll<HTMLVideoElement>(".faction-portrait-video")) {
      if (vid.dataset.factionVideo === this.faction) {
        vid.currentTime = 0;
        void vid.play();
      }
    }

    // Re-adopt the live preview canvas (one shared element across renders) and
    // point it at the current selection. The hangar only exists on step 2.
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

  /** Compact roster card: thumbnail + name/role (the preview panel carries
   *  the full stats, so the card stays scannable). */
  private shipCard(id: ShipTypeId): string {
    const info = SHIP_INFO[id];
    const sel = id === this.shipType ? " selected" : "";
    return `
      <div class="loadout-card ship-card ${this.faction}${sel}" data-ship="${id}">
        <div class="ship-thumb" data-thumb-for="${id}"></div>
        <div class="ship-card-info">
          <div class="card-title">${info.name.toUpperCase()}</div>
          <div class="card-sub">${info.role}</div>
          <div class="card-blurb">${info.summary}</div>
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
