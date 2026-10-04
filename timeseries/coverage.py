"""Stage 4: the coverage and comparability gate.

Mapped acreage divided by county area is a useful diagnostic but a poor
principal test: a county that is mostly federal or state land has structurally
low cadastral acreage while its private cadastral data is perfectly complete. So
a county-year becomes suspect only when **several** independent indicators fail
together.

1. **parcel count** against the county's own adjacent snapshots
2. **mapped acreage** against the county's stable late-series baseline -- its own
   plateau, which needs no external denominator
3. **populated quarter-section share** against that same plateau
4. **first-mapping share** of creations entering the county in that interval

The measured justification for (2) and (3): statewide mapped acreage swings +-5%
through 2004-2006 and then settles to +-0.1% from 2009 onward, and the
`first_mapping` share of creations falls from 42% to 4.7-11.8% after 2008. The
coverage era is real, bounded, and confined to 2003-2007.

An interval metric publishes only when **both** endpoints clear the gate.
Everything else renders as an explicit "no comparable data" state -- never as
zero, because a reader cannot tell a true zero from an absent county.
"""

from __future__ import annotations

import glob
import json
import logging
import os

import numpy as np
import pandas as pd

from . import geocode as gc

log = logging.getLogger("timeseries.coverage")

IN_DIR = "data/snapshots"
EVENT_DIR = "data/events"
OUT_DIR = "data/coverage"

# A county-year must reach this share of its own late-series plateau on both
# acreage and populated quarter-sections to be comparable.
PLATEAU_FLOOR = 0.90
# Snapshots used to define the plateau: the late series, where statewide acreage
# is stable to +-0.1%.
PLATEAU_FROM = "2016-01-12"
# Above this share of creations being first_mapping, the county-interval is
# recording coverage arriving rather than parcels being created.
FIRST_MAPPING_CEILING = 0.20
# ...but a rate needs a denominator. A county with 8 creations of which 4 are
# first_mapping scores 50% on noise, and 61.3% of the rejections under a bare
# ratio test were county-intervals with fewer than 25 creations. So the test
# also requires the coverage arrival to be absolutely material, which still
# catches the real cases (70 county-intervals with 100+ creations and a median
# first_mapping share of 0.51).
FIRST_MAPPING_MIN_ABS = 25


def county_stock(in_dir: str = IN_DIR) -> pd.DataFrame:
    """Per county per snapshot: parcels, acres, occupied quarter-sections."""
    rows = []
    for path in sorted(glob.glob(os.path.join(in_dir, "parcels_*.parquet"))):
        date = os.path.basename(path)[len("parcels_"):-len(".parquet")]
        df = pd.read_parquet(path, columns=["county_n", "acres", "county", "twp_code",
                                            "section", "quarter"])
        qk = (df["county"].fillna("") + df["twp_code"].fillna("")
              + df["section"].fillna("") + df["quarter"].fillna(""))
        g = pd.DataFrame({"county_n": df["county_n"], "acres": df["acres"], "qk": qk})
        agg = g.groupby("county_n").agg(parcels=("acres", "size"), acres=("acres", "sum"),
                                        quarters=("qk", "nunique")).reset_index()
        agg["snapshot"] = date
        rows.append(agg)
        log.info("  stock %s: %d counties", date, len(agg))
    return pd.concat(rows, ignore_index=True)


def build(in_dir: str = IN_DIR, event_dir: str = EVENT_DIR,
          out_dir: str = OUT_DIR) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    stock = county_stock(in_dir)
    stock = stock[stock["county_n"].between(1, 56)].copy()

    # Each county's own plateau, from the late series.
    late = stock[stock["snapshot"] >= PLATEAU_FROM]
    plateau = late.groupby("county_n").agg(
        acres_plateau=("acres", "median"), quarters_plateau=("quarters", "median"),
        parcels_plateau=("parcels", "median")).reset_index()
    stock = stock.merge(plateau, on="county_n", how="left")
    stock["acres_ratio"] = stock["acres"] / stock["acres_plateau"]
    stock["quarters_ratio"] = stock["quarters"] / stock["quarters_plateau"]
    stock["acres_ok"] = stock["acres_ratio"] >= PLATEAU_FLOOR
    stock["quarters_ok"] = stock["quarters_ratio"] >= PLATEAU_FLOOR

    # Parcel count against the county's own neighbours in time.
    stock = stock.sort_values(["county_n", "snapshot"])
    g = stock.groupby("county_n")["parcels"]
    prev, nxt = g.shift(1), g.shift(-1)
    neighbour = pd.concat([prev, nxt], axis=1).mean(axis=1)
    stock["parcel_jump"] = (stock["parcels"] - neighbour).abs() / neighbour
    stock["parcels_ok"] = ~(stock["parcel_jump"] > 0.10).fillna(False)

    # Two or more failures make a county-year non-comparable.
    fails = ((~stock["acres_ok"]).astype(int) + (~stock["quarters_ok"]).astype(int)
             + (~stock["parcels_ok"]).astype(int))
    stock["n_indicators_failed"] = fails.astype("int8")
    stock["coverage_ok"] = fails < 2

    # First-mapping share per county per interval, from the event tables.
    fm_rows = []
    for path in sorted(glob.glob(os.path.join(event_dir, "events_*.parquet"))):
        base = os.path.basename(path)[:-len(".parquet")]
        idx = int(base.split("_")[1])
        ev = pd.read_parquet(path, columns=["township_key", "event_class"])
        if ev.empty:
            continue
        ev["county_n"] = pd.to_numeric(ev["township_key"].str.slice(0, 2), errors="coerce")
        t = ev.groupby("county_n")["event_class"].agg(
            created="size", first_mapping=lambda s: int((s == "first_mapping").sum())).reset_index()
        t["interval"] = idx
        fm_rows.append(t)
    fm = pd.concat(fm_rows, ignore_index=True)
    fm["first_mapping_share"] = fm["first_mapping"] / fm["created"].clip(lower=1)
    fm["first_mapping_ok"] = ~((fm["first_mapping_share"] > FIRST_MAPPING_CEILING)
                               & (fm["first_mapping"] >= FIRST_MAPPING_MIN_ABS))

    # An interval is comparable only when both endpoints are and the interval
    # itself is not dominated by coverage arriving.
    dates = sorted(stock["snapshot"].unique())
    ok = stock.set_index(["county_n", "snapshot"])["coverage_ok"]
    iv = []
    for i, (a, b) in enumerate(zip(dates, dates[1:])):
        for c in sorted(stock["county_n"].unique()):
            ia = bool(ok.get((c, a), False))
            ib = bool(ok.get((c, b), False))
            row = fm[(fm["interval"] == i) & (fm["county_n"] == c)]
            fmo = bool(row["first_mapping_ok"].iloc[0]) if len(row) else True
            fms = float(row["first_mapping_share"].iloc[0]) if len(row) else 0.0
            fmn = int(row["first_mapping"].iloc[0]) if len(row) else 0
            created = int(row["created"].iloc[0]) if len(row) else 0
            iv.append({"county_n": int(c), "interval": i, "date_a": a, "date_b": b,
                       "endpoint_a_ok": ia, "endpoint_b_ok": ib, "created": created,
                       "first_mapping": fmn, "first_mapping_share": round(fms, 4),
                       "first_mapping_ok": fmo, "comparable": ia and ib and fmo})
    ivdf = pd.DataFrame(iv)

    stock.to_parquet(os.path.join(out_dir, "coverage_snapshot.parquet"), index=False)
    ivdf.to_parquet(os.path.join(out_dir, "coverage_interval.parquet"), index=False)

    per_snap = stock.groupby("snapshot")["coverage_ok"].agg(["sum", "size"])
    qa = {
        "county_snapshots": int(len(stock)),
        "county_snapshots_ok": int(stock["coverage_ok"].sum()),
        "pct_snapshots_ok": round(100.0 * float(stock["coverage_ok"].mean()), 3),
        "county_intervals": int(len(ivdf)),
        "county_intervals_comparable": int(ivdf["comparable"].sum()),
        "pct_intervals_comparable": round(100.0 * float(ivdf["comparable"].mean()), 3),
        "first_snapshot_fully_covered": next(
            (s for s in dates if per_snap.loc[s, "sum"] == per_snap.loc[s, "size"]), None),
        "counties_ok_by_snapshot": {s: int(per_snap.loc[s, "sum"]) for s in dates},
        "plateau_floor": PLATEAU_FLOOR,
        "first_mapping_ceiling": FIRST_MAPPING_CEILING,
        "first_mapping_min_abs": FIRST_MAPPING_MIN_ABS,
        "rejected_only_by_first_mapping": int(
            (ivdf["endpoint_a_ok"] & ivdf["endpoint_b_ok"] & ~ivdf["first_mapping_ok"]).sum()),
        "pct_creations_in_noncomparable": round(
            100.0 * float(ivdf.loc[~ivdf["comparable"], "created"].sum()
                          / max(1, ivdf["created"].sum())), 3),
    }
    worst = stock[~stock["coverage_ok"]].groupby("county_n").size().sort_values(ascending=False)
    qa["counties_most_often_masked"] = {int(k): int(v) for k, v in worst.head(10).items()}
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Stage 4: the coverage gate")
    ap.add_argument("--in-dir", default=IN_DIR)
    ap.add_argument("--event-dir", default=EVENT_DIR)
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    qa = build(args.in_dir, args.event_dir, args.out)
    with open(os.path.join(args.out, "qa_coverage.json"), "w") as fh:
        json.dump(qa, fh, indent=2, default=str)
    log.info("county-snapshots %s (%s ok, %.1f%%); county-intervals %s (%s comparable, %.1f%%)",
             f"{qa['county_snapshots']:,}", f"{qa['county_snapshots_ok']:,}",
             qa["pct_snapshots_ok"], f"{qa['county_intervals']:,}",
             f"{qa['county_intervals_comparable']:,}", qa["pct_intervals_comparable"])
    log.info("first fully covered snapshot: %s", qa["first_snapshot_fully_covered"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
