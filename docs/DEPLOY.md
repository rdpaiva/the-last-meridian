# Deploying the multiplayer server (+ pointing the Pages client at it)

The friends-playtest topology (docs/MULTIPLAYER.md → Phase 3 "Hosting
artifacts"):

```
GitHub Pages client (HTTPS)               owner's DigitalOcean VM
https://<user>.github.io/the-last-meridian/
        │
        │  wss://play.<domain>   (Pages is HTTPS ⇒ the socket MUST be wss)
        ▼
Caddy or nginx (TLS termination + WebSocket upgrade)
        │  localhost:2567
        ▼
systemd unit `space-duel` → node /opt/space-duel/server.mjs
```

**The one rule that can't be broken: client and server deploy from the SAME
commit.** `PROTOCOL_VERSION` (shared/src/protocol.ts) rides in every join and
the server refuses mismatches (clients render "NEW VERSION — refresh"). The
server deploy workflow is `workflow_dispatch`-only for exactly this reason —
run it against the same ref the Pages deploy just built.

> **RETIRED 2026-07-06** — the former "local `main` stays ahead of
> `origin/main` until hosting is provisioned" constraint ended when hosting
> went live: droplet + DNS (`play.the-last-meridian.com`) + Caddy + unit +
> deploy user + CI secrets all provisioned and verified, and `main`
> (`93a5241`) pushed with client and server shipped from that same commit.
> From here, follow "Every deploy after that" below.

## What's in the repo (agent-prepared, ready to use)

| Artifact | Purpose |
|---|---|
| `npm run build -w @space-duel/server` | esbuild bundle → `server/dist/server.mjs` (self-contained ESM, ~3.8 MB; only `ws`'s optional native peers are external — they're optional, plain Node 20+ runs it) |
| `deploy/space-duel.service` | systemd unit (localhost:2567, hardened, auto-restart) — install notes in the file header |
| `deploy/Caddyfile` | reverse proxy option A: Caddy (auto-TLS, zero-config websockets) |
| `deploy/nginx-play.conf` | reverse proxy option B: nginx (use if the VM already runs it; certbot-ready) |
| `.github/workflows/deploy-server.yml` | manual server deploy: typecheck + test + bundle, scp, atomic swap, unit restart |
| `.github/workflows/deploy.yml` | the existing Pages deploy, now baking `VITE_SERVER_URL` from a repo variable into the client |

## `[human]` provisioning checklist (one-time)

Accounts/credentials work — agents must not attempt any of this.

1. **DNS**: add an A record for `play.<domain>` → the VM's IP.
2. **VM user + directory**:
   ```bash
   sudo useradd --system --home /opt/space-duel --shell /usr/sbin/nologin spaceduel
   sudo mkdir -p /opt/space-duel && sudo chown spaceduel:spaceduel /opt/space-duel
   ```
3. **Reverse proxy — pick ONE**:
   - *Caddy*: install (`apt install caddy`), copy `deploy/Caddyfile` to
     `/etc/caddy/Caddyfile` with the real subdomain, `systemctl reload caddy`.
     TLS is automatic.
   - *nginx* (if already on the VM): follow the header comments in
     `deploy/nginx-play.conf` (site file + `certbot --nginx`).
4. **First bundle by hand** (before the workflow exists on the VM's side):
   ```bash
   npm ci && npm run build -w @space-duel/server
   scp server/dist/server.mjs <you>@<vm>:/opt/space-duel/server.mjs
   sudo cp deploy/space-duel.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now space-duel
   journalctl -u space-duel -f   # expect: "protocol vNN listening on :2567"
   ```
5. **Deploy access for CI**:
   - Create an SSH keypair for deploys; public half → the VM user's
     `~/.ssh/authorized_keys`.
   - Repo secret `DEPLOY_SSH_KEY` = the private key; repo secret
     `DEPLOY_HOST` = `<user>@play.<domain>`.
   - Sudoers (restart only, nothing else):
     `<user> ALL=(root) NOPASSWD: /usr/bin/systemctl restart space-duel`
6. **Point the client at it**: repo **variable** (not secret)
   `VITE_SERVER_URL` = `wss://play.<domain>`. While unset, Pages builds keep
   the localhost fallback and online play is dev-only — safe default.
7. **Smoke test before inviting anyone**: from a browser,
   `https://play.<domain>/` should answer (Colyseus matchmaking responds on
   plain HTTPS GET), and a Pages build with the variable set should join a
   match end-to-end.

## Every deploy after that

1. Push/merge to `main` → Pages deploys the client automatically.
2. Immediately run **Actions → Deploy game server** on the same commit.
3. Players on stale tabs get "NEW VERSION — refresh" — that's the protocol
   check working, not a bug. A server restart drops live matches; clients
   auto-reconnect for `GameConfig.net.reconnectGraceSec` (60s), but a
   restarted server has no rooms — they'll land on the terminal overlay and
   re-enter via ENTER/refresh. Deploy between matches when you can.

## Notes

- **CORS**: Colyseus's matchmaking HTTP responses mirror the request origin
  by default (`@colyseus/core` → `matchmaker/controller.ts`), so the Pages
  origin is admitted without configuration. To lock it to the Pages origin
  later: override `matchMaker.controller.getCorsHeaders` in
  `server/src/index.ts`.
- **PORT** is the unit's only env knob (default 2567). Change it in the unit
  AND the proxy config together.
- The bundle is fully self-contained — no `node_modules`, no npm install on
  the VM. Node 20+ (22 LTS fine) is the only runtime dependency.
