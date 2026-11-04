import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basemapKey, rangeBounds, handleBasemap } from '../basemap.mjs';

// A stand-in for an R2 bucket holding one 1,000-byte object.
const SIZE = 1000;
function fakeBucket() {
  const meta = (range) => ({
    size: SIZE, httpEtag: '"abc"', range,
    writeHttpMetadata(h) { h.set('content-type', 'application/octet-stream'); },
  });
  return {
    async head(k) { return k === 'mt-basemap.pmtiles' ? meta() : null; },
    async get(k, { range, onlyIf }) {
      if (k !== 'mt-basemap.pmtiles') return null;
      if (onlyIf.get('if-none-match') === '"abc"') return meta();          // no body
      const r = range.get('range');
      if (!r) return { ...meta(), body: 'whole' };
      if (r.includes(',')) throw new Error('multipart');
      const m = /bytes=(\d*)-(\d*)/.exec(r);
      const R = m[1] === '' ? { suffix: Number(m[2]) }
        : { offset: Number(m[1]), length: m[2] === '' ? undefined : Number(m[2]) - Number(m[1]) + 1 };
      return { ...meta(R), body: 'part' };
    },
  };
}
const req = (headers = {}, method = 'GET') => new Request('https://x.test/basemap/mt-basemap.pmtiles', { method, headers });

test('only archive paths are basemap keys', () => {
  assert.equal(basemapKey('/basemap/mt-basemap.pmtiles'), 'mt-basemap.pmtiles');
  for (const p of ['/basemap/styles/light.json', '/basemap/../x.pmtiles', '/data/x.pmtiles', '/basemap/A.pmtiles']) assert.equal(basemapKey(p), null);
});

test('range bounds: offset+length, open-ended, suffix', () => {
  assert.deepEqual(rangeBounds({ offset: 0, length: 16384 }, SIZE), [0, 999]);
  assert.deepEqual(rangeBounds({ offset: 10, length: 20 }, SIZE), [10, 29]);
  assert.deepEqual(rangeBounds({ offset: 900 }, SIZE), [900, 999]);
  assert.deepEqual(rangeBounds({ suffix: 100 }, SIZE), [900, 999]);
  // R2 objects expose `suffix` as an absent-valued property.
  assert.deepEqual(rangeBounds({ offset: 0, length: 127, suffix: undefined }, SIZE), [0, 126]);
});

test('a byte range is a 206 with Content-Range', async () => {
  const r = await handleBasemap(req({ range: 'bytes=10-29' }), { BASEMAP: fakeBucket() }, 'mt-basemap.pmtiles');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 10-29/1000');
  assert.equal(r.headers.get('content-length'), '20');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
});

test('whole file, HEAD, 304, 416, 404, 405', async () => {
  const env = { BASEMAP: fakeBucket() };
  assert.equal((await handleBasemap(req(), env, 'mt-basemap.pmtiles')).status, 200);
  const h = await handleBasemap(req({}, 'HEAD'), env, 'mt-basemap.pmtiles');
  assert.equal(h.status, 200); assert.equal(h.headers.get('content-length'), '1000');
  assert.equal((await handleBasemap(req({ 'if-none-match': '"abc"' }), env, 'mt-basemap.pmtiles')).status, 304);
  const bad = await handleBasemap(req({ range: 'bytes=0-1,5-6' }), env, 'mt-basemap.pmtiles');
  assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), 'bytes */1000');
  assert.equal((await handleBasemap(req(), env, 'other.pmtiles')).status, 404);
  assert.equal((await handleBasemap(req({}, 'POST'), env, 'mt-basemap.pmtiles')).status, 405);
  assert.equal((await handleBasemap(req(), {}, 'mt-basemap.pmtiles')).status, 404);
});
