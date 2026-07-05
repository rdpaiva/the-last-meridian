import { GameConfig } from "@space-duel/shared";
import { isOverridden } from "./ConfigOverrides";

/**
 * Difficulty presets — a named bundle of ENEMY-skill tuning chosen on the
 * splash menu, parallel to the arena Map (see Maps.ts). Difficulty changes how
 * sharp and aggressive the AI opposition is; it does NOT touch the player's own
 * side (the allied wing is a fixed baseline — see GameConfig.player.wingmen).
 *
 * HOW IT'S APPLIED: like Maps, `applyDifficulty` writes its knobs INTO the live
 * GameConfig at startup, before any system constructs (every system copies its
 * config at construction). Call it once per launch, alongside applyMap.
 *
 * PRECEDENCE: a knob is written ONLY when the player hasn't hand-tuned it in
 * match settings (ConfigOverrides) — same rule Maps uses, so an explicit
 * override always beats the difficulty baseline. Difficulty and Maps touch
 * disjoint knobs (Maps = battlefield setup; difficulty = ai/commander), so
 * their apply order doesn't matter.
 *
 * The knobs are the enemy's reflexes (`ai.reactionSec`), willingness/accuracy
 * (`ai.fireConeAngle`, `ai.fireRange`, `ai.engagementRange`), missile pressure
 * (`ai.missileCooldownSec`, `ai.missileMaxRange`), and how many fleet ships
 * actively press you (`commander.escortCount`, `commander.huntCount`).
 */

export type DifficultyId = "easy" | "medium" | "hard";

/** Menu order, easiest first. */
export const DIFFICULTY_ORDER: readonly DifficultyId[] = ["easy", "medium", "hard"];

export interface DifficultyConfig {
  id: DifficultyId;
  /** Splash card title. */
  name: string;
  /** One-line flavor for the card. */
  blurb: string;
  /** Sparse GameConfig overrides (dot-path → value) this level applies. */
  knobs: Record<string, number>;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyConfig> = {
  easy: {
    id: "easy",
    name: "Easy",
    blurb: "Green pilots. Slow to react, hold their fire, hunt you in ones.",
    knobs: {
      "ai.reactionSec": 0.55,
      "ai.engagementRange": 30,
      "ai.fireRange": 22,
      "ai.fireConeAngle": 0.14,
      "ai.missileCooldownSec": 14,
      "ai.missileMaxRange": 80,
      "commander.escortCount": 1,
      "commander.huntCount": 1,
    },
  },
  medium: {
    id: "medium",
    name: "Normal",
    blurb: "A fair fight. Competent enemies that press but won't overwhelm you.",
    knobs: {
      "ai.reactionSec": 0.4,
      "ai.engagementRange": 33,
      "ai.fireRange": 24,
      "ai.fireConeAngle": 0.19,
      "ai.missileCooldownSec": 9,
      "ai.missileMaxRange": 100,
      "commander.escortCount": 2,
      "commander.huntCount": 2,
    },
  },
  hard: {
    id: "hard",
    name: "Hard",
    blurb: "Ace squadrons. Fast reflexes, accurate guns, missiles and packs on you.",
    knobs: {
      "ai.reactionSec": 0.22,
      "ai.engagementRange": 38,
      "ai.fireRange": 28,
      "ai.fireConeAngle": 0.26,
      "ai.missileCooldownSec": 6,
      "ai.missileMaxRange": 120,
      "commander.escortCount": 3,
      "commander.huntCount": 3,
    },
  },
};

// ─── Persistence ─────────────────────────────────────────────────────────────
// Persists alongside the loadout + map (its own `lastMeridian_*` key). Default
// "medium" — a fair fight out of the box.

const KEY = "lastMeridian_difficulty";

function isValid(v: unknown): v is DifficultyId {
  return v === "easy" || v === "medium" || v === "hard";
}

/** The persisted difficulty, defaulting to "medium" (also the fallback for an
 *  unknown/corrupt/missing stored value). */
export function loadSavedDifficulty(): DifficultyId {
  try {
    const v = localStorage.getItem(KEY);
    return isValid(v) ? v : "medium";
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

function deepSet(obj: unknown, path: string, value: number): void {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (cur === null || typeof cur !== "object") return;
  (cur as Record<string, number>)[parts[parts.length - 1]] = value;
}

/**
 * Write a difficulty level's enemy-skill knobs into the live GameConfig. Call
 * ONCE at startup, after applyStoredOverrides (so a hand-tuned knob wins) and
 * before `new Game(...)`.
 */
export function applyDifficulty(id: DifficultyId): void {
  const cfg = DIFFICULTIES[id];
  for (const [path, value] of Object.entries(cfg.knobs)) {
    if (isOverridden(path)) continue; // explicit match-settings override wins
    deepSet(GameConfig, path, value);
  }
}
