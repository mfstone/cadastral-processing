/* caps.mjs -- the budget's arithmetic and decision, pure, so node can test
   them; budget.mjs (a Durable Object) and assistant.mjs use them. */

/** Micro-dollars for one answer's usage at per-MTok dollar prices. */
export function costMicros(usage, prices) {
  const u = usage || {};
  const n = (x) => Math.max(0, Math.floor(Number(x) || 0));
  return Math.round(n(u.input_tokens) * prices.input + n(u.cache_creation_input_tokens) * prices.cacheWrite
    + n(u.cache_read_input_tokens) * prices.cacheRead + n(u.output_tokens) * prices.output);
}

/** The decision, pure, so it can be tested without the runtime.
    m: this month's global row; mv: this visitor's month row;
    g, p: today's global and visitor rows. */
export function decide({ m, mv, g, p }, caps, newQuestion) {
  if (m.cost_micros >= caps.monthlyMicros + (newQuestion ? 0 : caps.overrunMicros)) return { ok: false, kind: 'month' };
  if (g.requests >= caps.dailyRequests || g.output_tokens >= caps.dailyOutputTokens) return { ok: false, kind: 'day' };
  if (p.requests >= caps.ipDailyRequests) return { ok: false, kind: 'ip_day' };
  if (newQuestion && p.questions >= caps.ipDailyQuestions) return { ok: false, kind: 'ip_day' };
  if (newQuestion && mv.questions >= caps.ipMonthlyQuestions) return { ok: false, kind: 'ip_month' };
  return { ok: true };
}


/** The caps from the Worker's vars, with the defaults the README documents. */
export function capsFrom(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  const usd = (v, d) => Math.round(num(v, d) * 1e6);
  return {
    monthlyMicros: usd(env.ASSISTANT_MONTHLY_BUDGET_USD, 20),
    overrunMicros: usd(env.ASSISTANT_MONTHLY_OVERRUN_USD, 1),
    dailyRequests: num(env.ASSISTANT_DAILY_REQUESTS, 600),
    dailyOutputTokens: num(env.ASSISTANT_DAILY_OUTPUT_TOKENS, 1.5e6),
    ipDailyRequests: num(env.ASSISTANT_IP_DAILY_REQUESTS, 80),
    ipDailyQuestions: num(env.ASSISTANT_IP_DAILY_QUESTIONS, 10),
    ipMonthlyQuestions: num(env.ASSISTANT_IP_MONTHLY_QUESTIONS, 60),
  };
}

/** Dollar prices per million tokens; defaults are Claude Opus 5.5's list
    prices with the five-minute cache write at 1.25 times input. */
export function pricesFrom(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  return {
    input: num(env.ASSISTANT_PRICE_INPUT, 4), output: num(env.ASSISTANT_PRICE_OUTPUT, 20),
    cacheRead: num(env.ASSISTANT_PRICE_CACHE_READ, 0.2), cacheWrite: num(env.ASSISTANT_PRICE_CACHE_WRITE, 5),
  };
}

/** What each refusal says to the person. */
export const LIMIT_MESSAGES = {
  month: 'The assistant has used its allowance for this month. It will be back on the 1st. The dashboard itself works as usual.',
  day: 'The assistant has reached its limit for today. Please try again tomorrow. The dashboard itself works as usual.',
  ip_day: 'You have reached today’s limit of questions for the assistant. Please try again tomorrow.',
  ip_month: 'You have reached this month’s limit of questions for the assistant. It resets on the 1st.',
};
