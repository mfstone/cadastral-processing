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
let bad = 0;
for (const [lon, lat, label] of [[-111.04, 45.68, 'Bozeman'], [-108.5, 45.78, 'Billings'], [-110.5, 46.9, 'state']]) {
  for (const z of [4, 7, 10, 13]) {
    const [zz, x, y] = tileAt(lon, lat, z);
    const t = await p.getZxy(zz, x, y);
    const n = t ? t.data.byteLength : 0;
    if (!n) bad += 1;
    console.log(`${label.padEnd(8)} z${zz} ${x}/${y}: ${n ? `${(n / 1024).toFixed(1)} KB` : 'EMPTY'}`);
  }
}
console.log(bad ? `CHECK FAILED: ${bad} empty tiles` : 'CHECK OK');
process.exit(bad ? 1 : 0);
