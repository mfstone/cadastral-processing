# Analytics for land-use and planning use

What this dataset can honestly support, ordered by how useful it is to someone
doing capacity analysis, growth policy, or open-space work — and what it cannot.
Every item notes the measured basis and the caveat that travels with it.

## Tier 1 — directly supported, high value

### 1. The development ladder

Three ordered stages per parcel per snapshot:

| stage | meaning | 2026 share |
|---|---|--:|
| 0 | platted only — a lot exists, nothing else | 37.8% |
| 1 | **situs address assigned, no assessed building** | 8.6% |
| 2 | assessed building value present | 53.5% |

The middle rung is the useful one, and it is earned rather than assumed: a parcel
with an assigned address carries an assessed building **82.9–87.1%** of the time
against **8.4–21.8%** without one, a 4–10× lift. An address is assigned at
E911/permit stage, so stage 1 is *commitment to build* rather than *a lot offered
for sale*.

Derived measures that matter to a planner:

- **Committed-but-unbuilt inventory** — stage 1 count and acres. ~76,500 parcels
  statewide in 2026, and it has sat near that level since 2014.
- **Dormant platted inventory** — stage 0 parcels created more than five years
  ago and still at stage 0. The "zombie subdivision" measure that the 2005–2008
  boom left behind.
- **Absorption curve** — of the lots created in year *Y*, what share reach stage 2
  by *Y+1*, *+3*, *+5*, *+10*. Per county this yields **years of supply**, which
  is the single most load-bearing number in an argument about whether to approve
  more lots.

*Caveat:* the ladder is probabilistic. 30,812 parcels in 2026 have a building but
no address, so stage 0 does not prove absence of a building; and a bare street
name without a house number ("SILVER BUTTE RD") is a weaker signal than a
numbered address, so both flags are carried separately.

### 2. Absentee ownership as a gradient, not a binary

In-state versus out-of-state is too coarse for planning: a Bozeman parcel owned
from Billings is in-state and still absentee. The gradient, built entirely from
fields already present:

1. **local** — owner mails to the parcel's own situs city (75.5% of the 507,917
   parcels where both are known, 2026)
2. **same county** — owner's city sits in the parcel's county
3. **elsewhere in Montana** — in-state absentee
4. **out-of-state**
5. **unknown / foreign**

*Why it matters:* absentee share predicts thin participation in local process,
resistance to bonds and levies, short-term-rental conversion, and notice
requirements that under-reach the people actually affected.

*Caveat:* this is a **mailing address**, not residence. It cannot distinguish an
owner-occupier from a local landlord, and a property manager's or trustee's
address reads as the owner's.

### 3. Owner-origin filtering at any granularity

Filter the whole surface by owner location: in-state, out-of-state, a specific
state, or a specific origin city. Owner city is populated on **99.4%** of parcels
(7,007 distinct) and owner ZIP5 likewise (11,656 distinct), so origin can be
exposed at state, metro, or city level.

*Caveat, and it is a sharp one:* the top out-of-state owner cities in 2026 are
Denver (2,065), **Washington DC (1,963)**, Salt Lake City (1,841), Houston
(1,589). Washington DC is federal land-management agencies, not people. Any
owner-origin view needs the legal-form classifier (item 11) or it will read
government holdings as absentee investment.

### 4. Clustering against regulatory thresholds

Montana's Subdivision and Platting Act regulates divisions that create parcels
**under 160 acres**; the family-conveyance exemption (MCA 76-3-207(1)(b)) may not
leave more than one remaining parcel under 160 acres; the agricultural-covenant
exemption requires exclusive agricultural use.

So: a fine-grained histogram of **newly created** parcel sizes around 160, 40 and
20 acres. A spike immediately *above* 160 acres is a review-avoidance signature;
a spike immediately *below* it means review happened. Tracking the ratio over 23
years shows where exemptions are doing the work review would otherwise do.

This is the analytic I would most want to publish. Exact acreage is available for
every created parcel, nobody appears to have it longitudinally, and it speaks
directly to whether the Act is functioning as written.

### 5. Agricultural land conversion

36.2% of parcels carry agricultural-use acreage, covering **67.9M of 90.6M
mapped acres** — so this is most of the state by area. The ag acreage fields
(`ContinuousCrop`, `Grazing`, `Irrigated`, `WildHay`, `Forest`, `Fallow`,
`Farmsite`, `NonQualified`) give a far cleaner indicator than `PropType`, which
is inconsistently coded across counties.

Measure: parcels carrying ag acreage at *t* and none at *t+1*; the acreage that
left; and the size class it became. That is the open-space question stated
quantitatively.

## Tier 2 — supported, with more interpretation required

### 6. Fragmentation as a flow matrix, not only a stock

The stock table shows the shift is slow — acreage under 40 acres rising 2.65% →
3.16% of the state over 23 years. A transition matrix (acreage moving from size
class *i* to class *j* per interval) shows *where it comes from*, which is the
part a planner can act on.

### 7. Turnover velocity as a leading indicator

Owner-change rate per township per year, tested against whether a turnover spike
*precedes* a creation spike by one or two intervals. If the lead is real it is a
genuine early-warning signal for where applications will land next. Worth
testing before it is believed.

### 8. Consolidation and assembly

The counter-trend: `parcels_merged` events plus acreage moving *into* the >640
class. Fragmentation gets the attention, but assembly changes the tax base and
land access just as much.

### 9. Condominiumisation, kept separate

5.9% of parcels carry a non-zero unit code and about zero acres. They are housing
supply but not land consumption, and mixing them into fragmentation would show a
resort-town condo boom as ranchland breaking up. Always a separate column.

## Tier 3 — needs one more input

| # | analytic | what it needs |
|---|---|---|
| 10 | City limits and the inside / 1-mile / 5-mile ring split — where growth leapfrogs into unincorporated county | TIGER places (0.3 MB) |
| 11 | Owner legal form: individual / entity / trust / government / institution | rule list calibrated on 2002–2011 `OWNCLASS` |
| 12 | Conservation easements as the counter-force to fragmentation | MSL `MTConEasements` 2014–2025 (1–4 MB) |
| 13 | Distance-based absenteeism rather than categorical | ZIP centroid table (~1 MB) |

## What I would caution against publishing

- **Dollar-based measures.** Montana reappraises on a cycle (2-year since 2015,
  6-year before), so any assessed-value series carries administrative step
  changes that look like market events. Counts and flags, not dollars.
- **Treating "no address" as "no building."** 30,812 counterexamples in 2026.
- **A condition series read across 2014 → 2015 as if one field.** The DOR filled
  CDU through tax year 2014 and its four components from 2015, seeded by copying;
  the seam re-rates 19% of dwellings. Name the field at every point (FINDINGS §19).
- **Mixing condo units into land fragmentation.** See item 9.
- **Owner-origin analysis without legal form.** See item 3 — Washington DC.
- **A single "subdivision" number.** Events are inferred; the confidence tiers
  and the `first_mapping` exclusion are what make the figure defensible, and a
  headline that drops them is not the same claim.

---

# Measured results

## The 20-acre threshold is real; the 40 and 160-acre "spikes" are not

My first pass found sharp spikes in newly created parcel sizes at exactly 40 and
160 acres and read them as review-avoidance. **That was wrong, and the control
caught it.** A quarter-quarter section is exactly 40 acres and a quarter section
exactly 160, so those spikes are the PLSS survey grid: 17.01% of all created
parcels land within 1% of an aliquot size (1.25 / 2.5 / 5 / 10 / 20 / 40 / 80 /
160 / 320 / 640 acres). Remove them and the distribution around 160 goes flat.
The mass also *straddled* each value rather than sitting above it, which is a
geometry signature, not a behavioural one.

One edge survives the control, and it is the one with a statutory basis.

Under **MCA 76-4-102(16)** and **76-4-125**, a parcel of 20 acres or more that is
exempt from the Subdivision and Platting Act is **not subject to DEQ sanitation
review**; divisions creating parcels under 20 acres go to DEQ, while 20–160 acres
go to the local health department. Crossing 20 acres therefore changes which
agency reviews the division, or whether anyone does.

Newly created parcels, aliquot sizes excluded, 0.25-acre bins:

```
[18.00,18.25)   212  ########
[19.00,19.25)   285  ###########
[19.50,19.75)   451  ##################
[19.75,20.25)     — excluded as aliquot —      <== 20-acre DEQ threshold
[20.25,20.50)   958  ######################################
[20.50,20.75)   853  ##################################
[21.00,21.25)   323  ############
[22.00,22.25)   160  ######
[23.00,23.25)   113  ####
```

**Sensitivity** — ratio of mass above to mass below, by window width:

| window | ±0.5 | ±0.75 | ±1.0 | ±1.5 | ±2.0 | ±3.0 |
|---|--:|--:|--:|--:|--:|--:|
| above/below | 2.12 | 2.34 | 2.05 | 1.81 | 1.60 | 1.40 |

Monotone decay with width is what a localised spike produces.

**Controls at sizes with no statutory meaning** (±1 acre, aliquot excluded):

| size | 12 ac | 15 ac | 18 ac | 25 ac | 30 ac | 50 ac | 100 ac |
|---|--:|--:|--:|--:|--:|--:|--:|
| above/below | 0.88 | 1.03 | 1.21 | 0.88 | 1.05 | 1.01 | 1.16 |

All ≈ 1.0. The asymmetry is specific to 20 acres.

**And it is strengthening:** 1.77 (2003–2010) → 2.15 (2011–2019) → **2.84
(2020–2026)**.

*What this does and does not show.* It shows that divisions increasingly produce
parcels sized just above the sanitation-review threshold rather than just below
it. It does not establish intent, and alternatives exist — market preference for
20-acre tracts, county zoning minimums at 20 acres. But the control sizes make
coincidence an unattractive explanation.

## Absorption: roughly half of created lots are never built on

Share of each cohort's lots reaching an assessed building, by age:

| cohort | lots | ~1 yr | ~3 yr | ~5 yr | ~10 yr | ~15 yr |
|---|--:|--:|--:|--:|--:|--:|
| 2004-07 | 23,837 | 47.2% | 50.6% | 52.4% | 55.2% | 58.3% |
| 2006-07 | 9,601 | 35.6% | 39.4% | 41.3% | 45.7% | 49.2% |
| 2008-01 | 5,477 | 23.1% | 31.8% | 35.5% | 44.4% | 56.7% |
| 2010-10 | 5,494 | 33.1% | 35.5% | 37.3% | 48.3% | 56.4% |
| 2014-12 | 6,696 | 41.5% | 53.7% | 58.5% | 64.0% | — |
| 2019-12 | 7,497 | 51.6% | 68.8% | 73.9% | — | — |
| 2022-12 | 6,266 | 40.5% | 48.2% | — | — | — |

Two things to read carefully. The curves **plateau near 50–58%** for cohorts old
enough to have finished, so 40–50% of created lots carry no building even after
fifteen years. And the 2019 cohort is absorbing much faster (73.9% by five years)
than the boom-era cohorts.

*Caveat on the one-year column.* A high immediate rate does not mean houses went
up in twelve months. A split of already-improved land hands the existing house to
one of the child parcels, so that child is "built" the moment it exists.
Separating splits of improved parents from genuinely vacant new lots is the
obvious refinement and is not yet done.

## Dormant platted inventory: 46,868 residential lots

Stage-0 parcels at 2026 whose creation was observed, by size class:

| size class | parcels | acres |
|---|--:|--:|
| < 1 ac | 15,214 | 5,000 |
| 1–5 ac | 12,077 | 30,000 |
| 5–20 ac | 11,797 | 141,000 |
| 20–40 ac | 7,780 | 216,000 |
| 40–160 ac | 10,099 | 882,000 |
| **> 160 ac** | **14,017** | **6,544,000** |

The size split is why the restriction matters: the over-160-acre class is 84% of
the dormant *acreage* and is rangeland, not inventory. The **under-40-acre
figure, 46,868 parcels on 392,000 acres**, is the residential-lot proxy.

Top counties by dormant lots under 40 acres:

| county | lots < 40 ac | of which 5 yr+ | median age (yr) |
|---|--:|--:|--:|
| Gallatin | 4,599 | 3,256 | 10.6 |
| Yellowstone | 3,669 | 2,188 | 7.7 |
| Flathead | 3,405 | 2,557 | 15.1 |
| Madison | 3,083 | 2,735 | 13.7 |
| **Jefferson** | 2,968 | 2,800 | **20.1** |
| **Sanders** | 2,601 | 2,306 | **20.1** |
| Lincoln | 2,416 | 2,060 | 17.2 |
| Ravalli | 1,998 | 1,390 | 13.7 |
| Missoula | 1,801 | 979 | 6.7 |
| Granite | 1,700 | 1,628 | 13.7 |

Jefferson, Sanders and Granite carry lots with a **median age around twenty
years** — approved capacity that has sat unbuilt for two decades.

## Committed-but-unbuilt pipeline, 2026

Parcels with a house number and no assessed building:

| county | platted | **addressed** | built | % committed |
|---|--:|--:|--:|--:|
| Flathead | 7,836 | **9,716** | 51,420 | **14.1%** |
| Missoula | 8,389 | 3,669 | 41,815 | 6.8% |
| Yellowstone | 12,382 | 3,495 | 67,993 | 4.2% |
| Lewis and Clark | 9,190 | 2,534 | 28,176 | 6.4% |
| Lake | 6,487 | 2,462 | 14,086 | 10.7% |

Flathead's 14.1% is the standout — nearly one parcel in seven is addressed and
waiting.

## Absentee gradient: only the three-tier version is a time series

Private acreage by owner locality. **The `local` tier is not comparable across
2009** — it needs the parcel's situs city, and `PROP_CITY` coverage collapses
from 82.8% to 40.3% in that vintage, which is why `local` reads 17.8% (2003),
2.4% (2010), 5.1% (2026). That is a coverage artifact.

Collapsed to the three tiers that rely only on the owner-city-to-county map:

| snapshot | in the parcel's county | elsewhere in Montana | out of state |
|---|--:|--:|--:|
| 2003-12-22 | 50.0% | 38.1% | 9.2% |
| 2010-10-13 | 48.1% | 41.5% | 9.9% |
| 2016-01-12 | 47.0% | 41.8% | 10.2% |
| 2021-12-31 | 47.0% | 41.3% | 11.5% |
| 2026-09-04 | 47.2% | 41.1% | 11.5% |

Stable, with a slow drift of about three points from in-county to out-of-state
over 23 years.

## Owner legal form, 2026

| class | parcels | share |
|---|--:|--:|
| individual | 528,773 | 59.6% |
| private entity | 171,401 | 19.3% |
| federal | 77,724 | 8.8% |
| trust / estate | 61,601 | 6.9% |
| state | 17,908 | 2.0% |
| local government | 13,651 | 1.5% |
| tribal | 7,960 | 0.9% |
| institution | 4,969 | 0.6% |
| indeterminate | 3,137 | 0.4% |

Public acreage 36.50M, private 54.12M. Remember the tribal figure is a **floor**
(recall 0.41) — see `ownerclass.py`.
