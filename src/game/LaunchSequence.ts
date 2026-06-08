import { GameConfig } from "./GameConfig";
import type { Ship } from "./Ship";

type Phase = "intro" | "countdown" | "launching" | "complete";

/**
 * BSG-style catapult launch sequence.
 *
 * Phases:
 *   intro      — ship frozen; camera held at maxZoom so the player can see
 *                the whole mothership. No overlay text. Duration controlled
 *                by GameConfig.launch.introDuration.
 *   countdown  — "3 / 2 / 1 / LAUNCH!" overlay ticks down while the camera
 *                smoothly zooms in from maxZoom to normal framing. Ship still
 *                frozen; input suppressed.
 *   launching  — catapult fires; ship position driven directly at
 *                launchSpeed. No input accepted.
 *   complete   — ship has cleared the bow; Game.ts re-enables normal control.
 */
export class LaunchSequence {
  private phase: Phase;
  private elapsedSec = 0;
  private _justLaunched = false;
  /** When skipping the intro, fire the catapult kick on the first update. */
  private kickPending = false;

  constructor(
    /** World-space Z the ship must pass to mark the sequence complete. */
    private readonly exitZ: number,
    /**
     * Skip the wide establishing shot + 3-2-1 countdown and catapult
     * immediately at normal zoom. Used on respawn so the player doesn't sit
     * through the full cinematic every death (the initial spawn keeps it).
     */
    skipIntro = false,
  ) {
    this.phase = skipIntro ? "launching" : "intro";
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
   * Returns null during the intro phase and once the launching phase begins.
   */
  get overlayText(): string | null {
    if (this.phase !== "countdown") return null;
    const cfg = GameConfig.launch;
    // Time elapsed since the countdown started (after the intro hold).
    const t = this.elapsedSec - cfg.introDuration;
    const step = cfg.countdownStepSec;
    if (t < step) return "3";
    if (t < step * 2) return "2";
    if (t < step * 3) return "1";
    return "LAUNCH!";
  }

  /**
   * Desired camera zoom for this frame. Game.ts calls cameraRig.setZoom()
   * with this value each tick while the sequence is active.
   *
   * Returns introZoom (full mothership visible) during intro, then
   * smoothstep-lerps down to 1.0 over the 3-digit countdown, and holds
   * at 1.0 from LAUNCH! onward.
   */
  get desiredZoom(): number {
    const cfg = GameConfig.launch;
    const introZoom = cfg.introZoom;

    if (this.phase === "intro") return introZoom;

    if (this.phase === "countdown") {
      const countdownDur = cfg.countdownStepSec * 3;
      const t = Math.min((this.elapsedSec - cfg.introDuration) / countdownDur, 1);
      // Smoothstep easing: slow start and end, fast middle — feels cinematic.
      const eased = t * t * (3 - 2 * t);
      return introZoom + (1.0 - introZoom) * eased;
    }

    return 1.0; // launching or complete
  }

  // ─── Tick ─────────────────────────────────────────────────────────────────

  /**
   * Called every simulation frame (skipped during hitstop, same as the rest
   * of the sim). Drives the ship directly while in the launching phase.
   */
  update(deltaSeconds: number, ship: Ship): void {
    this._justLaunched = false;

    if (this.phase === "complete") return;

    // Skip-intro respawn: deliver the catapult kick once, on the first frame.
    if (this.kickPending) {
      this.kickPending = false;
      this._justLaunched = true;
      ship.velocity.set(0, 0, GameConfig.launch.launchSpeed);
    }

    this.elapsedSec += deltaSeconds;

    if (this.phase === "intro") {
      if (this.elapsedSec >= GameConfig.launch.introDuration) {
        this.phase = "countdown";
      }
      // Ship stays frozen — Game.ts suppresses player input during inLaunch.
      return;
    }

    if (this.phase === "countdown") {
      const cfg = GameConfig.launch;
      const launchTime =
        cfg.introDuration +
        cfg.countdownStepSec * 3 +
        cfg.launchTextSec;
      if (this.elapsedSec >= launchTime) {
        this.phase = "launching";
        this._justLaunched = true;
        ship.velocity.set(0, 0, cfg.launchSpeed);
      }
      return;
    }

    if (this.phase === "launching") {
      // Override physics: maintain constant catapult speed.
      ship.velocity.set(0, 0, GameConfig.launch.launchSpeed);
      ship.position.z += GameConfig.launch.launchSpeed * deltaSeconds;
      ship.root.position.copyFrom(ship.position);

      if (ship.position.z >= this.exitZ) {
        // Hand off to normal control. Clamp to maxSpeed so the first
        // player-controlled frame isn't in an over-speed state.
        ship.velocity.set(0, 0, GameConfig.player.maxSpeed);
        this.phase = "complete";
      }
    }
  }
}
