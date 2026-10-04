# Step 0 probe report

30 snapshots probed. Read time total: 289s.

## Counts and the accounting identity

`rows == blank + quarantined + valid` must hold for every snapshot.

| date | era | cont | rows | blank | quarantined | valid rows | valid parcels | dup rows | identity | read |
|---|---|---|---|---|---|---|---|---|---|---|
| 2002-12-20 | A | shp | 508,649 | 6,724 | 262 | 501,663 | 495,822 | 5,841 | OK | 5s |
| 2003-12-22 | A | shp | 801,412 | 7,502 | 17,342 | 776,568 | 731,286 | 45,282 | OK | 8s |
| 2004-07-16 | A | shp | 833,537 | 7,375 | 20,314 | 805,848 | 740,420 | 65,428 | OK | 9s |
| 2005-02-01 | A | shp | 871,576 | 7,881 | 18,329 | 845,366 | 761,680 | 83,686 | OK | 9s |
| 2005-07-21 | A | shp | 864,427 | 7,711 | 17,713 | 839,003 | 769,169 | 69,834 | OK | 9s |
| 2006-01-27 | A | shp | 871,278 | 11,142 | 16,704 | 843,432 | 773,301 | 70,131 | OK | 10s |
| 2006-07-14 | A | shp | 877,722 | 11,743 | 16,630 | 849,349 | 778,539 | 70,810 | OK | 9s |
| 2007-01-23 | A | shp | 889,001 | 12,154 | 16,392 | 860,455 | 787,184 | 73,271 | OK | 9s |
| 2007-07-26 | A | shp | 910,585 | 12,371 | 16,747 | 881,467 | 804,806 | 76,661 | OK | 10s |
| 2008-01-24 | A | shp | 910,260 | 8,574 | 15,412 | 886,274 | 809,469 | 76,805 | OK | 9s |
| 2009-02-22 | A | shp | 903,061 | 10,501 | 15,845 | 876,715 | 816,497 | 60,218 | OK | 9s |
| 2009-07-05 | A | shp | 908,662 | 11,381 | 16,330 | 880,951 | 821,323 | 59,628 | OK | 10s |
| 2010-01-26 | A | shp | 948,129 | 11,484 | 19,718 | 916,927 | 824,919 | 92,008 | OK | 10s |
| 2010-10-13 | A | shp | 951,957 | 12,733 | 18,157 | 921,067 | 828,566 | 92,501 | OK | 11s |
| 2011-07-14 | A | shp | 954,745 | 23,870 | 6,064 | 924,811 | 831,582 | 93,229 | OK | 10s |
| 2013-01-09 | A | shp | 917,207 | 24,952 | 1,084 | 891,171 | 835,157 | 56,014 | OK | 10s |
| 2013-12-09 | A | shp | 918,812 | 24,715 | 222 | 893,875 | 837,481 | 56,394 | OK | 11s |
| 2014-12-10 | A | shp | 921,208 | 24,782 | 254 | 896,172 | 840,274 | 55,898 | OK | 10s |
| 2016-01-12 | A | shp | 925,674 | 26,931 | 231 | 898,512 | 844,130 | 54,382 | OK | 10s |
| 2017-01-30 | B | gdb | 932,164 | 26,678 | 4,044 | 901,442 | 847,547 | 53,895 | OK | 11s |
| 2018-01-10 | B | gdb | 932,986 | 30,246 | 192 | 902,548 | 851,064 | 51,484 | OK | 10s |
| 2018-12-18 | B | gdb | 938,857 | 31,199 | 217 | 907,441 | 854,099 | 53,342 | OK | 10s |
| 2019-12-31 | B | gdb | 937,257 | 30,197 | 186 | 906,874 | 860,279 | 46,595 | OK | 10s |
| 2020-12-31 | B | gdb | 928,190 | 30,917 | 109 | 897,164 | 863,398 | 33,766 | OK | 10s |
| 2021-12-31 | C | gdb | 904,459 | 31,571 | 93 | 872,795 | 868,232 | 4,563 | OK | 10s |
| 2022-12-31 | C | gdb | 908,857 | 30,675 | 93 | 878,089 | 873,539 | 4,550 | OK | 10s |
| 2023-12-31 | C | gdb | 914,136 | 30,881 | 64 | 883,191 | 878,746 | 4,445 | OK | 10s |
| 2024-12-31 | C | gdb | 917,575 | 31,068 | 12 | 886,495 | 882,041 | 4,454 | OK | 10s |
| 2025-12-31 | C | gdb | 915,580 | 31,031 | 17 | 884,532 | 884,233 | 299 | OK | 10s |
| 2026-09-04 | D | shp | 921,301 | 34,037 | 140 | 887,124 | 887,124 | 0 | OK | 13s |

## Q1 Why does PARCELID repeat?

The de-dup rule turns on this. *Differing* owner names mean a parcel-to-owner join whose collapse would destroy co-ownership; *identical* names with differing area mean exploded multipart geometry, where the parts must be summed.

| date | dup parcels | max rows/parcel | owner differs | owner identical | % differ | area differs | verdict |
|---|---|---|---|---|---|---|---|
| 2002-12-20 | 4,640 | 102 | 0 | 4,640 | 0.0 | 4,612 | **exploded_geometry** |
| 2003-12-22 | 25,200 | 199 | 28 | 25,172 | 0.11 | 24,980 | **exploded_geometry** |
| 2004-07-16 | 30,581 | 841 | 4 | 30,577 | 0.01 | 0 | **exploded_geometry** |
| 2005-02-01 | 51,794 | 838 | 45 | 51,749 | 0.09 | 29,779 | **exploded_geometry** |
| 2005-07-21 | 38,690 | 837 | 1 | 38,689 | 0.0 | 29,460 | **exploded_geometry** |
| 2006-01-27 | 34,115 | 838 | 56 | 34,059 | 0.16 | 33,434 | **exploded_geometry** |
| 2006-07-14 | 33,769 | 838 | 2 | 33,767 | 0.01 | 33,526 | **exploded_geometry** |
| 2007-01-23 | 33,974 | 838 | 43 | 33,931 | 0.13 | 33,181 | **exploded_geometry** |
| 2007-07-26 | 37,088 | 838 | 0 | 37,088 | 0.0 | 34,558 | **exploded_geometry** |
| 2008-01-24 | 38,098 | 838 | 13 | 38,085 | 0.03 | 35,808 | **exploded_geometry** |
| 2009-02-22 | 32,583 | 352 | 10 | 32,573 | 0.03 | 32,401 | **exploded_geometry** |
| 2009-07-05 | 32,445 | 352 | 1 | 32,444 | 0.0 | 32,282 | **exploded_geometry** |
| 2010-01-26 | 49,264 | 1,849 | 0 | 49,264 | 0.0 | 48,663 | **exploded_geometry** |
| 2010-10-13 | 49,620 | 1,831 | 0 | 49,620 | 0.0 | 48,977 | **exploded_geometry** |
| 2011-07-14 | 50,368 | 1,745 | 1 | 50,367 | 0.0 | 49,679 | **exploded_geometry** |
| 2013-01-09 | 30,919 | 352 | 0 | 30,919 | 0.0 | 30,718 | **exploded_geometry** |
| 2013-12-09 | 30,985 | 352 | 0 | 30,985 | 0.0 | 30,776 | **exploded_geometry** |
| 2014-12-10 | 30,737 | 352 | 0 | 30,737 | 0.0 | 30,531 | **exploded_geometry** |
| 2016-01-12 | 30,155 | 352 | 0 | 30,155 | 0.0 | 26,367 | **exploded_geometry** |
| 2017-01-30 | 29,710 | 352 | 0 | 29,710 | 0.0 | 25,900 | **exploded_geometry** |
| 2018-01-10 | 28,669 | 352 | 0 | 28,669 | 0.0 | 24,976 | **exploded_geometry** |
| 2018-12-18 | 29,545 | 352 | 0 | 29,545 | 0.0 | 25,804 | **exploded_geometry** |
| 2019-12-31 | 26,668 | 266 | 0 | 26,668 | 0.0 | 23,706 | **exploded_geometry** |
| 2020-12-31 | 21,144 | 51 | 0 | 21,144 | 0.0 | 20,046 | **exploded_geometry** |
| 2021-12-31 | 3,334 | 16 | 0 | 3,334 | 0.0 | 3,226 | **exploded_geometry** |
| 2022-12-31 | 3,310 | 16 | 0 | 3,310 | 0.0 | 3,204 | **exploded_geometry** |
| 2023-12-31 | 3,227 | 16 | 0 | 3,227 | 0.0 | 3,117 | **exploded_geometry** |
| 2024-12-31 | 3,225 | 16 | 0 | 3,225 | 0.0 | 3,121 | **exploded_geometry** |
| 2025-12-31 | 299 | 2 | 0 | 299 | 0.0 | 0 | **exploded_geometry** |
| 2026-09-04 | 0 | 1 | - | - | - | - | **no duplicates** |

## The area aggregation rule

If duplicates are exploded geometry then SUM is faithful and MAX drops the other parts. The gap is era-correlated, so choosing MAX would publish a spurious acreage trend.

| date | parcels | SUM Macres | MAX Macres | MAX loses (Macres) | MAX loses % |
|---|---|---|---|---|---|
| 2002-12-20 | 495,822 | 79.6995 | 79.5923 | 0.1072 | 0.1345 |
| 2003-12-22 | 731,286 | 86.0891 | 85.76 | 0.3291 | 0.3822 |
| 2004-07-16 | 740,420 | 0.0 | 0.0 | 0.0 | None |
| 2005-02-01 | 761,680 | 91.4328 | 88.0686 | 3.3642 | 3.6794 |
| 2005-07-21 | 769,169 | 92.0795 | 88.7277 | 3.3518 | 3.6401 |
| 2006-01-27 | 773,301 | 89.079 | 88.6108 | 0.4683 | 0.5257 |
| 2006-07-14 | 778,539 | 89.6229 | 89.1502 | 0.4727 | 0.5275 |
| 2007-01-23 | 787,184 | 90.3647 | 89.8464 | 0.5182 | 0.5735 |
| 2007-07-26 | 804,806 | 91.0391 | 89.9382 | 1.1009 | 1.2092 |
| 2008-01-24 | 809,469 | 90.8842 | 89.9852 | 0.8991 | 0.9892 |
| 2009-02-22 | 816,497 | 90.4123 | 89.9945 | 0.4177 | 0.462 |
| 2009-07-05 | 821,323 | 90.4133 | 90.0093 | 0.4039 | 0.4468 |
| 2010-01-26 | 824,919 | 90.42 | 90.0009 | 0.4191 | 0.4635 |
| 2010-10-13 | 828,566 | 90.4733 | 90.059 | 0.4143 | 0.458 |
| 2011-07-14 | 831,582 | 90.4685 | 90.0598 | 0.4087 | 0.4518 |
| 2013-01-09 | 835,157 | 90.4594 | 90.1129 | 0.3465 | 0.3831 |
| 2013-12-09 | 837,481 | 90.5214 | 90.1751 | 0.3464 | 0.3827 |
| 2014-12-10 | 840,274 | 90.5183 | 90.1762 | 0.3421 | 0.3779 |
| 2016-01-12 | 844,130 | 90.5031 | 90.1706 | 0.3326 | 0.3675 |
| 2017-01-30 | 847,547 | 90.5052 | 90.191 | 0.3142 | 0.3472 |
| 2018-01-10 | 851,064 | 90.5018 | 90.2427 | 0.2591 | 0.2863 |
| 2018-12-18 | 854,099 | 90.4934 | 90.1904 | 0.303 | 0.3349 |
| 2019-12-31 | 860,279 | 90.4944 | 90.2943 | 0.2 | 0.2211 |
| 2020-12-31 | 863,398 | 90.4888 | 90.3187 | 0.1701 | 0.188 |
| 2021-12-31 | 868,232 | 90.4881 | 90.4312 | 0.0569 | 0.0629 |
| 2022-12-31 | 873,539 | 90.5983 | 90.5412 | 0.0571 | 0.063 |
| 2023-12-31 | 878,746 | 90.6552 | 90.5981 | 0.0571 | 0.063 |
| 2024-12-31 | 882,041 | 90.6245 | 90.5678 | 0.0568 | 0.0626 |
| 2025-12-31 | 884,233 | 90.6941 | 90.6239 | 0.0702 | 0.0774 |
| 2026-09-04 | 887,124 | 90.6213 | 90.6213 | 0.0 | 0.0 |

## Q2 Geocode structure

`locatable` = first 9 chars parse as county(2) township(4) section(2) quarter(1) with county 1-56, section 1-36, quarter 0-4.

| date | length histogram | % locatable | twp codes | sections | qtr-sections | blocks | non-zero unit | codes spanning counties |
|---|---|---|---|---|---|---|---|---|
| 2002-12-20 | 17:501,664,3:254,9:7 | 99.9494 | 4,039 | 127,822 | 232,647 | 290,275 | 28,949 | 6 |
| 2003-12-22 | 1:6,10:2,11:245 | 98.092 | 4,438 | 138,346 | 252,818 | 334,484 | 38,009 | 16 |
| 2004-07-16 | 1:22,10:2,11:505 | 97.8136 | 4,507 | 140,076 | 255,541 | 338,361 | 39,619 | 20 |
| 2005-02-01 | 1:6,10:2,11:372 | 98.1388 | 4,573 | 142,405 | 259,173 | 343,850 | 53,322 | 20 |
| 2005-07-21 | 1:6,11:197,12:1 | 98.1905 | 4,603 | 143,415 | 260,782 | 346,502 | 43,952 | 20 |
| 2006-01-27 | 1:6,11:52,12:1 | 98.3141 | 4,607 | 143,464 | 261,097 | 347,389 | 42,366 | 23 |
| 2006-07-14 | 1:6,11:77,12:1 | 98.3351 | 4,636 | 144,346 | 262,384 | 349,127 | 39,285 | 21 |
| 2007-01-23 | 1:6,11:29,12:1 | 98.3591 | 4,666 | 145,429 | 264,127 | 351,696 | 38,718 | 20 |
| 2007-07-26 | 1:34,11:10,12:1 | 98.3808 | 4,673 | 145,602 | 264,676 | 353,275 | 45,708 | 22 |
| 2008-01-24 | 1:34,11:106,12:1 | 98.5327 | 4,672 | 145,612 | 264,848 | 354,457 | 48,058 | 22 |
| 2009-02-22 | 1:571,11:35,13:4 | 98.4577 | 4,671 | 145,607 | 265,179 | 354,883 | 46,368 | 16 |
| 2009-07-05 | 1:603,11:9,13:7 | 98.4112 | 4,672 | 145,611 | 265,304 | 355,326 | 46,963 | 18 |
| 2010-01-26 | 1:684,11:7,13:9 | 98.4635 | 4,673 | 145,631 | 265,550 | 355,800 | 52,950 | 20 |
| 2010-10-13 | 1:685,11:10,12:1 | 98.6354 | 4,674 | 145,695 | 265,788 | 356,370 | 53,059 | 20 |
| 2011-07-14 | 1:685,11:11,12:1 | 99.9132 | 4,672 | 145,680 | 265,912 | 356,740 | 54,860 | 17 |
| 2013-01-09 | 1:11,11:11,13:7 | 99.9891 | 4,673 | 145,682 | 266,237 | 357,586 | 46,912 | 18 |
| 2013-12-09 | 1:12,11:5,13:7 | 99.9905 | 4,674 | 145,793 | 266,346 | 357,991 | 46,891 | 18 |
| 2014-12-10 | 1:13,10:2,11:1 | 99.9886 | 4,683 | 145,813 | 266,535 | 358,485 | 46,516 | 23 |
| 2016-01-12 | 1:15,11:1,13:1 | 99.9902 | 4,682 | 145,807 | 266,755 | 359,113 | 46,702 | 25 |
| 2017-01-30 | 1:10,10:14,11:15 | 99.5681 | 4,676 | 145,798 | 267,044 | 360,034 | 43,227 | 23 |
| 2018-01-10 | 1:2,11:2,16:3 | 99.9914 | 4,675 | 145,803 | 267,208 | 360,468 | 44,283 | 19 |
| 2018-12-18 | 1:6,11:4,13:2 | 99.989 | 4,675 | 145,805 | 267,315 | 360,749 | 45,129 | 19 |
| 2019-12-31 | 11:3,13:2,14:7 | 99.9918 | 4,674 | 145,818 | 267,489 | 361,168 | 48,219 | 20 |
| 2020-12-31 | 17:897,273 | 99.9998 | 4,676 | 145,819 | 267,606 | 361,540 | 48,605 | 19 |
| 2021-12-31 | 17:872,888 | 100.0 | 4,675 | 145,819 | 267,776 | 362,070 | 49,164 | 23 |
| 2022-12-31 | 17:878,182 | 100.0 | 4,675 | 145,972 | 268,172 | 362,815 | 50,489 | 23 |
| 2023-12-31 | 17:883,255 | 100.0 | 4,676 | 146,020 | 268,393 | 363,293 | 52,270 | 22 |
| 2024-12-31 | 17:886,507 | 100.0 | 4,676 | 145,997 | 268,527 | 363,679 | 52,487 | 20 |
| 2025-12-31 | 17:884,549 | 99.9998 | 4,670 | 145,985 | 268,616 | 363,911 | 51,751 | 17 |
| 2026-09-04 | 17:887,264 | 99.9859 | 4,670 | 145,976 | 268,695 | 364,042 | 52,178 | 15 |

## Q3 PLSS witness: does the row's own T/R/S agree with the geocode?

An independent check on the positional hypothesis, available in every era (`TRS` 2002-2011, `Township`/`Range`/`Section` 2013+). `minority rows` is the error budget a majority vote would reassign.

| date | source | TRS parse % | section agree % | codes | T/R pairs | ambiguous codes | minority rows | % minority | median dominant share |
|---|---|---|---|---|---|---|---|---|---|
| 2002-12-20 | TRS | 95.613 | 99.996 | 4,039 | 3,591 | 8 | 438 | 0.0873 | 0.9983 |
| 2003-12-22 | TRS | 97.834 | 99.988 | 4,438 | 3,912 | 11 | 554 | 0.0727 | 0.9988 |
| 2004-07-16 | TRS | 98.006 | 99.986 | 4,507 | 3,981 | 11 | 914 | 0.1147 | 0.9988 |
| 2005-02-01 | TRS | 98.33 | 99.987 | 4,573 | 4,035 | 12 | 555 | 0.0659 | 0.999 |
| 2005-07-21 | TRS | 98.006 | 99.987 | 4,603 | 4,069 | 11 | 426 | 0.0508 | 0.9988 |
| 2006-01-27 | TRS | 97.997 | 99.988 | 4,607 | 4,071 | 11 | 400 | 0.0473 | 0.9988 |
| 2006-07-14 | TRS | 97.979 | 99.99 | 4,636 | 4,095 | 10 | 555 | 0.0652 | 0.9987 |
| 2007-01-23 | TRS | 98.294 | 99.99 | 4,666 | 4,123 | 9 | 524 | 0.0608 | 0.9989 |
| 2007-07-26 | TRS | 98.267 | 99.99 | 4,673 | 4,131 | 9 | 622 | 0.0704 | 0.9989 |
| 2008-01-24 | TRS | 97.951 | 99.99 | 4,672 | 4,131 | 9 | 788 | 0.0889 | 0.9989 |
| 2009-02-22 | TRS | 97.848 | 99.974 | 4,671 | 4,131 | 23 | 1,917 | 0.2182 | 0.9989 |
| 2009-07-05 | TRS | 97.945 | 99.963 | 4,672 | 4,134 | 49 | 3,991 | 0.452 | 0.998 |
| 2010-01-26 | TRS | 97.103 | 99.959 | 4,673 | 4,134 | 60 | 5,855 | 0.6349 | 0.9979 |
| 2010-10-13 | TRS | 96.992 | 99.954 | 4,674 | 4,134 | 76 | 6,238 | 0.6734 | 0.9968 |
| 2011-07-14 | TRS | 97.451 | 99.949 | 4,672 | 4,136 | 102 | 7,335 | 0.7887 | 0.9975 |
| 2013-01-09 | Township/Range/Section | - | 99.941 | 4,663 | 4,813 | 597 | 4,059 | 0.4591 | 0.9904 |
| 2013-12-09 | Township/Range/Section | - | 99.932 | 4,664 | 4,850 | 626 | 4,391 | 0.4949 | 0.9898 |
| 2014-12-10 | Township/Range/Section | - | 99.929 | 4,663 | 4,873 | 649 | 4,529 | 0.5103 | 0.9895 |
| 2016-01-12 | Township/Range/Section | - | 99.912 | 4,662 | 4,929 | 697 | 5,109 | 0.5744 | 0.9892 |
| 2017-01-30 | Township/Range/Section | - | 99.895 | 4,663 | 4,714 | 580 | 4,271 | 0.4761 | 0.989 |
| 2018-01-10 | Township/Range/Section | - | 99.887 | 4,663 | 4,683 | 569 | 3,764 | 0.4187 | 0.9894 |
| 2018-12-18 | Township/Range/Section | - | 99.883 | 4,663 | 4,690 | 577 | 3,816 | 0.4234 | 0.9892 |
| 2019-12-31 | Township/Range/Section | - | 99.863 | 4,663 | 4,691 | 577 | 4,002 | 0.4431 | 0.989 |
| 2020-12-31 | Township/Range/Section | - | 99.857 | 4,663 | 4,674 | 571 | 3,715 | 0.4166 | 0.9891 |
| 2021-12-31 | Township/Range/Section | - | 99.855 | 4,663 | 4,682 | 584 | 3,738 | 0.4316 | 0.9896 |
| 2022-12-31 | Township/Range/Section | - | 99.842 | 4,663 | 4,614 | 552 | 1,918 | 0.2199 | 0.9902 |
| 2023-12-31 | Township/Range/Section | - | 99.826 | 4,664 | 4,169 | 256 | 679 | 0.0774 | 0.996 |
| 2024-12-31 | Township/Range/Section | - | 99.82 | 4,665 | 4,170 | 247 | 663 | 0.0752 | 0.996 |
| 2025-12-31 | Township/Range/Section | - | 99.814 | 4,665 | 4,171 | 250 | 682 | 0.0775 | 0.9959 |
| 2026-09-04 | Township/Range/Section | - | 99.808 | 4,665 | 4,170 | 248 | 753 | 0.0852 | 0.996 |

## Q4 Is there a parcel situs (site) city?

If the Department of Revenue already says which city a parcel is in, that beats a quarter-section majority join against TIGER places. `% differ` is against the owner's mailing city -- a high value confirms the field really is the parcel's own location.

| date | column | % non-blank | distinct | % differ from owner city | samples |
|---|---|---|---|---|---|
| 2002-12-20 | PROP_CITY | 73.34 | 345 | - | WISE RIVER, WISE RIVER |
| 2003-12-22 | PROP_CITY | 78.02 | 360 | 40.77 | BUTTE, BUTTE |
| 2004-07-16 | PROP_CITY | 79.06 | 360 | 40.68 | BILLINGS, BILLINGS |
| 2005-02-01 | PROP_CITY | 80.82 | 360 | 41.13 | BUTTE, MELROSE |
| 2005-07-21 | PROP_CITY | 81.13 | 360 | 41.11 | BUTTE, MELROSE |
| 2006-01-27 | PROP_CITY | 81.76 | 360 | 41.13 | MELROSE, MELROSE |
| 2006-07-14 | PROP_CITY | 81.87 | 360 | 41.38 | BUTTE, MELROSE |
| 2007-01-23 | PROP_CITY | 82.5 | 360 | 41.63 | MELROSE, MELROSE |
| 2007-07-26 | PROP_CITY | 82.73 | 360 | 41.48 | HARDIN, BIG TIMBER |
| 2008-01-24 | PROP_CITY | 82.78 | 360 | 41.68 | KALISPELL, KALISPELL |
| 2009-02-22 | PROP_CITY | 40.29 | 319 | 23.08 | VAUGHN, VAUGHN |
| 2009-07-05 | PROP_CITY | 40.87 | 321 | 23.55 | LAUREL, LAUREL |
| 2010-01-26 | PROP_CITY | 41.75 | 321 | 23.31 | FORT SHAW, GREAT FALLS |
| 2010-10-13 | PROP_CITY | 42.62 | 322 | 23.52 | WEST YELLOWSTONE, WEST YELLOWSTONE |
| 2011-07-14 | PROP_CITY | 43.42 | 325 | 23.92 | VAUGHN, VAUGHN |
| 2013-01-09 | CityStateZ | 49.0 | 4,731 | 26.15 | WISE RIVER, MT 59762, WISE RIVER, MT 59762 |
| 2013-12-09 | CityStateZ | 49.66 | 4,760 | 26.08 | WISE RIVER, MT 59762, WISE RIVER, MT 59762 |
| 2014-12-10 | CityStateZ | 49.78 | 4,701 | 25.88 | WISE RIVER, MT 59762, WISE RIVER, MT 59762 |
| 2016-01-12 | CityStateZ | 50.71 | 4,295 | 26.07 | WISE RIVER, MT 59762, WISE RIVER, MT 59762 |
| 2017-01-30 | CityStateZip | 51.25 | 4,288 | 25.73 | WISE RIVER, MT 59762, WISE RIVER, MT 59762 |
| 2018-01-10 | CityStateZip | 51.93 | 4,257 | 25.61 | WISE RIVER, MT 59762, WISE RIVER, MT 59762 |
| 2018-12-18 | CityStateZip | 52.11 | 4,281 | 25.52 | WISE RIVER, MT 59762, WISE RIVER, MT 59762 |
| 2019-12-31 | CityStateZip | 53.53 | 4,330 | 25.31 | WISDOM, MT 59761, WISE RIVER, MT 59762 |
| 2020-12-31 | CityStateZip | 53.5 | 4,307 | 25.17 | BOULDER, MT 59632, JEFFERSON CITY, MT 59638 |
| 2021-12-31 | CityStateZip | 52.84 | 4,295 | 24.5 | TROY, MT 59935, TROY, MT 59935 |
| 2022-12-31 | CityStateZip | 53.44 | 4,272 | 24.64 | TROY, MT 59935, TROY, MT 59935 |
| 2023-12-31 | CityStateZip | 53.92 | 4,273 | 24.68 | LIVINGSTON, MT 59047, LIVINGSTON, MT 59047 |
| 2024-12-31 | CityStateZip | 54.26 | 4,281 | 24.6 | LIBBY, MT 59923, LIBBY, MT 59923 |
| 2025-12-31 | CityStateZip | 54.84 | 4,219 | 24.47 | LIBBY, MT 59923, LIBBY, MT 59923 |
| 2026-09-04 | CityStateZ | 55.33 | 4,197 | 24.5 | LIBBY, MT 59923, LIBBY, MT 59923 |

## Q5 Area fields and owner mailing state

`TotalAcres` is agricultural acreage only in the early era, so the parcel-area field is per-era. Owner-state shares are over valid parcels, not raw rows.

| date | area field | total Macres | % TotalAcres zero | state mechanism | % valid state | % MT | % out-of-state | CA parcels |
|---|---|---|---|---|---|---|---|---|
| 2002-12-20 | area_sqm | 80.9565 | 54.98 | mail_state | 95.6879 | 84.462 | 11.226 | 8,633 |
| 2003-12-22 | area_sqm | 88.3028 | 66.53 | mailcity_s_fixed_width | 96.0956 | 85.752 | 10.344 | 12,836 |
| 2004-07-16 | area_sqm | 0.0 | - | mailcity_s_fixed_width | 96.9247 | 86.427 | 10.498 | 13,822 |
| 2005-02-01 | area_sqm | 93.5875 | 67.15 | mailcity_s_fixed_width | 97.8536 | 87.044 | 10.81 | 14,662 |
| 2005-07-21 | area_sqm | 94.1838 | 67.04 | mailcity_s_fixed_width | 97.8822 | 87.079 | 10.803 | 14,838 |
| 2006-01-27 | area_sqm | 91.1368 | 67.56 | mailcity_s_fixed_width | 98.1492 | 87.124 | 11.025 | 15,637 |
| 2006-07-14 | area_sqm | 91.5411 | 67.79 | mailcity_s_fixed_width | 98.1138 | 87.061 | 11.053 | 15,857 |
| 2007-01-23 | area_sqm | 92.2249 | 67.83 | mailcity_s_fixed_width | 98.4135 | 87.237 | 11.176 | 16,481 |
| 2007-07-26 | area_sqm | 93.0641 | 68.32 | mailcity_s_fixed_width | 98.3968 | 87.181 | 11.216 | 17,232 |
| 2008-01-24 | area_sqm | 92.768 | 68.28 | mailcity_s_fixed_width | 97.8151 | 86.63 | 11.185 | 17,398 |
| 2009-02-22 | area_sqm | 92.3251 | 18.43 | mailcity_s_fixed_width | 98.0624 | 86.718 | 11.345 | 17,359 |
| 2009-07-05 | area_sqm | 92.3234 | 48.25 | mailcity_s_fixed_width | 98.339 | 86.96 | 11.379 | 17,492 |
| 2010-01-26 | area_sqm | 92.331 | 12.15 | mailcity_s_fixed_width | 98.1226 | 86.767 | 11.355 | 18,223 |
| 2010-10-13 | area_sqm | 92.38 | 11.95 | mailcity_s_fixed_width | 98.296 | 86.759 | 11.537 | 18,172 |
| 2011-07-14 | area_sqm | 92.4044 | 11.54 | mailcity_s_fixed_width | 98.6735 | 86.975 | 11.699 | 18,482 |
| 2013-01-09 | area_sqm | 92.4053 | 11.04 | owner_state | 99.0852 | 86.992 | 12.093 | 17,711 |
| 2013-12-09 | area_sqm | 92.3892 | 10.6 | owner_state | 99.0513 | 86.976 | 12.075 | 17,519 |
| 2014-12-10 | area_sqm | 92.3845 | 10.79 | owner_state | 98.7996 | 86.753 | 12.046 | 17,224 |
| 2016-01-12 | gis_acres | 93.6941 | 8.34 | owner_state | 98.6943 | 86.675 | 12.019 | 16,674 |
| 2017-01-30 | gis_acres | 93.765 | 4.38 | owner_state | 99.1418 | 87.293 | 11.849 | 16,707 |
| 2018-01-10 | gis_acres | 93.7664 | 3.97 | owner_state | 99.2167 | 87.392 | 11.824 | 16,461 |
| 2018-12-18 | gis_acres | 93.7665 | 3.78 | owner_state | 98.9593 | 87.219 | 11.74 | 16,267 |
| 2019-12-31 | gis_acres | 93.7669 | 3.08 | owner_state | 99.2364 | 87.412 | 11.825 | 16,503 |
| 2020-12-31 | gis_acres | 93.7607 | 2.92 | owner_state | 99.0505 | 87.295 | 11.756 | 15,499 |
| 2021-12-31 | gis_acres | 93.7604 | 2.9 | owner_state | 98.924 | 87.209 | 11.715 | 15,031 |
| 2022-12-31 | gis_acres | 93.8607 | 2.59 | owner_state | 99.015 | 87.229 | 11.786 | 15,307 |
| 2023-12-31 | gis_acres | 93.8654 | 2.5 | owner_state | 99.0267 | 87.297 | 11.729 | 14,878 |
| 2024-12-31 | gis_acres | 93.8358 | 2.39 | owner_state | 99.1248 | 87.425 | 11.7 | 14,668 |
| 2025-12-31 | gis_acres | 93.9148 | 2.31 | owner_state | 99.2431 | 87.68 | 11.564 | 13,987 |
| 2026-09-04 | gis_acres | 93.8464 | 6.27 | owner_state | 99.361 | 87.842 | 11.519 | 13,733 |

## County presence

| date | mechanism | counties | missing from 1-56 | unexpected | % null-PID rows with county |
|---|---|---|---|---|---|
| 2002-12-20 | alpha COUNTYCODE | 51 | FL, GA, MS, SB, YE | none | 100.0 |
| 2003-12-22 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2004-07-16 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2005-02-01 | numeric COUNTYCD | 57 | none | 0 | 100.0 |
| 2005-07-21 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2006-01-27 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2006-07-14 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2007-01-23 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2007-07-26 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2008-01-24 | numeric COUNTYCD | 57 | none | 0 | 100.0 |
| 2009-02-22 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2009-07-05 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2010-01-26 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2010-10-13 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2011-07-14 | numeric COUNTYCD | 57 | none | 0 | 100.0 |
| 2013-01-09 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2013-12-09 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2014-12-10 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2016-01-12 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2017-01-30 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2018-01-10 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2018-12-18 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2019-12-31 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2020-12-31 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2021-12-31 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2022-12-31 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2023-12-31 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2024-12-31 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2025-12-31 | numeric COUNTYCD | 56 | none | none | 100.0 |
| 2026-09-04 | numeric COUNTYCD | 56 | none | none | 100.0 |

## Attribute availability

Which corroborating attributes exist in which era -- this decides which confidence tiers and which v2 features are reachable.

| date | subdiv % non-blank | subdiv distinct | COS % non-blank | COS distinct | % improvement value | OWNCLASS | RESPROPIND |
|---|---|---|---|---|---|---|---|
| 2002-12-20 | 28.97 | 4,992 | - | - | - | yes | - |
| 2003-12-22 | 40.8 | 12,596 | - | - | 34.18 | yes | - |
| 2004-07-16 | 41.95 | 12,600 | - | - | 44.14 | yes | - |
| 2005-02-01 | 42.94 | 13,597 | - | - | 42.66 | yes | - |
| 2005-07-21 | 42.84 | 13,805 | - | - | 44.57 | yes | - |
| 2006-01-27 | 43.43 | 14,066 | - | - | 43.58 | yes | - |
| 2006-07-14 | 43.39 | 14,204 | - | - | 45.48 | yes | - |
| 2007-01-23 | 43.84 | 14,794 | - | - | 43.66 | yes | - |
| 2007-07-26 | 44.37 | 15,603 | - | - | 46.05 | yes | - |
| 2008-01-24 | 44.26 | 15,856 | - | - | 44.77 | yes | - |
| 2009-02-22 | 41.53 | 15,593 | - | - | 46.4 | yes | - |
| 2009-07-05 | 41.44 | 15,578 | - | - | 0.0 | yes | - |
| 2010-01-26 | 42.32 | 15,565 | - | - | 47.08 | yes | - |
| 2010-10-13 | 42.71 | 15,646 | - | - | 47.29 | yes | - |
| 2011-07-14 | 43.32 | 15,866 | - | - | 47.8 | yes | - |
| 2013-01-09 | 45.55 | 20,280 | 9.1 | 32,098 | 47.21 | - | - |
| 2013-12-09 | 45.68 | 20,484 | 9.22 | 32,498 | 47.53 | - | - |
| 2014-12-10 | 45.61 | 20,677 | 9.26 | 32,683 | 47.74 | - | - |
| 2016-01-12 | 45.81 | 21,046 | 9.56 | 33,645 | 47.86 | - | - |
| 2017-01-30 | 45.88 | 21,514 | 9.73 | 34,314 | 48.04 | - | - |
| 2018-01-10 | 46.08 | 21,858 | 9.88 | 34,698 | 48.41 | - | - |
| 2018-12-18 | 45.37 | 21,719 | 9.9 | 34,785 | 48.99 | - | - |
| 2019-12-31 | 45.78 | 22,250 | 10.15 | 35,496 | 49.47 | - | - |
| 2020-12-31 | 45.19 | 22,442 | 10.33 | 35,672 | 49.76 | - | - |
| 2021-12-31 | 45.24 | 22,900 | 10.27 | 36,476 | 49.59 | - | - |
| 2022-12-31 | 45.44 | 23,222 | 10.49 | 37,287 | 50.1 | - | - |
| 2023-12-31 | 45.59 | 23,564 | 10.78 | 38,563 | 50.63 | - | - |
| 2024-12-31 | 45.79 | 23,884 | 10.98 | 39,508 | 50.89 | - | - |
| 2025-12-31 | 46.04 | 23,965 | 11.2 | 40,579 | 51.42 | - | - |
| 2026-09-04 | 46.05 | 24,265 | 11.35 | 41,568 | 51.56 | - | - |

## Unresolved probe fields per snapshot

| date | columns | n unresolved | unresolved |
|---|---|---|---|
| 2002-12-20 | 39 | 14 | county_code, county_name, owner_state, owner_city, owner_citystatezip, gis_acres, township, plss_range, plss_section, cert_survey, build_value, tax_year, rec_year, situs_citystatezip |
| 2003-12-22 | 39 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2004-07-16 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2005-02-01 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2005-07-21 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2006-01-27 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2006-07-14 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2007-01-23 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2007-07-26 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2008-01-24 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2009-02-22 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2009-07-05 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2010-01-26 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2010-10-13 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2011-07-14 | 40 | 14 | county_code_alpha, county_name, owner_state, owner_city, mail_state, mail_city, gis_acres, township, plss_range, plss_section, cert_survey, tax_year, card_no, situs_citystatezip |
| 2013-01-09 | 40 | 14 | county_code_alpha, county_name, owner_name_2, owner_citystatezip, mail_state, mail_city, gis_acres, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2013-12-09 | 40 | 14 | county_code_alpha, county_name, owner_name_2, owner_citystatezip, mail_state, mail_city, gis_acres, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2014-12-10 | 40 | 14 | county_code_alpha, county_name, owner_name_2, owner_citystatezip, mail_state, mail_city, gis_acres, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2016-01-12 | 38 | 14 | county_code_alpha, county_name, owner_name_2, owner_citystatezip, mail_state, mail_city, area_sqm, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2017-01-30 | 40 | 13 | county_code_alpha, county_name, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2018-01-10 | 40 | 13 | county_code_alpha, county_name, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2018-12-18 | 40 | 13 | county_code_alpha, county_name, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2019-12-31 | 41 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2020-12-31 | 43 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2021-12-31 | 43 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2022-12-31 | 43 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2023-12-31 | 43 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2024-12-31 | 43 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2025-12-31 | 43 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |
| 2026-09-04 | 43 | 12 | county_code_alpha, owner_name_2, owner_citystatezip, mail_state, mail_city, trs, owner_class, owner_gen_descrip, owner_class_code, rec_year, card_no, situs_city |

