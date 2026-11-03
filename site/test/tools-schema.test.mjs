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

test('six strict tools in a fixed order', () => {
  assert.deepEqual(TOOL_NAMES, ['get_dashboard_state', 'configure_dashboard', 'lookup_place', 'read_series', 'read_table', 'compose_report']);
  for (const t of TOOLS) {
    assert.equal(t.strict, true, t.name);
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
