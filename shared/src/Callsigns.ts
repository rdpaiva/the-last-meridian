import type { Faction } from "./Faction";

/**
 * AI pilot callsigns — the naming canon lives in
 * docs/The-Last-Meridian-Story-Bible.md; these schemes are derived from it
 * so bots aren't anonymous (owner ask 2026-07-05):
 *
 *   humans   — Commonwealth squadron style: flights of four under a gritty
 *              squadron name ("Saber 1" … "Saber 4", then "Dagger 1" …).
 *              Old-school military radio discipline, per the bible's
 *              "human courage, instinct, and old-school military grit".
 *   machines — Novari choir voices: the Choirship "does not simply command,
 *              it harmonizes", so its pilots are named as voices in the
 *              choir, machine-styled with a dash and a zero-padded index
 *              ("Cantor-01" … "Cantor-04", then "Descant-01" …).
 *
 * HONESTY RULE (docs/MULTIPLAYER.md): these are for AI seats only. Human
 * pilots wear the name they typed, and the client styles the two visibly
 * differently — a generated scheme must never pass as a person.
 *
 * Deterministic by (faction, seat index): the server, the offline Game, and
 * any test all name the same fleet the same way, with nothing on the wire
 * beyond the resulting string.
 */

const HUMAN_SQUADRONS = [
  "Saber",
  "Dagger",
  "Anvil",
  "Talon",
  "Longbow",
  "Vanguard",
] as const;

const MACHINE_VOICES = [
  "Cantor",
  "Descant",
  "Vesper",
  "Antiphon",
  "Chorale",
  "Motet",
] as const;

/** Pilots per squadron/voice block before the next name starts. */
const FLIGHT_SIZE = 4;

/** The AI callsign for seat `index` (0-based, per faction) of `faction`. */
export function aiCallsign(faction: Faction, index: number): string {
  const block = Math.floor(index / FLIGHT_SIZE);
  const member = (index % FLIGHT_SIZE) + 1;
  if (faction === "humans") {
    const squadron = HUMAN_SQUADRONS[block % HUMAN_SQUADRONS.length];
    return `${squadron} ${member}`;
  }
  const voice = MACHINE_VOICES[block % MACHINE_VOICES.length];
  return `${voice}-${String(member).padStart(2, "0")}`;
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
