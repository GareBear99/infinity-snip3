// Infinity Snip3 — SNIP3 main play test harness (Node, no browser needed).
//
// Loads index.html's main inline script in a vm sandbox with stubbed browser
// APIs (same harness as tests/menu-game-separation.test.js) and drives the
// real game code through the window.NEOVECTR debug API + direct vm
// evaluation of internals.
//
// Usage:  node tests/snip3-main-mode.test.js
// Exits 0 when every check passes, 1 otherwise.
//
// The checks encode the SNIP3 main-play contract (Wii Tanks gap, 2026-11-17):
//   1. Starting SNIP3 builds level 1: enemies spawned, score 0, lives 3.
//   2. Enemy types are distinct (speed / HP / fire interval / score).
//   3. Enemies move and fire (enemy lasers follow player ricochet rules).
//   4. A player laser killing an enemy scores; armoured takes two hits.
//   5. Clearing a level advances to the next (with the clear bonus).
//   6. An enemy laser killing the player loses a life and restarts the level.
//   7. At 0 lives the run ends on the GAMEOVER screen, then returns to menu.
//   8. Your own ricochet kills you (self-hit = death); a fresh shot can't.
//   9. VS behaviour is unchanged in rule (own laser after a bounce
//      eliminates; a kill ends the round) — and now actually works, because
//      the shadowing duplicate eliminatePlayer() that made VS laser kills
//      no-ops was removed (see the fix note in index.html).
//  10. The pie-slice arena is unchanged: radial chord barriers, no
//      rectangular block walls anywhere (Gary 2026-11-17: the pie slices
//      are the game's identity and they stay).
//  11. Trail / dash / charge are KEPT (visual-only trail; player abilities).
//  12. Quitting to the menu tears the SNIP3 run down; a fresh start resets.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const lines = html.split('\n');
// Main inline script: <script> is line 94; find its closing </script> dynamically
// (line numbers shift as the file is edited — never hardcode the end).
let scriptEnd = -1;
for (let i = 93; i < lines.length; i++) {
  if (lines[i].includes('</script>')) { scriptEnd = i; break; }
}
if (scriptEnd < 0) throw new Error('main </script> not found');
const mainJs = lines.slice(94, scriptEnd).join('\n');

// ---------------------------------------------------------------------------
// Controllable clock + timers (the game uses performance.now + setTimeout).
// ---------------------------------------------------------------------------
let nowMs = 0;
let timerSeq = 0;
const timers = new Map(); // id -> { at, fn, args, repeatMs|null }
function fakeSetTimeout(fn, ms, ...args) {
  const id = ++timerSeq;
  timers.set(id, { at: nowMs + (ms || 0), fn, args, repeatMs: null });
  return id;
}
function fakeClearTimeout(id) { timers.delete(id); }
function fakeSetInterval(fn, ms, ...args) {
  const id = ++timerSeq;
  timers.set(id, { at: nowMs + (ms || 0), fn, args, repeatMs: ms || 0 });
  return id;
}
function fakeClearInterval(id) { timers.delete(id); }
function advanceClock(ms) {
  const target = nowMs + ms;
  for (;;) {
    let next = null; let nextId = null;
    for (const [id, t] of timers) {
      if (t.at <= target && (next === null || t.at < next.at)) { next = t; nextId = id; }
    }
    if (!next) break;
    nowMs = next.at;
    if (next.repeatMs === null) timers.delete(nextId);
    else next.at = nowMs + next.repeatMs;
    next.fn(...next.args);
  }
  nowMs = target;
}

// ---------------------------------------------------------------------------
// Browser stubs.
// ---------------------------------------------------------------------------
function makeGradient() { return { addColorStop() {} }; }
function makeCtx2d(canvasEl) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => makeGradient();
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData') return () => ({ data: new Uint8Array(4), width: 1, height: 1 });
      if (prop === 'canvas') return canvasEl;
      return () => {};
    },
    set() { return true; },
  });
}
function makeElement(id) {
  const listeners = {};
  const el = {
    id, style: {}, textContent: '', innerHTML: '', value: '1',
    width: 0, height: 0, scrollTop: 0, scrollHeight: 0,
    paused: true, currentTime: 0, duration: NaN, volume: 1, loop: false,
    src: '', preload: '', onended: null, onloadedmetadata: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { return child; },
    remove() {},
    click() {},
    play() { el.paused = false; return Promise.resolve(); },
    pause() { el.paused = true; },
    load() {},
    getContext(kind) { return kind === '2d' ? el._ctx2d : null; },
    toBlob(cb) { if (cb) cb(null); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; },
    _listeners: listeners,
  };
  el._ctx2d = makeCtx2d(el);
  return el;
}

class FakeAudio {
  constructor(src) {
    this.src = src || '';
    this.preload = ''; this.loop = false; this.volume = 1;
    this.paused = true; this.currentTime = 0; this.duration = NaN;
    this.onended = null; this.onloadedmetadata = null;
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
}

const elements = {};
function getElementById(id) {
  if (!elements[id]) {
    elements[id] = makeElement(id);
    if (id === 'c') { elements[id].width = 1280; elements[id].height = 720; }
    if (id === 'playerCount') elements[id].value = '1';
  }
  return elements[id];
}

const windowListeners = {};
function windowAddEventListener(type, fn) {
  (windowListeners[type] = windowListeners[type] || []).push(fn);
}
function dispatchWindowEvent(type, ev) {
  for (const fn of (windowListeners[type] || [])) fn(ev);
}

// requestAnimationFrame: capture the callback; the harness pumps frames.
let rafCallback = null;
function fakeRAF(cb) { rafCallback = cb; return 1; }
function pumpFrames(n, msPerFrame = 16) {
  for (let i = 0; i < n; i++) {
    advanceClock(msPerFrame);
    const cb = rafCallback;
    rafCallback = null;
    if (!cb) throw new Error('frame loop stopped requesting frames (rAF callback missing)');
    cb(nowMs);
  }
}

const storeMap = new Map();
const localStorageStub = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => { storeMap.set(k, String(v)); },
  removeItem: (k) => { storeMap.delete(k); },
  clear: () => { storeMap.clear(); },
};

const sandbox = {
  console,
  addEventListener: windowAddEventListener,
  removeEventListener: () => {},
  performance: { now: () => nowMs },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  requestAnimationFrame: fakeRAF,
  cancelAnimationFrame: () => {},
  localStorage: localStorageStub,
  navigator: { userAgent: 'node-harness', platform: 'Linux x86_64', onLine: false, getGamepads: () => [] },
  document: {
    getElementById,
    createElement: (tag) => makeElement(tag),
    body: { appendChild() {}, removeChild() {} },
    addEventListener: windowAddEventListener,
  },
  Audio: FakeAudio,
  AudioContext: undefined,
  webkitAudioContext: undefined,
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
  fetch: () => Promise.reject(new Error('network disabled in harness')),
  prompt: () => null, // cancel by default; tests override via sandbox.__promptValue
  alert: (msg) => { sandbox.__alerts.push(String(msg)); },
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  location: { href: 'http://localhost/', search: '', reload() { sandbox.__reloads++; } },
  __alerts: [],
  __reloads: 0,
  __promptValue: null,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
// The whole game is wrapped in an arrow-function IIFE (index.html:190–4795),
// so its top-level lexicals are NOT global. Inject the eval bridge just
// before the IIFE's closing `})();` so direct eval runs inside the game's
// own scope and can see every lexical (appMode, players, barriers,
// setPlayerCount, menuItems, ...). The harness inspects the game
// exclusively through this bridge.
const closeIdx = mainJs.lastIndexOf('})();');
if (closeIdx < 0) throw new Error('main IIFE close not found');
const bridgedJs = mainJs.slice(0, closeIdx)
  + '\n;window.__TEST_EVAL = function(code){ return eval(code); };\n'
  + mainJs.slice(closeIdx);
vm.runInContext(bridgedJs, context, { filename: 'index-inline-script.js' });

function ev(code) { return sandbox.__TEST_EVAL(code); }
function keyEvent(key, code) {
  return {
    key, code: code || key,
    preventDefault() {},
    getModifierState() { return false; },
  };
}
function dispatchKey(key) { dispatchWindowEvent('keydown', keyEvent(key)); }
function dispatchKeyUp(key) { dispatchWindowEvent('keyup', keyEvent(key)); }
function pressKey(key) { dispatchKey(key); dispatchKeyUp(key); }

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

const NEO = sandbox.NEOVECTR;
if (!NEO) { console.error('FATAL: window.NEOVECTR not defined — script failed to load'); process.exit(2); }


function bootToMenu() {
  pressKey('Enter'); // firstInteraction -> startBoot
  advanceClock(21000); // boot fail-safe (20s) fires -> goMenu
}
function startSnip3(seed) {
  if (ev('appMode') !== 'MENU') NEO.game.quit();
  NEO.game.start('SNIP3', seed ? { seed } : {});
}
function startVs(seed) {
  if (ev('appMode') !== 'MENU') NEO.game.quit();
  NEO.game.start('VS', { players: 2, seed: seed || 'VS-TEST' });
}
// Freeze every enemy in place and stop it firing (deterministic combat tests).
function freezeEnemies() {
  ev('enemies.forEach(e => { e.targetX = e.x; e.targetY = e.y; e.retargetT = 999; e.fireCooldown = 999; e.spawnGrace = 999; })');
}
// Inject a laser 30px from the player, flying straight at them.
function injectLaserAtPlayer(ownerId, bouncesLeft) {
  ev(`lasers.push({ownerId:${ownerId}, x: players[0].x - 30, y: players[0].y, px: players[0].x - 30, py: players[0].y, vx:1400, vy:0, dirX:1, dirY:0, life:0, maxLife:0.6, power:0.15, bouncesLeft:${bouncesLeft}, safeTime:0})`);
}

// ---------------------------------------------------------------------------
// 0. Boot -> menu.
// ---------------------------------------------------------------------------
section('0. Boot -> menu');
check('starts in BOOT_WAIT', ev('appMode') === 'BOOT_WAIT', 'appMode=' + ev('appMode'));
bootToMenu();
check('boot fail-safe reaches MENU', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));

// ---------------------------------------------------------------------------
// 1. Starting SNIP3 builds level 1.
// ---------------------------------------------------------------------------
section('1. Start SNIP3 -> level 1');
startSnip3('SNIP3-L1');
check('enters GAME', ev('appMode') === 'GAME', 'appMode=' + ev('appMode'));
check('gameMode is SNIP3', ev('gameMode') === 'SNIP3', 'gameMode=' + ev('gameMode'));
check('1 player', ev('players.length') === 1, 'players=' + ev('players.length'));
check('level is 1', ev('snip3Level') === 1, 'snip3Level=' + ev('snip3Level'));
check('level state is fighting', ev('snip3State') === 'fighting', 'snip3State=' + ev('snip3State'));
check('level 1 spawns 3 enemies', ev('enemies.length') === 3, 'enemies=' + ev('enemies.length'));
check('level 1 enemies are all BASIC', ev('enemies.every(e => e.type === "BASIC")'),
  JSON.stringify(ev('enemies.map(e => e.type)')));
check('score starts at 0', ev('players[0].score') === 0, 'score=' + ev('players[0].score'));
check('lives start at 3', ev('players[0].lives') === 3, 'lives=' + ev('players[0].lives'));
pumpFrames(60);
check('game steps 60 frames without throwing', ev('tSec') > 0, 'tSec=' + ev('tSec'));
check('watchdog validation passes in game', NEO.watchdog.getStatus().validation.valid,
  JSON.stringify(NEO.watchdog.getStatus().validation.errors));

// ---------------------------------------------------------------------------
// 2. Enemy types are distinct.
// ---------------------------------------------------------------------------
section('2. Enemy types are distinct');
check('BASIC is slowest-firing mid-speed, 1 HP, 100 pts',
  ev('ENEMY_TYPES.BASIC.speed') === 150 && ev('ENEMY_TYPES.BASIC.hp') === 1 &&
  ev('ENEMY_TYPES.BASIC.fireInterval') === 2.4 && ev('ENEMY_TYPES.BASIC.score') === 100);
check('FAST is faster with a shorter interval, 150 pts',
  ev('ENEMY_TYPES.FAST.speed') === 260 && ev('ENEMY_TYPES.FAST.fireInterval') === 1.7 &&
  ev('ENEMY_TYPES.FAST.score') === 150);
check('MULTI fires a 3-shot spread, 200 pts',
  ev('ENEMY_TYPES.MULTI.shots') === 3 && ev('ENEMY_TYPES.MULTI.score') === 200);
check('ARMOURED has 2 HP, is slowest, 300 pts',
  ev('ENEMY_TYPES.ARMOURED.hp') === 2 && ev('ENEMY_TYPES.ARMOURED.speed') === 90 &&
  ev('ENEMY_TYPES.ARMOURED.score') === 300);
ev('spawnEnemyTank("FAST", 640, 200); spawnEnemyTank("MULTI", 700, 200); spawnEnemyTank("ARMOURED", 760, 200);');
check('spawned types carry their own defs',
  ev('enemies.filter(e => e.type === "FAST").length') === 1 &&
  ev('enemies.filter(e => e.type === "MULTI").length') === 1 &&
  ev('enemies.filter(e => e.type === "ARMOURED").length') === 1 &&
  ev('enemies.find(e => e.type === "ARMOURED").hp') === 2);

// ---------------------------------------------------------------------------
// 3. Same seed -> same level (deterministic).
// ---------------------------------------------------------------------------
section('3. Determinism: same seed -> same level 1');
startSnip3('DET-1');
const detRun1 = ev('JSON.stringify(enemies.map(e => [e.type, e.x.toFixed(2), e.y.toFixed(2)]))');
startSnip3('DET-1');
const detRun2 = ev('JSON.stringify(enemies.map(e => [e.type, e.x.toFixed(2), e.y.toFixed(2)]))');
check('same seed reproduces the same enemies', detRun1 === detRun2, detRun1 + ' vs ' + detRun2);
startSnip3('DET-2');
check('different seed gives different enemies',
  ev('JSON.stringify(enemies.map(e => [e.type, e.x.toFixed(2), e.y.toFixed(2)]))') !== detRun1);

// ---------------------------------------------------------------------------
// 4. Enemies move.
// ---------------------------------------------------------------------------
section('4. Enemies move');
startSnip3('MOVE-1');
pumpFrames(2); // let the first step settle the player spawn (constrainToSlice)
const before = ev('JSON.stringify(enemies.map(e => [e.x, e.y]))');
pumpFrames(60); // ~1s: inside the no-fire window (grace 0.8s + first interval >= 1.44s)
const after = ev('JSON.stringify(enemies.map(e => [e.x, e.y]))');
check('at least one enemy moved', before !== after, before + ' vs ' + after);
check('player still alive (no enemy fire yet)', ev('players[0].alive') === true);
check('player still has 3 lives', ev('players[0].lives') === 3);

// ---------------------------------------------------------------------------
// 5. Enemies fire (enemy lasers follow player ricochet rules).
// ---------------------------------------------------------------------------
section('5. Enemies fire');
startSnip3('FIRE-1');
ev('barriers.length = 0'); // no ricochet randomness in the firing check
ev('players[0].x = 640; players[0].y = 100;');
ev('enemies[0].x = 640; enemies[0].y = 620; enemies[0].targetX = 640; enemies[0].targetY = 620; enemies[0].retargetT = 999; enemies[0].fireCooldown = 0; enemies[0].spawnGrace = 0;');
pumpFrames(5);
check('an enemy laser exists after the enemy fires',
  ev('lasers.some(L => (L.ownerId | 0) < -1)'), 'lasers=' + ev('JSON.stringify(lasers.map(L => L.ownerId))'));
check('enemy laser has 2 bounces, like a player laser',
  ev('lasers.filter(L => (L.ownerId | 0) < -1).every(L => L.bouncesLeft === 2)'));
check('enemy laser does not hit its own tank before bouncing',
  ev('enemies[0].alive') === true);

// ---------------------------------------------------------------------------
// 6. Player laser kills a BASIC enemy -> +100.
// ---------------------------------------------------------------------------
section('6. Player laser kills BASIC -> score');
startSnip3('KILL-1');
ev('barriers.length = 0');
freezeEnemies();
ev('players[0].x = 640; players[0].y = 360; players[0].aimX = 1; players[0].aimY = 0;');
ev('enemies[0].x = 900; enemies[0].y = 360; enemies[0].targetX = 900; enemies[0].targetY = 360;');
ev('spawnLaserFromP1(0.15)');
pumpFrames(12);
check('enemy is gone after the shot', ev('enemies.length') === 2, 'enemies=' + ev('enemies.length'));
check('kill scores +100', ev('players[0].score') === 100, 'score=' + ev('players[0].score'));

// ---------------------------------------------------------------------------
// 7. ARMOURED takes two hits.
// ---------------------------------------------------------------------------
section('7. ARMOURED takes two hits');
startSnip3('ARM-1');
ev('barriers.length = 0; enemies.length = 0; spawnEnemyTank("ARMOURED", 900, 360);');
freezeEnemies();
ev('players[0].x = 640; players[0].y = 360; players[0].aimX = 1; players[0].aimY = 0;');
ev('spawnLaserFromP1(0.15)');
pumpFrames(12);
check('armoured survives the first hit', ev('enemies.length') === 1, 'enemies=' + ev('enemies.length'));
check('armoured is down to 1 HP', ev('enemies[0].hp') === 1, 'hp=' + ev('enemies[0] && enemies[0].hp'));
check('first hit scores nothing', ev('players[0].score') === 0, 'score=' + ev('players[0].score'));
// Re-aim: step() re-derives the aim from the mouse every frame, so the
// aim set before the first shot is gone by now.
ev('players[0].aimX = 1; players[0].aimY = 0;');
ev('spawnLaserFromP1(0.15)');
pumpFrames(12);
check('armoured dies on the second hit', ev('enemies.length') === 0, 'enemies=' + ev('enemies.length'));
check('armoured kill scores +300 (plus the level-clear bonus at most)',
  ev('players[0].score') >= 300, 'score=' + ev('players[0].score'));

// ---------------------------------------------------------------------------
// 8. Clearing a level advances to the next, with the bonus.
// ---------------------------------------------------------------------------
section('8. Clear level -> advance');
startSnip3('LVL-1');
ev('enemies.slice().forEach(e => damageEnemy(e, 99, e.x, e.y))');
check('all level 1 enemies destroyed', ev('enemies.every(e => !e.alive)'));
pumpFrames(120); // 1.92s: covers the 1.6s clear breather, level 2 in spawn grace
check('level advanced to 2', ev('snip3Level') === 2, 'snip3Level=' + ev('snip3Level'));
check('level 2 spawns 4 BASIC enemies', ev('enemies.length') === 4 &&
  ev('enemies.every(e => e.type === "BASIC")'), 'enemies=' + ev('JSON.stringify(enemies.map(e => e.type))'));
check('score is 3 kills + level 1 clear bonus (300 + 100)',
  ev('players[0].score') === 400, 'score=' + ev('players[0].score'));
check('level state is fighting again', ev('snip3State') === 'fighting', 'snip3State=' + ev('snip3State'));

// ---------------------------------------------------------------------------
// 9. Enemy laser kills the player -> life lost, level restarts.
// ---------------------------------------------------------------------------
section('9. Enemy laser kills player -> lose a life, restart level');
startSnip3('DIE-1');
pumpFrames(2); // settle the player spawn before aiming a laser at them
ev('barriers.length = 0');
ev(`lasers.push({ownerId:-2, x: players[0].x + 100, y: players[0].y, px: players[0].x + 100, py: players[0].y, vx:-1250, vy:0, dirX:-1, dirY:0, life:0, maxLife:0.6, power:0.15, bouncesLeft:2, safeTime:0})`);
pumpFrames(10);
check('player is dead after the enemy laser hits', ev('players[0].alive') === false);
check('a life is lost (3 -> 2)', ev('players[0].lives') === 2, 'lives=' + ev('players[0].lives'));
check('level state is dead (respawn timer running)', ev('snip3State') === 'dead', 'snip3State=' + ev('snip3State'));
pumpFrames(100); // 1.6s: covers the 1.4s death timer
check('player respawns', ev('players[0].alive') === true);
check('still 2 lives after respawn', ev('players[0].lives') === 2, 'lives=' + ev('players[0].lives'));
check('same level restarts (level 1)', ev('snip3Level') === 1, 'snip3Level=' + ev('snip3Level'));
check('level 1 enemies are back (3 BASIC)', ev('enemies.length') === 3 &&
  ev('enemies.every(e => e.type === "BASIC")'), 'enemies=' + ev('enemies.length'));
check('score is untouched by death', ev('players[0].score') === 0, 'score=' + ev('players[0].score'));

// ---------------------------------------------------------------------------
// 10. At 0 lives the run ends on GAMEOVER, then returns to menu.
// ---------------------------------------------------------------------------
section('10. Zero lives -> GAMEOVER -> menu');
startSnip3('OVER-1');
pumpFrames(2); // settle the player spawn before aiming a laser at them
ev('players[0].lives = 1; barriers.length = 0;');
ev(`lasers.push({ownerId:-2, x: players[0].x + 100, y: players[0].y, px: players[0].x + 100, py: players[0].y, vx:-1250, vy:0, dirX:-1, dirY:0, life:0, maxLife:0.6, power:0.15, bouncesLeft:2, safeTime:0})`);
pumpFrames(10);
check('last life lost (1 -> 0)', ev('players[0].lives') === 0, 'lives=' + ev('players[0].lives'));
pumpFrames(100); // death timer expires with no lives left
check('game over screen shows', ev('appMode') === 'GAMEOVER', 'appMode=' + ev('appMode'));
pumpFrames(5);
check('game-over screen renders without throwing (5 frames pumped)', true);
check('watchdog accepts GAMEOVER as a valid mode', NEO.watchdog.getStatus().validation.valid,
  JSON.stringify(NEO.watchdog.getStatus().validation.errors));
dispatchKey('Enter'); // press anything (held) -> goMenu
for (let f = 0; f < 30 && ev('appMode') === 'GAMEOVER'; f++) pumpFrames(1);
dispatchKeyUp('Enter');
check('pressing anything returns to MENU', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));

// ---------------------------------------------------------------------------
// 11. Self-hit = death (but a fresh shot can't kill you).
// ---------------------------------------------------------------------------
section('11. Self-hit = death');
startSnip3('SELF-1');
pumpFrames(2); // settle the player spawn before aiming a laser at them
ev('barriers.length = 0');
injectLaserAtPlayer(0, 2); // fresh shot: 2 bounces left, hasn't bounced
pumpFrames(5);
check('a fresh shot passing through you does NOT kill you',
  ev('players[0].alive') === true && ev('players[0].lives') === 3,
  'alive=' + ev('players[0].alive') + ' lives=' + ev('players[0].lives'));
ev('lasers.length = 0');
injectLaserAtPlayer(0, 1); // bounced once: 1 bounce left
pumpFrames(5);
check('your own ricochet kills you', ev('players[0].alive') === false);
check('self-hit loses a life (3 -> 2)', ev('players[0].lives') === 2, 'lives=' + ev('players[0].lives'));
check('self-hit starts the death timer', ev('snip3State') === 'dead', 'snip3State=' + ev('snip3State'));

// ---------------------------------------------------------------------------
// 12. VS rules unchanged (own laser after a bounce eliminates; a kill
//     ends the round with the right winner) — and the victory screen works.
// ---------------------------------------------------------------------------
section('12. VS behaviour (restored, not changed in rule)');
startVs('VS-1');
pumpFrames(2); // settle the player spawns before aiming lasers at them
check('VS starts with 2 players', ev('players.length') === 2, 'players=' + ev('players.length'));
ev(`lasers.push({ownerId:0, x: players[0].x - 30, y: players[0].y, px: players[0].x - 30, py: players[0].y, vx:1400, vy:0, dirX:1, dirY:0, life:0, maxLife:0.6, power:0.15, bouncesLeft:2, safeTime:0})`);
pumpFrames(5);
check('VS: your own FRESH laser cannot hit you',
  ev('players[0].alive') === true, 'P1 alive=' + ev('players[0].alive'));
ev('lasers.length = 0');
ev(`lasers.push({ownerId:0, x: players[0].x - 30, y: players[0].y, px: players[0].x - 30, py: players[0].y, vx:1400, vy:0, dirX:1, dirY:0, life:0, maxLife:0.6, power:0.15, bouncesLeft:1, safeTime:0})`);
pumpFrames(5);
check('VS: your own BOUNCED laser eliminates you', ev('players[0].alive') === false);
check('VS: elimination ends the round', ev('appMode') === 'VICTORY', 'appMode=' + ev('appMode'));
check('VS: winner is P2 (index 1)', ev('winnerId') === 1, 'winnerId=' + ev('winnerId'));
pumpFrames(5);
check('victory screen renders without throwing (5 frames pumped)', true);

startVs('VS-2');
pumpFrames(2); // settle the player spawns before aiming a laser at P2
ev(`lasers.push({ownerId:0, x: players[1].x - 60, y: players[1].y, px: players[1].x - 60, py: players[1].y, vx:1400, vy:0, dirX:1, dirY:0, life:0, maxLife:0.6, power:0.15, bouncesLeft:2, safeTime:0})`);
pumpFrames(5);
check('VS: a laser kill eliminates the target', ev('players[1].alive') === false);
check('VS: kill ends the round', ev('appMode') === 'VICTORY', 'appMode=' + ev('appMode'));
check('VS: winner is P1 (index 0)', ev('winnerId') === 0, 'winnerId=' + ev('winnerId'));

// ---------------------------------------------------------------------------
// 13. The pie-slice arena is unchanged (no rectangular block walls).
// ---------------------------------------------------------------------------
section('13. Pie-slice arena unchanged');
startSnip3('ARENA-1');
check('SNIP3 still has one radial barrier per slice', ev('barriers.length') === 1, 'barriers=' + ev('barriers.length'));
check('barriers are still radial chords (x0/y0/x1/y1/r/slice)',
  ev('barriers.every(b => b.x0 !== undefined && b.y0 !== undefined && b.x1 !== undefined && b.y1 !== undefined && b.r !== undefined && b.slice !== undefined)'),
  JSON.stringify(ev('barriers')));
check('barriers have no rectangle fields',
  ev('barriers.every(b => b.w === undefined && b.h === undefined && b.x === undefined && b.y === undefined)'));
check('no rectangular-arena code exists',
  ev('typeof rectBarriers') === 'undefined' && ev('typeof blockWalls') === 'undefined' &&
  ev('typeof initRectBarriers') === 'undefined' && ev('typeof rectBarrier') === 'undefined');
check('initBarriers (radial) still exists', ev('typeof initBarriers') === 'function');

// ---------------------------------------------------------------------------
// 14. Trail / dash / charge are KEPT.
// ---------------------------------------------------------------------------
section('14. Trail / dash / charge kept');
startSnip3('KEEP-1');
pumpFrames(30);
check('player trail still grows (visual only, kept)',
  ev('players[0].trail.length') > 0, 'trail=' + ev('players[0].trail.length'));
check('charge shot still exists (0.85 s)', ev('CHARGE_TIME') === 0.85, 'CHARGE_TIME=' + ev('CHARGE_TIME'));
check('dash still exists (boost cooldown 1.0 s, impulse 1900)',
  ev('BOOST_COOLDOWN') === 1.0 && ev('BOOST_IMPULSE_MAX') === 1900);
check('trail drawing still exists', ev('typeof drawPlayerTrail') === 'function');

// ---------------------------------------------------------------------------
// 15. Quit tears the SNIP3 run down; a fresh start resets.
// ---------------------------------------------------------------------------
section('15. Quit tears down, fresh start resets');
startSnip3('QUIT-1');
ev('players[0].score = 500;');
check('score set to 500 for the test', ev('players[0].score') === 500);
NEO.game.quit();
check('quit returns to MENU', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));
check('enemies torn down', ev('enemies.length') === 0, 'enemies=' + ev('enemies.length'));
check('players torn down', ev('players.length') === 0, 'players=' + ev('players.length'));
check('barriers torn down', ev('barriers.length') === 0, 'barriers=' + ev('barriers.length'));
startSnip3('QUIT-1');
check('fresh start is level 1', ev('snip3Level') === 1, 'snip3Level=' + ev('snip3Level'));
check('fresh start resets score to 0', ev('players[0].score') === 0, 'score=' + ev('players[0].score'));
check('fresh start resets lives to 3', ev('players[0].lives') === 3, 'lives=' + ev('players[0].lives'));
check('fresh start spawns level 1 enemies', ev('enemies.length') === 3, 'enemies=' + ev('enemies.length'));

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) { console.log('Failed checks: ' + failures.join(' | ')); process.exit(1); }
console.log('ALL CHECKS PASSED');
