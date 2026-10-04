# The 28-interval review

Generated from `data/events/qa_intervals.json`. This is the plan's gate: every
interval is inspected for discontinuity **before** any aggregation is published.
Rates are annualised on the real day count, never on an assumed year.

## What the scan found

Six intervals are flagged, and **all six fall in 2003-2007** -- the era when MSL
was still completing coverage. Nothing after 2007-07-26 trips a flag.

| interval | flag |
|---|---|
| 2003-12-22 → 2004-07-16 | `first_mapping` 34% of creations |
| 2004-07-16 → 2005-02-01 | acres +4.97%, `first_mapping` 30% of creations |
| 2005-02-01 → 2005-07-21 | `first_mapping` 32% of creations |
| 2005-07-21 → 2006-01-27 | acres -3.26% |
| 2006-01-27 → 2006-07-14 | `first_mapping` 31% of creations |
| 2006-07-14 → 2007-01-23 | `first_mapping` 42% of creations |

`first_mapping` -- a parcel appearing in a quarter-section that held none at *t* --
is a coverage artifact, not an event. Its share of creations falls from **42%**
(2006-07 → 2007-01) to **4.7-11.8%** from 2008 onward, and total mapped acreage
settles from ±5% swings to ±0.1%. So the comparable creation series begins around
2008; earlier intervals publish only behind the coverage mask.

**Area conservation holds in all 28 intervals**: the median quarter-section acreage
ratio is exactly 1.0 every time. That is the independent check that the classifier
is seeing real division of land rather than data churn.

## The series

| interval | days | parcels | created/yr | lots/yr | `first_map` % | subdiv/yr | owner chg %/yr | transfers | addr-only | net CA/yr | merges |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 2003-12-22 → 2004-07-16 | 207 | 740,419 | 42,063 | 21,722 | 34.3 | 2,472 | 7.935 | 4,081 | 2,695 | +134 | 705 |
| 2004-07-16 → 2005-02-01 | 200 | 761,679 | 45,407 | 9,164 | 30.4 | 11,556 | 9.185 | 6,015 | 4,056 | +398 | 443 |
| 2005-02-01 → 2005-07-21 | 170 | 769,168 | 26,283 | 9,673 | 32.2 | 2,462 | 11.728 | 6,623 | 3,484 | +997 | 364 |
| 2005-07-21 → 2006-01-27 | 190 | 773,300 | 15,998 | 7,597 | 17.3 | 2,760 | 8.355 | 6,254 | 3,725 | +913 | 321 |
| 2006-01-27 → 2006-07-14 | 168 | 778,538 | 21,174 | 9,574 | 31.3 | 878 | 15.255 | 6,183 | 3,183 | +778 | 213 |
| 2006-07-14 → 2007-01-23 | 193 | 787,183 | 21,236 | 6,857 | 41.6 | 2,627 | 16.33 | 6,164 | 4,312 | +511 | 394 |
| 2007-01-23 → 2007-07-26 | 184 | 804,805 | 40,365 | 9,672 | 16.6 | 11,937 | 9.131 | 4,972 | 3,599 | +236 | 697 |
| 2007-07-26 → 2008-01-24 | 182 | 809,468 | 13,221 | 5,663 | 9.4 | 2,629 | 7.491 | 4,588 | 3,766 | +345 | 362 |
| 2008-01-24 → 2009-02-22 | 395 | 816,496 | 9,677 | 3,566 | 7.7 | 293 | 18.781 | 7,511 | 6,510 | +16 | 495 |
| 2009-02-22 → 2009-07-05 | 133 | 821,322 | 22,035 | 9,061 | 8.6 | 1,538 | 13.27 | 4,451 | 2,330 | -162 | 487 |
| 2009-07-05 → 2010-01-26 | 205 | 824,919 | 9,854 | 4,032 | 10.9 | 155 | 5.171 | 3,161 | 7,354 | +46 | 525 |
| 2010-01-26 → 2010-10-13 | 260 | 828,566 | 8,390 | 3,929 | 8.9 | 344 | 9.014 | 7,625 | 3,740 | -271 | 729 |
| 2010-10-13 → 2011-07-14 | 274 | 831,582 | 9,549 | 4,476 | 5.5 | 928 | 6.82 | 7,026 | 5,743 | -37 | 866 |
| 2011-07-14 → 2013-01-09 | 545 | 835,157 | 8,156 | 4,001 | 6.5 | 3,765 | 11.371 | 14,236 | 8,240 | -246 | 1,348 |
| 2013-01-09 → 2013-12-09 | 334 | 837,481 | 4,814 | 2,485 | 11.8 | 1,455 | 7.977 | 11,054 | 6,841 | -58 | 492 |
| 2013-12-09 → 2014-12-10 | 366 | 840,274 | 6,879 | 3,058 | 6.8 | 1,221 | 5.543 | 8,308 | 6,693 | -199 | 590 |
| 2014-12-10 → 2016-01-12 | 398 | 844,130 | 6,297 | 3,029 | 5.5 | 2,425 | 8.02 | 11,705 | 7,898 | -118 | 667 |
| 2016-01-12 → 2017-01-30 | 384 | 847,547 | 10,771 | 6,079 | 6.5 | 3,186 | 6.491 | 9,674 | 5,894 | -85 | 790 |
| 2017-01-30 → 2018-01-10 | 345 | 851,064 | 6,679 | 3,310 | 7.5 | 2,763 | 7.532 | 10,074 | 7,917 | -3 | 724 |
| 2018-01-10 → 2018-12-18 | 342 | 854,099 | 4,691 | 2,131 | 4.7 | 788 | 5.44 | 7,844 | 5,003 | +38 | 470 |
| 2018-12-18 → 2019-12-31 | 378 | 860,279 | 7,583 | 2,654 | 5.2 | 3,717 | 8.207 | 12,919 | 6,524 | +190 | 496 |
| 2019-12-31 → 2020-12-31 | 366 | 863,398 | 4,581 | 2,452 | 4.7 | 1,004 | 6.061 | 9,954 | 6,015 | +29 | 371 |
| 2020-12-31 → 2021-12-31 | 365 | 868,232 | 6,457 | 3,382 | 4.8 | 1,209 | 8.621 | 17,121 | 6,265 | +809 | 456 |
| 2021-12-31 → 2022-12-31 | 365 | 873,539 | 6,709 | 3,268 | 11.2 | 1,497 | 8.209 | 14,805 | 5,744 | +511 | 347 |
| 2022-12-31 → 2023-12-31 | 365 | 878,746 | 7,095 | 2,857 | 5.2 | 1,573 | 6.411 | 10,111 | 6,968 | +105 | 413 |
| 2023-12-31 → 2024-12-31 | 366 | 882,041 | 5,009 | 2,434 | 5.7 | 1,719 | 6.197 | 9,735 | 6,377 | +21 | 534 |
| 2024-12-31 → 2025-12-31 | 365 | 884,233 | 4,423 | 2,816 | 5.3 | 1,562 | 6.315 | 9,269 | 6,007 | -7 | 736 |
| 2025-12-31 → 2026-09-04 | 247 | 887,124 | 5,488 | 3,753 | 6.3 | 2,544 | 8.512 | 8,478 | 3,074 | -228 | 228 |

## Three findings worth stating carefully

**Parcel creation is falling.** Past the coverage era, creations run ~9,500/yr around
2010 and ~4,400-7,100/yr through the 2020s, against 42,000/yr in 2004 when the dataset
was still filling in. The decline is real, but the early numbers are not comparable to
the late ones and must not be charted as one continuous line without the mask.

**The California story is two waves, not a trend.** Net CA-bound transfers peak near
**+997/yr in 2005**, go neutral or negative through 2009-2019, spike to **+809/yr in
2020-21** and +511/yr in 2021-22, then return to zero and turn negative by 2026.
There is no secular rise.

**And the 2020-21 spike is not California-specific.** Transfers to every destination
surged in that interval -- CA 811 → 1,947, WA 577 → 1,663, TX 377 → 1,203, ID 182 →
393 -- and in-state MT transfers rose too, 3,824 → 6,094. It was a general
transaction-volume surge in which out-of-state transfers grew proportionally more than
in-state ones. California is consistently the largest single out-of-state destination,
roughly double the next (Washington), but it did not behave uniquely. Reporting
"Californians bought Montana in 2021" would misread a volume surge as a California
phenomenon.

## Still to resolve (Tier 2 diagnostics)

- **Owner-change rate is noisy early**: 18.8%/yr (2008-2009) and 16.3%/yr (2006-2007)
  against 5.4-8.6%/yr from 2013. Check against the normalizer before publishing any
  turnover claim.
- **`GA` records 1,182 transfers in 2019-12 → 2020-12** against 86-323 in every
  neighbouring interval. Almost certainly an artifact; unexplained.
- **`address_change_only` exceeds transfers in 2009-07 → 2010-01** (7,354 vs 3,161) --
  the interval following the vintage whose value block is dead.
- **9,023 resurrected geocodes (0.93% of 974,535)** from DOR reissuing retired lot
  numbers, currently counted as creations. Decide whether to exclude.
