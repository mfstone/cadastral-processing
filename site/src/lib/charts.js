/* ---------------------------------------------------------------------------
   charts.js -- inline SVG chart primitives.

   Built to the project's visualization rules rather than to taste:

   * Form follows the data's job. Ordered categories (parcel-size classes, the
     development ladder, distance tiers) get an ORDINAL one-hue ramp, because
     they carry magnitude; only identity dimensions (tenure) get categorical
     hues. Nothing here ever uses a rainbow or a hue at a diverging midpoint.
   * One axis, always. Two measures of different scale become two charts.
   * Thin marks; a 2px surface-coloured gap between stacked fills so segment
     boundaries read without outlines; recessive grid and axes.
   * A hover layer by default: crosshair plus tooltip on line and area, per-mark
     tooltip on bars.
   * A legend whenever two or more series are drawn, with direct labels on the
     last point when four or fewer -- so identity is never carried by colour
     alone. Every chart also offers a table view.

   Colours are read from CSS custom properties at render time, so the light and
   dark palettes swap in one place and the chart body names only roles.
--------------------------------------------------------------------------- */

const NS = 'http://www.w3.org/2000/svg';
const GAP = 2;            // surface gap between stacked fills, in px

function el(name, attrs = {}, parent = null) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(n);
  return n;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
export function ramp(prefix, n) {
  return Array.from({ length: n }, (_, i) => cssVar(`--${prefix}-${i + 1}`));
}

export const fmtInt = (v) => (v == null || !isFinite(v) ? '--' : Math.round(v).toLocaleString());
export const fmtPct = (v, d = 1) => (v == null || !isFinite(v) ? '--' : `${v.toFixed(d)}%`);
export const fmtAc = (v) => {
  if (v == null || !isFinite(v)) return '--';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M ac`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3).toLocaleString()}k ac`;
  return `${Math.round(v).toLocaleString()} ac`;
};

/* ------------------------------------------------------------------ tooltip */
let _tip;
function tip() {
  if (!_tip) {
    _tip = document.createElement('div');
    _tip.className = 'tip';
    _tip.hidden = true;
    document.body.appendChild(_tip);
  }
  return _tip;
}
export function showTip(html, ev) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 12;
  const r = t.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 4) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 4) y = ev.clientY - r.height - pad;
  t.style.left = `${Math.max(4, x)}px`;
  t.style.top = `${Math.max(4, y)}px`;
}
export function hideTip() { if (_tip) _tip.hidden = true; }

/* ------------------------------------------------------------------- scales */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * mag) return m * mag;
  }
  return 10 * mag;
}

function frame(host, { height = 190, padL = 46, padR = 12, padT = 10, padB = 22 } = {}) {
  host.textContent = '';
  const width = Math.max(260, host.clientWidth || 360);
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`, role: 'img',
    preserveAspectRatio: 'none', style: `height:${height}px`,
  }, host);
  return { svg, width, height, x0: padL, x1: width - padR, y0: padT, y1: height - padB };
}

function yAxis(svg, f, max, fmt = fmtInt, ticks = 4) {
  const g = el('g', { class: 'grid' }, svg);
  const a = el('g', { class: 'axis' }, svg);
  for (let i = 0; i <= ticks; i++) {
    const v = (max * i) / ticks;
    const y = f.y1 - (v / max) * (f.y1 - f.y0);
    el('line', { x1: f.x0, x2: f.x1, y1: y, y2: y }, g);
    const t = el('text', { x: f.x0 - 6, y: y + 3.5, 'text-anchor': 'end' }, a);
    t.textContent = fmt(v);
  }
  el('line', { x1: f.x0, x2: f.x0, y1: f.y0, y2: f.y1 }, a);
}

function xTicks(svg, f, labels, every) {
  const a = el('g', { class: 'axis' }, svg);
  el('line', { x1: f.x0, x2: f.x1, y1: f.y1, y2: f.y1 }, a);
  const n = labels.length;
  const step = every || Math.max(1, Math.ceil(n / 7));
  for (let i = 0; i < n; i += step) {
    const x = f.x0 + (n === 1 ? 0 : (i / (n - 1)) * (f.x1 - f.x0));
    const t = el('text', { x, y: f.y1 + 13, 'text-anchor': 'middle' }, a);
    t.textContent = labels[i];
  }
}

/* --------------------------------------------------------------- table view */
function tableView(host, headers, rows, caption) {
  const d = document.createElement('details');
  d.className = 'tableview';
  const s = document.createElement('summary');
  s.textContent = caption || 'Table view';
  d.appendChild(s);
  const t = document.createElement('table');
  t.className = 'data';
  const thead = t.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.appendChild(th);
  }
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    r.forEach((c) => { tr.insertCell().textContent = c; });
  }
  d.appendChild(t);
  host.appendChild(d);
}

/* -------------------------------------------------------------- legend row */
export function legendRow(host, items) {
  const d = document.createElement('div');
  d.className = 'legend-row';
  for (const { label, color } of items) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = color;
    s.appendChild(i);
    s.appendChild(document.createTextNode(label));
    d.appendChild(s);
  }
  host.appendChild(d);
}

/* ------------------------------------------------------------ stacked area */
/**
 * Ordered composition over time. Series must be ORDERED (size classes, ladder
 * stages, distance tiers) because the fill ramp encodes magnitude.
 */
export function stackedArea(host, {
  series, labels, colors, xLabels, height = 200, fmt = fmtInt,
  share = false, caption,
}) {
  const wrap = document.createElement('div');
  host.appendChild(wrap);
  const f = frame(wrap, { height });
  const n = xLabels.length;
  const k = series.length;

  const totals = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) totals[i] += series[j][i] || 0;
  const max = share ? 100 : niceMax(Math.max(...totals));
  yAxis(f.svg, f, max, share ? ((v) => `${Math.round(v)}%`) : fmt);

  const X = (i) => f.x0 + (n === 1 ? 0 : (i / (n - 1)) * (f.x1 - f.x0));
  const Y = (v) => f.y1 - (max ? (v / max) * (f.y1 - f.y0) : 0);

  // Cumulative from the top so the gap is drawn on the shared boundary.
  const cum = Array.from({ length: k + 1 }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < k; j++) {
      const v = share && totals[i] ? (100 * (series[j][i] || 0)) / totals[i] : (series[j][i] || 0);
      acc += v;
      cum[j + 1][i] = acc;
    }
  }
  for (let j = 0; j < k; j++) {
    const top = cum[j + 1], bot = cum[j];
    let d = '';
    for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${(Y(top[i]) + (j < k - 1 ? GAP / 2 : 0)).toFixed(1)}`;
    for (let i = n - 1; i >= 0; i--) d += `L${X(i).toFixed(1)},${(Y(bot[i]) - (j > 0 ? GAP / 2 : 0)).toFixed(1)}`;
    el('path', { d: `${d}Z`, fill: colors[j], stroke: 'none' }, f.svg);
  }
  xTicks(f.svg, f, xLabels);

  // Direct labels on the widest segment when the series count is small.
  if (k <= 4) {
    for (let j = 0; j < k; j++) {
      const mid = n - 1;
      const yMid = (Y(cum[j][mid]) + Y(cum[j + 1][mid])) / 2;
      if (Math.abs(Y(cum[j][mid]) - Y(cum[j + 1][mid])) > 13) {
        const t = el('text', {
          x: f.x1 - 4, y: yMid + 3.5, 'text-anchor': 'end', class: 'lab-direct',
        }, f.svg);
        t.textContent = labels[j];
      }
    }
  }

  // Crosshair + tooltip.
  const ch = el('line', { class: 'crosshair', y1: f.y0, y2: f.y1, x1: -99, x2: -99 }, f.svg);
  const hit = el('rect', {
    class: 'hit', x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0,
  }, f.svg);
  hit.addEventListener('mousemove', (ev) => {
    const bb = f.svg.getBoundingClientRect();
    const px = ((ev.clientX - bb.left) / bb.width) * f.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - f.x0) / (f.x1 - f.x0)) * (n - 1))));
    ch.setAttribute('x1', X(i)); ch.setAttribute('x2', X(i));
    const rows = series.map((s, j) => {
      const v = s[i] || 0;
      const pc = totals[i] ? (100 * v) / totals[i] : 0;
      return `<tr><td><i style="background:${colors[j]}"></i>${labels[j]}</td><td>${fmt(v)}</td><td>${pc.toFixed(1)}%</td></tr>`;
    }).reverse().join('');
    showTip(`<div class="t">${xLabels[i]}</div><table>${rows}</table>`, ev);
  });
  hit.addEventListener('mouseleave', () => {
    hideTip(); ch.setAttribute('x1', -99); ch.setAttribute('x2', -99);
  });

  legendRow(wrap, labels.map((l, j) => ({ label: l, color: colors[j] })));
  tableView(wrap, ['', ...xLabels], series.map((s, j) => [labels[j], ...Array.from(s, fmt)]), caption);
  return wrap;
}

/* -------------------------------------------------------------- line chart */
export function lineChart(host, {
  series, labels, colors, xLabels, height = 190, fmt = fmtInt, caption, yMax,
}) {
  const wrap = document.createElement('div');
  host.appendChild(wrap);
  const f = frame(wrap, { height });
  const n = xLabels.length;
  const max = yMax || niceMax(Math.max(...series.flatMap((s) => Array.from(s))));
  yAxis(f.svg, f, max, fmt);
  const X = (i) => f.x0 + (n === 1 ? 0 : (i / (n - 1)) * (f.x1 - f.x0));
  const Y = (v) => f.y1 - (max ? (v / max) * (f.y1 - f.y0) : 0);

  series.forEach((s, j) => {
    let d = '';
    for (let i = 0; i < n; i++) {
      if (s[i] == null || !isFinite(s[i])) continue;
      d += `${d ? 'L' : 'M'}${X(i).toFixed(1)},${Y(s[i]).toFixed(1)}`;
    }
    el('path', { d, fill: 'none', stroke: colors[j], 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, f.svg);
    if (series.length <= 4 && n) {
      const last = n - 1;
      if (isFinite(s[last])) {
        const t = el('text', { x: X(last) - 3, y: Y(s[last]) - 6, 'text-anchor': 'end', class: 'lab-direct' }, f.svg);
        t.textContent = labels[j];
      }
    }
  });
  xTicks(f.svg, f, xLabels);

  const ch = el('line', { class: 'crosshair', y1: f.y0, y2: f.y1, x1: -99, x2: -99 }, f.svg);
  const dots = series.map((_, j) => el('circle', {
    r: 4, fill: colors[j], stroke: cssVar('--surface-1'), 'stroke-width': 2,
    cx: 0, cy: 0, opacity: 0,
  }, f.svg));
  const hit = el('rect', { class: 'hit', x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0 }, f.svg);
  hit.addEventListener('mousemove', (ev) => {
    const bb = f.svg.getBoundingClientRect();
    const px = ((ev.clientX - bb.left) / bb.width) * f.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - f.x0) / (f.x1 - f.x0)) * (n - 1))));
    ch.setAttribute('x1', X(i)); ch.setAttribute('x2', X(i));
    series.forEach((s, j) => {
      const ok = isFinite(s[i]);
      dots[j].setAttribute('opacity', ok ? 1 : 0);
      if (ok) { dots[j].setAttribute('cx', X(i)); dots[j].setAttribute('cy', Y(s[i])); }
    });
    const rows = series.map((s, j) =>
      `<tr><td><i style="background:${colors[j]}"></i>${labels[j]}</td><td>${fmt(s[i])}</td></tr>`).join('');
    showTip(`<div class="t">${xLabels[i]}</div><table>${rows}</table>`, ev);
  });
  hit.addEventListener('mouseleave', () => {
    hideTip(); ch.setAttribute('x1', -99); ch.setAttribute('x2', -99);
    dots.forEach((d) => d.setAttribute('opacity', 0));
  });

  if (series.length >= 2) legendRow(wrap, labels.map((l, j) => ({ label: l, color: colors[j] })));
  tableView(wrap, ['', ...xLabels], series.map((s, j) => [labels[j], ...Array.from(s, fmt)]), caption);
  return wrap;
}

/* ------------------------------------------------------------- bar / hist  */
/** Vertical bars with 4px rounded data-ends anchored to the baseline. */
export function histogram(host, {
  values, xLabels, color, height = 190, fmt = fmtInt, refAt, refLabel, caption,
  xTickEvery,
}) {
  const wrap = document.createElement('div');
  host.appendChild(wrap);
  const f = frame(wrap, { height });
  const n = values.length;
  const max = niceMax(Math.max(...values));
  yAxis(f.svg, f, max, fmt);
  const bw = (f.x1 - f.x0) / n;
  const fill = color || cssVar('--cat-1');
  for (let i = 0; i < n; i++) {
    const v = values[i] || 0;
    const h = max ? (v / max) * (f.y1 - f.y0) : 0;
    const x = f.x0 + i * bw;
    const r = el('rect', {
      x: x + Math.min(1, bw * 0.08), y: f.y1 - h,
      width: Math.max(1, bw - Math.min(2, bw * 0.16)), height: Math.max(0, h),
      rx: Math.min(4, bw / 2.5), fill,
    }, f.svg);
    r.addEventListener('mouseenter', (ev) =>
      showTip(`<div class="t">${xLabels[i]}</div>${fmt(v)}`, ev));
    r.addEventListener('mousemove', (ev) =>
      showTip(`<div class="t">${xLabels[i]}</div>${fmt(v)}`, ev));
    r.addEventListener('mouseleave', hideTip);
  }
  if (refAt != null && refAt >= 0 && refAt <= n) {
    const x = f.x0 + refAt * bw;
    el('line', { class: 'refline', x1: x, x2: x, y1: f.y0 - 2, y2: f.y1 }, f.svg);
    if (refLabel) {
      const t = el('text', { x: x + 5, y: f.y0 + 8, class: 'reflab' }, f.svg);
      t.textContent = refLabel;
    }
  }
  xTicks(f.svg, f, xLabels, xTickEvery);
  tableView(wrap, ['bin', 'value'], values.map((v, i) => [xLabels[i], fmt(v)]), caption);
  return wrap;
}

/** Horizontal ranked bars, always direct-labelled. */
export function rankBars(host, { items, color, fmt = fmtInt, caption, max: givenMax }) {
  const wrap = document.createElement('div');
  host.appendChild(wrap);
  const rowH = 19;
  const f = frame(wrap, { height: Math.max(40, items.length * rowH + 10), padL: 112, padB: 6, padT: 4 });
  const max = givenMax || niceMax(Math.max(...items.map((d) => d.value)));
  const fill = color || cssVar('--cat-1');
  items.forEach((d, i) => {
    const y = f.y0 + i * rowH;
    const w = max ? (d.value / max) * (f.x1 - f.x0) : 0;
    const r = el('rect', {
      x: f.x0, y: y + 3, width: Math.max(1, w), height: rowH - 8,
      rx: Math.min(4, (rowH - 8) / 2), fill,
    }, f.svg);
    const lab = el('text', { x: f.x0 - 7, y: y + rowH / 2 + 1.5, 'text-anchor': 'end' }, f.svg);
    lab.textContent = d.label;
    const val = el('text', {
      x: f.x0 + Math.max(1, w) + 5, y: y + rowH / 2 + 1.5, class: 'lab-direct',
    }, f.svg);
    val.textContent = fmt(d.value);
    const on = (ev) => showTip(`<div class="t">${d.label}</div>${d.detail || fmt(d.value)}`, ev);
    r.addEventListener('mouseenter', on);
    r.addEventListener('mousemove', on);
    r.addEventListener('mouseleave', hideTip);
  });
  tableView(wrap, ['', 'value'], items.map((d) => [d.label, fmt(d.value)]), caption);
  return wrap;
}

/**
 * Small multiples: one mini chart per facet, sharing a y-scale.
 *
 * The fold-to form when a categorical dimension exceeds what hue can carry.
 * Seven reservations cannot be told apart as seven lines, and generating an
 * eighth hue is never the answer; faceting keeps every series in the first
 * categorical slot and lets position carry identity instead of colour.
 */
export function smallMultiples(host, {
  facets, xLabels, color, yMax = 100, fmt = (v) => `${Math.round(v)}%`,
  height = 62, caption, cols = 2,
}) {
  const wrap = document.createElement('div');
  wrap.style.display = 'grid';
  wrap.style.gridTemplateColumns = `repeat(${cols}, minmax(0,1fr))`;
  wrap.style.gap = '10px 14px';
  host.appendChild(wrap);
  const fill = color || cssVar('--cat-1');

  for (const f of facets) {
    const cell = document.createElement('div');
    wrap.appendChild(cell);
    const t = document.createElement('div');
    t.style.cssText = 'font-size:11px;font-weight:650;color:var(--ink-1);margin-bottom:1px';
    const last = [...f.values].reverse().find((v) => isFinite(v));
    t.textContent = `${f.label} · ${fmt(last ?? NaN)}`;
    cell.appendChild(t);

    // frame() clears its host, so the svg gets its own container and the
    // title above it survives.
    const plot = document.createElement('div');
    cell.appendChild(plot);
    const fr = frame(plot, { height, padL: 4, padR: 4, padT: 5, padB: 4 });
    const n = f.values.length;
    const X = (i) => fr.x0 + (n === 1 ? 0 : (i / (n - 1)) * (fr.x1 - fr.x0));
    const Y = (v) => fr.y1 - (v / yMax) * (fr.y1 - fr.y0);
    // A recessive 50% reference so the facets are comparable at a glance.
    el('line', { x1: fr.x0, x2: fr.x1, y1: Y(yMax / 2), y2: Y(yMax / 2),
      stroke: cssVar('--grid'), 'stroke-width': 1 }, fr.svg);
    let d = '';
    for (let i = 0; i < n; i++) {
      if (!isFinite(f.values[i])) continue;
      d += `${d ? 'L' : 'M'}${X(i).toFixed(1)},${Y(f.values[i]).toFixed(1)}`;
    }
    el('path', { d, fill: 'none', stroke: fill, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, fr.svg);

    const hit = el('rect', { class: 'hit', x: fr.x0, y: fr.y0,
      width: fr.x1 - fr.x0, height: fr.y1 - fr.y0 }, fr.svg);
    // Hidden by opacity, not by moving off-canvas: `svg { overflow: visible }`
    // means a mark parked outside the viewBox still paints.
    const dot = el('circle', { r: 3.5, fill, stroke: cssVar('--surface-1'),
      'stroke-width': 2, cx: 0, cy: 0, opacity: 0 }, fr.svg);
    hit.addEventListener('mousemove', (ev) => {
      const bb = fr.svg.getBoundingClientRect();
      const px = ((ev.clientX - bb.left) / bb.width) * fr.width;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - fr.x0) / (fr.x1 - fr.x0)) * (n - 1))));
      const ok = isFinite(f.values[i]);
      dot.setAttribute('opacity', ok ? 1 : 0);
      if (ok) { dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(f.values[i])); }
      showTip(`<div class="t">${f.label}</div>${xLabels[i]}: ${fmt(f.values[i])}`, ev);
    });
    hit.addEventListener('mouseleave', () => {
      hideTip(); dot.setAttribute('opacity', 0);
    });
  }
  tableView(host, ['', ...xLabels],
    facets.map((f) => [f.label, ...Array.from(f.values, fmt)]), caption);
  return wrap;
}

/** A stat tile row. Values wear ink, never a series colour. */
export function stats(host, items) {
  const d = document.createElement('div');
  d.className = 'stats';
  for (const it of items) {
    const s = document.createElement('div');
    s.className = 'stat';
    s.innerHTML = `<div class="v">${it.value}</div><div class="k">${it.label}</div>` +
      (it.detail ? `<div class="d">${it.detail}</div>` : '');
    d.appendChild(s);
  }
  host.appendChild(d);
  return d;
}

export function card(host, title, caption) {
  const c = document.createElement('div');
  c.className = 'card';
  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    c.appendChild(h);
  }
  if (caption) {
    const p = document.createElement('div');
    p.className = 'cap';
    p.textContent = caption;
    c.appendChild(p);
  }
  host.appendChild(c);
  return c;
}

/* ------------------------------------------------------------------- table */
/** A visible data table (the chart table-views are collapsed by default). */
export function table(host, { headers, rows, caption, html = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'tablewrap';
  if (caption) {
    const c = document.createElement('div');
    c.className = 'cap';
    c.textContent = caption;
    wrap.appendChild(c);
  }
  const t = document.createElement('table');
  t.className = 'data';
  const thead = t.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.appendChild(th);
  }
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    r.forEach((c) => {
      const td = tr.insertCell();
      if (html && typeof c === 'string' && c.startsWith('<')) td.innerHTML = c;
      else td.textContent = c;
    });
  }
  wrap.appendChild(t);
  host.appendChild(wrap);
  return wrap;
}
