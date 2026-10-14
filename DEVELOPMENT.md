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

## v0.9.0: FisterQoL option and VR clips

- **Setup page option "What the bookmark loads":** Fister VR only, or Fister VR + FisterQoL.
  - `qol/FisterQoL.user.template.js` is the FisterQoL Tampermonkey userscript with `const VR_SOURCE=__FISTER_VR_SOURCE__;`
    where `tools/build.cjs` puts this layer. Change QoL there; never hand-edit `dist/`.
  - `qolForBookmarklet()` in the build reformats it for a bookmarklet: no metadata block, `window` = `globalThis`
    (no `unsafeWindow`), plain `<script>` elements instead of `GM_addElement` (VR layer and the patched game module),
    no Steam staging path, bookmark wording in the "started too late" message. The build fails if any
    Tampermonkey-only code is left or a swap anchor stops matching.
  - The result is gzipped and base64'd (~950 KB -> ~335 KB bookmarklet). `site/qol-loader.js` builds the loader:
    checks fister.fun home page / already running / game already loading (`__fisterRuntimeBootPromise`,
    `__fisterRuntimeLoaded`, `#runtime-ui-root[data-loaded=1]`), turns on QoL VR mode, writes the page's VR settings
    to `fister-vr-config` (every tap, or only when none are saved), then unpacks with `DecompressionStream` and runs
    it as a `<script>`.
  - Timing: QoL hooks the game's lazy `__fisterRuntimeBootPromise`, so the bookmark must run before the game starts
    loading its runtime. Unverified on the real site whether that happens on first tap/click or by itself.
- **Clip view** (`renderClipView`, `clipFrame`): in VR the canvas doesn't update. While FisterQoL's clip hook asks for
  frames (`fisterVR.clipFrame()` from `fisterClipOverlays.recordingCanvas`, i.e. while the game records), a
  first-person view from `state.view`'s world pose (lerp/slerp smoothing) is rendered with XR off into the bottom-left
  of the canvas and copied to a 2D canvas in the same task. `state.clipRendering` exempts that clear from the
  black-flash clear blocker. Config: `clipView`, `clipHeight`, `clipFov`, `clipSmoothing`. Nothing renders when not
  recording.
- **`'clip'` button action** (default on right stick click): asks `__fisterQolVrBridge.clipInput()` (FisterQoL looks up
  the game's clip binding in its input bindings) and presses it, with a haptic pulse. Without FisterQoL it only
  shows a status message.
- API: `fisterVR.toggle()`, `presenting`, `buttonText`, `copyLog()`, `clipFrame()`, `clipStats()`,
  `applyButtonVisibility()`; config `showButton`.
- Tests: `test/run20.cjs` (clip view + clip button), `test/run23.cjs` (setup page QoL option end to end on a
  stand-in home page, too-late and already-running checks).

## v0.8.3

- **The in-match panel was never visible on the Quest** (pause menu included). Menu-only VR, which draws with its own WebGL, always worked; the three.js-built panel in the game's scene didn't. The cause is unknown (texture class, the game's render passes, ...). The gray window in earlier videos was the Quest browser's 2D page, not the panel.
- **`drawOverlay(renderer)`**, called after the main headset render:
  - It draws the panel texture, the menu laser and dot, and the aim line with `overlayProgram(gl)` on the game's GL context, into `session.renderState.baseLayer.framebuffer`. Positions are in the XR reference space, which is the rig's local space times `rig.scale`.
  - Afterwards it calls `renderer.resetState()`.
  - While it works (`state.overlayOk`), the three.js panel, laser, dot and aim-laser meshes are hidden.
  - If it throws, the mod falls back to the three.js meshes. `config.overlayGl = false` turns it off.
- The status line shows "drawn directly (N frames)" or "three.js mesh".

## v0.8.2

- **In-match HUD layout.** Mapping the whole page onto one panel put Fister's HUD (health, style and souls at the top left, scoreboard at the top right) about 30° out, where the Quest's lenses blur. It looked like there was no HUD.
  - In HUD mode, `paintDom` now paints into a scratch canvas (`menu.full`) and collects "widgets": the first non-container box or text on each branch.
  - Boxes that are more than half the screen, more than 45% wide or more than 60% tall count as layout containers. Their backgrounds are skipped and the walk looks inside them.
  - Each widget is copied into the panel pulled toward the centre (`hud.pull`) and enlarged (`hud.grow`).
  - `menu.hudMap` maps laser hits back to the real page position.
- The status line shows "as HUD (N widgets)". If N is 0 on the real game, the widget detection is the problem.

## v0.8.1

- **Aim origin is the game camera** (`aimOrigin: 'camera'`). Fister's aim follows its third-person camera's crosshair, about 5.5 m behind the head; the green aim line runs from the body to where that crosshair hits.
  - The hand's target comes from a ground-plane test plus `raycastWorld`. That function ray-tests world-space boxes around scene meshes (refreshed every 1.5 s) and a rough box around each other player.
- **HUD mode** (`hudMode()`: in gameplay, not ragdolled, no menu open):
  - The painter skips backgrounds of boxes covering more than half the screen (the gray slab).
  - The panel follows the head closely at eye level (`config.hud`).
  - The laser only counts real controls as hits. Before, pointing ahead "hit" the gray container, which paused the hand aim: a big part of the "aim is off" report.

## v0.8.0

- **Real item names**, from the user's 0.7.9 debug report (`dump()` lists the local player's fields):
  - `javelinMesh`, `bananarangMesh`, `singularityGrenadeMesh`, `stickyBombMesh`, `spellbookMesh`, `dodgeballMesh`
  - `pistonMesh`, `scytheMesh`, `physicsCannonMesh`, `bearTrapHeldMesh`, `sniperRifleMesh`, `harpoonVisual`, `laserbeamOrb`
  - Items under an arm, or under another item, are skipped (they already follow). Items are also kept visible by `hideBody`.
- **Hand aim converges.** The game's aim starts at the body, so the mod steers it through the point where the hand's ray meets the ground, or `aimDistance` (10 m) out.
  - `aimLaser` draws a thin red line from the aim hand.
  - Setup page "Aim with" has three options: right hand, left hand (`aimHand: 'left'`), or mouse.
- **Skinned-mesh render crash** (`applyBoneTransform` / `getX` in `computeBoundingSphere`): on that error, culling is turned off for the offending skinned meshes and the frame is retried.
- **Text-box release** no longer touches `<select>`s, or anything within 8 s of using the menu panel. It used to fight the sandbox cheat menu.
- **The game also has its own first-person mode**, which the mod doesn't use yet:
  - fields `firstPerson*`, `firstPersonHeldMesh*`, `scytheHandLocalPosition`, `spellbookHandLocalPosition`, `scytheGripOffset`
  - account setting `fister-camera-perspective`
  - These may give a better grip for items later.

## v0.7.8 – v0.7.9

- Hands are always mirrored side to side so the claws face outward (the game's model was showing them inside). There's no option for this.
- Held items: `holdItems()` follows the player fields FisterQoL also uses (`scytheMesh`, `pistonMesh`, `carMesh`, `tankMesh`, `laserbeamOrb`, `firstPersonWeaponRoot`).
  - Each item keeps its offset from the arm *as the game saw it* that frame, applied to your VR arm. It inherits the arm's size and mirroring.
  - `armSizeSeen` corrects the item size when the game doesn't reset the arm's scale.
  - Items more than 0.6 m from the game's hand, and the first-person weapon, are put directly at the hand, facing where the controller points.
  - Objects outside the scene (e.g. on the game camera) are moved into the scene while in VR and put back afterwards.
- `gamePose()` / `notePoseWritten()`: if the game didn't set an object's pose again since we wrote it, its last pose is restored before we work from it. This is checked per part (position, rotation, scale).
- Item names and how the game attaches items are unverified on the real game.

## Status / open items (as of v0.7.7)

- v0.7.7 fixes, found from a Quest video:
  - **Hands and aim dead after starting from the main menu.** three.js only tracks controllers it saw arrive through `inputsourceschange`, and after the menu-only hand-off they had already arrived. `adoptControllers` now replays that event once per session.
  - **Pointer lock.** The spoofed lock reports the element the game actually asked to lock (`state.lockTarget`), not always the canvas. It is also active in menu-only VR.
  - **Focused text boxes.** A text box left focused after a menu click (name, lobby code, chat) would swallow W/A/S/D. It is released on entering gameplay.
  - **Clicks.** The trigger now ends with a `click` event.
- Debug console:
  - It is anchored to the top of the page; on the Quest its buttons were off-screen.
  - There are Copy all buttons at the top and bottom, plus COPY LOG next to VR INFO.
  - If the clipboard is blocked, the report appears in a selected text box.
  - A new "Input:" line shows where keys go, the focused element, the lock target and the keys held.
- HUD repaint in a match is rarer (the Quest measured about 67 ms per paint).
- The Quest ran at about 13 fps (77 ms frames, only 8 ms of it the mod's own work). If that persists, try a lower framebufferScale.
- Not yet verified on a real Quest. The next report should include COPY LOG output.
