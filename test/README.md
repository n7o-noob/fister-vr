# Tests

Stand-in "games" built on three.js that mimic Fister's structure (player map
with head/arms, Win95-style HUD, pause menu, pointer-lock mouse look,
ragdolls, player-list rebuilds), plus Playwright scripts that drive the VR
layer through simulated XR frames.

They are for development only. To run them:

1. `npm i playwright three`, then copy `node_modules/three/build/three.module.js`
   and `three.core.js` into `test/site/`.
2. `node tools/build.cjs` (the tests load `dist/fister-vr.bookmarklet.txt`).
3. `node test/run12.cjs` (menus, aim, layers), `node test/run11.cjs` (black-flash
   fixes), `node test/run8.cjs` (walking / player rebuild), and so on.

- `node test/run13.cjs`: menu-only VR before the game renders, then hand-off to the game (uses `xr-mock.js`, a fake WebXR headset).
- `node test/run14.cjs`: normal VR session through three.js's real XR code, including hand aim.
- `node test/run15.cjs`: main menu with no 3D objects (menu-only VR), clicks through WebXR select events, timers, then the panel and controller boxes appearing in the match.
- `node test/run16.cjs`: enter VR from the main menu, game captures the mouse on `<body>`, a text box left focused: movement and hand aim must still reach the game after the hand-off; console Copy all.
- `node test/run17.cjs` (and `ANIMALL=1 node test/run17.cjs`): power-up items follow the VR hand and scale with it, both when the game re-poses the arm every frame and when it doesn't; a first-person weapon on the game camera is moved into the scene at your hand.
- `node test/run18.cjs`: hand aim converges on the spot the hand points at (floor hit or 10 m out), the aim line sits on the hand, and left-hand aim works.
- `node test/run19.cjs`: third-person camera (~8 m behind, like Fister's): its crosshair ray passes through what the hand points at (a wall, the ground); the in-match HUD paints see-through, without full-screen backgrounds.
- `node test/run20.cjs`: clip view while a recorder takes frames in VR (first-person headset view at clip size, saved to `test/clip-frame.png`), nothing rendered when not recording, right stick click sends the clip key from a stand-in FisterQoL bridge.
- `node test/run23.cjs`: setup page "Fister VR + FisterQoL" option: generates the bookmarklet, runs it on a stand-in fister.fun home page (FisterQoL hook installed, VR layer injected with the page's settings, Enter VR), plus the "already running" and "game already loading" messages.
- `node test/run24.cjs`: save-clip button feedback: an old saved `right.thumbstick: null` becomes the clip button, and the on-screen message for saving, clip recording off, no Save clip key, and FisterQoL not loaded.
- `node test/run25.cjs`: reload loops with the FisterQoL bookmarklet: a game that adds a query parameter, reloads once, reloads every time (loader gives up after 3 with a banner and keeps the game running), goes to another page, or reloads on a service-worker change.
- `node test/run26.cjs`: a fister.fun-like Content-Security-Policy that blocks inline scripts, as an HTTP header and as a `<meta>` tag: FisterQoL must start in the frame (frame hosted on a policy-free same-origin file) and VR must work.
- `node test/run27.cjs`: like run19, but the fake headset offers WebXR Layers (`window.__xrMockLayers = true`), as the Quest Browser does: three.js draws into a projection layer and the direct-drawn HUD must land in it (`__xrMock.layerImage()` reads the layer back as a PNG).
- `node test/run28.cjs`: virtual 1920x1080 screen. In VR, fixed elements anchor to a 1920x1080 box, `vw`/`vh` rules become 1080p pixels (`#vwbox` in game3), width/height media rules are decided for 1920x1080, scripts see `innerWidth/innerHeight` 1920x1080, and the panel canvas is 16:9. Leaving VR restores all of it. Writes the panel image to `$SHOT`.
