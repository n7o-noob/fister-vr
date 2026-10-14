// Setup page "Fister VR + FisterQoL" option: generate the bookmarklet, run it on a stand-in fister.fun home page.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const site = path.join(__dirname, 'site'), docs = path.join(__dirname, '..', 'docs');
const server = http.createServer((req, res) => { let u = req.url.split('?')[0]; let f;
  if (u === '/setup/') f = path.join(docs, 'index.html'); else { if (u === '/') u = '/game3.html'; f = path.join(site, u); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(d); }); }).listen(8794, async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--host-resolver-rules=MAP fister.fun 127.0.0.1:8794'] });
  const out = {};
  // 1. Setup page
  const setup = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const perr = []; setup.on('pageerror', e => perr.push(e.message));
  await setup.goto('http://127.0.0.1:8794/setup/');
  out.page = await setup.evaluate(() => ({ options: [...document.getElementById('bundle').options].map(o => o.textContent), vrSize: document.getElementById('size').textContent, qolInfoHidden: document.getElementById('qolInfo').hidden }));
  await setup.selectOption('#bundle', 'qol');
  await setup.selectOption('#armScale', '0.75');
  Object.assign(out.page, await setup.evaluate(() => ({ qolSize: document.getElementById('size').textContent, qolInfoShown: !document.getElementById('qolInfo').hidden, optionsShown: !document.getElementById('qolOptions').hidden, note: document.getElementById('bundleNote').textContent })));
  const bm = await setup.evaluate(() => document.getElementById('code').value);
  await setup.screenshot({ path: path.join(__dirname, 'setup-qol.png'), fullPage: false });
  out.page.errors = perr;
  const runOn = async (pre) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [], alerts = [], logs = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { alerts.push(d.message()); d.dismiss(); });
    page.on('console', m => { if (/QoL|Fister VR\]/.test(m.text())) logs.push(m.text().slice(0, 140)); });
    await page.addInitScript({ path: path.join(__dirname, 'xr-mock.js') });
    await page.goto('http://fister.fun/?lock'); // mapped to the local server
    await page.waitForFunction(() => window.game && window.game.frames > 20);
    if (pre) await page.evaluate(pre);
    await page.evaluate((c) => { location.href = c; }, bm).catch(() => {});
    await page.waitForTimeout(2500);
    return { page, errors, alerts, logs };
  };
  // 2. Normal run on the home page before the game loads its runtime
  const a = await runOn(null);
  out.run = await a.page.evaluate(() => ({ qolLoading: !!window.__fisterQolBrowserLoading, bootHook: typeof Object.getOwnPropertyDescriptor(window, '__fisterRuntimeBootPromise')?.get, vrInjected: !!window.__fisterQolVrInjected, fisterVR: window.fisterVR && fisterVR.version,
    armScale: window.fisterVR && fisterVR.config.armScale, framebufferScale: window.fisterVR && fisterVR.config.framebufferScale, clipButton: window.fisterVR && fisterVR.config.buttons['right.thumbstick'], qolPref: localStorage.getItem('fister-qol-vr-v1'), renderers: window.fisterVR ? fisterVR.state.renderers.size : 0 }));
  await a.page.evaluate(() => fisterVR.toggle()); await a.page.waitForTimeout(1500);
  out.run.inVr = await a.page.evaluate(() => ({ presenting: fisterVR.presenting, gameplay: fisterVR.state.gameplay }));
  out.run.alerts = a.alerts; out.run.errors = a.errors; out.run.logs = a.logs.slice(0, 6);
  // 3. Tapped again on the same page
  await a.page.evaluate((c) => { location.href = c; }, bm).catch(() => {}); await a.page.waitForTimeout(800);
  out.again = a.alerts.slice(); await a.page.close();
  // 4. Too late: the game already started loading
  const b = await runOn(() => { window.__fisterRuntimeLoaded = true; });
  out.tooLate = { alerts: b.alerts, qolLoading: await b.page.evaluate(() => !!window.__fisterQolBrowserLoading) }; await b.page.close();
  console.log(JSON.stringify(out, null, 1));
  await browser.close(); server.close();
});
