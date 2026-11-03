/* ---------------------------------------------------------------------------
   loop.js -- the agent loop, in the browser.

   One question is one or more round trips: the conversation goes to the
   Worker, which pins everything and relays the model's stream; the final
   message comes back through the SDK's own stream helper; if it asks for
   tools they are run here, against the live page, and their results go back
   as one user message, until the model stops. The history is append-only
   and every assistant message is stored exactly as received (thinking
   blocks included), which is what the API requires of a conversation it
   wrote. A question that is stopped or fails is rolled back whole, so the
   history never ends on an unanswered tool call.
--------------------------------------------------------------------------- */
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import { describeState, getState } from '../lib/state.js';
import { execute } from './execute.js';

export const ENDPOINT = 'api/assistant';
const NUDGE = 'Stop calling tools now and answer with what you have, saying what is still unknown.';

export class Conversation {
  constructor() { this.messages = []; this.turns = []; }
}

function textOf(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
}

/**
 * Ask one question. Callbacks: onText(text so far), onTool(record),
 * onStatus(string). Resolves to the turn record {status, text, tools, error}.
 */
export async function ask(conv, question, { onText, onTool, onStatus, signal, maxIterations = 8, names = 'never', headers = {} } = {}) {
  const turn = { question, before: getState(), tools: [], text: '', status: 'running', error: null, started: Date.now() };
  conv.turns.push(turn);
  const mark = conv.messages.length;
  const blocks = [{ type: 'text', text: `[Dashboard state]\n${JSON.stringify(describeState())}` }, { type: 'text', text: question }];
  const last = conv.messages[conv.messages.length - 1];
  // Two user turns in a row (a question after a stopped one) fold into one.
  if (last && last.role === 'user') {
    last.content = (typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content).concat(blocks);
  } else {
    conv.messages.push({ role: 'user', content: blocks });
  }
  const rollback = () => { conv.messages.length = mark; };
  let nudged = false;

  for (let iter = 0; ; iter++) {
    onStatus?.(iter ? 'working' : 'thinking');
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(iter === 0 ? headers : {}) },
        body: JSON.stringify({ messages: conv.messages }), signal,
      });
    } catch (err) {
      rollback();
      turn.status = signal?.aborted ? 'stopped' : 'error';
      turn.error = signal?.aborted ? null : 'The assistant could not be reached.';
      return turn;
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`, type = null;
      try { const e = await res.json(); if (e?.error?.message) message = e.error.message; type = e?.error?.type || null; } catch { /* not JSON */ }
      rollback();
      turn.status = 'error';
      turn.error = message;
      turn.errorType = type;
      return turn;
    }
    const ms = MessageStream.fromReadableStream(res.body);
    let streamed = '';
    ms.on('text', (delta) => { streamed += delta; onText?.(turn.text ? `${turn.text}\n\n${streamed}` : streamed); });
    let msg;
    try {
      msg = await ms.finalMessage();
    } catch (err) {
      rollback();
      turn.status = signal?.aborted ? 'stopped' : 'error';
      turn.error = signal?.aborted ? null : 'The answer was interrupted.';
      return turn;
    }
    conv.messages.push({ role: 'assistant', content: msg.content });
    const t = textOf(msg.content);
    if (t) turn.text = turn.text ? `${turn.text}\n\n${t}` : t;
    turn.usage = msg.usage || null;

    if (msg.stop_reason === 'refusal') { turn.status = 'refused'; turn.error = 'The model declined to answer this.'; return turn; }
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason === 'max_tokens') {
      // A tool input cut off mid-way may parse as a valid partial object; never run it.
      if (uses.length) rollback();
      turn.status = 'cut'; turn.error = 'The answer was cut off; try a narrower question.';
      return turn;
    }
    if (!uses.length || msg.stop_reason !== 'tool_use') { turn.status = 'done'; return turn; }
    if (nudged && iter >= maxIterations) {
      // It kept calling tools after being told to stop: drop this exchange.
      rollback();
      turn.status = 'done';
      if (!turn.text) turn.error = 'The assistant ran out of steps without an answer.';
      return turn;
    }

    const results = [];
    for (const u of uses) {
      const rec = { name: u.name, input: u.input, started: Date.now(), ok: true, summary: '', ms: 0 };
      onStatus?.(u.name);
      let content;
      try {
        content = await execute(u.name, u.input, { names });
        try { rec.summary = JSON.parse(content).summary || ''; } catch { /* not JSON */ }
        results.push({ type: 'tool_result', tool_use_id: u.id, content });
      } catch (err) {
        rec.ok = false;
        rec.summary = String(err && err.message ? err.message : err);
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: rec.summary });
      }
      rec.ms = Date.now() - rec.started;
      turn.tools.push(rec);
      onTool?.(rec);
    }
    if (iter >= maxIterations - 1 && !nudged) { results.push({ type: 'text', text: NUDGE }); nudged = true; }
    conv.messages.push({ role: 'user', content: results });
  }
}
