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
