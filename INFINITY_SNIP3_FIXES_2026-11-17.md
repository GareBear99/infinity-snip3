# Infinity Snip3 — fixes, 2026-11-17

Gary: the menu / in-game separation is done, plus the crash that meant the
game could never play a single frame. All changes are local to this repo;
nothing was pushed to itch or any other channel.

## What the repo is

- `index.html` (5,005 lines) — the whole game is ONE inline script (lines
  94–4902). All game state lives inside that IIFE.
- `js/` (17 files, ~9,700 lines) — a module layer that is **not loaded**:
  all 14 `<script src>` tags are inside an HTML comment
  (`index.html:4892–4907`), and `js/game-init.js` / `js/menu-arrow-3d.js`
  are not even in the commented list. The live game is the inline script only.
- `audio/` (9 files), docs, `tests/` (new — the verification harness).

## Issues found (file:line refs are to the original code, before this fix)

### Critical — the game could never play a frame
1. `index.html: initPlayers()` created player objects with NO `trail` /
   `trailMax`, but `step()` unconditionally does `p.trail.push(...)`.
   First `step()` threw `TypeError`; the throw killed the `requestAnimationFrame`
   loop permanently. Broken since the initial commit.
2. Same class of bug, found while fixing #1: players were also missing
   `angMin` / `angMax` (read by `constrainToSlice`, `drawPlayerSlices`,
   the no-input drift in `step()`), `driftT` (read by the drift fallback),
   `aimX` / `aimY` (read by the lobby/aim drawing), and `angle` (read by
   the `NEOVECTR.player` API). With them undefined, every coordinate
   became `NaN` on the first frame and the watchdog reported
   "Player 0 has invalid x/y".
3. `initBarriers()` was never called anywhere, so the "one interior
   barrier per slice" feature was dead and `barriers[]` was always empty.
   And `barrierMidRFor()` read nonexistent `b.ax/b.bx/b.ay/b.by` fields,
   which would have produced `NaN` spawn radii the moment a barrier existed.
   `initBarriers()` also used a different angle base (0) than the players
   (`-PI/2`), so each barrier sat 90° away from the slice it belongs to.
   `collidePlayerWithBarrier()` compared `B.slice` (0-based) to `p.id`
   (1-based), so no barrier could ever collide with any player.

### Critical — menu / in-game coupling (the blocker Gary named)
4. The start sequence was inlined 4× with drift: SNIP3 (`:2734`),
   LOCAL VS (`:2755`), START VS (CUSTOM) (`:2784`), and
   `NEOVECTR.game.start()` (`:4331`). SNIP3 spawned players twice
   (once with the stale RNG, again after `setSeed`); VS starts inherited
   whatever player count the slider/previous game left (including
   1-player VS, which ends instantly); the API version seeded *after*
   spawning and never re-seeded on `seed:''`.
5. Menu actions mutated the live world directly: the SETTINGS seed action
   called `setSeed()` + `initPlayers()` + `resetP1Systems()` while still
   in the menu; the PLAYERS slider and the `#playerCount` DOM select
   called `setPlayerCount()` → `initPlayers()` (the DOM select could
   fire **mid-game** and instantly respawn everyone, wiping scores/lives);
   the co-op toggle forced `setPlayerCount(2)` as a side effect.
6. `goMenu()` (`:534`) did no teardown — players, barriers, lasers,
   sparks, scores, timers all survived into the menu. The VICTORY branch
   (`:4106`) and watchdog `recover()` (`:4713`) bypassed `goMenu()` with
   partial inline transitions. A world was also created at page load by
   a bare `initPlayers()` (`:3525`) behind the boot/menu.
7. No single game config existed — mode, player count, seed, co-op were
   scattered globals (`gameMode`, `playerCount`, `settings.seedStr`,
   `currentSeed`, `rand`).
8. Victory was duplicated: `endVsRound()` (`:2510`) was dead code that
   wrote `victoryWinnerId`/`victoryAt` (read nowhere), while
   `eliminatePlayer()` (`:1936`) inlined its own transition.

### High — dead module layer (only matters if the modules are re-enabled)
9. `js/network.js:528/534` called `handleInputPacket` / `handleStateUpdate`,
   which don't exist (real functions are `receiveClientInput` /
   `receiveStateUpdate`) — every incoming INPUT/STATE_UPDATE packet
   would throw `ReferenceError`.
10. `js/network.js` never set `channel.binaryType`, so binary packets
    arrive as Blob and `JSON.parse` throws.
11. `js/game-init.js:34` `const GameState` collided with
    `js/network-state.js:29` `class GameState` — loading both is a
    `SyntaxError`.
12. `js/audio-control.js:232` `playSound` crashed if used before init
    (no null check on `audioContext`).
13. `js/system-checker.js` `FILE_MANIFEST` script paths lacked the `js/`
    prefix (every check 404'd) and listed `CREDITS.md` /
    `AUDIO_INTEGRATION_GUIDE.md`, which don't exist in the repo.

### Other (found, not all fixed — see "Still open")
- `settings.coop` has no gameplay reader (only its own toggle and the API
  read it). The toggle still works; it just doesn't change gameplay.
- `prompt()` blocks the frame loop while a seed is being typed (menu only).
- The Tab lobby handler had no mode check (could open during boot); the
  DOM lobby overlay (`index.html:4879–4909`, second inline script) is a
  separate overlay with its own Tab handler and a Google favicon fetch
  on every open — it measures internet reachability, not a game server.
- `menuItems()` is rebuilt 3× per frame; `aliveCount()` is dead code;
  `drawPlayerSlices` checks `p.id === 0` but ids are 1-based (the
  slice-shake never applies); `menuPage` is declared after its first use.
- Docs: `FIXES_COMPLETED.md` claimed the game was "production-ready" and
  that `shape-editor.js` was "truncated around line 480" — both false.
  `SCRIPT_LOADING_ORDER.md` lists 16 scripts in a different order than
  the commented block (14, different order) and says "All 15 JS modules".
- Multiplayer is not runnable: no signaling server ships, no default,
  no UI calls `createLobby`/`joinLobby`; the visible "lobby" is local/AI
  players + a Google favicon ping. `network-privacy.js` is theater
  (only Google STUN is used; TURN creds are public demo creds).
- `enhanced-menu.js` reads bare globals (`canvas`, `arena()`,
  `bootAnalyser`) that don't exist outside the IIFE — it would throw
  `ReferenceError` if loaded. It also duplicates `updateMenuArrow` /
  `drawArrowShape` with `menu-arrow-3d.js`.
- `game-modes.js` / `battle-royale-system.js` are parallel game systems
  (own player shapes, own spawning) with empty stubs and no driver.

## What was fixed (this commit)

**Menu / in-game separation (`index.html`):**
- New `GameConfig`: the menu owns a *pending draft* (`pendingConfig` —
  mode, players, seed, coop); the game owns only the *active* copy.
  Menu actions edit the draft only, via `setPendingPlayers()` /
  `setPendingSeed()`; they never generate or mutate the live world.
- New single entry point `startGame(config)`: validates/clamps the config
  (SNIP3 forces 1 player, VS requires ≥ 2, `''` seed = AUTO), then
  `stopMenuMusic → resetRoundState → setSeed → initBarriers → initPlayers
  → resetP1Systems → appMode='GAME'` (mode flips LAST). All four old
  start sites now call it; `NEOVECTR.game.start()` delegates to it.
- `goMenu()` now tears the run down (players/barriers/lasers/sparks
  cleared, round state reset, lobby overlay hidden). VICTORY and the
  watchdog `recover()` route through it. The boot-time `initPlayers()`
  is gone — no world exists until `startGame()` builds one.
- `setPlayerCount()` updates the draft in the menu and regenerates only
  mid-game (debug HUD testing affordance preserved). The players slider
  label/thumb and the `#playerCount` DOM select now read the draft and
  stay in sync.
- SETTINGS seed changes are now persisted (`saveSettings()` was missing
  there). The seed log line now shows the effective seed (`currentSeed`),
  not the raw setting.
- Victory is one path: `eliminatePlayer()` calls `endVsRound()`, which
  sets the variables the victory screen actually reads; the dead
  `victoryWinnerId`/`victoryAt` are gone.
- Tab lobby is gated to MENU/GAME/PAUSE (never during boot).

**Crash / generation fixes (`index.html`):**
- `initPlayers()` now initializes `trail: []` + `trailMax: 32`,
  `angMin`/`angMax` (slice bounds), `sliceIndex`, `driftT: 0`,
  `aimX`/`aimY`, `angle`.
- `initBarriers()` is called by `startGame()` (after `setSeed`, before
  `initPlayers`). `barrierMidRFor()` returns the stored barrier radius
  (the old field names produced NaN). Barrier angles now use the same
  `-PI/2` base as the player slices. `collidePlayerWithBarrier()`
  compares against `p.sliceIndex` (0-based).

**Module fixes (`js/`):**
- `network.js`: dispatch calls renamed to `receiveClientInput` /
  `receiveStateUpdate`; `channel.binaryType = 'arraybuffer'` in
  `setupDataChannel`.
- `game-init.js`: internal `GameState` renamed to `Snip3GameState`
  (public `GameInit.GameState` key unchanged) — no more collision with
  `network-state.js`'s `class GameState`.
- `audio-control.js`: `playSound` returns early when there is no audio
  context yet.
- `system-checker.js`: manifest script paths fixed with the `js/` prefix;
  the two nonexistent doc entries removed.

**Docs:** README now states the module layer is disabled and multiplayer
needs a signaling server; `FIXES_COMPLETED.md` corrects the shape-editor
truncation claim (the file is complete; it lacks *input wiring*) and the
"production-ready" conclusion.

**Tests:** `tests/menu-game-separation.test.js` (Node, no browser) drives
the game via the `NEOVECTR` API in a vm sandbox — 9 sections, 52 checks
covering boot→menu, start, pause/resume, quit teardown, draft-only
selection, VS from the pending selection, same-seed determinism, new
selection, and running-game insulation.

## How it was verified

- `node --check` on the inline script and all 17 `js/` files: pass.
- `node tests/menu-game-separation.test.js`: **52 passed, 0 failed
  (ALL CHECKS PASSED)**. Baseline (original code) crashed at
  `p.trail.push` during the first 120-frame pump and had 0 barriers.
- No real browser was available on the VM, so this is harness + code
  verification, not a live browser play-through. The menu → select →
  start → back-to-menu flow should be re-checked in a real browser
  (GitHub Pages) after this lands.

## Still open / needs Gary's decision

- **Re-enabling the module layer** — the 14 scripts were disabled
  deliberately ("need proper integration to avoid conflicts"). Do not
  uncomment them without a decision: `enhanced-menu.js` needs a rewrite
  (bare globals, hardcoded menu), `game-modes.js` / `battle-royale-system.js`
  are parallel games, `game-init.js` still runs a shadow `GameState`.
- **Multiplayer** — needs a signaling server (none ships), a decision on
  hosting, and the game-loop hooks (`updateInputSystem` etc. are never
  called by the inline loop).
- **`settings.coop`** — dead setting with no gameplay reader. Keep the
  toggle as-is, delete it, or give co-op a real meaning?
- **`prompt()` seed input** — works but blocks the frame loop; replace
  with an in-menu text input?
- **DOM lobby overlay** — second, independent overlay with the Google
  favicon "ping". Unify with the canvas lobby or remove?
- The `menuItems()` 3×/frame rebuild, `aliveCount()` dead code,
  `p.id === 0` slice-shake check, and `menuPage` declaration order are
  known smells, left as-is (not bugs).
