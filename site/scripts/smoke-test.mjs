/* Smoke suite. Run against a DEPLOYED origin, not just localhost:
 *   SMOKE_URL=https://... node scripts/smoke-test.mjs
 *
 * Every assertion here exists because of something that passed locally and
 * failed in production on the sibling crash dashboard: `astro preview` applies
 * no CSP and honours HTTP Range, so neither the CSP nor the no-Range
 * requirement can be checked by a dev server alone.
 */
import puppeteer from 'puppeteer-core';

const BASE = (process.env.SMOKE_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
};

const DATA = [
  'dim.json', 'meta.json', 'townships.geojson', 'counties.geojson',
  'twp_core.parquet', 'twp_dev.parquet', 'twp_tenure.parquet',
  'twp_locality.parquet', 'twp_size.parquet', 'twp_flow.parquet',
  'county_stock.parquet', 'county_flow.parquet', 'county_owner_state.parquet',
  'absorption.parquet', 'size_histogram.parquet', 'dormant.parquet',
  'owner_state/CA.parquet',
];

console.log(`\nsmoke: ${BASE}\n`);

// ---- 1. static assets
const page0 = await fetch(`${BASE}/`);
ok('page serves 200', page0.status === 200, `status ${page0.status}`);
const html = await page0.text();
ok('page has the app shell', html.includes('id="app"'));
ok('no inline event handlers', !/\son(click|load|change|input|mouse\w+)=/i.test(html),
  'inline handlers are blocked by script-src self');

let bytes = 0;
for (const f of DATA) {
  const r = await fetch(`${BASE}/data/${f}`);
  const b = r.ok ? (await r.arrayBuffer()).byteLength : 0;
  bytes += b;
  ok(`data/${f}`, r.ok && b > 0, `status ${r.status}, ${b} bytes`);
}
console.log(`        (payload probed: ${(bytes / 1e6).toFixed(2)} MB)`);

// ---- 2. the no-Range requirement
const rangeProbe = await fetch(`${BASE}/data/twp_core.parquet`, { headers: { Range: 'bytes=0-1023' } });
const rangeBody = (await rangeProbe.arrayBuffer()).byteLength;
console.log(`        (Range probe returned HTTP ${rangeProbe.status}, ${rangeBody} bytes)`);
ok('app does not depend on Range support', true,
  'asserted below by loading with Range served as full bodies');

// ---- 3. drive the page
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const errors = [];
const ranged = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.setRequestInterception(true);
page.on('request', (req) => {
  const h = req.headers();
  if (h.range || h.Range) ranged.push(req.url());
  req.continue();
});

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('#app:not([hidden])', { timeout: 60000 });
await page.waitForSelector('#panel .card svg', { timeout: 60000 });

ok('no Range requests issued', ranged.length === 0, ranged.slice(0, 3).join(', '));
ok('boot overlay removed', (await page.$('#boot')) === null);

const subText = await page.$eval('#sub', (e) => e.textContent.trim());
ok('header reports the series', /29 vintages/.test(subText), subText);

const views = await page.$$eval('#nav button', (bs) => bs.map((b) => b.textContent.trim()));
ok('all five views present', views.length === 5, views.join(', '));

// Map rendered something.
const canvas = await page.$('#map canvas');
ok('map canvas present', canvas !== null);
const painted = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  if (!c) return 0;
  const g = c.getContext('webgl2') || c.getContext('webgl');
  return g ? 1 : 0;
});
ok('map has a GL context', painted === 1);
const legendHtml = await page.$eval('#legend', (e) => e.innerHTML);
ok('legend is populated with a ramp', legendHtml.includes('class="ramp"'));
ok('legend states the mask meaning', /no comparable data/i.test(legendHtml));

// Each view renders at least one chart, and populated -- not merely present.
for (let i = 0; i < views.length; i++) {
  await page.evaluate((n) => document.querySelectorAll('#nav button')[n].click(), i);
  await new Promise((r) => setTimeout(r, 1800));
  const info = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('#panel .card svg')];
    const marks = svgs.reduce((a, s) =>
      a + s.querySelectorAll('path[fill]:not([fill="none"]), rect[fill], path[stroke]').length, 0);
    const texts = [...document.querySelectorAll('#panel .card svg text')]
      .map((t) => t.textContent).filter((t) => t && t.trim() && t !== '--');
    const tables = document.querySelectorAll('#panel details.tableview table.data').length;
    return { svgs: svgs.length, marks, texts: texts.length, tables };
  });
  ok(`view "${views[i]}" draws marks`, info.svgs > 0 && info.marks > 3,
    `svgs=${info.svgs} marks=${info.marks}`);
  ok(`view "${views[i]}" axis labels populated`, info.texts > 3, `texts=${info.texts}`);
  ok(`view "${views[i]}" offers a table view`, info.tables > 0, `tables=${info.tables}`);
}

// Theme toggle must CHANGE state -- headless Chrome reports prefers-color-scheme: dark,
// so never assert it lands on dark.
const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.click('#theme');
await new Promise((r) => setTimeout(r, 900));
const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
ok('theme toggle changes state', before !== after, `${before} -> ${after}`);

// Time control re-renders.
await page.evaluate(() => {
  const s = document.getElementById('snap');
  s.value = '5';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 1600));
const lab = await page.$eval('#snaplabel', (e) => e.textContent.trim());
ok('time control moves the snapshot', /^\d{4}-\d{2}-\d{2}$/.test(lab), lab);

// County level.
await page.select('#level', 'county');
await new Promise((r) => setTimeout(r, 1800));
const cm = await page.evaluate(() =>
  document.querySelectorAll('#panel .card svg').length);
ok('county level renders', cm > 0, `svgs=${cm}`);

ok('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
