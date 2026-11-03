// Read the archive back with the official pmtiles client (the one the
// dashboard uses), so the in-house writer is checked by an independent
// reader: header, metadata, and a tile at each zoom over Bozeman and the
// state as a whole. Run from the repository root:
//   node basemap/check_pmtiles.mjs basemap/dist/mt-basemap.pmtiles
import { PMTiles } from '../site/node_modules/pmtiles/dist/esm/index.js';
import fs from 'node:fs/promises';

class FileSource {
  constructor(path) { this.path = path; }
  getKey() { return this.path; }
  async getBytes(offset, length) {
    const fh = await fs.open(this.path);
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) };
    } finally { await fh.close(); }
  }
}

const tileAt = (lon, lat, z) => {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [z, x, y];
};

const p = new PMTiles(new FileSource(process.argv[2]));
const h = await p.getHeader();
console.log('header', { minZoom: h.minZoom, maxZoom: h.maxZoom, tileType: h.tileType, tileCompression: h.tileCompression,
  entries: h.numTileEntries, contents: h.numTileContents, clustered: h.clustered,
  bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat].map((v) => v.toFixed(3)) });
const md = await p.getMetadata();
console.log('vector_layers', (md.vector_layers || []).map((v) => `${v.id}[${v.minzoom}-${v.maxzoom}]`).join(' '));
// Broadened 2026-11-03: every zoom the archive declares, at eight places
// across the state, and each tile body must be a well-formed gzip member
// that inflates to a non-empty protobuf whose first field is a layer (tag
// 0x1a), which is what the dashboard's reader will demand of it. The sha1
// of the inflated body is printed so basemap/compare_mbtiles.py can check
// the same tiles against the MBTiles the writer was fed.
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
const PLACES = [[-111.04, 45.68, 'Bozeman'], [-108.5, 45.78, 'Billings'], [-114.0, 46.87, 'Missoula'],
  [-112.03, 46.59, 'Helena'], [-114.31, 48.2, 'Kalispell'], [-105.84, 46.41, 'Miles City'],
  [-104.72, 48.1, 'Plentywood'], [-110.5, 46.9, 'state']];
const zooms = [];
for (let z = h.minZoom; z <= h.maxZoom; z++) zooms.push(z);
let bad = 0, checked = 0, bytes = 0;
const rows = [];
for (const [lon, lat, label] of PLACES) {
  for (const z of zooms) {
    const [zz, x, y] = tileAt(lon, lat, z);
    const t = await p.getZxy(zz, x, y);
    const n = t ? t.data.byteLength : 0;
    checked += 1;
    if (!n) { bad += 1; console.log(`${label.padEnd(10)} z${zz} ${x}/${y}: EMPTY`); continue; }
    bytes += n;
    // The client inflates tile bodies itself when the header declares gzip;
    // a body that still carries the gzip magic is inflated here instead.
    let body = Buffer.from(t.data);
    try {
      if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
    } catch (err) { bad += 1; console.log(`${label.padEnd(10)} z${zz} ${x}/${y}: BAD GZIP (${err.message})`); continue; }
    const layerTag = body.length > 0 && body[0] === 0x1a;
    if (!body.length || !layerTag) { bad += 1; console.log(`${label.padEnd(10)} z${zz} ${x}/${y}: not an MVT body`); continue; }
    rows.push(`${zz}/${x}/${y} ${createHash('sha1').update(body).digest('hex')}`);
  }
}
console.log(`${checked} tiles read at ${zooms.length} zooms over ${PLACES.length} places, ${(bytes / 1024).toFixed(0)} KB; ${bad} bad`);
if (process.argv.includes('--hashes')) console.log(rows.join('\n'));
console.log(bad ? `CHECK FAILED: ${bad} bad tiles` : 'CHECK OK');
process.exit(bad ? 1 : 0);
