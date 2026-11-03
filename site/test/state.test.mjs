/* The pure parts of state.js: validation, the URL form, the description.
   Run with `npm run test:unit` (node --test). No DOM, no map. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  S, getState, normalize, toHash, fromHash, applyState, describeState, bindHost, subscribe,
  defaultReport, LAYER_DEFAULTS, VIEW_KEYS,
} from '../src/lib/state.js';

const dim = {
  snapshots: Array.from({ length: 29 }, (_, i) => ({ id: i, date: `${2003 + i}-01-01`, era: i < 18 ? 'A' : 'B' })),
  intervals: Array.from({ length: 28 }, (_, i) => ({ id: i, a: i, b: i + 1, days: 300, years: 0.82 })),
  counties: [{ code: 1, name: 'Silver Bow', abbr: 'SB' }, { code: 6, name: 'Gallatin', abbr: 'GA' },
    { code: 31, name: 'Park', abbr: 'PA' }],
  townships: [
    { id: 0, tr: '001.0N001.0E', label: '1N 1E', km2: 94 }, { id: 1, tr: '001.0N001.0W', label: '1N 1W', km2: 94 },
    { id: 2, tr: '002.0S006.0E', label: '2S 6E', km2: 93 }, { id: 3, tr: '003.0N010.0E', label: '3N 10E', km2: 93 },
    { id: 4, tr: '010.0S015.0W', label: '10S 15W', km2: 93 },
  ],
  states: ['00', 'CA', 'MT', 'WA'],
  reservations: [], labels: {}, delta_coded: true,
};
const meta = {
  caveats: [
    'Owner location is a MAILING ADDRESS, not residence.',
    'The development ladder is probabilistic: a parcel with a house number carries a building 89-91% of the time.',
    '2009-07-05 has a dead value block: improvement status is unknown, not zero.',
    'Holdings follow Haggerty et al. (2022).',
  ],
  field_availability: [{ snapshot: 10, date: '2013-01-01', unavailable: ['development_ladder'] }],
};
const home = () => ({
  view: 'ladder', snap: 28, level: 'township', measure: 'parcels', selection: [], era: 'all', originState: '',
  maskLow: true, basemap: 'none', layers: { ...LAYER_DEFAULTS }, map: null, theme: null,
  report: defaultReport(dim), parcel: '',
});

test('holdings forces the county level and clears a township selection', () => {
  const { next, warnings, changed } = normalize({ view: 'holdings' }, { ...home(), selection: [2] }, dim);
  assert.equal(next.view, 'holdings');
  assert.equal(next.level, 'county');
  assert.deepEqual(next.selection, []);
  assert.ok(warnings.some((w) => /county-level/.test(w)), warnings.join('; '));
  assert.deepEqual([...changed].sort(), ['level', 'selection', 'view']);
});

test('invalid and duplicate unit ids are dropped with one warning', () => {
  const { next, warnings } = normalize({ level: 'county', selection: [6, 99, 6, 31, 'x'] }, home(), dim);
  assert.deepEqual(next.selection, [6, 31]);
  assert.equal(warnings.filter((w) => /dropped/.test(w)).length, 1);
});

test('township keys are accepted as selection ids', () => {
  const { next } = normalize({ selection: ['002.0S006.0E', 3] }, home(), dim);
  assert.deepEqual(next.selection, [2, 3]);
});

test('snapshot is clamped or refused', () => {
  const a = normalize({ snap: 40 }, home(), dim);
  assert.equal(a.next.snap, 28);
  assert.ok(a.warnings.length === 1);
  const b = normalize({ snap: 'july' }, home(), dim);
  assert.equal(b.next.snap, 28);
  assert.equal(b.changed.size, 0);
});

test('owner origin must be a known state other than Montana', () => {
  assert.equal(normalize({ originState: 'MT' }, home(), dim).next.originState, '');
  assert.equal(normalize({ originState: 'ca' }, home(), dim).next.originState, 'CA');
  assert.equal(normalize({ originState: 'ZZ' }, home(), dim).warnings.length, 1);
});

test('a level change clears the selection unless one is given', () => {
  assert.deepEqual(normalize({ level: 'county' }, { ...home(), selection: [1] }, dim).next.selection, []);
  assert.deepEqual(normalize({ level: 'county', selection: [6] }, { ...home(), selection: [1] }, dim).next.selection, [6]);
});

test('unknown fields warn and are not applied', () => {
  const { next, warnings } = normalize({ colour: 'red', view: 'churn' }, home(), dim);
  assert.equal(next.view, 'churn');
  assert.equal('colour' in next, false);
  assert.ok(warnings.some((w) => /colour/.test(w)));
});

test('the camera takes a centre or a box, clamped to Montana', () => {
  const c = normalize({ map: { center: [-111.04, 45.68], zoom: 12.6 } }, home(), dim);
  assert.deepEqual(c.next.map, { center: [-111.04, 45.68], zoom: 12.6 });
  const far = normalize({ map: { center: [-80, 30], zoom: 50 } }, home(), dim);
  assert.deepEqual(far.next.map, { center: [-103, 44], zoom: 15 });
  assert.ok(far.warnings.length >= 1);
  const b = normalize({ map: { bbox: [-112, 45, -110, 46] } }, home(), dim);
  assert.deepEqual(b.next.map, { bbox: [-112, 45, -110, 46] });
  assert.equal(normalize({ map: null }, { ...home(), map: { center: [-110, 46], zoom: 7 } }, dim).next.map, null);
});

test('the report form is validated', () => {
  const r = normalize({ report: { kind: 'activity', county: '', a: 20, b: 10 } }, home(), dim);
  assert.equal(r.next.report.kind, 'activity');
  assert.equal(r.next.report.county, null);
  assert.ok(r.warnings.some((w) => /earlier vintage/.test(w)));
  assert.equal(normalize({ report: { kind: 'poem' } }, home(), dim).next.report.kind, 'profile');
});

test('the home state is an empty hash', () => {
  assert.equal(toHash(home(), dim), '');
});

test('townships are written as PLSS keys and read back as ids', () => {
  const st = { ...home(), selection: [2, 3] };
  const h = toHash(st, dim);
  assert.equal(h, 'u=002.0S006.0E,003.0N010.0E');
  assert.deepEqual(fromHash('#' + h, dim).patch.selection, [2, 3]);
  const { patch, warnings } = fromHash('u=002.0S006.0E,099.0N001.0E', dim);
  assert.deepEqual(patch.selection, [2]);
  assert.equal(warnings.length, 1);
});

test('the theme is not carried in the link', () => {
  assert.equal(toHash({ ...home(), theme: 'dark' }, dim), '');
});

test('hash round trips for a spread of states', () => {
  const fixtures = [
    { view: 'holdings', level: 'county', selection: [6] },
    { view: 'condition', snap: 19, level: 'county', selection: [6, 31], measure: 'acres' },
    { view: 'thresholds', era: 'mid', maskLow: false },
    { view: 'ownership', originState: 'CA', snap: 0 },
    { view: 'fragmentation', basemap: 'montana', layers: { roads: false, publiclands: true } },
    { view: 'churn', map: { center: [-111.035, 45.68], zoom: 12.6 } },
    { view: 'review', level: 'county' },
    { view: 'reports', report: { kind: 'activity', county: null, a: 10, b: 20 } },
    { view: 'reports', report: { kind: 'profile', county: 31, generated: true } },
    { view: 'about' },
    { selection: [0, 1, 4] },
    { layers: { parcels: false, parcelFill: false } },
    { layers: { parcels: false, parcelFill: false, townships: false, counties: false, roads: false, buildings: false } },
    { snap: 5, measure: 'acres', basemap: 'positron' },
    { view: 'ladder', level: 'county', selection: [1, 6, 31], snap: 12 },
    { view: 'thresholds', era: 'late', map: { center: [-110.5, 46.9], zoom: 6.2 } },
    { view: 'ownership', originState: 'WA', level: 'county', selection: [1] },
    { view: 'condition', snap: 16 },
    { view: 'churn', snap: 27, map: { center: [-114.1234, 48.5678], zoom: 9.99 } },
    { view: 'holdings', snap: 19, selection: [6], measure: 'acres' },
  ];
  assert.ok(fixtures.length >= 20);
  for (const patch of fixtures) {
    const st = normalize(patch, home(), dim).next;
    const h = toHash(st, dim);
    const back = normalize(fromHash('#' + h, dim).patch, home(), dim).next;
    assert.deepEqual(back, st, `round trip failed for ${JSON.stringify(patch)} -> ${h}`);
    assert.equal(toHash(back, dim), h);
  }
});

test('every view key round-trips through the hash', () => {
  for (const v of VIEW_KEYS) {
    const st = normalize({ view: v }, home(), dim).next;
    assert.equal(normalize(fromHash(toHash(st, dim), dim).patch, home(), dim).next.view, v);
  }
});

/* ---- the live object, without a DOM or a map ------------------------- */
function primeS() {
  S.dim = dim; S.meta = meta; S.map = null;
  S.nSnaps = dim.snapshots.length; S.nIv = dim.intervals.length; S.nTwp = dim.townships.length;
  S.twpByKey = new Map(dim.townships.map((t) => [t.tr, t]));
  S.twpById = new Map(dim.townships.map((t) => [t.id, t]));
  S.snap = S.nSnaps - 1;
  S.report = defaultReport(dim);
  bindHost({ viewInfo: (k) => ({ label: k[0].toUpperCase() + k.slice(1), legend: `${k} legend`, summary: `${k} summary` }) });
}

test('applyState works without a DOM and notifies subscribers', async () => {
  primeS();
  const events = [];
  const off = subscribe((e) => events.push(e));
  const r = await applyState({ view: 'holdings', selection: [2] }, { source: 'assistant' });
  off();
  assert.equal(S.view, 'holdings');
  assert.equal(S.level, 'county');
  assert.equal(S.selection.size, 0);
  assert.ok(r.warnings.length >= 1);
  assert.ok(r.changed.includes('view') && r.changed.includes('level'));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'assistant');
  assert.equal(events[0].before.view, 'ladder');
});

test('applyState calls are applied in order', async () => {
  primeS();
  const a = applyState({ level: 'county', selection: [6] });
  const b = applyState({ selection: [6, 31] });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra.state.selection, [6]);
  assert.deepEqual(rb.state.selection, [6, 31]);
  assert.deepEqual(getState().selection, [6, 31]);
});

test('describeState speaks in names and dates', async () => {
  primeS();
  await applyState({ view: 'ownership', level: 'county', selection: [6, 31], snap: 10, originState: 'CA' });
  const d = describeState();
  assert.equal(d.view.label, 'Ownership');
  assert.equal(d.vintage.date, '2013-01-01');
  assert.deepEqual(d.vintage.unavailable, ['development_ladder']);
  assert.deepEqual(d.selection.names, ['Gallatin', 'Park']);
  assert.equal(d.filters.origin_state, 'CA');
  assert.equal(d.filters.era, null);
  assert.ok(d.caveats.some((c) => /MAILING ADDRESS/.test(c)));
  assert.equal(d.map.center, null);
  await applyState({ view: 'ladder', level: 'township', selection: [2] });
  assert.deepEqual(describeState().selection.names, ['T2S R6E']);
});
