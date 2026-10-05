/* ---------------------------------------------------------------------------
   app.js -- views, filters and wiring.

   Five views, each answering one of the planning questions the pipeline
   supports, over one shared map surface and one shared time control.

   An honest limitation is built into the controls. The published tables carry
   MARGINALS at township grain, not the full joint cube -- the joint at that
   grain would be millions of rows -- so the dashboard offers one category
   dimension at a time rather than pretending to cross-filter. Where a view
   needs a second dimension (owner origin by state) it fetches a purpose-built
   table for the selected state. Nothing silently shows an unfiltered total
   while implying otherwise.
--------------------------------------------------------------------------- */

import { loadJSON, loadTable, cube, flowCube, seriesOf, sumAt, valuesAt } from './data.js';
import { UnitMap, quantileBreaks, classify } from './map.js';
import * as C from './charts.js';

const S = {
  dim: null, meta: null, map: null,
  snap: 0, level: 'township', measure: 'parcels', view: 'ladder',
  maskLow: true, selection: new Set(), originState: '',
  twpByKey: new Map(), twpById: new Map(),
  cubes: {}, flows: {}, nSnaps: 0, nTwp: 0, nIv: 0,
};
const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------- data access */
async function twpCube(topic) {
  if (S.cubes[topic]) return S.cubes[topic];
  const t = await loadTable(`twp_${topic}`);
  S.cubes[topic] = cube(t, { nUnits: S.nTwp + 1, nSnaps: S.nSnaps, delta: S.dim.delta_coded });
  return S.cubes[topic];
}
async function twpFlow() {
  if (S.flows.twp) return S.flows.twp;
  const t = await loadTable('twp_flow');
  S.flows.twp = flowCube(t, { nUnits: S.nTwp + 1, nIntervals: S.nIv });
  return S.flows.twp;
}
async function countyCube() {
  if (S.cubes.county) return S.cubes.county;
  const t = await loadTable('county_stock');
  S.cubes.county = cube(t, { nUnits: 57, nSnaps: S.nSnaps, keyCol: 'county_n', delta: false });
  return S.cubes.county;
}
async function countyFlow() {
  if (S.flows.county) return S.flows.county;
  const t = await loadTable('county_flow');
  S.flows.county = flowCube(t, { nUnits: 57, nIntervals: S.nIv, keyCol: 'county_n' });
  return S.flows.county;
}

/** Active stock cube for the chosen unit level, plus its id list. */
async function activeStock(topic) {
  if (S.level === 'county') return { c: await countyCube(), ids: countyIds() };
  return { c: await twpCube(topic), ids: twpIds() };
}
const twpIds = () => S.dim.townships.map((t) => t.id);
const countyIds = () => S.dim.counties.map((c) => c.code);
const selectedUnits = () => (S.selection.size ? Array.from(S.selection) : null);

function unitFeatureId(u) {
  return S.level === 'county' ? u : (S.twpById.get(u)?.tr ?? null);
}
const snapLabels = () => S.dim.snapshots.map((s) => s.date.slice(0, 7));
const ivLabels = () => S.dim.intervals.map((i) => S.dim.snapshots[i.a].date.slice(2, 7) + '→' + S.dim.snapshots[i.b].date.slice(2, 7));

/* ----------------------------------------------------------------- painting */
function paintFrom(c, ids, fn, { diverging = false, maskFn = null } = {}) {
  const vals = new Map();
  const noValue = [];
  for (const u of ids) {
    const v = fn(c, u, S.snap);
    if (v != null && isFinite(v)) vals.set(u, v);
    else noValue.push(u);
  }
  const masked = cssVar('--masked');
  const colors = new Map();
  // Units below the view's minimum-count threshold are painted masked rather
  // than left unpainted: an unpainted unit shows the page background and is
  // indistinguishable from "no comparable data", which is exactly the
  // confusion the mask exists to prevent.
  for (const u of noValue) {
    const fid = unitFeatureId(u);
    if (fid != null) colors.set(fid, masked);
  }
  if (diverging) {
    const arr = Array.from(vals.values()).filter((v) => isFinite(v));
    const lim = Math.max(1e-9, ...arr.map(Math.abs));
    const ramp = ['--div-neg-2', '--div-neg-1', '--div-mid', '--div-pos-1', '--div-pos-2'].map(cssVar);
    for (const [u, v] of vals) {
      const fid = unitFeatureId(u);
      if (fid == null) continue;
      if (maskFn && maskFn(u)) { colors.set(fid, masked); continue; }
      const t = Math.max(-1, Math.min(1, v / lim));
      const i = t < -0.5 ? 0 : t < -0.05 ? 1 : t <= 0.05 ? 2 : t <= 0.5 ? 3 : 4;
      colors.set(fid, ramp[i]);
    }
    legend(ramp, `-${fmtShort(lim)}`, `+${fmtShort(lim)}`, true);
  } else {
    const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7', '--seq-8'].map(cssVar);
    const breaks = quantileBreaks(vals.values(), ramp.length);
    for (const [u, v] of vals) {
      const fid = unitFeatureId(u);
      if (fid == null) continue;
      if (maskFn && maskFn(u)) { colors.set(fid, masked); continue; }
      colors.set(fid, ramp[Math.min(ramp.length - 1, classify(v, breaks))]);
    }
    const arr = Array.from(vals.values()).sort((a, b) => a - b);
    legend(ramp, fmtShort(arr[0] ?? 0), fmtShort(arr[arr.length - 1] ?? 0), false);
  }
  S.map.paint(colors);
}
const cssVar = C.cssVar;
const fmtShort = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
  : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k`
  : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

function legend(ramp, lo, hi, diverging) {
  const l = $('legend');
  l.innerHTML = `<div class="title">${l.dataset.title || ''}</div>
    <div class="ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ends"><span>${lo}</span><span>${hi}</span></div>
    ${diverging ? '<div class="note">Diverging around zero; grey midpoint is no change.</div>' : ''}
    <div class="note">Grey = no comparable data (coverage mask), never zero.</div>`;
}

/* -------------------------------------------------------------------- views */
const VIEWS = {};

/* 1. Development ladder -- Tier 1.1 */
VIEWS.ladder = {
  label: 'Development',
  legend: 'Share of parcels addressed but unbuilt',
  async render(panel) {
    const dev = await twpCube('dev');
    const { c, ids } = await activeStock('dev');
    const cov = S.level === 'county' ? await countyCube() : await twpCube('core');

    paintFrom(c, ids, (cc, u, s) => {
      const n0 = cc.data.n_dev0?.[u * cc.nSnaps + s] ?? 0;
      const n1 = cc.data.n_dev1?.[u * cc.nSnaps + s] ?? 0;
      const n2 = cc.data.n_dev2?.[u * cc.nSnaps + s] ?? 0;
      const t = n0 + n1 + n2;
      return t > 25 ? (100 * n1) / t : null;
    }, { maskFn: maskLowCoverage(cov) });

    const units = selectedUnits();
    const ser = ['n_dev0', 'n_dev1', 'n_dev2'].map((m) => seriesOf(c, m, units));
    const acr = ['ac_dev0', 'ac_dev1', 'ac_dev2'].map((m) => seriesOf(c, m, units));
    // The 2009-07-05 export carries a dead value block, so improvement status is
    // unknown there rather than zero. Drawn as its own masked band: without it
    // the stack collapses to a white wedge that reads as a rendering fault
    // instead of as missing data.
    const unknown = seriesOf(c, 'n_dev3', units);
    const hasUnknown = Array.from(unknown).some((v) => v > 0);
    const use = (S.measure === 'acres' ? acr : ser).slice();
    const stackLabels = ['platted only', 'addressed', 'built'];
    const stackColors = C.ramp('ord3', 3);
    if (hasUnknown && S.measure !== 'acres') {
      use.push(unknown);
      stackLabels.push('no data');
      stackColors.push(cssVar('--masked'));
    }

    const tot = use.reduce((a, s) => a + s[S.snap], 0);
    C.stats(C.card(panel, 'At the selected snapshot', selectionNote()), [
      { value: C.fmtInt(ser[1][S.snap]), label: 'addressed, not built',
        detail: tot ? `${((100 * ser[1][S.snap]) / (ser[0][S.snap] + ser[1][S.snap] + ser[2][S.snap])).toFixed(1)}% of parcels` : '' },
      { value: C.fmtInt(ser[0][S.snap]), label: 'platted only' },
      { value: C.fmtInt(ser[2][S.snap]), label: 'built' },
    ]);

    const k1 = C.card(panel, 'The ladder over time',
      'Platted only → address assigned → assessed building value. A parcel with a house number carries a building 89–91% of the time.');
    C.stackedArea(k1, {
      series: use, labels: stackLabels, colors: stackColors,
      xLabels: snapLabels(), share: true,
      fmt: S.measure === 'acres' ? C.fmtAc : C.fmtInt,
      caption: 'Ladder composition, table view',
    });

    await absorptionCard(panel);
    await dormantCard(panel);
  },
};

async function absorptionCard(panel) {
  const t = await loadTable('absorption');
  const col = (n) => t.columns.indexOf(n);
  const ci = col('cohort'), ai = col('age_idx'), di = col('dev_stage'),
    pi = col('parcels'), yi = col('years_elapsed');
  // Cohort -> age -> {built, total}
  const agg = new Map();
  for (const r of t.rows) {
    const coh = Number(r[ci]), age = Number(r[ai]), st = Number(r[di]);
    if (!isFinite(coh) || coh <= 0 || st < 0) continue;
    const key = `${coh}|${age}`;
    const o = agg.get(key) || { built: 0, total: 0, yrs: Number(r[yi]) };
    o.total += Number(r[pi]); if (st === 2) o.built += Number(r[pi]);
    agg.set(key, o);
  }
  // Pick a handful of cohorts spread across the series, ordinal by time.
  const cohorts = [...new Set([...agg.keys()].map((k) => Number(k.split('|')[0])))].sort((a, b) => a - b);
  const pick = [1, 5, 10, 16, 21].map((i) => cohorts[Math.min(i, cohorts.length - 1)])
    .filter((v, i, a) => v != null && a.indexOf(v) === i);
  const maxAge = 24;
  const series = pick.map((coh) => {
    const out = new Float64Array(maxAge).fill(NaN);
    for (let age = 0; age < maxAge; age++) {
      const o = agg.get(`${coh}|${age}`);
      if (o && o.total > 0) out[age] = (100 * o.built) / o.total;
    }
    return out;
  });
  const card = C.card(panel, 'Absorption: share of a cohort built, by age',
    'Of the lots created at each vintage, the share carrying an assessed building N years later. Curves plateau near 50–58%.');
  C.lineChart(card, {
    series, labels: pick.map((c) => S.dim.snapshots[c]?.date.slice(0, 4) ?? String(c)),
    colors: C.ramp('ord5', 5).slice(0, series.length),
    xLabels: Array.from({ length: maxAge }, (_, i) => String(i)),
    fmt: (v) => C.fmtPct(v, 0), yMax: 100,
    caption: 'Absorption by cohort and age in years',
  });
  const note = document.createElement('div');
  note.className = 'caveat';
  note.textContent = 'The age-0 and age-1 points are inflated by splits that hand an '
    + 'existing house to a child parcel, so a lot can be "built" the moment it exists.';
  card.appendChild(note);
}

async function dormantCard(panel) {
  const t = await loadTable('dormant');
  const col = (n) => t.columns.indexOf(n);
  const items = t.rows.map((r) => ({
    code: Number(r[col('county_n')]),
    lots: Number(r[col('dormant_lt40ac')] ?? 0),
    aged: Number(r[col('dormant_lt40ac_ge_5y')] ?? 0),
    age: Number(r[col('dormant_lt40ac_median_age')] ?? 0),
  })).filter((d) => d.lots > 0);
  const byCode = new Map(S.dim.counties.map((c) => [c.code, c.name]));
  items.sort((a, b) => b.lots - a.lots);
  const card = C.card(panel, 'Dormant platted inventory',
    'Lots under 40 acres with no house number and no building, whose creation was observed. Size-restricted because stage 0 is the normal permanent state of a working ranch tract.');
  C.rankBars(card, {
    items: items.slice(0, 12).map((d) => ({
      label: byCode.get(d.code) || String(d.code), value: d.lots,
      detail: `${C.fmtInt(d.lots)} lots · ${C.fmtInt(d.aged)} at 5 yr+ · median age ${d.age.toFixed(0)} yr`,
    })),
    color: cssVar('--cat-1'), caption: 'Dormant lots under 40 acres, by county',
  });
}

/* 2. Ownership -- Tier 1.2 and 1.3 */
VIEWS.ownership = {
  label: 'Ownership',
  legend: 'Out-of-state share of parcels',
  async render(panel) {
    const { c, ids } = await activeStock('locality');
    const cov = S.level === 'county' ? await countyCube() : await twpCube('core');
    const originSel = S.originState;

    if (originSel) {
      const st = await loadTable(`owner_state/${originSel}`);
      const sc = cube(st, { nUnits: S.nTwp + 1, nSnaps: S.nSnaps, delta: false });
      if (S.level === 'township') {
        paintFrom(sc, twpIds(), (cc, u, s) => cc.data.parcels?.[u * cc.nSnaps + s] || null,
          { maskFn: maskLowCoverage(cov) });
      } else {
        paintFrom(c, ids, () => null);
      }
      const card = C.card(panel, `Parcels owned from ${originSel}`,
        'Township detail for the selected owner origin, fetched on demand.');
      const units = selectedUnits();
      C.lineChart(card, {
        series: [seriesOf(sc, 'parcels', units)], labels: [originSel],
        colors: [cssVar('--cat-2')], xLabels: snapLabels(),
        caption: `Parcels with a ${originSel} mailing address`,
      });
    } else {
      paintFrom(c, ids, (cc, u, s) => {
        const n = [0, 1, 2, 3, 4].map((i) => cc.data[`n_loc${i}`]?.[u * cc.nSnaps + s] ?? 0);
        const t = n.reduce((a, b) => a + b, 0);
        return t > 25 ? (100 * n[3]) / t : null;
      }, { maskFn: maskLowCoverage(cov) });
    }

    const units = selectedUnits();
    const pre = S.measure === 'acres' ? 'ac_loc' : 'n_loc';
    const fmt = S.measure === 'acres' ? C.fmtAc : C.fmtInt;
    // The three tiers that are comparable over time: local and same-county are
    // collapsed because `local` needs the parcel's situs city, whose coverage
    // collapses in 2009.
    const inCounty = sum2(seriesOf(c, `${pre}0`, units), seriesOf(c, `${pre}1`, units));
    const elsewhere = seriesOf(c, `${pre}2`, units);
    const outState = sum2(seriesOf(c, `${pre}3`, units), seriesOf(c, `${pre}4`, units));
    const card = C.card(panel, 'Owner distance from the land',
      'Collapsed to the three tiers that are comparable across the whole series. “Local” alone is not: it needs the parcel’s situs city, whose coverage collapses in 2009.');
    C.stackedArea(card, {
      series: [inCounty, elsewhere, outState],
      labels: ['in the parcel’s county', 'elsewhere in Montana', 'out of state / unknown'],
      colors: C.ramp('ord3', 3), xLabels: snapLabels(), share: true, fmt,
      caption: 'Owner locality composition',
    });

    await tenureCard(panel, units);
    await originRankCard(panel);
  },
};
const sum2 = (a, b) => { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + b[i]; return o; };

async function tenureCard(panel, units) {
  const { c } = await activeStock('tenure');
  const pre = S.measure === 'acres' ? 'ac_ten' : 'n_ten';
  const fmt = S.measure === 'acres' ? C.fmtAc : C.fmtInt;
  const ser = [0, 1, 2].map((i) => seriesOf(c, `${pre}${i}`, units));
  const card = C.card(panel, 'Tenure: public domain, tribal trust, private',
    'Public domain comes from the MTPublicLands spatial join — a locational answer, independent of how an owner is named. Tribal trust comes from owner names only, because trust land is absent from a public-lands layer.');
  C.stackedArea(card, {
    series: ser, labels: S.dim.labels.tenure.map((t) => t.replace('_', ' ')),
    colors: [cssVar('--cat-1'), cssVar('--cat-2'), cssVar('--cat-3')],
    xLabels: snapLabels(), share: true, fmt, caption: 'Tenure composition',
  });
}

async function originRankCard(panel) {
  const t = await loadTable('county_owner_state');
  const col = (n) => t.columns.indexOf(n);
  const si = col('s'), sti = col('st'), pi = col('parcels'), ai = col('acres'), ci = col('county_n');
  const states = S.dim.states;
  const sel = S.selection.size && S.level === 'county' ? S.selection : null;
  const acc = new Map();
  for (const r of t.rows) {
    if (Number(r[si]) !== S.snap) continue;
    if (sel && !sel.has(Number(r[ci]))) continue;
    const st = states[Number(r[sti])];
    if (!st || st === 'MT') continue;
    acc.set(st, (acc.get(st) || 0) + Number(S.measure === 'acres' ? r[ai] : r[pi]));
  }
  const items = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([st, v]) => ({ label: st, value: v }));
  const card = C.card(panel, 'Where out-of-state owners mail from',
    'Mailing address, not residence. Select a state in the filter row to map its township detail.');
  C.rankBars(card, {
    items, color: cssVar('--cat-2'),
    fmt: S.measure === 'acres' ? C.fmtAc : C.fmtInt,
    caption: 'Out-of-state owner origins',
  });
}

/* 3. Fragmentation -- Tier 1.5 and Tier 2.6 */
VIEWS.fragmentation = {
  label: 'Fragmentation',
  legend: 'Share of acreage in parcels under 40 acres',
  async render(panel) {
    const { c, ids } = await activeStock('size');
    const cov = S.level === 'county' ? await countyCube() : await twpCube('core');
    paintFrom(c, ids, (cc, u, s) => {
      const at = u * cc.nSnaps + s;
      const small = (cc.data.ac_sz1?.[at] ?? 0) + (cc.data.ac_sz2?.[at] ?? 0)
        + (cc.data.ac_sz3?.[at] ?? 0) + (cc.data.ac_sz4?.[at] ?? 0);
      let tot = 0;
      for (let i = 0; i <= 7; i++) tot += cc.data[`ac_sz${i}`]?.[at] ?? 0;
      return tot > 500 ? (100 * small) / tot : null;
    }, { maskFn: maskLowCoverage(cov) });

    const units = selectedUnits();
    const pre = S.measure === 'acres' ? 'ac_sz' : 'n_sz';
    const fmt = S.measure === 'acres' ? C.fmtAc : C.fmtInt;
    // Five display classes. Eight ordinal steps of one hue cannot be told apart
    // (adjacent lightness gap 0.047 against a 0.06 floor), and the two smallest
    // real classes carry 0.4% of the state's acreage, so they fold.
    const g = (idx) => idx.map((i) => seriesOf(c, `${pre}${i}`, units))
      .reduce((a, b) => sum2(a, b));
    const series = [g([1, 2]), g([3, 4]), g([5]), g([6]), g([7])];
    const labels = ['<5 ac', '5–40 ac', '40–160 ac', '160–640 ac', '>640 ac'];
    const card = C.card(panel, 'Acreage by parcel-size class',
      'Acreage leaving the large classes for the small ones is the fragmentation signature. It is real and slow: 2.65% → 3.16% of the state under 40 acres over 23 years.');
    C.stackedArea(card, {
      series, labels, colors: C.ramp('ord5', 5), xLabels: snapLabels(),
      share: true, fmt, caption: 'Size-class composition',
    });

    const { c: ag } = await activeStock('ag');
    // The 2009-07-05 export has a dead agricultural block, so that snapshot is
    // a gap in the line rather than a plunge to near zero.
    const agSeries = seriesOf(ag, 'ag_acres', units);
    const avail = seriesOf(ag, 'ag_available', units);
    const nUnitsSel = units ? units.length : ag.nUnits;
    for (let i = 0; i < agSeries.length; i++) {
      if (!(avail[i] > nUnitsSel * 0.5)) agSeries[i] = NaN;
    }
    const card2 = C.card(panel, 'Agricultural-use acreage',
      'Parcels carrying any agricultural-use acreage — a cleaner indicator than PropType, which is coded inconsistently across counties. Acreage is clamped to each parcel\u2019s own area, since agricultural use is a subset of the parcel; without that the 2003 and 2004 exports report 735M and 781M acres against a mapped 86M.');
    C.lineChart(card2, {
      series: [agSeries], labels: ['agricultural acres'],
      colors: [cssVar('--cat-3')], xLabels: snapLabels(), fmt: C.fmtAc,
      caption: 'Agricultural-use acreage',
    });
  },
};

/* 4. Churn -- Tier 2.7, 2.8, 2.9 */
VIEWS.churn = {
  label: 'Churn',
  legend: 'Owner change, % of persisting parcels per year',
  async render(panel) {
    const f = S.level === 'county' ? await countyFlow() : await twpFlow();
    const ids = S.level === 'county' ? countyIds() : twpIds();
    const iv = Math.min(S.dim.intervals.length - 1, Math.max(0, S.snap - 1));
    const yrs = S.dim.intervals[iv]?.years || 1;

    const vals = new Map();
    for (const u of ids) {
      const at = u * f.nSnaps + iv;
      const p = f.data.persisted?.[at] ?? 0;
      const ch = f.data.owner_changed?.[at] ?? 0;
      const ok = (f.data.comparable?.[at] ?? 0) > 0;
      if (p > 50 && ok) vals.set(u, (100 * ch) / p / yrs);
    }
    const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7', '--seq-8'].map(cssVar);
    const breaks = quantileBreaks(vals.values(), ramp.length);
    const colors = new Map();
    for (const u of ids) {
      const fid = unitFeatureId(u);
      if (fid == null) continue;
      colors.set(fid, vals.has(u) ? ramp[Math.min(7, classify(vals.get(u), breaks))] : cssVar('--masked'));
    }
    S.map.paint(colors);
    const arr = [...vals.values()].sort((a, b) => a - b);
    legend(ramp, C.fmtPct(arr[0] ?? 0), C.fmtPct(arr[arr.length - 1] ?? 0), false);

    const units = selectedUnits();
    const xl = ivLabels();
    const rate = new Float64Array(S.nIv), trans = new Float64Array(S.nIv),
      addr = new Float64Array(S.nIv), merged = new Float64Array(S.nIv);
    for (let i = 0; i < S.nIv; i++) {
      const y = S.dim.intervals[i]?.years || 1;
      const p = sumAt(f, 'persisted', i, units), ch = sumAt(f, 'owner_changed', i, units);
      rate[i] = p ? (100 * ch) / p / y : NaN;
      trans[i] = sumAt(f, 'transfers_out_of_state', i, units) / y;
      addr[i] = sumAt(f, 'address_change_only', i, units) / y;
      merged[i] = sumAt(f, 'unit_created', i, units) / y;
    }
    const c1 = C.card(panel, 'Owner turnover',
      'Share of parcels persisting across an interval whose normalized owner changed, annualised on the real day count.');
    C.lineChart(c1, {
      series: [rate], labels: ['owner change %/yr'], colors: [cssVar('--cat-1')],
      xLabels: xl, fmt: (v) => C.fmtPct(v, 1), caption: 'Turnover rate',
    });

    const c2 = C.card(panel, 'Transfers versus address edits',
      'A mailing-state change on an unchanged owner is an address edit, not a sale. Conflating the two overstates out-of-state buying by about two thirds.');
    C.lineChart(c2, {
      series: [trans, addr],
      labels: ['transfer to another state', 'address change only'],
      colors: [cssVar('--cat-1'), cssVar('--cat-2')], xLabels: xl,
      fmt: (v) => C.fmtInt(v), caption: 'Interstate transfers vs address edits, per year',
    });

    const c3 = C.card(panel, 'Condominiumisation',
      'Units created inside an existing lot. Housing supply, but not land consumption — never mixed into fragmentation.');
    C.lineChart(c3, {
      series: [merged], labels: ['units created/yr'], colors: [cssVar('--cat-3')],
      xLabels: xl, fmt: C.fmtInt, caption: 'Condominium units created per year',
    });
  },
};

/* 5. Regulatory thresholds -- Tier 1.4 */
VIEWS.thresholds = {
  label: 'Thresholds',
  legend: 'New lots per 1,000 parcels per year',
  async render(panel) {
    const f = S.level === 'county' ? await countyFlow() : await twpFlow();
    const { c } = await activeStock('core');
    const ids = S.level === 'county' ? countyIds() : twpIds();
    const iv = Math.min(S.dim.intervals.length - 1, Math.max(0, S.snap - 1));
    const yrs = S.dim.intervals[iv]?.years || 1;
    const colors = new Map();
    const vals = new Map();
    for (const u of ids) {
      const at = u * f.nSnaps + iv;
      const ok = (f.data.comparable?.[at] ?? 0) > 0;
      const lots = f.data.lot_created?.[at] ?? 0;
      const stock = c.data.parcels?.[u * c.nSnaps + S.snap] ?? 0;
      if (ok && stock > 50) vals.set(u, (1000 * lots) / stock / yrs);
    }
    const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7', '--seq-8'].map(cssVar);
    const breaks = quantileBreaks(vals.values(), ramp.length);
    for (const u of ids) {
      const fid = unitFeatureId(u);
      if (fid == null) continue;
      colors.set(fid, vals.has(u) ? ramp[Math.min(7, classify(vals.get(u), breaks))] : cssVar('--masked'));
    }
    S.map.paint(colors);
    const arr = [...vals.values()].sort((a, b) => a - b);
    legend(ramp, fmtShort(arr[0] ?? 0), fmtShort(arr[arr.length - 1] ?? 0), false);

    const t = await loadTable('size_histogram');
    const col = (n) => t.columns.indexOf(n);
    const lo = col('bin_lo'), hi = col('bin_hi'), pr = col('parcels'), ivc = col('interval');
    const era = $('era')?.value || 'all';
    const bounds = era === 'early' ? [0, 11] : era === 'mid' ? [11, 20] : era === 'late' ? [20, 28] : [0, 99];
    const bins = new Map();
    for (const r of t.rows) {
      const i = Number(r[ivc]);
      if (i < bounds[0] || i >= bounds[1]) continue;
      const L = Number(r[lo]);
      if (!(L >= 10 && L < 32)) continue;
      bins.set(L, (bins.get(L) || 0) + Number(r[pr]));
    }
    const keys = [...bins.keys()].sort((a, b) => a - b);
    const refIdx = keys.findIndex((k) => k >= 20);
    const card = C.card(panel, 'Newly created parcel sizes around the 20-acre line',
      'Under MCA 76-4-102(16) and 76-4-125, a parcel of 20 acres or more that is exempt from the Platting Act escapes DEQ sanitation review. Mass just above the line exceeds mass just below by about 2×, while controls at 12, 15, 25, 30, 50 and 100 acres all sit near 1.0.');
    C.histogram(card, {
      values: keys.map((k) => bins.get(k)),
      xLabels: keys.map((k) => (Number.isInteger(k) ? String(k) : k.toFixed(1))),
      color: cssVar('--cat-1'), refAt: refIdx < 0 ? null : refIdx,
      refLabel: '20 ac', xTickEvery: 4,
      caption: 'Created-parcel size distribution, 10–32 acres',
    });
    const note = document.createElement('div');
    note.className = 'caveat';
    note.innerHTML = 'The spikes at exactly 40 and 160 acres elsewhere in the distribution are '
      + 'the PLSS survey grid, not review avoidance — a quarter-quarter section is 40 acres and '
      + 'a quarter section 160. 17% of created parcels land within 1% of an aliquot size.';
    card.appendChild(note);
  },
};

function maskLowCoverage(cov) {
  if (!S.maskLow) return null;
  return (u) => {
    const a = cov.data.coverage_ok;
    if (!a) return false;
    return (a[u * cov.nSnaps + S.snap] ?? 1) <= 0;
  };
}
function selectionNote() {
  if (!S.selection.size) return 'Statewide. Click a unit on the map to focus; shift-click to add.';
  const names = Array.from(S.selection).slice(0, 4).map((u) =>
    S.level === 'county' ? (S.dim.counties.find((c) => c.code === u)?.name ?? u)
      : (S.twpById.get(u)?.label ?? u));
  return `${S.selection.size} unit${S.selection.size > 1 ? 's' : ''}: ${names.join(', ')}${S.selection.size > 4 ? '…' : ''}`;
}

/* -------------------------------------------------------------------- wiring */
async function render() {
  const panel = $('panel');
  panel.textContent = '';
  const l = $('legend');
  l.dataset.title = VIEWS[S.view].legend;
  try {
    await VIEWS[S.view].render(panel);
  } catch (err) {
    console.error(err);
    const c = C.card(panel, 'Could not render this view');
    c.appendChild(document.createTextNode(String(err && err.message ? err.message : err)));
  }
  caveatCard(panel);
}

function caveatCard(panel) {
  const c = C.card(panel, 'How to read this');
  const ul = document.createElement('ul');
  for (const t of S.meta.caveats) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  }
  const d = document.createElement('div');
  d.className = 'caveat';
  d.appendChild(ul);
  c.appendChild(d);
}

function buildControls() {
  const nav = $('nav');
  for (const [k, v] of Object.entries(VIEWS)) {
    const b = document.createElement('button');
    b.textContent = v.label;
    b.setAttribute('aria-selected', String(k === S.view));
    b.addEventListener('click', () => {
      S.view = k;
      for (const o of nav.children) o.setAttribute('aria-selected', String(o === b));
      $('erawrap').hidden = k !== 'thresholds';
      $('originwrap').hidden = k !== 'ownership';
      render();
    });
    nav.appendChild(b);
  }
  const slider = $('snap');
  slider.max = String(S.nSnaps - 1);
  slider.value = String(S.nSnaps - 1);
  S.snap = S.nSnaps - 1;
  const setSnap = () => {
    S.snap = Number(slider.value);
    $('snaplabel').textContent = S.dim.snapshots[S.snap].date;
    render();
  };
  slider.addEventListener('input', () => {
    S.snap = Number(slider.value);
    $('snaplabel').textContent = S.dim.snapshots[S.snap].date;
  });
  slider.addEventListener('change', setSnap);
  $('snaplabel').textContent = S.dim.snapshots[S.snap].date;

  $('level').addEventListener('change', (e) => {
    S.level = e.target.value;
    S.selection.clear();
    S.map.setLevel(S.level);
    S.map.setSelection(new Set());
    render();
  });
  $('measure').addEventListener('change', (e) => { S.measure = e.target.value; render(); });
  $('mask').addEventListener('change', (e) => { S.maskLow = e.target.checked; render(); });
  $('era').addEventListener('change', render);
  $('basemap').addEventListener('change', (e) => S.map.setBasemap(e.target.value));

  const origin = $('origin');
  origin.appendChild(new Option('all origins', ''));
  for (const st of S.dim.states) {
    if (st && st.length === 2 && st !== 'MT') origin.appendChild(new Option(st, st));
  }
  origin.addEventListener('change', (e) => { S.originState = e.target.value; render(); });

  $('clearsel').addEventListener('click', () => {
    S.selection.clear(); S.map.setSelection(new Set()); render();
  });
  const t = document.getElementById('theme');
  t.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    if (S.map) S.map.retheme();
    render();
  });
}

export async function boot() {
  const [dim, meta, townships, counties] = await Promise.all([
    loadJSON('dim.json'), loadJSON('meta.json'),
    loadJSON('townships.geojson'), loadJSON('counties.geojson'),
  ]);
  S.dim = dim; S.meta = meta;
  S.nSnaps = dim.snapshots.length;
  S.nIv = dim.intervals.length;
  S.nTwp = dim.townships.length;
  for (const t of dim.townships) { S.twpByKey.set(t.tr, t); S.twpById.set(t.id, t); }

  $('boot').remove();
  $('app').hidden = false;
  $('sub').textContent =
    `${dim.snapshots.length} vintages · ${dim.townships.length.toLocaleString()} townships · `
    + `comparable series from ${meta.comparable_series_begins}`;

  S.map = new UnitMap('map', {
    onSelect: (level, id, props, additive) => {
      const u = level === 'county' ? Number(id) : (S.twpByKey.get(id)?.id ?? null);
      if (u == null) return;
      if (!additive) S.selection.clear();
      if (S.selection.has(u)) S.selection.delete(u); else S.selection.add(u);
      S.map.setSelection(new Set(Array.from(S.selection, unitFeatureId).filter((x) => x != null)));
      render();
    },
  });
  try {
    await S.map.init({ townships, counties });
  } catch (err) {
    // The map failing must not take the charts with it.
    console.error('map init failed', err);
    const w = document.getElementById('mapwrap');
    if (w) w.innerHTML = '<div style="padding:18px;color:var(--ink-2)">'
      + 'Map unavailable: ' + String(err && err.message ? err.message : err) + '</div>';
  }
  buildControls();
  await render();
}
