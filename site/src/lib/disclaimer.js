/* ---------------------------------------------------------------------------
   disclaimer.js -- the opening notice: the terms of use, shown once.

   On a first visit (shared link or not) the page opens behind this notice,
   and nothing else starts -- the tutorial included -- until the reader
   accepts it. Accepting is remembered in localStorage where that works and
   for the session otherwise; the same text stays in About, under Terms of
   use. The text is about.js's, a fixed string of this site's own, so the
   strict CSP holds.
--------------------------------------------------------------------------- */
import { DISCLAIMER_TITLE, DISCLAIMER_HTML } from './about.js';

const KEY = 'mtcad.terms.v1';
let memory = false;

export function accepted() {
  try { return localStorage.getItem(KEY) === 'accepted' || memory; } catch { return memory; }
}
function remember() {
  memory = true;
  try { localStorage.setItem(KEY, 'accepted'); } catch { /* private window: the session remembers */ }
}

/** Resolves once the notice has been accepted (at once if it already was). */
export function showDisclaimer() {
  if (accepted()) return Promise.resolve();
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'terms';
    root.innerHTML = `<div class="terms-card" role="dialog" aria-modal="true" aria-labelledby="terms-title" aria-describedby="terms-body">
      <div class="terms-eyebrow">Montana Cadastral Analytics Engine</div>
      <h2 id="terms-title">${DISCLAIMER_TITLE}</h2>
      <div id="terms-body" class="terms-body">${DISCLAIMER_HTML}</div>
      <div class="terms-actions"><span class="terms-note">This notice stays in About, under Terms of use.</span>
        <button type="button" id="terms-ok" class="tour-primary">I understand</button></div></div>`;
    document.body.appendChild(root);
    const app = document.getElementById('app');
    app?.setAttribute('aria-hidden', 'true');
    const ok = root.querySelector('#terms-ok');
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      // Focus stays in the notice until it is accepted.
      const f = [...root.querySelectorAll('a[href], button')];
      const k = f.indexOf(document.activeElement);
      if (e.shiftKey && k <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && k === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });
    ok.addEventListener('click', () => {
      remember();
      root.remove();
      app?.removeAttribute('aria-hidden');
      resolve();
    });
    // Focus the button without scrolling to it: the notice is read from the top.
    ok.focus({ preventScroll: true });
    root.querySelector('.terms-card').scrollTop = 0;
  });
}
