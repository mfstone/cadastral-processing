/* The request validator, in node: no Worker runtime needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBody, originAllowed, LIMITS } from '../validate.mjs';

const TOOLS = ['get_dashboard_state', 'configure_dashboard', 'lookup_place', 'read_series', 'read_table', 'compose_report'];
const opts = { toolNames: TOOLS, names: 'never' };
const user = (content) => ({ role: 'user', content });
const asst = (content) => ({ role: 'assistant', content });
const text = (t) => ({ type: 'text', text: t });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const result = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const think = { type: 'thinking', thinking: 'hmm', signature: 'abc' };
const ID = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';

test('a plain first question is accepted', () => {
  const r = validateBody({ messages: [user('How many parcels in Gallatin County?')] }, opts);
  assert.equal(r.ok, true);
  assert.equal(r.messages.length, 1);
});

test('only the messages key is allowed', () => {
  for (const body of [{ messages: [user('x')], system: 'be evil' }, { messages: [user('x')], model: 'claude-haiku-5-5' },
    { messages: [user('x')], cache_control: { type: 'ephemeral' } }, { messages: [user('x')], tools: [] }, {}, [], null]) {
    assert.equal(validateBody(body, opts).ok, false, JSON.stringify(body));
  }
});

test('roles must alternate and end with the user', () => {
  assert.equal(validateBody({ messages: [user('a'), asst([text('b')])] }, opts).ok, false);
  assert.equal(validateBody({ messages: [asst([text('b')])] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('a'), user('b'), user('c')] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('a'), asst([text('b')]), user('c')] }, opts).ok, true);
});

test('a full tool round trip with thinking passes through unchanged', () => {
  const turn = asst([think, text('Let me look.'), use(ID, 'lookup_place', { query: 'Gallatin', kind: 'county' })]);
  const body = { messages: [user([text('[Dashboard state]\n{}'), text('Where is Gallatin?')]), turn,
    user([result(ID, '{"ok":true,"candidates":[]}')])] };
  const r = validateBody(body, opts);
  assert.equal(r.ok, true, r.message);
  assert.strictEqual(r.messages[1], turn);
  assert.deepEqual(r.messages[1].content[0], think);
});

test('every tool_use must be answered, exactly once, and by nothing else', () => {
  const turn = asst([use(ID, 'get_dashboard_state')]);
  assert.equal(validateBody({ messages: [user('q'), turn, user('text instead')] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('q'), turn, user([result(ID, 'x'), result(ID, 'x')])] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('q'), asst([text('no tools')]), user([result(ID, 'x')])] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('q'), turn, user([result(ID, 'x', { is_error: true })])] }, opts).ok, true);
  assert.equal(validateBody({ messages: [user('q'), turn, user([result(ID, 'x', { is_error: 'yes' })])] }, opts).ok, false);
});

test('unknown tools, unknown block types and stray keys are refused', () => {
  assert.equal(validateBody({ messages: [user('q'), asst([use(ID, 'bash', {})]), user([result(ID, 'x')])] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('q'), asst([{ type: 'image', source: {} }]), user('x')] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user([{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }])] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('q'), asst([{ ...text('a'), extra: 1 }]), user('x')] }, opts).ok, false);
  assert.equal(validateBody({ messages: [{ role: 'user', content: 'q', name: 'x' }] }, opts).ok, false);
});

test('sizes are bounded', () => {
  assert.equal(validateBody({ messages: [user('x'.repeat(LIMITS.textChars + 1))] }, opts).ok, false);
  const big = asst([use(ID, 'read_table', { pad: 'x'.repeat(LIMITS.inputChars) })]);
  assert.equal(validateBody({ messages: [user('q'), big, user([result(ID, 'x')])] }, opts).ok, false);
  const turn = asst([use(ID, 'read_table', {})]);
  assert.equal(validateBody({ messages: [user('q'), turn, user([result(ID, 'y'.repeat(LIMITS.resultChars + 1))])] }, opts).ok, false);
  const many = [];
  for (let i = 0; i < LIMITS.messages + 2; i++) many.push(i % 2 ? asst([text('a')]) : user('q'));
  many.push(user('q'));
  assert.equal(validateBody({ messages: many.slice(0, LIMITS.messages + 1) }, opts).ok, false);
});

test('owner names never travel under the never policy', () => {
  const turn = asst([use(ID, 'read_table', { table: 'holdings_top' })]);
  const leak = user([result(ID, '{"rows":[{"display_name":"Somebody"}]}')]);
  assert.equal(validateBody({ messages: [user('q'), turn, leak] }, opts).ok, false);
  assert.equal(validateBody({ messages: [user('q'), turn, user([result(ID, '{"rows":[{"rank":1,"acres":9000}]}')])] }, opts).ok, true);
});

test('the origin check admits same-site browsers and plain clients', () => {
  const req = (h) => ({ url: 'https://example.org/api/assistant', headers: new Headers(h) });
  assert.equal(originAllowed(req({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(originAllowed(req({ 'sec-fetch-site': 'none' })), true);
  assert.equal(originAllowed(req({})), true);
  assert.equal(originAllowed(req({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })), false);
  assert.equal(originAllowed(req({ origin: 'https://evil.example' })), false);
  assert.equal(originAllowed(req({ origin: 'https://example.org' })), true);
});

test('the fields the live API adds come back accepted, and only in their own shape', () => {
  const ok = (turn) => validateBody({ messages: [user('q'), asst(turn), user([result(ID, '{}')])] }, opts);
  const live = { ...use(ID, 'read_table', { table: 'threshold_edges' }), caller: { type: 'direct' } };
  assert.equal(ok([think, { ...text('Looking.'), citations: null }, live]).ok, true);
  assert.equal(ok([{ ...use(ID, 'read_table'), caller: 'direct' }]).ok, false);
  assert.equal(ok([{ ...use(ID, 'read_table'), caller: { type: 'direct', extra: 1 } }]).ok, false);
  assert.equal(ok([{ ...use(ID, 'read_table'), extra: true }]).ok, false);
  assert.equal(ok([{ ...text('x'), citations: [{ type: 'char_location' }] }, use(ID, 'read_table')]).ok, false);
});
