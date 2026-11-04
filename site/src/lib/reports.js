/* ---------------------------------------------------------------------------
   reports.js -- the six printable reports.

   Each report is composed in the page from the same published tables the
   views read, laid out as a paper document (Letter, one column, 7in of
   content) and handed to the browser's print engine for the PDF. There is no
   server to render on: the site is static files on Cloudflare Pages, so the
   PDF is made where the data already is, in the reader's browser, from the
   vintage they are looking at. Puppeteer's page.pdf() drives the same print
   path, which is how the smoke suite checks the output.

   The report is paper: it declares the light palette on itself (see
   `.report` in viz.css) and the charts read their colours from it, so a
   report generated in the dark theme still prints on white.

   Every number here is the dashboard's number -- the report functions take
   the same cubes and tables, with the county or period as an explicit
   argument instead of the map selection -- so a figure in a PDF can always
   be found on screen, and the other way round.
--------------------------------------------------------------------------- */

import { seriesOf, sumAt } from './data.js';
import * as C from './charts.js';

const { fmtInt, fmtAc, fmtPct } = C;
const today = () => new Date().toISOString().slice(0, 10);
const cssVar = (n) => C.cssVar(n);

export const CONTACT_URL = 'https://www.epistemegeospatial.com/contact';

/** The catalogue: what the form offers, and what each report needs to know. */
export const REPORTS = {
  profile: {
    label: 'County profile', needs: ['county'],
    blurb: 'One county, every view: parcels and acres over the whole series, the development ladder and '
      + 'dormant inventory, ownership and out-of-state share, churn, new-lot sizes against the statutory '
      + 'lines, large holdings and CLO4, and the review queue. For a county planning office or a '
      + 'conservation district.',
  },
  condition: {
    label: 'Housing condition profile', needs: ['county'],
    blurb: 'One county’s dwellings as the Department of Revenue’s appraisers recorded them: condition, '
      + 'year built and type, the townships where the poorer housing is, and what the building records '
      + 'say about the development ladder, at eight tax years from three ORION exports.',
  },
  trends: {
    label: 'Statewide trends brief', needs: [],
    blurb: 'The headline series with their caveats: parcels created per year, the built share of old '
      + 'cohorts, out-of-state ownership and the concentration of large holdings. Short, chart-led, dated '
      + 'to the newest export.',
  },
  holdings: {
    label: 'Large-holdings update', needs: [],
    blurb: 'In the form of Haggerty et al. (2022): Table 1 for every county, the four largest holdings '
      + 'per county, CLO4 ranked, and the residuals against the published figures county by county, so '
      + 'the reproduction can be checked.',
  },
  worksheet: {
    label: 'Review worksheet (CSV)', needs: ['county-optional'], csv: true,
    blurb: 'The large holdings that rest on an unmade identity or tenure decision, as a CSV a reviewer '
      + 'marks up and feeds back through owner_overrides.csv. The one report that changes the numbers.',
  },
  activity: {
    label: 'Subdivision activity', needs: ['period'],
    blurb: 'For a chosen period: new lots per thousand parcels per year by county, and the pile-ups just '
      + 'above the 20-, 40- and 160-acre lines.',
  },
};

/* ------------------------------------------------------------------ pieces */
function div(host, cls, html) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (html) d.innerHTML = html;
  host.appendChild(d);
  return d;
}
function sec(host, title, caption, { long = false } = {}) {
  const s = div(host, 'rsec' + (long ? ' long' : ''));
  const h = document.createElement('h2');
  h.textContent = title;
  s.appendChild(h);
  if (caption) div(s, 'cap', caption);
  return s;
}
const note = (host, html) => div(host, 'rnote', html);
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function masthead(host, ctx, { kind, title, scope, extra = '' }) {
  const first = ctx.dim.snapshots[0].date, last = ctx.dim.snapshots[ctx.nSnaps - 1].date;
  div(host, 'mast', `
    <div class="eyebrow">Montana Cadastral Analytics Engine · ${esc(kind)}</div>
    <h1>${esc(title)}</h1>
    ${scope ? `<div class="scope">${esc(scope)}</div>` : ''}
    <div class="meta">Dated to the <strong>${last}</strong> export · ${ctx.nSnaps} vintages, ${first} to ${last}
      · generated ${today()}${extra ? ' · ' + esc(extra) : ''}</div>
    <div class="meta">Montana Cadastral Framework (Montana State Library, Department of Revenue) ·
      a project of Episteme Geospatial</div>`);
}

function colophon(host, ctx, extraCaveats = []) {
  const s = sec(host, 'Reading this report', null, { long: true });
  const items = [...extraCaveats, ...ctx.meta.caveats];
  div(s, 'rcaveats', `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <p>Definitions and the measured decisions behind each analysis are kept in the project’s findings
    log; the holdings method follows Haggerty, Epstein, Gosnell, Rose and Stone (2022),
    <em>Society &amp; Natural Resources</em> 35(6), doi:10.1080/08941920.2022.2038318. Questions and
    corrections: ${CONTACT_URL}. Generated from the dashboard at ${esc(location.origin + location.pathname)}.</p>`);
}

const snapLabels = (ctx) => ctx.dim.snapshots.map((s) => s.date.slice(0, 7));
const ivLabels = (ctx) => ctx.dim.intervals.map((i) =>
  ctx.dim.snapshots[i.a].date.slice(2, 7) + '→' + ctx.dim.snapshots[i.b].date.slice(2, 7));
const sum2 = (a, b) => Float64Array.from(a, (v, i) => v + b[i]);
const ratioSeries = (num, den) => Float64Array.from(num, (v, i) => (den[i] ? (100 * v) / den[i] : NaN));
const hAt = (c, m, u, s) => c.data[m]?.[u * c.nSnaps + s] ?? 0;
const hSer = (c, m, u) => Float64Array.from({ length: c.nSnaps }, (_, i) => hAt(c, m, u, i));
const col = (t) => (n) => t.columns.indexOf(n);
const pad2 = (n) => String(n).padStart(2, '0');

/** Ranked bars in two columns so fifty-six counties fit one page. */
function rankSplit(host, items, { color, fmt, caption, max }) {
  const grid = div(host, 'rgrid2');
  const half = Math.ceil(items.length / 2);
  [items.slice(0, half), items.slice(half)].forEach((part, i) => {
    if (!part.length) return;
    const cell = div(grid);
    C.rankBars(cell, { items: part, color, fmt, max, caption: `${caption} (${i ? 'continued' : 'ranked'})` });
  });
}

function statusText(ctx, code) {
  return ctx.dim.labels.review_status[code] || '';
}
function reasons(r, short = false) {
  const out = [];
  if (r.strong) out.push(short ? 'shared name/address' : 'shared name or address needs a decision');
  if (r.token) out.push(short ? 'token match' : 'name-token match');
  if (r.conflict) out.push(short ? 'tenure conflict' : 'point and area tenure disagree');
  if (r.oos) out.push('out-of-state');
  return out.join('; ');
}
const code = (v) => `<code>${esc(v)}</code>`;
async function topRows(ctx, s, counties = null) {
  const t = await ctx.loadTable('holdings_top');
  const c = col(t);
  const ci = c('county_n'), si = c('s');
  const want = counties ? new Set(counties) : null;
  const rows = [];
  for (const r of t.rows) {
    if (Number(r[si]) !== s) continue;
    const cn = Number(r[ci]);
    if (cn === 0 || (want && !want.has(cn))) continue;
    rows.push({
      county: cn, rank: Number(r[c('rank')]), name: r[c('display_name')],
      city: r[c('display_city')], state: r[c('display_state')],
      acres: Number(r[c('acres')]), acresMax: Number(r[c('acres_if_merged')]),
      parcels: Number(r[c('n_parcels')]), status: Number(r[c('review_status')]),
      names: Number(r[c('n_names')]), links: Number(r[c('pending_links')]),
      strong: Number(r[c('strong')]) > 0, token: Number(r[c('token')]) > 0,
      conflict: Number(r[c('conflict')]) > 0, oos: Number(r[c('oos')]) > 0,
      hash: r[c('group_hash')],
    });
  }
  return rows;
}
const pending = (r) => r.status === 2 || r.status === 3 || r.strong || r.conflict;
const mailsFrom = (r) => `${r.city || ''}${r.state ? ', ' + r.state : ''}`;
const acresRange = (r) => (r.acresMax > r.acres * 1.001 ? `${fmtInt(r.acres)} – ${fmtInt(r.acresMax)}` : fmtInt(r.acres));

/** Absorption: cohort -> age -> built share, for one county or the state. */
async function absorption(ctx, county = null) {
  const t = await ctx.loadTable('absorption');
  const c = col(t);
  const ci = c('county_n'), ki = c('cohort'), ai = c('age_idx'), di = c('dev_stage'),
    pi = c('parcels'), oi = c('observed');
  const agg = new Map();
  for (const r of t.rows) {
    if (county != null && Number(r[ci]) !== county) continue;
    const coh = Number(r[ki]), age = Number(r[ai]), st = Number(r[di]);
    if (!isFinite(coh) || coh <= 0 || st < 0) continue;
    const key = `${coh}|${age}`;
    const o = agg.get(key) || { built: 0, total: 0, observed: Number(r[oi]) };
    o.total += Number(r[pi]);
    if (st === 2) o.built += Number(r[pi]);
    agg.set(key, o);
  }
  return agg;
}

function absorptionChart(host, ctx, agg, caption) {
  const cohorts = [...new Set([...agg.keys()].map((k) => Number(k.split('|')[0])))].sort((a, b) => a - b);
  const pick = [1, 5, 10, 16, 21].map((i) => cohorts[Math.min(i, cohorts.length - 1)])
    .filter((v, i, a) => v != null && a.indexOf(v) === i);
  const maxAge = 24;
  const series = pick.map((coh) => {
    const out = new Float64Array(maxAge).fill(NaN);
    for (let age = 0; age < maxAge; age++) {
      const o = agg.get(`${coh}|${age}`);
      if (o && o.total >= 20) out[age] = (100 * o.built) / o.total;
    }
    return out;
  });
  if (!series.length) return;
  C.lineChart(host, {
    series, labels: pick.map((c) => ctx.dim.snapshots[c]?.date.slice(0, 4) ?? String(c)),
    colors: C.ramp('ord5', 5).slice(0, series.length),
    xLabels: Array.from({ length: maxAge }, (_, i) => String(i)),
    fmt: (v) => fmtPct(v, 0), yMax: 100, caption,
  });
}

/* ============================================================ 1. profile */
async function profile(host, { county }, ctx) {
  const S = ctx.nSnaps - 1;
  const name = ctx.countyName(county);
  const c = await ctx.countyCube();
  const f = await ctx.countyFlow();
  const h = await ctx.holdingsCube();
  const U = [county];
  const ser = (m) => seriesOf(c, m, U);
  const xl = snapLabels(ctx), il = ivLabels(ctx);
  const dates = ctx.dim.snapshots.map((s) => s.date);
  const idx = [...Array(ctx.nSnaps).keys()];

  const cov = ser('coverage_ok');
  const firstOk = cov.findIndex((v) => v > 0);
  masthead(host, ctx, {
    kind: 'county profile', title: `${name} County`,
    scope: 'Parcels, ownership, development, churn, subdivision and large holdings, over every vintage',
    extra: firstOk > 0 ? `record complete from ${dates[firstOk]}` : '',
  });

  // ---- headline
  const parcels = ser('parcels'), acres = ser('acres'), priv = ser('acres_private');
  const dev = [0, 1, 2, 4].map((i) => ser(`n_dev${i}`));
  const loc = [0, 1, 2, 3, 4].map((i) => ser(`n_loc${i}`));
  const locTot = loc.reduce((a, b) => sum2(a, b));
  const outShare = ratioSeries(sum2(loc[3], loc[4]), locTot);
  const dm = await ctx.loadTable('dormant');
  const dc = col(dm);
  const drow = dm.rows.find((r) => Number(r[dc('county_n')]) === county);
  const dormantLots = drow ? Number(drow[dc('dormant_lt40ac')]) : 0;
  const dormantAged = drow ? Number(drow[dc('dormant_lt40ac_ge_5y')]) : 0;
  const dormantAge = drow ? Number(drow[dc('dormant_lt40ac_median_age')]) : NaN;
  const ladderTot = dev[0][S] + dev[1][S] + dev[2][S];
  const s0 = sec(host, `At the ${dates[S]} export`);
  C.stats(s0, [
    { value: fmtInt(parcels[S]), label: 'parcels', detail: `${fmtAc(acres[S])} · ${fmtAc(priv[S])} private` },
    { value: fmtPct(ladderTot ? (100 * dev[2][S]) / ladderTot : NaN), label: 'of parcels built',
      detail: `${fmtInt(dev[1][S])} addressed, not built · ${fmtInt(dev[0][S])} platted only` },
    { value: fmtPct(outShare[S]), label: 'of parcels owned from out of state', detail: 'mailing address, or unknown' },
    { value: fmtInt(hAt(h, 'large_owners', county, S)), label: 'owners of 640+ acre holdings',
      detail: `${fmtAc(hAt(h, 'large_acres', county, S))} · CLO4 ${fmtPct(100 * hAt(h, 'clo4', county, S), 0)}` },
    { value: fmtInt(dormantLots), label: 'dormant lots under 40 acres',
      detail: `${fmtInt(dormantAged)} at five years or more` },
  ]);

  // ---- 1. parcels and acres
  const s1 = sec(host, 'Parcels and acres over the series',
    'Every vintage. Early growth is coverage arriving as much as land being divided: '
    + (firstOk > 0 ? `the county’s record is complete from ${dates[firstOk]}.` : 'the record is complete from the first vintage.'));
  C.lineChart(s1, { series: [parcels], labels: ['parcels'], colors: [cssVar('--cat-3')], xLabels: xl, fmt: fmtInt, caption: 'Parcels' });
  C.lineChart(s1, { series: [acres, priv], labels: ['all parcels', 'private'], colors: [cssVar('--cat-3'), cssVar('--cat-1')],
    xLabels: xl, fmt: fmtAc, caption: 'Acres' });

  // ---- 2. the ladder
  const known = idx.filter((i) => dev[0][i] + dev[1][i] + dev[2][i] > 0);
  const left = idx.filter((i) => !known.includes(i)).map((i) => dates[i]);
  const s2 = sec(host, 'The development ladder',
    'Platted only → address assigned → assessed building value. A parcel with a house number carries a '
    + 'building 89–91% of the time. Dedicated common areas are off the ladder.'
    + (left.length ? ` The ${left.join(', ')} export carries no building values and is left out.` : ''));
  C.stackedArea(s2, {
    series: dev.slice(0, 3).map((s) => known.map((i) => s[i])), labels: ['platted only', 'addressed', 'built'],
    colors: C.ramp('ord3', 3), xLabels: known.map((i) => xl[i]), share: true, fmt: fmtInt,
    caption: 'Ladder composition, share of parcels',
  });
  note(s2, `${fmtInt(dev[3][S])} parcels are dedicated common area (open space, parks, HOA and condominium tracts) and are counted apart.`);

  const agg = await absorption(ctx, county);
  const s2b = sec(host, 'Absorption: share of a cohort built, by age',
    'Of the lots created at each vintage in this county, the share carrying an assessed building N years later. '
    + 'Cohorts with fewer than twenty lots at an age are left blank. The age-0 and age-1 points are inflated by '
    + 'splits that hand an existing house to a child parcel (statewide, a third of new lots with a dwelling; the housing '
    + 'condition profile gives this county’s share), and a January export carries the previous year’s roll, so a '
    + 'cohort’s built share can run up to a year behind.');
  absorptionChart(s2b, ctx, agg, `Absorption by cohort and age in years, ${name} County`);

  const bs = await ctx.loadTable('dormant_by_size');
  const bc = col(bs);
  const SIZE_LAB = { lt1: '<1 ac', '1_5': '1–5', '5_20': '5–20', '20_40': '20–40', '40_160': '40–160', '160_640': '160–640', gt640: '>640' };
  const sizes = bs.rows.filter((r) => Number(r[bc('county_n')]) === county)
    .map((r) => ({ label: SIZE_LAB[r[bc('size_class')]] || String(r[bc('size_class')]), value: Number(r[bc('parcels')]),
      acres: Number(r[bc('acres')]) }));
  const s2c = sec(host, 'Dormant platted inventory',
    'Parcels still at the bottom of the ladder, no house number and no building, whose creation was observed in '
    + 'the series. Stage 0 is the normal permanent state of a working ranch tract, so the under-40-acre band is '
    + 'the residential-lot proxy.');
  C.stats(s2c, [
    { value: fmtInt(dormantLots), label: 'dormant lots under 40 acres' },
    { value: fmtInt(dormantAged), label: 'of them dormant five years or more' },
    { value: isFinite(dormantAge) ? `${dormantAge.toFixed(0)} yr` : '--', label: 'median age of a dormant lot' },
  ]);
  if (sizes.length) {
    C.table(s2c, { headers: ['size class', 'dormant parcels', 'acres'],
      rows: sizes.map((d) => [d.label, fmtInt(d.value), fmtAc(d.acres)]), caption: 'Dormant parcels by size class' });
  }

  // ---- 3. ownership
  const s3 = sec(host, 'Ownership',
    'Tenure from the public-lands layer and owner names; the owner’s distance from the land from the mailing '
    + 'address on the record. “Out of state” includes owners whose state is unknown.');
  const ten = [0, 1, 2].map((i) => ser(`ac_ten${i}`));
  C.stackedArea(s3, { series: ten, labels: ['public domain', 'tribal trust', 'private'],
    colors: [cssVar('--cat-1'), cssVar('--cat-2'), cssVar('--cat-3')], xLabels: xl, share: true, fmt: fmtAc,
    caption: 'Tenure, share of acreage' });
  C.stackedArea(s3, { series: [sum2(loc[0], loc[1]), loc[2], sum2(loc[3], loc[4])],
    labels: ['in the county', 'elsewhere in Montana', 'out of state / unknown'], colors: C.ramp('ord3', 3),
    xLabels: xl, share: true, fmt: fmtInt, caption: 'Owner distance, share of parcels' });
  const acLoc = [0, 1, 2, 3, 4].map((i) => ser(`ac_loc${i}`));
  const outAcres = ratioSeries(sum2(acLoc[3], acLoc[4]), acLoc.reduce((a, b) => sum2(a, b)));
  C.lineChart(s3, { series: [outShare, outAcres], labels: ['share of parcels', 'share of acres'],
    colors: [cssVar('--cat-3'), cssVar('--cat-2')], xLabels: xl, fmt: (v) => fmtPct(v, 1), yMax: 100,
    caption: 'Out-of-state share' });
  const os = await ctx.loadTable('county_owner_state');
  const oc = col(os);
  const acc = new Map();
  for (const r of os.rows) {
    if (Number(r[oc('s')]) !== S || Number(r[oc('county_n')]) !== county) continue;
    const st = ctx.dim.states[Number(r[oc('st')])];
    if (!st || st === 'MT' || st.length !== 2 || /\d/.test(st)) continue;
    acc.set(st, (acc.get(st) || 0) + Number(r[oc('parcels')]));
  }
  const origins = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([st, v]) => ({ label: st, value: v }));
  if (origins.length) {
    const s3b = sec(host, 'Where out-of-state owners mail from', `Parcels at the ${dates[S]} export, by the owner’s mailing state.`);
    C.rankBars(s3b, { items: origins, color: cssVar('--cat-2'), fmt: fmtInt, caption: 'Out-of-state owner origins' });
  }

  // ---- 4. churn
  const nIv = ctx.nIv;
  const rate = new Float64Array(nIv), trans = new Float64Array(nIv), addr = new Float64Array(nIv), units = new Float64Array(nIv);
  for (let i = 0; i < nIv; i++) {
    const y = ctx.dim.intervals[i]?.years || 1;
    const p = sumAt(f, 'persisted', i, U), ch = sumAt(f, 'owner_changed', i, U);
    const ok = sumAt(f, 'comparable', i, U) > 0;
    rate[i] = ok && p > 50 ? (100 * ch) / p / y : NaN;
    trans[i] = ok ? sumAt(f, 'transfers_out_of_state', i, U) / y : NaN;
    addr[i] = ok ? sumAt(f, 'address_change_only', i, U) / y : NaN;
    units[i] = ok ? sumAt(f, 'unit_created', i, U) / y : NaN;
  }
  const s4 = sec(host, 'Churn',
    'Owner turnover is the share of parcels persisting across an interval whose normalised owner changed, '
    + 'annualised on the real day count. A mailing-state change on an unchanged owner is an address edit, not a '
    + 'sale. Intervals in which the county’s record is not comparable are left blank.');
  C.lineChart(s4, { series: [rate], labels: ['owner change, % per year'], colors: [cssVar('--cat-1')], xLabels: il,
    fmt: (v) => fmtPct(v, 1), caption: 'Owner turnover' });
  C.lineChart(s4, { series: [trans, addr], labels: ['transfer to another state', 'address change only'],
    colors: [cssVar('--cat-1'), cssVar('--cat-2')], xLabels: il, fmt: fmtInt,
    caption: 'Interstate transfers against address edits, per year' });
  C.lineChart(s4, { series: [units], labels: ['condominium units created per year'], colors: [cssVar('--cat-3')],
    xLabels: il, fmt: fmtInt, caption: 'Condominium units created per year' });

  // ---- 5. fragmentation
  const g = (ids) => ids.map((i) => ser(`ac_sz${i}`)).reduce((a, b) => sum2(a, b));
  const s5 = sec(host, 'Fragmentation',
    'Acreage by parcel-size class. Acreage leaving the large classes for the small ones is the fragmentation '
    + 'signature, and it is slow. Agricultural-use acreage is clamped to each parcel’s own area.');
  C.stackedArea(s5, { series: [g([1, 2]), g([3, 4]), g([5]), g([6]), g([7])],
    labels: ['<5 ac', '5–40 ac', '40–160 ac', '160–640 ac', '>640 ac'], colors: C.ramp('ord5', 5),
    xLabels: xl, share: true, fmt: fmtAc, caption: 'Size-class composition of acreage' });
  const ag = ser('ag_acres'), agOk = ser('ag_available');
  for (let i = 0; i < ag.length; i++) if (!(agOk[i] > 0)) ag[i] = NaN;
  C.lineChart(s5, { series: [ag], labels: ['agricultural-use acres'], colors: [cssVar('--cat-3')], xLabels: xl,
    fmt: fmtAc, caption: 'Agricultural-use acreage' });

  // ---- 6. thresholds
  const ch = await ctx.loadTable('county_size_histogram');
  const hc = col(ch);
  const bins = new Map();
  for (const r of ch.rows) {
    if (Number(r[hc('county_n')]) !== county) continue;
    const L = Number(r[hc('bin_lo')]);
    if (!(L >= 10 && L < 32)) continue;
    bins.set(L, (bins.get(L) || 0) + Number(r[hc('parcels')]));
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  const ed = await ctx.loadTable('threshold_edges');
  const ec = col(ed);
  const tot = { lots: 0 };
  for (const e of [20, 40, 160]) { tot[`below${e}`] = 0; tot[`above${e}`] = 0; }
  const lotsByIv = new Float64Array(nIv);
  for (const r of ed.rows) {
    if (Number(r[ec('county_n')]) !== county) continue;
    tot.lots += Number(r[ec('lots')]);
    for (const e of [20, 40, 160]) {
      tot[`below${e}`] += Number(r[ec(`below${e}`)]);
      tot[`above${e}`] += Number(r[ec(`above${e}`)]);
    }
    const i = Number(r[ec('interval')]);
    if (i >= 0 && i < nIv) lotsByIv[i] += Number(r[ec('lots')]);
  }
  const s6 = sec(host, 'New lots against the statutory lines',
    'Sizes of parcels created by land division in this county over the whole series (condominium units and '
    + 'coverage arriving are excluded). Under MCA 76-4-102(25) a subdivision is a division creating a parcel under 20 acres, '
    + 'and under 76-4-103 a parcel of 20 acres or more (exclusive of public roadways) is not subject to DEQ sanitation review; the Subdivision and Platting Act regulates '
    + 'divisions creating parcels under 160 acres. Mass just above a line is lots sized to clear it.');
  if (keys.length) {
    const refIdx = keys.findIndex((k) => k >= 20);
    C.histogram(s6, { values: keys.map((k) => bins.get(k)), xLabels: keys.map((k) => (Number.isInteger(k) ? String(k) : k.toFixed(1))),
      color: cssVar('--cat-1'), refAt: refIdx < 0 ? null : refIdx, refLabel: '20 ac', xTickEvery: 4,
      caption: 'Created-parcel sizes, 10–32 acres' });
  }
  const sw = ctx.meta.thresholds || {};
  C.table(s6, {
    headers: ['line', 'window', 'just below', 'just above', 'above ÷ below', 'statewide'],
    rows: [20, 40, 160].map((e) => {
      const w = sw[`${e}_acre_edge`]?.window_acres ?? Math.max(1, e * 0.03);
      const b = tot[`below${e}`], a = tot[`above${e}`];
      return [`${e} acres`, `± ${w} ac`, fmtInt(b), fmtInt(a), b + a >= 20 ? (a / Math.max(1, b)).toFixed(2) : 'too few',
        sw[`${e}_acre_edge`] ? sw[`${e}_acre_edge`].above_over_below.toFixed(2) : '--'];
    }),
    caption: `Edge test over the whole series, ${fmtInt(tot.lots)} parcels created by division`,
  });
  const per1k = new Float64Array(nIv);
  for (let i = 0; i < nIv; i++) {
    const iv = ctx.dim.intervals[i];
    const stock = parcels[iv.a], ok = sumAt(f, 'comparable', i, U) > 0;
    per1k[i] = ok && stock > 50 ? (1000 * lotsByIv[i]) / stock / (iv.years || 1) : NaN;
  }
  C.lineChart(s6, { series: [per1k], labels: ['new lots per 1,000 parcels per year'], colors: [cssVar('--cat-1')],
    xLabels: il, fmt: (v) => v.toFixed(1), caption: 'Rate of land division' });

  // ---- 7. holdings
  const lo = hSer(h, 'large_owners', county), lom = hSer(h, 'large_owners_max', county);
  const la = hSer(h, 'large_acres', county), lam = hSer(h, 'large_acres_max', county);
  const pa = hSer(h, 'private_acres', county), clo = Float64Array.from(hSer(h, 'clo4', county), (v) => 100 * v);
  const prov = hSer(h, 'large_provisional', county), provAc = hSer(h, 'large_provisional_acres', county);
  const oosAc = hSer(h, 'large_oos_acres', county), oosN = hSer(h, 'large_oos_owners', county);
  const s7 = sec(host, 'Large private holdings',
    'A holding is one owner’s consolidated private acreage within the county; large is 640 acres or more. '
    + 'The document tier applies the consolidation rule as far as it can be automated; the maximal tier accepts '
    + 'every pending review flag. A manual review lands between them.');
  C.stats(s7, [
    { value: fmtInt(lo[S]), label: 'owners of 640+ acre holdings', detail: `${fmtInt(lom[S])} if every pending review were accepted` },
    { value: fmtAc(la[S]), label: 'acres in large holdings', detail: `${fmtPct(pa[S] ? (100 * la[S]) / pa[S] : NaN)} of private acreage · up to ${fmtAc(lam[S])}` },
    { value: `${fmtInt(lo[S] ? la[S] / lo[S] : NaN)} ac`, label: 'mean large holding' },
    { value: fmtPct(clo[S], 0), label: 'CLO4', detail: 'share of large-holding acreage in the four largest' },
    { value: fmtPct(la[S] ? (100 * oosAc[S]) / la[S] : NaN), label: 'of large acreage mailed out of state', detail: `${fmtInt(oosN[S])} owners` },
    { value: fmtInt(prov[S]), label: 'large holdings awaiting review', detail: `${fmtAc(provAc[S])} rests on an unmade decision` },
  ]);
  C.lineChart(s7, { series: [lo, lom], labels: ['document tier', 'maximal tier'], colors: [cssVar('--cat-3'), cssVar('--ord3-2')],
    xLabels: xl, fmt: fmtInt, caption: 'Owners of large holdings' });
  C.lineChart(s7, { series: [la, lam], labels: ['document tier', 'maximal tier'], colors: [cssVar('--cat-3'), cssVar('--ord3-2')],
    xLabels: xl, fmt: fmtAc, caption: 'Acres in large holdings' });
  C.lineChart(s7, { series: [clo], labels: ['CLO4'], colors: [cssVar('--cat-3')], xLabels: xl, fmt: (v) => fmtPct(v, 0), yMax: 100,
    caption: 'Four-property concentration ratio' });
  C.lineChart(s7, { series: [hSer(h, 'top1_acres', county), hSer(h, 'top2_acres', county)], labels: ['largest holding', 'second largest'],
    colors: [cssVar('--cat-3'), cssVar('--cat-2')], xLabels: xl, fmt: fmtAc, caption: 'The two largest holdings' });
  const top = (await topRows(ctx, S, [county])).sort((a, b) => a.rank - b.rank);
  const s7b = sec(host, `The four largest holdings, ${dates[S]}`,
    'Owner of record as the cadastral record names it. A range of acres means a pending merge would add the difference.');
  C.table(s7b, { headers: ['#', 'owner of record', 'mails from', 'acres', 'parcels', 'status'],
    rows: top.filter((r) => r.rank <= 4).map((r) => [String(r.rank), r.name, mailsFrom(r), acresRange(r), fmtInt(r.parcels), statusText(ctx, r.status)]),
    caption: 'Largest private holdings in the county' });

  // ---- 8. review
  const queue = top.filter(pending).sort((a, b) => (b.acresMax - b.acres) - (a.acresMax - a.acres) || b.acres - a.acres);
  const s8 = sec(host, 'Review queue',
    'Large holdings whose acreage rests on an unmade identity or tenure decision, among the ten largest in the '
    + 'county. The pipeline never merges two owners on a judgment call; a reviewer records one in '
    + 'owner_overrides.csv as merge or keep, with a reason and date, and the identity stage applies it on its next run. '
    + 'The review worksheet report exports these rows as a CSV.', { long: true });
  if (queue.length) {
    C.table(s8, { headers: ['owner of record', 'mails from', 'acres', 'if merged', 'parcels', 'names', 'status', 'why', 'group'],
      rows: queue.map((r) => [r.name, mailsFrom(r), fmtInt(r.acres), fmtInt(r.acresMax), fmtInt(r.parcels), String(r.names),
        statusText(ctx, r.status), reasons(r, true), code(r.hash)]),
      caption: 'Flagged large holdings. Why: shared name/address = a shared name or address needs a decision; token match = '
        + 'name-token match only; tenure conflict = the point and area tests disagree on a parcel.', html: true });
  } else {
    note(s8, 'No flagged holdings among the ten largest in this county at this vintage. Smaller flagged holdings may exist; the published list is capped at ten per county.');
  }

  colophon(host, ctx, [
    'Figures in this profile are the county’s own; ratios (CLO4, shares) are computed within the county and are not comparable to a statewide ratio by subtraction.',
  ]);
  return { title: `${name} County cadastral profile ${dates[S]}` };
}

/* ================================================= 1b. housing condition */
/*
   The DOR's building records (stage 11): eight tax years from three ORION
   exports, each joined to the parcel export carrying its roll. The headline
   is the newest point; the series and the point-to-point re-ratings have a
   section of their own. The rating is CDU through 2014 and the DOR's
   physical-condition component after, named per point.
*/
const CD_COLS = [...Array(8).keys()].map((i) => `n_cd${i}`);
const YB_COLS = [...Array(9).keys()].map((i) => `n_yb${i}`);
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const rowObj = (t, r) => Object.fromEntries(t.columns.map((c, i) => [c, num(r[i])]));
const pctOf = (n, d) => (d ? (100 * n) / d : NaN);
const shortCond = (l) => String(l).replace(/ \(\d+\)/, '');
const ratedOf = (o) => CD_COLS.reduce((a, n) => a + o[n], 0);
const belowOf = (o) => pctOf(o.n_cd0 + o.n_cd1 + o.n_cd2 + o.n_cd3, ratedOf(o));
const ybTot = (o) => YB_COLS.reduce((a, n) => a + o[n], 0);
const pre1980Of = (o) => pctOf(o.n_yb0 + o.n_yb1 + o.n_yb2 + o.n_yb3 + o.n_yb4, ybTot(o));

async function condition(host, { county }, ctx) {
  const name = ctx.countyName(county);
  const cm = ctx.meta.cama || {};
  const ty = cm.tax_year || 2026;
  const L = ctx.dim.labels.condition || [];
  const YBL = ctx.dim.labels.year_built || [];
  const [cty, twp, tim, cbd, tr] = await Promise.all(
    ['cama_county', 'cama_township', 'cama_timing', 'cama_condition_decade', 'cama_transitions'].map((n) => ctx.loadTable(n)));
  const cc = col(cty);
  // The series points, newest last; the headline is the newest, the series section has them all.
  const points = [...new Set(cty.rows.map((x) => num(x[cc('s')])))].sort((a, b) => a - b);
  const sNew = points[points.length - 1];
  const pmeta = (sp) => (cm.points || []).find((p) => p.s === sp) || {};
  const tyOf = (sp) => pmeta(sp).tax_year ?? sp;
  const rowFor = (code, sp) => {
    const x = cty.rows.find((y) => num(y[cc('county_n')]) === code && num(y[cc('s')]) === sp);
    return x ? rowObj(cty, x) : null;
  };
  const c = rowFor(county, sNew), s = rowFor(0, sNew);
  if (!c || !s) throw new Error(`no building records for county ${county}`);
  const last = ctx.dim.snapshots[ctx.nSnaps - 1].date;
  const pointDate = ctx.dim.snapshots[sNew]?.date ?? last;

  masthead(host, ctx, {
    kind: 'housing condition profile', title: `${name} County`,
    scope: 'Dwellings on record with the Department of Revenue: their condition, age and type, and what '
      + 'the appraiser’s records say about the development ladder',
    extra: `DOR building records at tax year ${ty} (export ${pointDate}, refresh ${cm.refresh_date || 'n/a'}); `
      + `series ${points.map(tyOf).join(', ')}`,
  });

  const s0 = sec(host, `Dwellings on record, tax year ${ty}`);
  C.stats(s0, [
    { value: fmtInt(c.dwellings), label: 'parcels with a dwelling',
      detail: `${fmtInt(c.n_dwell_total)} dwellings · ${fmtInt(c.rated)} rated` },
    { value: fmtPct(belowOf(c)), label: 'rated fair or worse', detail: `statewide ${fmtPct(belowOf(s))}` },
    { value: fmtInt(c.n_cd0 + c.n_cd1), label: 'unsound or very poor',
      detail: `${fmtPct(pctOf(c.n_cd0 + c.n_cd1, ratedOf(c)))} of rated · statewide ${fmtPct(pctOf(s.n_cd0 + s.n_cd1, ratedOf(s)))}` },
    { value: c.yb_median > 0 ? String(Math.round(c.yb_median)) : '--', label: 'median year built',
      detail: `${fmtPct(pre1980Of(c))} built before 1980 · statewide ${fmtPct(pre1980Of(s))}` },
    { value: fmtPct(pctOf(c.mh, c.dwellings)), label: 'manufactured homes',
      detail: `${fmtInt(c.condo_th)} condominium or townhouse · ${fmtInt(c.partial)} partly complete` },
  ]);
  note(s0, 'Through tax year 2014 the DOR filled CDU, the composite condition–desirability–utility rating its data '
    + 'dictionary describes. At the 2015 reappraisal it retired the composite by copying it into four components and '
    + `has rated them apart since; in this refresh CDU carries ${fmtInt(cm.orion?.dwelling_rows_with_cdu ?? 0)} of `
    + `${fmtInt(cm.orion?.dwelling_rows ?? 0)} dwelling rows. The condition reported from 2015 is the physical-condition `
    + 'component, on the same scale, for the principal dwelling on each parcel; the 2014 point is CDU.');

  const s1 = sec(host, 'Condition of the principal dwelling',
    `The DOR’s rating at tax year ${ty}, assigned at inspection on a scale from Unsound (1) to Excellent (10).`);
  C.histogram(s1, { values: CD_COLS.map((n) => c[n]), xLabels: L.map(shortCond), color: cssVar('--cat-1'),
    xTickEvery: 1, caption: 'Dwellings by condition class' });
  C.table(s1, { headers: ['condition', 'dwellings', 'share', 'statewide share'],
    rows: CD_COLS.map((n, i) => [L[i], fmtInt(c[n]), fmtPct(pctOf(c[n], ratedOf(c))), fmtPct(pctOf(s[n], ratedOf(s)))]),
    caption: 'Condition classes, county against statewide' });

  const s2 = sec(host, 'When the dwellings were built', 'Earliest dwelling on the parcel, by the DOR’s year built.');
  C.histogram(s2, { values: YB_COLS.map((n) => c[n]), xLabels: YBL, color: cssVar('--cat-3'), xTickEvery: 1,
    caption: 'Dwellings by year built' });
  C.table(s2, { headers: ['built', 'dwellings', 'share', 'statewide share'],
    rows: YB_COLS.map((n, i) => [YBL[i], fmtInt(c[n]), fmtPct(pctOf(c[n], ybTot(c))), fmtPct(pctOf(s[n], ybTot(s)))]),
    caption: 'Year-built cohorts, county against statewide' });

  const s3 = sec(host, 'Condition by age',
    'Share of each year-built cohort in each condition class. Older housing should rate worse; where it does not, '
    + 'the stock has been rebuilt or the rating is stale.');
  const bc = col(cbd);
  const grid = [...Array(8)].map(() => new Float64Array(9));
  for (const r of cbd.rows) {
    if (num(r[bc('county_n')]) !== county || num(r[bc('s')]) !== sNew) continue;
    grid[num(r[bc('cond')])][num(r[bc('yb_bin')])] += num(r[bc('dwellings')]);
  }
  C.stackedArea(s3, { series: grid, labels: L.map(shortCond), colors: C.ramp('seq', 8).slice().reverse(),
    xLabels: YBL, share: true, caption: 'Condition by year-built cohort' });
  C.table(s3, { headers: ['built', 'rated dwellings', 'fair or worse'],
    rows: YBL.map((b, j) => {
      const tot = grid.reduce((a, g) => a + g[j], 0);
      return [b, fmtInt(tot), fmtPct(pctOf(grid[0][j] + grid[1][j] + grid[2][j] + grid[3][j], tot))];
    }), caption: 'Share rated fair or worse, by cohort' });

  const s3b = sec(host, 'Condition over the series',
    `Every point the three ORION refreshes give: tax years ${points.map(tyOf).join(', ')}, each joined to the parcel `
    + 'export that carries its roll. The 2014 point is the composite CDU and the rest the physical-condition component '
    + 'it was copied into, so the seam is a change of field, not of housing. No refresh is on hand between 2018 and 2024.');
  const serC = points.map((sp) => rowFor(county, sp) || {});
  const serS = points.map((sp) => rowFor(0, sp) || {});
  const xl = points.map((sp) => String(tyOf(sp)));
  C.stackedArea(s3b, { series: CD_COLS.map((n) => serC.map((o) => o[n] || 0)), labels: L.map(shortCond),
    colors: C.ramp('seq', 8).slice().reverse(), xLabels: xl, share: true, xTickEvery: 1,
    caption: `Condition composition by tax year, ${name} County` });
  C.lineChart(s3b, { series: [serC.map((o) => (o.dwellings ? belowOf(o) : NaN)), serS.map((o) => (o.dwellings ? belowOf(o) : NaN))],
    labels: [name, 'Montana'], colors: [cssVar('--cat-1'), cssVar('--cat-3')], xLabels: xl, fmt: (v) => fmtPct(v),
    xTickEvery: 1, caption: 'Share rated fair or worse, by tax year' });
  C.table(s3b, { headers: ['tax year', 'rating field', 'rated dwellings', 'fair or worse', 'statewide', 'unsound or very poor', 'median year built'],
    rows: points.map((sp, i) => [String(tyOf(sp)), pmeta(sp).rating_field || '', fmtInt(ratedOf(serC[i])), fmtPct(belowOf(serC[i])),
      fmtPct(belowOf(serS[i])), fmtInt((serC[i].n_cd0 || 0) + (serC[i].n_cd1 || 0)), serC[i].yb_median > 0 ? String(Math.round(serC[i].yb_median)) : '--']),
    caption: 'The series, county against statewide' });
  const trc = col(tr);
  const trRows = (code) => tr.rows.filter((x) => num(x[trc('county_n')]) === code).map((x) => rowObj(tr, x)).sort((p, q) => p.s - q.s);
  const trC = trRows(county), trS = trRows(0);
  if (trC.length) {
    C.table(s3b, { headers: ['interval', 'dwellings followed', 'same', 'worse', 'better', 'two or more steps worse', 'statewide worse'],
      rows: trC.map((t) => {
        const st = trS.find((x) => x.s_from === t.s_from && x.s === t.s) || {};
        return [`${tyOf(t.s_from)} → ${tyOf(t.s)}`, fmtInt(t.n), fmtPct(pctOf(t.same, t.n)), fmtPct(pctOf(t.worse, t.n)),
          fmtPct(pctOf(t.better, t.n)), fmtPct(pctOf(t.worse2plus, t.n)), fmtPct(pctOf(st.worse, st.n))];
      }),
      caption: 'The same dwellings re-rated, point to point: single-dwelling properties rated at both ends, followed by the DOR’s property id' });
  }

  const tc = col(twp);
  const tw = twp.rows.filter((r) => num(r[tc('county_n')]) === county && num(r[tc('s')]) === sNew).map((r) => {
    const o = rowObj(twp, r);
    const t = ctx.dim.townships[o.u];
    return { label: t ? t.label : String(o.u), rated: ratedOf(o), v: belowOf(o) };
  }).filter((d) => d.rated >= 25 && isFinite(d.v)).sort((a, b) => b.v - a.v);
  if (tw.length) {
    const s4 = sec(host, 'Where the housing in poorer condition is',
      'Townships in the county with at least 25 rated dwellings, by the share rated fair or worse. A township '
      + 'straddling a county line is listed under the county that holds most of its parcels.');
    rankSplit(s4, tw.slice(0, 24).map((d) => ({ label: d.label, value: d.v, detail: `${fmtInt(d.rated)} rated` })),
      { color: cssVar('--cat-1'), fmt: (v) => fmtPct(v), caption: 'Share rated fair or worse, by township' });
  }

  const s5 = sec(host, 'What the appraiser’s records say about the development ladder',
    'The dashboard’s ladder reads two inferred signals from the parcel layer: an assessed building value and a '
    + 'situs house number. The DOR’s dwelling, commercial and outbuilding records are the appraiser’s own, keyed on '
    + 'the same geocode, and the State Library’s Structures Framework places an address point on the structure itself. '
    + 'Each row is a test with a count on both sides, the statewide figure beside it.');
  const vacant = (o) => o.parcels_tested - o.improved_layer - o.dor_only;
  const tests = [
    { t: 'Parcels where the two records agree, built or not', pct: true,
      a: pctOf(c.agree_built + vacant(c), c.parcels_tested), b: pctOf(s.agree_built + vacant(s), s.parcels_tested),
      n: `${fmtInt(c.parcels_tested)} parcels tested` },
    { t: 'Built per the parcel layer, no DOR structure', pct: false, a: c.layer_only, b: s.layer_only,
      n: `${fmtPct(pctOf(c.layer_only, c.improved_layer))} of parcels with a building value` },
    { t: 'DOR structure, parcel layer unimproved', pct: false, a: c.dor_only, b: s.dor_only,
      n: `${fmtPct(pctOf(c.dor_only, c.struct_dor))} of parcels with a DOR structure` },
    { t: 'House numbers that carry a dwelling', pct: true,
      a: pctOf(c.hn_dwell, c.hn_dwell + c.hn_nodwell), b: pctOf(s.hn_dwell, s.hn_dwell + s.hn_nodwell),
      n: `${fmtInt(c.nohn_dwell)} dwellings without a house number` },
    ...(c.addr_tested > 0 ? [
      { t: 'House numbers with an address point on the parcel (Structures Framework)', pct: true,
        a: pctOf(c.addr_hn_pt, c.addr_hn_pt + c.addr_hn_nopt), b: pctOf(s.addr_hn_pt, s.addr_hn_pt + s.addr_hn_nopt),
        n: `${fmtInt(c.addr_pt_nohn)} address points on parcels without a house number` },
      { t: 'Dwellings on record with a residential address point', pct: true,
        a: pctOf(c.addr_dw_res, c.addr_dw_res + c.addr_dw_nores), b: pctOf(s.addr_dw_res, s.addr_dw_res + s.addr_dw_nores),
        n: `${fmtInt(c.addr_res_nodw)} residential points on parcels with no dwelling on record` }] : []),
    { t: 'Dwellings built 2004 on, on the ladder by the first export that could carry them', pct: true,
      a: pctOf(c.timing_ontime, c.timing_n), b: pctOf(s.timing_ontime, s.timing_n),
      n: `${fmtInt(c.timing_never)} of ${fmtInt(c.timing_n)} never seen` },
    { t: 'Dormant lots under 40 acres that carry a dwelling', pct: false, a: c.dormant_dwell, b: s.dormant_dwell,
      n: `of ${fmtInt(c.dormant_lt40)} dormant lots · ${fmtInt(c.dormant_permit)} hold a new-dwelling permit` },
    { t: 'Addressed, not built, but a dwelling on record', pct: false, a: c.stage1_dwell, b: s.stage1_dwell,
      n: `of ${fmtInt(c.stage1)} parcels at the addressed stage` },
    { t: 'New lots (plat or split) whose dwelling is older than the lot', pct: true,
      a: pctOf(c.born_older, c.born_dwell), b: pctOf(s.born_older, s.born_dwell),
      n: `${fmtInt(c.born_older)} of ${fmtInt(c.born_dwell)} new lots with a dwelling` },
    { t: 'Building values equal to the DOR final value', pct: true,
      a: pctOf(c.value_equal, c.value_n), b: pctOf(s.value_equal, s.value_n),
      n: `${fmtInt(c.value_n)} parcels, tax year ${cm.witness?.building_value_witness?.tax_year ?? ty}` },
    { t: 'Dwellings inspected within five years', pct: true,
      a: pctOf(c.insp_recent, c.dwellings), b: pctOf(s.insp_recent, s.dwellings), n: '' },
  ];
  C.table(s5, { headers: ['test', name, 'Montana', 'note'],
    rows: tests.map((x) => [x.t, x.pct ? fmtPct(x.a) : fmtInt(x.a), x.pct ? fmtPct(x.b) : fmtInt(x.b), x.n]),
    caption: 'Witness tests, county against statewide' });
  const ti = col(tim);
  const names = ['earlier', 'on_time', 'late1', 'late2plus', 'never'];
  const by = new Map();
  for (const r of tim.rows) {
    if (num(r[ti('county_n')]) !== county || num(r[ti('s')]) !== sNew) continue;
    by.set(num(r[ti('yb')]), names.map((n) => num(r[ti(n)])));
  }
  const years = [...by.keys()].sort((a, b) => a - b);
  if (years.length) {
    C.stackedArea(s5, { series: names.map((_, i) => years.map((y) => by.get(y)[i])),
      labels: ['earlier structure on the parcel', 'on time', 'one roll late', 'two or more rolls late', 'never'],
      colors: C.ramp('ord5', 5), xLabels: years.map(String), share: true,
      caption: 'Dwellings by year built: when the ladder first showed a building value, in tax-year rolls' });
  }
  note(s5, 'A dwelling built in year Y goes on the Y+1 roll, and an export carries its own year’s roll only from '
    + 'July: the January exports still hold the previous year’s values. “On time” is the first export that could '
    + 'carry the dwelling; “earlier structure” means a value stood on the parcel before the year built; “never” is '
    + 'a miss, a dwelling the DOR holds that the parcel layer has not valued. The January export of the following '
    + 'year carries the roll, so the missing 2012 and 2015 exports cost no dwelling its on-time reading.');

  colophon(host, ctx, [
    'Dwelling condition, year built, permits and inspections come from three ORION refreshes joined into eight '
      + `tax years (${points.map(tyOf).join(', ')}); the headline figures are tax year ${ty}.`,
    'The condition is the principal dwelling’s (largest depreciated cost); the year built is the earliest '
      + 'dwelling on the parcel.',
    'Manufactured homes not attached to real property, and condominium units whose geocode is not a parcel, '
      + 'are DOR properties with no parcel and are outside every count here.',
    'A rating is as current as the last inspection; the share of dwellings inspected within five years is reported above.',
  ]);
  return { title: `${name} County housing condition ${last}` };
}

/* ============================================================= 2. trends */
async function trends(host, _params, ctx) {
  const S = ctx.nSnaps - 1;
  const dates = ctx.dim.snapshots.map((s) => s.date);
  const c = await ctx.countyCube();
  const f = await ctx.countyFlow();
  const h = await ctx.holdingsCube();
  const ser = (m) => seriesOf(c, m, null);
  const xl = snapLabels(ctx), il = ivLabels(ctx);
  const idx = [...Array(ctx.nSnaps).keys()];
  masthead(host, ctx, { kind: 'statewide trends brief', title: 'Montana cadastral trends',
    scope: 'Parcels created, the built share of old cohorts, out-of-state ownership and the concentration of large holdings' });

  // headline
  const parcels = ser('parcels'), acres = ser('acres');
  const loc = [0, 1, 2, 3, 4].map((i) => ser(`n_loc${i}`));
  const acLoc = [0, 1, 2, 3, 4].map((i) => ser(`ac_loc${i}`));
  const outP = ratioSeries(sum2(loc[3], loc[4]), loc.reduce((a, b) => sum2(a, b)));
  const outA = ratioSeries(sum2(acLoc[3], acLoc[4]), acLoc.reduce((a, b) => sum2(a, b)));
  const nIv = ctx.nIv;
  const land = new Float64Array(nIv), units = new Float64Array(nIv), per1k = new Float64Array(nIv);
  for (let i = 0; i < nIv; i++) {
    const iv = ctx.dim.intervals[i], y = iv.years || 1;
    land[i] = (sumAt(f, 'lot_created', i, null) + sumAt(f, 'block_created', i, null)) / y;
    units[i] = sumAt(f, 'unit_created', i, null) / y;
    per1k[i] = parcels[iv.a] ? (1000 * land[i]) / parcels[iv.a] : NaN;
  }
  const lo = hSer(h, 'large_owners', 0), lom = hSer(h, 'large_owners_max', 0), la = hSer(h, 'large_acres', 0);
  const pa = hSer(h, 'private_acres', 0);
  const s0 = sec(host, `At the ${dates[S]} export`);
  C.stats(s0, [
    { value: fmtInt(parcels[S]), label: 'parcels', detail: fmtAc(acres[S]) },
    { value: fmtInt(land[nIv - 1]), label: 'parcels created by land division per year', detail: `in the latest interval, ${il[nIv - 1]}` },
    { value: fmtPct(outP[S]), label: 'of parcels owned from out of state', detail: `${fmtPct(outA[S])} of acres` },
    { value: fmtInt(lo[S]), label: 'owners of 640+ acre holdings', detail: `${fmtAc(la[S])} · ${fmtPct(pa[S] ? (100 * la[S]) / pa[S] : NaN)} of private acreage` },
  ]);

  // 1. created per year
  const s1 = sec(host, 'Parcels created per year',
    'New parcels from land division (a new lot in an existing block, or a new block), and condominium units created '
    + 'inside an existing lot, per year on the real day count of each interval. Parcels arriving with coverage are '
    + `excluded; the comparable series begins in ${ctx.meta.comparable_series_begins}.`);
  C.lineChart(s1, { series: [land, units], labels: ['land divisions', 'condominium units'],
    colors: [cssVar('--cat-1'), cssVar('--cat-3')], xLabels: il, fmt: fmtInt, caption: 'Parcels created per year' });
  C.lineChart(s1, { series: [per1k], labels: ['new lots per 1,000 parcels per year'], colors: [cssVar('--cat-1')],
    xLabels: il, fmt: (v) => v.toFixed(1), caption: 'Rate of land division' });
  note(s1, 'Caveat: a division is inferred from the parcel identifiers; “subdivision” is reserved for events corroborated by a subdivision or certificate-of-survey name. No 2012 or 2015 export exists, so events in those years are dated to the interval that spans them.');

  // 2. built share of old cohorts
  const agg = await absorption(ctx, null);
  const byCohort = new Map();
  for (const [k, o] of agg) {
    const [coh] = k.split('|').map(Number);
    if (o.observed !== S) continue;
    const cur = byCohort.get(coh) || { built: 0, total: 0 };
    cur.built += o.built; cur.total += o.total;
    byCohort.set(coh, cur);
  }
  const cohorts = [...byCohort.keys()].sort((a, b) => a - b);
  const builtNow = Float64Array.from(cohorts, (coh) => { const o = byCohort.get(coh); return o.total ? (100 * o.built) / o.total : NaN; });
  const newestYear = Number(dates[S].slice(0, 4));
  const old = cohorts.filter((coh) => newestYear - Number(dates[coh].slice(0, 4)) >= 10);
  const oldBuilt = old.reduce((a, coh) => a + byCohort.get(coh).built, 0), oldTot = old.reduce((a, coh) => a + byCohort.get(coh).total, 0);
  const s2 = sec(host, 'Built share of old cohorts',
    `Of the lots created at each vintage, the share carrying an assessed building at the ${dates[S]} export. Old cohorts `
    + 'plateau: lots that have not been built on in ten years mostly stay that way.');
  C.stats(s2, [
    { value: fmtPct(oldTot ? (100 * oldBuilt) / oldTot : NaN), label: 'of lots created ten or more years ago are built',
      detail: `${fmtInt(oldTot)} lots in cohorts ${dates[old[0]]?.slice(0, 4) ?? ''}–${dates[old[old.length - 1]]?.slice(0, 4) ?? ''}` },
  ]);
  C.lineChart(s2, { series: [builtNow], labels: ['share built at the newest export'], colors: [cssVar('--cat-1')],
    xLabels: cohorts.map((coh) => dates[coh].slice(0, 7)), fmt: (v) => fmtPct(v, 0), yMax: 100, caption: 'Built share by creation cohort' });
  absorptionChart(s2, ctx, agg, 'Absorption by cohort and age in years, statewide');
  note(s2, 'Caveat: the ladder is probabilistic (a house number carries a building 89–91% of the time), and the age-0 and age-1 points are inflated by splits that hand an existing house to a child parcel. The 2009-07-05 export carries no building values and never contributes an observation.');

  // 3. out of state
  const s3 = sec(host, 'Out-of-state ownership',
    'Share of parcels and of acres whose owner mails from outside Montana, or whose state is unknown.');
  C.lineChart(s3, { series: [outP, outA], labels: ['share of parcels', 'share of acres'], colors: [cssVar('--cat-3'), cssVar('--cat-2')],
    xLabels: xl, fmt: (v) => fmtPct(v, 1), caption: 'Out-of-state share' });
  const trans = new Float64Array(nIv), addr = new Float64Array(nIv);
  for (let i = 0; i < nIv; i++) {
    const y = ctx.dim.intervals[i].years || 1;
    trans[i] = sumAt(f, 'transfers_out_of_state', i, null) / y;
    addr[i] = sumAt(f, 'address_change_only', i, null) / y;
  }
  C.lineChart(s3, { series: [trans, addr], labels: ['transfer to another state', 'address change only'],
    colors: [cssVar('--cat-1'), cssVar('--cat-2')], xLabels: il, fmt: fmtInt, caption: 'Interstate transfers against address edits, per year' });
  note(s3, 'Caveat: owner location is a mailing address, not a residence. A mailing-state change on an unchanged owner is an address edit, not a sale; conflating the two overstates out-of-state buying by about two thirds. The finer “local” tier is not comparable across 2009 and is not used here.');

  // 4. concentration
  const rt = await ctx.loadTable('regression_table1');
  const rc = col(rt);
  const paperCounties = [...new Set(rt.rows.map((r) => Number(r[rc('county_n')])))];
  const cloMean = Float64Array.from({ length: ctx.nSnaps }, (_, s) => {
    const v = paperCounties.map((u) => hAt(h, 'clo4', u, s)).filter((x) => x > 0);
    return v.length ? (100 * v.reduce((a, b) => a + b, 0)) / v.length : NaN;
  });
  const s4 = sec(host, 'Concentration of large holdings',
    'Owners holding 640 acres or more of private land within a county, and their acreage, statewide. Fewer owners '
    + 'holding more acreage is the concentration signature Haggerty et al. (2022) report for thirteen counties, 2005 to 2018.');
  C.lineChart(s4, { series: [lo, lom], labels: ['document tier', 'maximal tier'], colors: [cssVar('--cat-3'), cssVar('--ord3-2')],
    xLabels: xl, fmt: fmtInt, caption: 'Owners of large holdings, statewide' });
  C.lineChart(s4, { series: [Float64Array.from(la, (v, i) => (lo[i] ? v / lo[i] : NaN))], labels: ['mean large holding'],
    colors: [cssVar('--cat-1')], xLabels: xl, fmt: fmtAc, caption: 'Mean size of a large holding' });
  C.lineChart(s4, { series: [cloMean], labels: ['mean CLO4, the paper’s 13 counties'], colors: [cssVar('--cat-3')],
    xLabels: xl, fmt: (v) => fmtPct(v, 0), yMax: 40, caption: 'Four-property concentration ratio, averaged over the paper’s counties' });
  note(s4, 'Caveat: owners are identified by mailing address with bridges for entities and couples, and no manual review has been performed; the document and maximal tiers bound what a reviewer could change. The paper reports the thirteen-county mean CLO4 rising from 14% to 16%.');

  colophon(host, ctx);
  return { title: `Montana cadastral trends ${dates[S]}` };
}

/* =========================================================== 3. holdings */
async function holdingsUpdate(host, _params, ctx) {
  const S = ctx.nSnaps - 1;
  const dates = ctx.dim.snapshots.map((s) => s.date);
  const h = await ctx.holdingsCube();
  const s05 = dates.indexOf('2005-02-01'), s18 = dates.indexOf('2018-01-10');
  masthead(host, ctx, { kind: 'large-holdings update', title: 'Large private holdings in Montana counties',
    scope: 'In the form of Haggerty, Epstein, Gosnell, Rose and Stone (2022), extended to every county and to the newest export' });

  const intro = sec(host, 'Definitions');
  div(intro, 'rprose', `
    <p>A <strong>holding</strong> is the consolidated private acreage of one owner within one county, the paper’s unit;
    an owner present in several counties has a holding in each. <strong>Private</strong> excludes public domain (decided
    by area overlap with the public-lands layer) and tribal trust. <strong>Large</strong> is 640 acres or more, one
    section. <strong>CLO4</strong> is the share of a county’s large-holding acreage held by its four largest holdings
    (Desmarais et al. 2015, as used by the paper).</p>
    <p>Owners are identified by the method’s address key with name bridges for entities and couples. The
    <strong>document tier</strong> applies the rule as far as it can be automated; the <strong>maximal tier</strong>
    accepts every pending review flag. The paper’s manual pass lands between them, and no manual review has been
    performed here. Table 1 below reports the document tier; the residual section brackets it.</p>`);

  // Table 1
  const counties = ctx.dim.counties.slice().sort((a, b) => a.name.localeCompare(b.name));
  const cell = (m, u, s) => (s < 0 ? '--' : fmtInt(hAt(h, m, u, s)));
  const headers = ['county', `private acres ${dates[S].slice(0, 4)}`];
  const years = [[s05, '2005'], [s18, '2018'], [S, dates[S].slice(0, 4)]].filter(([s]) => s >= 0);
  for (const [, y] of years) headers.push(`large acres ${y}`);
  for (const [, y] of years) headers.push(`owners ${y}`);
  headers.push(`mean ${dates[S].slice(0, 4)}`, `CLO4 ${dates[S].slice(0, 4)}`);
  const rowFor = (u, label) => {
    const r = [label, cell('private_acres', u, S)];
    for (const [s] of years) r.push(cell('large_acres', u, s));
    for (const [s] of years) r.push(cell('large_owners', u, s));
    const lo = hAt(h, 'large_owners', u, S), la = hAt(h, 'large_acres', u, S);
    r.push(fmtInt(lo ? la / lo : NaN), lo >= 4 ? fmtPct(100 * hAt(h, 'clo4', u, S), 0) : '--');
    return r;
  };
  const t1 = sec(host, 'Table 1. Private land in holdings of 640 acres or larger, by county',
    `Acres and owners at ${years.map(([s]) => dates[s]).join(', ')}; mean holding and CLO4 at the newest export. CLO4 is shown only `
    + 'where a county has at least four large holdings. The last row is the statewide total, in which an owner is counted once per county held.', { long: true });
  C.table(t1, { headers, rows: [...counties.map((cty) => rowFor(cty.code, cty.name)), rowFor(0, 'Montana')], caption: 'Table 1' });

  // four largest per county
  const rows = (await topRows(ctx, S)).filter((r) => r.rank <= 4);
  const byCounty = new Map();
  for (const r of rows) { if (!byCounty.has(r.county)) byCounty.set(r.county, []); byCounty.get(r.county).push(r); }
  const t2 = sec(host, `The four largest holdings in each county, ${dates[S]}`,
    'Owner of record as the cadastral record names it, with the mailing city and state. A range of acres means a pending '
    + 'merge would add the difference; the status column says what the identity stage decided.', { long: true });
  const out = [];
  for (const cty of counties) {
    const rs = (byCounty.get(cty.code) || []).sort((a, b) => a.rank - b.rank);
    rs.forEach((r, i) => out.push([i === 0 ? cty.name : '', String(r.rank), r.name, mailsFrom(r), acresRange(r), fmtInt(r.parcels), statusText(ctx, r.status)]));
  }
  C.table(t2, { headers: ['county', '#', 'owner of record', 'mails from', 'acres', 'parcels', 'status'], rows: out, caption: 'Four largest holdings per county' });

  // CLO4 ranked
  const items = ctx.dim.counties.map((cty) => ({ label: cty.name, value: 100 * hAt(h, 'clo4', cty.code, S), n: hAt(h, 'large_owners', cty.code, S) }))
    .filter((x) => x.n >= 4).sort((a, b) => b.value - a.value);
  const omitted = ctx.dim.counties.length - items.length;
  const t3 = sec(host, `Counties ranked by CLO4, ${dates[S]}`,
    'Share of each county’s large-holding acreage held by its four largest holdings.'
    + (omitted ? ` ${omitted} count${omitted === 1 ? 'y' : 'ies'} with fewer than four large holdings ${omitted === 1 ? 'is' : 'are'} omitted.` : ''));
  rankSplit(t3, items, { color: cssVar('--cat-3'), fmt: (v) => fmtPct(v, 0), caption: 'CLO4 by county', max: 100 });

  // residuals
  const rt = await ctx.loadTable('regression_table1');
  const rc = col(rt);
  const rg = ctx.meta.holdings?.regression || [];
  const t4 = sec(host, 'Residuals against the published Table 1',
    'The paper reports thirteen counties at 2005 and 2018. Its homogenisation included a manual pass that cannot be replayed, '
    + 'so the test is whether the paper’s figure lies between the document and maximal tiers, county by county. The archive '
    + 'holds two exports for each year; the first of each is shown.', { long: true });
  for (const s of [s05, s18].filter((x) => x >= 0)) {
    const rs = rt.rows.filter((r) => Number(r[rc('s')]) === s)
      .map((r) => ({ name: ctx.countyName(Number(r[rc('county_n')])), T1: Number(r[rc('T1_large_acres')]), doc: Number(r[rc('doc_large_acres')]),
        max: Number(r[rc('max_large_acres')]), T1o: Number(r[rc('T1_owners')]), doco: Number(r[rc('doc_owners')]), maxo: Number(r[rc('max_owners')]) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const tot = rg.find((x) => x.snapshot === dates[s]);
    const body = rs.map((r) => [r.name, fmtInt(r.T1), fmtInt(r.doc), fmtInt(r.max), `${((100 * (r.doc - r.T1)) / r.T1).toFixed(1)}%`,
      `${((100 * (r.max - r.T1)) / r.T1).toFixed(1)}%`, fmtInt(r.T1o), fmtInt(r.doco), fmtInt(r.maxo),
      r.doc <= r.T1 + 1 && r.T1 <= r.max + 1 ? 'yes' : 'no']);
    if (tot) {
      body.push(['13 counties', fmtInt(tot.paper_large_acres), fmtInt(tot.document_large_acres), fmtInt(tot.maximal_large_acres),
        `${((100 * (tot.document_large_acres - tot.paper_large_acres)) / tot.paper_large_acres).toFixed(1)}%`,
        `${((100 * (tot.maximal_large_acres - tot.paper_large_acres)) / tot.paper_large_acres).toFixed(1)}%`,
        fmtInt(tot.paper_owners), fmtInt(tot.document_owners), fmtInt(tot.maximal_owners), '']);
    }
    C.table(t4, { headers: ['county', 'paper acres', 'document', 'maximal', 'document Δ', 'maximal Δ', 'paper owners', 'document', 'maximal', 'paper inside bracket'],
      rows: body, caption: `Against Table 1, ${dates[s]}` });
  }
  note(t4, 'Reading: a document-tier residual below the maximal-tier reach, with the paper inside the bracket, is the expected shape. A county outside the bracket is the thing to look at; the usual cause is a tenure decision (a parcel straddling public land, or a name the public-lands layer does not carry) rather than an identity one.');

  colophon(host, ctx, [
    'Holdings are named from the public cadastral record. Only the ten largest holdings per county are published; smaller holdings enter the counts and ratios but are not listed.',
  ]);
  return { title: `Montana large holdings update ${dates[S]}` };
}

/* ========================================================== 4. worksheet */
const CSV_HEAD = ['override_action', 'source_owner_id', 'target_owner_group_id', 'PartyID', 'PARCELID', 'PropertyID',
  'CountyPrefix', 'TaxYear', 'reason', 'reviewer', 'review_date',
  'county', 'rank', 'owner_of_record', 'mails_from', 'acres', 'acres_if_merged', 'parcels', 'names', 'pending_links',
  'review_status', 'why', 'group_hash', 'snapshot'];
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function worksheet(host, { county = null }, ctx) {
  const S = ctx.nSnaps - 1;
  const dates = ctx.dim.snapshots.map((s) => s.date);
  const scopeName = county ? `${ctx.countyName(county)} County` : 'all counties';
  masthead(host, ctx, { kind: 'review worksheet', title: `Holdings awaiting a review decision, ${scopeName}`,
    scope: 'Large holdings whose acreage rests on an unmade identity or tenure decision' });
  const rows = (await topRows(ctx, S, county ? [county] : null)).filter(pending)
    .sort((a, b) => a.county - b.county || (b.acresMax - b.acres) - (a.acresMax - a.acres) || b.acres - a.acres);

  const how = sec(host, 'How to use this worksheet');
  div(how, 'rprose', `
    <p>Each row is a large holding (640 acres or more of private land in one county) that the identity stage could not
    settle by rule: a shared name or address that needs a decision, a name-token match, a parcel on which the point and
    area tenure tests disagree, or a holding flagged for review. The CSV carries the columns of
    <code>owner_overrides.csv</code> first, with <code>source_owner_id</code> already set to the holding’s group hash and
    <code>CountyPrefix</code> to the county code, then the context a reviewer needs.</p>
    <p>To record a decision, fill <code>override_action</code> with <strong>merge</strong> (and put the id of the group it
    joins in <code>target_owner_group_id</code>) or <strong>keep</strong> (looked, kept separate), add a reason, your name and
    the date, and append the filled rows to <code>owner_overrides.csv</code>. Rows with no action are ignored. The identity
    stage applies the file on its next run, the holding is marked <em>reviewed</em>, and the reviewer, date and reason travel
    into the next publish. This is the one report that changes the numbers.</p>
    <p>Scope: the ten largest holdings per county are published, so this worksheet covers the flagged holdings among them
    (${rows.length} rows). The complete queue, including smaller holdings, is written locally by the identity stage.</p>`);

  const t = sec(host, `Worksheet, ${dates[S]}`,
    'Ordered by county, then by the acreage at stake. Why: shared name/address = a shared name or address needs a decision; '
    + 'token match = name-token match only; tenure conflict = the point and area tests disagree on a parcel. The last column is '
    + 'for a decision on paper; the CSV carries the same rows for the overrides file.', { long: true });
  C.table(t, { headers: ['county', '#', 'owner of record', 'mails from', 'acres', 'if merged', 'parcels', 'names', 'status', 'why', 'group hash', 'decision'],
    rows: rows.map((r) => [ctx.countyName(r.county), String(r.rank), r.name, mailsFrom(r), fmtInt(r.acres), fmtInt(r.acresMax),
      fmtInt(r.parcels), String(r.names), statusText(ctx, r.status), reasons(r, true), code(r.hash), '<span class="blank"></span>']),
    caption: 'Holdings awaiting review', html: true });

  const csv = [CSV_HEAD.join(',')].concat(rows.map((r) => [
    '', r.hash, '', '', '', '', pad2(r.county), '', '', '', '',
    ctx.countyName(r.county), r.rank, r.name, mailsFrom(r), r.acres.toFixed(1), r.acresMax.toFixed(1), r.parcels, r.names, r.links,
    statusText(ctx, r.status), reasons(r), r.hash, dates[S],
  ].map(csvCell).join(','))).join('\r\n') + '\r\n';

  colophon(host, ctx, ['Holdings are named from the public cadastral record; no parcel-level owner information is published.']);
  return { title: `Review worksheet ${scopeName} ${dates[S]}`, csv, csvName: `review_worksheet_${county ? pad2(county) + '_' : ''}${dates[S]}.csv`, rows: rows.length };
}

/* =========================================================== 5. activity */
async function activity(host, { a, b }, ctx) {
  const dates = ctx.dim.snapshots.map((s) => s.date);
  const ivs = [...Array(ctx.nIv).keys()].filter((i) => ctx.dim.intervals[i].a >= a && ctx.dim.intervals[i].b <= b);
  const years = ivs.reduce((t, i) => t + (ctx.dim.intervals[i].years || 0), 0);
  const c = await ctx.countyCube();
  const f = await ctx.countyFlow();
  masthead(host, ctx, { kind: 'subdivision activity', title: `Land division, ${dates[a]} to ${dates[b]}`,
    scope: `${ivs.length} interval${ivs.length === 1 ? '' : 's'}, ${years.toFixed(1)} years on the real day count` });

  const ed = await ctx.loadTable('threshold_edges');
  const ec = col(ed);
  const per = new Map();
  for (const cty of ctx.dim.counties) per.set(cty.code, { name: cty.name, lots: 0, b20: 0, a20: 0, b40: 0, a40: 0, b160: 0, a160: 0 });
  const want = new Set(ivs);
  for (const r of ed.rows) {
    const i = Number(r[ec('interval')]);
    if (!want.has(i)) continue;
    const p = per.get(Number(r[ec('county_n')]));
    if (!p) continue;
    p.lots += Number(r[ec('lots')]);
    for (const e of [20, 40, 160]) { p[`b${e}`] += Number(r[ec(`below${e}`)]); p[`a${e}`] += Number(r[ec(`above${e}`)]); }
  }
  const rows = [];
  for (const cty of ctx.dim.counties) {
    const p = per.get(cty.code);
    const stock = c.data.parcels[cty.code * c.nSnaps + a] || 0;
    const comparable = ivs.every((i) => sumAt(f, 'comparable', i, [cty.code]) > 0);
    const units = ivs.reduce((t, i) => t + sumAt(f, 'unit_created', i, [cty.code]), 0);
    rows.push({ ...p, code: cty.code, stock, comparable, units,
      rate: comparable && stock > 50 && years > 0 ? (1000 * p.lots) / stock / years : NaN });
  }
  const tot = rows.reduce((t, r) => { for (const k of ['lots', 'b20', 'a20', 'b40', 'a40', 'b160', 'a160', 'stock', 'units']) t[k] += r[k]; return t; }, { lots: 0, b20: 0, a20: 0, b40: 0, a40: 0, b160: 0, a160: 0, stock: 0, units: 0 });
  const ratio = (above, below) => (above + below >= 20 ? (above / Math.max(1, below)).toFixed(2) : 'too few');

  const s0 = sec(host, 'Statewide');
  C.stats(s0, [
    { value: fmtInt(tot.lots), label: 'parcels created by land division', detail: `${fmtInt(tot.units)} condominium units besides` },
    { value: (years && tot.stock ? (1000 * tot.lots) / tot.stock / years : NaN).toFixed(1), label: 'new lots per 1,000 parcels per year',
      detail: `on the ${fmtInt(tot.stock)} parcels of ${dates[a]}` },
    { value: ratio(tot.a20, tot.b20), label: 'mass above ÷ below the 20-acre line', detail: `${fmtInt(tot.a20)} just above, ${fmtInt(tot.b20)} just below` },
    { value: ratio(tot.a40, tot.b40), label: 'at the 40-acre line', detail: `${fmtInt(tot.a40)} above, ${fmtInt(tot.b40)} below` },
    { value: ratio(tot.a160, tot.b160), label: 'at the 160-acre line', detail: `${fmtInt(tot.a160)} above, ${fmtInt(tot.b160)} below` },
  ]);

  // statewide histogram for the period
  const hist = await ctx.loadTable('size_histogram');
  const hc = col(hist);
  const bins = new Map();
  for (const r of hist.rows) {
    if (!want.has(Number(r[hc('interval')]))) continue;
    const L = Number(r[hc('bin_lo')]);
    if (!(L >= 10 && L < 32)) continue;
    bins.set(L, (bins.get(L) || 0) + Number(r[hc('parcels')]));
  }
  const keys = [...bins.keys()].sort((x, y) => x - y);
  const s1 = sec(host, 'Newly created parcel sizes around the 20-acre line',
    'Statewide, for the period. Under MCA 76-4-102(25) and 76-4-103 a parcel of 20 acres or more (exclusive of public roadways) '
    + 'is not subject to DEQ sanitation review, so mass just above the line is consistent with lots sized to clear it. The spikes at '
    + 'exactly 40 and 160 acres elsewhere in the distribution are the survey grid (a quarter-quarter section is 40 acres), not review avoidance.');
  if (keys.length) {
    const refIdx = keys.findIndex((k) => k >= 20);
    C.histogram(s1, { values: keys.map((k) => bins.get(k)), xLabels: keys.map((k) => (Number.isInteger(k) ? String(k) : k.toFixed(1))),
      color: cssVar('--cat-1'), refAt: refIdx < 0 ? null : refIdx, refLabel: '20 ac', xTickEvery: 4, caption: 'Created-parcel sizes, 10–32 acres' });
  }

  // by county
  const ranked = rows.filter((r) => isFinite(r.rate)).sort((x, y) => y.rate - x.rate);
  const s2 = sec(host, 'New lots per thousand parcels per year, by county',
    `Parcels created by land division in the period, per thousand parcels on the county’s ${dates[a]} record, per year. `
    + 'Counties whose record is not comparable across every interval of the period are listed but not ranked.');
  rankSplit(s2, ranked.map((r) => ({ label: r.name, value: r.rate })), { color: cssVar('--cat-1'), fmt: (v) => v.toFixed(1), caption: 'Rate of land division by county' });

  const s3 = sec(host, 'By county: lots, rate and the statutory lines',
    'Just below and just above each line, within a 3% window (±1 acre at 20, ±1.2 at 40, ±4.8 at 160). A ratio is shown only '
    + 'where the two windows hold twenty parcels or more together.', { long: true });
  C.table(s3, { headers: ['county', 'lots created', `parcels ${dates[a].slice(0, 4)}`, 'per 1,000 per yr', '<20', '≥20', 'ratio', '<40', '≥40', 'ratio', '<160', '≥160', 'ratio'],
    rows: rows.slice().sort((x, y) => (isFinite(y.rate) ? y.rate : -1) - (isFinite(x.rate) ? x.rate : -1))
      .map((r) => [r.name + (r.comparable ? '' : ' *'), fmtInt(r.lots), fmtInt(r.stock), isFinite(r.rate) ? r.rate.toFixed(1) : '--',
        fmtInt(r.b20), fmtInt(r.a20), ratio(r.a20, r.b20), fmtInt(r.b40), fmtInt(r.a40), ratio(r.a40, r.b40), fmtInt(r.b160), fmtInt(r.a160), ratio(r.a160, r.b160)]),
    caption: 'Land division by county for the period' });
  note(s3, '* the coverage gate found the county’s record not comparable across the whole period (an endpoint vintage failed two of its three indicators, or an interval was dominated by parcels arriving as first mappings), so no rate is given.');

  const edgeRank = rows.filter((r) => r.a20 + r.b20 >= 20).map((r) => ({ label: r.name, value: r.a20 / Math.max(1, r.b20) })).sort((x, y) => y.value - x.value);
  if (edgeRank.length) {
    const s4 = sec(host, 'The 20-acre pile-up by county', 'Mass just above the line divided by mass just below, where the windows hold twenty parcels or more. A ratio near 1 is no pile-up.');
    rankSplit(s4, edgeRank, { color: cssVar('--statute'), fmt: (v) => v.toFixed(2), caption: '20-acre edge ratio by county' });
  }

  colophon(host, ctx, ['Lots are counted from inferred creation events (a new lot in an existing block, or a new block); condominium units and parcels arriving with coverage are excluded.']);
  return { title: `Montana subdivision activity ${dates[a]} to ${dates[b]}` };
}

/* ================================================================ entry */
const RENDER = { profile, condition, trends, holdings: holdingsUpdate, worksheet, activity };

/**
 * Compose one report into `host`. The host must be laid out at its print
 * width when this runs, because the charts size themselves to it.
 * Returns { title, csv?, csvName? }.
 */
export async function renderReport(kind, params, host, ctx) {
  const fn = RENDER[kind];
  if (!fn) throw new Error(`unknown report ${kind}`);
  host.textContent = '';
  C.setPaletteRoot(host);
  try {
    return await fn(host, params, ctx);
  } finally {
    C.setPaletteRoot(null);
  }
}
