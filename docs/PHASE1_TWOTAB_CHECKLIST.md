# Phase 1 — local two-tab acceptance checklist `[human]`

This is the real definition of done for Phase 1 (docs/MULTIPLAYER.md). The
Node integration tests already prove the pipe headlessly
(`tests/server/battleRoom.test.ts`); this is the eyeball pass in a browser.

## Run it

Two terminals from the repo root:

```bash
# 1. the authoritative server (Colyseus on :2567)
npm run server

# 2. the client (Vite dev server on :5173)
npm run dev
```

Then open the client in **online** mode by adding `?online`:

```
http://localhost:5173/?online
```

Pick a side + ship on the splash and PLAY. (Without `?online` the page is the
normal fully-offline single-player game — PLAY SOLO needs no server.)

To point at a non-local server, build/run the client with
`VITE_SERVER_URL=wss://your.host` set.

## What "playable" means at this phase (read first)

Phase 1 is the **dumb client**: the server owns the sim, the client renders
what it's told and sends your input. So expect:

- **No laser bolts or explosions yet.** Transient FX are replicated in Phase 2
  (the event channel). Ships fly, ram, die, respawn; carriers lose HP and a
  side wins — you just don't see the tracers. This is expected, not a bug.
- **Slightly steppy motion** on other ships (server patch rate is 15Hz; client
  interpolation is Phase 2). Your own ship is also un-predicted, so it'll feel
  a touch laggy. Also expected at this phase.

## Checklist

Single tab (vs AI backfill):

- [ ] `?online` loads, splash works, PLAY connects (no "SERVER UNAVAILABLE").
- [ ] You spawn and can fly: W/S thrust, A/D turn, Q/E strafe, +/- zoom.
- [ ] Camera follows your ship; the arena, carriers, nebulas, starfield render.
- [ ] ~14 ships are present and moving (both fleets, AI-flown).
- [ ] The match leaves "STAND BY" and plays out; carrier HP bars drop over time.
- [ ] A carrier eventually falls → VICTORY or DEFEAT banner shows.

Two tabs (vs another human):

- [ ] Open a second tab at `http://localhost:5173/?online` and PLAY (same or
      opposite faction).
- [ ] Each tab controls ITS OWN ship only; the other player's ship is visible
      and moves in both tabs.
- [ ] Inputs land: turning/thrusting in one tab is mirrored in the other.
- [ ] Closing a tab hands that ship back to the AI (it keeps flying); the match
      stays balanced and plays to a result.

Resilience:

- [ ] Stop the server while a tab is playing → "CONNECTION LOST" overlay
      appears (no crash).

## Known gaps (tracked, not bugs)

- No weapon/explosion FX, no radar, no sound, no detailed cockpit HUD — Phase 2.
- Procedural fighter meshes (faction-colored), not the per-type GLBs — a later
  client polish pass.
- No friend-invite link / server browser — quick match only (by design).
- Reconnect-after-drop is Phase 3 (`allowReconnection`).
