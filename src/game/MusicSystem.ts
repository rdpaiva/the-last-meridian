import { Sound } from "@babylonjs/core/Audio/sound";
import type { Scene } from "@babylonjs/core/scene";

// Side-effect imports — same audio engine wiring as SoundSystem.
import "@babylonjs/core/Audio/audioEngine";
import "@babylonjs/core/Audio/audioSceneComponent";

import { GameConfig } from "./GameConfig";

/**
 * Background music player with shuffled playlist cycling.
 *
 * Two named playlists live in GameConfig.music: `game` (in-combat tracks)
 * and `menu` (for a future main-menu screen). Call playPlaylist('game') or
 * playPlaylist('menu') to switch context; the system shuffles the relevant
 * track list and cycles through it indefinitely, reshuffling after each
 * full pass so the same track never leads two cycles in a row (when there
 * are more than one tracks).
 *
 * Playback is deferred until the WebAudio context is running — Babylon
 * internally queues the play() call and fires it once the context resumes
 * after the first user gesture, so no explicit unlock coordination with
 * SoundSystem is needed.
 */
export class MusicSystem {
  private readonly scene: Scene;
  private readonly baseUrl: string;

  private currentTrack: Sound | null = null;
  private activePlaylist: string[] = [];
  private shuffledQueue: string[] = [];
  private queueIndex = 0;

  constructor(scene: Scene, baseUrl = `${import.meta.env.BASE_URL}music`) {
    this.scene = scene;
    this.baseUrl = baseUrl;
  }

  /**
   * Shuffle the given playlist and start playing from the beginning.
   * Stops any currently playing track first.
   * Pass an empty array (or call stop()) to silence music.
   */
  playPlaylist(type: "game" | "menu"): void {
    const tracks =
      type === "game"
        ? GameConfig.music.gamePlaylist
        : GameConfig.music.menuPlaylist;

    this.stop();
    if (tracks.length === 0) return;

    this.activePlaylist = tracks;
    this.shuffledQueue = this.shuffle([...tracks]);
    this.queueIndex = 0;
    this.playNext();
  }

  stop(): void {
    if (this.currentTrack) {
      this.currentTrack.stop();
      this.currentTrack.dispose();
      this.currentTrack = null;
    }
  }

  private playNext(): void {
    // Finished a full pass — reshuffle so the order is fresh next cycle.
    // When there's only one track, skip the shuffle (nothing to reorder).
    if (this.queueIndex >= this.shuffledQueue.length) {
      if (this.activePlaylist.length > 1) {
        this.shuffledQueue = this.shuffleAvoidingLeader(
          [...this.activePlaylist],
          this.shuffledQueue[this.shuffledQueue.length - 1],
        );
      }
      this.queueIndex = 0;
    }

    const filename = this.shuffledQueue[this.queueIndex++];
    const url = `${this.baseUrl}/${encodeURIComponent(filename)}`;

    const track = new Sound(
      `music_track`,
      url,
      this.scene,
      () => {
        // Ready callback: audio buffer decoded, safe to play. Babylon queues
        // this internally if the WebAudio context is still suspended and fires
        // it automatically on the first user-gesture unlock.
        track.play();
      },
      {
        volume: GameConfig.music.volume,
        loop: false,
        autoplay: false,
      },
    );

    track.onEndedObservable.add(() => {
      track.dispose();
      if (this.currentTrack === track) this.currentTrack = null;
      this.playNext();
    });

    this.currentTrack = track;
  }

  /** Fisher-Yates shuffle. */
  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Shuffle but ensure the first element isn't `lastPlayed`, so the same
   * track never leads two cycles back-to-back.
   */
  private shuffleAvoidingLeader<T>(arr: T[], lastPlayed: T): T[] {
    const shuffled = this.shuffle(arr);
    if (shuffled.length > 1 && shuffled[0] === lastPlayed) {
      // Swap the leader with any other position.
      const swapIdx = 1 + Math.floor(Math.random() * (shuffled.length - 1));
      [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
    }
    return shuffled;
  }
}
