/* ---------------------------------------------------------------------------
   analytics.js -- a first-party pageview beacon for the self-hosted Umami.

   Ported from the Montana Crash Explorer (crash-data-analyzer), which reports
   to the same Umami instance; the notes below are that file's, kept because
   every reason in them holds here too.

   Umami's own tracker is a <script src> on the Umami origin. Loading it would
   mean adding that origin to `script-src`, and `script-src` here admits nothing
   beyond 'self' and Turnstile — a compromised
   third-party script is the realistic attack on a static site, and the CSP is
   written so that there is nothing to compromise.

   So this talks to Umami's documented POST /api/send endpoint directly instead.
   The server answers `access-control-allow-origin: *` on that route, so no
   proxy is needed -- but a wildcard is only good for an UNCREDENTIALED request,
   which is why the send below pins `credentials: 'omit'` and why sendBeacon,
   which cannot be uncredentialed, is unusable here. The only CSP change is one
   `connect-src` entry: the beacon can send, and it still cannot execute
   anything.

   What this costs in return is that the payload shape is now ours to maintain.
   It is the five fields Umami reads for a pageview, and it has been stable
   across v2; if an upgrade changes it, pageviews stop arriving rather than
   anything breaking on the page — every failure here is swallowed.
--------------------------------------------------------------------------- */

/* A Umami website id is not a secret: on any Umami-tracked site it sits in the
   page source, which is where this one ends up too. So it is checked in as the
   default rather than kept in a gitignored .env — a build from a fresh clone
   then reports correctly instead of silently reporting nothing, which is the
   kind of failure nobody notices for months. The env var still overrides, for
   pointing a build at a different Umami site.

   Baking it in is safe only because shouldSend below gates on hostname: a
   local or preview build carries the id but never sends. */
const WEBSITE_ID = import.meta.env.PUBLIC_UMAMI_WEBSITE_ID
  || '5cb9f25f-a72a-431e-b93d-ad0ea7f87966';
const ENDPOINT = (import.meta.env.PUBLIC_UMAMI_URL
  || 'https://episteme-umami-prod.fly.dev').replace(/\/$/, '');

/* Only the real site reports. Without this, three things would quietly inflate
   the numbers: localhost during development, the per-deploy preview URLs
   wrangler mints on every upload, the Worker's own workers.dev origin, and — most of all — the smoke tests, which
   are pointed at the production origin on purpose and would otherwise register
   a visit on every run. */
const HOSTS = new Set([
  'cadastral-analytics.epistemegeospatial.com',
  'cadastral-analytics.pages.dev',
]);

/* `?debug=analytics` turns on console reporting. Read ONCE at module load,
   not per call: the app rewrites the URL from its filter state on the first
   map move, which drops the query string. Capturing it here means the flag
   survives that for the life of the page.

   It reports; it never changes behaviour. A gate that blocks still blocks, so
   what you see in the console is what actually happened. */
const DEBUG = (() => {
  try { return new URLSearchParams(location.search).get('debug') === 'analytics'; }
  catch { return false; }
})();

const log = (...a) => { if (DEBUG) console.log('[analytics]', ...a); };

/**
 * Why this visit will or will not be counted.
 *
 * Returns null when it will be, otherwise the name of the gate that stopped
 * it. Naming the gate is the whole point: every one of these failures is
 * otherwise completely silent, because the beacon swallows errors so that
 * analytics can never break the dashboard.
 *
 * @returns {string|null}
 */
function gateBlockedBy() {
  if (!WEBSITE_ID) return 'no website id compiled in';
  if (!HOSTS.has(location.hostname)) {
    return `hostname "${location.hostname}" is not in the allowlist `
         + `(${[...HOSTS].join(', ')}) — preview deploys and localhost do not report`;
  }
  if (navigator.webdriver) return 'navigator.webdriver is true (automated browser)';
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') {
    return 'this browser sends Do Not Track, which the site honours';
  }
  return null;
}

function shouldSend() {
  return gateBlockedBy() === null;
}

if (DEBUG) {
  const blocked = gateBlockedBy();
  log('debug reporting on');
  log('gate inputs', {
    websiteId: WEBSITE_ID ? `${WEBSITE_ID.slice(0, 8)}…` : '(none)',
    endpoint: ENDPOINT,
    hostname: location.hostname,
    hostAllowed: HOSTS.has(location.hostname),
    webdriver: navigator.webdriver,
    doNotTrack: navigator.doNotTrack ?? window.doNotTrack ?? null,
  });
  if (blocked) console.warn('[analytics] NOT COUNTED — ' + blocked);
  else console.log('[analytics] will be counted');
}

/**
 * Record one pageview.
 *
 * Deliberately NOT called on hash changes. The whole dashboard state (view,
 * vintage, selection, map position) lives in the URL hash, so treating a hash
 * change as a navigation would file every slider nudge and map pan as a separate page — tens of thousands of distinct "URLs", which would
 * bury the visitor count this exists to show. It would also transmit precisely
 * what each visitor had chosen to look at, which is more than measuring traffic
 * requires. The hash is stripped for the same reason: `url` is the path alone.
 */
const START = Date.now();

/* A visit with one event has one timestamp, so Umami's duration — the span
   between a visit's first and last event — is necessarily zero, and its single
   event makes the visit a bounce. That is why the dashboard read "0s" for
   nearly everyone: an artefact of sending one beacon and never speaking again,
   not a fact about readers.

   The fix is a second, later event. It is a NAMED event rather than a second
   pageview, so it extends the visit without inflating the view count.

   It is withheld below this threshold on purpose. Fire it unconditionally and
   every visit has two events, so nothing is ever a bounce and that metric goes
   as useless as the duration was. Gated, the two numbers start meaning
   something: a visit that leaves inside ten seconds stays a bounce with no
   duration, and one that stays is measured. Ten seconds is GA's "engaged
   session" threshold, borrowed for comparability. */
const ENGAGED_AFTER_MS = 10_000;
let lastEngagement = 0;

function post(body) {
  const url = `${ENDPOINT}/api/send`;
  const json = JSON.stringify(body);
  const kind = body?.payload?.name || 'pageview';
  log(`sending ${kind}`, body.payload);
  try {
    /* fetch with `keepalive`, and deliberately NOT navigator.sendBeacon.

       sendBeacon looks like the right tool -- it exists for precisely this --
       but it cannot work against this endpoint. The Beacon spec fixes the
       request's credentials mode at "include" with no way to override it, and
       a credentialed CORS request may not accept `access-control-allow-origin:
       *`, which is what Umami answers with. The JSON body forces a preflight on
       top of that, so the POST was rejected before it was ever sent.

       On the Crash Explorer it failed silently for weeks: sendBeacon returns
       true for *queued*, so the early return read as success. Hence a single
       path: what debugging exercises is what every visitor runs.

       `keepalive` is the modern replacement and survives page dismissal the
       same way. Its 64 KiB cap is irrelevant to a few hundred bytes. Firefox
       honoured it only from v133, so a much older Firefox may drop an
       `engaged` event fired during dismissal -- a lost event, not an error, and
       the pageview is sent on load rather than on the way out. */
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!DEBUG) return;
        const text = await res.text().catch(() => '');
        if (!res.ok) {
          console.warn(`[analytics] ${kind} REJECTED — HTTP ${res.status} `
            + text.slice(0, 160));
        } else if (/"beep"/.test(text)) {
          // Umami's decoy for an event it accepts and throws away, almost
          // always because it classified the User-Agent as a bot.
          console.warn(`[analytics] ${kind} DISCARDED by the server as a bot `
            + `— HTTP 200, but the body is ${text.slice(0, 40)}`);
        } else {
          console.log(`[analytics] ${kind} RECORDED — HTTP ${res.status}`);
        }
      })
      .catch((err) => {
        if (DEBUG) {
          console.warn(`[analytics] ${kind} FAILED TO SEND — `
            + (err?.message || err));
          console.warn('[analytics] a TypeError here is usually the content '
            + 'security policy: connect-src must allow ' + ENDPOINT);
        }
      });
  } catch (err) {
    if (DEBUG) console.warn('[analytics] threw before sending:', err);
    /* analytics must never break the dashboard */
  }
}

function base() {
  return {
    website: WEBSITE_ID,
    hostname: location.hostname,
    screen: `${screen.width}x${screen.height}`,
    language: navigator.language,
    title: document.title,
    url: location.pathname,
    referrer: document.referrer || '',
  };
}

/** Record one pageview. See the note on the hash above. */
export function pageview() {
  if (!shouldSend()) return;
  post({ type: 'event', payload: base() });
}

/* Close out the visit when the reader leaves or tabs away, so it has an end as
   well as a beginning. `pagehide` and the hidden transition are both wired
   because neither alone is reliable -- iOS Safari frequently never fires
   unload. They can both fire for one
   departure, so near-simultaneous sends are collapsed. */
function endOfVisit() {
  if (!shouldSend()) return;
  const elapsed = Date.now() - START;
  if (elapsed < ENGAGED_AFTER_MS) {
    log(`leaving after ${Math.round(elapsed / 1000)}s — under the `
      + `${ENGAGED_AFTER_MS / 1000}s threshold, so this stays a bounce with no `
      + 'duration, which is intended');
    return;
  }
  const now = Date.now();
  if (now - lastEngagement < 1000) return;
  lastEngagement = now;
  post({
    type: 'event',
    payload: { ...base(), name: 'engaged', data: { seconds: Math.round(elapsed / 1000) } },
  });
}

addEventListener('pagehide', endOfVisit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') endOfVisit();
});
