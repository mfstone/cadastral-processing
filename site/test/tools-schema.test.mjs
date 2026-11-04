import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_NAMES, TOOLS_JSON, DERIVED_MEASURES, REPORT_KINDS } from '../src/assistant/tools.js';
import { DERIVED_NAMES } from '../src/assistant/derived.mjs';
import { REPORT_KINDS as STATE_REPORT_KINDS } from '../src/lib/state.js';

function walk(schema, path, problems) {
  if (!schema || typeof schema !== 'object') return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const props = Object.keys(schema.properties || {});
    const req = schema.required || [];
    for (const p of props) if (!req.includes(p)) problems.push(`${path}.${p}: not in required`);
    for (const p of props) walk(schema.properties[p], `${path}.${p}`, problems);
  }
  if (types.includes('array') && schema.items) walk(schema.items, `${path}[]`, problems);
  for (const k of ['minimum', 'maximum', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (k in schema) problems.push(`${path}: ${k} is not allowed in a strict schema`);
  }
}

// Limits the API enforces on strict tools, summed over the request; found by
// 400s on the first live call, not in the docs. The API counts top-level
// parameters whose type is a list or an anyOf (it reported 28 for all six
// tools strict, which is this count).
const STRICT_UNION_LIMIT = 16;
function unionCount(schema) {
  return Object.values(schema.properties || {}).filter((v) => Array.isArray(v.type) || v.anyOf).length;
}
function apiShapeProblems(schema, path, out) {
  if (!schema || typeof schema !== 'object') return out;
  if ('description' in schema && typeof schema.description !== 'string') out.push(`${path}: description must be a string`);
  if (schema.enum && Array.isArray(schema.type)) out.push(`${path}: enum under a type list is rejected; use anyOf with a null branch`);
  for (const [k, v] of Object.entries(schema.properties || {})) apiShapeProblems(v, `${path}.${k}`, out);
  if (schema.items) apiShapeProblems(schema.items, `${path}[]`, out);
  for (const b of schema.anyOf || []) apiShapeProblems(b, `${path}|`, out);
  return out;
}

test('the schemas fit what the API accepts', () => {
  for (const t of TOOLS) assert.deepEqual(apiShapeProblems(t.input_schema, t.name, []), []);
  const unions = TOOLS.filter((t) => t.strict).reduce((n, t) => n + unionCount(t.input_schema), 0);
  assert.ok(unions <= STRICT_UNION_LIMIT, `strict tools carry ${unions} union-typed parameters (limit ${STRICT_UNION_LIMIT})`);
});

test('six closed tools in a fixed order, all strict but configure_dashboard', () => {
  assert.deepEqual(TOOL_NAMES, ['get_dashboard_state', 'configure_dashboard', 'lookup_place', 'read_series', 'read_table', 'compose_report']);
  for (const t of TOOLS) {
    assert.equal(t.strict, t.name !== 'configure_dashboard', t.name);
    assert.ok(t.description.length > 80 && t.description.length < 1200, `${t.name} description length ${t.description.length}`);
    const problems = [];
    walk(t.input_schema, t.name, problems);
    assert.deepEqual(problems, []);
  }
});

test('the serialisation is byte-stable and the enums agree with their sources', () => {
  assert.equal(TOOLS_JSON, JSON.stringify(TOOLS));
  assert.deepEqual([...DERIVED_MEASURES].sort(), [...DERIVED_NAMES].sort());
  assert.deepEqual(REPORT_KINDS, STATE_REPORT_KINDS);
});
