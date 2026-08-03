/**
 * IntroCinematic — the story intro, as a single full-screen video.
 *
 * Replaces the old image slideshow (drifting story art + narration-cued
 * captions, which in turn replaced a CSS text crawl): the whole intro is now
 * one self-hosted film, `public/videos/meridian-primer.mp4`, carrying its own
 * picture, score, and voiceover. main.ts owns the splash state machine and
 * calls play() on entering the intro state and stop() on leaving it; when the
 * film ends (or errors out), onFinished fires and main.ts advances the splash.
 *
 * WHY SELF-HOSTED, NOT A YOUTUBE EMBED. Same-origin <video> keeps the intro
 * ad-free and unbranded, plays with SOUND (the intro is always entered from a
 * user gesture — the step-1 Enter or the Replay Intro click — so the autoplay
 * policy is satisfied), and gives exact frame-accurate control of skip, end,
 * and teardown. A cross-origin iframe gives up all four.
 *
 * FAILURE IS NEVER A DEAD END. A missing/broken file, a decode error, or a
 * rejected play() all fall through to onFinished, so the splash advances
 * instead of stranding the player on black. A play() rejected for autoplay
 * reasons retries muted and offers a click-to-unmute — a silent film beats no
 * film, but only just, so the offer is loud.
 *
 * The rest is dress: a fade up from black on the first painted frame, a fade
 * to black at the end (the .intro-ended class, same as the slideshow used),
 * and a LOADING line while the video stalls for buffer.
 */

/** BASE_URL-relative path to the film. Single H.264/AAC mp4 — universally
 *  supported, so no webm twin (that would double the repo/deploy cost to
 *  serve exactly one of the two per visitor). */
const VIDEO_SRC = "videos/meridian-primer.mp4";

/** Fade to black at the end, before onFinished — matches the CSS transition
 *  on #intro-cinematic.intro-ended. */
const CLOSING_FADE_MS = 1400;

export class IntroCinematic {
  private readonly root: HTMLElement;
  private readonly onFinished: () => void;
  private readonly base = import.meta.env.BASE_URL;

  private video: HTMLVideoElement | null = null;
  private status: HTMLDivElement | null = null;
  private timers: number[] = [];
  private running = false;

  constructor(root: HTMLElement, onFinished: () => void) {
    this.root = root;
    this.onFinished = onFinished;
  }

  /** Build the player and roll. Idempotent with stop(): replaying always
   *  starts clean, from the first frame. */
  play(): void {
    this.stop();
    this.running = true;

    const video = document.createElement("video");
    video.id = "intro-video";
    video.src = `${this.base}${VIDEO_SRC}`;
    video.preload = "auto";
    video.playsInline = true; // iOS/iPadOS: play in the page, not fullscreen
    video.controls = false;
    this.video = video;

    const status = document.createElement("div");
    status.id = "intro-status";
    this.status = status;

    this.root.append(video, status);

    // Fade up on the first painted frame — never on a black or half-decoded
    // one (the root behind is black, so a slow start reads as a held beat).
    video.addEventListener("loadeddata", () => video.classList.add("visible"));
    // Buffer stalls get a quiet line rather than a mystery freeze.
    video.addEventListener("waiting", () => this.setStatus("LOADING…"));
    video.addEventListener("playing", () => this.setStatus(""));
    video.addEventListener("ended", () => this.finish());
    // A missing file / unsupported codec must not strand the splash on black.
    video.addEventListener("error", () => this.finish(0));

    this.start(video);
  }

  /** Tear down: cancel every pending beat, stop and release the video. Safe
   *  to call mid-play (Skip / Enter) or when nothing is running. */
  stop(): void {
    this.running = false;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];
    if (this.video) {
      this.video.pause();
      // Drop the source before discarding the element, or the browser can
      // keep buffering a film nobody is watching.
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.root.classList.remove("intro-ended");
    this.root.replaceChildren();
    this.video = null;
    this.status = null;
  }

  // ── Playback ───────────────────────────────────────────────────────────

  /** Roll, with the muted fallback. The intro is always entered from a user
   *  gesture so the sound path is the normal one; the fallback exists for the
   *  cases we don't control (an autoplay-blocking extension, a browser that
   *  scopes activation more tightly than we expect). */
  private start(video: HTMLVideoElement): void {
    video.play().catch(() => {
      if (!this.running) return;
      video.muted = true;
      video.play().then(
        () => this.offerUnmute(video),
        () => this.finish(0), // can't play at all — get out of the way
      );
    });
  }

  /** Muted fallback landed: a click anywhere on the film restores the sound. */
  private offerUnmute(video: HTMLVideoElement): void {
    this.setStatus("CLICK FOR SOUND");
    this.root.classList.add("intro-muted");
    const unmute = (): void => {
      video.muted = false;
      this.setStatus("");
      this.root.classList.remove("intro-muted");
    };
    this.root.addEventListener("click", unmute, { once: true });
  }

  private setStatus(text: string): void {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.toggle("visible", text !== "");
  }

  /** Close on black, then hand the splash back to main.ts. */
  private finish(fadeMs = CLOSING_FADE_MS): void {
    if (!this.running) return;
    this.setStatus("");
    this.root.classList.add("intro-ended");
    this.at(fadeMs, () => {
      if (this.running) this.onFinished();
    });
  }

  private at(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }
}
