import { GameConfig } from "./GameConfig";
import { clamp } from "./math";
import type { Ship } from "./Ship";

type Phase = "hold" | "launching" | "complete";

/**
 * BSG-style catapult launch for a SINGLE ship. Every ship that launches from a
 * carrier gets one — the human pilot, the AI wingmen, and the enemy fleet — so
 * they all freeze in the tube and are flung out the same way. Only the player's
 * sequence is `cinematic`: it drives the camera zoom and the 3-2-1 overlay; the
 * rest just hold and launch silently.
 *
 * Phases:
 *   hold       — ship frozen in the tube for `holdSec`. For the cinematic
 *                (player) launch this window is the wide establishing shot +
 *                "3 / 2 / 1 / LAUNCH!" countdown; for everyone else it's just a
 *                staggered wait so the wing streams out one ship at a time.
 *                The owning Game suppresses the ship's controller while held.
 *   launching  — catapult fires; ship position is driven directly at
 *                launchSpeed along the carrier's forward axis. No control.
 *   complete   — ship has cleared the bow; Game re-enables normal control.
 */
export class LaunchSequence {
  private phase: Phase;
  private elapsedSec = 0;
  private _justLaunched = false;
  /** When skipping the hold (respawn), fire the catapult kick on the first update. */
  private kickPending = false;

  /**
   * Total pre-launch freeze for the cinematic (player) launch: the wide intro
   * hold + the 3-2-1 countdown + the lingering "LAUNCH!" banner. The whole
   * launch queue is timed off this base so the wing starts streaming out the
   * instant the player catapults.
   */
  static cinematicHoldSec(): number {
    const cfg = GameConfig.launch;
    return cfg.introDuration + cfg.countdownStepSec * 3 + cfg.launchTextSec;
  }

  constructor(
    /**
     * Unit launch direction (world X/Z) — the carrier's facing. The ship is
     * catapulted along this axis, so the launch works for either mothership
     * (humans fire +Z, machines fire -Z).
     */
    private readonly dirX: number,
    private readonly dirZ: number,
    /** Carrier center (world X/Z); the exit test is measured relative to it. */
    private readonly originX: number,
    private readonly originZ: number,
    /**
     * Distance along the launch axis (from the carrier center) the ship must
     * travel to fully clear the bow and hand back to normal control.
     */
    private readonly exitDistance: number,
    /**
     * Seconds the ship sits frozen in the tube before the catapult fires. For
     * the player this is cinematicHoldSec(); for the rest of the queue it's
     * that plus a per-ship stagger so the wing launches one behind the other.
     */
    private readonly holdSec: number,
    /**
     * Whether this sequence drives the camera zoom + 3-2-1 overlay. True for the
     * player's launch only; every other ship holds and launches silently.
     */
    private readonly cinematic: boolean,
    /**
     * Skip the hold entirely and catapult immediately. Used on respawn so a
     * returning ship streams straight back out of its carrier without sitting
     * through a countdown.
     */
    skipIntro = false,
  ) {
    this.phase = skipIntro ? "launching" : "hold";
    this.kickPending = skipIntro;
  }

  // ─── State queries ────────────────────────────────────────────────────────

  get isComplete(): boolean {
    return this.phase === "complete";
  }

  get isLaunching(): boolean {
    return this.phase === "launching";
  }

  /**
   * True for exactly one tick: the frame when the catapult fires.
   * Used by Game.ts to add camera trauma at the launch moment.
   */
  get justLaunched(): boolean {
    return this._justLaunched;
  }

  /**
   * Text for the centered launch overlay, or null when nothing should show.
   * Only the cinematic (player) launch shows text, and only during the hold:
   * null through the wide intro, then "3 / 2 / 1 / LAUNCH!".
   */
  get overlayText(): string | null {
    if (!this.cinematic || this.phase !== "hold") return null;
    const cfg = GameConfig.launch;
    // Time elapsed since the countdown started (after the intro hold).
    const t = this.elapsedSec - cfg.introDuration;
    if (t < 0) return null; // still in the wide establishing shot
    const step = cfg.countdownStepSec;
    if (t < step) return "3";
    if (t < step * 2) return "2";
    if (t < step * 3) return "1";
    return "LAUNCH!";
  }

  /**
   * Desired camera zoom for this frame. Game.ts calls cameraRig.setZoom() with
   * this value each tick while the PLAYER's sequence is active (non-cinematic
   * sequences are never queried for it).
   *
   * Returns introZoom (full mothership visible) during the intro hold, then
   * smoothstep-lerps down to the default over the 3-digit countdown, and holds
   * at the default from LAUNCH! onward.
   */
  get desiredZoom(): number {
    const cfg = GameConfig.launch;
    const defaultZoom = GameConfig.camera.defaultZoom;
    if (!this.cinematic || this.phase !== "hold") return defaultZoom;

    if (this.elapsedSec < cfg.introDuration) return cfg.introZoom;

    const countdownDur = cfg.countdownStepSec * 3;
    const t = Math.min((this.elapsedSec - cfg.introDuration) / countdownDur, 1);
    // Smoothstep easing: slow start and end, fast middle — feels cinematic.
    const eased = t * t * (3 - 2 * t);
    return cfg.introZoom + (defaultZoom - cfg.introZoom) * eased;
  }

  // ─── Tick ─────────────────────────────────────────────────────────────────

  /**
   * Called every simulation frame (skipped during hitstop, same as the rest
   * of the sim). Drives the ship directly while in the launching phase.
   */
  update(deltaSeconds: number, ship: Ship): void {
    this._justLaunched = false;

    if (this.phase === "complete") return;

    // Skip-hold respawn: deliver the catapult kick once, on the first frame.
    if (this.kickPending) {
      this.kickPending = false;
      this._justLaunched = true;
      const s = GameConfig.launch.launchSpeed;
      ship.velocity.set(this.dirX * s, 0, this.dirZ * s);
    }

    this.elapsedSec += deltaSeconds;

    if (this.phase === "hold") {
      // Ship stays frozen in the tube — Game suppresses its controller while a
      // launch sequence is active — until the catapult fires.
      if (this.elapsedSec >= this.holdSec) {
        this.phase = "launching";
        this._justLaunched = true;
        const s = GameConfig.launch.launchSpeed;
        ship.velocity.set(this.dirX * s, 0, this.dirZ * s);
      }
      return;
    }

    if (this.phase === "launching") {
      const cfg = GameConfig.launch;
      // How far past the carrier center we are right now, along the launch axis.
      const projNow =
        (ship.position.x - this.originX) * this.dirX +
        (ship.position.z - this.originZ) * this.dirZ;

      // Full catapult kick for most of the run, then ease the speed down to the
      // ship's OWN cruise speed over the final `settleDistance` so control hands
      // off with no speed discontinuity. The old hard snap from launchSpeed to
      // maxSpeed at the bow was the "abrupt brake" (worst on the slow enemies,
      // 90 → 22); easing it removes that. The floor is the ship's maxSpeed (its
      // normal cruise), so the launch never drops below flight speed — no crawl.
      let s = cfg.launchSpeed;
      const settleStart = this.exitDistance - cfg.settleDistance;
      if (cfg.settleDistance > 0 && projNow > settleStart) {
        const u = clamp((projNow - settleStart) / cfg.settleDistance, 0, 1);
        const eased = u * u * (3 - 2 * u); // smoothstep: gentle onset + settle
        s = cfg.launchSpeed + (ship.maxSpeed - cfg.launchSpeed) * eased;
      }

      ship.velocity.set(this.dirX * s, 0, this.dirZ * s);
      ship.position.x += this.dirX * s * deltaSeconds;
      ship.position.z += this.dirZ * s * deltaSeconds;
      ship.root.position.copyFrom(ship.position);

      // Distance travelled past the carrier center, projected onto the launch axis.
      const proj =
        (ship.position.x - this.originX) * this.dirX +
        (ship.position.z - this.originZ) * this.dirZ;
      if (proj >= this.exitDistance) {
        // Already eased to ~maxSpeed; pin it exactly and hand back to control,
        // so the player and the slower AI fighters each leave at their own cruise.
        const ms = ship.maxSpeed;
        ship.velocity.set(this.dirX * ms, 0, this.dirZ * ms);
        this.phase = "complete";
      }
    }
  }
}
