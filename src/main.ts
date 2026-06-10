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

const game = new Game(canvas, hudRoot);

startBtn.addEventListener("click", () => {
  splash.classList.add("hidden");
  void game.start();
});

window.addEventListener("resize", () => {
  game.handleResize();
});
