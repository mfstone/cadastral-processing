/* ---------------------------------------------------------------------------
   tools.js -- the assistant's six tools, as plain data.

   This file is imported by three parties and must stay free of DOM and
   browser code: the Worker pins this list into every request to the model;
   the page executes the calls the model makes (execute.js); the prompt
   builder and the tests read it. The order is fixed and the serialisation is
   deterministic, because the tool list is the first thing in the cached
   prompt prefix and a reordered list is a cache miss on every request.

   Every schema is strict: additionalProperties false, every property
   required, optional ones nullable. Range checks (an index past the last
   snapshot, a county that does not exist) are done by the executors, which
   can say what the right value would have been.
--------------------------------------------------------------------------- */

const VIEWS = ['ladder', 'condition', 'ownership', 'fragmentation', 'churn', 'thresholds', 'holdings', 'review', 'reports', 'about'];
const nullable = (type) => (Array.isArray(type) ? [...type, 'null'] : [type, 'null']);
const str = (description) => ({ type: ['string', 'null'], description });
const bool = (description) => ({ type: ['boolean', 'null'], description });
const int = (description) => ({ type: ['integer', 'null'], description });
const strEnum = (values, description) => ({ type: ['string', 'null'], enum: [...values, null], description });
const obj = (properties, description) => ({
  type: ['object', 'null'], description, properties, required: Object.keys(properties), additionalProperties: false,
});
const intList = (description) => ({ type: ['array', 'null'], items: { type: 'integer' }, description });

export const DERIVED_MEASURES = [
  'addressed_unbuilt_share', 'out_of_state_share', 'under_40ac_acreage_share', 'owner_change_pct_per_year',
  'new_lots_per_1000_per_year', 'transfers_out_of_state_per_year', 'address_changes_per_year', 'units_created_per_year',
  'clo4_pct', 'mean_large_holding_acres', 'large_acres_share_of_private', 'large_oos_share', 'large_provisional_share',
  'fair_or_worse_share', 'pre_1980_share',
];
export const SERIES_TOPICS = ['core', 'dev', 'tenure', 'locality', 'size', 'class', 'owner_origin', 'ag', 'improve',
  'flow', 'holdings', 'cama', 'owner_state'];
export const QUERY_TABLES = ['absorption', 'size_histogram', 'county_size_histogram', 'threshold_edges', 'dormant',
  'dormant_by_size', 'county_owner_state', 'reservation_stock', 'holdings_county', 'holdings_top', 'holdings_review',
  'regression_table1', 'cama_county', 'cama_township', 'cama_timing', 'cama_condition_decade', 'cama_transitions',
  'county_stock', 'county_flow'];
export const REPORT_KINDS = ['profile', 'condition', 'trends', 'holdings', 'worksheet', 'activity'];

export const TOOLS = [
  {
    name: 'get_dashboard_state',
    description: 'Return what the dashboard currently shows: the view, the vintage (export date), the unit level, '
      + 'the selection as place names, the filters, the map extent and layers, and the caveats that apply to the view. '
      + 'Call this when you need the current context and the conversation does not already carry it. '
      + 'configure_dashboard returns the same description, so do not call both in one turn.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'configure_dashboard',
    description: 'Change what the user is looking at. Every field is optional (null keeps the current value). '
      + 'Call it once per turn, before you read numbers, so the user sees what you are describing. '
      + 'Use lookup_place first to turn a place name into a county code or township id; never guess ids. '
      + 'Holdings and Review are county-level views (the level is forced). Snapshot 10 (2009-07-05) has no '
      + 'development ladder or agricultural acreage. The result is the resulting state plus warnings about anything '
      + 'that was coerced or could not be applied.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        view: strEnum(VIEWS, 'The view (tab) to show.'),
        snapshot: obj({
          index: int('Export index 0..28; use this or date.'),
          date: str('An export date YYYY-MM-DD, or a year YYYY (its last export); resolved to the nearest export at or before.'),
        }, 'The vintage to show.'),
        level: strEnum(['township', 'county'], 'The aggregate unit: PLSS township or county.'),
        measure: strEnum(['parcels', 'acres'], 'Count parcels or sum acres, where a view supports both.'),
        selection: obj({
          counties: intList('County codes 1-56 to focus on (sets the level to county).'),
          townships: intList('Township ids to focus on (sets the level to township).'),
          clear: bool('true to return to the statewide figures.'),
        }, 'Which units the charts focus on. Omit to keep the current selection.'),
        era: strEnum(['all', 'early', 'mid', 'late'], 'Thresholds view only: all, early (2003-2010), mid (2011-2019) or late (2020-2026).'),
        origin_state: str('Ownership view only: a two-letter state to map where its owners hold land, or "" for all origins.'),
        mask_low_coverage: bool('Grey out units whose record is not yet complete in the vintage (default true).'),
        basemap: strEnum(['none', 'montana', 'positron'], 'Outlines only, the in-house Montana basemap, or OpenStreetMap.'),
        layers: obj({
          parcels: bool(null), parcel_fill: bool(null), townships: bool(null), counties: bool(null), roads: bool(null),
          buildings: bool(null), reservations: bool(null), public_lands: bool(null), city_limits: bool(null),
        }, 'Reference layers on or off. Parcels draw only past zoom 10.'),
        map: obj({
          fit: strEnum(['statewide', 'selection', 'county', 'township', 'city', 'reservation'],
            'Zoom the map to a place: the state, the current selection, or a county/township/city/reservation named by fit_id.'),
          fit_id: str('For fit: a county code, township id, city name or reservation name, as a string.'),
          center: { type: ['array', 'null'], items: { type: 'number' }, description: '[longitude, latitude] to centre on.' },
          zoom: { type: ['number', 'null'], description: 'Zoom level 4 (state) to 15 (lots). Parcels appear past 10.' },
        }, 'Where the map looks. fit is preferred; center and zoom are for a precise spot.'),
        theme: strEnum(['light', 'dark', 'system'], 'The colour theme.'),
      },
      required: ['view', 'snapshot', 'level', 'measure', 'selection', 'era', 'origin_state', 'mask_low_coverage',
        'basemap', 'layers', 'map', 'theme'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_place',
    description: 'Resolve a place name to the ids the dashboard uses. Accepts a county name or two-letter county '
      + 'abbreviation, a city or town name, a PLSS township such as "T1N R1E" or "2S 6E", or a reservation name. '
      + 'Returns candidates with their code or id, the county a city sits in, the township containing a city, and a '
      + 'bounding box. Always call this before configure_dashboard or read_series when the user names a place.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The place as the user wrote it.' },
        kind: strEnum(['any', 'county', 'city', 'township', 'reservation'], 'Narrow the search; null means any.'),
      },
      required: ['query', 'kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_series',
    description: 'Read a time series (one value per export) for a unit selection from the dashboard’s own cubes, '
      + 'the same arithmetic the map uses. Pick a topic and either raw measures (counts and acres) or one named derived '
      + 'measure (shares and rates are computed here, with the view’s count floors; never compute them yourself). '
      + 'An empty units list means statewide. Each point carries the export date, how many of the units were covered '
      + '(coverage_ok) and whether the field is unknown in that export (2009-07-05). Topics: core, dev, tenure, '
      + 'locality, size, class, owner_origin, ag, improve (stock, by export); flow (events, by interval between exports); '
      + 'holdings (county level only); cama (building records, eight points); owner_state (township level, needs state). '
      + 'Use read_table for tables not keyed by unit and export.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['township', 'county'], description: 'The unit the ids refer to.' },
        units: intList('County codes or township ids; empty or null for statewide.'),
        topic: { type: 'string', enum: SERIES_TOPICS, description: 'Which table family to read.' },
        measures: { type: ['array', 'null'], items: { type: 'string' },
          description: 'Column names from the data dictionary (for example n_dev1, ac_sz3, owner_changed); null for the topic’s main columns.' },
        derived: strEnum(DERIVED_MEASURES, 'One derived measure instead of raw columns.'),
        state: str('Two-letter state; required for topic owner_state, ignored otherwise.'),
        snapshots: obj({ from: int('First export index, null for the start.'), to: int('Last export index, null for the end.') },
          'Restrict the series to a range of export indexes.'),
      },
      required: ['level', 'units', 'topic', 'measures', 'derived', 'state', 'snapshots'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_table',
    description: 'Query one of the published analytic tables with a small declarative query: filter rows, optionally '
      + 'group and aggregate, order and limit. Coded columns are decoded to labels when decode is true. Keys: county_n '
      + '(0 is the statewide row in holdings and cama tables), s (export index), i or interval (interval index), -1 means '
      + 'unknown. Use read_series for anything keyed by township or county and export. holdings_top carries no owner '
      + 'names here: refer to holdings by rank and size.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: QUERY_TABLES, description: 'The table to read.' },
        columns: { type: ['array', 'null'], items: { type: 'string' }, description: 'Columns to return; null for all.' },
        where: { type: ['array', 'null'], description: 'Row filters, all of which must hold (at most 8).',
          items: { type: 'object', properties: {
            col: { type: 'string' },
            op: { type: 'string', enum: ['=', '!=', '<', '<=', '>', '>=', 'in'] },
            value: { type: ['number', 'string', 'array', 'null'], items: { type: ['number', 'string'] }, description: 'A number or string, or a list for "in".' },
          }, required: ['col', 'op', 'value'], additionalProperties: false } },
        group_by: { type: ['array', 'null'], items: { type: 'string' }, description: 'Columns to group by (at most 3).' },
        aggregate: { type: ['array', 'null'], description: 'Aggregates over each group (at most 8).',
          items: { type: 'object', properties: {
            fn: { type: 'string', enum: ['sum', 'count', 'min', 'max', 'avg'] },
            col: { type: ['string', 'null'], description: 'The column; null with count counts rows.' },
            as: { type: 'string', description: 'The output name.' },
          }, required: ['fn', 'col', 'as'], additionalProperties: false } },
        order_by: { type: ['array', 'null'], description: 'Sort order.',
          items: { type: 'object', properties: {
            col: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] },
          }, required: ['col', 'dir'], additionalProperties: false } },
        limit: int('Rows to return; default 50, at most 200.'),
        decode: bool('Decode county codes, export indexes and class codes to names (default true).'),
      },
      required: ['table', 'columns', 'where', 'group_by', 'aggregate', 'order_by', 'limit', 'decode'],
      additionalProperties: false,
    },
  },
  {
    name: 'compose_report',
    description: 'Compose one of the six printable reports in the Reports view and return its title, section headings '
      + 'and headline figures. kinds: profile (one county), condition (one county), trends (statewide), holdings '
      + '(statewide), worksheet (CSV, county optional), activity (a period: from and to export indexes). The user can '
      + 'then save it as a PDF. Do not call this for a number you could get with read_series.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: REPORT_KINDS, description: 'Which report.' },
        county: int('County code for profile, condition and worksheet; null otherwise.'),
        from: int('Activity report: first export index.'),
        to: int('Activity report: last export index.'),
      },
      required: ['kind', 'county', 'from', 'to'],
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** The list as the Worker sends it, byte-stable. */
export const TOOLS_JSON = JSON.stringify(TOOLS);
