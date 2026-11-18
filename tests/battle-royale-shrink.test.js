// Battle royale shrink test (node, no DOM).
// Loads js/battle-royale-system.js in a vm sandbox and checks Gary's design:
// the circle starts MASSIVE (99 slices) and shrinks SLOWLY as players die —
// deaths set the target, the slice count only drips down one slice per
// interval, never jumping straight to the target.
//
// Usage: node tests/battle-royale-shrink.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.error('FAIL:', name, detail || ''); }
}

// Load the module in a sandbox (it assigns window.BattleRoyaleSystem).
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'battle-royale-system.js'), 'utf8');
const sandbox = { window: {}, console: { log: () => {} }, Date };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const BR = sandbox.window.BattleRoyaleSystem;
check('module exports BattleRoyaleSystem', !!BR && !!BR.state);

const arena = { cx: 400, cy: 400, r: 300 };

// --- 1. Starts massive: 99 slices, one per player -------------------------
const players = BR.initPlayers(99, 1, arena);
check('starts with 99 players alive', BR.state.alivePlayers.length === 99, 'got ' + BR.state.alivePlayers.length);
check('starts with 99 slices (massive circle)', BR.state.currentSlices === 99, 'got ' + BR.state.currentSlices);
check('target starts at 99', BR.state.targetSlices === 99, 'got ' + BR.state.targetSlices);

// --- 2. Deaths set the target — no instant jump ---------------------------
for (let i = 0; i < 10; i++) BR.eliminatePlayer(players[10 + i]);
check('10 eliminated -> 89 alive', BR.state.alivePlayers.length === 89, 'got ' + BR.state.alivePlayers.length);
check('deaths set target to 89', BR.state.targetSlices === 89, 'got ' + BR.state.targetSlices);
check('slice count does NOT jump on deaths', BR.state.currentSlices === 99, 'got ' + BR.state.currentSlices);

// --- 3. The shrink is SLOW: one slice per interval ------------------------
// Step 4s at 0.5s/frame: 2 intervals elapsed -> 2 slices down (99 -> 97).
for (let t = 0; t < 4; t += 0.5) BR.updateArenaShrink(0.5, players);
check('after 4s the circle has only crept to 97 (not jumped to 89)',
  BR.state.currentSlices === 97, 'got ' + BR.state.currentSlices);
// Step another 16s (8 more intervals) -> 8 more slices down -> 89, target reached.
for (let t = 0; t < 16; t += 0.5) BR.updateArenaShrink(0.5, players);
check('after 20s total the circle reaches the 89 target',
  BR.state.currentSlices === 89, 'got ' + BR.state.currentSlices);
check('shrink stops at the target', (() => {
  for (let t = 0; t < 4; t += 0.5) BR.updateArenaShrink(0.5, players);
  return BR.state.currentSlices === 89;
})(), 'got ' + BR.state.currentSlices);
// Slice boundaries were redistributed on each step (alive players re-sliced).
const alive = players.filter(p => p.alive);
check('alive players re-sliced to 89 boundaries',
  alive.every(p => p.angMax > p.angMin) && Math.abs(alive[0].angMin - 0) < 1e-9,
  'first alive slice starts at 0');

// --- 4. Shrink progress is a 0..1 ramp inside each step -------------------
const players2 = BR.initPlayers(10, 1, arena);
BR.eliminatePlayer(players2[1]);
BR.eliminatePlayer(players2[2]);
check('target 8 after 2 deaths', BR.state.targetSlices === 8, 'got ' + BR.state.targetSlices);
BR.updateArenaShrink(1.0, players2);
check('progress ramps 0..1 inside a step', BR.state.shrinkProgress === 0.5, 'got ' + BR.state.shrinkProgress);
check('no slice step before the interval elapses', BR.state.currentSlices === 10, 'got ' + BR.state.currentSlices);
BR.updateArenaShrink(1.0, players2);
check('one slice steps off when the interval elapses', BR.state.currentSlices === 9, 'got ' + BR.state.currentSlices);

// --- 5. Last player standing ends the match --------------------------------
const players3 = BR.initPlayers(3, 1, arena);
BR.eliminatePlayer(players3[1]);
BR.eliminatePlayer(players3[2]);
check('one alive -> FINISHED', BR.state.gameMode === 'FINISHED', 'got ' + BR.state.gameMode);
check('winner is the survivor', BR.state.alivePlayers[0] === 0, 'got ' + BR.state.alivePlayers);

console.log(`battle-royale-shrink: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
