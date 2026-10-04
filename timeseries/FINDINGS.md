# Step 0 findings: measured corrections to the plan

Every number here comes from reading the archives, not from inspection of
documentation. Where a finding contradicts the approved plan
(`~/.claude/plans/i-have-a-cadastral-enchanted-pearl.md`), the contradiction is
stated plainly. Regenerate the supporting tables with
`python -m timeseries.probe && python -m timeseries.probe_report`.

## 1. Why `PARCELID` repeats — settled, and opposite to the plan

The plan treated duplicate parcel ids as possibly "a parcel-to-owner join whose
collapse would destroy co-ownership" and therefore specified
*"Acres come from one row per parcel (`MAX`, never `SUM`)"*.

**All 30 snapshots say otherwise.** 29 are `exploded_geometry` and the 30th
(2026) has no duplicates at all. Across the series, parcels whose duplicate rows
carry *differing* owner names number 0–56 — between 0.00% and 0.16% — while
tens of thousands carry an *identical* owner name and a *differing* area:

| snapshot | dup parcels | owner differs | owner identical | area differs |
|---|---|---|---|---|
| 2003-12-22 | 25,200 | 28 (0.11%) | 25,172 | 24,980 |
| 2006-07-14 | 33,769 | 2 (0.01%) | 33,767 | 33,526 |
| 2021-12-31 | 3,334 | 0 | 3,334 | 3,226 |
| 2026-09-04 | 0 | — | — | — |

A representative case: `MUHE DANIEL DBA FINANCIAL FREE` appears five times on one
parcel with areas 284.96 / 457.64 / 585.33 / 1220.22 acres. Those are polygon
parts, not co-owners.

**So the area rule is `SUM`.** `MAX` discards the remaining parts, and the loss
is era-correlated because duplication decays from 93,229 rows (2011) to 0
(2026):

| snapshot | SUM Macres | MAX Macres | MAX loses |
|---|---|---|---|
| 2005-02-01 | 91.4328 | 88.0686 | **3.68%** |
| 2006-07-14 | 89.6229 | 89.1502 | 0.53% |
| 2021-12-31 | 90.4881 | 90.4312 | 0.06% |
| 2026-09-04 | 90.6213 | 90.6213 | 0.00% |

Choosing `MAX` would have manufactured a rising-acreage trend out of a
data-normalisation artifact.

## 2. Owner interests carry no independent location

The plan specified three distinct California measures — `any_owner_ca`,
`all_owners_ca`, `interest_share_ca`. **The data cannot distinguish them.** A
parcel has exactly one mailing address:

* 2006: of 33,769 duplicated parcels, **2** have more than one distinct mailing state
* 2021: **zero**

So "share of owner interests from California" is the same parcels re-weighted by
how many names appear on the record — a different statistic, and a misleading
one. **Published denominators are parcels and acres, each named explicitly.**

Co-ownership is real but lives *inside* the owner string: 37.5% of 2006 records
and 32.3% of 2021 records contain an `&`. The interest table is retained for
counting parties and classifying legal form, never for location.

## 3. `OWNR_NAM1` overflows into `OWNR_NAM2`

`OWNR_NAM1` is `String(30)` in the early era and long names continue into the
second field rather than naming a second party. A field-width heuristic does not
separate the cases — measured on 2006:

* continuation at 26 chars: `MONTANA COLLEGE OF MINERAL` + `SCIENCE & TECHNOLOGY`
* co-owner at 29 chars: `CARLSON NATALIE & KYNNY (2/3)` + `VIRGIL A BORONI (1/3)`

The two fields are therefore joined with a **neutral space**, never `&`. A space
is correct whichever case applies, and because 2013+ holds the whole name in one
167-character field it also matches better across the 2011→2013 boundary.
`n_names_on_record` counts only unambiguous `&`/`AND` separators and is
documented as a **lower bound**. Joining with `&` produced
`MONTANA DEPARTMENT OF ENVIRONM & QUALITY` — two fabricated parties.

## 4. Validate structurally; do not enumerate sentinels

The parcel-id column carries literal stand-ins and numeric filler:

```
NA                  14,323 rows (2006, all Flathead, no owner, 1.28 M acres)
03888844444444444      385      03555555555550000   187
03888844444440000      264      03666666666666666   157
```

A range check on county (1–56), section (1–36) and quarter (0–4) rejects every
numeric filler family without anyone listing it; only the non-numeric
stand-ins need naming. The identity
`rows == blank + quarantined + valid` is asserted per snapshot and **holds for
all 30**.

Quarantine volume is itself a finding: 16k–20k rows per snapshot in 2003–2010,
collapsing to ~200 by 2013 as MSL converted filler to nulls (2011 shows the
switch — quarantined falls to 6,064 while blank jumps to 23,870).

## 5. Only the geocode's first nine characters are numeric

4,654 of 887,264 geocodes in 2026 carry a letter in the block/lot/unit tail —
`5229573420101F001`, `5638262430446000A`, `0111943210101MINE`, and a few
lowercase such as `4208582542001b473`. Their locating prefix is intact, so
rejecting them would discard placeable parcels. **99.986% of 2026 geocodes are
locatable**; the residue is 125 rows whose quarter digit is `R`.

## 6. The PLSS witness validates the spatial frame in every vintage

The row's own PLSS text (`TRS` 2002–2011, `Township`/`Range`/`Section` 2013+)
agrees with the section parsed out of the geocode:

| era | section agreement | range |
|---|---|---|
| 2002–2011 (`TRS`) | 99.95–100.00% | parse rate 95.6–98.3% |
| 2013–2026 (`T`/`R`/`S`) | 99.81–99.94% | — |

**Never below 99.8%.** The township code is *not* 1:1 with township+range (4,665
codes vs 4,170 pairs in 2026), but the ambiguity is attribute noise, not genuine
straddling: 189 of 248 ambiguous codes have a dominant township/range at ≥99%,
245 at ≥90%, none below 60%, and the worst offender's minority value is `215W` —
an impossible Montana range. The majority-vote error budget is **0.047%–0.79%**
of rows across the series.

**Decision: the township unit is county + township code (6 chars), not the bare
4-char code.** 14–15 codes appear under two county prefixes; keying on the pair
splits such a township into one unit per county, which is the conservative
reading and makes county rollups reconcile exactly. 4,684 units in 2026.

## 7. `/vsizip/` is pathological for FileGDB

The plan assumed GDAL reads both containers in place. It does not.

A shapefile's DBF is one member read start to finish, so `/vsizip/` costs
nothing — 5–13 s statewide. A `.gdb` is a directory of ~50 members and the
driver seeks across them, which `/vsizip/` can only serve by re-inflating the
deflate stream from its last checkpoint. Measured on 2017: **78 GB of logical
reads against a 539 MB dataset, 2.66 GB/s of re-inflation with zero additional
disk traffic, no sign of finishing after ten minutes at 100% CPU.**

`sources.Snapshot.local()` unpacks the `.gdb` subtree to scratch; the same read
then takes ~34 s. It is a no-op for shapefiles.

## 8. Two vintages have a dead field

| vintage | field | symptom | handling |
|---|---|---|---|
| 2004-07-16 | `AREA` | entirely zero, 833,537 rows, max 0.0 (2005 median: 13,865 m²) | derive acres from geometry; the only geometry read in the pipeline |
| 2009-07-05 | `TOT_FB_VAL`, `TOT_FL_VAL`, `VALUE_MRF` | all three entirely zero, 908,662 rows (neighbours: 46.4%, 47.1%) | `improved = -1` (unknown), **never 0** |

Both are handled by a general degeneracy rule — a numeric field whose
strictly-positive share falls below a threshold is dead for that vintage — not
by date special-casing. A dead field must read as *no data*, never as a
measurement of zero, or the improvement series shows a spurious dip to zero.

## 9. DOR answers "which city" — but only partly

There *is* a parcel situs city field, contrary to the plan's doubt, and it is
distinct from the owner's mailing city (they differ 24–42% of the time):

| era | column | non-blank | distinct |
|---|---|---|---|
| 2002–2008 | `PROP_CITY` | 73.3–82.8% | **345–360** (essentially Montana's place list) |
| 2009–2011 | `PROP_CITY` | 40.3–43.4% | 319–325 |
| 2013–2026 | `CityStateZip` | 49.0–55.3% | 4,197–4,760 (city+state+zip combined) |

`PROP_CITY` collapses in 2009 from 82.78% to 40.29%. So DOR's answer is a
**supplement** to the quarter-section place join, never a replacement; record
which source supplied each assignment.

## 10. Era boundaries are continuous

The three riskiest intervals — 2011→2013 (schema rewrite, `AREA`→`Shape_Area`,
and the missing 2012), 2016→2017 (container change) and 2020→2021 (CRS change) —
show no discontinuity:

| snapshot | area field | state field | parcels | med acres | total Macres | % out-of-state | % CA |
|---|---|---|---|---|---|---|---|
| 2011-07-14 | `AREA` | `MAILCITY_S` | 831,851 | 3.601 | 89.59 | 11.71 | 1.970 |
| 2013-01-09 | `SHAPE_Area` | `OwnerState` | 835,403 | 3.704 | 89.80 | 11.88 | 1.909 |
| 2016-01-12 | `GISAcres` | `OwnerState` | 844,163 | 3.555 | 89.86 | 11.76 | 1.775 |
| 2017-01-30 | `GISAcres` | `OwnerState` | 847,592 | 3.502 | 89.91 | 11.58 | 1.769 |
| 2020-12-31 | `GISAcres` | `OwnerState` | 863,458 | 3.215 | 90.14 | 11.50 | 1.662 |
| 2021-12-31 | `GISAcres` | `OwnerState` | 868,276 | 3.491 | 90.34 | 11.66 | 1.720 |

The fixed-width `MAILCITY_S` parse yields a valid two-letter state **98.97%** of
the time, against **99.12%** for the *native* column in 2013 — so it is as
reliable as a real field, not a best-effort guess.

The deduplicated parcel series is smooth and monotonic: 495,822 (2002) → 731,286
(2003) → 887,124 (2026), with duplicate rows decaying 93,229 → 0 underneath it.

## 11. Attribute availability by era

| attribute | available | note |
|---|---|---|
| `subdivision` | all vintages | 29.0% → 46.1% non-blank; 4,992 → 24,265 distinct |
| `cert_survey` | **2013+ only** | 9.1% → 11.4%; so pre-2013 high-confidence events rest on the subdivision name alone |
| improvement value | 2003+ | 34.2% → 51.6% positive; 2002 has no value block, 2009-07-05's is dead |
| `OWNCLASS`/`GENDESCRIP`/`OWNCLSCD` | **2002–2011 only** | 17 / 15 / numeric classes; the owner-form calibration target |
| `RESPROPIND` | **2004–2011 only** | Dwelling / Mobile / Other / Vacant — an independent "platted vs built" signal for that window |

## Carried forward unchanged from the plan

2002 is excluded (missing Silver Bow, Yellowstone, Missoula, Gallatin and
Flathead — exactly where parcels are created); 2012 and 2015 do not exist
upstream either; `TotalAcres` is agricultural acreage only (zero on 67.8% of
2006 parcels, though progressively populated to 2.3% by 2025); aggregate-only
publication with no owner names and no parcel geometry.
