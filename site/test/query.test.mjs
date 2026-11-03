import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, CAPS } from '../src/assistant/query.js';

const T = {
  columns: ['county_n', 's', 'rank', 'acres', 'display_name', 'is_entity'],
  rows: [
    [6, 19, 1, 60000, 'A', 1], [6, 19, 2, 40000, 'B', 0], [6, 19, 3, 30000n, 'C', 1],
    [31, 19, 1, 70000, 'D', 1], [31, 19, 2, 20000, 'E', 0], [6, 20, 1, 61000, 'F', 1],
  ],
};
const dec = { county_n: (v) => (v === 6 ? 'Gallatin' : v === 31 ? 'Park' : String(v)) };
const deny = new Set(['display_name']);

test('filters, projects and decodes', () => {
  const r = runQuery(T, { where: [{ col: 'county_n', op: '=', value: 6 }, { col: 's', op: '=', value: '19' }], columns: ['county_n', 'rank', 'acres'],
    order_by: [{ col: 'rank', dir: 'asc' }] }, { deny, decoders: dec });
  assert.deepEqual(r.columns, ['county_n', 'rank', 'acres']);
  assert.deepEqual(r.rows, [['Gallatin', 1, 60000], ['Gallatin', 2, 40000], ['Gallatin', 3, 30000]]);
  assert.equal(r.total, 3);
});

test('groups and aggregates, with in and bigint', () => {
  const r = runQuery(T, { where: [{ col: 'county_n', op: 'in', value: [6, 31] }], group_by: ['county_n'],
    aggregate: [{ fn: 'sum', col: 'acres', as: 'acres' }, { fn: 'count', col: null, as: 'n' }, { fn: 'avg', col: 'acres', as: 'mean' }],
    order_by: [{ col: 'acres', dir: 'desc' }], decode: false }, { deny });
  assert.deepEqual(r.columns, ['county_n', 'acres', 'n', 'mean']);
  assert.deepEqual(r.rows, [[6, 191000, 4, 47750], [31, 90000, 2, 45000]]);
});

test('denied columns are neither returned nor filterable', () => {
  const all = runQuery(T, {}, { deny });
  assert.ok(!all.columns.includes('display_name'));
  assert.throws(() => runQuery(T, { columns: ['display_name'] }, { deny }), /not available/);
  assert.throws(() => runQuery(T, { where: [{ col: 'display_name', op: '=', value: 'A' }] }, { deny }), /not available/);
});

test('caps and errors', () => {
  assert.throws(() => runQuery(T, { where: Array(CAPS.where + 1).fill({ col: 's', op: '=', value: 19 }) }), /at most/);
  assert.throws(() => runQuery(T, { where: [{ col: 'nope', op: '=', value: 1 }] }), /unknown column/);
  assert.throws(() => runQuery(T, { where: [{ col: 's', op: '~', value: 1 }] }), /unknown operator/);
  const r = runQuery(T, { limit: 5000 });
  assert.ok(r.notes.some((n) => /limit reduced/.test(n)));
  const two = runQuery(T, { limit: 2 });
  assert.equal(two.rows.length, 2);
  assert.equal(two.truncated, true);
  assert.equal(two.total, 6);
});
