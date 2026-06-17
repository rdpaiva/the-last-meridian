import { GameConfig } from "../GameConfig";
import type { ConcealmentZone } from "../SensorSystem";

/**
 * The scene-free half of the combat nebulas (Phase 0 sim/view split): turn the
 * configured fractional cloud placements (GameConfig.scenery.combatNebulas.zones)
 * into world-space SensorSystem concealment footprints.
 *
 * These zones are the gameplay TRUTH the sensors and radar read — the textured
 * quads in CombatNebulas (view) are only their depiction. Both the client view
 * and the headless smoke harness call this, so the footprint math lives in
 * exactly ONE place (it used to be duplicated, with a "keep in sync" caveat).
 * Pure math + GameConfig: imports nothing from the scene, so it runs anywhere.
 */
export function computeConcealmentZones(
  arenaHalfWidth: number,
  arenaHalfDepth: number,
): ConcealmentZone[] {
  return GameConfig.scenery.combatNebulas.zones.map((z) => ({
    x: z.xFrac * arenaHalfWidth,
    z: z.zFrac * arenaHalfDepth,
    radius: z.radius,
  }));
}
