import type { Faction } from "./Faction";
import { GameConfig, type ShipTypeId } from "./GameConfig";

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
    // Non-essential — the player just sees the landing screen again next time.
  }
}
