import {
  applyDifficulty as applySharedDifficulty,
  isDifficultyId,
  type DifficultyId,
} from "@space-duel/shared";
import { isOverridden } from "./ConfigOverrides";

/**
 * Client shim over the SHARED difficulty catalog (shared/Difficulty.ts) —
 * same shape as Maps.ts over the shared arena catalog. The presets themselves
 * live shared so the server can apply them too; this file owns what's
 * client-only: selection persistence and the SOLO applier that wires the
 * ConfigOverrides precedence in (an explicit match-settings override beats
 * the difficulty baseline).
 *
 * Online the ROOM owns the difficulty: the creator's pick rides JoinOptions,
 * BattleRoom validates + applies it server-side (where the AI pilots actually
 * live), and joiners inherit it via the replicated BattleState.difficulty —
 * the client never applies difficulty locally for an online match.
 */

export {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  type DifficultyConfig,
  type DifficultyId,
} from "@space-duel/shared";
export { isDifficultyId };

// ─── Persistence ─────────────────────────────────────────────────────────────
// Persists alongside the loadout + map (its own `lastMeridian_*` key). Default
// "medium" — a fair fight out of the box.

const KEY = "lastMeridian_difficulty";

/** The persisted difficulty, defaulting to "medium" (also the fallback for an
 *  unknown/corrupt/missing stored value). */
export function loadSavedDifficulty(): DifficultyId {
  try {
    const v = localStorage.getItem(KEY);
    return isDifficultyId(v) ? v : "medium";
  } catch {
    return "medium";
  }
}

/** Persist the player's difficulty selection (written by the picker UI). */
export function saveDifficulty(id: DifficultyId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Storage unavailable (private mode etc.) — the selection just won't persist.
  }
}

/**
 * SOLO launch: write the difficulty's enemy-skill knobs into the live
 * GameConfig with match-settings precedence. Call ONCE at startup, after
 * applyStoredOverrides and before `new Game(...)`.
 */
export function applyDifficulty(id: DifficultyId): void {
  applySharedDifficulty(id, { isOverridden });
}
