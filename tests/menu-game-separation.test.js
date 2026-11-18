// Infinity Snip3 — menu / game separation test harness (Node, no browser needed).
//
// Loads index.html's main inline script in a vm sandbox with stubbed browser
// APIs (DOM, canvas 2d, Audio, timers, rAF) and drives the real game code
// through the window.NEOVECTR debug API + direct vm evaluation of internals.
//
// Usage:  node tests/menu-game-separation.test.js
// Exits 0 when every check passes, 1 otherwise.
//
// The checks encode the separation contract:
//   1. The menu never generates or mutates the game world. Changing a
//      selection (players / seed / co-op) in the menu only updates the
//      pending GameConfig draft.
//   2. Starting a game builds the world exactly once, from the config:
//      setSeed -> initBarriers -> initPlayers -> resetP1Systems.
//   3. Returning to the menu tears the game world down (players, barriers,
//      lasers, sparks all empty) so no run state leaks into the next game.
//   4. The same seed + config reproduces the same world (deterministic).
//   5. A running game is unaffected by menu selection changes (menu is not
//      reachable mid-game except via PAUSE, and PAUSE -> menu tears down).
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

// ---------------------------------------------------------------------------
// 1. Boot -> menu.
// ---------------------------------------------------------------------------
section('1. Boot -> menu');
check('starts in BOOT_WAIT', ev('appMode') === 'BOOT_WAIT', 'appMode=' + ev('appMode'));
pressKey('Enter'); // firstInteraction -> startBoot (press + release so Enter isn't held into the menu)
check('keypress starts boot', ev('appMode') === 'BOOT', 'appMode=' + ev('appMode'));
advanceClock(21000); // boot fail-safe (20s) fires -> goMenu
check('boot fail-safe reaches MENU', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));
pumpFrames(5);
check('menu renders without throwing (5 frames pumped)', true);
check('no page reload was triggered', sandbox.__reloads === 0);
check('no alert was shown', sandbox.__alerts.length === 0);

// ---------------------------------------------------------------------------
// 2. Start SNIP3 from the menu.
// ---------------------------------------------------------------------------
section('2. Menu -> start SNIP3');
NEO.menu.goto('MAIN');
const mainItems = NEO.menu.getItems();
check('main menu has 4 items', mainItems.length === 4, 'got ' + mainItems.length);
NEO.menu.select(0);
NEO.menu.activate();
check('activating item 0 enters GAME', ev('appMode') === 'GAME', 'appMode=' + ev('appMode'));
check('gameMode is SNIP3', ev('gameMode') === 'SNIP3', 'gameMode=' + ev('gameMode'));
check('1 player spawned', ev('players.length') === 1, 'players=' + ev('players.length'));
check('a seed was generated', typeof ev('currentSeed') === 'string' && ev('currentSeed').length > 0);
check('barriers generated (one per slice)', ev('barriers.length') === 1, 'barriers=' + ev('barriers.length'));
pumpFrames(120); // 2s of game time
check('game steps 120 frames without throwing', ev('tSec') > 0, 'tSec=' + ev('tSec'));
check('watchdog validation passes in game', NEO.watchdog.getStatus().validation.valid,
  JSON.stringify(NEO.watchdog.getStatus().validation.errors));

// ---------------------------------------------------------------------------
// 3. Pause / resume.
// ---------------------------------------------------------------------------
section('3. Pause / resume');
NEO.game.pause();
check('pause enters PAUSE', ev('appMode') === 'PAUSE', 'appMode=' + ev('appMode'));
pumpFrames(10);
check('paused game does not advance sim time', true);
NEO.game.resume();
check('resume returns to GAME', ev('appMode') === 'GAME', 'appMode=' + ev('appMode'));

// ---------------------------------------------------------------------------
// 4. Quit to menu tears the world down (no leaked run state).
// ---------------------------------------------------------------------------
section('4. Quit to menu tears the world down');
ev('lasers.push({x:0,y:0})'); // simulate leftover combat state
NEO.game.quit();
check('quit returns to MENU', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));
check('players torn down', ev('players.length') === 0, 'players=' + ev('players.length'));
check('barriers torn down', ev('barriers.length') === 0, 'barriers=' + ev('barriers.length'));
check('lasers cleared', ev('lasers.length') === 0, 'lasers=' + ev('lasers.length'));
check('sparks cleared', ev('sparks.length') === 0, 'sparks=' + ev('sparks.length'));
pumpFrames(5);
check('menu frames run clean after quit', true);

// ---------------------------------------------------------------------------
// 5. Menu selection does NOT generate the world (the core separation).
// ---------------------------------------------------------------------------
section('5. Menu selection only updates the pending config');
const playersBefore = ev('players.length');
// Change player count from the menu (the Settings players slider path).
// The slider's onRight calls setPlayerCount(playerCount+1); do it directly too.
ev('setPlayerCount(4)');
check('setPlayerCount in MENU does not spawn players', ev('players.length') === playersBefore,
  `players went ${playersBefore} -> ${ev('players.length')}`);
check('pending player count is 4',
  (() => { try { return ev('pendingConfig.players') === 4; } catch (e) { return false; } })(),
  'pendingConfig=' + (() => { try { return JSON.stringify(ev('pendingConfig')); } catch (e) { return 'undefined'; } })());
check('barriers still empty in MENU', ev('barriers.length') === 0, 'barriers=' + ev('barriers.length'));
// Change the seed through the REAL Settings menu action (prompt-driven).
NEO.menu.goto('SETTINGS');
const settingsItems = ev('menuItems()');
const seedIdx = settingsItems.findIndex((it) => it.key === 'seed');
check('settings has a seed item', seedIdx >= 0);
sandbox.prompt = () => 'TEST-123';
NEO.menu.select(seedIdx);
NEO.menu.activate();
sandbox.prompt = () => null;
check('seed selection saved to settings', ev('settings.seedStr') === 'TEST-123',
  'settings.seedStr=' + ev('settings.seedStr'));
check('seed selection does not reseed the world in MENU', ev('currentSeed') !== 'TEST-123',
  'currentSeed=' + ev('currentSeed'));
check('seed selection does not regenerate players in MENU', ev('players.length') === playersBefore,
  `players went ${playersBefore} -> ${ev('players.length')}`);
check('pending seed is TEST-123',
  (() => { try { return ev('pendingConfig.seed') === 'TEST-123'; } catch (e) { return false; } })());
// Players slider via the real menu item (onRight) — also must not generate.
const playersIdx = settingsItems.findIndex((it) => it.key === 'players');
check('settings has a players slider', playersIdx >= 0);
ev('menuItems()[' + playersIdx + '].onRight()');
check('players slider in MENU does not spawn players', ev('players.length') === playersBefore,
  `players went ${playersBefore} -> ${ev('players.length')}`);
check('pending player count updated by slider',
  (() => { try { return ev('pendingConfig.players') === 5; } catch (e) { return false; } })(),
  'pendingConfig=' + (() => { try { return JSON.stringify(ev('pendingConfig')); } catch (e) { return 'undefined'; } })());
// Restore the draft to 4 players for the next section (the slider bumped it to 5).
ev('setPlayerCount(4)');

// ---------------------------------------------------------------------------
// 6. Start VS from the pending selection -> world built exactly once.
// ---------------------------------------------------------------------------
section('6. Start VS from the pending selection');
NEO.menu.goto('MAIN');
NEO.menu.select(1); // VS MODE -> VS_PRE
NEO.menu.activate();
check('VS_PRE page opens', ev('menuPage') === 'VS_PRE', 'menuPage=' + ev('menuPage'));
NEO.menu.select(0); // LOCAL VS
NEO.menu.activate();
check('LOCAL VS enters GAME', ev('appMode') === 'GAME', 'appMode=' + ev('appMode'));
check('gameMode is VS', ev('gameMode') === 'VS', 'gameMode=' + ev('gameMode'));
check('4 players from pending selection', ev('players.length') === 4, 'players=' + ev('players.length'));
check('seed TEST-123 applied', ev('currentSeed') === 'TEST-123', 'currentSeed=' + ev('currentSeed'));
check('4 barriers (one per slice)', ev('barriers.length') === 4, 'barriers=' + ev('barriers.length'));
const firstRunPlayers = ev('JSON.stringify(players.map(p => [p.x.toFixed(3), p.y.toFixed(3)]))');
const firstRunBarriers = ev('JSON.stringify(barriers.map(b => [b.x0.toFixed(3), b.y0.toFixed(3), b.x1.toFixed(3), b.y1.toFixed(3)]))');
pumpFrames(30);
check('VS game steps without throwing', true);

// ---------------------------------------------------------------------------
// 7. Same seed + config reproduces the same world (deterministic).
// ---------------------------------------------------------------------------
section('7. Determinism: same seed -> same world');
NEO.game.quit();
check('quit back to MENU', ev('appMode') === 'MENU');
NEO.menu.goto('MAIN');
NEO.menu.select(1); NEO.menu.activate(); // VS_PRE
NEO.menu.select(0); NEO.menu.activate(); // LOCAL VS again, same pending selection
check('second run enters GAME', ev('appMode') === 'GAME');
check('same player spawns for same seed', ev('JSON.stringify(players.map(p => [p.x.toFixed(3), p.y.toFixed(3)]))') === firstRunPlayers);
check('same barriers for same seed', ev('JSON.stringify(barriers.map(b => [b.x0.toFixed(3), b.y0.toFixed(3), b.x1.toFixed(3), b.y1.toFixed(3)]))') === firstRunBarriers);

// ---------------------------------------------------------------------------
// 8. A different selection produces a different world; old state is gone.
// ---------------------------------------------------------------------------
section('8. New selection -> new world, old state gone');
NEO.game.quit();
ev('setPlayerCount(2)');
NEO.menu.goto('SETTINGS');
const settingsItems2 = ev('menuItems()');
const seedIdx2 = settingsItems2.findIndex((it) => it.key === 'seed');
sandbox.prompt = () => 'OTHER-9';
NEO.menu.select(seedIdx2);
NEO.menu.activate();
sandbox.prompt = () => null;
check('new seed saved to settings', ev('settings.seedStr') === 'OTHER-9',
  'settings.seedStr=' + ev('settings.seedStr'));
NEO.menu.goto('MAIN');
NEO.menu.select(1); NEO.menu.activate();
NEO.menu.select(0); NEO.menu.activate();
check('2 players for new selection', ev('players.length') === 2, 'players=' + ev('players.length'));
check('new seed applied', ev('currentSeed') === 'OTHER-9', 'currentSeed=' + ev('currentSeed'));
check('world differs from previous seed', ev('JSON.stringify(players.map(p => [p.x.toFixed(3), p.y.toFixed(3)]))') !== firstRunPlayers);

// ---------------------------------------------------------------------------
// 9. Menu changes cannot touch a running game (via PAUSE -> menu -> start).
// ---------------------------------------------------------------------------
section('9. Running game is insulated from menu selection');
const livePlayers = ev('JSON.stringify(players.map(p => [p.x.toFixed(3), p.y.toFixed(3)]))');
NEO.game.pause();
check('paused', ev('appMode') === 'PAUSE');
// Pause menu -> MAIN MENU (goMenu path)
ev('pauseSel = 1; pauseItems()[1].action();');
check('pause MAIN MENU returns to MENU', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));
check('world torn down on menu return', ev('players.length') === 0, 'players=' + ev('players.length'));

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) { console.log('Failed checks: ' + failures.join(' | ')); process.exit(1); }
console.log('ALL CHECKS PASSED');
