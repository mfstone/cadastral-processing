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
| 2009-07-05 | `TOT_FB_VAL`, `TOT_FL_VAL`, `VALUE_MRF` | all three entirely zero, 908,662 rows (neighbours: 46.4%, 47.1%); a separate download of the same vintage checked 2026-10-31 is byte-identical (md5 of the .dbf), so the dead block is the DOR export itself, not the archive copy | `improved = -1` (unknown), **never 0** |

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
2006 parcels, though progressively populated to 2.3% by 2025).

Aggregate-only publication is carried forward **for owner identity only** — no
owner name, mailing address, city or value is published anywhere. The "no parcel
geometry" half was abandoned deliberately once the township surface was built and
inspected; see section 16.

## 12. The locator: no download needed, and the vote must be gated

`PLSSTownship` ships **inside** the 2018 and 2019 cadastral geodatabases — 4,191
features, EPSG:32100 — so the authoritative survey geometry was already on disk
and MSL's 525 MB `MT_PLSS_SHP.zip` was never needed.

Two keys, because they answer different questions: the **analytic** key is
county + township code (4,675 units, so county rollups reconcile exactly), and
the **display** key is the PLSS township polygon (4,191). The crosswalk between
them is a majority vote over all 29 snapshots — 25.1 M votes, median dominant
share **1.0**, minority votes **0.066%**, and 4,622 of 4,675 units resolved at
≥99% dominance.

**The vote has to be restricted to township/range keys that exist in the
survey.** Without that gate, ten units resolved to impossible keys — range
`545E`, `365E`, `275W`, township `75S`, none of which exist in Montana — each on
a dominant share of only 0.51–0.55, because a corrupt attribute had outvoted a
valid one by a hair. Gating the vote takes location from 99.786% to **100.000%**
and rejects 7,058 votes for out-of-survey keys. Those votes are counted and
reported, never silently dropped.

Validation: the township polygons total **380,044 km²** against Montana's
380,831 km² of land area, a 99.8% match.

Published geometry is simplified at **50 m**, which is 0.5% of a township's
9.6 km width and invisible at any dashboard zoom — these are survey lines, not
physical features. The source carries ~125 vertices per township for what is
essentially a rectangle:

| tolerance | vertices | gzipped | area error |
|---|---|---|---|
| none | 525,985 | 2,193 KB | — |
| **50 m** | **24,833** | **158 KB** | **0.0015%** |
| 100 m | 23,372 | 144 KB | 0.0039% |
| 800 m | 21,359 | 132 KB | 0.3011% |

## 13. The coverage gate reproduces MSL's own documented gaps

MSL's 2006 metadata states: *"significant areas of private land are missing from
Lincoln County, along with smaller areas of Madison, Sanders, Sweet Grass, and
Stillwater counties."* The gate was built with no reference to that sentence —
it compares each county against **its own** late-series plateau on acreage,
populated quarter-sections and parcel count, and masks a county-year when two of
three fail. It finds four of the five, in the right severity order:

| county | MSL's wording | gate result | worst acreage vs own plateau |
|---|---|---|---|
| Lincoln | *"significant areas"* | masked 6 snapshots | **0.597** (2003-12-22) |
| Sweet Grass | *"smaller areas"* | masked 6 snapshots | 0.814 |
| Sanders | *"smaller areas"* | masked 2 snapshots | 0.879 |
| Stillwater | *"smaller areas"* | masked 2 snapshots | 0.841 |
| Madison | *"smaller areas"* | not masked | 0.909 — fails one indicator, not two |

Madison sitting just above the floor, and therefore passing, is the right
outcome for the mildest case on MSL's list.

The gate also finds gaps MSL's metadata never mentions: **Park at 0.627**, nearly
as severe as Lincoln, plus Jefferson (0.726) and Granite (0.750).

**Every masked county-snapshot falls between 2003-12-22 and 2006-07-14.** The
first snapshot in which all 56 counties clear the gate is **2007-01-23**, which
bounds the coverage era independently of any metadata.

A rate test needs a denominator. Under a bare 20% `first_mapping` ceiling, 535
county-intervals were rejected and 61.3% of those had fewer than 25 creations —
a county with 8 creations of which 4 are first-mapping scores 50% on noise.
Requiring the coverage arrival to be *materially* large as well as proportionally
large leaves 65 rejections, takes comparability from 64.0% to **94.0%**, and
makes the gate track the era properly: **86.2%** of county-intervals comparable
in 2003-2007 against **97.1%** from 2008.

## 14. A third degenerate field, caught by a plausibility rule

Agricultural-use acreage is a **subset of the parcel**, so it cannot exceed the
parcel's own area. The 2003 and 2004 exports violate that by two orders of
magnitude — statewide totals of **735 M and 781 M acres against a mapped
86–87 M**, with a single parcel carrying 642,980 ag acres against a maximum of
3,841 from 2005 onward. The column names are identical across the series; only
the values are wrong, so no schema check would have found it.

Clamping each parcel's agricultural acreage to its own area repairs the broken
vintages and the ordinary baseline alike:

| vintage | raw | clamped | mapped parcel acres |
|---|--:|--:|--:|
| 2003-12-22 | 734.94 M | **54.27 M** | 86.09 M |
| 2004-07-16 | 781.48 M | 54.57 M | 87.10 M |
| 2005-02-01 | 55.20 M | 54.87 M | 91.43 M |
| 2026-09-04 | 67.87 M | 67.61 M | 90.62 M |

The series becomes continuous — 54.27 → 54.87 → … → 67.61 M — where before it
opened with a 735 M spike. The residual ~1% of parcels whose ag record exceeds
their mapped polygon from 2005 on is ordinary assessor-versus-GIS mismatch, and
the clamp handles it by the same rule.

**2009-07-05 fails separately**: its agricultural block is 0.99% populated
against ~35% elsewhere, so that vintage is reported as *unavailable* rather than
as a collapse to 1.21 M acres. That is the same export whose value block is dead
(§8) — a single bad export, failing in three places.

The general lesson is that the earlier degeneracy rule only caught fields that
were *empty*. A field can also be *impossibly large*, and the check that catches
it is a relationship the data must satisfy — here, that a part cannot exceed its
whole — rather than a threshold on the field alone.

## 15. Reservations: jurisdiction is not ownership, and names drift

`MontanaReservations_shp.zip` carries the seven Montana reservations (8.39 M
acres) and off-reservation trust land (174 k acres).

**A reservation boundary is jurisdictional, not a form of ownership.**
Reservations hold large amounts of fee land in non-tribal hands, the legacy of
allotment-era parcelling, and the proportion varies enormously:

| reservation | tribal trust | fee / private |
|---|--:|--:|
| Rocky Boy's | 100.0% | 0.0% |
| Northern Cheyenne | 97.9% | 2.1% |
| Fort Belknap | 92.1% | 4.7% |
| Blackfeet | 67.1% | 32.6% |
| Crow | 64.1% | 34.0% |
| Flathead | 63.6% | 33.4% |
| **Fort Peck** | **40.5%** | **59.3%** |

So `reservation` is published as its own dimension beside tenure, never folded
into it, and the crosstab is the checkerboard.

**It validates the name-based tribal class from the outside.** 95.4% of
name-classified tribal parcels fall inside a reservation and a further 542 sit on
off-reservation trust land, leaving 2.0% in neither. And the largest non-tribal
owners *inside* reservations are genuine ranches and companies — `SUNLIGHT RANCH
COMPANY`, `PADLOCK RANCH CO`, `BIG SKY COLONY INC`, `MONETTE FARMS USA INC` — so
the 3.09 M acres of fee land inside reservations is real, not misclassification.

### Owner names drift between vintages, and it moves land between classes

The same 39,850-acre holding at Rocky Boy's is titled:

```
2008   UNITED STATES OF AMERICA ROCKY BOY RESERVATION   -> tribal
2013   UNITED STATES OF AMERICA                         -> federal   (!)
2021   UNITED STATES OF AMERICA                         -> federal   (!)
2026   USA IN TRUST FOR                                 -> tribal
```

The land never changed; only its label did, and a name-only classifier follows
the label. The result was a **70-point collapse and recovery in Rocky Boy's
tribal share** that is pure artifact — 99.9% → 29.5% → 99.9%.

Three independent sources settle it. Public-domain federal land appears in the
public-lands layer *and* names its managing agency; land held in trust for a
tribe does neither and sits on reservation or trust land. So a parcel that is
titled with the **bare sovereign**, is **inside a reservation or on
off-reservation trust land**, and is **absent from the public-lands layer** is
trust land. Requiring the name to be bare is what keeps genuine Fish and
Wildlife, Park Service and Bureau of Reclamation holdings inside reservations out
of the reclassification.

The rule moves 288–502 parcels per snapshot. Rocky Boy's reads 99.9% → 100.0%
across the whole series, and statewide tribal trust becomes a smooth rising
series: **4.95 M → 5.36 M acres**.

### Two classification bugs found the same way

- **Bare `USA` matched company names.** `MONETTE FARMS USA INC` (51.7 k acres),
  `GARNET USA LLC`, `BOYNE USA INC`, `MILLERCOORS USA LLC` — 291 parcels and
  57.0 k acres of plainly private land classified federal. The token is now
  anchored to the start of the name; of the 421 parcels carrying `USA`
  elsewhere, all are corporate but one allottee trust the tribal rule catches
  first.
- **The Bureau of Indian Affairs administers land held in trust for tribes**, so
  it now classifies as tribal rather than as public-domain federal.

Calibration against 2006 `OWNCLASS` is unchanged at **0.9839** overall, with
federal precision improving slightly to 0.9837.

### Land returning to trust

Tribal trust acreage inside reservations rises **4.72 M → 5.17 M (+449 k acres)**
across 23 years, concentrated in Flathead (+199 k) and Blackfeet (+156 k).

## 16. The township is too coarse to answer "where", so the parcels ship

The plan's spatial frame was PLSS township, chosen for defensible reasons that
all still hold — it comes free from the attributes in every era, it is the
source's own grouping, it reconciles with counties, and "T1S R26E section 14" is
a citation a title company can look up. What it cannot do is answer the question
the dashboard exists to answer. A township is **36 square miles**. Forty new lots
inside one 20-acre plat and forty scattered tracts across six sections produce
the same cell value, and those are opposite land-use outcomes.

This was only visible after building it. The choropleth was legible, correct,
and useless at the scale a planning decision is actually made.

So the parcel fabric is published as vector tiles, measured first:

| | |
|---|--:|
| parcels, newest snapshot | 887,124 |
| geometry vertices | 40,019,133 |
| parcels under 1,000 m² | 24.4% |
| tiles z10–12 over the Montana bbox | **11,599** |
| on disk, uncompressed | 321 MB, mean 8 KB/tile |
| heaviest tile (Billings z11) | 6.1 MB raw, **1.0 MB gzipped** |

Three constraints fell out of the measurement, and each is enforced by an
assertion in `tiles.audit()` rather than left to care:

1. **z13 cannot be deployed.** It needs 57,270 tiles against Cloudflare Pages'
   20,000-file cap. z12 at GDAL's default 4096 extent is already finer than the
   screen, so the tile grid stops where the deployment does and the rendering is
   unaffected.
2. **z6–9 are generated and then deleted.** Every parcel in the state lands in a
   handful of tiles — 1.8 MB apiece to draw a grey smear. The source declares
   `minzoom: 10` and the township choropleth owns everything below, which is
   precisely the zoom range where an aggregate *is* the honest answer. The two
   surfaces now divide the work by what each can support.
3. **Tiles are stored decompressed**, 2.8× the bytes at rest and none on the
   wire. GDAL's MVT driver gzips bodies by default, needing a
   `Content-Encoding: gzip` that `_headers` can supply in production and
   `astro preview` cannot — so the map worked deployed and failed locally, the
   inverse of the usual trap and harder to find for it. The smoke suite now
   asserts the absence of a gzip magic number directly.

### GDAL's tile caps drop features silently

`MAX_SIZE` and `MAX_FEATURES` on the MVT driver are **discard thresholds, not
warnings**. A tile over the limit is written anyway, minus whatever did not fit,
and nothing in the output says so. At 2 MB / 400,000 the Billings z10 tile keeps
**19,572 of its 51,971 parcels** — the tile count, the zoom layout and the
directory tree are all identical to a correct run, and the only symptom is that
downtown Billings renders as a hole at exactly the zoom where someone would look
at it.

This was caught by regenerating the pyramid and comparing feature counts against
the known-good tiles, not by reading the output. `tiles.check_no_dropped_features`
now asserts that the deepest zoom carries at least as many feature instances as
the source has parcels — every parcel must appear in at least one z12 tile, and
boundary-straddling parcels appear in two, so the total is a lower bound that
cannot be met if anything was dropped.

### What is on a tile, and what is not

The geocode plus seven derived codes: `dev` (the platted/addressed/built ladder,
with −1 preserved for 2009's dead value block), `born` (snapshot index of first
appearance, which is what keeps the time dimension without 30 copies of the
geometry), `ac`, `ten`, `loc`, `res`, `cnd`.

**No owner name, mailing address, city, or value reaches a tile**, and the parcel
popup says so in as many words. The geocode is the DOR's own public key — it is
what the state's Cadastral application searches on — and the boundary is already
published by MSL. MCA 2-6-1017 bars using a state-prepared list of persons as a
*distribution list*, which this is not and cannot become without the names.

The non-disclosure that matters is kept by what is withheld. Withholding the map
as well bought nothing, and cost the ability to answer the question.

### Reference overlays

Reservation boundaries and public lands render as recessive annotation —
reservations as outlines, public lands as a desaturated wash — behind a
collapsible layer list, both off-by-default and lazily fetched. They exist
because *neither is ownership*: a parcel inside a reservation may be fee land
(section 15) and a parcel adjoining public land is not public. Showing them as
analytical layers would invite exactly that misreading, so they are styled to sit
beneath the data rather than compete with it.

Both are generated by `export_overlay()` in their own modules. Nothing is
measured off either one — the analytical flags come from full-resolution
point-in-polygon joins in the same modules — so the drawn layers can be reduced
without moving a published number, and only the drawing is at stake.

What the public-lands layer must preserve is the **school-trust checkerboard**:
sections 16 and 36 of every township are state land, so roughly 9,000 of the
31,091 source polygons form a 640-acre grid that is one of the most recognisable
facts about Montana land tenure, and the reason the dissolved layer carries
1,095,567 vertices. A 40-acre floor drops 46% of the polygons for 0.34% of the
acreage and leaves every one of those sections standing; 60 m simplification is
~1 px at z10 and ~4.6 px at z12. Coarser settings were measured (250 m → 4.0 MB,
500 m → 3.0 MB) and **not** taken: the layer is off by default and loads in
**1.7 s measured**, so there was no load problem to trade fidelity against, and
at parcel zoom a visibly wrong boundary beside crisp parcel edges would cost more
than the bytes are worth. The before/after renders differ by 1.3% of pixels at
z8, all of it antialiasing on simplified edges.

## 17. Dedicated common areas are parcels that never climb the ladder

A subdivision plat sets aside tracts that are never meant to carry a house:
dedicated open space, parks, drainage and detention lots, well sites, the
condominium master lot. They are parcels, they sit at stage 0 for ever, and
left in they inflate dormant inventory and depress every absorption curve.
Asked about on 2026-10-30; measured the same day.

The short legal description (`LegalDescr` / `LegalDescriptionShort` /
`SHT_LEG_DS`, present in every vintage, populated on 99.6% of 2026 parcels and
92.7% of 2006) had never been extracted. Read from the archives, it is only
part of the answer, and three signals are combined (`timeseries/commonarea.py`):

| signal, platted-only subdivision lots under 40 ac | 2026 (of 54,168) | 2006 (of 63,994) |
|---|---|---|
| DOR property type Non-Valued | 3,215 | 383 |
| owners' association or condo master, or the owner field *is* the tract's name | 1,583 | 588 |
| legal description names the tract, and no building is assessed | 2,214 | 1,191 |
| **any signal** | **4,194 (7.7%)** | **1,642 (2.6%)** |

In Flathead, Missoula and Gallatin counties a fifth to a quarter of
platted-only lots are such tracts.

Four traps, each found by sampling the hits:

* **"PLUS OPEN SPACE" is a lot, not a park.** Gallatin appends it to ordinary
  residential lots that own a share of a common area; Yellowstone writes
  "2.5% COMMON AREA INTEREST" on condominium units. A phrase that follows an
  appurtenance word is excluded.
* **PARK and TRAIL are mostly names.** Roundup Park Addition, Clyde Park,
  Trail Creek Addition, Parkland West. The description is matched with the
  subdivision's own name removed, PARK counts only as a descriptor ("PARK D",
  "PARK AREA", "PARK IN BLK") and TRAIL not at all.
* **A built parcel with only a legal phrase is a house.** The legal signal
  needs no assessed building; the owner and property-type signals stand at
  any stage, since a clubhouse on an HOA tract is still a tract. With the
  guards the rule touches 0.4% of built lots in 2026 and 0.2% in 2006;
  without the building guard it flagged a residence for every two tracts.
* **Non-Valued outside a subdivision is a substation or a railbed.** The
  first cut took the property type at any location and flagged 1,642 parcels
  with no subdivision name, 33,000 acres, 81% of them owned by NorthWestern
  Energy, BNSF, Avista, the telephone cooperatives and the ditch companies:
  centrally assessed property, which the county marks Non-Valued for a
  different reason. The signal is confined to named subdivisions. For the
  same reason a company whose name merely contains the words ("WIDE OPEN
  SPACES LLC", "PARKLAND USA CORPORATION") is not a tract-named owner.

Flagged parcels leave the ladder everywhere: the aggregate cubes count them
in their own column (`n_dev4`, label `common_area`), the absorption cohorts
and dormant inventory drop them, and the parcel tiles carry `dev = 4` so the
Development view paints them chartreuse (#80ff00, apart from the public-land
green) and names them in its
key. The per-parcel `common_area_src` bitmask (1 legal, 2 non-valued, 4
association, 8 tract-named owner) travels in the extract for QA.

What moved when they left (2026-09-04 vintage, before → after):

| measure | before | after | change |
|---|---|---|---|
| platted-only parcels, statewide | 368,424 | 363,635 | −4,789 |
| addressed, not built | 43,711 | 42,393 | −1,318 |
| built | 474,989 | 473,494 | −1,495 |
| common area (new column) | — | 7,602 (52,551 ac) | |
| dormant inventory, all sizes | 70,984 | 67,790 | −4.5% |
| dormant lots under 40 ac | 46,868 | 43,743 | −6.7% |
| dormant lots under 40 ac, five years or older | 37,230 | 34,598 | −7.1% |
| built share of cohorts ten snapshots old or more | 61.1% | 61.9% | +0.8 pt |

The addressed and built parcels that left are association-owned and
non-valued tracts that happen to carry a structure or a street number (a
clubhouse, a pump house): 0.3% of built parcels, the rate the guard note
above reports.

One vintage is a known exception. 2009-07-05 ships its value block dead, so
improvement status is unknown there and the legal signal runs unguarded: it
flags 5,270 parcels against 3,802 and 4,299 in the vintages either side,
roughly a thousand more legal hits than either neighbour. The Development
view leaves that vintage out of the ladder-over-time chart and says so on
the card (a wedge of "no data" was drawn first and read as a collapse),
dormant inventory is measured on the latest vintage, and the absorption
cohorts never read a stage from it, so nothing published rests on it; the
share-of-platted-lots figure for that vintage is null in the QA rather than
wrong.
