import { GameConfig } from "@space-duel/shared";

/** One frame's netcode internals, gathered by NetworkGame.tick. */
export interface NetDebugStats {
  /** Smoothed wall↔sim clock offset (ms); null before the first patch. */
  clockOffsetMs: number | null;
  /** Own ship's snapshot buffer depth (samples held for interpolation). */
  bufferDepth: number;
  /** Newest own-ship sample time minus the render time (ms) — how much
   *  buffered future the interpolation has left before it starves. */
  bufferHeadroomMs: number;
  /** Prediction inputs sent but not yet acked (the replay set). */
  pendingInputs: number;
  /** inputSeq − last acked seq: input frames the server hasn't consumed. */
  ackLagInputs: number;
  /** Magnitude of the decaying visual correction offset (world units). */
  correctionUnits: number;
  /** Magnitude of the rotational correction (degrees). */
  correctionDeg: number;
  /** Server FX facts queued, waiting for the render clock. */
  fxQueueDepth: number;
  /** Replicated ships being interpolated. */
  shipsTracked: number;
}

/**
 * Dev netcode readout (plain DOM, like the Hud; online only). Backquote
 * toggles it — the key is free in MP; offline it's the god-mode toggle. Shows
 * the live numbers behind the GameConfig.net feel knobs (clock offset,
 * interpolation buffer depth/headroom, prediction queue + ack lag, correction
 * magnitude, FX queue) so netcode feel can be tuned while flying.
 *
 * When the network-condition simulator (GameConfig.net.sim) is enabled, an
 * amber NETSIM badge stays pinned to the viewport even while the panel is
 * hidden — simulated latency must never be mistakable for real feel.
 */
export class NetDebugOverlay {
  private readonly panel: HTMLDivElement;
  private badge: HTMLDivElement | null = null;
  private shown = false;
  /** Last panel rewrite (ms) — 5 Hz is readable; per-frame is churn. */
  private lastTextMs = 0;

  constructor() {
    this.panel = document.createElement("div");
    this.panel.id = "netdebug";
    this.panel.style.display = "none";
    document.body.appendChild(this.panel);

    const sim = GameConfig.net.sim;
    if (sim.enabled) {
      this.badge = document.createElement("div");
      this.badge.id = "netsim-badge";
      this.badge.textContent = `NETSIM ON · ${sim.latencyMs}ms RTT ±${sim.jitterMs}ms`;
      document.body.appendChild(this.badge);
    }
  }

  /** Whether the panel is showing — callers skip gathering stats when not. */
  get visible(): boolean {
    return this.shown;
  }

  toggle(): void {
    this.shown = !this.shown;
    this.panel.style.display = this.shown ? "block" : "none";
  }

  update(nowMs: number, s: NetDebugStats): void {
    if (!this.shown || nowMs - this.lastTextMs < 200) return;
    this.lastTextMs = nowMs;
    const sim = GameConfig.net.sim;
    const net = GameConfig.net;
    this.panel.textContent =
      `NETCODE (\` to hide)\n` +
      `clock offset  ${s.clockOffsetMs === null ? "---" : s.clockOffsetMs.toFixed(1)} ms\n` +
      `interp delay  ${net.interpDelayMs} ms (cfg)\n` +
      `snap buffer   ${s.bufferDepth} · headroom ${s.bufferHeadroomMs.toFixed(0)} ms\n` +
      `pending in    ${s.pendingInputs} · ack lag ${s.ackLagInputs}\n` +
      `correction    ${s.correctionUnits.toFixed(2)} u · ${s.correctionDeg.toFixed(1)}°\n` +
      `fx queue      ${s.fxQueueDepth}\n` +
      `ships         ${s.shipsTracked}\n` +
      `netsim        ${sim.enabled ? `ON ${sim.latencyMs}ms ±${sim.jitterMs}ms` : "off"}`;
  }

  dispose(): void {
    this.panel.remove();
    this.badge?.remove();
  }
}
