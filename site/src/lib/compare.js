/* ---------------------------------------------------------------------------
   compare.js -- one of the views' shares or rates as a series, for any set of
   places, so a place can be drawn against its county and the state.

   The formulas are DERIVED (assistant/derived.mjs), the same ones the views'
   tiles and the assistant use, with the same count floors: a point below its
   floor is NaN (a gap), never zero. Flows are per interval and are drawn at
   the export that closes it. `units` null means the whole state.
--------------------------------------------------------------------------- */
import { DERIVED } from '../assistant/derived.mjs';
import { S } from './state.js';
import { sumAt } from './data.js';
import * as A from './access.js';

export async function derivedSeries(name, level, units) {
  const d = DERIVED[name];
  const n = S.nSnaps;
  const out = new Float64Array(n).fill(NaN);
  if (!d) return out;
  const v = (x) => (x == null || !Number.isFinite(x) ? NaN : x);
  if (d.topic === 'flow') {
    const f = level === 'county' ? await A.countyFlow() : await A.twpFlow();
    const core = level === 'county' ? await A.countyCube() : await A.twpCube('core');
    for (let iv = 0; iv < S.nIv; iv++) {
      const years = S.dim.intervals[iv]?.years || 1;
      out[iv + 1] = v(d.compute((c) => sumAt(f, c, iv, units), { years, stock: sumAt(core, 'parcels', iv + 1, units) }));
    }
    return out;
  }
  if (d.topic === 'cama') {
    const T = await A.camaTables();
    const twp = level === 'township' && units;
    const t = twp ? T.twp : T.cty, by = twp ? T.twpBy : T.ctyBy, u = units || [0];
    for (const s of T.points) {
      const sums = A.camaSum(t, by.get(s), u, d.columns);
      out[s] = v(d.compute((c) => sums[c] ?? 0, {}));
    }
    return out;
  }
  if (d.topic === 'holdings') {
    const c = await A.holdingsCube();
    const u = units && units.length ? units : [0];
    for (let s = 0; s < n; s++) out[s] = v(d.compute((col) => sumAt(c, col, s, u), {}));
    return out;
  }
  const c = level === 'county' ? await A.countyCube() : await A.twpCube(d.topic);
  for (let s = 0; s < n; s++) out[s] = v(d.compute((col) => sumAt(c, col, s, units), {}));
  return out;
}
