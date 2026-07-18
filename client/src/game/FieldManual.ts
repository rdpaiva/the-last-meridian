import { GameConfig, type ShipTypeId } from "@space-duel/shared";
import type { ShipPreview } from "./ShipPreview";
import { SHIP_INFO } from "./LoadoutMenu";
import { UPGRADE_LABELS } from "./Hud";
import { loadSavedLoadout, markGuideSeen } from "./Loadout";

/**
 * The Field Manual — the "hit the ground running" guide: a self-paced deck of
 * cards, one gameplay concept each, opened from the loadout footer rail (and
 * auto-opened once right after the first-run intro). Plain DOM overlay in the
 * controls-overlay dress; ←/→ or ENTER pages, ESC closes.
 *
 * Every visual is rendered from the game itself — ship thumbnails come from
 * ShipPreview (the same GLB captures the hangar cards use), the HUD/radar
 * specimens reuse the real HUD colors, and the diagrams are inline SVG — so
 * the manual has no art assets to author and can't drift from the game's look.
 *
 * ── EDITING THE GUIDE ────────────────────────────────────────────────────
 * All text lives in buildCards() below: one entry per card, `lines` = the
 * bullet rows (plain strings; <b>/<span> allowed). Add a line, reword a rule,
 * or add a whole card there — nothing else needs touching. Timing numbers
 * (spool/cooldown seconds etc.) are read from GameConfig inside the template
 * strings, so retuning the game re-words the manual automatically.
 */

/** Which diagram renders above a card's text — see the builders at the bottom. */
type VisualKind =
  | "flight"
  | "weapons"
  | "carrier"
  | "roster"
  | "battlefield"
  | "strategic"
  | "hud";

interface ManualCard {
  /** Small kicker above the title (the card's "chapter"). */
  tag: string;
  title: string;
  visual: VisualKind;
  /** Bullet rows. Plain strings; inline markup allowed. */
  lines: string[];
}

const sec = (ms: number): string => {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
};

/** The deck. Built per open (not at module load) so the text always reflects
 *  the live GameConfig — including any match-settings overrides. */
function buildCards(): ManualCard[] {
  const j = GameConfig.jump;
  return [
    {
      tag: "Flight",
      title: "Your Ship",
      visual: "flight",
      lines: [
        `You fly top-down on a flat plane. <b>W/S</b> thrust, <b>A/D</b> turn, <b>Q/E</b> strafe — or just point the <b>mouse</b> where you want to go (the ship steers toward the cursor), or use the gamepad's left stick.`,
        `Your ship keeps its momentum. Cut thrust and you drift; mix strafe and reverse to slip a pursuer's aim without giving up your heading.`,
        `<b>+/−</b> zooms the camera. The full key/stick list is under <b>CONTROLS</b> in the footer.`,
        `Lose all your hull and you're benched: redeploying at your carrier takes ~${sec(GameConfig.combat.playerRespawnDelayMs)}s (the red countdown ring on the HUD shows the wait). Every death buys the enemy real board time — break off early rather than flying it to zero.`,
      ],
    },
    {
      tag: "Weapons",
      title: "Guns & Heat-Seekers",
      visual: "weapons",
      lines: [
        `<b>SPACE</b> / <b>LMB</b> fires your cannon — your bread-and-butter damage. The magazine is finite: a trigger-holder runs dry mid-fight, a disciplined burst-shooter rarely does. Rearm at your carrier.`,
        `<b>SHIFT</b> / <b>RMB</b> launches a heat-seeker. It needs a live radar track inside the forward lock cone — no track (nebula, broken contact), no lock.`,
        `Watch the <b>lock</b> row on the HUD: it flips to a green <span style="color:#a6e3a1">LOCK</span> when a target is in the cone and you have a missile left — that's your green light to fire. A dim <span style="color:#6c7086">---</span> means no lock (or an empty rack).`,
        `A missile's motor burns for about ${sec(GameConfig.missile.lifetimeMs)}s, then it self-destructs. Being chased? Turn hard and strafe — outlast the motor and it dies behind you.`,
        `Racks are small (${GameConfig.shipTypes.wraith.missileAmmo}–${GameConfig.shipTypes.reaver.missileAmmo} depending on the ship). Spend them on gunships and carrier runs, not on every passing fighter.`,
      ],
    },
    {
      tag: "Carrier Ops",
      title: "Docking & the Meridian Drive",
      visual: "carrier",
      lines: [
        `Your carrier is home base. Nuzzle up to a launch bay and <b>slow to a crawl</b> — inside the service ring your hull, cannon rounds, and missiles all refill over a few seconds. Strafing past at speed gets you nothing.`,
        `The launch bays are themselves targets: a destroyed bay slows every respawn on that side (up to ×${GameConfig.mothership.subsystems.hangar.destroyedRespawnDelayScale} with both down), and relaunches re-route to the surviving bay. Torching the enemy's bays keeps their pilots benched — and yours are just as burnable.`,
        `<b>J</b> arms the <b>Meridian Drive</b>: after a ${sec(j.spoolMs)}s spool (the rising whine is your countdown) it snaps you straight home into that service ring. You can fly and fight the whole spool, and enemy fire can't break it.`,
        `Press <b>J</b> again to <b>cancel</b> the spool — until the final ${sec(j.commitMs)}s, when coordinates lock and you're going whether you like it or not.`,
        `Jumping <i>or</i> cancelling puts the drive on a ${sec(j.cooldownMs)}s cooldown — a cancel isn't free, so don't arm it as a bluff.`,
        `Spooling lights you up: your signature reads DETECTED and every enemy sees the charge ring on their radar. Jump out while you still have hull to survive the attention.`,
      ],
    },
    {
      tag: "The Hangar",
      title: "Know Your Ships",
      visual: "roster",
      lines: [
        `<b>Interceptors</b> — Spitfire, Wraith — are fast, agile duelists. They win the dogfight, screen the fleet, and chase runners down.`,
        `<b>Heavy gunships</b> — Breaker, Reaver — carry the best sustained guns and the biggest missile racks in the catalog, on slow-turning hulls. They crack carriers; they lose knife-fights.`,
        `Firepower is paid for in agility: a lone gunship is a missile magnet. <b>Escort your gunships</b> — a fighter screen keeps the interceptors busy while the big hulls grind the objective down.`,
        `Your own wing's composition (escorts vs. carrier guards) is tunable under <b>MATCH SETTINGS</b>.`,
      ],
    },
    {
      tag: "Terrain",
      title: "The Battlefield",
      visual: "battlefield",
      lines: [
        `The objective is the <b>enemy carrier</b>: bring its hull down before yours falls. Its flak turrets are individually destructible — strip a corner to open a safe attack lane.`,
        `<b>Asteroids</b> block shots — yours and theirs. Duck behind one to break contact, or shoot the rock itself: they shatter, which opens the lane and makes chaos of a furball. Derelict carrier <b>wrecks</b> give the same cover but never break — fight around them, not through.`,
        `<b>Nebulas</b> swallow radar signatures. Inside a cloud you vanish from the enemy picture unless someone flies close enough to eyeball you. Use them to reset a losing fight or line up an ambush.`,
        `<b>Ion storms</b> — the electric blue-cyan clouds — bite: a lightning zap every ~${GameConfig.storms.zapIntervalSec}s while you fly inside. They hide you from radar exactly like a nebula, so a storm run is an escape you pay for in hull. AI pilots route around them — storm banks carve the map into lanes.`,
        `Every arena arranges these differently — the map card's schematic on the MISSION step is a true top-down preview.`,
      ],
    },
    {
      tag: "Strategic Ops",
      title: "Stations, Energy & Shields",
      visual: "strategic",
      lines: [
        `Some arenas seed neutral <b>orbital stations</b>. Park inside a station's ring and <b>slow to a crawl</b> — about ${GameConfig.stations.captureTimeSec}s docked fills the capture meter (the HUD shows progress while you're in the ring). Docked wingmates speed it up; an enemy in the ring freezes it.`,
        `Enemy-held stations flip in <b>two stages</b> — drain theirs to neutral, then capture it for yourself. Double the work, so guard what you take.`,
        `Owned stations feed your side <b>Energy</b> (the ⚡ line under your carrier bar), and upgrades unlock automatically down the ladder above: <b>${UPGRADE_LABELS.fasterRespawn}</b> (respawns ${Math.round((1 - GameConfig.energy.fasterRespawnScale) * 100)}% faster), <b>${UPGRADE_LABELS.sensorBoost}</b> (radar +${Math.round((GameConfig.energy.sensorRangeScale - 1) * 100)}%), then <b>${UPGRADE_LABELS.turretOverdrive}</b> — your carrier's guns revive, and full-strength guns fire faster and hit harder. Chip an overdriven gun below full and it drops back to stock.`,
        `Stations also power <b>carrier shields</b>: every station your side holds blunts damage to your carrier's hull — hold them all and enemy hits land at ${Math.round(GameConfig.stations.shield.minFactor * 100)}% strength. If your shots are barely scratching the enemy carrier, take their stations before pressing the attack.`,
      ],
    },
    {
      tag: "Sensors & HUD",
      title: "Reading Your HUD",
      visual: "hud",
      lines: [
        `<b>SIG</b> answers one question: does the enemy have a fresh track on you <i>right now?</i> <span style="color:#f38ba8">DETECTED</span> — they see you. <span style="color:#a6e3a1">HIDDEN</span> — a nebula is concealing you. <span style="color:#6c7086">NO TRACK</span> — they've simply lost you in the open.`,
        `The radar shows your side's <b>sensor picture, not the truth</b>. Solid blips are live tracks; hollow <b>ghost rings</b> are last-known positions that fade after ~${GameConfig.sensors.memorySec}s. An empty radar doesn't mean an empty sky.`,
        `Tracks come from every friendly fighter's radar plus your carrier's long-range sweep around home — stay near friends and you see more.`,
        `A pulsing red border and a quickening beep is the <b>missile warning</b>: a seeker is homing on you. Break hard and outlast its motor.`,
        `The carrier hull bars are the win condition — when one empties, the match ends. The pips beneath each bar are <b>station shield power</b>: every lit pip means that carrier's hull is taking reduced damage.`,
      ],
    },
  ];
}

// ── Visual builders ─────────────────────────────────────────────────────────
// Each returns an HTML string for the card's diagram strip. Palette matches
// the game: humans #89b4fa, machines #f38ba8, nebula violet, HUD greens/reds.

/** A labeled key chip (the controls-overlay look, compacted). */
const key = (k: string, label: string): string =>
  `<span class="fm-key"><b>${k}</b>${label}</span>`;

/** A ship thumbnail slot — filled async from ShipPreview after render. */
const shipThumb = (id: ShipTypeId, label: string, sub: string): string => `
  <div class="fm-ship">
    <div class="fm-ship-thumb" data-thumb-for="${id}"></div>
    <div class="fm-ship-name">${label}</div>
    <div class="fm-ship-sub">${sub}</div>
  </div>`;

function visualFlight(): string {
  const ship = loadSavedLoadout().shipType;
  const info = SHIP_INFO[ship];
  return `
    <div class="fm-visual-row">
      ${shipThumb(ship, info.name.toUpperCase(), "YOUR SHIP")}
      <div class="fm-keys">
        ${key("W/S", "thrust")}${key("A/D", "turn")}${key("Q/E", "strafe")}
        ${key("SPACE", "guns")}${key("SHIFT", "missile")}${key("J", "jump")}
      </div>
    </div>`;
}

function visualWeapons(): string {
  // Lock-cone diagram (your ship, the forward cone, a locked target inside it
  // and an unlocked one outside; a laser stream alongside) + specimen HUD
  // lock-row chips in the real colors: green LOCK = clear to fire.
  return `
    <div class="fm-visual-row">
    <svg class="fm-svg" viewBox="0 0 320 110" xmlns="http://www.w3.org/2000/svg">
      <path d="M40 55 L300 12 L300 98 Z" fill="rgba(137,180,250,0.10)" stroke="rgba(137,180,250,0.35)" stroke-dasharray="4 3"/>
      <path d="M40 47 L28 63 L40 59 L52 63 Z" fill="#89b4fa" transform="rotate(90 40 55)"/>
      <line x1="58" y1="55" x2="118" y2="52" stroke="#f38ba8" stroke-width="2"/>
      <line x1="126" y1="52" x2="150" y2="51" stroke="#f38ba8" stroke-width="2"/>
      <circle cx="228" cy="42" r="6" fill="none" stroke="#f38ba8" stroke-width="2"/>
      <circle cx="228" cy="42" r="2.4" fill="#f38ba8"/>
      <text x="228" y="24" text-anchor="middle" class="fm-svg-label" fill="#a6e3a1">LOCK</text>
      <circle cx="150" cy="100" r="2.4" fill="#f38ba8" opacity="0.55"/>
      <text x="176" y="104" class="fm-svg-label" fill="#6c7086">OUTSIDE CONE — NO LOCK</text>
      <text x="60" y="40" class="fm-svg-label" fill="#89b4fa">CANNON</text>
    </svg>
    <div class="fm-chips">
      <div class="fm-chip"><span class="fm-chip-label">lock</span><span style="color:#a6e3a1">LOCK</span></div>
      <div class="fm-chip"><span class="fm-chip-label">lock</span><span style="color:#6c7086">---</span></div>
    </div>
    </div>`;
}

function visualCarrier(): string {
  // Left: the service ring around a carrier bay. Right: the drive timeline —
  // spool → JUMP, the no-cancel commit tail, and the cooldown that follows
  // either outcome. Widths are schematic, labels carry the real numbers.
  const j = GameConfig.jump;
  return `
    <svg class="fm-svg" viewBox="0 0 340 110" xmlns="http://www.w3.org/2000/svg">
      <rect x="14" y="42" width="64" height="16" rx="3" fill="#9aa6c8"/>
      <circle cx="46" cy="66" r="26" fill="rgba(166,227,161,0.08)" stroke="rgba(166,227,161,0.5)" stroke-dasharray="4 3"/>
      <path d="M46 62 L40 72 L46 69.5 L52 72 Z" fill="#89b4fa"/>
      <text x="46" y="17" text-anchor="middle" class="fm-svg-label" fill="#a6e3a1">SERVICE RING</text>
      <text x="46" y="28" text-anchor="middle" class="fm-svg-label" fill="#6c7086">SLOW DOWN TO REFIT</text>
      <rect x="120" y="38" width="120" height="10" rx="2" fill="rgba(137,180,250,0.30)"/>
      <rect x="216" y="38" width="24" height="10" rx="2" fill="rgba(249,226,175,0.65)"/>
      <rect x="244" y="38" width="82" height="10" rx="2" fill="rgba(108,112,134,0.45)"/>
      <text x="180" y="30" text-anchor="middle" class="fm-svg-label" fill="#89b4fa">SPOOL ${sec(j.spoolMs)}s · CANCEL OK</text>
      <text x="228" y="62" text-anchor="middle" class="fm-svg-label" fill="#f9e2af">LOCKED</text>
      <text x="285" y="30" text-anchor="middle" class="fm-svg-label" fill="#8a96b8">COOLDOWN ${sec(j.cooldownMs)}s</text>
      <text x="240" y="80" text-anchor="middle" class="fm-svg-label" fill="#6c7086">JUMP OR CANCEL — COOLDOWN EITHER WAY</text>
    </svg>`;
}

function visualRoster(): string {
  return `
    <div class="fm-visual-row fm-roster">
      <div class="fm-roster-group">
        <div class="fm-roster-tag">INTERCEPTORS</div>
        <div class="fm-visual-row">
          ${shipThumb("spitfire", "SPITFIRE", "COMMONWEALTH")}
          ${shipThumb("wraith", "WRAITH", "NOVARI")}
        </div>
      </div>
      <div class="fm-roster-group">
        <div class="fm-roster-tag">HEAVY GUNSHIPS</div>
        <div class="fm-visual-row">
          ${shipThumb("breaker", "BREAKER", "COMMONWEALTH")}
          ${shipThumb("reaver", "REAVER", "NOVARI")}
        </div>
      </div>
    </div>`;
}

function visualBattlefield(): string {
  // A radar-style schematic: both carriers, an asteroid cluster shielding an
  // approach, a nebula with a ship hidden inside it.
  return `
    <svg class="fm-svg" viewBox="0 0 340 110" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="336" height="106" rx="6" fill="rgba(8,11,20,0.55)" stroke="rgba(120,140,200,0.25)"/>
      <rect x="20" y="47" width="34" height="9" rx="2" fill="#89b4fa"/>
      <rect x="286" y="47" width="34" height="9" rx="2" fill="#f38ba8"/>
      <circle cx="205" cy="34" r="26" fill="rgba(150,90,210,0.22)" stroke="rgba(160,110,220,0.4)"/>
      <path d="M205 30 L199 40 L205 37.5 L211 40 Z" fill="#89b4fa" opacity="0.5"/>
      <text x="205" y="14" text-anchor="middle" class="fm-svg-label" fill="rgba(190,150,240,0.9)">NEBULA · HIDDEN</text>
      <g fill="rgba(150,150,165,0.6)">
        <circle cx="120" cy="76" r="5"/><circle cx="136" cy="84" r="3.6"/>
        <circle cx="106" cy="86" r="3"/><circle cx="128" cy="66" r="2.6"/>
      </g>
      <text x="122" y="102" text-anchor="middle" class="fm-svg-label" fill="#8a96b8">ASTEROIDS · COVER</text>
      <text x="37" y="72" text-anchor="middle" class="fm-svg-label" fill="#89b4fa">YOURS</text>
      <text x="303" y="72" text-anchor="middle" class="fm-svg-label" fill="#f38ba8">TARGET</text>
    </svg>`;
}

function visualStrategic(): string {
  // Left: the wheel-and-spire station inside its dashed capture ring (the
  // service-ring look — same "get inside and slow down" grammar). Right: the
  // Energy upgrade ladder, one chip per threshold, built from the live config
  // (and the HUD's own upgrade labels) so retuning re-words it.
  const chips = GameConfig.energy.thresholds
    .map(
      (t) =>
        `<div class="fm-chip"><span class="fm-chip-label">⚡${t.cost}</span><span style="color:#f9e2af">${UPGRADE_LABELS[t.effect]}</span></div>`,
    )
    .join("");
  return `
    <div class="fm-visual-row">
    <svg class="fm-svg" viewBox="0 0 170 110" xmlns="http://www.w3.org/2000/svg">
      <circle cx="85" cy="58" r="42" fill="rgba(166,227,161,0.06)" stroke="rgba(166,227,161,0.5)" stroke-dasharray="4 3"/>
      <circle cx="85" cy="58" r="16" fill="none" stroke="#9aa6c8" stroke-width="3"/>
      <line x1="85" y1="42" x2="85" y2="74" stroke="#9aa6c8" stroke-width="2"/>
      <line x1="69" y1="58" x2="101" y2="58" stroke="#9aa6c8" stroke-width="2"/>
      <circle cx="85" cy="58" r="4" fill="#f9e2af"/>
      <path d="M85 88 L79 98 L85 95.5 L91 98 Z" fill="#89b4fa"/>
      <text x="85" y="12" text-anchor="middle" class="fm-svg-label" fill="#a6e3a1">CAPTURE RING</text>
      <text x="85" y="107" text-anchor="middle" class="fm-svg-label" fill="#6c7086">DOCK SLOW TO CAPTURE</text>
    </svg>
    <div class="fm-chips">${chips}</div>
    </div>`;
}

function visualHud(): string {
  // Specimen HUD chips in the real HUD colors + the radar blip legend.
  return `
    <div class="fm-visual-row fm-hud-row">
      <div class="fm-chips">
        <div class="fm-chip"><span class="fm-chip-label">sig</span><span style="color:#f38ba8">DETECTED</span></div>
        <div class="fm-chip"><span class="fm-chip-label">sig</span><span style="color:#a6e3a1">HIDDEN</span></div>
        <div class="fm-chip"><span class="fm-chip-label">sig</span><span style="color:#6c7086">NO TRACK</span></div>
      </div>
      <svg class="fm-svg fm-legend" viewBox="0 0 150 84" xmlns="http://www.w3.org/2000/svg">
        <circle cx="14" cy="14" r="4" fill="#f38ba8"/>
        <text x="30" y="18" class="fm-svg-label" fill="#8a96b8">LIVE TRACK</text>
        <circle cx="14" cy="42" r="4.6" fill="none" stroke="#f38ba8" stroke-width="1.6"/>
        <text x="30" y="46" class="fm-svg-label" fill="#8a96b8">GHOST · LAST KNOWN</text>
        <circle cx="14" cy="70" r="9" fill="rgba(140,90,200,0.25)" stroke="rgba(160,110,220,0.4)"/>
        <text x="30" y="74" class="fm-svg-label" fill="#8a96b8">NEBULA ZONE</text>
      </svg>
    </div>`;
}

const VISUALS: Record<VisualKind, () => string> = {
  flight: visualFlight,
  weapons: visualWeapons,
  carrier: visualCarrier,
  roster: visualRoster,
  battlefield: visualBattlefield,
  strategic: visualStrategic,
  hud: visualHud,
};

// ── The overlay ─────────────────────────────────────────────────────────────

export class FieldManual {
  private cards: ManualCard[] = [];
  private index = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly preview: ShipPreview,
  ) {
    // Backdrop click closes, like the controls overlay.
    root.addEventListener("click", (e) => {
      if (e.target === root) this.close();
    });
    window.addEventListener("keydown", this.onKeyDown);
  }

  get isOpen(): boolean {
    return this.root.classList.contains("open");
  }

  /** Open on the first card. Cards are (re)built per open so the copy always
   *  reflects the live GameConfig. Opening counts as "seen". */
  open(): void {
    this.cards = buildCards();
    this.index = 0;
    this.root.classList.add("open");
    markGuideSeen();
    this.render();
  }

  close(): void {
    this.root.classList.remove("open");
  }

  /** ←/→ page, ENTER advances (closing off the last card), ESC closes. Runs
   *  only while open; LoadoutMenu yields its keys whenever the manual is up. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    switch (e.code) {
      case "Escape":
        e.preventDefault();
        this.close();
        break;
      case "ArrowLeft":
        e.preventDefault();
        this.go(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        this.go(1);
        break;
      case "Enter":
        e.preventDefault();
        if (this.index >= this.cards.length - 1) this.close();
        else this.go(1);
        break;
    }
  };

  private go(dir: number): void {
    const next = this.index + dir;
    if (next < 0 || next >= this.cards.length) return;
    this.index = next;
    this.render();
  }

  private render(): void {
    const card = this.cards[this.index];
    const last = this.index === this.cards.length - 1;
    const dots = this.cards
      .map((_, i) => `<span class="fm-dot${i === this.index ? " now" : ""}" data-goto="${i}"></span>`)
      .join("");
    this.root.innerHTML = `
      <div class="fm-panel">
        <div class="fm-head">
          <div class="fm-tag">FIELD MANUAL · ${card.tag.toUpperCase()}</div>
          <div class="fm-title">${card.title}</div>
        </div>
        <div class="fm-visual">${VISUALS[card.visual]()}</div>
        <ul class="fm-lines">
          ${card.lines.map((l) => `<li>${l}</li>`).join("")}
        </ul>
        <div class="fm-foot">
          <button class="fm-nav" id="fm-prev" ${this.index === 0 ? "disabled" : ""}>◂ PREV</button>
          <div class="fm-dots">${dots}</div>
          <button class="fm-nav" id="fm-next">${last ? "DONE" : "NEXT ▸"}</button>
        </div>
        <div class="fm-hint">←/→ PAGE · ENTER NEXT · ESC CLOSE</div>
      </div>`;
    this.bind();
  }

  private bind(): void {
    this.root
      .querySelector<HTMLButtonElement>("#fm-prev")
      ?.addEventListener("click", () => this.go(-1));
    this.root.querySelector<HTMLButtonElement>("#fm-next")?.addEventListener("click", () => {
      if (this.index >= this.cards.length - 1) this.close();
      else this.go(1);
    });
    for (const dot of this.root.querySelectorAll<HTMLElement>(".fm-dot")) {
      dot.addEventListener("click", () => {
        this.index = Number(dot.dataset.goto);
        this.render();
      });
    }
    // Ship thumbnails ride the same cached ShipPreview captures the hangar
    // cards use — async exactly once per ship, instant after that.
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-thumb-for]")) {
      const id = el.dataset.thumbFor as ShipTypeId;
      void this.preview.thumbnail(id).then((url) => {
        if (url && el.isConnected) el.style.backgroundImage = `url(${url})`;
      });
    }
  }
}
