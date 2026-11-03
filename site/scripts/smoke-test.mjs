/* Smoke suite. Run against a DEPLOYED origin, not just localhost:
 *   SMOKE_URL=https://... node scripts/smoke-test.mjs
 *
 * Every assertion here exists because of something that passed locally and
 * failed in production on the sibling crash dashboard: `astro preview` applies
 * no CSP and honours HTTP Range, so neither the CSP nor the no-Range
 * requirement can be checked by a dev server alone.
 */
import puppeteer from 'puppeteer-core';
import { scripted } from './lib/mock-assistant.mjs';

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
  'threshold_edges.parquet', 'county_size_histogram.parquet', 'regression_table1.parquet',
  'cama_township.parquet', 'cama_county.parquet', 'cama_timing.parquet', 'cama_condition_decade.parquet',
  'cama_transitions.parquet',
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

// ---- 1b. on a deployed origin only: the tiles must go out compressed, which
// depends on the Content-Type being one Cloudflare compresses (see _headers).
if (/^https:/.test(BASE)) {
  const tr = await fetch(`${BASE}/data/parcels/11/367/716.pbf`, { headers: { 'accept-encoding': 'gzip, br, zstd' } });
  const enc = tr.headers.get('content-encoding') || '';
  const type = tr.headers.get('content-type') || '';
  ok('deployed tiles are compressed on the wire', tr.ok && /gzip|br|zstd/.test(enc) && /x-protobuf/.test(type),
    `status ${tr.status}, content-encoding "${enc}", content-type "${type}"`);
}

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
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // The mocked Worker refusal below is meant to be a 429; the browser logs it.
  if (mock.fail && /status of 429/.test(m.text())) return;
  errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.setRequestInterception(true);
// The assistant's endpoint is answered here by a scripted model (no key, no
// network): the health check says it is on, and each POST gets the next step
// of the script for the question asked. `mock.fail` makes the Worker refuse.
const mock = { script: null, fail: 0 };
let assistantChunk = 0;
page.on('response', async (res) => {
  if (/\/_astro\/panel\.[^/]+\.js$/.test(res.url())) { try { assistantChunk = (await res.buffer()).length; } catch { /* ignore */ } }
});
page.on('request', (req) => {
  const h = req.headers();
  if (h.range || h.Range) ranged.push(req.url());
  const path = new URL(req.url()).pathname;
  if (path === '/api/assistant/health') {
    return req.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, model: 'claude-mock', effort: 'medium', names: 'never', turnstile: false, site_key: null, prompt: 'mock' }) });
  }
  if (path === '/api/assistant') {
    if (mock.fail) {
      return req.respond({ status: mock.fail, contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'budget', message: 'You have reached today\u2019s limit for the assistant.' } }) });
    }
    return req.respond({ status: 200, contentType: 'application/x-ndjson', body: mock.script ? mock.script.next() : '' });
  }
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
ok('all ten views present, Condition after Development, Reports then About last',
  views.length === 10 && views[1] === 'Condition' && views[8] === 'Reports' && views[9] === 'About', views.join(', '));

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
// present. About is prose and Reports composes on request; both have their
// own checks further down.
for (let i = 0; i < views.length; i++) {
  if (views[i] === 'About' || views[i] === 'Reports') continue;
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

// ---- 3b. the state is addressable: one applyState for every driver, and
// the URL carries it. The hash must reflect a programmatic change, the
// controls must follow the state, a camera move must not re-render the view,
// and a view change must render exactly once.
const dash = await page.evaluate(async () => {
  const r0 = window.__state.renders;
  const r = await window.__dash.applyState({ view: 'holdings', level: 'county', selection: [6], snap: 19 });
  const st = window.__dash.getState();
  const nav = [...document.querySelectorAll('#nav button')].find((b) => b.getAttribute('aria-selected') === 'true');
  return { hash: location.hash, view: st.view, level: st.level, selection: st.selection, snap: st.snap,
    levelSel: document.getElementById('level').value, levelDisabled: document.getElementById('level').disabled,
    navLabel: nav ? nav.textContent.trim() : '', label: document.getElementById('snaplabel').textContent.trim(),
    rendersDelta: window.__state.renders - r0, warnings: r.warnings };
});
ok('applyState drives the view, the level, the selection and the vintage',
  dash.view === 'holdings' && dash.level === 'county' && dash.selection.length === 1 && dash.selection[0] === 6
    && dash.snap === 19 && dash.levelSel === 'county' && dash.levelDisabled && dash.navLabel === 'Holdings'
    && dash.label === '2018-01-10' && dash.rendersDelta === 1,
  JSON.stringify(dash));
ok('the URL hash carries the state', /v=holdings/.test(dash.hash) && /l=c/.test(dash.hash) && /u=6/.test(dash.hash) && /s=19/.test(dash.hash), dash.hash);
const camera = await page.evaluate(async () => {
  const r0 = window.__state.renders;
  await window.__dash.applyState({ map: { center: [-111.035, 45.68], zoom: 12.6 } });
  const st = window.__dash.getState();
  return { rendersDelta: window.__state.renders - r0, zoom: window.__map.map.getZoom(), hash: location.hash,
    stateZoom: st.map && st.map.zoom, legendMode: document.getElementById('legend').dataset.mode };
});
ok('a camera change moves the map and the URL without re-rendering the view',
  camera.rendersDelta === 0 && Math.abs(camera.zoom - 12.6) < 0.05 && /c=-111\.035/.test(camera.hash) && camera.legendMode === 'parcel',
  JSON.stringify(camera));
const described = await page.evaluate(() => window.__dash.describeState());
ok('describeState speaks in names and dates',
  described.view.label === 'Holdings' && described.selection.names[0] === 'Gallatin' && described.vintage.date === '2018-01-10'
    && described.map.parcel_scale === true && described.caveats.length >= 1,
  JSON.stringify({ view: described.view.label, names: described.selection.names, date: described.vintage.date }));
const restored = await page.evaluate(async () => {
  const r0 = window.__state.renders;
  await window.__dash.applyState({ view: 'ladder', selection: [], map: null });
  return { rendersDelta: window.__state.renders - r0, hash: location.hash, legendMode: document.getElementById('legend').dataset.mode,
    zoom: window.__map.map.getZoom() };
});
ok('restoring a view renders once and leaves the parcel key behind',
  restored.rendersDelta === 1 && !/v=/.test(restored.hash) && restored.legendMode !== 'parcel' && restored.zoom < 9,
  JSON.stringify(restored));

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
// The DOR's building record rides on the tile: condition 0-7 and year built.
const cdAttr = await page.evaluate(() => {
  const fs = window.__map.map.queryRenderedFeatures({ layers: ['parcel-fill'] });
  return { n: fs.length,
    withCd: fs.filter((f) => f.properties.cd != null && Number(f.properties.cd) >= 0).length,
    withYb: fs.filter((f) => Number(f.properties.yb) > 0).length };
});
ok('parcel tiles carry the DOR condition and year built', cdAttr.withCd > 50 && cdAttr.withYb > 50, JSON.stringify(cdAttr));
// The Condition view's parcel paint must be the DOR rating and the year built
// together (the bivariate grid, nine cells in the legend), and its popup must
// name the rating and the year built.
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Condition') b.click(); });
await new Promise((r) => setTimeout(r, 3500));
const condView = await page.evaluate(() => {
  const paint = window.__map.map.getPaintProperty('parcel-fill', 'fill-color');
  const fs = window.__map.map.queryRenderedFeatures({ layers: ['parcel-fill'] })
    .filter((f) => Number(f.properties.cd) >= 0 && Number(f.properties.yb) > 0);
  return { rated: fs.length, paintUsesCd: JSON.stringify(paint).includes('"cd"') && JSON.stringify(paint).includes('"yb"'),
    cells: document.querySelectorAll('#legend .bv .grid i').length, sliderOn: !document.getElementById('snap').disabled,
    legend: document.getElementById('legend').textContent,
    cards: [...document.querySelectorAll('#panel .card h3')].map((e) => e.textContent),
    caption: document.querySelector('#panel .card .cap')?.textContent || '',
    tiles: [...document.querySelectorAll('#panel .stat .k')].map((e) => e.textContent).slice(0, 6) };
});
ok('Condition view paints parcels by the DOR rating and year built, keeps the time slider and draws the series',
  condView.rated > 50 && condView.paintUsesCd && condView.cells === 9 && condView.sliderOn && /condition/i.test(condView.legend)
    && condView.tiles.some((t) => /dwelling/i.test(t)) && /tax years? 20\d\d/.test(condView.caption)
    && condView.cards.some((c) => /over the series/i.test(c)) && condView.cards.some((c) => /point to point/i.test(c)),
  JSON.stringify({ rated: condView.rated, sliderOn: condView.sliderOn, cards: condView.cards }));
// Moving the slider back to 2017 must change the point the view describes.
await page.evaluate(() => { const sl = document.getElementById('snap'); sl.value = '18'; sl.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 3000));
const condBack = await page.evaluate(() => document.querySelector('#panel .card h3')?.textContent || '');
ok('Condition view follows the slider to an earlier point', /tax year 2016/.test(condBack), condBack);
await page.evaluate(() => { const sl = document.getElementById('snap'); sl.value = sl.max; sl.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 2000));
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

// The Reports view: six documents composed from the same tables and printed
// to PDF by the browser. Each must compose without error and carry its
// sections; the worksheet must be a CSV shaped for owner_overrides.csv; and
// the print path (the same one Save as PDF uses) must yield a real PDF.
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Reports') b.click(); });
await new Promise((r) => setTimeout(r, 800));
const rform = await page.evaluate(() => ({
  kinds: [...document.querySelectorAll('#rpt-kind option')].map((o) => o.value),
  county: !!document.getElementById('rpt-county'), go: !!document.getElementById('rpt-go'),
  mapHidden: document.getElementById('mapwrap').offsetHeight === 0 }));
ok('Reports view offers the six reports', rform.kinds.length === 6 && rform.county && rform.go && rform.mapHidden, JSON.stringify(rform));
const compose = async (kind, county) => {
  await page.evaluate((k, c) => {
    const s = document.getElementById('rpt-kind'); s.value = k; s.dispatchEvent(new Event('change'));
    if (c != null) { const cs = document.getElementById('rpt-county'); cs.value = c; cs.dispatchEvent(new Event('change')); }
    window.__report = null;
    document.getElementById('rpt-go').click();
  }, kind, county);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await page.evaluate(() => !!window.__report)) break;
  }
  return page.evaluate(() => {
    const r = document.getElementById('report');
    const out = window.__report || {};
    return { title: out.title || '', rows: out.rows || 0, csvHead: (out.csv || '').split('\r\n')[0],
      csvLines: out.csv ? out.csv.split('\r\n').length - 1 : 0,
      secs: r ? r.querySelectorAll('.rsec').length : 0, svgs: r ? r.querySelectorAll('svg').length : 0,
      tableRows: r ? [...r.querySelectorAll('.tablewrap table.data')].map((t) => t.tBodies[0].rows.length) : [],
      dashes: r ? [...r.querySelectorAll('.stat .v')].filter((e) => e.textContent === '--').length : 0,
      width: r ? Math.round(r.getBoundingClientRect().width) : 0,
      pdfBtn: !document.getElementById('rpt-pdf').hidden, csvBtn: !document.getElementById('rpt-csv').hidden };
  });
};
const prof = await compose('profile', '6');
ok('county profile composes every section with populated tiles',
  /Gallatin/.test(prof.title) && prof.secs >= 13 && prof.svgs >= 14 && prof.dashes === 0 && prof.pdfBtn && prof.width === 816,
  JSON.stringify(prof));
// The witness table carries ten tests from the DOR records plus two from the
// Structures Framework address points on the newest series point: 12 rows.
const cond = await compose('condition', '6');
ok('housing condition profile composes its sections from the DOR building records and the address points',
  /Gallatin County housing condition/.test(cond.title) && cond.secs >= 7 && cond.svgs >= 8 && cond.dashes === 0
    && cond.tableRows.includes(8) && cond.tableRows.includes(12) && cond.pdfBtn,
  JSON.stringify(cond));
const trnd = await compose('trends', null);
ok('statewide trends brief is chart-led and dated', /2026|20\d\d/.test(trnd.title) && trnd.svgs >= 8 && trnd.dashes === 0, JSON.stringify(trnd));
const hold = await compose('holdings', null);
ok('large-holdings update carries Table 1 for every county, the four largest per county, and the residuals',
  hold.tableRows[0] === 57 && hold.tableRows[1] >= 200 && hold.tableRows.filter((n) => n === 14).length === 2 && hold.svgs >= 2,
  JSON.stringify(hold.tableRows));
const wks = await compose('worksheet', '');
ok('review worksheet is a CSV shaped for owner_overrides.csv',
  wks.csvHead.startsWith('override_action,source_owner_id,target_owner_group_id,PartyID,PARCELID,PropertyID,CountyPrefix,TaxYear,reason,reviewer,review_date,')
    && wks.rows > 50 && wks.csvLines === wks.rows + 1 && wks.tableRows[0] === wks.rows && wks.csvBtn,
  JSON.stringify({ head: wks.csvHead.slice(0, 60), rows: wks.rows, lines: wks.csvLines, csvBtn: wks.csvBtn }));
const act = await compose('activity', null);
ok('subdivision activity report tables every county for the period',
  /\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/.test(act.title) && act.tableRows.includes(56) && act.svgs >= 3, JSON.stringify(act));
// The PDF comes from the browser's print engine, through the same stylesheet
// the Save-as-PDF button uses; Letter, several pages, and only the report.
// page.pdf() returns a Uint8Array, whose toString is a list of numbers.
const pdfBuf = Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true }));
const pdfTxt = pdfBuf.toString('latin1');
const pdfPages = (pdfTxt.match(/\/Type\s*\/Page[^s]/g) || []).length;
ok('report prints to a multi-page PDF through the browser',
  pdfBuf.length > 50000 && pdfTxt.startsWith('%PDF-') && pdfPages >= 3,
  JSON.stringify({ bytes: pdfBuf.length, pages: pdfPages }));
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Development') b.click(); });
await new Promise((r) => setTimeout(r, 2500));

// First-party reference layers: roads from the same tiles, named from the
// vendored glyphs, and buildings from the merged footprint layer. Nothing is fetched
// from a third party by default: the basemap select starts at outlines only.
const glyphRes = await fetch(`${BASE}/fonts/Noto%20Sans%20Regular/0-255.pbf`);
ok('label glyphs are served first-party',
  glyphRes.ok && (await glyphRes.arrayBuffer()).byteLength > 10000, `status ${glyphRes.status}`);
// Livingston: inside a lidar project area, so lidar footprints (src 2, 3) draw beside
// the 2018 set; Bozeman is outside every project area, so only the 2018 set (src 1) does.
await page.evaluate(() => window.__map.map.jumpTo({ center: [-110.56, 45.66], zoom: 13.4 }));
await new Promise((r) => setTimeout(r, 7000));
const ref = await page.evaluate(() => {
  const mp = window.__map.map;
  const q = (l) => (mp.getLayer(l) ? mp.queryRenderedFeatures({ layers: [l] }).length : -1);
  const srcs = [...new Set(mp.queryRenderedFeatures({ layers: ['bld-fill'] }).map((f) => Number(f.properties.src)))].sort();
  return { roads: q('road-line'), buildings: q('bld-fill'), srcs, labels: q('road-label') + q('road-label-major'),
           base: mp.getStyle().layers.filter((l) => l.id.startsWith('base-')).length,
           glyphs: String(mp.getStyle().glyphs || ''), basemap: document.getElementById('basemap').value };
});
ok('roads and buildings draw from the parcel tiles', ref.roads > 50 && ref.buildings > 50,
  JSON.stringify({ roads: ref.roads, buildings: ref.buildings }));
ok('footprints carry their source tag, lidar where flown', ref.srcs.includes(3) && !ref.srcs.includes(1)
  && ref.srcs.every((v) => v >= 1 && v <= 4), JSON.stringify(ref.srcs));
await page.evaluate(() => window.__map.map.jumpTo({ center: [-111.04, 45.675], zoom: 13.4 }));
await new Promise((r) => setTimeout(r, 6000));
const bz = await page.evaluate(() => {
  const fs = window.__map.map.queryRenderedFeatures({ layers: ['bld-fill'] });
  return { n: fs.length, ms: fs.filter((f) => Number(f.properties.src) === 1).length };
});
ok('the 2018 set draws outside the lidar areas (Bozeman)', bz.n > 200 && bz.ms === bz.n, JSON.stringify(bz));
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
// The in-house basemap: State Library frameworks in one PMTiles archive under
// /basemap, read by Range requests, with the vendored glyphs.
const rangeRes = await fetch(`${BASE}/basemap/mt-basemap.pmtiles`, { headers: { Range: 'bytes=0-126' } });
ok('the in-house basemap archive is served with Range support',
  rangeRes.status === 206 && (await rangeRes.arrayBuffer()).byteLength === 127, `status ${rangeRes.status}`);
await page.evaluate(() => { const s = document.getElementById('basemap'); s.value = 'montana'; s.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 9000));
const mt = await page.evaluate(() => {
  const mp = window.__map.map;
  const layers = mp.getStyle().layers.filter((l) => l.id.startsWith('base-'));
  const symbols = layers.filter((l) => l.type === 'symbol').map((l) => l.id);
  const lines = layers.filter((l) => l.type === 'line').map((l) => l.id);
  return { layers: layers.length,
           labels: symbols.length ? mp.queryRenderedFeatures({ layers: symbols }).length : 0,
           lines: lines.length ? mp.queryRenderedFeatures({ layers: lines }).length : 0,
           glyphs: String(mp.getStyle().glyphs || ''),
           credit: document.querySelector('.maplibregl-ctrl-attrib')?.textContent || '' };
});
ok('the in-house basemap draws from first-party tiles, with labels',
  mt.layers > 20 && mt.labels > 0 && mt.lines > 0 && /\/fonts\//.test(mt.glyphs) && !/openfreemap/.test(mt.glyphs),
  JSON.stringify({ layers: mt.layers, labels: mt.labels, lines: mt.lines, glyphs: mt.glyphs }));
ok('the in-house basemap credits the State Library', /Montana State Library/.test(mt.credit), mt.credit.slice(0, 80));
await page.evaluate(() => { const s = document.getElementById('basemap'); s.value = 'none'; s.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 1500));

const legendMode = await page.evaluate(() => document.getElementById('legend').dataset.mode);
ok('legend switches to the parcel key at depth', legendMode === 'parcel', legendMode);
// The period outlines are the one thing on the parcel map that follows the
// slider; the key must say what they are and name the vintage they refer to.
const keyText = await page.evaluate(() => ({
  text: document.getElementById('legend').innerText,
  swatch: !!document.querySelector('#legend .pl i.ol'),
  date: document.getElementById('snaplabel').textContent.trim() }));
ok('parcel key explains the period outlines and names the vintage',
  keyText.swatch && /did not yet exist in|no parcels created after/.test(keyText.text) && keyText.text.includes(keyText.date),
  JSON.stringify({ swatch: keyText.swatch, date: keyText.date, text: keyText.text.slice(0, 120) }));
// At the first vintage every parcel that came later is outlined by its period
// and the county gate is in the filter; at the last vintage nothing is outlined.
const outl = await page.evaluate(async () => {
  for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Development') b.click();
  const sl = document.getElementById('snap');
  const last = Number(sl.max);
  const set = (v) => { sl.value = String(v); sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change')); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1500);
  set(0); await wait(3000);
  const m = window.__map.map;
  const atFirst = m.queryRenderedFeatures({ layers: ['parcel-hl'] }).length;
  const color = JSON.stringify(m.getPaintProperty('parcel-hl', 'line-color'));
  const filter = JSON.stringify(m.getFilter('parcel-hl'));
  const periods = document.querySelectorAll('#legend .pl i.ol').length;
  set(last); await wait(3000);
  const atLast = m.queryRenderedFeatures({ layers: ['parcel-hl'] }).length;
  return { atFirst, atLast, step: color.includes('"step"'), gate: filter.includes('"slice"'), periods };
});
ok('parcels created after the selected vintage are outlined by period, none after the last',
  outl.atFirst > 50 && outl.atLast === 0 && outl.step && outl.gate && outl.periods === 5, JSON.stringify(outl));
// The fill can be switched off under Parcels: the fill goes transparent, the
// outlines stay, the key says so, and switching it back restores the paint.
const fillOff = await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__map.map;
  const cb = document.getElementById('lyr-parcel-fill');
  const sl = document.getElementById('snap');
  const set = (v) => { sl.value = String(v); sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change')); };
  cb.checked = false; cb.dispatchEvent(new Event('change'));
  set(0); await wait(3000);
  const op = JSON.stringify(m.getPaintProperty('parcel-fill', 'fill-opacity'));
  const outlined = m.queryRenderedFeatures({ layers: ['parcel-hl'] }).length;
  const noted = /fill off/i.test(document.getElementById('legend').innerText);
  cb.checked = true; cb.dispatchEvent(new Event('change'));
  set(Number(sl.max)); await wait(2500);
  const opBack = JSON.stringify(m.getPaintProperty('parcel-fill', 'fill-opacity'));
  return { op, outlined, noted, opBack };
});
ok('the parcel fill switches off under Parcels, leaving the outlines, and back on',
  fillOff.op === '0' && fillOff.outlined > 50 && fillOff.noted && fillOff.opBack !== '0', JSON.stringify(fillOff));

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

// ---- 5c. a phone: nothing overflows sideways, the map is on top, the panel below.
const phone = await browser.newPage();
// A 390-px layout viewport without device emulation: with `isMobile` Chrome
// reported an 807-px inner width here and the phone rules never applied; the
// layout is what is under test, and a CSS width of 390 is what a phone lays out at.
await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await phone.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
await phone.waitForSelector('#panel .card svg', { timeout: 60000 });
const ph = await phone.evaluate(() => {
  const r = (id) => document.getElementById(id).getBoundingClientRect();
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    mapTop: r('mapwrap').top, mapH: r('mapwrap').height, panelTop: r('panel').top,
    canvas: !!document.querySelector('#map canvas'), layersOpen: document.getElementById('layers').open,
    navScrolls: document.getElementById('nav').scrollWidth > document.getElementById('nav').clientWidth,
    legendW: r('legend').width, mapDesc: document.getElementById('map-desc').textContent.length };
});
ok('the phone layout has no horizontal overflow and stacks the map above the panel',
  ph.scrollW <= ph.innerW + 1 && ph.canvas && ph.mapH >= 240 && ph.mapH <= 420 && ph.panelTop >= ph.mapTop + ph.mapH - 2
    && !ph.layersOpen && ph.navScrolls && ph.legendW <= 0.6 * ph.innerW && ph.mapDesc > 20,
  JSON.stringify(ph));
await phone.close();

// ---- 6. a pasted link is a state: a fresh page opens on it.
const page2 = await browser.newPage();
await page2.setViewport({ width: 1400, height: 900 });
const errors2 = [];
page2.on('pageerror', (e) => errors2.push(String(e)));
await page2.goto(`${BASE}/#v=thresholds&e=mid&l=c&u=31&s=20`, { waitUntil: 'networkidle2', timeout: 60000 });
await page2.waitForSelector('#panel .card svg', { timeout: 60000 });
const linked = await page2.evaluate(() => {
  const st = window.__dash.getState();
  const nav = [...document.querySelectorAll('#nav button')].find((b) => b.getAttribute('aria-selected') === 'true');
  return { view: st.view, era: st.era, level: st.level, selection: st.selection, snap: st.snap,
    eraShown: !document.getElementById('erawrap').hidden, eraSel: document.getElementById('era').value,
    navLabel: nav ? nav.textContent.trim() : '', hash: location.hash,
    histogram: document.querySelectorAll('#panel .card svg rect[fill]').length,
    askHidden: document.getElementById('assist-toggle').hidden };
});
ok('without the Worker the Ask button stays hidden', linked.askHidden === true);
ok('a deep link opens the dashboard in its state',
  linked.view === 'thresholds' && linked.era === 'mid' && linked.level === 'county' && linked.selection[0] === 31
    && linked.snap === 20 && linked.eraShown && linked.eraSel === 'mid' && linked.navLabel === 'Thresholds'
    && linked.histogram > 5 && errors2.length === 0,
  JSON.stringify(linked));
await page2.close();

// ---- 5b. the assistant, against the scripted model: the panel, the loop,
// the executors and the names policy, with no key and no network.
await page.evaluate(() => { for (const b of document.querySelectorAll('#nav button')) if (b.textContent.trim() === 'Development') b.click(); });
await new Promise((r) => setTimeout(r, 1500));
ok('the Ask button appears when the assistant endpoint answers',
  await page.evaluate(() => !document.getElementById('assist-toggle').hidden));
await page.click('#assist-toggle');
await page.waitForSelector('#assist:not([hidden])', { timeout: 20000 });
await page.waitForFunction(() => !!window.__assistant, { timeout: 20000 });
const panel0 = await page.evaluate(() => ({
  chips: document.querySelectorAll('#assist-suggest .chip').length,
  privacy: document.getElementById('assist-privacy').textContent.length,
  focused: document.activeElement && document.activeElement.id }));
ok('the panel opens with suggestions, the privacy note and focus in the box',
  panel0.chips === 6 && panel0.privacy > 100 && panel0.focused === 'assist-q', JSON.stringify(panel0));
ok('the assistant chunk is loaded on first open and stays small',
  assistantChunk > 10000 && assistantChunk < 700000, `${assistantChunk} bytes`);

const q1 = 'Show me large holdings in Gallatin County in 2018';
mock.script = scripted(q1);
const run = await page.evaluate(async (q) => {
  const turn = await window.__assistant.ask(q);
  const st = window.__dash.getState();
  return { status: turn.status, tools: turn.tools.map((t) => [t.name, t.ok, t.summary]), text: turn.text, hash: location.hash,
    view: st.view, level: st.level, selection: st.selection, snap: st.snap, zoom: window.__map.map.getZoom(),
    answerHtml: document.querySelector('.assist-a')?.innerHTML || '',
    trace: document.querySelectorAll('.assist-trace li').length, restore: !!document.querySelector('.assist-actions-row .chip'),
    messages: window.__assistant.conv.messages.length, roles: window.__assistant.conv.messages.map((m) => m.role[0]).join('') };
}, q1);
ok('a scripted question drives the dashboard through the tools',
  run.status === 'done' && run.tools.length === 3 && run.tools.every((t) => t[1]) && run.view === 'holdings'
    && run.level === 'county' && run.selection.length === 1 && run.selection[0] === 6 && run.snap === 19,
  JSON.stringify({ status: run.status, tools: run.tools, view: run.view, level: run.level, sel: run.selection, snap: run.snap }));
ok('the map fitted to the county and the URL carries the state',
  run.zoom > 7 && run.zoom <= 9.6 && /v=holdings/.test(run.hash) && /u=6/.test(run.hash) && /s=19/.test(run.hash),
  JSON.stringify({ zoom: run.zoom, hash: run.hash }));
ok('the answer is rendered as DOM with the trace and a way back',
  /<strong>Gallatin County<\/strong>/.test(run.answerHtml) && /<li>/.test(run.answerHtml) && !/<script/i.test(run.answerHtml)
    && run.trace === 3 && run.restore && /2018-01-10/.test(run.text),
  JSON.stringify({ trace: run.trace, restore: run.restore, text: run.text.slice(0, 80) }));
ok('the conversation alternates and ends with the answer', run.roles === 'uauaua' && run.messages === 6, run.roles);

// The executors against the page's own numbers.
const series = await page.evaluate(async () => {
  const r = JSON.parse(await window.__assistant.exec('read_series', { level: 'county', units: [6], topic: 'dev', measures: null,
    derived: 'addressed_unbuilt_share', state: null, snapshots: { from: 28, to: 28 } }));
  await window.__dash.applyState({ view: 'ladder', level: 'county', selection: [6], snap: 28 });
  const tile = [...document.querySelectorAll('#panel .stat')].find((e) => /addressed, not built/.test(e.querySelector('.k')?.textContent || ''));
  return { value: r.points[0].value, date: r.points[0].date, covered: r.points[0].covered_units, detail: tile ? tile.querySelector('.d').textContent : '' };
});
const shown = Number((series.detail.match(/([\d.]+)% of parcels/) || [])[1]);
ok('read_series returns the number the Development view shows',
  Number.isFinite(shown) && Math.abs(series.value - shown) < 0.06 && series.date === '2026-09-04' && series.covered === 1,
  JSON.stringify({ series: series.value, shown, detail: series.detail }));
const tbl = await page.evaluate(async () => {
  const r = JSON.parse(await window.__assistant.exec('read_table', { table: 'holdings_top', columns: null,
    where: [{ col: 'county_n', op: '=', value: 6 }, { col: 's', op: '=', value: 19 }], group_by: null, aggregate: null,
    order_by: [{ col: 'rank', dir: 'asc' }], limit: 10, decode: true }));
  let err = '';
  try {
    await window.__assistant.exec('read_table', { table: 'holdings_top', columns: ['display_name'], where: null, group_by: null,
      aggregate: null, order_by: null, limit: 10, decode: true });
  } catch (e) { err = e.message; }
  return { cols: r.columns, rows: r.rows.length, first: r.rows[0], err, raw: JSON.stringify(r) };
});
ok('read_table decodes codes and withholds owner names',
  tbl.rows === 10 && !tbl.cols.includes('display_name') && tbl.first[0] === 'Gallatin' && tbl.first[1] === '2018-01-10'
    && /not available/.test(tbl.err) && !/display_name/.test(tbl.raw),
  JSON.stringify({ cols: tbl.cols, rows: tbl.rows, first: tbl.first, err: tbl.err }));
const place = await page.evaluate(async () => JSON.parse(await window.__assistant.exec('lookup_place', { query: 'Bozeman', kind: 'city' })));
ok('lookup_place finds a city with its county and township',
  place.candidates[0]?.kind === 'city' && place.candidates[0].county?.code === 6 && !!place.candidates[0].township && !!place.candidates[0].bbox,
  JSON.stringify(place.candidates[0]));

const restoredView = await page.evaluate(async () => {
  document.querySelector('.assist-actions-row .chip').click();
  await new Promise((r) => setTimeout(r, 1500));
  const st = window.__dash.getState();
  return { view: st.view, level: st.level, selection: st.selection };
});
ok('Restore my view returns to the state before the question',
  restoredView.view === 'ladder' && restoredView.level === 'township' && restoredView.selection.length === 0, JSON.stringify(restoredView));

const q2 = 'How many people live in Bozeman? population';
mock.script = scripted(q2);
const pop = await page.evaluate((q) => window.__assistant.ask(q), q2);
ok('an unanswerable question gets a plain answer without tools',
  pop.status === 'done' && pop.tools.length === 0 && /do not carry population/.test(pop.text), pop.text.slice(0, 80));
const q3 = 'error path: where is Atlantis county';
mock.script = scripted(q3);
const errp = await page.evaluate((q) => window.__assistant.ask(q), q3);
ok('a failed tool call goes back to the model as an error and the answer still arrives',
  errp.status === 'done' && errp.tools.length === 1 && errp.tools[0].ok === false && /Atlantis/.test(errp.text),
  JSON.stringify({ status: errp.status, tools: errp.tools.map((t) => [t.name, t.ok, t.summary.slice(0, 60)]) }));
mock.fail = 429;
const limited = await page.evaluate(async () => {
  const n = window.__assistant.conv.messages.length;
  const t = await window.__assistant.ask('one more');
  return { status: t.status, error: t.error, same: window.__assistant.conv.messages.length === n,
    shown: document.querySelector('.assist-turn:last-child .assist-status')?.textContent || '' };
});
mock.fail = 0;
ok('a refusal from the Worker is shown and the conversation rolls back',
  limited.status === 'error' && /limit/i.test(limited.error) && limited.same && /limit/i.test(limited.shown), JSON.stringify(limited));
await page.evaluate(() => document.getElementById('assist-close').click());
ok('closing the panel returns focus to the Ask button',
  await page.evaluate(() => document.getElementById('assist').hidden && document.activeElement?.id === 'assist-toggle'));

ok('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
