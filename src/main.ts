import { Game } from "./game/Game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
const hudRoot = document.getElementById("hud") as HTMLDivElement | null;
const splash = document.getElementById("splash") as HTMLDivElement | null;
const splashPoster = document.getElementById("splash-poster") as HTMLImageElement | null;
const startBtn = document.getElementById("splash-start") as HTMLButtonElement | null;

if (!canvas) throw new Error("Canvas #renderCanvas not found in DOM");
if (!hudRoot) throw new Error("HUD root #hud not found in DOM");
if (!splash) throw new Error("#splash not found in DOM");
if (!splashPoster) throw new Error("#splash-poster not found in DOM");
if (!startBtn) throw new Error("#splash-start not found in DOM");

// Set src via JS so BASE_URL is resolved correctly for GitHub Pages.
splashPoster.src = `${import.meta.env.BASE_URL}images/The-Last-Meridian-Poster.jpg`;

// Splash music — HTML5 Audio, independent of Babylon (engine not started yet).
const splashMusic = new Audio(`${import.meta.env.BASE_URL}music/Black Star Pursuit 2.mp3`);
splashMusic.loop = true;
splashMusic.volume = 0.45;

// Browsers block autoplay without a prior user gesture. Try immediately and,
// if blocked, retry on the first interaction so music starts as early as possible.
void splashMusic.play().catch(() => {
  const unlock = () => { void splashMusic.play(); };
  document.addEventListener("mousemove", unlock, { once: true });
  document.addEventListener("keydown", unlock, { once: true });
  document.addEventListener("click", unlock, { once: true });
});

const game = new Game(canvas, hudRoot);

startBtn.addEventListener("click", () => {
  splashMusic.pause();
  splash.classList.add("hidden");
  void game.start();
});

window.addEventListener("resize", () => {
  game.handleResize();
});
