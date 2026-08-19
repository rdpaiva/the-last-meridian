import { GameConfig } from "./GameConfig";

/**
 * Difficulty presets — a named bundle of ENEMY-skill tuning, the AI-opposition
 * sibling of the arena catalog (Maps.ts). Shared because BOTH loops apply it:
 * solo the client writes it into its own GameConfig at launch; online the
 * ROOM owns the difficulty — the creator's pick rides JoinOptions, BattleRoom
 * applies it server-side before the sim constructs (the AI pilots live in the
 * server's BattleSim; a client-side apply would tune nobody), and the concrete
 * id replicates as BattleState.difficulty. Joiners inherit the room's level.
 *
 * Difficulty changes how sharp and aggressive the AI opposition is; it does
 * NOT touch the player's own side (the allied wing is a fixed baseline — see
 * GameConfig.player.wingmen).
 *
 * PRECEDENCE: like Maps, a knob is written only when the player hasn't
 * hand-tuned it in match settings — the injectable `hooks` parameter (client
 * solo passes ConfigOverrides' predicate; server/online applies cleanly over
 * stock config). Difficulty and Maps touch disjoint knobs (Maps = battlefield
 * setup; difficulty = ai/commander), so their apply order doesn't matter.
 *
 * The knobs are the enemy's reflexes (`ai.reactionSec`), willingness/accuracy
 * (`ai.fireConeAngle`, `ai.fireRange`, `ai.engagementRange`), missile pressure
 * (`ai.missileCooldownSec`, `ai.missileMaxRange`), and how many fleet ships
 * actively press you (`commander.escortCount`, `commander.huntCount`).
 *
 * SERVER CAVEAT (same as applyMap): GameConfig is a process-wide singleton, so
 * on a multi-room server the LAST-created room's difficulty owns the global
 * values. The AI reads its knobs at CONSTRUCTION time (AIController copies its
 * config), so existing rooms keep the skill level they were built with.
 */

export type DifficultyId = "easy" | "medium" | "hard";

/** Menu order, easiest first. */
export const DIFFICULTY_ORDER: readonly DifficultyId[] = ["easy", "medium", "hard"];

export function isDifficultyId(v: unknown): v is DifficultyId {
  return v === "easy" || v === "medium" || v === "hard";
}

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
      "ai.reactionSec": 0.7,
      "ai.engagementRange": 85,
      "ai.fireRange": 20,
      "ai.fireConeAngle": 0.1,
      "ai.missileCooldownSec": 18,
      "ai.missileMaxRange": 65,
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
      "ai.engagementRange": 140,
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
      "ai.engagementRange": 180,
      "ai.fireRange": 28,
      "ai.fireConeAngle": 0.26,
      "ai.missileCooldownSec": 6,
      "ai.missileMaxRange": 120,
      "commander.escortCount": 3,
      "commander.huntCount": 3,
    },
  },
};

/**
 * The match-settings override predicate applyDifficulty consults so a
 * hand-tuned knob beats the difficulty baseline (subset of MapOverrideHooks —
 * difficulty knobs are all exact dot-paths, no prefix checks needed). Client
 * solo passes ConfigOverrides' predicate; omitting it (server, online) means
 * "nothing overridden".
 */
export interface DifficultyOverrideHooks {
  /** Is this exact dot-path knob overridden in match settings? */
  isOverridden(path: string): boolean;
}

const NO_OVERRIDES: DifficultyOverrideHooks = { isOverridden: () => false };

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
 * ONCE at startup, BEFORE any sim constructs (solo client: after
 * applyStoredOverrides, alongside applyMap; server: in BattleRoom.onCreate).
 */
export function applyDifficulty(
  id: DifficultyId,
  hooks: DifficultyOverrideHooks = NO_OVERRIDES,
): void {
  const cfg = DIFFICULTIES[id];
  for (const [path, value] of Object.entries(cfg.knobs)) {
    if (hooks.isOverridden(path)) continue; // explicit match-settings override wins
    deepSet(GameConfig, path, value);
  }
}
