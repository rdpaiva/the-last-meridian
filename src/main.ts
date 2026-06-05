import { Game } from "./game/Game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
const hudRoot = document.getElementById("hud") as HTMLDivElement | null;

if (!canvas) {
  throw new Error("Canvas #renderCanvas not found in DOM");
}
if (!hudRoot) {
  throw new Error("HUD root #hud not found in DOM");
}

const game = new Game(canvas, hudRoot);
void game.start();

window.addEventListener("resize", () => {
  game.handleResize();
});
