import { Sound } from "@babylonjs/core/Audio/sound";
import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";

// Side-effect imports — same audio engine wiring as SoundSystem.
import "@babylonjs/core/Audio/audioEngine";
import "@babylonjs/core/Audio/audioSceneComponent";

import { GameConfig } from "@space-duel/shared";

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
 * Locked-context caveat: Babylon only re-queues a play() blocked by a
 * suspended AudioContext when the sound is loop/autoplay — for plain
 * one-shot sounds like our tracks it shows the unmute icon and DROPS the
 * play() permanently. So if the engine isn't unlocked yet we queue the
 * play ourselves on onAudioUnlockedObservable. (Game.start() also unlocks
 * the context inside the Start-click gesture, so normally we never hit
 * the locked path at all.)
 */
export class MusicSystem {
  private readonly scene: Scene;
  private readonly baseUrl: string;

  private currentTrack: Sound | null = null;
  private activePlaylist: string[] = [];
  private shuffledQueue: string[] = [];
  private queueIndex = 0;
  /** sessionStorage key for the active playlist's saved shuffle + position. */
  private stateKey = "";

  constructor(scene: Scene, baseUrl = `${import.meta.env.BASE_URL}music`) {
    this.scene = scene;
    this.baseUrl = baseUrl;
  }

  /**
   * Start playing the given playlist. Stops any currently playing track first.
   * Pass an empty array (or call stop()) to silence music.
   *
   * Playlist progress (the shuffled order and our position in it) is persisted
   * to sessionStorage and resumed here, so an end-of-match restart — which is a
   * full page reload (see Game.onKeyDown / RESTART_FLAG) — continues to the NEXT
   * track instead of reshuffling from scratch every match. Without this, matches
   * shorter than a track (the common case) would only ever play track openings,
   * which reads as "the same song over and over." A fresh tab (sessionStorage
   * empty) starts a new random shuffle.
   */
  playPlaylist(type: "game" | "menu"): void {
    const tracks =
      type === "game"
        ? GameConfig.music.gamePlaylist
        : GameConfig.music.menuPlaylist;

    this.stop();
    if (tracks.length === 0) return;

    this.activePlaylist = tracks;
    this.stateKey = `space-duel-music-${type}`;

    const resumed = this.loadSavedState(tracks);
    if (resumed) {
      this.shuffledQueue = resumed.queue;
      this.queueIndex = resumed.index;
    } else {
      this.shuffledQueue = this.shuffle([...tracks]);
      this.queueIndex = 0;
    }
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
    // Persist now (queueIndex points at the NEXT track), so a restart reload
    // resumes on the track after this one rather than replaying it.
    this.saveState();

    const track = new Sound(
      `music_track`,
      url,
      this.scene,
      () => {
        // Ready callback: audio buffer decoded, safe to play. If the audio
        // engine is still locked, defer the play to the unlock event —
        // Babylon would otherwise discard a locked play() for a
        // non-loop/non-autoplay sound (see class doc).
        const ae = AbstractEngine.audioEngine;
        if (ae && !ae.unlocked) {
          ae.onAudioUnlockedObservable.addOnce(() => {
            // Skip if this track was stop()ed/disposed while locked.
            if (this.currentTrack === track) track.play();
          });
        } else {
          track.play();
        }
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

  /** Persist the current shuffled order + position for the active playlist. */
  private saveState(): void {
    if (!this.stateKey) return;
    try {
      sessionStorage.setItem(
        this.stateKey,
        JSON.stringify({ queue: this.shuffledQueue, index: this.queueIndex }),
      );
    } catch {
      // sessionStorage can throw (private mode, quota); music continues fine
      // without persistence — we just fall back to a fresh shuffle next load.
    }
  }

  /**
   * Restore a saved shuffle + position, but only if it's still valid for the
   * current playlist (same set of tracks — a config change invalidates it).
   * Returns null when there's nothing usable saved, so the caller reshuffles.
   */
  private loadSavedState(
    tracks: string[],
  ): { queue: string[]; index: number } | null {
    try {
      const raw = sessionStorage.getItem(this.stateKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { queue: string[]; index: number };
      if (!Array.isArray(parsed.queue) || typeof parsed.index !== "number") {
        return null;
      }
      // The saved queue must be a permutation of the current playlist.
      const sameSet =
        parsed.queue.length === tracks.length &&
        [...parsed.queue].sort().join(" ") ===
          [...tracks].sort().join(" ");
      if (!sameSet) return null;
      // Clamp the index so a malformed/stale value can't break playNext.
      const index = Math.max(0, Math.min(parsed.index, parsed.queue.length));
      return { queue: parsed.queue, index };
    } catch {
      return null;
    }
  }
}
