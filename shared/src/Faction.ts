import { Color3 } from "@babylonjs/core/Maths/math.color";

/**
 * The two warring sides of *The Last Meridian* (see
 * docs/The-Last-Meridian-Story-Bible.md for the canon). Everything that used
 * to be hardcoded as "player" (blue, south) vs "enemy" (red, north) is now
 * keyed off this so either side can be flown by a human, an AI, or —
 * eventually — a remote network peer. The "player" is simply whichever Ship
 * carries a LocalInputController; it is NOT baked into the faction.
 *
 * The string keys stay `humans`/`machines` (they thread through GameConfig,
 * save state, and every subsystem); the canon names live in FACTION_THEME.
 *
 *   humans   — the Meridian Commonwealth: surviving baseline humanity. Cool
 *              blue hulls, hot-pink lasers. Player flies for this side by
 *              default (GameConfig.player.faction).
 *   machines — the Novari Ascendancy: enhanced humans bound to the Loom-built
 *              Thread. Crimson hulls, electric-green lasers.
 */
export type Faction = "humans" | "machines";

/** Returns the opposing faction. */
export function opposing(faction: Faction): Faction {
  return faction === "humans" ? "machines" : "humans";
}

/**
 * Per-faction visual + label theme. Laser colors preserve the original
 * player(pink)/enemy(green) palette so the refactor is visually identical
 * to before; the fighter-mesh colors mirror the old EnemyShip crimson for
 * machines and a cool blue for humans (used when a faction fields procedural
 * AI fighters — the human player's own ship still comes from AssetLoader).
 */
export interface FactionTheme {
  /** Short all-caps label for the HUD (e.g. mothership objective bars). */
  label: string;
  /** Full canon faction name (story bible §2). */
  fullName: string;
  /** Canon mothership class (e.g. "Bastion Carrier"). */
  mothershipClass: string;
  /** Canon named flagship of this faction (e.g. "MCS Aegis"). */
  mothershipName: string;
  /** Canon dogfighter type — the procedural fighter this faction fields. */
  fighterClass: string;
  /** Canon heavy strike craft type (story bible §8). */
  gunshipClass: string;
  /** Emissive RGB of this faction's LIGHT (fighter) laser bolts (components > 1
   *  bloom harder). */
  laserEmissive: Color3;
  /** Emissive RGB of this faction's HEAVY (gunship) laser bolts — a hue-shifted
   *  cousin of laserEmissive so a Breaker/Reaver's fire reads as the same
   *  faction but heavier ordnance (and distinct from the orange turret flak). */
  laserHeavyEmissive: Color3;
  /** Material name for this faction's laser bolts (inspector aid). */
  laserMaterialName: string;
  /** Procedural fighter body color. */
  bodyColor: Color3;
  /** Procedural fighter wing color. */
  wingColor: Color3;
  /** Procedural fighter engine emissive (glow-layer). */
  engineEmissive: Color3;
  /** Procedural fighter nose "eye" emissive (glow-layer). */
  eyeEmissive: Color3;
  /**
   * Standard exhaust burn for this faction's GLB fighters (EngineGlow
   * idle→hot) — an always-on friend-or-foe cue in the furball: Commonwealth
   * engines burn blue, Novari burn red. The local player's own ship wears
   * `GameConfig.ownShipTint` (teal) instead, so "you" still reads distinct
   * from your own wing.
   */
  engineIdle: Color3;
  engineHot: Color3;
}

export const FACTION_THEME: Record<Faction, FactionTheme> = {
  humans: {
    label: "COMMONWEALTH",
    fullName: "The Meridian Commonwealth",
    mothershipClass: "Bastion Carrier",
    mothershipName: "MCS Aegis",
    fighterClass: "Spitfire Interceptor",
    gunshipClass: "Breaker Gunship",
    laserEmissive: new Color3(2.0, 0.6, 0.9), // hot pink (old player)
    laserHeavyEmissive: new Color3(0.5, 0.7, 2.8), // electric blue (Breaker) — warm pink → cool blue reads clearly distinct
    laserMaterialName: "humans_laser_mat",
    bodyColor: new Color3(0.16, 0.24, 0.5),
    wingColor: new Color3(0.12, 0.18, 0.36),
    engineEmissive: new Color3(0.5, 0.8, 1.8),
    eyeEmissive: new Color3(0.6, 0.9, 1.8),
    engineIdle: new Color3(0.08, 0.16, 0.38),
    engineHot: new Color3(0.55, 1.1, 2.4),
  },
  machines: {
    label: "NOVARI",
    fullName: "The Novari Ascendancy",
    mothershipClass: "Choirship",
    mothershipName: "The Silent Choir",
    fighterClass: "Wraith Interceptor",
    gunshipClass: "Reaver Gunship",
    laserEmissive: new Color3(0.3, 2.0, 0.6), // electric green (old enemy)
    laserHeavyEmissive: new Color3(0.25, 1.9, 1.5), // teal/aqua (Reaver)
    laserMaterialName: "machines_laser_mat",
    bodyColor: new Color3(0.5, 0.12, 0.14),
    wingColor: new Color3(0.35, 0.1, 0.12),
    engineEmissive: new Color3(1.6, 0.25, 0.15),
    eyeEmissive: new Color3(1.8, 0.3, 0.2),
    engineIdle: new Color3(0.32, 0.08, 0.05),
    engineHot: new Color3(2.2, 0.5, 0.28),
  },
};

/**
 * A faction's standard exhaust palette in the shape EngineGlow's `palette`
 * option takes (Color3 satisfies `{r,g,b}` structurally). Construction-time
 * helper — one small object per ship, never per frame.
 */
export function factionExhaust(faction: Faction): {
  idle: { r: number; g: number; b: number };
  hot: { r: number; g: number; b: number };
} {
  const theme = FACTION_THEME[faction];
  return { idle: theme.engineIdle, hot: theme.engineHot };
}
