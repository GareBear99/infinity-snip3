// Infinity Snip3 — boot sign + Game Center test harness (Node, no browser needed).
//
// Loads index.html's main inline script in a vm sandbox (same harness shape as
// menu-game-separation.test.js) and checks:
//   1. bootSignGate maps analyser energy to a sign drive: silence ~0, the slow
//      build dim, the Moses blast full.
//   2. The boot neon sign follows the cannon: with a fake analyser feeding the
//      real computeBootEnergy path, the sign's peak-hold stays ~0 in silence,
//      glows dimly through the build, flares to full at the blast, and dies
//      again in the trailing silence. Without an analyser it falls back to the
//      old time ramp (hold unused).
//   3. Game Center sign-in (local arcade profile): create / case-insensitive
//      re-sign-in / switch / persist + reload restore / sign out / delete.
//   4. While the Game Center panel is open, menu input is locked (Enter does
//      not activate a menu item) and closing clears the key set.
//   5. Geometry: the hexagon button clears the bottom nav hint text at
//      1280x720 and at 960x540; the lobby button is bottom-right, not centered.
//
// Usage:  node tests/boot-sign-and-gamecenter.test.js
// Exits 0 when every check passes, 1 otherwise.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const lines = html.split('\n');
let scriptEnd = -1;
for (let i = 93; i < lines.length; i++) {
  if (lines[i].includes('</script>')) { scriptEnd = i; break; }
}
if (scriptEnd < 0) throw new Error('main </script> not found');
const mainJs = lines.slice(94, scriptEnd).join('\n');

// ---------------------------------------------------------------------------
// Controllable clock + timers.
// ---------------------------------------------------------------------------
let nowMs = 0;
let timerSeq = 0;
const timers = new Map();
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
// Browser stubs (same shape as menu-game-separation.test.js).
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
  prompt: () => null,
  alert: (msg) => { sandbox.__alerts.push(String(msg)); },
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  location: { href: 'http://localhost/', search: '', reload() { sandbox.__reloads++; } },
  __alerts: [],
  __reloads: 0,
  __promptValue: null,
  __bootLevel: 0,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
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
function approx(actual, expected, tol) { return Math.abs(actual - expected) <= tol; }

const NEO = sandbox.NEOVECTR;
if (!NEO) { console.error('FATAL: window.NEOVECTR not defined — script failed to load'); process.exit(2); }

// ---------------------------------------------------------------------------
// 0. Boot -> menu (shared setup).
// ---------------------------------------------------------------------------
section('0. Boot -> menu');
check('starts in BOOT_WAIT', ev('appMode') === 'BOOT_WAIT', 'appMode=' + ev('appMode'));
pressKey('Enter');
check('keypress starts boot', ev('appMode') === 'BOOT', 'appMode=' + ev('appMode'));
advanceClock(21000);
check('boot fail-safe reaches MENU', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));
pumpFrames(3);

// ---------------------------------------------------------------------------
// 1. bootSignGate mapping (pure function, real code).
// ---------------------------------------------------------------------------
section('1. bootSignGate mapping');
check('silence maps to ~0', approx(ev('bootSignGate(0.02)'), 0, 0.01), 'got ' + ev('bootSignGate(0.02)'));
check('build maps dim (0.55-0.67 -> 0.23-0.42)', ev('bootSignGate(0.60)') > 0.2 && ev('bootSignGate(0.60)') < 0.45, 'got ' + ev('bootSignGate(0.60)'));
check('blast maps to full (0.92 -> 1.0)', approx(ev('bootSignGate(0.92)'), 1, 0.001), 'got ' + ev('bootSignGate(0.92)'));
check('zero maps to zero', ev('bootSignGate(0)') === 0);
check('full maps to full', ev('bootSignGate(1)') === 1);

// ---------------------------------------------------------------------------
// 2. The sign follows the cannon (real drawBootScreen + fake analyser).
// ---------------------------------------------------------------------------
section('2. Sign follows the cannon');
// Fake analyser: fills the first 28 freq bins with window.__bootLevel.
ev(`bootFreq = new Uint8Array(1024);
bootAnalyser = { getByteFrequencyData: function(arr){ for (let i=0;i<28;i++) arr[i] = window.__bootLevel; } };`);
ev(`appMode = 'BOOT'; bootT0 = performance.now(); bootSignHold = 0; bootEnergySm = 0; bootFlash = 0;`);
sandbox.__bootLevel = 5; // silence (energy ~0.02)
pumpFrames(10);
check('silence: sign hold stays ~0', ev('bootSignHold') < 0.05, 'hold=' + ev('bootSignHold'));
sandbox.__bootLevel = 150; // slow build (energy ~0.59)
pumpFrames(30);
const buildHold = ev('bootSignHold');
check('build: sign glows dimly (0.2-0.4)', buildHold > 0.2 && buildHold < 0.4, 'hold=' + buildHold);
sandbox.__bootLevel = 230; // the blast (energy ~0.90)
pumpFrames(30);
const blastHold = ev('bootSignHold');
check('blast: sign flares to full (>0.9)', blastHold > 0.9, 'hold=' + blastHold);
sandbox.__bootLevel = 5; // trailing silence again
pumpFrames(120);
const tailHold = ev('bootSignHold');
check('trailing silence: sign dies back down (<0.2)', tailHold < 0.2, 'hold=' + tailHold);
// No analyser -> old time ramp path (hold unused, no throw).
ev(`bootAnalyser = null; bootFreq = null; bootSignHold = 0; bootT0 = performance.now();`);
pumpFrames(5);
check('no analyser: fallback runs without throwing, hold stays 0', ev('bootSignHold') === 0, 'hold=' + ev('bootSignHold'));
// Back to the menu for the remaining sections.
ev(`appMode = 'MENU'; menuPage = 'MAIN'; menuSel = 0;`);
pumpFrames(2);

// ---------------------------------------------------------------------------
// 3. Game Center sign-in (local arcade profile).
// ---------------------------------------------------------------------------
section('3. Game Center sign-in');
check('starts signed out, no profiles', NEO.gameCenter.getState().active === null && NEO.gameCenter.getState().profiles.length === 0,
  JSON.stringify(NEO.gameCenter.getState()));
check('blank name is rejected', NEO.gameCenter.signIn('   ') === null);
check('blank sign-in changes nothing', NEO.gameCenter.getState().active === null);
check('sign in as Gary', NEO.gameCenter.signIn('Gary') === 'Gary');
check('active is Gary', NEO.gameCenter.getState().active === 'Gary');
check('one profile saved', NEO.gameCenter.getState().profiles.length === 1);
check('re-sign-in is case-insensitive, no duplicate', NEO.gameCenter.signIn('gary') === 'Gary' && NEO.gameCenter.getState().profiles.length === 1,
  JSON.stringify(NEO.gameCenter.getState()));
check('second profile signs in', NEO.gameCenter.signIn('BassBruh') === 'BassBruh');
check('two profiles saved', NEO.gameCenter.getState().profiles.length === 2);
check('profile persisted to storage', (() => {
  const raw = storeMap.get('NEO-VECTR_gamecenter_v1');
  if (!raw) return false;
  const obj = JSON.parse(raw);
  return obj.active === 'BassBruh' && obj.profiles.length === 2;
})(), 'stored=' + (storeMap.get('NEO-VECTR_gamecenter_v1') || 'none'));
// Simulate a reload: wipe in-memory state, reload from storage.
ev(`gameCenter = { profiles: [], active: null }; loadGameCenter();`);
check('reload restores active profile', NEO.gameCenter.getState().active === 'BassBruh', JSON.stringify(NEO.gameCenter.getState()));
check('reload restores both profiles', NEO.gameCenter.getState().profiles.length === 2);
NEO.gameCenter.signOut();
check('sign out clears active, keeps profiles', NEO.gameCenter.getState().active === null && NEO.gameCenter.getState().profiles.length === 2);
NEO.gameCenter.deleteProfile('Gary');
check('delete removes the profile', NEO.gameCenter.getState().profiles.length === 1 && NEO.gameCenter.getState().profiles[0] === 'BassBruh',
  JSON.stringify(NEO.gameCenter.getState()));
check('delete persists', (() => {
  const obj = JSON.parse(storeMap.get('NEO-VECTR_gamecenter_v1'));
  return obj.profiles.length === 1 && obj.profiles[0].name === 'BassBruh';
})());

// ---------------------------------------------------------------------------
// 4. Menu input is locked while the panel is open.
// ---------------------------------------------------------------------------
section('4. Menu input locked while panel open');
NEO.menu.goto('MAIN');
NEO.menu.select(0);
const selBefore = ev('menuSel');
NEO.gameCenter.open();
check('panel reports open', NEO.gameCenter.isOpen() === true);
dispatchKey('Enter'); // would activate menu item 0 (start SNIP3) if not locked
pumpFrames(3);
check('Enter does not activate a menu item while open', ev('appMode') === 'MENU' && ev('menuSel') === selBefore,
  'appMode=' + ev('appMode') + ' menuSel=' + ev('menuSel'));
dispatchKeyUp('Enter');
NEO.gameCenter.close();
check('panel reports closed', NEO.gameCenter.isOpen() === false);
check('closing clears the key set', ev('keys.size') === 0, 'keys.size=' + ev('keys.size'));
pumpFrames(2);
check('no activation leaks through after close', ev('appMode') === 'MENU', 'appMode=' + ev('appMode'));

// ---------------------------------------------------------------------------
// 5. Geometry: hexagon clears the nav hint; lobby button is bottom-right.
// ---------------------------------------------------------------------------
section('5. Geometry');
function checkHexagonClearance(label) {
  pumpFrames(1);
  const rect = JSON.parse(ev('JSON.stringify(rainbowBtnRect)'));
  const cw = ev('canvas.width');
  const ch = ev('canvas.height');
  const fs = Math.floor(Math.min(cw, ch) * 0.06);
  const navY = ch - fs * 0.25;
  const hintTop = navY - fs * 0.24; // nav hint font is fs*0.24, baseline bottom at navY
  const btnBottom = rect.y + rect.h;
  check(label + ': hexagon visible on MAIN', rect.visible === true, JSON.stringify(rect));
  check(label + ': hexagon bottom clears nav hint text top by >= 8px',
    btnBottom < hintTop - 8, `btnBottom=${btnBottom.toFixed(1)} hintTop=${hintTop.toFixed(1)}`);
  // Caption sits between button bottom and hint top (navY - fs*0.68 .. navY - fs*0.50).
  const capTop = navY - fs * 0.68;
  const capBottom = navY - fs * 0.50;
  check(label + ': caption band is clear of both button and hint',
    capTop > btnBottom + 2 && capBottom < hintTop - 2,
    `capTop=${capTop.toFixed(1)} capBottom=${capBottom.toFixed(1)} btnBottom=${btnBottom.toFixed(1)} hintTop=${hintTop.toFixed(1)}`);
}
checkHexagonClearance('1280x720');
sandbox.innerWidth = 960;
sandbox.innerHeight = 540;
ev('resize()');
check('resize to 960x540 took effect', ev('canvas.width') === 960 && ev('canvas.height') === 540,
  'canvas=' + ev('canvas.width') + 'x' + ev('canvas.height'));
checkHexagonClearance('960x540');
check('lobby button moved to bottom-right (no bottom:110px centering)',
  html.includes('right:18px') && html.includes('bottom:18px') && !html.includes('bottom:110px'));
check('Game Center panel HTML exists',
  html.includes('id="gameCenterOverlay"') && html.includes('id="gameCenterName"') && html.includes('id="gameCenterSignInBtn"'));
check('hexagon no longer triggers the lobby hold',
  !html.includes("lobbyHoldSource = 'button'"));

// ---------------------------------------------------------------------------
// 6. Ricochet tone-down: bounce is a small glint, not an explosion.
// ---------------------------------------------------------------------------
section('6. Ricochet tone-down');
check('old bounce explosion is gone from the code',
  !html.includes('spawnExplosion(L.x, L.y, 0.22'));
check('bounce now uses the flash', html.includes('spawnBounceFlash(L.x, L.y)'));
check('final collision keeps the big explosion',
  html.includes('spawnExplosion(L.x, L.y, 0.65 + 0.55*L.power)'));
// Direct: a bounce flash is 6 small, short, pale-cyan glints.
ev('sparks.length = 0; spawnBounceFlash(100, 100);');
check('flash spawns 6 sparks', ev('sparks.length') === 6, 'sparks=' + ev('sparks.length'));
check('flash sparks are small (<2)', ev('sparks.every(s => s.size < 2)'), 'sizes=' + ev('JSON.stringify(sparks.map(s => s.size.toFixed(2)))'));
check('flash sparks are short-lived (<0.25s)', ev('sparks.every(s => s.maxLife < 0.25)'));
check('flash sparks are pale cyan, not orange', ev('sparks.every(s => s.r < 220 && s.g > 220 && s.b === 255)'));
// Direct: the old bounce explosion for the same laser power was far bigger.
ev('sparks.length = 0; spawnExplosion(100, 100, 0.22 + 0.25*1);');
check('old bounce explosion would have spawned ~47 sparks', ev('sparks.length') === 47, 'sparks=' + ev('sparks.length'));
check('explosion sparks are big orange fireballs', ev('sparks.some(s => s.size > 3) && sparks.every(s => s.r === 255 && s.b < 100)'));
// Real loop: a laser bouncing off the edge leaves a glint, not an explosion.
NEO.menu.goto('MAIN');
NEO.menu.select(0);
NEO.menu.activate();
check('SNIP3 game started for the bounce test', ev('appMode') === 'GAME', 'appMode=' + ev('appMode'));
ev('sparks.length = 0;');
ev(`lasers.push({ ownerId: 0, x: 7.2, y: canvas.height - 30, px: 7.2, py: canvas.height - 30,
  vx: -1500, vy: 0, dirX: -1, dirY: 0, life: 0, maxLife: 5, power: 1, bouncesLeft: 2, safeTime: 0 });`);
const ricIdxBefore = ev('_ricIdx');
pumpFrames(1);
check('laser survives its first bounce', ev('lasers.length') === 1, 'lasers=' + ev('lasers.length'));
check('first bounce consumes one bounce', ev('lasers[0].bouncesLeft') === 1, 'bouncesLeft=' + ev('lasers[0].bouncesLeft'));
check('first bounce leaves only a 6-spark glint', ev('sparks.length') === 6, 'sparks=' + ev('sparks.length'));
check('ricochet sound played once (soft)', ev('_ricIdx') === ricIdxBefore + 1, '_ricIdx=' + ev('_ricIdx'));
// Second bounce 16ms later: throttled sound, still just a glint.
ev(`lasers[0].x = 7.2; lasers[0].px = 7.2; lasers[0].vx = -1500; lasers[0].vy = 0; lasers[0].dirX = -1; lasers[0].dirY = 0;`);
pumpFrames(1);
check('second bounce consumes the last bounce', ev('lasers[0].bouncesLeft') === 0, 'bouncesLeft=' + ev('lasers[0].bouncesLeft'));
check('second bounce is still just a glint (12 sparks total)', ev('sparks.length') === 12, 'sparks=' + ev('sparks.length'));
check('ricochet sound throttled within 120ms', ev('_ricIdx') === ricIdxBefore + 1, '_ricIdx=' + ev('_ricIdx'));
// Final collision: the laser dies in a real explosion.
ev(`lasers[0].x = 7.2; lasers[0].px = 7.2; lasers[0].vx = -1500; lasers[0].vy = 0; lasers[0].dirX = -1; lasers[0].dirY = 0;`);
pumpFrames(1);
check('final collision removes the laser', ev('lasers.length') === 0, 'lasers=' + ev('lasers.length'));
check('final collision is a real explosion (>60 sparks total)', ev('sparks.length') > 60, 'sparks=' + ev('sparks.length'));

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) { console.log('Failed checks: ' + failures.join(' | ')); process.exit(1); }
console.log('ALL CHECKS PASSED');
