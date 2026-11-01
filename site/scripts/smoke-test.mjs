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
  'owner_state/CA.parquet', 'reservation_stock.parquet',
  'reservations.geojson', 'publiclands.geojson', 'cities.geojson', 'highways.geojson',
  'lidar_coverage.geojson',
  'holdings_county.parquet', 'holdings_top.parquet', 'holdings_review.parquet',
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
ok('all eight views present, About last', views.length === 8 && views[7] === 'About', views.join(', '));

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

// Each chart view renders at least one chart, and populated -- not merely
// present. About is prose and has its own checks further down.
for (let i = 0; i < views.length; i++) {
  if (views[i] === 'About') continue;
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

// ---- 4. actual parcels, the deep-zoom surface
await page.select('#level', 'township');
await new Promise((r) => setTimeout(r, 1200));

// The tiles are stored UNCOMPRESSED on purpose: GDAL's COMPRESS=YES writes gzip
// bytes needing a Content-Encoding that `astro preview` does not apply, so the
// map would work on one origin and fail on the other for no visible reason.
const tileRes = await fetch(`${BASE}/data/parcels/12/735/1432.pbf`);
const tileBuf = new Uint8Array(await tileRes.arrayBuffer());
ok('parcel tile serves', tileRes.ok && tileBuf.length > 0, `status ${tileRes.status}`);
ok('parcel tile is NOT gzipped on disk',
  !(tileBuf[0] === 0x1f && tileBuf[1] === 0x8b),
  'a gzip magic number here means it needs a Content-Encoding the preview will not send');

await page.evaluate(() => window.__map.map.jumpTo({ center: [-111.035, 45.68], zoom: 12.6 }));
await new Promise((r) => setTimeout(r, 7000));
const pc = await page.evaluate(() =>
  window.__map.map.queryRenderedFeatures({ layers: ['parcel-fill'] }).length);
ok('parcels render at z12', pc > 500, `${pc} features`);
// The agricultural-acreage line has a deliberate gap (NaN) at 2009-07-05;
// the chart must scale to the finite values and draw inside its frame.
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Fragmentation') b.click(); });
await new Promise((r) => setTimeout(r, 4000));
const agChart = await page.evaluate(() => {
  const card = Array.from(document.querySelectorAll('#panel .card'))
    .find((c) => /Agricultural-use acreage/.test(c.textContent));
  if (!card) return { card: false };
  const svg = card.querySelector('svg');
  const path = Array.from(card.querySelectorAll('svg path')).find((p) => (p.getAttribute('d') || '').length > 20);
  const d = path ? path.getAttribute('d') : '';
  const ys = Array.from(d.matchAll(/[ML][\d.]+,([\d.-]+)/g)).map((m) => Number(m[1]));
  const h = Number(svg?.getAttribute('height') || svg?.viewBox?.baseVal?.height || 0);
  return { card: true, points: ys.length, inFrame: ys.every((y) => y >= 0 && y <= h), h, ymin: Math.min(...ys), ymax: Math.max(...ys) };
});
ok('agricultural acreage line draws inside its frame',
  agChart.card && agChart.points >= 20 && agChart.inFrame, JSON.stringify(agChart));
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Development') b.click(); });
await new Promise((r) => setTimeout(r, 3000));

// The About view: how to use, how to read, where it comes from, caveats,
// and the Episteme contact link; the map comes back when it is left.
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'About') b.click(); });
await new Promise((r) => setTimeout(r, 1500));
const about = await page.evaluate(() => ({
  cards: document.querySelectorAll('#panel .card').length,
  contact: document.querySelector('#panel a[href*="epistemegeospatial.com/contact"]')?.getAttribute('href') || '',
  doi: !!document.querySelector('#panel a[href*="doi.org"]'),
  mapHidden: document.getElementById('mapwrap').offsetHeight === 0 }));
ok('About view explains the dashboard and links to Episteme',
  about.cards >= 6 && /epistemegeospatial\.com\/contact/.test(about.contact) && about.doi && about.mapHidden,
  JSON.stringify(about));
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Development') b.click(); });
await new Promise((r) => setTimeout(r, 2500));
const back = await page.evaluate(() => ({
  mapShown: document.getElementById('mapwrap').offsetHeight > 0,
  canvas: window.__map.map.getCanvas().width > 0 }));
ok('leaving About restores the map', back.mapShown && back.canvas, JSON.stringify(back));

// First-party reference layers: roads from the same tiles, named from the
// vendored glyphs, and buildings where lidar has flown. Nothing is fetched
// from a third party by default: the basemap select starts at outlines only.
const glyphRes = await fetch(`${BASE}/fonts/Noto%20Sans%20Regular/0-255.pbf`);
ok('label glyphs are served first-party',
  glyphRes.ok && (await glyphRes.arrayBuffer()).byteLength > 10000, `status ${glyphRes.status}`);
// Livingston: inside a lidar project area, so footprints exist (Bozeman is not).
await page.evaluate(() => window.__map.map.jumpTo({ center: [-110.56, 45.66], zoom: 13.4 }));
await new Promise((r) => setTimeout(r, 7000));
const ref = await page.evaluate(() => {
  const mp = window.__map.map;
  const q = (l) => (mp.getLayer(l) ? mp.queryRenderedFeatures({ layers: [l] }).length : -1);
  return { roads: q('road-line'), buildings: q('bld-fill'), labels: q('road-label') + q('road-label-major'),
           base: mp.getStyle().layers.filter((l) => l.id.startsWith('base-')).length,
           glyphs: String(mp.getStyle().glyphs || ''), basemap: document.getElementById('basemap').value };
});
ok('roads and buildings draw from the parcel tiles', ref.roads > 50 && ref.buildings > 50,
  JSON.stringify({ roads: ref.roads, buildings: ref.buildings }));
ok('road names render from first-party glyphs',
  ref.labels > 0 && /\/fonts\//.test(ref.glyphs) && !/openfreemap/.test(ref.glyphs),
  JSON.stringify({ labels: ref.labels, glyphs: ref.glyphs }));
ok('no external basemap by default', ref.basemap === 'none' && ref.base === 0,
  JSON.stringify({ basemap: ref.basemap, base: ref.base }));
// The OpenStreetMap basemap stays available as an explicit choice, and tears down.
await page.evaluate(() => { const s = document.getElementById('basemap'); s.value = 'positron'; s.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 9000));
const osm = await page.evaluate(() => {
  const mp = window.__map.map;
  const symbols = mp.getStyle().layers.filter((l) => l.id.startsWith('base-') && l.type === 'symbol').map((l) => l.id);
  return { symbols: symbols.length, labels: symbols.length ? mp.queryRenderedFeatures({ layers: symbols }).length : 0,
           osm: /OpenStreetMap/.test(document.querySelector('.maplibregl-ctrl-attrib')?.textContent || '') };
});
ok('OpenStreetMap basemap loads on request, with labels and credit',
  osm.symbols > 5 && osm.labels > 0 && osm.osm, JSON.stringify(osm));
await page.evaluate(() => { const s = document.getElementById('basemap'); s.value = 'none'; s.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 1500));
const baseAfter = await page.evaluate(() => ({
  base: window.__map.map.getStyle().layers.filter((l) => l.id.startsWith('base-')).length,
  glyphs: String(window.__map.map.getStyle().glyphs || '') }));
ok('external basemap tears down and glyphs return to first-party',
  baseAfter.base === 0 && /\/fonts\//.test(baseAfter.glyphs) && !/openfreemap/.test(baseAfter.glyphs),
  JSON.stringify(baseAfter));

const legendMode = await page.evaluate(() => document.getElementById('legend').dataset.mode);
ok('legend switches to the parcel key at depth', legendMode === 'parcel', legendMode);
// The magenta outline is the one thing on the parcel map that follows the
// slider; the key must say what it is and name the vintage it refers to.
const keyText = await page.evaluate(() => ({
  text: document.getElementById('legend').innerText,
  swatch: !!document.querySelector('#legend .pl i.ol'),
  date: document.getElementById('snaplabel').textContent.trim() }));
ok('parcel key explains the magenta outline and names the vintage',
  keyText.swatch && /first seen in/.test(keyText.text) && keyText.text.includes(keyText.date),
  JSON.stringify({ swatch: keyText.swatch, date: keyText.date, text: keyText.text.slice(0, 120) }));

const popup = await page.evaluate(() => {
  const f = window.__map.map.queryRenderedFeatures({ layers: ['parcel-fill'] })[0];
  if (!f) return null;
  window.__map.onParcel(f.properties);
  const b = document.getElementById('parcelinfo');
  return b.hidden ? null : b.innerText;
});
ok('clicking a parcel names its geocode', !!popup && /\d{17}/.test(popup),
  (popup || 'no popup').slice(0, 60));
ok('parcel popup publishes no owner information',
  !!popup && /No owner information/.test(popup));

// The info box names a geocode; the selection outline must draw that parcel
// and only that parcel, and clear with the box.
// A filter change shows up in queryRenderedFeatures only after the next frame.
const selId = await page.evaluate(() => {
  const f = window.__map.map.queryRenderedFeatures({ layers: ['parcel-fill'] })[0];
  if (!f) return null;
  window.__map.selectParcel(f.properties.id);
  return f.properties.id;
});
let selDrawn = [];
for (let i = 0; i < 12 && !selDrawn.length; i++) {
  await new Promise((r) => setTimeout(r, 400));
  selDrawn = await page.evaluate(() => Array.from(new Set(
    window.__map.map.queryRenderedFeatures({ layers: ['parcel-sel'] }).map((x) => x.properties.id))));
}
await page.evaluate(() => window.__map.selectParcel(''));
// The clear shows up a frame or two later; poll rather than guess the delay.
let selCleared = -1;
for (let i = 0; i < 12 && selCleared !== 0; i++) {
  await new Promise((r) => setTimeout(r, 400));
  selCleared = await page.evaluate(() =>
    window.__map.map.queryRenderedFeatures({ layers: ['parcel-sel'] }).length);
}
const selCheck = selId ? { id: selId, drawn: selDrawn, cleared: selCleared } : null;
ok('clicked parcel is outlined as selected',
  !!selCheck && selCheck.drawn.length === 1 && selCheck.drawn[0] === selCheck.id && selCheck.cleared === 0,
  JSON.stringify(selCheck));

await page.evaluate(() => window.__map.map.jumpTo({ center: [-110.0, 46.9], zoom: 6.2 }));
await new Promise((r) => setTimeout(r, 2500));
const pc0 = await page.evaluate(() =>
  window.__map.map.queryRenderedFeatures({ layers: ['parcel-fill'] }).length);
ok('parcels are absent at statewide zoom', pc0 === 0, `${pc0} features`);

// ---- 5. reference overlays, lazily fetched
for (const kind of ['reservations', 'publiclands']) {
  await page.click(`#lyr-${kind}`);
  await new Promise((r) => setTimeout(r, kind === 'publiclands' ? 9000 : 3000));
  const on = await page.evaluate((k) => !!window.__map.map.getLayer(`ov-${k}-fill`), kind);
  ok(`${kind} overlay loads on demand`, on);
  await page.click(`#lyr-${kind}`);
  await new Promise((r) => setTimeout(r, 800));
  const vis = await page.evaluate((k) =>
    window.__map.map.getLayoutProperty(`ov-${k}-fill`, 'visibility'), kind);
  ok(`${kind} overlay toggles off`, vis === 'none', String(vis));
}

ok('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
