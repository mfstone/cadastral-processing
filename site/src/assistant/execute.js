/* ---------------------------------------------------------------------------
   execute.js -- the six tools, executed in the page.

   The model emits a tool call; this module runs it against the live
   dashboard: state.js for what is shown, access.js for the cubes the views
   read, the published tables for everything else. Every result is compact
   JSON that echoes the vintage it was read at and names rather than ids,
   capped at RESULT_CHARS; every failure is a thrown Error whose message is
   handed back to the model as an error result it can act on.

   The owner-names policy is enforced here as well as in the Worker: the
   name columns of holdings_top are neither returned nor filterable.
--------------------------------------------------------------------------- */
import { S, applyState, describeState, getState, unavailableAt } from '../lib/state.js';
import { loadTable, loadJSON, cube, sumAt } from '../lib/data.js';
import * as A from '../lib/access.js';
import { DERIVED } from './derived.mjs';
import { runQuery, QueryError } from './query.js';
import { countyCode, townshipFromLabel, snapIndex, stateCode, lookupPlace, bboxOf } from './resolve.js';
import { REPORT_KINDS } from './tools.js';

export const RESULT_CHARS = 16000;
const DENY_ALWAYS = new Set(['group_hash']);
const NAME_COLS = ['display_name', 'display_city', 'display_state'];
const STOCK_TOPICS = new Set(['core', 'dev', 'tenure', 'locality', 'size', 'class', 'owner_origin', 'ag', 'improve']);
const seq = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const TOPIC_DEFAULTS = {
  core: ['parcels', 'acres', 'coverage_ok'],
  dev: ['n_dev0', 'n_dev1', 'n_dev2', 'n_dev4'],
  tenure: [...seq('n_ten', 3), ...seq('ac_ten', 3)],
  locality: seq('n_loc', 5),
  size: seq('ac_sz', 8),
  class: seq('n_oc', 9),
  owner_origin: seq('n_st', 12),
  ag: ['n_ag', 'ag_acres', 'ag_available'],
  improve: ['n_improved', 'n_unimproved', 'n_with_house_number'],
  flow: ['created', 'lot_created', 'persisted', 'owner_changed', 'transfers_out_of_state', 'address_change_only'],
  holdings: ['private_acres', 'large_acres', 'large_owners', 'clo4', 'large_provisional'],
  cama: ['dwellings', 'rated', ...seq('n_cd', 8)],
  owner_state: ['parcels', 'acres', 'private_parcels'],
};
const UNKNOWN_FIELD = { dev: 'development_ladder', improve: 'development_ladder', ag: 'agricultural_acreage' };
const LAYER_MAP = { parcels: 'parcels', townships: 'townships', counties: 'counties',
  roads: 'roads', buildings: 'buildings', reservations: 'reservations', public_lands: 'publiclands', city_limits: 'cities' };

const fail = (m) => { throw new Error(m); };
const countyName = (code) => (code === 0 ? 'Montana' : (S.dim.counties.find((c) => c.code === code)?.name ?? String(code)));
const twpLabel = (id) => { const t = S.twpById.get(id); return t ? `T${t.label.replace(' ', ' R')}` : String(id); };
const unitName = (u, level) => (level === 'county' ? countyName(u) : twpLabel(u));
const dateOf = (s) => S.dim.snapshots[s]?.date ?? null;

/** Stringify, and if the result is too long, drop rows or points until it fits. */
function pack(obj) {
  let json = JSON.stringify(obj);
  if (json.length <= RESULT_CHARS) return json;
  const key = Array.isArray(obj.rows) ? 'rows' : Array.isArray(obj.points) ? 'points' : null;
  if (!key) return json.slice(0, RESULT_CHARS - 20) + '…(truncated)';
  const all = obj[key];
  let n = all.length;
  while (n > 1 && json.length > RESULT_CHARS) {
    n = Math.floor(n * 0.7);
    obj[key] = key === 'points' ? all.slice(-n) : all.slice(0, n);
    obj.notes = [...(obj.notes || []).filter((x) => !/^truncated/.test(x)), `truncated to ${n} of ${all.length} ${key}`];
    json = JSON.stringify(obj);
  }
  return json;
}

/* ---- place data the page holds, plus two files fetched on first use ------ */
let citiesP = null, reservationsP = null;
const cities = () => (citiesP ||= loadJSON('cities.geojson').catch(() => null));
const reservations = () => (reservationsP ||= loadJSON('reservations.geojson').catch(() => null));
async function placeCtx() {
  return { dim: S.dim, counties: S.geo?.counties, townships: S.geo?.townships, cities: await cities(), reservations: await reservations() };
}

function unitsOf(level, list) {
  if (!list || !list.length) return null;
  const out = [];
  for (const v of list) {
    if (level === 'county') { const c = countyCode(v, S.dim); if (!c) fail(`no county with code ${v}`); out.push(c.code); }
    else { const t = townshipFromLabel(v, S.dim); if (!t) fail(`no township with id ${v}`); out.push(t.id); }
  }
  return [...new Set(out)];
}

/* ---- the tools ---------------------------------------------------------- */
async function getDashboardState() {
  return { ok: true, summary: 'Read the dashboard state', state: describeState() };
}

async function configureDashboard(input) {
  const patch = {};
  const notes = [];
  const i = input || {};
  if (i.view != null) patch.view = i.view;
  if (i.snapshot && (i.snapshot.index != null || i.snapshot.date != null)) {
    const r = snapIndex(i.snapshot.index != null ? i.snapshot.index : i.snapshot.date, S.dim);
    if (!r) fail(`no export matches ${JSON.stringify(i.snapshot)}; exports are 0..${S.nSnaps - 1} or dates 2003-12-22 to ${dateOf(S.nSnaps - 1)}`);
    patch.snap = r.index;
    if (r.note) notes.push(r.note);
  }
  if (i.level != null) patch.level = i.level;
  if (i.measure != null) patch.measure = i.measure;
  if (i.selection) {
    const sel = i.selection;
    if (sel.clear) patch.selection = [];
    if (sel.counties && sel.counties.length) { patch.level = 'county'; patch.selection = unitsOf('county', sel.counties); }
    if (sel.townships && sel.townships.length) {
      if (patch.level === 'county') fail('give counties or townships, not both');
      patch.level = 'township'; patch.selection = unitsOf('township', sel.townships);
    }
  }
  if (i.era != null) patch.era = i.era;
  if (i.origin_state != null) {
    const st = stateCode(i.origin_state, S.dim);
    if (st == null) fail(`"${i.origin_state}" is not an owner-origin state in this dataset (two letters, not MT)`);
    patch.originState = st;
  }
  if (i.mask_low_coverage != null) patch.maskLow = !!i.mask_low_coverage;
  if (i.basemap != null) patch.basemap = i.basemap;
  if (i.layers) {
    patch.layers = {};
    for (const [k, v] of Object.entries(i.layers)) if (v != null && LAYER_MAP[k]) patch.layers[LAYER_MAP[k]] = !!v;
  }
  if (i.theme != null) patch.theme = i.theme;
  if (i.map) {
    const m = i.map;
    if (m.fit) {
      if (m.fit === 'statewide') patch.map = null;
      else if (m.fit === 'selection') {
        const level = patch.level || S.level;
        const sel = patch.selection || Array.from(S.selection);
        if (!sel.length) patch.map = null;
        else {
          const feats = level === 'county'
            ? (S.geo?.counties?.features || []).filter((f) => sel.includes(Number(f.properties?.county_n)))
            : (S.geo?.townships?.features || []).filter((f) => sel.includes(S.twpByKey.get(f.properties?.tr_key)?.id));
          const boxes = feats.map((f) => bboxOf(f.geometry)).filter(Boolean);
          if (!boxes.length) fail('the selection has no boundary to fit');
          patch.map = { bbox: [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
            Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))] };
        }
      } else {
        if (m.fit_id == null) fail(`map.fit "${m.fit}" needs fit_id`);
        const r = lookupPlace(String(m.fit_id), m.fit, await placeCtx());
        const c = r.candidates.find((x) => x.kind === m.fit && x.bbox);
        if (!c) fail(`no ${m.fit} matches "${m.fit_id}"`);
        patch.map = { bbox: c.bbox, maxZoom: m.fit === 'county' ? 9.5 : m.fit === 'township' ? 11 : 12.5 };
        notes.push(`map fitted to ${c.name}`);
      }
    } else if (m.center) {
      patch.map = { center: m.center, zoom: m.zoom ?? 10 };
    }
  }
  const r = await applyState(patch, { source: 'assistant' });
  const d = describeState();
  const where = d.selection.statewide ? 'statewide' : d.selection.names.join(', ');
  return { ok: true, summary: `Showed ${d.view.label} · ${where} · ${d.vintage?.date ?? ''}`.trim(),
    state: d, warnings: [...notes, ...r.warnings] };
}

async function lookup(input) {
  const q = String(input?.query ?? '').trim();
  if (!q) fail('query is empty');
  const r = lookupPlace(q, input?.kind || 'any', await placeCtx());
  if (!r.candidates.length) {
    fail(`nothing matches "${q}". Counties are named like "Gallatin" or "GA"; townships like "T2S R6E"; cities by name; reservations by name.`);
  }
  return { ok: true, summary: `Looked up “${q}”: ${r.candidates.map((c) => `${c.name} (${c.kind})`).slice(0, 3).join(', ')}`, ...r };
}

/* ---- read_series --------------------------------------------------------- */
async function readSeries(input) {
  const i = input || {};
  const level = i.level === 'county' ? 'county' : 'township';
  const topic = i.topic;
  if (!TOPIC_DEFAULTS[topic]) fail(`unknown topic "${topic}"`);
  if (topic === 'holdings' && level !== 'county') fail('holdings are published at county level only; use level "county"');
  if (topic === 'owner_state' && level !== 'township') fail('owner_state is published at township level only; use level "township"');
  const units = unitsOf(level, i.units);
  const names = units ? units.map((u) => unitName(u, level)) : ['Montana'];
  const derived = i.derived ? DERIVED[i.derived] : null;
  if (i.derived && !derived) fail(`unknown derived measure "${i.derived}"`);
  if (derived) {
    if (derived.topic !== topic) fail(`${i.derived} is a ${derived.topic} measure; set topic to "${derived.topic}"`);
    if (derived.level === 'county' && level !== 'county') fail(`${i.derived} needs level "county"`);
    if (derived.perUnit && (!units || units.length !== 1)) fail(`${i.derived} is per county: give exactly one county in units`);
  }
  const range = i.snapshots || {};
  const notes = [];
  const meta = { ok: true, level, units: { count: units ? units.length : 0, names, statewide: !units }, topic };

  if (topic === 'cama') {
    const T = await A.camaTables();
    const twpLevel = level === 'township';
    const src = units ? { t: twpLevel ? T.twp : T.cty, m: twpLevel ? T.twpBy : T.ctyBy, u: units } : { t: T.cty, m: T.ctyBy, u: [0] };
    const cols = derived ? derived.columns : (i.measures && i.measures.length ? i.measures : TOPIC_DEFAULTS.cama);
    for (const c of cols) if (!src.t.columns.includes(c)) fail(`"${c}" is not a column of ${twpLevel ? 'cama_township' : 'cama_county'}`);
    const points = [];
    for (const s of T.points) {
      if (range.from != null && s < range.from) continue;
      if (range.to != null && s > range.to) continue;
      const sums = A.camaSum(src.t, src.m.get(s), src.u, cols);
      const pm = A.pointMeta(s);
      const pt = { s, date: dateOf(s), tax_year: pm.tax_year ?? null, rating_field: pm.rating_field ?? null };
      if (derived) pt.value = derived.compute((c) => sums[c] ?? 0, {});
      else pt.values = sums;
      points.push(pt);
    }
    if (units && twpLevel) notes.push('township rows carry the witness tests only at township grain; the fuller set is at county grain');
    return pack({ ...meta, summary: `Read building records${derived ? ` (${i.derived})` : ''} for ${names.join(', ')}`,
      unit: derived ? derived.unit : 'dwellings', definition: derived?.definition ?? null, points, notes });
  }

  if (topic === 'flow') {
    const f = level === 'county' ? await A.countyFlow() : await A.twpFlow();
    const core = level === 'county' ? await A.countyCube() : await A.twpCube('core');
    const cols = derived ? derived.columns : (i.measures && i.measures.length ? i.measures : TOPIC_DEFAULTS.flow);
    for (const c of cols) if (!f.measures.includes(c)) fail(`"${c}" is not a flow column; columns are ${f.measures.join(', ')}`);
    const points = [];
    for (let iv = 0; iv < S.nIv; iv++) {
      if (range.from != null && iv + 1 < range.from) continue;
      if (range.to != null && iv + 1 > range.to) continue;
      const years = S.dim.intervals[iv]?.years || 1;
      const pt = { i: iv, from: dateOf(iv), to: dateOf(iv + 1), years, comparable: sumAt(f, 'comparable', iv, units) > 0 };
      if (derived) pt.value = derived.compute((c) => sumAt(f, c, iv, units), { years, stock: sumAt(core, 'parcels', iv + 1, units) });
      else { pt.values = {}; for (const c of cols) pt.values[c] = sumAt(f, c, iv, units); }
      points.push(pt);
    }
    notes.push('events are inferred between consecutive exports; rates are per year on the interval’s real length');
    return pack({ ...meta, summary: `Read events${derived ? ` (${i.derived})` : ''} for ${names.join(', ')}`,
      unit: derived ? derived.unit : 'parcels per interval', definition: derived?.definition ?? null, points, notes });
  }

  let c, cov, nUnitsAll;
  if (topic === 'holdings') {
    c = await A.holdingsCube();
    cov = null;
  } else if (topic === 'owner_state') {
    const st = stateCode(i.state, S.dim);
    if (!st) fail('owner_state needs state: a two-letter owner-origin state (not MT)');
    const t = await loadTable(`owner_state/${st}`);
    c = cube(t, { nUnits: S.nTwp + 1, nSnaps: S.nSnaps, delta: false });
    cov = await A.twpCube('core');
    meta.state = st;
  } else {
    c = level === 'county' ? await A.countyCube() : await A.twpCube(topic);
    cov = level === 'county' ? c : await A.twpCube('core');
  }
  const hu = topic === 'holdings' ? (units || [0]) : units;
  const cols = derived ? derived.columns : (i.measures && i.measures.length ? i.measures : TOPIC_DEFAULTS[topic]);
  if (cols.length > 12) fail('at most 12 measures per call');
  for (const col of cols) if (!c.measures.includes(col)) fail(`"${col}" is not a column here; columns are ${c.measures.join(', ')}`);
  nUnitsAll = level === 'county' ? S.dim.counties.length : S.nTwp;
  const points = [];
  for (let s = 0; s < S.nSnaps; s++) {
    if (range.from != null && s < range.from) continue;
    if (range.to != null && s > range.to) continue;
    const pt = { s, date: dateOf(s) };
    if (cov) {
      pt.covered_units = sumAt(cov, 'coverage_ok', s, units);
      pt.n_units = units ? units.length : nUnitsAll;
    }
    const uf = UNKNOWN_FIELD[topic];
    pt.unknown = !!(uf && unavailableAt(s).includes(uf));
    if (derived) pt.value = pt.unknown ? null : derived.compute((col) => sumAt(c, col, s, hu), {});
    else { pt.values = {}; for (const col of cols) pt.values[col] = sumAt(c, col, s, hu); }
    points.push(pt);
  }
  if (cov) notes.push('covered_units counts the selected units whose record is complete in that export; a unit not covered contributes zero, not a measurement');
  if (UNKNOWN_FIELD[topic]) notes.push('unknown = the export carries no values for this field (2009-07-05): not zero');
  if (topic === 'holdings' && !units) notes.push('statewide holdings row (county 0)');
  return pack({ ...meta, summary: `Read ${topic}${derived ? ` (${i.derived})` : ''} for ${names.join(', ')}`,
    unit: derived ? derived.unit : (cols.some((x) => x.startsWith('ac') || x.includes('acres')) ? 'parcels and acres' : 'parcels'),
    definition: derived?.definition ?? null, points, notes });
}

/* ---- read_table ---------------------------------------------------------- */
function decoders() {
  const L = S.dim.labels || {};
  const lab = (list) => (v) => (v == null || v < 0 ? 'unknown' : (list[v] ?? v));
  const date = (v) => (v == null || v < 0 ? 'unknown' : (dateOf(v) ?? v));
  const interval = (v) => (v == null || v < 0 ? 'unknown' : `${dateOf(v)}→${dateOf(v + 1)}`);
  return {
    county_n: (v) => (v == null || v < 0 ? 'unknown' : countyName(v)),
    s: date, cohort: date, observed: date, s_from: date,
    i: interval, interval,
    review_status: lab(L.review_status || []), cond: lab(L.condition || []), yb_bin: lab(L.year_built || []),
    dev_stage: lab(L.dev_stage || []), ten: lab(L.tenure || []),
    st: (v) => (v == null || v < 0 ? 'unknown' : (S.dim.states[v] ?? v)),
    r: (v) => (v == null || v < 0 ? 'unknown' : (S.dim.reservations[v] ?? v)),
  };
}

async function readTable(input, ctx) {
  const i = input || {};
  const name = i.table;
  if (!name || /[^a-z_0-9]/.test(name)) fail('table must be one of the published tables');
  let t;
  try { t = await loadTable(name); } catch (err) { fail(`table ${name} could not be read: ${err.message}`); }
  const deny = new Set(DENY_ALWAYS);
  if ((ctx?.names || 'never') === 'never') for (const c of NAME_COLS) deny.add(c);
  let r;
  try { r = runQuery(t, i, { deny, decoders: decoders() }); }
  catch (err) { if (err instanceof QueryError) fail(err.message); throw err; }
  const notes = [...r.notes];
  if (name === 'holdings_top') notes.push('owner names are not available; refer to a holding by rank and size');
  if (name === 'cama_county' || name === 'cama_township') notes.push('s is one of the eight building-record points');
  return pack({ ok: true, summary: `Queried ${name}: ${r.total} row${r.total === 1 ? '' : 's'}`, table: name,
    columns: r.columns, rows: r.rows, total: r.total, truncated: r.truncated, notes });
}

/* ---- compose_report ------------------------------------------------------ */
async function composeReport(input) {
  const i = input || {};
  if (!REPORT_KINDS.includes(i.kind)) fail(`kind must be one of ${REPORT_KINDS.join(', ')}`);
  const report = { kind: i.kind, generated: true };
  if (i.kind === 'profile' || i.kind === 'condition') {
    if (i.county == null) fail(`the ${i.kind} report needs a county code`);
    const c = countyCode(i.county, S.dim);
    if (!c) fail(`no county with code ${i.county}`);
    report.county = c.code;
  } else if (i.kind === 'worksheet') {
    if (i.county != null) { const c = countyCode(i.county, S.dim); if (!c) fail(`no county with code ${i.county}`); report.county = c.code; } else report.county = null;
  } else if (i.kind === 'activity') {
    if (i.from == null || i.to == null) fail('the activity report needs from and to export indexes');
    if (!(Number(i.from) < Number(i.to))) fail('from must be an earlier export than to');
    report.a = Number(i.from); report.b = Number(i.to);
  }
  const r = await applyState({ view: 'reports', report }, { source: 'assistant' });
  const out = S.reportOut;
  if (!out) fail('the report did not compose: ' + (document.getElementById('rpt-status')?.textContent || 'unknown reason'));
  const host = document.getElementById('report');
  const sections = host ? [...host.querySelectorAll('.rsec > h2')].map((h) => h.textContent.trim()).slice(0, 24) : [];
  const tiles = host ? [...host.querySelectorAll('.stat')].slice(0, 40).map((el) => ({
    label: el.querySelector('.k')?.textContent.trim() ?? '', value: el.querySelector('.v')?.textContent.trim() ?? '' })) : [];
  return pack({ ok: true, summary: `Composed “${out.title}”`, title: out.title, csv_rows: out.rows ?? null, sections, tiles,
    warnings: r.warnings, notes: ['The user can save it with the Save as PDF button on the Reports view.'] });
}

const EXECUTORS = {
  get_dashboard_state: getDashboardState,
  configure_dashboard: configureDashboard,
  lookup_place: lookup,
  read_series: readSeries,
  read_table: readTable,
  compose_report: composeReport,
};

/**
 * Run one tool call. Resolves to a string for the tool_result; throws with
 * a message meant for the model. ctx: { names }.
 */
export async function execute(name, input, ctx = {}) {
  const fn = EXECUTORS[name];
  if (!fn) fail(`unknown tool ${name}`);
  const out = await fn(input, ctx);
  return typeof out === 'string' ? out : pack(out);
}

export { getState };
