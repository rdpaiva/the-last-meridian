/**
 * @space-duel/server — Colyseus authoritative game server.
 *
 * Phase 1 skeleton. The BattleRoom (running the shared `advanceSim`) lands in
 * the next task; this entry just proves the workspace + shared import wire up
 * and the server typechecks against the sim package.
 */
import { GameConfig } from "@space-duel/shared";

const PORT = Number(process.env.PORT ?? 2567);

// Smoke check that the shared sim resolves server-side (Babylon math only).
console.log(
  `[space-duel server] shared sim loaded (arena ${GameConfig.arena.halfWidth}x${GameConfig.arena.halfDepth}); ` +
    `listening target :${PORT} once Colyseus lands.`,
);
