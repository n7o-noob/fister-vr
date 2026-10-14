// ==UserScript==
// @name         Fister VR (WebXR layer)
// @namespace    fister-vr.local
// @version      0.8.2
// @description  Experimental WebXR / SteamVR layer for Fister: Enter VR button, first-person lock, 1:1 headset tracking, 6DoF controllers.
// @match        https://fister.fun/*
// @match        https://www.fister.fun/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==
//
// Works two ways:
//   1. Browser: install as a Tampermonkey/Violentmonkey userscript (Chrome/Edge on Windows + SteamVR).
//   2. Steam client: dist/main.js + dist/preload.js inject this file into the page when launched with --vr.
//   3. Quest Browser: run as a bookmarklet while the game is already open (late attach, see 1b below).
//
// The game's code is served live from fister.fun as an obfuscated bundle, so this layer does not edit that
// bundle. It hooks Three.js itself from the outside:
//   - every WebGLRenderer sets `this.isWebGLRenderer = true` in its constructor -> captured with a one-shot
//     Object.prototype setter, then `renderer.xr.enabled = true` is applied right after construction;
//   - the game's scene wrapper assigns `this.renderer = <WebGLRenderer>` -> captured the same way, which gives
//     us `gameScene.camera`, `gameScene.players`, `gameScene.localPlayerId` (names confirmed from FisterQoL);
//   - `renderer.render(scene, camera)` is wrapped per instance; while `renderer.xr.isPresenting` is true the
//     main view is re-rendered through an XR rig that sits on the first-person viewpoint.
// Anything that depends on game internals I could not see (first-person toggle name, arm rig, key bindings)
// is auto-detected where possible, logged, and overridable from the console via `fisterVR`.

(() => {
  'use strict';
  const VERSION = '0.8.2';
  const root = globalThis;
  if (root.fisterVR) return;

  // ---------------------------------------------------------------------------------------------------------
  // Config (persisted per browser profile; edit live with fisterVR.config.* then fisterVR.saveConfig())
  // ---------------------------------------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    worldScale: 1,              // >1 makes you feel bigger. Game units are assumed to be ~metres.
    referenceSpace: 'local',    // 'local' = seated/standing origin at your head at session start.
    anchor: 'auto',             // 'auto' | 'head' | 'camera'. auto: local avatar head if found, else game camera.
    hideLocalHead: true,        // hide your own avatar's head mesh while anchored inside it.
    disableScreenShake: true,   // camera shake in VR causes motion sickness.
    // First-person POV toggle. Leave path null to auto-detect. Path is relative to the game scene object,
    // e.g. 'firstPerson' or 'cameraController.mode'. `value` is what "ON" means (true, 'first', 1, ...).
    firstPerson: { path: null, value: true },
    // Controller boxes
    controllerBoxes: true,
    boxSize: [0.05, 0.05, 0.12],
    boxScale: 1,                  // controller box size multiplier; 0 hides them
    armScale: 1,                  // your arms' size in VR (visual, only you see it); e.g. 0.5 = half size
    boxColors: { left: 0x35c4ff, right: 0xff5a5a, none: 0xffffff },
    // Arms (visual, client-side): 'aim' = each arm stays on its shoulder and points at its controller,
    // 'hand' = the arm's hand end sits on the controller, 'off' = game animation only.
    armMode: 'hand',
    swapArms: true,
    // 'hand' arm mode: where the hands sit relative to the controllers, in metres, in your facing direction.
    // forward pushes them out in front of you, inward pulls them toward your centre line.
    handOffset: { forward: 0.15, inward: 0.06, up: 0 },
    // Hide your own torso and legs (and clothing/cosmetics on them) in the headset. Head, arms and held items stay.
    hideBody: true,
    // Power-up items (scythe, piston, car, tank, laser orb, first-person weapon) follow your VR hands.
    holdItems: true,
    armOverride: true,            // legacy switch; false behaves like armMode 'off'
    armAxis: 'auto',              // arm mesh's long axis toward the hand: 'auto' | '-y' | 'y' | '-z' | 'z' | '-x' | 'x'
    armRotationOffsetDeg: [0, 0, 0],
    // Aim (Vivecraft-style): 'hand' steers the game's own aim (mouse look, which the server sees) toward where
    // the right controller points; your view comes only from the headset. 'head' = old behaviour (mouse aims).
    aimMode: 'hand',
    aimHand: 'right',             // 'right' | 'left': the hand you aim (and click menus) with
    // The game's aim starts at your body; we turn it so it passes through the spot your hand's ray points at:
    // where the ray meets the ground, or this many metres out. A line from the hand shows that ray.
    aimDistance: 10,
    aimLaser: true,
    // Where the game's aim ray starts: 'camera' (its third-person camera's crosshair, Fister's default) or 'body'.
    aimOrigin: 'camera',
    // In-match HUD panel (health, style, scoreboard): distance and width in metres, and how far below eye level.
    // pull: how far widgets are moved in toward the centre of view (1 = where the page has them, 0 = all in the middle);
    // grow: how much bigger they're drawn.
    hud: { distance: 1.5, width: 2.0, drop: 0.05, pull: 0.5, grow: 1.4 },
    aimGain: 0.6,                 // fraction of the remaining angle corrected per frame
    aimDeadzoneDeg: 0.4,
    aimPitch: true,
    // Head-locked copy of the game's 2D interface (HUD, menus) with a laser pointer on the aim hand.
    // The game's menus and HUD on a panel in front of your body. mode 'body' or 'off'. Sizes in metres.
    menu: { mode: 'body', distance: 1.4, width: 1.6, drop: 0.15, tiltDeg: 8, followDeg: 35, maxFps: 12, resolution: 1280 },
    spoofPointerLock: true,       // tell the game the mouse is captured while in VR (needed for aim to reach it)
    // Head mode: raise the eyes above the avatar head's centre (metres; scaled with worldScale).
    eyeOffset: { up: 0.1, forward: 0 },
    // Hide glowing/inverted outline meshes (power-ups etc.) that render as black boxes in the headset.
    // 'world' = everything except player avatars, 'all', or 'off'.
    hideOutlines: 'world',
    // Input mapping. Buttons use the WebXR 'xr-standard' gamepad layout.
    // Targets: { mouse: 0|1|2 } | { key: 'KeyCode' } | 'recenter'. Defaults are GUESSES; rebind to match your
    // in-game controls (Settings > Controls).
    buttons: {
      'right.trigger': { mouse: 0 },
      'left.trigger': { mouse: 0 },
      'right.squeeze': { mouse: 2 },
      'left.squeeze': { mouse: 2 },
      'right.a': { key: 'KeyV' },   // voice chat (hold to talk)
      'right.b': 'refocus',      // wakes game input if it stops responding
      'left.x': { key: 'Space' },
      'left.y': { key: 'Escape' },
      'left.thumbstick': 'recenter',
      'right.thumbstick': null,
    },
    moveStick: 'left',            // stick that sends WASD
    moveThreshold: 0.45,
    turnStick: 'right',           // stick that sends mouse X movement (turning)
    turnMode: 'snap',             // 'snap' | 'smooth' | 'rig' | 'off'. 'rig' turns only your view (use if the
                                  // game ignores the fake mouse movement, e.g. without pointer lock).
    rigSnapDegrees: 30,
    framebufferScale: 1,          // headset render resolution; try 0.7 on Quest 2 if it stutters
    snapTurnPixels: 250,          // mouse movementX sent per snap; tune to your in-game sensitivity
    smoothTurnPixelsPerFrame: 12,
    showStatus: true,
  };

  const CONFIG_KEY = 'fister-vr-config';
  const config = (() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') || {}; } catch { saved = {}; }
    // Settings baked into a bookmarklet (no console on Quest) win over saved ones.
    const baked = (root.__fisterVrConfigOverrides && typeof root.__fisterVrConfigOverrides === 'object') ? root.__fisterVrConfigOverrides : {};
    const merged = { ...DEFAULT_CONFIG, ...saved, ...baked };
    merged.firstPerson = { ...DEFAULT_CONFIG.firstPerson, ...(saved.firstPerson || {}), ...(baked.firstPerson || {}) };
    merged.buttons = { ...DEFAULT_CONFIG.buttons, ...(saved.buttons || {}), ...(baked.buttons || {}) };
    merged.boxColors = { ...DEFAULT_CONFIG.boxColors, ...(saved.boxColors || {}), ...(baked.boxColors || {}) };
    merged.menu = { ...DEFAULT_CONFIG.menu, ...(saved.menu || {}), ...(baked.menu || {}) };
    merged.eyeOffset = { ...DEFAULT_CONFIG.eyeOffset, ...(saved.eyeOffset || {}), ...(baked.eyeOffset || {}) };
    merged.hud = { ...DEFAULT_CONFIG.hud, ...(saved.hud || {}), ...(baked.hud || {}) };
    merged.handOffset = { ...DEFAULT_CONFIG.handOffset, ...(saved.handOffset || {}), ...(baked.handOffset || {}) };
    if (merged.armOverride === false) merged.armMode = 'off';
    return merged;
  })();
  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); return true; } catch { return false; }
  }

  // Everything the mod (and the game) logs is kept in a ring buffer for the in-page / in-headset console.
  const nativeConsole = { info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  const logBuffer = [];
  let logListener = null;
  const stringify = (a) => {
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  };
  function record(level, args) {
    const msg = args.map(stringify).join(' ').slice(0, 800);
    const last = logBuffer[logBuffer.length - 1];
    if (last && last.msg === msg && last.level === level) { last.count++; last.t = performance.now(); }
    else { logBuffer.push({ t: performance.now(), level, msg, count: 1 }); if (logBuffer.length > 400) logBuffer.shift(); }
    if (logListener) logListener();
  }
  const log = (...args) => { record('info', args); nativeConsole.info('[Fister VR]', ...args); };
  const warn = (...args) => { record('warn', args); nativeConsole.warn('[Fister VR]', ...args); };
  console.warn = (...args) => { record('game-warn', args); nativeConsole.warn(...args); };
  console.error = (...args) => { record('game-error', args); nativeConsole.error(...args); };
  root.addEventListener('error', (e) => record('page-error', [e.message + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')]));
  root.addEventListener('unhandledrejection', (e) => record('page-error', ['Unhandled promise: ', e.reason]));
  // Each VR feature runs isolated: one failing (e.g. arms) must not take down the headset view.
  const featureErrors = {};
  function safe(name, fn) {
    try { return fn(); }
    catch (error) {
      const count = featureErrors[name] = (featureErrors[name] || 0) + 1;
      if (count === 1 || count % 600 === 0) { record('error', [name + ' failed (' + count + 'x):', error]); nativeConsole.error('[Fister VR]', name, error); }
      return undefined;
    }
  }
  const warned = new Set();
  const warnOnce = (key, ...args) => { if (!warned.has(key)) { warned.add(key); warn(...args); } };

  // ---------------------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------------------
  const state = {
    renderers: new Set(),
    lateScene: null,         // stand-in scene from the Map probe when attached late
    menu: null,              // VR menu panel
    uiHit: null,             // where the right-hand laser meets the menu panel
    uiPress: null,
    pointerLockReleased: false,
    handBaseYaw: null,       // view yaw anchor in 'hand' aim mode
    aim: { ratioX: -0.0022, ratioY: -0.0022, lastDx: 0, lastDy: 0, lastYaw: null, lastPitch: null, flipX: 0, flipY: 0, stuck: 0 },
    focusTimer: 0,
    rigTurn: 0,              // radians, view-only turning (turnMode 'rig')
    renderer: null,          // renderer bound to the VR session
    gameScene: null,         // the game's scene wrapper (has .renderer/.camera/.players/.localPlayerId)
    sceneCandidates: [],
    threeScene: null,        // THREE.Scene last rendered with the main camera
    gameCamera: null,        // the game's main PerspectiveCamera
    cameraStats: new Map(),  // camera -> { count, renderer, scene }
    classes: null,           // harvested Three.js constructors
    rig: null,               // Object3D that follows the first-person viewpoint
    view: null,              // PerspectiveCamera child of rig handed to three's XR manager
    controllers: [],         // [{ index, group, box, handedness, source }]
    headOffset: null,        // Vector3, reference-space head position at last recenter
    yawOffset: 0,            // radians, reference-space head yaw at last recenter
    pendingRecenter: false,
    presenting: false,
    redirectRaf: false,
    rafQueue: new Map(),
    rafSeq: 0x40000000,
    gameAnimationLoop: new WeakMap(), // renderer -> game's own setAnimationLoop callback, if any
    xrTarget: null,
    mainRendered: false,
    fp: null,                // { owner, key, previous, label }
    hiddenHead: null,
    shake: null,
    buttonsDown: new Map(),
    keysDown: new Set(),
    turnLatched: false,
    statusEl: null,
    buttonEl: null,
  };

  // ---------------------------------------------------------------------------------------------------------
  // 1. Capture Three.js renderers and the game's scene wrapper
  // ---------------------------------------------------------------------------------------------------------
  // Transparent Object.prototype setters: the first assignment of `name` on any object defines a normal own
  // property (exactly what the assignment would have done) and lets us look at the object.
  function installTrap(name, onAssign) {
    const descriptor = {
      configurable: true,
      enumerable: false,
      get() { return undefined; },
      set(value) {
        if (Object(this) !== this || !Object.isExtensible(this)) return;
        Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
        try { onAssign(this, value); } catch (error) { warnOnce('trap-' + name, 'hook error', error); }
      },
    };
    Object.defineProperty(Object.prototype, name, descriptor);
    return () => {
      const current = Object.getOwnPropertyDescriptor(Object.prototype, name);
      if (current && current.set === descriptor.set) delete Object.prototype[name];
    };
  }

  installTrap('isWebGLRenderer', (renderer, value) => {
    if (value !== true) return;
    // The constructor is still running; finish setup once it returns.
    queueMicrotask(() => captureRenderer(renderer));
  });

  const removeSceneTrap = installTrap('renderer', (owner, value) => {
    if (!value || value.isWebGLRenderer !== true) return;
    captureGameScene(owner, 'renderer assignment');
  });
  // Don't leave a global `'renderer' in obj` trap around forever.
  setTimeout(removeSceneTrap, 10 * 60 * 1000);

  // Several objects get a `.renderer` (the game scene, but also e.g. an EffectComposer). Keep them all and
  // pick the one that looks like the game scene when it is needed.
  function captureGameScene(owner, how) {
    if (state.sceneCandidates.includes(owner)) return;
    state.sceneCandidates.push(owner);
    if (state.sceneCandidates.length > 24) state.sceneCandidates.shift();
    log('Scene candidate captured via ' + how + '.');
  }

  function gameScene() {
    if (state.gameScene) return state.gameScene;
    const looksLikeGame = (c) => c && c.camera && c.camera.isCamera === true && ('players' in c || 'localPlayerId' in c);
    const found = state.sceneCandidates.find(looksLikeGame);
    if (found) {
      state.gameScene = found;
      removeSceneTrap();
      removeMapProbe();
      log('Game scene identified.');
      detectFirstPerson(true);
    }
    // Late attach (bookmarklet): the scene was built before we loaded. Use what the Map probe found.
    return state.gameScene || state.lateScene;
  }

  // ---------------------------------------------------------------------------------------------------------
  // 1b. Late attach (Quest Browser bookmarklet): the game is already running when this loads, so the
  //     constructor hooks above never fire. Three.js reads `camera.isArrayCamera` while rendering; a normal
  //     camera doesn't own that property, so the lookup reaches Object.prototype and hands us the camera.
  //     From the camera's prototype chain we briefly patch Object3D.prototype.onBeforeRender, which
  //     WebGLRenderer.render calls as scene.onBeforeRender(renderer, scene, camera) -> renderer + scene.
  // ---------------------------------------------------------------------------------------------------------
  let lateObject3DProto = null, lateOriginalOnBeforeRender = null;
  const lateGetter = function () {
    try { if (this && this.isCamera === true && !hasMainRenderer()) armLateRendererProbe(this); } catch {}
    return undefined;
  };
  Object.defineProperty(Object.prototype, 'isArrayCamera', { configurable: true, enumerable: false, get: lateGetter, set(value) {
    if (Object(this) === this && Object.isExtensible(this)) Object.defineProperty(this, 'isArrayCamera', { value, writable: true, enumerable: true, configurable: true });
  } });
  function removeLateCameraProbe() {
    const current = Object.getOwnPropertyDescriptor(Object.prototype, 'isArrayCamera');
    if (current && current.get === lateGetter) delete Object.prototype.isArrayCamera;
  }

  // The game's main renderer draws to a big on-screen canvas; small ones (avatar previews) don't count.
  function isMainRenderer(renderer) {
    const c = renderer && renderer.domElement;
    if (!c || !c.isConnected) return false;
    return (c.clientWidth * c.clientHeight) > 0.3 * innerWidth * innerHeight;
  }
  function hasMainRenderer() { for (const r of state.renderers) if (isMainRenderer(r)) return true; return false; }

  function armLateRendererProbe(camera) {
    if (lateObject3DProto) return;
    let proto = Object.getPrototypeOf(camera);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'onBeforeRender')) proto = Object.getPrototypeOf(proto);
    if (!proto || typeof proto.onBeforeRender !== 'function') return;
    lateObject3DProto = proto;
    lateOriginalOnBeforeRender = proto.onBeforeRender;
    proto.onBeforeRender = function fisterVrProbe(renderer, scene, cam) {
      if (renderer && renderer.isWebGLRenderer === true && scene && scene.isScene === true) {
        proto.onBeforeRender = lateOriginalOnBeforeRender; // restore at once
        lateObject3DProto = null; // may re-arm if this wasn't the main renderer
        log('Late attach: renderer found from a running frame.');
        captureRenderer(renderer);
        noteRender(renderer, scene, cam);
      }
      return lateOriginalOnBeforeRender.apply(this, arguments);
    };
  }

  // The game keeps players in a Map (FisterQoL iterates scene.players.values() and reads player.head /
  // leftArm / rightArm). Watch Map lookups until a map of player-like objects shows up.
  const MapProto = Map.prototype;
  const nativeMapGet = MapProto.get, nativeMapValues = MapProto.values, nativeMapForEach = MapProto.forEach;
  const isPlayerLike = (v) => v && typeof v === 'object' && v.head && v.head.isObject3D === true
    && ((v.leftArm && v.leftArm.isObject3D) || (v.rightArm && v.rightArm.isObject3D));
  const isLocalPlayerObj = (p) => !!p && ((typeof p.isLocalPlayer === 'function' && (() => { try { return p.isLocalPlayer(); } catch { return false; } })()) || p.isLocal === true);
  const wantsPlayers = () => !state.gameScene && (!state.lateScene || state.reprobe);
  function inspectPlayers(map) {
    if (!wantsPlayers()) return;
    if (state.lateScene && state.lateScene.players === map) return;
    let first;
    try { first = nativeMapValues.call(map).next().value; } catch { return; }
    if (!isPlayerLike(first)) return;
    let hasLocal = false;
    for (const value of nativeMapValues.call(map)) if (isLocalPlayerObj(value)) { hasLocal = true; break; }
    if (state.reprobe && !hasLocal) return; // when replacing a stale list, only accept one that contains us
    // Prefer a real scene wrapper referenced from a player; otherwise build a minimal stand-in.
    let owner = null;
    for (const value of nativeMapValues.call(map)) {
      for (const key of Object.keys(value)) {
        const ref = value[key];
        if (ref && typeof ref === 'object' && ref.renderer && ref.renderer.isWebGLRenderer === true && ref.players === map) { owner = ref; break; }
      }
      if (owner) break;
    }
    if (owner) captureGameScene(owner, 'player map');
    state.lateScene = owner || { players: map, get camera() { return state.gameCamera; }, get renderer() { return state.renderer; } };
    log((state.reprobe ? 'Player list replaced' : 'Players found') + ' via Map lookups' + (owner ? ' (with game scene)' : '') + (hasLocal ? '; local player present.' : '.'));
    state.reprobe = false;
    removeMapProbe();
  }
  function installMapProbe() {
    MapProto.get = function get(key) {
      const value = nativeMapGet.call(this, key);
      if (wantsPlayers() && isPlayerLike(value)) inspectPlayers(this);
      return value;
    };
    MapProto.values = function values() { if (wantsPlayers()) inspectPlayers(this); return nativeMapValues.call(this); };
    MapProto.forEach = function forEach(callback, thisArg) { if (wantsPlayers()) inspectPlayers(this); return nativeMapForEach.call(this, callback, thisArg); };
  }
  function removeMapProbe() {
    if (MapProto.get !== nativeMapGet) MapProto.get = nativeMapGet;
    if (MapProto.values !== nativeMapValues) MapProto.values = nativeMapValues;
    if (MapProto.forEach !== nativeMapForEach) MapProto.forEach = nativeMapForEach;
  }
  installMapProbe();
  setTimeout(() => { if (!state.reprobe) removeMapProbe(); }, 5 * 60 * 1000);

  function captureRenderer(renderer) {
    if (state.renderers.has(renderer) || typeof renderer.render !== 'function' || !renderer.xr) return;
    state.renderers.add(renderer);
    if (isMainRenderer(renderer)) removeLateCameraProbe();

    // Step 1 of the brief: renderer.xr.enabled = true directly after the WebGLRenderer is created.
    renderer.xr.enabled = true;
    try { renderer.xr.setReferenceSpaceType(config.referenceSpace); } catch {}

    const originalRender = renderer.render;
    renderer.render = function fisterVrRender(scene, camera) {
      try {
        return renderThroughVr(this, originalRender, scene, camera);
      } catch (error) {
        // A skinned mesh without skin data can't be measured for culling (seen with some power-up models once they
        // come into view in the headset). Draw those without culling and try again.
        const now = performance.now();
        if (/applyBoneTransform|getX/.test(String(error && error.stack)) && scene && scene.traverse && now - (state.skinFixAt || 0) > 2000) {
          state.skinFixAt = now;
          let fixed = 0;
          scene.traverse((n) => {
            if (!n.isSkinnedMesh || !n.frustumCulled || n.boundingSphere) return;
            try { n.computeBoundingSphere(); } catch { n.frustumCulled = false; fixed++; }
          });
          log('Turned off culling for ' + fixed + ' skinned mesh(es) without skin data.');
          try { return renderThroughVr(this, originalRender, scene, camera); } catch {}
        }
        warnOnce('render', 'render hook failed, falling back to the original renderer', error);
        record('error', ['Headset render failed:', error]);
        return originalRender.call(this, scene, camera);
      }
    };
    renderer.__fisterVrOriginalRender = originalRender;

    // A colour clear after the headset view was drawn this frame would wipe it (black flash). Keep depth/stencil.
    const originalClear = renderer.clear;
    renderer.clear = function fisterVrClear(color = true, depth = true, stencil = true) {
      if (state.presenting && this === state.renderer && state.mainRendered && color) {
        const target = this.getRenderTarget();
        if (target === null || target === state.xrTarget) {
          state.blockedClears = (state.blockedClears || 0) + 1;
          if (state.blockedClears === 1) log('Blocked a screen clear after the headset view was drawn (would flash black).');
          return originalClear.call(this, false, depth, stencil);
        }
      }
      return originalClear.call(this, color, depth, stencil);
    };

    const originalLoop = renderer.setAnimationLoop;
    renderer.setAnimationLoop = function fisterVrSetAnimationLoop(callback) {
      state.gameAnimationLoop.set(this, callback || null);
      if (state.presenting && this === state.renderer) return; // re-applied on session end
      return originalLoop.call(this, callback);
    };
    renderer.__fisterVrOriginalLoop = originalLoop;

    renderer.xr.addEventListener('sessionstart', () => onSessionStart(renderer));
    renderer.xr.addEventListener('sessionend', () => onSessionEnd(renderer));

    log('WebGLRenderer captured' + (isMainRenderer(renderer) ? ' (main game view)' : ' (small, not the game view)') + '; renderer.xr.enabled = true.');
    whenBody(ensureVrButton);
    // (hand-off from menu-only VR happens in the render hook, once the game draws a scene we can build objects in)
  }

  // ---------------------------------------------------------------------------------------------------------
  // rAF redirection: during an immersive session the game's frames must run inside XRSession rAF.
  // ---------------------------------------------------------------------------------------------------------
  // In VR a game's "request full screen" or "resume audio" can fail or hang without a real click; neither matters in
  // the headset, so don't let them block (e.g. a join-lobby button awaiting them).
  const nativeRequestFullscreen = Element.prototype.requestFullscreen;
  if (nativeRequestFullscreen) {
    Element.prototype.requestFullscreen = function requestFullscreen(...args) {
      if (state.presenting) return Promise.resolve();
      return nativeRequestFullscreen.apply(this, args);
    };
  }
  for (const Ctx of [root.AudioContext, root.webkitAudioContext]) {
    if (!Ctx || !Ctx.prototype.resume || Ctx.prototype.__fisterVrResume) continue;
    const nativeResume = Ctx.prototype.resume;
    Ctx.prototype.__fisterVrResume = true;
    Ctx.prototype.resume = function resume(...args) {
      const p = nativeResume.apply(this, args);
      if (!state.presenting) return p;
      return Promise.race([p, new Promise((r) => setTimeout(r, 400))]);
    };
  }

  // Timers: with the page hidden behind VR the browser slows setTimeout/setInterval to about once a second, so menus,
  // loading and lobby lists stall. While in VR we also run due timers every headset frame.
  const nativeSetTimeout = root.setTimeout.bind(root), nativeClearTimeout = root.clearTimeout.bind(root);
  const nativeSetInterval = root.setInterval.bind(root), nativeClearInterval = root.clearInterval.bind(root);
  const timers = new Map();
  let timerSeq = 0x50000000;
  function runTimer(id, early) {
    const t = timers.get(id);
    if (!t) return;
    const now = performance.now();
    if (t.interval && !early && now < t.due - 1) return; // native interval tick for a period we already ran
    if (t.interval) t.due = now + t.interval;
    else { timers.delete(id); if (early) nativeClearTimeout(t.native); }
    try { t.fn.apply(root, t.args); } catch (error) { record('page-error', ['Timer error:', error]); nativeConsole.error(error); }
  }
  root.setTimeout = function setTimeout(fn, delay, ...args) {
    if (typeof fn !== 'function') return nativeSetTimeout(fn, delay, ...args);
    const id = ++timerSeq, d = Math.max(0, Number(delay) || 0);
    const t = { fn, args, due: performance.now() + d, interval: 0, native: 0 };
    timers.set(id, t);
    t.native = nativeSetTimeout(() => runTimer(id, false), d);
    return id;
  };
  root.setInterval = function setInterval(fn, delay, ...args) {
    if (typeof fn !== 'function') return nativeSetInterval(fn, delay, ...args);
    const id = ++timerSeq, d = Math.max(4, Number(delay) || 0);
    const t = { fn, args, due: performance.now() + d, interval: d, native: 0 };
    timers.set(id, t);
    t.native = nativeSetInterval(() => runTimer(id, false), d);
    return id;
  };
  const clearAny = function clear(id) {
    const t = timers.get(id);
    if (t) { timers.delete(id); if (t.interval) nativeClearInterval(t.native); else nativeClearTimeout(t.native); return; }
    nativeClearTimeout(id); nativeClearInterval(id);
  };
  root.clearTimeout = clearAny;
  root.clearInterval = clearAny;
  function runDueTimers() {
    if (!state.presenting || !timers.size) return;
    const now = performance.now();
    let budget = 200;
    for (const [id, t] of timers) {
      if (t.due <= now) { runTimer(id, true); if (--budget <= 0) break; }
    }
  }

  const nativeRaf = root.requestAnimationFrame.bind(root);
  const nativeCaf = root.cancelAnimationFrame.bind(root);
  root.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (!state.redirectRaf) return nativeRaf(callback);
    const id = ++state.rafSeq;
    state.rafQueue.set(id, callback);
    return id;
  };
  root.cancelAnimationFrame = function cancelAnimationFrame(id) {
    if (state.rafQueue.delete(id)) return;
    nativeCaf(id);
  };

  function xrFrame(renderer, time, frame) {
    if (state.inXrFrame) return; // never re-enter (a queued callback must not run another XR frame inside this one)
    state.inXrFrame = true;
    try { xrFrameBody(renderer, time, frame); } finally { state.inXrFrame = false; }
  }
  function xrFrameBody(renderer, time, frame) {
    safe('timers', runDueTimers);
    state.xrTarget = renderer.getRenderTarget();
    state.mainRendered = false;
    if (time - state.focusTimer > 2000) {
      state.focusTimer = time;
      if (!nativeHasFocus.call(document)) reassertFocus('timer');
    }
    if (state.lastXrTime) state.frameMs = state.frameMs ? state.frameMs * 0.9 + (time - state.lastXrTime) * 0.1 : time - state.lastXrTime;
    state.lastXrTime = time;
    safe('controller input', () => pollInput(frame));

    const gameLoop = state.gameAnimationLoop.get(renderer);
    if (gameLoop) {
      try { gameLoop(time, frame); } catch (error) { record('game-error', ['Game loop error:', error]); nativeConsole.error(error); }
    }
    const queue = state.rafQueue;
    state.rafQueue = new Map();
    for (const callback of queue.values()) {
      try { callback(time); } catch (error) { record('game-error', ['Game frame error:', error]); nativeConsole.error(error); }
    }
    // Frame pacers (the game's, or FisterQoL's FPS cap) may skip a frame. An XR frame with no draw shows black,
    // so repeat the last view instead.
    if (!state.mainRendered && state.threeScene && (state.frameCamera || state.gameCamera)) {
      state.repeats = (state.repeats || 0) + 1;
      renderMain(renderer, renderer.__fisterVrOriginalRender, state.threeScene, state.frameCamera || state.gameCamera);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // 2. First-person lock + headset binding
  // ---------------------------------------------------------------------------------------------------------
  function noteRender(renderer, scene, camera) {
    if (!scene || scene.isScene !== true || !camera || camera.isPerspectiveCamera !== true) return;
    const entry = state.cameraStats.get(camera);
    if (entry) { entry.count++; entry.renderer = renderer; entry.scene = scene; }
    else state.cameraStats.set(camera, { count: 1, renderer, scene });
    if (state.cameraStats.size > 32) state.cameraStats.clear();
  }

  function canvasArea(renderer) {
    const canvas = renderer.domElement;
    return canvas && canvas.isConnected ? (canvas.clientWidth * canvas.clientHeight) || 1 : 0;
  }

  function pickMain() {
    const gs = gameScene();
    let renderer = gs && gs.renderer && state.renderers.has(gs.renderer) ? gs.renderer : null;
    let camera = gs && gs.camera && gs.camera.isCamera ? gs.camera : null;
    if (!camera || !renderer) {
      let best = null, bestScore = -1;
      for (const [cam, entry] of state.cameraStats) {
        if (renderer && entry.renderer !== renderer) continue;
        const score = entry.count * canvasArea(entry.renderer) * (1 + (entry.scene.children ? entry.scene.children.length : 0));
        if (score > bestScore) { best = [cam, entry]; bestScore = score; }
      }
      if (best) { camera = camera || best[0]; renderer = renderer || best[1].renderer; }
    }
    if (!renderer) {
      renderer = [...state.renderers].sort((a, b) => canvasArea(b) - canvasArea(a))[0] || null;
    }
    return { renderer, camera };
  }

  function renderThroughVr(renderer, originalRender, scene, camera) {
    if (state.standalone && !state.standalone.handedOff && isMainRenderer(renderer) && scene && scene.isScene
        && camera && camera.isPerspectiveCamera && sceneHasBuildingBlocks(scene)) {
      noteRender(renderer, scene, camera);
      handOffStandalone(renderer);
      return originalRender.call(renderer, scene, camera);
    }
    if (!state.presenting || renderer !== state.renderer || !renderer.xr.isPresenting) {
      noteRender(renderer, scene, camera);
      return originalRender.call(renderer, scene, camera);
    }
    const isSceneRender = scene && scene.isScene && camera && camera.isPerspectiveCamera;
    if (isSceneRender) {
      const target = renderer.getRenderTarget();
      const toScreen = target === null || target === state.xrTarget;
      // The headset view is the gameplay camera (even if it renders into a post-processing target), or whatever
      // perspective camera the game draws to the screen: menus, between rounds, killcam, spectating.
      if (camera === gameplayCamera() || toScreen) {
        if (state.mainRendered) return; // one headset view per XR frame
        return renderMain(renderer, originalRender, scene, camera);
      }
    }
    // Everything else: offscreen helpers render normally (XR off for the call); screen-space post-processing
    // passes are dropped because they cannot be drawn stereo.
    const target = renderer.getRenderTarget();
    if (target === null || target === state.xrTarget) return;
    renderer.xr.enabled = false;
    try { return originalRender.call(renderer, scene, camera); }
    finally { renderer.xr.enabled = true; }
  }

  function gameplayCamera() {
    const gs = state.gameScene;
    if (gs && gs.camera && gs.camera.isCamera) return gs.camera;
    return state.gameCamera;
  }

  // Is this camera following our own avatar (gameplay), or a menu / round-break / killcam camera?
  // Once a camera has been seen following us it stays "the gameplay camera"; distance is only used to find it,
  // because a third-person or lagging camera can drift far from the head while walking.
  function sceneRoot(object) { let n = object; while (n && n.parent) n = n.parent; return n; }
  function isGameplayCamera(camera) {
    const gs = state.gameScene;
    if (gs && gs.camera && gs.camera.isCamera) {
      if (gs.killcamTargetId) return (state.gameplayReason = 'killcam', false);
      return (state.gameplayReason = camera === gs.camera ? 'game scene camera' : 'other camera', camera === gs.camera);
    }
    const player = localPlayer();
    const head = player && player.head && player.head.isObject3D ? player.head : null;
    if (!head) return (state.gameplayReason = 'no local player', false);
    if (player.removed) return (state.gameplayReason = 'local player removed', false);
    if (typeof player.health === 'number' && player.health <= 0) return (state.gameplayReason = 'dead', false);
    const root = sceneRoot(head);
    if (!root || root.isScene !== true) return (state.gameplayReason = 'local player not in any scene (stale)', false);
    if (state.gameplayCamera === camera) return (state.gameplayReason = 'gameplay camera', true);
    if (root !== state.threeScene) return (state.gameplayReason = 'different scene (menu)', false);
    const { tmp } = state;
    head.getWorldPosition(tmp.v4);
    camera.getWorldPosition(tmp.v2);
    const distance = tmp.v4.distanceTo(tmp.v2);
    if (distance < 15) {
      if (state.gameplayCamera !== camera) log('Gameplay camera identified (' + distance.toFixed(1) + ' from head).');
      state.gameplayCamera = camera;
      return (state.gameplayReason = 'near head', true);
    }
    return (state.gameplayReason = 'camera ' + distance.toFixed(1) + ' from head', false);
  }

  // Ragdolled? Fister exposes isRagdollState (seen in FisterQoL); fall back to other common names and to its
  // ragdoll meshes being on screen.
  function worldVisible(object) { for (let n = object; n; n = n.parent) if (n.visible === false) return false; return true; }
  function isRagdolled(player) {
    if (!player) return false;
    for (const key of ['isRagdollState', 'isRagdoll', 'ragdolled', 'isRagdolled', 'ragdollActive']) {
      const value = player[key];
      if (typeof value === 'function') { try { if (value.call(player)) return true; } catch {} }
      else if (value === true) return true;
    }
    const anim = player.currentAnimationState;
    if (typeof anim === 'string' && /ragdoll/i.test(anim)) return true;
    const meshes = player.ragdollMeshes;
    if (meshes && typeof meshes === 'object') {
      const list = Array.isArray(meshes) ? meshes : meshes instanceof Map ? [...meshes.values()] : Object.values(meshes);
      for (const m of list) if (m && m.isObject3D && worldVisible(m) && sceneRoot(m) && sceneRoot(m).isScene) return true;
    }
    return false;
  }

  // If we attached late and our player list goes stale (game rebuilt it, respawn, new round), look again.
  function checkPlayersFresh() {
    if (state.gameScene || !state.lateScene || state.reprobe) return;
    const player = localPlayer();
    const root = player && player.head ? sceneRoot(player.head) : null;
    if (player && root && root.isScene) return;
    state.reprobe = true;
    installMapProbe();
    log('Local player ' + (player ? 'left the scene' : 'missing') + '; searching for the live player list.');
  }

  function renderMain(renderer, originalRender, scene, camera) {
    camera = camera || state.frameCamera || state.gameCamera;
    state.threeScene = scene;
    state.frameCamera = camera;
    if (!state.gameCamera) state.gameCamera = camera;
    const workStart = performance.now();
    if (!safe('rig', () => ensureRig(scene))) return originalRender.call(renderer, scene, camera);
    state.frameCount = (state.frameCount || 0) + 1;
    if (state.frameCount % 60 === 0) safe('player refresh', checkPlayersFresh);
    // Hysteresis: a brief hiccup (lag spike, respawn flicker) must not throw you out of your body.
    const raw = !!safe('gameplay check', () => isGameplayCamera(camera));
    let gameplay;
    if (raw) { state.offGameplayFrames = 0; gameplay = true; }
    else {
      state.offGameplayFrames = (state.offGameplayFrames || 0) + 1;
      gameplay = !!state.gameplay && camera === state.gameplayCamera && state.offGameplayFrames < 45;
    }
    if (gameplay !== !!state.gameplay) log(gameplay ? 'Entered gameplay view.' : 'Left gameplay view: ' + state.gameplayReason + '.');
    if (gameplay) state.gameCamera = camera;
    if (gameplay && !state.gameplay) safe('text focus', releaseTextFocus);
    state.gameplay = gameplay;
    // Ragdolled: hand the camera back to the game's normal third-person view until you get up.
    const ragdoll = gameplay && !!safe('ragdoll check', () => isRagdolled(localPlayer()));
    if (ragdoll !== !!state.ragdoll) log(ragdoll ? 'Ragdolled: following the game camera (third person).' : 'Back on your feet: first-person view.');
    state.ragdoll = ragdoll;
    const inBody = gameplay && !ragdoll;
    if (inBody) { safe('first-person lock', lockFirstPerson); safe('screen shake', suppressShake); }
    else if (ragdoll) { safe('first-person release', unlockFirstPerson); safe('head', restoreHead); }
    safe('view rig', () => updateRig(scene, camera, inBody));
    if (!state.menu && config.menu.mode !== 'off' && (state.menuRetry = (state.menuRetry || 0) + 1) % 30 === 1) safe('menu setup', setupMenu);
    safe('menu', updateMenu);   // before aim, so aim pauses the same frame the laser lands on a menu
    safe('aim line', updateAimLaser);
    if (inBody) { safe('hand aim', steerAim); safe('arms', overrideArms); safe('held items', () => holdItems(localPlayer(), scene)); safe('hide body', () => hideBody(localPlayer())); }
    else { state.aim.lastYaw = null; safe('hide body', restoreBody); safe('held items', restoreItems); safe('arm size', restoreArmScale); }
    safe('outlines', () => hideOutlines(scene));
    safe('controller boxes', updateBoxes);
    const work = performance.now() - workStart;
    state.modMs = state.modMs ? state.modMs * 0.9 + work * 0.1 : work;
    const previousTarget = renderer.getRenderTarget();
    if (state.xrTarget && previousTarget !== state.xrTarget) renderer.setRenderTarget(state.xrTarget);
    try {
      originalRender.call(renderer, scene, state.view);
    } finally {
      if (state.xrTarget && previousTarget !== state.xrTarget) renderer.setRenderTarget(previousTarget);
    }
    state.mainRendered = true;
  }

  // Grab Three.js constructors from live objects: the game's copy of three.js is a private ES module.
  // Does this scene contain what we need to build our own objects (a Mesh with a plain Float32 position attribute)?
  function sceneHasBuildingBlocks(scene) {
    let ok = false;
    try {
      scene.traverse((node) => {
        if (ok || node.isMesh !== true) return;
        const pos = node.geometry && node.geometry.attributes && node.geometry.attributes.position;
        if (pos && pos.isBufferAttribute === true && pos.isInterleavedBufferAttribute !== true && pos.array instanceof Float32Array) ok = true;
      });
    } catch {}
    return ok;
  }

  function harvestClasses(scene, camera) {
    // A previous scene (loading screen, empty menu) may not have had everything. Try again every 30 frames.
    if (state.classes && state.classes.Mesh && state.classes.Attribute) return state.classes;
    if (state.classes && ((state.harvestTries = (state.harvestTries || 0) + 1) % 30 !== 0)) return state.classes;
    const Vector3 = camera.position.constructor;
    const Quaternion = camera.quaternion.constructor;
    const Euler = camera.rotation.constructor;

    let Object3D = camera.constructor;
    for (;;) {
      const parent = Object.getPrototypeOf(Object3D);
      if (typeof parent !== 'function' || parent === Function.prototype) break;
      let probe;
      try { probe = new parent(); } catch { break; }
      if (!probe || probe.isObject3D !== true) break;
      Object3D = parent;
    }

    let Mesh = null, Attribute = null;
    scene.traverse((node) => {
      if (!Mesh && node.isMesh === true) {
        let ctor = node.constructor;
        while (typeof ctor === 'function' && ctor !== Function.prototype) {
          let probe = null;
          try { probe = new ctor(); } catch {}
          if (probe && probe.type === 'Mesh' && probe.isMesh === true && probe.geometry && probe.material) { Mesh = ctor; break; }
          ctor = Object.getPrototypeOf(ctor);
        }
      }
      const position = node.geometry && node.geometry.attributes && node.geometry.attributes.position;
      if (!Attribute && position && position.isBufferAttribute === true && position.isInterleavedBufferAttribute !== true
          && position.array instanceof Float32Array) {
        Attribute = position.constructor;
      }
    });

    const Matrix4 = camera.matrixWorld.constructor;
    const PerspectiveCamera = camera.isPerspectiveCamera ? camera.constructor : null;
    const previous = state.classes || {};
    state.classes = { ...previous, Vector3, Quaternion, Euler, Object3D, Mesh: Mesh || previous.Mesh || null, Attribute: Attribute || previous.Attribute || null, PerspectiveCamera, Matrix4 };
    if (state.classes.Mesh && state.classes.Attribute && !(previous.Mesh && previous.Attribute) && state.rig) safe('controller boxes', addMissingBoxes);
    log('Three.js classes harvested:', Object.fromEntries(Object.entries(state.classes).map(([k, v]) => [k, !!v])));
    return state.classes;
  }

  function ensureRig(scene) {
    const camera = state.gameCamera;
    if (!camera) return false;
    const C = harvestClasses(scene, camera);
    if (!state.rig) {
      state.rig = new C.Object3D();
      state.rig.name = 'fister-vr-rig';
      state.view = camera.clone(false);
      state.view.name = 'fister-vr-view';
      state.view.position.set(0, 0, 0);
      state.view.quaternion.set(0, 0, 0, 1);
      state.view.scale.set(1, 1, 1);
      state.rig.add(state.view);
      state.headOffset = new C.Vector3();
      state.tmp = { v: new C.Vector3(), v2: new C.Vector3(), v3: new C.Vector3(), v4: new C.Vector3(), q: new C.Quaternion(),
        q2: new C.Quaternion(), q3: new C.Quaternion(), e: new C.Euler(0, 0, 0, 'YXZ'), m: new C.Matrix4() };
      setupControllers();
    }
    if (state.rig.parent !== scene) scene.add(state.rig);
    return true;
  }

  function localPlayer() {
    const gs = gameScene();
    if (!gs || !gs.players) return null;
    const players = gs.players;
    if (typeof players.get === 'function' && gs.localPlayerId != null) {
      const direct = players.get(gs.localPlayerId);
      if (direct) return direct;
    }
    const list = typeof players.values === 'function' ? players.values() : Object.values(players);
    for (const player of list) {
      if (!player) continue;
      if (player.id != null && player.id === gs.localPlayerId) return player;
      if ((typeof player.isLocalPlayer === 'function' && player.isLocalPlayer()) || player.isLocal === true) return player;
    }
    return null;
  }

  function anchorObject() {
    const mode = config.anchor;
    if (mode !== 'camera') {
      const player = localPlayer();
      const head = player && player.head && player.head.isObject3D ? player.head : null;
      if (head && (mode === 'head' || !state.fp)) return { object: head, player };
    }
    return { object: state.frameCamera || state.gameCamera, player: null };
  }

  function updateRig(scene, camera, gameplay) {
    const { rig, view, tmp } = state;
    const gameCamera = camera || state.gameCamera;
    const scale = Math.max(0.05, Number(config.worldScale) || 1);
    // Outside gameplay (menus, round breaks, killcam) you sit where the game's camera is and look around freely.
    const anchor = gameplay ? anchorObject() : { object: gameCamera, player: null };

    // 'head' aim: view yaw follows the game camera (mouse / snap turn).
    // 'hand' aim: the game camera follows your right hand, so the view must NOT follow it (that would swing
    // the world every time you aim). The view keeps the yaw it had when VR started, plus stick turns.
    gameCamera.updateMatrixWorld();
    gameCamera.getWorldQuaternion(tmp.q);
    tmp.e.setFromQuaternion(tmp.q, 'YXZ');
    let baseYaw = tmp.e.y;
    if (config.aimMode === 'hand' && gameplay) {
      if (state.handBaseYaw === null) state.handBaseYaw = tmp.e.y;
      baseYaw = state.handBaseYaw;
    }
    const yaw = baseYaw - state.yawOffset + state.rigTurn;

    anchor.object.updateWorldMatrix(true, false);
    anchor.object.getWorldPosition(tmp.v2);
    const onHead = anchor.object !== gameCamera;
    if (onHead) {
      // Eyes a little above the head mesh's centre (and optionally forward along your facing).
      const eye = config.eyeOffset || {};
      tmp.v2.y += (Number(eye.up) || 0) * scale;
      const fwd = Number(eye.forward) || 0;
      if (fwd) { tmp.v2.x -= Math.sin(yaw) * fwd * scale; tmp.v2.z -= Math.cos(yaw) * fwd * scale; }
    }
    // Ignore a broken position (NaN) and one-frame teleports of the anchor; real teleports (respawn) persist.
    const valid = Number.isFinite(tmp.v2.x) && Number.isFinite(tmp.v2.y) && Number.isFinite(tmp.v2.z);
    if (!state.lastAnchor) state.lastAnchor = tmp.v2.clone();
    const jump = valid ? tmp.v2.distanceTo(state.lastAnchor) : Infinity;
    if (!valid || (jump > 3 * scale && !state.jumpPending)) {
      state.jumpPending = valid;
      state.glitches = (state.glitches || 0) + 1;
      rig.position.copy(state.lastAnchor);
    } else {
      state.jumpPending = false;
      state.lastAnchor.copy(tmp.v2);
      rig.position.copy(tmp.v2);
    }
    if (onHead) hideHead(anchor.object); else restoreHead();

    rig.rotation.set(0, yaw, 0);
    rig.scale.setScalar(scale);
    // eye_world = anchor + R(yaw) * scale * (headPose - headOffset)
    tmp.v.copy(state.headOffset).multiplyScalar(scale).applyQuaternion(rig.quaternion);
    rig.position.sub(tmp.v);
    rig.updateMatrixWorld(true);

    view.near = Math.min(gameCamera.near, 0.05);
    view.far = gameCamera.far;
    view.layers.mask = gameCamera.layers.mask;
  }

  function recenter(frame) {
    const renderer = state.renderer;
    if (!renderer || !frame) { state.pendingRecenter = true; return; }
    const space = renderer.xr.getReferenceSpace();
    const pose = space && frame.getViewerPose(space);
    if (!pose || !state.headOffset) { state.pendingRecenter = true; return; }
    const p = pose.transform.position, o = pose.transform.orientation;
    state.headOffset.set(p.x, p.y, p.z);
    state.tmp.q2.set(o.x, o.y, o.z, o.w);
    state.tmp.e.setFromQuaternion(state.tmp.q2, 'YXZ');
    state.yawOffset = state.tmp.e.y;
    state.pendingRecenter = false;
    log('Recentered.');
  }

  // --- first-person POV toggle -------------------------------------------------------------------------------
  const FP_NAME = /first.?person|fpv|^pov$|povmode|isfps|fps.?cam/i;
  const FP_MODE_NAME = /camera.?mode|view.?mode|pov|perspective.?mode/i;

  function resolvePath(base, path) {
    const parts = String(path).split('.');
    const key = parts.pop();
    let owner = base;
    for (const part of parts) { owner = owner && owner[part]; }
    return owner && typeof owner === 'object' ? { owner, key } : null;
  }

  function scanForToggle(base, depth, prefix, out, seen) {
    if (!base || typeof base !== 'object' || seen.has(base) || depth < 0) return;
    if (base.isObject3D || base.isMaterial || base.isBufferGeometry || base.isTexture) return;
    if (typeof Node !== 'undefined' && base instanceof Node) return;
    seen.add(base);
    let keys;
    try { keys = Object.keys(base); } catch { return; }
    for (const key of keys) {
      let value;
      try { value = base[key]; } catch { continue; }
      const label = prefix ? prefix + '.' + key : key;
      if (typeof value === 'boolean' && FP_NAME.test(key)) out.push({ owner: base, key, label, kind: 'boolean', value });
      else if ((typeof value === 'string' || typeof value === 'number') && FP_MODE_NAME.test(key)) out.push({ owner: base, key, label, kind: typeof value, value });
      else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)) {
        scanForToggle(value, depth - 1, label, out, seen);
      }
    }
  }

  function detectFirstPerson(verbose) {
    const gs = gameScene();
    if (!gs) return null;
    if (config.firstPerson.path) {
      const hit = resolvePath(gs, config.firstPerson.path);
      if (hit) { state.fp = { ...hit, label: config.firstPerson.path, value: config.firstPerson.value }; return state.fp; }
      warnOnce('fp-path', 'Configured first-person path not found on game scene:', config.firstPerson.path);
    }
    const found = [];
    scanForToggle(gs, 2, '', found, new Set());
    const toggle = found.find((c) => c.kind === 'boolean');
    if (verbose && found.length) log('First-person candidates:', found.map((c) => c.label + ' = ' + JSON.stringify(c.value)).join(', '));
    if (toggle) {
      state.fp = { owner: toggle.owner, key: toggle.key, label: toggle.label, value: true };
      log('First-person toggle auto-detected: gameScene.' + toggle.label);
      return state.fp;
    }
    if (verbose) warnOnce('fp-missing', 'No boolean first-person toggle found on the game scene. Anchoring the view to the '
      + 'local avatar head instead. Run fisterVR.dump() and share the output, or set fisterVR.setFirstPersonPath(path, value).');
    return null;
  }

  function lockFirstPerson() {
    if (!state.renderer || !state.renderer.xr.isPresenting) return;
    const fp = state.fp || detectFirstPerson(false);
    if (!fp) return;
    if (!('previous' in fp)) fp.previous = fp.owner[fp.key];
    if (fp.owner[fp.key] !== fp.value) fp.owner[fp.key] = fp.value; // locked ON every frame while presenting
  }

  function unlockFirstPerson() {
    const fp = state.fp;
    if (fp && 'previous' in fp) { fp.owner[fp.key] = fp.previous; delete fp.previous; }
  }

  function hideHead(head) {
    if (!config.hideLocalHead) return;
    if (state.hiddenHead && state.hiddenHead.object !== head) restoreHead();
    if (head && !state.hiddenHead) { state.hiddenHead = { object: head, visible: head.visible }; }
    if (head) head.visible = false;
  }
  function restoreHead() {
    if (state.hiddenHead) { state.hiddenHead.object.visible = state.hiddenHead.visible; state.hiddenHead = null; }
  }

  function suppressShake() {
    const gs = gameScene();
    if (!config.disableScreenShake || !gs || typeof gs.screenShakeIntensity !== 'number') return;
    if (!state.shake) state.shake = { previous: gs.screenShakeIntensity };
    gs.screenShakeIntensity = 0;
  }
  function restoreShake() {
    if (state.shake && gameScene()) gameScene().screenShakeIntensity = state.shake.previous;
    state.shake = null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // 3. Controllers: anchors, boxes, arm override, input mapping
  // ---------------------------------------------------------------------------------------------------------
  function boxGeometry(sx, sy, sz) {
    const { Mesh, Attribute } = state.classes;
    const geometry = new Mesh().geometry; // three's default BufferGeometry
    const x = sx / 2, y = sy / 2, z = sz / 2;
    const c = [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z]];
    const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
    const out = [];
    for (const [a, b, d, e] of faces) for (const i of [a, b, d, a, d, e]) out.push(...c[i]);
    geometry.setAttribute('position', new Attribute(new Float32Array(out), 3));
    geometry.computeBoundingSphere();
    return geometry;
  }

  function makeBox(index) {
    const C = state.classes;
    const box = new C.Mesh();
    box.geometry = boxGeometry(...config.boxSize);
    if (box.material.color) box.material.color.setHex(config.boxColors.none);
    box.name = 'fister-vr-controller-box-' + index;
    showOnAllLayers(box);
    return box;
  }
  function addMissingBoxes() {
    if (!config.controllerBoxes || !state.classes || !state.classes.Mesh || !state.classes.Attribute) return;
    for (const entry of state.controllers) {
      if (entry.box) continue;
      entry.box = makeBox(entry.index);
      entry.group.add(entry.box);
      if (entry.box.material.color) entry.box.material.color.setHex(config.boxColors[entry.handedness] ?? config.boxColors.none);
    }
  }

  function setupControllers() {
    const renderer = state.renderer;
    const C = state.classes;
    for (let index = 0; index < 2; index++) {
      const group = renderer.xr.getController(index);
      const entry = { index, group, box: null, handedness: 'none', source: null };
      if (config.controllerBoxes && C.Mesh && C.Attribute) {
        const box = new C.Mesh();
        box.geometry = boxGeometry(...config.boxSize);
        if (box.material.color) box.material.color.setHex(config.boxColors.none);
        box.name = 'fister-vr-controller-box-' + index;
        showOnAllLayers(box);
        group.add(box);
        entry.box = box;
      } else if (config.controllerBoxes) {
        warnOnce('boxes', 'Could not build controller boxes (Mesh/BufferAttribute classes not found in scene).');
      }
      group.addEventListener('connected', (event) => {
        entry.source = event.data;
        entry.handedness = event.data && event.data.handedness || 'none';
        if (entry.box && entry.box.material.color) entry.box.material.color.setHex(config.boxColors[entry.handedness] ?? config.boxColors.none);
        log('Controller ' + index + ' connected (' + entry.handedness + ').');
      });
      group.addEventListener('disconnected', () => { entry.source = null; entry.handedness = 'none'; });
      state.rig.add(group); // controllers live in the same space as the headset view
      state.controllers.push(entry);
    }
  }

  // --- outlines ------------------------------------------------------------------------------------------------
  // Outline / glow shells (typically back-faced, black, or subtractive/multiply-blended copies of a mesh) render as
  // solid black boxes in the headset. Hide them while in VR; avatars are left alone unless hideOutlines is 'all'.
  const BLEND_SUBTRACT = 3, BLEND_MULTIPLY = 4, BACK_SIDE = 1;
  function isOutlineMesh(node) {
    if (!node.isMesh || !node.material) return false;
    const gs = state.gameScene;
    if (gs && (node === gs.skyboxMesh)) return false;
    if (node.parent === state.rig || node.parent === state.view) return false;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const names = (node.name || '') + ' ' + materials.map((m) => (m && (m.name || m.type)) || '').join(' ');
    if (/outline|glow|halo|aura|highlight|silhouette/i.test(node.name || '') || materials.some((m) => m && /outline|glow|halo|aura|silhouette/i.test(m.name || ''))) return true;
    const geometry = node.geometry;
    if (geometry && !geometry.boundingSphere && geometry.computeBoundingSphere) geometry.computeBoundingSphere();
    const radius = geometry && geometry.boundingSphere ? geometry.boundingSphere.radius * Math.max(node.scale.x, node.scale.y, node.scale.z) : 0;
    if (radius > 40) return false; // skyboxes and level shells
    void names;
    for (const m of materials) {
      if (!m) continue;
      const dark = m.color && (m.color.r + m.color.g + m.color.b) < 0.12;
      if (m.blending === BLEND_SUBTRACT || m.blending === BLEND_MULTIPLY) return true;
      if (m.side === BACK_SIDE && (dark || m.isShaderMaterial || m.isRawShaderMaterial)) return true;
    }
    return false;
  }
  // Other players' outlines may be kept ('world'); your own never are: your eyes sit inside your avatar, so its
  // outline shell wraps the camera and blacks out the view.
  function insideAvatar(node) {
    const gs = gameScene();
    if (!gs || !gs.players) return false;
    const me = localPlayer();
    const roots = new Set();
    for (const p of (typeof gs.players.values === 'function' ? gs.players.values() : Object.values(gs.players))) {
      if (p === me) continue;
      if (p && p.mesh) roots.add(p.mesh);
      if (p && p.avatarVisualRoot) roots.add(p.avatarVisualRoot);
    }
    for (let n = node; n; n = n.parent) if (roots.has(n)) return true;
    return false;
  }
  function hideOutlines(scene) {
    if (config.hideOutlines === 'off') return;
    const hidden = state.outlines || (state.outlines = new Map());
    if (((state.outlineScan = (state.outlineScan || 0) + 1) % 30) === 1) {
      scene.traverse((node) => {
        if (hidden.has(node) || !isOutlineMesh(node)) return;
        if (config.hideOutlines !== 'all' && insideAvatar(node)) return;
        hidden.set(node, node.visible);
      });
    }
    for (const [node] of hidden) node.visible = false; // re-hide every frame in case the game toggles them
  }
  function restoreOutlines() {
    if (!state.outlines) return;
    for (const [node, visible] of state.outlines) node.visible = visible;
    state.outlines.clear();
  }

  // --- hide own torso & legs -----------------------------------------------------------------------------------
  // Meshes are moved to a layer the headset cameras don't draw (layers don't inherit, so arms parented to the
  // torso stay visible). Everything under the avatar except head, arms and held items counts: torso, legs and
  // whatever clothing or cosmetics hang off them.
  const HIDDEN_LAYER_MASK = 1 << 31;
  function bodyMeshes(player) {
    const keep = new Set([player.head, player.leftArm, player.rightArm, player.carMesh, player.tankMesh,
      ...ITEM_KEYS.map((k) => player[k])].filter((o) => o && o.isObject3D));
    const roots = [player.avatarVisualRoot, player.mesh, player.torso, player.leftLeg, player.rightLeg].filter((o) => o && o.isObject3D);
    const out = new Set();
    for (const root of roots) {
      root.traverse((node) => {
        if (!node.isMesh && !node.isSkinnedMesh && !node.isInstancedMesh) return;
        for (let n = node; n; n = n.parent) { if (keep.has(n)) return; if (n === root) break; }
        out.add(node);
      });
    }
    // Explicit body parts always count, even if they sit under a kept node in some rig.
    for (const part of [player.torso, player.leftLeg, player.rightLeg]) {
      if (part && part.isObject3D) part.traverse((node) => { if (node.isMesh) { let kept = false; for (let n = node; n && n !== part; n = n.parent) if (keep.has(n)) kept = true; if (!kept) out.add(node); } });
    }
    return out;
  }
  function hideBody(player) {
    if (!config.hideBody || !player) { restoreBody(); return; }
    const hidden = state.hiddenBody || (state.hiddenBody = new Map());
    if (state.bodyPlayer !== player) { restoreBody(); state.bodyPlayer = player; state.bodyScan = 0; }
    if ((state.bodyScan = (state.bodyScan || 0) + 1) % 30 === 1) {
      for (const node of bodyMeshes(player)) if (!hidden.has(node)) hidden.set(node, node.layers.mask);
    }
    for (const [node] of hidden) node.layers.mask = HIDDEN_LAYER_MASK;
  }
  function restoreBody() {
    if (!state.hiddenBody || !state.hiddenBody.size) return;
    for (const [node, mask] of state.hiddenBody) node.layers.mask = mask;
    state.hiddenBody.clear();
    state.bodyPlayer = null;
  }

  // --- arms ------------------------------------------------------------------------------------------------
  // Measure each arm once in its own space: which axis is long, where the shoulder end and hand end are.
  function armInfo(arm) {
    if (arm.__fisterVrArm) return arm.__fisterVrArm;
    const C = state.classes;
    arm.updateWorldMatrix(true, true);
    const inverse = new C.Matrix4().copy(arm.matrixWorld).invert();
    const p = new C.Vector3();
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    arm.traverse((node) => {
      const g = node.geometry;
      if (!node.isMesh || !g) return;
      if (!g.boundingBox && typeof g.computeBoundingBox === 'function') g.computeBoundingBox();
      const b = g.boundingBox;
      if (!b) return;
      for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)
          .applyMatrix4(node.matrixWorld).applyMatrix4(inverse);
        const c = [p.x, p.y, p.z];
        for (let k = 0; k < 3; k++) { if (c[k] < min[k]) min[k] = c[k]; if (c[k] > max[k]) max[k] = c[k]; }
      }
    });
    if (!Number.isFinite(min[0])) { min = [-0.05, -0.5, -0.05]; max = [0.05, 0, 0.05]; }
    let axisIndex, sign;
    const spec = String(config.armAxis || 'auto').toLowerCase();
    if (/^-?[xyz]$/.test(spec)) {
      axisIndex = 'xyz'.indexOf(spec.slice(-1));
      sign = spec.startsWith('-') ? -1 : 1;
    } else {
      const extent = [0, 1, 2].map((k) => max[k] - min[k]);
      axisIndex = extent.indexOf(Math.max(...extent));
      // The hand is the end farther from the arm's pivot (arms usually hang from the shoulder: -Y).
      sign = Math.abs(min[axisIndex]) >= Math.abs(max[axisIndex]) ? -1 : 1;
    }
    const center = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
    const shoulder = center.slice(), hand = center.slice(), axis = [0, 0, 0];
    shoulder[axisIndex] = sign < 0 ? max[axisIndex] : min[axisIndex];
    hand[axisIndex] = sign < 0 ? min[axisIndex] : max[axisIndex];
    axis[axisIndex] = sign;
    const info = { axisIndex, axis: new C.Vector3(...axis), shoulder: new C.Vector3(...shoulder), hand: new C.Vector3(...hand),
      label: (sign < 0 ? '-' : '') + 'xyz'[axisIndex] };
    arm.__fisterVrArm = info;
    log('Arm measured: long axis ' + info.label + ', length ' + (max[axisIndex] - min[axisIndex]).toFixed(2));
    return info;
  }

  function overrideArms() {
    if (config.armMode === 'off') return;
    const player = localPlayer();
    if (!player) { warnOnce('arms', 'Arm override: local player not found.'); return; }
    const C = state.classes;
    if (!state.armTmp) {
      state.armTmp = { pin: new C.Vector3(), now: new C.Vector3(), target: new C.Vector3(), dir: new C.Vector3(),
        pos: new C.Vector3(), fwd: new C.Vector3(0, 0, -1), qw: new C.Quaternion(), qc: new C.Quaternion(),
        qp: new C.Quaternion(), qo: new C.Quaternion(), e: new C.Euler(), qv: new C.Quaternion(), fwdFlat: new C.Vector3(), right: new C.Vector3() };
    }
    const t = state.armTmp;
    const rot = (config.armRotationOffsetDeg || [0, 0, 0]).map((d) => (Number(d) || 0) * Math.PI / 180);
    t.e.set(rot[0], rot[1], rot[2], 'XYZ');
    t.qo.setFromEuler(t.e);
    for (const entry of state.controllers) {
      if (!entry.source) continue;
      const hand = entry.handedness === 'left' || entry.handedness === 'right'
        ? (config.swapArms ? (entry.handedness === 'left' ? 'right' : 'left') : entry.handedness) : null;
      const arm = hand === 'left' ? player.leftArm : hand === 'right' ? player.rightArm : null;
      if (!arm || !arm.isObject3D || !arm.parent) continue;
      // The arm as the game saw it when it placed held items this frame (held items are measured against this).
      // If the game doesn't reset the arm's size, it placed items against our resized arm: remember by how much
      // (sizeSeen), so items still end up scaled with your arm.
      const origs = state.armOrig || (state.armOrig = new Map());
      if (!origs.has(arm)) origs.set(arm, new C.Matrix4());
      arm.updateWorldMatrix(true, false);
      origs.get(arm).copy(arm.matrixWorld);
      const preSize = arm.scale.length();
      gamePose(arm); // start from the game's pose (it may not re-animate the arm every frame)
      const sizes = state.armSizeSeen || (state.armSizeSeen = new Map());
      sizes.set(arm, arm.scale.length() > 1e-9 ? preSize / arm.scale.length() : 1);
      const info = armInfo(arm);
      // Size: remember the game's own scale once, then apply ours on top (restored when you leave your body).
      const scaled = state.armScaled || (state.armScaled = new Map());
      if (!scaled.has(arm)) scaled.set(arm, arm.scale.clone());
      const k = Math.max(0.1, Math.min(2, Number(config.armScale) || 1));
      arm.scale.copy(scaled.get(arm)).multiplyScalar(k);
      arm.updateWorldMatrix(true, false);
      entry.group.getWorldPosition(t.target);
      if (config.armMode === 'hand') {
        // Hand end on the controller, long axis along the controller's pointing direction.
        entry.group.getWorldQuaternion(t.qc);
        t.qw.setFromUnitVectors(info.axis, t.fwd).premultiply(t.qc);
        t.pin.copy(t.target);
        // Shift the hands forward / toward your centre line, in the direction your head faces (flattened).
        const o = config.handOffset || {};
        const scale = state.rig.scale.x || 1;
        state.view.getWorldQuaternion(t.qv);
        t.fwdFlat.set(0, 0, -1).applyQuaternion(t.qv); t.fwdFlat.y = 0;
        if (t.fwdFlat.lengthSq() < 1e-6) t.fwdFlat.set(0, 0, -1); else t.fwdFlat.normalize();
        t.right.set(-t.fwdFlat.z, 0, t.fwdFlat.x);
        const inwardSign = entry.handedness === 'left' ? 1 : -1;
        t.pin.addScaledVector(t.fwdFlat, (Number(o.forward) || 0) * scale)
          .addScaledVector(t.right, inwardSign * (Number(o.inward) || 0) * scale);
        t.pin.y += (Number(o.up) || 0) * scale;
      } else {
        // Shoulder stays where the game put it; the arm points from there toward the controller.
        t.pin.copy(info.shoulder).applyMatrix4(arm.matrixWorld);
        t.dir.subVectors(t.target, t.pin);
        if (t.dir.lengthSq() < 1e-10) continue;
        t.dir.normalize();
        t.qw.setFromUnitVectors(info.axis, t.dir);
      }
      t.qw.multiply(t.qo);
      // Mirror across the plane that splits the hand into inside/outside: flip the arm's local axis that points
      // most sideways (perpendicular to the arm and to world up).
      if (config.armMode === 'hand') { // hands always mirrored: the claws belong on the outside
        t.dir.copy(info.axis).applyQuaternion(t.qw);           // arm direction, world
        t.right.set(0, 1, 0).cross(t.dir);                      // sideways, world
        if (t.right.lengthSq() > 1e-8) {
          t.right.normalize().applyQuaternion(t.qp.copy(t.qw).invert()); // sideways, arm local
          const c = [Math.abs(t.right.x), Math.abs(t.right.y), Math.abs(t.right.z)];
          c[info.axisIndex] = -1;
          const k2 = c.indexOf(Math.max(...c));
          const sideIndex = info.sideIndex === undefined ? (info.sideIndex = k2) : info.sideIndex;
          arm.scale.setComponent(sideIndex, -arm.scale.getComponent(sideIndex));
        }
      }
      arm.parent.getWorldQuaternion(t.qp);
      arm.quaternion.copy(t.qp.invert().multiply(t.qw));
      arm.updateMatrixWorld(true);
      // Move the arm so its pinned point (shoulder or hand) lands exactly on t.pin.
      t.now.copy(config.armMode === 'hand' ? info.hand : info.shoulder).applyMatrix4(arm.matrixWorld);
      arm.getWorldPosition(t.pos).add(t.pin).sub(t.now);
      arm.position.copy(arm.parent.worldToLocal(t.pos));
      arm.updateMatrixWorld(true);
      notePoseWritten(arm);
    }
  }

  // --- the game's own pose vs ours --------------------------------------------------------------------------------
  // We overwrite some objects' local pose every frame. If the game doesn't set them again next frame, what we find
  // is our own output, so put the game's last pose back first instead of building on ours.
  function gamePose(obj) {
    const poses = state.poses || (state.poses = new Map());
    let rec = poses.get(obj);
    if (!rec) { rec = { game: null, written: null }; poses.set(obj, rec); }
    // Per part: the game may set the position every frame but never the scale, say.
    if (!rec.game) rec.game = { p: obj.position.clone(), q: obj.quaternion.clone(), s: obj.scale.clone() };
    else {
      const w = rec.written;
      for (const [k, prop] of [['p', 'position'], ['q', 'quaternion'], ['s', 'scale']]) {
        if (w && obj[prop].equals(w[k])) obj[prop].copy(rec.game[k]);
        else rec.game[k].copy(obj[prop]);
      }
    }
    rec.written = null;
    return rec;
  }
  function notePoseWritten(obj) {
    const rec = state.poses && state.poses.get(obj);
    if (rec) rec.written = { p: obj.position.clone(), q: obj.quaternion.clone(), s: obj.scale.clone() };
  }
  function restoreGamePose(obj) {
    const rec = state.poses && state.poses.get(obj);
    if (rec && rec.game) { obj.position.copy(rec.game.p); obj.quaternion.copy(rec.game.q); obj.scale.copy(rec.game.s); }
    if (state.poses) state.poses.delete(obj);
  }

  // --- held items ---------------------------------------------------------------------------------------------
  // Power-up items are separate objects the game places from its own arm animation (or, for the first-person
  // weapon, from its camera), so they floated where the animation had them, or weren't drawn at all. Each frame we
  // take where the game put the item relative to its animated arm and apply that to the arm you're moving instead:
  // same grip, and it scales with the arm. Items far from the game's hand (camera-held) are put straight in the hand.
  // Held items as the game names them on a player (from a 0.7.9 debug report). carMesh/tankMesh are vehicles, not held.
  const ITEM_KEYS = ['javelinMesh', 'bananarangMesh', 'singularityGrenadeMesh', 'stickyBombMesh', 'spellbookMesh', 'dodgeballMesh',
    'pistonMesh', 'scytheMesh', 'physicsCannonMesh', 'bearTrapHeldMesh', 'sniperRifleMesh', 'harpoonVisual', 'laserbeamOrb',
    'firstPersonWeaponRoot'];
  const isUnder = (node, ancestor) => { for (let n = node && node.parent; n; n = n.parent) if (n === ancestor) return true; return false; };
  function armFor(player, hand) {
    const gameHand = config.swapArms ? (hand === 'left' ? 'right' : 'left') : hand;
    return gameHand === 'left' ? player.leftArm : player.rightArm;
  }
  function holdItems(player, scene) {
    if (!config.holdItems || config.armMode !== 'hand' || !player || !state.armOrig) { restoreItems(); return; }
    const C = state.classes;
    const t = state.itemTmp || (state.itemTmp = { m: new C.Matrix4(), m2: new C.Matrix4(), m3: new C.Matrix4(), p: new C.Vector3(),
      q: new C.Quaternion(), s: new C.Vector3(), h: new C.Vector3(), h2: new C.Vector3() });
    const items = state.heldItems || (state.heldItems = new Map());
    const seen = new Set();
    for (const key of ITEM_KEYS) {
      const item = player[key];
      if (!item || !item.isObject3D || item === player.leftArm || item === player.rightArm || seen.has(item)) continue;
      // Already hanging off an arm (or off another item): it follows your hand by itself.
      if (isUnder(item, player.leftArm) || isUnder(item, player.rightArm)) continue;
      if (ITEM_KEYS.some((k) => player[k] && player[k] !== item && player[k].isObject3D && isUnder(item, player[k]))) continue;
      seen.add(item);
      let rec = items.get(item);
      if (!rec) { rec = { key, home: item.parent, reparented: false, arm: null }; items.set(item, rec); }
      if (!rec.reparented) rec.home = item.parent;
      gamePose(item);
      if (!item.visible) continue;
      // Where the game means the item to be (in its own parent's space, even if we moved it into the scene).
      const home = rec.home;
      t.m.compose(item.position, item.quaternion, item.scale);
      if (home) { home.updateWorldMatrix(true, false); t.m.premultiply(home.matrixWorld); }
      // Which hand: the first-person weapon goes in your aim hand; others in whichever game hand is nearest.
      if (!rec.arm || !rec.arm.parent) {
        if (key === 'firstPersonWeaponRoot') rec.arm = armFor(player, config.aimHand);
        else {
          t.p.setFromMatrixPosition(t.m);
          let best = null, bestD = Infinity;
          for (const arm of [player.leftArm, player.rightArm]) {
            const orig = arm && state.armOrig.get(arm);
            if (!orig) continue;
            const d = t.h.copy(armInfo(arm).hand).applyMatrix4(orig).distanceTo(t.p);
            if (d < bestD) { bestD = d; best = arm; }
          }
          rec.arm = best;
        }
        if (rec.arm) log('Holding ' + key + ' in your ' + (rec.arm === armFor(player, 'right') ? 'right' : 'left') + ' hand.');
      }
      const arm = rec.arm, orig = arm && state.armOrig.get(arm);
      if (!orig) continue;
      const info = armInfo(arm);
      t.p.setFromMatrixPosition(t.m);
      const offHand = t.h.copy(info.hand).applyMatrix4(orig).distanceTo(t.p);
      const avatarScale = state.rig && state.rig.scale.x || 1;
      if (key === 'firstPersonWeaponRoot' || offHand > 0.6 * avatarScale) {
        // Not attached to the game's arm: put it at your hand, facing where the controller points.
        const entry = state.controllers.find((c) => c.source && armFor(player, c.handedness) === arm);
        const k = Math.max(0.1, Math.min(2, Number(config.armScale) || 1));
        t.m.decompose(t.h2, t.q, t.s);
        t.s.multiplyScalar(k);
        t.h.copy(info.hand).applyMatrix4(arm.matrixWorld);
        if (entry) entry.group.getWorldQuaternion(t.q); else arm.getWorldQuaternion(t.q);
        t.m3.compose(t.h, t.q, t.s);
      } else {
        // Same grip as the game's animation, carried over to your arm (inherits its size and mirroring).
        t.m2.copy(orig).invert().multiply(t.m);
        t.m3.copy(arm.matrixWorld).multiply(t.m2);
        const seen = state.armSizeSeen && state.armSizeSeen.get(arm) || 1;
        if (Math.abs(seen - 1) > 1e-4) t.m3.scale(t.s.setScalar(seen));
      }
      // Objects outside the scene (e.g. a weapon on the game's camera) are never drawn in the headset: move them in.
      let top = item; while (top.parent) top = top.parent;
      if (top !== scene) { scene.add(item); rec.reparented = true; }
      item.parent.updateWorldMatrix(true, false);
      t.m2.copy(item.parent.matrixWorld).invert().multiply(t.m3);
      t.m2.decompose(item.position, item.quaternion, item.scale);
      item.updateMatrixWorld(true);
      notePoseWritten(item);
    }
    for (const [item, rec] of items) if (!seen.has(item)) { putItemBack(item, rec); items.delete(item); }
  }
  function putItemBack(item, rec) {
    if (rec.reparented) { if (rec.home) rec.home.add(item); else if (item.parent) item.parent.remove(item); }
    restoreGamePose(item);
  }
  function restoreItems() {
    if (!state.heldItems || !state.heldItems.size) return;
    for (const [item, rec] of state.heldItems) putItemBack(item, rec);
    state.heldItems.clear();
  }

  function restoreArmScale() {
    if (state.armOrig) { for (const arm of state.armOrig.keys()) restoreGamePose(arm); state.armOrig.clear(); }
    if (!state.armScaled || !state.armScaled.size) return;
    for (const [arm, scale] of state.armScaled) arm.scale.copy(scale);
    state.armScaled.clear();
  }

  // Controller boxes follow boxScale live.
  function updateBoxes() {
    const k = Math.max(0, Number(config.boxScale));
    for (const entry of state.controllers) {
      if (!entry.box) continue;
      entry.box.visible = k > 0.01;
      entry.box.scale.setScalar(k > 0.01 ? k : 1);
    }
  }

  // --- Vivecraft-style aim: the game's own aim (what the server sees) follows the right hand -------------------
  // The game aims with mouse look. Each frame we compare where the right controller points with where the game
  // camera points and send the mouse movement that closes the gap. Pixels-per-radian is learned from how the
  // camera actually responded, so in-game sensitivity doesn't matter.
  const wrapAngle = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  function aimEntry() {
    return state.controllers.find((c) => c.source && c.handedness === config.aimHand) || null;
  }
  function learnAim(axis, sent, moved) {
    const aim = state.aim, key = 'ratio' + axis, flip = 'flip' + axis;
    if (Math.abs(sent) < 4 || Math.abs(moved) < 1e-5) return;
    const sample = moved / sent;
    if (Math.abs(sample) < 2e-5 || Math.abs(sample) > 0.05) return;
    if (Math.sign(sample) !== Math.sign(aim[key])) {
      if (++aim[flip] >= 4) { aim[key] = sample; aim[flip] = 0; }
      return;
    }
    aim[flip] = 0;
    aim[key] = aim[key] * 0.8 + sample * 0.2;
  }
  // Where the aim hand's ray points: the ground in front of you, or aimDistance metres out. Also draws the aim line.
  function aimTarget(entry) {
    const t = state.aimTmp || (state.aimTmp = { o: new state.classes.Vector3(), d: new state.classes.Vector3(), p: new state.classes.Vector3(), q: new state.classes.Quaternion(), f: new state.classes.Vector3() });
    entry.group.getWorldPosition(t.o);
    entry.group.getWorldQuaternion(t.q);
    t.d.set(0, 0, -1).applyQuaternion(t.q);
    const scale = state.rig && state.rig.scale.x || 1;
    let dist = (Number(config.aimDistance) || 10) * scale;
    const player = localPlayer();
    if (player && player.mesh && player.mesh.isObject3D && t.d.y < -0.02) {
      player.mesh.getWorldPosition(t.f);
      const hit = (t.f.y - t.o.y) / t.d.y;
      if (hit > 0.3 * scale && hit < dist) dist = hit;
    }
    // Walls, blocks, other players: whatever the ray meets first.
    const wall = safe('aim raycast', () => raycastWorld(t.o, t.d, dist, 0.3 * scale));
    if (typeof wall === 'number' && wall < dist) dist = wall;
    t.p.copy(t.o).addScaledVector(t.d, dist);
    state.aimDist = dist / scale;
    return t.p;
  }
  // Cheap world ray test against boxes around the arena's meshes (refreshed every ~1.5 s; other players every frame).
  function raycastWorld(o, d, maxDist, minDist) {
    const scene = state.threeScene;
    if (!scene || !state.classes) return null;
    const now = performance.now();
    const C = state.classes;
    const cache = state.rayCache || (state.rayCache = { at: 0, boxes: [], scene: null, v: new C.Vector3(), m: null });
    const me = localPlayer();
    const players = (() => { const gs = gameScene(); const p = gs && gs.players; try { return p && typeof p.values === 'function' ? [...p.values()] : []; } catch { return []; } })();
    if (now - cache.at > 1500 || cache.scene !== scene) {
      cache.at = now; cache.scene = scene; cache.boxes = [];
      const skip = new Set([state.rig]);
      for (const p of players) for (const k of ['mesh', 'avatarVisualRoot', 'avatarFlipPivot']) if (p && p[k] && p[k].isObject3D) skip.add(p[k]);
      const v = cache.v;
      const walk = (node) => {
        if (skip.has(node) || node.visible === false) return;
        const g = node.geometry;
        if (node.isMesh && !node.isSkinnedMesh && g && g.attributes && g.attributes.position && !(node.material && node.material.transparent && node.material.opacity < 0.5)) {
          if (!g.boundingBox && typeof g.computeBoundingBox === 'function') { try { g.computeBoundingBox(); } catch {} }
          const b = g.boundingBox;
          if (b && Number.isFinite(b.min.x)) {
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < 8; i++) {
              v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(node.matrixWorld);
              const c = [v.x, v.y, v.z];
              for (let k = 0; k < 3; k++) { if (c[k] < min[k]) min[k] = c[k]; if (c[k] > max[k]) max[k] = c[k]; }
            }
            // Skip huge boxes (sky, the ground) and specks; the ground is handled as a plane.
            const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
            if (size > 0.05 && size < 200) cache.boxes.push([min, max]);
          }
        }
        for (const child of node.children) walk(child);
      };
      walk(scene);
    }
    const hitBox = (min, max) => {
      let t0 = minDist, t1 = maxDist;
      const oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z];
      for (let k = 0; k < 3; k++) {
        if (Math.abs(da[k]) < 1e-9) { if (oa[k] < min[k] || oa[k] > max[k]) return Infinity; continue; }
        let a = (min[k] - oa[k]) / da[k], b = (max[k] - oa[k]) / da[k];
        if (a > b) { const x = a; a = b; b = x; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
        if (t0 > t1) return Infinity;
      }
      return t0;
    };
    let best = Infinity;
    for (const [min, max] of cache.boxes) { const t = hitBox(min, max); if (t < best) best = t; }
    // Other players (they move): a rough box around each body.
    const v = cache.v;
    for (const p of players) {
      if (!p || p === me || !p.mesh || !p.mesh.isObject3D) continue;
      p.mesh.getWorldPosition(v);
      const t = hitBox([v.x - 0.5, v.y, v.z - 0.5], [v.x + 0.5, v.y + 2.2, v.z + 0.5]);
      if (t < best) best = t;
    }
    return best;
  }
  function updateAimLaser() {
    const entry = aimEntry();
    const show = !!(config.aimLaser && config.aimMode === 'hand' && entry && state.gameplay && !state.ragdoll && !state.uiHit && state.classes && state.classes.Mesh);
    let laser = state.aimLaser;
    if (!show) { if (laser) laser.visible = false; return; }
    if (!laser) {
      const g = boxGeometry(0.003, 0.003, 1);
      g.translate(0, 0, -0.5);
      laser = state.aimLaser = overlayMesh(g, 0xff5555, 1e6 - 1);
      laser.material.opacity = 0.45;
      laser.material.depthTest = true;
      laser.name = 'fister-vr-aim-laser';
    }
    if (laser.parent !== entry.group) entry.group.add(laser);
    if (state.aimDist === undefined) aimTarget(entry);
    laser.scale.set(1, 1, Math.max(0.05, state.aimDist || 1));
    laser.visible = true;
  }
  function steerAim() {
    const aim = state.aim;
    if (config.aimMode !== 'hand') return;
    const entry = aimEntry();
    if (!entry || !state.gameplay || state.uiHit || state.uiPress) { aim.lastYaw = null; return; }
    const { tmp, gameCamera } = state;
    const target = aimTarget(entry);
    // Direction from your body (where the game's aim starts) to the spot your hand points at.
    const player = localPlayer();
    const from = config.aimOrigin === 'body' && player && player.head && player.head.isObject3D
      ? player.head.getWorldPosition(tmp.v4) : gameCamera.getWorldPosition(tmp.v4);
    tmp.v3.subVectors(target, from);
    if (tmp.v3.lengthSq() < 1e-6) { entry.group.getWorldQuaternion(tmp.q3); tmp.v3.set(0, 0, -1).applyQuaternion(tmp.q3); }
    tmp.v3.normalize();
    const wantYaw = Math.atan2(-tmp.v3.x, -tmp.v3.z);
    const wantPitch = Math.asin(Math.max(-1, Math.min(1, tmp.v3.y)));
    gameCamera.getWorldQuaternion(tmp.q);
    tmp.e.setFromQuaternion(tmp.q, 'YXZ');
    const yaw = tmp.e.y, pitch = tmp.e.x;
    if (aim.lastYaw !== null) {
      const movedYaw = wrapAngle(yaw - aim.lastYaw), movedPitch = pitch - aim.lastPitch;
      learnAim('X', aim.lastDx, movedYaw);
      learnAim('Y', aim.lastDy, movedPitch);
      if (Math.abs(aim.lastDx) + Math.abs(aim.lastDy) >= 4 && Math.abs(movedYaw) + Math.abs(movedPitch) < 1e-6) aim.stuck++;
      else if (Math.abs(movedYaw) + Math.abs(movedPitch) > 1e-6) aim.stuck = 0;
      if (aim.stuck === 90) { setStatus('Aim isn\'t reaching the game. Press the right B button to wake input.'); reassertFocus('aim stuck'); }
    }
    const dead = (Number(config.aimDeadzoneDeg) || 0) * Math.PI / 180;
    const gain = Math.min(1, Math.max(0.05, Number(config.aimGain) || 0.6));
    const errYaw = wrapAngle(wantYaw - yaw);
    const errPitch = config.aimPitch ? wantPitch - pitch : 0;
    const clamp = (n) => Math.max(-400, Math.min(400, n));
    const dx = Math.abs(errYaw) > dead ? clamp(Math.round(errYaw * gain / aim.ratioX)) : 0;
    const dy = Math.abs(errPitch) > dead ? clamp(Math.round(errPitch * gain / aim.ratioY)) : 0;
    aim.lastYaw = yaw; aim.lastPitch = pitch; aim.lastDx = dx; aim.lastDy = dy;
    if (dx || dy) sendMouseMove(dx, dy);
  }

  // --- page helpers ------------------------------------------------------------------------------------------
  const isOurs = (el) => !!(el && el.closest && el.closest('#fister-vr-bar, #fister-vr-status, #fister-steam-overlay-heartbeat'));
  const isGameCanvas = (el) => !!(el && state.renderer && el === state.renderer.domElement);

  // --- VR menus: the game's 2D interface on a panel in front of your body ------------------------------------------
  // Fister's HUD and menus (health, style/souls, scoreboard, charge bar, main menu, settings, loading screens) are a
  // flat web layer over the 3D view; the headset never sees it. We repaint that layer onto a texture and show it on a
  // panel that floats in front of you like the in-world health bars: it stays in place while you look around and
  // catches up when you turn far. Your right hand points a laser at it to click, drag sliders and scroll.
  const ALL_LAYERS = 0xffffffff >>> 0;
  function showOnAllLayers(object) {
    // The game camera may only render some layers; our own objects must show regardless.
    object.layers.mask = ALL_LAYERS & ~(1 << 31);
  }

  function textureCtorFrom(t) {
    if (!t || t.isTexture !== true) return null;
    let ctor = t.constructor;
    while (typeof ctor === 'function' && ctor !== Function.prototype) {
      let probe = null;
      try { probe = new ctor(); } catch {}
      if (probe && probe.isTexture === true && !probe.isCubeTexture && !probe.isDataTexture && !probe.isVideoTexture
          && !probe.isCompressedTexture && !probe.isDepthTexture && !probe.isFramebufferTexture) return ctor;
      ctor = Object.getPrototypeOf(ctor);
    }
    return null;
  }

  function findTextureCtor(scene) {
    const candidates = [];
    if (state.xrTarget && state.xrTarget.texture) candidates.push(state.xrTarget.texture);
    if (state.renderer) { const rt = state.renderer.getRenderTarget(); if (rt && rt.texture) candidates.push(rt.texture); }
    if (scene) {
      candidates.push(scene.background, scene.environment);
      scene.traverse((node) => {
        if (candidates.length > 64 || !node.material) return;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (!material) continue;
          for (const key of ['map', 'emissiveMap', 'alphaMap', 'envMap', 'matcap', 'gradientMap']) if (material[key]) candidates.push(material[key]);
          if (material.uniforms) for (const u of Object.values(material.uniforms)) if (u && u.value && u.value.isTexture) candidates.push(u.value);
        }
      });
    }
    for (const t of candidates) { const ctor = textureCtorFrom(t); if (ctor) return ctor; }
    return null;
  }

  function planeGeometry() {
    const { Mesh, Attribute } = state.classes;
    const geometry = new Mesh().geometry;
    geometry.setAttribute('position', new Attribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geometry.setAttribute('uv', new Attribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
    geometry.computeBoundingSphere();
    return geometry;
  }

  function overlayMesh(geometry, color, order) {
    const mesh = new state.classes.Mesh();
    mesh.geometry = geometry;
    const m = mesh.material;
    if (m.color) m.color.setHex(color);
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    m.toneMapped = false;
    m.side = 2; // DoubleSide: visible whichever way it ends up facing
    m.needsUpdate = true;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    showOnAllLayers(mesh);
    return mesh;
  }

  function setupMenu() {
    if (!config.menu || config.menu.mode === 'off') { state.menuProblem = 'turned off'; return; }
    const C = state.classes;
    if (!C || !C.Mesh || !C.Attribute) { state.menuProblem = 'three.js classes not found yet'; return; }
    if (!C.Texture) C.Texture = findTextureCtor(state.threeScene);
    if (!C.Texture) { state.menuProblem = 'no texture class found yet'; return; }
    const width = Math.max(512, Math.min(2048, Number(config.menu.resolution) || 1280));
    const aspect = Math.min(1, Math.max(0.3, (innerHeight || 720) / (innerWidth || 1280)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round(width * aspect);
    const ctx = canvas.getContext('2d');
    const texture = new C.Texture(canvas);
    if ('colorSpace' in texture) texture.colorSpace = 'srgb'; else if ('encoding' in texture) texture.encoding = 3001;
    texture.generateMipmaps = false;
    texture.minFilter = 1006;
    texture.magFilter = 1006;

    const panel = overlayMesh(planeGeometry(), 0xffffff, 1e6);
    panel.material.map = texture;
    panel.material.needsUpdate = true;
    panel.name = 'fister-vr-menu';
    const w = Number(config.menu.width) || 1.6;
    panel.scale.set(w, w * aspect, 1);
    state.rig.add(panel); // rig space = your play space; we place it in front of you every frame

    const dot = overlayMesh(boxGeometry(0.014, 0.014, 0.002), 0xffffff, 1e6 + 2);
    dot.visible = false;
    state.rig.add(dot);
    const laserGeometry = boxGeometry(0.004, 0.004, 1);
    laserGeometry.translate(0, 0, -0.5);
    const laser = overlayMesh(laserGeometry, 0xffffff, 1e6 + 1);
    laser.material.opacity = 0.55;
    laser.visible = false;

    state.menu = { canvas, ctx, texture, panel, dot, laser, aspect, yaw: null, dirty: true, lastDraw: 0, draws: 0,
      drawMs: 0, nodes: 0, noImages: false };
    state.menuProblem = null;
    // Redraw when the interface changes, plus a slow heartbeat for things that animate without DOM changes.
    try {
      state.menuObserver = new MutationObserver(() => { if (state.menu) state.menu.dirty = true; });
      state.menuObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {}
    log('Menu panel ready (' + canvas.width + 'x' + canvas.height + ').');
  }

  function sameOrigin(url) {
    try { const u = new URL(url, location.href); return u.origin === location.origin || u.protocol === 'data:' || u.protocol === 'blob:'; }
    catch { return false; }
  }
  // Image cache for the menu painter. Same-origin and data: images draw directly; other sites' images are re-fetched
  // with CORS (works when the host allows it) so they don't poison the texture. Inline SVG icons are serialised to
  // data: images. Anything still loading redraws the panel when it arrives.
  const imageCache = new Map();
  function cachedImage(url, crossOrigin) {
    let entry = imageCache.get(url);
    if (!entry) {
      if (imageCache.size > 400) imageCache.delete(imageCache.keys().next().value);
      const img = new Image();
      entry = { img, ok: false, failed: false };
      if (crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = () => { entry.ok = true; if (state.menu) state.menu.dirty = true; if (state.standalone && state.standalone.menu) state.standalone.menu.dirty = true; };
      img.onerror = () => { entry.failed = true; };
      img.src = url;
      imageCache.set(url, entry);
    }
    return entry.ok ? entry.img : null;
  }
  function imageFor(url) {
    if (!url) return null;
    return sameOrigin(url) ? cachedImage(url, false) : cachedImage(url, true);
  }
  function svgImage(el, cs) {
    if (el.querySelector('foreignObject')) return null;
    const clone = el.cloneNode(true);
    const r = el.getBoundingClientRect();
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(Math.max(1, Math.round(r.width))));
    clone.setAttribute('height', String(Math.max(1, Math.round(r.height))));
    clone.setAttribute('style', 'color:' + cs.color + ';fill:' + cs.fill + ';stroke:' + cs.stroke);
    const text = new XMLSerializer().serializeToString(clone);
    if (text.length > 60000) return null;
    return cachedImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text), false);
  }
  const transparentColor = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);

  // In a match (no menu open) the panel is a HUD: only the game's overlays (health, style, scoreboard, charge bar),
  // see-through, without the full-screen containers behind the game canvas (they painted a big gray slab).
  const hudMode = () => !!(state.gameplay && !state.ragdoll && !state.pointerLockReleased);
  function paintDom(menu) {
    const hud = hudMode();
    // HUD: paint the page to a scratch canvas, then copy each on-screen widget (health box, scoreboard, popups) into
    // the panel, pulled in toward the centre of view and drawn bigger. Page edges sit too far out to see in a headset.
    let canvas = menu.canvas, ctx = menu.ctx;
    const widgets = [];
    if (hud) {
      if (!menu.full) { menu.full = document.createElement('canvas'); menu.fullCtx = menu.full.getContext('2d'); }
      if (menu.full.width !== canvas.width || menu.full.height !== canvas.height) { menu.full.width = canvas.width; menu.full.height = canvas.height; }
      canvas = menu.full; ctx = menu.fullCtx;
    }
    const W = canvas.width, H = canvas.height, sx = W / innerWidth, sy = H / innerHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    let budget = 5000, nodes = 0, unverified = [];
    const verified = menu.verified || (menu.verified = new WeakSet());
    const drawSource = (src, key, x, y, w, h) => {
      try { ctx.drawImage(src, x, y, w, h); if (!verified.has(key)) unverified.push(key); } catch {}
    };
    const range = document.createRange();
    const big = (r) => r.width * r.height > 0.5 * innerWidth * innerHeight;

    const boxPath = (r, cs) => {
      const x = r.left * sx, y = r.top * sy, w = r.width * sx, h = r.height * sy;
      const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.width / 2, r.height / 2) * sx;
      ctx.beginPath();
      if (radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, radius); else ctx.rect(x, y, w, h);
    };
    const paintBox = (r, cs, alpha) => {
      let bg = cs.backgroundColor;
      if (transparentColor(bg) && cs.backgroundImage && cs.backgroundImage !== 'none') {
        const m = cs.backgroundImage.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i); // gradient: use its first colour
        if (m) bg = m[0];
      }
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const sides = ['Top', 'Right', 'Bottom', 'Left'].map((k) => ({ w: parseFloat(cs['border' + k + 'Width']) || 0, c: cs['border' + k + 'Color'], s: cs['border' + k + 'Style'] }));
      const uniform = sides.every((b) => b.w === sides[0].w && b.c === sides[0].c && b.s === sides[0].s);
      const anySide = sides.some((b) => b.w > 0 && b.s !== 'none' && !transparentColor(b.c));
      const hasBorder = uniform ? (bw > 0 && cs.borderTopStyle !== 'none' && !transparentColor(cs.borderTopColor)) : false;
      const bgUrl = cs.backgroundImage && cs.backgroundImage !== 'none' ? (cs.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/) || [])[1] : null;
      const shadow = cs.boxShadow && cs.boxShadow !== 'none' && /inset/.test(cs.boxShadow);
      if (transparentColor(bg) && !hasBorder && !shadow && !anySide && !bgUrl) return;
      ctx.globalAlpha = alpha;
      boxPath(r, cs);
      if (!transparentColor(bg)) { ctx.fillStyle = bg; ctx.fill(); }
      if (bgUrl && !menu.noImages) {
        const img = imageFor(bgUrl);
        if (img && img.naturalWidth) {
          // background-size: contain / cover / explicit sizes are approximated; repeat is drawn once.
          const x = r.left * sx, y = r.top * sy, w = r.width * sx, h = r.height * sy;
          const size = cs.backgroundSize || 'auto';
          let dw = w, dh = h;
          const ir = img.naturalWidth / img.naturalHeight;
          if (size === 'contain') { if (w / h > ir) { dh = h; dw = h * ir; } else { dw = w; dh = w / ir; } }
          else if (size === 'cover') { if (w / h > ir) { dw = w; dh = w / ir; } else { dh = h; dw = h * ir; } }
          else if (size === 'auto' || size === 'auto auto') { dw = Math.min(w, img.naturalWidth * sx); dh = dw / ir; }
          const pos = (cs.backgroundPosition || '50% 50%').split(' ');
          const frac = (v) => v.endsWith('%') ? parseFloat(v) / 100 : (v === 'center' ? 0.5 : v === 'right' || v === 'bottom' ? 1 : 0);
          ctx.save(); boxPath(r, cs); ctx.clip();
          drawSource(img, img, x + (w - dw) * frac(pos[0] || '50%'), y + (h - dh) * frac(pos[1] || pos[0] || '50%'), dw, dh);
          ctx.restore();
        }
      }
      if (hasBorder) { ctx.lineWidth = Math.max(1, bw * sx); ctx.strokeStyle = cs.borderTopColor; ctx.stroke(); }
      else if (anySide) {
        const x = r.left * sx, y = r.top * sy, w = r.width * sx, h = r.height * sy;
        const [t, rt, b, l] = sides;
        const draw = (side, fx, fy, fw, fh) => { if (side.w > 0 && side.s !== 'none' && !transparentColor(side.c)) { ctx.fillStyle = side.c; ctx.fillRect(fx, fy, fw, fh); } };
        draw(t, x, y, w, t.w * sy); draw(b, x, y + h - b.w * sy, w, b.w * sy);
        draw(l, x, y, l.w * sx, h); draw(rt, x + w - rt.w * sx, y, rt.w * sx, h);
      }
      if (shadow) {
        // Win95-style bevels are drawn with inset box-shadows: light top/left, dark bottom/right.
        const colors = cs.boxShadow.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi) || [];
        const light = colors.find((c) => /255|#f|#e|#d/i.test(c)) || 'rgba(255,255,255,0.8)';
        const dark = colors.find((c) => c !== light) || 'rgba(0,0,0,0.5)';
        const x = r.left * sx, y = r.top * sy, w = r.width * sx, h = r.height * sy, t = Math.max(1, 2 * sx);
        ctx.fillStyle = light; ctx.fillRect(x, y, w, t); ctx.fillRect(x, y, t, h);
        ctx.fillStyle = dark; ctx.fillRect(x, y + h - t, w, t); ctx.fillRect(x + w - t, y, t, h);
      }
    };
    const setFont = (cs) => {
      const size = parseFloat(cs.fontSize) || 14;
      ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + (size * sy).toFixed(1) + 'px ' + cs.fontFamily;
      ctx.fillStyle = cs.color;
      ctx.textBaseline = 'middle';
      return size;
    };
    const caseOf = (cs, str) => cs.textTransform === 'uppercase' ? str.toUpperCase() : cs.textTransform === 'lowercase' ? str.toLowerCase() : str;
    const paintText = (node, cs, alpha) => {
      const raw = node.nodeValue;
      if (!raw || !raw.trim()) return;
      const size = setFont(cs);
      ctx.globalAlpha = alpha;
      const outline = cs.textShadow && cs.textShadow !== 'none';
      if (outline) { ctx.lineWidth = Math.max(2, size * sy * 0.18); ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineJoin = 'round'; }
      const put = (str, rect) => {
        if (!rect || rect.width === 0) return;
        const x = rect.left * sx, y = (rect.top + rect.height / 2) * sy;
        if (outline) ctx.strokeText(str, x, y);
        ctx.fillText(str, x, y);
      };
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      if (rects.length <= 1) { put(caseOf(cs, raw.trim()), rects[0]); return; }
      const re = /\S+/g;
      let match, count = 0;
      while ((match = re.exec(raw)) && count++ < 400) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        put(caseOf(cs, match[0]), range.getClientRects()[0]);
      }
    };

    const walk = (el, alpha, inWidget) => {
      if (--budget < 0 || isOurs(el)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      const opacity = parseFloat(cs.opacity);
      const a = alpha * (Number.isFinite(opacity) ? opacity : 1);
      if (a < 0.02) return;
      nodes++;
      const visible = cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
      const r = el.getBoundingClientRect();
      const onScreen = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      const tag = el.tagName;
      if (visible && onScreen && r.width > 0 && r.height > 0 && el !== document.body && el !== document.documentElement && !isGameCanvas(el)) {
        // In the HUD, full-width bars / tall columns are layout containers: look inside them for the widgets.
        const container = hud && !inWidget && (big(r) || r.width > 0.45 * innerWidth || r.height > 0.6 * innerHeight);
        if (!(hud && (big(r) || container))) paintBox(r, cs, a);
        if (hud && !inWidget && !container && r.width >= 3 && r.height >= 3) { widgets.push({ x: r.left, y: r.top, w: r.width, h: r.height }); inWidget = true; }
        ctx.globalAlpha = a;
        if (tag === 'IMG' && !menu.noImages && el.complete && el.naturalWidth) {
          const src = el.currentSrc || el.src;
          const img = sameOrigin(src) ? el : imageFor(src);
          if (img) drawSource(img, img, r.left * sx, r.top * sy, r.width * sx, r.height * sy);
        } else if ((tag === 'svg' || tag === 'SVG') && !menu.noImages && r.width * r.height < 0.25 * innerWidth * innerHeight) {
          const img = svgImage(el, cs);
          if (img) drawSource(img, img, r.left * sx, r.top * sy, r.width * sx, r.height * sy);
        } else if (tag === 'VIDEO' && !menu.noImages && el.readyState >= 2 && sameOrigin(el.currentSrc || el.src)) {
          drawSource(el, el, r.left * sx, r.top * sy, r.width * sx, r.height * sy);
        } else if (tag === 'CANVAS' && !menu.noImages && !big(r)) {
          drawSource(el, el, r.left * sx, r.top * sy, r.width * sx, r.height * sy);
        } else if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.type === 'range') {
          const min = Number(el.min) || 0, max = Number(el.max) || 100, v = Number(el.value);
          const f = max > min ? (v - min) / (max - min) : 0;
          ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(r.left * sx, (r.top + r.height / 2 - 2) * sy, r.width * sx, 4 * sy);
          ctx.fillStyle = '#ddd'; ctx.fillRect((r.left + f * r.width - 5) * sx, r.top * sy, 10 * sx, r.height * sy);
        } else if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          ctx.fillStyle = '#fff'; ctx.fillRect(r.left * sx, r.top * sy, r.width * sx, r.height * sy);
          if (el.checked) { ctx.fillStyle = '#111'; ctx.fillRect((r.left + r.width * 0.25) * sx, (r.top + r.height * 0.25) * sy, r.width * 0.5 * sx, r.height * 0.5 * sy); }
        } else if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && el.type !== 'password' && el.type !== 'hidden') {
          const text = tag === 'SELECT' ? (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text + '  ▾' : '') : String(el.value || el.placeholder || '');
          if (text) {
            setFont(cs);
            if (!el.value && tag !== 'SELECT') ctx.globalAlpha = a * 0.5;
            ctx.fillText(text.slice(0, 200), (r.left + (parseFloat(cs.paddingLeft) || 4)) * sx, (r.top + r.height / 2) * sy);
          }
        }
      }
      if (tag === 'CANVAS' || tag === 'SELECT' || tag === 'svg' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE') return;
      // Scroll areas and clipped boxes: keep their children inside the box.
      const clip = cs.overflow !== 'visible' && cs.overflowY !== 'visible' && r.width > 0 && r.height > 0;
      if (clip) { ctx.save(); ctx.beginPath(); ctx.rect(r.left * sx, r.top * sy, r.width * sx, r.height * sy); ctx.clip(); }
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) walk(child, a, inWidget);
        else if (child.nodeType === 3 && visible && onScreen) {
          paintText(child, cs, a);
          if (hud && !inWidget && child.nodeValue && child.nodeValue.trim()) {
            range.selectNodeContents(child);
            const tr = range.getBoundingClientRect();
            if (tr.width > 0 && tr.height > 0) widgets.push({ x: tr.left - 2, y: tr.top - 2, w: tr.width + 4, h: tr.height + 4 });
          }
        }
      }
      if (clip) ctx.restore();
    };
    if (document.body) walk(document.body, 1, false);
    ctx.globalAlpha = 1;
    // A cross-origin image would make the texture unusable. Checking costs a GPU readback, so only do it the first
    // time a new image/canvas is drawn.
    if (unverified.length) {
      try { ctx.getImageData(0, 0, 1, 1); for (const k of unverified) verified.add(k); }
      catch {
        if (!menu.noImages) { menu.noImages = true; menu.full = null; warn('Menu panel: a cross-origin image blocked it; redrawing without images.'); return paintDom(menu); }
      }
    }
    menu.hudMap = null;
    if (hud) {
      const out = menu.ctx, W = menu.canvas.width, H = menu.canvas.height;
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.globalAlpha = 1;
      out.clearRect(0, 0, W, H);
      const pull = Math.max(0, Math.min(1, Number(config.hud.pull) || 0.5)), grow = Math.max(0.5, Math.min(3, Number(config.hud.grow) || 1.4));
      const cx0 = innerWidth / 2, cy0 = innerHeight / 2, map = [];
      for (const r of widgets) {
        const w = r.w * grow, h = r.h * grow;
        let x = cx0 + (r.x + r.w / 2 - cx0) * pull - w / 2, y = cy0 + (r.y + r.h / 2 - cy0) * pull - h / 2;
        x = Math.max(0, Math.min(innerWidth - w, x)); y = Math.max(0, Math.min(innerHeight - h, y));
        try { out.drawImage(canvas, r.x * sx, r.y * sy, r.w * sx, r.h * sy, x * sx, y * sy, w * sx, h * sy); } catch {}
        map.push({ src: r, dst: { x, y, w, h } });
      }
      menu.hudMap = map;
      menu.hudWidgets = widgets.length;
    }
    menu.nodes = nodes;
    menu.texture.needsUpdate = true;
  }

  function hitInteractive(el) {
    if (!el || el === document.body || el === document.documentElement || isGameCanvas(el) || isOurs(el)) return false;
    if (!hudMode()) return true;
    const control = el.closest && el.closest('button, a[href], input, select, textarea, label, summary, [role="button"], [role="tab"], [role="menuitem"], [onclick]');
    if (control) return true;
    try { return getComputedStyle(el).cursor === 'pointer'; } catch { return false; }
  }

  function updateMenu() {
    const menu = state.menu;
    if (!menu) return;
    const now = performance.now();
    // Redraw: on change (capped), at least once a second for things that animate without DOM changes.
    // Adaptive: never spend more than ~8% of the time painting (a 4 ms paint allows ~12/s, a 15 ms paint ~5/s).
    const inMatch = state.gameplay && !state.uiHit && !state.pointerLockReleased;
    if (menu.wasHud !== hudMode()) { menu.wasHud = hudMode(); menu.dirty = true; menu.lastDraw = 0; }
    const minGap = Math.max(1000 / Math.max(1, Number(config.menu.maxFps) || 12), (menu.drawMs || 0) * (inMatch ? 25 : 12));
    if ((menu.dirty && now - menu.lastDraw > minGap) || now - menu.lastDraw > (inMatch ? 3000 : 1000)) {
      menu.dirty = false;
      menu.lastDraw = now;
      const t0 = performance.now();
      paintDom(menu);
      const dt = performance.now() - t0;
      menu.drawMs = menu.drawMs ? menu.drawMs * 0.8 + dt * 0.2 : dt;
      menu.draws++;
    }

    // Place the panel in front of you (rig space), below eye level, tilted toward you. It keeps its heading
    // until your head turns more than followDeg away, then catches up smoothly.
    const { tmp } = state;
    const view = state.view;
    const head = view.position; // last XR pose, rig space
    tmp.e.setFromQuaternion(view.quaternion, 'YXZ');
    const headYaw = tmp.e.y;
    if (menu.yaw === null) menu.yaw = headYaw;
    const diff = wrapAngle(headYaw - menu.yaw);
    const hud = hudMode();
    if (hud) { menu.yaw += diff * 0.2; menu.catching = false; } // HUD: stays in front of your face, gently smoothed
    else {
      const follow = (Number(config.menu.followDeg) || 35) * Math.PI / 180;
      if (Math.abs(diff) > follow) menu.catching = true;
      if (menu.catching) {
        menu.yaw += diff * 0.12;
        if (Math.abs(diff) < 0.05) menu.catching = false;
      }
    }
    const d = hud ? (Number(config.hud.distance) || 1.6) : (Number(config.menu.distance) || 1.4);
    const w = hud ? (Number(config.hud.width) || 2.0) : (Number(config.menu.width) || 1.6);
    const panel = menu.panel;
    panel.scale.set(w, w * menu.aspect, 1);
    const drop = hud ? (Number(config.hud.drop) || 0) : (Number(config.menu.drop) || 0.15);
    panel.position.set(head.x - Math.sin(menu.yaw) * d, head.y - drop, head.z - Math.cos(menu.yaw) * d);
    panel.rotation.set(hud ? 0 : -(Number(config.menu.tiltDeg) || 8) * Math.PI / 180, menu.yaw, 0, 'YXZ');
    panel.updateMatrixWorld(true);

    // Laser from the right hand.
    const entry = aimEntry();
    let hit = null;
    if (entry) {
      if (menu.laser.parent !== entry.group) entry.group.add(menu.laser);
      entry.group.getWorldPosition(tmp.v);
      entry.group.getWorldQuaternion(tmp.q3);
      tmp.v2.set(0, 0, -1).applyQuaternion(tmp.q3).add(tmp.v);
      const o = panel.worldToLocal(tmp.v4.copy(tmp.v));
      const p2 = panel.worldToLocal(tmp.v2);
      const dz = p2.z - o.z;
      if (Math.abs(dz) > 1e-6) {
        const t = -o.z / dz;
        const x = o.x + (p2.x - o.x) * t, y = o.y + (p2.y - o.y) * t;
        if (t > 0 && Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5) {
          let cx = (x + 0.5) * innerWidth, cy = (0.5 - y) * innerHeight;
          if (menu.hudMap) { // the HUD moved widgets: map the point back to where the widget really is on the page
            const m = menu.hudMap.find((e) => cx >= e.dst.x && cx <= e.dst.x + e.dst.w && cy >= e.dst.y && cy <= e.dst.y + e.dst.h);
            if (m) { cx = m.src.x + (cx - m.dst.x) * m.src.w / m.dst.w; cy = m.src.y + (cy - m.dst.y) * m.src.h / m.dst.h; } else { cx = -1; cy = -1; }
          }
          const el = cx < 0 ? null : document.elementFromPoint(cx, cy);
          if (hitInteractive(el)) {
            hit = { element: el, x: cx, y: cy };
            const world = panel.localToWorld(tmp.v2.set(x, y, 0.002));
            menu.dot.position.copy(state.rig.worldToLocal(world.clone()));
            const scale = state.rig.scale.x || 1;
            menu.laser.scale.set(1, 1, panel.localToWorld(tmp.v2.set(x, y, 0)).distanceTo(tmp.v) / scale);
          }
        }
      }
    }
    state.uiHit = hit;
    menu.dot.visible = !!hit;
    menu.laser.visible = !!hit;
    if (state.uiPress && hit) uiDrag(hit);
  }

  function fireMouse(el, type, x, y, button, buttons) {
    const init = { button, buttons, bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
    if (type.startsWith('pointer')) el.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    else el.dispatchEvent(new MouseEvent(type, init));
  }

  // Native controls ignore synthetic events for their default behaviour, so sliders and dropdowns are set directly
  // (through the native value setter, so React notices).
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  function setRange(el, x) {
    const r = el.getBoundingClientRect();
    const min = Number(el.min) || 0, max = el.max === '' ? 100 : Number(el.max), step = Number(el.step) || 1;
    let v = min + Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))) * (max - min);
    v = Math.round(v / step) * step;
    nativeValueSetter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function stepSelect(el) {
    const n = el.options.length;
    if (!n) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set;
    setter.call(el, (el.selectedIndex + 1) % n);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function uiPress(down) {
    state.lastUiAt = performance.now();
    if (down) {
      const hit = state.uiHit;
      if (!hit) return false;
      state.uiPress = hit;
      fireMouse(hit.element, 'pointerdown', hit.x, hit.y, 0, 1);
      fireMouse(hit.element, 'mousedown', hit.x, hit.y, 0, 1);
      const el = hit.element;
      if (el.tagName === 'INPUT' && el.type === 'range') setRange(el, hit.x);
      return true;
    }
    const press = state.uiPress;
    if (!press) return false;
    state.uiPress = null;
    const at = state.uiHit || press;
    fireMouse(press.element, 'pointerup', at.x, at.y, 0, 0);
    fireMouse(press.element, 'mouseup', at.x, at.y, 0, 0);
    const same = at.element === press.element || press.element.contains(at.element) || at.element.contains(press.element);
    if (same) {
      const el = press.element;
      if (el.tagName === 'SELECT') stepSelect(el);
      else if (!(el.tagName === 'INPUT' && el.type === 'range')) {
        const clickable = el.closest('button, a, label, input, summary, [role], [onclick]') || el;
        if (typeof clickable.click === 'function' && /^(BUTTON|A|LABEL|INPUT|SUMMARY)$/.test(clickable.tagName)) clickable.click();
        else fireMouse(el, 'click', at.x, at.y, 0, 0);
      }
    }
    // Don't leave keyboard focus on a menu button: the game would stop seeing WASD.
    setTimeout(() => { const ae = document.activeElement; if (ae && (ae.tagName === 'BUTTON' || ae.tagName === 'A')) ae.blur(); }, 0);
    if (state.menu) state.menu.dirty = true;
    return true;
  }

  function uiDrag(hit) {
    const press = state.uiPress;
    if (!press) return;
    fireMouse(press.element, 'pointermove', hit.x, hit.y, 0, 1);
    fireMouse(press.element, 'mousemove', hit.x, hit.y, 0, 1);
    if (press.element.tagName === 'INPUT' && press.element.type === 'range') setRange(press.element, hit.x);
  }

  function uiScroll(amount) {
    const hit = state.uiHit;
    if (!hit) return;
    hit.element.dispatchEvent(new WheelEvent('wheel', { deltaY: amount, clientX: hit.x, clientY: hit.y, bubbles: true, cancelable: true }));
    // Synthetic wheel events don't scroll by themselves: scroll the nearest scrollable box directly.
    for (let n = hit.element; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 2) { n.scrollTop += amount; break; }
    }
    if (state.menu) state.menu.dirty = true;
  }

  function teardownMenu() {
    if (state.uiPress) uiPress(false);
    state.uiHit = null;
    if (state.menu) state.menu.yaw = null;
  }

  // --- pointer lock: many games only apply mouse look while the pointer is locked ---------------------------------
  const pointerLockDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement');
  // When the game asks to capture the mouse again (e.g. clicking back in after the pause menu), grant it in VR.
  const nativeRequestPointerLock = Element.prototype.requestPointerLock;
  if (nativeRequestPointerLock) {
    Element.prototype.requestPointerLock = function requestPointerLock(...args) {
      state.lockTarget = this;
      state.lockRequests = (state.lockRequests || 0) + 1;
      if (state.presenting && config.spoofPointerLock) {
        state.pointerLockReleased = false;
        setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0);
        return Promise.resolve();
      }
      return nativeRequestPointerLock.apply(this, args);
    };
  }
  document.addEventListener('pointerlockchange', () => {
    const real = pointerLockDescriptor && pointerLockDescriptor.get.call(document);
    if (real) state.lockTarget = real;
  }, true);
  try { const real = pointerLockDescriptor && pointerLockDescriptor.get.call(document); if (real) state.lockTarget = real; } catch {}
  function spoofPointerLock(on) {
    if (!pointerLockDescriptor || !config.spoofPointerLock) return;
    if (on === state.lockSpoofed) { if (on) document.dispatchEvent(new Event('pointerlockchange')); return; }
    state.lockSpoofed = on;
    if (on) {
      Object.defineProperty(Document.prototype, 'pointerLockElement', {
        configurable: true, enumerable: true,
        get() {
          const real = pointerLockDescriptor.get.call(this);
          if (real || !state.presenting || state.pointerLockReleased) return real || null;
          // The element the game asked to lock (it may compare against it), else the game canvas.
          if (state.lockTarget && state.lockTarget.isConnected) return state.lockTarget;
          return state.renderer && state.renderer.domElement ? state.renderer.domElement : null;
        },
      });
      document.dispatchEvent(new Event('pointerlockchange'));
    } else {
      Object.defineProperty(Document.prototype, 'pointerLockElement', pointerLockDescriptor);
      document.dispatchEvent(new Event('pointerlockchange'));
    }
  }

  // --- menu-only VR: enter VR before the game draws anything 3D ---------------------------------------------------
  // On the landing page / main menu the game may not have drawn a 3D frame yet, so there is no three.js renderer to
  // hand the headset to. In that case we run the session ourselves with a tiny WebGL renderer: the menu panel, the
  // laser and a floor grid. As soon as the game renders (you press Play, or the menu's skybox starts), the session is
  // handed to the game's renderer without leaving VR.
  const mat4 = {
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    // translate(x,y,z) * rotateY(yaw) * scale(sx,sy,sz)
    trs(x, y, z, yaw, sx, sy, sz) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      return new Float32Array([c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1]);
    },
  };

  function standaloneGl(session) {
    const canvas = document.createElement('canvas');
    const attrs = { xrCompatible: true, alpha: false, antialias: true, depth: true };
    const gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs);
    if (!gl) throw new Error('WebGL unavailable');
    const compile = (type, src) => {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, 'attribute vec3 p;attribute vec2 uv;uniform mat4 mvp;varying vec2 v;void main(){v=uv;gl_Position=mvp*vec4(p,1.0);}'));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, 'precision mediump float;uniform sampler2D t;uniform vec4 c;uniform float tex;varying vec2 v;void main(){vec4 col=tex>0.5?texture2D(t,vec2(v.x,1.0-v.y))*c:c;if(col.a<0.01)discard;gl_FragColor=col;}'));
    gl.linkProgram(prog);
    const loc = { p: gl.getAttribLocation(prog, 'p'), uv: gl.getAttribLocation(prog, 'uv'), mvp: gl.getUniformLocation(prog, 'mvp'),
      t: gl.getUniformLocation(prog, 't'), c: gl.getUniformLocation(prog, 'c'), tex: gl.getUniformLocation(prog, 'tex') };
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0, 0, 0, 0.5, -0.5, 0, 1, 0, 0.5, 0.5, 0, 1, 1, -0.5, -0.5, 0, 0, 0, 0.5, 0.5, 0, 1, 1, -0.5, 0.5, 0, 0, 1]), gl.STATIC_DRAW);
    const lines = gl.createBuffer();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    return { canvas, gl, prog, loc, quad, lines, texture };
  }

  async function startStandalone(session) {
    const g = standaloneGl(session);
    if (g.gl.makeXRCompatible) await g.gl.makeXRCompatible();
    const scale = Math.min(1.5, Math.max(0.4, Number(config.framebufferScale) || 1));
    const layer = new XRWebGLLayer(session, g.gl, { framebufferScaleFactor: scale });
    await session.updateRenderState({ baseLayer: layer });
    const space = await session.requestReferenceSpace('local');
    const width = Math.max(512, Math.min(2048, Number(config.menu.resolution) || 1280));
    const aspect = Math.min(1, Math.max(0.3, (innerHeight || 720) / (innerWidth || 1280)));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = Math.round(width * aspect);
    const menu = { canvas, ctx: canvas.getContext('2d'), texture: { needsUpdate: false }, aspect, dirty: true, lastDraw: 0, draws: 0, drawMs: 0, nodes: 0, noImages: false, yaw: null };
    const sa = { session, space, layer, g, menu, handedOff: false, frames: 0, floorY: null, hand: null };
    state.standalone = sa;
    state.presenting = true;
    state.redirectRaf = true;
    spoofFocus(true);
    state.pointerLockReleased = false;
    spoofPointerLock(true);
    try { state.menuObserver2 = new MutationObserver(() => { menu.dirty = true; }); state.menuObserver2.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
    session.addEventListener('end', () => endStandalone(sa));
    attachSelectEvents(session);
    session.requestAnimationFrame((t, f) => standaloneFrame(sa, t, f));
    log('Menu-only VR started (no game 3D yet). It switches to the game view as soon as the game renders.');
    setStatus('In VR (menus) · switches to the game when it starts rendering');
  }

  function endStandalone(sa) {
    if (state.standalone !== sa) return;
    state.standalone = null;
    if (sa.handedOff) return;
    releaseAllInput();
    state.presenting = false;
    state.redirectRaf = false;
    state.uiHit = null;
    spoofFocus(false);
    spoofPointerLock(false);
    if (state.menuObserver2) { try { state.menuObserver2.disconnect(); } catch {} state.menuObserver2 = null; }
    const queue = state.rafQueue;
    state.rafQueue = new Map();
    for (const callback of queue.values()) nativeRaf(callback);
    setStatus('');
    log('Menu-only VR ended.');
  }

  // Called from captureRenderer: the game started rendering while we run the session ourselves.
  function handOffStandalone(renderer) {
    const sa = state.standalone;
    if (!sa || sa.handedOff) return;
    sa.handedOff = true;
    if (state.menuObserver2) { try { state.menuObserver2.disconnect(); } catch {} state.menuObserver2 = null; }
    state.uiHit = null;
    state.renderer = renderer;
    try { renderer.xr.setFramebufferScaleFactor(Math.min(1.5, Math.max(0.4, Number(config.framebufferScale) || 1))); } catch {}
    renderer.xr.setSession(sa.session).then(() => {
      log('Handed the headset to the game renderer.');
    }).catch((error) => {
      record('error', ['Hand-off to the game renderer failed:', error]);
      sa.handedOff = false;
      state.standalone = sa;
      sa.session.requestAnimationFrame((t, f) => standaloneFrame(sa, t, f));
    });
  }

  function standaloneFrame(sa, time, frame) {
    if (sa.handedOff || state.standalone !== sa) return;
    sa.session.requestAnimationFrame((t, f) => standaloneFrame(sa, t, f));
    sa.frames++;
    safe('timers', runDueTimers);
    // Let the page (and the game's loop, if it runs) do its frame work inside the XR frame.
    const queue = state.rafQueue;
    state.rafQueue = new Map();
    for (const callback of queue.values()) { try { callback(time); } catch (error) { record('game-error', ['Game frame error:', error]); } }
    if (sa.handedOff) return; // the game rendered during its frame and took over
    safe('controller input', () => pollInput(frame));
    const pose = frame.getViewerPose(sa.space);
    if (!pose) return;
    safe('menu-only view', () => drawStandalone(sa, frame, pose));
  }

  function drawStandalone(sa, frame, pose) {
    const { gl, prog, loc, quad, lines, texture } = sa.g;
    const menu = sa.menu;
    const now = performance.now();
    const minGap = Math.max(1000 / Math.max(1, Number(config.menu.maxFps) || 12), (menu.drawMs || 0) * 12);
    if ((menu.dirty && now - menu.lastDraw > minGap) || now - menu.lastDraw > 1000) {
      menu.dirty = false; menu.lastDraw = now;
      const t0 = performance.now();
      paintDom(menu);
      const dt = performance.now() - t0;
      menu.drawMs = menu.drawMs ? menu.drawMs * 0.8 + dt * 0.2 : dt;
      menu.draws++;
    }
    // Panel: in front of your head, lazily following your facing.
    const hp = pose.transform.position, ho = pose.transform.orientation;
    const headYaw = Math.atan2(2 * (ho.w * ho.y + ho.x * ho.z), 1 - 2 * (ho.y * ho.y + ho.x * ho.x));
    if (menu.yaw === null) menu.yaw = headYaw;
    const diff = wrapAngle(headYaw - menu.yaw);
    if (Math.abs(diff) > (Number(config.menu.followDeg) || 35) * Math.PI / 180) menu.catching = true;
    if (menu.catching) { menu.yaw += diff * 0.12; if (Math.abs(diff) < 0.05) menu.catching = false; }
    if (sa.floorY === null) sa.floorY = hp.y - 1.6;
    const d = Number(config.menu.distance) || 1.4, w = Number(config.menu.width) || 1.6, h = w * menu.aspect;
    const cx = hp.x - Math.sin(menu.yaw) * d, cy = hp.y - (Number(config.menu.drop) || 0.15), cz = hp.z - Math.cos(menu.yaw) * d;

    // Laser from the right controller.
    let hit = null, ray = null;
    for (const source of frame.session.inputSources) {
      if (source.handedness !== config.aimHand || !source.targetRaySpace) continue;
      const rp = frame.getPose(source.targetRaySpace, sa.space);
      if (!rp) continue;
      const m = rp.transform.matrix;
      const o = [m[12], m[13], m[14]], dir = [-m[8], -m[9], -m[10]];
      ray = { o, dir, len: 3 };
      const cs = Math.cos(-menu.yaw), sn = Math.sin(-menu.yaw);
      const ox = o[0] - cx, oy = o[1] - cy, oz = o[2] - cz;
      const lo = [ox * cs + oz * sn, oy, -ox * sn + oz * cs];
      const ld = [dir[0] * cs + dir[2] * sn, dir[1], -dir[0] * sn + dir[2] * cs];
      if (Math.abs(ld[2]) > 1e-6) {
        const t = -lo[2] / ld[2];
        const x = lo[0] + ld[0] * t, y = lo[1] + ld[1] * t;
        if (t > 0 && Math.abs(x) <= w / 2 && Math.abs(y) <= h / 2) {
          const clientX = (x / w + 0.5) * innerWidth, clientY = (0.5 - y / h) * innerHeight;
          const el = document.elementFromPoint(clientX, clientY);
          if (hitInteractive(el)) { hit = { element: el, x: clientX, y: clientY }; ray.len = t; }
        }
      }
    }
    state.uiHit = hit;
    if (state.uiPress && hit) uiDrag(hit);

    // Draw.
    const layer = sa.layer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0.07, 0.09, 0.13, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (menu.texture.needsUpdate) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, menu.canvas);
      menu.texture.needsUpdate = false;
    }
    gl.uniform1i(loc.t, 0);
    // Floor grid + laser as lines.
    const grid = [];
    const fy = sa.floorY, gx = Math.round(hp.x), gz = Math.round(hp.z);
    for (let i = -8; i <= 8; i++) { grid.push(gx - 8, fy, gz + i, gx + 8, fy, gz + i, gx + i, fy, gz - 8, gx + i, fy, gz + 8); }
    const laser = ray ? [ray.o[0], ray.o[1], ray.o[2], ray.o[0] + ray.dir[0] * ray.len, ray.o[1] + ray.dir[1] * ray.len, ray.o[2] + ray.dir[2] * ray.len] : [];
    const panelModel = mat4.trs(cx, cy, cz, menu.yaw, w, h, 1);
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const vpm = mat4.mul(view.projectionMatrix, view.transform.inverse.matrix);
      // lines
      gl.bindBuffer(gl.ARRAY_BUFFER, lines);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid.concat(laser)), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.p);
      gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, 12, 0);
      gl.disableVertexAttribArray(loc.uv);
      gl.vertexAttrib2f(loc.uv, 0, 0);
      gl.uniformMatrix4fv(loc.mvp, false, vpm);
      gl.uniform1f(loc.tex, 0);
      gl.uniform4f(loc.c, 0.3, 0.45, 0.55, 0.6);
      gl.drawArrays(gl.LINES, 0, grid.length / 3);
      if (laser.length) {
        gl.uniform4f(loc.c, 1, 1, 1, hit ? 0.9 : 0.35);
        gl.drawArrays(gl.LINES, grid.length / 3, 2);
      }
      // panel
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc.p);
      gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(loc.uv);
      gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 20, 12);
      gl.uniformMatrix4fv(loc.mvp, false, mat4.mul(vpm, panelModel));
      gl.uniform1f(loc.tex, 1);
      gl.uniform4f(loc.c, 1, 1, 1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (hit && ray) {
        const p = [ray.o[0] + ray.dir[0] * ray.len, ray.o[1] + ray.dir[1] * ray.len, ray.o[2] + ray.dir[2] * ray.len];
        gl.uniformMatrix4fv(loc.mvp, false, mat4.mul(vpm, mat4.trs(p[0], p[1], p[2], menu.yaw, 0.015, 0.015, 1)));
        gl.uniform1f(loc.tex, 0);
        gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.enable(gl.DEPTH_TEST);
      }
    }
  }

  // --- keep the game listening ------------------------------------------------------------------------------
  // In an immersive session the 2D page can lose focus; the game then drops or ignores input until you switch
  // tabs. While in VR we report the page as focused/visible and replay focus + held keys whenever it slips.
  const nativeHasFocus = Document.prototype.hasFocus;
  function spoofFocus(on) {
    if (on) {
      Document.prototype.hasFocus = function hasFocus() { return state.presenting ? true : nativeHasFocus.call(this); };
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      } catch {}
    } else {
      Document.prototype.hasFocus = nativeHasFocus;
      try { delete document.visibilityState; delete document.hidden; } catch {}
    }
  }
  function reassertFocus(why) {
    if (!state.presenting) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && (isOurs(ae) || ae.tagName === 'BUTTON')) { try { ae.blur(); } catch {} }
    if (state.gameplay) releaseTextFocus();
    window.dispatchEvent(new FocusEvent('focus'));
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    document.dispatchEvent(new Event('visibilitychange'));
    for (const code of state.keysDown) dispatchKey(code, true);
    if (why !== 'timer') log('Input re-focused (' + why + ').');
  }
  window.addEventListener('blur', () => { if (state.presenting) setTimeout(() => reassertFocus('blur'), 30); }, true);
  document.addEventListener('visibilitychange', (event) => {
    if (state.presenting && event.isTrusted) setTimeout(() => reassertFocus('visibility'), 30);
  }, true);

  const BUTTON_INDEX = { trigger: 0, squeeze: 1, thumbstick: 3 };
  const FACE = { left: { x: 4, y: 5 }, right: { a: 4, b: 5 } };

  function keyFromCode(code) {
    if (code.startsWith('Key')) return code.slice(3).toLowerCase();
    if (code.startsWith('Digit')) return code.slice(5);
    return { Space: ' ', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', Escape: 'Escape', Tab: 'Tab', Enter: 'Enter' }[code] || code;
  }
  const KEY_CODES = { Space: 32, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, Escape: 27, Tab: 9, Enter: 13 };
  function keyCodeFor(code) {
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit\d$/.test(code)) return code.charCodeAt(5);
    return KEY_CODES[code] || 0;
  }

  const isTextField = (el) => !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
  function keyTarget() {
    const ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement || isOurs(ae) || ae.tagName === 'BUTTON') return document.body || document;
    if (state.gameplay && isTextField(ae)) return document.body || document;
    return ae;
  }
  // A menu click (name box, lobby code, chat) can leave a text field focused. In a match that swallows W/A/S/D, and
  // many games ignore the mouse while you're typing. There's no keyboard in the headset, so let go of it.
  function releaseTextFocus() {
    const ae = document.activeElement;
    if (!isTextField(ae) || isOurs(ae) || (ae.closest && ae.closest('#fister-vr-info'))) return;
    // Dropdowns don't take movement keys, and you may be using a menu over the match (sandbox, settings).
    if (ae.tagName === 'SELECT' || (state.lastUiAt && performance.now() - state.lastUiAt < 8000)) return;
    try { ae.blur(); } catch {}
    log('Let go of a focused text box (' + describeEl(ae) + ') so movement keys reach the game.');
  }
  function describeEl(el) {
    if (!el) return 'none';
    if (el === document.body) return 'page';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '');
  }

  function dispatchKey(code, down) {
    const event = new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: keyFromCode(code), bubbles: true, cancelable: true, composed: true });
    const keyCode = keyCodeFor(code);
    Object.defineProperty(event, 'keyCode', { get: () => keyCode });
    Object.defineProperty(event, 'which', { get: () => keyCode });
    keyTarget().dispatchEvent(event);
  }

  function sendKey(code, down) {
    if (down === state.keysDown.has(code)) return;
    if (down) state.keysDown.add(code); else state.keysDown.delete(code);
    dispatchKey(code, down);
  }

  function inputTarget() {
    return (state.renderer && state.renderer.domElement && state.renderer.domElement.isConnected) ? state.renderer.domElement : document;
  }

  const mouseButtonsHeld = new Set();
  function sendMouseButton(button, down) {
    if (down) mouseButtonsHeld.add(button); else mouseButtonsHeld.delete(button);
    const buttons = [...mouseButtonsHeld].reduce((mask, b) => mask | (b === 0 ? 1 : b === 2 ? 2 : 4), 0);
    const target = inputTarget();
    const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const init = { button, buttons, bubbles: true, cancelable: true, composed: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    target.dispatchEvent(new PointerEvent(down ? 'pointerdown' : 'pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', init));
    if (!down && button === 0) target.dispatchEvent(new MouseEvent('click', init));
  }

  function sendMouseMove(dx, dy = 0) {
    if (!dx && !dy) return;
    const target = inputTarget();
    const init = { movementX: dx, movementY: dy, buttons: [...mouseButtonsHeld].reduce((m, b) => m | (b === 0 ? 1 : b === 2 ? 2 : 4), 0),
      bubbles: true, cancelable: true, composed: true, view: window };
    target.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousemove', init));
  }

  // WebXR 'select' events count as a user action, so clicks done inside them may open full screen, start audio or
  // capture the mouse, which a lobby/join button may need. Menu clicks with the aim hand are done here.
  function attachSelectEvents(session) {
    if (!session || session.__fisterVrSelect) return;
    session.__fisterVrSelect = true;
    session.addEventListener('selectstart', (event) => {
      if (!event.inputSource || event.inputSource.handedness !== config.aimHand || !state.uiHit) return;
      state.triggerToUi = true;
      safe('menu click', () => uiPress(true));
    });
    session.addEventListener('selectend', (event) => {
      if (!event.inputSource || event.inputSource.handedness !== config.aimHand || !state.triggerToUi) return;
      safe('menu click', () => uiPress(false));
      state.selectReleased = true;
    });
  }

  function runAction(action, down, frame, hand) {
    if (!action) return;
    if (action === 'recenter') { if (down) { recenter(frame); reassertFocus('recenter'); } return; }
    if (action === 'refocus') { if (down) reassertFocus('button'); return; }
    // Right trigger on the menu panel clicks the menu instead of punching.
    if (hand === config.aimHand && action.mouse === 0) {
      // Already handled by the select event? Then just consume the gamepad edge.
      if (down && state.triggerToUi) return;
      if (!down && state.triggerToUi) { state.triggerToUi = false; if (!state.selectReleased && state.uiPress) uiPress(false); state.selectReleased = false; return; }
      if (down ? state.uiHit : state.uiPress) { state.triggerToUi = down; uiPress(down); return; }
    }
    // Escape opens the game's pause menu, which many games do when the pointer is released.
    if (action.key === 'Escape' && down && config.spoofPointerLock && state.presenting) {
      state.pointerLockReleased = !state.pointerLockReleased;
      document.dispatchEvent(new Event('pointerlockchange'));
    }
    if (typeof action.mouse === 'number') sendMouseButton(action.mouse, down);
    else if (typeof action.key === 'string') sendKey(action.key, down);
  }

  // Controllers that connected before our rig existed never sent us a 'connected' event. three.js assigns controller
  // slots in the order input sources appear, so adopt them from the session's list.
  function adoptControllers(session) {
    if (!session || !state.controllers.length) return;
    const sources = [...session.inputSources].filter((src) => src.targetRayMode === 'tracked-pointer' || src.gamepad);
    // three.js only tracks controllers it saw arrive ('inputsourceschange'). After the menu-only view hands the session
    // over, they had already arrived, so three never moves them: no hands, no aim. Replay the arrival for three.
    if (session.__fisterVrReplayed !== session && sources.length && typeof session.dispatchEvent === 'function' && state.controllers.some((c) => !c.source)) {
      session.__fisterVrReplayed = session;
      try {
        const event = new Event('inputsourceschange');
        event.added = [...session.inputSources];
        event.removed = [];
        session.dispatchEvent(event);
        log('Re-announced ' + sources.length + ' controller(s) to the game renderer.');
      } catch (error) { record('error', ['Controller replay failed:', error]); }
    }
    for (const entry of state.controllers) {
      if (entry.source) continue;
      const src = sources[entry.index];
      if (!src) continue;
      entry.source = src;
      entry.handedness = src.handedness || 'none';
      if (entry.box && entry.box.material.color) entry.box.material.color.setHex(config.boxColors[entry.handedness] ?? config.boxColors.none);
      log('Controller ' + entry.index + ' adopted (' + entry.handedness + ').');
    }
  }

  function pollInput(frame) {
    if (frame && frame.session) adoptControllers(frame.session);
    if (state.pendingRecenter) recenter(frame);
    const session = frame && frame.session;
    if (!session) return;
    let move = null, turn = null, scroll = 0;
    for (const source of session.inputSources) {
      const pad = source.gamepad;
      const hand = source.handedness;
      if (!pad || (hand !== 'left' && hand !== 'right')) continue;
      const names = { ...BUTTON_INDEX, ...(FACE[hand] || {}) };
      for (const [name, index] of Object.entries(names)) {
        const id = hand + '.' + name;
        const pressed = !!(pad.buttons[index] && pad.buttons[index].pressed);
        const was = state.buttonsDown.get(id) || false;
        if (pressed !== was) {
          state.buttonsDown.set(id, pressed);
          runAction(config.buttons[id], pressed, frame, hand);
        }
      }
      const sx = pad.axes.length >= 4 ? pad.axes[2] : pad.axes[0] || 0;
      const sy = pad.axes.length >= 4 ? pad.axes[3] : pad.axes[1] || 0;
      if (hand === config.moveStick) move = [sx, sy];
      if (hand === config.turnStick) turn = sx;
      if (hand === config.aimHand) scroll = sy;
    }
    // Point at the menu and push the right stick up/down to scroll.
    if (state.uiHit && Math.abs(scroll) > 0.3) uiScroll(scroll * 30);
    // Hold both grips for one second: open/close the debug console (it appears on the menu panel).
    const both = state.buttonsDown.get('left.squeeze') && state.buttonsDown.get('right.squeeze');
    const nowMs = performance.now();
    if (both) {
      if (!state.comboStart) state.comboStart = nowMs;
      else if (!state.comboFired && nowMs - state.comboStart > 1000) { state.comboFired = true; toggleInfoPanel(); }
    } else { state.comboStart = 0; state.comboFired = false; }
    if (move) {
      const t = config.moveThreshold;
      sendKey('KeyW', move[1] < -t);
      sendKey('KeyS', move[1] > t);
      sendKey('KeyA', move[0] < -t);
      sendKey('KeyD', move[0] > t);
    }
    // With hand aim the mouse belongs to the aim, so turning always rotates your view (Vivecraft-style).
    const viewTurn = config.aimMode === 'hand' || config.turnMode === 'rig';
    if (turn !== null && config.turnMode !== 'off' && viewTurn) {
      if (config.turnMode === 'smooth') {
        if (Math.abs(turn) > 0.15) state.rigTurn -= turn * 0.035;
      } else if (!state.turnLatched && Math.abs(turn) > 0.7) {
        state.turnLatched = true;
        state.rigTurn -= Math.sign(turn) * (Number(config.rigSnapDegrees) || 30) * Math.PI / 180;
      } else if (state.turnLatched && Math.abs(turn) < 0.3) {
        state.turnLatched = false;
      }
    } else if (turn !== null && config.turnMode !== 'off') {
      if (config.turnMode === 'smooth') {
        if (Math.abs(turn) > 0.15) sendMouseMove(Math.round(turn * config.smoothTurnPixelsPerFrame));
      } else if (!state.turnLatched && Math.abs(turn) > 0.7) {
        state.turnLatched = true;
        sendMouseMove(Math.sign(turn) * config.snapTurnPixels);
      } else if (state.turnLatched && Math.abs(turn) < 0.3) {
        state.turnLatched = false;
      }
    }
  }

  function releaseAllInput() {
    for (const code of [...state.keysDown]) sendKey(code, false);
    for (const button of [...mouseButtonsHeld]) sendMouseButton(button, false);
    if (state.uiPress) uiPress(false);
    state.buttonsDown.clear();
    state.turnLatched = false;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------------------------------------
  function onSessionStart(renderer) {
    attachSelectEvents(renderer.xr.getSession());
    state.renderer = renderer;
    const main = pickMain();
    state.gameCamera = main.camera || state.gameCamera;
    state.presenting = true;
    state.pendingRecenter = true;
    state.handBaseYaw = null;
    state.rigTurn = 0;
    state.aim.lastYaw = null;
    state.aim.stuck = 0;
    detectFirstPerson(true);
    spoofFocus(true);
    state.pointerLockReleased = false;
    spoofPointerLock(true);
    setTimeout(() => reassertFocus('session start'), 100);

    state.redirectRaf = true;
    // Hook the XR frame loop directly. renderer.setAnimationLoop would also restart three's window-rAF loop, which our
    // rAF redirect feeds back into the XR frame: infinite recursion (stack overflow, black frames).
    renderer.xr.setAnimationLoop((time, frame) => xrFrame(renderer, time, frame));
    setStatus('In VR' + (state.fp ? ' · first-person: ' + state.fp.label : ' · first-person: head anchor'));
    log('XR session started. Main camera:', state.gameCamera ? 'found' : 'pending first render');
  }

  function onSessionEnd(renderer) {
    releaseAllInput();
    state.presenting = false;
    state.redirectRaf = false;
    spoofFocus(false);
    teardownMenu();
    spoofPointerLock(false);
    unlockFirstPerson();
    restoreHead();
    restoreShake();
    restoreOutlines();
    restoreBody();
    restoreItems();
    restoreArmScale();
    if (state.rig && state.rig.parent) state.rig.parent.remove(state.rig);
    renderer.xr.setAnimationLoop(null);
    renderer.__fisterVrOriginalLoop.call(renderer, state.gameAnimationLoop.get(renderer) || null);
    const queue = state.rafQueue;
    state.rafQueue = new Map();
    for (const callback of queue.values()) nativeRaf(callback);
    setStatus('');
    log('XR session ended.');
  }

  // ---------------------------------------------------------------------------------------------------------
  // VR button (same flow as three/examples/jsm/webxr/VRButton.js, MIT; the official file is not part of the
  // game's bundle and loading it from a CDN would be blocked by the site's CSP)
  // ---------------------------------------------------------------------------------------------------------
  function whenBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  function styleButton(el) {
    el.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483646;padding:10px 14px;border:1px solid #fff;'
      + 'border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font:bold 13px/1 sans-serif;text-align:center;'
      + 'opacity:.6;outline:none;cursor:pointer;';
    el.onmouseenter = () => { el.style.opacity = '1'; };
    el.onmouseleave = () => { el.style.opacity = '.6'; };
  }

  function ensureVrButton() {
    if (state.buttonEl) return;
    const button = document.createElement('button');
    button.id = 'fister-vr-button';
    styleButton(button);
    state.buttonEl = button;
    const bar = document.createElement('div');
    bar.id = 'fister-vr-bar';
    bar.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483646;display:flex;gap:8px;align-items:center;';
    button.style.position = 'static';
    bar.appendChild(button);
    document.body.appendChild(bar);

    const status = document.createElement('div');
    status.id = 'fister-vr-status';
    status.style.cssText = 'position:fixed;bottom:58px;left:16px;z-index:2147483646;color:#fff;font:12px sans-serif;'
      + 'text-shadow:0 0 3px #000;pointer-events:none;';
    state.statusEl = status;
    document.body.appendChild(status);

    // "VR info" panel: live debug console + status, for browsers without DevTools (Quest). Also opens in the
    // headset by holding both grips for a second, and shows on the UI panel there.
    const info = document.createElement('button');
    info.id = 'fister-vr-info-button';
    info.textContent = 'VR INFO';
    styleButton(info);
    info.style.position = 'static';
    info.onclick = () => { toggleInfoPanel(); info.blur(); };
    bar.appendChild(info);
    const copy = document.createElement('button');
    copy.id = 'fister-vr-copy-button';
    copy.textContent = 'COPY LOG';
    styleButton(copy);
    copy.style.position = 'static';
    copy.onclick = () => { copyReport(copy, document.getElementById('fister-vr-info')); copy.blur(); };
    bar.appendChild(copy);

    const unsupported = (text) => {
      button.textContent = text;
      button.style.cursor = 'auto';
      button.onclick = null;
    };

    if (!('xr' in navigator) || !navigator.xr) {
      unsupported(window.isSecureContext === false ? 'WEBXR NEEDS HTTPS' : 'WEBXR NOT AVAILABLE');
      return;
    }

    let currentSession = null;
    // No 'layers': the session may start in menu-only mode and later move to the game renderer, which is simplest with
    // a plain XRWebGLLayer on both sides.
    const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor'] };

    async function onSessionStarted(session) {
      let { renderer, camera } = pickMain();
      if (renderer && !isMainRenderer(renderer)) renderer = [...state.renderers].find(isMainRenderer) || null;
      // Only go straight to the game view if the game is drawing a scene we can put the menu panel into.
      if (renderer) {
        const entry = camera && state.cameraStats.get(camera);
        const scene = entry ? entry.scene : null;
        if (!scene || !sceneHasBuildingBlocks(scene)) { log('Game scene not ready for VR objects yet; starting menu-only VR.'); renderer = null; }
      }
      session.addEventListener('end', onSessionEnded);
      button.textContent = 'EXIT VR';
      currentSession = session;
      if (!renderer) {
        try { await startStandalone(session); }
        catch (error) { record('error', ['Menu-only VR failed:', error]); session.end(); setStatus('VR failed: ' + (error && error.message || error)); }
        return;
      }
      state.renderer = renderer;
      try { renderer.xr.setFramebufferScaleFactor(Math.min(1.5, Math.max(0.4, Number(config.framebufferScale) || 1))); } catch {}
      await renderer.xr.setSession(session);
    }
    function onSessionEnded() {
      if (!currentSession) return;
      currentSession.removeEventListener('end', onSessionEnded);
      button.textContent = 'ENTER VR';
      currentSession = null;
    }

    navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
      if (!supported) { unsupported('VR NOT SUPPORTED'); return; }
      button.textContent = 'ENTER VR';
      button.onclick = () => {
        if (currentSession === null) {
          navigator.xr.requestSession('immersive-vr', sessionInit).then(onSessionStarted)
            .catch((error) => { warn('requestSession failed', error); setStatus('VR failed: ' + (error && error.message || error)); });
        } else {
          currentSession.end();
        }
      };
      if (navigator.xr.offerSession !== undefined) {
        navigator.xr.offerSession('immersive-vr', sessionInit).then(onSessionStarted).catch(() => {});
      }
    }).catch((error) => { unsupported('VR NOT ALLOWED'); warn('isSessionSupported failed', error); });
  }

  // --- debug console --------------------------------------------------------------------------------------------
  const LEVEL_COLORS = { info: '#9fd3ff', warn: '#ffd166', error: '#ff6b6b', 'game-warn': '#e6c47a', 'game-error': '#ff9a9a', 'page-error': '#ff6b6b', eval: '#b8f5a8', input: '#cccccc' };
  function liveSummary() {
    const player = (() => { try { return localPlayer(); } catch { return null; } })();
    const errors = Object.entries(featureErrors).map(([k, v]) => k + '×' + v).join(', ') || 'none';
    const fps = state.frameMs ? Math.round(1000 / state.frameMs) : 0;
    return [
      'VR: ' + (state.standalone && !state.standalone.handedOff ? 'in headset (menu-only, waiting for the game to render)' : state.presenting ? 'in headset' : 'not in VR') + (fps ? ' · ' + fps + ' fps' : ''),
      'View: ' + (state.gameplay ? (state.ragdoll ? 'ragdoll (third person)' : 'gameplay') : 'menu/theater') + ' (' + (state.gameplayReason || '-') + ')',
      'Eyes: ' + (state.gameplay ? (anchorObject().object === state.gameCamera ? 'game camera' : 'avatar head') : 'game camera')
        + ' · first-person flag: ' + (state.fp ? state.fp.label : 'none'),
      'Players: ' + (state.gameScene ? 'game scene' : state.lateScene ? 'map probe' : 'not found') + (state.reprobe ? ' (re-searching)' : '')
        + ' · local: ' + (player ? 'yes' : 'no'),
      'Aim: ' + config.aimMode + ' · learned ' + (state.aim.ratioX * 1000).toFixed(2) + ' mrad/px' + (state.aim.stuck > 30 ? ' · NOT RESPONDING' : ''),
      'Menu panel: ' + (state.menu ? 'shown' + (state.menu.hudMap ? ' as HUD (' + state.menu.hudWidgets + ' widgets)' : '') + ' · ' + state.menu.draws + ' draws · ' + state.menu.nodes + ' elements · ' + state.menu.drawMs.toFixed(1) + ' ms/draw' : (state.menuProblem || 'not built yet'))
        + ' · laser: ' + (state.uiHit ? 'on ' + state.uiHit.element.tagName.toLowerCase() : 'off') + ' · mouse captured: ' + (document.pointerLockElement ? 'yes' : 'no'),
      'Input: keys to ' + describeEl(keyTarget()) + ' · focus ' + describeEl(document.activeElement) + ' · page focused ' + (nativeHasFocus.call(document) ? 'yes' : 'no')
        + ' · game locked ' + describeEl(state.lockTarget) + ' (' + (state.lockRequests || 0) + 'x) · keys held ' + ([...state.keysDown].join(' ') || 'none'),
      'Frame: ' + (state.frameMs ? state.frameMs.toFixed(1) + ' ms' : '-') + ' · mod work ' + (state.modMs || 0).toFixed(1) + ' ms · repeated frames ' + (state.repeats || 0) + ' · blocked late clears ' + (state.blockedClears || 0) + ' · position glitches ' + (state.glitches || 0),
      'Feature errors: ' + errors,
    ];
  }

  function toggleInfoPanel(forceTab) {
    const old = document.getElementById('fister-vr-info');
    if (old && !forceTab) { old.remove(); logListener = null; return; }
    if (old) old.remove();
    const panel = document.createElement('div');
    panel.id = 'fister-vr-info';
    panel.style.cssText = 'position:fixed;left:16px;right:16px;top:12px;max-height:calc(100vh - 80px);overflow:auto;max-width:860px;z-index:2147483647;'
      + 'background:rgba(8,12,16,.94);color:#e8eef2;border:1px solid #6b7c8a;border-radius:8px;padding:10px;'
      + 'font:13px/1.35 ui-monospace,Consolas,monospace;display:flex;flex-direction:column;gap:8px;';
    const btn = (label, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:bold 13px sans-serif;padding:8px 12px;border-radius:5px;border:1px solid #8aa;background:#1d2a33;color:#fff;cursor:pointer;';
      b.onclick = (e) => { e.stopPropagation(); onClick(b); b.blur(); };
      return b;
    };
    const tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;';
    const summary = document.createElement('div');
    summary.style.cssText = 'white-space:pre-wrap;color:#cfe8d0;border-bottom:1px solid #33444f;padding-bottom:6px;';
    const body = document.createElement('div');
    body.style.cssText = 'height:min(300px,40vh);overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;';
    let tab = forceTab || 'console';

    const renderConsole = () => {
      body.textContent = '';
      // Newest at the bottom; only what fits, so the headset copy of this panel stays inside its box.
      const shown = logBuffer.slice(-18);
      for (const entry of shown) {
        const line = document.createElement('div');
        line.style.cssText = 'white-space:pre-wrap;word-break:break-word;max-height:2.7em;overflow:hidden;color:' + (LEVEL_COLORS[entry.level] || '#fff');
        const secs = (entry.t / 1000).toFixed(1).padStart(7, ' ');
        line.textContent = secs + ' ' + entry.level.padEnd(10, ' ') + (entry.count > 1 ? '(' + entry.count + 'x) ' : '') + entry.msg.split('\n')[0].slice(0, 220);
        body.appendChild(line);
      }
      if (!shown.length) body.textContent = 'No messages yet.';
    };
    const renderStatus = () => {
      body.textContent = '';
      const pre = document.createElement('div');
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;overflow:hidden;';
      const d = root.fisterVR.dump();
      pre.textContent = Object.entries(d).filter(([k]) => !['gameScene', 'localPlayer', 'storage', 'userAgent'].includes(k))
        .map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join('\n');
      body.appendChild(pre);
    };
    const runRow = document.createElement('div');
    runRow.style.cssText = 'display:flex;gap:6px;';
    const input = document.createElement('input');
    input.placeholder = 'JavaScript, e.g. fisterVR.config.aimGain = 0.4';
    input.style.cssText = 'flex:1;min-width:0;font:13px ui-monospace,monospace;padding:8px;background:#0d1419;color:#fff;border:1px solid #556;border-radius:5px;';
    const run = () => {
      const code = input.value.trim();
      if (!code) return;
      record('input', ['> ' + code]);
      try {
        const result = (0, eval)(code);
        record('eval', [result === undefined ? 'undefined' : result]);
      } catch (error) {
        record('error', [/unsafe-eval|Content Security/i.test(String(error)) ? 'The site blocks running typed code (CSP). Use the buttons instead.' : error]);
      }
      input.value = '';
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') run(); });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    runRow.append(input, btn('Run', run), btn('Copy all', (b) => copyReport(b, panel)));

    const refresh = () => {
      summary.textContent = liveSummary().join('\n');
      if (tab === 'console') renderConsole(); else renderStatus();
    };
    const setTab = (name) => { tab = name; refresh(); };
    const copyAll = (b) => copyReport(b, panel);
    tabsRow.append(
      btn('Console', () => setTab('console')),
      btn('Status', () => setTab('status')),
      btn('Copy all', copyAll),
      btn('Clear', () => { logBuffer.length = 0; refresh(); }),
      btn('Recenter', () => { state.pendingRecenter = true; }),
      btn('Wake input', () => reassertFocus('console')),
      btn('Close', () => toggleInfoPanel()),
    );
    panel.append(tabsRow, summary, body, runRow);
    document.body.appendChild(panel);
    let pending = false;
    logListener = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; if (panel.isConnected) refresh(); }, 250); } };
    const tick = () => { if (!panel.isConnected) return; refresh(); setTimeout(tick, 1000); };
    tick();
  }

  function reportText() {
    let dump = '';
    try { dump = JSON.stringify(root.fisterVR.dump(), null, 1); } catch (error) { dump = 'dump failed: ' + error; }
    return 'Fister VR ' + VERSION + ' report\n' + liveSummary().join('\n') + '\n\nLOG\n'
      + logBuffer.map((e) => (e.t / 1000).toFixed(1) + ' ' + e.level + (e.count > 1 ? ' (' + e.count + 'x)' : '') + ' ' + e.msg).join('\n')
      + '\n\nDETAILS\n' + dump;
  }
  // Copy the whole report. If the browser refuses the clipboard, show it in a box, already selected, to copy by hand.
  function copyReport(button, host) {
    const text = reportText();
    const label = button ? button.textContent : '';
    const done = (ok) => { if (button) { button.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(() => { button.textContent = label; }, 1800); } };
    const showBox = () => {
      let box = document.getElementById('fister-vr-copybox');
      if (!box) {
        box = document.createElement('textarea');
        box.id = 'fister-vr-copybox';
        box.readOnly = true;
        box.style.cssText = 'width:100%;height:160px;box-sizing:border-box;font:12px ui-monospace,monospace;background:#0d1419;color:#fff;border:1px solid #6b7c8a;border-radius:5px;';
        (host || document.body).appendChild(box);
      }
      box.value = text;
      box.focus(); box.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      done(ok);
      if (!ok) log('Copy blocked by the browser: the report is in the box below the console, selected. Long-press it and choose Copy.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), showBox);
    else showBox();
  }

  function setStatus(text) {
    if (state.statusEl && config.showStatus) state.statusEl.textContent = text ? 'Fister VR: ' + text : '';
  }

  // ---------------------------------------------------------------------------------------------------------
  // Console API
  // ---------------------------------------------------------------------------------------------------------
  function describe(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'Array(' + value.length + ')';
    if (value instanceof Map) return 'Map(' + value.size + ')';
    if (typeof value === 'object') return (value.type || (value.constructor && value.constructor.name) || 'object');
    if (typeof value === 'function') return 'function';
    return typeof value + ' = ' + JSON.stringify(value);
  }

  root.fisterVR = Object.freeze({
    console: () => toggleInfoPanel(),
    config,
    state,
    saveConfig,
    recenter: () => { state.pendingRecenter = true; },
    setFirstPersonPath(path, value = true) {
      config.firstPerson = { path, value };
      saveConfig();
      state.fp = null;
      return detectFirstPerson(true);
    },
    resetConfig() { try { localStorage.removeItem(CONFIG_KEY); } catch {} location.reload(); },
    // Paste the output of this to get exact game hook names wired in.
    dump() {
      const gs = gameScene();
      const out = { version: VERSION, userAgent: navigator.userAgent, attach: state.lateScene && state.lateScene !== state.gameScene ? 'late' : 'early',
        gameSceneCaptured: !!state.gameScene, playersFound: !!(gs && gs.players), localPlayerFound: !!localPlayer(),
        renderers: state.renderers.size, camerasSeen: state.cameraStats.size,
        menuPanel: state.menu ? { draws: state.menu.draws, elements: state.menu.nodes, msPerDraw: +state.menu.drawMs.toFixed(1) } : (state.menuProblem || 'not built yet'),
        inGameplay: !!state.gameplay,
        outlinesHidden: state.outlines ? [...state.outlines.keys()].slice(0, 12).map((n) => {
          const m = Array.isArray(n.material) ? n.material[0] : n.material;
          return (n.name || '(unnamed)') + ' ' + (m && m.type) + ' side=' + (m && m.side) + ' blend=' + (m && m.blending) + (m && m.color ? ' #' + m.color.getHexString() : '');
        }) : [],
        firstPerson: state.fp ? state.fp.label : null, gameScene: {}, localPlayer: {}, storage: {} };
      if (gs) for (const key of Object.keys(gs)) { try { out.gameScene[key] = describe(gs[key]); } catch {} }
      const player = localPlayer();
      if (player) for (const key of Object.keys(player)) { try { out.localPlayer[key] = describe(player[key]); } catch {} }
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (/fister|camera|view|person|pov|control|bind/i.test(key)) out.storage[key] = String(localStorage.getItem(key)).slice(0, 200);
        }
      } catch {}
      const text = JSON.stringify(out, null, 1);
      console.log(text);
      return out;
    },
    _internals: { captureRenderer, captureGameScene, pickMain, harvestClasses, ensureRig, updateRig, detectFirstPerson,
      lockFirstPerson, unlockFirstPerson, boxGeometry, overrideArms, localPlayer, xrFrame, pollInput, gameScene, steerAim, armInfo, reassertFocus, spoofFocus, hideOutlines, isGameplayCamera, toggleInfoPanel, checkPlayersFresh, setupMenu, updateMenu, paintDom, startStandalone, handOffStandalone, isMainRenderer, sceneHasBuildingBlocks, runDueTimers, uiPress, uiScroll, spoofPointerLock, logBuffer, liveSummary, hideBody, restoreBody, bodyMeshes, isRagdolled },
  });

  whenBody(ensureVrButton); // available right away, even before the game draws anything 3D
  log('v' + VERSION + ' loaded.');
})();
