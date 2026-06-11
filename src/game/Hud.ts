import type { Ship } from "./Ship";
import type { LaserSystem } from "./LaserSystem";
import { FACTION_THEME } from "./Faction";

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
  private readonly lasersEl: Element | null;
  private readonly missilesEl: HTMLElement | null;
  private readonly lockEl: HTMLElement | null;
  private readonly zoomEl: Element | null;
  private readonly sfxEl: HTMLElement | null;
  private readonly launchOverlayEl: HTMLElement | null;
  private readonly humansFillEl: HTMLElement | null;
  private readonly machinesFillEl: HTMLElement | null;
  private readonly endBannerEl: HTMLElement | null;

  private lastTextUpdateMs = 0;
  private lastOverlayText: string | null = null;
  private endShown = false;

  constructor(root: HTMLDivElement) {
    root.innerHTML = `
      <div><span class="label">hp</span><span id="hud-hp">100 / 100</span></div>
      <div><span class="label">pos</span><span id="hud-pos">0.0, 0.0</span></div>
      <div><span class="label">vel</span><span id="hud-vel">0.0</span> u/s</div>
      <div><span class="label">lasers</span><span id="hud-lasers">0</span></div>
      <div><span class="label">missiles</span><span id="hud-missiles">0</span></div>
      <div><span class="label">lock</span><span id="hud-lock">---</span></div>
      <div><span class="label">zoom</span><span id="hud-zoom">1.00</span></div>
      <div><span class="label">sfx</span><span id="hud-sfx">on</span></div>
    `;
    this.hpEl = root.querySelector<HTMLElement>("#hud-hp");
    this.posEl = root.querySelector("#hud-pos");
    this.velEl = root.querySelector("#hud-vel");
    this.lasersEl = root.querySelector("#hud-lasers");
    this.missilesEl = root.querySelector<HTMLElement>("#hud-missiles");
    this.lockEl = root.querySelector<HTMLElement>("#hud-lock");
    this.zoomEl = root.querySelector("#hud-zoom");
    this.sfxEl = root.querySelector<HTMLElement>("#hud-sfx");

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
    banner.innerHTML = `<div class="end-title"></div><div class="end-sub"></div>`;
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
   */
  setEndBanner(outcome: "victory" | "defeat" | null): void {
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
    const subEl = this.endBannerEl.querySelector<HTMLElement>(".end-sub");
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = "Press Enter to restart";
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

  setMuted(muted: boolean): void {
    if (!this.sfxEl) return;
    this.sfxEl.textContent = muted ? "off" : "on";
    this.sfxEl.style.color = muted ? "#6c7086" : "";
  }

  update(
    player: Ship,
    lasers: LaserSystem,
    nowMs: number,
    lockAvailable: boolean,
    zoom: number,
  ): void {
    if (nowMs - this.lastTextUpdateMs < 100) return;
    this.lastTextUpdateMs = nowMs;

    // HP with color cue.
    if (this.hpEl) {
      this.hpEl.textContent = `${player.hp} / ${player.maxHp}`;
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
    if (this.lasersEl) this.lasersEl.textContent = String(lasers.count);

    // Missile ammo — dim once empty.
    if (this.missilesEl) {
      this.missilesEl.textContent = String(player.missileAmmo);
      this.missilesEl.style.color =
        player.missileAmmo > 0 ? "#f9e2af" : "#6c7086";
    }

    if (this.zoomEl) this.zoomEl.textContent = zoom.toFixed(2);

    // Lock cue: green LOCK only when a lock is available AND we have a missile
    // to use it; otherwise a dim placeholder.
    if (this.lockEl) {
      const canLock = lockAvailable && player.missileAmmo > 0;
      this.lockEl.textContent = canLock ? "LOCK" : "---";
      this.lockEl.style.color = canLock ? "#a6e3a1" : "#6c7086";
    }
  }
}
