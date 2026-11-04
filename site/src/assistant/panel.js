/* ---------------------------------------------------------------------------
   panel.js -- the assistant's drawer.

   Loaded on the first click of the Ask button (a separate chunk, with the
   SDK's stream helper), so a reader who never asks pays nothing. The panel
   is a log of questions and answers, each answer with the trace of what the
   assistant did to the dashboard ("What I did") and a way back ("Restore my
   view"). The model's text is rendered as DOM, never as HTML.
--------------------------------------------------------------------------- */
import { applyState, toHash, getState, relayout, S } from '../lib/state.js';
import { Conversation, ask } from './loop.js';
import { renderText } from './render-text.js';

const $ = (id) => document.getElementById(id);
const SUGGESTIONS = [
  'What share of Gallatin County’s parcels are addressed but not built?',
  'Show me the largest holdings in Park County in 2018.',
  'Where are new lots piling up just above 20 acres?',
  'How has out-of-state ownership changed in Flathead County?',
  'Which counties have the oldest housing?',
  'Make a county profile for Ravalli County.',
];
const PRIVACY = 'Your question, the assistant’s replies and a description of what the dashboard shows are sent to '
  + 'Anthropic’s API through this site’s server. Nothing else about you is sent, and no owner names are. '
  + 'Please do not include personal information. The assistant reports only figures read from the published tables, '
  + 'with the export date; check anything that matters against the view it opens.';
const TOOL_LABEL = {
  get_dashboard_state: 'Read the dashboard', configure_dashboard: 'Set the dashboard', lookup_place: 'Looked up a place',
  read_series: 'Read a series', read_table: 'Queried a table', compose_report: 'Composed a report',
};

let conv = new Conversation();
/* The bot check, only where the Worker asks for it: the widget script is
   loaded on first use, a token is fetched for the first question of a
   session, and the Worker's cookie covers the rest. */
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let widget = null, sessionOk = false;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = TURNSTILE_SRC; sc.async = true; sc.defer = true;
    sc.onload = () => resolve(); sc.onerror = () => reject(new Error('the check could not be loaded'));
    document.head.appendChild(sc);
  });
}
async function turnstileToken() {
  if (!health?.turnstile || !health.site_key || sessionOk) return null;
  await loadTurnstile();
  let host = $('assist-turnstile');
  if (!host) { host = el('div'); host.id = 'assist-turnstile'; $('assist-form').appendChild(host); }
  return new Promise((resolve, reject) => {
    const opts = { sitekey: health.site_key, appearance: 'interaction-only', callback: (t) => resolve(t),
      'error-callback': () => reject(new Error('the check failed')), 'expired-callback': () => {} };
    if (widget == null) widget = window.turnstile.render(host, opts);
    else { window.turnstile.reset(widget); window.turnstile.execute?.(widget, opts); }
  });
}
let health = null;
let controller = null;
let locked = false;

/* A usage limit was reached (the month's allowance, the day's, or this
   visitor's): say so where the question box was and stop taking questions.
   The conversation so far stays readable and the dashboard keeps working. */
function showLimit(message) {
  locked = true;
  const n = $('assist-notice');
  n.textContent = message;
  n.hidden = false;
  $('assist-q').disabled = true;
  $('assist-q').placeholder = 'The assistant is not taking questions right now.';
  $('assist-send').disabled = true;
  $('assist-suggest').hidden = true;
}
let built = false;
let busy = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function toggle(h) {
  health = h || health;
  if (!built) build();
  const a = $('assist');
  const open = a.hidden;
  a.hidden = !open;
  $('assist-toggle').setAttribute('aria-expanded', String(open));
  // The panel takes its own share of the screen and the dashboard reflows
  // into the rest (beside it on a wide screen, above it on a narrow one).
  document.body.classList.toggle('assist-open', open);
  relayout();
  if (open) $('assist-q').focus(); else $('assist-toggle').focus();
}

function build() {
  built = true;
  const sug = $('assist-suggest');
  for (const s of SUGGESTIONS) {
    const b = el('button', 'chip', s);
    b.type = 'button';
    b.addEventListener('click', () => { $('assist-q').value = s; submit(); });
    sug.appendChild(b);
  }
  $('assist-privacy').textContent = PRIVACY;
  if (health?.exhausted) showLimit(health.notice || 'The assistant has used its allowance for this month.');
  $('assist-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('assist-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') toggle();
  });
  $('assist-stop').addEventListener('click', () => controller?.abort());
  $('assist-close').addEventListener('click', () => toggle());
  $('assist-new').addEventListener('click', () => {
    if (busy) controller?.abort();
    conv = new Conversation();
    $('assist-log').textContent = '';
    $('assist-suggest').hidden = false;
    $('assist-q').focus();
  });
  // Test handle: the smoke suite and the eval drive the panel through this.
  window.__assistant = {
    ask: (q) => submit(q), abort: () => controller?.abort(),
    get conv() { return conv; }, lastRun: null,
    exec: async (name, input) => (await import('./execute.js')).execute(name, input, { names: health?.names || 'never' }),
  };
}

async function submit(text) {
  const q = (text ?? $('assist-q').value).trim();
  if (!q || busy || locked) return null;
  busy = true;
  $('assist-q').value = '';
  $('assist-suggest').hidden = true;
  $('assist-send').disabled = true;
  $('assist-stop').hidden = false;
  const log = $('assist-log');
  const box = el('div', 'assist-turn');
  box.appendChild(el('div', 'assist-q', q));
  const status = el('div', 'assist-status', 'Thinking…');
  const answer = el('div', 'assist-a');
  const traceWrap = el('details', 'assist-trace');
  traceWrap.appendChild(el('summary', null, 'What I did'));
  const trace = el('ol');
  traceWrap.appendChild(trace);
  traceWrap.hidden = true;
  const actions = el('div', 'assist-actions-row');
  box.append(status, answer, traceWrap, actions);
  log.appendChild(box);
  box.scrollIntoView({ block: 'end' });

  controller = new AbortController();
  let headers = {};
  try {
    const tok = await turnstileToken();
    if (tok) headers = { 'cf-turnstile-response': tok };
  } catch (err) { status.textContent = err.message; }
  const run = () => ask(conv, q, {
    signal: controller.signal, names: health?.names || 'never', headers,
    onText: (t) => { status.hidden = true; renderText(answer, t); log.scrollTop = log.scrollHeight; },
    onStatus: (s) => { status.hidden = false; status.textContent = TOOL_LABEL[s] ? `${TOOL_LABEL[s]}…` : (s === 'working' ? 'Working…' : 'Thinking…'); },
    onTool: (rec) => {
      traceWrap.hidden = false;
      const li = el('li');
      li.appendChild(el('b', null, TOOL_LABEL[rec.name] || rec.name));
      li.appendChild(document.createTextNode(` ${rec.summary || ''}`));
      if (!rec.ok) li.classList.add('err');
      trace.appendChild(li);
    },
  });
  let turn = await run();
  if (turn.status === 'error' && turn.errorType === 'turnstile' && health?.turnstile) {
    // The session lapsed: one fresh token, one retry.
    sessionOk = false;
    try { headers = { 'cf-turnstile-response': await turnstileToken() }; turn = await run(); } catch { /* keep the error */ }
  }
  if (turn.status !== 'error') sessionOk = true;
  status.hidden = turn.status !== 'error' && turn.status !== 'refused' && turn.status !== 'cut' && turn.status !== 'stopped';
  if (turn.status === 'stopped') status.textContent = 'Stopped.';
  else if (turn.error) status.textContent = turn.error;
  if (turn.text) renderText(answer, turn.text);
  if (turn.tools.some((t) => t.name === 'configure_dashboard' || t.name === 'compose_report')) {
    const restore = el('button', 'chip', 'Restore my view');
    restore.type = 'button';
    restore.addEventListener('click', () => applyState(turn.before, { source: 'user' }));
    const link = el('button', 'chip', 'Copy link');
    link.type = 'button';
    link.addEventListener('click', async () => {
      const h = toHash(getState(), S.dim);
      const url = `${location.origin}${location.pathname}${h ? '#' + h : ''}`;
      try { await navigator.clipboard.writeText(url); link.textContent = 'Copied'; } catch { link.textContent = url; }
    });
    actions.append(restore, link);
  }
  window.__assistant.lastRun = turn;
  busy = false;
  controller = null;
  $('assist-stop').hidden = true;
  if (turn.status === 'error' && (turn.errorType === 'budget' || turn.errorType === 'limit')) {
    box.remove();   // the question was not answered; the notice says why
    showLimit(turn.error);
    $('assist-notice').focus?.();
    return turn;
  }
  $('assist-send').disabled = false;
  $('assist-q').focus();
  return turn;
}
