"""Stage 7: encode the published payload for the static dashboard.

Three constraints come from the sibling crash dashboard, where each was learned
the hard way in production rather than in development.

**GZIP page codec, not zstd.** ``hyparquet`` ships only SNAPPY built in. GZIP is
supplied client-side through a *deep* import of
``hyparquet-compressors/src/gzip.js``, because the package index eagerly
instantiates an embedded WebAssembly module at import time, which
``script-src 'self'`` forbids -- the page died at boot in production while
working perfectly against a dev server, since ``astro preview`` applies no CSP.

**One row group per file, no statistics on wide tables.** Cloudflare Pages
ignores HTTP ``Range``, so the client fetches each file whole and wraps the
ArrayBuffer. Extra row groups and per-column statistics then buy nothing and
cost footer bytes.

**No nullable dtypes.** ``Int32`` rather than ``int32`` adds a definition-level
stream per column; sentinels (-1) are used instead.

Tables are split by topic so a view fetches only the columns it reads. The
largest single win on the crash project came from cutting a column that shipped
but was never decoded, and splitting by topic makes that mistake impossible.
"""

from __future__ import annotations

import json
import logging
import os
import shutil

import numpy as np
import pandas as pd

from cadastral.schema import COUNTY_PREFIX

from . import locality
from . import ownerclass as oc
from . import sources

log = logging.getLogger("timeseries.publish")

FACT_DIR = "data/facts"
LOC_DIR = "data/locator"
LADDER_DIR = "data/ladder"
COVER_DIR = "data/coverage"
EVENT_DIR = "data/events"
OUT_DIR = "site/public/data"

PARQUET_KW = dict(compression="gzip", index=False)

# Topic split for the township surface. Each view fetches only its own file.
TOPICS = {
    "core": ["parcels", "acres", "quarters", "n_condo", "n_named_subdiv",
             "coverage_ok"],
    "dev": [f"n_dev{i}" for i in range(4)] + [f"ac_dev{i}" for i in range(4)],
    "tenure": [f"n_ten{i}" for i in range(oc.N_TENURE)]
              + [f"ac_ten{i}" for i in range(oc.N_TENURE)] + ["n_on_public_land"],
    "locality": [f"n_loc{i}" for i in range(locality.N_LEVELS)]
                + [f"ac_loc{i}" for i in range(locality.N_LEVELS)],
    "size": [f"n_sz{i}" for i in range(8)] + [f"ac_sz{i}" for i in range(8)],
    "class": [f"n_oc{i}" for i in range(oc.N_CLASSES)],
    "owner_origin": [f"n_st{i}" for i in range(12)],
    "ag": ["n_ag", "ag_acres", "n_ag_business"],
    "improve": ["n_improved", "n_unimproved", "n_improve_unknown",
                "n_with_addr", "n_with_house_number"],
}
FLOW_COLS = ["created", "retired", "persisted", "lot_created", "block_created",
             "unit_created", "first_mapping", "conf_high", "conf_medium",
             "is_subdivision", "acres_created", "owner_changed",
             "transfers_out_of_state", "address_change_only", "to_CA", "from_CA",
             "comparable"]

STATE_BUCKETS = ["MT", "CA", "WA", "TX", "CO", "FL", "AZ", "ID", "UT", "WY",
                 "other_us", "unknown"]


def _narrow(df: pd.DataFrame) -> pd.DataFrame:
    """Shrink integer and float columns; never leave a nullable dtype behind."""
    out = df.loc[:, ~df.columns.duplicated()].copy()
    for c in out.columns:
        s = out[c]
        if s.dtype == bool:
            out[c] = s.astype("int8")
            continue
        if pd.api.types.is_integer_dtype(s) or pd.api.types.is_bool_dtype(s):
            v = pd.to_numeric(s, errors="coerce").fillna(-1)
            mx, mn = float(v.max()), float(v.min())
            for dt, lo, hi in (("int8", -128, 127), ("int16", -32768, 32767),
                               ("int32", -2147483648, 2147483647)):
                if mn >= lo and mx <= hi:
                    out[c] = v.astype(dt)
                    break
            else:
                out[c] = v.astype("int64")
        elif pd.api.types.is_float_dtype(s):
            out[c] = s.fillna(0).astype("float32")
    return out


def _write(df: pd.DataFrame, path: str, delta_on: str | None = None,
           key: str | None = None) -> dict:
    """Write one published table, optionally snapshot-delta coded.

    Delta coding stores ``value[s] - value[s-1]`` along the snapshot axis, which
    measured ~2.2x smaller than storing levels once dictionary-encoded and
    gzipped, because consecutive snapshots of a stock quantity barely differ.
    The client cumsums at load.
    """
    d = df.copy()
    if delta_on and key:
        d = d.sort_values([key, delta_on]).reset_index(drop=True)
        measures = [c for c in d.columns if c not in (key, delta_on)]
        g = d.groupby(key, sort=False)
        for c in measures:
            if pd.api.types.is_numeric_dtype(d[c]):
                d[c] = d[c] - g[c].shift(1).fillna(0)
    d = _narrow(d)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    d.to_parquet(path, **PARQUET_KW)
    return {"rows": int(len(d)), "cols": int(d.shape[1]),
            "bytes": os.path.getsize(path), "delta_coded": bool(delta_on)}


def build(out_dir: str = OUT_DIR, delta: bool = True) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    files: dict[str, dict] = {}

    twp = pd.read_parquet(os.path.join(FACT_DIR, "stock_township.parquet"))
    cty = pd.read_parquet(os.path.join(FACT_DIR, "stock_county.parquet"))
    twp_flow = pd.read_parquet(os.path.join(FACT_DIR, "flow_township.parquet"))
    cty_flow = pd.read_parquet(os.path.join(FACT_DIR, "flow_county.parquet"))
    cty_state = pd.read_parquet(os.path.join(FACT_DIR, "stock_county_state.parquet"))
    twp_state = pd.read_parquet(os.path.join(FACT_DIR, "stock_township_state.parquet"))
    units = pd.read_parquet(os.path.join(LOC_DIR, "spatial_unit.parquet"))

    # Small integer ids keep every fact row narrow.
    snaps = sorted(twp["snapshot"].unique())
    snap_id = {s: i for i, s in enumerate(snaps)}
    tr_keys = sorted(k for k in twp["tr_key"].unique() if k and k != "UNASSIGNED")
    twp_id = {k: i for i, k in enumerate(tr_keys)}
    twp_id["UNASSIGNED"] = len(tr_keys)

    twp["u"] = twp["tr_key"].map(twp_id).astype("int16")
    twp["s"] = twp["snapshot"].map(snap_id).astype("int8")
    twp_flow["u"] = twp_flow["tr_key"].map(twp_id).astype("int16")
    twp_flow["i"] = twp_flow["interval"].astype("int8")
    cty["s"] = cty["snapshot"].map(snap_id).astype("int8")

    # ---- township topics
    for topic, cols in TOPICS.items():
        have = [c for c in cols if c in twp.columns]
        if not have:
            continue
        sub = twp[["u", "s"] + have]
        files[f"twp_{topic}"] = _write(
            sub, os.path.join(out_dir, f"twp_{topic}.parquet"),
            delta_on="s" if delta else None, key="u")

    have = [c for c in FLOW_COLS if c in twp_flow.columns]
    files["twp_flow"] = _write(twp_flow[["u", "i"] + have],
                               os.path.join(out_dir, "twp_flow.parquet"))

    # ---- county stock and flow: small enough to keep whole
    cty_cols = [c for c in cty.columns if c not in ("snapshot", "s", "county_n")]
    files["county_stock"] = _write(cty[["county_n", "s"] + cty_cols],
                                   os.path.join(out_dir, "county_stock.parquet"))
    # Normalise the interval key to `i`, matching the township tables, and drop
    # first_mapping_share: it is first_mapping / created, and a derivable has no
    # business on the wire.
    cf = (cty_flow.rename(columns={"interval": "i"})
          .drop(columns=[c for c in ("first_mapping_share",) if c in cty_flow.columns]))
    files["county_flow"] = _write(cf, os.path.join(out_dir, "county_flow.parquet"))

    # ---- the full owner-origin matrix at county grain
    cs = cty_state.copy()
    cs["s"] = cs["snapshot"].map(snap_id).astype("int8")
    states = sorted(cs["state"].unique())
    st_id = {s: i for i, s in enumerate(states)}
    cs["st"] = cs["state"].map(st_id).astype("int16")
    files["county_owner_state"] = _write(cs[["county_n", "s", "st", "parcels", "acres"]],
                                         os.path.join(out_dir, "county_owner_state.parquet"))

    # ---- per-state township detail, fetched only when a state is selected
    ts = twp_state.copy()
    ts["u"] = ts["tr_key"].map(twp_id)
    ts = ts[ts["u"].notna()]
    ts["u"] = ts["u"].astype("int16")
    ts["s"] = ts["snapshot"].map(snap_id).astype("int8")
    st_dir = os.path.join(out_dir, "owner_state")
    shutil.rmtree(st_dir, ignore_errors=True)
    os.makedirs(st_dir, exist_ok=True)
    per_state = {}
    for st, grp in ts.groupby("state"):
        if not isinstance(st, str) or len(st) != 2:
            continue
        info = _write(grp[["u", "s", "parcels", "acres", "private_parcels"]],
                      os.path.join(st_dir, f"{st}.parquet"))
        per_state[st] = info["bytes"]
    files["owner_state_dir"] = {"states": len(per_state),
                                "bytes": int(sum(per_state.values())),
                                "largest": sorted(per_state.items(),
                                                  key=lambda x: -x[1])[:5]}

    # ---- planning analytics
    for name, src in (("absorption", "absorption.parquet"),
                      ("size_histogram", "size_histogram.parquet"),
                      ("dormant", "dormant.parquet"),
                      ("dormant_by_size", "dormant_by_size.parquet")):
        p = os.path.join(LADDER_DIR, src)
        if not os.path.exists(p):
            continue
        d = pd.read_parquet(p)
        if "cohort_date" in d.columns:
            d["cohort"] = d["cohort_date"].map(snap_id)
            d["observed"] = d["observed_date"].map(snap_id)
            d = d.drop(columns=[c for c in ("cohort_date", "observed_date",
                                            "first_idx", "observed_idx") if c in d])
        for c in d.columns:
            if str(d[c].dtype) == "category":
                d[c] = d[c].astype(str)
        files[name] = _write(d, os.path.join(out_dir, f"{name}.parquet"))

    # ---- geometry
    for g in ("townships.geojson", "counties.geojson"):
        src = os.path.join(LOC_DIR, g)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(out_dir, g))
            files[g] = {"bytes": os.path.getsize(os.path.join(out_dir, g))}

    # ---- dimensions
    snap_meta = []
    iv_qa = json.load(open(os.path.join(EVENT_DIR, "qa_intervals.json")))
    for s in snaps:
        snap_meta.append({"id": snap_id[s], "date": s,
                          "era": sources.era_of(s)})
    intervals = [{"id": r["interval"], "a": snap_id.get(r["date_a"]),
                  "b": snap_id.get(r["date_b"]), "days": r["days"],
                  "years": round(r["years"], 4)} for r in iv_qa]
    twp_label = (units.drop_duplicates("tr_key").set_index("tr_key")
                 [["label", "land_km2", "lon", "lat"]])
    townships = []
    for k in tr_keys:
        row = twp_label.loc[k] if k in twp_label.index else None
        townships.append({
            "id": twp_id[k], "tr": k,
            "label": (str(row["label"]) if row is not None else k),
            "km2": (round(float(row["land_km2"]), 2) if row is not None else None),
        })
    dim = {
        "snapshots": snap_meta, "intervals": intervals,
        "counties": [{"code": c, "name": COUNTY_PREFIX[c][0], "abbr": COUNTY_PREFIX[c][1]}
                     for c in sorted(COUNTY_PREFIX)],
        "townships": townships,
        "states": states,
        "labels": {
            "size": ["unknown", "<1", "1-5", "5-20", "20-40", "40-160", "160-640", ">640"],
            "locality": locality.LEVELS,
            "locality_robust": locality.ROBUST_LEVELS,
            "tenure": oc.TENURE,
            "owner_class": oc.CLASSES,
            "dev_stage": ["platted_only", "addressed_not_built", "built", "unknown"],
            "owner_origin": STATE_BUCKETS,
        },
        "delta_coded": bool(delta),
    }
    with open(os.path.join(out_dir, "dim.json"), "w") as fh:
        json.dump(dim, fh, separators=(",", ":"))
    files["dim.json"] = {"bytes": os.path.getsize(os.path.join(out_dir, "dim.json"))}

    cov = json.load(open(os.path.join(COVER_DIR, "qa_coverage.json")))
    lad = json.load(open(os.path.join(LADDER_DIR, "qa_ladder.json")))
    facts_qa = json.load(open(os.path.join(FACT_DIR, "qa_facts.json")))
    meta = {
        "title": "Montana cadastral change, 2003-2026",
        "snapshots": len(snaps), "intervals": len(intervals),
        "townships": len(tr_keys), "counties": 56,
        "first_fully_covered_snapshot": cov.get("first_snapshot_fully_covered"),
        "comparable_series_begins": "2008",
        "owner_class_calibration": facts_qa.get("owner_class_calibration"),
        "tenure_note": facts_qa.get("tenure_note"),
        "dormant": {k: lad[k] for k in
                    ("dormant_parcels_total", "dormant_lt40ac_total",
                     "dormant_lt40ac_acres", "dormant_note") if k in lad},
        "thresholds": lad.get("thresholds", {}).get("edge_tests"),
        "caveats": [
            "2002 is excluded: it lacks Silver Bow, Yellowstone, Missoula, "
            "Gallatin and Flathead, exactly where parcels are created.",
            "2012 and 2015 do not exist; events spanning the gaps are 'observed "
            "during 2011-2013' and '2014-2016'.",
            "Owner location is a MAILING ADDRESS, not residence.",
            "The development ladder is probabilistic: a parcel with a house "
            "number carries an assessed building 89-91% of the time, but 30,812 "
            "parcels in 2026 have a building and no house number.",
            "Public-domain status comes from a single 2026 public-lands layer "
            "applied to every year.",
            "Tribal trust land is identified from owner names only; the "
            "public-lands layer carries none.",
            "The absentee 'local' tier is not comparable across 2009; use the "
            "three-tier collapse for any time series.",
            "2009-07-05 has a dead value block: improvement status is unknown, "
            "not zero.",
            "Events are inferred. 'Subdivision' is reserved for events "
            "corroborated by a subdivision or certificate-of-survey name.",
        ],
        "files": files,
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2, default=str)
    files["meta.json"] = {"bytes": os.path.getsize(os.path.join(out_dir, "meta.json"))}
    return {"files": files, "total_bytes": sum(
        v.get("bytes", 0) for v in files.values() if isinstance(v, dict))}


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Stage 7: publish the dashboard payload")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--no-delta", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    qa = build(args.out, delta=not args.no_delta)
    for name, info in sorted(qa["files"].items(), key=lambda x: -x[1].get("bytes", 0)):
        b = info.get("bytes", 0)
        log.info("  %-24s %8s KB  %s", name, f"{b // 1024:,}",
                 f"{info.get('rows', ''):>9} rows" if info.get("rows") else "")
    log.info("payload total %.2f MB raw", qa["total_bytes"] / 1e6)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
