import { Game, RESTART_FLAG } from "./game/Game";
import { LoadoutMenu, SHIP_INFO } from "./game/LoadoutMenu";
import { ShipPreview } from "./game/ShipPreview";
import { SettingsMenu } from "./game/SettingsMenu";
import { FACTION_THEME } from "./game/Faction";
import { applyStoredOverrides, overrideCount } from "./game/ConfigOverrides";
import { applyMap, resolveMapId, loadSavedMapSelection } from "./game/Maps";
import {
  hasSavedLoadout,
  hasSeenIntro,
  loadSavedLoadout,
  markIntroSeen,
} from "./game/Loadout";

/**
 * Entry point: the staged splash flow, then the Game.
 *
 * The splash is a small state machine (data-state on #splash drives all the
 * CSS visibility):
 *
 *   landing       THE LAST MERIDIAN · [ENTER THE MERIDIAN] · Skip Intro.
 *                 First screen for anyone without a saved loadout + seen
 *                 intro. Skip Intro is ALWAYS visible from second zero.
 *   intro         The cinematic: color fades up, music starts, the story
 *                 crawl plays once. Ends (or Skip) → factionSelect.
 *   factionSelect CHOOSE YOUR SIDE — faction cards, the selected faction's
 *                 ships, the rotating hangar preview, PLAY.
 *   quickPlay     Returning players (saved loadout + intro seen): Continue
 *                 line · [PLAY] · Change Faction / Replay Intro.
 *
 * Every button is also a browser audio-unlock gesture (unlockAudio()).
 */

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
const hudRoot = document.getElementById("hud") as HTMLDivElement | null;
const splash = document.getElementById("splash") as HTMLDivElement | null;
const splashPoster = document.getElementById("splash-poster") as HTMLImageElement | null;
const story = document.getElementById("splash-story") as HTMLDivElement | null;
const primaryBtn = document.getElementById("splash-primary") as HTMLButtonElement | null;
const skipBtn = document.getElementById("splash-skip") as HTMLButtonElement | null;
const changeBtn = document.getElementById("splash-change") as HTMLButtonElement | null;
const replayBtn = document.getElementById("splash-replay") as HTMLButtonElement | null;
const continueLoadout = document.getElementById("splash-continue-loadout");
const loadoutRoot = document.getElementById("loadout") as HTMLDivElement | null;
const settingsBtn = document.getElementById("splash-settings") as HTMLButtonElement | null;
const settingsRoot = document.getElementById("settings") as HTMLDivElement | null;

if (!canvas) throw new Error("Canvas #renderCanvas not found in DOM");
if (!hudRoot) throw new Error("HUD root #hud not found in DOM");
if (!splash) throw new Error("#splash not found in DOM");
if (!splashPoster) throw new Error("#splash-poster not found in DOM");
if (!story) throw new Error("#splash-story not found in DOM");
if (!primaryBtn) throw new Error("#splash-primary not found in DOM");
if (!skipBtn) throw new Error("#splash-skip not found in DOM");
if (!changeBtn) throw new Error("#splash-change not found in DOM");
if (!replayBtn) throw new Error("#splash-replay not found in DOM");
if (!continueLoadout) throw new Error("#splash-continue-loadout not found in DOM");
if (!loadoutRoot) throw new Error("#loadout not found in DOM");
if (!settingsBtn) throw new Error("#splash-settings not found in DOM");
if (!settingsRoot) throw new Error("#settings not found in DOM");

// Write any saved match-settings overrides into GameConfig BEFORE anything
// reads it — both Game-construction paths below and the loadout menu's stat
// bars read the live config. (Every system copies its config at construction,
// so this one early call is the whole "apply" step.)
applyStoredOverrides();

// Arena map (docs/ARENA-MAPS.md). The persisted selection drives it: a pinned
// concrete map, or "random" (the default) which re-rolls a preset each page
// load — i.e. each match, since the end-of-match restart reloads. The picker
// UI that lets the player change this is slice 3; until then the selection
// comes from storage (default "random"). applyMap runs AFTER
// applyStoredOverrides so a player's match-settings override of a shared knob
// (asteroid count, fleet composition) beats the map baseline.
applyMap(resolveMapId(loadSavedMapSelection()));

// Set src via JS so BASE_URL is resolved correctly for GitHub Pages.
splashPoster.src = `${import.meta.env.BASE_URL}images/The-Last-Meridian-Poster.jpg`;

// ── Splash music / audio unlock ────────────────────────────────────────────
// Routed through the Web Audio API, NOT an HTML5 <audio> element. This is the
// same pipeline the in-game SFX use (Babylon's Sound is Web Audio under the
// hood). Some browsers/extensions auto-mute <audio>/<video> elements
// specifically; going through Web Audio means the music plays exactly like
// the SFX do. The AudioContext is created inside a button-click handler so
// the user gesture lets it start in the "running" state.
const musicUrl = `${import.meta.env.BASE_URL}music/Black Star Pursuit 2.mp3`;
let musicCtx: AudioContext | null = null;
let musicSource: AudioBufferSourceNode | null = null;

async function startSplashMusic(): Promise<void> {
  if (musicCtx) return; // already started (idempotent for repeat clicks)
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

/**
 * Centralized browser audio unlock — called from EVERY splash button (Enter
 * the Meridian, Skip Intro, Play, Replay Intro, Change Faction). The click
 * that invokes it is the user gesture browsers require, so the shared
 * AudioContext starts "running"; the same gesture also satisfies Babylon's
 * own in-game audio engine unlock once the Game constructs.
 */
function unlockAudio(): void {
  if (musicCtx) {
    void musicCtx.resume();
    return;
  }
  void startSplashMusic();
}

// ── Game construction ──────────────────────────────────────────────────────
// The Game is constructed at launch time (not page load) so it can take the
// loadout — which side and ship the pilot chose on the splash menu.
let game: Game | null = null;
let menu: LoadoutMenu | null = null;
let preview: ShipPreview | null = null;

function startGame(): void {
  if (game) return;
  // commit() persists the choice and releases the menu's arrow keys back to
  // the ship; quick play (no menu constructed) launches the saved loadout.
  const loadout = menu ? menu.commit() : loadSavedLoadout();
  stopSplashMusic();
  preview?.dispose();
  preview = null;
  splash!.classList.add("hidden");
  game = new Game(canvas!, hudRoot!, loadout);
  void game.start();
}

// ── Splash state machine ───────────────────────────────────────────────────

type SplashState = "landing" | "intro" | "factionSelect" | "quickPlay" | "settings";
let state: SplashState = "landing";
let settings: SettingsMenu | null = null;
/** Where BACK/Esc returns to from the settings overlay. */
let settingsReturn: SplashState = "landing";

/** "Match Settings · N modified" when off defaults — the at-a-glance cue
 *  that the next launch won't run stock tuning. */
function updateSettingsBadge(): void {
  const n = overrideCount();
  settingsBtn!.textContent = n > 0 ? `Match Settings · ${n} modified` : "Match Settings";
}

function setState(next: SplashState): void {
  state = next;
  splash!.dataset.state = next;

  // The desaturated "dormant" filter lifts the moment the interface wakes up
  // (intro or selection); landing and quick play stay gray until touched.
  if (next === "intro" || next === "factionSelect") {
    splash!.classList.add("begun");
  }

  switch (next) {
    case "landing":
      primaryBtn!.textContent = "ENTER THE MERIDIAN";
      break;
    case "intro":
      restartCrawl();
      break;
    case "quickPlay": {
      const saved = loadSavedLoadout();
      const info = SHIP_INFO[saved.shipType];
      continueLoadout!.textContent =
        `${FACTION_THEME[saved.faction].fullName.replace(/^The /, "")}` +
        ` · ${info.name} ${info.role}`;
      primaryBtn!.textContent = "PLAY";
      break;
    }
    case "factionSelect":
      // Built lazily on first entry; both survive return visits (e.g. via
      // Change Faction) with their loaded GLBs and thumbnails intact.
      if (!preview) preview = new ShipPreview();
      if (!menu) menu = new LoadoutMenu(loadoutRoot!, preview, startGame);
      preview.start();
      break;
    case "settings":
      // Built lazily on first entry; survives return visits with its
      // section-open state intact.
      if (!settings) {
        settings = new SettingsMenu(
          settingsRoot!,
          () => setState(settingsReturn),
          updateSettingsBadge,
        );
      }
      break;
  }
  if (next !== "factionSelect") preview?.stop();
}

/**
 * Reset the story crawl so Replay Intro starts from the top. The animation
 * is declared in CSS (one iteration, paused outside the intro state);
 * clearing the inline override after a reflow re-arms it.
 */
function restartCrawl(): void {
  story!.style.animation = "none";
  void story!.offsetHeight; // force reflow so the reset takes
  story!.style.animation = "";
}

function enterMeridian(): void {
  unlockAudio();
  setState("intro");
}

function skipIntro(): void {
  unlockAudio();
  markIntroSeen();
  setState("factionSelect");
}

if (sessionStorage.getItem(RESTART_FLAG)) {
  // This load is the end-of-match restart (Enter on the result banner) —
  // the player already sat through the splash, so skip it and relaunch the
  // saved loadout directly. Audio resumes on their first keypress (a
  // reloaded page has no user gesture yet, so it can't resume here).
  sessionStorage.removeItem(RESTART_FLAG);
  splash.classList.add("hidden");
  game = new Game(canvas, hudRoot, loadSavedLoadout());
  void game.start();
} else {
  // Returning players (intro seen + a real saved loadout) get the one-click
  // quick-play screen; everyone else gets the cinematic landing — which
  // always offers both ENTER THE MERIDIAN and Skip Intro.
  setState(hasSeenIntro() && hasSavedLoadout() ? "quickPlay" : "landing");

  primaryBtn.addEventListener("click", () => {
    if (state === "landing") enterMeridian();
    else if (state === "quickPlay") {
      unlockAudio();
      startGame();
    }
  });

  skipBtn.addEventListener("click", skipIntro);

  changeBtn.addEventListener("click", () => {
    unlockAudio();
    setState("factionSelect");
  });

  replayBtn.addEventListener("click", () => {
    // Replaying never erases the saved faction/ship — the crawl just runs
    // again, then lands on faction selection with the save preselected.
    unlockAudio();
    setState("intro");
  });

  updateSettingsBadge();
  settingsBtn.addEventListener("click", () => {
    unlockAudio();
    if (state !== "settings") settingsReturn = state;
    setState("settings");
  });

  // The crawl finished on its own → remember that and reveal the selection.
  story.addEventListener("animationend", () => {
    if (state !== "intro") return;
    markIntroSeen();
    setState("factionSelect");
  });

  // Enter mirrors the current state's primary action so the whole splash
  // remains keyboard-walkable (landing → intro → [Enter skips] → select →
  // launch; quick play is a single Enter).
  window.addEventListener("keydown", (e) => {
    if (game) return;
    if (state === "settings") {
      // Enter must NOT launch the game while the user is editing inputs;
      // Esc mirrors the BACK button.
      if (e.code === "Escape") setState(settingsReturn);
      return;
    }
    if (e.code !== "Enter") return;
    switch (state) {
      case "landing":
        enterMeridian();
        break;
      case "intro":
        // Don't trap keyboard users in the crawl — Enter skips ahead.
        skipIntro();
        break;
      case "quickPlay":
      case "factionSelect":
        startGame();
        break;
    }
  });
}

window.addEventListener("resize", () => {
  game?.handleResize();
  preview?.resize();
});
