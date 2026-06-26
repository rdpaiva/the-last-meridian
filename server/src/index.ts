/**
 * @space-duel/server — Colyseus authoritative game server (docs/MULTIPLAYER.md
 * Phase 1). Registers the BattleRoom and listens for clients. Dev: `npm run
 * server` (tsx watch). Prod bundling (esbuild) + systemd/Caddy are Phase 3.
 */
import { Server, WebSocketTransport } from "colyseus";

import { BATTLE_ROOM, PROTOCOL_VERSION } from "@space-duel/shared";
import { BattleRoom } from "./rooms/BattleRoom";

const port = Number(process.env.PORT ?? 2567);

const gameServer = new Server({
  transport: new WebSocketTransport(),
});

gameServer.define(BATTLE_ROOM, BattleRoom);

gameServer
  .listen(port)
  .then(() => {
    console.log(
      `[space-duel server] protocol v${PROTOCOL_VERSION} listening on :${port} ` +
        `(room "${BATTLE_ROOM}")`,
    );
  })
  .catch((err) => {
    console.error("[space-duel server] failed to start:", err);
    process.exit(1);
  });
