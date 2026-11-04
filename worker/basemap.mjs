/* ---------------------------------------------------------------------------
   basemap.mjs -- the in-house basemap archive, from R2, with HTTP Range.

   The archive is one PMTiles file the map reads by byte range. It is too big
   for a static asset (25 MiB cap) and the asset runtime ignores Range, so it
   lives in the R2 bucket bound as BASEMAP and this handler serves it: a
   single byte range (206), a whole-file GET (200), HEAD, and the ETag
   conditionals (304), with the headers the asset runtime would have set.
   Locally, seed the simulated bucket once:  npm run dev:seed-basemap
--------------------------------------------------------------------------- */

const KEY = /^\/basemap\/([a-z0-9][a-z0-9-]*\.pmtiles)$/;

/** The object key for a basemap path, or null. */
export function basemapKey(pathname) {
  const m = KEY.exec(pathname);
  return m ? m[1] : null;
}

/** The [first, last] bytes an R2 range names, for Content-Range. */
export function rangeBounds(range, size) {
  if (!range) return null;
  // R2's range object answers `'suffix' in r` even without one: test the value.
  if (range.suffix != null) {
    const len = Math.min(range.suffix, size);
    return [size - len, size - 1];
  }
  const first = range.offset ?? 0;
  const last = range.length == null ? size - 1 : Math.min(size - 1, first + range.length - 1);
  return [first, last];
}

const base = () => ({
  'cache-control': 'public, max-age=86400',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
});

/**
 * @param {Request} request
 * @param {{BASEMAP?: R2Bucket}} env
 */
export async function handleBasemap(request, env, key) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', ...base() } });
  }
  if (!env.BASEMAP) return new Response('basemap not configured', { status: 404, headers: base() });
  let obj;
  try {
    obj = request.method === 'HEAD'
      ? await env.BASEMAP.head(key)
      : await env.BASEMAP.get(key, { range: request.headers, onlyIf: request.headers });
  } catch {
    // An unsatisfiable or multi-part range.
    const head = await env.BASEMAP.head(key);
    return new Response(null, { status: 416, headers: { ...base(), 'content-range': `bytes */${head ? head.size : 0}` } });
  }
  if (!obj) return new Response('not found', { status: 404, headers: base() });
  const h = new Headers(base());
  obj.writeHttpMetadata(h);
  if (!h.has('content-type')) h.set('content-type', 'application/octet-stream');
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  if (request.method === 'HEAD') {
    h.set('content-length', String(obj.size));
    return new Response(null, { status: 200, headers: h });
  }
  // onlyIf failed: R2 hands back the metadata without a body.
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers: h });
  const b = request.headers.has('range') ? rangeBounds(obj.range, obj.size) : null;
  if (b) {
    h.set('content-range', `bytes ${b[0]}-${b[1]}/${obj.size}`);
    h.set('content-length', String(b[1] - b[0] + 1));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers: h });
}
