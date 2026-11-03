/* ---------------------------------------------------------------------------
   validate.mjs -- what the page may send the Worker: `messages`, and nothing
   else.

   The Worker pins the model, the system prompt, the tools and every other
   parameter; the page supplies only the conversation. So the body is checked
   for exactly that shape, with the sizes a real conversation needs and no
   more, and every block is passed through byte for byte afterwards -- the
   model's thinking blocks are bound to the conversation that produced them,
   and the API checks that the history it is handed back is the one it wrote.
   Pure: no I/O, so it is unit-tested in node.
--------------------------------------------------------------------------- */

export const LIMITS = Object.freeze({
  bodyBytes: 512 * 1024, messages: 80, blocksPerTurn: 24, textChars: 8000, assistantTextChars: 60000,
  resultChars: 24000, inputChars: 4096, totalChars: 400000,
});
const TOOL_ID = /^toolu_[A-Za-z0-9_-]{8,64}$/;
const NAME_LEAKS = ['"display_name"', '"display_city"', '"display_state"'];

/** Same-site browsers only. A browser always sends Sec-Fetch-Site; a request
 *  with neither it nor an Origin (curl, a test) is accepted. */
export function originAllowed(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  return true;
}

const keysOf = (o) => Object.keys(o).sort().join(',');
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/**
 * Check a parsed body. Returns { ok: true, messages } or
 * { ok: false, status, message }. `names` is the owner-names policy; under
 * "never" a tool result that carries a name column is refused outright.
 */
export function validateBody(body, { toolNames, names = 'never' }) {
  const fail = (message) => ({ ok: false, status: 400, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('body must be a JSON object');
  if (keysOf(body) !== 'messages') return fail('body must be {"messages": [...]} and nothing else');
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length < 1) return fail('messages must be a non-empty array');
  if (msgs.length > LIMITS.messages) return fail(`at most ${LIMITS.messages} messages per conversation`);
  if (msgs.length % 2 === 0) return fail('the conversation must end with a user message');
  const known = new Set(toolNames);
  let total = 0;
  let pendingIds = new Set();   // tool_use ids of the previous assistant turn

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== 'object' || keysOf(m) !== 'content,role') return fail(`message ${i} must have exactly role and content`);
    const role = i % 2 === 0 ? 'user' : 'assistant';
    if (m.role !== role) return fail(`message ${i} must be from the ${role}`);

    if (role === 'user') {
      const answered = new Set();
      if (typeof m.content === 'string') {
        if (!isStr(m.content, LIMITS.textChars)) return fail(`message ${i}: text over ${LIMITS.textChars} characters`);
        total += m.content.length;
      } else if (Array.isArray(m.content) && m.content.length >= 1 && m.content.length <= LIMITS.blocksPerTurn) {
        for (const b of m.content) {
          if (!b || typeof b !== 'object') return fail(`message ${i}: block must be an object`);
          if (b.type === 'text') {
            if (keysOf(b) !== 'text,type' || !isStr(b.text, LIMITS.textChars)) return fail(`message ${i}: bad text block`);
            total += b.text.length;
          } else if (b.type === 'tool_result') {
            const k = keysOf(b);
            if (k !== 'content,tool_use_id,type' && k !== 'content,is_error,tool_use_id,type') return fail(`message ${i}: bad tool_result block`);
            if (!TOOL_ID.test(b.tool_use_id)) return fail(`message ${i}: bad tool_use_id`);
            if ('is_error' in b && typeof b.is_error !== 'boolean') return fail(`message ${i}: is_error must be boolean`);
            let text;
            if (typeof b.content === 'string') text = b.content;
            else if (Array.isArray(b.content) && b.content.every((t) => t && keysOf(t) === 'text,type' && t.type === 'text' && typeof t.text === 'string')) {
              text = b.content.map((t) => t.text).join('');
            } else return fail(`message ${i}: tool_result content must be text`);
            if (text.length > LIMITS.resultChars) return fail(`message ${i}: tool result over ${LIMITS.resultChars} characters`);
            if (names === 'never' && NAME_LEAKS.some((n) => text.includes(n))) return fail(`message ${i}: owner names are not accepted`);
            if (!pendingIds.has(b.tool_use_id)) return fail(`message ${i}: tool_result ${b.tool_use_id} answers no tool_use`);
            if (answered.has(b.tool_use_id)) return fail(`message ${i}: tool_result ${b.tool_use_id} repeated`);
            answered.add(b.tool_use_id);
            total += text.length;
          } else return fail(`message ${i}: block type "${b.type}" not accepted`);
        }
      } else return fail(`message ${i}: content must be text or 1..${LIMITS.blocksPerTurn} blocks`);
      for (const id of pendingIds) if (!answered.has(id)) return fail(`message ${i}: tool_use ${id} was not answered`);
      pendingIds = new Set();
    } else {
      if (!Array.isArray(m.content) || m.content.length < 1 || m.content.length > LIMITS.blocksPerTurn) {
        return fail(`message ${i}: assistant content must be 1..${LIMITS.blocksPerTurn} blocks`);
      }
      const ids = new Set();
      for (const b of m.content) {
        if (!b || typeof b !== 'object') return fail(`message ${i}: block must be an object`);
        const k = keysOf(b);
        if (b.type === 'text') {
          if (k !== 'text,type' || !isStr(b.text, LIMITS.assistantTextChars)) return fail(`message ${i}: bad text block`);
          total += b.text.length;
        } else if (b.type === 'thinking') {
          if (k !== 'signature,thinking,type' || typeof b.thinking !== 'string' || typeof b.signature !== 'string') return fail(`message ${i}: bad thinking block`);
          total += b.thinking.length + b.signature.length;
        } else if (b.type === 'redacted_thinking') {
          if (k !== 'data,type' || typeof b.data !== 'string') return fail(`message ${i}: bad redacted_thinking block`);
          total += b.data.length;
        } else if (b.type === 'tool_use') {
          if (k !== 'id,input,name,type' || !TOOL_ID.test(b.id)) return fail(`message ${i}: bad tool_use block`);
          if (!known.has(b.name)) return fail(`message ${i}: unknown tool "${b.name}"`);
          if (!b.input || typeof b.input !== 'object' || Array.isArray(b.input)) return fail(`message ${i}: tool input must be an object`);
          const len = JSON.stringify(b.input).length;
          if (len > LIMITS.inputChars) return fail(`message ${i}: tool input over ${LIMITS.inputChars} characters`);
          if (ids.has(b.id)) return fail(`message ${i}: tool_use id repeated`);
          ids.add(b.id);
          total += len;
        } else return fail(`message ${i}: block type "${b.type}" not accepted`);
      }
      pendingIds = ids;
    }
    if (total > LIMITS.totalChars) return fail(`conversation over ${LIMITS.totalChars} characters`);
  }
  return { ok: true, messages: msgs };
}
