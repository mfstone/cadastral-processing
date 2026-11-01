// Batch-produce the five reports against a running preview:
//   npm run preview -- --port 4398 &  SMOKE_URL=http://127.0.0.1:4398 npm run reports:pdf
// Composes each report in the page, screenshots the preview, saves the CSV
// where there is one, and saves a PDF through the same print path the
// Save-as-PDF button uses (so what comes out is what a reader would get).
// KINDS=profile,trends limits the set; DARK=1 previews under the dark theme.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:4398';
const OUT = process.env.OUT || '/tmp/cadastral-reports';
fs.mkdirSync(OUT, { recursive: true });
const dark = process.env.DARK === '1';

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 1 });
await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
await p.waitForSelector('#panel .card svg', { timeout: 60000 });
await p.evaluate(() => { for (const x of document.querySelectorAll('#nav button')) if (x.textContent.trim() === 'Reports') x.click(); });
await new Promise((r) => setTimeout(r, 800));

const kinds = (process.env.KINDS || 'profile,trends,holdings,worksheet,activity').split(',');
for (const kind of kinds) {
  const t0 = Date.now();
  await p.evaluate((k) => {
    const s = document.getElementById('rpt-kind'); s.value = k; s.dispatchEvent(new Event('change'));
    if (k === 'profile') { const c = document.getElementById('rpt-county'); c.value = '6'; c.dispatchEvent(new Event('change')); }
    if (k === 'worksheet') { const c = document.getElementById('rpt-county'); c.value = ''; c.dispatchEvent(new Event('change')); }
    window.__report = null;
    document.getElementById('rpt-go').click();
  }, kind);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await p.evaluate(() => !!window.__report)) break;
  }
  const info = await p.evaluate(() => {
    const r = document.getElementById('report');
    return {
      title: window.__report?.title, rows: window.__report?.rows, csvHead: (window.__report?.csv || '').split('\n')[0],
      csvLines: (window.__report?.csv || '').split('\n').length - 1,
      secs: r.querySelectorAll('.rsec').length, svgs: r.querySelectorAll('svg').length,
      tables: r.querySelectorAll('table.data').length,
      tableRows: Array.from(r.querySelectorAll('table.data')).map((t) => t.tBodies[0].rows.length),
      h2: Array.from(r.querySelectorAll('h2')).map((h) => h.textContent),
      width: r.getBoundingClientRect().width,
      status: document.getElementById('rpt-status').textContent,
      pdfBtn: !document.getElementById('rpt-pdf').hidden, csvBtn: !document.getElementById('rpt-csv').hidden,
      dashes: Array.from(r.querySelectorAll('.stat .v')).map((e) => e.textContent).filter((t) => t === '--').length,
    };
  });
  console.log(`\n== ${kind} (${Date.now() - t0} ms)`);
  console.log(JSON.stringify(info, null, 1));
  await p.screenshot({ path: `${OUT}/${kind}${dark ? '-dark' : ''}.png`, fullPage: true });
  const pdf = await p.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(`${OUT}/${kind}.pdf`, pdf);
  if (info.csvHead) fs.writeFileSync(`${OUT}/${kind}.csv`, await p.evaluate(() => window.__report.csv));
}
console.log('errors:', JSON.stringify(errors));
await b.close();
