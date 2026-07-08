import { GameConfig } from "../GameConfig";
import type { ConcealmentZone } from "../SensorSystem";

/**
 * The scene-free footprint math for the ion storms — the exact contract
 * CombatNebulaZones.ts provides for the stealth clouds: turn the configured
 * fractional placements (GameConfig.storms.zones) into world-space circles.
 *
 * These circles are the gameplay TRUTH: StormSystem zaps ships inside them,
 * the sensors treat them as concealment, the AI steers around them, and the
 * radar draws them. The electric cloud quads in StormClouds (client view) are
 * only their depiction. Pure math + GameConfig — runs anywhere.
 */
export function computeStormZones(
  arenaHalfWidth: number,
  arenaHalfDepth: number,
): ConcealmentZone[] {
  return GameConfig.storms.zones.map((z) => ({
    x: z.xFrac * arenaHalfWidth,
    z: z.zFrac * arenaHalfDepth,
    radius: z.radius,
  }));
}
