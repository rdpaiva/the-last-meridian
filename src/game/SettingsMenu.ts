import { TUNING_SCHEMA, type TuningEntry } from "./TuningSchema";
import {
  exportTuningJson,
  getTuningDefault,
  getTuningValue,
  importTuningJson,
  isOverridden,
  overrideCount,
  resetAllTuning,
  resetTuningValue,
  setTuningValue,
} from "./ConfigOverrides";

/**
 * The match-settings stage of the splash flow (data-state="settings"): a
 * schema-driven tuning screen for dev/playtesting — every knob in
 * TUNING_SCHEMA gets a slider + number field (or a checkbox), grouped into
 * collapsible sections. Plain DOM like the HUD and LoadoutMenu (no
 * framework). main.ts owns showing/hiding it via the splash state machine;
 * Esc/BACK return to wherever the player came from.
 *
 * Edits take effect immediately in the live GameConfig (via ConfigOverrides)
 * and persist to localStorage, but the SIM only feels them on the next match
 * launch — every system copies its config at construction. Copy/Paste JSON
 * round-trips the sparse override blob so testers can share setups.
 *
 * Structural re-renders (reset all / import) rebuild the whole tree —
 * a pre-game screen, nowhere near a hot path; slider drags only touch their
 * own row's DOM.
 */
export class SettingsMenu {
  private statusTimer: number | undefined;
  /** RESET ALL is two-click (arm, then confirm) — no browser confirm() box. */
  private resetArmed = false;
  private resetArmTimer: number | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly onBack: () => void,
    /** Fires after any change so main.ts can refresh its "N modified" badge. */
    private readonly onChanged: () => void,
  ) {
    this.render();
    // Click-away closes any open ⓘ popover. Document-level (not root-level)
    // so clicking the BACK button or outside the panel closes it too; never
    // removed — the menu lives for the page lifetime. Clicks ON an ⓘ button
    // are left to that button's own toggle handler (which runs first, in the
    // bubble phase); clicks inside a popover keep it open so text can be
    // selected/copied.
    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest(".set-info") && !t?.closest(".set-info-pop")) {
        this.closeInfoPops();
      }
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private render(): void {
    // Preserve which sections the user has open across structural re-renders.
    const openState = new Map<string, boolean>();
    for (const d of this.root.querySelectorAll<HTMLDetailsElement>("details.set-group")) {
      openState.set(d.dataset.group ?? "", d.open);
    }

    const groups = TUNING_SCHEMA.map((g, i) => {
      const open = openState.get(g.title) ?? i === 0;
      return `
        <details class="set-group" data-group="${g.title}"${open ? " open" : ""}>
          <summary>${g.title}<span class="set-group-mod"></span></summary>
          <div class="set-rows">${g.entries.map((e) => this.rowHtml(e)).join("")}</div>
        </details>`;
    }).join("");

    // The io textarea stays hidden until PASTE SETUP opens it (or COPY SETUP
    // falls back to it when the clipboard is blocked) — the JSON never sits
    // on the screen by default.
    this.root.innerHTML = `
      <div class="settings-head">
        <span class="settings-title">MATCH SETTINGS</span>
        <span class="settings-modcount"></span>
        <span class="settings-status"></span>
        <div class="settings-actions">
          <button id="set-export" class="set-btn" title="Copy your changed settings to the clipboard, to save or share">COPY SETUP</button>
          <button id="set-import" class="set-btn" title="Paste a shared setup (replaces current changes)">PASTE SETUP</button>
          <button id="set-resetall" class="set-btn">RESET ALL</button>
          <button id="set-back" class="set-btn primary">BACK</button>
        </div>
      </div>
      <div class="settings-note">
        Applies on the next launch · saved in this browser · Esc to go back
      </div>
      <div class="settings-io" hidden>
        <textarea id="set-io-text" rows="7" spellcheck="false" placeholder='Paste a settings JSON blob here, e.g. { "asteroids.count": 120 }'></textarea>
        <div class="settings-io-actions">
          <button id="set-io-apply" class="set-btn primary">APPLY</button>
          <button id="set-io-cancel" class="set-btn">CLOSE</button>
        </div>
      </div>
      <div class="settings-body">${groups}</div>`;

    this.byId("set-back").addEventListener("click", () => this.onBack());
    this.byId("set-resetall").addEventListener("click", () => this.resetAll());
    this.byId("set-export").addEventListener("click", () => void this.copyJson());
    this.byId("set-import").addEventListener("click", () => this.openIo(""));
    this.byId("set-io-apply").addEventListener("click", () => this.applyIo());
    this.byId("set-io-cancel").addEventListener("click", () => this.closeIo());

    for (const row of this.root.querySelectorAll<HTMLElement>(".set-row")) {
      this.bindRow(row);
    }
    this.updateCounts();
  }

  private rowHtml(entry: TuningEntry): string {
    const control =
      entry.kind === "boolean"
        ? `<span></span><input type="checkbox" class="set-check">`
        : entry.kind === "choice"
          ? `<select class="set-select">${entry
              .options!.map((o) => `<option value="${o.value}">${o.label}</option>`)
              .join("")}</select>`
          : `<input type="range" class="set-range" min="${entry.min}" max="${entry.max}" step="${entry.step}">
             <input type="number" class="set-num" min="${entry.min}" max="${entry.max}" step="${entry.step}">`;
    // The ⓘ toggles the popover (hidden attribute — no display rule in CSS,
    // or [hidden] would stop working). One open at a time; click-away closes.
    return `
      <div class="set-row" data-path="${entry.path}">
        <span class="set-label">${entry.label}<button class="set-info" title="What does this do?">i</button></span>
        ${control}
        <button class="set-reset" title="Reset to default (${getTuningDefault(entry.path)})">⟲</button>
        <div class="set-info-pop" hidden>${entry.hint} <span class="set-info-default">Default: ${getTuningDefault(entry.path)}.</span></div>
      </div>`;
  }

  // ── Row wiring ───────────────────────────────────────────────────────────

  private bindRow(row: HTMLElement): void {
    const path = row.dataset.path!;
    const range = row.querySelector<HTMLInputElement>(".set-range");
    const num = row.querySelector<HTMLInputElement>(".set-num");
    const check = row.querySelector<HTMLInputElement>(".set-check");
    const select = row.querySelector<HTMLSelectElement>(".set-select");
    const reset = row.querySelector<HTMLButtonElement>(".set-reset")!;
    const info = row.querySelector<HTMLButtonElement>(".set-info")!;
    const pop = row.querySelector<HTMLElement>(".set-info-pop")!;

    const sync = (): void => {
      const v = getTuningValue(path);
      if (check && typeof v === "boolean") check.checked = v;
      if (select && typeof v === "string") select.value = v;
      if (typeof v === "number") {
        if (range) range.value = String(v);
        if (num) num.value = String(v);
      }
      row.classList.toggle("modified", isOverridden(path));
    };

    const apply = (raw: number | boolean | string): void => {
      setTuningValue(path, raw);
      sync();
      this.updateCounts();
      this.onChanged();
    };

    range?.addEventListener("input", () => apply(parseFloat(range.value)));
    // "change" (not "input") so a half-typed number isn't clamped under the
    // user's cursor; the commit snaps both controls to the clamped value.
    num?.addEventListener("change", () => apply(parseFloat(num.value)));
    check?.addEventListener("change", () => apply(check.checked));
    select?.addEventListener("change", () => apply(select.value));
    info.addEventListener("click", () => {
      const wasHidden = pop.hidden;
      this.closeInfoPops(); // one popover at a time
      pop.hidden = !wasHidden;
    });
    reset.addEventListener("click", () => {
      resetTuningValue(path);
      sync();
      this.updateCounts();
      this.onChanged();
    });

    sync();
  }

  private closeInfoPops(): void {
    for (const pop of this.root.querySelectorAll<HTMLElement>(".set-info-pop")) {
      pop.hidden = true;
    }
  }

  /** Refresh the header badge + each section's "· N" modified marker. */
  private updateCounts(): void {
    const n = overrideCount();
    this.root.querySelector<HTMLElement>(".settings-modcount")!.textContent =
      n > 0 ? `· ${n} modified` : "· defaults";
    for (const group of this.root.querySelectorAll<HTMLDetailsElement>(".set-group")) {
      const mods = group.querySelectorAll(".set-row.modified").length;
      group.querySelector<HTMLElement>(".set-group-mod")!.textContent =
        mods > 0 ? `· ${mods}` : "";
    }
  }

  // ── Header actions ───────────────────────────────────────────────────────

  private async copyJson(): Promise<void> {
    if (overrideCount() === 0) {
      this.status("Nothing to copy — every setting is at its default");
      return;
    }
    const json = exportTuningJson();
    try {
      await navigator.clipboard.writeText(json);
      this.status(`Setup copied — ${overrideCount()} changed setting(s)`);
    } catch {
      // Clipboard blocked (permissions / non-secure context) — fall back to
      // the textarea so the user can copy by hand.
      this.openIo(json);
      this.status("Clipboard unavailable — copy from the box below");
    }
  }

  private applyIo(): void {
    const text = this.byId<HTMLTextAreaElement>("set-io-text").value;
    const result = importTuningJson(text);
    if (!result) {
      this.status("Not a valid settings JSON blob");
      return;
    }
    this.render(); // structural: every row's value may have changed
    this.onChanged();
    this.status(
      `Applied ${result.applied} setting(s)` +
        (result.skipped > 0 ? ` · skipped ${result.skipped} unknown/bad` : ""),
    );
  }

  private resetAll(): void {
    const btn = this.byId<HTMLButtonElement>("set-resetall");
    if (!this.resetArmed) {
      this.resetArmed = true;
      btn.textContent = "CLICK TO CONFIRM";
      btn.classList.add("armed");
      window.clearTimeout(this.resetArmTimer);
      this.resetArmTimer = window.setTimeout(() => {
        this.resetArmed = false;
        btn.textContent = "RESET ALL";
        btn.classList.remove("armed");
      }, 3000);
      return;
    }
    window.clearTimeout(this.resetArmTimer);
    this.resetArmed = false;
    resetAllTuning();
    this.render();
    this.onChanged();
    this.status("All settings restored to defaults");
  }

  // ── Small helpers ────────────────────────────────────────────────────────

  private openIo(text: string): void {
    const io = this.root.querySelector<HTMLElement>(".settings-io")!;
    io.hidden = false;
    const ta = this.byId<HTMLTextAreaElement>("set-io-text");
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
    this.statusTimer = window.setTimeout(() => (el.textContent = ""), 3500);
  }

  private byId<T extends HTMLElement = HTMLButtonElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }
}
