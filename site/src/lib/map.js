/* ---------------------------------------------------------------------------
   map.js -- the choropleth surface.

   Two unit levels, both as plain GeoJSON sources: 4,135 PLSS townships (the
   primary analytic unit, because it comes free from the geocode and a Montanan
   can look up "T1S R26E") and 56 counties. No vector tiles and no PMTiles: the
   township layer is 158 KB gzipped once simplified at 50 m, which is 0.5% of a
   township's 9.6 km width and invisible at any zoom this dashboard uses.

   Colour is applied through `setFeatureState` rather than by rewriting the
   source, which keeps a repaint at a few milliseconds for 4,135 features.
   `removeFeatureState` is called before each repaint, or units keep a stale
   shade when they drop out of the current filter.

   A unit with no comparable data is painted in a distinct masked colour, never
   in the ramp's zero step: a reader cannot otherwise tell "no data" from
   "nothing happened", and conflating those is the easiest way to publish a
   false finding from this dataset.
--------------------------------------------------------------------------- */

import maplibregl from 'maplibre-gl';

const MT_BOUNDS = [[-116.4, 44.2], [-103.9, 49.1]];

function mapLine() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--map-line').trim();
  return v || '#9a978f';
}

/** The map's own ground, read from the theme so it does not stay light in dark mode. */
function mapGround() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--map-ground').trim();
  return v || '#eceae4';
}
// OpenFreeMap serves the style JSON at the path itself -- appending
// "/style.json" returns 404. Two styles so the basemap follows the theme.
const BASEMAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

export class UnitMap {
  constructor(container, { onSelect } = {}) {
    this.onSelect = onSelect || (() => {});
    this.level = 'township';
    this.selected = new Set();
    this._painted = { township: false, county: false };

    this.map = new maplibregl.Map({
      container,
      // No `glyphs` key at all. MapLibre validates the style and rejects
      // `glyphs: undefined` outright ("string expected, undefined found"),
      // which throws during construction and takes the whole page with it.
      // There are no symbol layers here -- unit labels are drawn in the panel,
      // not on the map -- so no glyph server is needed.
      style: {
        version: 8, sources: {}, layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': mapGround() } },
        ],
      },
      bounds: MT_BOUNDS, fitBoundsOptions: { padding: 18 },
      attributionControl: false, maxZoom: 13, minZoom: 4,
      dragRotate: false, pitchWithRotate: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Parcels & PLSS: Montana State Library / DOR',
    }), 'bottom-right');
    this.ready = new Promise((r) => this.map.on('load', r));
  }

  async init({ townships, counties }) {
    await this.ready;
    const m = this.map;
    m.addSource('twp', { type: 'geojson', data: townships, promoteId: 'tr_key' });
    m.addSource('cty', { type: 'geojson', data: counties, promoteId: 'county_n' });

    for (const [src, id] of [['twp', 'township'], ['cty', 'county']]) {
      m.addLayer({
        id: `${id}-fill`, type: 'fill', source: src,
        paint: {
          'fill-color': ['coalesce', ['feature-state', 'color'], 'rgba(0,0,0,0)'],
          'fill-opacity': 0.88,
        },
      });
      m.addLayer({
        id: `${id}-line`, type: 'line', source: src,
        paint: {
          'line-color': mapLine(),
          'line-width': id === 'county' ? 0.9 : 0.35,
          'line-opacity': id === 'county' ? 0.85 : 0.5,
        },
      });
      // Selection is driven through a PAINT expression, not a filter:
      // MapLibre rejects feature-state in filters ("feature-state data
      // expressions are not supported with filters") and the error surfaces at
      // style-validation time, taking the map down with it.
      m.addLayer({
        id: `${id}-sel`, type: 'line', source: src,
        paint: {
          'line-color': getComputedStyle(document.documentElement)
            .getPropertyValue('--ink-1').trim() || '#0b0b0b',
          'line-width': 2.2,
          'line-opacity': ['case', ['boolean', ['feature-state', 'sel'], false], 1, 0],
        },
      });
      m.on('click', `${id}-fill`, (e) => {
        const f = e.features && e.features[0];
        if (f) this.onSelect(id, f.id, f.properties, e.originalEvent.shiftKey);
      });
      m.on('mouseenter', `${id}-fill`, () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', `${id}-fill`, () => { m.getCanvas().style.cursor = ''; });
    }
    this.setLevel('township');
  }

  setLevel(level) {
    this.level = level;
    for (const id of ['township', 'county']) {
      const on = id === level ? 'visible' : 'none';
      for (const sfx of ['fill', 'sel']) {
        if (this.map.getLayer(`${id}-${sfx}`)) {
          this.map.setLayoutProperty(`${id}-${sfx}`, 'visibility', on);
        }
      }
      // County outlines stay visible beneath the township surface for orientation.
      if (this.map.getLayer(`${id}-line`)) {
        this.map.setLayoutProperty(`${id}-line`, 'visibility',
          id === 'county' ? 'visible' : on);
      }
    }
  }

  get source() { return this.level === 'township' ? 'twp' : 'cty'; }

  /** Repaint from a Map of featureId -> css colour. Stale state is cleared first. */
  paint(colors) {
    const src = this.source;
    if (this._painted[this.level]) this.map.removeFeatureState({ source: src });
    this._painted[this.level] = true;
    for (const [id, color] of colors) {
      this.map.setFeatureState({ source: src, id }, { color });
    }
    this.applySelection();
  }

  applySelection() {
    const src = this.source;
    for (const id of this.selected) {
      this.map.setFeatureState({ source: src, id }, { sel: true });
    }
  }

  setSelection(ids) {
    const src = this.source;
    for (const id of this.selected) {
      if (!ids.has(id)) this.map.setFeatureState({ source: src, id }, { sel: false });
    }
    this.selected = new Set(ids);
    this.applySelection();
  }

  /** Swap between the external basemap and a first-party outlines-only view.
   *
   * The basemap is additive and opt-in: its sources and non-symbol layers are
   * grafted BENEATH our own, so the page renders fully from first-party data if
   * the origin is unavailable or blocked.
   *
   * Two details matter. The style declares more than one source -- a raster
   * relief layer AND the vector tiles the layers actually reference -- so every
   * source must be registered and each layer's `source` remapped; taking the
   * first key alone grafts the raster and every vector layer then fails with
   * "requires a vector source". And symbol layers are skipped because they need
   * a glyph server, which this style deliberately declares none of.
   */
  async setBasemap(kind) {
    const m = this.map;
    this._basemapKind = kind;
    // Always tear down first: switching themes reloads in the other variant.
    for (const id of this._baseLayers || []) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    for (const id of this._baseSources || []) {
      if (m.getSource(id)) m.removeSource(id);
    }
    this._baseLayers = [];
    this._baseSources = [];
    if (kind === 'none') return;

    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.getAttribute('data-theme')
          && window.matchMedia('(prefers-color-scheme: dark)').matches);
    try {
      const res = await fetch(BASEMAP_STYLES[dark ? 'dark' : 'light']);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const style = await res.json();

      const srcMap = {};
      for (const [name, def] of Object.entries(style.sources || {})) {
        const id = `base-src-${name}`;
        if (!m.getSource(id)) m.addSource(id, def);
        srcMap[name] = id;
        this._baseSources.push(id);
      }
      // Graft beneath our own fills so the choropleth stays on top.
      const beneath = ['township-fill', 'county-fill']
        .find((id) => m.getLayer(id));
      for (const layer of style.layers || []) {
        if (layer.type === 'background' || layer.type === 'symbol') continue;
        const src = srcMap[layer.source];
        if (!src) continue;
        const id = `base-${layer.id}`;
        m.addLayer({ ...layer, id, source: src }, beneath);
        this._baseLayers.push(id);
      }
      // Our own fills become translucent so the basemap reads through.
      for (const id of ['township-fill', 'county-fill']) {
        if (m.getLayer(id)) m.setPaintProperty(id, 'fill-opacity', 0.68);
      }
    } catch (err) {
      console.warn('basemap unavailable; outlines only', err);
      this._basemapKind = 'none';
    }
    if (kind === 'none' || this._basemapKind === 'none') {
      for (const id of ['township-fill', 'county-fill']) {
        if (m.getLayer(id)) m.setPaintProperty(id, 'fill-opacity', 0.88);
      }
    }
  }

  fitTo(bbox) { if (bbox) this.map.fitBounds(bbox, { padding: 30, maxZoom: 11 }); }

  /** Re-read themed colours after a light/dark switch. */
  retheme() {
    // Reload the external basemap in the matching variant, if one is active.
    if (this._basemapKind && this._basemapKind !== 'none') {
      const kind = this._basemapKind;
      this.setBasemap('none');
      this.setBasemap(kind);
    }
    if (this.map.getLayer('bg')) {
      this.map.setPaintProperty('bg', 'background-color', mapGround());
    }
    const line = getComputedStyle(document.documentElement)
      .getPropertyValue('--map-line').trim() || '#9a978f';
    for (const id of ['township-line', 'county-line']) {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-color', line);
    }
    const sel = getComputedStyle(document.documentElement)
      .getPropertyValue('--ink-1').trim() || '#0b0b0b';
    for (const id of ['township-sel', 'county-sel']) {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, 'line-color', sel);
    }
  }
}

/** Quantile breaks, so a skewed distribution still fills the ramp. */
export function quantileBreaks(values, nClasses) {
  const v = Array.from(values).filter((x) => isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return [];
  const out = [];
  for (let i = 1; i < nClasses; i++) out.push(v[Math.floor((i / nClasses) * v.length)]);
  return out.filter((x, i, a) => i === 0 || x > a[i - 1]);
}

export function classify(value, breaks) {
  let i = 0;
  while (i < breaks.length && value >= breaks[i]) i++;
  return i;
}
