/* ---------------------------------------------------------------------------
   app.js -- views, filters and wiring.

   Ten views, each answering one of the planning questions the pipeline
   supports, over one shared map surface and one shared time control, plus
   the Reports and About tabs. The state they share and the one function
   that changes it are in state.js; the table accessors are in access.js.

   An honest limitation is built into the controls. The published tables carry
   MARGINALS at township grain, not the full joint cube -- the joint at that
   grain would be millions of rows -- so the dashboard offers one category
   dimension at a time rather than pretending to cross-filter. Where a view
   needs a second dimension (owner origin by state) it fetches a purpose-built
   table for the selected state. Nothing silently shows an unfiltered total
   while implying otherwise.
--------------------------------------------------------------------------- */

import { loadJSON, loadTable, cube, seriesOf, sumAt } from './data.js';
import { UnitMap, quantileBreaks, classify } from './map.js';
import * as C from './charts.js';
import { derivedSeries } from './compare.js';
import { DERIVED } from '../assistant/derived.mjs';

// Whether the visitor arrived on a shared link, read before the map writes its
// own position into the address bar on load.
const ARRIVED_ON_LINK = typeof location !== 'undefined' && location.hash.replace(/^#/, '').length > 0;
import { REPORTS, renderReport } from './reports.js';
import { aboutSections } from './about.js';
import { pageview } from './analytics.js';
import { S, applyState, getState, describeState, toHash, fromHash, bindHost, syncSnapLabel, writeHash,
  ERA_BOUNDS, LAYER_KEYS, LAYER_IDS, relayout } from './state.js';
import { twpCube, countyCube, countyFlow, twpFlow, activeStock, twpIds, countyIds, selectedUnits, unitFeatureId, viewScope, countyAt,
  snapLabels, ivLabels, unavailableAt, FIELD_LABEL, num, CD_COLS, YB_COLS, WITNESS_TWP, WITNESS_CTY, shortCond,
  ratedOf, belowShare, pre1980Share, pctOf, camaTables, pointAt, pointMeta, taxYearOf, camaSum, condByDecade,
  timingSeries, transitionSeries, holdingsCube, hAt, holdingUnits, countyLabel, topRows, maskLowCoverage,
} from './access.js';

const $ = (id) => document.getElementById(id);


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
  showUnitLegend(bivariateLegendHTML({ title: l.dataset.title || '', x: { ...x, classes: classes(bx) },
    y: { ...y, classes: classes(by) }, note: `Classes are thirds of the units shown. ${note}`.trim() }));
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
  const n = S.dim.snapshots.length;
  const when = S.dim.snapshots[S.snap]?.date || 'the selected vintage';
  const latest = S.dim.snapshots[n - 1]?.date || 'the latest export';
  if (S.view === 'growth') return growthLegendHTML(when);
  const items = PARCEL_LEGEND[S.view] || [];
  if (!items.length && S.view !== 'condition') return '';
  const title = `Parcels &mdash; ${VIEWS[S.view].parcelLegend || 'colour key'}`;
  const head = S.view === 'condition'
    ? bivariateLegendHTML({ title, x: { label: 'poorer condition \u2192', name: 'DOR condition rating',
        classes: ['good or better (8 to 10)', 'average (7)', 'fair or worse (1 to 6)'] },
      y: { label: 'older \u2192', name: 'year built', classes: ['2005 on', '1980 to 2004', 'before 1980'] } })
      + `<div class="pl"><i style="background:${cssVar('--masked')}"></i>no dwelling rating (includes commercial-only parcels)</div>`
    : `<div class="title">${title}</div>`
      + items.map(([label, tok]) => `<div class="pl"><i style="background:${cssVar('--' + tok)}"></i>${label}</div>`).join('');
  // Said plainly, because it is the surprise: zoomed in, the slider moves the
  // charts and the zoomed-out map but not the parcel colours.
  return head + `<div class="note"><strong>Colours do not follow the slider.</strong> They show each parcel as recorded in ${latest}`
    + (S.snap < n - 1 ? `; zoom out to see this view at ${when}` : '') + '. Subdivision growth shows parcels by the date they were created.</div>';
}

/** The Subdivision growth view's parcel legend: one chip per calendar year
 *  in the three colour bands, later years dimmed, the slider's year marked. */
function growthLegendHTML(when) {
  const { spans, w } = growthClasses();
  const nowYear = Number(when.slice(0, 4));
  const prev = S.snap > 0 ? S.dim.snapshots[S.snap - 1].date : null;
  const chips = spans.map((ys, k) => {
    if (!ys.length) return '';
    const a = ys[0], b = ys[ys.length - 1];
    const label = a === b ? `’${String(a).slice(2)}` : `${String(a).slice(2)}–${String(b).slice(2)}`;
    const future = a > nowYear || S.snap === 0;
    const now = S.snap > 0 && nowYear >= a && nowYear <= b;
    return `<span class="yr${future ? ' yr-future' : ''}${now ? ' yr-now' : ''}" title="${a === b ? a : `${a} to ${b}`}">`
      + `<i style="background:${GROWTH_COLORS[k]}"></i>${label}</span>`;
  }).join('');
  return `<div class="title">Lots divided off &mdash; year, up to ${when}</div>`
    + `<div class="yr-row yr-classes">${chips}</div>`
    + `<div class="note">Seven equal intervals of about ${w.toFixed(1)} years each, oldest red to newest violet.</div>`
    + (prev ? `<div class="note">Newest: lots divided off between ${prev} and ${when}.</div>` : '<div class="note">The first export is the baseline; nothing is divided yet.</div>')
    + '<div class="note">Filled: lots split from a parcel by a new plat, an amended plat or a certificate of survey. Unfilled: not divided off by then, or part of a county’s baseline. A lot’s year is the year of the export it first appears in. '
    + 'Parcels are drawn as they exist today.</div>';
}

function refreshLegendForZoom() {
  if (!S.map) return;
  const l = $('legend');
  const parcelScale = S.map.zoom >= 10.5 && S.layers.parcels;
  if (parcelScale) {
    const html = parcelLegendHTML();
    if (html) { $('legend-body').innerHTML = html; l.dataset.mode = 'parcel'; return; }
  }
  if (l.dataset.mode === 'parcel') {
    l.dataset.mode = '';
    // The unit legend was kept when it was last drawn, so zooming back out
    // of the parcels restores it without re-rendering the whole view.
    if (S.unitLegendHTML) $('legend-body').innerHTML = S.unitLegendHTML; else render();
  }
}

/** Show the unit-scale legend, or the parcel key if the map is at parcel
 *  scale; either way the unit legend is kept for refreshLegendForZoom. */
function showUnitLegend(html) {
  const l = $('legend');
  S.unitLegendHTML = html;
  if (S.map && S.map.zoom >= 10.5 && S.layers.parcels) {
    const p = parcelLegendHTML();
    if (p) { $('legend-body').innerHTML = p; l.dataset.mode = 'parcel'; return; }
  }
  l.dataset.mode = '';
  $('legend-body').innerHTML = html;
}

function legend(ramp, lo, hi, diverging, reason) {
  const l = $('legend');
  // A blank surface must name its own cause. "Coverage mask" is the wrong
  // explanation when the vintage's field is simply dead.
  const why = reason
    ? `<div class="note"><strong>No data at this snapshot.</strong> ${reason}</div>`
    : '<div class="note">Grey = no comparable data (coverage mask), never zero.</div>';
  showUnitLegend(`<div class="title">${l.dataset.title || ''}</div>
    ${reason ? '' : `<div class="ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ends"><span>${lo}</span><span>${hi}</span></div>`}
    ${diverging && !reason ? '<div class="note">Diverging around zero; grey midpoint is no change.</div>' : ''}
    ${why}`);
}


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
/* Subdivision growth colours each lot by the calendar year of the export it
   first appears in, binned into seven equal-interval classes over the years
   that have new lots (the first export is the baseline), oldest to newest
   red, orange, yellow, green, cyan, blue, violet in highlighter colours. The
   breaks are computed from the export dates, so a new export moves them. */
const GROWTH_COLORS = ['#ff2d6f', '#ff9100', '#fff200', '#39ff14', '#00e5ff', '#3d7bff', '#d63dff'];
function growthClasses() {
  const years = S.dim.snapshots.slice(1).map((sn) => Number(sn.date.slice(0, 4)));
  const lo = Math.min(...years), hi = Math.max(...years);
  const k = GROWTH_COLORS.length;
  const w = (hi - lo) / k || 1;
  const classOf = (y) => Math.max(0, Math.min(k - 1, Math.floor((y - lo) / w)));
  // The whole years that fall in each class, for the key.
  const spans = GROWTH_COLORS.map(() => []);
  for (let y = lo; y <= hi; y++) spans[classOf(y)].push(y);
  return { lo, hi, w, classOf, spans };
}
const growthColor = (year) => GROWTH_COLORS[growthClasses().classOf(year)];
function growthFill() {
  // The export at which the lot was divided off (timeseries.subdivisions).
  const born = ['coalesce', ['get', 'sdx'], -1];
  const base = S.countyBase
    ? ['match', ['to-number', ['slice', ['get', 'id'], 0, 2]],
        ...Object.entries(S.countyBase).flatMap(([c, b]) => [Number(c), b]), 0]
    : 0;
  // Snapshot index -> its calendar year's colour.
  const byIdx = ['match', born];
  S.dim.snapshots.forEach((sn, i) => { if (i > 0) byIdx.push(i, growthColor(Number(sn.date.slice(0, 4)))); });
  byIdx.push('rgba(0,0,0,0)');
  // Divided off by the slider date and after its county's baseline: the
  // colour of that year. Everything else is unfilled; the parcel lines draw it.
  return ['case', ['all', ['<=', born, S.snap], ['>', born, base], ['>', born, 0]], byIdx, 'rgba(0,0,0,0)'];
}

function parcelStyle() {
  const ord3 = C.ramp('ord3', 3);
  const ord5 = C.ramp('ord5', 5);
  const masked = cssVar('--masked');

  switch (S.view) {
    case 'growth':
      // Filled by year of creation; no outlines (see growthFill).
      return [growthFill(), null];
    case 'ladder':
      // 4 = dedicated common area (open space, park, HOA tract): on the map in
      // chartreuse, a colour apart from the public-land green so the two kinds
      // of green cannot be read as one; off the ladder in every count.
      return [['match', ['get', 'dev'], 0, ord3[0], 1, ord3[1], 2, ord3[2],
        4, cssVar('--open-space'), masked], null];
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
        0, masked, 1, masked, 2, ord3[1], masked], null];
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
        ord5[0], 20, cssVar('--statute'), 40, ord5[2], 160, ord5[4]], null];
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
  // Subdivision growth leaves lots not yet created unfilled, so it draws the
  // parcel lines from z10 to keep the fabric readable; every view fills.
  S.map.setParcelFill(true, { linesFrom: S.view === 'growth' ? 10 : 12.5 });
  S.map.setParcelPaint(color, outline);
}

/* -------------------------------------------------------------------- views */
const VIEWS = {};

/* 1. Development ladder -- Tier 1.1 */
VIEWS.ladder = {
  parcelLegend: 'development stage',
  label: 'Development',
  summary: 'The development ladder: platted only, addressed, built; absorption of each creation cohort; dormant platted inventory.',
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
function witnessTiles(host, w, { full, statewide }) {
  const vacantBoth = w.parcels_tested - w.improved_layer - w.dor_only;
  const agree = pctOf(w.agree_built + vacantBoth, w.parcels_tested);
  const sw = statewide ? ` · statewide ${C.fmtPct(pctOf(statewide.agree_built + statewide.parcels_tested - statewide.improved_layer - statewide.dor_only, statewide.parcels_tested))}` : '';
  const items = [
    { value: C.fmtPct(agree), label: 'parcels where the two records agree',
      detail: `${C.fmtInt(w.parcels_tested)} parcels tested${sw}` },
    // Precision and recall of the layer's built call against the DOR's own
    // structures: a reconciliation of two products of one source system,
    // not an independent check, and labelled so.
    { value: C.fmtPct(pctOf(w.agree_built, w.agree_built + w.layer_only)), label: 'built per the layer, with a DOR structure (precision)',
      detail: 'reconciliation with the DOR’s own records, not an independent check' },
    { value: C.fmtPct(pctOf(w.agree_built, w.agree_built + w.dor_only)), label: 'DOR structures the layer calls built (recall)',
      detail: `${C.fmtInt(w.dor_only)} DOR structures the layer missed` },
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

/* 1b. Subdivision growth -- the spread of new lots, played through time.
   Zoomed in, every lot that exists by the slider date is filled in the colour
   of the year it was created (GROWTH_COLORS, seven equal-interval classes); the rest of today's fabric is
   unfilled, drawn by its parcel lines.
   Zoomed out, each township or county is shaded by the lots divided off there
   since the first export, on classes fixed from the end of the series so the
   map fills in steadily as it plays. Only lots in a subdivision count
   (timeseries.subdivisions: a plat name in the subdivision field, or a
   subdivision named in the legal description). A new lot is a lot or a block created by
   a division (condominium units and coverage arriving are not), counted only
   in intervals whose two ends are both covered. */
const PLAYER = { playing: false, timer: null, ms: 1500, focus: null };
const SPEEDS = [['Slow', 3000], ['Normal', 1500], ['Fast', 700]];
// Lots divided off by a plat, an amended plat or a certificate of survey
// (timeseries.subdivisions); re-descriptions and instrument-less splits are not.
const newLots = (f, at) => f.data.divided?.[at] ?? 0;

function syncPlayer() {
  const b = document.querySelector('[data-player="play"]');
  if (b) {
    b.textContent = PLAYER.playing ? 'Pause' : 'Play';
    b.setAttribute('aria-pressed', String(PLAYER.playing));
    b.setAttribute('aria-label', PLAYER.playing ? 'Pause the sequence' : 'Play the sequence');
  }
}
function stopPlayer() {
  PLAYER.playing = false;
  clearTimeout(PLAYER.timer);
  PLAYER.timer = null;
  syncPlayer();
}
async function stepTo(i) {
  await applyState({ snap: Math.max(0, Math.min(S.nSnaps - 1, i)) });
}
function schedule() {
  clearTimeout(PLAYER.timer);
  PLAYER.timer = setTimeout(tick, PLAYER.ms);
}
async function tick() {
  if (!PLAYER.playing || S.view !== 'growth') { stopPlayer(); return; }
  await stepTo(S.snap + 1);
  if (!PLAYER.playing) return;
  if (S.snap >= S.nSnaps - 1) stopPlayer(); else schedule();
}
async function togglePlay() {
  if (PLAYER.playing) { stopPlayer(); return; }
  PLAYER.playing = true;
  syncPlayer();
  // From the last export, play starts again at the first.
  if (S.snap >= S.nSnaps - 1) { await stepTo(0); if (PLAYER.playing) schedule(); return; }
  await tick();
}

function playerCard(panel) {
  const prev = S.snap > 0 ? S.dim.snapshots[S.snap - 1].date : null;
  const now = S.dim.snapshots[S.snap].date;
  const k = C.card(panel, 'Play the series',
    'Play steps through the exports one at a time; pause at any point, or step by hand. The slider above moves with it.');
  const bar = document.createElement('div');
  bar.className = 'player';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Sequence controls');
  const btn = (key, text, label, fn, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.player = key;
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', fn);
    b.addEventListener('focus', () => { PLAYER.focus = key; });
    return b;
  };
  const last = S.nSnaps - 1;
  bar.append(
    btn('first', '⏮', 'First export', () => { stopPlayer(); stepTo(0); }, S.snap === 0),
    btn('prev', '◀', 'Previous export', () => { stopPlayer(); stepTo(S.snap - 1); }, S.snap === 0),
    btn('play', PLAYER.playing ? 'Pause' : 'Play', PLAYER.playing ? 'Pause the sequence' : 'Play the sequence', togglePlay),
    btn('next', '▶', 'Next export', () => { stopPlayer(); stepTo(S.snap + 1); }, S.snap === last),
    btn('last', '⏭', 'Last export', () => { stopPlayer(); stepTo(last); }, S.snap === last),
  );
  bar.querySelector('[data-player="play"]').classList.add('player-primary');
  bar.querySelector('[data-player="play"]').setAttribute('aria-pressed', String(PLAYER.playing));
  const speed = document.createElement('label');
  speed.className = 'player-speed';
  speed.textContent = 'Speed ';
  const sel = document.createElement('select');
  sel.dataset.player = 'speed';
  for (const [name, ms] of SPEEDS) {
    const o = document.createElement('option');
    o.value = String(ms);
    o.textContent = name;
    o.selected = ms === PLAYER.ms;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { PLAYER.ms = Number(sel.value); if (PLAYER.playing) schedule(); });
  sel.addEventListener('focus', () => { PLAYER.focus = 'speed'; });
  speed.appendChild(sel);
  bar.appendChild(speed);
  // Left and right step while focus is on the controls.
  bar.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlayer(); stepTo(S.snap - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlayer(); stepTo(S.snap + 1); }
  });
  bar.addEventListener('focusout', (e) => { if (e.relatedTarget && !bar.contains(e.relatedTarget)) PLAYER.focus = null; });
  k.appendChild(bar);
  const where = document.createElement('div');
  where.className = 'player-where';
  where.setAttribute('aria-live', 'polite');
  where.textContent = prev ? `Showing ${now}: the lots divided off by then, and those divided since ${prev}.`
    : `Showing ${now}, the first export: the baseline every later lot is counted against.`;
  k.appendChild(where);
  // The panel is rebuilt each step; keep keyboard focus on the same control.
  if (PLAYER.focus && (document.activeElement === document.body || !document.activeElement)) {
    const t = bar.querySelector(`[data-player="${PLAYER.focus}"]`);
    if (t && !t.disabled) t.focus({ preventScroll: true });
    else bar.querySelector('[data-player="play"]').focus({ preventScroll: true });
  }
  return k;
}

VIEWS.growth = {
  parcelLegend: 'created by the slider date',
  label: 'Subdivision growth',
  summary: 'Land being divided, played export by export: lots split from a parcel by a plat, an amended plat or a certificate of survey, where and how fast.',
  legend: 'Lots divided off since the first export',
  async render(panel) {
    const f = S.level === 'county' ? await countyFlow() : await twpFlow();
    const ids = S.level === 'county' ? countyIds() : twpIds();
    const nIv = S.dim.intervals.length;
    const upto = Math.min(S.snap, nIv);   // intervals 0 .. upto-1 end at or before the slider
    const cum = (u, end) => {
      let t = 0, ok = false;
      for (let i = 0; i < end; i++) {
        const at = u * f.nSnaps + i;
        if ((f.data.comparable?.[at] ?? 0) > 0) { t += newLots(f, at); ok = true; }
      }
      return ok ? t : null;
    };
    // Classes fixed from the end of the series, so the map only darkens as it plays.
    const finals = ids.map((u) => cum(u, nIv)).filter((v) => v != null && v > 0);
    const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7', '--seq-8'].map(cssVar);
    const breaks = quantileBreaks(finals, ramp.length);
    const colors = new Map();
    for (const u of ids) {
      const fid = unitFeatureId(u);
      if (fid == null) continue;
      const v = S.snap === 0 ? 0 : cum(u, upto);
      colors.set(fid, v == null ? cssVar('--masked') : v === 0 ? ramp[0] : ramp[Math.min(7, classify(v, breaks))]);
    }
    S.map.paint(colors);
    applyParcelStyle();
    const top = finals.length ? Math.max(...finals) : 0;
    legend(ramp, '0', fmtShort(top), false);

    playerCard(panel);

    // The selection's series, by export: new lots in the step ending there,
    // per year, and the running total.
    const units = selectedUnits() || ids;
    const n = S.nSnaps;
    const step = new Float64Array(n).fill(NaN), perYr = new Float64Array(n).fill(NaN), run = new Float64Array(n);
    let acc = 0;
    for (let sIdx = 1; sIdx < n; sIdx++) {
      const i = sIdx - 1;
      let t = 0, any = false;
      for (const u of units) {
        const at = u * f.nSnaps + i;
        if ((f.data.comparable?.[at] ?? 0) > 0) { t += newLots(f, at); any = true; }
      }
      if (any) { step[sIdx] = t; perYr[sIdx] = t / (S.dim.intervals[i]?.years || 1); acc += t; }
      run[sIdx] = acc;
    }
    const total = run[n - 1] || 0;
    const prevDate = S.snap > 0 ? S.dim.snapshots[S.snap - 1].date : null;
    C.stats(C.card(panel, 'Lots divided off at the selected export', selectionNote()), [
      { value: S.snap > 0 && isFinite(step[S.snap]) ? C.fmtInt(step[S.snap]) : '–',
        label: prevDate ? `new since ${prevDate}` : 'the first export is the baseline',
        detail: S.snap > 0 && isFinite(perYr[S.snap]) ? `${C.fmtInt(perYr[S.snap])} a year` : '' },
      { value: C.fmtInt(run[S.snap]), label: 'lots divided off since the first export' },
      { value: total ? C.fmtPct((100 * run[S.snap]) / total, 0) : '–', label: 'of all the lots divided off in the series',
        detail: `${C.fmtInt(total)} by ${S.dim.snapshots[n - 1].date}` },
    ]);

    const xl = snapLabels();
    const k1 = C.card(panel, 'Lots divided off, running total',
      'Lots split from a parcel by a plat, an amended plat or a certificate of survey since the first export. Intervals whose two ends are not both covered are left out, so early totals are lower bounds.');
    C.lineChart(k1, { series: [run], labels: ['lots divided off'], colors: [cssVar('--cat-1')], xLabels: xl, fmt: C.fmtInt,
      caption: 'Cumulative lots divided off by export' });
    const k2 = C.card(panel, 'Lots divided off per year',
      'Each export’s step, annualised by the days between the two exports. 2012 and 2015 have no export, so those steps span two years.');
    C.lineChart(k2, { series: [perYr], labels: ['lots a year'], colors: [cssVar('--cat-3')], xLabels: xl, fmt: C.fmtInt,
      caption: 'Lots divided off per year, by export' });

    // By instrument: plats, amended plats, surveys.
    const byHow = ['divided_plat', 'divided_amended', 'divided_cos'].map((m) => {
      const out = new Float64Array(n).fill(0);
      for (let sIdx = 1; sIdx < n; sIdx++) {
        let t = 0;
        for (const u of units) {
          const at = u * f.nSnaps + sIdx - 1;
          if ((f.data.comparable?.[at] ?? 0) > 0) t += f.data[m]?.[at] ?? 0;
        }
        out[sIdx] = t;
      }
      return out;
    });
    const kH = C.card(panel, 'How the land was divided',
      'Each export’s lots divided off, by the instrument named in the legal description: a new plat or phase, an amended plat or replat, or a certificate of survey.');
    C.stackedArea(kH, { series: byHow, labels: ['new plat', 'amended plat', 'certificate of survey'],
      colors: [cssVar('--cat-1'), cssVar('--cat-2'), cssVar('--cat-3')], xLabels: xl, fmt: C.fmtInt,
      caption: 'Lots divided off by instrument, by export' });

    // Where the latest step's lots were made.
    const k3 = C.card(panel, prevDate ? `Counties with the most lots divided off, ${prevDate} to ${S.dim.snapshots[S.snap].date}` : 'Counties with the most lots divided off',
      prevDate ? 'The step ending at the selected export.' : 'Move past the first export to see where land was divided.');
    if (S.snap > 0) {
      const cf = await countyFlow();
      const i = S.snap - 1;
      const items = countyIds().map((u) => {
        const at = u * cf.nSnaps + i;
        return { label: countyLabel(u), value: (cf.data.comparable?.[at] ?? 0) > 0 ? newLots(cf, at) : NaN };
      }).filter((d) => isFinite(d.value) && d.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
      if (items.length) C.rankBars(k3, { items, color: cssVar('--cat-1'), fmt: C.fmtInt, caption: 'Lots divided off by county in this step' });
      else k3.appendChild(document.createTextNode('No comparable lots divided off in this step.'));
    }

    const how = C.card(panel, 'Reading the growth map');
    const d = document.createElement('div');
    d.className = 'caveat';
    d.innerHTML = '<ul>'
      + '<li>Zoom in past the township grid to see the parcels themselves, filled in the colour of the year they were created (see the key on the map). Zoomed out, the shading is the running total of new lots.</li>'
      + '<li>The parcels are today’s: a parcel that was split later shows as its pieces at every date, and a parcel that has since been merged away is not drawn.</li>'
      + '<li>A county’s first covered export is its baseline. Its parcels then are not new lots, which is why early years look quiet where a county’s record arrived late.</li>'
      + '<li>A lot counts when land was split where it sits (a parcel in its quarter-section is gone or smaller at the later export) and its legal description names an instrument its parent land’s did not: a new subdivision plat or phase, an amended plat or replat, or a certificate of survey (the instrument of family-transfer and other exempt splits).</li>'
      + '<li>Not counted: a parcel re-described with the same area (a field filled in, a description reformatted), a re-split inside a plat the parent was already in with no new amendment or survey, a split naming no instrument, condominium units, and coverage arriving for the first time.</li>'
      + '</ul>';
    how.appendChild(d);
  },
};

VIEWS.condition = {
  parcelLegend: 'dwelling condition and year built, DOR records (newest point)',
  label: 'Condition',
  summary: 'Condition and age of the housing stock from the DOR building records at eight tax years, and those records as a witness to the ladder.',
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
  const h10 = S.meta.absorption_survival?.horizons?.['10y'];
  const censor = h10
    ? ` Counting a lot that left the record as a competing outcome (Aalen–Johansen), the median cohort has ${C.fmtPct(100 * h10.ci_built_median, 0)} of its lots built by ten years (cohorts ${C.fmtPct(100 * h10.ci_built_min, 0)} to ${C.fmtPct(100 * h10.ci_built_max, 0)}).`
    : '';
  const card = C.card(panel, 'Absorption: share of a cohort built, by age',
    'Of the lots created at each vintage, the share carrying an assessed building N years later. Curves level off near 50–58%: '
    + 'a lot unbuilt at its last export is unbuilt so far, not never, so these curves are right-censored.' + censor + ' '
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
  summary: 'Tenure (public domain, tribal trust, private), owner distance from the land by mailing address, the reservation checkerboard, and where out-of-state owners mail from.',
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
  const scope = viewScope('county');
  const sel = scope.units ? new Set(scope.units) : null;
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
    `${scope.kind === 'selection' ? 'The selected counties. ' : scope.kind === 'view' ? 'The counties in view. ' : 'Statewide. '}`
    + 'Mailing address, not residence. Select a state in the filter row to map its township detail.');
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
  summary: 'Acreage by parcel-size class, the share of acreage in parcels under 40 acres, and agricultural-use acreage.',
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
  summary: 'Owner turnover per year on persisting parcels, interstate transfers against address-only edits, and condominium units created.',
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
  summary: 'New lots per thousand parcels per year, and the sizes of newly created parcels around the 20-acre statutory line.',
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
    const bounds = ERA_BOUNDS[S.era] || ERA_BOUNDS.all;
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
    // The headline ratio and its sensitivity come from the publish, never typed here.
    const t20 = S.meta.thresholds?.['20_acre_edge'];
    const s20 = S.meta.thresholds_sensitivity?.sensitivity?.['20']?.rel3;
    const ratioTxt = t20 ? `${Number(t20.above_over_below).toFixed(2)}×` : 'about 1.6×';
    const exclTxt = s20 && s20.ratio_excl_exact != null
      ? ` (${Number(s20.ratio_excl_exact).toFixed(2)}× with the parcels of exactly 20 acres set aside)` : '';
    const ctrl = S.meta.thresholds_sensitivity?.controls || {};
    const cr = Object.entries(ctrl).filter(([k]) => Number(k) <= 50).map(([, v]) => Number(v.ratio)).filter(Number.isFinite);
    const ctrlTxt = cr.length ? `the control sizes from 10 to 50 acres run ${Math.min(...cr).toFixed(2)}× to ${Math.max(...cr).toFixed(2)}×` : 'controls at 12, 15, 25, 30 and 50 acres sit near 1.0';
    const card = C.card(panel, 'Newly created parcel sizes around the 20-acre line',
      `Under MCA 76-4-102(25) a subdivision is a division creating a parcel under 20 acres, and under 76-4-103 a parcel of 20 acres or more (exclusive of public roadways) is not subject to DEQ sanitation review. Lots created just above the line outnumber those just below by ${ratioTxt}${exclTxt}, while ${ctrlTxt}. Bunching is a pattern consistent with lots sized to clear review; it does not establish the motive of any one division.`);
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

/** The county level is coerced by state.js (normalize) before a render ever
 *  starts; this is the guard that says so if it is not. */
function forceCounty() {
  if (S.level === 'county') return;
  console.warn('forceCounty: the level should have been coerced by applyState');
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

VIEWS.holdings = {
  parcelLegend: 'owner\u2019s holding in the county',
  label: 'Holdings',
  summary: 'Large private holdings (640+ acres) consolidated by owner within each county: counts, acreage, CLO4, size classes, concentration, and the ten largest named from the public record.',
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
      'Share of a county’s large-holding acreage held by its four largest holdings (Desmarais et al. 2015, as used by the paper). Averaged over the paper’s counties it rose from 14% to 16%. Where a maximal-tier line is drawn, the gap between the two is what the pending identity decisions could change: the tiers are two reconciliation procedures, not confidence bounds.');
    if (units.length === 1) {
      const u = units[0];
      const clo = Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'clo4', u, i));
      // The maximal tier's CLO4 beside the document tier's: the gap is what
      // the pending identity decisions could change.
      const cloMax = h.measures.includes('clo4_max')
        ? Float64Array.from({ length: S.nSnaps }, (_, i) => 100 * hAt(h, 'clo4_max', u, i)) : null;
      C.lineChart(k3, { series: cloMax ? [clo, cloMax] : [clo], labels: cloMax ? ['CLO4, document tier', 'maximal tier'] : ['CLO4'],
        colors: cloMax ? [cssVar('--cat-3'), cssVar('--ord3-2')] : [cssVar('--cat-3')], xLabels: xl,
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
  summary: 'The large holdings that rest on an unmade identity or tenure decision, and how a review is recorded.',
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

function selectionNames() {
  const names = Array.from(S.selection).slice(0, 4).map((u) =>
    S.level === 'county' ? `${S.dim.counties.find((c) => c.code === u)?.name ?? u} County`
      : (S.twpById.get(u)?.label ?? u));
  return `${names.join(', ')}${S.selection.size > 4 ? ` and ${S.selection.size - 4} more` : ''}`;
}
function selectionNote() {
  const sc = viewScope();
  if (sc.kind === 'selection') {
    return `Selected: ${selectionNames()}. The charts show the selection while it is on screen; `
      + 'pan away from it, or press Clear selection, and they follow the map again.';
  }
  const hidden = S.selection.size ? `Your selection (${selectionNames()}) is out of view, so the charts follow the map. ` : '';
  if (sc.kind === 'view') {
    const cc = sc.center ? countyAt(sc.center) : null;
    const what = S.level === 'county' ? 'count' : 'township';
    return `${hidden}In view: ${sc.units.length} ${what}${sc.units.length > 1 ? (what === 'count' ? 'ies' : 's') : (what === 'count' ? 'y' : '')}`
      + `${cc ? `, centred in ${countyLabel(cc)} County` : ''}. The charts follow the map; zoom out for the whole state, or click a unit to pick one.`;
  }
  return `${hidden}Statewide. Zoom in and the charts follow the map; click a unit to focus, shift-click to add.`;
}


/* 9. Reports -- the six printable documents, composed in reports.js */
VIEWS.reports = {
  label: 'Reports',
  summary: 'Six printable documents composed from the same tables: county profile, housing condition profile, statewide trends, large-holdings update, review worksheet (CSV), subdivision activity.',
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
  // The form's fields are state (a link can carry them); only Generate composes.
  $('rpt-kind').addEventListener('change', () => {
    applyState({ report: { kind: $('rpt-kind').value } }, { render: false });
    sync();
  });
  $('rpt-county').addEventListener('change', () =>
    applyState({ report: { county: Number($('rpt-county').value) || null } }, { render: false }));
  $('rpt-a').addEventListener('change', () => applyState({ report: { a: Number($('rpt-a').value) } }, { render: false }));
  $('rpt-b').addEventListener('change', () => applyState({ report: { b: Number($('rpt-b').value) } }, { render: false }));
  $('rpt-go').addEventListener('click', async () => {
    await applyState({ report: { kind: $('rpt-kind').value, county: Number($('rpt-county').value) || null,
      a: Number($('rpt-a').value), b: Number($('rpt-b').value), generated: true } }, { render: false });
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

/* 10. About -- how to use it, how to read it, where it comes from; the text
   itself is in about.js, shared with the assistant's instructions. */
VIEWS.about = {
  label: 'About',
  summary: 'What the dashboard is, how to use it, how to read each view, where the data and analyses come from, and the caveats.',
  legend: 'About this dashboard',
  full: true,
  async render(panel) {
    for (const sec of aboutSections(S.dim, S.meta)) {
      const c = C.card(panel, sec.title);
      const d = document.createElement('div');
      d.className = 'about';
      d.innerHTML = sec.html;
      c.appendChild(d);
    }
    // The temporal registry: what time each source speaks for.
    if (Array.isArray(S.meta.temporal) && S.meta.temporal.length) {
      const c = C.card(panel, 'What time each source speaks for',
        'Observation time (when a source was captured) and effective time (when the condition held) are not the same, and the series combines sources from different ones.');
      C.table(c, { headers: ['source', 'observed', 'applies to', 'what it supports'],
        rows: S.meta.temporal.map((t) => [t.name, t.observation, t.applies_to, t.inference]),
        caption: 'Temporal applicability of each input' });
    }
    // The release this bundle is: from the manifest the publish stage writes.
    try {
      const m = await loadJSON('manifest.json');
      const c = C.card(panel, 'This release');
      const d = document.createElement('div');
      d.className = 'about';
      d.textContent = `Release ${m.release}, built ${String(m.built_at || '').slice(0, 10)} from pipeline commit `
        + `${String(m.pipeline?.git_commit || 'unknown').slice(0, 8)}${m.pipeline?.dirty ? ' (with uncommitted changes)' : ''}, `
        + `code hash ${m.pipeline?.code_hash || '?'}; ${Object.keys(m.outputs || {}).length} published files and `
        + `${(m.tiles?.files ?? 0).toLocaleString()} tiles, each with its hash in data/manifest.json.`;
      c.appendChild(d);
    } catch { /* a bundle published without a manifest */ }
  },
};

/* -------------------------------------------------------------------- wiring */
/* Each view's headline share or rate for the places in view (or selected),
   drawn against the county at their centre and against Montana: the charts
   above follow the map, and this says how the place compares. The formulas
   are the views' own (DERIVED). */
const COMPARE = {
  ladder: ['addressed_unbuilt_share', 'Addressed but not built, compared'],
  growth: ['lots_divided_per_1000_per_year', 'Lots divided off per 1,000 parcels a year, compared'],
  condition: ['fair_or_worse_share', 'Dwellings in fair or worse condition, compared'],
  ownership: ['out_of_state_share', 'Parcels with an out-of-state owner, compared'],
  fragmentation: ['under_40ac_acreage_share', 'Acreage in parcels under 40 acres, compared'],
  churn: ['owner_change_pct_per_year', 'Owner changes per year, compared'],
  thresholds: ['new_lots_per_1000_per_year', 'New lots per 1,000 parcels a year, compared'],
  holdings: ['large_acres_share_of_private', 'Private acreage in large holdings, compared'],
};
async function compareCard(panel) {
  const spec = COMPARE[S.view];
  if (!spec) return;
  const [name, title] = spec;
  const d = DERIVED[name];
  const county = d.topic === 'holdings' || d.level === 'county';
  const sc = viewScope(county ? 'county' : S.level);
  if (sc.kind === 'state') return;   // the charts already show Montana
  const series = [], labels = [], colors = [];
  const here = sc.kind === 'view' ? 'in view' : 'selection';
  series.push(await derivedSeries(name, sc.level, sc.units)); labels.push(here); colors.push(cssVar('--cat-1'));
  // The county at the centre, unless the scope is that county already.
  const cc = sc.center ? countyAt(sc.center) : null;
  const sameCounty = sc.level === 'county' && sc.units.length === 1 && sc.units[0] === cc;
  if (cc && !sameCounty) {
    series.push(await derivedSeries(name, 'county', [cc])); labels.push(`${countyLabel(cc)} County`); colors.push(cssVar('--cat-3'));
  }
  series.push(await derivedSeries(name, 'county', null)); labels.push('Montana'); colors.push(cssVar('--ink-muted'));
  const card = C.card(panel, title,
    `${d.unit[0].toUpperCase()}${d.unit.slice(1)}: the ${here === 'in view' ? 'places in view' : 'selection'}`
    + `${cc && !sameCounty ? `, ${countyLabel(cc)} County (at the centre of ${here === 'in view' ? 'the view' : 'the selection'})` : ''} and Montana. `
    + 'A gap is a point below the measure’s count floor or not comparable, not zero.');
  const pct = /%/.test(d.unit);
  // Three lines that often end close together: the legend row names them.
  C.lineChart(card, { series, labels, colors, xLabels: snapLabels(), directLabels: false,
    fmt: pct ? (v) => C.fmtPct(v, 1) : (v) => (Number.isFinite(v) ? v.toFixed(v >= 10 ? 0 : 1) : '–'),
    caption: `${title} (table view)` });
  // After the view's first card of figures for the scope (or its first card).
  const cards = [...panel.children].filter((c) => c !== card);
  const anchor = cards.find((c) => c.querySelector('.stats')) || cards[0];
  if (anchor && anchor.nextSibling !== card) panel.insertBefore(card, anchor.nextSibling);
}

async function render() {
  S.renders++;
  lastScopeKey = scopeKey();
  // Reports carry their own pair of dates, so no slider mark there.
  C.setSnapshotMark(S.view === 'reports' ? null : snapLabels()[S.snap]);
  const panel = $('panel');
  panel.textContent = '';
  const l = $('legend');
  l.dataset.title = VIEWS[S.view].legend;
  try {
    await VIEWS[S.view].render(panel);
    await compareCard(panel);
  } catch (err) {
    console.error(err);
    const c = C.card(panel, 'Could not render this view');
    c.appendChild(document.createTextNode(String(err && err.message ? err.message : err)));
  }
  if (!VIEWS[S.view].full) caveatCard(panel);
  // A text description of the map for readers who cannot see it.
  const md = $('map-desc');
  if (md) {
    md.textContent = VIEWS[S.view].full ? ''
      : `Map: ${VIEWS[S.view].legend}, by ${S.level}. ${selectionNote()} Export ${S.dim.snapshots[S.snap]?.date || ''}.`;
  }
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

/* Every control is one line: it hands applyState a patch and state.js does
   the rest -- validation, the map, the other controls, the render, the URL.
   The controls are synced back from the state after each change, so no
   control needs to know what another one did. */
/* One line per view for the View menu: what the reader will see there. */
const VIEW_BRIEF = {
  ladder: 'How much land is platted, addressed or built, and how fast new lots get built on.',
  growth: 'Play land being divided by plats, amended plats and surveys, export by export.',
  condition: 'The condition and age of homes, from the state’s building records.',
  ownership: 'Public, tribal and private land, and how far owners live from it.',
  fragmentation: 'How the land is divided by parcel size, and agricultural acreage.',
  churn: 'How often parcels change hands, and sales to out-of-state owners.',
  thresholds: 'Where new lots are created, and their sizes around the 20-acre line.',
  holdings: 'Large private holdings of 640 acres or more, combined by owner, by county.',
  review: 'Large holdings that wait on an unmade decision about the owner.',
  reports: 'Six printable reports built from the same tables.',
};

/* The View menu: a button that opens a list of the views. Arrow keys move,
   Enter or a click chooses, Escape or a click elsewhere closes. */
export function openViewMenu(focusCurrent = true) {
  const nav = $('nav'), btn = $('views-btn');
  if (!nav || !btn) return;
  nav.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  if (focusCurrent) (nav.querySelector('[aria-checked="true"]') || nav.firstElementChild)?.focus();
}
export function closeViewMenu(refocus = false) {
  const nav = $('nav'), btn = $('views-btn');
  if (!nav || nav.hidden) return;
  nav.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (refocus) btn.focus();
}

function buildControls() {
  const nav = $('nav');
  for (const [k, v] of Object.entries(VIEWS)) {
    if (k === 'about' || k === 'reports') continue;   // Reports and About have their own buttons
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.view = k;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(k === S.view));
    b.setAttribute('aria-selected', String(k === S.view));
    const t = document.createElement('span');
    t.className = 'vi-t';
    t.textContent = v.label;
    const d = document.createElement('span');
    d.className = 'vi-d';
    d.textContent = VIEW_BRIEF[k] || '';
    b.append(t, d);
    b.addEventListener('click', () => { closeViewMenu(true); applyState({ view: k }); });
    nav.appendChild(b);
  }
  const vbtn = $('views-btn');
  vbtn.addEventListener('click', () => ($('nav').hidden ? openViewMenu() : closeViewMenu()));
  vbtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openViewMenu(); }
  });
  nav.addEventListener('keydown', (e) => {
    const items = [...nav.children];
    const k = items.indexOf(document.activeElement);
    const to = (n) => items[(n + items.length) % items.length].focus();
    if (e.key === 'ArrowDown') { e.preventDefault(); to(k + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); to(k - 1); }
    else if (e.key === 'Home') { e.preventDefault(); to(0); }
    else if (e.key === 'End') { e.preventDefault(); to(items.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeViewMenu(true); }
    else if (e.key === 'Tab') closeViewMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('nav').hidden && !$('viewmenu').contains(e.target)) closeViewMenu();
  });
  // About and Reports are toggles: pressed again, they put back the view the
  // reader came from (Development when the page was opened on them).
  let cameFrom = null;
  const toggleView = (v) => {
    if (S.view === v) { applyState({ view: cameFrom && cameFrom !== v ? cameFrom : 'ladder' }); return; }
    if (S.view !== 'about' && S.view !== 'reports') cameFrom = S.view;
    applyState({ view: v });
  };
  $('about-btn').addEventListener('click', () => toggleView('about'));
  $('reports-btn').addEventListener('click', () => toggleView('reports'));
  const slider = $('snap');
  slider.max = String(S.nSnaps - 1);
  slider.value = String(S.snap);
  // Dragging moves the date label only; the view follows on release.
  slider.addEventListener('input', () => syncSnapLabel(Number(slider.value)));
  slider.addEventListener('change', () => applyState({ snap: Number(slider.value) }));
  syncSnapLabel(S.snap);

  $('level').addEventListener('change', (e) => applyState({ level: e.target.value }));
  $('measure').addEventListener('change', (e) => applyState({ measure: e.target.value }));
  $('mask').addEventListener('change', (e) => applyState({ maskLow: e.target.checked }));
  $('era').addEventListener('change', (e) => applyState({ era: e.target.value }));
  $('basemap').addEventListener('change', (e) => applyState({ basemap: e.target.value }));

  const origin = $('origin');
  origin.appendChild(new Option('all origins', ''));
  for (const st of S.dim.states) {
    if (st && st.length === 2 && st !== 'MT') origin.appendChild(new Option(st, st));
  }
  origin.addEventListener('change', (e) => applyState({ originState: e.target.value }));

  for (const k of LAYER_KEYS) {
    const el = $(LAYER_IDS[k]);
    if (el) el.addEventListener('change', (e) => applyState({ layers: { [k]: e.target.checked } }));
  }
  $('clearsel').addEventListener('click', () => applyState({ selection: [] }));
  $('theme').addEventListener('click', () => {
    const cur = S.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyState({ theme: cur === 'dark' ? 'light' : 'dark' });
  });
}

/** The camera is state too: a moved map writes itself into the URL. */
let moveTimer = null;
let lastScopeKey = null;
function scopeKey() { const sc = viewScope(); return `${sc.kind}|${S.level}|${sc.units ? sc.units.join(',') : ''}`; }
function onMoveEnd() {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    // Still flying (a view change moving the camera): its own move-end comes
    // after, by which time that change has drawn the panel.
    if (S.map.map.isMoving()) return;
    const v = S.map.getView();
    S.mapView = { center: v.center, zoom: v.zoom };
    writeHash();
    // The charts follow the map: redraw when the places in view change, or
    // when a selection scrolls into or out of view.
    const k = scopeKey();
    if (lastScopeKey !== null && k !== lastScopeKey && !VIEWS[S.view].full) render();
    lastScopeKey = k;
  }, 300);
}

/* ---------------------------------------------------------------- phones
   One application at every width; below 700 px it behaves as a phone app:
   the map takes the screen, the panel is a sheet over it that can be dragged
   up (and scrolled inside), the layer list starts closed and the legend shows
   colours and classes with its notes behind a More button. The defaults are
   re-applied whenever the width crosses the line (a rotation, a resized
   window), and the charts are redrawn when the width changes, because they are
   drawn to the width they have. */
const PHONE = typeof window !== 'undefined' ? window.matchMedia('(max-width: 700px)') : null;
const SHEET_SNAPS = [0.32, 0.62, 0.94];   // share of the area below the filters
let sheetFrac = SHEET_SNAPS[0];

function setSheet(frac) {
  const main = document.querySelector('main');
  if (!main) return;
  sheetFrac = Math.max(0.18, Math.min(0.96, frac));
  main.style.setProperty('--sheet-h', `${(100 * sheetFrac).toFixed(1)}%`);
  const g = $('sheet-grip');
  if (g) g.setAttribute('aria-valuenow', String(Math.round(100 * sheetFrac)));
}
const nearestSnap = (f) => SHEET_SNAPS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));

function setupSheet() {
  const g = $('sheet-grip');
  const main = document.querySelector('main');
  if (!g || !main) return;
  g.setAttribute('role', 'slider');
  g.setAttribute('aria-valuemin', '18');
  g.setAttribute('aria-valuemax', '96');
  let drag = null;
  g.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, f: sheetFrac, moved: false };
    g.setPointerCapture(e.pointerId);
    main.classList.add('sheet-dragging');
  });
  g.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const h = main.getBoundingClientRect().height || 1;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    setSheet(drag.f + dy / h);
  });
  const done = () => {
    if (!drag) return;
    main.classList.remove('sheet-dragging');
    // A tap steps up through the heights and back down to the peek.
    if (!drag.moved) {
      const k = SHEET_SNAPS.indexOf(nearestSnap(sheetFrac));
      setSheet(SHEET_SNAPS[(k + 1) % SHEET_SNAPS.length]);
    } else setSheet(nearestSnap(sheetFrac));
    drag = null;
  };
  g.addEventListener('pointerup', done);
  g.addEventListener('pointercancel', done);
  // Keyboard: Enter/Space step like a tap (the click below), arrows move.
  g.addEventListener('click', (e) => {
    if (e.detail !== 0) return;   // a pointer tap is handled on pointerup
    const k = SHEET_SNAPS.indexOf(nearestSnap(sheetFrac));
    setSheet(SHEET_SNAPS[(k + 1) % SHEET_SNAPS.length]);
  });
  g.addEventListener('keydown', (e) => {
    const k = SHEET_SNAPS.indexOf(nearestSnap(sheetFrac));
    if (e.key === 'ArrowUp') { e.preventDefault(); setSheet(SHEET_SNAPS[Math.min(SHEET_SNAPS.length - 1, k + 1)]); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSheet(SHEET_SNAPS[Math.max(0, k - 1)]); }
  });
  setSheet(SHEET_SNAPS[0]);
}

function setLegendExpanded(on) {
  const l = $('legend'), b = $('legend-more');
  if (!l || !b) return;
  l.classList.toggle('expanded', on);
  b.setAttribute('aria-expanded', String(on));
  b.textContent = on ? 'Less' : 'More';
}

function setupPhone() {
  setupSheet();
  $('legend-more')?.addEventListener('click', () => setLegendExpanded(!$('legend').classList.contains('expanded')));
  $('filters-more')?.addEventListener('click', () => {
    const open = !$('filters').classList.contains('open');
    $('filters').classList.toggle('open', open);
    $('filters-more').setAttribute('aria-expanded', String(open));
    // The map's box changed: tell it.
    requestAnimationFrame(() => S.map?.map?.resize());
  });
  const apply = () => {
    const phone = !!PHONE?.matches;
    if ($('layers')) $('layers').open = !phone;
    setLegendExpanded(!phone);
    // The map credit starts folded to its (i) button on a phone, where its
    // text would sit on the legend; it opens with a tap.
    const attrib = document.querySelector('.maplibregl-ctrl-attrib');
    if (attrib && phone) attrib.classList.remove('maplibregl-compact-show');
    setSheet(SHEET_SNAPS[0]);
  };
  apply();
  PHONE?.addEventListener('change', () => { apply(); relayout(); });
  // Redraw on a width change only: a phone's address bar showing and hiding
  // changes the height on every scroll and must not redraw the charts.
  let w = window.innerWidth, t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { if (window.innerWidth !== w) { w = window.innerWidth; relayout(); } }, 250);
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
  // The boundaries are kept: place lookups need them and loadJSON does not cache.
  S.geo = { townships, counties };
  S.snap = S.nSnaps - 1;
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
        ['created', bornTxt],
      ];
      if (props.hs != null && Number(props.hs) >= 0) {
        const cls = (L.holding_size || [])[Number(props.hs)] || '';
        rows.push(['owner\u2019s holding', `${cls} ac in this county`
          + (Number(props.hr) > 0 ? ` \u00b7 #${Number(props.hr)} largest` : '')
          + (Number(props.hp) ? ' \u00b7 awaiting review' : '')]);
      }
      if (props.cd != null && Number(props.cd) >= 0) {
        rows.push(['dwelling condition', `${(L.condition || [])[Number(props.cd)] || '-'} · DOR rating, tax year ${S.meta.cama?.tax_year || 2026}`]);
      } else if (L.dev_stage[Number(props.dev)] === 'built') {
        rows.push(['dwelling condition', 'not rated: no dwelling rating on record (commercial buildings and outbuildings are not rated; see About)']);
      }
      if (Number(props.sdx) > 0) {
        const how = ['', 'a subdivision plat', 'an amended plat', 'a certificate of survey'][Number(props.sdh)] || 'a division';
        rows.push(['divided off', `${S.dim.snapshots[Number(props.sdx)]?.date || ''} by ${how}`]);
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
      // A plain click selects the unit; shift-click toggles it in the set.
      const sel = additive ? new Set(S.selection) : new Set();
      if (sel.has(u)) sel.delete(u); else sel.add(u);
      applyState({ selection: Array.from(sel) });
    },
  });
  bindHost({
    render,
    viewInfo: (k) => (VIEWS[k]
      ? { label: VIEWS[k].label, legend: VIEWS[k].legend, summary: VIEWS[k].summary || '', full: !!VIEWS[k].full }
      : null),
    refreshLegend: refreshLegendForZoom,
  });
  // Test handles: the smoke and screenshot suites drive the map and the
  // state through these.
  window.__map = S.map;
  window.__state = S;
  window.__dash = {
    getState, applyState, describeState,
    toHash: () => toHash(getState(), S.dim), fromHash: (h) => fromHash(h, S.dim),
  };
  try {
    await S.map.init({ townships, counties });
    // The legend must follow the surface the reader is actually looking at.
    S.map.map.on('zoomend', refreshLegendForZoom);
    S.map.map.on('moveend', onMoveEnd);
  } catch (err) {
    // The map failing must not take the charts with it.
    console.error('map init failed', err);
    const w = document.getElementById('mapwrap');
    if (w) w.innerHTML = '<div style="padding:18px;color:var(--ink-2)">'
      + 'Map unavailable: ' + String(err && err.message ? err.message : err) + '</div>';
  }
  buildControls();
  // On a phone the layer panel starts closed; the map is the point.
  setupPhone();
  // A pasted link is a state: it is applied before the first render, and a
  // link edited in the address bar afterwards is applied the same way.
  const { patch, warnings } = fromHash(location.hash, S.dim);
  if (warnings.length) console.warn('link:', warnings.join('; '));
  await applyState(patch, { source: 'hash', force: true });
  window.addEventListener('hashchange', () => applyState(fromHash(location.hash, S.dim).patch, { source: 'hash' }));
  // The assistant's button is probed first so the tour can include it; the
  // tour starts by itself on a first visit and is a header button after.
  await enableAssistant();
  // Counted on load, before the terms notice, so a visit that stops there still counts.
  pageview();
  // The terms of use come first on a first visit; the tutorial waits for them.
  const { showDisclaimer } = await import('./disclaimer.js');
  await showDisclaimer();
  const { initTour } = await import('./tour.js');
  window.__tour = initTour({ applyState, getState, sharedLink: ARRIVED_ON_LINK,
    menu: { open: () => openViewMenu(false), close: () => closeViewMenu() } });
}

/** The Ask button appears only where the assistant's endpoint answers: a
 *  static deploy without the Worker gets the site's 404 page here and shows
 *  nothing. The panel and the SDK's stream helper are a separate chunk,
 *  loaded on the first click. */
async function enableAssistant() {
  let h;
  try {
    const r = await fetch('api/assistant/health', { cache: 'no-store' });
    if (!r.ok || !/application\/json/.test(r.headers.get('content-type') || '')) return;
    h = await r.json();
  } catch { return; }
  if (!h || !h.ok) return;
  const t = $('assist-toggle');
  t.hidden = false;
  t.addEventListener('click', async () => {
    const m = await import('../assistant/panel.js');
    m.toggle(h);
  });
}
