import type { Faction } from "@space-duel/shared";
import { GameConfig, sanitizePilotName, type ShipTypeId } from "@space-duel/shared";

/**
 * What the pilot chose on the splash loadout menu: which side to fly, in which
 * ship. Game copies it at construction (GameConfig stays the read-only
 * defaults); the splash flow persists it so quick play, the end-of-match
 * restart, and the next session all relaunch the same setup without touching
 * the menu.
 *
 * Persistence is split across `lastMeridian_*` localStorage keys:
 *   lastMeridian_faction    "humans" | "machines"
 *   lastMeridian_ship       a ShipTypeId from the catalog
 *   lastMeridian_introSeen  "true" once the story crawl finished or was skipped
 *
 * Whether a SAVED loadout exists (hasSavedLoadout) is a separate question from
 * what loadout to USE (loadSavedLoadout, which falls back to the GameConfig
 * defaults) — the splash only offers the quick-play screen for a real save.
 */
export interface PlayerLoadout {
  faction: Faction;
  shipType: ShipTypeId;
}

const FACTION_KEY = "lastMeridian_faction";
const SHIP_KEY = "lastMeridian_ship";
const INTRO_KEY = "lastMeridian_introSeen";
const GUIDE_KEY = "lastMeridian_guideSeen";
const PILOT_NAME_KEY = "lastMeridian_pilotName";
const MODE_KEY = "lastMeridian_mode";
/** Pre-rename single-JSON key — still read as a fallback, removed on save. */
const LEGACY_KEY = "space-duel-loadout";

/** The build-time defaults (GameConfig.player) as a loadout. */
export function defaultLoadout(): PlayerLoadout {
  return {
    faction: GameConfig.player.faction,
    shipType: GameConfig.player.shipType,
  };
}

/**
 * Clamp raw stored values to the current faction rosters — a saved ship that
 * no longer exists (or belongs to the other side) falls back to the faction's
 * first ship; an unknown faction falls back to humans.
 */
function validate(faction: unknown, shipType: unknown): PlayerLoadout {
  const f: Faction = faction === "machines" ? "machines" : "humans";
  const ships = GameConfig.factionShips[f];
  const s = ships.includes(shipType as ShipTypeId)
    ? (shipType as ShipTypeId)
    : ships[0];
  return { faction: f, shipType: s };
}

/**
 * The last loadout chosen on the menu, validated against the current faction
 * rosters; anything missing or unparseable falls back to GameConfig defaults.
 */
export function loadSavedLoadout(): PlayerLoadout {
  try {
    const faction = localStorage.getItem(FACTION_KEY);
    const shipType = localStorage.getItem(SHIP_KEY);
    if (faction && shipType) return validate(faction, shipType);

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Partial<PlayerLoadout>;
      return validate(parsed.faction, parsed.shipType);
    }
    return defaultLoadout();
  } catch {
    return defaultLoadout();
  }
}

/**
 * True when the player has actually picked a loadout before (under either the
 * current keys or the legacy one) — the gate for the quick-play screen.
 */
export function hasSavedLoadout(): boolean {
  try {
    return (
      (localStorage.getItem(FACTION_KEY) !== null &&
        localStorage.getItem(SHIP_KEY) !== null) ||
      localStorage.getItem(LEGACY_KEY) !== null
    );
  } catch {
    return false;
  }
}

export function saveLoadout(loadout: PlayerLoadout): void {
  try {
    localStorage.setItem(FACTION_KEY, loadout.faction);
    localStorage.setItem(SHIP_KEY, loadout.shipType);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage unavailable (private mode etc.) — the choice just won't persist.
  }
}

/**
 * The persisted pilot name (callsign the player wears online), sanitized on
 * the way out. "" = never entered / nothing usable — the server falls back
 * to the seat's AI callsign.
 */
export function loadPilotName(): string {
  try {
    return sanitizePilotName(localStorage.getItem(PILOT_NAME_KEY) ?? "");
  } catch {
    return "";
  }
}

export function savePilotName(name: string): void {
  try {
    localStorage.setItem(PILOT_NAME_KEY, sanitizePilotName(name));
  } catch {
    // Storage unavailable — the name just won't persist across sessions.
  }
}

/**
 * The launch mode picked on the splash mode screen ("solo" | "online"),
 * persisted like every other loadout selection so the menu reopens on the
 * mode the pilot last flew. An invite link in the URL overrides the saved
 * value at menu construction (the player came to join a friend).
 */
export function loadSavedMode(): "solo" | "online" {
  try {
    return localStorage.getItem(MODE_KEY) === "online" ? "online" : "solo";
  } catch {
    return "solo";
  }
}

export function saveMode(mode: "solo" | "online"): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage unavailable — the mode just won't persist across sessions.
  }
}

/** True once the story crawl has been watched to the end or skipped. */
export function hasSeenIntro(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === "true";
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_KEY, "true");
  } catch {
    // Non-essential — the player just gets the intro gate again next time.
  }
}

/** True once the Field Manual has been opened (auto-open happens only once,
 *  right after the first-run intro — the footer link covers everyone else). */
export function hasSeenGuide(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === "true";
  } catch {
    return false;
  }
}

export function markGuideSeen(): void {
  try {
    localStorage.setItem(GUIDE_KEY, "true");
  } catch {
    // Non-essential — the manual just auto-opens again next first run.
  }
}
