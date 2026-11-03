/* ---------------------------------------------------------------------------
   budget.mjs -- the daily caps, as one Durable Object with a SQLite table.

   The rate-limit binding guards a minute per location and is approximate;
   this is the exact count: requests and output tokens per day, globally and
   per hashed IP. One object ("global") serialises every reservation, which
   at these volumes is nothing. Rows older than a week are pruned by alarm.
--------------------------------------------------------------------------- */
import { DurableObject } from 'cloudflare:workers';

const DAY_MS = 24 * 3600 * 1000;

export class Budget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS counters (
        day TEXT NOT NULL, key TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, key))`);
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + DAY_MS);
    });
  }

  #row(day, key) {
    const r = this.ctx.storage.sql
      .exec('SELECT requests, output_tokens FROM counters WHERE day = ? AND key = ?', day, key).toArray()[0];
    return r || { requests: 0, output_tokens: 0 };
  }

  #bump(day, key, requests, tokens) {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (day, key, requests, output_tokens) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, key) DO UPDATE SET requests = requests + excluded.requests,
       output_tokens = output_tokens + excluded.output_tokens`, day, key, requests, tokens);
  }

  /** Count a request against the day, or say why not. */
  async reserve(day, ipHash, caps) {
    const g = this.#row(day, 'global');
    const p = this.#row(day, ipHash);
    if (g.requests >= caps.dailyRequests || g.output_tokens >= caps.dailyOutputTokens) {
      return { ok: false, reason: 'The assistant has reached its limit for today; please try again tomorrow.' };
    }
    if (p.requests >= caps.ipDailyRequests) {
      return { ok: false, reason: 'You have reached today’s limit for the assistant; please try again tomorrow.' };
    }
    this.#bump(day, 'global', 1, 0);
    this.#bump(day, ipHash, 1, 0);
    return { ok: true, global: g.requests + 1, ip: p.requests + 1 };
  }

  /** Add the output tokens of a finished answer. */
  async record(day, ipHash, outputTokens) {
    const n = Math.max(0, Math.floor(Number(outputTokens) || 0));
    if (!n) return;
    this.#bump(day, 'global', 0, n);
    this.#bump(day, ipHash, 0, n);
  }

  async usage(day) {
    return { day, global: this.#row(day, 'global') };
  }

  async alarm() {
    const cutoff = new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10);
    this.ctx.storage.sql.exec('DELETE FROM counters WHERE day < ?', cutoff);
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }
}
