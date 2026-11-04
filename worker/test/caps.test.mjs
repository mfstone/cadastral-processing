import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costMicros, decide, capsFrom, pricesFrom, LIMIT_MESSAGES } from '../caps.mjs';
import { isNewQuestion, spendFault, configFault } from '../assistant.mjs';

const prices = pricesFrom({});
const caps = capsFrom({ ASSISTANT_MONTHLY_BUDGET_USD: '20' });
const zero = { requests: 0, output_tokens: 0, questions: 0 };
const month = (cost_micros, questions = 0) => ({ cost_micros, questions, requests: 0 });

test('cost is integer micro-dollars at the per-MTok prices', () => {
  // The first live request: 19,961 tokens written to cache, 4 input, 150 output.
  assert.equal(costMicros({ input_tokens: 4, cache_creation_input_tokens: 19961, cache_read_input_tokens: 0, output_tokens: 150 }, prices),
    4 * 4 + 19961 * 5 + 150 * 20);
  // The second: all read from cache, $0.006 or so.
  assert.equal(costMicros({ input_tokens: 4, cache_read_input_tokens: 19961, output_tokens: 99 }, prices), 16 + 3992 + 1980);
  assert.equal(costMicros(null, prices), 0);
});

test('the monthly cap stops new questions, lets one under way finish, then stops that too', () => {
  const rows = (cost) => ({ m: month(cost), mv: month(0), g: zero, p: zero });
  assert.equal(decide(rows(19_999_999), caps, true).ok, true);
  assert.deepEqual(decide(rows(20_000_000), caps, true), { ok: false, kind: 'month' });
  assert.equal(decide(rows(20_500_000), caps, false).ok, true);
  assert.deepEqual(decide(rows(21_000_000), caps, false), { ok: false, kind: 'month' });
});

test('a visitor is capped on questions per day and per month, not on tool round trips', () => {
  const r = (p, mv) => ({ m: month(0), mv, g: zero, p });
  assert.deepEqual(decide(r({ ...zero, questions: 10 }, month(0)), caps, true), { ok: false, kind: 'ip_day' });
  assert.equal(decide(r({ ...zero, questions: 10, requests: 40 }, month(0)), caps, false).ok, true);
  assert.deepEqual(decide(r(zero, month(0, 60)), caps, true), { ok: false, kind: 'ip_month' });
  assert.deepEqual(decide(r({ ...zero, requests: 80 }, month(0)), caps, false), { ok: false, kind: 'ip_day' });
  for (const k of ['month', 'day', 'ip_day', 'ip_month']) assert.ok(LIMIT_MESSAGES[k].length > 20);
});

test('a question is a user turn without tool results', () => {
  assert.equal(isNewQuestion([{ role: 'user', content: 'hi' }]), true);
  assert.equal(isNewQuestion([{ role: 'user', content: [{ type: 'text', text: 'state' }, { type: 'text', text: 'q' }] }]), true);
  assert.equal(isNewQuestion([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '{}' }] }]), false);
});

test('a spend-limit refusal is told apart from a credentials fault', () => {
  assert.equal(spendFault('You have reached your specified API usage limits. You will regain access on 2026-12-01.'), true);
  assert.equal(spendFault('Your credit balance is too low to access the Anthropic API.'), true);
  assert.equal(spendFault('This API key is not scoped to a workspace'), false);
  assert.equal(configFault('This API key is not scoped to a workspace'), true);
});
