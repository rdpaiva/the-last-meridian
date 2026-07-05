import { GameConfig } from "@space-duel/shared";
import { clamp, exponentialMultiplier, lerp } from "@space-duel/shared";
import type { Missile } from "@space-duel/shared";
import type { MissileSystem } from "@space-duel/shared";
import type { Ship } from "@space-duel/shared";
import type { Hud } from "./Hud";
import type { SoundSystem } from "./SoundSystem";

/**
 * Incoming-missile warning — the player's RWR (radar warning receiver).
 *
 * Trigger condition: ANY live enemy missile currently HOMING on the player's
 * ship (per-frame poll of the enemy faction's MissileSystem). A round that
 * goes ballistic — lost its lock, or its target (you) died — stops warning;
 * a ballistic round that REACQUIRES you starts warning. The counterplay
 * already exists (out-turn it: missile turnRate < the fighters' rotation
 * speeds; drag it into an asteroid: rocks eat missiles; break the track in a
 * nebula: the AI only launches on a fresh track) — this system's whole job
 * is making that counterplay LEGIBLE so dodges can be timed.
 *
 * Three channels, deliberately synced to ONE rhythm (knobs in
 * GameConfig.missileWarning):
 *   1. Warning tone — a repeating beep whose interval lerps from
 *      beepIntervalFarSec to beepIntervalCloseSec as the NEAREST tracking
 *      missile closes (RWR-style: proximity through rhythm, zero eye
 *      movement needed).
 *   2. HUD border pulse + INCOMING label — each beep re-triggers a red
 *      viewport-edge pulse to pulsePeakAlpha, which then decays at
 *      pulseDecayRate; because the trigger IS the beep, the visual rhythm
 *      ramps with the audio for free, and a sustained track reads as a
 *      sustained pulse train — unmistakable next to the one-shot damage
 *      flash. (Hud.setMissileWarning owns the DOM writes.)
 *   3. Radar blips — the threat list is exposed via `threats` and drawn by
 *      Radar as amber missile blips (the "from where?" follow-up cue).
 *
 * Update placement (see Game.tick): runs in the always-section WITH the
 * other presentation systems, not the sim block — audio/HUD continue
 * through hitstop by design (the threat picture is simply static while the
 * sim is frozen). Game gates it to state === "playing" + player alive by
 * passing player = null otherwise, which silences the warning on the end
 * screens and through death/launch gaps.
 */
export class MissileWarning {
  /** Live enemy missiles homing on the player, rebuilt in place each update. */
  private readonly threatList: Missile[] = [];
  /** Wall-clock time the next beep fires (valid while a threat is live). */
  private nextBeepAtMs = 0;
  /** Current border-pulse opacity — peaks on each beep, decays between. */
  private pulseAlpha = 0;
  /** Whether last update had a live threat (edge-detects threat onset). */
  private wasActive = false;

  constructor(
    private readonly sound: SoundSystem,
    private readonly hud: Hud,
  ) {}

  /** The current threat picture — Radar draws these as missile blips. */
  get threats(): ReadonlyArray<Missile> {
    return this.threatList;
  }

  /**
   * Poll the threat picture and drive all three warning channels. Pass
   * `player = null` to force the warning inactive (match not live / player
   * dead) — the pulse decays out instead of snapping, so a kill or match end
   * fades the border rather than popping it off.
   */
  update(
    deltaSeconds: number,
    nowMs: number,
    enemyMissiles: MissileSystem,
    player: Ship | null,
  ): void {
    const cfg = GameConfig.missileWarning;

    this.threatList.length = 0;
    if (player && player.isAlive) {
      enemyMissiles.collectHomingOn(player, this.threatList);
    }

    if (this.threatList.length === 0 || player === null) {
      // No live threat: decay any remaining pulse out and go quiet.
      this.wasActive = false;
      if (this.pulseAlpha > 0) {
        this.pulseAlpha *= exponentialMultiplier(cfg.pulseDecayRate, deltaSeconds);
        if (this.pulseAlpha < 0.01) this.pulseAlpha = 0;
      }
      this.hud.setMissileWarning(false, this.pulseAlpha);
      return;
    }

    // Tempo from the NEAREST tracking missile: closeness 0 at/beyond
    // rampStartDistance → 1 at/inside rampEndDistance.
    let nearest = Infinity;
    for (const missile of this.threatList) {
      const dx = missile.position.x - player.position.x;
      const dz = missile.position.z - player.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < nearest) nearest = dist;
    }
    const closeness = clamp(
      (cfg.rampStartDistance - nearest) /
        (cfg.rampStartDistance - cfg.rampEndDistance),
      0,
      1,
    );
    const intervalMs =
      lerp(cfg.beepIntervalFarSec, cfg.beepIntervalCloseSec, closeness) * 1000;

    if (!this.wasActive) {
      // Threat onset: beep NOW — the first cue is the launch cue.
      this.wasActive = true;
      this.nextBeepAtMs = nowMs;
    } else {
      // A beep scheduled at a far-away tempo shouldn't sit stale while the
      // missile closes: pull the pending beep in whenever the CURRENT tempo
      // would fire sooner. (Never pushes a beep out — tempo only tightens.)
      this.nextBeepAtMs = Math.min(this.nextBeepAtMs, nowMs + intervalMs);
    }

    if (nowMs >= this.nextBeepAtMs) {
      this.sound.playMissileWarning();
      this.pulseAlpha = cfg.pulsePeakAlpha;
      this.nextBeepAtMs = nowMs + intervalMs;
    } else {
      this.pulseAlpha *= exponentialMultiplier(cfg.pulseDecayRate, deltaSeconds);
    }
    this.hud.setMissileWarning(true, this.pulseAlpha);
  }
}
