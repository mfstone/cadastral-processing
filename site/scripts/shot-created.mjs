// Screenshot the Development view's parcel map over Bozeman at several
// vintages, light and dark: the parcels that did not yet exist at each
// vintage carry an outline coloured by the period they first appeared.
//   SMOKE_URL=http://127.0.0.1:4398 OUT=/tmp/cadastral-shots node scripts/shot-created.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:4398';
const OUT = process.env.OUT || '/tmp/cadastral-shots';
fs.mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
for (const dark of [false, true]) {
  const p = await b.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await p.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForSelector('#panel .card svg', { timeout: 60000 });
  await p.evaluate(() => window.__map.map.jumpTo({ center: [-111.035, 45.68], zoom: 12.6 }));
  // FILL=0 switches the parcel fill off under Layers, leaving the outlines.
  if (process.env.FILL === '0') {
    await p.evaluate(() => { const cb = document.getElementById('lyr-parcel-fill'); cb.checked = false; cb.dispatchEvent(new Event('change')); });
  }
  await new Promise((r) => setTimeout(r, 6000));
  const snaps = await p.evaluate(() => window.__state.dim.snapshots.map((s) => s.date));
  for (const idx of [0, 11, 16, 22, snaps.length - 1]) {
    const info = await p.evaluate(async (i) => {
      const sl = document.getElementById('snap');
      sl.value = String(i); sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 3000));
      const m = window.__map.map;
      const hl = m.queryRenderedFeatures({ layers: ['parcel-hl'] });
      const by = {};
      for (const f of hl) { const k = Number(f.properties.born); by[k] = (by[k] || 0) + 1; }
      return { outlined: hl.length, legend: document.getElementById('legend').innerText.replace(/\s+/g, ' ').slice(0, 220) };
    }, idx);
    const sfx = dark ? '-dark' : '-light';
    await (await p.$('#mapwrap')).screenshot({ path: `${OUT}/created-${snaps[idx]}${sfx}${process.env.FILL === '0' ? '-nofill' : ''}.png` });
    console.log(`${snaps[idx]}${sfx}: ${info.outlined} parcels outlined | ${info.legend}`);
  }
  console.log(dark ? 'dark' : 'light', 'console errors:', errors.length, errors.slice(0, 3));
  await p.close();
}
await b.close();
