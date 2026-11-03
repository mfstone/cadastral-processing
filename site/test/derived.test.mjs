import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DERIVED } from '../src/assistant/derived.mjs';

const sums = (o) => (c) => o[c] ?? 0;

test('shares apply the views’ count floors', () => {
  assert.equal(DERIVED.addressed_unbuilt_share.compute(sums({ n_dev0: 10, n_dev1: 5, n_dev2: 5 })), null);
  assert.equal(DERIVED.addressed_unbuilt_share.compute(sums({ n_dev0: 50, n_dev1: 25, n_dev2: 25 })), 25);
  assert.equal(DERIVED.under_40ac_acreage_share.compute(sums({ ac_sz1: 100, ac_sz5: 300 })), null);
  assert.equal(DERIVED.under_40ac_acreage_share.compute(sums({ ac_sz1: 100, ac_sz5: 900 })), 10);
  assert.equal(DERIVED.fair_or_worse_share.compute(sums({ n_cd3: 10, n_cd4: 10 })), null);
  assert.equal(DERIVED.fair_or_worse_share.compute(sums({ n_cd3: 10, n_cd4: 30 })), 25);
});

test('rates use the interval length and the closing stock', () => {
  assert.equal(DERIVED.owner_change_pct_per_year.compute(sums({ persisted: 1000, owner_changed: 50, comparable: 1 }), { years: 0.5 }), 10);
  assert.equal(DERIVED.owner_change_pct_per_year.compute(sums({ persisted: 1000, owner_changed: 50, comparable: 0 }), { years: 0.5 }), null);
  assert.equal(DERIVED.new_lots_per_1000_per_year.compute(sums({ lot_created: 20, comparable: 1 }), { years: 2, stock: 1000 }), 10);
  assert.equal(DERIVED.new_lots_per_1000_per_year.compute(sums({ lot_created: 20, comparable: 1 }), { years: 2, stock: 10 }), null);
});

test('holdings measures', () => {
  assert.equal(DERIVED.clo4_pct.compute(sums({ clo4: 0.25, large_owners: 3 })), null);
  assert.equal(DERIVED.clo4_pct.compute(sums({ clo4: 0.25, large_owners: 4 })), 25);
  assert.equal(DERIVED.mean_large_holding_acres.compute(sums({ large_acres: 9000, large_owners: 3 })), 3000);
  assert.equal(DERIVED.large_acres_share_of_private.compute(sums({ large_acres: 500, private_acres: 2000 })), 25);
  assert.equal(DERIVED.clo4_pct.perUnit, true);
});
