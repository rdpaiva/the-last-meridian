import { Game, RESTART_FLAG } from "./game/Game";
import { LoadoutMenu } from "./game/LoadoutMenu";
import { loadSavedLoadout, type PlayerLoadout } from "./game/Loadout";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
const hudRoot = document.getElementById("hud") as HTMLDivElement | null;
const splash = document.getElementById("splash") as HTMLDivElement | null;
const splashPoster = document.getElementById("splash-poster") as HTMLImageElement | null;
const startBtn = document.getElementById("splash-start") as HTMLButtonElement | null;
const loadoutRoot = document.getElementById("loadout") as HTMLDivElement | null;

if (!canvas) throw new Error("Canvas #renderCanvas not found in DOM");
if (!hudRoot) throw new Error("HUD root #hud not found in DOM");
if (!splash) throw new Error("#splash not found in DOM");
if (!splashPoster) throw new Error("#splash-poster not found in DOM");
if (!startBtn) throw new Error("#splash-start not found in DOM");
if (!loadoutRoot) throw new Error("#loadout not found in DOM");

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

// The Game is constructed at launch time (not page load) so it can take the
// loadout — which side and ship the pilot chose on the splash menu.
let game: Game | null = null;

function launch(loadout: PlayerLoadout): void {
  if (game) return;
  game = new Game(canvas!, hudRoot!, loadout);
  void game.start();
}

if (sessionStorage.getItem(RESTART_FLAG)) {
  // This load is the end-of-match restart (Enter on the result banner) —
  // the player already sat through the splash, so skip it and relaunch the
  // saved loadout directly. Audio resumes on their first keypress (a
  // reloaded page has no user gesture yet, so it can't resume here).
  sessionStorage.removeItem(RESTART_FLAG);
  splash.classList.add("hidden");
  launch(loadSavedLoadout());
} else {
  // Side + ship select, preloaded with the saved choice so Enter-Enter gets
  // a returning player straight back into the fight.
  const menu = new LoadoutMenu(loadoutRoot);

  // START GAME is a two-press entry — no separate "click to begin" gate. The
  // first press is the user gesture the browser requires to allow audio: it
  // starts the music and (via the `begun` class) the cinematic crawl, which
  // fades in over the poster. The second press launches the chosen loadout.
  // That gap is what lets the splash music + crawl actually be heard/seen
  // before the cut to gameplay. Enter mirrors the button exactly.
  const begin = (): void => {
    if (splash.classList.contains("begun")) return;
    // `begun` fades the splash up into color (CSS) and starts the music; the
    // button relabels to the pulsing PLAY so the launch press reads as a new,
    // distinct action rather than a second click of the same "START GAME".
    splash.classList.add("begun");
    startBtn.textContent = "Play";
    void startSplashMusic();
  };

  const startGame = (): void => {
    if (game) return;
    // commit() persists the choice and releases the menu's arrow keys back
    // to the ship before the Game's own key handling comes up.
    const loadout = menu.commit();
    stopSplashMusic();
    splash.classList.add("hidden");
    launch(loadout);
  };

  const advance = (): void => {
    if (splash.classList.contains("begun")) startGame();
    else begin();
  };

  startBtn.addEventListener("click", advance);

  // Enter walks the whole splash from the keyboard: first press starts the
  // music + crawl (the audio user gesture), second press launches.
  window.addEventListener("keydown", (e) => {
    if (game || e.code !== "Enter") return;
    advance();
  });
}

window.addEventListener("resize", () => {
  game?.handleResize();
});
