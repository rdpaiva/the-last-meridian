# Deploying the game (client + server, one droplet)

The live topology (since 2026-07-06; single DigitalOcean droplet):

```
https://the-last-meridian.com          wss://play.the-last-meridian.com
        │                                       │
        ▼                                       ▼
   Caddy (auto-TLS for both sites, WebSocket upgrade on play.)
        │                                       │
        │ file_server                           │ localhost:2567
        ▼                                       ▼
/var/www/the-last-meridian          systemd unit `space-duel`
  (static Vite bundle)                → node /opt/space-duel/server.mjs
```

The client was originally on GitHub Pages; it moved to the droplet
2026-07-06 (nicer URL, one host, and it let the client + server deploys
merge into ONE workflow). The Pages workflow is deleted; disable Pages in
repo Settings if it's still serving the stale copy.

**The one rule that can't be broken: client and server deploy from the SAME
commit.** `PROTOCOL_VERSION` (shared/src/protocol.ts) rides in every join and
the server refuses mismatches (clients render "NEW VERSION — refresh"). The
**Deploy game** workflow builds and ships BOTH from one checkout, so the
rule is now automatic — just never hand-deploy one half alone.

## What's in the repo

| Artifact | Purpose |
|---|---|
| `npm run build -w @space-duel/server` | esbuild bundle → `server/dist/server.mjs` (self-contained ESM, ~3.8 MB; only `ws`'s optional native peers are external — they're optional, plain Node 20+ runs it) |
| `npm run build -w @space-duel/client` | Vite bundle → `client/dist/` (~34 MB with assets; `VITE_SERVER_URL` env bakes the socket URL, base is `/`) |
| `deploy/space-duel.service` | systemd unit (localhost:2567, hardened, auto-restart) — install notes in the file header |
| `deploy/Caddyfile` | Caddy config REFERENCE — the live `/etc/caddy/Caddyfile` on the droplet serves both sites (apex file_server + play. reverse_proxy) |
| `deploy/nginx-play.conf` | nginx alternative for the proxy half (unused; kept for reference) |
| `.github/workflows/deploy-server.yml` | **"Deploy game"** — manual dispatch: typecheck + test, build client AND server, scp both, atomic swaps, unit restart |

## Provisioned state (done 2026-07-06 — recorded so nobody re-does it)

- **Droplet**: 1GB/1vCPU Ubuntu 24.04 (`Meridian-Multiplayer-Server`),
  Node 22 + Caddy via cloud-init, ufw allowing 22/80/443.
- **DNS**: A records → droplet IP for `play.the-last-meridian.com` (server)
  and `the-last-meridian.com` (client).
- **Server**: unit `space-duel` runs `/opt/space-duel/server.mjs` as system
  user `spaceduel` on :2567.
- **Client**: static bundle at `/var/www/the-last-meridian`, served by
  Caddy `file_server` (zstd/gzip). Deploys swap
  `the-last-meridian.new` → live → `.old` atomically.
- **Deploy user**: `spaceduel-deploy` — key-only SSH (public half of the
  `DEPLOY_SSH_KEY` repo secret), write access to `/opt/space-duel` (via
  `spaceduel` group) and `/var/www`, and exactly one sudo right:
  `NOPASSWD: /usr/bin/systemctl restart space-duel`
  (`/etc/sudoers.d/spaceduel-deploy`).
- **Repo config**: secrets `DEPLOY_SSH_KEY`, `DEPLOY_HOST`
  (`spaceduel-deploy@play.the-last-meridian.com`); variable
  `VITE_SERVER_URL` (`wss://play.the-last-meridian.com`).

## Every deploy

1. Push/merge to `main` (nothing auto-deploys anymore).
2. Run **Actions → Deploy game** on that commit — it typechecks, tests,
   builds both halves, ships both, restarts the unit.
3. Players on stale tabs get "NEW VERSION — refresh" — that's the protocol
   check working, not a bug. A server restart drops live matches; clients
   auto-reconnect for `GameConfig.net.reconnectGraceSec` (60s), but a
   restarted server has no rooms — they'll land on the terminal overlay and
   re-enter via ENTER/refresh. Deploy between matches when you can.

## Notes

- **CORS**: Colyseus's matchmaking HTTP responses mirror the request origin
  by default (`@colyseus/core` → `matchmaker/controller.ts`), so the client
  origin is admitted without configuration. To lock it to the apex origin
  later: override `matchMaker.controller.getCorsHeaders` in
  `server/src/index.ts`.
- **PORT** is the unit's only env knob (default 2567). Change it in the unit
  AND the proxy config together.
- The server bundle is fully self-contained — no `node_modules`, no npm
  install on the VM. Node 20+ (22 LTS on the box) is the only runtime
  dependency.
- The apex site is plain static hosting — no SPA rewrite rules needed;
  invite links ride the `#join=` URL hash.
