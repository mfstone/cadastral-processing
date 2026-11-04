/* Stage the Pages upload: site/dist, less what Pages cannot or must not
   serve itself (the basemap archive is over the 25 MiB file cap and lives in
   R2 behind the Worker; .assetsignore is the Worker's), plus the forwarder and
   its routes. Files are hard-linked, so staging 600 MB takes a moment. */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'site/dist');
const out = path.join(root, '.deploy/pages');
const SKIP = new Set(['.assetsignore', 'basemap/mt-basemap.pmtiles']);
const MAX = 25 * 1024 * 1024;

if (!fs.existsSync(path.join(src, 'index.html'))) throw new Error('site/dist is empty: run npm run build first');
fs.rmSync(out, { recursive: true, force: true });
let files = 0, bytes = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name), rel = path.relative(src, abs).split(path.sep).join('/');
    if (SKIP.has(rel)) continue;
    const to = path.join(out, rel);
    if (e.isDirectory()) { fs.mkdirSync(to, { recursive: true }); walk(abs); continue; }
    const size = fs.statSync(abs).size;
    if (size > MAX) throw new Error(`${rel} is ${(size / 2 ** 20).toFixed(1)} MiB, over the Pages file cap`);
    fs.linkSync(abs, to);
    files++; bytes += size;
  }
};
fs.mkdirSync(out, { recursive: true });
walk(src);
for (const f of ['_worker.js', '_routes.json']) fs.copyFileSync(path.join(root, 'pages', f), path.join(out, f));
files += 2;
if (files > 20000) throw new Error(`${files} files: over the Pages limit of 20,000`);
console.log(`staged ${files} files, ${(bytes / 2 ** 20).toFixed(0)} MiB -> ${path.relative(root, out)}`);
