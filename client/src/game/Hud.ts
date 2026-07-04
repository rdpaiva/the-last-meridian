import type { Ship } from "@space-duel/shared";
import { FACTION_THEME } from "@space-duel/shared";
import { GameConfig } from "@space-duel/shared";

/**
 * Plain DOM debug HUD. DOM updates are throttled to 10 Hz — the HUD doesn't
 * need 144fps and updating textContent every frame churns layout for no
 * reason.
 *
 * HP gets a color cue (green / yellow / red) so the player can read their
 * health at a glance without parsing the number.
 */
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
  private readonly zoomEl: Element | null;
  private readonly sfxEl: HTMLElement | null;
  private readonly launchOverlayEl: HTMLElement | null;
  private readonly humansFillEl: HTMLElement | null;
  private readonly machinesFillEl: HTMLElement | null;
  private readonly endBannerEl: HTMLElement | null;

  private readonly incomingOverlayEl: HTMLElement;
  private readonly jumpRingEl: HTMLElement;
  private readonly jumpRingTextEl: HTMLElement | null;
  /** Last spool tenth written to the ring (write-on-change; per-frame). */
  private lastJumpTenths = -1;

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
      </div>
      <div class="ms-bar ms-machines">
        <span class="ms-label">${FACTION_THEME.machines.mothershipName.toUpperCase()}</span>
        <div class="ms-track"><div class="ms-fill" id="ms-fill-machines"></div></div>
      </div>
    `;
    document.body.appendChild(msBars);
    this.humansFillEl = msBars.querySelector<HTMLElement>("#ms-fill-humans");
    this.machinesFillEl = msBars.querySelector<HTMLElement>("#ms-fill-machines");

    // Victory / defeat banner — fullscreen, hidden until the match ends.
    const banner = document.createElement("div");
    banner.id = "end-banner";
    banner.className = "end-banner hidden";
    banner.innerHTML = `<div class="end-title"></div><div class="end-stats"></div><div class="end-sub"></div>`;
    document.body.appendChild(banner);
    this.endBannerEl = banner;
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
   * Show the victory/defeat banner (idempotent — only writes the DOM once).
   * Pass null to hide it (e.g. on restart, though we currently reload).
   * `stats` is the run summary line shown under the title (kills/score).
   */
  setEndBanner(outcome: "victory" | "defeat" | null, stats = ""): void {
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
    const subEl = this.endBannerEl.querySelector<HTMLElement>(".end-sub");
    if (titleEl) titleEl.textContent = title;
    if (statsEl) statsEl.textContent = stats;
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
