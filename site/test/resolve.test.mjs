import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countyCode, townshipFromLabel, snapIndex, stateCode, labelIndex, lookupPlace, bboxOf } from '../src/assistant/resolve.js';

const dim = {
  snapshots: [{ id: 0, date: '2003-12-22' }, { id: 1, date: '2004-07-16' }, { id: 2, date: '2005-02-01' }, { id: 3, date: '2005-12-30' },
    { id: 4, date: '2018-01-10' }, { id: 5, date: '2018-12-18' }, { id: 6, date: '2026-09-04' }],
  counties: [{ code: 1, name: 'Silver Bow', abbr: 'SB' }, { code: 6, name: 'Gallatin', abbr: 'GA' }, { code: 31, name: 'Park', abbr: 'PA' }],
  townships: [{ id: 0, tr: '001.0N001.0E', label: '1N 1E' }, { id: 2, tr: '002.0S006.0E', label: '2S 6E' }],
  states: ['00', 'CA', 'MT', 'WA'], reservations: ['CROW', "ROCKY BOY'S"],
  labels: { tenure: ['public_domain', 'tribal_trust', 'private'] },
};
const sq = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
const ctx = {
  dim,
  counties: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { county_n: 6 }, geometry: sq(-112, 45, -110, 46) }] },
  townships: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { tr_key: '002.0S006.0E' }, geometry: sq(-111.2, 45.5, -111.0, 45.7) }] },
  cities: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Bozeman', county: 'Gallatin', acres: 12000 }, geometry: sq(-111.1, 45.6, -111.05, 45.65) }] },
  reservations: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'CROW' }, geometry: sq(-109, 45, -107, 46) }] },
};

test('counties by name, abbreviation, code and near-miss', () => {
  assert.equal(countyCode('Gallatin', dim).code, 6);
  assert.equal(countyCode('gallatin county', dim).code, 6);
  assert.equal(countyCode('GA', dim).code, 6);
  assert.equal(countyCode(31, dim).name, 'Park');
  assert.equal(countyCode('Galatin', dim).code, 6);
  assert.equal(countyCode('Galatin', dim).exact, false);
  assert.equal(countyCode('Nowhere', dim), null);
});

test('townships from labels', () => {
  assert.equal(townshipFromLabel('T2S R6E', dim).id, 2);
  assert.equal(townshipFromLabel('2s 6e', dim).id, 2);
  assert.equal(townshipFromLabel('T 1 N, R 1 E', dim).id, 0);
  assert.equal(townshipFromLabel('002.0S006.0E', dim).id, 2);
  assert.equal(townshipFromLabel('T9N R9E', dim), null);
});

test('export indexes from dates and years', () => {
  assert.deepEqual(snapIndex(4, dim), { index: 4, date: '2018-01-10', note: null });
  assert.equal(snapIndex('2018', dim).index, 5);
  assert.equal(snapIndex('2018-06-01', dim).index, 4);
  assert.match(snapIndex('2018-06-01', dim).note, /nearest/);
  assert.equal(snapIndex('2005', dim).index, 3);
  assert.equal(snapIndex('1999-01-01', dim).index, 0);
  assert.equal(snapIndex('soon', dim), null);
  assert.equal(snapIndex(99, dim), null);
});

test('states and labels', () => {
  assert.equal(stateCode('ca', dim), 'CA');
  assert.equal(stateCode('MT', dim), null);
  assert.equal(stateCode('', dim), '');
  assert.equal(labelIndex('tenure', 'tribal trust', dim), 1);
  assert.equal(labelIndex('tenure', 2, dim), 2);
});

test('lookup_place finds a city with its county and township, and a reservation', () => {
  const r = lookupPlace('Bozeman', 'any', ctx);
  const city = r.candidates.find((c) => c.kind === 'city');
  assert.equal(city.county.code, 6);
  assert.equal(city.township.id, 2);
  assert.deepEqual(city.bbox, [-111.1, 45.6, -111.05, 45.65]);
  const g = lookupPlace('Gallatin', 'county', ctx);
  assert.equal(g.candidates[0].code, 6);
  assert.deepEqual(g.candidates[0].bbox, [-112, 45, -110, 46]);
  const res = lookupPlace('Rocky Boys', 'reservation', ctx);
  assert.equal(res.candidates[0].name, "ROCKY BOY'S");
  assert.equal(lookupPlace('zzz', 'any', ctx).candidates.length, 0);
  assert.equal(bboxOf(null), null);
});
