/* tables-node.mjs -- the published Parquet tables in node, shaped exactly as
   the browser's data.js shapes them ({columns, rows}), so the eval can
   compute a figure independently of the page with the same cube arithmetic. */
import path from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetRead } from 'hyparquet';
import { gunzip } from 'hyparquet-compressors/src/gzip.js';

const COMPRESSORS = { GZIP: (input, outputLength) => gunzip(input, new Uint8Array(outputLength)) };
const cache = new Map();

export async function loadTableNode(name, dataDir) {
  const key = `${dataDir}/${name}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const file = await asyncBufferFromFile(path.join(dataDir, `${name}.parquet`));
    const metadata = await parquetMetadataAsync(file);
    const columns = metadata.row_groups[0].columns.map((c) => c.meta_data.path_in_schema.join('.'));
    let rows = [];
    await parquetRead({ file, metadata, compressors: COMPRESSORS, onComplete: (d) => { rows = d; } });
    return { columns, rows };
  })();
  cache.set(key, p);
  return p;
}
