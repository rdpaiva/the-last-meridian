import { Game } from "./game/Game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
const hudRoot = document.getElementById("hud") as HTMLDivElement | null;
const splash = document.getElementById("splash") as HTMLDivElement | null;
const splashBegin = document.getElementById("splash-begin") as HTMLDivElement | null;
const splashPoster = document.getElementById("splash-poster") as HTMLImageElement | null;
const startBtn = document.getElementById("splash-start") as HTMLButtonElement | null;

if (!canvas) throw new Error("Canvas #renderCanvas not found in DOM");
if (!hudRoot) throw new Error("HUD root #hud not found in DOM");
if (!splash) throw new Error("#splash not found in DOM");
if (!splashBegin) throw new Error("#splash-begin not found in DOM");
if (!splashPoster) throw new Error("#splash-poster not found in DOM");
if (!startBtn) throw new Error("#splash-start not found in DOM");

// Set src via JS so BASE_URL is resolved correctly for GitHub Pages.
splashPoster.src = `${import.meta.env.BASE_URL}images/The-Last-Meridian-Poster.jpg`;

// Splash music — routed through the Web Audio API, NOT an HTML5 <audio>
// element. This is the same pipeline the in-game SFX use (Babylon's Sound is
// Web Audio under the hood). Some browsers/extensions auto-mute <audio>/<video>
// elements specifically; going through Web Audio means the music plays exactly
// like the SFX do. The AudioContext is created inside the begin-click handler
// so the user gesture lets it start in the "running" state.
const musicUrl = `${import.meta.env.BASE_URL}music/Black Star Pursuit 2.mp3`;
let musicCtx: AudioContext | null = null;
let musicSource: AudioBufferSourceNode | null = null;

async function startSplashMusic(): Promise<void> {
  try {
    musicCtx = new AudioContext();
    const gain = musicCtx.createGain();
    gain.gain.value = 0.45;
    gain.connect(musicCtx.destination);
    const data = await fetch(musicUrl).then((r) => r.arrayBuffer());
    const buffer = await musicCtx.decodeAudioData(data);
    // Bail if the splash was already dismissed while the mp3 was decoding.
    if (!musicCtx) return;
    musicSource = musicCtx.createBufferSource();
    musicSource.buffer = buffer;
    musicSource.loop = true;
    musicSource.connect(gain);
    musicSource.start();
  } catch {
    // Music is non-essential; never let an audio failure break the splash.
  }
}

function stopSplashMusic(): void {
  try { musicSource?.stop(); } catch { /* already stopped */ }
  void musicCtx?.close();
  musicCtx = null;
  musicSource = null;
}

const game = new Game(canvas, hudRoot);

// The "click to begin" overlay click is the user gesture the browser requires
// to allow audio. It starts the music and (via the `begun` class) the
// cinematic scroll together, so they stay in sync. `once` means there are no
// stray handlers left over after the splash is dismissed.
splashBegin.addEventListener("click", () => {
  splash.classList.add("begun");
  void startSplashMusic();
}, { once: true });

startBtn.addEventListener("click", () => {
  stopSplashMusic();
  splash.classList.add("hidden");
  void game.start();
});

window.addEventListener("resize", () => {
  game.handleResize();
});
