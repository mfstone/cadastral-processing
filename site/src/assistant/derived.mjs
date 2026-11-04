/* ---------------------------------------------------------------------------
   derived.mjs -- the shares and rates the views compute, written once.

   The assistant never divides two numbers itself: it asks read_series for one
   of these, and the executor computes it from the same cube sums the map and
   the stat tiles use, with the same count floors (a share over too few
   parcels is noise, and the views return null rather than a number). The
   eval computes the same formulas in node, from the same file, so a figure
   the assistant states can be checked without the page.

   Each entry: the topic (cube family) it reads, the columns it needs, the
   level it is valid at, and compute(sum, ctx) where sum(col) is the
   selection's total at the point and ctx carries the interval's years and
   the stock at the interval's closing export (for rates per parcel).
--------------------------------------------------------------------------- */

const cols = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const pct = (num, den) => (den > 0 ? (100 * num) / den : null);

export const DERIVED = {
  addressed_unbuilt_share: {
    topic: 'dev', level: 'any', columns: cols('n_dev', 3), unit: '% of parcels on the ladder',
    definition: 'addressed-but-unbuilt parcels as a share of platted + addressed + built; null under 25 parcels',
    compute: (sum) => { const t = sum('n_dev0') + sum('n_dev1') + sum('n_dev2'); return t > 25 ? pct(sum('n_dev1'), t) : null; },
  },
  out_of_state_share: {
    topic: 'locality', level: 'any', columns: cols('n_loc', 5), unit: '% of parcels',
    definition: 'parcels whose owner mails from out of state, as a share of all parcels with an owner record; null under 25 parcels',
    compute: (sum) => { const t = cols('n_loc', 5).reduce((a, c) => a + sum(c), 0); return t > 25 ? pct(sum('n_loc3'), t) : null; },
  },
  under_40ac_acreage_share: {
    topic: 'size', level: 'any', columns: cols('ac_sz', 8), unit: '% of acreage',
    definition: 'acreage in parcels under 40 acres as a share of all acreage; null under 500 acres',
    compute: (sum) => {
      const small = sum('ac_sz1') + sum('ac_sz2') + sum('ac_sz3') + sum('ac_sz4');
      const tot = cols('ac_sz', 8).reduce((a, c) => a + sum(c), 0);
      return tot > 500 ? pct(small, tot) : null;
    },
  },
  owner_change_pct_per_year: {
    topic: 'flow', level: 'any', columns: ['persisted', 'owner_changed', 'comparable'], unit: '% of persisting parcels per year',
    definition: 'persisting parcels whose owner changed, as a share per year on the interval’s real length; null under 50 persisting parcels or where the interval is not comparable',
    compute: (sum, ctx) => {
      const p = sum('persisted');
      if (!(p > 50) || !(sum('comparable') > 0)) return null;
      return pct(sum('owner_changed'), p) / (ctx.years || 1);
    },
  },
  new_lots_per_1000_per_year: {
    topic: 'flow', level: 'any', columns: ['lot_created', 'comparable'], unit: 'new lots per 1,000 parcels per year',
    definition: 'lots created in the interval per thousand parcels in stock at its closing export, per year; null under 50 parcels or where not comparable',
    compute: (sum, ctx) => {
      if (!(sum('comparable') > 0) || !(ctx.stock > 50)) return null;
      return (1000 * sum('lot_created')) / ctx.stock / (ctx.years || 1);
    },
  },
  lots_divided_per_1000_per_year: {
    topic: 'flow', level: 'any', columns: ['divided', 'comparable'], unit: 'lots divided off per 1,000 parcels per year',
    definition: 'lots divided off by a plat, an amended plat or a certificate of survey in the interval, per thousand parcels in stock at its closing export, per year; null under 50 parcels or where not comparable',
    compute: (sum, ctx) => {
      if (!(sum('comparable') > 0) || !(ctx.stock > 50)) return null;
      return (1000 * sum('divided')) / ctx.stock / (ctx.years || 1);
    },
  },
  transfers_out_of_state_per_year: {
    topic: 'flow', level: 'any', columns: ['transfers_out_of_state'], unit: 'transfers per year',
    definition: 'owner changes where the mailing state also changed, per year',
    compute: (sum, ctx) => sum('transfers_out_of_state') / (ctx.years || 1),
  },
  address_changes_per_year: {
    topic: 'flow', level: 'any', columns: ['address_change_only'], unit: 'address edits per year',
    definition: 'mailing-state changes with the same owner (an address edit, not a sale), per year',
    compute: (sum, ctx) => sum('address_change_only') / (ctx.years || 1),
  },
  units_created_per_year: {
    topic: 'flow', level: 'any', columns: ['unit_created'], unit: 'condominium units per year',
    definition: 'condominium units created inside existing lots, per year',
    compute: (sum, ctx) => sum('unit_created') / (ctx.years || 1),
  },
  clo4_pct: {
    topic: 'holdings', level: 'county', perUnit: true, columns: ['clo4', 'large_owners'], unit: '% of large-holding acreage',
    definition: 'share of a county’s large-holding acreage held by its four largest holdings; one county at a time; null under four large holdings',
    compute: (sum) => (sum('large_owners') >= 4 ? 100 * sum('clo4') : null),
  },
  mean_large_holding_acres: {
    topic: 'holdings', level: 'county', columns: ['large_acres', 'large_owners'], unit: 'acres',
    definition: 'acres in large (640+ acre) private holdings divided by their number',
    compute: (sum) => (sum('large_owners') > 0 ? sum('large_acres') / sum('large_owners') : null),
  },
  large_acres_share_of_private: {
    topic: 'holdings', level: 'county', columns: ['large_acres', 'private_acres'], unit: '% of private acreage',
    definition: 'acres in large holdings as a share of all private acreage',
    compute: (sum) => pct(sum('large_acres'), sum('private_acres')),
  },
  large_oos_share: {
    topic: 'holdings', level: 'county', columns: ['large_oos_acres', 'large_acres'], unit: '% of large-holding acreage',
    definition: 'large-holding acreage whose owner mails from out of state, as a share of all large-holding acreage',
    compute: (sum) => pct(sum('large_oos_acres'), sum('large_acres')),
  },
  large_provisional_share: {
    topic: 'holdings', level: 'county', columns: ['large_provisional', 'large_owners'], unit: '% of large holdings',
    definition: 'large holdings that rest on a pending identity decision, as a share of large holdings',
    compute: (sum) => pct(sum('large_provisional'), sum('large_owners')),
  },
  fair_or_worse_share: {
    topic: 'cama', level: 'any', columns: cols('n_cd', 8), unit: '% of rated dwellings',
    definition: 'dwellings rated fair (6) or worse as a share of rated dwellings; null under 25 rated',
    compute: (sum) => { const r = cols('n_cd', 8).reduce((a, c) => a + sum(c), 0); return r >= 25 ? pct(sum('n_cd0') + sum('n_cd1') + sum('n_cd2') + sum('n_cd3'), r) : null; },
  },
  pre_1980_share: {
    topic: 'cama', level: 'any', columns: cols('n_yb', 9), unit: '% of dwellings with a year built',
    definition: 'dwellings built before 1980 as a share of those with a year built',
    compute: (sum) => { const t = cols('n_yb', 9).reduce((a, c) => a + sum(c), 0); return pct(sum('n_yb0') + sum('n_yb1') + sum('n_yb2') + sum('n_yb3') + sum('n_yb4'), t); },
  },
};

export const DERIVED_NAMES = Object.keys(DERIVED);
