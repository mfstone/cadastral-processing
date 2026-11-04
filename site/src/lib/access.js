/* ---------------------------------------------------------------------------
   access.js -- the published tables as the views read them: the township and
   county cubes and flows, the building records, the holdings, and the small
   helpers that turn the live state into unit lists and labels.

   Moved out of app.js so that anything else needing the same arithmetic --
   the reports, the assistant's tools -- can import it without importing the
   views. Caches live on S (state.js), which also supplies the dimensions and
   the current level, snapshot and selection.
--------------------------------------------------------------------------- */
import { loadTable, cube, flowCube } from './data.js';
import { S, unitFeatureId, unavailableAt, FIELD_LABEL } from './state.js';

export { unitFeatureId, unavailableAt, FIELD_LABEL };

/* ------------------------------------------------------- cubes and flows */
export async function twpCube(topic) {
  if (S.cubes[topic]) return S.cubes[topic];
  const t = await loadTable(`twp_${topic}`);
  S.cubes[topic] = cube(t, { nUnits: S.nTwp + 1, nSnaps: S.nSnaps, delta: S.dim.delta_coded });
  return S.cubes[topic];
}
export async function twpFlow() {
  if (S.flows.twp) return S.flows.twp;
  const t = await loadTable('twp_flow');
  S.flows.twp = flowCube(t, { nUnits: S.nTwp + 1, nIntervals: S.nIv });
  return S.flows.twp;
}
export async function countyCube() {
  if (S.cubes.county) return S.cubes.county;
  const t = await loadTable('county_stock');
  S.cubes.county = cube(t, { nUnits: 57, nSnaps: S.nSnaps, keyCol: 'county_n', delta: false });
  return S.cubes.county;
}
export async function countyFlow() {
  if (S.flows.county) return S.flows.county;
  const t = await loadTable('county_flow');
  S.flows.county = flowCube(t, { nUnits: 57, nIntervals: S.nIv, keyCol: 'county_n' });
  return S.flows.county;
}

/** Active stock cube for the chosen unit level, plus its id list. */
export async function activeStock(topic) {
  if (S.level === 'county') return { c: await countyCube(), ids: countyIds() };
  return { c: await twpCube(topic), ids: twpIds() };
}
export const twpIds = () => S.dim.townships.map((t) => t.id);
export const countyIds = () => S.dim.counties.map((c) => c.code);
/* ---- the scope the charts summarise ---------------------------------------
   A selection (a click) is the scope while it is in view. Otherwise the charts
   follow the map: zoomed in, the townships (or, at county level, the
   counties) whose centres are in view; zoomed out to most of the state,
   Montana as a whole (null). A place in view is also compared with the
   county at the centre of what is shown and with the state (compareCard). */
let scopeIdx = null;
function geomBox(geom) {
  let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity, sx = 0, sy = 0, k = 0;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < w) w = x; if (y < so) so = y; if (x > e) e = x; if (y > n) n = y; sx += x; sy += y; k++;
  }
  return { b: [w, so, e, n], c: k ? [sx / k, sy / k] : [(w + e) / 2, (so + n) / 2], rings: polys.map((p) => p[0]) };
}
function scopeIndex() {
  if (scopeIdx || !S.geo || !S.twpByKey) return scopeIdx;
  const twp = new Map(), cty = new Map();
  for (const f of S.geo.townships?.features || []) {
    const t = S.twpByKey.get(f.properties.tr_key);
    if (t && f.geometry) twp.set(t.id, geomBox(f.geometry));
  }
  for (const f of S.geo.counties?.features || []) if (f.geometry) cty.set(Number(f.properties.county_n), geomBox(f.geometry));
  scopeIdx = { township: twp, county: cty };
  return scopeIdx;
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** The county containing a point, or null. */
export function countyAt([x, y]) {
  const idx = scopeIndex();
  if (!idx) return null;
  for (const [code, g] of idx.county) {
    if (x < g.b[0] || x > g.b[2] || y < g.b[1] || y > g.b[3]) continue;
    if (g.rings.some((r) => inRing(x, y, r))) return code;
  }
  return null;
}
/** { kind: 'selection'|'view'|'state', level, units, center }. */
/** Is any selected unit on screen? A selection only steers the charts while
 *  the reader can see it: pan away from it and the map takes over again. */
export function selectionInView() {
  const m = S.map?.map, idx = scopeIndex();
  if (!S.selection.size) return false;
  if (!m || !idx) return true;
  const bb = m.getBounds(), W = bb.getWest(), So = bb.getSouth(), E = bb.getEast(), N = bb.getNorth();
  for (const u of S.selection) {
    const g = idx[S.level]?.get(u);
    if (g && g.b[0] <= E && g.b[2] >= W && g.b[1] <= N && g.b[3] >= So) return true;
  }
  return false;
}
export function viewScope(level = S.level) {
  if (S.selection.size && level === S.level && selectionInView()) {
    const idx = scopeIndex();
    const pts = Array.from(S.selection).map((u) => idx?.[level]?.get(u)?.c).filter(Boolean);
    const center = pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : null;
    return { kind: 'selection', level, units: Array.from(S.selection), center };
  }
  const m = S.map?.map, idx = scopeIndex();
  if (!m || !idx) return { kind: 'state', level, units: null, center: null };
  const bb = m.getBounds(), W = bb.getWest(), So = bb.getSouth(), E = bb.getEast(), N = bb.getNorth();
  const all = idx[level];
  let units = [];
  for (const [u, g] of all) if (g.c[0] >= W && g.c[0] <= E && g.c[1] >= So && g.c[1] <= N) units.push(u);
  // Zoomed in past every centre: the places the view overlaps.
  if (!units.length) for (const [u, g] of all) if (g.b[0] <= E && g.b[2] >= W && g.b[1] <= N && g.b[3] >= So) units.push(u);
  const c = m.getCenter();
  if (!units.length || units.length >= 0.9 * all.size) return { kind: 'state', level, units: null, center: null };
  return { kind: 'view', level, units: units.sort((a, b) => a - b), center: [c.lng, c.lat] };
}
export const selectedUnits = () => viewScope().units;

export const snapLabels = () => S.dim.snapshots.map((s) => s.date.slice(0, 7));
export const ivLabels = () => S.dim.intervals.map((i) => S.dim.snapshots[i.a].date.slice(2, 7) + '→' + S.dim.snapshots[i.b].date.slice(2, 7));

/* ------------------------------------------------- the building records */
export const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
export const CD_COLS = [...Array(8).keys()].map((i) => `n_cd${i}`);
export const YB_COLS = [...Array(9).keys()].map((i) => `n_yb${i}`);
export const WITNESS_TWP = ['parcels_tested', 'improved_layer', 'struct_dor', 'agree_built', 'layer_only', 'dor_only',
  'addr_tested', 'addr_hn_pt', 'addr_hn_nopt', 'addr_dw_res', 'addr_dw_nores'];
export const WITNESS_CTY = [...WITNESS_TWP, 'addr_pt_nohn', 'addr_res_nodw', 'hn_dwell', 'hn_nodwell', 'nohn_dwell', 'dormant_lt40', 'dormant_dwell',
  'dormant_struct', 'dormant_permit', 'stage1', 'stage1_dwell', 'timing_n', 'timing_never', 'timing_ontime',
  'born_dwell', 'born_older', 'insp_recent', 'value_n', 'value_equal'];
export const shortCond = (l) => String(l).replace(/ \(\d+\)/, '');
export const ratedOf = (o) => CD_COLS.reduce((a, n) => a + (o[n] || 0), 0);
export const belowShare = (o) => { const r = ratedOf(o); return r ? (100 * (o.n_cd0 + o.n_cd1 + o.n_cd2 + o.n_cd3)) / r : NaN; };
export const pre1980Share = (o) => { const t = YB_COLS.reduce((a, n) => a + (o[n] || 0), 0); return t ? (100 * (o.n_yb0 + o.n_yb1 + o.n_yb2 + o.n_yb3 + o.n_yb4)) / t : NaN; };
export const pctOf = (n, d) => (d ? (100 * n) / d : NaN);

export async function camaTables() {
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
export const pointAt = (T, snap) => { let p = T.points[0]; for (const s of T.points) if (s <= snap) p = s; return p; };
export const pointMeta = (s) => (S.meta.cama?.points || []).find((p) => p.s === s) || {};
export const taxYearOf = (s) => pointMeta(s).tax_year ?? s;
/** Sum the named columns of table `t` over the rows keyed by `units`. */
export function camaSum(t, byMap, units, names) {
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
export function condByDecade(T, counties, s) {
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
export function timingSeries(T, counties, s) {
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
export function transitionSeries(T, counties) {
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

/* -------------------------------------------------------------- holdings */
export async function holdingsCube() {
  if (S.cubes.holdings) return S.cubes.holdings;
  const t = await loadTable('holdings_county');
  S.cubes.holdings = cube(t, { nUnits: 57, nSnaps: S.nSnaps, keyCol: 'county_n', snapCol: 's', delta: false });
  return S.cubes.holdings;
}
export const hAt = (c, m, u, s) => c.data[m]?.[u * c.nSnaps + s] ?? 0;
// Holdings are counties: the selected counties, or the counties in view, or the state row (0).
export const holdingUnits = () => {
  const sc = viewScope('county');
  return sc.units && sc.units.length ? sc.units : [0];
};
export const countyLabel = (u) => (u === 0 ? 'Montana' : (S.dim.counties.find((c) => c.code === u)?.name ?? String(u)));

export async function topRows(units, s) {
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

/* ---------------------------------------------------------- the mask */
export function maskLowCoverage(cov) {
  if (!S.maskLow) return null;
  return (u) => {
    const a = cov.data.coverage_ok;
    if (!a) return false;
    return (a[u * cov.nSnaps + S.snap] ?? 1) <= 0;
  };
}
