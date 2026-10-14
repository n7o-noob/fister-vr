# Development notes (handoff)

Context for anyone (human or AI) continuing work on Fister VR. Current version: see `@version` in `src/fister-vr.js`.

## Target and constraints

- **Main target:** standalone Meta Quest 2, Quest Browser, run as a **bookmarklet** on fister.fun. No PC, no SteamVR (the owner's SteamVR doesn't connect; Virtual Desktop runs but can't enter VR mode).
- Fister is a three.js game by BOOTLOOP Studio. The browser build loads an obfuscated bundle live from fister.fun, so the mod never edits game code. It hooks three.js from outside.
- The Steam client is Electron. `steam/` holds only *diffs* of its main.js/preload.js. Never commit Fister's own launcher files. ASAR integrity means a repacked app.asar won't start without patching the exe.
- Fister's arm names are backwards. `swapArms` is always true and is not offered on the setup page.

## Repo layout

- `src/fister-vr.js`: the whole mod (single file, ~2600 lines). Don't put multi-line strings in it, because the bookmarklet build strips full-line `//` comments and joins lines.
- `site/page-template.html`: the setup page (Windows 95 style like fister.fun). `__LAYER_SOURCE__` and `__VERSION__` are filled in by the build. Settings are baked into the bookmarklet.
- `tools/build.cjs` builds:
  - `docs/index.html` (GitHub Pages: main branch, `/docs`)
  - `dist/fister-vr.user.js`
  - `dist/fisterVr.js`
  - `dist/fister-vr.bookmarklet.txt`
- `.github/workflows/build.yml`: rebuilds and commits docs/ and dist/ on pushes touching src/, site/ or tools/.
- `test/`: the testing setup.
  - Stand-in games: `test/site/game2.js` with modes norender, emptymenu, lock, layer1, rebuild, third, ragdoll, glitch, lateClear; and `game3.html`, a Win95 HUD with pause/settings, pointer-lock gating and a charge bar.
  - `xr-mock.js`: a fake WebXR headset that drives three.js's real XR path.
  - Playwright scripts `run3`–`run15.cjs`. See `test/README.md`.

## Release checklist

1. Bump `@version` in `src/fister-vr.js`.
2. Run `node tools/build.cjs` and the relevant `test/run*.cjs`.
3. Commit and push to main. CI rebuilds docs/dist, and Pages deploys in about a minute.
4. Tell the user to re-copy the bookmarklet from https://n7o-noob.github.io/fister-vr/.

## Architecture (src/fister-vr.js)

**Finding the renderer**
- Object.prototype setter traps on `isWebGLRenderer` and `renderer`.
- For late attach (bookmarklet), an `isArrayCamera` getter probe plus a temporary `Object3D.prototype.onBeforeRender` patch.
- Probing repeats until the *main* renderer is found (`isMainRenderer`: canvas covers more than 30% of the viewport).

**Finding the player list**
- A Map.prototype get/values/forEach probe finds the players Map (entries with head/leftArm/rightArm).
- It re-probes when the Map goes stale, because the game rebuilds it.

**Classes**
- Vector3, Quaternion, Euler, Object3D, Mesh, BufferAttribute, Matrix4 and Texture are harvested from live objects.
- Harvesting retries every 30 frames until Mesh and Attribute exist, then `addMissingBoxes()` runs.

**Rendering (`renderThroughVr` / `renderMain`)**
- The game's render call is wrapped. The scene is drawn through an XR rig:
  - the rig is an Object3D in the scene
  - the view is a camera clone
  - the controllers sit in the rig
- Modes:
  - Gameplay: sticky, with hysteresis of about 45 frames before leaving.
  - Theater: menus and killcam.
  - Ragdoll: follows the game's third-person camera until the player gets up.
- Other fixes in this path:
  - torso, legs and clothing hidden
  - own outline shell hidden
  - outline meshes hidden (they showed as black boxes)
  - late screen clears blocked
  - one-frame position glitches ignored
  - near clip at most 5 cm

**XR loop**
- Uses `renderer.xr.setAnimationLoop`, NOT `renderer.setAnimationLoop`.
- An `inXrFrame` re-entry guard is in place.
- Window rAF is redirected into XR frames.
- Past bug: `renderer.setAnimationLoop` restarted three's rAF loop, which recursed into the XR frame and caused a stack overflow and black frames.

**Input**
- `pollInput` and `adoptControllers` (picks up controllers that connected before the rig existed).
- Buttons map to synthetic key and mouse events: triggers = mouse0, grips = mouse2, right A = V (voice), right B = refocus, left X = Space, left Y = Escape, left stick = WASD, left stick click = recenter, right stick = snap turn.
- Focus is spoofed (hasFocus, visibilityState), and `reassertFocus` runs.

**Aim (Vivecraft-style)**
- The right controller's pointing direction becomes synthetic mousemove events, with a learned radians-per-pixel ratio.
- Pointer lock is spoofed (`Document.prototype.pointerLockElement`, requestPointerLock). Escape toggles `pointerLockReleased`.

**Menu panel**
- The game's DOM is painted to a canvas texture (`paintDom`).
  - Covers images (CORS re-fetch), CSS background images, inline SVG, borders and Win95 bevels, and clipping.
  - Redraw is adaptive: a MutationObserver dirty flag plus a 1 s heartbeat.
- The panel is body-locked in rig space.
- Laser hit testing uses `elementFromPoint`, then uiPress, uiDrag and uiScroll. Range and select inputs are handled.
- Clicks run inside WebXR selectstart/selectend so they count as user activation (`attachSelectEvents`).

**Menu-only VR**
- Used when the game hasn't drawn a scene with meshes yet, e.g. the main menu.
- The mod uses its own WebGL context and XRWebGLLayer: floor grid, laser and panel.
- `handOffStandalone` moves the session to the game renderer via `renderer.xr.setSession` once a usable scene renders.

**While presenting**
- requestFullscreen resolves.
- AudioContext.resume races a 400 ms timeout.
- setTimeout/setInterval are patched: due callbacks run every headset frame (`runDueTimers`), because the Quest throttles the hidden page.

**Debug**
- Debug console: hold both grips 1 s in VR, or press the VR INFO button on the page. **Copy all** gives a report.
- `fisterVR.config`, `fisterVR.saveConfig()` and `fisterVR.dump()` are available from the browser console.

## Config defaults (selected)

- Arms and body: armMode 'hand', swapArms true, handOffset {forward 0.15, inward 0.06, up 0}, hideBody true, eyeOffset.up 0.1.
- Menu: mode 'body', distance 1.4, width 1.6, drop 0.15, tiltDeg 8, followDeg 35, maxFps 12, resolution 1280.
- Aim and other: aimMode 'hand', armScale 1, boxScale 1, hideOutlines 'world', spoofPointerLock true.

## Status / open items (as of v0.7.6)

- v0.7.6 targets three problems:
  - the missing panel and boxes when entering VR from the main menu
  - lobby and join buttons not responding
  - the game not loading unless the page was visible
- None of these fixes is verified on a real Quest yet. They're only verified against the stand-in games.
- The user said "a few things are missing" from the VR menu, with no specifics yet. Ask for the debug console **Copy all** output and screenshots of the flat menu vs. the VR panel.
- Testing is mock-only. Real behavior must come from the user's reports.
