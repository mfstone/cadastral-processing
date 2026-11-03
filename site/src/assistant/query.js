/* ---------------------------------------------------------------------------
   query.js -- the read_table grammar over a {columns, rows} table.

   A small declarative query rather than code: filter rows with ANDed
   clauses, optionally group and aggregate, order and limit. No expressions,
   no joins, no free-form execution in the page, hard caps on everything.
   Pure, so node tests it; the executor supplies the table, the deny-list and
   the decoders.
--------------------------------------------------------------------------- */

export const CAPS = Object.freeze({ where: 8, inValues: 64, groupBy: 3, aggregates: 8, limit: 200, defaultLimit: 50, cells: 4000 });
const OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'in']);
const FNS = new Set(['sum', 'count', 'min', 'max', 'avg']);

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const cmp = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

class QueryError extends Error {}

function clauseFn(c, columns) {
  if (!c || typeof c !== 'object') throw new QueryError('each where clause must be an object');
  const idx = columns.indexOf(c.col);
  if (idx < 0) throw new QueryError(`unknown column "${c.col}" in where; columns are ${columns.join(', ')}`);
  if (!OPS.has(c.op)) throw new QueryError(`unknown operator "${c.op}"`);
  if (c.op === 'in') {
    if (!Array.isArray(c.value)) throw new QueryError('"in" needs a list of values');
    if (c.value.length > CAPS.inValues) throw new QueryError(`"in" takes at most ${CAPS.inValues} values`);
    const set = new Set(c.value.map((v) => (typeof v === 'number' ? v : String(v))));
    return (row) => { const v = num(row[idx]); return set.has(typeof v === 'number' ? v : String(v)); };
  }
  const want = c.value;
  if (Array.isArray(want)) throw new QueryError(`operator "${c.op}" takes one value`);
  return (row) => {
    const v = num(row[idx]);
    const w = typeof v === 'number' && typeof want === 'string' && want.trim() !== '' && Number.isFinite(Number(want)) ? Number(want) : want;
    const d = cmp(v, w);
    switch (c.op) {
      case '=': return v == null ? w == null : d === 0;
      case '!=': return v == null ? w != null : d !== 0;
      case '<': return v != null && w != null && d < 0;
      case '<=': return v != null && w != null && d <= 0;
      case '>': return v != null && w != null && d > 0;
      case '>=': return v != null && w != null && d >= 0;
      default: return false;
    }
  };
}

/**
 * Run `spec` over `table`. Options: deny (Set of column names never returned
 * or filtered on), decoders ({col: (value) => label}), applied when
 * spec.decode is not false. Returns { columns, rows, total, truncated, notes }.
 */
export function runQuery(table, spec, { deny = new Set(), decoders = {} } = {}) {
  const allCols = table.columns.filter((c) => !deny.has(c));
  const q = spec || {};
  const notes = [];
  const bad = (m) => { throw new QueryError(m); };
  for (const c of [...(q.columns || []), ...(q.group_by || []), ...(q.where || []).map((w) => w && w.col),
    ...(q.aggregate || []).map((a) => a && a.col).filter(Boolean), ...(q.order_by || []).map((o) => o && o.col)]) {
    if (deny.has(c)) bad(`column "${c}" is not available`);
  }
  const where = q.where || [];
  if (where.length > CAPS.where) bad(`at most ${CAPS.where} where clauses`);
  const tests = where.map((c) => clauseFn(c, table.columns));
  let rows = table.rows;
  if (tests.length) rows = rows.filter((r) => tests.every((t) => t(r)));

  const groupBy = q.group_by || [];
  const aggs = q.aggregate || [];
  if (groupBy.length > CAPS.groupBy) bad(`at most ${CAPS.groupBy} group_by columns`);
  if (aggs.length > CAPS.aggregates) bad(`at most ${CAPS.aggregates} aggregates`);
  for (const g of groupBy) if (!allCols.includes(g)) bad(`unknown column "${g}" in group_by`);

  let outCols, outRows;
  if (groupBy.length || aggs.length) {
    const gi = groupBy.map((g) => table.columns.indexOf(g));
    const specs = aggs.map((a) => {
      if (!a || !FNS.has(a.fn)) bad(`unknown aggregate "${a && a.fn}"`);
      if (!a.as || typeof a.as !== 'string') bad('each aggregate needs an output name (as)');
      const ci = a.col == null ? -1 : table.columns.indexOf(a.col);
      if (a.fn !== 'count' && ci < 0) bad(`unknown column "${a.col}" in aggregate`);
      return { fn: a.fn, ci, as: a.as };
    });
    const groups = new Map();
    for (const r of rows) {
      const key = gi.map((i) => String(num(r[i]))).join('\u0001');
      let g = groups.get(key);
      if (!g) { g = { keys: gi.map((i) => num(r[i])), acc: specs.map(() => ({ n: 0, sum: 0, min: null, max: null })) }; groups.set(key, g); }
      specs.forEach((s, k) => {
        const a = g.acc[k];
        if (s.fn === 'count') { if (s.ci < 0 || num(r[s.ci]) != null) a.n++; return; }
        const v = num(r[s.ci]);
        if (typeof v !== 'number' || !Number.isFinite(v)) return;
        a.n++; a.sum += v;
        a.min = a.min == null ? v : Math.min(a.min, v);
        a.max = a.max == null ? v : Math.max(a.max, v);
      });
    }
    outCols = [...groupBy, ...specs.map((s) => s.as)];
    outRows = [...groups.values()].map((g) => [...g.keys, ...specs.map((s, k) => {
      const a = g.acc[k];
      switch (s.fn) {
        case 'count': return a.n;
        case 'sum': return a.sum;
        case 'min': return a.min;
        case 'max': return a.max;
        default: return a.n ? a.sum / a.n : null;
      }
    })]);
  } else {
    const want = q.columns && q.columns.length ? q.columns : allCols;
    for (const c of want) if (!allCols.includes(c)) bad(`unknown column "${c}"; columns are ${allCols.join(', ')}`);
    const idx = want.map((c) => table.columns.indexOf(c));
    outCols = want;
    outRows = rows.map((r) => idx.map((i) => num(r[i])));
  }

  for (const o of (q.order_by || []).slice().reverse()) {
    const i = outCols.indexOf(o && o.col);
    if (i < 0) bad(`order_by column "${o && o.col}" is not in the result`);
    const dir = o.dir === 'desc' ? -1 : 1;
    outRows.sort((a, b) => dir * cmp(a[i], b[i]));
  }

  const total = outRows.length;
  let limit = q.limit == null ? CAPS.defaultLimit : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = CAPS.defaultLimit;
  if (limit > CAPS.limit) { notes.push(`limit reduced to ${CAPS.limit}`); limit = CAPS.limit; }
  const maxRows = Math.max(1, Math.floor(CAPS.cells / Math.max(1, outCols.length)));
  if (limit > maxRows) { notes.push(`limit reduced to ${maxRows} rows (${CAPS.cells} cells)`); limit = maxRows; }
  const truncated = total > limit;
  outRows = outRows.slice(0, limit);
  if (truncated) notes.push(`${total} rows matched; showing ${limit}`);

  if (q.decode !== false) {
    const dec = outCols.map((c) => decoders[c] || null);
    if (dec.some(Boolean)) outRows = outRows.map((r) => r.map((v, i) => (dec[i] ? dec[i](v) : v)));
  }
  return { columns: outCols, rows: outRows, total, truncated, notes };
}

export { QueryError };
