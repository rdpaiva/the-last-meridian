import {
  applyMap as applySharedMap,
  isMapSelection,
  type ConcreteMapId,
  type MapId,
} from "@space-duel/shared";
import { isOverridden, hasOverrideUnder } from "./ConfigOverrides";

/**
 * Client face of the arena / map system (docs/ARENA-MAPS.md). The catalog and
 * the config-writing applier live in SHARED (shared/src/Maps.ts) so the server
 * can apply the same map before constructing the BattleSim (online, the server
 * owns the arena). This module keeps the two client-only pieces:
 *
 *  - PERSISTENCE of the player's selection (localStorage, lastMeridian_map);
 *  - the SOLO applier, which wires the ConfigOverrides predicates in so a
 *    hand-tuned match-settings knob beats the map baseline. Online, main.ts
 *    applies the SERVER's replicated map with the shared applier directly
 *    (no override hooks — the board must match the server exactly).
 */

// The catalog + types re-exported for the menus (LoadoutMenu's picker cards).
export { MAPS, resolveMapId, isMapSelection } from "@space-duel/shared";
export type { MapId, ConcreteMapId, MapConfig } from "@space-duel/shared";

// ─── Persistence ─────────────────────────────────────────────────────────────
// The map SELECTION persists alongside the loadout (Loadout.ts owns faction/
// ship; the map is a separate `lastMeridian_*` key, NOT a PlayerLoadout field,
// since the map applies via GameConfig rather than being passed to `new Game`).
//
// What's stored is the selection, not the resolved map: a concrete id PINS that
// map; "random" RE-ROLLS each launch (resolveMapId runs per page load, and the
// end-of-match restart is a fresh reload, so a new map is picked every match).

const MAP_KEY = "lastMeridian_map";

/** The persisted map selection. Defaults to "random" so matches vary out of
 *  the box; an unknown/corrupt/missing stored value falls back the same way. */
export function loadSavedMapSelection(): MapId {
  try {
    const v = localStorage.getItem(MAP_KEY);
    return isMapSelection(v) ? v : "random";
  } catch {
    return "random";
  }
}

/** Persist the player's map selection (written by the loadout menu's picker). */
export function saveMapSelection(selection: MapId): void {
  try {
    localStorage.setItem(MAP_KEY, selection);
  } catch {
    // Storage unavailable (private mode etc.) — the selection just won't persist.
  }
}

/**
 * SOLO map application: write the map into the live GameConfig with the
 * match-settings override predicates wired in (a hand-tuned knob beats the
 * map baseline). Call ONCE at launch, AFTER applyStoredOverrides and BEFORE
 * `new Game(...)`.
 */
export function applyMap(id: ConcreteMapId): void {
  applySharedMap(id, { isOverridden, hasOverrideUnder });
}
