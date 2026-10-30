# Montana Cadastral Ownership Consolidation

A reproducible Python implementation of the **Montana Cadastral Parcel Consolidation
Methodology** (Stone, 2017; "Ranchland Dynamics 2.0"). It replaces the manual
QGIS + Excel + SQL workflow with an entity-resolution + dissolve pipeline that
collapses individual tax parcels into **consolidated-ownership polygons** for
land-ownership-concentration analysis.

> **Scope:** shapefile-only **MVP**. ORION (DOR CAMA SQL) enrichment is an
> explicit **Phase 2** (see `cadastral/orion.py`), not implemented here.

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

```bash
.venv/bin/python -m timeseries.extract          # now carries owner_addr_norm (+ generic / care-of flags)
.venv/bin/python -m timeseries.identity         # --overrides owner_overrides.csv to apply reviews
.venv/bin/python -m timeseries.tenure_area      # ~5 min per snapshot; holdings falls back to the point method without it
.venv/bin/python -m timeseries.holdings
.venv/bin/python -m timeseries.regress
.venv/bin/python -m timeseries.publish && (cd site && npm run build)
```

The identity rule is the document's: the mailing address keys an owner, names
bridge entities and couples across addresses, and everything the document
leaves to a reviewer is carried as a flag and shown in the dashboard's Review
view as a range between the document tier and the maximal tier.

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
| `timeseries/identity.py` | owner identity tiers + review flags per snapshot |
| `timeseries/tenure_area.py` | public-land area overlap per parcel |
| `timeseries/holdings.py` | large-holding and concentration metrics |
| `timeseries/regress.py` | regression against the published Table 1 |

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
