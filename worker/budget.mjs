/* ---------------------------------------------------------------------------
   budget.mjs -- the spending and usage caps, as one Durable Object with SQLite.

   The rate-limit binding guards a minute per location and is approximate;
   this is the exact count. Two tables:

   * counters (per day): requests and output tokens, globally and per hashed
     IP, plus questions per hashed IP. A question is what a person types; it
     costs several requests, because each tool round trip is one.
   * monthly (per calendar month, UTC): questions, requests and the estimated
     cost in micro-dollars, globally and per visitor (an IP hashed with the
     month, so the same visitor is the same key all month).

   Cost is computed from the usage the API reports on every answer, at the
   per-million-token prices in wrangler.jsonc. A price per million tokens in
   dollars is exactly a price per token in micro-dollars, so the arithmetic
   is integer. It is an estimate of the bill, close but not the invoice: the
   Anthropic Console's spend limit is the hard stop and this is the soft one
   that turns the stop into a polite notice before the API ever refuses.

   One object ("global") serialises every reservation, which at these volumes
   is nothing. Daily rows older than a week and monthly rows older than a
   year are pruned by alarm.
--------------------------------------------------------------------------- */
import { DurableObject } from 'cloudflare:workers';
import { decide, costMicros } from './caps.mjs';

const DAY_MS = 24 * 3600 * 1000;

export class Budget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS counters (
        day TEXT NOT NULL, key TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, key))`);
      const cols = sql.exec('PRAGMA table_info(counters)').toArray().map((r) => r.name);
      if (!cols.includes('questions')) sql.exec('ALTER TABLE counters ADD COLUMN questions INTEGER NOT NULL DEFAULT 0');
      sql.exec(`CREATE TABLE IF NOT EXISTS monthly (
        month TEXT NOT NULL, key TEXT NOT NULL,
        questions INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (month, key))`);
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + DAY_MS);
    });
  }

  #day(day, key) {
    return this.ctx.storage.sql
      .exec('SELECT requests, output_tokens, questions FROM counters WHERE day = ? AND key = ?', day, key).toArray()[0]
      || { requests: 0, output_tokens: 0, questions: 0 };
  }

  #month(month, key) {
    return this.ctx.storage.sql
      .exec('SELECT questions, requests, cost_micros FROM monthly WHERE month = ? AND key = ?', month, key).toArray()[0]
      || { questions: 0, requests: 0, cost_micros: 0 };
  }

  #bumpDay(day, key, requests, tokens, questions) {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (day, key, requests, output_tokens, questions) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, key) DO UPDATE SET requests = requests + excluded.requests,
       output_tokens = output_tokens + excluded.output_tokens, questions = questions + excluded.questions`,
      day, key, requests, tokens, questions);
  }

  #bumpMonth(month, key, questions, requests, micros) {
    this.ctx.storage.sql.exec(
      `INSERT INTO monthly (month, key, questions, requests, cost_micros) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(month, key) DO UPDATE SET questions = questions + excluded.questions,
       requests = requests + excluded.requests, cost_micros = cost_micros + excluded.cost_micros`,
      month, key, questions, requests, micros);
  }

  /** Count a request, or say which cap stops it. A continuation (a tool
      result going back) may finish a question already under way, up to the
      overrun allowance past the monthly cap, so nobody gets half an answer. */
  async reserve({ day, month, who, whoMonth, newQuestion }, caps) {
    const rows = { m: this.#month(month, 'global'), mv: this.#month(month, whoMonth),
      g: this.#day(day, 'global'), p: this.#day(day, who) };
    const d = decide(rows, caps, newQuestion);
    if (!d.ok) return d;
    const q = newQuestion ? 1 : 0;
    this.#bumpDay(day, 'global', 1, 0, q);
    this.#bumpDay(day, who, 1, 0, q);
    this.#bumpMonth(month, 'global', q, 1, 0);
    this.#bumpMonth(month, whoMonth, q, 1, 0);
    return { ok: true, visitor_questions_today: rows.p.questions + q, visitor_questions_month: rows.mv.questions + q };
  }

  /** Add a finished (or cut-off) answer's tokens and cost. */
  async record({ day, month, who, whoMonth }, usage, prices) {
    const out = Math.max(0, Math.floor(Number(usage?.output_tokens) || 0));
    const micros = costMicros(usage, prices);
    if (out) { this.#bumpDay(day, 'global', 0, out, 0); this.#bumpDay(day, who, 0, out, 0); }
    if (micros) { this.#bumpMonth(month, 'global', 0, 0, micros); this.#bumpMonth(month, whoMonth, 0, 0, micros); }
    return micros;
  }

  /** What the panel needs to know before anyone types: is the month spent? */
  async status(month, monthlyMicros) {
    const m = this.#month(month, 'global');
    return { month, spent_micros: m.cost_micros, cap_micros: monthlyMicros, questions: m.questions,
      exhausted: m.cost_micros >= monthlyMicros };
  }

  async alarm() {
    const now = Date.now();
    const dayCut = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);
    const monthCut = new Date(now - 400 * DAY_MS).toISOString().slice(0, 7);
    this.ctx.storage.sql.exec('DELETE FROM counters WHERE day < ?', dayCut);
    this.ctx.storage.sql.exec('DELETE FROM monthly WHERE month < ?', monthCut);
    await this.ctx.storage.setAlarm(now + DAY_MS);
  }
}
