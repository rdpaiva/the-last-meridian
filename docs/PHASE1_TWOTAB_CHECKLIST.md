# Phase 1 — local two-tab acceptance checklist `[human]`

This is the real definition of done for Phase 1 (docs/MULTIPLAYER.md). The
Node integration tests already prove the pipe headlessly
(`tests/server/battleRoom.test.ts`); this is the eyeball pass in a browser.
Updated 2026-07-04 for the entry-polish build (PLAY ONLINE buttons, invite
links, HUD parity, prediction + FX replication all in).

## Run it

Two terminals from the repo root:

```bash
# 1. the authoritative server (Colyseus on :2567)
npm run server

# 2. the client (Vite dev server on :5173)
npm run dev
```

Open `http://localhost:5173/` — no flag needed anymore. **PLAY ONLINE** lives
on the quick-play screen and on the loadout's mission page (next to PLAY
SOLO). PLAY SOLO stays fully offline, no server needed.

To point at a non-local server, build/run the client with
`VITE_SERVER_URL=wss://your.host` set.

## What "playable" means now

Solo-online should feel close to single-player: predicted own ship, muzzle-
true predicted fire, interpolated remotes, full FX/sound, full HUD (radar on
a client sensor picture, RWR, kills/score, lock/sig cues, pilot counts).
Deliberate differences (not bugs): **no hitstop online**; remote engine glow
rides a speed proxy, not thrust input.

## Checklist

Entry + solo online (vs AI backfill):

- [ ] PLAY ONLINE connects (button shows CONNECTING…, then the match); the
      address bar gains `#join=<roomId>`.
- [ ] With the server stopped, PLAY ONLINE fails readably ("SERVER
      UNAVAILABLE — try again, or play solo") and the buttons still work;
      PLAY SOLO still launches offline.
- [ ] You spawn via the carrier launch, fly (W/S/A/D, Q/E strafe, +/- zoom),
      fire (predicted, muzzle-true at speed), and full-thrust motion is
      SMOOTH — no judder (this build's fix; watch for it specifically).
- [ ] Both fleets fly and fight with bolts/missiles/explosions/sound; the
      radar picture behaves (ghost rings age out, nebula hides hostiles),
      RWR beeps only when a missile chases YOU, kills/score tally.
- [ ] Your AI wing covers you: friendly escorts form up on YOUR ship and
      break to engage threats near you (the human is the formation leader).
- [ ] A carrier eventually falls → VICTORY/DEFEAT banner with the stats
      line; ENTER rejoins a fresh online match, ESC returns to the menu.

Two tabs (vs/with another human):

- [ ] Copy the `#join=<roomId>` URL into a second tab: its primary button
      reads JOIN FRIENDS' MATCH and lands in the SAME room (pilots row reads
      `2 human`; each sees the other's white radar halo).
- [ ] Each tab controls ITS OWN ship only; the other player's ship moves
      smoothly and fires visibly in both tabs.
- [ ] Closing a tab hands that ship back to the AI (isAI honesty: the halo
      drops, pilot count drops to 1) and escort leadership returns/moves.
- [ ] A stale invite link (room gone — restart the server) falls back to a
      fresh quick match and the hash self-heals to the new room.

Resilience:

- [ ] Stop the server while a tab is playing → "CONNECTION LOST" overlay
      appears (no crash).

## Known gaps (tracked, not bugs)

- Nebula stealth is honest UI but not anti-wallhack (full state still
  replicates) — server-side sensor-filtered replication is a pre-deploy
  Phase 2 item.
- Reconnect-after-drop is Phase 3 (`allowReconnection`).
- No server browser — quick match + invite links only (by design).
