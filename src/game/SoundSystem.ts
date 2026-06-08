import { Sound } from "@babylonjs/core/Audio/sound";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";

// Side-effect imports.
//   audioEngine         — registers AbstractEngine.AudioEngineFactory so
//                         the Engine constructor can create the audio
//                         engine (combined with `audioEngine: true` in the
//                         Engine options).
//   audioSceneComponent — wires audio updates into the scene tick loop.
import "@babylonjs/core/Audio/audioEngine";
import "@babylonjs/core/Audio/audioSceneComponent";

/**
 * Small pool of N independent Sound instances that share a URL. Loading
 * the same URL N times is cheap because the browser caches the response —
 * each Sound parses its own copy of the buffer (a few KB) but the network
 * fetch happens once.
 *
 * We use independent instances rather than Sound.clone() because clone()
 * has historically returned null in some setups when called too early,
 * and is generally fussier. Independent instances are bulletproof.
 *
 * To play, we round-robin through the pool — that way rapid fire (180ms
 * cooldown) plays cleanly even if each sound is 700ms long.
 */
class PooledSound {
  private readonly sounds: Sound[] = [];
  private idx = 0;

  constructor(
    name: string,
    url: string,
    scene: Scene,
    poolSize: number,
    options: { volume: number },
  ) {
    for (let i = 0; i < poolSize; i++) {
      this.sounds.push(
        new Sound(`${name}_${i}`, url, scene, null, {
          volume: options.volume,
          autoplay: false,
        }),
      );
    }
  }

  play(): void {
    const s = this.sounds[this.idx];
    this.idx = (this.idx + 1) % this.sounds.length;
    // Sound.play() is a no-op if the buffer isn't ready yet — quiet by
    // design, no errors. First few rapid-fire shots after page load may
    // be silent while files stream in.
    if (s.isReady()) s.play();
  }
}

/**
 * Centralized audio: 5 one-shot sounds (player laser, enemy laser, hit,
 * explosion, missile launch) plus 1 looping engine hum whose volume is
 * modulated by thrust.
 *
 * Browser autoplay policy requires a user gesture before audio plays. The
 * Engine has to be constructed with `audioEngine: true` (see Game.ts) so
 * Babylon initialises its audio system at all; then SoundSystem.unlock()
 * resumes the WebAudio context the first time the user touches input.
 *
 * All assets are CC0 from freesound.org — see public/sounds/SOURCES.md.
 */
export class SoundSystem {
  private readonly playerLaser: PooledSound;
  private readonly playerGuns: PooledSound;
  private readonly missileLaunch: PooledSound;
  private readonly enemyLaser: PooledSound;
  private readonly hit: PooledSound;
  private readonly explosion: PooledSound;
  private readonly engineHum: Sound;

  private engineCurrentIntensity = 0;
  private readonly engineMaxVolume = 0.45;
  private unlocked = false;
  private engineHumStarted = false;

  constructor(scene: Scene, baseUrl = "/sounds") {
    this.playerLaser = new PooledSound(
      "sfx_player_laser",
      `${baseUrl}/player_laser.mp3`,
      scene,
      4,
      { volume: 0.35 },
    );
    this.playerGuns = new PooledSound(
      "sfx_player_guns",
      `${baseUrl}/guns.wav`,
      scene,
      4,
      { volume: 0.35 },
    );
    this.missileLaunch = new PooledSound(
      "sfx_missile_launch",
      `${baseUrl}/missile-launch.wav`,
      scene,
      2,
      { volume: 0.5 },
    );
    this.enemyLaser = new PooledSound(
      "sfx_enemy_laser",
      `${baseUrl}/enemy_laser.mp3`,
      scene,
      4,
      { volume: 0.3 },
    );
    this.hit = new PooledSound(
      "sfx_hit",
      `${baseUrl}/hit.mp3`,
      scene,
      4,
      { volume: 0.35 },
    );
    this.explosion = new PooledSound(
      "sfx_explosion",
      `${baseUrl}/explosion.mp3`,
      scene,
      2,
      { volume: 0.6 },
    );

    this.engineHum = new Sound(
      "sfx_engine_hum",
      `${baseUrl}/engine.mp3`,
      scene,
      null,
      {
        volume: 0,
        loop: true,
        autoplay: false,
      },
    );
  }

  /**
   * Resume the WebAudio context and clear the "locked" flag. Idempotent
   * once it actually fires — safe to call every frame until then.
   *
   * Three layers of unlock because browsers vary:
   *   1. Babylon's audioEngine.unlock() — does the right thing on most.
   *   2. audioContext.resume() — direct WebAudio API, needed on some.
   *   3. We refuse to flip the `unlocked` flag until the audioContext is
   *      actually running, so this method keeps retrying every frame
   *      until the unlock takes.
   */
  unlock(): void {
    if (this.unlocked) return;
    const ae = AbstractEngine.audioEngine;
    if (!ae) {
      // Babylon audio engine never initialised — fix the Engine option
      // (audioEngine: true) and retry. Bail without flipping the flag so
      // the next frame tries again, which will succeed once the fix lands.
      return;
    }
    ae.unlock();
    const ctx = ae.audioContext;
    if (ctx && ctx.state === "suspended") {
      // Direct resume — some browsers need this even after audioEngine.unlock.
      void ctx.resume();
    }
    if (ctx && ctx.state === "running") {
      this.unlocked = true;
      // eslint-disable-next-line no-console
      console.info("[SoundSystem] audio unlocked");
    }
    // If not yet running, leave unlocked=false so we retry next frame.
  }

  /**
   * Drive the engine hum's volume from a 0..1 intensity (typically taken
   * from EngineGlow.currentIntensity so the audio matches the visuals).
   * Also kicks off the looping playback on first frame after unlock.
   */
  updateEngine(deltaSeconds: number, thrustIntensity: number): void {
    const target = 0.18 + thrustIntensity * 0.55;
    const t = 1 - Math.exp(-6 * deltaSeconds);
    this.engineCurrentIntensity +=
      (target - this.engineCurrentIntensity) * t;

    if (this.engineHum.isReady()) {
      this.engineHum.setVolume(
        this.engineCurrentIntensity * this.engineMaxVolume,
      );

      if (this.unlocked && !this.engineHumStarted) {
        this.engineHum.play();
        this.engineHumStarted = true;
        // eslint-disable-next-line no-console
        console.info("[SoundSystem] engine hum started");
      }
    }
  }

  playPlayerLaser(): void {
    this.playerLaser.play();
  }
  playPlayerGuns(): void {
    this.playerGuns.play();
  }
  playMissileLaunch(): void {
    this.missileLaunch.play();
  }
  playEnemyLaser(): void {
    this.enemyLaser.play();
  }
  playHit(): void {
    this.hit.play();
  }
  playExplosion(): void {
    this.explosion.play();
  }
}
