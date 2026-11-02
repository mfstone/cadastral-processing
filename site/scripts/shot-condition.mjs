// Screenshot the Condition view three ways: statewide at township grain, a
// county selected at county grain, and the parcels at depth over Bozeman.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:4398';
const OUT = process.env.OUT || '/tmp/cadastral-shots';
fs.mkdirSync(OUT, { recursive: true });
const dark = process.env.DARK === '1';

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
await p.waitForSelector('#panel .card svg', { timeout: 60000 });
const click = (label) => p.evaluate((l) => {
  for (const x of document.querySelectorAll('#nav button')) if (x.textContent.trim() === l) x.click();
}, label);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sfx = dark ? '-dark' : '';

await click('Condition');
await wait(4000);
await p.screenshot({ path: `${OUT}/condition-state${sfx}.png`, fullPage: true });
console.log('statewide:', await p.evaluate(() => ({
  legend: document.getElementById('legend').textContent.slice(0, 120),
  tiles: [...document.querySelectorAll('#panel .stat')].slice(0, 5).map((e) => e.textContent.trim().replace(/\s+/g, ' ')),
  slider: document.getElementById('snap').disabled,
})));

await p.select('#level', 'county');
await wait(1500);
await p.evaluate(() => { window.__state.selection.add(6); });
await click('Condition');
await wait(4000);
await p.screenshot({ path: `${OUT}/condition-gallatin${sfx}.png`, fullPage: true });
console.log('gallatin:', await p.evaluate(() => ({
  tiles: [...document.querySelectorAll('#panel .stat')].slice(0, 5).map((e) => e.textContent.trim().replace(/\s+/g, ' ')),
  cards: [...document.querySelectorAll('#panel .card h3')].map((e) => e.textContent),
})));

await p.evaluate(() => window.__map.map.jumpTo({ center: [-111.035, 45.68], zoom: 13.2 }));
await wait(7000);
const feats = await p.evaluate(() => {
  const fs = window.__map.map.queryRenderedFeatures({ layers: ['parcel-fill'] });
  const cd = fs.map((f) => Number(f.properties.cd)).filter((v) => v >= 0);
  const hist = {}; for (const v of cd) hist[v] = (hist[v] || 0) + 1;
  return { n: fs.length, rated: cd.length, hist, legend: document.getElementById('legend').textContent.slice(0, 160) };
});
console.log('parcels:', JSON.stringify(feats));
await p.screenshot({ path: `${OUT}/condition-parcels${sfx}.png`, clip: { x: 0, y: 0, width: 1440, height: 1000 } });
console.log('errors:', JSON.stringify(errors));
await b.close();
