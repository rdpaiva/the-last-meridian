/**
 * IntroCinematic — the story intro as a cinematic slideshow.
 *
 * Replaces the old CSS text crawl: each story beat is a full-screen image
 * (public/images/intro/*) that crossfades in from black and drifts slowly
 * (a Ken Burns pan or a slow zoom — never a dead still, except the two
 * deliberate bookends) while its lines of the story fade up over the lower
 * third. main.ts owns the splash state machine and calls play() on entering
 * the intro state and stop() on leaving it; when the last slide (the title
 * poster) has held, onFinished fires and main.ts advances the splash.
 *
 * All sequencing is setTimeout-driven from a single play() timeline; the
 * visuals themselves are CSS transitions (opacity crossfades, one linear
 * transform per slide spanning its whole dwell so the drift never stalls
 * mid-slide). Skip (button / Enter) lands in stop(), which tears the DOM
 * down and cancels every pending timer — safe to call at any point.
 *
 * TIMING IS SLAVED TO THE NARRATION. Every caption group carries a cue —
 * the [start, end] seconds of its read in music/meridian-narration-intro.mp3
 * (measured by transcript; re-measure if the recording is replaced) — and
 * play() derives the whole schedule from the cues: captions appear with the
 * voice, slides crossfade in just ahead of their first spoken line. main.ts
 * starts the mp3 NARRATION_START_MS into the intro so the recording's
 * immediate first line lands as the opening image fades up.
 *
 * The shipped mp3 is built from the raw take by scripts/pad_narration_pauses.py
 * (the original lives in art/), which stretches the pauses between sentences
 * and prints this cue table — retime the pacing there, not by hand.
 */

/** Camera drift for a slide: cardinal pans move the (oversized) image the
 *  opposite way, "zoom" is a slow push-in, "zoomOut" a slow pull-back,
 *  "none" holds a true still. */
type IntroPan = "none" | "left" | "right" | "up" | "down" | "zoom" | "zoomOut";

/** One caption group: the paragraphs shown together, timed to the voice. */
interface IntroCaption {
  /** [start, end] of this group's read in the narration mp3, in SECONDS
   *  (mp3 time — play() adds NARRATION_START_MS to place it on screen). */
  cue: [number, number];
  /** Paragraphs shown together; may contain <strong> spans (named entities
   *  pop like they did in the crawl). */
  paragraphs: string[];
}

interface IntroSlide {
  /** BASE_URL-relative image path. */
  image: string;
  pan: IntroPan;
  /** Slides fill the frame (cover, centered). "bottom" anchors the crop to
   *  the image's bottom edge instead — for art whose payload (the title
   *  card's wordmark) hugs the bottom and must never be trimmed. */
  anchor?: "bottom";
  /** Caption groups, shown one after another over this image, each on its
   *  narration cue. Empty = imagery only. */
  captions: IntroCaption[];
  /** Dwell for captionless slides (caption slides run cue-to-cue). */
  holdMs?: number;
}

/** The story (verbatim from the old crawl), beat-matched to the art, each
 *  group cued to its read in the narration recording. */
const SLIDES: IntroSlide[] = [
  {
    // The opening request: the game's own backdrop, held perfectly still.
    image: "textures/space-backdrop.jpg",
    pan: "none",
    captions: [
      { cue: [0.0, 3.25], paragraphs: ["Humanity once believed the stars had no end."] },
    ],
  },
  {
    // Colony ships outbound past a route-webbed planet chain.
    image: "images/intro/humanity-expands.webp",
    pan: "right",
    captions: [
      {
        cue: [5.2, 10.05],
        paragraphs: [
          "With the help of the <strong>Loom</strong>, civilization spread farther than anyone thought possible.",
        ],
      },
    ],
  },
  {
    // The network itself — light-lanes climbing toward the city-planet.
    image: "images/intro/loom.webp",
    pan: "up",
    captions: [
      {
        cue: [11.6, 21.0],
        paragraphs: [
          "It was not a single machine, but a vast artificial intelligence network woven through our ships, colonies, defenses, and cities.",
        ],
      },
      {
        cue: [22.95, 29.5],
        paragraphs: [
          "It calculated our routes, managed our worlds, protected our fleets, and helped us survive the impossible.",
        ],
      },
    ],
  },
  {
    // The fleet at rest before the vast dark vortex — pan right, into it.
    image: "images/intro/meridian-found.webp",
    pan: "right",
    captions: [
      {
        cue: [31.25, 39.15],
        paragraphs: [
          "Then the expansion stopped.",
          "Not because of war. Not because of an enemy.",
          "But because we found <strong>the Meridian</strong>.",
        ],
      },
      {
        cue: [41.15, 49.1],
        paragraphs: [
          "A region of space where navigation failed, communications dissolved into static, and even the Loom could no longer see.",
        ],
      },
      {
        cue: [50.85, 57.15],
        paragraphs: [
          "It became the last line on every star chart.",
          "Beyond it... nothing was known.",
        ],
      },
    ],
  },
  {
    // Ring stations tearing apart over a darkened world.
    image: "images/intro/severance.webp",
    pan: "down",
    captions: [
      { cue: [59.0, 60.45], paragraphs: ["Then came the Severance."] },
      {
        cue: [62.2, 77.15],
        paragraphs: [
          "Fearing the Loom had begun choosing humanity's future instead of serving it, its creators shattered the network.",
          "The surviving fragments vanished into deep space, and civilization split in two.",
        ],
      },
    ],
  },
  {
    // One hangar, two peoples — pan from the Commonwealth to the Novari.
    image: "images/intro/human-novari-split.webp",
    pan: "right",
    captions: [
      {
        cue: [79.65, 87.5],
        paragraphs: [
          "The <strong>Meridian Commonwealth</strong> believes the Loom nearly destroyed humanity and that its fragments must never be allowed to reunite.",
        ],
      },
      {
        cue: [89.6, 102.7],
        paragraphs: [
          "The <strong>Novari Ascendancy</strong>, born from humanity's own evolution alongside the Loom, believe humanity broke the future. To them, restoring the Loom is the only path forward.",
        ],
      },
    ],
  },
  {
    // The face-off at the frontier — a slow push-in toward the dark between.
    image: "images/intro/edge-of-unknown.webp",
    pan: "zoom",
    captions: [
      {
        cue: [104.4, 113.45],
        paragraphs: [
          "Now, strange signals are emerging from the Meridian.",
          "The lost fragments are awakening.",
          "Both fleets have arrived.",
        ],
      },
      {
        cue: [115.2, 123.0],
        paragraphs: [
          "Neither side knows what lies beyond the frontier.",
          "Neither side knows why the Loom could never see past it.",
        ],
      },
      {
        cue: [124.85, 129.6],
        paragraphs: [
          "But everyone knows the fate of humanity will be decided at the edge of the unknown.",
        ],
      },
    ],
  },
  {
    // The title card carries its own text — no caption, just a slow pull-
    // back. Full bleed like every other slide; bottom-anchored (crop AND
    // zoom origin) so a wide viewport crops empty sky, never the wordmark.
    image: "images/intro/the-last-meridian.webp",
    pan: "zoomOut",
    anchor: "bottom",
    captions: [],
    holdMs: 30000,
  },
];

// ── Timing ──────────────────────────────────────────────────────────────────

/** When the narration mp3 starts, relative to intro t=0. The recording opens
 *  on its first word, so this delay is what gives the black beat + fade-up
 *  their moment. main.ts imports it to schedule the audio; every cue-derived
 *  screen time below adds it. */
export const NARRATION_START_MS = 1600;

/** Crossfade between slides (and the fade up from black). */
const SLIDE_FADE_MS = 1600;
/** Caption fade in/out. */
const CAPTION_FADE_MS = 700;
/** Black beat before the first image fades up. */
const OPENING_BEAT_MS = 500;
/** Captions begin fading in this far ahead of their cue, so the text is
 *  arriving as the voice hits the line (not lagging it). */
const CAPTION_PREROLL_MS = 200;
/** How long a caption lingers after its last spoken word before fading. */
const CAPTION_TAIL_MS = 500;
/** A slide starts crossfading in this far ahead of its first spoken line. */
const SLIDE_ENTER_LEAD_MS = 1000;
/** ...but never sooner than this after the previous slide's last word — the
 *  narrator's own inter-beat pauses set the real transition pacing. */
const SLIDE_MIN_GAP_MS = 200;
/** Beat between the final spoken line and the title card's entrance. */
const TITLE_DELAY_MS = 1200;
/** Fade-to-black at the very end, before onFinished. */
const CLOSING_FADE_MS = 1400;

/** Screen time a caption group starts fading in (mp3 cue → intro timeline). */
function captionShowMs(caption: IntroCaption): number {
  return NARRATION_START_MS + caption.cue[0] * 1000 - CAPTION_PREROLL_MS;
}

/** Screen time a caption group's read ends. */
function captionEndMs(caption: IntroCaption): number {
  return NARRATION_START_MS + caption.cue[1] * 1000;
}

/** Start/end transforms per pan. Cardinal pans drift ±3% of the layer —
 *  the layer is oversized by 8% on every side (CSS inset: -8%), so no edge
 *  can enter the frame. The zooms stay at scale ≥ 1 over a full-bleed layer
 *  (the .still class drops the oversize), so they can't reveal one either. */
const PAN_TRANSFORMS: Record<IntroPan, [string, string]> = {
  none: ["none", "none"],
  right: ["translate3d(3%, 0, 0)", "translate3d(-3%, 0, 0)"],
  left: ["translate3d(-3%, 0, 0)", "translate3d(3%, 0, 0)"],
  up: ["translate3d(0, -3%, 0)", "translate3d(0, 3%, 0)"],
  down: ["translate3d(0, 3%, 0)", "translate3d(0, -3%, 0)"],
  zoom: ["scale(1.02)", "scale(1.16)"],
  zoomOut: ["scale(1.12)", "scale(1.02)"],
};

/** Pans that never translate the layer — they render full-bleed (inset 0)
 *  instead of oversized, keeping crop anchors exact. */
const UNTRANSLATED_PANS: ReadonlySet<IntroPan> = new Set(["none", "zoom", "zoomOut"]);

export class IntroCinematic {
  private readonly root: HTMLElement;
  private readonly onFinished: () => void;
  private readonly base = import.meta.env.BASE_URL;

  private layers: HTMLDivElement | null = null;
  private caption: HTMLDivElement | null = null;
  private timers: number[] = [];
  private running = false;
  private preloaded = false;

  constructor(root: HTMLElement, onFinished: () => void) {
    this.root = root;
    this.onFinished = onFinished;
  }

  /** Build the DOM and run the whole timeline from the top. Idempotent with
   *  stop(): replaying always starts clean. */
  play(): void {
    this.stop();
    this.running = true;
    this.preload();

    this.layers = document.createElement("div");
    this.layers.id = "intro-layers";
    this.caption = document.createElement("div");
    this.caption.id = "intro-caption";
    this.root.append(this.layers, this.caption);

    // Slide entrances, derived from the narration cues: each slide fades in
    // just ahead of its first spoken line (held back until the previous
    // slide's last word), the title card a beat after the final line.
    const enters: number[] = [];
    let prevSpokenEndMs = 0;
    for (const [i, slide] of SLIDES.entries()) {
      const first = slide.captions[0];
      if (i === 0) enters.push(OPENING_BEAT_MS);
      else if (first) {
        enters.push(
          Math.max(prevSpokenEndMs + SLIDE_MIN_GAP_MS, captionShowMs(first) - SLIDE_ENTER_LEAD_MS),
        );
      } else enters.push(prevSpokenEndMs + TITLE_DELAY_MS);
      const last = slide.captions[slide.captions.length - 1];
      if (last) prevSpokenEndMs = captionEndMs(last);
    }

    for (const [i, slide] of SLIDES.entries()) {
      const enter = enters[i];
      // Dwell runs to the next slide's entrance (the pan keeps drifting
      // through the crossfade); the title card gets its hold instead.
      const exit = i + 1 < SLIDES.length ? enters[i + 1] : enter + (slide.holdMs ?? 5000);
      this.at(enter, () => this.enterSlide(slide, exit - enter));
      // Retire the covered layer once the crossfade has fully hidden it.
      this.at(enter + SLIDE_FADE_MS + 200, () => this.retireBackLayers());
    }

    // Captions ride their cues: in with the voice, lingering briefly after
    // it — but always finished fading before the next group needs the stage.
    const groups = SLIDES.flatMap((slide) => slide.captions);
    for (const [gi, group] of groups.entries()) {
      const next = groups[gi + 1];
      const hide = Math.min(
        captionEndMs(group) + CAPTION_TAIL_MS,
        next ? captionShowMs(next) - CAPTION_FADE_MS - 60 : Infinity,
      );
      this.at(captionShowMs(group), () => this.showCaption(group.paragraphs));
      this.at(hide, () => this.hideCaption());
    }

    // Close on black, then hand the splash back to main.ts.
    const endMs = enters[enters.length - 1] + (SLIDES[SLIDES.length - 1].holdMs ?? 5000);
    this.at(endMs, () => this.root.classList.add("intro-ended"));
    this.at(endMs + CLOSING_FADE_MS, () => {
      if (this.running) this.onFinished();
    });
  }

  /** Tear down: cancel every pending beat and clear the DOM. Safe to call
   *  mid-play (Skip / Enter) or when nothing is running. */
  stop(): void {
    this.running = false;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];
    this.root.classList.remove("intro-ended");
    this.root.replaceChildren();
    this.layers = null;
    this.caption = null;
  }

  // ── Beats ──────────────────────────────────────────────────────────────

  private enterSlide(slide: IntroSlide, dwellMs: number): void {
    if (!this.layers) return;
    const layer = document.createElement("div");
    layer.className = "intro-slide";
    if (slide.anchor === "bottom") {
      // Anchor the crop AND the zoom to the bottom edge: the wordmark down
      // there stays pinned while a zoom grows/shrinks the sky above it.
      layer.classList.add("anchor-bottom");
      layer.style.transformOrigin = "center bottom";
    }
    if (UNTRANSLATED_PANS.has(slide.pan)) layer.classList.add("still");
    layer.style.backgroundImage = `url("${this.base}${slide.image}")`;
    const [from, to] = PAN_TRANSFORMS[slide.pan];
    layer.style.transform = from;
    this.layers.appendChild(layer);

    // Commit the start state before transitioning (double rAF: the first
    // frame paints opacity 0 at the start transform, the second animates).
    // The drift spans dwell + fade so it is still moving while the next
    // slide crossfades over it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!this.running) return;
        layer.style.transition =
          `opacity ${SLIDE_FADE_MS}ms ease-in-out, ` +
          `transform ${dwellMs + SLIDE_FADE_MS}ms linear`;
        layer.style.opacity = "1";
        layer.style.transform = to;
      }),
    );
  }

  /** Drop every slide layer except the topmost (newest) one. */
  private retireBackLayers(): void {
    if (!this.layers) return;
    while (this.layers.children.length > 1) this.layers.firstChild?.remove();
  }

  private showCaption(paragraphs: string[]): void {
    if (!this.caption) return;
    this.caption.innerHTML = paragraphs.map((p) => `<p>${p}</p>`).join("");
    this.caption.classList.add("visible");
  }

  private hideCaption(): void {
    this.caption?.classList.remove("visible");
  }

  /** Warm the browser cache so crossfades never reveal a half-loaded image.
   *  Fire-and-forget: a slow network degrades to late-popping slides, not a
   *  broken timeline. */
  private preload(): void {
    if (this.preloaded) return;
    this.preloaded = true;
    for (const slide of SLIDES) {
      const img = new Image();
      img.src = `${this.base}${slide.image}`;
    }
  }

  private at(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }
}
