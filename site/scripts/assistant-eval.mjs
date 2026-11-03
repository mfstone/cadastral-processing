#!/usr/bin/env node
/* assistant-eval.mjs -- the golden questions against a live deployment.
 *
 *   EVAL_URL=https://... node scripts/assistant-eval.mjs [--record] [--only id]
 *
 * Drives the real page with puppeteer, asks each question through the
 * panel's test handle, and scores the turn: did the dashboard land in the
 * expected state, do the expected numbers (computed here, in node, from the
 * same Parquet tables and the same formulas) appear in the answer, is every
 * forbidden pattern absent, is every must-mention present. It costs real
 * money (one question is several model calls), so it is opt-in. With
 * --record the Worker's NDJSON responses are saved as fixtures.
 *
 * Pass: at least 90% of cases, and no forbidden hit anywhere.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { loadTableNode } from './lib/tables-node.mjs';
import { cube, sumAt } from '../src/lib/data.js';
import { DERIVED } from '../src/assistant/derived.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(SITE, 'public', 'data');
const BASE = (process.env.EVAL_URL || '').replace(/\/$/, '');
if (!BASE) { console.error('set EVAL_URL to the deployed origin'); process.exit(2); }
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const record = process.argv.includes('--record');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const dim = JSON.parse(readFileSync(path.join(DATA, 'dim.json'), 'utf8'));
const cases = JSON.parse(readFileSync(path.join(SITE, 'test', 'assistant-golden.json'), 'utf8'))
  .filter((c) => !only || c.id === only);

/* ---- expected numbers, computed here --------------------------------- */
const nSnaps = dim.snapshots.length;
const byTr = new Map(dim.townships.map((t) => [t.tr, t.id]));
async function cubeFor(level, topic) {
  if (level === 'county') {
    if (topic === 'holdings') return cube(await loadTableNode('holdings_county', DATA), { nUnits: 57, nSnaps, keyCol: 'county_n', delta: false });
    return cube(await loadTableNode('county_stock', DATA), { nUnits: 57, nSnaps, keyCol: 'county_n', delta: false });
  }
  return cube(await loadTableNode(`twp_${topic}`, DATA), { nUnits: dim.townships.length + 1, nSnaps, delta: dim.delta_coded });
}
async function expectedNumber(spec) {
  if (spec.series) {
    const s = spec.series;
    const units = s.units && s.units.length ? s.units.map((u) => (typeof u === 'string' && byTr.has(u) ? byTr.get(u) : u)) : null;
    const c = await cubeFor(s.level, s.topic);
    const hu = s.topic === 'holdings' ? (units || [0]) : units;
    if (s.derived) return DERIVED[s.derived].compute((col) => sumAt(c, col, s.snap, hu), {});
    return sumAt(c, s.measures[0], s.snap, hu);
  }
  if (spec.table) {
    const t = await loadTableNode(spec.table, DATA);
    const row = t.rows.find((r) => Object.entries(spec.where).every(([k, v]) => Number(r[t.columns.indexOf(k)]) === v));
    return row ? Number(row[t.columns.indexOf(spec.column)]) : null;
  }
  return null;
}
/** Does `value` appear in `text`, allowing the formats people write numbers in? */
function appears(value, text, { format, tolerance }) {
  if (value == null) return /unknown|null|not (available|published)/i.test(text);
  const nums = [];
  for (const m of text.matchAll(/(\d[\d,]*\.?\d*)\s*(%|k|M|million|thousand)?/g)) {
    let v = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    if (m[2] === 'k' || m[2] === 'thousand') v *= 1e3;
    if (m[2] === 'M' || m[2] === 'million') v *= 1e6;
    nums.push(v);
  }
  const tol = format === 'percent' ? (tolerance ?? 0.15) : Math.max(tolerance ?? 0, Math.abs(value) * 0.005);
  return nums.some((v) => Math.abs(v - value) <= tol);
}

/* ---- drive the page --------------------------------------------------- */
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
let forbiddenHits = 0;
for (const c of cases) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const captured = [];
  if (record) page.on('response', async (res) => { if (new URL(res.url()).pathname === '/api/assistant' && res.ok()) captured.push(await res.text()); });
  const t0 = Date.now();
  let turn = null, state = null, error = null;
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#assist-toggle:not([hidden])', { timeout: 60000 });
    await page.click('#assist-toggle');
    await page.waitForFunction(() => !!window.__assistant, { timeout: 30000 });
    turn = await page.evaluate((q) => window.__assistant.ask(q), c.prompt);
    state = await page.evaluate(() => window.__dash.getState());
  } catch (err) { error = String(err && err.message ? err.message : err); }
  const ms = Date.now() - t0;
  const text = turn?.text || '';
  const problems = [];
  if (error) problems.push(`page: ${error}`);
  if (turn && turn.status !== 'done') problems.push(`status ${turn.status}${turn.error ? ': ' + turn.error : ''}`);
  const ex = c.expect || {};
  for (const [k, v] of Object.entries(ex.state || {})) {
    const got = state?.[k];
    if (JSON.stringify(got) !== JSON.stringify(v)) problems.push(`state.${k} = ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`);
  }
  for (const [k, v] of Object.entries(ex.report || {})) if (state?.report?.[k] !== v) problems.push(`report.${k} = ${state?.report?.[k]}, expected ${v}`);
  for (const n of ex.numbers || []) {
    const want = await expectedNumber(n);
    if (!appears(want, text, n)) problems.push(`number ${want == null ? 'null' : want.toFixed(2)} (${n.series?.derived || n.series?.measures?.[0] || n.column}) not in the answer`);
  }
  for (const m of ex.must_mention || []) if (!text.includes(m)) problems.push(`missing "${m}"`);
  if (ex.must_mention_any && !ex.must_mention_any.some((m) => text.toLowerCase().includes(m.toLowerCase()))) problems.push(`none of ${ex.must_mention_any.join(' / ')}`);
  for (const f of ex.forbidden || []) if (new RegExp(f).test(text)) { problems.push(`forbidden /${f}/ matched`); forbiddenHits++; }
  for (const t of ex.no_tools || []) if (turn?.tools?.some((x) => x.name === t)) problems.push(`tool ${t} was called`);
  const usage = turn?.usage || {};
  results.push({ id: c.id, pass: problems.length === 0, problems, ms, calls: (turn?.tools?.length || 0) + 1, output: usage.output_tokens, text });
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${c.id}  ${(ms / 1000).toFixed(1)}s  tools=${turn?.tools?.map((t) => t.name).join(',') || '-'}`);
  for (const p of problems) console.log(`      - ${p}`);
  if (record && captured.length) {
    const dir = path.join(SITE, 'test', 'fixtures', 'assistant', c.id);
    mkdirSync(dir, { recursive: true });
    captured.forEach((body, i) => writeFileSync(path.join(dir, `${i + 1}.ndjson`), body));
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ prompt: c.prompt, text, tools: turn?.tools }, null, 1));
  }
  await page.close();
}
await browser.close();
const passed = results.filter((r) => r.pass).length;
const rate = results.length ? passed / results.length : 0;
console.log(`\n${passed}/${results.length} passed (${(100 * rate).toFixed(0)}%), ${forbiddenHits} forbidden hit(s)`);
writeFileSync(path.join(SITE, 'test', 'assistant-eval.last.json'), JSON.stringify(results, null, 1));
process.exit(rate >= 0.9 && forbiddenHits === 0 ? 0 : 1);
