# What the pipeline says

All figures come from the stage-6 fact tables. Denominators are stated because
the source cannot support some of the distinctions one might want -- see
`FINDINGS.md` section 2. Comparisons use only county-intervals that clear the
coverage gate, and the comparable series begins in 2008 (`INTERVALS.md`).

## 1. Where is subdivision occurring, and at what rate?

Name-corroborated subdivision events and new lots per year, averaged over
comparable intervals from 2008. Townships, by PLSS label:

| township | new lots/yr | new blocks/yr | name-corroborated/yr |
|---|--:|--:|--:|
| 13N 19W | 82.0 | 24.0 | 78.5 |
| 1S 25E | 74.3 | 95.7 | 69.1 |
| 2S 5E | 72.5 | 189.9 | 121.0 |
| 31N 22W | 72.5 | 18.5 | 67.8 |
| 29N 21W | 69.2 | 51.8 | 57.8 |
| 28N 21W | 64.5 | 12.9 | 39.5 |
| 10N 3W | 60.7 | 44.7 | 33.5 |
| 28N 22W | 59.4 | 86.4 | 35.7 |
| 1N 26E | 58.8 | 48.8 | 50.2 |
| 30N 20W | 52.9 | 44.5 | 23.8 |
| 1S 26E | 42.7 | 21.7 | 50.2 |
| 30N 22W | 41.1 | 29.9 | 26.9 |

By county:

| county | new lots/yr |
|---|--:|
| Flathead | 791 |
| Lewis and Clark | 328 |
| Yellowstone | 294 |
| Gallatin | 286 |
| Missoula | 264 |
| Ravalli | 186 |
| Lake | 165 |
| Madison | 145 |
| Lincoln | 140 |
| Cascade | 115 |

## 2. How has owner mailing-state composition changed?

It has barely moved. Out-of-state ownership sits in a band roughly 10-12% of
parcels for the whole period, and the apparent early rise is mostly the
`unknown` share shrinking as the data improved:

| snapshot | Montana | out-of-state | unknown |
|---|--:|--:|--:|
| 2003-12-22 | 86.27% | 10.24% | 3.49% |
| 2006-07-14 | 87.27% | 10.99% | 1.74% |
| 2010-10-13 | 87.12% | 11.54% | 1.33% |
| 2016-01-12 | 86.98% | 11.76% | 1.26% |
| 2021-12-31 | 87.29% | 11.66% | 1.05% |
| 2026-09-04 | 87.84% | 11.52% | 0.64% |

This is the finding most likely to be misreported. There is **no large shift**
in who owns Montana by mailing address over 23 years.

## 3. How much out-of-state ownership is from California?

California is consistently the largest single out-of-state origin -- roughly
double the next -- but **its share has been falling for two decades**:

| snapshot | CA parcels | % of all parcels | % of out-of-state |
|---|--:|--:|--:|
| 2003-12-22 | 11,793 | 1.61% | 15.74% |
| 2006-07-14 | 14,206 | 1.82% | 16.61% |
| 2010-10-13 | 16,034 | 1.94% | 16.76% |
| 2016-01-12 | 14,982 | 1.77% | 15.09% |
| 2021-12-31 | 14,937 | 1.72% | 14.76% |
| 2026-09-04 | 13,733 | 1.55% | 13.44% |

The *stock* declines while *transfers* came in two waves (peaking near +997/yr
net in 2005 and +809/yr in 2020-21), which is consistent: the 2021 wave was
large enough to notice but not large enough to reverse a long erosion. And it
was not California-specific -- every destination surged that year, in-state
Montana included. See `INTERVALS.md`.

## 4. Fragmentation: is large-parcel land breaking up?

Yes, slowly and steadily. Share of total mapped acreage by parcel-size class:

| snapshot | <1 | 1-5 | 5-20 | 20-40 | 40-160 | 160-640 | >640 |
|---|--:|--:|--:|--:|--:|--:|--:|
| 2003-12-22 | 0.10 | 0.21 | 0.83 | 1.51 | 9.75 | 67.09 | 20.51 |
| 2010-10-13 | 0.10 | 0.26 | 0.96 | 1.62 | 9.68 | 67.33 | 20.05 |
| 2016-01-12 | 0.10 | 0.27 | 0.98 | 1.66 | 9.81 | 67.29 | 19.89 |
| 2021-12-31 | 0.11 | 0.28 | 1.00 | 1.70 | 9.91 | 67.22 | 19.78 |
| 2026-09-04 | 0.11 | 0.29 | 1.02 | 1.74 | 9.98 | 67.16 | 19.69 |

Acreage in parcels under 40 acres rises from **2.65%** to
**3.16%** of the state, while acreage in parcels over 640 acres falls
from **20.51%** to **19.69%**. Over 23 years that is roughly
**0.47 million acres** moving into small holdings -- a real
trend, and a slow one. Anyone expecting a dramatic collapse of large holdings
will not find it here.

## What is not answered yet

**Which cities.** Census places and the inside-limits / 1-mile / 5-mile ring
analysis are v2. The pipeline has what it needs: DOR's own situs city field
covers 40-83% of parcels depending on era (`FINDINGS.md` section 9), to be
combined with a quarter-section place join for the rest.

**Owner legal form** (individual / entity / government / trust) is v2, with
ground truth only for 2002-2011.
