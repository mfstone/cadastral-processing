/* ---------------------------------------------------------------------------
   index.mjs -- the Worker that fronts the Montana cadastral dashboard.

       /api/assistant/health   is the assistant on, and how is it configured
       /api/assistant          the pinned streaming proxy (assistant.mjs)
       /api/*                  nothing else is real
       everything else         ASSETS: Astro's static output, with _headers

   A deploy without the Worker (the static files alone) still works: the
   page asks /health, gets the site's 404 page, and hides the assistant.
--------------------------------------------------------------------------- */
import { handleAssistant, handleHealth } from './assistant.mjs';

export { Budget } from './budget.mjs';

export default {
  /**
   * @param {Request} request
   * @param {{ASSETS: Fetcher, BUDGET?: DurableObjectNamespace, ASSIST_RL?: RateLimit}} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/assistant/health') return handleHealth(request, env);
    if (pathname === '/api/assistant') return handleAssistant(request, env, ctx);
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: { type: 'not_found', message: 'no such route' } }), {
        status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
