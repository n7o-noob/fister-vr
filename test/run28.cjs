// VR menu width/height: defaults 1.4 / 1.8; pointing at a menu, right stick right = wider (no turning); right grip +
// stick up = taller (no scrolling, no right click to the game); both saved.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, 'site');
const server = http.createServer((req, res) => { const f = path.join(root, req.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(d); }); }).listen(8800, async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript({ path: path.join(__dirname, 'xr-mock.js') });
  await page.goto('http://127.0.0.1:8800/game3.html?emptymenu&lock');
  await page.waitForFunction(() => window.game && window.game.ui);
  await page.evaluate(() => document.getElementById('pause').classList.add('visible'));
  const bm = decodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'dist', 'fister-vr.bookmarklet.txt'), 'utf8').slice(11));
  await page.evaluate((c) => (0, eval)(c), bm);
  await page.waitForFunction(() => fisterVR.state.renderers.size > 0 && document.getElementById('fister-vr-button').textContent === 'ENTER VR');
  await page.evaluate(() => document.getElementById('fister-vr-button').click());
  await page.waitForTimeout(600);
  const res = {};
  res.onEmptyMenu = await page.evaluate(() => ({ menuOnly: !!fisterVR.state.standalone && !fisterVR.state.standalone.handedOff, panelDraws: fisterVR.state.standalone && fisterVR.state.standalone.menu.draws }));
  const aim = () => page.evaluate(() => {
    const b = document.getElementById('openSettings').getBoundingClientRect(), w = 1.6 * fisterVR.config.uiWidth, h = 1.6 * (innerHeight / innerWidth) * fisterVR.config.uiHeight;
    const x = ((b.left + b.width / 2) / innerWidth - 0.5) * w, y = (0.5 - (b.top + b.height / 2) / innerHeight) * h;
    const target = [x, 1.6 - 0.15 + y, -1.4], o = [0.2, 1.2, -0.3];
    __xrMock.setRay('right', o, target.map((v, i) => v - o[i]));
  });
  await aim(); await page.waitForTimeout(200);
  res.before = await page.evaluate(() => ({ uiWidth: fisterVR.config.uiWidth, uiHeight: fisterVR.config.uiHeight, laser: fisterVR.state.uiHit && fisterVR.state.uiHit.element.id }));
  await page.evaluate(() => __xrMock.setAxes('right', [0, 0, 1, 0]));
  await page.waitForTimeout(600);
  await page.evaluate(() => __xrMock.setAxes('right', [0, 0, 0, 0]));
  await page.waitForTimeout(300);
  res.afterWidth = await page.evaluate(() => ({ uiWidth: fisterVR.config.uiWidth, uiHeight: fisterVR.config.uiHeight, rigTurn: fisterVR.state.rigTurn }));
  // Height: re-aim at the (now wider) panel, hold the right grip, push the stick up.
  await aim(); await page.waitForTimeout(200);
  await page.evaluate(() => { window.__rightClicks = 0; document.addEventListener('mousedown', (e) => { if (e.button === 2) window.__rightClicks++; }, true); __xrMock.press('right', 1, true); });
  await page.waitForTimeout(100);
  await page.evaluate(() => __xrMock.setAxes('right', [0, 0, 0, -1]));
  await page.waitForTimeout(600);
  await page.evaluate(() => { __xrMock.setAxes('right', [0, 0, 0, 0]); __xrMock.press('right', 1, false); });
  await page.waitForTimeout(700);
  res.afterHeight = await page.evaluate(() => ({ uiWidth: fisterVR.config.uiWidth, uiHeight: fisterVR.config.uiHeight, rightClicksToGame: window.__rightClicks,
    saved: (({ uiWidth, uiHeight }) => ({ uiWidth, uiHeight }))(JSON.parse(localStorage.getItem('fister-vr-config') || '{}')),
    panelScale: fisterVR.state.standalone ? null : [fisterVR.state.menu.panel.scale.x, fisterVR.state.menu.panel.scale.y].map(n => +n.toFixed(2)) }));
  console.log(JSON.stringify(res, null, 1)); console.log('errors', errors);
  await browser.close(); server.close();
});
