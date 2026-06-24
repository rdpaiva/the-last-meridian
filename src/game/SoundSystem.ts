import { Sound } from "@babylonjs/core/Audio/sound";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { FireSoundKey } from "./types";
import type { Ship } from "./sim/Ship";
import type { Faction } from "./Faction";
import { GameConfig } from "./GameConfig";

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
 *
 * When `spatial: true`, each Sound is configured as a 3D source with a
 * linear distance model. Call `playAt(pos)` to set the world position
 * before triggering playback; the listener is the active camera.
 */
class PooledSound {
  private readonly sounds: Sound[] = [];
  private idx = 0;
  /** Base volume, reset on every play so a slot faded out by a caller (e.g.
   *  a jump cut short) isn't stuck silent when it's later round-robined. */
  private readonly volume: number;

  constructor(
    name: string,
    url: string,
    scene: Scene,
    poolSize: number,
    options: { volume: number; spatial?: boolean },
  ) {
    const cfg = GameConfig.sound;
    this.volume = options.volume;
    for (let i = 0; i < poolSize; i++) {
      this.sounds.push(
        new Sound(`${name}_${i}`, url, scene, null, {
          volume: options.volume,
          autoplay: false,
          ...(options.spatial && {
            spatialSound: true,
            distanceModel: "linear",
            maxDistance: cfg.maxDistance,
            refDistance: cfg.refDistance,
            rolloffFactor: 1,
          }),
        }),
      );
    }
  }

  play(): void {
    // Drop the shot while the audio engine is still locked: Babylon reacts
    // to a play() against a suspended context by showing the unmute icon
    // and discarding the one-shot anyway. Matters on the restart path,
    // where the game (and its launch SFX) starts before any user gesture.
    if (AbstractEngine.audioEngine?.unlocked === false) return;
    const s = this.sounds[this.idx];
    this.idx = (this.idx + 1) % this.sounds.length;
    // Sound.play() is a no-op if the buffer isn't ready yet — quiet by
    // design, no errors. First few rapid-fire shots after page load may
    // be silent while files stream in.
    if (s.isReady()) {
      s.setVolume(this.volume);
      s.play();
    }
  }

  /**
   * Set the 3D position of the next slot and play it (spatial sounds only).
   * Returns the Sound instance that was triggered (or null if not played), so
   * a caller can later stop THIS playback — e.g. cutting an enemy's jump-drive
   * clip when the ship dies mid-spool.
   */
  playAt(position: Vector3): Sound | null {
    if (AbstractEngine.audioEngine?.unlocked === false) return null; // see play()
    const s = this.sounds[this.idx];
    this.idx = (this.idx + 1) % this.sounds.length;
    if (s.isReady()) {
      s.setVolume(this.volume);
      s.setPosition(position);
      s.play();
      return s;
    }
    return null;
  }
}

/**
 * Centralized audio: one-shot SFX pools (lasers, hit, explosion, missile
 * launch, incoming-missile warning beep) plus 1 looping engine hum whose
 * volume is modulated by thrust.
 *
 * Browser autoplay policy requires a user gesture before audio plays. The
 * Engine has to be constructed with `audioEngine: true` (see Game.ts) so
 * Babylon initialises its audio system at all; then SoundSystem.unlock()
 * resumes the WebAudio context the first time the user touches input.
 *
 * All assets are CC0 from freesound.org — see public/sounds/SOURCES.md.
 */
export class SoundSystem {
  // Fire sounds come in OWN/SPATIAL pairs over the same asset (one cached
  // fetch). The own-fire pool is NON-spatial: the player is at the listener,
  // so their shots play full volume with no 3D source. A spatial Sound played
  // without a position would emit from the world origin — or from wherever an
  // AI ship last parked that pool slot — fading out (and panning away) as the
  // player flies from arena center. The spatial pool is for every other ship,
  // positioned per shot via playAt().
  private readonly playerLaser: PooledSound;
  private readonly playerGuns: PooledSound;
  private readonly playerGunsSpatial: PooledSound;
  private readonly missileLaunch: PooledSound;
  private readonly missileLaunchSpatial: PooledSound;
  private readonly missileWarning: PooledSound;
  private readonly enemyLaser: PooledSound;
  private readonly laserGun: PooledSound;
  private readonly laserGunOwn: PooledSound;
  // Carrier defense-turret cannon. Always spatial — every turret is mounted on
  // a (distant) mothership, never the player, so it only ever attenuates in
  // from the hull. cannon.mp3 is a heavier flak report than the fighter lasers.
  private readonly turretCannon: PooledSound;
  private readonly breakerLaserOwn: PooledSound;
  private readonly breakerLaserSpatial: PooledSound;
  private readonly hit: PooledSound;
  private readonly explosion: PooledSound;
  private readonly engineHum: Sound;
  // The PLAYER's own jump drive — a single sustained ~8s clip (6s build-up =
  // the spool/audible countdown, trigger hit at 6s = the teleport, 2s tail =
  // the departure whoosh through arrival). NOT pooled: it's one continuous
  // playback per spool, faded (not cut) on a cancel. Distinct from the RWR
  // whine other ships hear when they DETECT a spool (that's MissileWarning's
  // idiom, wired in the detection slice). See docs/JUMP-DRIVE-AND-RESUPPLY.md.
  //
  // Keyed by FACTION: each side has its own drive timbre (humans = the clean
  // FTL crack; machines/Novari Ascendancy = a pitched-down, wobbling variant —
  // jump-drive-novari.mp3). startJumpDrive picks off the spooling ship.faction.
  private readonly jumpDrive: Record<Faction, Sound>;
  private readonly jumpDriveVolume = 0.5;
  // OTHER ships' drives, heard spatially — you hear an enemy's drive winding up
  // (and the trigger hit when it goes), attenuating with distance. Same own/
  // spatial split as the fire sounds; this is the "a runner is charging"
  // telegraph (docs/JUMP-DRIVE-AND-RESUPPLY.md), NOT the missile RWR. Also
  // per-faction so a Novari runner sounds like a Novari runner from afar.
  private readonly jumpDriveSpatial: Record<Faction, PooledSound>;
  /**
   * The jump-drive clip currently playing for each spooling ship, so it can be
   * cut if the spool ends WITHOUT firing — a pilot cancel, or the ship being
   * destroyed mid-spool (otherwise the 8s clip, trigger "boom" and all, plays
   * out for a jump that never happened). Cleared on stop/release.
   */
  private readonly activeJumpDrives = new Map<Ship, Sound>();

  private engineCurrentIntensity = 0;
  private readonly engineMaxVolume = 0.45;
  private unlocked = false;
  private engineHumStarted = false;
  private muted = false;

  constructor(scene: Scene, baseUrl = `${import.meta.env.BASE_URL}sounds`) {
    this.playerLaser = new PooledSound(
      "sfx_player_laser",
      `${baseUrl}/player_laser.mp3`,
      scene,
      4,
      { volume: 0.35 },
    );
    this.playerGuns = new PooledSound(
      "sfx_player_guns",
      `${baseUrl}/guns.mp3`,
      scene,
      4,
      { volume: 0.35 },
    );
    this.playerGunsSpatial = new PooledSound(
      "sfx_player_guns_spatial",
      `${baseUrl}/guns.mp3`,
      scene,
      4,
      { volume: 0.3, spatial: true },
    );
    this.missileLaunch = new PooledSound(
      "sfx_missile_launch",
      `${baseUrl}/missile-launch.mp3`,
      scene,
      2,
      { volume: 0.5 },
    );
    this.missileLaunchSpatial = new PooledSound(
      "sfx_missile_launch_spatial",
      `${baseUrl}/missile-launch.mp3`,
      scene,
      3,
      { volume: 0.45, spatial: true },
    );
    // RWR beep for the incoming-missile warning (MissileWarning). NON-spatial:
    // it's the player's own cockpit warning, always full volume at the
    // listener. The asset should be a SHORT blip (≲0.3 s) — at the warning's
    // fastest tempo (missileWarning.beepIntervalCloseSec) each of the 4 pool
    // slots replays every ~0.45 s, so a longer file would cut itself off.
    this.missileWarning = new PooledSound(
      "sfx_missile_warning",
      `${baseUrl}/missile-warning.mp3`,
      scene,
      4,
      { volume: 0.4 },
    );
    this.enemyLaser = new PooledSound(
      "sfx_enemy_laser",
      `${baseUrl}/enemy_laser.mp3`,
      scene,
      4,
      { volume: 0.3, spatial: true },
    );
    this.laserGun = new PooledSound(
      "sfx_laser_gun",
      `${baseUrl}/laser-gun.mp3`,
      scene,
      4,
      { volume: 0.3, spatial: true },
    );
    this.laserGunOwn = new PooledSound(
      "sfx_laser_gun_own",
      `${baseUrl}/laser-gun.mp3`,
      scene,
      4,
      { volume: 0.35 },
    );
    this.turretCannon = new PooledSound(
      "sfx_turret_cannon",
      `${baseUrl}/cannon.mp3`,
      scene,
      4,
      { volume: 0.32, spatial: true },
    );
    this.breakerLaserOwn = new PooledSound(
      "sfx_breaker_laser_own",
      `${baseUrl}/breaker-laser-fire.mp3`,
      scene,
      4,
      { volume: 0.4 },
    );
    this.breakerLaserSpatial = new PooledSound(
      "sfx_breaker_laser_spatial",
      `${baseUrl}/breaker-laser-fire.mp3`,
      scene,
      4,
      { volume: 0.4, spatial: true },
    );
    this.hit = new PooledSound(
      "sfx_hit",
      `${baseUrl}/hit.mp3`,
      scene,
      4,
      { volume: 0.35, spatial: true },
    );
    this.explosion = new PooledSound(
      "sfx_explosion",
      `${baseUrl}/explosion.mp3`,
      scene,
      2,
      { volume: 0.6, spatial: true },
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

    // Per-faction jump-drive clips: humans get the clean FTL crack, machines
    // (Novari Ascendancy) get the pitched-down, wobbling variant.
    const jumpDriveUrls: Record<Faction, string> = {
      humans: `${baseUrl}/jump-drive.mp3`,
      machines: `${baseUrl}/jump-drive-novari.mp3`,
    };
    this.jumpDrive = {
      humans: new Sound("sfx_jump_drive_humans", jumpDriveUrls.humans, scene, null, {
        volume: this.jumpDriveVolume,
        loop: false,
        autoplay: false,
      }),
      machines: new Sound("sfx_jump_drive_machines", jumpDriveUrls.machines, scene, null, {
        volume: this.jumpDriveVolume,
        loop: false,
        autoplay: false,
      }),
    };
    this.jumpDriveSpatial = {
      humans: new PooledSound(
        "sfx_jump_drive_spatial_humans",
        jumpDriveUrls.humans,
        scene,
        3,
        { volume: 0.5, spatial: true },
      ),
      machines: new PooledSound(
        "sfx_jump_drive_spatial_machines",
        jumpDriveUrls.machines,
        scene,
        3,
        { volume: 0.5, spatial: true },
      ),
    };
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

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): void {
    this.muted = !this.muted;
    AbstractEngine.audioEngine?.setGlobalVolume(this.muted ? 0 : 1);
  }

  playPlayerLaser(): void {
    this.playerLaser.play();
  }
  playPlayerGuns(): void {
    this.playerGuns.play();
  }
  /**
   * Missile-launch whoosh. Pass `position` for AI launches (spatial pool,
   * attenuates with distance); omit it for the player's own launch (full
   * volume at the listener) — same own/spatial split as playFireSound.
   */
  playMissileLaunch(position?: Vector3): void {
    if (position) this.missileLaunchSpatial.playAt(position);
    else this.missileLaunch.play();
  }
  /**
   * One RWR warning blip — MissileWarning re-triggers this on its beep
   * cadence while an enemy missile is homing on the player (the tempo lives
   * there, not here).
   */
  playMissileWarning(): void {
    this.missileWarning.play();
  }
  playEnemyLaser(position: Vector3): void {
    this.enemyLaser.playAt(position);
  }
  playLaserGun(position: Vector3): void {
    this.laserGun.playAt(position);
  }
  /** Carrier defense-turret cannon report at a world position (spatial only). */
  playTurretFire(position: Vector3): void {
    this.turretCannon.playAt(position);
  }
  /**
   * Play the fire sound mapped to a ship's FireSoundKey.
   * Pass `position` for any ship that isn't the player — those play from the
   * spatial pool and attenuate with distance. Omit it for the player's own
   * fire, which plays from the non-spatial own-fire pool (always full volume
   * since the player is at the listener). The same key routes both ways
   * because a fire sound belongs to a ship TYPE, and any type can be flown
   * by the player or by an AI.
   */
  playFireSound(key: FireSoundKey, position?: Vector3): void {
    switch (key) {
      case "playerGuns":
        if (position) this.playerGunsSpatial.playAt(position);
        else this.playerGuns.play();
        break;
      case "enemyLaser":
        if (position) this.enemyLaser.playAt(position);
        break;
      case "laserGun":
        if (position) this.laserGun.playAt(position);
        else this.laserGunOwn.play();
        break;
      case "breakerLaser":
        if (position) this.breakerLaserSpatial.playAt(position);
        else this.breakerLaserOwn.play();
        break;
    }
  }
  /** Play the hit cue at a world position (attenuates with distance). */
  playHit(position: Vector3): void {
    this.hit.playAt(position);
  }
  /** Play the explosion cue at a world position (attenuates with distance). */
  playExplosion(position: Vector3): void {
    this.explosion.playAt(position);
  }

  /**
   * Begin a ship's jump-drive clip (arming a spool). `spatialPos` null = the
   * PLAYER's own drive (full volume at the listener); a position = any other
   * ship, heard spatially (attenuates with distance — the "runner charging"
   * telegraph, distinct from the missile RWR). The build-up IS the audible
   * countdown; left to ring through the trigger hit + 2s departure tail on a
   * completed jump. The playback is tracked by `ship` so it can be cut if the
   * spool ends without firing (stopJumpDrive).
   */
  startJumpDrive(ship: Ship, spatialPos: Vector3 | null): void {
    let sound: Sound | null = null;
    if (spatialPos === null) {
      const own = this.jumpDrive[ship.faction];
      if (AbstractEngine.audioEngine?.unlocked !== false && own.isReady()) {
        own.stop();
        own.setVolume(this.jumpDriveVolume);
        own.play();
        sound = own;
      }
    } else {
      sound = this.jumpDriveSpatial[ship.faction].playAt(spatialPos);
    }
    if (sound) this.activeJumpDrives.set(ship, sound);
  }

  /**
   * Cut a ship's jump-drive clip when the spool ends WITHOUT firing — a pilot
   * cancel or the ship destroyed mid-spool. A quick fade to silence (never a
   * hard cut). No-op if this ship has no drive playing.
   */
  stopJumpDrive(ship: Ship, fadeSeconds = 0.35): void {
    const sound = this.activeJumpDrives.get(ship);
    if (!sound) return;
    this.activeJumpDrives.delete(ship);
    if (sound.isReady()) {
      sound.setVolume(0, fadeSeconds);
      sound.stop(fadeSeconds);
    }
  }

  /**
   * Stop TRACKING a ship's drive on a COMPLETED jump, but let the clip ring out
   * (the trigger hit + departure tail are the point). Just drops the handle so
   * a later stopJumpDrive(ship) — e.g. when it dies at home — won't cut a tail.
   */
  releaseJumpDrive(ship: Ship): void {
    this.activeJumpDrives.delete(ship);
  }
}
