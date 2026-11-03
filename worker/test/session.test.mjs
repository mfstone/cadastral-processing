import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, checkSession, cookieValue, verifyTurnstile } from '../session.mjs';

test('a session verifies for its holder until it expires', async () => {
  const t = await makeSession('s3cret', 'abc123', 1000, 5000);
  assert.equal(await checkSession('s3cret', t, 'abc123', 2000), true);
  assert.equal(await checkSession('s3cret', t, 'abc123', 7000), false);
  assert.equal(await checkSession('s3cret', t, 'other', 2000), false);
  assert.equal(await checkSession('wrong', t, 'abc123', 2000), false);
  assert.equal(await checkSession('s3cret', t.slice(0, -1) + 'x', 'abc123', 2000), false);
  assert.equal(await checkSession('s3cret', '', 'abc123', 2000), false);
});

test('cookies are read by name', () => {
  assert.equal(cookieValue('a=1; assist_session=x.y.z; b=2', 'assist_session'), 'x.y.z');
  assert.equal(cookieValue('a=1', 'assist_session'), null);
  assert.equal(cookieValue(null, 'assist_session'), null);
});

test('turnstile verification reads the siteverify answer', async () => {
  const yes = async () => ({ ok: true, json: async () => ({ success: true }) });
  const no = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
  assert.deepEqual(await verifyTurnstile('sec', 'tok', '1.2.3.4', yes), { ok: true, codes: [] });
  assert.deepEqual(await verifyTurnstile('sec', 'tok', '1.2.3.4', no), { ok: false, codes: ['invalid-input-response'] });
  assert.equal((await verifyTurnstile('sec', '', '1.2.3.4', yes)).ok, false);
  assert.equal((await verifyTurnstile('sec', 'tok', '1.2.3.4', async () => { throw new Error('down'); })).codes[0], 'unreachable');
});
