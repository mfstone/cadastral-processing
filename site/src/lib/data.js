/* ---------------------------------------------------------------------------
   data.js -- load the published payload and reshape it into flat typed arrays.

   Two constraints, both learned in production on the sibling crash dashboard:

   1. Cloudflare Pages ignores HTTP `Range`: it answers 200 with the whole body
      and sends no `accept-ranges`. hyparquet reads Parquet through a file-like
      object whose `slice` would become a Range request, so every file is
      fetched WHOLE and the ArrayBuffer wrapped. A row-group read would
      otherwise degrade to re-downloading the file per request.

   2. The GZIP page codec is supplied by a DEEP import of
      `hyparquet-compressors/src/gzip.js`. The package index also pulls in
      hysnappy, which instantiates an embedded WebAssembly module eagerly at
      import time -- and `script-src 'self'` forbids compiling wasm without
      'wasm-unsafe-eval'. Reaching past the index keeps the CSP absolute and
      drops four decompressors this payload never uses. That is why the package
      is pinned exactly in package.json: a deep import is not public API, so a
      version bump could move the file. It would fail at build, not at runtime.

   The stock tables are snapshot-delta coded (each value is the change from the
   previous snapshot, measured 1.44-1.87x smaller than levels once gzipped), so
   they are cumulatively summed along the snapshot axis once at load.
--------------------------------------------------------------------------- */

import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import { gunzip } from 'hyparquet-compressors/src/gzip.js';

const COMPRESSORS = {
  GZIP: (input, outputLength) => gunzip(input, new Uint8Array(outputLength)),
};

const BASE = 'data';

/** Wrap an ArrayBuffer as the file-like object hyparquet wants, with no Range. */
function bufferOf(arrayBuffer) {
  return {
    byteLength: arrayBuffer.byteLength,
    async slice(start, end) { return arrayBuffer.slice(start, end); },
  };
}

const _cache = new Map();

/** Fetch a published Parquet table as {columns: string[], rows: any[][]}. */
export async function loadTable(name) {
  if (_cache.has(name)) return _cache.get(name);
  const p = (async () => {
    const res = await fetch(`${BASE}/${name}.parquet`);
    if (!res.ok) throw new Error(`${name}.parquet: HTTP ${res.status}`);
    const file = bufferOf(await res.arrayBuffer());
    const metadata = await parquetMetadataAsync(file);
    const columns = metadata.row_groups[0].columns.map(
      (c) => c.meta_data.path_in_schema.join('.'),
    );
    let rows = [];
    await parquetRead({
      file, metadata, compressors: COMPRESSORS,
      onComplete: (d) => { rows = d; },
    });
    return { columns, rows };
  })();
  _cache.set(name, p);
  return p;
}

export async function loadJSON(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Transpose a (unit, snapshot) table into one flat Float64Array per measure,
 * indexed `unit * nSnaps + snap`, undoing the delta coding as it goes.
 *
 * Flat typed arrays rather than nested objects because every repaint sums over
 * a unit selection, and that wants contiguous memory.
 */
export function cube(table, { nUnits, nSnaps, keyCol = 'u', snapCol = 's', delta = true }) {
  const { columns, rows } = table;
  const ki = columns.indexOf(keyCol);
  const si = columns.indexOf(snapCol);
  if (ki < 0 || si < 0) throw new Error(`cube: missing ${keyCol}/${snapCol}`);
  const measures = columns.filter((c) => c !== keyCol && c !== snapCol);
  const out = {};
  for (const m of measures) out[m] = new Float64Array(nUnits * nSnaps);

  for (const row of rows) {
    const u = row[ki], s = row[si];
    if (u == null || s == null || u < 0 || u >= nUnits || s < 0 || s >= nSnaps) continue;
    const at = u * nSnaps + s;
    for (let j = 0; j < measures.length; j++) {
      const v = row[columns.indexOf(measures[j])];
      out[measures[j]][at] = typeof v === 'bigint' ? Number(v) : (v ?? 0);
    }
  }
  if (delta) {
    for (const m of measures) {
      const a = out[m];
      for (let u = 0; u < nUnits; u++) {
        const base = u * nSnaps;
        for (let s = 1; s < nSnaps; s++) a[base + s] += a[base + s - 1];
      }
    }
  }
  return { measures, data: out, nUnits, nSnaps };
}

/** Same shape for interval-keyed flow tables, which are never delta coded. */
export function flowCube(table, { nUnits, nIntervals, keyCol = 'u', ivCol = 'i' }) {
  return cube(table, { nUnits, nSnaps: nIntervals, keyCol, snapCol: ivCol, delta: false });
}

/** Sum a measure over a unit selection at one snapshot. */
export function sumAt(c, measure, snap, units) {
  const a = c.data[measure];
  if (!a) return 0;
  let t = 0;
  if (!units) {
    for (let u = 0; u < c.nUnits; u++) t += a[u * c.nSnaps + snap];
  } else {
    for (const u of units) t += a[u * c.nSnaps + snap];
  }
  return t;
}

/** A measure's series across all snapshots for a unit selection. */
export function seriesOf(c, measure, units) {
  const out = new Float64Array(c.nSnaps);
  for (let s = 0; s < c.nSnaps; s++) out[s] = sumAt(c, measure, s, units);
  return out;
}

/** Per-unit values of one measure at one snapshot, for choropleth paint. */
export function valuesAt(c, measure, snap) {
  const a = c.data[measure];
  const out = new Float64Array(c.nUnits);
  if (!a) return out;
  for (let u = 0; u < c.nUnits; u++) out[u] = a[u * c.nSnaps + snap];
  return out;
}
