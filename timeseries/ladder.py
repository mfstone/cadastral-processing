"""Development-ladder cohorts, dormant inventory, and regulatory thresholds.

Three planning analytics that need the time axis rather than a single snapshot.

**Absorption.** Of the lots created in a given interval, what share have reached
an assessed building by one, three, five and ten years later? Per county this
gives *years of supply*, which is the number that actually settles an argument
about whether to approve more lots.

**Dormant platted inventory.** Parcels still at stage 0 -- no house number, no
building -- years after they were created. This is the residue the 2005-2008
boom left behind, and it is capacity that already exists on paper.

It must be **size-restricted to be meaningful.** Stage 0 is the normal and
permanent condition of a working ranch tract: a 640-acre grazing parcel has no
house number and no building value, and is not dormant inventory in any useful
sense. Without the restriction Lincoln County reports 918,000 dormant acres,
which are rangeland, not vacant lots. Reported here by size class, with the
under-40-acre band as the residential-lot proxy.

**Regulatory-threshold clustering.** Montana's Subdivision and Platting Act
regulates divisions creating parcels **under 160 acres**; the family-conveyance
exemption (MCA 76-3-207(1)(b)) may not leave more than one remaining parcel under
160 acres; the agricultural-covenant exemption requires exclusive agricultural
use. So the size distribution of *newly created* parcels around 160 acres is a
direct read on whether divisions are being structured to stay outside review. A
mass immediately above the threshold is a review-avoidance signature.
"""

from __future__ import annotations

import glob
import json
import logging
import os

import numpy as np
import pandas as pd

log = logging.getLogger("timeseries.ladder")

SNAP_DIR = "data/snapshots"
EVENT_DIR = "data/events"
OUT_DIR = "data/ladder"

# Dormant once this many years have passed with no address and no building.
DORMANT_YEARS = 5
# Fine bins for the threshold analysis, in acres: 0.5 ac to 50, 2 ac to 200,
# then coarse. Deliberately fine enough to see a spike one acre wide.
THRESHOLD_BINS = (list(np.arange(0, 50.5, 0.5)) + list(np.arange(52, 202, 2))
                  + [220, 260, 320, 400, 480, 640, 1280, 1e9])
# The statutory edges worth testing directly.
STATUTORY_EDGES = (20.0, 40.0, 160.0)


def _dev_stage(df):
    """The development ladder, recomputed from its era-stable inputs.

    2 = assessed building value present
    1 = house number assigned, no building value yet (committed to build)
    0 = neither (platted only)
   -1 = unknown, because this vintage's value block is dead

    The middle rung uses ``has_house_number``, not ``has_situs_addr``, because
    its MEANING is stable across eras: P(improved | house number) holds at
    89-91% from 2006 through 2026, whereas P(improved | any address) drifts from
    46% to 85% because era A resolves the address field to a street NAME
    (``PROP_ST``) while 2013+ resolves it to a full address (``AddressLine1``).
    A definition that changes meaning mid-series manufactures a trend.
    """
    imp = df["improved"].to_numpy()
    stage = np.where(imp == 1, 2,
                     np.where(df["has_house_number"].to_numpy(), 1, 0)).astype("int8")
    stage[imp == -1] = -1
    return stage


def _dates(snap_dir: str) -> list[str]:
    return sorted(os.path.basename(p)[len("parcels_"):-len(".parquet")]
                  for p in glob.glob(os.path.join(snap_dir, "parcels_*.parquet")))


def absorption(snap_dir: str = SNAP_DIR, event_dir: str = EVENT_DIR) -> pd.DataFrame:
    """Cohort x age x stage counts, for parcels whose creation was observed.

    Parcels present in the first snapshot are excluded: their creation predates
    the series, so their age is unknown and including them would flatter every
    absorption curve.
    """
    dates = _dates(snap_dir)
    pres = pd.read_parquet(os.path.join(event_dir, "presence.parquet"),
                           columns=["parcel_id", "first_idx"])
    first = pres.set_index("parcel_id")["first_idx"]
    rows = []
    for j, date in enumerate(dates):
        df = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"),
                             columns=["parcel_id", "improved", "has_house_number",
                                      "county_n", "acres"])
        df["dev_stage"] = _dev_stage(df)
        df["first_idx"] = df["parcel_id"].map(first).astype("int16")
        born = df[(df["first_idx"] > 0) & (df["first_idx"] <= j)]
        g = (born.groupby(["first_idx", "county_n", "dev_stage"])
             .agg(parcels=("parcel_id", "size"), acres=("acres", "sum")).reset_index())
        g["observed_idx"] = j
        g["age_idx"] = g["observed_idx"] - g["first_idx"]
        rows.append(g)
        log.info("  absorption %s (%s cohort rows)", date, f"{len(g):,}")
    out = pd.concat(rows, ignore_index=True)
    out["cohort_date"] = out["first_idx"].map(dict(enumerate(dates)))
    out["observed_date"] = out["observed_idx"].map(dict(enumerate(dates)))
    yrs = {i: pd.Timestamp(d) for i, d in enumerate(dates)}
    out["years_elapsed"] = [
        (yrs[o] - yrs[f]).days / 365.25 for f, o in zip(out["first_idx"], out["observed_idx"])]
    return out


def thresholds(event_dir: str = EVENT_DIR) -> tuple[pd.DataFrame, dict]:
    """Size distribution of newly created parcels, with the statutory edges tested.

    ``first_mapping`` events are excluded: those are parcels arriving with
    coverage, not divisions of land, and they would blur the signal.
    """
    frames = []
    for path in sorted(glob.glob(os.path.join(event_dir, "events_*.parquet"))):
        base = os.path.basename(path)[:-len(".parquet")]
        parts = base.split("_")
        ev = pd.read_parquet(path, columns=["acres", "event_class", "confidence",
                                            "township_key", "is_subdivision"])
        if ev.empty:
            continue
        ev = ev[ev["event_class"] != "first_mapping"]
        ev["interval"] = int(parts[1])
        ev["date_a"], ev["date_b"] = parts[2], parts[3]
        frames.append(ev)
    ev = pd.concat(frames, ignore_index=True)
    ev["county_n"] = pd.to_numeric(ev["township_key"].str.slice(0, 2), errors="coerce")
    ev["bin"] = pd.cut(ev["acres"], bins=THRESHOLD_BINS, right=False)
    hist = (ev.groupby(["interval", "bin"], observed=True)
            .agg(parcels=("acres", "size")).reset_index())
    hist["bin_lo"] = hist["bin"].apply(lambda b: float(b.left))
    hist["bin_hi"] = hist["bin"].apply(lambda b: float(b.right))
    hist = hist.drop(columns=["bin"])

    # The direct test: mass just below an edge against mass just above it.
    tests = {}
    for edge in STATUTORY_EDGES:
        w = max(1.0, edge * 0.03)      # a 3% window either side
        below = int(((ev["acres"] >= edge - w) & (ev["acres"] < edge)).sum())
        above = int(((ev["acres"] >= edge) & (ev["acres"] < edge + w)).sum())
        tests[f"{edge:g}_acre_edge"] = {
            "window_acres": round(w, 2),
            "just_below": below, "just_above": above,
            "above_over_below": round(above / max(1, below), 4),
        }
    era = {}
    for lo, hi, lab in ((0, 11, "2003-2010"), (11, 20, "2011-2019"), (20, 28, "2020-2026")):
        sub = ev[(ev["interval"] >= lo) & (ev["interval"] < hi)]
        e = {}
        for edge in STATUTORY_EDGES:
            w = max(1.0, edge * 0.03)
            b = int(((sub["acres"] >= edge - w) & (sub["acres"] < edge)).sum())
            a = int(((sub["acres"] >= edge) & (sub["acres"] < edge + w)).sum())
            e[f"{edge:g}"] = {"below": b, "above": a, "ratio": round(a / max(1, b), 3)}
        era[lab] = e
    qa = {"events_scored": int(len(ev)),
          "note": "first_mapping excluded: coverage arriving, not land divided",
          "edge_tests": tests, "by_era": era,
          "pct_under_160_acres": round(100.0 * float((ev["acres"] < 160).mean()), 3)}
    return hist, qa


def dormant(snap_dir: str = SNAP_DIR, event_dir: str = EVENT_DIR,
            years: float = DORMANT_YEARS) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Stage-0 parcels at the latest snapshot, by how long they have been so."""
    dates = _dates(snap_dir)
    latest = dates[-1]
    pres = pd.read_parquet(os.path.join(event_dir, "presence.parquet"),
                           columns=["parcel_id", "first_idx"])
    first = pres.set_index("parcel_id")["first_idx"]
    df = pd.read_parquet(os.path.join(snap_dir, f"parcels_{latest}.parquet"),
                         columns=["parcel_id", "dev_stage", "county_n", "acres",
                                  "township_key"] if False else
                                 ["parcel_id", "improved", "has_house_number",
                                  "county_n", "acres", "county", "twp_code"])
    df["dev_stage"] = _dev_stage(df)
    df["tr_unit"] = df["county"].fillna("") + df["twp_code"].fillna("")
    df["first_idx"] = df["parcel_id"].map(first).astype("int16")
    ts = {i: pd.Timestamp(d) for i, d in enumerate(dates)}
    df["age_years"] = [(ts[len(dates) - 1] - ts[f]).days / 365.25 if f >= 0 else np.nan
                       for f in df["first_idx"]]
    out = df[(df["dev_stage"] == 0) & (df["first_idx"] > 0)].copy()
    # Size class of the dormant parcel: a residential lot and a grazing tract
    # are both stage 0, and only one of them is inventory.
    out["size_class"] = pd.cut(out["acres"], bins=[0, 1, 5, 20, 40, 160, np.inf],
                               labels=["lt1", "1_5", "5_20", "20_40", "40_160", "gt160"],
                               right=False)
    g = (out.groupby("county_n")
         .agg(dormant_parcels=("parcel_id", "size"), dormant_acres=("acres", "sum"),
              median_age_years=("age_years", "median")).reset_index())
    res = out[out["acres"] < 40]          # the residential-lot proxy
    gr = (res.groupby("county_n")
          .agg(dormant_lt40ac=("parcel_id", "size"),
               dormant_lt40ac_acres=("acres", "sum"),
               dormant_lt40ac_median_age=("age_years", "median")).reset_index())
    aged = res[res["age_years"] >= years]
    ga = (aged.groupby("county_n")
          .agg(**{f"dormant_lt40ac_ge_{int(years)}y": ("parcel_id", "size")}).reset_index())
    by_size = (out.groupby(["county_n", "size_class"], observed=True)
               .agg(parcels=("parcel_id", "size"), acres=("acres", "sum")).reset_index())
    merged = (g.merge(gr, on="county_n", how="left")
              .merge(ga, on="county_n", how="left").fillna(0))
    # Returned as a pair rather than stashed in .attrs: pandas serialises attrs
    # into parquet metadata as JSON, which a DataFrame cannot survive.
    return merged, by_size


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Development-ladder and threshold analytics")
    ap.add_argument("--snap-dir", default=SNAP_DIR)
    ap.add_argument("--event-dir", default=EVENT_DIR)
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    os.makedirs(args.out, exist_ok=True)

    log.info("absorption cohorts")
    ab = absorption(args.snap_dir, args.event_dir)
    ab.to_parquet(os.path.join(args.out, "absorption.parquet"), index=False, compression="zstd")

    log.info("regulatory thresholds")
    hist, tqa = thresholds(args.event_dir)
    hist.to_parquet(os.path.join(args.out, "size_histogram.parquet"), index=False, compression="zstd")

    log.info("dormant inventory")
    dm, by_size = dormant(args.snap_dir, args.event_dir)
    dm.to_parquet(os.path.join(args.out, "dormant.parquet"), index=False, compression="zstd")
    by_size.to_parquet(os.path.join(args.out, "dormant_by_size.parquet"),
                       index=False, compression="zstd")

    qa = {"absorption_rows": int(len(ab)), "histogram_rows": int(len(hist)),
          "dormant_counties": int(len(dm)),
          "dormant_parcels_total": int(dm["dormant_parcels"].sum()),
          "dormant_acres_total": float(dm["dormant_acres"].sum()),
          "dormant_lt40ac_total": int(dm["dormant_lt40ac"].sum()),
          "dormant_lt40ac_acres": float(dm["dormant_lt40ac_acres"].sum()),
          "dormant_note": ("stage 0 is the normal permanent state of a working "
                           "ranch tract; the under-40-acre figure is the "
                           "residential-lot proxy"),
          "thresholds": tqa}
    with open(os.path.join(args.out, "qa_ladder.json"), "w") as fh:
        json.dump(qa, fh, indent=2, default=str)
    log.info("dormant: %s parcels, %.2fM acres across %d counties",
             f"{qa['dormant_parcels_total']:,}", qa["dormant_acres_total"] / 1e6, len(dm))
    for k, v in tqa["edge_tests"].items():
        log.info("  %s: just below %s, just above %s, ratio %s",
                 k, f"{v['just_below']:,}", f"{v['just_above']:,}", v["above_over_below"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
