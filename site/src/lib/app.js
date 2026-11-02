/* ---------------------------------------------------------------------------
   app.js -- views, filters and wiring.

   Eight views, each answering one of the planning questions the pipeline
   supports, over one shared map surface and one shared time control, plus
   the Reports and About tabs.

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
import { REPORTS, renderReport } from './reports.js';

const S = {
  dim: null, meta: null, map: null,
  snap: 0, level: 'township', measure: 'parcels', view: 'ladder',
  maskLow: true, selection: new Set(), originState: '',
  twpByKey: new Map(), twpById: new Map(),
  cubes: {}, flows: {}, nSnaps: 0, nTwp: 0, nIv: 0,
  // The Reports view: which document, for which county or period, and
  // whether one has been composed (so a re-render redraws it).
  report: { kind: 'profile', county: 6, a: 0, b: 0, generated: false },
  reportGen: 0, reportOut: null,
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
/* ------------------------------------------------------- bivariate paint */
/*
   The Condition view draws two measures at once: condition across and age
   up, nine colours from the --bv-<condition><age> tokens. Units are cut at
   thirds of the units shown at the point (the same quantile rule the single
   ramps use), parcels at fixed classes; the legend is the grid itself with
   the cuts written out, and every cell names its pair on hover.
*/
const bvTok = (i, j) => cssVar(`--bv-${i}${j}`);
function bivariateLegendHTML({ title, x, y, note }) {
  const cells = [];
  for (let j = 3; j >= 1; j--) {
    for (let i = 1; i <= 3; i++) cells.push(`<i style="background:${bvTok(i, j)}" title="${x.classes[i - 1]} · ${y.classes[j - 1]}"></i>`);
  }
  return `<div class="title">${title}</div>
    <div class="bv"><div class="ylab">${y.label}</div><div class="grid">${cells.join('')}</div>
    <div></div><div class="xlab">${x.label}</div></div>
    <div class="note">Across, ${x.name}: ${x.classes.join(' · ')}. Up, ${y.name}: ${y.classes.join(' · ')}.${note ? ` ${note}` : ''}</div>`;
}
function paintBivariate(c, ids, fx, fy, { x, y, note = '' }) {
  const xs = new Map(), ys = new Map();
  const noValue = [];
  for (const u of ids) {
    const vx = fx(c, u, S.snap), vy = fy(c, u, S.snap);
    if (vx != null && isFinite(vx) && vy != null && isFinite(vy)) { xs.set(u, vx); ys.set(u, vy); }
    else noValue.push(u);
  }
  const masked = cssVar('--masked');
  const colors = new Map();
  for (const u of noValue) {
    const fid = unitFeatureId(u);
    if (fid != null) colors.set(fid, masked);
  }
  const bx = quantileBreaks(xs.values(), 3), by = quantileBreaks(ys.values(), 3);
  for (const [u, vx] of xs) {
    const fid = unitFeatureId(u);
    if (fid == null) continue;
    colors.set(fid, bvTok(Math.min(2, classify(vx, bx)) + 1, Math.min(2, classify(ys.get(u), by)) + 1));
  }
  const f = (v) => C.fmtPct(v, 0);
  const classes = (b) => (b.length < 2 ? ['low', 'middle', 'high'] : [`under ${f(b[0])}`, `${f(b[0])} to ${f(b[1])}`, `${f(b[1])} and over`]);
  const l = $('legend');
  if (S.map && S.map.zoom >= 10.5 && $('lyr-parcels')?.checked && parcelLegendHTML()) {
    l.innerHTML = parcelLegendHTML(); l.dataset.mode = 'parcel';
  } else {
    l.dataset.mode = '';
    l.innerHTML = bivariateLegendHTML({ title: l.dataset.title || '', x: { ...x, classes: classes(bx) },
      y: { ...y, classes: classes(by) }, note: `Classes are thirds of the units shown. ${note}`.trim() });
  }
  S.map.paint(colors);
  applyParcelStyle();
}

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
  applyParcelStyle();
}
const cssVar = C.cssVar;
const fmtShort = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
  : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k`
  : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

/** Parcel-scale legend: at deep zoom the surface IS the parcels, so the
 *  township metric's ramp is no longer what the reader is looking at. */
function parcelLegendHTML() {
  const items = PARCEL_LEGEND[S.view] || [];
  if (!items.length && S.view !== 'condition') return '';
  const when = S.dim.snapshots[S.snap]?.date || 'the selected vintage';
  const title = `Parcels &mdash; ${VIEWS[S.view].parcelLegend || 'colour key'}`;
  const head = S.parcelFill === false
    ? `<div class="title">${title}</div><div class="note">Fill off (Layers, under Parcels); the parcel lines and the outlines below remain.</div>`
    : S.view === 'condition'
    ? bivariateLegendHTML({ title, x: { label: 'poorer condition \u2192', name: 'DOR condition rating',
        classes: ['good or better (8 to 10)', 'average (7)', 'fair or worse (1 to 6)'] },
      y: { label: 'older \u2192', name: 'year built', classes: ['2005 on', '1980 to 2004', 'before 1980'] } })
      + `<div class="pl"><i style="background:${cssVar('--masked')}"></i>no dwelling on record</div>`
    : `<div class="title">${title}</div>`
      + items.map(([label, tok]) => `<div class="pl"><i style="background:${cssVar('--' + tok)}"></i>${label}</div>`).join('');
  // The one thing on the parcel map that follows the slider: the outline on
  // the parcels that did not yet exist at the vintage shown, by period.
  const st = periodStarts();
  const n = S.dim.snapshots.length;
  const cols = C.ramp('period', PERIODS.length);
  const later = PERIODS.map(([label], k) => ({ label, color: cols[k], from: st[k], to: (st[k + 1] ?? n) - 1 }))
    .filter((p) => p.from < n && p.to > S.snap);
  const outlines = later.length
    ? `<div class="note">Outlined: parcels that did not yet exist in ${when}, by the period first seen.</div>`
      + later.map((p) => `<div class="pl"><i class="ol" style="border-color:${p.color}"></i>${p.label}</div>`).join('')
    : `<div class="pl"><i class="ol" style="border-color:transparent"></i>no parcels created after ${when}</div>`;
  return head + outlines
    + '<div class="note">Colours are the 2026 state of each parcel. Parcels are '
    + 'drawn as they exist today, so one split later shows as its pieces at every '
    + 'date. Parcels first seen in or before the vintage a county\u2019s record arrived '
    + 'are its baseline, not creations, and are not outlined.</div>';
}

function refreshLegendForZoom() {
  if (!S.map) return;
  const l = $('legend');
  const parcelScale = S.map.zoom >= 10.5 && $('lyr-parcels')?.checked;
  if (parcelScale) {
    const html = parcelLegendHTML();
    if (html) { l.innerHTML = html; l.dataset.mode = 'parcel'; return; }
  }
  if (l.dataset.mode === 'parcel') { l.dataset.mode = ''; render(); }
}

function legend(ramp, lo, hi, diverging, reason) {
  const l = $('legend');
  if (S.map && S.map.zoom >= 10.5 && $('lyr-parcels')?.checked) {
    const html = parcelLegendHTML();
    if (html) { l.innerHTML = html; l.dataset.mode = 'parcel'; return; }
  }
  l.dataset.mode = '';
  // A blank surface must name its own cause. "Coverage mask" is the wrong
  // explanation when the vintage's field is simply dead.
  const why = reason
    ? `<div class="note"><strong>No data at this snapshot.</strong> ${reason}</div>`
    : '<div class="note">Grey = no comparable data (coverage mask), never zero.</div>';
  l.innerHTML = `<div class="title">${l.dataset.title || ''}</div>
    ${reason ? '' : `<div class="ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ends"><span>${lo}</span><span>${hi}</span></div>`}
    ${diverging && !reason ? '<div class="note">Diverging around zero; grey midpoint is no change.</div>' : ''}
    ${why}`;
}

/** Fields this vintage cannot report, from meta.field_availability. */
function unavailableAt(snap) {
  const rec = (S.meta.field_availability || []).find((r) => r.snapshot === snap);
  return rec ? rec.unavailable : [];
}
const FIELD_LABEL = {
  development_ladder: 'development ladder',
  agricultural_acreage: 'agricultural acreage',
};

/** A prominent card explaining a vintage-specific gap. */
function unavailableCard(panel, field) {
  const rec = (S.meta.field_availability || []).find((r) => r.snapshot === S.snap);
  const c = C.card(panel, `No ${FIELD_LABEL[field] || field} in this vintage`);
  const name = FIELD_LABEL[field] || field;
  const d = document.createElement('div');
  d.className = 'caveat';
  d.innerHTML = `The <strong>${S.dim.snapshots[S.snap].date}</strong> export ships the `
    + `columns this view needs entirely zero, so the ${name} is `
    + `<strong>unknown</strong> here, not zero. Every other measure in this snapshot is sound — `
    + `parcel counts, acreage, ownership and size classes all read normally. `
    + `The other 2009 vintage, <strong>2009-02-22</strong>, is unaffected.`;
  c.appendChild(d);
  return c;
}

/* ------------------------------------------------------------------ parcels */
/**
 * Data-driven paint for the actual-parcel layer, one expression per view.
 *
 * Attributes are baked into the tiles, so this is a pure styling decision with
 * no data fetch: `dev` ladder stage, `ten` tenure, `loc` absentee tier, `ac`
 * acres, `born` the snapshot index at which the parcel first appears.
 *
 * `born` is used to HIGHLIGHT parcels created in the selected interval, not to
 * reconstruct the historical fabric. The tiles carry today's parcels, so a
 * parcel split in 2010 appears as its children at every date; hiding the
 * children would leave a hole where the parent was rather than showing the
 * parent. Highlighting what is new is honest; pretending to rewind is not.
 */
/*
   The outline on the parcels that did not yet exist at the selected vintage,
   coloured by the period in which they first appeared, so that the 2003
   layer shows the whole subdivision history at once and each later vintage
   shows what was still to come. A parcel first seen in or before the vintage
   its county's record arrived (the coverage gate) is that county's baseline,
   not a creation, and is never outlined; the geocode's first two digits are
   the county, so the gate is applied in the client from the county cube.
*/
const PERIODS = [['2003 to 2005', 2003], ['2006 to 2010', 2006], ['2011 to 2015', 2011], ['2016 to 2020', 2016], ['2021 on', 2021]];
/** The first snapshot index in each period; index 0 is the baseline vintage, never a creation. */
function periodStarts() {
  const n = S.dim.snapshots.length;
  return PERIODS.map(([, y], k) => {
    const i = S.dim.snapshots.findIndex((sn) => sn.date >= `${y}-01-01`);
    return i < 0 ? n : (k === 0 ? Math.max(1, i) : i);
  });
}
function periodOf(born) {
  let p = -1;
  periodStarts().forEach((st, k) => { if (born >= st) p = k; });
  return p;
}
/** Each county's baseline: the first vintage that clears the coverage gate. */
function countyBaselines(cov) {
  const a = cov.data.coverage_ok;
  const out = {};
  for (let c = 1; c < cov.nUnits; c++) {
    let b = 0;
    if (a) for (let sn = 0; sn < cov.nSnaps; sn++) { if ((a[c * cov.nSnaps + sn] ?? 0) > 0) { b = sn; break; } }
    out[c] = b;
  }
  return out;
}
function createdOutline() {
  const born = ['coalesce', ['get', 'born'], -1];
  const base = S.countyBase
    ? ['match', ['to-number', ['slice', ['get', 'id'], 0, 2]],
        ...Object.entries(S.countyBase).flatMap(([c, b]) => [Number(c), b]), 0]
    : 0;
  const st = periodStarts();
  const n = S.dim.snapshots.length;
  const cols = C.ramp('period', PERIODS.length);
  const color = ['step', born, cols[0]];
  for (let k = 1; k < st.length; k++) if (st[k] > st[k - 1] && st[k] < n) color.push(st[k], cols[k]);
  return { filter: ['all', ['>', born, S.snap], ['>', born, base]], color };
}

function parcelStyle() {
  const ord3 = C.ramp('ord3', 3);
  const ord5 = C.ramp('ord5', 5);
  const masked = cssVar('--masked');
  const created = createdOutline();

  switch (S.view) {
    case 'ladder':
      // 4 = dedicated common area (open space, park, HOA tract): on the map in
      // chartreuse, a colour apart from the public-land green so the two kinds
      // of green cannot be read as one; off the ladder in every count.
      return [['match', ['get', 'dev'], 0, ord3[0], 1, ord3[1], 2, ord3[2],
        4, cssVar('--open-space'), masked], created];
    case 'ownership': {
      const by = S.measure === 'acres' ? 'loc' : 'ten';
      if (by === 'ten') {
        return [['match', ['get', 'ten'],
          0, cssVar('--cat-1'), 1, cssVar('--cat-2'), 2, cssVar('--cat-3'), masked], null];
      }
      return [['match', ['get', 'loc'],
        0, ord3[0], 1, ord3[0], 2, ord3[1], 3, ord3[2], masked], null];
    }
    case 'fragmentation':
      return [['step', ['get', 'ac'],
        ord5[0], 5, ord5[1], 40, ord5[2], 160, ord5[3], 640, ord5[4]], null];
    case 'churn':
      return [['match', ['get', 'ten'],
        0, masked, 1, masked, 2, ord3[1], masked], created];
    case 'holdings':
      // The paper's Figure 1 at parcel scale: the four largest holdings in the
      // county, other large holdings, small private; then the land outside
      // the private universe, public in the forest-service green the overlay
      // uses and tribal trust in its own colour. What is left (hs -1 with a
      // private tenure code) has no owner of record or is public by area
      // only, and stays muted rather than being passed off as either.
      return [['case',
        ['>', ['coalesce', ['get', 'hr'], 0], 0], cssVar('--statute'),
        ['>=', ['coalesce', ['get', 'hs'], -1], 1], ord5[3],
        ['==', ['coalesce', ['get', 'hs'], -1], 0], ord5[0],
        ['==', ['coalesce', ['get', 'ten'], 2], 0], cssVar('--public-land'),
        ['==', ['coalesce', ['get', 'ten'], 2], 1], cssVar('--cat-2'),
        masked], null];
    case 'review':
      return [['case',
        ['all', ['>=', ['coalesce', ['get', 'hs'], -1], 1], ['==', ['coalesce', ['get', 'hp'], 0], 1]], cssVar('--statute'),
        ['>=', ['coalesce', ['get', 'hs'], -1], 1], ord5[3],
        ['==', ['coalesce', ['get', 'hs'], -1], 0], ord5[0],
        ['==', ['coalesce', ['get', 'ten'], 2], 0], cssVar('--public-land'),
        ['==', ['coalesce', ['get', 'ten'], 2], 1], cssVar('--cat-2'),
        masked], null];
    case 'condition': {
      // The DOR's rating across (good or better, average, fair or worse) and the
      // year built up (2005 on, 1980 to 2004, before 1980): the nine cells of the
      // unit map in fixed classes. `cd` is the ordinal 0-7 of the eight classes
      // the DOR uses, 0-3 being fair (6) or worse and 4 average (7).
      const cd = ['coalesce', ['get', 'cd'], -1];
      const yb = ['coalesce', ['get', 'yb'], 0];
      const ci = ['case', ['<=', cd, 3], 3, ['==', cd, 4], 2, 1];
      const aj = ['case', ['<', yb, 1980], 3, ['<', yb, 2005], 2, 1];
      const cells = [];
      for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) cells.push(i * 10 + j, bvTok(i, j));
      return [['case', ['any', ['<', cd, 0], ['<=', yb, 0]], masked,
        ['match', ['+', ['*', ci, 10], aj], ...cells, masked]], null];
    }
    case 'thresholds':
      // The 20-acre statutory line, drawn on the parcels themselves.
      return [['step', ['get', 'ac'],
        ord5[0], 20, cssVar('--statute'), 40, ord5[2], 160, ord5[4]], created];
    default:
      return [ord5[2], null];
  }
}

const PARCEL_LEGEND = {
  ladder: [['platted only', 'ord3-1'], ['addressed', 'ord3-2'], ['built', 'ord3-3'],
           ['common area / open space (off the ladder)', 'open-space']],
  ownership: [['public domain', 'cat-1'], ['tribal trust', 'cat-2'], ['private', 'cat-3']],
  fragmentation: [['<5 ac', 'ord5-1'], ['5-40', 'ord5-2'], ['40-160', 'ord5-3'],
                  ['160-640', 'ord5-4'], ['>640', 'ord5-5']],
  churn: [['private parcel', 'ord3-2']],
  thresholds: [['under 20 ac', 'ord5-1'], ['20-40 ac (above the DEQ line)', 'statute'],
               ['40-160', 'ord5-3'], ['over 160', 'ord5-5']],
  holdings: [['four largest holdings in the county', 'statute'], ['other 640+ ac holding', 'ord5-4'],
             ['private, under 640 ac', 'ord5-1'], ['public land', 'public-land'], ['tribal trust', 'cat-2'],
             ['no owner of record, or public by area only', 'masked']],
  review: [['holding awaits a review decision', 'statute'], ['640+ ac holding, clean', 'ord5-4'],
           ['private, under 640 ac', 'ord5-1'], ['public land', 'public-land'], ['tribal trust', 'cat-2'],
           ['no owner of record, or public by area only', 'masked']],
};

function applyParcelStyle() {
  if (!S.map) return;
  if (!S.countyBase && !S.countyBasePending) {
    // The county gate arrives with the county cube; paint without it first
    // and once more when it lands.
    S.countyBasePending = true;
    countyCube().then((cov) => { S.countyBase = countyBaselines(cov); applyParcelStyle(); });
  }
  const [color, outline] = parcelStyle();
  S.map.setParcelPaint(color, outline);
}

/* -------------------------------------------------------------------- views */
const VIEWS = {};

/* 1. Development ladder -- Tier 1.1 */
VIEWS.ladder = {
  parcelLegend: 'development stage',
  label: 'Development',
  legend: 'Share of parcels addressed but unbuilt',
  async render(panel) {
    const dev = await twpCube('dev');
    const { c, ids } = await activeStock('dev');
    const cov = S.level === 'county' ? await countyCube() : await twpCube('core');
    const gone = unavailableAt(S.snap);
    if (gone.includes('development_ladder')) {
      const masked = cssVar('--masked');
      const colors = new Map();
      for (const u of ids) {
        const fid = unitFeatureId(u);
        if (fid != null) colors.set(fid, masked);
      }
      S.map.paint(colors);
      legend([], '', '', false,
        `The ${S.dim.snapshots[S.snap].date} export ships its value columns entirely `
        + 'zero, so improvement status is unknown in this vintage — not a coverage gap.');
      unavailableCard(panel, 'development_ladder');
    }

    if (!gone.includes('development_ladder')) paintFrom(c, ids, (cc, u, s) => {
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
    // Dedicated common areas are counted apart (n_dev4) and never enter the
    // ladder's shares; the tile below says how many were set aside.
    const common = seriesOf(c, 'n_dev4', units);
    // A vintage whose export carries no building values (2009-07-05) puts
    // every parcel at "unknown". It is left out of the chart rather than drawn
    // as a wedge of no data, so the stack runs from the vintage before it to
    // the one after; the card says which vintage is missing.
    const known = [...Array(S.nSnaps).keys()].filter((i) => (ser[0][i] + ser[1][i] + ser[2][i]) > 0);
    const left = [...Array(S.nSnaps).keys()].filter((i) => !known.includes(i))
      .map((i) => S.dim.snapshots[i].date);
    const pick = (s) => known.map((i) => s[i] || 0);
    const use = (S.measure === 'acres' ? acr : ser).map(pick);
    const stackLabels = ['platted only', 'addressed', 'built'];
    const stackColors = C.ramp('ord3', 3);
    const allLabels = snapLabels();

    const tot = ser.reduce((a, s) => a + s[S.snap], 0);
    // Zeroes and NaN% here would read as a measurement; the explanatory card
    // above already says the vintage cannot report this.
    if (!gone.includes('development_ladder')) C.stats(
      C.card(panel, 'At the selected snapshot', selectionNote()), [
      { value: C.fmtInt(ser[1][S.snap]), label: 'addressed, not built',
        detail: tot ? `${((100 * ser[1][S.snap]) / (ser[0][S.snap] + ser[1][S.snap] + ser[2][S.snap])).toFixed(1)}% of parcels` : '' },
      { value: C.fmtInt(ser[0][S.snap]), label: 'platted only' },
      { value: C.fmtInt(ser[2][S.snap]), label: 'built' },
      { value: C.fmtInt(common[S.snap]), label: 'common area, off the ladder',
        detail: 'dedicated open space, parks, HOA and condo tracts' },
    ]);

    const k1 = C.card(panel, 'The ladder over time',
      'Platted only → address assigned → assessed building value. A parcel with a house number carries a building 89–91% of the time. Dedicated common areas are not on the ladder.'
      + (left.length ? ` The ${left.join(', ')} export carries no building values and is left out.` : ''));
    C.stackedArea(k1, {
      series: use, labels: stackLabels, colors: stackColors,
      xLabels: known.map((i) => allLabels[i]), share: true,
      fmt: S.measure === 'acres' ? C.fmtAc : C.fmtInt,
      caption: 'Ladder composition, table view',
    });

    await absorptionCard(panel);
    await dormantCard(panel);
  },
};

/* ------------------------------------------------------------ condition */
/*
   1b. Condition of the housing stock, and the DOR's building records as a
   witness to the ladder (stage 11, timeseries/cama.py).

   Eight points rather than a continuous series: three ORION refreshes,
   each tax year joined to the parcel export that carries its roll -- tax
   years 2014, 2015-2018 and 2024-2026. The time slider selects the nearest
   point at or before the vintage shown, and every card names it. The
   parcels/acres toggle does not apply: the unit is the dwelling. The rating
   is CDU, the composite, through 2014 and the DOR's physical-condition
   component from 2015, when the composite was retired by copying it into
   its components; each point names its field.
*/
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const CD_COLS = [...Array(8).keys()].map((i) => `n_cd${i}`);
const YB_COLS = [...Array(9).keys()].map((i) => `n_yb${i}`);
const WITNESS_TWP = ['parcels_tested', 'improved_layer', 'struct_dor', 'agree_built', 'layer_only', 'dor_only',
  'addr_tested', 'addr_hn_pt', 'addr_hn_nopt', 'addr_dw_res', 'addr_dw_nores'];
const WITNESS_CTY = [...WITNESS_TWP, 'addr_pt_nohn', 'addr_res_nodw', 'hn_dwell', 'hn_nodwell', 'nohn_dwell', 'dormant_lt40', 'dormant_dwell',
  'dormant_struct', 'dormant_permit', 'stage1', 'stage1_dwell', 'timing_n', 'timing_never', 'timing_ontime',
  'born_dwell', 'born_older', 'insp_recent', 'value_n', 'value_equal'];
const shortCond = (l) => String(l).replace(/ \(\d+\)/, '');
const ratedOf = (o) => CD_COLS.reduce((a, n) => a + (o[n] || 0), 0);
const belowShare = (o) => { const r = ratedOf(o); return r ? (100 * (o.n_cd0 + o.n_cd1 + o.n_cd2 + o.n_cd3)) / r : NaN; };
const pre1980Share = (o) => { const t = YB_COLS.reduce((a, n) => a + (o[n] || 0), 0); return t ? (100 * (o.n_yb0 + o.n_yb1 + o.n_yb2 + o.n_yb3 + o.n_yb4)) / t : NaN; };
const pctOf = (n, d) => (d ? (100 * n) / d : NaN);

async function camaTables() {
  if (S.cama) return S.cama;
  const [twp, cty, tim, cbd, tr] = await Promise.all([
    loadTable('cama_township'), loadTable('cama_county'), loadTable('cama_timing'),
    loadTable('cama_condition_decade'), loadTable('cama_transitions')]);
  const si = cty.columns.indexOf('s');
  const points = [...new Set(cty.rows.map((r) => num(r[si])))].sort((a, b) => a - b);
  // One Map of unit -> row per point: small, and the slider only ever asks for one point.
  const byPoint = (t, key) => {
    const k = t.columns.indexOf(key), s = t.columns.indexOf('s');
    const maps = new Map(points.map((p) => [p, new Map()]));
    for (const r of t.rows) maps.get(num(r[s]))?.set(num(r[k]), r);
    return maps;
  };
  S.cama = { twp, cty, tim, cbd, tr, points, twpBy: byPoint(twp, 'u'), ctyBy: byPoint(cty, 'county_n') };
  return S.cama;
}
/** The series point at or before a snapshot index, else the first. */
const pointAt = (T, snap) => { let p = T.points[0]; for (const s of T.points) if (s <= snap) p = s; return p; };
const pointMeta = (s) => (S.meta.cama?.points || []).find((p) => p.s === s) || {};
const taxYearOf = (s) => pointMeta(s).tax_year ?? s;
/** Sum the named columns of table `t` over the rows keyed by `units`. */
function camaSum(t, byMap, units, names) {
  const out = {};
  const ci = names.map((n) => t.columns.indexOf(n));
  for (const n of names) out[n] = 0;
  if (!byMap) return out;
  for (const u of units) {
    const r = byMap.get(u);
    if (!r) continue;
    names.forEach((n, i) => { if (ci[i] >= 0) out[n] += num(r[ci[i]]); });
  }
  return out;
}
/** Condition x year-built-bin counts at one point, summed over county rows (0 = statewide). */
function condByDecade(T, counties, s) {
  const c = (n) => T.cbd.columns.indexOf(n);
  const ki = c('county_n'), bi = c('yb_bin'), di = c('cond'), ni = c('dwellings'), si = c('s');
  const want = new Set(counties);
  const grid = [...Array(8)].map(() => new Float64Array(9));
  for (const r of T.cbd.rows) {
    if (num(r[si]) !== s || !want.has(num(r[ki]))) continue;
    grid[num(r[di])][num(r[bi])] += num(r[ni]);
  }
  return grid;
}
/** Year-built cohort x ladder lag at one point, summed over county rows (0 = statewide). */
function timingSeries(T, counties, s) {
  const c = (n) => T.tim.columns.indexOf(n);
  const ki = c('county_n'), yi = c('yb'), si = c('s');
  const want = new Set(counties);
  const names = ['earlier', 'on_time', 'late1', 'late2plus', 'never'];
  const by = new Map();
  for (const r of T.tim.rows) {
    if (num(r[si]) !== s || !want.has(num(r[ki]))) continue;
    const y = num(r[yi]);
    if (!by.has(y)) by.set(y, Object.fromEntries(names.map((n) => [n, 0])));
    const o = by.get(y);
    for (const n of names) o[n] += num(r[c(n)]);
  }
  const years = [...by.keys()].sort((a, b) => a - b);
  return { years, series: names.map((n) => years.map((y) => by.get(y)[n])) };
}
/** Point-to-point transitions summed over county rows (0 = statewide). */
function transitionSeries(T, counties) {
  const c = (n) => T.tr.columns.indexOf(n);
  const want = new Set(counties);
  const by = new Map();
  for (const r of T.tr.rows) {
    if (!want.has(num(r[c('county_n')]))) continue;
    const key = `${num(r[c('s_from')])}>${num(r[c('s')])}`;
    if (!by.has(key)) by.set(key, { from: num(r[c('s_from')]), to: num(r[c('s')]), n: 0, same: 0, worse: 0, better: 0, worse2plus: 0, better2plus: 0 });
    const o = by.get(key);
    for (const k of ['n', 'same', 'worse', 'better', 'worse2plus', 'better2plus']) o[k] += num(r[c(k)]);
  }
  return [...by.values()].sort((a, b) => a.to - b.to);
}
function witnessTiles(host, w, { full, statewide }) {
  const vacantBoth = w.parcels_tested - w.improved_layer - w.dor_only;
  const agree = pctOf(w.agree_built + vacantBoth, w.parcels_tested);
  const sw = statewide ? ` · statewide ${C.fmtPct(pctOf(statewide.agree_built + statewide.parcels_tested - statewide.improved_layer - statewide.dor_only, statewide.parcels_tested))}` : '';
  const items = [
    { value: C.fmtPct(agree), label: 'parcels where the two records agree',
      detail: `${C.fmtInt(w.parcels_tested)} parcels tested${sw}` },
    { value: C.fmtInt(w.layer_only), label: 'built per the parcel layer, no DOR structure',
      detail: `${C.fmtPct(pctOf(w.layer_only, w.improved_layer))} of parcels with a building value` },
    { value: C.fmtInt(w.dor_only), label: 'DOR structure, parcel layer unimproved',
      detail: `${C.fmtPct(pctOf(w.dor_only, w.struct_dor))} of parcels with a DOR structure` },
  ];
  if (w.addr_tested > 0) {
    // Stage 12: the Structures Framework's address points, newest export only.
    items.push(
      { value: C.fmtPct(pctOf(w.addr_hn_pt, w.addr_hn_pt + w.addr_hn_nopt)), label: 'house numbers with an address point on the parcel',
        detail: `Structures Framework · ${C.fmtInt(w.addr_hn_nopt)} house numbers with no point` },
      { value: C.fmtPct(pctOf(w.addr_dw_res, w.addr_dw_res + w.addr_dw_nores)), label: 'dwellings on record with a residential address point',
        detail: `${C.fmtInt(w.addr_dw_nores)} dwellings without one` });
  }
  if (full) {
    items.push(
      { value: C.fmtInt(w.dormant_dwell), label: 'dormant lots that carry a dwelling',
        detail: `of ${C.fmtInt(w.dormant_lt40)} lots under 40 ac the ladder holds at platted only` },
      { value: C.fmtInt(w.stage1_dwell), label: 'addressed, not built — but a dwelling on record',
        detail: `of ${C.fmtInt(w.stage1)} parcels at the addressed stage` },
      { value: C.fmtPct(pctOf(w.timing_ontime, w.timing_n)), label: 'dwellings built 2004+ on the ladder by the first export that could carry them',
        detail: `${C.fmtInt(w.timing_never)} of ${C.fmtInt(w.timing_n)} never seen` },
      { value: C.fmtPct(pctOf(w.born_older, w.born_dwell)), label: 'new lots whose dwelling is older than the lot',
        detail: `${C.fmtInt(w.born_older)} of ${C.fmtInt(w.born_dwell)} lots first seen in the series` },
      { value: C.fmtPct(pctOf(w.value_equal, w.value_n)), label: 'building values equal to the DOR final value',
        detail: w.value_n ? `within one dollar · ${C.fmtInt(w.value_n)} parcels` : 'valuation table incomplete for this tax year' },
      { value: C.fmtPct(pctOf(w.hn_dwell, w.hn_dwell + w.hn_nodwell)), label: 'house numbers that carry a dwelling',
        detail: `${C.fmtInt(w.nohn_dwell)} dwellings without a house number` },
    );
  }
  C.stats(host, items);
}

VIEWS.condition = {
  parcelLegend: 'dwelling condition and year built, DOR records (newest point)',
  label: 'Condition',
  legend: 'Condition and age of the housing stock',
  async render(panel) {
    const T = await camaTables();
    const L = S.dim.labels.condition || [];
    const YBL = S.dim.labels.year_built || [];
    const cm = S.meta.cama || {};
    const s = pointAt(T, S.snap);
    const pm = pointMeta(s);
    const ty = pm.tax_year ?? cm.tax_year;
    const pointDate = S.dim.snapshots[s]?.date ?? '';
    const slipped = S.snap !== s;
    const ptsTxt = T.points.map(taxYearOf).join(', ');
    const twpLevel = S.level === 'township';
    const tbl = twpLevel ? T.twp : T.cty;
    const byMaps = twpLevel ? T.twpBy : T.ctyBy;
    const byMap = byMaps.get(s);
    const ids = twpLevel ? twpIds() : countyIds();
    const cdIdx = CD_COLS.map((n) => tbl.columns.indexOf(n));

    // The map: the share of rated dwellings fair or worse across and the share
    // built before 1980 up, at the point, masked under 25 rated. The mask here
    // is a count floor, not the coverage gate, and the legend must say so.
    const ybIdx = YB_COLS.map((n) => tbl.columns.indexOf(n));
    const rowOf = (u) => {
      const r = byMap?.get(u);
      if (!r) return null;
      const o = {};
      CD_COLS.forEach((n, i) => { o[n] = num(r[cdIdx[i]]); });
      YB_COLS.forEach((n, i) => { o[n] = num(r[ybIdx[i]]); });
      return ratedOf(o) >= 25 ? o : null;
    };
    paintBivariate(T, ids, (_t, u) => { const o = rowOf(u); return o ? belowShare(o) : null; },
      (_t, u) => { const o = rowOf(u); return o ? pre1980Share(o) : null; },
      { x: { label: 'poorer condition \u2192', name: 'share of rated dwellings fair or worse' },
        y: { label: 'older \u2192', name: 'share built before 1980' },
        note: `Tax year ${ty}, from the ${pointDate} export. Grey = fewer than 25 rated dwellings, or none on record.` });

    const sel = selectedUnits();
    const src = sel ? { t: tbl, m: byMaps, u: sel } : { t: T.cty, m: T.ctyBy, u: [0] };
    const base = camaSum(src.t, src.m.get(s), src.u, ['dwellings', 'rated', 'mh', 'condo_th', 'partial', ...CD_COLS, ...YB_COLS]);
    const stw = camaSum(T.cty, T.ctyBy.get(s), [0], ['dwellings', 'rated', 'mh', ...CD_COLS, ...YB_COLS]);
    const one = src.u.length === 1 ? src.m.get(s)?.get(src.u[0]) : null;
    const medYb = one ? num(one[src.t.columns.indexOf('yb_median')]) : NaN;
    const field = pm.rating_field === 'CDU' ? 'CDU, the composite rating' : 'the physical-condition rating';

    C.stats(C.card(panel, `Dwellings on record, tax year ${ty}`, `${selectionNote().replace(/\.?$/, '.')} `
      + `From the ${pointDate} export (ORION refresh ${pm.refresh_date || 'n/a'}); the rating is ${field}. `
      + (slipped
        ? `The slider is at ${S.dim.snapshots[S.snap]?.date}; building records exist for tax years ${ptsTxt}, and the nearest earlier point is shown.`
        : `Building records exist for tax years ${ptsTxt}.`)), [
      { value: C.fmtInt(base.dwellings), label: 'parcels with a dwelling', detail: `${C.fmtInt(base.rated)} rated` },
      { value: C.fmtPct(belowShare(base)), label: 'rated fair or worse', detail: `statewide ${C.fmtPct(belowShare(stw))}` },
      { value: C.fmtInt(base.n_cd0 + base.n_cd1), label: 'unsound or very poor',
        detail: `${C.fmtPct(pctOf(base.n_cd0 + base.n_cd1, ratedOf(base)))} of rated` },
      { value: isFinite(medYb) && medYb > 0 ? String(Math.round(medYb)) : '--', label: 'median year built',
        detail: `${C.fmtPct(pre1980Share(base))} built before 1980` },
      { value: C.fmtPct(pctOf(base.mh, base.dwellings)), label: 'manufactured homes',
        detail: `${C.fmtInt(base.partial)} partly complete` },
    ]);

    const seq = C.ramp('seq', 8).slice().reverse();
    const k1 = C.card(panel, 'Condition of the principal dwelling',
      'The DOR’s rating on its own scale, Unsound (1) to Excellent (10). Through tax year 2014 the DOR filled CDU, '
      + 'the composite of condition, desirability and utility; at the 2015 reappraisal it retired the composite by '
      + 'copying it into four components and has rated them apart since. The physical-condition component is shown from 2015.');
    C.histogram(k1, { values: CD_COLS.map((n) => base[n]), xLabels: L.map(shortCond), xTickEvery: 1,
      color: cssVar('--cat-1'), caption: `Dwellings by condition class, tax year ${ty}` });
    C.table(k1, { headers: ['condition', 'dwellings', 'share', 'statewide'],
      rows: CD_COLS.map((n, i) => [L[i], C.fmtInt(base[n]), C.fmtPct(pctOf(base[n], ratedOf(base))), C.fmtPct(pctOf(stw[n], ratedOf(stw)))]),
      caption: 'Condition classes, selection against statewide' });

    // ---- the series
    const xl = T.points.map((p) => String(taxYearOf(p)));
    const ser = T.points.map((p) => camaSum(src.t, src.m.get(p), src.u, CD_COLS));
    const serSt = T.points.map((p) => camaSum(T.cty, T.ctyBy.get(p), [0], CD_COLS));
    const kS = C.card(panel, 'Condition over the series',
      'Every point the three refreshes give: tax years 2014, 2015 to 2018 and 2024 to 2026. The 2014 point is the '
      + 'composite CDU and the rest the physical-condition component it was copied into, so the seam is a change of '
      + 'field, not of housing. No refresh is on hand between 2018 and 2024.');
    C.stackedArea(kS, { series: CD_COLS.map((n) => ser.map((o) => o[n])), labels: L.map(shortCond), colors: seq,
      xLabels: xl, share: true, xTickEvery: 1, caption: 'Condition composition by tax year' });
    C.lineChart(kS, { series: [ser.map(belowShare), serSt.map(belowShare)], labels: ['selection', 'Montana'],
      colors: [cssVar('--cat-1'), cssVar('--cat-3')], xLabels: xl, fmt: (v) => C.fmtPct(v), xTickEvery: 1,
      caption: 'Share rated fair or worse, by tax year' });

    const counties = !twpLevel && sel ? sel : [0];
    const trs = transitionSeries(T, counties);
    if (trs.length) {
      const kT = C.card(panel, 'The same dwellings, point to point',
        (twpLevel && sel ? 'Statewide: transitions are published at county grain. ' : '')
        + 'Single-dwelling properties rated at both ends of each interval, followed by the DOR’s property id. '
        + '“Worse” and “better” are any step on the scale; the first interval crosses the change of field.');
      const xt = trs.map((t) => `${taxYearOf(t.from)}→${String(taxYearOf(t.to)).slice(2)}`);
      C.lineChart(kT, { series: [trs.map((t) => pctOf(t.worse, t.n)), trs.map((t) => pctOf(t.better, t.n))],
        labels: ['rated worse', 'rated better'], colors: [cssVar('--statute'), cssVar('--cat-1')], xLabels: xt,
        fmt: (v) => C.fmtPct(v), xTickEvery: 1, caption: 'Share of followed dwellings re-rated, by interval' });
      C.table(kT, { headers: ['interval', 'dwellings followed', 'same', 'worse', 'better', 'two or more steps worse'],
        rows: trs.map((t, i) => [xt[i], C.fmtInt(t.n), C.fmtPct(pctOf(t.same, t.n)), C.fmtPct(pctOf(t.worse, t.n)),
          C.fmtPct(pctOf(t.better, t.n)), C.fmtPct(pctOf(t.worse2plus, t.n))]),
        caption: 'Transitions, table view' });
    }

    const k2 = C.card(panel, 'When the dwellings were built',
      `Earliest dwelling on the parcel, by the DOR’s year built, at tax year ${ty}. The series the other views draw on begins in 2003.`);
    C.histogram(k2, { values: YB_COLS.map((n) => base[n]), xLabels: YBL, color: cssVar('--cat-3'), xTickEvery: 1,
      caption: 'Dwellings by year built' });

    const k3 = C.card(panel, 'Condition by age',
      (twpLevel && sel ? 'Statewide: condition by age is published at county grain. ' : '')
      + `Share of each year-built cohort in each condition class at tax year ${ty}. Older housing should rate worse; `
      + 'where it does not, the rating is stale or the stock was rebuilt.');
    const grid = condByDecade(T, counties, s);
    C.stackedArea(k3, { series: grid, labels: L.map(shortCond), colors: seq, xLabels: YBL, share: true,
      caption: 'Condition by year-built cohort, table view' });

    const k4 = C.card(panel, 'What the building records say about the ladder',
      `At tax year ${ty}. The parcel layer’s building value and house number are inferred signals; the DOR’s dwelling, `
      + 'commercial and outbuilding records are the appraiser’s. Each tile is a test with a count on both sides. '
      + (twpLevel && sel ? 'The fuller set of tests is published at county grain; switch to counties to see it.' : ''));
    const wcols = twpLevel && sel ? WITNESS_TWP : WITNESS_CTY;
    const w = camaSum(src.t, src.m.get(s), src.u, wcols);
    const wsw = camaSum(T.cty, T.ctyBy.get(s), [0], WITNESS_CTY);
    witnessTiles(k4, w, { full: !(twpLevel && sel), statewide: sel ? wsw : null });
    if (!(twpLevel && sel)) {
      const tm = timingSeries(T, counties, s);
      if (tm.years.length) {
        C.stackedArea(k4, { series: tm.series,
          labels: ['earlier structure on the parcel', 'on time', 'one roll late', 'two or more rolls late', 'never'],
          colors: C.ramp('ord5', 5), xLabels: tm.years.map(String), share: true,
          caption: 'Dwellings by year built: when the ladder first showed a building value, in tax-year rolls' });
        const d = document.createElement('div');
        d.className = 'caveat';
        d.innerHTML = 'A dwelling built in year Y goes on the Y+1 roll, and an export carries its own year’s roll only '
          + 'from July: the January exports still hold the previous year’s values. “On time” is the first export '
          + 'that could carry the dwelling. “Earlier structure” means a value stood on the parcel before the year '
          + 'built. “Never” is a miss: the DOR holds a dwelling the parcel layer has not valued. The January export '
          + 'of the following year carries the roll, so the missing 2012 and 2015 exports cost no dwelling its '
          + 'on-time reading.';
        k4.appendChild(d);
      }
    }

    const ci = (n) => T.cty.columns.indexOf(n);
    const ranked = [...(T.ctyBy.get(s) || new Map()).entries()]
      .filter(([u]) => u > 0)
      .map(([u, r]) => { const o = {}; CD_COLS.forEach((n) => { o[n] = num(r[ci(n)]); }); return { u, rated: ratedOf(o), v: belowShare(o) }; })
      .filter((d) => d.rated >= 100 && isFinite(d.v))
      .sort((a, b) => b.v - a.v).slice(0, 15);
    const k5 = C.card(panel, 'Counties with the largest share of housing rated fair or worse',
      `Counties with at least 100 rated dwellings, tax year ${ty}.`);
    C.rankBars(k5, { items: ranked.map((d) => ({ label: countyLabel(d.u), value: d.v, detail: `${C.fmtInt(d.rated)} rated` })),
      color: cssVar('--cat-1'), fmt: (v) => C.fmtPct(v), caption: 'Share rated fair or worse, by county' });
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
    'Of the lots created at each vintage, the share carrying an assessed building N years later. Curves plateau near 50–58%. '
    + 'Two things the DOR’s building records showed (Condition view): a third of new lots that carry a house were split off '
    + 'around an existing one, so the curves start part-full; and a January export carries the previous year’s roll, so a '
    + 'cohort’s built share can run up to a year behind.');
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
  parcelLegend: 'tenure',
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
    await reservationCard(panel);
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

async function reservationCard(panel) {
  if (!S.dim.reservations || !S.dim.reservations.length) return;
  let t;
  try { t = await loadTable('reservation_stock'); } catch { return; }
  const col = (n) => t.columns.indexOf(n);
  const ri = col('r'), si = col('s'), ti = col('ten'), ai = col('acres');
  const names = S.dim.reservations;
  const nS = S.nSnaps;
  const tribalIdx = S.dim.labels.tenure.indexOf('tribal_trust');
  const trib = names.map(() => new Float64Array(nS));
  const tot = names.map(() => new Float64Array(nS));
  for (const row of t.rows) {
    const r = Number(row[ri]), sn = Number(row[si]), ten = Number(row[ti]);
    const ac = Number(row[ai]) || 0;
    if (!(r >= 0 && r < names.length && sn >= 0 && sn < nS)) continue;
    tot[r][sn] += ac;
    if (ten === tribalIdx) trib[r][sn] += ac;
  }
  const facets = names.map((n, i) => ({
    label: n.replace(/'S$/, "'s").replace(/\b(\w)(\w*)/g, (_, a, b) => a + b.toLowerCase()),
    values: Float64Array.from(trib[i], (v, j) => (tot[i][j] ? (100 * v) / tot[i][j] : NaN)),
  }));
  const card = C.card(panel, 'The checkerboard: tribal trust share inside each reservation',
    'A reservation boundary is jurisdictional, not ownership. Reservations hold large amounts of fee land from the allotment era — 59% of Fort Peck by acreage — so the share held in trust varies from 40% to 100%. Rising share is land returning to trust.');
  C.smallMultiples(card, {
    facets, xLabels: snapLabels(), color: cssVar('--cat-2'), yMax: 100,
    caption: 'Tribal-trust share of acreage by reservation', cols: 2,
  });
  const note = document.createElement('div');
  note.className = 'caveat';
  note.textContent = 'Statewide, tribal trust rises from 4.95M to 5.36M acres across the series. '
    + 'Owner names drift between vintages, so trust status is confirmed where three independent '
    + 'sources agree: a bare-sovereign name, reservation or off-reservation trust land, and '
    + 'absence from the public-lands layer.';
  card.appendChild(note);
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
  parcelLegend: 'parcel size',
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
    if (unavailableAt(S.snap).includes('agricultural_acreage')) {
      unavailableCard(panel, 'agricultural_acreage');
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
  parcelLegend: 'private parcels',
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
    applyParcelStyle();
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
  parcelLegend: 'size against the 20-acre line',
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
    applyParcelStyle();
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

/* ------------------------------------------------------------ holdings */
/*
   6 and 7. Large private holdings and their review -- Haggerty et al. (2022).

   The unit is the county, the paper's unit, so both views force the county
   level. county_n 0 carries the statewide row, used when nothing is selected.
   Ratios (CLO4, Gini, top shares) are per county and cannot be summed over a
   selection, so a multi-county selection draws them as small multiples while
   the counts and acres are summed.
*/
async function holdingsCube() {
  if (S.cubes.holdings) return S.cubes.holdings;
  const t = await loadTable('holdings_county');
  S.cubes.holdings = cube(t, { nUnits: 57, nSnaps: S.nSnaps, keyCol: 'county_n', snapCol: 's', delta: false });
  return S.cubes.holdings;
}
const hAt = (c, m, u, s) => c.data[m]?.[u * c.nSnaps + s] ?? 0;
const holdingUnits = () => (S.selection.size && S.level === 'county' ? Array.from(S.selection) : [0]);
const countyLabel = (u) => (u === 0 ? 'Montana' : (S.dim.counties.find((c) => c.code === u)?.name ?? String(u)));

function forceCounty() {
  if (S.level === 'county') return;
  S.level = 'county';
  const sel = $('level');
  if (sel) sel.value = 'county';
  S.selection.clear();
  S.map.setLevel('county');
  S.map.setSelection(new Set());
}
function holdNote() {
  const u = holdingUnits();
  if (u.length === 1 && u[0] === 0) return 'Statewide. Click a county to focus; shift-click to add. Holdings are consolidated within each county, as in the paper.';
  return `${u.length} count${u.length > 1 ? 'ies' : 'y'}: ${u.map(countyLabel).join(', ')}`;
}
const STATUS_TOK = ['cat-1', 'ord3-2', 'statute', 'statute', 'cat-3', 'cat-1', 'cat-3'];
function statusBadge(code) {
  const lab = S.dim.labels.review_status[code] || '';
  return `<span class="badge" style="border-color:var(--${STATUS_TOK[code] || 'axis'})">${lab}</span>`;
}
function reasonList(r) {
  const out = [];
  if (r.strong) out.push('shared name or address needs a decision');
  if (r.token) out.push('name-token match');
  if (r.conflict) out.push('point and area tenure disagree');
  if (r.oos) out.push('out-of-state');
  return out.join('; ');
}
async function topRows(units, s) {
  const t = await loadTable('holdings_top');
  const col = (n) => t.columns.indexOf(n);
  const ci = col('county_n'), si = col('s');
  const want = new Set(units);
  const rows = [];
  for (const r of t.rows) {
    if (Number(r[si]) !== s || !want.has(Number(r[ci]))) continue;
    rows.push({
      county: Number(r[ci]), rank: Number(r[col('rank')]), name: r[col('display_name')],
      city: r[col('display_city')], state: r[col('display_state')],
      acres: Number(r[col('acres')]), acresMax: Number(r[col('acres_if_merged')]),
      parcels: Number(r[col('n_parcels')]), status: Number(r[col('review_status')]),
      names: Number(r[col('n_names')]), links: Number(r[col('pending_links')]),
      strong: Number(r[col('strong')]) > 0, token: Number(r[col('token')]) > 0,
      conflict: Number(r[col('conflict')]) > 0, oos: Number(r[col('oos')]) > 0,
      hash: r[col('group_hash')],
    });
  }
  return rows.sort((a, b) => b.acres - a.acres);
}

VIEWS.holdings = {
  parcelLegend: 'owner\u2019s holding in the county',
  label: 'Holdings',
  legend: 'Four-property concentration ratio (CLO4), % of large-holding acreage',
  async render(panel) {
    forceCounty();
    const h = await holdingsCube();
    paintFrom(h, countyIds(), (c, u, s) => {
      const n = hAt(c, 'large_owners', u, s);
      return n >= 4 ? 100 * hAt(c, 'clo4', u, s) : null;
    });
    const units = holdingUnits();
    const s = S.snap;
    const ser = (m) => seriesOf(h, m, units);
    const la = ser('large_acres'), lo = ser('large_owners');
    const lam = ser('large_acres_max'), lom = ser('large_owners_max');
    const prov = ser('large_provisional'), provAc = ser('large_provisional_acres');
    const oosAc = ser('large_oos_acres'), oosN = ser('large_oos_owners');
    const pa = ser('private_acres');

    C.stats(C.card(panel, 'Large private holdings at the selected snapshot', holdNote()), [
      { value: C.fmtInt(lo[s]), label: 'owners holding 640+ acres',
        detail: `${C.fmtInt(lom[s])} if every pending review were accepted` },
      { value: C.fmtAc(la[s]), label: 'acres in large holdings',
        detail: `${C.fmtPct(pa[s] ? (100 * la[s]) / pa[s] : NaN)} of private acreage · up to ${C.fmtAc(lam[s])}` },
      { value: `${C.fmtInt(lo[s] ? la[s] / lo[s] : NaN)} ac`, label: 'mean large holding' },
      { value: C.fmtPct(la[s] ? (100 * oosAc[s]) / la[s] : NaN), label: 'of large acreage mailed out of state',
        detail: `${C.fmtInt(oosN[s])} owners` },
      { value: C.fmtInt(prov[s]), label: 'large holdings awaiting review',
        detail: `${C.fmtAc(provAc[s])} rests on an unmade decision` },
    ]);

    const xl = snapLabels();
    const k1 = C.card(panel, 'Owners of large holdings',
      'The document tier applies the consolidation rule as far as it can be automated; the maximal tier accepts every pending review flag. The paper’s manual pass lands between them.');
    C.lineChart(k1, {
      series: [lo, lom], labels: ['document tier', 'maximal tier'],
      colors: [cssVar('--cat-3'), cssVar('--ord3-2')], xLabels: xl, fmt: C.fmtInt,
      caption: 'Owners of 640+ acre private holdings',
    });
    const k2 = C.card(panel, 'Acreage in large holdings and its mean',
      'Fewer owners holding more acreage is the concentration signature the paper reports: a 6.4% fall in owners and a 7% rise in mean holding across its 13 counties, 2005 to 2018.');
    C.lineChart(k2, {
      series: [la, lam], labels: ['document tier', 'maximal tier'],
      colors: [cssVar('--cat-3'), cssVar('--ord3-2')], xLabels: xl, fmt: C.fmtAc,
      caption: 'Acres in large holdings',
    });
    const mean = Float64Array.from(la, (v, i) => (lo[i] ? v / lo[i] : NaN));
    C.lineChart(k2, {
      series: [mean], labels: ['mean large holding'], colors: [cssVar('--cat-1')],
      xLabels: xl, fmt: C.fmtAc, caption: 'Mean size of a large holding',
    });

    // CLO4 and the gap: per-county ratios.
    const k3 = C.card(panel, 'Four-property concentration ratio (CLO4)',
      'Share of a county’s large-holding acreage held by its four largest holdings (Desmarais et al. 2015, as used by the paper). Averaged over the paper’s counties it rose from 14% to 16%.');
    if (units.length === 1) {
      const u = units[0];
      const clo = Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'clo4', u, i));
      C.lineChart(k3, { series: [clo], labels: ['CLO4'], colors: [cssVar('--cat-3')], xLabels: xl,
        fmt: (v) => C.fmtPct(v, 1), caption: `CLO4, ${countyLabel(u)}` });
      const t1 = Float64Array.from({ length: S.nSnaps }, (_, i) => hAt(h, 'top1_acres', u, i));
      const t2 = Float64Array.from({ length: S.nSnaps }, (_, i) => hAt(h, 'top2_acres', u, i));
      C.lineChart(k3, { series: [t1, t2], labels: ['largest holding', 'second largest'],
        colors: [cssVar('--cat-3'), cssVar('--cat-2')], xLabels: xl, fmt: C.fmtAc,
        caption: 'The two largest holdings' });
    } else {
      C.smallMultiples(k3, {
        facets: units.slice(0, 8).map((u) => ({ label: countyLabel(u),
          values: Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'clo4', u, i)) })),
        xLabels: xl, color: cssVar('--cat-3'), yMax: 100, caption: 'CLO4 by selected county', cols: 2,
      });
    }

    // County ranking at the snapshot.
    const items = countyIds().map((u) => ({ label: countyLabel(u), value: 100 * hAt(h, 'clo4', u, s), n: hAt(h, 'large_owners', u, s) }))
      .filter((x) => x.n >= 4).sort((a, b) => b.value - a.value).slice(0, 14);
    const k4 = C.card(panel, 'Counties ranked by CLO4', 'Counties with fewer than four large holdings are omitted.');
    C.rankBars(k4, { items, color: cssVar('--cat-3'), fmt: (v) => C.fmtPct(v, 0), caption: 'CLO4 by county', max: 100 });

    // Size classes of holdings.
    const labs = S.dim.labels.holding_size;
    const pre = S.measure === 'acres' ? 'ac_' : 'n_';
    const keys = ['lt640', '640_2560', '2560_10k', '10k_50k', 'gt50k'];
    const k5 = C.card(panel, 'Private holdings by size class',
      'Consolidated holding size, not parcel size. Classes are anchored on aliquot multiples: a section, four sections, roughly sixteen.');
    C.stackedArea(k5, {
      series: keys.map((k) => ser(pre + k)), labels: labs, colors: C.ramp('ord5', 5),
      xLabels: xl, share: true, fmt: S.measure === 'acres' ? C.fmtAc : C.fmtInt,
      caption: 'Holding size-class composition',
    });

    // Concentration across all private holdings.
    const k6 = C.card(panel, 'Concentration across all private holdings',
      'Share of private acreage held by the largest 1% and 10% of holdings, and the Gini coefficient. These go beyond the paper and are labelled as our measures.');
    if (units.length === 1) {
      const u = units[0];
      const p1 = Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'top1pct_share', u, i));
      const p10 = Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'top10pct_share', u, i));
      const gi = Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'gini_private', u, i));
      C.lineChart(k6, { series: [p1, p10, gi], labels: ['top 1% of holdings', 'top 10%', 'Gini × 100'],
        colors: [cssVar('--cat-3'), cssVar('--cat-2'), cssVar('--cat-1')], xLabels: xl,
        fmt: (v) => C.fmtPct(v, 0), yMax: 100, caption: 'Concentration measures' });
    } else {
      C.smallMultiples(k6, {
        facets: units.slice(0, 8).map((u) => ({ label: countyLabel(u),
          values: Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'top10pct_share', u, i)) })),
        xLabels: xl, color: cssVar('--cat-2'), yMax: 100, caption: 'Share held by the top 10% of holdings', cols: 2,
      });
    }

    // The largest holdings, named.
    const rows = await topRows(units.length > 1 ? units : [units[0]], s);
    const k7 = C.card(panel, `Largest holdings, ${units.length === 1 ? countyLabel(units[0]) : 'selected counties'}`,
      'Owner of record from the cadastral, public record. A range means the holding rests on a review that has not been made; the second figure is its reach if every pending flag were accepted.');
    C.table(k7, {
      headers: ['#', 'owner of record', 'mails from', 'acres', 'parcels', 'status'],
      rows: rows.slice(0, units.length > 1 ? 20 : 10).map((r, i) => [
        String(i + 1), r.name, `${r.city || ''}${r.state ? ', ' + r.state : ''}`,
        r.acresMax > r.acres * 1.001 ? `${C.fmtInt(r.acres)} – ${C.fmtInt(r.acresMax)}` : C.fmtInt(r.acres),
        C.fmtInt(r.parcels), statusBadge(r.status)]),
      caption: 'Largest private holdings at the selected snapshot', html: true,
    });
    await regressionCard(panel);
  },
};

async function regressionCard(panel) {
  const rg = S.meta.holdings && S.meta.holdings.regression;
  if (!rg || !rg.length) return;
  const c = C.card(panel, 'Against the published Table 1',
    'Haggerty et al. (2022) report 13 counties for 2005 and 2018. Their homogenization included a manual pass that cannot be replayed, so the test is whether the paper’s figure lies between the document and maximal tiers.');
  C.table(c, {
    headers: ['snapshot', 'paper acres', 'document', 'maximal', 'paper owners', 'document', 'maximal'],
    rows: rg.map((r) => [r.snapshot, C.fmtInt(r.paper_large_acres), C.fmtInt(r.document_large_acres),
      C.fmtInt(r.maximal_large_acres), C.fmtInt(r.paper_owners), C.fmtInt(r.document_owners), C.fmtInt(r.maximal_owners)]),
    caption: '13-county totals of acres and owners in 640+ acre private holdings',
  });
}

VIEWS.review = {
  parcelLegend: 'review status of the owner\u2019s holding',
  label: 'Review',
  legend: 'Large holdings awaiting review, % of large holdings',
  async render(panel) {
    forceCounty();
    const h = await holdingsCube();
    paintFrom(h, countyIds(), (c, u, s) => {
      const n = hAt(c, 'large_owners', u, s);
      return n >= 4 ? (100 * hAt(c, 'large_provisional', u, s)) / n : null;
    });
    const units = holdingUnits();
    const s = S.snap;
    const ser = (m) => seriesOf(h, m, units);
    const lo = ser('large_owners'), la = ser('large_acres'), lam = ser('large_acres_max');
    const prov = ser('large_provisional'), provAc = ser('large_provisional_acres');
    const tok = ser('large_token'), conf = ser('large_conflict');

    C.stats(C.card(panel, 'What a reviewer would change', holdNote()), [
      { value: C.fmtInt(prov[s]), label: 'large holdings flagged',
        detail: `${C.fmtPct(lo[s] ? (100 * prov[s]) / lo[s] : NaN)} of large holdings · ${C.fmtAc(provAc[s])}` },
      { value: C.fmtInt(tok[s]), label: 'with a name-token check only' },
      { value: C.fmtAc(lam[s] - la[s]), label: 'acreage the pending merges would add',
        detail: 'document tier to maximal tier' },
      { value: C.fmtInt(conf[s]), label: 'large holdings on a disputed parcel',
        detail: 'the point and area methods classify one of its parcels differently' },
    ]);

    // Review composition among large holdings, over time.
    let t;
    try { t = await loadTable('holdings_review'); } catch { t = null; }
    if (t) {
      const col = (n) => t.columns.indexOf(n);
      const ci = col('county_n'), si = col('s'), ri = col('review_status'), oi = col('owners'), ai = col('acres');
      const want = new Set(units);
      const nS = S.nSnaps;
      const series = [0, 1, 2, 3, 4, 5, 6].map(() => new Float64Array(nS));
      for (const r of t.rows) {
        const u = Number(r[ci]), sn = Number(r[si]), st = Number(r[ri]);
        if (!want.has(u) || !(sn >= 0 && sn < nS) || !(st >= 0 && st < 7)) continue;
        series[st][sn] += Number(S.measure === 'acres' ? r[ai] : r[oi]) || 0;
      }
      const k = C.card(panel, 'Review status of large holdings',
        'Clean holdings rest on an exact address and name. Entity-name merges follow the document’s rule for companies and trusts. Token checks and flags are the document’s CHECK and FALSE cases, waiting on a decision.');
      C.stackedArea(k, {
        series, labels: S.dim.labels.review_status,
        colors: [cssVar('--cat-1'), cssVar('--ord3-2'), cssVar('--ord5-3'), cssVar('--statute'), cssVar('--cat-3'), cssVar('--seq-6'), cssVar('--seq-3')],
        xLabels: snapLabels(), share: true, fmt: S.measure === 'acres' ? C.fmtAc : C.fmtInt,
        caption: 'Large holdings by review status',
      });
    }

    const rows = (await topRows(units, s)).filter((r) => r.status >= 2 || r.strong || r.conflict)
      .sort((a, b) => (b.acresMax - b.acres) - (a.acresMax - a.acres) || b.acres - a.acres);
    const k2 = C.card(panel, 'Largest holdings that rest on an unmade decision',
      'Ordered by the acreage at stake. Resolve a row by adding a merge or keep line to owner_overrides.csv and re-running the identity stage; the reviewer, date and reason travel into the next publish.');
    C.table(k2, {
      headers: ['owner of record', 'mails from', 'acres', 'if merged', 'parcels', 'names', 'status', 'why', 'group'],
      rows: rows.slice(0, 25).map((r) => [r.name, `${r.city || ''}${r.state ? ', ' + r.state : ''}`,
        C.fmtInt(r.acres), C.fmtInt(r.acresMax), C.fmtInt(r.parcels), String(r.names),
        statusBadge(r.status), reasonList(r), r.hash]),
      caption: 'Flagged large holdings at the selected snapshot', html: true,
    });
    if (!rows.length) {
      const d = document.createElement('div');
      d.className = 'caveat';
      d.textContent = 'No flagged large holdings among the top-ranked holdings here. Smaller flagged holdings exist; the published list is capped at the ten largest per county.';
      k2.appendChild(d);
    }
    const how = C.card(panel, 'How a review is recorded');
    const d = document.createElement('div');
    d.className = 'caveat';
    d.innerHTML = 'The pipeline never merges two owners on a judgment call. A reviewer records one in '
      + '<code>owner_overrides.csv</code> as <code>merge</code> (join these ids into one group) or '
      + '<code>keep</code> (looked, kept separate), with a reason and date. Ids accepted: the strict id, '
      + 'the address-key id, or the group hash shown in the last column. The identity stage applies the '
      + 'file on its next run and marks the result <em>reviewed</em>.';
    how.appendChild(d);
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


/* 9. Reports -- the six printable documents, composed in reports.js */
VIEWS.reports = {
  label: 'Reports',
  legend: 'Reports',
  full: true,
  async render(panel) {
    reportForm(panel);
    if (S.report.generated) await generateReport();
  },
};

const reportCtx = () => ({
  dim: S.dim, meta: S.meta, nSnaps: S.nSnaps, nIv: S.nIv,
  countyCube, countyFlow, holdingsCube, loadTable,
  countyName: (code) => S.dim.counties.find((c) => c.code === code)?.name ?? String(code),
});

function reportForm(panel) {
  const card = C.card(panel, 'Generate a report');
  card.classList.add('no-print');
  const counties = S.dim.counties.slice().sort((a, b) => a.name.localeCompare(b.name));
  const snaps = S.dim.snapshots;
  const opt = (v, label, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${label}</option>`;
  const r = S.report;
  card.insertAdjacentHTML('beforeend', `
    <div class="rform">
      <label>Report <select id="rpt-kind">${Object.entries(REPORTS).map(([k, v]) => opt(k, v.label, k === r.kind)).join('')}</select></label>
      <label id="rpt-county-wrap">County <select id="rpt-county">${opt('', 'all counties', !r.county)}${counties.map((c) => opt(c.code, c.name, c.code === r.county)).join('')}</select></label>
      <span id="rpt-period-wrap" style="display:contents">
        <label>From <select id="rpt-a">${snaps.map((sn, i) => opt(i, sn.date, i === r.a)).join('')}</select></label>
        <label>To <select id="rpt-b">${snaps.map((sn, i) => opt(i, sn.date, i === r.b)).join('')}</select></label>
      </span>
      <button id="rpt-go">Generate</button>
      <button id="rpt-pdf" class="secondary" hidden>Save as PDF</button>
      <a id="rpt-csv" hidden>Download CSV</a>
    </div>
    <div class="cap" id="rpt-blurb" style="margin-top:8px"></div>
    <div class="hint" id="rpt-status" style="font-size:11.5px;color:var(--ink-muted)"></div>`);
  const sync = () => {
    const k = $('rpt-kind').value;
    const needs = REPORTS[k].needs;
    $('rpt-county-wrap').hidden = !(needs.includes('county') || needs.includes('county-optional'));
    $('rpt-period-wrap').hidden = !needs.includes('period');
    // The profile is one county; only the worksheet can take them all.
    const all = $('rpt-county').options[0];
    all.hidden = !needs.includes('county-optional');
    if (needs.includes('county') && !$('rpt-county').value) {
      const fromMap = S.level === 'county' && S.selection.size ? Array.from(S.selection)[0] : null;
      $('rpt-county').value = String(fromMap ?? 6);
    }
    $('rpt-blurb').textContent = REPORTS[k].blurb;
    $('rpt-pdf').hidden = !(S.report.generated && S.reportOut && S.report.kind === k);
    $('rpt-csv').hidden = !(S.report.generated && S.reportOut?.csv && S.report.kind === k);
  };
  $('rpt-kind').addEventListener('change', () => { S.report.kind = $('rpt-kind').value; sync(); });
  $('rpt-county').addEventListener('change', () => { S.report.county = Number($('rpt-county').value) || null; });
  $('rpt-a').addEventListener('change', () => { S.report.a = Number($('rpt-a').value); });
  $('rpt-b').addEventListener('change', () => { S.report.b = Number($('rpt-b').value); });
  $('rpt-go').addEventListener('click', () => {
    S.report.kind = $('rpt-kind').value;
    S.report.county = Number($('rpt-county').value) || null;
    S.report.generated = true;
    generateReport();
  });
  $('rpt-pdf').addEventListener('click', printReport);
  sync();
}

async function generateReport() {
  const panel = $('panel');
  let host = $('report');
  if (!host) {
    host = document.createElement('div');
    host.id = 'report';
    host.className = 'report';
    panel.appendChild(host);
  }
  const { kind, county, a, b } = S.report;
  const status = $('rpt-status');
  if (kind === 'activity' && !(a < b)) {
    status.textContent = 'The period must run from an earlier vintage to a later one.';
    return;
  }
  const params = (kind === 'profile' || kind === 'condition') ? { county: county || 6 }
    : kind === 'worksheet' ? { county: county || null }
    : kind === 'activity' ? { a, b } : {};
  const gen = ++S.reportGen;
  status.textContent = 'Composing\u2026';
  $('rpt-pdf').hidden = true;
  $('rpt-csv').hidden = true;
  try {
    const out = await renderReport(kind, params, host, reportCtx());
    if (gen !== S.reportGen) return;   // superseded by a later request
    S.reportOut = out;
    $('rpt-pdf').hidden = false;
    const csvA = $('rpt-csv');
    if (out.csv) {
      if (csvA.href) URL.revokeObjectURL(csvA.href);
      csvA.href = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv' }));
      csvA.download = out.csvName;
      csvA.hidden = false;
    }
    status.textContent = `${out.title}${out.csv ? ` \u00b7 ${out.rows} rows in the CSV` : ''}. `
      + 'Save as PDF opens the browser\u2019s print dialog; choose \u201cSave as PDF\u201d as the destination. '
      + 'The page is composed for Letter paper.';
    // Test handle: the smoke suite reads the composed report through this.
    window.__report = out;
  } catch (err) {
    console.error(err);
    status.textContent = `Could not compose the report: ${err && err.message ? err.message : err}`;
  }
}

/** The PDF is the browser's: the print stylesheet keeps only the report, and
 *  the document title becomes the file name the dialog proposes. */
function printReport() {
  const was = document.title;
  document.title = (S.reportOut?.title || 'report').replace(/[^\w .,-]+/g, '');
  window.addEventListener('afterprint', () => { document.title = was; }, { once: true });
  window.print();
}

/* 9. About -- how to use it, how to read it, where it comes from */
const CONTACT_URL = 'https://www.epistemegeospatial.com/contact';
VIEWS.about = {
  label: 'About',
  legend: 'About this dashboard',
  full: true,
  async render(panel) {
    const first = S.dim.snapshots[0].date, last = S.dim.snapshots[S.nSnaps - 1].date;
    const section = (title, html) => {
      const c = C.card(panel, title);
      const d = document.createElement('div');
      d.className = 'about';
      d.innerHTML = html;
      c.appendChild(d);
    };

    section('What this is', `
      <p>Montana’s cadastral parcel layer, exported ${S.nSnaps} times between ${first} and ${last}
      by the Montana State Library from the Department of Revenue’s records, read parcel by parcel
      and compared vintage to vintage. Each export is a snapshot of every parcel in the state;
      the differences between snapshots are the events: parcels created and retired, owners
      changed, buildings assessed. Statistics are aggregated to ${S.meta.townships.toLocaleString()}
      PLSS townships and ${S.meta.counties} counties, and the newest export’s parcels themselves
      (about 887,000) are drawn once the map is zoomed past level 10. Beside the parcel layer, the Department
      of Revenue’s own building records, from three exports of its ORION appraisal database, are joined to the
      parcels at eight tax years (2014, 2015 to 2018 and 2024 to 2026): the condition and age of the housing
      stock, and an independent check on what the parcel layer says is built.</p>
      <p>It was built by <a href="https://www.epistemegeospatial.com/">Episteme Geospatial</a> as a
      working instrument for the questions the cadastral record can answer: where land is being
      divided, who owns it and from where, what has actually been built on it, and how concentrated
      large private holdings have become.</p>`);

    section('How to use it', `
      <ul>
        <li><strong>Tabs</strong> choose a view. Each view paints the map and fills this panel with its charts.</li>
        <li><strong>The snapshot slider</strong> picks a vintage; the map, the tiles of numbers and the charts’
          cursor follow it. The date shown is the export date, not an assessment date. The Condition view has
          building records at eight of the vintages and shows the nearest one at or before the slider.</li>
        <li><strong>Unit</strong> switches the aggregate surface between PLSS townships and counties.
          <strong>Measure</strong> switches between parcels and acres where a view supports both.</li>
        <li><strong>Click a unit</strong> on the map to focus every chart on it; shift-click adds units;
          <em>Clear selection</em> returns to the statewide figures. The key in the map’s corner names what is painted.</li>
        <li><strong>Mask low coverage</strong> greys out units whose record is not yet complete in that vintage;
          the early years arrived county by county.</li>
        <li><strong>Zoom in.</strong> Past level 10 the aggregate surface gives way to the parcels, coloured by the
          view’s parcel key. Click a parcel for its geocode and attributes; no owner information is shown.
          Parcels that did not yet exist at the selected vintage are outlined by the period in which they first
          appeared (2003 to 2005, 2006 to 2010, 2011 to 2015, 2016 to 2020, 2021 on), so the 2003 layer shows the
          whole subdivision history at once and each later vintage what was still to come. Parcels first seen in
          or before the vintage a county’s record arrived are that county’s baseline and are not outlined.</li>
        <li><strong>Layers</strong> adds the township grid, county boundaries, roads with their names, building
          footprints (the 2018 statewide set, with lidar footprints where flown), reservations, public lands and city limits. Under Parcels, the fill can be switched off to leave only the parcel lines and the period outlines. The basemap is outlines only;
          the basemap menu offers an in-house Montana basemap built from the State Library’s frameworks (roads, water,
          places, buildings and address points, served from this site) and an OpenStreetMap one; only the latter
          fetches anything from a third party.</li>
        <li><strong>Reports</strong> composes a printable document from the same tables: a county profile, a
          housing condition profile, a statewide trends brief, a large-holdings update in the form of the paper, a
          review worksheet as a CSV, and a subdivision-activity report for a chosen period. <em>Save as PDF</em> hands the page to the browser’s print
          dialog, where “Save as PDF” is the destination; nothing leaves the browser.</li>
        <li>The <strong>◐</strong> button toggles light and dark.</li>
      </ul>`);

    section('Reading the views', `
      <p><strong>Development.</strong> Every parcel sits on a three-step ladder: <em>platted only</em> (no situs
      address, no assessed building), <em>addressed</em> (a house number but no building value) and <em>built</em>
      (an assessed building). The map shows the share of parcels addressed but unbuilt, the gap between
      infrastructure and houses. The charts follow the ladder over time, the <em>absorption</em> of each creation
      cohort (of the lots created at a vintage, the share carrying a building N years later) and the
      <em>dormant inventory</em> (lots under 40 acres that have sat at the bottom of the ladder five years or more).
      Dedicated common areas (open space, parks, HOA and condominium tracts) are counted apart and never climb.</p>
      <p><strong>Condition.</strong> The Department of Revenue’s own building records, from its ORION appraisal
      database, joined to the parcels on the geocode at eight tax years: the condition of the principal dwelling on
      the DOR’s scale from Unsound (1) to Excellent (10), the earliest year built, and the same dwellings followed
      from point to point. Through tax year 2014 the DOR filled CDU, the composite rating its dictionary describes;
      at the 2015 reappraisal it retired the composite by copying it into four components and has rated them apart
      since, so the rating is CDU for 2014 and the physical-condition component after, and the view says which. The map
      draws condition and age together as one grid of nine colours, condition across and age up: thirds of the units
      shown at township and county grain, fixed classes on the parcels (fair or worse, average, good or better; before
      1980, 1980 to 2004, 2005 on). The
      same records are an independent witness to the ladder, and the view reports each test with a count on both
      sides at every point: whether a parcel the layer calls built has a structure on record, how soon after a
      dwelling’s year built the ladder first showed a value, whether a dormant lot carries a dwelling after all.</p>
      <p><strong>Ownership.</strong> Tenure (public domain, tribal trust, private) and the owner’s distance from
      the land (the same place, the same county, elsewhere in Montana, out of state), both read from the mailing
      address on the record. The map shows the out-of-state share; the charts add the trust-and-fee checkerboard
      inside each reservation and where out-of-state owners mail from.</p>
      <p><strong>Fragmentation.</strong> Acreage by parcel-size class, the share of acreage in parcels under 40
      acres on the map, and agricultural-use acreage.</p>
      <p><strong>Churn.</strong> How often parcels that persist from one vintage to the next change owner, per
      year; transfers against address-only edits; and condominiumisation.</p>
      <p><strong>Thresholds.</strong> The sizes of newly created parcels against the acreage lines in Montana’s
      subdivision law. A pile-up just above a line is lots sized to clear it; the map shows new lots per
      thousand parcels per year, and the era filter narrows the period.</p>
      <p><strong>Holdings.</strong> A <em>holding</em> is one owner’s consolidated private acreage within a county;
      <em>large</em> means 640 acres or more, one section. The map shows the four-property concentration ratio
      (CLO4): the share of a county’s large-holding acreage held by its four largest. The charts count large
      owners and their acreage, rank counties, class holdings by size, draw the Lorenz curve and Gini, and compare
      the result with the published Table 1. Owners are identified by mailing address, with bridges for entities
      and couples, and two tiers (document and maximal) bound what a manual review could change.</p>
      <p><strong>Review.</strong> The method expects a reviewer. This view shows what one would decide: large
      holdings that rest on an unmade decision (an entity merge, a token name, a pending match, an ORION bridge),
      parcels on which the two public-land tests disagree, and how a decision is recorded.</p>`);

    section('Where the analyses come from', `
      <p>The holdings and review analyses follow Haggerty, Epstein, Gosnell, Rose and Stone (2022),
      <em>Rural Land Concentration &amp; Protected Areas: Recent Trends from Montana and Greater Yellowstone</em>,
      Society &amp; Natural Resources 35(6): 692–700,
      <a href="https://doi.org/10.1080/08941920.2022.2038318">doi:10.1080/08941920.2022.2038318</a>, and the
      consolidation methodology in its supplement. The Holdings view reports this dashboard’s residuals against
      that paper’s Table 1 so the reproduction can be judged.</p>
      <p>The development ladder, absorption, dormant inventory, churn and threshold analyses were constructed for
      this dashboard from the same records, and the condition series and the witness tests from the Department of
      Revenue’s building records. Each card’s caption states its definition, and the measured decisions behind them
      are kept in the project’s findings log.</p>
      <p>Data: the Montana Cadastral Framework (Montana State Library and Department of Revenue), ${S.nSnaps}
      exports from ${first} to ${last}; the Montana Public Lands layer (State Library, 2026) for public domain by
      area; reservations and incorporated cities (State Library); the Transportation Framework road centerlines
      (State Library and Department of Transportation, June 2026); building footprints (Microsoft US Building
      Footprints, 2018 release, ODbL, as redistributed by the State Library, merged with the State Library’s lidar
      building footprints, 37 project areas); the Structures Framework’s address points (State Library, exported
      2026-10-30), as a witness to the address rung and in the in-house basemap, which also draws the NHD
      hydrography, GNIS place names, county and city boundaries and public lands (State Library); and the Department of Revenue’s ORION appraisal database in three exports (refreshed
      2016-03-27, 2018-06-21 and 2026-06-24), for the building records behind the Condition view and the party
      identifiers that bridge owners in the 2024 to 2026 vintages.</p>`);

    section('Caveats', `
      <ul>
        <li>Vintages are export dates. 2002 is excluded (it lacks the counties where parcels are created) and no
          2012 or 2015 export exists, so events spanning those gaps are dated to the interval.</li>
        <li>Coverage arrived county by county through 2007; the comparable series begins in
          ${S.meta.comparable_series_begins}. The coverage mask is on by default for that reason.</li>
        <li>The 2009-07-05 export ships its value and agricultural columns entirely zero. Improvement status and
          agricultural acreage are unknown there, not zero, and that vintage is left out of the charts that need them.</li>
        <li>The ladder is probabilistic: a parcel with a house number carries an assessed building 89 to 91% of the
          time, and some parcels carry a building with no house number. Checked against the Department of Revenue’s
          building records, the parcel layer and the appraiser agree on whether a parcel is built on 99.5 to 99.7%
          of parcels in every tax year tested.</li>
        <li>The State Library’s address points are a third record: on the newest export they agree with the parcel
          layer’s house number on 92% of parcels, place a residential point on 94% of parcels with a dwelling on
          record, and their own geocode names the parcel that contains them 98.7% of the time. A multi-unit
          building is usually one point. The framework has no history, so only the newest point carries the test.</li>
        <li>Condition and year built are the appraiser’s record at eight tax years, not a continuous series, and
          a rating is as current as the last inspection. An export dated January or February carries the previous
          year’s roll, so a dwelling built in one year enters the ladder in the first export after the middle of the
          next; the Condition view states the test in those terms.</li>
        <li>Owner location is a mailing address, not a residence.</li>
        <li>Public domain comes from one 2026 public-lands layer applied to every year, decided by area overlap;
          tribal trust comes from owner names, because trust land is absent from that layer. A reservation boundary
          is jurisdiction, not ownership.</li>
        <li>Owner identity follows the method’s address key. No manual review has been performed; the Review view
          shows the range a reviewer could move, and nothing is assumed in either direction.</li>
        <li>Dedicated common areas are flagged by rule (the Non-Valued property type inside a subdivision, an
          association or tract-named owner, or an open-space phrase in the legal description of an unbuilt parcel);
          the rule touches 7.7% of platted-only subdivision lots under 40 acres and 0.3% of built parcels.</li>
        <li>The parcels drawn are the newest export’s. A parcel split later shows as its pieces at every date;
          the magenta outline is the one thing on the parcel map that follows the slider.</li>
        <li>Parcel geometry is generalised for the tiles (about 2.4 m). Building footprints are Microsoft’s 2018
          computer-generated set, which carries 79% of the parcels with an appraised dwelling statewide (89% of those
          built before 2015, 11% of those built in 2018 or later), overlaid with the State Library’s lidar footprints
          where lidar has flown, an eighth of the state; together 82% statewide and about 91% inside the flown areas.
          A 2018 footprint inside a flown area that the lidar did not see is drawn lighter. Roads are as of June 2026.</li>
        <li>Agricultural-use acreage is clamped to each parcel’s own area, since some exports report more
          agricultural acres than mapped acres.</li>
        <li>No parcel-level owner information is published. The largest holdings are named from the public
          cadastral record.</li>
      </ul>`);

    section('Questions and comments', `
      <p>This dashboard is a project of <a href="https://www.epistemegeospatial.com/">Episteme Geospatial</a>.
      Comments, corrections and questions are welcome through the
      <a href="${CONTACT_URL}">contact page</a>.</p>`);
  },
};

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
  if (!VIEWS[S.view].full) caveatCard(panel);
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
      $('level').disabled = (k === 'holdings' || k === 'review');
      // The DOR's building records exist at eight points; the slider picks the
      // nearest earlier one. The unit is the dwelling, not parcels or acres.
      $('measure').disabled = (k === 'condition');
      $('timewrap').title = k === 'condition' ? 'Building records exist at eight vintages (tax years 2014, 2015-2018, 2024-2026); the slider shows the nearest earlier one.' : '';
      // About is prose and Reports is paper: the map and filters step aside,
      // and the map is told its size again when they come back.
      document.body.classList.toggle('full', !!VIEWS[k].full);
      if (!VIEWS[k].full && S.map) setTimeout(() => S.map.map.resize(), 0);
      render();
    });
    nav.appendChild(b);
  }
  const slider = $('snap');
  slider.max = String(S.nSnaps - 1);
  slider.value = String(S.nSnaps - 1);
  S.snap = S.nSnaps - 1;
  const label = () => {
    const d = S.dim.snapshots[S.snap].date;
    const gone = unavailableAt(S.snap);
    const el = $('snaplabel');
    el.textContent = d;
    el.title = gone.length
      ? `${d}: this export ships ${gone.map((g) => FIELD_LABEL[g] || g).join(' and ')} `
        + 'entirely zero, so those measures are unknown here.'
      : d;
    const mark = $('snapwarn');
    if (mark) {
      mark.hidden = !gone.length;
      mark.title = el.title;
    }
  };
  const setSnap = () => { S.snap = Number(slider.value); label(); render(); };
  slider.addEventListener('input', () => { S.snap = Number(slider.value); label(); });
  slider.addEventListener('change', setSnap);
  label();

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

  // --- layer list ------------------------------------------------------
  const status = $('lyr-status');
  $('lyr-parcels').addEventListener('change', (e) => {
    S.map.setParcelsVisible(e.target.checked);
    $('lyr-parcel-fill').disabled = !e.target.checked;
  });
  // The fill is the view's parcel key; off, the thin parcel lines and the
  // period outlines remain, which is the readable state when the outlines
  // are what the reader came for.
  $('lyr-parcel-fill').addEventListener('change', (e) => {
    S.parcelFill = e.target.checked;
    S.map.setParcelFill(S.parcelFill);
    const l = $('legend');
    if (l.dataset.mode === 'parcel') l.innerHTML = parcelLegendHTML();
  });
  $('lyr-townships').addEventListener('change', (e) => {
    const v = e.target.checked ? 'visible' : 'none';
    for (const id of ['township-line']) {
      if (S.map.map.getLayer(id)) S.map.map.setLayoutProperty(id, 'visibility', v);
    }
  });
  $('lyr-counties').addEventListener('change', (e) => {
    const v = e.target.checked ? 'visible' : 'none';
    if (S.map.map.getLayer('county-line')) S.map.map.setLayoutProperty('county-line', 'visibility', v);
  });
  $('lyr-roads').addEventListener('change', (e) => S.map.setReference('roads', e.target.checked));
  $('lyr-buildings').addEventListener('change', (e) => S.map.setReference('buildings', e.target.checked));
  for (const [kind, file, label] of [
    ['reservations', 'reservations.geojson', 'reservations'],
    ['publiclands', 'publiclands.geojson', 'public lands'],
    ['cities', 'cities.geojson', 'city limits'],
  ]) {
    $(`lyr-${kind}`).addEventListener('change', async (e) => {
      if (!e.target.checked) { S.map.setOverlay(kind, false); return; }
      status.textContent = `loading ${label}\u2026`;
      try {
        await S.map.addOverlay(kind, `data/${file}`);
        S.map.setOverlay(kind, true);
        status.textContent = '';
      } catch (err) {
        status.textContent = `${label} unavailable`;
        e.target.checked = false;
      }
    });
  }

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
  // The activity report defaults to the last five years or so of the series.
  S.report.a = Math.max(0, S.nSnaps - 6);
  S.report.b = S.nSnaps - 1;
  for (const t of dim.townships) { S.twpByKey.set(t.tr, t); S.twpById.set(t.id, t); }

  $('boot').remove();
  $('app').hidden = false;
  $('sub').textContent =
    `${dim.snapshots.length} vintages · ${dim.townships.length.toLocaleString()} townships · `
    + `comparable series from ${meta.comparable_series_begins}`;

  S.map = new UnitMap('map', {
    onParcel: (props) => {
      const box = $('parcelinfo');
      const L = S.dim.labels;
      const born = Number(props.born);
      const bornTxt = born >= 0 && born < S.dim.snapshots.length
        ? (born === 0 ? `present in ${S.dim.snapshots[0].date} (or earlier)`
                      : `first seen ${S.dim.snapshots[born].date}${periodOf(born) >= 0 ? ` (${PERIODS[periodOf(born)][0]})` : ''}`)
        : 'unknown';
      const rows = [
        ['acres', Number(props.ac).toLocaleString(undefined, { maximumFractionDigits: 1 })],
        ['stage', L.dev_stage[Number(props.dev)] ? L.dev_stage[Number(props.dev)].replace(/_/g, ' ') : 'unknown'],
        ['tenure', (L.tenure[Number(props.ten)] || '').replace('_', ' ')],
        ['owner distance', L.locality[Number(props.loc)] || '-'],
        ['created', bornTxt + (born === S.snap ? ' \u00b7 outlined in magenta at this slider position' : '')],
      ];
      if (props.hs != null && Number(props.hs) >= 0) {
        const cls = (L.holding_size || [])[Number(props.hs)] || '';
        rows.push(['owner\u2019s holding', `${cls} ac in this county`
          + (Number(props.hr) > 0 ? ` \u00b7 #${Number(props.hr)} largest` : '')
          + (Number(props.hp) ? ' \u00b7 awaiting review' : '')]);
      }
      if (props.cd != null && Number(props.cd) >= 0) {
        rows.push(['dwelling condition', `${(L.condition || [])[Number(props.cd)] || '-'} · DOR rating, tax year ${S.meta.cama?.tax_year || 2026}`]);
      }
      if (props.yb != null && Number(props.yb) > 0) rows.push(['year built', `${Number(props.yb)} (earliest dwelling on the parcel)`]);
      if (Number(props.res)) rows.push(['', 'inside a reservation']);
      if (Number(props.cnd)) rows.push(['', 'condominium unit']);
      box.innerHTML = `<span class="x" id="pi-x">\u00d7</span>`
        + `<div class="gc">${props.id}</div>`
        + `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`
        + `<div class="hint" style="margin-top:5px;color:var(--ink-muted)">`
        + `Geocode is the DOR parcel identifier. No owner information is published.</div>`;
      box.hidden = false;
      $('pi-x').addEventListener('click', () => { box.hidden = true; S.map.selectParcel(''); });
    },
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
    // Test handle: the smoke and screenshot suites drive the map through this.
  window.__map = S.map;
  window.__state = S;
  await S.map.init({ townships, counties });
  // The street basemap is the default reference; if its origin is
  // unreachable the map falls back to outlines only on its own.
  if ($('basemap').value !== 'none') S.map.setBasemap($('basemap').value);
  // The legend must follow the surface the reader is actually looking at.
  S.map.map.on('zoomend', refreshLegendForZoom);
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
