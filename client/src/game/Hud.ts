import type { Faction, Ship } from "@space-duel/shared";
import { FACTION_THEME } from "@space-duel/shared";
import { GameConfig } from "@space-duel/shared";

/**
 * One pilot's line on the match scoreboard (the end-of-game leaderboard and
 * the multiplayer running-tally panel). Built by ScoreBoard offline and from
 * the replicated `scores` map online — the view is the same either way.
 */
export interface ScoreRow {
  callsign: string;
  faction: Faction;
  kills: number;
  deaths: number;
  /** Sum of victims' maxHp — the same currency as the personal score line. */
  score: number;
  /** The local pilot's row — highlighted so they can see where they stand. */
  isPlayer: boolean;
  /** Honesty rule styling: bright human name vs dim faction-tinted AI. */
  isHuman: boolean;
}

/** Scoreboard ranking: kills desc → score desc → callsign asc. */
export function compareScoreRows(a: ScoreRow, b: ScoreRow): number {
  if (b.kills !== a.kills) return b.kills - a.kills;
  if (b.score !== a.score) return b.score - a.score;
  return a.callsign.localeCompare(b.callsign);
}

/**
 * Plain DOM debug HUD. DOM updates are throttled to 10 Hz — the HUD doesn't
 * need 144fps and updating textContent every frame churns layout for no
 * reason.
 *
 * HP gets a color cue (green / yellow / red) so the player can read their
 * health at a glance without parsing the number.
 */
/** What the capture-status line should read for a docked player. */
export interface CaptureStatus {
  text: string;
  tone: "good" | "bad" | "neutral";
}

/**
 * Compose the capture-status line for the local pilot docked at `station`
 * (shared by solo Game and NetworkGame so both modes read identically).
 * Percentages are the live capture meter; "draining" shows the ENEMY meter
 * you're burning down before your own climb starts.
 */
export function captureStatusFor(
  station: {
    owner: Faction | null;
    capturingFaction: Faction | null;
    progress: number;
    contested: boolean;
  },
  faction: Faction,
): CaptureStatus {
  if (station.contested) {
    return { text: "CAPTURE CONTESTED — CLEAR HOSTILES", tone: "bad" };
  }
  const pct = Math.round(station.progress * 100);
  if (station.capturingFaction === faction) {
    return station.owner && station.owner !== faction
      ? { text: `NEUTRALIZING ENEMY STATION ${pct}%`, tone: "good" }
      : { text: `CAPTURING STATION ${pct}%`, tone: "good" };
  }
  if (station.capturingFaction) {
    return { text: `DRAINING ENEMY PROGRESS ${pct}%`, tone: "good" };
  }
  if (station.owner === faction) return { text: "STATION SECURE", tone: "neutral" };
  return { text: "DOCKING…", tone: "neutral" };
}

/** Player-facing names for the strategic upgrade effects (toast copy). */
export const UPGRADE_LABELS: Record<
  "fasterRespawn" | "sensorBoost" | "turretOverdrive",
  string
> = {
  fasterRespawn: "RAPID REDEPLOY",
  sensorBoost: "SENSOR UPLINK",
  turretOverdrive: "TURRET OVERDRIVE",
};

export class Hud {
  // Using HTMLElement<T> through querySelector's generic — these are spans
  // we control, so the cast is safe. We need HTMLElement for .style access
  // on the HP color cue.
  private readonly hpEl: HTMLElement | null;
  private readonly posEl: Element | null;
  private readonly velEl: Element | null;
  private readonly cannonEl: HTMLElement | null;
  private readonly missilesEl: HTMLElement | null;
  private readonly dockEl: HTMLElement | null;
  private readonly lockEl: HTMLElement | null;
  private readonly sigEl: HTMLElement | null;
  private readonly warnEl: HTMLElement | null;
  private readonly killsEl: HTMLElement | null;
  private readonly scoreEl: HTMLElement | null;
  private readonly pilotsRowEl: HTMLElement | null;
  private readonly pilotsEl: HTMLElement | null;
  private readonly inviteRowEl: HTMLElement | null;
  private readonly inviteEl: HTMLElement | null;
  /** Pending revert timer for the invite row's LINK COPIED flash. */
  private inviteFlashTimer: number | null = null;
  private readonly zoomEl: Element | null;
  private readonly sfxEl: HTMLElement | null;
  private readonly launchOverlayEl: HTMLElement | null;
  private readonly humansFillEl: HTMLElement | null;
  private readonly machinesFillEl: HTMLElement | null;
  private humansSubsEl: HTMLElement | null = null;
  private machinesSubsEl: HTMLElement | null = null;
  private humansEnergyEl: HTMLElement | null = null;
  private machinesEnergyEl: HTMLElement | null = null;
  /** Last energy-line signature written (write-on-change; called per frame). */
  private lastEnergySig = "";
  private strategicToastEl: HTMLElement | null = null;
  private strategicToastTimer: number | null = null;
  private captureStatusEl: HTMLElement | null = null;
  /** Last capture-status signature written (write-on-change; per frame). */
  private lastCaptureSig = "";
  /** Last pip signature written (write-on-change; called per frame). */
  private lastSubsSig = "";
  /** Last shield-power signature written (write-on-change; per frame). */
  private lastShieldSig = "";
  private readonly endBannerEl: HTMLElement | null;
  private readonly scoreboardEl: HTMLElement | null;

  private readonly incomingOverlayEl: HTMLElement;
  private readonly jumpRingEl: HTMLElement;
  private readonly jumpRingTextEl: HTMLElement | null;
  /** Last spool tenth written to the ring (write-on-change; per-frame). */
  private lastJumpTenths = -1;
  private readonly respawnRingEl: HTMLElement;
  private readonly respawnRingTextEl: HTMLElement | null;
  /** "SPECTATING — <callsign>" line under the redeploy ring (death spectate). */
  private spectateLabelEl: HTMLElement | null = null;
  /** Last spectate callsign written (write-on-change), null = hidden. */
  private lastSpectateLabel: string | null = null;
  /** Last countdown tenth written to the respawn ring (write-on-change). */
  private lastRespawnTenths = -1;

  private lastTextUpdateMs = 0;
  private lastOverlayText: string | null = null;
  private endShown = false;
  /** Last state written to the INCOMING label (write-on-change only). */
  private warnShown = false;
  /** Last opacity written to the incoming border (skip sub-1% deltas). */
  private lastPulseAlpha = -1;

  constructor(root: HTMLDivElement) {
    root.innerHTML = `
      <div><span class="label">hp</span><span id="hud-hp">100 / 100</span></div>
      <div><span class="label">pos</span><span id="hud-pos">0.0, 0.0</span></div>
      <div><span class="label">vel</span><span id="hud-vel">0.0</span> u/s</div>
      <div><span class="label">cannon</span><span id="hud-cannon">0</span></div>
      <div><span class="label">missiles</span><span id="hud-missiles">0</span></div>
      <div><span class="label">dock</span><span id="hud-dock">---</span></div>
      <div><span class="label">lock</span><span id="hud-lock">---</span></div>
      <div><span class="label">sig</span><span id="hud-sig">---</span></div>
      <div><span class="label">warn</span><span id="hud-warn">---</span></div>
      <div><span class="label">kills</span><span id="hud-kills">0</span></div>
      <div><span class="label">score</span><span id="hud-score">0</span></div>
      <div id="hud-pilots-row" style="display:none"><span class="label">pilots</span><span id="hud-pilots">---</span></div>
      <div id="hud-invite-row" style="display:none"><span class="label">invite</span><span id="hud-invite">I · copy link</span></div>
      <div><span class="label">zoom</span><span id="hud-zoom">1.00</span></div>
      <div><span class="label">sfx</span><span id="hud-sfx">on</span></div>
    `;
    this.hpEl = root.querySelector<HTMLElement>("#hud-hp");
    this.posEl = root.querySelector("#hud-pos");
    this.velEl = root.querySelector("#hud-vel");
    this.cannonEl = root.querySelector<HTMLElement>("#hud-cannon");
    this.missilesEl = root.querySelector<HTMLElement>("#hud-missiles");
    this.dockEl = root.querySelector<HTMLElement>("#hud-dock");
    this.lockEl = root.querySelector<HTMLElement>("#hud-lock");
    this.sigEl = root.querySelector<HTMLElement>("#hud-sig");
    this.warnEl = root.querySelector<HTMLElement>("#hud-warn");
    if (this.warnEl) this.warnEl.style.color = "#6c7086"; // dim until a threat
    this.killsEl = root.querySelector<HTMLElement>("#hud-kills");
    this.scoreEl = root.querySelector<HTMLElement>("#hud-score");
    this.pilotsRowEl = root.querySelector<HTMLElement>("#hud-pilots-row");
    this.pilotsEl = root.querySelector<HTMLElement>("#hud-pilots");
    this.inviteRowEl = root.querySelector<HTMLElement>("#hud-invite-row");
    this.inviteEl = root.querySelector<HTMLElement>("#hud-invite");
    if (this.inviteEl) this.inviteEl.style.color = "#6c7086"; // dim hint
    this.zoomEl = root.querySelector("#hud-zoom");
    this.sfxEl = root.querySelector<HTMLElement>("#hud-sfx");

    // Incoming-missile border — a fullscreen red edge glow whose opacity is
    // driven by MissileWarning (a pulse re-triggered on each warning beep).
    // Appended FIRST so the launch overlay / end banner stack above it in DOM
    // order, same z-strategy as every other fixed overlay here.
    const incoming = document.createElement("div");
    incoming.id = "incoming-overlay";
    incoming.className = "incoming-overlay";
    document.body.appendChild(incoming);
    this.incomingOverlayEl = incoming;

    // Jump-drive spool ring — bottom-center gauge that fills as the player's
    // drive charges. Driven per-frame (not 10Hz) by setJumpSpool.
    const jumpRing = document.createElement("div");
    jumpRing.id = "jump-ring";
    jumpRing.className = "jump-ring hidden";
    jumpRing.innerHTML = `<span class="jump-ring-text">JUMP</span>`;
    document.body.appendChild(jumpRing);
    this.jumpRingEl = jumpRing;
    this.jumpRingTextEl = jumpRing.querySelector<HTMLElement>(".jump-ring-text");

    // Respawn countdown ring — the jump-ring recipe in the warning red,
    // centered where the dead player's attention is. Fills as the redeploy
    // clock runs down; driven per-frame by setRespawnCountdown.
    const respawnRing = document.createElement("div");
    respawnRing.id = "respawn-ring";
    respawnRing.className = "respawn-ring hidden";
    respawnRing.innerHTML =
      `<span class="respawn-ring-text"></span>` +
      `<span class="respawn-ring-label">REDEPLOY</span>` +
      `<span class="respawn-ring-spectate hidden"></span>`;
    document.body.appendChild(respawnRing);
    this.respawnRingEl = respawnRing;
    this.respawnRingTextEl =
      respawnRing.querySelector<HTMLElement>(".respawn-ring-text");
    this.spectateLabelEl =
      respawnRing.querySelector<HTMLElement>(".respawn-ring-spectate");

    // Launch overlay lives outside the debug panel — it's fullscreen-centered.
    const overlay = document.createElement("div");
    overlay.id = "launch-overlay";
    overlay.className = "launch-overlay hidden";
    document.body.appendChild(overlay);
    this.launchOverlayEl = overlay;

    // Mothership objective bars — top center, one per faction.
    const msBars = document.createElement("div");
    msBars.id = "mothership-bars";
    // Objective-bar labels carry the canon flagship names (story bible §8).
    msBars.innerHTML = `
      <div class="ms-bar ms-humans">
        <span class="ms-label">${FACTION_THEME.humans.mothershipName.toUpperCase()}</span>
        <div class="ms-track"><div class="ms-fill" id="ms-fill-humans"></div></div>
        <div class="ms-subs" id="ms-subs-humans"></div>
        <div class="ms-energy" id="ms-energy-humans"></div>
      </div>
      <div class="ms-bar ms-machines">
        <span class="ms-label">${FACTION_THEME.machines.mothershipName.toUpperCase()}</span>
        <div class="ms-track"><div class="ms-fill" id="ms-fill-machines"></div></div>
        <div class="ms-subs" id="ms-subs-machines"></div>
        <div class="ms-energy" id="ms-energy-machines"></div>
      </div>
    `;
    document.body.appendChild(msBars);
    this.humansFillEl = msBars.querySelector<HTMLElement>("#ms-fill-humans");
    this.machinesFillEl = msBars.querySelector<HTMLElement>("#ms-fill-machines");
    this.humansSubsEl = msBars.querySelector<HTMLElement>("#ms-subs-humans");
    this.machinesSubsEl = msBars.querySelector<HTMLElement>("#ms-subs-machines");
    this.humansEnergyEl = msBars.querySelector<HTMLElement>("#ms-energy-humans");
    this.machinesEnergyEl = msBars.querySelector<HTMLElement>("#ms-energy-machines");

    // Strategic toast — transient top-center line under the objective bars
    // ("HANGAR DESTROYED" / "SHIELDS OFFLINE"). One at a time; a new
    // toast replaces the current one and restarts the fade timer.
    const toast = document.createElement("div");
    toast.id = "strategic-toast";
    toast.className = "strategic-toast";
    document.body.appendChild(toast);
    this.strategicToastEl = toast;

    // Capture status — the "how much have I captured?" line while the player
    // is docked at a station, bottom-center above the jump ring. Continuous
    // (per-frame percentage), unlike the transient toast.
    const capture = document.createElement("div");
    capture.id = "capture-status";
    capture.className = "capture-status";
    document.body.appendChild(capture);
    this.captureStatusEl = capture;

    // Victory / defeat banner — fullscreen, hidden until the match ends.
    const banner = document.createElement("div");
    banner.id = "end-banner";
    banner.className = "end-banner hidden";
    banner.innerHTML = `<div class="end-title"></div><div class="end-stats"></div><div class="end-board"></div><div class="end-sub"></div>`;
    document.body.appendChild(banner);
    this.endBannerEl = banner;

    // Match scoreboard panel — the multiplayer running tally. Bottom-left
    // (HUD owns top-left, netdebug top-right, radar bottom-right, jump ring
    // bottom-center). Hidden until the first setScoreboard call, so the
    // offline HUD is unchanged — same MP-only pattern as the pilots row.
    const scoreboard = document.createElement("div");
    scoreboard.id = "scoreboard";
    scoreboard.style.display = "none";
    document.body.appendChild(scoreboard);
    this.scoreboardEl = scoreboard;
  }

  /**
   * Render `rows` (already sorted) as scoreboard lines into `container`,
   * replacing its contents. One header + one line per pilot; textContent
   * everywhere (callsigns are player-typed online). Row classes reuse the
   * nameplate honesty/faction language: `human` bright, `ai` dim + tinted.
   */
  private renderScoreRows(container: HTMLElement, rows: ScoreRow[]): void {
    container.textContent = "";
    const header = document.createElement("div");
    header.className = "score-row score-header";
    for (const [cls, text] of [
      ["score-name", "PILOT"],
      ["score-num", "K"],
      ["score-num", "D"],
      ["score-num", "SCORE"],
    ] as const) {
      const cell = document.createElement("span");
      cell.className = cls;
      cell.textContent = text;
      header.appendChild(cell);
    }
    container.appendChild(header);
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = `score-row ${row.isHuman ? "human" : "ai"} ${row.faction}${
        row.isPlayer ? " me" : ""
      }`;
      const cells: Array<[string, string]> = [
        ["score-name", row.callsign],
        ["score-num", String(row.kills)],
        ["score-num", String(row.deaths)],
        ["score-num", String(Math.round(row.score))],
      ];
      for (const [cls, text] of cells) {
        const cell = document.createElement("span");
        cell.className = cls;
        cell.textContent = text;
        line.appendChild(cell);
      }
      container.appendChild(line);
    }
  }

  /** Last scoreboard content written (write-on-change; called per frame). */
  private lastScoreboardSig = "";

  /**
   * The multiplayer running tally: every pilot ranked live, bottom-left.
   * `rows` need not be sorted or capped — this sorts, keeps the top
   * `GameConfig.scoreboard.panelMaxRows`, and always re-includes the local
   * pilot's row if it fell below the cut (the whole point is seeing where
   * you stand). Offline never calls this, so the panel never shows.
   */
  setScoreboard(rows: ScoreRow[]): void {
    if (!this.scoreboardEl) return;
    const sorted = [...rows].sort(compareScoreRows);
    let shown = sorted.slice(0, GameConfig.scoreboard.panelMaxRows);
    const me = sorted.find((r) => r.isPlayer);
    if (me && !shown.includes(me)) shown = [...shown.slice(0, -1), me];
    const sig = shown
      .map((r) => `${r.callsign}:${r.kills}:${r.deaths}:${r.score}:${r.isHuman ? 1 : 0}`)
      .join("|");
    if (sig === this.lastScoreboardSig) return;
    this.lastScoreboardSig = sig;
    this.scoreboardEl.style.display = "";
    this.renderScoreRows(this.scoreboardEl, shown);
  }

  /**
   * Update the two mothership objective bars. Fractions are clamped to [0,1].
   * Cheap enough (two style writes) to call every frame.
   */
  setMothershipHp(
    humansFrac: number,
    machinesFrac: number,
  ): void {
    if (this.humansFillEl) {
      this.humansFillEl.style.width = `${Math.max(0, Math.min(1, humansFrac)) * 100}%`;
    }
    if (this.machinesFillEl) {
      this.machinesFillEl.style.width = `${Math.max(0, Math.min(1, machinesFrac)) * 100}%`;
    }
  }

  /**
   * Update the subsystem pips under each carrier bar — one pip per hangar
   * BAY (each is an independent destructible), lit while that bay lives.
   * Accepts each carrier's live `subsystems` array (structural type — both
   * Game's motherships and NetworkGame's carrierSims qualify).
   * Write-on-change: cheap to call every frame.
   */
  setSubsystems(
    humans: ReadonlyArray<{ kind: "hangar"; isAlive: boolean }>,
    machines: ReadonlyArray<{ kind: "hangar"; isAlive: boolean }>,
  ): void {
    const sig =
      humans.map((s) => `${s.kind}:${s.isAlive ? 1 : 0}`).join(",") +
      "|" +
      machines.map((s) => `${s.kind}:${s.isAlive ? 1 : 0}`).join(",");
    if (sig === this.lastSubsSig) return;
    this.lastSubsSig = sig;
    const render = (
      el: HTMLElement | null,
      subs: ReadonlyArray<{ kind: "hangar"; isAlive: boolean }>,
    ) => {
      if (!el) return;
      // Preserve the shield-power segment container (setShieldPower owns it);
      // only the pips get rebuilt.
      for (const pip of Array.from(el.querySelectorAll(".ms-pip"))) pip.remove();
      for (const s of subs) {
        const pip = document.createElement("span");
        pip.className = `ms-pip ${s.kind}${s.isAlive ? "" : " dead"}`;
        pip.title = "Hangar bay";
        el.appendChild(pip);
      }
    };
    render(this.humansSubsEl, humans);
    render(this.machinesSubsEl, machines);
  }

  /**
   * Update the STATION-POWER shield segments under each carrier bar: `total`
   * segments per carrier (one per station on the map), the first `owned` lit
   * — the at-a-glance "how shielded is each carrier" read (the graduated
   * damage factor scales with owned/total; see GameConfig.stations.shield).
   * `total` 0 (station-free maps) renders nothing. Write-on-change; cheap to
   * call every frame.
   */
  setShieldPower(
    humansOwned: number,
    machinesOwned: number,
    total: number,
  ): void {
    const sig = `${humansOwned}/${machinesOwned}/${total}`;
    if (sig === this.lastShieldSig) return;
    this.lastShieldSig = sig;
    const render = (el: HTMLElement | null, owned: number) => {
      if (!el) return;
      let wrap = el.querySelector<HTMLElement>(".ms-shield-segs");
      if (total === 0) {
        wrap?.remove();
        return;
      }
      if (!wrap) {
        wrap = document.createElement("span");
        wrap.className = "ms-shield-segs";
        el.insertBefore(wrap, el.firstChild);
      }
      wrap.title = `Shield power: ${owned}/${total} stations`;
      wrap.textContent = "";
      for (let i = 0; i < total; i++) {
        const seg = document.createElement("span");
        seg.className = `ms-seg${i < owned ? " lit" : ""}`;
        wrap.appendChild(seg);
      }
    };
    render(this.humansSubsEl, humansOwned);
    render(this.machinesSubsEl, machinesOwned);
  }

  /**
   * Update the per-faction Energy lines under the carrier bars (strategic
   * layer — capture-station income + upgrade tiers). `active` false (maps
   * without stations) keeps the lines empty/hidden. Write-on-change; cheap
   * to call every frame.
   */
  setEnergy(
    active: boolean,
    humansEnergy: number,
    humansTier: number,
    machinesEnergy: number,
    machinesTier: number,
  ): void {
    const hE = Math.floor(humansEnergy);
    const mE = Math.floor(machinesEnergy);
    const sig = active ? `${hE}:${humansTier}|${mE}:${machinesTier}` : "off";
    if (sig === this.lastEnergySig) return;
    this.lastEnergySig = sig;
    const render = (el: HTMLElement | null, energy: number, tier: number) => {
      if (!el) return;
      if (!active) {
        el.textContent = "";
        return;
      }
      el.textContent = "";
      const num = document.createElement("span");
      num.className = "ms-energy-num";
      num.textContent = `⚡ ${energy}`;
      el.appendChild(num);
      const tiers = GameConfig.energy.thresholds.length;
      for (let i = 0; i < tiers; i++) {
        const pip = document.createElement("span");
        pip.className = `ms-tier${i < tier ? " lit" : ""}`;
        pip.textContent = "▮";
        pip.title = GameConfig.energy.thresholds[i].effect;
        el.appendChild(pip);
      }
    };
    render(this.humansEnergyEl, hE, humansTier);
    render(this.machinesEnergyEl, mE, machinesTier);
  }

  /**
   * Show/update the docked capture-status line (null = hidden). Continuous —
   * called every frame with the live meter; write-on-change keeps the DOM
   * quiet between percentage steps.
   */
  setCaptureStatus(status: CaptureStatus | null): void {
    const el = this.captureStatusEl;
    if (!el) return;
    const sig = status ? `${status.tone}|${status.text}` : "";
    if (sig === this.lastCaptureSig) return;
    this.lastCaptureSig = sig;
    if (!status) {
      el.className = "capture-status";
      el.textContent = "";
      return;
    }
    el.textContent = status.text;
    el.className = `capture-status show ${status.tone}`;
  }

  /**
   * Flash a transient strategic notification under the objective bars
   * ("HANGAR DESTROYED", "SHIELDS OFFLINE — NO STATION POWER"). `tone`
   * colors it from the local pilot's perspective: "good" = enemy setback,
   * "bad" = ours. A new toast replaces the current one.
   */
  showStrategicToast(text: string, tone: "good" | "bad"): void {
    const el = this.strategicToastEl;
    if (!el) return;
    el.textContent = text;
    el.className = `strategic-toast show ${tone}`;
    if (this.strategicToastTimer !== null) {
      window.clearTimeout(this.strategicToastTimer);
    }
    this.strategicToastTimer = window.setTimeout(() => {
      el.className = "strategic-toast";
      this.strategicToastTimer = null;
    }, 4000);
  }

  /**
   * Show the victory/defeat banner (idempotent — only writes the DOM once).
   * Pass null to hide it (e.g. on restart, though we currently reload).
   * `stats` is the run summary line shown under the title (kills/score).
   * `rows` is the match leaderboard — every pilot ranked by kills, rendered
   * between the stats line and the restart hint (omitted = no board).
   */
  setEndBanner(
    outcome: "victory" | "defeat" | null,
    stats = "",
    rows?: ScoreRow[],
  ): void {
    if (!this.endBannerEl) return;
    if (outcome === null) {
      if (!this.endShown) return;
      this.endShown = false;
      this.endBannerEl.className = "end-banner hidden";
      return;
    }
    if (this.endShown) return;
    this.endShown = true;
    const title = outcome === "victory" ? "VICTORY" : "DEFEAT";
    const titleEl = this.endBannerEl.querySelector<HTMLElement>(".end-title");
    const statsEl = this.endBannerEl.querySelector<HTMLElement>(".end-stats");
    const boardEl = this.endBannerEl.querySelector<HTMLElement>(".end-board");
    const subEl = this.endBannerEl.querySelector<HTMLElement>(".end-sub");
    if (titleEl) titleEl.textContent = title;
    if (statsEl) statsEl.textContent = stats;
    if (boardEl && rows && rows.length > 0) {
      this.renderScoreRows(boardEl, [...rows].sort(compareScoreRows));
    }
    if (subEl) subEl.textContent = "Press Enter to restart · Esc for menu";
    this.endBannerEl.className = `end-banner ${outcome}`;
  }


  /**
   * Show or hide the centered launch countdown overlay. Pass null to hide.
   * Skips DOM writes when the text hasn't changed (called every frame).
   */
  setLaunchOverlay(text: string | null): void {
    if (!this.launchOverlayEl || text === this.lastOverlayText) return;
    this.lastOverlayText = text;
    if (text === null) {
      this.launchOverlayEl.classList.add("hidden");
    } else {
      this.launchOverlayEl.textContent = text;
      this.launchOverlayEl.classList.remove("hidden");
    }
  }

  /** Last dock state written (write-on-change; called every frame). */
  private dockShown: "servicing" | "docked" | null = null;

  /**
   * Carrier-service cue: SERVICING (actively repairing/rearming, green),
   * DOCKED (in the bubble but already full, dim green), or hidden. Called
   * every frame from updateViews; only touches the DOM when the state flips.
   */
  setServiceStatus(state: "servicing" | "docked" | null): void {
    if (state === this.dockShown) return;
    this.dockShown = state;
    if (!this.dockEl) return;
    if (state === "servicing") {
      this.dockEl.textContent = "SERVICING";
      this.dockEl.style.color = "#a6e3a1";
    } else if (state === "docked") {
      this.dockEl.textContent = "DOCKED";
      this.dockEl.style.color = "#74c7ec";
    } else {
      this.dockEl.textContent = "---";
      this.dockEl.style.color = "#6c7086";
    }
  }

  /**
   * Drive the jump-drive spool ring. `progress` is 0→1 (arm→fire) while the
   * player's drive is spooling, or null to hide it. Called every frame; only
   * touches the DOM when the displayed tenth-of-a-second changes (the conic
   * fill + countdown text move together). The countdown counts DOWN to the
   * jump (the audio build-up is its audible companion).
   */
  setJumpSpool(progress: number | null): void {
    if (progress === null) {
      if (this.lastJumpTenths !== -1) {
        this.lastJumpTenths = -1;
        this.jumpRingEl.classList.add("hidden");
      }
      return;
    }
    const remainingSec = (1 - progress) * (GameConfig.jump.spoolMs / 1000);
    const tenths = Math.ceil(remainingSec * 10);
    if (tenths === this.lastJumpTenths) return;
    if (this.lastJumpTenths === -1) this.jumpRingEl.classList.remove("hidden");
    this.lastJumpTenths = tenths;
    this.jumpRingEl.style.setProperty(
      "--spool",
      `${Math.round(progress * 360)}deg`,
    );
    if (this.jumpRingTextEl) {
      this.jumpRingTextEl.textContent = (tenths / 10).toFixed(1);
    }
  }

  /**
   * Drive the respawn countdown ring. `remainingMs` is the wait left while
   * the player is dead, or null to hide (alive, launching, match over).
   * `totalMs` is the full wait (the ring fills as it elapses). Called every
   * frame; only touches the DOM when the displayed tenth changes. Whole
   * seconds read best for a long bench; the last 10s tick in tenths like the
   * jump spool.
   */
  setRespawnCountdown(remainingMs: number | null, totalMs: number): void {
    if (remainingMs === null) {
      if (this.lastRespawnTenths !== -1) {
        this.lastRespawnTenths = -1;
        this.respawnRingEl.classList.add("hidden");
      }
      return;
    }
    const tenths = Math.ceil(remainingMs / 100);
    if (tenths === this.lastRespawnTenths) return;
    if (this.lastRespawnTenths === -1) {
      this.respawnRingEl.classList.remove("hidden");
    }
    this.lastRespawnTenths = tenths;
    const progress = totalMs > 0 ? 1 - remainingMs / totalMs : 1;
    this.respawnRingEl.style.setProperty(
      "--spool",
      `${Math.round(progress * 360)}deg`,
    );
    if (this.respawnRingTextEl) {
      const sec = tenths / 10;
      this.respawnRingTextEl.textContent =
        sec > 10 ? String(Math.ceil(sec)) : sec.toFixed(1);
    }
  }

  /**
   * Who the death-spectate camera is following, or null to hide the line
   * (alive, wreck-hold beat, nobody watchable). Rides under the redeploy
   * ring, so it's only ever visible while the ring is. Write-on-change.
   */
  setSpectating(callsign: string | null): void {
    if (callsign === this.lastSpectateLabel || !this.spectateLabelEl) return;
    this.lastSpectateLabel = callsign;
    if (callsign === null) {
      this.spectateLabelEl.classList.add("hidden");
    } else {
      this.spectateLabelEl.textContent = `SPECTATING — ${callsign}`;
      this.spectateLabelEl.classList.remove("hidden");
    }
  }

  /** Last pilot counts written (write-on-change; MP calls this per snapshot). */
  private lastPilots = "";

  /**
   * The honesty rule (docs/MULTIPLAYER.md): the HUD must say how many seats
   * are humans vs. bots. Multiplayer-only — the row stays hidden until the
   * first call, so the offline HUD is unchanged.
   */
  setPilotCounts(humans: number, bots: number): void {
    const text = `${humans} human · ${bots} ai`;
    if (text === this.lastPilots) return;
    this.lastPilots = text;
    if (this.pilotsRowEl) this.pilotsRowEl.style.display = "";
    if (this.pilotsEl) this.pilotsEl.textContent = text;
  }

  /**
   * Reveal the invite-link row (multiplayer-only, like the pilots row — the
   * address bar carries `#join=<roomId>`, and I copies it for a friend).
   */
  showInviteHint(): void {
    if (this.inviteRowEl) this.inviteRowEl.style.display = "";
  }

  /** Flash the invite row's result, then revert to the dim key hint. */
  flashInviteCopied(ok: boolean): void {
    if (!this.inviteEl) return;
    if (this.inviteFlashTimer !== null) window.clearTimeout(this.inviteFlashTimer);
    this.inviteEl.textContent = ok ? "LINK COPIED" : "COPY FAILED";
    this.inviteEl.style.color = ok ? "#a6e3a1" : "#f38ba8";
    this.inviteFlashTimer = window.setTimeout(() => {
      this.inviteFlashTimer = null;
      if (!this.inviteEl) return;
      this.inviteEl.textContent = "I · copy link";
      this.inviteEl.style.color = "#6c7086";
    }, 2000);
  }

  setMuted(muted: boolean): void {
    if (!this.sfxEl) return;
    this.sfxEl.textContent = muted ? "off" : "on";
    this.sfxEl.style.color = muted ? "#6c7086" : "";
  }

  /**
   * Drive the incoming-missile cues. Called EVERY frame by MissileWarning
   * (not 10 Hz-throttled like update() — the border pulse is the fast,
   * rhythm-carrying channel), so both writes are guarded: the INCOMING label
   * only touches the DOM when the threat state flips, and the border opacity
   * (compositor-only, no layout) skips sub-1% deltas so an idle overlay
   * costs nothing.
   */
  setMissileWarning(active: boolean, pulseAlpha: number): void {
    if (active !== this.warnShown) {
      this.warnShown = active;
      if (this.warnEl) {
        // "INCOMING", not "MISSILE LOCK": the AI has no pre-launch lock phase —
        // the detectable event is a missile already in flight.
        this.warnEl.textContent = active ? "INCOMING" : "---";
        this.warnEl.style.color = active ? "#f38ba8" : "#6c7086";
      }
    }
    const alpha = Math.round(pulseAlpha * 100) / 100;
    if (alpha !== this.lastPulseAlpha) {
      this.lastPulseAlpha = alpha;
      this.incomingOverlayEl.style.opacity = String(alpha);
    }
  }

  update(
    player: Ship,
    nowMs: number,
    lockAvailable: boolean,
    zoom: number,
    signature: "detected" | "hidden" | "untracked",
    kills: number,
    wingKills: number,
    score: number,
    bestScore: number,
  ): void {
    if (nowMs - this.lastTextUpdateMs < 100) return;
    this.lastTextUpdateMs = nowMs;

    // HP with color cue.
    if (this.hpEl) {
      // hp can be fractional mid-service — show a whole number (ceil so a
      // barely-alive ship never reads "0").
      this.hpEl.textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
      const frac = player.hp / player.maxHp;
      // Catppuccin Mocha-ish palette: green / yellow / red, plus dim while dead.
      let color = "#a6e3a1";
      if (frac < 0.3) color = "#f38ba8";
      else if (frac < 0.6) color = "#f9e2af";
      if (player.hp <= 0) color = "#6c7086"; // dimmed when dead
      this.hpEl.style.color = color;
    }

    if (this.posEl) {
      this.posEl.textContent = `${player.position.x.toFixed(1)}, ${player.position.z.toFixed(1)}`;
    }
    if (this.velEl) this.velEl.textContent = player.speed.toFixed(1);

    // Cannon ammo — the draining magazine that gates primary fire. Yellow
    // while stocked, orange when low (<25%), dim red when empty (defenseless
    // on cannons — go rearm at the carrier). The visible drain is part of the
    // anti-spam mechanic (docs/JUMP-DRIVE-AND-RESUPPLY.md).
    if (this.cannonEl) {
      // floor: only WHOLE rounds are fireable, so don't advertise a partial.
      this.cannonEl.textContent = `${Math.floor(player.cannonAmmo)} / ${player.maxCannonAmmo}`;
      const frac =
        player.maxCannonAmmo > 0 ? player.cannonAmmo / player.maxCannonAmmo : 0;
      let color = "#f9e2af";
      if (player.cannonAmmo <= 0) color = "#f38ba8";
      else if (frac < 0.25) color = "#fab387";
      this.cannonEl.style.color = color;
    }

    // Missile ammo — dim once empty.
    if (this.missilesEl) {
      this.missilesEl.textContent = String(Math.floor(player.missileAmmo));
      this.missilesEl.style.color =
        player.missileAmmo >= 1 ? "#f9e2af" : "#6c7086";
    }

    if (this.zoomEl) this.zoomEl.textContent = zoom.toFixed(2);

    // Lock cue: green LOCK only when a lock is available AND we have a missile
    // to use it; otherwise a dim placeholder.
    if (this.lockEl) {
      const canLock = lockAvailable && player.missileAmmo >= 1;
      this.lockEl.textContent = canLock ? "LOCK" : "---";
      this.lockEl.style.color = canLock ? "#a6e3a1" : "#6c7086";
    }

    // Sensor signature cue — does the ENEMY's picture have a fresh track on
    // you right now? DETECTED (red), HIDDEN (green, inside a nebula and
    // untracked), or a dim NO TRACK (untracked in the open — they've merely
    // lost you, nothing is concealing you).
    if (this.sigEl) {
      if (signature === "detected") {
        this.sigEl.textContent = "DETECTED";
        this.sigEl.style.color = "#f38ba8";
      } else if (signature === "hidden") {
        this.sigEl.textContent = "HIDDEN";
        this.sigEl.style.color = "#a6e3a1";
      } else {
        this.sigEl.textContent = "NO TRACK";
        this.sigEl.style.color = "#6c7086";
      }
    }

    // Progression: the player's own kills (wing kills noted alongside) and
    // the running score vs. the persistent best.
    if (this.killsEl) {
      this.killsEl.textContent =
        wingKills > 0 ? `${kills} (+${wingKills} wing)` : String(kills);
    }
    if (this.scoreEl) {
      this.scoreEl.textContent =
        bestScore > 0 ? `${score} · best ${bestScore}` : String(score);
      this.scoreEl.style.color =
        score > 0 && score >= bestScore ? "#f9e2af" : "";
    }
  }
}
