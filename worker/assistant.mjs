/* ---------------------------------------------------------------------------
   assistant.mjs -- POST /api/assistant: the pinned streaming proxy.

   The page sends the conversation and nothing else; this handler adds
   everything the model needs and nothing the page may vary: the model, the
   system prompt (generated at build time, cached at the API), the six tools,
   the token cap, the effort. It checks the origin, the shape and the size of
   the body, the per-minute and per-day limits, then relays the model's
   stream as newline-delimited JSON events, which the page turns back into a
   message with the SDK's own helper. Usage is logged per request, with the
   cache-read count that says the prompt cache is doing its job.
--------------------------------------------------------------------------- */
import Anthropic from '@anthropic-ai/sdk';
import prompt from '../site/src/assistant/prompt.json' with { type: 'json' };
import { TOOLS, TOOL_NAMES } from '../site/src/assistant/tools.js';
import { LIMITS, originAllowed, validateBody } from './validate.mjs';
import { SESSION_COOKIE, SESSION_TTL_MS, makeSession, checkSession, cookieValue, verifyTurnstile } from './session.mjs';

/* The asset runtime's _headers do not apply to Worker responses, so the
   security headers are restated here. */
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex',
};
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra },
});
const fail = (status, type, message, extra) => json({ error: { type, message } }, status, extra);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

function enabled(env) {
  return env.ASSISTANT_ENABLED === '1' && !!env.ANTHROPIC_API_KEY;
}

export function handleHealth(request, env) {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'GET only', { allow: 'GET' });
  if (!enabled(env)) return json({ ok: false, reason: env.ASSISTANT_ENABLED === '1' ? 'no key configured' : 'disabled' });
  return json({
    ok: true, model: env.ASSISTANT_MODEL || 'claude-opus-5-5', effort: env.ASSISTANT_EFFORT || 'medium',
    names: env.ASSISTANT_NAMES || 'never', turnstile: !!env.TURNSTILE_SITE_KEY,
    site_key: env.TURNSTILE_SITE_KEY || null, prompt: prompt.hash || null,
  });
}

/** A daily, salted hash of the client address: the only identity logged or counted. */
async function ipHash(env, ip, day) {
  const data = new TextEncoder().encode(`${day}|${env.ASSISTANT_SALT || ''}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mapError(err, who) {
  if (err instanceof Anthropic.RateLimitError) {
    return fail(429, 'upstream_busy', 'The model is busy; please try again in a moment.', { 'retry-after': '20' });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    log({ who, error: 'auth', status: err.status });
    return fail(503, 'unavailable', 'The assistant is not available right now.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    log({ who, error: 'bad_request', message: String(err.message).slice(0, 500) });
    return fail(400, 'invalid_request', 'The request was refused by the model API.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return fail(504, 'upstream_timeout', 'The model did not answer in time; please try again.');
  }
  if (err instanceof Anthropic.APIError) {
    log({ who, error: 'api', status: err.status, message: String(err.message).slice(0, 300) });
    return fail(503, 'overloaded', 'The model is overloaded; please try again shortly.', { 'retry-after': '10' });
  }
  log({ who, error: 'internal', message: String(err && err.message ? err.message : err).slice(0, 300) });
  return fail(500, 'internal', 'Something went wrong on the server.');
}

export async function handleAssistant(request, env, ctx) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only', { allow: 'POST' });
  if (!enabled(env)) return fail(503, 'unavailable', 'The assistant is not enabled on this deployment.');
  if (!originAllowed(request)) return fail(403, 'forbidden', 'cross-site requests are not accepted');
  if (!/^application\/json/i.test(request.headers.get('content-type') || '')) {
    return fail(415, 'unsupported_media_type', 'send application/json');
  }
  if (num(request.headers.get('content-length'), 0) > LIMITS.bodyBytes) {
    return fail(413, 'too_large', `body over ${LIMITS.bodyBytes} bytes`);
  }
  const raw = await request.text();
  if (raw.length > LIMITS.bodyBytes) return fail(413, 'too_large', `body over ${LIMITS.bodyBytes} bytes`);
  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, 'invalid_request', 'body is not JSON'); }
  const names = env.ASSISTANT_NAMES || 'never';
  const v = validateBody(body, { toolNames: TOOL_NAMES, names });
  if (!v.ok) return fail(v.status, 'invalid_request', v.message);

  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  const who = await ipHash(env, ip, day);
  if (env.ASSIST_RL) {
    const { success } = await env.ASSIST_RL.limit({ key: ip });
    if (!success) return fail(429, 'rate_limited', 'Too many requests; please wait a minute.', { 'retry-after': '60' });
  }
  // The bot check, where it is configured: a widget token on the first
  // request of a session, a signed cookie afterwards.
  let setCookie = null;
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET) {
    const secret = env.ASSISTANT_SALT || env.TURNSTILE_SECRET;
    const have = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
    if (!(await checkSession(secret, have, who))) {
      const t = await verifyTurnstile(env.TURNSTILE_SECRET, request.headers.get('cf-turnstile-response'), ip);
      if (!t.ok) {
        log({ who, turnstile: t.codes.join(',') });
        return fail(403, 'turnstile', 'Please complete the check and try again.');
      }
      setCookie = `${SESSION_COOKIE}=${await makeSession(secret, who)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; `
        + 'Path=/api/assistant; HttpOnly; Secure; SameSite=Strict';
    }
  }
  const budget = env.BUDGET ? env.BUDGET.get(env.BUDGET.idFromName('global')) : null;
  if (budget) {
    const r = await budget.reserve(day, who, {
      dailyRequests: num(env.ASSISTANT_DAILY_REQUESTS, 600),
      dailyOutputTokens: num(env.ASSISTANT_DAILY_OUTPUT_TOKENS, 1.5e6),
      ipDailyRequests: num(env.ASSISTANT_IP_DAILY_REQUESTS, 80),
    });
    if (!r.ok) return fail(429, 'budget', r.reason, { 'retry-after': '3600' });
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 120_000 });
  const model = env.ASSISTANT_MODEL || 'claude-opus-5-5';
  const t0 = Date.now();
  const stream = client.messages.stream({
    model,
    max_tokens: num(env.ASSISTANT_MAX_TOKENS, 12000),
    // One explicit breakpoint on the static prefix (tools render before
    // system, so this caches both), plus the automatic one on the tail.
    system: [{ type: 'text', text: prompt.system[names] ?? prompt.system.never, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    tool_choice: { type: 'auto' },
    output_config: { effort: env.ASSISTANT_EFFORT || 'medium' },
    cache_control: { type: 'ephemeral' },
    metadata: { user_id: who },
    messages: v.messages,
  }, { signal: request.signal });

  try {
    // The API's own response headers: an auth or validation error surfaces
    // here, as a typed exception, before any byte goes to the page.
    await stream.withResponse();
  } catch (err) {
    return mapError(err, who);
  }

  ctx.waitUntil(stream.finalMessage().then((m) => {
    const u = m.usage || {};
    log({ who, model: m.model, stop: m.stop_reason, turn: v.messages.length, ms: Date.now() - t0,
      input: u.input_tokens, cache_write: u.cache_creation_input_tokens, cache_read: u.cache_read_input_tokens,
      output: u.output_tokens });
    if (budget && u.output_tokens) return budget.record(day, who, u.output_tokens);
    return undefined;
  }).catch((err) => log({ who, ended: 'early', ms: Date.now() - t0, message: String(err && err.message ? err.message : err).slice(0, 200) })));

  const headers = new Headers({ ...HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8' });
  if (setCookie) headers.append('set-cookie', setCookie);
  return new Response(stream.toReadableStream(), { headers });
}
