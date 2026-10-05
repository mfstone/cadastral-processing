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
- **Mixing condo units into land fragmentation.** See item 9.
- **Owner-origin analysis without legal form.** See item 3 — Washington DC.
- **A single "subdivision" number.** Events are inferred; the confidence tiers
  and the `first_mapping` exclusion are what make the figure defensible, and a
  headline that drops them is not the same claim.
