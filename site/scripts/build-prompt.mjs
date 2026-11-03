#!/usr/bin/env node
/* build-prompt.mjs -- the assistant's system prompt, generated.
 *
 *   node scripts/build-prompt.mjs            -> src/assistant/prompt.json
 *   node scripts/build-prompt.mjs --count    also asks the API for the exact token count (needs a key)
 *
 * The prompt is assembled from five sources so that it cannot drift from
 * the dashboard: the hand-written role and rules (src/assistant/rules.md),
 * the About tab's own prose (src/lib/about.js), the published caveats and
 * dimension tables (public/data/meta.json, dim.json), and the hand-written
 * data dictionary (src/assistant/dictionary.md), which is checked here
 * against the Parquet schemas: a table or column named in the dictionary
 * that is not in the data fails the build, and a column in the data that
 * the dictionary never mentions is reported.
 *
 * The output is byte-stable for the same inputs (no dates, no ids), because
 * it is the cached prefix of every request: a byte that changes is a cache
 * miss for everyone. Its hash travels in the health endpoint and the test
 * fixtures.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync } from 'hyparquet';
import { aboutSections } from '../src/lib/about.js';
import { TOOLS, TOOLS_JSON } from '../src/assistant/tools.js';
import { ERA_BOUNDS } from '../src/lib/state.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(SITE, 'public', 'data');
const OUT = path.join(SITE, 'src', 'assistant', 'prompt.json');
const read = (p) => readFileSync(p, 'utf8');

const dim = JSON.parse(read(path.join(DATA, 'dim.json')));
const meta = JSON.parse(read(path.join(DATA, 'meta.json')));
const rules = read(path.join(SITE, 'src', 'assistant', 'rules.md')).trim();
const dictionary = read(path.join(SITE, 'src', 'assistant', 'dictionary.md')).trim();

/* ---- HTML to text: the About prose as the model reads it --------------- */
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–' };
function textOf(html) {
  let t = html;
  t = t.replace(/<li>/g, '\n- ').replace(/<\/li>/g, '');
  t = t.replace(/<\/p>/g, '\n\n').replace(/<p>/g, '');
  t = t.replace(/<\/?(ul|ol)>/g, '\n');
  t = t.replace(/<br\s*\/?>/g, '\n');
  t = t.replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs, (_, href, inner) => (/^https?:/.test(href) ? `${inner} (${href})` : inner));
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&[a-z#0-9]+;/g, (e) => ENT[e] ?? e);
  t = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/* ---- the Parquet schemas, for the dictionary check ---------------------- */
async function schemas() {
  const out = new Map();
  const files = readdirSync(DATA).filter((f) => f.endsWith('.parquet')).map((f) => f.replace('.parquet', '')).sort();
  for (const name of files) {
    const md = await parquetMetadataAsync(await asyncBufferFromFile(path.join(DATA, `${name}.parquet`)));
    out.set(name, { rows: Number(md.num_rows), columns: md.row_groups[0].columns.map((c) => c.meta_data.path_in_schema.join('.')) });
  }
  const st = readdirSync(path.join(DATA, 'owner_state')).filter((f) => f.endsWith('.parquet'));
  if (st.length) {
    const md = await parquetMetadataAsync(await asyncBufferFromFile(path.join(DATA, 'owner_state', st[0])));
    out.set('owner_state', { rows: null, files: st.length, columns: md.row_groups[0].columns.map((c) => c.meta_data.path_in_schema.join('.')) });
  }
  return out;
}

/** Expand `n_sz0..7` into n_sz0 … n_sz7; plain names pass through. */
function expand(token) {
  const m = token.match(/^([A-Za-z_]+?)(\d+)\.\.(\d+)$/);
  if (!m) return [token];
  const out = [];
  for (let i = Number(m[2]); i <= Number(m[3]); i++) out.push(`${m[1]}${i}`);
  return out;
}

/* The keys are described once in the dictionary's preamble, not per table. */
const KEY_COLS = new Set(['u', 's', 'i', 'interval', 'county_n']);

function checkDictionary(text, tables) {
  const problems = [], notes = [];
  const sections = text.split(/^### /m).slice(1);
  const documented = new Set();
  for (const sec of sections) {
    const name = sec.split(/\s/)[0].trim();
    const names = name.split('|');
    for (const n of names) {
      if (!tables.has(n)) { problems.push(`dictionary names table "${n}", which is not published`); continue; }
      documented.add(n);
      const cols = new Set(tables.get(n).columns);
      const mentioned = new Set();
      for (const tok of sec.matchAll(/`([^`]+)`/g)) {
        for (const c of expand(tok[1].trim())) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) { if (cols.has(c)) mentioned.add(c); }
        }
      }
      const missing = [...cols].filter((c) => !mentioned.has(c) && !KEY_COLS.has(c));
      if (missing.length) notes.push(`${n}: ${missing.length} column(s) not mentioned: ${missing.join(', ')}`);
    }
  }
  for (const n of tables.keys()) if (!documented.has(n)) problems.push(`table "${n}" is published but not in the dictionary`);
  return { problems, notes };
}

/* ---- assemble ----------------------------------------------------------- */
const tables = await schemas();
const check = checkDictionary(dictionary, tables);
for (const n of check.notes) console.warn('note:', n);
if (check.problems.length) {
  for (const p of check.problems) console.error('error:', p);
  process.exit(1);
}

const about = aboutSections(dim, meta).filter((s) => s.prompt)
  .map((s) => `## ${s.title}\n\n${textOf(s.html)}`).join('\n\n');

const fa = (meta.field_availability || []).map((r) => `export ${r.snapshot} (${r.date}): ${r.unavailable.join(', ')} unavailable; ${r.reason}`);
const caveats = `# Caveats the data carries\n\n${meta.caveats.map((c) => `- ${c}`).join('\n')}`
  + (fa.length ? `\n\nField availability: ${fa.join('; ')}.` : '')
  + `\n\nThe comparable series begins in ${meta.comparable_series_begins}; the first fully covered export is ${meta.first_fully_covered_snapshot}.`;

const snaps = dim.snapshots.map((s) => `${s.id}=${s.date}${s.era ? ` (${s.era})` : ''}`).join(', ');
const ivs = `${dim.intervals.length} intervals, i = the index of the export that closes the interval minus one (interval i runs from export i to export i+1); years = its length in years.`;
const counties = dim.counties.map((c) => `${c.code} ${c.name} (${c.abbr})`).join('; ');
const labels = Object.entries(dim.labels).map(([k, v]) => `- ${k}: ${v.map((l, i) => `${i}=${l}`).join(', ')}`).join('\n');
const points = (meta.cama?.points || []).map((p) => `tax year ${p.tax_year} = export ${p.s} (${p.date}), rating field ${p.rating_field}`).join('; ');
const eras = Object.entries(ERA_BOUNDS).filter(([k]) => k !== 'all').map(([k, [a, b]]) => `${k} = intervals ${a} to ${b - 1}`).join('; ');
const dims = `# Dimensions\n\n## Exports (index=date (era))\n${snaps}\n\n## Intervals\n${ivs}\n\n## Counties (code name (abbr))\n${counties}\n\n`
  + `## Townships\n${dim.townships.length} PLSS townships, id 0..${dim.townships.length - 1}; id ${dim.townships.length} is UNASSIGNED (parcels with no township). A label like "2S 6E" is township 2 south, range 6 east; lookup_place resolves it.\n\n`
  + `## Owner-origin states\n${dim.states.join(', ')} (codes that are not states are military or foreign mailing codes; 00 means none).\n\n`
  + `## Reservations\n${dim.reservations.map((r, i) => `${i}=${r}`).join(', ')}\n\n## Code lists (index=label)\n${labels}\n\n`
  + `## Building-record points (Condition)\n${points}.\n\n## Thresholds era filter\n${eras}.`;

// What the publish knows about time, identifiers, censoring and the threshold
// test: stated from meta so the prompt and the About tab cannot disagree.
const temporal = Array.isArray(meta.temporal) && meta.temporal.length
  ? `# What time each source speaks for\n\nObservation time (when a source was captured) and effective time (when the `
    + `condition held) are not interchangeable; say which a figure rests on when it matters, and never present a `
    + `contemporary classification applied to an old export as an observation of that year.\n\n`
    + meta.temporal.map((t) => `- ${t.name}: observed ${t.observation}; applies to ${t.applies_to}; ${t.inference}.`).join('\n')
  : '';
const extra = [];
if (meta.lineage && meta.lineage.resurrected_ids != null) {
  extra.push(`Identifiers and parcels: ${Number(meta.lineage.parcel_ids).toLocaleString()} geocodes were ever observed, in `
    + `${Number(meta.lineage.occurrences).toLocaleString()} occurrences; ${Number(meta.lineage.resurrected_ids).toLocaleString()} `
    + 'identifiers returned after a gap and are counted as new parcels from their return. The map at parcel depth is '
    + 'today\u2019s fabric carrying historical attributes, not a reconstruction of an earlier fabric.');
}
const h10 = meta.absorption_survival?.horizons?.['10y'];
if (h10) {
  extra.push(`Absorption with censoring: of lots whose creation was observed, the median cohort has ${(100 * h10.ci_built_median).toFixed(0)}% `
    + `built by ten years (cohorts ${(100 * h10.ci_built_min).toFixed(0)}% to ${(100 * h10.ci_built_max).toFixed(0)}%; Aalen-Johansen, `
    + 'leaving the record as a competing outcome). A lot unbuilt at its last export is unbuilt so far; never say "never built".');
}
const s20 = meta.thresholds_sensitivity?.sensitivity?.['20']?.rel3;
const t20 = meta.thresholds?.['20_acre_edge'];
if (t20 && s20) {
  extra.push(`The 20-acre test: parcels created just above the line outnumber those just below by ${Number(t20.above_over_below).toFixed(2)} to 1 `
    + `(3% window), ${Number(s20.ratio_excl_exact).toFixed(2)} to 1 with parcels of exactly 20 acres set aside; the controls at 12, 15, 25, 30, `
    + '50 and 100 acres sit near 1. Bunching is a pattern consistent with lots sized to clear review, not evidence of any division\u2019s motive.');
}
const caveatsFull = extra.length ? `${caveats}\n\n${extra.join('\n\n')}` : caveats;
const system = [rules, `# The dashboard\n\n${about}`, caveatsFull, ...(temporal ? [temporal] : []), dims,
  `# Data dictionary\n\n${dictionary}`].join('\n\n');
const toolsHash = createHash('sha256').update(TOOLS_JSON).digest('hex').slice(0, 16);
const hash = createHash('sha256').update(system).update(TOOLS_JSON).digest('hex').slice(0, 16);
const out = {
  built_from: { title: meta.title, snapshots: dim.snapshots.length, counties: dim.counties.length, tables: tables.size },
  system: { never: system },
  tools: TOOLS.map((t) => t.name),
  tools_hash: toolsHash,
  hash,
  chars: { system: system.length, tools: TOOLS_JSON.length },
};
const json = JSON.stringify(out, null, 1) + '\n';
const before = existsSync(OUT) ? read(OUT) : null;
writeFileSync(OUT, json);
const est = Math.round((system.length + TOOLS_JSON.length) / 3.8);
console.log(`prompt.json: system ${system.length.toLocaleString()} chars + tools ${TOOLS_JSON.length.toLocaleString()} chars ≈ ${est.toLocaleString()} tokens; hash ${hash}${before === json ? ' (unchanged)' : ''}`);

if (process.argv.includes('--count')) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const r = await client.messages.count_tokens({
    model: 'claude-opus-5-5', system: [{ type: 'text', text: system }], tools: TOOLS,
    messages: [{ role: 'user', content: 'How many parcels does Gallatin County have?' }],
  });
  console.log(`count_tokens: ${r.input_tokens.toLocaleString()} input tokens`);
}
