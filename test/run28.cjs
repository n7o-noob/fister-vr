// VR UI size: panels default to uiScale 1.4; pointing at a menu and pushing the right stick right makes them bigger
// (and doesn't turn you); the size is saved.
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
    const b = document.getElementById('openSettings').getBoundingClientRect(), s = fisterVR.config.uiScale, w = 1.6 * s, h = w * (innerHeight / innerWidth);
    const x = ((b.left + b.width / 2) / innerWidth - 0.5) * w, y = (0.5 - (b.top + b.height / 2) / innerHeight) * h;
    const target = [x, 1.6 - 0.15 + y, -1.4], o = [0.2, 1.2, -0.3];
    __xrMock.setRay('right', o, target.map((v, i) => v - o[i]));
  });
  await aim(); await page.waitForTimeout(200);
  res.before = await page.evaluate(() => ({ uiScale: fisterVR.config.uiScale, laser: fisterVR.state.uiHit && fisterVR.state.uiHit.element.id }));
  await page.evaluate(() => __xrMock.setAxes('right', [0, 0, 1, 0]));
  await page.waitForTimeout(600);
  await page.evaluate(() => __xrMock.setAxes('right', [0, 0, 0, 0]));
  await page.waitForTimeout(700);
  res.after = await page.evaluate(() => ({ uiScale: fisterVR.config.uiScale, rigTurn: fisterVR.state.rigTurn, saved: JSON.parse(localStorage.getItem('fister-vr-config') || '{}').uiScale }));
  console.log(JSON.stringify(res, null, 1)); console.log('errors', errors);
  await browser.close(); server.close();
});
