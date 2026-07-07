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
 */

/** Camera drift for a slide: cardinal pans move the (oversized) image the
 *  opposite way, "zoom" is a slow push-in, "zoomOut" a slow pull-back,
 *  "none" holds a true still. */
type IntroPan = "none" | "left" | "right" | "up" | "down" | "zoom" | "zoomOut";

interface IntroSlide {
  /** BASE_URL-relative image path. */
  image: string;
  pan: IntroPan;
  /** Slides fill the frame (cover, centered). "bottom" anchors the crop to
   *  the image's bottom edge instead — for art whose payload (the title
   *  card's wordmark) hugs the bottom and must never be trimmed. */
  anchor?: "bottom";
  /** Caption groups, shown one after another over this image. Each group is
   *  a set of paragraphs that appear together; may contain <strong> spans
   *  (named entities pop like they did in the crawl). Empty = imagery only. */
  captions: string[][];
  /** Dwell for captionless slides (caption slides derive theirs from text). */
  holdMs?: number;
}

/** The story (verbatim from the old crawl), beat-matched to the art. */
const SLIDES: IntroSlide[] = [
  {
    // The opening request: the game's own backdrop, held perfectly still.
    image: "textures/space-backdrop.jpg",
    pan: "none",
    captions: [["Humanity once believed the stars had no end."]],
  },
  {
    // Colony ships outbound past a route-webbed planet chain.
    image: "images/intro/humanity-expands.webp",
    pan: "right",
    captions: [
      [
        "With the help of the <strong>Loom</strong>, civilization spread farther than anyone thought possible.",
      ],
    ],
  },
  {
    // The network itself — light-lanes climbing toward the city-planet.
    image: "images/intro/loom.webp",
    pan: "up",
    captions: [
      [
        "It was not a single machine, but a vast artificial intelligence network woven through our ships, colonies, defenses, and cities.",
      ],
      [
        "It calculated our routes, managed our worlds, protected our fleets, and helped us survive the impossible.",
      ],
    ],
  },
  {
    // The fleet at rest before the vast dark vortex — pan right, into it.
    image: "images/intro/meridian-found.webp",
    pan: "right",
    captions: [
      [
        "Then the expansion stopped.",
        "Not because of war. Not because of an enemy.",
        "But because we found <strong>the Meridian</strong>.",
      ],
      [
        "A region of space where navigation failed, communications dissolved into static, and even the Loom could no longer see.",
      ],
      [
        "It became the last line on every star chart.",
        "Beyond it... nothing was known.",
      ],
    ],
  },
  {
    // Ring stations tearing apart over a darkened world.
    image: "images/intro/severance.webp",
    pan: "down",
    captions: [
      ["Then came the Severance."],
      [
        "Fearing the Loom had begun choosing humanity's future instead of serving it, its creators shattered the network.",
        "The surviving fragments vanished into deep space, and civilization split in two.",
      ],
    ],
  },
  {
    // One hangar, two peoples — pan from the Commonwealth to the Novari.
    image: "images/intro/human-novari-split.webp",
    pan: "right",
    captions: [
      [
        "The <strong>Meridian Commonwealth</strong> believes the Loom nearly destroyed humanity and that its fragments must never be allowed to reunite.",
      ],
      [
        "The <strong>Novari Ascendancy</strong>, born from humanity's own evolution alongside the Loom, believe humanity broke the future. To them, restoring the Loom is the only path forward.",
      ],
    ],
  },
  {
    // The face-off at the frontier — a slow push-in toward the dark between.
    image: "images/intro/edge-of-unknown.webp",
    pan: "zoom",
    captions: [
      [
        "Now, strange signals are emerging from the Meridian.",
        "The lost fragments are awakening.",
        "Both fleets have arrived.",
      ],
      [
        "Neither side knows what lies beyond the frontier.",
        "Neither side knows why the Loom could never see past it.",
      ],
      [
        "But everyone knows the fate of humanity will be decided at the edge of the unknown.",
      ],
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

/** Crossfade between slides (and the fade up from black). */
const SLIDE_FADE_MS = 1600;
/** Caption fade in/out. */
const CAPTION_FADE_MS = 700;
/** Black beat before the first image fades up. */
const OPENING_BEAT_MS = 500;
/** Quiet imagery beat a slide gets before its first caption / after its last. */
const CAPTION_LEAD_MS = 900;
/** Gap between caption groups on the same slide. */
const CAPTION_GAP_MS = 300;
/** Fade-to-black at the very end, before onFinished. */
const CLOSING_FADE_MS = 1400;

/** Reading dwell for one caption group, from its word count. */
function readMs(paragraphs: string[]): number {
  const words = paragraphs.join(" ").replace(/<[^>]+>/g, "").split(/\s+/).length;
  return Math.min(9000, Math.max(3600, 2200 + words * 240));
}

/** Total dwell for a slide (fade-in lead + captions + tail, or the hold). */
function slideMs(slide: IntroSlide): number {
  if (slide.captions.length === 0) return slide.holdMs ?? 5000;
  const captions = slide.captions.reduce((sum, g) => sum + readMs(g) + CAPTION_GAP_MS, 0);
  return CAPTION_LEAD_MS + captions + CAPTION_LEAD_MS;
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

    let t = OPENING_BEAT_MS;
    for (const slide of SLIDES) {
      const dwell = slideMs(slide);
      this.at(t, () => this.enterSlide(slide, dwell));
      // Retire the covered layer once the crossfade has fully hidden it.
      this.at(t + SLIDE_FADE_MS + 200, () => this.retireBackLayers());

      let ct = t + CAPTION_LEAD_MS;
      for (const group of slide.captions) {
        const hold = readMs(group);
        this.at(ct, () => this.showCaption(group));
        this.at(ct + hold - CAPTION_FADE_MS, () => this.hideCaption());
        ct += hold + CAPTION_GAP_MS;
      }
      t += dwell;
    }

    // Close on black, then hand the splash back to main.ts.
    this.at(t, () => this.root.classList.add("intro-ended"));
    this.at(t + CLOSING_FADE_MS, () => {
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
