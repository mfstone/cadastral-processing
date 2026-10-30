# Large-landholding and concentration definitions

Source: Haggerty, J. H., K. Epstein, H. Gosnell, J. Rose, and M. Stone. 2022.
"Rural Land Concentration & Protected Areas: Recent Trends from Montana and
Greater Yellowstone." *Society & Natural Resources* 35(6): 692-700.
doi:10.1080/08941920.2022.2038318. Its online supplement is the consolidation
methodology in `docs/reference/Detailed Cadastral Methodology.pdf`.

These are the definitions the `holdings` stage is built to. Anything the paper
does not define is marked **choice** and is ours to defend.

## Unit of analysis

* A **holding** is the consolidated acreage of one owner code within one county
  (the paper's owner codes are assigned per county; Table 1 notes that regional
  owner totals are not reported because one owner may appear in several counties).
  The statewide app also publishes a cross-county holding per `GlobalOwnerID`,
  labelled separately. Both are kept; neither replaces the other.
* **Private** land only. Public domain (federal, state, local), tribal trust and
  reservation categories are excluded from every statistic below. Tenure comes
  from `timeseries/ownerclass.py` plus the public-lands layer, not from a name
  list alone.
* **Large** means a private holding of **640 acres or more** (one section).

## Metrics (per county, per snapshot)

| metric | definition | Table 1 / figure |
|---|---|---|
| `large_acres` | sum of acres in private holdings >= 640 ac | Table 1, "Private land in holdings 640 acres or larger" |
| `large_owners` | count of owner codes with a private holding >= 640 ac | Table 1, "Number of owners" |
| `large_mean_acres` | `large_acres / large_owners` | Table 1, "Average size" |
| `clo4` | acres of the 4 largest holdings / `large_acres` (four-property concentration ratio, after Desmarais et al. 2015) | Figure 1 bar chart |
| `top4_acres` | acres of the 4 largest holdings | text: +235,000 ac 2005-2018 across 48 holdings |
| `top1_acres`, `top2_acres` | the two largest holdings | Figure 2 dumbbell |
| `gap_1_2` | `top1_acres - top2_acres` | Figure 2; "quintupled on average" |
| `top1_share_of_top4_growth` | share of top-4 growth accruing to the largest | text: 70% |

Region-level: `clo4` averaged across counties (14% -> 16%); change in number
of large owners (2,993 -> 2,801, -6.4%); mean holding (3,885 -> 4,141 ac, +7%).

**Choices beyond the paper** (published with a label, switchable):
* holding-size classes on consolidated private acreage: 640-2,560 / 2,560-10,000 /
  10,000-50,000 / >= 50,000 ac (aliquot-anchored: section, 4 sections, ~16 sections);
* Lorenz curve and Gini on private acreage across all private holdings, not only
  large ones;
* top-N lists for N in {1, 4, 10} with owner names, since the paper names drivers.

## Snapshots and county set used by the paper

* Two points in time: **2005** and **2018**. The archive holds two of each
  (`Cadastral20050201`, `Cadastral20050721`, `Cadastral20180110`,
  `Cadastral20181218`). The methodology text refers to "2005" and "2019 data";
  which archive matches Table 1 is **unresolved**. Run all four; the one that
  reproduces Table 1 most closely is the paper's.
* Text and Figure 1 say **twelve** counties; Table 1 lists **thirteen** (Valley
  is in the table but not the figure). Reproduce all thirteen.

## Regression baseline: Table 1 (author calculations, Montana cadastral data)

Acres; owners; mean holding size. Expect residual differences: the paper's
homogenization included manual QA and adjustment we cannot replay exactly.

| county | total_acres | large_acres_2005 | large_acres_2018 | owners_2005 | owners_2018 | mean_2005 | mean_2018 |
|---|---|---|---|---|---|---|---|
| Beaverhead | 3,566,341 | 1,016,370 | 1,000,755 | 201 | 184 | 5,057 | 5,439 |
| Carbon | 1,317,043 | 500,292 | 485,788 | 216 | 207 | 2,316 | 2,347 |
| Fergus | 2,783,889 | 1,813,265 | 1,917,110 | 662 | 627 | 2,739 | 3,058 |
| Golden Valley | 751,440 | 681,994 | 639,469 | 139 | 123 | 4,906 | 5,199 |
| Madison | 2,305,561 | 892,681 | 903,931 | 241 | 238 | 3,704 | 3,798 |
| Meagher | 1,530,928 | 921,716 | 916,188 | 150 | 136 | 6,145 | 6,737 |
| Park | 1,799,453 | 649,744 | 642,201 | 214 | 202 | 3,036 | 3,179 |
| Petroleum | 1,062,205 | 570,196 | 578,113 | 118 | 114 | 4,832 | 5,071 |
| Phillips | 3,308,105 | 1,512,138 | 1,526,557 | 373 | 329 | 4,053 | 4,639 |
| Stillwater | 1,147,180 | 752,043 | 757,024 | 305 | 280 | 2,466 | 2,704 |
| Sweet Grass | 1,198,785 | 780,220 | 773,337 | 227 | 219 | 3,437 | 3,531 |
| Valley | 3,155,397 | 1,300,854 | 1,319,475 | 464 | 446 | 2,804 | 2,958 |
| Wheatland | 912,591 | 735,919 | 735,520 | 147 | 142 | 5,006 | 5,180 |
| Totals | 24,838,918 | 12,127,432 | 12,195,468 | 2,993 | 2,801 | 3,885 | 4,141 |

Figure 1 CLO4 (read from the chart, approximate, 2005 -> 2018): Meagher 25->25,
Wheatland 23->22, Golden Valley 22->23, Beaverhead 21->23, Sweet Grass 19->21,
Madison 18->20, Petroleum 17->18, Carbon 15->16, Park 14->15, Stillwater 9->11,
Phillips 8->9, Fergus 7->8. Treat as a sanity check, not a tolerance target.

## Mapping onto the pipeline (as built, 2026-10-30)

1. `timeseries/identity.py` (stage 8) resolves owners per snapshot in three
   tiers: `strict_id` (exact normalized name + address), `group_id` (the
   document's rule: address key; company, trust and multi-party names bridge
   addresses; name fallback where the address is blank or General Delivery;
   overrides; the ORION party bridge for 2024-2026) and `group_max` (every
   pending flag accepted, county-scoped). Outputs
   `data/identity/owners_<date>.parquet` (one row per parcel) and
   `groups_<date>.parquet` (one row per group, with its review status).
2. `timeseries/tenure_area.py` (stage 9) intersects every parcel with the
   public-lands layer: `data/tenure/area_<date>.parquet`.
3. `timeseries/holdings.py` (stage 10) decides tenure per parcel, keeps the
   private universe, groups private acres by (county, group) and by group,
   applies the 640 ac threshold and writes `data/facts/holdings_county.parquet`
   (county rows plus a statewide row, `county_n` 0; Lorenz shares, Gini and the
   size classes are columns), `holdings_state.parquet`, `holdings_top.parquet`
   (top 10 per county and statewide, with names) and `holdings_review.parquet`
   (large holdings by review status).
4. `timeseries/regress.py` rebuilds this file's Table 1 from the 2005 and 2018
   archives: `data/facts/regression_table1.csv`.
5. `timeseries/publish.py` ships the facts and `meta.holdings` to the site, and
   `timeseries/tiles.py` bakes holding size class, county top-4 rank and the
   pending-review flag onto the parcel tiles.
6. Dashboard views **Holdings** (CLO4 by county; large owners and acres as a
   document-to-maximal range; size classes; concentration shares; top table
   with review badges; the Table 1 card) and **Review** (what a reviewer would
   change, status composition over time, the queue sorted by acres at stake,
   how to record a decision).
## Review indication (requirement, 2026-10-30; as built)

The methodology's manual QA step cannot be automated, so the application
shows which holdings depend on unreviewed judgments instead of hiding them.

**Per owner group** (every snapshot), a `review_status`, assigned from the
group's flag bits in this precedence (a later line wins):

| status | meaning |
|---|---|
| `clean` | no flag raised; identity rests on the exact normalized address (+ name) |
| `auto_entity` | merged across addresses by a company, trust or multi-party name: the document's rule, applied without a human, so shown distinctly |
| `orion_bridged` | merged because parcels share a DOR `PartyID` (evidence, not judgment; 2024-2026 only) |
| `token_check` | first two name components match another group (the document's DataCheck2); nothing merged |
| `flagged` | a strong pending flag: an individual's name at several addresses (the document's FALSE), a General Delivery address, or an address hosting more than three names |
| `reviewed_kept` | a reviewer looked and kept it separate (`keep` override) |
| `reviewed_merged` | an override merged it (`merge` override) |

Flag bits carried on every parcel and group (`timeseries/identity.py`):
`same_name_diff_addr` (1), `token_check` (2), `general_delivery` (4),
`hub_address` (8), `blank_address` (16), `care_of` (32), `blank_owner` (64),
`entity_bridge` (128), `couple_bridge` (256), `override_merge` (512),
`tenure_conflict` (1024, set in the holdings stage where the point and area
methods disagree), `orion_bridge` (2048), `reviewed_kept` (4096). The pending
set is 1 | 2 | 4 | 8; the strong set, which makes a holding provisional, is
1 | 4 | 8.

**Per holding**, derived from its groups, in `holdings_county.parquet`:
`large_provisional` and `large_provisional_acres` (large holdings carrying a
strong pending flag), `large_token`, `large_conflict` (large holdings built on
a parcel the two tenure methods classify differently), and the maximal-tier
bounds `large_acres_max` and `large_owners_max`. Every top-N row carries
`acres` (document tier) and `acres_if_merged` (every pending flag accepted),
so a holding and the county's CLO4 read as a range, not a point.

**Dashboard**: a badge on every top-N row; the Holdings view draws the
document and maximal tiers as a band; the Review view lists the queue sorted
by acres at stake and names `owner_overrides.csv` as the only write path
(reviewer, date and reason are carried, not interpreted).

Not built: a toggle recomputing every metric on clean + reviewed holdings
only (the document tier already excludes every pending merge, so the band's
lower edge is that number); issue types `same_address_diff_name` and
`orion_name_conflict` (the hub-address flag covers the first; ORION is used
as a bridge, not compared by name).
## Public land exclusion (requirement, 2026-10-30; as built)

Public land is removed from the private universe by **location**, using the
public-lands layer, never by owner name alone. Name rules miss agencies
(`MONTANA HISTORICAL SOCIETY`, `GALLATIN AIRPORT AUTHORITY`, school districts:
2,439 parcels in 2026) and the paper's "private" universe excludes every public
category in its Figure 1 legend.

Sources on hand (both EPSG:6514, field `OWNER`, 19 categories):
* `GeoData/.../Montana_Cadastral/PUBLICLANDS.shp`, 31,099 polygons, the
  canonical copy. Its `Edit_Date` field is empty in every row, so the file date
  (2026-06-03) is the only vintage evidence; `timeseries/tenure_area.py` now
  writes the layer's path, file date and polygon count into
  `data/tenure/qa_tenure_area.json` (the outputs on disk predate that line).
* `Extreme SSD/Cadastral/MTPublicLands_SHP.zip`, 31,091 polygons (what
  `timeseries/publiclands.py` uses for the point method); the fallback.

Two methods, both published:
1. **Representative point in polygon** (`timeseries/publiclands.py`, ~12 s per
   snapshot). Correct for parcels wholly inside or outside, which is nearly
   all of them.
2. **Area overlap** (`timeseries/tenure_area.py`, ~5 min per snapshot):
   intersect each parcel with the layer and store `public_fraction` and
   `public_acres`. A parcel is excluded from the private universe when
   `public_fraction >= 0.5` (**choice**), and a straddling parcel contributes
   only its non-public acres to the holding.

The area method decides exclusion whenever its output exists for the
snapshot; the point label is compared and every disagreement is carried on
the parcel as `tenure_conflict` (flag 1024), so that `large_conflict` in
`holdings_county.parquet` counts the large holdings built on a disputed
parcel and the Review view shows them. (The first build excluded a parcel
when *either* method called it public, which silently dropped every disputed
parcel and left that count at zero; fixed 2026-10-30.) Measured
disagreements, point-public / area-private (of which kept private after the
name rule) and point-private / area-public:

| snapshot | point public, area private | kept private | point private, area public |
|---|---|---|---|
| 2005-07-21 | 1,199 parcels, 47,078 ac | 823 (34,424 private ac) | 716 parcels, 51,768 ac |
| 2018-01-10 | 284 parcels, 14,645 ac | 189 (12,415 private ac) | 263 parcels, 18,503 ac |
| 2026-09-04 | 174 parcels, 15,435 ac | 37 (2,620 private ac) | 133 parcels, 19,689 ac |

Public agency names still exclude a parcel the layer misses, and the three-way
tenure stays as built: `public_domain` (this layer, or an agency name),
`tribal_trust` (owner name, with the tribal rule ahead of the federal rule),
`private`. Blank-owner parcels are outside the private universe. Both
non-private classes are excluded from every holdings metric. Conservation
easements (`CONSERVATIONEASEMENTS.shp`, 2,779 polygons) are private land and
stay in; they are an overlay, not an exclusion.

The layer is one vintage applied to every snapshot. Historical tenure is
therefore approximate and is labelled as such wherever it appears.
## Implementation notes (measured, 2026-10-30)

* **Address columns.** The truncated shapefile schema is `OwnerAddre` (line 1),
  `OwnerAdd_1` (line 2), `OwnerAdd_2` (line 3): 98.1% / 10.0% / 0.5% populated
  in 2026-09-04, and line 2 holds the street whenever line 1 is a "MAIL TO"
  instruction. The alias table had read line 3 as line 2 and skipped line 2;
  fixed in `cadastral/schema.py`. The extracts now carry `owner_addr_norm`.
* **Hub addresses.** 7,045 addresses carry more than three names in 2018; the
  median carries four and three quarters carry five or fewer, which is a
  family's post-office box and which the document merges. Splitting the key at
  three names keyed 15.6% of private parcels by name and under-merged against
  Table 1, so the split is at five and the flag at three.
* **Tiers against Table 1 (area tenure, 13 counties).** Large acres, document
  / maximal tier against the paper: 2005-07-21 -1.8% / -0.3%; 2018-01-10
  -1.3% / -0.4% (the 2005-02-01 and 2018-12-18 archives give the same figures
  to a tenth). Large owners: 2005 paper 3,457, document 3,630, maximal 3,424;
  2018 paper 3,247, document 3,406, maximal 3,230. On owners the paper lies
  between the two tiers in both totals and in 9 of 13 counties (2005) and 8 of
  13 (2018): the shape a manual pass over the flagged queue should produce. On
  acres the paper sits 0.3-0.4% above even the maximal tier. The public
  acreage removed from straddling parcels in these counties (17,563 ac in
  2005, 3,688 ac in 2018) is too small to account for that, so the remainder
  is the paper's manual homogenization or an acreage source that cannot be
  replayed. Per county at the maximal tier, 2018 is within -1.7%..+0.9%
  everywhere; 2005 is wider (Golden Valley -8.6%, Fergus +6.1%), which points
  at a different 2005 vintage behind the paper rather than at the identity
  rule. The strict tier (exact name + address, no bridges; measured on the
  first run with point tenure) sat at -4.7% acres / +20% owners on 2018 and is
  carried only as the floor.
* **2005 vintage.** 2005-02-01 is short of Park (-27% of county area) and Sweet
  Grass (-19%); 2005-07-21 is whole and is taken as the paper's 2005.
* **ORION bridge.** `property.GeoCodeSearch` joins the parcel id at 99.65%
  (2026), 99.53% (2025), 99.45% (2024); one owner record per property-year, so
  a shared `PartyID` is a shared owner record. Applied as an edge for those
  three vintages and marked `orion_bridged`.
* **Tenure by area.** Against the point method, 1,915 parcels disagree on
  2005-07-21, 547 on 2018-01-10 and 307 on 2026-09-04 (the layer is a 2026
  vintage, so disagreement grows backwards in time); 823 / 189 / 37 of them
  stay private under the area rule and carry the flag, and 147 / 45 / 4 large
  holdings rest on one. Public acreage removed from straddling private parcels
  statewide: 69,117 ac (2005-07-21), 15,099 (2018-01-10), 8,654 (2026-09-04).
  The overlap stage costs about five minutes per snapshot, almost all of it
  the `intersects` query.
* **Statewide series (document tier).** Owners of 640+ ac holdings 14,011
  (2003-12-22) -> 12,506 (2026-09-04); their acreage 46.81M -> 47.76M ac
  (maximal tier 47.70M -> 48.27M); mean holding 3,341 -> 3,819 ac; share of
  large-holding acreage held by the top 1% of large owners 53.6% -> 64.0%;
  Gini over private owners 0.956 -> 0.967; large acreage mailed out of state
  11.7% -> 16.3%. Largest 2026 holdings: Farmland Reserve 326k, Green Diamond
  Montana Timberlands 291k, 71 Ranch 255k, Wilks Ranch Montana 243k, Sunlight
  Ranch 240k, Coffee Nefsy 216k ac.
* **Review load, 2026-09-04, statewide.** Large holdings by status: clean
  7,091 (23.1M ac), merged by entity name 594 (3.7M), token check 1,163
  (4.1M), flagged 3,621 (16.4M), ORION-bridged 37 (0.5M). The flagged set is
  where a reviewer's time goes; accepting every pending flag moves 0.5M ac and
  711 owners between the tiers.
## Recording a review

`owner_overrides.csv` (the expanded schema of `cadastral/consolidate.py`; an
example is in `owner_overrides.example.csv`) is the only write path. The
identity stage reads it on every run.

| action | effect |
|---|---|
| `merge` | every `source_owner_id` sharing one `target_owner_group_id` becomes one group; status `reviewed: merged` |
| `keep` | the id was looked at and kept separate; its pending flags leave the maximal tier; status `reviewed: kept separate` |

`source_owner_id` may be a strict id or address-key id (`owners_<date>`) or
the 16-character group hash shown in the dashboard's Review table
(`groups_<date>`). Group hashes are resolved on a second pass, so a reviewer
can work from the dashboard alone. `reason`, `reviewer` and `review_date` are
carried, not interpreted.
