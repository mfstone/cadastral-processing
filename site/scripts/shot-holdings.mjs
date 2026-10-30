/* Screenshot the Holdings view at parcel scale over a known large holding, and
 * count how many rendered parcels carry a holding class / county rank. */
import puppeteer from 'puppeteer-core';
const OUT = process.env.SHOT_DIR || '/tmp/shots';
const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:4399';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push(String(e)));
await p.setViewport({ width: 1200, height: 860 });
await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await p.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 90000 });
await p.waitForSelector('#panel .card svg', { timeout: 90000 });
// switch to Holdings
await p.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Holdings') b.click(); });
await new Promise((r) => setTimeout(r, 6000));
await p.screenshot({ path: `${OUT}/holdings-state.png` });
// Meagher County (71 Ranch) at parcel scale
await p.evaluate(() => window.__map.map.jumpTo({ center: [-110.95, 46.45], zoom: 11.3 }));
await new Promise((r) => setTimeout(r, 9000));
const m = await p.$('#mapwrap');
await m.screenshot({ path: `${OUT}/holdings-meagher-z11.png` });
const info = await p.evaluate(() => {
  const mp = window.__map.map;
  const f = mp.queryRenderedFeatures({ layers: ['parcel-fill'] });
  const hs = {}; let top4 = 0, flagged = 0;
  for (const x of f) { const k = String(x.properties.hs); hs[k] = (hs[k] || 0) + 1; if (Number(x.properties.hr) > 0) top4++; if (Number(x.properties.hp) === 1) flagged++; }
  return { zoom: +mp.getZoom().toFixed(1), parcels: f.length, hs, top4, flagged, legend: document.getElementById('legend').innerText.slice(0, 160) };
});
console.log(JSON.stringify(info));
// Review view panel
await p.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Review') b.click(); });
await new Promise((r) => setTimeout(r, 5000));
await p.screenshot({ path: `${OUT}/review-state.png` });
console.log('errors:', errs.slice(0, 3));
await b.close();
