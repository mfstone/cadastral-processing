"""The absentee gradient: how far the owner is from the land.

In-state versus out-of-state is too coarse for planning. A Bozeman parcel owned
from Billings is in-state and still absentee, and the distinction between an
owner down the road and one across the state is exactly what predicts
participation in local process.

Five ordered levels, built entirely from fields already in the parcel table:

====  ==============  ===============================================
code  level           test
====  ==============  ===============================================
0     local           owner mails to the parcel's own situs city
1     same_county     owner's city sits in the parcel's county
2     in_state        owner state is MT, but not the above
3     out_of_state    owner state is a valid non-MT state
4     unknown         no usable owner state
====  ==============  ===============================================

The city-to-county map is **derived from the data itself** rather than imported:
each situs city is assigned the county in which most of its parcels lie. The
situs city field is populated on only 57.5% of parcels (533 distinct values,
essentially Montana's place list), so `local` is decidable for a subset while
`same_county` falls back to the owner city's own county.

This is a **mailing address**, never residence. It cannot separate an
owner-occupier from a local landlord, and a property manager's or trustee's
address reads as the owner's.

**The `local` level is not comparable across 2009.** It requires the parcel's
situs city, and `PROP_CITY` coverage collapses from 82.8% to 40.3% in the
2009-02-22 vintage. Measured on private acreage, `local` reads 17.8% (2003),
2.4% (2010), 5.1% (2026) -- a coverage artifact, not a change in who owns
Montana. Use :func:`collapse_in_county` for any time series: `local` and
`same_county` combined rely only on the owner-city-to-county map, and that
series is stable at 50.0% / 48.1% / 47.0% / 47.0% / 47.2% across the same dates.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LEVELS = ["local", "same_county", "in_state", "out_of_state", "unknown"]
N_LEVELS = len(LEVELS)


def city_county_map(frames: list[pd.DataFrame]) -> pd.Series:
    """Dominant county per situs city, pooled over the snapshots supplied.

    Pooling across vintages means a city whose parcels are sparsely coded in one
    year still resolves. Ties go to the more populous county by parcel count,
    which is what `idxmax` gives.
    """
    tally: dict[tuple[str, int], int] = {}
    for df in frames:
        city = df["situs_city"].fillna("").str.upper().str.strip()
        ok = city != ""
        vc = pd.Series(list(zip(city[ok], df.loc[ok, "county_n"]))).value_counts()
        for (c, cnty), n in vc.items():
            tally[(c, int(cnty))] = tally.get((c, int(cnty)), 0) + int(n)
    if not tally:
        return pd.Series(dtype="int8")
    t = pd.DataFrame([{"city": c, "county_n": k, "n": n} for (c, k), n in tally.items()])
    win = t.loc[t.groupby("city")["n"].idxmax()]
    return win.set_index("city")["county_n"].astype("int16")


def classify(df: pd.DataFrame, city_county: pd.Series) -> np.ndarray:
    """Return the locality code 0..4 for each parcel row."""
    owner_city = df["owner_city"].fillna("").str.upper().str.strip()
    situs_city = df["situs_city"].fillna("").str.upper().str.strip()
    state = df["owner_state"].fillna("").str.upper()
    valid = np.asarray(state.str.fullmatch(r"[A-Z]{2}", na=False), dtype=bool)
    is_mt = np.asarray(state == "MT", dtype=bool)

    out = np.full(len(df), 4, dtype="int8")                 # unknown
    out[valid & ~is_mt] = 3                                 # out_of_state
    out[valid & is_mt] = 2                                  # in_state

    owner_county = owner_city.map(city_county).to_numpy()
    parcel_county = df["county_n"].to_numpy()
    same_county = (~pd.isna(owner_county)) & (owner_county == parcel_county)
    out[np.asarray(same_county, dtype=bool) & is_mt] = 1    # same_county

    both = (owner_city != "") & (situs_city != "")
    local = np.asarray(both & (owner_city == situs_city), dtype=bool)
    out[local & is_mt] = 0                                  # local
    return out


# The three levels that are safe to plot over time. `local` versus `same_county`
# is a cross-sectional distinction only -- see the module docstring.
ROBUST_LEVELS = ["in_county", "elsewhere_in_state", "out_of_state_or_unknown"]


def collapse_in_county(codes: np.ndarray) -> np.ndarray:
    """Collapse to the three time-comparable tiers.

    0 = in the parcel's county (local + same_county)
    1 = elsewhere in Montana
    2 = out of state, or owner location unknown
    """
    out = np.full(len(codes), 2, dtype="int8")
    out[codes == 2] = 1
    out[(codes == 0) | (codes == 1)] = 0
    return out


def summarize(codes: np.ndarray) -> dict:
    vc = pd.Series(codes).value_counts()
    n = len(codes)
    return {LEVELS[i]: {"parcels": int(vc.get(i, 0)),
                        "pct": round(100.0 * int(vc.get(i, 0)) / max(1, n), 3)}
            for i in range(N_LEVELS)}
