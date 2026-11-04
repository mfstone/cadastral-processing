/* mock-assistant.mjs -- a scripted model, as the stream the Worker relays.
 *
 * The smoke suite answers POST /api/assistant from here so that the panel,
 * the loop and the executors are exercised with no key and no network. A
 * script is a list of assistant messages (text and tool calls); each call to
 * next() returns the following one as newline-delimited JSON events in the
 * exact shape the SDK's MessageStream.fromReadableStream() expects, with the
 * tool inputs streamed as partial JSON the way the API sends them. */

let counter = 0;
const id = () => `toolu_mock${String(++counter).padStart(20, '0')}`;

/** One assistant message -> NDJSON. blocks: [{text} | {tool, input}]. */
export function ndjsonFor(blocks, { stopReason } = {}) {
  const ev = [];
  const push = (o) => ev.push(JSON.stringify(o));
  const hasTool = blocks.some((b) => b.tool);
  push({ type: 'message_start', message: { id: `msg_mock${++counter}`, type: 'message', role: 'assistant', model: 'claude-mock',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 11800 } } });
  blocks.forEach((b, i) => {
    if (b.text != null) {
      push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      for (const piece of String(b.text).match(/.{1,24}/gs) || []) {
        push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } });
      }
    } else {
      push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id || id(), name: b.tool, input: {}, caller: { type: 'direct' } } });
      const json = JSON.stringify(b.input || {});
      for (const piece of json.match(/.{1,40}/gs) || ['']) {
        push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: piece } });
      }
    }
    push({ type: 'content_block_stop', index: i });
  });
  push({ type: 'message_delta', delta: { stop_reason: stopReason || (hasTool ? 'tool_use' : 'end_turn'), stop_sequence: null },
    usage: { output_tokens: 180 } });
  push({ type: 'message_stop' });
  return ev.join('\n') + '\n';
}

/** The scripted conversations, keyed by a phrase in the question. */
export const SCRIPTS = {
  'large holdings in Gallatin': [
    [{ text: 'Let me find Gallatin County first.' }, { tool: 'lookup_place', input: { query: 'Gallatin County', kind: 'county' } }],
    [{ tool: 'configure_dashboard', input: { view: 'holdings', snapshot: { index: null, date: '2018-01-10' }, level: 'county', measure: null,
      selection: { counties: [6], townships: null, clear: null }, era: null, origin_state: null, mask_low_coverage: null, basemap: null,
      layers: null, map: { fit: 'county', fit_id: '6', center: null, zoom: null }, theme: null } },
     { tool: 'read_series', input: { level: 'county', units: [6], topic: 'holdings', measures: null, derived: 'clo4_pct', state: null,
      snapshots: { from: 19, to: 19 } } }],
    [{ text: 'The Holdings view now shows **Gallatin County** at the 2018-01-10 export.\n\n- The four largest holdings held about a fifth of the large-holding acreage (CLO4).\n- The ten largest holdings are listed on screen by rank and size.\n\nThe map now shows Gallatin County on the Holdings view at the 2018-01-10 export.' }],
  ],
  'population': [
    [{ text: 'The dashboard’s tables do not carry population. The nearest thing they can answer is how many parcels carry a dwelling, on the Condition view.' }],
  ],
  'error path': [
    [{ tool: 'lookup_place', input: { query: 'Atlantis', kind: 'county' } }],
    [{ text: 'There is no county called Atlantis in Montana.' }],
  ],
};

/** A fresh cursor over the script that matches the question. */
export function scripted(question) {
  const key = Object.keys(SCRIPTS).find((k) => question.toLowerCase().includes(k.toLowerCase()));
  const steps = key ? SCRIPTS[key] : [[{ text: 'I can only answer from the dashboard’s tables.' }]];
  let i = 0;
  return { key, next: () => ndjsonFor(steps[Math.min(i++, steps.length - 1)]) };
}
