# Montana Cadastral Ownership Consolidation

A reproducible Python implementation of the **Montana Cadastral Parcel Consolidation
Methodology** (Stone, 2017; "Ranchland Dynamics 2.0"). It replaces the manual
QGIS + Excel + SQL workflow with an entity-resolution + dissolve pipeline that
collapses individual tax parcels into **consolidated-ownership polygons** for
land-ownership-concentration analysis.

> **Scope.** The per-county consolidation tool below is the shapefile-only
> MVP. The longitudinal pipeline under `timeseries/` and the dashboard under
> `site/` grew out of it and now also read the DOR's ORION CAMA database: party
> identifiers bridge owners in the identity stage, and the building records
> (stage 11) give the dwelling condition series and the checks on the
> development ladder. See *ORION integration* and *Dashboard* below.

## What it does

For each county (and then statewide):

1. **Inspect & resolve schema** — fields are addressed by *logical* name and
   resolved across shapefile-truncated / metadata / historical schemas
   (`cadastral/schema.py`). CRS is read from the layer (never hardcoded) and
   warned on if not projected metres.
2. **Separate null-`PARCELID`** rights-of-way / water into their own layer
   (kept for accounting, excluded from consolidation). Counts reconcile.
3. **Normalize owner identity** — name + mailing address normalized to keys;
   raw values preserved (`cadastral/normalize.py`).
4. **Assign owner codes** — conservative merge: parcels merge **iff** identical
   normalized `(name, address, city, state, zip5)`. Produces a stable-hash
   `StrictOwnerID`, a county `OwnerGroupID`, a statewide `GlobalOwnerID`, and a
   human 9-digit `OwnerCode` (`cadastral/consolidate.py`).
5. **Review queue** — ambiguous cases (same-name/different-address,
   same-address/different-name, General-Delivery) are flagged, never
   auto-merged. → `*_review_queue.csv`.
6. **Override loop** — edit a review into `owner_overrides.csv` and re-run with
   `--overrides` to merge confirmed-same owners (Run 2).
7. **Parcel-location Census tag** — each parcel tagged with the tract +
   block-group GEOID it sits in, via interior representative point
   (`cadastral/census.py`). Dissolved owners get **no** single GEOID; an
   `owner_geography_xwalk` records each owner's acreage split across block groups.
8. **Owner mailing-location enrichment** — `owner_zip5` / `owner_state` /
   `owner_in_state` (+ optional ZIP→county FIPS), answering *where the owner is*
   vs. where the land is (`cadastral/owner_geo.py`).
9. **Dissolve** — parcels dissolved by owner into consolidated polygons, with
   `ConsolAcres` recomputed from projected geometry (`cadastral/dissolve.py`).
10. **QA report** — count reconciliation, acreage comparison, ambiguity /
    blank-owner / null-geometry counts.

## Setup

```bash
cd cadastral-processing
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Usage

```bash
# all counties (uses discovered default data paths)
.venv/bin/python cadastral-processing.py

# one county (code or name), faster to iterate
.venv/bin/python cadastral-processing.py --county 33
.venv/bin/python cadastral-processing.py --county Treasure

# Run 2: apply human-reviewed merges
.venv/bin/python cadastral-processing.py --county 33 --overrides owner_overrides.csv

# tag/attribute only, skip the dissolve (fast)
.venv/bin/python cadastral-processing.py --county 33 --no-dissolve
```

Key flags: `--input`, `--tracts`, `--bg`, `--outdir`, `--zip-crosswalk`,
`--no-census`, `--no-statewide-merge`, `-v`.

### `owner_overrides.csv` format

| column | meaning |
|---|---|
| `source_owner_code` | a `StrictOwnerID` (== `GlobalOwnerID` before overrides) from the review queue / owner-join CSV |
| `corrected_owner_group_id` | shared label; rows with the same value merge into one owner |
| `action` | free text (e.g. `merge`) |
| `reviewer_note` | free text justification |

## Outputs (in `--outdir`, default `data/`)

Per county `Cad_<NN>_<Name>.gpkg` layers: `parcels_tagged`, `owners_dissolved`,
`rights_of_way`, `owner_summary`, `owner_geography_xwalk`, `review_queue`; plus
CSV companions (`*_owner_join.csv`, `*_review_queue.csv`, `*_owner_summary.csv`).

Statewide `Montana_consolidated.gpkg`: `owners_dissolved_statewide` (by
`GlobalOwnerID`), `owner_county_xwalk`; plus `Montana_owner_county_xwalk.csv`.

## Large private holdings (Haggerty et al. 2022)

The longitudinal pipeline under `timeseries/` now carries the ownership
consolidation and the concentration analysis of *Rural Land Concentration &
Protected Areas* (Society & Natural Resources 35(6), 2022), whose online
supplement is the methodology document in `docs/reference/`. Definitions,
choices and the Table 1 regression baseline are in `docs/holdings_definitions.md`.

| stage | module | output |
|---|---|---|
| 8 | `timeseries/identity.py` | `data/identity/owners_<date>`, `groups_<date>`: strict / document / maximal tiers, review flags |
| 9 | `timeseries/tenure_area.py` | `data/tenure/area_<date>`: public fraction per parcel by area overlap |
| 10 | `timeseries/holdings.py` | `data/facts/holdings_{county,state,top,review}`: 640+ acre holdings, CLO4, top-N, Lorenz/Gini |
| -- | `timeseries/regress.py` | `data/facts/regression_table1.csv`: residuals against the paper's Table 1 |
| 11 | `timeseries/cama.py` | `data/cama/parcels_cama_<date>` (one per series point), `cama_{county,township,timing,condition_decade,transitions}`, `qa_cama.json`: the DOR's building records (ORION `Res`/`Com`/`Oby`/`Permit`/`FinalVal`/`InspHistory`) joined on the geocode at eight tax years as a witness to the ladder, and the dwelling condition and year built as a measure |
| 12 | `timeseries/structures.py` | `data/structures/points_<date>`, `parcels_structures_<date>`, `qa_structures.json`: the State Library's Structures Framework address points (NENA v2, monthly) joined to the newest export's parcels twice, by containment and by the geocode each point records, as a witness to the address rung, the DOR's dwellings and the geocode itself |

```bash
.venv/bin/python -m timeseries.extract          # now carries owner_addr_norm (+ generic / care-of flags), legal_desc, is_common_area
.venv/bin/python -m timeseries.identity         # --overrides owner_overrides.csv to apply reviews
.venv/bin/python -m timeseries.tenure_area      # ~5 min per snapshot; holdings falls back to the point method without it
.venv/bin/python -m timeseries.holdings
.venv/bin/python -m timeseries.regress
.venv/bin/python -m timeseries.cama             # needs orion_cache/res.parquet etc.; see ORION integration
.venv/bin/python -m timeseries.structures       # stage 12: address points as a witness; run before cama so the series carries it
.venv/bin/python -m timeseries.tiles            # re-bake the parcel tiles so they carry `cd` / `yb`
.venv/bin/python -m timeseries.publish && (cd site && npm run build)
.venv/bin/python -m basemap.build --install-site site/public   # the in-house basemap (basemap/dist) and its copy under site/public/basemap
```

The identity rule is the document's: the mailing address keys an owner, names
bridge entities and couples across addresses, and everything the document
leaves to a reviewer is carried as a flag and shown in the dashboard's Review
view as a range between the document tier and the maximal tier.

## Dashboard (`site/`)

A static Astro site over the published tables (`timeseries/publish.py` writes
`site/public/data/`; the parcel tiles come from `timeseries/tiles.py`). One
shared map, one time slider over the 29 vintages, and ten tabs:

| tab | what it answers |
|---|---|
| Development | the platted / addressed / built ladder, absorption by cohort, dormant inventory; at parcel depth the parcels that did not yet exist at the vintage shown are outlined by the period they first appeared (2003-05 to 2021 on) |
| Condition | the DOR's dwelling condition and year built at eight tax years (2014, 2015-2018, 2024-2026), drawn together as a bivariate grid (condition across, age up; thirds of the units shown, fixed classes on the parcels), the same dwellings re-rated point to point, and the building records as a witness to the ladder |
| Ownership | tenure, owner distance, out-of-state share, the reservation checkerboard |
| Fragmentation | acreage by parcel size, agricultural-use acreage |
| Churn | owner change among persisting parcels, address-only edits, condominiumisation |
| Thresholds | new-lot sizes against the 20-, 40- and 160-acre lines |
| Holdings | 640+ acre holdings, CLO4, Lorenz and Gini, the paper's Table 1 |
| Review | the decisions the holdings method leaves to a reviewer |
| Reports | six printable documents: county profile, housing condition profile, statewide trends brief, large-holdings update, review worksheet (CSV), subdivision activity for a period |
| About | sources, definitions, caveats |

```bash
cd site && npm install
npm run data            # = python -m timeseries.publish
npm run tiles           # = python -m timeseries.tiles (about 25 minutes)
npm run build && npm run preview
SMOKE_URL=http://127.0.0.1:4321 npm run test:smoke     # 137 checks
npm run test:unit       # the state, the query grammar, the resolver, the tool schemas (node --test)
npm run reports:pdf     # composes every report through the print path (needs a preview on SMOKE_URL)
```

Every control is state (`site/src/lib/state.js`): one `applyState()` validates a
change, syncs the map and the controls, renders once and writes the URL hash, so
a link such as `/#v=holdings&l=c&u=6&s=19` opens the dashboard in that state and
the assistant below drives the same function the nav buttons do.

### Assistant (`worker/`, `site/src/assistant/`)

An **Ask** button opens a panel where a reader types a question; an agent sets the
dashboard (view, vintage, county or township, filters, map) and answers from the
same published tables, naming the export date for every figure and never an
owner's name. The page runs the agent loop and the six tools (`tools.js`,
`execute.js`): the model only ever sees tool results. A Cloudflare Worker
(`worker/assistant.mjs`) is the pinned streaming proxy between the page and the
Anthropic Messages API: it holds the key, the model, the generated system prompt
and the tool list, validates that the page sent nothing but the conversation,
rate-limits, caps the day's spend and relays the stream. The site still deploys
and runs with no Worker at all: the button appears only where
`/api/assistant/health` answers.

```bash
npm install                                  # at the repo root: wrangler and the SDK
cp .dev.vars.example .dev.vars               # then put a real ANTHROPIC_API_KEY in it
npm run build                                # site: regenerates src/assistant/prompt.json, then astro build
npx wrangler dev                             # http://127.0.0.1:8787 serves site/dist + /api/assistant
npm test                                     # unit tests for the page and the Worker
npx wrangler secret put ANTHROPIC_API_KEY    # first deploy; also ASSISTANT_SALT, and TURNSTILE_SECRET if used
npm run deploy                               # build, then wrangler deploy
EVAL_URL=https://... node site/scripts/assistant-eval.mjs   # the 15 golden questions, live (costs money)
```

The system prompt is generated (`site/scripts/build-prompt.mjs`) from the rules
(`site/src/assistant/rules.md`), the About tab's own prose (`site/src/lib/about.js`),
the published caveats and dimensions, and a hand-written data dictionary
(`site/src/assistant/dictionary.md`) that the build checks against the Parquet
schemas. The knobs are `vars` in `wrangler.jsonc`: `ASSISTANT_MODEL`,
`ASSISTANT_EFFORT`, the daily caps, `TURNSTILE_SITE_KEY` (the bot check is off until
a key is set), and `ASSISTANT_ENABLED`. The in-house basemap archive is excluded
from the asset upload (`site/public/.assetsignore`): it exceeds the 25 MiB per-asset
cap and needs HTTP Range, so in production it is served from R2.

## Module map

| file | responsibility |
|---|---|
| `cadastral-processing.py` | CLI + per-county/statewide orchestration + QA |
| `cadastral/schema.py` | field-alias resolver, CRS/units validation |
| `cadastral/io_utils.py` | county enumeration, chunked reads, GPKG/CSV writers |
| `cadastral/normalize.py` | owner name + address normalization |
| `cadastral/consolidate.py` | owner ids, review queue, override loop |
| `cadastral/census.py` | parcel→tract/BG tag, owner-geography crosswalk |
| `cadastral/owner_geo.py` | owner mailing-location enrichment |
| `cadastral/dissolve.py` | geometry repair, dissolve, area recompute |
| `cadastral/orion.py` | ORION cache reader, party profiles, resolver, deeds |
| `orion_etl.py` | one-time ORION SQL Server -> Parquet ETL + profiler |
| `timeseries/commonarea.py` | dedicated common-area flag (open space, parks, HOA tracts) that leaves the development ladder |
| `timeseries/identity.py` | owner identity tiers + review flags per snapshot |
| `timeseries/tenure_area.py` | public-land area overlap per parcel |
| `timeseries/holdings.py` | large-holding and concentration metrics |
| `timeseries/regress.py` | regression against the published Table 1 |
| `timeseries/cama.py` | stage 11: the DOR's CAMA building records as a witness to the ladder (improvement, value, house-number, timing, cohort, dormant and permit tests) and as a measure (dwelling condition, year built) at parcel, township and county grain |
| `timeseries/reference.py` | MDT road centerlines + building footprints (Microsoft's 2018 statewide set merged with the State Library's lidar footprints, each tagged by source, with a coverage test against the DOR's dwellings) staged into the parcel tiles; statewide highways and city names for the low zooms (labels from vendored Noto Sans glyphs under `site/public/fonts`) |
| `timeseries/structures.py` | stage 12: the Structures Framework's address points as a witness (address rung, dwellings, geocode, units, manufactured homes, placement) |
| `basemap/build.py`, `basemap/styles.py`, `basemap/pmtiles_writer.py` | the in-house Montana basemap: State Library frameworks staged to twelve layers, tiled by GDAL to z13, packaged as PMTiles with light and dark MapLibre styles; `check_pmtiles.mjs` reads the archive back with the official client |
| `site/src/lib/reports.js` | the six printable reports (county profile, housing condition profile, statewide brief, large-holdings update, review worksheet CSV, subdivision activity), composed in the page from the published tables and printed to PDF by the browser |

## In-house basemap (`basemap/`)

The dashboard's basemap menu offers an in-house Montana basemap beside the
external OpenStreetMap one, so a page can show streets, water, places,
buildings and addresses without a third-party request. It is built from State
Library frameworks only (Transportation Framework, Structures Framework, NHD
hydrography, GNIS names, counties, cities, public lands) plus the merged
building footprints, and packaged to be reused anywhere:

```
basemap/dist/
  mt-basemap.pmtiles     one archive, zooms 4-13 (overzooms past 13)
  mt-basemap.mbtiles     the same tiles for QGIS or a tile server
  styles/light.json      MapLibre styles, warm neutrals parallel to Positron / Dark Matter
  styles/dark.json
  fonts/                 the Noto Sans glyphs the styles reference
  index.html             a demo page
  README.md, qa.json     layer schema, sources, feature counts
```

`python -m basemap.build` stages and tiles (16 minutes measured: one to stage, 15
for GDAL to tile; 60,429 tiles, a 130 MB archive); `--install-site site/public`
also copies the archive and renders the styles for `/basemap`.
PMTiles needs HTTP Range: Astro preview honours it, Cloudflare Pages static
assets do not and cap files at 25 MB, so a Pages deployment serves the archive
from R2 (see `reference_cloudflare_workers_range` in the project notes). The
tiles are written by GDAL's MVT driver; tippecanoe would generalise the low
zooms better and is the upgrade if it is ever on hand.

## ORION integration (DOR CAMA database)

The optional ORION stage augments consolidation with the DOR's authoritative
ownership data: **canonical owner name/address**, **co-owners**, **PercentOwnership**,
and **deed/transfer history**. It is *additive* — ORION can only merge owners the
shapefile heuristic kept separate, never split them (consolidation is always
>= the MVP).

Key facts learned from the data (statewide `Output.mdf`, RefreshDate 2026-06-24):
- The DB is current (TaxYears 2024-2026); **100% of 2026 parcels match** ORION on
  `PropertyID`. Always confirm via the profiler — it reads `SystemInfo.RefreshDate`.
- **`PartyID` is per owner-record, NOT a deduplicated entity** (149 "PV RANCH"
  parcels span 9 PartyIDs). So PartyID is used as a high-confidence *bridge*
  (parcels sharing one are the same owner) and as the source of canonical
  name/address — never as the consolidation identity by itself. Cross-name-variant
  merges (e.g. "PV RANCH CO LLC" vs "PV RANCH COMPANY LLC") remain a review/override
  decision.

### One-time setup (Docker SQL Server + ETL)
```bash
# 1. copy the mdf somewhere the container can read/write
mkdir -p orion_work && cp /media/.../STATE-WIDE/Output.mdf orion_work/ \
  && chmod 666 orion_work/Output.mdf && chmod 777 orion_work
# 2. start SQL Server Developer (free, no size limit; Express can't hold the 9.5GB statewide file)
docker run -d --name orion-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='<pw>' \
  -e MSSQL_PID=Developer -p 1433:1433 \
  -v "$PWD/orion_work:/var/opt/mssql/orion" mcr.microsoft.com/mssql/server:2022-latest
# 3. attach (no .ldf ships, so rebuild the log) — via any SQL client / pymssql:
#    CREATE DATABASE Orion ON (FILENAME='/var/opt/mssql/orion/Output.mdf') FOR ATTACH_REBUILD_LOG;
# 4. profile + export to Parquet (the durable artifact the pipeline reads)
.venv/bin/pip install -r requirements-orion.txt
ORION_SA_PASSWORD='<pw>' .venv/bin/python orion_etl.py   # writes orion_cache/*.parquet + orion_profile.txt
# 5. the container + orion_work/Output.mdf copy can now be removed; only orion_cache/ is needed.
```

### Building records (Phase 3, `timeseries/cama.py`)

The ETL also exports the CAMA building tables -- `Res` (dwellings and
manufactured homes), `Com`, `Oby`, `Permit`, `FinalVal` and a per-property
reduction of `InspHistory` (latest inspection date and count; the full table
re-lists a property's history under every tax year, 3.4 M rows for 2026).
`orion_etl.py --export --only res com oby permit finalval inspection` adds them
to an existing cache. Stage 11 joins them to the parcels on the geocode
(`Property.GeoCodeSearch`) and uses them two ways: as an independent witness to
the development ladder (every test is a named count on both sides in
`data/cama/qa_cama.json` and `meta.json`), and as the source of the dwelling
condition and year built the Condition view, the parcel tiles (`cd`, `yb`) and
the housing condition report show.

**Three refreshes make a series.** Two older ORION exports (refreshed
2016-03-27, tax years 2014-2016; and 2018-06-21, tax years 2016-2018) are
exported to their own caches and the stage reads every cache it finds
(`cama.ORION_CACHES`, newest first; a tax year held twice is taken from the
newest refresh). Each tax year is joined to the parcel export that carries
its roll, which gives eight points: 2014, 2015-2018 and 2024-2026. The
county, township, timing and condition-by-decade tables carry the snapshot
index `s`; `cama_transitions` follows single-dwelling properties between
consecutive points.

```bash
# the vintages attach beside the 2026 database in the same container
#   CREATE DATABASE Orion2016 ON (FILENAME='/var/opt/mssql/orion/Output_2016.mdf') FOR ATTACH_REBUILD_LOG;
ORION_SA_PASSWORD='<pw>' .venv/bin/python orion_etl.py --database Orion2016 --cache orion_cache_2016 --tax-years 2014 2015 2016 --parcels '' --profile --export
ORION_SA_PASSWORD='<pw>' .venv/bin/python orion_etl.py --database Orion2018 --cache orion_cache_2018 --tax-years 2016 2017 2018 --parcels '' --profile --export
```

**CDU through 2014, its components after.** The data dictionary
(`docs/reference/Revised Data Dictionary.xlsx`) defines `CDU` as the composite
condition-desirability-utility rating. It is filled on 412,439 of 412,440
dwellings for tax year 2014 and on a few dozen manufactured homes in every
year since; from tax year 2015 its four components -- `PhyCondition`,
`Utility`, `PropDesirability`, `LocDesirability` -- are filled instead, on the
same scale: Unsound (1), Very Poor (3), Poor (5), Fair (6), Average (7), Good
(8), Very Good (9), Excellent (10). The composite was retired at the 2015
reappraisal by copying it into the components (it equals the 2015
`PhyCondition` on 80.6% of dwellings). The stage picks the filled field per
tax year and names it (`rating_field`): CDU for 2014, `PhyCondition` after.

### Run with ORION
```bash
.venv/bin/python cadastral-processing.py --county 33 --orion-cache orion_cache
.venv/bin/python cadastral-processing.py --orion-cache orion_cache            # all counties
# fractional ownership stats instead of primary-owner acres:
.venv/bin/python cadastral-processing.py --county 33 --orion-cache orion_cache --ownership-mode fractional
```
Extra ORION flags: `--orion-tax-year {match,latest,<year>}`, `--doctype-xwalk <csv>`.

ORION adds nullable columns to `parcels_tagged` (`PartyID`, `owner_source`,
`canonical_name`, `canonical_addr_full`, `PercentOwnership`, `coowner_names_json`,
`tenure_years`, `latest_transfer_date`, audit fields) and new outputs:
`parcel_owner_interest`, `orion_autoresolved` (owners ORION/overrides merged),
and `*_deed_events.csv`. Owner names in summaries/dissolve use the ORION canonical
name when matched.

### Expanded overrides (`owner_overrides.csv`)
Columns: `override_action, source_owner_id, target_owner_group_id, PartyID,
PARCELID, PropertyID, CountyPrefix, TaxYear, reason, reviewer, review_date`.
Actions: `merge`, `split`, `force_orion`, `force_heuristic`, `suppress_orion`,
`exclude_from_consolidation`. Rows match by `source_owner_id` (StrictOwnerID or
PartyID), or by `PARCELID`/`PropertyID`/`PartyID`. Precedence: overrides > ORION
> heuristic. The legacy 2-column override format is auto-migrated to `merge`.

### Editable deed classification
`doctype_transfer_class.csv` (`DocType, DocType_Desc, transfer_class,
include_for_tenure, notes`) controls which deed document types count as genuine
ownership transfers for tenure; edit it without touching code.
