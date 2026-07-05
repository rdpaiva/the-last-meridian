import type { Faction } from "./Faction";

/**
 * AI pilot callsigns — the naming canon lives in
 * docs/The-Last-Meridian-Story-Bible.md; these schemes are derived from it
 * so bots aren't anonymous (owner ask 2026-07-05). Owner direction
 * (2026-07-05 review): two-word handles, NO numbers.
 *
 *   humans   — Commonwealth pilot handles: [gritty adjective] + [animal /
 *              cavalry noun] — "Blue Fox", "Iron Hawk", "Storm Jackal".
 *              Old-school military radio energy, per the bible's "human
 *              courage, instinct, and old-school military grit".
 *   machines — Novari choir names: [cold/still adjective] + [choral term] —
 *              "Silent Psalm", "Glass Hymn", "Winter Chord". The Choirship
 *              "does not simply command, it harmonizes"; "Thread" is the
 *              canon Novari neural architecture.
 *
 * HONESTY RULE (docs/MULTIPLAYER.md): these are for AI seats only. Human
 * pilots wear the name they typed, and the client styles the two visibly
 * differently — a generated scheme must never pass as a person.
 *
 * Deterministic by (faction, seat index): the server, the offline Game, and
 * any test all name the same fleet the same way, with nothing on the wire
 * beyond the resulting string.
 */

const HUMAN_FIRST = [
  "Blue",
  "Iron",
  "Storm",
  "Ghost",
  "Lucky",
  "Black",
  "Copper",
  "Wild",
  "Steel",
  "Dust",
] as const;

const HUMAN_SECOND = [
  "Fox",
  "Wolf",
  "Hawk",
  "Mustang",
  "Bulldog",
  "Raven",
  "Jackal",
  "Boar",
  "Stag",
  "Arrow",
] as const;

const MACHINE_FIRST = [
  "Silent",
  "Pale",
  "Hollow",
  "Glass",
  "Silver",
  "Winter",
  "Still",
  "Mirror",
  "Faint",
  "Thread",
] as const;

const MACHINE_SECOND = [
  "Hymn",
  "Psalm",
  "Chord",
  "Bell",
  "Cadence",
  "Vesper",
  "Refrain",
  "Descant",
  "Antiphon",
  "Motet",
] as const;

/**
 * Pair the two lists on a shifted diagonal: consecutive seats change BOTH
 * words ("Blue Fox", "Iron Wolf", "Storm Hawk" — never "Blue Fox",
 * "Blue Wolf"), and every combo stays unique until first×second seats
 * (10×10 = 100; a fleet fields ~10 per side).
 */
function pair(
  first: readonly string[],
  second: readonly string[],
  index: number,
): string {
  const a = index % first.length;
  const b = (index + Math.floor(index / first.length)) % second.length;
  return `${first[a]} ${second[b]}`;
}

/** The AI callsign for seat `index` (0-based, per faction) of `faction`. */
export function aiCallsign(faction: Faction, index: number): string {
  return faction === "humans"
    ? pair(HUMAN_FIRST, HUMAN_SECOND, index)
    : pair(MACHINE_FIRST, MACHINE_SECOND, index);
}

/** Longest name a human pilot can wear (HUD nameplates stay one short line). */
export const PILOT_NAME_MAX = 16;

/**
 * Normalize a player-entered pilot name for the wire + nameplates: printable
 * characters only, collapsed whitespace, length-capped. Returns "" when
 * nothing usable remains — callers fall back to the seat's AI callsign, so an
 * empty name can't produce an anonymous ship. Runs on BOTH sides (client
 * before send, server on join) so the replicated string is safe regardless of
 * what a modified client sends.
 */
export function sanitizePilotName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[^\x20-\x7E]/g, "") // printable ASCII — keeps DOM + logs simple
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PILOT_NAME_MAX)
    .trim();
}
