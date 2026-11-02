// Screenshot the in-house basemap in the dashboard: light and dark, Bozeman at
// z14 (buildings + addresses), Billings z12, statewide z6, Gallatin z9 (water,
// roads, places). Prints what each view rendered per source layer.
//   SMOKE_URL=http://127.0.0.1:4398 OUT=/tmp/cadastral-shots node scripts/shot-basemap.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:4398';
const OUT = process.env.OUT || '/tmp/cadastral-shots';
fs.mkdirSync(OUT, { recursive: true });
const views = [
  ['bozeman-z14', [-111.04, 45.678], 14.2],
  ['billings-z12', [-108.52, 45.78], 12],
  ['gallatin-z9', [-111.2, 45.6], 9],
  ['state-z6', [-109.6, 47.0], 6],
];
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
for (const dark of [false, true]) {
  const p = await b.newPage();
  const errors = [], failed = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  p.on('requestfailed', (r) => failed.push(`${r.url().slice(0, 90)} ${r.failure()?.errorText}`));
  await p.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForSelector('#panel .card svg', { timeout: 60000 });
  await p.evaluate(() => { const s = document.getElementById('basemap'); s.value = 'montana'; s.dispatchEvent(new Event('change')); });
  await new Promise((r) => setTimeout(r, 5000));
  for (const [name, center, zoom] of views) {
    await p.evaluate((c, z) => window.__map.map.jumpTo({ center: c, zoom: z }), center, zoom);
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); if (await p.evaluate(() => window.__map.map.loaded() && !window.__map.map.isMoving())) break; }
    await new Promise((r) => setTimeout(r, 1500));
    const info = await p.evaluate(() => {
      const m = window.__map.map; const st = m.getStyle();
      const q = m.queryRenderedFeatures();
      const by = {};
      for (const f of q) { const l = f.sourceLayer || f.layer.source; by[l] = (by[l] || 0) + 1; }
      return { layers: st.layers.length, rendered: q.length, by, glyphs: st.glyphs, zoom: m.getZoom().toFixed(1) };
    });
    const sfx = dark ? '-dark' : '-light';
    await (await p.$('#mapwrap')).screenshot({ path: `${OUT}/basemap-${name}${sfx}.png` });
    console.log(`${name}${sfx}: z${info.zoom} rendered ${info.rendered} by source-layer ${JSON.stringify(info.by)}`);
  }
  console.log(dark ? 'dark' : 'light', 'console errors:', errors.length, errors.slice(0, 4), 'failed requests:', failed.length, failed.slice(0, 4));
  await p.close();
}
await b.close();
