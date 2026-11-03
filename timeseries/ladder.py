"""Development-ladder cohorts, dormant inventory, and regulatory thresholds.

Three planning analytics that need the time axis rather than a single snapshot.

**Absorption.** Of the lots created in a given interval, what share have reached
an assessed building by one, three, five and ten years later? Per county this
gives *years of supply*, which is the number that actually settles an argument
about whether to approve more lots. The cohort curves are descriptive; a lot
that is unbuilt at its last observation is **right-censored**, not "never
built", so :func:`absorption_survival` estimates time to a building with the
end of each record treated as a censoring (Kaplan-Meier) and a lot leaving the
record -- consolidated, retired, renumbered -- as a competing event
(Aalen-Johansen).

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
use; and under the Sanitation in Subdivisions Act a "subdivision" is a division
creating a parcel under 20 acres (MCA 76-4-102(25)), a parcel of 20 acres or
more being outside that review (76-4-103). So the size distribution of *newly
created* parcels around those lines is a direct read on whether divisions are
being structured to stay outside review. A mass immediately above a threshold
is consistent with that -- bunching is a pattern, not a motive -- and the
sensitivity sweep in :func:`thresholds` says how much of it survives a change
of window and the removal of the aliquot size that sits on the line itself.
"""

from __future__ import annotations

import glob
import json
import logging
import os

import numpy as np
import pandas as pd

from . import events

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
# The statutory edges worth testing directly, and the control sizes with no
# statutory meaning that the same test is run at.
STATUTORY_EDGES = (20.0, 40.0, 160.0)
CONTROL_EDGES = (10.0, 12.0, 15.0, 25.0, 30.0, 50.0, 80.0, 100.0, 320.0)
# A parcel within this fraction of an edge IS the aliquot size (a 20-acre
# half of a quarter-quarter, a 40-acre quarter-quarter, a 160-acre quarter):
# the survey grid, which sits at the very bottom of the "above" window.
EXACT_TOL = 0.005


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
    occ = events.load_occurrences(event_dir)
    rows = []
    for j, date in enumerate(dates):
        df = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"),
                             columns=["parcel_id", "improved", "has_house_number",
                                      "county_n", "acres", "is_common_area"])
        # Dedicated common areas never absorb; they would read as lots that
        # failed to (timeseries.commonarea).
        df = df[~df["is_common_area"].to_numpy(dtype=bool)]
        df["dev_stage"] = _dev_stage(df)
        # The cohort is the occurrence present at this snapshot: a reissued
        # geocode belongs to the cohort of its return, not of its first life.
        df["first_idx"] = df["parcel_id"].map(events.occurrence_start(occ, j)).fillna(-1).astype("int16")
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


def absorption_survival(snap_dir: str = SNAP_DIR, event_dir: str = EVENT_DIR
                        ) -> tuple[pd.DataFrame, dict]:
    """Time to an assessed building for every observed creation, censored
    honestly.

    One row per (cohort, county or 0 for statewide, age in snapshots): the
    parcels still under observation and unbuilt at that age (``at_risk``), the
    number first built at that age, the number that left the record at that
    age without a building (``gone``: consolidated, retired or renumbered),
    and the number whose record simply ends there (``ended``, the series end).
    ``km_built`` treats leaving as a censoring (Kaplan-Meier, the share that
    would have been built had every lot stayed); ``ci_built`` treats it as a
    competing event (Aalen-Johansen, the share of created lots actually
    built), which is the smaller and the more literal of the two.
    """
    dates = _dates(snap_dir)
    n = len(dates)
    occ = events.load_occurrences(event_dir)
    occ = occ[occ["first_idx"] > 0].reset_index(drop=True)     # creation observed
    first_built = np.full(len(occ), 127, dtype="int16")
    common = np.zeros(len(occ), dtype=bool)
    for j, date in enumerate(dates):
        if j == 0:
            continue
        df = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"),
                             columns=["parcel_id", "improved", "is_common_area"])
        live = occ[(occ["first_idx"] <= j) & (occ["last_idx"] >= j)]
        rowmap = pd.Series(live.index.to_numpy(), index=live["parcel_id"].to_numpy())
        rows = df["parcel_id"].map(rowmap)
        ok = rows.notna().to_numpy()
        r = rows[ok].to_numpy().astype("int64")
        built = df["improved"].to_numpy()[ok] == 1
        np.minimum.at(first_built, r[built], np.int16(j))
        common[r[df["is_common_area"].to_numpy(dtype=bool)[ok]]] = True
        log.info("  survival %s", date)
    keep = ~common
    occ = occ[keep].reset_index(drop=True)
    fb = first_built[keep]
    f = occ["first_idx"].to_numpy().astype("int64")
    last = occ["last_idx"].to_numpy().astype("int64")
    event = fb <= last
    exit_age = np.where(event, fb - f, last - f)
    gone = (~event) & (last < n - 1)
    county = pd.to_numeric(occ["parcel_id"].str.slice(0, 2), errors="coerce").fillna(0).astype("int16")
    d = pd.DataFrame({"cohort": f.astype("int16"), "county_n": county, "exit": exit_age.astype("int16"),
                      "event": event, "gone": gone})
    ts = [pd.Timestamp(x) for x in dates]

    def tab(g: pd.DataFrame, cohort: int, cn: int, out: list) -> None:
        maxa = n - 1 - cohort
        ex = g["exit"].to_numpy()
        ev = g["event"].to_numpy()
        go = g["gone"].to_numpy()
        built = np.bincount(ex[ev], minlength=maxa + 1)[:maxa + 1]
        left = np.bincount(ex[go], minlength=maxa + 1)[:maxa + 1]
        ended = np.bincount(ex[~ev & ~go], minlength=maxa + 1)[:maxa + 1]
        exits = built + left + ended
        at_risk = len(g) - np.concatenate([[0], np.cumsum(exits)[:-1]])
        with np.errstate(divide="ignore", invalid="ignore"):
            h_b = np.where(at_risk > 0, built / at_risk, 0.0)
            h_all = np.where(at_risk > 0, (built + left) / at_risk, 0.0)
        s_all = np.cumprod(1.0 - h_all)
        s_prev = np.concatenate([[1.0], s_all[:-1]])
        ci = np.cumsum(s_prev * h_b)
        km = 1.0 - np.cumprod(1.0 - h_b)
        for a in range(maxa + 1):
            out.append({"cohort": cohort, "county_n": cn, "age_idx": a,
                        "years": round((ts[cohort + a] - ts[cohort]).days / 365.25, 3),
                        "at_risk": int(at_risk[a]), "built": int(built[a]), "gone": int(left[a]),
                        "ended": int(ended[a]), "km_built": round(float(km[a]), 5),
                        "ci_built": round(float(ci[a]), 5)})

    out: list[dict] = []
    for cohort, g in d.groupby("cohort"):
        tab(g, int(cohort), 0, out)
        for cn, gc in g.groupby("county_n"):
            if cn > 0:
                tab(gc, int(cohort), int(cn), out)
    table = pd.DataFrame(out)
    for c in ("cohort", "county_n", "age_idx", "at_risk", "built", "gone", "ended"):
        table[c] = table[c].astype("int32")

    # The statewide reading at five, ten and fifteen years, per cohort that
    # has been followed that long, and the plain tally of what happened to
    # every observed creation by the end of the series.
    sw = table[table["county_n"] == 0]
    horizons = {}
    for yrs in (5, 10, 15):
        rows = []
        for cohort, g in sw.groupby("cohort"):
            g = g[g["years"] >= yrs]
            if g.empty:
                continue
            r = g.iloc[0]
            rows.append({"cohort": int(cohort), "cohort_date": dates[int(cohort)], "age_years": float(r["years"]),
                         "ci_built": float(r["ci_built"]), "km_built": float(r["km_built"]), "at_risk_start": int(sw[sw["cohort"] == cohort].iloc[0]["at_risk"])})
        if rows:
            ci = np.array([r["ci_built"] for r in rows])
            horizons[f"{yrs}y"] = {"cohorts": len(rows), "ci_built_min": round(float(ci.min()), 4),
                                  "ci_built_median": round(float(np.median(ci)), 4), "ci_built_max": round(float(ci.max()), 4),
                                  "km_built_median": round(float(np.median([r["km_built"] for r in rows])), 4),
                                  "by_cohort": rows}
    qa = {
        "creations_observed": int(len(d)),
        "built_by_series_end": int(d["event"].sum()),
        "left_record_unbuilt": int(d["gone"].sum()),
        "unbuilt_under_observation": int((~d["event"] & ~d["gone"]).sum()),
        "horizons": horizons,
        "note": "ci_built is the Aalen-Johansen cumulative incidence of an assessed building with "
                "leaving the record as a competing event; km_built treats leaving as censoring. "
                "A lot unbuilt at its last observation is right-censored, not never built.",
    }
    return table, qa


def thresholds(event_dir: str = EVENT_DIR) -> tuple[pd.DataFrame, dict, pd.DataFrame, pd.DataFrame]:
    """Size distribution of newly created parcels, with the statutory edges tested.

    ``first_mapping`` events are excluded: those are parcels arriving with
    coverage, not divisions of land, and they would blur the signal.

    Returns the statewide histogram by interval, its QA, and two county
    tables the reports draw on: the counts just below and just above each
    statutory edge per county and interval (``threshold_edges``), and the
    county's all-time histogram (``county_size_histogram``). The per-county,
    per-interval histogram would be a quarter of a million rows for a chart
    nobody reads at that grain; the edge windows are what the question needs.
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
    agg = {"lots": ("acres", "size")}
    for edge in STATUTORY_EDGES:
        w = max(1.0, edge * 0.03)      # a 3% window either side
        b = (ev["acres"] >= edge - w) & (ev["acres"] < edge)
        a = (ev["acres"] >= edge) & (ev["acres"] < edge + w)
        below, above = int(b.sum()), int(a.sum())
        tests[f"{edge:g}_acre_edge"] = {
            "window_acres": round(w, 2),
            "just_below": below, "just_above": above,
            "above_over_below": round(above / max(1, below), 4),
        }
        ev[f"below{edge:g}"] = b.astype("int32")
        ev[f"above{edge:g}"] = a.astype("int32")
        agg[f"below{edge:g}"] = (f"below{edge:g}", "sum")
        agg[f"above{edge:g}"] = (f"above{edge:g}", "sum")
    # Land divisions only for the per-county lot count: a condominium unit is
    # housing inside an existing lot, never a division of land.
    land = ev[ev["event_class"].isin(["lot_created", "block_created"])]
    edges = (land[land["county_n"].notna()]
             .groupby(["county_n", "interval"]).agg(**agg).reset_index())
    edges["county_n"] = edges["county_n"].astype("int16")
    chist = (ev[ev["county_n"].notna()].groupby(["county_n", "bin"], observed=True)
             .agg(parcels=("acres", "size")).reset_index())
    chist["bin_lo"] = chist["bin"].apply(lambda b: float(b.left))
    chist["bin_hi"] = chist["bin"].apply(lambda b: float(b.right))
    chist = chist.drop(columns=["bin"])
    chist["county_n"] = chist["county_n"].astype("int16")
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
    # Sensitivity: the same ratio under other windows, and with the aliquot
    # size itself (the survey grid, exactly on the line) removed from both
    # sides; then the control sizes that carry no statutory meaning.
    acres = ev["acres"].to_numpy(dtype="float64")

    def edge_test(edge: float, w: float) -> dict:
        below = (acres >= edge - w) & (acres < edge)
        above = (acres >= edge) & (acres < edge + w)
        exact = np.abs(acres - edge) <= EXACT_TOL * edge
        b, a = int(below.sum()), int(above.sum())
        bx, ax = int((below & ~exact).sum()), int((above & ~exact).sum())
        return {"window_acres": round(w, 3), "below": b, "above": a, "ratio": round(a / max(1, b), 3),
                "exact": int(exact.sum()), "below_excl_exact": bx, "above_excl_exact": ax,
                "ratio_excl_exact": round(ax / max(1, bx), 3)}

    sens = {}
    for edge in STATUTORY_EDGES:
        e = {}
        for label, w in (("rel1", 0.01 * edge), ("rel2", 0.02 * edge), ("rel3", 0.03 * edge),
                         ("rel5", 0.05 * edge), ("rel10", 0.10 * edge),
                         ("abs0.5", 0.5), ("abs1", 1.0), ("abs2", 2.0)):
            e[label] = edge_test(edge, max(w, 0.25))
        sens[f"{edge:g}"] = e
    controls = {f"{edge:g}": edge_test(edge, max(1.0, edge * 0.03)) for edge in CONTROL_EDGES}
    qa = {"events_scored": int(len(ev)),
          "note": "first_mapping excluded: coverage arriving, not land divided",
          "edge_tests": tests, "by_era": era,
          "sensitivity": sens, "controls": controls,
          "sensitivity_note": "rel/abs name the window as a fraction of the edge or in acres; "
                              "*_excl_exact removes parcels within 0.5% of the edge, the aliquot "
                              "size itself, which sits at the bottom of the 'above' window",
          "pct_under_160_acres": round(100.0 * float((ev["acres"] < 160).mean()), 3),
          "county_edges_rows": int(len(edges)), "county_histogram_rows": int(len(chist))}
    return hist, qa, edges, chist


def dormant(snap_dir: str = SNAP_DIR, event_dir: str = EVENT_DIR,
            years: float = DORMANT_YEARS) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Stage-0 parcels at the latest snapshot, by how long they have been so."""
    dates = _dates(snap_dir)
    latest = dates[-1]
    # Age from the start of the parcel's current occurrence (events.py).
    first = events.occurrence_start(events.load_occurrences(event_dir), len(dates) - 1)
    df = pd.read_parquet(os.path.join(snap_dir, f"parcels_{latest}.parquet"),
                         columns=["parcel_id", "improved", "has_house_number",
                                  "county_n", "acres", "county", "twp_code",
                                  "is_common_area"])
    # A dedicated park or open-space tract is stage 0 by design, not dormant
    # inventory; out before anything is counted (timeseries.commonarea).
    common = df["is_common_area"].to_numpy(dtype=bool)
    log.info("  dormant: %s common-area tracts left out of %s", f"{int(common.sum()):,}", latest)
    df = df[~common]
    df["dev_stage"] = _dev_stage(df)
    df["tr_unit"] = df["county"].fillna("") + df["twp_code"].fillna("")
    df["first_idx"] = df["parcel_id"].map(first).fillna(-1).astype("int16")
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

    log.info("absorption survival (censored)")
    surv, sqa = absorption_survival(args.snap_dir, args.event_dir)
    surv.to_parquet(os.path.join(args.out, "absorption_survival.parquet"), index=False, compression="zstd")

    log.info("regulatory thresholds")
    hist, tqa, edges, chist = thresholds(args.event_dir)
    hist.to_parquet(os.path.join(args.out, "size_histogram.parquet"), index=False, compression="zstd")
    edges.to_parquet(os.path.join(args.out, "threshold_edges.parquet"), index=False, compression="zstd")
    chist.to_parquet(os.path.join(args.out, "county_size_histogram.parquet"), index=False, compression="zstd")

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
                           "residential-lot proxy; dedicated common areas "
                           "(open space, parks, HOA and condo tracts) are "
                           "excluded from every cohort"),
          "thresholds": tqa,
          "absorption_survival": sqa}
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
