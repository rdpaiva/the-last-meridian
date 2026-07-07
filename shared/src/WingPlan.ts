import { GameConfig, type ShipTypeId, type WingOrder } from "./GameConfig";
import type { Faction } from "./Faction";

/**
 * Resolve the player's wing for a match from the RUNTIME loadout. The wing is
 * configured as ROLE COUNTS (`GameConfig.player.wingmen.composition`) because
 * a static type list can't express "the same ship the player chose" — this is
 * the ONE place those roles become concrete {shipType, order} slots, given
 * the picked faction + ship:
 *   self    → the player's chosen type (a clone of the loaded model), "cover"
 *   other   → the other ship type in the player's faction, "cover"
 *   gunship → the faction's heavy gunship (factionShips[*] last entry), "defend"
 *
 * Both the client (Game.ts) and the headless harness (tests/sim/
 * HeadlessBattle.ts) build their wing from this list, in this order — slot
 * index i feeds `wingmen.formationSlot(i)`, so escorts fill the close
 * formation slots before the carrier-guard gunships take the far ones.
 */
export interface WingSlot {
  typeId: ShipTypeId;
  order: WingOrder;
}

export function resolveWingPlan(playerFaction: Faction, playerTypeId: ShipTypeId): WingSlot[] {
  const counts = GameConfig.player.wingmen.composition;
  const roster = GameConfig.factionShips[playerFaction];
  const other = roster.find((t) => t !== playerTypeId) ?? playerTypeId;
  const gunship = roster[roster.length - 1];

  const plan: WingSlot[] = [];
  for (let i = 0; i < counts.self; i++) plan.push({ typeId: playerTypeId, order: "cover" });
  for (let i = 0; i < counts.other; i++) plan.push({ typeId: other, order: "cover" });
  for (let i = 0; i < counts.gunship; i++) plan.push({ typeId: gunship, order: "defend" });
  return plan;
}
