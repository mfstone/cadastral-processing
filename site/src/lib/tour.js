/* ---------------------------------------------------------------------------
   tour.js -- a guided first-visit tutorial for the application.

   On a first visit with no shared link in the address bar, the tour opens by
   itself after the first render and walks through every part of the page:
   the views, the slider and each filter, the map and its layers and legend,
   the charts, the reports, the theme, the assistant and sharing. Each step
   highlights the part it describes, and some steps set the dashboard to show
   it (a view, the parcels zoomed in). When the tour ends -- finished, skipped
   or closed with Escape -- the dashboard goes back to the view it had before,
   and the tour stays available as the "Tour" button in the header.

   A visitor who arrives on a shared link gets no tour over the content they
   were sent to, just a short note beside the button. "Seen" is remembered in
   localStorage where that works and for the session otherwise. Everything is
   DOM built here, no HTML strings from outside, so the strict CSP holds.
--------------------------------------------------------------------------- */

const SEEN_KEY = 'mtcad.tour.v1';
let memorySeen = false;

function seen() {
  try { return localStorage.getItem(SEEN_KEY) === 'done' || memorySeen; } catch { return memorySeen; }
}
function markSeen() {
  memorySeen = true;
  try { localStorage.setItem(SEEN_KEY, 'done'); } catch { /* private window: the session remembers */ }
}

const $ = (id) => document.getElementById(id);
const navButton = (view) => document.querySelector(`#nav button[data-view="${view}"]`);
const visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

/* The steps. `target` returns the element to highlight (none: a centred
   card); `state` is applied before the step shows; `skip` drops a step that
   does not apply here (the assistant on a deploy without one). Text is plain
   and short: what the thing is and what to do with it. */
function steps() {
  const view = (v, title, body) => ({ title, body, state: { view: v }, target: () => $('panel'), tab: v });
  return [
    { title: 'Welcome to the Montana Cadastral Analytics Engine',
      body: 'It follows Montana’s parcels across 29 statewide exports from 2003 to 2026: '
        + 'where land is being divided, what gets built, who owns it and the condition of the housing. '
        + 'This tutorial takes about two minutes. Use Next and Back, or the arrow keys. Press Escape to leave at any time.' },
    { title: 'The View menu', target: () => $('views-btn'),
      body: 'The button at the right of the header names the view you are looking at. Open it to choose another.' },
    { title: 'Choosing a view', target: () => $('nav'), menu: true,
      body: 'Each view answers one kind of question, and each has a line here on what it shows. All views share the '
        + 'same map, slider and filters, so a place and a date you choose stay chosen as you switch. The next steps show each view.' },
    view('ladder', 'Development',
      'Every parcel sits on a ladder: platted only, addressed, or built. This view shows how much of the land is on each '
        + 'rung, how quickly new lots get built on, and how many lots have sat unbuilt for five years or more.'),
    { title: 'Subdivision growth', state: { view: 'growth', snap: 10 }, target: () => document.querySelector('#panel .player') || $('panel'),
      body: 'Watch land being divided: lots split off by a new plat, an amended plat or a certificate of survey. Press Play to step through the exports one at a time, Pause to stop, and the arrows '
        + 'to move one export back or forward; the slider moves with it. Zoomed in, each lot that exists by the date shown is '
        + 'filled in the colour of the years it was created in, from red for the oldest to violet for the newest.' },
    view('condition', 'Condition',
      'The condition and age of homes, from the Department of Revenue’s building records at eight tax years. '
        + 'The rating covers dwellings only, so commercial parcels show no condition.'),
    view('ownership', 'Ownership',
      'Public, tribal trust and private land, and how far owners live from their land by mailing address. '
        + 'On this view an Owner origin filter appears, to pick the state owners mail from.'),
    view('fragmentation', 'Fragmentation',
      'How the land is divided by parcel size: acreage in each size class, the share in parcels under 40 acres, '
        + 'and agricultural acreage.'),
    view('churn', 'Churn',
      'How often parcels change hands each year, transfers to owners in other states, and new condominium units.'),
    view('thresholds', 'Thresholds',
      'New lots per thousand parcels, and the sizes of new parcels around the 20-acre line in state law. '
        + 'An Era filter appears here to compare 2003–2010, 2011–2019 and 2020–2026.'),
    view('holdings', 'Holdings',
      'Large private holdings of 640 acres or more, combined by owner within each county: how many, how much land, '
        + 'and how concentrated. This view always works by county.'),
    view('review', 'Review',
      'The large holdings that depend on a decision not yet made, such as whether two similar owner names are the same owner.'),
    { title: 'Snapshot slider', target: () => $('timewrap'), state: { view: 'ladder', level: 'township' },
      body: 'Drag the slider, or focus it and use the arrow keys, to choose an export date. The map and the figures change to that date, '
        + 'and every time chart marks it with a vertical line. Exports for 2012 and 2015 do not exist; a warning sign appears '
        + 'when the chosen date is missing a field.' },
    { title: 'Unit', filters: true, target: () => $('level').closest('label'),
      body: 'Show the map and figures by PLSS township, the six-mile survey squares, or by county.' },
    { title: 'Measure', filters: true, target: () => $('measure').closest('label'),
      body: 'Count parcels, or add up their acres. A few large parcels can dominate acres while many small ones dominate counts.' },
    { title: 'Basemap', filters: true, target: () => $('basemap').closest('label'),
      body: 'Outlines only draws no background. Montana is a basemap built from state data. OpenStreetMap loads from an outside server.' },
    { title: 'Mask low coverage', filters: true, target: () => $('mask').closest('label'),
      body: 'Early exports are missing some counties. With this on, places without comparable data are shown in grey instead of as zero.' },
    { title: 'The map', target: () => $('mapwrap'),
      body: 'Scroll or pinch to zoom and drag to pan. The charts follow the map: zoom in and they summarise the places in view, '
        + 'compared with their county and Montana. Click a township or county to show it instead; shift-click adds more. '
        + 'A selection holds only while it is on screen: pan away, or press Clear selection, and the charts follow the map again.' },
    { title: 'Parcels up close', target: () => $('mapwrap'),
      state: { view: 'ladder', map: { center: [-111.04, 45.68], zoom: 11.6 } },
      body: 'Zoom in far enough and individual parcels appear, coloured by the view. Click a parcel for its record: acres, rung, '
        + 'owner distance and when it was created. Parcel colours show the latest export and do not follow the slider; Subdivision growth shows parcels by the date they were created.' },
    { title: 'Legend', target: () => $('legend'), state: { map: null },
      body: 'The legend explains the colours for the current view and zoom. Grey means no comparable data, never zero.' },
    { title: 'Layers', target: () => $('layers'), open: () => { const d = $('layers'); if (d) d.open = true; },
      body: 'Turn reference layers on and off: parcels, the township grid, counties, roads, buildings, reservations, '
        + 'public lands and city limits.' },
    { title: 'Charts and tables', target: () => document.querySelector('#panel .card svg')?.closest('.card') || $('panel'),
      body: 'Point at a chart to read exact values. Under each chart, the table link opens the same numbers as a table. '
        + 'The cards start with the figures for your selection at the chosen date.' },
    { title: 'Reports', target: () => $('reports-btn'), state: { view: 'reports' },
      body: 'Its own button, beside the View menu: six printable documents built from the same tables, a county profile, a housing '
        + 'condition profile, statewide trends, a large-holdings update, a review worksheet and subdivision activity. '
        + 'Choose one, then print or save it as a PDF.' },
    { title: 'About', target: () => $('about-btn'), state: { view: 'about' },
      body: 'Its own button: how each view is built, where the data comes from, and the limits to keep in mind. '
        + 'Read it before quoting a figure.' },
    { title: 'Tutorial', target: () => $('tour-btn'),
      body: 'This tutorial. It stays here as a button, to run again whenever you like.' },
    { title: 'Light and dark', target: () => $('theme'),
      body: 'Switch between a light and a dark theme.' },
    { title: 'Ask', target: () => $('assist-toggle'), skip: () => !visible($('assist-toggle')),
      body: 'Type a question in plain words. The assistant sets the dashboard to show the answer and replies from the same tables, '
        + 'with the export date. “Restore my view” puts the dashboard back. It never names individual owners.' },
    { title: 'Share what you see',
      body: 'The address bar always holds the current view, date, unit, selection and map position. Copy it to share exactly what you see.' },
    { title: 'That’s the tutorial', target: () => $('tour-btn'), restore: true,
      body: 'Your view is back the way it was. Open the tutorial again at any time with the Tutorial button.' },
  ];
}

export function initTour({ applyState, getState, sharedLink = false, menu = null }) {
  const btn = $('tour-btn');
  if (!btn) return null;
  let root = null, list = [], i = 0, saved = null, layersWasOpen = null, lastFocus = null, busy = false;

  const build = () => {
    root = document.createElement('div');
    root.id = 'tour';
    const block = document.createElement('div');
    block.className = 'tour-block';
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.setAttribute('aria-describedby', 'tour-body');
    // A close button where people look for one, top right; the same as Exit.
    card.innerHTML = '<button type="button" id="tour-x" class="tour-x" aria-label="Close the tutorial" title="Close the tutorial">&times;</button>'
      + '<div class="tour-count" id="tour-count"></div>'
      + '<h2 id="tour-title"></h2><p id="tour-body"></p>'
      + '<div class="tour-bar"><i id="tour-progress"></i></div>'
      + '<div class="tour-actions"><button type="button" id="tour-skip" class="tour-link">Exit tutorial</button>'
      + '<span class="tour-gap"></span><button type="button" id="tour-back">Back</button>'
      + '<button type="button" id="tour-next" class="tour-primary">Next</button></div>';
    root.append(block, spot, card);
    document.body.appendChild(root);
    $('tour-next').addEventListener('click', () => go(i + 1));
    $('tour-back').addEventListener('click', () => go(i - 1));
    $('tour-skip').addEventListener('click', () => end());
    $('tour-x').addEventListener('click', () => end());
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); end(); }
      else if (e.key === 'ArrowRight' && e.target.tagName !== 'INPUT') { e.preventDefault(); go(i + 1); }
      else if (e.key === 'ArrowLeft' && e.target.tagName !== 'INPUT') { e.preventDefault(); go(i - 1); }
      else if (e.key === 'Tab') {
        // Focus stays in the card while the tour is open.
        const f = [...card.querySelectorAll('button:not([disabled])')];
        const k = f.indexOf(document.activeElement);
        if (e.shiftKey && k <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && k === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    addEventListener('resize', place);
  };

  function place() {
    if (!root || root.hidden) return;
    const s = list[i];
    const spot = root.querySelector('.tour-spot');
    const card = root.querySelector('.tour-card');
    const el = s && s.target ? s.target() : null;
    const phone = innerWidth <= 700;
    card.style.left = card.style.top = card.style.bottom = '';
    card.classList.toggle('tour-docked', phone);
    card.classList.remove('tour-docked-top');
    if (!el || !visible(el)) {
      spot.hidden = true;
      root.classList.add('tour-dim');
      if (!phone) { card.style.left = `${(innerWidth - card.offsetWidth) / 2}px`; card.style.top = `${Math.max(16, (innerHeight - card.offsetHeight) / 2)}px`; }
      return;
    }
    root.classList.remove('tour-dim');
    const r = el.getBoundingClientRect();
    const pad = 6;
    const box = { l: Math.max(4, r.left - pad), t: Math.max(4, r.top - pad) };
    box.w = Math.min(innerWidth - 4, r.right + pad) - box.l;
    box.h = Math.min(innerHeight - 4, r.bottom + pad) - box.t;
    Object.assign(spot.style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.w}px`, height: `${box.h}px` });
    spot.hidden = false;
    if (phone) {
      // Docked at the end of the screen with more room beside the subject:
      // at the top when the subject sits low (the chart sheet, the legend),
      // at the bottom when it sits high (the header, the filters).
      const below = innerHeight - (box.t + box.h), above = box.t;
      card.classList.toggle('tour-docked-top', above > below);
      return;
    }
    const cw = card.offsetWidth, chh = card.offsetHeight, m = 12;
    let left, top;
    if (innerHeight - (box.t + box.h) >= chh + m * 2) { top = box.t + box.h + m; left = box.l; }
    else if (box.t >= chh + m * 2) { top = box.t - chh - m; left = box.l; }
    else if (innerWidth - (box.l + box.w) >= cw + m * 2) { left = box.l + box.w + m; top = box.t; }
    else if (box.l >= cw + m * 2) { left = box.l - cw - m; top = box.t; }
    else { left = (innerWidth - cw) / 2; top = innerHeight - chh - 24; }   // a large target: over it, at the foot
    card.style.left = `${Math.min(Math.max(m, left), innerWidth - cw - m)}px`;
    card.style.top = `${Math.min(Math.max(m, top), innerHeight - chh - m)}px`;
  }

  async function go(n) {
    if (busy) return;
    if (n >= list.length) { end(); return; }
    if (n < 0) return;
    busy = true;
    // While a step loads (a view render, a map move) the buttons say so
    // rather than swallowing a click.
    $('tour-next').disabled = true;
    $('tour-back').disabled = true;
    root.setAttribute('aria-busy', 'true');
    // Skip steps that do not apply, in the direction of travel.
    const dir = n >= i ? 1 : -1;
    while (list[n] && list[n].skip && list[n].skip()) n += dir;
    if (!list[n]) { busy = false; $('tour-next').disabled = false; $('tour-back').disabled = i === 0; if (dir > 0) end(); return; }
    i = n;
    const s = list[i];
    try {
      // The View menu is open only on the steps about it; on a phone the
      // folded filter row opens for the steps about its controls.
      if (menu) { if (s.menu) menu.open(); else menu.close(); }
      $('filters')?.classList.toggle('open', !!s.filters);
      $('filters-more')?.setAttribute('aria-expanded', String(!!s.filters));
      if (s.restore && saved) await applyState(saved, { source: 'tour' });
      else if (s.state) await applyState(s.state, { source: 'tour', hash: false });
      if (s.open) s.open();
    } catch (err) { console.warn('tour:', err); }
    // Give the map and the panel a frame to settle before measuring.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t = s.target ? s.target() : null;
    if (t && visible(t) && t.closest('#panel')) t.scrollIntoView({ block: 'nearest' });
    $('tour-count').textContent = `${i + 1} of ${list.length}`;
    $('tour-title').textContent = s.title;
    $('tour-body').textContent = s.body;
    $('tour-progress').style.width = `${(100 * (i + 1)) / list.length}%`;
    $('tour-back').disabled = i === 0;
    $('tour-next').disabled = false;
    $('tour-next').textContent = i === list.length - 1 ? 'Finish' : 'Next';
    root.removeAttribute('aria-busy');
    place();
    busy = false;
    $('tour-next').focus();
  }

  async function start() {
    hint(false);
    if (root && !root.hidden) return;
    if (!root) build();
    saved = getState();
    layersWasOpen = $('layers') ? $('layers').open : null;
    lastFocus = document.activeElement;
    list = steps();
    i = 0;
    root.hidden = false;
    document.body.classList.add('touring');
    btn.setAttribute('aria-expanded', 'true');
    await go(0);
  }

  async function end() {
    if (!root || root.hidden) return;
    markSeen();
    root.hidden = true;
    if (menu) menu.close();
    $('filters')?.classList.remove('open');
    $('filters-more')?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('touring');
    btn.setAttribute('aria-expanded', 'false');
    // Back to the view the visitor had, as if the tour never touched it.
    if (saved) {
      try { await applyState(saved, { source: 'tour' }); } catch (err) { console.warn('tour:', err); }
    }
    if ($('layers') && layersWasOpen != null) $('layers').open = layersWasOpen;
    (btn || lastFocus)?.focus();
  }

  // A short note beside the button for a first visit on a shared link.
  function hint(show) {
    const h = $('tour-hint');
    if (!h) return;
    h.hidden = !show;
    btn.classList.toggle('tour-pulse', show);
  }

  btn.hidden = false;
  btn.addEventListener('click', start);
  $('tour-hint-x')?.addEventListener('click', () => { hint(false); markSeen(); });

  if (!seen()) {
    if (sharedLink) {
      hint(true);
      setTimeout(() => { hint(false); markSeen(); }, 12000);
    } else {
      start();
    }
  }
  return { start, end, go: (n) => go(n), get step() { return i; }, get open() { return !!root && !root.hidden; },
    get ready() { return !busy; },
    get count() { return list.length; } };
}
