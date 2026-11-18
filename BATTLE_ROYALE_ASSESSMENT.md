# Infinity Snip3 — Battle Royale assessment + multiplayer notes

Date: 2026-11-17. Gary's design (2026-11-17 ~20:42 MST): "the battle royale
mode, thats supposed to start with massive circle that gets smaller as more
die right" + "slowly changing the pie circle right". Sequencing (20:43 MST):
"after multiplayer is in then battleroyale can be finished with everything" —
so battle royale gets FINISHED AFTER multiplayer. This note is the assessment
plus the cheap alignment done now; it is NOT the finished mode.

## What battle-royale-system.js had vs Gary's design

The module (`js/battle-royale-system.js`, 707 lines) already has the concept:
"Dynamic pie grid that shrinks as players are eliminated", up to 99 players
(8 human + 91 AI), `shrinkEnabled: true`, `currentSlices` / `targetSlices`
starting at 99.

Against Gary's design:

- **Massive circle at the start — HALF true.** The pie grid starts at 99
  slices, one per player — that is the massive start in slice terms. But the
  physical circle (arena radius) never grows for battle royale and never
  shrinks: only the slice COUNT shrinks. The arena is the standard game arena
  (`min(w,h)*0.42`); nothing makes it bigger for 99 players.
- **Smaller as more die — TRUE.** `eliminatePlayer()` sets
  `targetSlices = alivePlayers.length` whenever the alive count drops below
  the current slice count. The shrink is death-driven, not timer-driven.
- **Slowly changing — NOT TRUE (fixed below).** The old `updateArenaShrink`
  ran a ~3.3s timer (`shrinkSpeed: 0.3`) and then JUMPED `currentSlices`
  straight to `targetSlices` in one step — 10 deaths at once meant a 10-slice
  jump. And `recalculateSlices()` (redistribute slice boundaries) was never
  called by the shrink, so the boundaries didn't move with the count.
  `shrinkTimer: 30` and `timeSinceLastShrink` were declared but NEVER USED.
- **Not playable.** The whole module layer is NOT loaded (the 14 script tags
  are inside an HTML comment in index.html), so none of this runs.
  `js/game-modes.js` `updateBattleRoyaleMode()` is an empty hook
  ("Handled by battle-royale-system.js") — nothing calls `updateArenaShrink`,
  the AI updates, or the BR renderers from the game loop. `gameMode`
  starts at 'WARMUP' with `warmupTime: 5` and nothing ever transitions it to
  'ACTIVE'. The BR `eliminatePlayer` is separate from the game's
  `eliminatePlayer` — the two were never joined.

## Alignment done in this batch (cheap + safe, module code only)

`js/battle-royale-system.js` — the shrink is now a slow drip:

- Deaths still set the target (unchanged).
- `updateArenaShrink(dt, players)` now steps the slice count down ONE slice
  per `shrinkStepInterval` (2.0s), calling `recalculateSlices(players, …)` on
  each step, so the pie circle visibly creeps inward instead of jumping.
  `shrinkProgress` is now the 0→1 ramp inside each step (a renderer can show
  the next shrink coming).
- Removed the dead/misleading fields `shrinkSpeed` and `shrinkTimer`
  (nothing outside the file referenced them — verified by grep).
- New test `tests/battle-royale-shrink.test.js`: 17/17 pass — starts at 99,
  deaths set the target without jumping, 4s of stepping only creeps to 97,
  20s reaches 89, boundaries re-sliced, last player standing → FINISHED.

## What finishing battle royale AFTER multiplayer still needs

1. **Multiplayer first** (Gary's order) — up to 99 players is a network
   problem before it is a mode problem (see below).
2. **Wire the module layer in** — the big decision: uncomment/load the 14
   scripts, resolve the shadow `GameState` in game-init.js, and call the BR
   update/render hooks from the game loop (`updateArenaShrink`,
   `updateAIPlayer`/`aiShouldShoot`, the audio-reactive draw calls, the HUD).
   `game-modes.js` `updateBattleRoyaleMode()` is the integration point.
3. **Join the elimination paths** — the game's `eliminatePlayer` must call
   the BR one (or vice versa) so a death shrinks the circle and updates
   placement; decide which one owns the kill.
4. **Match flow** — WARMUP → ACTIVE transition (the 5s warmup never fires),
   ENDGAME state, spectator mode for eliminated players, placement HUD
   wiring.
5. **The circle itself** — decide whether the BR arena should be physically
   larger at the start (a bigger radius for 99 players) and whether the
   radius should shrink with the slice count, or whether the slice count
   alone is the "circle getting smaller". Gary's call.
6. **AI + performance** — 91 AI tanks thinking/shooting every frame, 99
   trails, 99 slices of glow: measure before shipping; the 5-minute AI
   respawn fallback in game-modes.js conflicts with BR (no respawns in BR).
7. **Menu entry** — no battle royale menu item exists; add it when the mode
   is wired in (with a player-count select: 99 is the max, fewer is fine).

## What multiplayer would need (not built in this batch)

The module layer already has a full multiplayer design, unloaded:

- `js/network.js` (643 lines): authoritative-host model over WebRTC
  (RTCPeerConnection + RTCDataChannel), host migration, heartbeat timeout
  3s. Gated on `window.SNIP3_NET_CONFIG = { enabled:true,
  signalingUrl:'wss://…', … }` — **no signaling server exists and no URL is
  configured.** TURN servers are a TODO ("Add TURN servers here for NAT
  traversal if needed").
- `js/network-input.js` (544 lines): input packets client→host,
  reconciliation, game events. `js/network-state.js` (636 lines): host
  broadcasts authoritative state snapshots with delta compression, clients
  interpolate for 120 FPS. `js/network-privacy.js` (392 lines): ICE config,
  anonymous peer IDs, LAN mode + room codes + LAN discovery.
- Still needed to make it real: (a) **a signaling server + hosting decision**
  (where it runs, who pays — Gary hasn't decided); (b) TURN for NAT
  traversal; (c) wiring the network layer into the game loop (the game's
  `step()`/`players` are local-only today — `processClientInputs` /
  `receiveClientInput` are never called); (d) the lobby / room-code UI and
  the Game Center identity (the local arcade profile built in this batch is
  the identity ONLINE VS would attach to); (e) host migration + disconnect
  handling tested live; (f) deciding the player cap for a real match
  (99 over WebRTC peer-to-peer is ambitious — a dedicated server or a
  host-relay may be needed, vs the current host-authoritative mesh).
