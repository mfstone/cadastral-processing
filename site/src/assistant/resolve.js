/* ---------------------------------------------------------------------------
   resolve.js -- names to the ids the dashboard uses, and back.

   Counties by name, abbreviation or code (with a small tolerance for
   spelling); PLSS townships from "T1N R1E" or "1N 1E"; export dates and years
   to the export index "at or before"; cities and reservations from their
   boundary files, with the containing county and township. Pure functions
   over `dim` and the GeoJSON the page already holds; node tests them.
--------------------------------------------------------------------------- */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\bcounty\b/, '').trim();

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** A county from a code, a name or an abbreviation. Returns {code, name, abbr, exact} or null. */
export function countyCode(q, dim) {
  if (q == null || q === '') return null;
  const counties = dim.counties || [];
  if (typeof q === 'number' || /^\d+$/.test(String(q).trim())) {
    const c = counties.find((x) => x.code === Number(q));
    return c ? { ...c, exact: true } : null;
  }
  const s = norm(q);
  const up = String(q).trim().toUpperCase();
  let c = counties.find((x) => norm(x.name) === s) || (up.length === 2 && counties.find((x) => x.abbr === up));
  if (c) return { ...c, exact: true };
  c = counties.find((x) => norm(x.name).startsWith(s) && s.length >= 3);
  if (c) return { ...c, exact: false };
  let best = null;
  for (const x of counties) {
    const d = levenshtein(norm(x.name), s);
    if (d <= 2 && (!best || d < best.d)) best = { d, x };
  }
  return best ? { ...best.x, exact: false } : null;
}

/** "T1N R1E", "1N 1E", "T 2 S R 6 E" or a tr key to a township {id, tr, label}. */
export function townshipFromLabel(q, dim) {
  if (q == null) return null;
  const byTr = new Map((dim.townships || []).map((t) => [t.tr, t]));
  if (byTr.has(String(q))) return byTr.get(String(q));
  if (typeof q === 'number' || /^\d+$/.test(String(q).trim())) {
    return (dim.townships || []).find((t) => t.id === Number(q)) || null;
  }
  const m = String(q).toUpperCase().match(/^\s*T?\s*(\d{1,3})\s*([NS])\s*,?\s*R?\s*(\d{1,3})\s*([EW])\s*$/);
  if (!m) return null;
  const tr = `${m[1].padStart(3, '0')}.0${m[2]}${m[3].padStart(3, '0')}.0${m[4]}`;
  return byTr.get(tr) || null;
}

/**
 * An export index from an index, a date (YYYY-MM-DD, the export at or
 * before it) or a year (its last export). Returns {index, date, note} or null.
 */
export function snapIndex(q, dim) {
  const snaps = dim.snapshots || [];
  if (!snaps.length || q == null || q === '') return null;
  if (typeof q === 'number' || /^\d{1,2}$/.test(String(q).trim())) {
    const n = Number(q);
    if (Number.isInteger(n) && n >= 0 && n < snaps.length) return { index: n, date: snaps[n].date, note: null };
    return null;
  }
  const s = String(q).trim();
  let want;
  if (/^\d{4}$/.test(s)) want = `${s}-12-31`;
  else if (/^\d{4}-\d{2}$/.test(s)) want = `${s}-31`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) want = s;
  else return null;
  let pick = null;
  for (const sn of snaps) if (sn.date <= want) pick = sn;
  if (!pick) return { index: 0, date: snaps[0].date, note: `no export at or before ${s}; using the first, ${snaps[0].date}` };
  const note = pick.date === want ? null : `nearest export at or before ${s} is ${pick.date}`;
  return { index: pick.id ?? snaps.indexOf(pick), date: pick.date, note };
}

/** A two-letter owner-origin state present in the data, or null. */
export function stateCode(q, dim) {
  if (q == null) return null;
  const up = String(q).trim().toUpperCase();
  if (up === '' || up === 'ALL') return '';
  return (dim.states || []).includes(up) && up !== 'MT' ? up : null;
}

/** The index of a label in a code list, accepting the index itself or the label (loosely). */
export function labelIndex(kind, q, dim) {
  const list = (dim.labels || {})[kind] || [];
  if (typeof q === 'number') return q >= 0 && q < list.length ? q : null;
  const s = norm(q).replace(/[^a-z0-9]+/g, '_');
  const i = list.findIndex((l) => norm(l).replace(/[^a-z0-9]+/g, '_') === s);
  return i >= 0 ? i : null;
}

/* ---- geometry ------------------------------------------------------------ */
function rings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  return [];
}
export function bboxOf(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of rings(geom)) for (const [x, y] of ring) { if (x < w) w = x; if (y < s) s = y; if (x > e) e = x; if (y > n) n = y; }
  if (!Number.isFinite(w)) return null;
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return [r(w), r(s), r(e), r(n)];
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInGeom(x, y, geom) {
  if (geom?.type === 'Polygon') return pointInRing(x, y, geom.coordinates[0]);
  if (geom?.type === 'MultiPolygon') return geom.coordinates.some((p) => pointInRing(x, y, p[0]));
  return false;
}
const centreOf = (geom) => { const b = bboxOf(geom); return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null; };

/** The township whose polygon contains the point, from the townships FeatureCollection. */
export function townshipAt(lon, lat, townships, dim) {
  const byTr = new Map((dim.townships || []).map((t) => [t.tr, t]));
  for (const f of townships?.features || []) {
    const b = bboxOf(f.geometry);
    if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (pointInGeom(lon, lat, f.geometry)) {
      const t = byTr.get(f.properties?.tr_key);
      if (t) return t;
    }
  }
  return null;
}

/**
 * lookup_place. ctx: { dim, counties, townships, cities, reservations }
 * (FeatureCollections; cities and reservations may be null when not loaded).
 */
export function lookupPlace(query, kind, ctx) {
  const { dim } = ctx;
  const want = kind && kind !== 'any' ? kind : null;
  const out = [];
  const q = String(query ?? '').trim();
  if (!q) return { candidates: [], exact: false };
  const countyFeat = (code) => (ctx.counties?.features || []).find((f) => Number(f.properties?.county_n) === code);

  if (!want || want === 'county') {
    const c = countyCode(q, dim);
    if (c) out.push({ kind: 'county', name: `${c.name} County`, code: c.code, abbr: c.abbr, exact: c.exact, bbox: bboxOf(countyFeat(c.code)?.geometry) });
  }
  if (!want || want === 'township') {
    const t = townshipFromLabel(q, dim);
    if (t) {
      const f = (ctx.townships?.features || []).find((x) => x.properties?.tr_key === t.tr);
      out.push({ kind: 'township', name: `T${t.label.replace(' ', ' R')}`, id: t.id, tr: t.tr, exact: true, bbox: bboxOf(f?.geometry) });
    }
  }
  if (!want || want === 'city') {
    const s = norm(q);
    const feats = (ctx.cities?.features || []);
    const matches = feats.filter((f) => norm(f.properties?.name) === s);
    const loose = matches.length ? [] : feats.filter((f) => norm(f.properties?.name).startsWith(s) && s.length >= 3).slice(0, 5);
    for (const f of [...matches, ...loose]) {
      const c = countyCode(f.properties?.county, dim);
      const ctr = centreOf(f.geometry);
      const t = ctr ? townshipAt(ctr[0], ctr[1], ctx.townships, dim) : null;
      out.push({ kind: 'city', name: f.properties?.name, county: c ? { code: c.code, name: c.name } : null,
        township: t ? { id: t.id, label: `T${t.label.replace(' ', ' R')}` } : null, exact: matches.includes(f),
        bbox: bboxOf(f.geometry), acres: f.properties?.acres ?? null });
    }
  }
  if (!want || want === 'reservation') {
    const s = norm(q).replace(/\breservation\b/, '').trim();
    (dim.reservations || []).forEach((name, i) => {
      const n = norm(name).replace(/'/g, '').replace(/\breservation\b/, '').trim();
      const sq = s.replace(/'/g, '');
      if (n === sq || (sq.length >= 4 && n.includes(sq))) {
        const f = (ctx.reservations?.features || []).find((x) => norm(x.properties?.name).replace(/'/g, '') === n);
        out.push({ kind: 'reservation', name, index: i, exact: n === sq, bbox: bboxOf(f?.geometry) });
      }
    });
  }
  const exactFirst = out.sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, 8);
  return { candidates: exactFirst, exact: exactFirst.some((c) => c.exact) };
}
