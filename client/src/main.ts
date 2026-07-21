import { Game, RESTART_FLAG } from "./game/Game";
import { NetworkGame } from "./game/NetworkGame";
import { NetClient, inviteRoomId, clearInviteHash } from "./net/NetClient";
import { IntroCinematic, NARRATION_START_MS } from "./game/IntroCinematic";
import { LoadoutMenu, type LaunchMode } from "./game/LoadoutMenu";
import { ShipPreview } from "./game/ShipPreview";
import { SettingsMenu } from "./game/SettingsMenu";
import {
  PROTOCOL_MISMATCH,
  FACTION_FULL,
  applyMap as applyServerMap,
  applyMapConfig,
} from "@space-duel/shared";
import { applyStoredOverrides } from "./game/ConfigOverrides";
import { applyMap, resolveMapId, loadSavedMapSelection } from "./game/Maps";
import { MapEditor, loadDraftMap, type DraftMap } from "./game/MapEditor";
import { applyDifficulty, loadSavedDifficulty } from "./game/Difficulty";
import { FieldManual } from "./game/FieldManual";
import {
  hasSeenIntro,
  loadSavedLoadout,
  loadPilotName,
  markIntroSeen,
} from "./game/Loadout";

/**
 * Entry point: the staged splash flow, then the Game.
 *
 * The splash is a small state machine (data-state on #splash drives all the
 * CSS visibility):
 *
 *   factionSelect The front door for EVERYONE: the three-step loadout frame
 *                 (LoadoutMenu.ts): mode + callsign → faction/ship hangar →
 *                 mission setup → launch. Returning players get a gold
 *                 CONTINUE CTA (Enter) on step 1 that relaunches the saved
 *                 loadout immediately — the old quick-play screen, folded in.
 *   intro         The cinematic story slideshow (IntroCinematic.ts): the
 *                 story beats over drifting full-screen art, ending on the
 *                 title poster. First-timers hit it as a gate between MODE
 *                 and HANGAR; it's replayable via the loadout's footer rail.
 *
 * Audio unlock rides the first pointer/key gesture on the splash (browsers
 * require a user gesture before an AudioContext may run).
 */

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
const hudRoot = document.getElementById("hud") as HTMLDivElement | null;
const splash = document.getElementById("splash") as HTMLDivElement | null;
const introRoot = document.getElementById("intro-cinematic") as HTMLDivElement | null;
const skipBtn = document.getElementById("splash-skip") as HTMLButtonElement | null;
const loadoutRoot = document.getElementById("loadout") as HTMLDivElement | null;
const manualRoot = document.getElementById("field-manual") as HTMLDivElement | null;
const settingsRoot = document.getElementById("settings") as HTMLDivElement | null;
const mapEditorRoot = document.getElementById("map-editor") as HTMLDivElement | null;

if (!canvas) throw new Error("Canvas #renderCanvas not found in DOM");
if (!hudRoot) throw new Error("HUD root #hud not found in DOM");
if (!splash) throw new Error("#splash not found in DOM");
if (!introRoot) throw new Error("#intro-cinematic not found in DOM");
if (!skipBtn) throw new Error("#splash-skip not found in DOM");
if (!loadoutRoot) throw new Error("#loadout not found in DOM");
if (!manualRoot) throw new Error("#field-manual not found in DOM");
if (!settingsRoot) throw new Error("#settings not found in DOM");
if (!mapEditorRoot) throw new Error("#map-editor not found in DOM");

// Write any saved match-settings overrides into GameConfig BEFORE anything
// reads it — both Game-construction paths below and the loadout menu's stat
// bars read the live config. (Every system copies its config at construction,
// so this one early call is the whole "apply" step.)
applyStoredOverrides();

// The loadout screens' nebula backdrop (CSS reads --splash-bg under
// data-state="factionSelect") — set here for the same BASE_URL reason.
splash.style.setProperty(
  "--splash-bg",
  `url("${import.meta.env.BASE_URL}images/Meridian-Splash.jpg")`,
);

// ── Splash music / audio unlock ────────────────────────────────────────────
// Routed through the Web Audio API, NOT an HTML5 <audio> element. This is the
// same pipeline the in-game SFX use (Babylon's Sound is Web Audio under the
// hood). Some browsers/extensions auto-mute <audio>/<video> elements
// specifically; going through Web Audio means the music plays exactly like
// the SFX do. The AudioContext is created inside a button-click handler so
// the user gesture lets it start in the "running" state.
const musicUrl = `${import.meta.env.BASE_URL}music/Last Stand in Deep Space.mp3`;
const narrationUrl = `${import.meta.env.BASE_URL}music/meridian-narration-intro.mp3`;
/** Music level, and the level it ducks to while the intro narration speaks. */
const MUSIC_GAIN = 0.45;
const MUSIC_DUCKED_GAIN = 0.32;
let musicCtx: AudioContext | null = null;
let musicSource: AudioBufferSourceNode | null = null;
let musicGain: GainNode | null = null;
/** Kept after decode so the track can be restarted from the top (the intro
 *  cinematic re-cues it) without re-fetching. */
let musicBuffer: AudioBuffer | null = null;

async function startSplashMusic(): Promise<void> {
  if (musicCtx) return; // already started (idempotent for repeat clicks)
  try {
    musicCtx = new AudioContext();
    musicGain = musicCtx.createGain();
    musicGain.gain.value = MUSIC_GAIN;
    musicGain.connect(musicCtx.destination);
    void loadNarration(); // fetched/decoded alongside the music, never blocking it
    const data = await fetch(musicUrl).then((r) => r.arrayBuffer());
    const buffer = await musicCtx.decodeAudioData(data);
    // Bail if the splash was already dismissed while the mp3 was decoding.
    if (!musicCtx) return;
    musicBuffer = buffer;
    playMusicFromTop();
  } catch {
    // Music is non-essential; never let an audio failure break the splash.
  }
}

/** (Re)start the splash track from its first beat. A BufferSourceNode is
 *  one-shot, so restarting means swapping in a fresh source over the kept
 *  buffer. No-op until the mp3 has decoded — in that case the track is
 *  about to start from the top anyway. */
function playMusicFromTop(): void {
  if (!musicCtx || !musicBuffer || !musicGain) return;
  try { musicSource?.stop(); } catch { /* not started / already stopped */ }
  musicSource = musicCtx.createBufferSource();
  musicSource.buffer = musicBuffer;
  musicSource.loop = true;
  musicSource.connect(musicGain);
  musicSource.start();
}

function stopSplashMusic(): void {
  stopNarration();
  try { musicSource?.stop(); } catch { /* already stopped */ }
  void musicCtx?.close();
  musicCtx = null;
  musicSource = null;
  musicGain = null;
  musicBuffer = null;
  narrationBuffer = null;
  narrationGain = null;
}

// ── Intro narration ────────────────────────────────────────────────────────
// The story cinematic's voiceover, overlaid on the (ducked) splash track.
// Playback is anchored to the moment the intro state was entered: if the mp3
// finishes decoding after the slideshow has already started (the first-run
// Enter press kicks off both), the narration joins at the elapsed offset so
// the read stays in step with the slides instead of drifting late.
let narrationBuffer: AudioBuffer | null = null;
let narrationSource: AudioBufferSourceNode | null = null;
let narrationGain: GainNode | null = null;
/** performance.now() at intro entry; null whenever the intro isn't active. */
let introStartedAtMs: number | null = null;

async function loadNarration(): Promise<void> {
  if (narrationBuffer) return;
  try {
    const data = await fetch(narrationUrl).then((r) => r.arrayBuffer());
    if (!musicCtx) return; // splash dismissed while fetching
    narrationBuffer = await musicCtx.decodeAudioData(data);
    playNarration(); // no-op unless the intro is already running
  } catch {
    // Narration is non-essential; the intro plays fine without it.
  }
}

/** Start (or restart) the narration on the cinematic's timeline — the mp3
 *  belongs NARRATION_START_MS into the intro (IntroCinematic's caption cues
 *  are all relative to that anchor). Scheduled ahead on the audio clock when
 *  the intro just began; joined at the elapsed offset when the decode landed
 *  late. No-op until both the decode and the intro state are in place —
 *  whichever lands second calls this. */
function playNarration(): void {
  if (!musicCtx || !narrationBuffer || introStartedAtMs === null) return;
  stopNarrationSource();
  const offsetSec =
    (performance.now() - introStartedAtMs - NARRATION_START_MS) / 1000;
  if (offsetSec >= narrationBuffer.duration) return;
  if (!narrationGain) {
    narrationGain = musicCtx.createGain();
    narrationGain.gain.value = 1;
    narrationGain.connect(musicCtx.destination);
  }
  narrationSource = musicCtx.createBufferSource();
  narrationSource.buffer = narrationBuffer;
  narrationSource.connect(narrationGain);
  // Natural end (the title card outlasts the voice) brings the music back up.
  narrationSource.onended = () => duckMusic(false);
  if (offsetSec >= 0) narrationSource.start(0, offsetSec);
  else narrationSource.start(musicCtx.currentTime - offsetSec, 0);
  duckMusic(true);
}

/** Silence the voice and restore the music — leaving the intro in any way. */
function stopNarration(): void {
  introStartedAtMs = null;
  stopNarrationSource();
  duckMusic(false);
}

function stopNarrationSource(): void {
  if (!narrationSource) return;
  narrationSource.onended = null; // manual stop: duck state is handled by the caller
  try { narrationSource.stop(); } catch { /* not started / already stopped */ }
  narrationSource = null;
}

function duckMusic(duck: boolean): void {
  if (!musicCtx || !musicGain) return;
  musicGain.gain.setTargetAtTime(
    duck ? MUSIC_DUCKED_GAIN : MUSIC_GAIN,
    musicCtx.currentTime,
    0.4,
  );
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
let netGame: NetworkGame | null = null;
let menu: LoadoutMenu | null = null;
let preview: ShipPreview | null = null;
/** The Field Manual card deck. Built lazily (it needs the ShipPreview for
 *  its thumbnails); survives open/close cycles like the menu does. */
let manual: FieldManual | null = null;

function openManual(): void {
  if (!preview) return; // only reachable from factionSelect, where it exists
  if (!manual) manual = new FieldManual(manualRoot!, preview);
  manual.open();
}

/**
 * Launch modes (Phase 1 entry polish — replaces the old `?online` flag):
 * PLAY SOLO runs the offline Game (no server); PLAY ONLINE quick-matches into
 * a server battle. WITH FRIENDS rides the URL hash: joining a match writes
 * `#join=<roomId>` into the address bar (the invite link — share the URL),
 * and a page opened WITH that hash joins the friend's room by id instead of
 * quick-matching (falling back to a fresh match if it's gone).
 */
/** True while an online join is in flight — blocks double-launch clicks. */
let connecting = false;

/**
 * Arena map (docs/ARENA-MAPS.md). Applied at LAUNCH, not page load: the picker
 * persists the player's selection (LoadoutMenu) and quick play / restart read
 * it from storage, so resolving here means the latest choice always takes — and
 * "random" (the default) re-rolls a preset each match. Runs AFTER
 * applyStoredOverrides (module-init) so a player's match-settings override of a
 * shared knob (asteroid count, fleet composition) beats the map baseline.
 * Applied exactly once per page load, on the one launch path that runs.
 */
function applyActiveMap(): void {
  applyMap(resolveMapId(loadSavedMapSelection()));
}

/**
 * Apply the saved difficulty (enemy-skill preset) at LAUNCH, mirroring
 * applyActiveMap: the picker persists the selection and quick play / restart
 * read it from storage. Touches only ai/commander knobs (disjoint from the
 * map), and a hand-tuned match-settings override still wins.
 */
function applyActiveDifficulty(): void {
  applyDifficulty(loadSavedDifficulty());
}

/**
 * Map-editor TEST FLIGHT: the draft to launch on instead of the saved arena
 * selection. Set by the editor's callback right before it calls
 * startGame("solo"); the sessionStorage flag lets an end-of-match Enter
 * restart (a fresh page load) replay the draft too — a normal solo launch
 * clears it.
 */
let testFlightMap: DraftMap | null = null;
const TEST_FLIGHT_FLAG = "lastMeridian_testFlight";

function startGame(mode: LaunchMode): void {
  if (game || netGame || connecting) return;
  // commit() persists the choice and releases the menu's arrow keys back to
  // the ship; quick play (no menu constructed) launches the saved loadout.
  const loadout = menu ? menu.commit() : loadSavedLoadout();

  if (mode === "online") {
    void startOnline(loadout);
    return;
  }

  stopSplashMusic();
  preview?.dispose();
  preview = null;
  if (testFlightMap) {
    // The draft exactly as designed — no override hooks (unlike applyMap's
    // solo path), so match-settings hand-tuning can't skew what's being
    // playtested.
    applyMapConfig(testFlightMap);
    testFlightMap = null;
    sessionStorage.setItem(TEST_FLIGHT_FLAG, "1");
  } else {
    sessionStorage.removeItem(TEST_FLIGHT_FLAG);
    applyActiveMap();
  }
  applyActiveDifficulty();
  splash!.classList.add("hidden");
  game = new Game(canvas!, hudRoot!, loadout);
  void game.start();
}

/**
 * Connect to the server and hand off to the networked renderer: join the
 * friend's room when the URL carries `#join=<roomId>` (falling back to a
 * quick match if that room is gone), else quick-match. Success writes the
 * joined roomId back into the hash — the address bar IS the invite link.
 * On failure (server down, protocol mismatch) the splash stays up with a
 * readable reason on the button that was pressed — PLAY SOLO always works.
 */
async function startOnline(base: ReturnType<typeof loadSavedLoadout>): Promise<void> {
  // The persisted pilot name rides the join as the seat's callsign (the
  // loadout menu's field saves per keystroke; quick play reads the same key).
  // The map selection rides too: it becomes the room's arena when this join
  // CREATES the room (quick match to an empty server, WITH FRIENDS host, or
  // the faction-full fallback create); joining an existing room inherits its
  // arena instead — either way the server replicates the resolved map back.
  const loadout = {
    ...base,
    pilotName: loadPilotName(),
    mapSelection: loadSavedMapSelection(),
  };
  // Status lands where the player is looking: the loadout's online launch
  // CTA (step 3) or the CONTINUE CTA (step 1) — setOnlineStatus feeds both.
  const setStatus = (text: string | null): void => menu?.setOnlineStatus(text);
  connecting = true;
  setStatus("CONNECTING…");
  try {
    const invite = inviteRoomId();
    let net: NetClient;
    if (invite) {
      try {
        net = await NetClient.joinById(invite, loadout);
      } catch (err) {
        // Protocol mismatch would fail a fresh match the same way — surface
        // it. Faction-full is the one case where the friend's room is ALIVE:
        // stay on the splash and tell them the actual fix (the hash
        // survives, so switching sides and relaunching retries the same
        // room). Anything else (room disposed/locked/full) means the
        // friend's match is unreachable — STOP on the splash with the
        // reason rather than auto-quick-matching: a successful fallback
        // hides the splash within a few hundred ms, so any status set here
        // flashes unreadably and the player lands in a stranger's room with
        // no explanation. Dropping the dead hash makes the next launch
        // press an ordinary quick match.
        if ((err as { code?: number }).code === PROTOCOL_MISMATCH) throw err;
        if ((err as { code?: number }).code === FACTION_FULL) {
          setStatus("FRIEND'S MATCH — that side is full; switch factions to join");
          return;
        }
        console.warn("[online] invite room unavailable:", err);
        clearInviteHash();
        setStatus("FRIEND'S MATCH UNAVAILABLE (full or ended) — relaunch for a new room");
        return;
      }
    } else {
      try {
        net = await NetClient.quickMatch(loadout);
      } catch (err) {
        // joinOrCreate seated us in a room whose <faction> side is full (the
        // matchmaker counts CLIENTS, not seats-per-faction). Retrying would
        // match the same room again — start a fresh one instead.
        if ((err as { code?: number }).code !== FACTION_FULL) throw err;
        setStatus("MATCH FULL — starting a fresh room…");
        net = await NetClient.createMatch(loadout);
      }
    }
    // Shareable WITH FRIENDS link (replaceState: no scroll/history spam).
    history.replaceState(null, "", `#join=${net.roomId}`);
    // The ROOM owns the arena: apply its replicated map (awaited — the join
    // can settle before the first full state decodes) into GameConfig before
    // NetworkGame constructs, so carrier placement, nebula/storm zones, and
    // wreck hazards match the server's board. The shared applier, WITHOUT the
    // match-settings override hooks the solo path uses: online, local
    // hand-tuning of board knobs must not desync the view from the server.
    applyServerMap(await net.mapId());
    stopSplashMusic();
    preview?.dispose();
    preview = null;
    splash!.classList.add("hidden");
    netGame = new NetworkGame(canvas!, hudRoot!, net, loadout.faction);
    void netGame.start();
  } catch (err) {
    console.error("[online] failed to join:", err);
    // A protocol mismatch is a stale build, not an outage — say so. The code
    // rides the Colyseus ServerError through to the client error object.
    setStatus(
      (err as { code?: number }).code === PROTOCOL_MISMATCH
        ? "NEW VERSION — refresh to update (⌘⇧R)"
        : "SERVER UNAVAILABLE — try again, or play solo",
    );
  } finally {
    connecting = false;
  }
}

// ── Splash state machine ───────────────────────────────────────────────────

type SplashState = "intro" | "factionSelect" | "settings" | "mapEditor";
let state: SplashState = "factionSelect";
let settings: SettingsMenu | null = null;
let mapEditor: MapEditor | null = null;
/** The story slideshow. Built lazily on first intro entry; finished()
 *  advances the splash (guarded — stop() cancels the timeline, so this can
 *  only fire while the intro is actually the active state). */
let cinematic: IntroCinematic | null = null;
/** Where BACK/Esc returns to from the settings overlay. */
let settingsReturn: SplashState = "factionSelect";
/** Where the intro hands off when it ends: the hangar (the first-run gate on
 *  MODE → HANGAR advances the menu) or wherever the menu already was (Replay
 *  Intro). */
let introReturn: "hangar" | "stay" = "stay";

/** The loadout footer rail renders its own "Match Settings · N" label from
 *  overrideCount() — a refresh re-reads it when settings change. */
function updateSettingsBadge(): void {
  menu?.refresh();
}

function setState(next: SplashState): void {
  state = next;
  splash!.dataset.state = next;

  switch (next) {
    case "intro":
      if (!cinematic) cinematic = new IntroCinematic(introRoot!, finishIntro);
      cinematic.play();
      // The intro and the track open together. (First-run entry rides an
      // Enter press, whose gestureUnlock is still fetching the mp3 — then
      // this is a no-op and the decode callback starts it from the top.)
      playMusicFromTop();
      // The voiceover is anchored here; if its decode is still in flight it
      // joins at the elapsed offset when it lands (see playNarration).
      introStartedAtMs = performance.now();
      playNarration();
      break;
    case "factionSelect":
      // Built lazily on first entry; both survive return visits (intro,
      // settings) with their loaded GLBs and thumbnails intact.
      if (!preview) preview = new ShipPreview();
      if (!menu) {
        menu = new LoadoutMenu(loadoutRoot!, preview, startGame, {
          firstRunIntro: () => {
            // The MODE → HANGAR gate: first-timers see the story cinematic
            // before choosing a side. Returns true when it intercepts (the
            // menu holds; finishIntro() advances it to the hangar after).
            if (hasSeenIntro()) return false;
            introReturn = "hangar";
            setState("intro");
            return true;
          },
          replayIntro: () => {
            introReturn = "stay";
            setState("intro");
          },
          openSettings: () => {
            settingsReturn = state;
            setState("settings");
          },
          openMapEditor: () => setState("mapEditor"),
          openManual,
        });
      }
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
    case "mapEditor":
      // Built lazily; the draft persists in localStorage across visits.
      if (!mapEditor) {
        mapEditor = new MapEditor(
          mapEditorRoot!,
          () => state === "mapEditor",
          () => setState("factionSelect"),
          (map) => {
            testFlightMap = map;
            startGame("solo");
          },
        );
      }
      // The root was display:none until now — size the canvas to it.
      mapEditor.onShown();
      break;
  }
  if (next !== "factionSelect") preview?.stop();
  // Leaving the intro tears the slideshow down (cancels its timeline) and
  // silences the voiceover; a return visit rebuilds both from the top.
  if (next !== "intro") {
    cinematic?.stop();
    stopNarration();
  }
}

/** Intro over (slideshow finished or skipped): back to the loadout —
 *  advancing into the hangar when the intro was the first-run MODE → HANGAR
 *  gate. */
function finishIntro(): void {
  markIntroSeen();
  const toHangar = introReturn === "hangar";
  introReturn = "stay";
  setState("factionSelect");
  // First-timers land in the hangar with the gold ROOKIE PILOTS callout
  // pointing at the Field Manual (LoadoutMenu.rookieCallout) — a link beats
  // a forced overlay, so the manual is never auto-opened.
  if (toHangar) menu?.enterHangar();
}

// End-of-match restart (Enter on the result banner): the flag's VALUE is the
// mode to relaunch — "online" rejoins a match, anything else relaunches solo.
const restartMode = sessionStorage.getItem(RESTART_FLAG);
if (restartMode) sessionStorage.removeItem(RESTART_FLAG);

if (restartMode && restartMode !== "online") {
  // Solo restart — the player already sat through the splash, so skip it and
  // relaunch the saved loadout directly. Audio resumes on their first
  // keypress (a reloaded page has no user gesture yet, so it can't resume
  // here). A map-editor TEST FLIGHT restart replays the draft (the flag
  // survives the reload in sessionStorage; the draft lives in localStorage),
  // so Enter-to-restart keeps iterating the same board.
  const draft = sessionStorage.getItem(TEST_FLIGHT_FLAG) ? loadDraftMap() : null;
  if (draft) applyMapConfig(draft);
  else applyActiveMap();
  applyActiveDifficulty();
  splash.classList.add("hidden");
  game = new Game(canvas, hudRoot, loadSavedLoadout());
  void game.start();
} else {
  // Everyone lands on the loadout frame (step 1: MODE). First-timers hit the
  // intro when they advance to the hangar; returning players get the gold
  // CONTINUE CTA for a one-press relaunch.
  setState("factionSelect");

  // Browsers hold the AudioContext until a user gesture — the first pointer
  // or key press on the splash starts (or resumes) the menu music. Guarded so
  // in-game input never resurrects it after launch (startGame stops it).
  const gestureUnlock = (): void => {
    if (!game && !netGame) unlockAudio();
  };
  window.addEventListener("pointerdown", gestureUnlock);
  window.addEventListener("keydown", gestureUnlock);

  skipBtn.addEventListener("click", finishIntro);

  window.addEventListener("keydown", (e) => {
    if (game || netGame) return;
    if (state === "settings") {
      // Enter must NOT launch the game while the user is editing inputs;
      // Esc mirrors the BACK button.
      if (e.code === "Escape") setState(settingsReturn);
      return;
    }
    if (state === "mapEditor") {
      // Same deal: the editor owns its keys (Delete etc.); Esc = BACK.
      if (e.code === "Escape") setState("factionSelect");
      return;
    }
    // Don't trap keyboard users in the slideshow — Enter skips ahead.
    // factionSelect's keys (Enter included) are owned by LoadoutMenu; its
    // handler runs first and preventDefault()s the Enter that STARTED the
    // intro (the step-1 advance), so that same keystroke must not also skip
    // the slideshow it just started.
    if (state === "intro" && e.code === "Enter" && !e.defaultPrevented) finishIntro();
  });

  // Online restart (Enter on the end banner of a networked match): the full
  // splash wiring above stays live, so a failed rejoin leaves a working menu
  // — the reconnect just fires immediately on top of the loadout screen.
  if (restartMode === "online") {
    void startOnline(loadSavedLoadout());
  }
}

window.addEventListener("resize", () => {
  game?.handleResize();
  netGame?.handleResize();
  preview?.resize();
});
