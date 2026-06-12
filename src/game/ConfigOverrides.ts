import { GameConfig } from "./GameConfig";
import { findTuningEntry, TUNING_SCHEMA, type TuningEntry } from "./TuningSchema";

/**
 * Persistence + application for the match-settings overrides (SettingsMenu).
 *
 * The model: GameConfig stays the read-only DEFAULTS in source; this module
 * holds a sparse map of { dot-path → value } for just the knobs the user
 * changed (localStorage `lastMeridian_tuning`), and writes them INTO the live
 * GameConfig object. Because every system copies its config at construction,
 * the only requirement is that `applyStoredOverrides()` runs before the first
 * `new Game(...)` — main.ts calls it at module init, ahead of both the splash
 * flow and the end-of-match restart path.
 *
 * Every value is validated against TUNING_SCHEMA (known path, clamped to its
 * bounds) on load, on set, and on import — a hand-edited JSON blob can't push
 * an out-of-range value into the sim.
 *
 * The export/import JSON blob (a flat { path: value } object) is the
 * tester-sharing format today and the planned multiplayer host match-config
 * document tomorrow (docs/MULTIPLAYER.md).
 */

export type OverrideValue = number | boolean | string;

const STORAGE_KEY = "lastMeridian_tuning";

/** The active overrides (mirrors localStorage). */
let overrides: Record<string, OverrideValue> = {};

/**
 * Source defaults for every schema path, captured from GameConfig BEFORE any
 * override is written into it — what "reset" restores and what the menu shows
 * as "(default N)".
 */
const defaults = new Map<string, OverrideValue>();
let defaultsCaptured = false;

function deepGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function deepSet(obj: unknown, path: string, value: OverrideValue): void {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (cur === null || typeof cur !== "object") return;
  (cur as Record<string, OverrideValue>)[parts[parts.length - 1]] = value;
}

function captureDefaults(): void {
  if (defaultsCaptured) return;
  defaultsCaptured = true;
  for (const group of TUNING_SCHEMA) {
    for (const entry of group.entries) {
      const v = deepGet(GameConfig, entry.path);
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
        defaults.set(entry.path, v);
      }
    }
  }
}

/**
 * Clamp/coerce a raw value to an entry's schema. Returns undefined when the
 * value is unusable (wrong type, non-finite) — callers drop the override.
 */
function sanitize(entry: TuningEntry, raw: unknown): OverrideValue | undefined {
  if (entry.kind === "boolean") {
    return typeof raw === "boolean" ? raw : undefined;
  }
  if (entry.kind === "choice") {
    return typeof raw === "string" && entry.options?.some((o) => o.value === raw)
      ? raw
      : undefined;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  let v = Math.min(entry.max ?? raw, Math.max(entry.min ?? raw, raw));
  // Integer steps stay integers; fractional steps just shed float noise.
  v = (entry.step ?? 1) >= 1 ? Math.round(v) : Math.round(v * 10000) / 10000;
  return v;
}

function persist(): void {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // Storage unavailable (private mode etc.) — overrides last this session.
  }
}

/**
 * Validate a raw { path: value } object into a clean overrides map. Unknown
 * paths and unusable values are skipped (counted for the caller's status
 * line), in-range values are clamped — the one entry point all external data
 * (localStorage, pasted JSON) flows through.
 */
function sanitizeMap(raw: unknown): {
  clean: Record<string, OverrideValue>;
  applied: number;
  skipped: number;
} {
  const clean: Record<string, OverrideValue> = {};
  let applied = 0;
  let skipped = 0;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = findTuningEntry(path);
      const v = entry ? sanitize(entry, value) : undefined;
      if (entry && v !== undefined && v !== defaults.get(path)) {
        clean[path] = v;
        applied++;
      } else if (v === undefined) {
        skipped++;
      }
    }
  }
  return { clean, applied, skipped };
}

/**
 * Load the persisted overrides and write them into GameConfig. Call ONCE at
 * startup, before anything constructs off the config. Idempotent enough for
 * dev double-init (defaults are captured first, so re-applying is harmless).
 */
export function applyStoredOverrides(): void {
  captureDefaults();
  let raw: unknown = null;
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json) raw = JSON.parse(json);
  } catch {
    raw = null; // unreadable/corrupt → run on defaults
  }
  overrides = sanitizeMap(raw).clean;
  for (const [path, value] of Object.entries(overrides)) {
    deepSet(GameConfig, path, value);
  }
}

/** The live value of a schema path (defaults + any override applied). */
export function getTuningValue(path: string): OverrideValue | undefined {
  captureDefaults();
  const v = deepGet(GameConfig, path);
  return typeof v === "number" || typeof v === "boolean" || typeof v === "string"
    ? v
    : undefined;
}

/** The source-default value of a schema path. */
export function getTuningDefault(path: string): OverrideValue | undefined {
  captureDefaults();
  return defaults.get(path);
}

export function isOverridden(path: string): boolean {
  return path in overrides;
}

export function overrideCount(): number {
  return Object.keys(overrides).length;
}

/**
 * Set one knob: clamp to schema, write into the live GameConfig, and persist
 * (a value equal to its default clears the override instead). Returns the
 * clamped value actually applied, or undefined for an unknown path/bad value.
 */
export function setTuningValue(path: string, raw: OverrideValue): OverrideValue | undefined {
  captureDefaults();
  const entry = findTuningEntry(path);
  if (!entry) return undefined;
  const v = sanitize(entry, raw);
  if (v === undefined) return undefined;
  deepSet(GameConfig, path, v);
  if (v === defaults.get(path)) {
    delete overrides[path];
  } else {
    overrides[path] = v;
  }
  persist();
  return v;
}

/** Restore one knob to its source default. */
export function resetTuningValue(path: string): void {
  captureDefaults();
  const def = defaults.get(path);
  if (def === undefined) return;
  deepSet(GameConfig, path, def);
  delete overrides[path];
  persist();
}

/** Restore EVERY knob to its source default and clear the persisted blob. */
export function resetAllTuning(): void {
  captureDefaults();
  for (const [path, def] of defaults) deepSet(GameConfig, path, def);
  overrides = {};
  persist();
}

/** The current overrides as the shareable JSON blob ("{}" when on defaults). */
export function exportTuningJson(): string {
  return JSON.stringify(overrides, null, 2);
}

/**
 * REPLACE the current overrides with a pasted JSON blob: defaults are
 * restored first, then every valid entry is applied + persisted. Returns the
 * applied/skipped counts for a status line, or null if the text isn't JSON.
 */
export function importTuningJson(json: string): { applied: number; skipped: number } | null {
  captureDefaults();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { clean, applied, skipped } = sanitizeMap(raw);
  resetAllTuning();
  overrides = clean;
  for (const [path, value] of Object.entries(overrides)) {
    deepSet(GameConfig, path, value);
  }
  persist();
  return { applied, skipped };
}
