/* ---------------------------------------------------------------------------
   state.js -- the one dashboard state, its URL form, and the one way to
   change it.

   Every control the reader has -- the view, the vintage, the unit level, the
   selection, the filters, the layers, the basemap, the camera, the theme and
   the report form -- is a field of S, and every change goes through
   applyState(): it validates the patch, syncs the map and the DOM controls,
   renders once, writes the URL hash and tells subscribers. The nav buttons
   and the filter row are one driver of that function; a pasted link is
   another; the assistant is a third. None of them knows privately how a
   change takes effect, which is what made the earlier arrangement -- fourteen
   listeners each mutating the object and the map in its own way, with the
   era filter living only in a <select> -- impossible to drive from outside.

   The pure parts (normalize, toHash, fromHash) take the state and `dim` as
   arguments and touch no DOM, so node can test them. The module imports
   nothing: app.js registers its render function and view registry through
   bindHost() at boot, which keeps the import graph acyclic.
--------------------------------------------------------------------------- */

export const VIEW_KEYS = ['ladder', 'growth', 'condition', 'ownership', 'fragmentation', 'churn', 'thresholds',
  'holdings', 'review', 'reports', 'about'];
/** The paper's unit is the county, so these two views only ever show counties. */
export const COUNTY_ONLY = new Set(['holdings', 'review']);
/** Prose and paper: the map and filters step aside. */
export const FULL_VIEWS = new Set(['reports', 'about']);
export const LEVELS = ['township', 'county'];
export const MEASURES = ['parcels', 'acres'];
export const ERAS = ['all', 'early', 'mid', 'late'];
/** Interval-index bounds [from, to) behind the Thresholds era filter; the
 *  <select> in index.astro names the years they correspond to. */
export const ERA_BOUNDS = { all: [0, 99], early: [0, 11], mid: [11, 20], late: [20, 28] };
export const BASEMAPS = ['none', 'montana', 'positron'];
export const THEMES = ['light', 'dark'];
export const REPORT_KINDS = ['profile', 'condition', 'trends', 'holdings', 'worksheet', 'activity'];
export const LAYER_KEYS = ['parcels', 'townships', 'counties', 'roads', 'buildings',
  'reservations', 'publiclands', 'cities'];
export const LAYER_DEFAULTS = Object.freeze({ parcels: true, townships: true, counties: true,
  roads: true, buildings: true, reservations: false, publiclands: false, cities: false });
/** Checkbox ids in index.astro, by layer key. */
export const LAYER_IDS = { parcels: 'lyr-parcels', townships: 'lyr-townships',
  counties: 'lyr-counties', roads: 'lyr-roads', buildings: 'lyr-buildings', reservations: 'lyr-reservations',
  publiclands: 'lyr-publiclands', cities: 'lyr-cities' };
const LAYER_CODES = { parcels: 'par', townships: 'twp', counties: 'cty', roads: 'rd',
  buildings: 'bld', reservations: 'res', publiclands: 'pl', cities: 'city' };
const OVERLAYS = { reservations: ['reservations.geojson', 'reservations'],
  publiclands: ['publiclands.geojson', 'public lands'], cities: ['cities.geojson', 'city limits'] };
/** Montana, generously, and the map's own zoom range (map.js). */
export const MT_LON = [-117, -103];
export const MT_LAT = [44, 49.5];
export const ZOOM_RANGE = [4, 15];
/** Which filter controls a view uses; the rest are hidden or disabled. */
export const VIEW_CONTROLS = {
  era: (v) => v === 'thresholds',
  origin: (v) => v === 'ownership',
  levelLocked: (v) => COUNTY_ONLY.has(v),
  measureOff: (v) => v === 'condition' || v === 'growth',
};
const CONDITION_TIME_TITLE = 'Building records exist at eight vintages (tax years 2014, 2015-2018, 2024-2026); '
  + 'the slider shows the nearest earlier one.';
/** Fields whose change needs the view re-rendered. The camera, the basemap
 *  and the reference layers are the map's own business. */
const RENDER_KEYS = new Set(['view', 'snap', 'level', 'measure', 'selection', 'era', 'originState', 'maskLow', 'theme']);
const STATE_KEYS = new Set(['view', 'snap', 'level', 'measure', 'selection', 'era', 'originState', 'maskLow',
  'basemap', 'layers', 'map', 'theme', 'report', 'parcel']);

export const FIELD_LABEL = {
  development_ladder: 'development ladder',
  agricultural_acreage: 'agricultural acreage',
};

/* ------------------------------------------------------------- the object */
/** The live state. The first block is the state proper (what the URL
 *  carries); the rest is runtime: the dimension tables, the map, caches. */
export const S = {
  view: 'ladder', snap: 0, level: 'township', measure: 'parcels',
  selection: new Set(), era: 'all', originState: '', maskLow: true,
  basemap: 'none', layers: { ...LAYER_DEFAULTS }, mapView: null, theme: null,
  // The Reports view: which document, for which county or period, and
  // whether one has been composed (so a re-render redraws it).
  report: { kind: 'profile', county: 6, a: 0, b: 0, generated: false },
  parcel: '',

  dim: null, meta: null, map: null, geo: null,
  twpByKey: new Map(), twpById: new Map(),
  cubes: {}, flows: {}, nSnaps: 0, nTwp: 0, nIv: 0,
  reportGen: 0, reportOut: null,
  unitLegendHTML: '', renders: 0,
};

/** A plain, serialisable copy of the state proper. */
export function getState() {
  const mv = S.mapView;
  return {
    view: S.view, snap: S.snap, level: S.level, measure: S.measure,
    selection: Array.from(S.selection), era: S.era, originState: S.originState, maskLow: S.maskLow,
    basemap: S.basemap, layers: { ...S.layers },
    map: mv?.center ? { center: [mv.center[0], mv.center[1]], zoom: mv.zoom }
      : mv?.bbox ? { bbox: [...mv.bbox] } : null,
    theme: S.theme, report: { ...S.report }, parcel: S.parcel,
  };
}

/** The report form's defaults: Gallatin, the last five years or so. */
export function defaultReport(dim) {
  const n = dim?.snapshots?.length || 0;
  return { kind: 'profile', county: 6, a: Math.max(0, n - 6), b: Math.max(0, n - 1), generated: false };
}

/** Fields this vintage cannot report, from meta.field_availability. */
export function unavailableAt(snap) {
  const rec = (S.meta?.field_availability || []).find((r) => r.snapshot === snap);
  return rec ? rec.unavailable : [];
}

/** A unit id (township id or county code) to the map's feature id. */
export function unitFeatureId(u) {
  return S.level === 'county' ? u : (S.twpById.get(u)?.tr ?? null);
}

/* ---------------------------------------------------------------- normalize */
const isInt = (v) => Number.isInteger(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function validUnits(list, level, dim, warn) {
  const out = [];
  const seen = new Set();
  let dropped = 0;
  const codes = level === 'county' ? new Set((dim?.counties || []).map((c) => c.code)) : null;
  const nTwp = dim?.townships?.length || 0;
  const byTr = level === 'township' ? new Map((dim?.townships || []).map((t) => [t.tr, t.id])) : null;
  for (let v of list) {
    if (level === 'township' && typeof v === 'string' && byTr.has(v)) v = byTr.get(v);
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    const ok = isInt(n) && (level === 'county' ? codes.has(n) : (n >= 0 && n < nTwp));
    if (!ok) { dropped++; continue; }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (dropped) warn(`${dropped} selection id${dropped > 1 ? 's' : ''} not valid at the ${level} level dropped`);
  return out;
}

/**
 * Validate and complete a patch against the previous state. Pure.
 * Returns { next, warnings, changed } where `changed` is the set of top-level
 * fields whose value differs from `prev`.
 */
export function normalize(patch, prev, dim) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const p = patch && typeof patch === 'object' ? patch : {};
  const nSnaps = dim?.snapshots?.length || 0;
  const next = {
    ...prev, layers: { ...prev.layers }, report: { ...prev.report },
    selection: [...prev.selection], map: prev.map ? { ...prev.map } : null,
  };
  for (const k of Object.keys(p)) if (!STATE_KEYS.has(k)) warn(`unknown state field "${k}" ignored`);

  if (p.view !== undefined) {
    if (VIEW_KEYS.includes(p.view)) next.view = p.view; else warn(`unknown view "${p.view}"`);
  }
  if (p.snap !== undefined) {
    const n = Number(p.snap);
    if (isInt(n) && nSnaps) {
      next.snap = clamp(n, 0, nSnaps - 1);
      if (next.snap !== n) warn(`snapshot ${n} is outside 0..${nSnaps - 1}; using ${next.snap}`);
    } else warn(`snapshot must be an index 0..${Math.max(0, nSnaps - 1)}`);
  }
  if (p.level !== undefined) {
    if (LEVELS.includes(p.level)) next.level = p.level; else warn(`unknown level "${p.level}"`);
  }
  if (COUNTY_ONLY.has(next.view) && next.level !== 'county') {
    next.level = 'county';
    warn('level set to county: the Holdings and Review views are county-level');
  }
  if (p.measure !== undefined) {
    if (MEASURES.includes(p.measure)) next.measure = p.measure; else warn(`unknown measure "${p.measure}"`);
  }
  const levelChanged = next.level !== prev.level;
  if (p.selection !== undefined) {
    if (Array.isArray(p.selection)) next.selection = validUnits(p.selection, next.level, dim, warn);
    else warn('selection must be an array of unit ids');
  } else if (levelChanged) {
    next.selection = [];
  }
  if (p.era !== undefined) {
    if (ERAS.includes(p.era)) next.era = p.era; else warn(`unknown era "${p.era}"`);
  }
  if (p.originState !== undefined) {
    const v = p.originState == null ? '' : String(p.originState).toUpperCase();
    const known = (dim?.states || []);
    if (v === '' || (v.length === 2 && v !== 'MT' && known.includes(v))) next.originState = v;
    else warn(`"${p.originState}" is not an owner-origin state in this dataset`);
  }
  if (p.maskLow !== undefined) {
    if (typeof p.maskLow === 'boolean') next.maskLow = p.maskLow; else warn('maskLow must be true or false');
  }
  if (p.basemap !== undefined) {
    if (BASEMAPS.includes(p.basemap)) next.basemap = p.basemap; else warn(`unknown basemap "${p.basemap}"`);
  }
  if (p.layers !== undefined) {
    if (p.layers && typeof p.layers === 'object') {
      for (const [k, v] of Object.entries(p.layers)) {
        if (!LAYER_KEYS.includes(k)) { warn(`unknown layer "${k}"`); continue; }
        if (typeof v === 'boolean') next.layers[k] = v; else warn(`layer ${k} must be true or false`);
      }
    } else warn('layers must be an object of booleans');
  }
  if (p.map !== undefined) {
    const m = p.map;
    if (m === null) next.map = null;
    else if (m && Array.isArray(m.bbox) && m.bbox.length === 4 && m.bbox.every(Number.isFinite)) {
      const [w, s, e, n] = m.bbox.map(Number);
      if (w < e && s < n) next.map = { bbox: [w, s, e, n] }; else warn('map.bbox must be [west, south, east, north]');
    } else if (m && Array.isArray(m.center) && m.center.length === 2 && m.center.every(Number.isFinite)) {
      const lon = clamp(Number(m.center[0]), MT_LON[0], MT_LON[1]);
      const lat = clamp(Number(m.center[1]), MT_LAT[0], MT_LAT[1]);
      const zoom = Number.isFinite(Number(m.zoom)) ? clamp(Number(m.zoom), ZOOM_RANGE[0], ZOOM_RANGE[1]) : (prev.map?.zoom ?? 6);
      if (lon !== Number(m.center[0]) || lat !== Number(m.center[1])) warn('map centre clamped to Montana');
      next.map = { center: [lon, lat], zoom };
    } else warn('map must be null, {center:[lon,lat], zoom} or {bbox:[w,s,e,n]}');
  }
  if (p.theme !== undefined) {
    const t = p.theme === 'system' ? null : p.theme;
    if (t === null || THEMES.includes(t)) next.theme = t; else warn(`unknown theme "${p.theme}"`);
  }
  if (p.report !== undefined) {
    const r = p.report;
    if (r && typeof r === 'object') {
      if (r.kind !== undefined) {
        if (REPORT_KINDS.includes(r.kind)) next.report.kind = r.kind; else warn(`unknown report "${r.kind}"`);
      }
      if (r.county !== undefined) {
        const c = r.county === null || r.county === '' || r.county === 0 ? null : Number(r.county);
        const codes = new Set((dim?.counties || []).map((x) => x.code));
        if (c === null || codes.has(c)) next.report.county = c; else warn(`unknown county code ${r.county}`);
      }
      for (const k of ['a', 'b']) {
        if (r[k] === undefined) continue;
        const n = Number(r[k]);
        if (isInt(n) && nSnaps) next.report[k] = clamp(n, 0, nSnaps - 1); else warn(`report.${k} must be a snapshot index`);
      }
      if (r.generated !== undefined) next.report.generated = !!r.generated;
      if (next.report.kind === 'activity' && !(next.report.a < next.report.b)) {
        warn('the activity report needs a period from an earlier vintage to a later one');
      }
    } else warn('report must be an object');
  }
  if (p.parcel !== undefined) next.parcel = p.parcel == null ? '' : String(p.parcel);

  const changed = new Set();
  for (const k of STATE_KEYS) if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)) changed.add(k);
  return { next, warnings, changed };
}

/* ------------------------------------------------------------------- hash */
const enc = (v) => encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3A/gi, ':');

/** The state as a URL fragment (without the '#'); defaults are omitted, so
 *  the home state is an empty string. Townships are written as their PLSS
 *  key (stable across publishes), counties as their code. The theme is
 *  deliberately not carried: it is the viewer's preference, not the view. */
export function toHash(state, dim) {
  const q = [];
  const nSnaps = dim?.snapshots?.length || 0;
  if (state.view !== 'ladder') q.push(['v', state.view]);
  if (nSnaps && state.snap !== nSnaps - 1) q.push(['s', String(state.snap)]);
  if (state.level !== 'township') q.push(['l', 'c']);
  if (state.measure !== 'parcels') q.push(['m', 'a']);
  if (state.selection.length) {
    const ids = state.selection.map((u) => (state.level === 'county' ? String(u) : (dim?.townships?.[u]?.tr ?? '')))
      .filter(Boolean);
    if (ids.length) q.push(['u', ids.join(',')]);
  }
  if (state.era !== 'all') q.push(['e', state.era]);
  if (state.originState) q.push(['o', state.originState]);
  if (!state.maskLow) q.push(['mask', '0']);
  if (state.basemap !== 'none') q.push(['b', state.basemap]);
  const on = LAYER_KEYS.filter((k) => state.layers[k]).map((k) => LAYER_CODES[k]).join(',');
  const onDefault = LAYER_KEYS.filter((k) => LAYER_DEFAULTS[k]).map((k) => LAYER_CODES[k]).join(',');
  if (on !== onDefault) q.push(['ly', on || '-']);
  if (state.map?.center) {
    q.push(['c', `${state.map.center[0].toFixed(4)},${state.map.center[1].toFixed(4)},${Number(state.map.zoom).toFixed(2)}`]);
  }
  const r = state.report, d = defaultReport(dim);
  if (r.kind !== d.kind || (r.county ?? 0) !== (d.county ?? 0) || r.a !== d.a || r.b !== d.b || r.generated) {
    q.push(['r', `${r.kind}:${r.county ?? ''}:${r.a}:${r.b}:${r.generated ? 1 : 0}`]);
  }
  return q.map(([k, v]) => `${k}=${enc(v)}`).join('&');
}

/** A URL fragment to a patch for applyState. Lenient: unknown keys are
 *  ignored and bad values dropped, each with a warning. */
export function fromHash(hash, dim) {
  const h = String(hash || '').replace(/^#/, '');
  const patch = {}, warnings = [];
  if (!h) return { patch, warnings };
  let q;
  try { q = new URLSearchParams(h); } catch { return { patch, warnings: ['unreadable fragment'] }; }
  if (q.has('v')) patch.view = q.get('v');
  if (q.has('s')) patch.snap = Number(q.get('s'));
  if (q.has('l')) patch.level = { c: 'county', t: 'township' }[q.get('l')] || q.get('l');
  if (q.has('m')) patch.measure = { a: 'acres', p: 'parcels' }[q.get('m')] || q.get('m');
  if (q.has('u')) {
    const level = patch.level || 'township';
    const items = q.get('u').split(',').map((x) => x.trim()).filter(Boolean);
    if (level === 'county') patch.selection = items.map(Number);
    else {
      const byTr = new Map((dim?.townships || []).map((t) => [t.tr, t.id]));
      patch.selection = [];
      for (const it of items) {
        if (byTr.has(it)) patch.selection.push(byTr.get(it));
        else warnings.push(`township ${it} not in this publish`);
      }
    }
  }
  if (q.has('e')) patch.era = q.get('e');
  if (q.has('o')) patch.originState = q.get('o').toUpperCase();
  if (q.has('mask')) patch.maskLow = q.get('mask') !== '0';
  if (q.has('b')) patch.basemap = q.get('b');
  if (q.has('ly')) {
    const codes = q.get('ly') === '-' ? [] : q.get('ly').split(',').filter(Boolean);
    const known = new Set(Object.values(LAYER_CODES));
    for (const c of codes) if (!known.has(c)) warnings.push(`unknown layer code "${c}"`);
    patch.layers = Object.fromEntries(LAYER_KEYS.map((k) => [k, codes.includes(LAYER_CODES[k])]));
  }
  if (q.has('c')) {
    const [lon, lat, z] = q.get('c').split(',').map(Number);
    if ([lon, lat, z].every(Number.isFinite)) patch.map = { center: [lon, lat], zoom: z };
    else warnings.push('map position must be lon,lat,zoom');
  }
  if (q.has('r')) {
    const [kind, county, a, b, g] = q.get('r').split(':');
    patch.report = { kind, county: county ? Number(county) : null, a: Number(a), b: Number(b), generated: g === '1' };
  }
  return { patch, warnings };
}

/* ------------------------------------------------------------ description */
const VIEW_CAVEATS = {
  ladder: [/development ladder is probabilistic/i, /2009-07-05/],
  condition: [/condition and year built/i],
  ownership: [/MAILING ADDRESS/, /public-domain status/i, /reservation boundary/i],
  fragmentation: [/2009-07-05/],
  churn: [/events are inferred/i],
  thresholds: [/events are inferred/i],
  holdings: [/Haggerty/],
  review: [/Haggerty/],
};
function caveatsFor(view, meta) {
  const pats = VIEW_CAVEATS[view] || [];
  const out = [];
  for (const c of meta?.caveats || []) if (pats.some((p) => p.test(c))) out.push(c);
  return out.slice(0, 3);
}
function unitName(u, level) {
  if (level === 'county') return S.dim?.counties?.find((c) => c.code === u)?.name ?? String(u);
  const t = S.twpById.get(u);
  return t ? `T${t.label.replace(' ', ' R')}` : String(u);
}
function countyName(code) {
  return code === 0 ? 'Montana' : (S.dim?.counties?.find((c) => c.code === code)?.name ?? String(code));
}

/** What the dashboard shows, in words: names rather than ids, dates rather
 *  than indexes. This is what the assistant reads. */
export function describeState() {
  const st = getState();
  const dim = S.dim, meta = S.meta;
  const info = host.viewInfo ? host.viewInfo(st.view) || {} : {};
  const sn = dim?.snapshots?.[st.snap];
  const view = S.map && typeof S.map.getView === 'function' ? S.map.getView() : null;
  const report = st.view === 'reports' ? {
    kind: st.report.kind, county: st.report.county, county_name: st.report.county ? countyName(st.report.county) : null,
    from: st.report.a, from_date: dim?.snapshots?.[st.report.a]?.date ?? null,
    to: st.report.b, to_date: dim?.snapshots?.[st.report.b]?.date ?? null,
    generated: st.report.generated, title: S.reportOut?.title ?? null,
  } : null;
  return {
    view: { key: st.view, label: info.label || st.view, map_shows: info.legend || '', summary: info.summary || '',
      full_page: FULL_VIEWS.has(st.view) },
    vintage: sn ? { index: st.snap, date: sn.date, era: sn.era ?? null, unavailable: unavailableAt(st.snap) } : null,
    level: st.level, measure: st.measure, measure_applies: !VIEW_CONTROLS.measureOff(st.view),
    selection: {
      count: st.selection.length, statewide: st.selection.length === 0,
      names: st.selection.slice(0, 12).map((u) => unitName(u, st.level)),
      ids: st.selection.slice(0, 12), truncated: st.selection.length > 12,
    },
    filters: {
      era: VIEW_CONTROLS.era(st.view) ? st.era : null,
      origin_state: VIEW_CONTROLS.origin(st.view) ? (st.originState || 'all') : null,
      mask_low_coverage: st.maskLow,
    },
    map: {
      basemap: st.basemap, center: view?.center ?? null, zoom: view?.zoom ?? null, bbox: view?.bbox ?? null,
      parcel_scale: !!(view && view.zoom >= 10.5 && st.layers.parcels),
      layers_on: LAYER_KEYS.filter((k) => st.layers[k]),
    },
    theme: st.theme || 'system',
    report,
    caveats: caveatsFor(st.view, meta),
  };
}

/* ------------------------------------------------------------------- host */
const host = { render: null, viewInfo: null, refreshLegend: null };
const subscribers = new Set();

/** app.js registers what state.js may call: the renderer, the view
 *  registry's labels, and the legend refresh. */
export function bindHost(h) { Object.assign(host, h); }

/** The page's frame changed size (the assistant docked or undocked): tell the
    map its new size and redraw the view, because the charts are drawn to the
    width their container has at render time. No state changes. */
export async function relayout() {
  await nextFrame();
  await nextFrame();   // the class change has been laid out by the second frame
  if (S.map && S.map.map) S.map.map.resize();
  if (host.render) await host.render();
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/* ---------------------------------------------------------------- DOM sync */
const doc = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));
const setValue = (id, v) => { const el = doc(id); if (el && el.value !== String(v)) el.value = String(v); };
const setChecked = (id, v) => { const el = doc(id); if (el) el.checked = !!v; };
const show = (id, on) => { const el = doc(id); if (el) el.hidden = !on; };
const disable = (id, on) => { const el = doc(id); if (el) el.disabled = !!on; };
const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(r) : setTimeout(r, 0)));

/** The date under the slider, with the warning mark when the vintage's
 *  export cannot report a field. Called on every drag, so it reads the
 *  snapshot it is given rather than the committed state. */
export function syncSnapLabel(snap) {
  const el = doc('snaplabel');
  if (!el || !S.dim) return;
  const d = S.dim.snapshots[snap]?.date || '';
  const gone = unavailableAt(snap);
  el.textContent = d;
  el.title = gone.length
    ? `${d}: this export ships ${gone.map((g) => FIELD_LABEL[g] || g).join(' and ')} `
      + 'entirely zero, so those measures are unknown here.'
    : d;
  const mark = doc('snapwarn');
  if (mark) { mark.hidden = !gone.length; mark.title = el.title; }
}

/** Every control reflects the state. Idempotent; dispatches no events. */
export function syncControls() {
  if (typeof document === 'undefined') return;
  const nav = doc('nav');
  if (nav) {
    let current = null;
    for (const b of nav.children) {
      const on = b.dataset.view === S.view;
      b.setAttribute('aria-checked', String(on));
      b.setAttribute('aria-selected', String(on));
      if (on) current = b.querySelector('.vi-t')?.textContent || b.textContent;
    }
    // The menu button names the view on screen; About has its own button.
    const cur = doc('views-current');
    if (cur) cur.textContent = current || 'Choose';
    const vb = doc('views-btn');
    if (vb) vb.classList.toggle('hbtn-strong', !!current);
    // Reports and About have their own buttons, pressed while showing.
    for (const [id, v] of [['reports-btn', 'reports'], ['about-btn', 'about']]) {
      const b = doc(id);
      if (b) b.setAttribute('aria-pressed', String(S.view === v));
    }
  }
  show('erawrap', VIEW_CONTROLS.era(S.view));
  show('originwrap', VIEW_CONTROLS.origin(S.view));
  disable('level', VIEW_CONTROLS.levelLocked(S.view));
  disable('measure', VIEW_CONTROLS.measureOff(S.view));
  const tw = doc('timewrap');
  if (tw) tw.title = S.view === 'condition' ? CONDITION_TIME_TITLE : '';
  document.body.classList.toggle('full', FULL_VIEWS.has(S.view));
  const slider = doc('snap');
  if (slider) { slider.max = String(Math.max(0, S.nSnaps - 1)); slider.value = String(S.snap); }
  syncSnapLabel(S.snap);
  setValue('level', S.level);
  setValue('measure', S.measure);
  setValue('era', S.era);
  setValue('origin', S.originState);
  setValue('basemap', S.basemap);
  setChecked('mask', S.maskLow);
  for (const k of LAYER_KEYS) setChecked(LAYER_IDS[k], S.layers[k]);
  const root = document.documentElement;
  if (S.theme) root.setAttribute('data-theme', S.theme); else root.removeAttribute('data-theme');
}

/** Rewrite the fragment to the current state (replaceState: no history
 *  entry, no hashchange event). */
export function writeHash() {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const h = toHash(getState(), S.dim);
  const want = h ? `#${h}` : '';
  if (location.hash === want) return;
  history.replaceState(null, '', want || location.pathname + location.search);
}

async function syncLayers(prevLayers, warnings) {
  const m = S.map;
  if (!m) return;
  const setVis = (id, on) => { if (m.map.getLayer(id)) m.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
  for (const k of LAYER_KEYS) {
    if (prevLayers[k] === S.layers[k]) continue;
    const on = S.layers[k];
    switch (k) {
      case 'parcels': m.setParcelsVisible(on); break;
      case 'townships': setVis('township-line', on); break;
      case 'counties': setVis('county-line', on); break;
      case 'roads': case 'buildings': m.setReference(k, on); break;
      default: {
        const [file, label] = OVERLAYS[k];
        if (!on) { m.setOverlay(k, false); break; }
        const status = doc('lyr-status');
        if (status) status.textContent = `loading ${label}…`;
        try {
          await m.addOverlay(k, `data/${file}`);
          m.setOverlay(k, true);
          if (status) status.textContent = '';
        } catch (err) {
          S.layers[k] = false;
          warnings.push(`${label} unavailable`);
          if (status) status.textContent = `${label} unavailable`;
        }
      }
    }
  }
}

/* -------------------------------------------------------------- applyState */
let queue = Promise.resolve();

/**
 * Change the dashboard. Validates the patch, writes the state, syncs the
 * map and the controls, renders once if a rendered field changed, rewrites
 * the URL and notifies subscribers. Calls are serialised, so a fast sequence
 * of changes applies in order. Resolves to { state, warnings, changed }.
 *
 * Options: source ('user' | 'hash' | 'assistant'), render (false to skip the
 * view), hash (false to leave the URL), force (render even if nothing changed).
 */
export function applyState(patch, opts = {}) {
  const run = () => apply(patch, opts).catch((err) => { console.error('applyState', err); throw err; });
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function apply(patch, { source = 'user', render = true, hash = true, force = false } = {}) {
  const prev = getState();
  const { next, warnings, changed } = normalize(patch, prev, S.dim);

  S.view = next.view; S.snap = next.snap; S.level = next.level; S.measure = next.measure;
  S.selection.clear();
  for (const u of next.selection) S.selection.add(u);
  S.era = next.era; S.originState = next.originState; S.maskLow = next.maskLow;
  S.basemap = next.basemap; S.layers = { ...next.layers }; S.theme = next.theme;
  S.report = { ...next.report }; S.parcel = next.parcel;
  if (changed.has('map')) S.mapView = next.map;

  const m = S.map;
  if (m) {
    if (changed.has('basemap')) {
      await m.setBasemap(S.basemap);
      const actual = typeof m.getBasemap === 'function' ? m.getBasemap() : S.basemap;
      if (actual !== S.basemap) { warnings.push(`basemap "${S.basemap}" unavailable; outlines only`); S.basemap = actual; }
    }
    if (changed.has('layers')) await syncLayers(prev.layers, warnings);
    if (changed.has('level')) m.setLevel(S.level);
    if (changed.has('level') || changed.has('selection')) {
      m.setSelection(new Set(Array.from(S.selection, unitFeatureId).filter((x) => x != null)));
    }
    if (changed.has('theme')) {
      const root = document.documentElement;
      if (S.theme) root.setAttribute('data-theme', S.theme); else root.removeAttribute('data-theme');
      m.retheme();
    }
    if (changed.has('map') && typeof m.setView === 'function') {
      const v = await m.setView(S.mapView);
      if (v?.center) S.mapView = { center: v.center, zoom: v.zoom };
    }
  }

  syncControls();
  if (changed.has('view') && m) {
    // The map is told its size again when it comes back from a full-page view.
    await nextFrame();
    m.map.resize();
  }
  if (changed.has('layers') && prev.layers.parcels !== S.layers.parcels) {
    if (host.refreshLegend) host.refreshLegend();
  }
  const needsRender = force || [...changed].some((k) => RENDER_KEYS.has(k));
  if (render && needsRender && host.render) await host.render();
  if (hash && source !== 'hash') writeHash();

  const after = getState();
  for (const fn of subscribers) {
    try { fn({ before: prev, after, changed: [...changed], warnings, source }); } catch (err) { console.error(err); }
  }
  return { state: after, warnings, changed: [...changed] };
}
