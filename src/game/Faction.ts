import { Color3 } from "@babylonjs/core/Maths/math.color";

/**
 * The two warring sides. Everything that used to be hardcoded as
 * "player" (blue, south) vs "enemy" (red, north) is now keyed off this so
 * either side can be flown by a human, an AI, or — eventually — a remote
 * network peer. The "player" is simply whichever Ship carries a
 * LocalInputController; it is NOT baked into the faction.
 *
 *   humans   — the original, unaugmented humanity. Cool blue hulls, hot-pink
 *              lasers. Player flies for this side by default
 *              (GameConfig.player.faction).
 *   machines — humans who chose to merge with AI. Crimson hulls, electric-
 *              green lasers.
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
  /** Human-readable name for the HUD. */
  label: string;
  /** Emissive RGB of this faction's laser bolts (components > 1 bloom harder). */
  laserEmissive: Color3;
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
}

export const FACTION_THEME: Record<Faction, FactionTheme> = {
  humans: {
    label: "HUMANS",
    laserEmissive: new Color3(2.0, 0.6, 0.9), // hot pink (old player)
    laserMaterialName: "humans_laser_mat",
    bodyColor: new Color3(0.16, 0.24, 0.5),
    wingColor: new Color3(0.12, 0.18, 0.36),
    engineEmissive: new Color3(0.5, 0.8, 1.8),
    eyeEmissive: new Color3(0.6, 0.9, 1.8),
  },
  machines: {
    label: "MACHINES",
    laserEmissive: new Color3(0.3, 2.0, 0.6), // electric green (old enemy)
    laserMaterialName: "machines_laser_mat",
    bodyColor: new Color3(0.5, 0.12, 0.14),
    wingColor: new Color3(0.35, 0.1, 0.12),
    engineEmissive: new Color3(1.6, 0.25, 0.15),
    eyeEmissive: new Color3(1.8, 0.3, 0.2),
  },
};
