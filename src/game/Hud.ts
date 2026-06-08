import type { PlayerShip } from "./PlayerShip";
import type { LaserSystem } from "./LaserSystem";

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
  private readonly modelEl: Element | null;
  private readonly launchOverlayEl: HTMLElement | null;

  private lastTextUpdateMs = 0;
  private lastOverlayText: string | null = null;

  constructor(root: HTMLDivElement) {
    root.innerHTML = `
      <div><span class="label">hp</span><span id="hud-hp">100 / 100</span></div>
      <div><span class="label">pos</span><span id="hud-pos">0.0, 0.0</span></div>
      <div><span class="label">vel</span><span id="hud-vel">0.0</span> u/s</div>
      <div><span class="label">lasers</span><span id="hud-lasers">0</span></div>
      <div><span class="label">missiles</span><span id="hud-missiles">0</span></div>
      <div><span class="label">lock</span><span id="hud-lock">---</span></div>
      <div><span class="label">model</span><span id="hud-model">-</span></div>
    `;
    this.hpEl = root.querySelector<HTMLElement>("#hud-hp");
    this.posEl = root.querySelector("#hud-pos");
    this.velEl = root.querySelector("#hud-vel");
    this.lasersEl = root.querySelector("#hud-lasers");
    this.missilesEl = root.querySelector<HTMLElement>("#hud-missiles");
    this.lockEl = root.querySelector<HTMLElement>("#hud-lock");
    this.modelEl = root.querySelector("#hud-model");

    // Launch overlay lives outside the debug panel — it's fullscreen-centered.
    const overlay = document.createElement("div");
    overlay.id = "launch-overlay";
    overlay.className = "launch-overlay hidden";
    document.body.appendChild(overlay);
    this.launchOverlayEl = overlay;
  }

  setModelLabel(label: string): void {
    if (this.modelEl) this.modelEl.textContent = label;
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

  update(
    player: PlayerShip,
    lasers: LaserSystem,
    nowMs: number,
    lockAvailable: boolean,
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

    // Lock cue: green LOCK only when a lock is available AND we have a missile
    // to use it; otherwise a dim placeholder.
    if (this.lockEl) {
      const canLock = lockAvailable && player.missileAmmo > 0;
      this.lockEl.textContent = canLock ? "LOCK" : "---";
      this.lockEl.style.color = canLock ? "#a6e3a1" : "#6c7086";
    }
  }
}
