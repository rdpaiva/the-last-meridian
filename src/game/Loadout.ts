import type { Faction } from "./Faction";
import { GameConfig, type ShipTypeId } from "./GameConfig";

/**
 * What the pilot chose on the splash loadout menu: which side to fly, in which
 * ship. Game copies it at construction (GameConfig stays the read-only
 * defaults); main.ts persists it so the end-of-match restart — and the next
 * session — relaunch the same setup without touching the menu.
 */
export interface PlayerLoadout {
  faction: Faction;
  shipType: ShipTypeId;
}

const STORAGE_KEY = "space-duel-loadout";

/** The build-time defaults (GameConfig.player) as a loadout. */
export function defaultLoadout(): PlayerLoadout {
  return {
    faction: GameConfig.player.faction,
    shipType: GameConfig.player.shipType,
  };
}

/**
 * The last loadout chosen on the menu, validated against the current faction
 * rosters — a saved ship that no longer exists (or belongs to the other side)
 * falls back to the faction's first ship; anything unparseable falls back to
 * the GameConfig defaults.
 */
export function loadSavedLoadout(): PlayerLoadout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLoadout();
    const parsed = JSON.parse(raw) as Partial<PlayerLoadout>;
    const faction: Faction = parsed.faction === "machines" ? "machines" : "humans";
    const ships = GameConfig.factionShips[faction];
    const shipType = ships.includes(parsed.shipType as ShipTypeId)
      ? (parsed.shipType as ShipTypeId)
      : ships[0];
    return { faction, shipType };
  } catch {
    return defaultLoadout();
  }
}

export function saveLoadout(loadout: PlayerLoadout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loadout));
  } catch {
    // Storage unavailable (private mode etc.) — the choice just won't persist.
  }
}
