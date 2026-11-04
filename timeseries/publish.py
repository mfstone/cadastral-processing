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

from . import locality, temporal, manifest
from . import ownerclass as oc
from . import sources
from . import cama

log = logging.getLogger("timeseries.publish")

FACT_DIR = "data/facts"
LOC_DIR = "data/locator"
LADDER_DIR = "data/ladder"
CAMA_DIR = "data/cama"
COVER_DIR = "data/coverage"
EVENT_DIR = "data/events"
OUT_DIR = "site/public/data"
# Owners who asked for their name not to be shown (one name per line, as the
# Holdings view shows it; optional county_n). Kept out of git: it is a list of
# people who asked not to be listed. See name_withheld.example.csv.
WITHHELD_CSV = "name_withheld.csv"
WITHHELD_LABEL = "Name withheld on request"

PARQUET_KW = dict(compression="gzip", index=False)

# Topic split for the township surface. Each view fetches only its own file.
TOPICS = {
    "core": ["parcels", "acres", "quarters", "n_condo", "n_named_subdiv",
             "coverage_ok"],
    "dev": [f"n_dev{i}" for i in range(5)] + [f"ac_dev{i}" for i in range(5)],
    "tenure": [f"n_ten{i}" for i in range(oc.N_TENURE)]
              + [f"ac_ten{i}" for i in range(oc.N_TENURE)] + ["n_on_public_land"],
    "locality": [f"n_loc{i}" for i in range(locality.N_LEVELS)]
                + [f"ac_loc{i}" for i in range(locality.N_LEVELS)],
    "size": [f"n_sz{i}" for i in range(8)] + [f"ac_sz{i}" for i in range(8)],
    "class": [f"n_oc{i}" for i in range(oc.N_CLASSES)],
    "owner_origin": [f"n_st{i}" for i in range(12)],
    "ag": ["n_ag", "ag_acres", "n_ag_business", "ag_available"],
    "improve": ["n_improved", "n_unimproved", "n_improve_unknown",
                "n_with_addr", "n_with_house_number"],
}
FLOW_COLS = ["created", "retired", "persisted", "lot_created", "block_created",
             "unit_created", "first_mapping", "conf_high", "conf_medium",
             "is_subdivision", "divided", "divided_plat", "divided_amended", "divided_cos",
             "acres_created", "owner_changed",
             "transfers_out_of_state", "address_change_only", "to_CA", "from_CA",
             "comparable"]

STATE_BUCKETS = ["MT", "CA", "WA", "TX", "CO", "FL", "AZ", "ID", "UT", "WY",
                 "other_us", "unknown"]


def _norm_name(v) -> str:
    return " ".join(str(v or "").upper().split())


def withhold_names(top: pd.DataFrame, path: str = WITHHELD_CSV) -> tuple[pd.DataFrame, int]:
    """Replace the names (and mailing city and state) of owners on the withheld
    list with WITHHELD_LABEL, in every county and vintage, or only in the
    county given. Matching ignores case and spacing. Returns (table, rows hit)."""
    if not os.path.exists(path):
        return top, 0
    w = pd.read_csv(path, dtype=str).fillna("")
    if "name" not in w.columns:
        raise ValueError(f"{path} needs a 'name' column")
    every = {_norm_name(n) for n, c in zip(w["name"], w.get("county_n", [""] * len(w))) if n.strip() and not c.strip()}
    by_county = {(_norm_name(n), int(c)) for n, c in zip(w["name"], w.get("county_n", [""] * len(w)))
                 if n.strip() and c.strip()}
    names = top["display_name"].map(_norm_name)
    hit = names.isin(every) | pd.Series([(n, int(c)) in by_county for n, c in zip(names, top["county_n"])],
                                        index=top.index, dtype=bool)
    top = top.copy()
    top.loc[hit, "display_name"] = WITHHELD_LABEL
    for c in ("display_city", "display_state"):
        if c in top.columns:
            top.loc[hit, c] = ""
    return top, int(hit.sum())


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


def _lineage_meta() -> dict | None:
    """The presence and event QA, summarised: what the identifier model saw."""
    pq = os.path.join(EVENT_DIR, "qa_presence.json")
    iq = os.path.join(EVENT_DIR, "qa_intervals.json")
    if not (os.path.exists(pq) and os.path.exists(iq)):
        return None
    pres = json.load(open(pq))
    ivs = json.load(open(iq))
    cons = [q.get("area_conservation") for q in ivs if q.get("area_conservation")]
    out = {
        "snapshots": pres.get("snapshots"), "bitmap_bits": pres.get("bitmap_bits"),
        "parcel_ids": pres.get("parcel_ids"), "occurrences": pres.get("occurrences"),
        "resurrected_ids": pres.get("resurrected_ids"),
        "reused_id_creations": pres.get("reused_id_creations"),
        "note": pres.get("note"),
    }
    if cons:
        p90 = [c["p90"] for c in cons if c.get("p90") is not None]
        p99 = [c["p99"] for c in cons if c.get("p99") is not None]
        w5 = [c["within_5pct"] for c in cons if c.get("within_5pct") is not None]
        w1 = [c["within_1pct"] for c in cons if c.get("within_1pct") is not None]
        ec = [c["event_quarters_conserved"] for c in cons if c.get("event_quarters_conserved") is not None]
        out["area_conservation"] = {
            "intervals": len(cons),
            "median_ratio_range": [min(q["quarter_acres_ratio_median"] for q in ivs if q.get("quarter_acres_ratio_median") is not None),
                                   max(q["quarter_acres_ratio_median"] for q in ivs if q.get("quarter_acres_ratio_median") is not None)],
            "p90_range": [min(p90), max(p90)] if p90 else None,
            "p99_range": [min(p99), max(p99)] if p99 else None,
            "within_1pct_range": [min(w1), max(w1)] if w1 else None,
            "within_5pct_range": [min(w5), max(w5)] if w5 else None,
            "event_quarters_conserved_range": [min(ec), max(ec)] if ec else None,
            "note": "per interval, over quarter-sections with parcels at both ends; the median "
                    "says nothing about the tails, which are reported here",
        }
    return out


def build(out_dir: str = OUT_DIR, delta: bool = True) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    files: dict[str, dict] = {}

    twp = pd.read_parquet(os.path.join(FACT_DIR, "stock_township.parquet"))
    cty = pd.read_parquet(os.path.join(FACT_DIR, "stock_county.parquet"))
    twp_flow = pd.read_parquet(os.path.join(FACT_DIR, "flow_township.parquet"))
    cty_flow = pd.read_parquet(os.path.join(FACT_DIR, "flow_county.parquet"))
    cty_state = pd.read_parquet(os.path.join(FACT_DIR, "stock_county_state.parquet"))
    twp_state = pd.read_parquet(os.path.join(FACT_DIR, "stock_township_state.parquet"))
    res_path = os.path.join(FACT_DIR, "stock_reservation.parquet")
    res_stock = pd.read_parquet(res_path) if os.path.exists(res_path) else pd.DataFrame()
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

    # ---- reservations: jurisdiction crossed with tenure, i.e. the checkerboard
    if len(res_stock):
        rs = res_stock.copy()
        rs["s"] = rs["snapshot"].map(snap_id).astype("int8")
        names = sorted(rs["reservation"].unique())
        rs["r"] = rs["reservation"].map({n: i for i, n in enumerate(names)}).astype("int8")
        files["reservation_stock"] = _write(
            rs[["r", "s", "ten", "parcels", "acres"]],
            os.path.join(out_dir, "reservation_stock.parquet"))
        reservation_names = names
    else:
        reservation_names = []

    # ---- planning analytics
    for name, src in (("absorption", "absorption.parquet"),
                      ("absorption_survival", "absorption_survival.parquet"),
                      ("size_histogram", "size_histogram.parquet"),
                      ("threshold_edges", "threshold_edges.parquet"),
                      ("county_size_histogram", "county_size_histogram.parquet"),
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

    # ---- the DOR's building records (stage 11): dwelling condition and year
    # built, one cross-section, with the witness counts against the ladder.
    # The township table arrives keyed on tr_key and is keyed to `u` here
    # like every other township table.
    cama_meta = {}
    cq_path = os.path.join(CAMA_DIR, "qa_cama.json")
    if os.path.exists(cq_path):
        ct = pd.read_parquet(os.path.join(CAMA_DIR, "cama_township.parquet"))
        ct["u"] = ct["tr_key"].map(twp_id)
        ct = ct[ct["u"].notna()].copy()
        ct["u"] = ct["u"].astype("int16")
        files["cama_township"] = _write(ct.drop(columns=["tr_key"]),
                                        os.path.join(out_dir, "cama_township.parquet"))
        for name in ("cama_county", "cama_timing", "cama_condition_decade", "cama_transitions"):
            files[name] = _write(pd.read_parquet(os.path.join(CAMA_DIR, f"{name}.parquet")),
                                 os.path.join(out_dir, f"{name}.parquet"))
        cq = json.load(open(cq_path))
        newest = cq["points"][-1]
        orion_keys = ("tax_year", "rating_field", "dwelling_rows", "dwelling_rows_with_cdu",
                      "dwelling_rows_with_phycondition", "properties_with_dwelling")
        cama_meta = {
            "date": cq["date"], "tax_year": cq["tax_year"], "refresh_date": newest["refresh_date"],
            "rating_field": newest["rating_field"], "note": cq["note"],
            # the newest point in full, every point compactly, and the transitions
            "series": cq["series"], "orion": newest["orion"], "join": newest["join"],
            "witness": newest["witness"],
            "points": [{"tax_year": p["tax_year"], "date": p["date"], "s": p["s"],
                        "refresh_date": p["refresh_date"], "rating_field": p["rating_field"],
                        "orion": {k: p["orion"].get(k) for k in orion_keys},
                        "witness": p["witness"]} for p in cq["points"]],
            "transitions": cq["transitions"],
        }

    # ---- large private holdings (stage 10). County grain only -- the paper's
    # unit -- with county_n 0 carrying the statewide row. The top-holdings
    # table carries owner names: the only place the payload does, because a
    # review cannot be done against a hash. See docs/holdings_definitions.md.
    hold_meta = {}
    hc_path = os.path.join(FACT_DIR, "holdings_county.parquet")
    if os.path.exists(hc_path):
        hc = pd.concat([pd.read_parquet(hc_path), pd.read_parquet(os.path.join(FACT_DIR, "holdings_state.parquet"))],
                       ignore_index=True)
        hc["s"] = hc["snapshot"].map(snap_id)
        hc = hc[hc["s"].notna()].copy()
        hc["s"] = hc["s"].astype("int8")
        hcols = [c for c in hc.columns if c not in ("snapshot", "s", "county_n")]
        files["holdings_county"] = _write(hc[["county_n", "s"] + hcols],
                                          os.path.join(out_dir, "holdings_county.parquet"))
        top = pd.read_parquet(os.path.join(FACT_DIR, "holdings_top.parquet"))
        top["s"] = top["snapshot"].map(snap_id)
        top = top[top["s"].notna()].copy()
        top["s"] = top["s"].astype("int8")
        for c in ("strong", "token", "conflict", "oos", "is_entity"):
            top[c] = top[c].fillna(False).astype("int8")
        top["review_status"] = top["review_status"].fillna(0).astype("int8")
        tcols = ["county_n", "s", "rank", "display_name", "display_city", "display_state", "acres",
                 "acres_if_merged", "n_parcels", "is_entity", "review_status", "n_names",
                 "pending_links", "strong", "token", "conflict", "oos", "group_hash"]
        top, n_withheld = withhold_names(top)
        if n_withheld:
            log.info("holdings_top: %d rows withheld on request (%s)", n_withheld, WITHHELD_CSV)
        files["holdings_top"] = _write(top[tcols], os.path.join(out_dir, "holdings_top.parquet"))
        rv = pd.read_parquet(os.path.join(FACT_DIR, "holdings_review.parquet"))
        rv["s"] = rv["snapshot"].map(snap_id)
        rv = rv[rv["s"].notna()].copy()
        rv["s"] = rv["s"].astype("int8")
        files["holdings_review"] = _write(rv[["county_n", "s", "review_status", "owners", "acres"]],
                                          os.path.join(out_dir, "holdings_review.parquet"))
        hq_path = os.path.join(FACT_DIR, "qa_holdings.json")
        if os.path.exists(hq_path):
            hq = json.load(open(hq_path))
            hold_meta["tenure_method"] = {r["date"]: r.get("tenure_method") for r in hq}
            hold_meta["tenure_conflicts"] = {r["date"]: r.get("tenure_conflicts") for r in hq}
        rg_path = os.path.join(FACT_DIR, "regression_table1.csv")
        if os.path.exists(rg_path):
            rg = pd.read_csv(rg_path)
            # The per-county cells too, so the large-holdings report can show
            # the residual county by county rather than only the 13-county sum.
            name_to_code = {v[0]: k for k, v in COUNTY_PREFIX.items()}
            rt = rg.copy()
            rt["county_n"] = rt["county"].map(name_to_code)
            rt["s"] = rt["snapshot"].map(snap_id)
            rt = rt[rt["county_n"].notna() & rt["s"].notna()].copy()
            rt["county_n"] = rt["county_n"].astype("int16")
            rt["s"] = rt["s"].astype("int8")
            files["regression_table1"] = _write(
                rt[["county_n", "s", "T1_large_acres", "doc_large_acres", "max_large_acres",
                    "T1_owners", "doc_owners", "max_owners", "T1_mean", "doc_mean", "clo4"]],
                os.path.join(out_dir, "regression_table1.parquet"))
            hold_meta["regression"] = [
                {"snapshot": d, "counties": int(len(g)),
                 "paper_large_acres": float(g["T1_large_acres"].sum()),
                 "document_large_acres": float(g["doc_large_acres"].sum()),
                 "maximal_large_acres": float(g["max_large_acres"].sum()),
                 "paper_owners": int(g["T1_owners"].sum()),
                 "document_owners": int(g["doc_owners"].sum()),
                 "maximal_owners": int(g["max_owners"].sum())}
                for d, g in rg.groupby("snapshot")]

    # ---- geometry
    for g in ("townships.geojson", "counties.geojson",
              "reservations.geojson", "publiclands.geojson", "cities.geojson",
              "highways.geojson", "lidar_coverage.geojson"):
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
        "reservations": reservation_names,
        "labels": {
            "size": ["unknown", "<1", "1-5", "5-20", "20-40", "40-160", "160-640", ">640"],
            "locality": locality.LEVELS,
            "locality_robust": locality.ROBUST_LEVELS,
            "tenure": oc.TENURE,
            "owner_class": oc.CLASSES,
            "dev_stage": ["platted_only", "addressed_not_built", "built", "unknown",
                          "common_area"],
            "owner_origin": STATE_BUCKETS,
            "holding_size": ["<640", "640-2,560", "2,560-10,000", "10,000-50,000", ">50,000"],
            "review_status": ["clean", "merged by entity name", "name-token check",
                              "flagged for review", "reviewed: merged", "merged by ORION party id",
                              "reviewed: kept separate"],
            "condition": cama.CONDITION_LABELS,
            "year_built": cama.YB_LABELS,
        },
        "delta_coded": bool(delta),
    }
    with open(os.path.join(out_dir, "dim.json"), "w") as fh:
        json.dump(dim, fh, separators=(",", ":"))
    files["dim.json"] = {"bytes": os.path.getsize(os.path.join(out_dir, "dim.json"))}

    # Which published fields are unusable in which vintage. A dead field is not
    # a coverage problem and must not be reported as one: the 2009-07-05 export
    # ships its value block and its agricultural block entirely zero, so the
    # development ladder and agricultural acreage are *unknown* there while
    # every other measure in that snapshot is sound.
    avail = []
    for s_ in snaps:
        row = twp[twp["snapshot"] == s_]
        ladder = int(row[["n_dev0", "n_dev1", "n_dev2"]].to_numpy().sum()) > 0
        agric = int(row["ag_available"].sum()) > 0 if "ag_available" in row else True
        if not (ladder and agric):
            avail.append({
                "snapshot": snap_id[s_], "date": s_,
                "unavailable": ([] if ladder else ["development_ladder"])
                               + ([] if agric else ["agricultural_acreage"]),
                "reason": "this MSL export ships the affected columns entirely zero; "
                          "the values are unknown, not zero",
            })

    cov = json.load(open(os.path.join(COVER_DIR, "qa_coverage.json")))
    lad = json.load(open(os.path.join(LADDER_DIR, "qa_ladder.json")))
    facts_qa = json.load(open(os.path.join(FACT_DIR, "qa_facts.json")))
    lineage = _lineage_meta()
    tq = lad.get("thresholds", {})
    surv = lad.get("absorption_survival")
    meta = {
        "title": "Montana cadastral change, 2003-2026",
        "snapshots": len(snaps), "intervals": len(intervals),
        "townships": len(tr_keys), "counties": 56,
        "first_fully_covered_snapshot": cov.get("first_snapshot_fully_covered"),
        "comparable_series_begins": "2008",
        "field_availability": avail,
        "owner_class_calibration": facts_qa.get("owner_class_calibration"),
        "tenure_note": facts_qa.get("tenure_note"),
        "dormant": {k: lad[k] for k in
                    ("dormant_parcels_total", "dormant_lt40ac_total",
                     "dormant_lt40ac_acres", "dormant_note") if k in lad},
        "thresholds": tq.get("edge_tests"),
        "thresholds_sensitivity": {k: tq.get(k) for k in ("sensitivity", "controls", "by_era", "sensitivity_note")},
        "absorption_survival": ({k: surv[k] for k in ("creations_observed", "built_by_series_end",
                                                      "left_record_unbuilt", "unbuilt_under_observation", "note")}
                                | {"horizons": {h: {k: v for k, v in d.items() if k != "by_cohort"}
                                                for h, d in surv.get("horizons", {}).items()}}
                                if surv else None),
        "lineage": lineage,
        "temporal": temporal.registry(),
        "holdings": hold_meta,
        "cama": cama_meta,
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
            "applied to every year: a contemporary classification of historical "
            "parcels, so the tenure series describes the parcels inside what is "
            "public land today, not how much land was public in a given year.",
            "A geocode is an identifier, not a parcel: a number the DOR reissues "
            "after a gap is counted as a new parcel from its return"
            + (f" ({lineage['resurrected_ids']:,} such identifiers over the series)"
               if lineage and lineage.get("resurrected_ids") is not None else "") + ".",
            "The parcels drawn at depth are the newest export's. The map is today's "
            "fabric carrying historical attributes and first-seen outlines, not a "
            "reconstruction of the fabric at an earlier date.",
            "A reservation boundary is jurisdictional, not ownership: "
            "reservations hold large amounts of fee land from the allotment era, "
            "59% of Fort Peck by acreage.",
            "Tribal trust is identified from owner names, refined where three "
            "sources agree -- a bare-sovereign name, inside a reservation or on "
            "off-reservation trust land, and absent from the public-lands layer.",
            "The absentee 'local' tier is not comparable across 2009; use the "
            "three-tier collapse for any time series.",
            "2009-07-05 has a dead value block: improvement status is unknown, "
            "not zero.",
            "Events are inferred. 'Subdivision' is reserved for events "
            "corroborated by a subdivision or certificate-of-survey name.",
            "Holdings follow Haggerty et al. (2022): an owner's consolidated "
            "private acreage within a county, keyed on the mailing address with "
            "name bridges for entities and couples. The manual review the method "
            "requires is shown as a range (document tier to maximal tier) and as "
            "flags, never assumed.",
            "Dwelling condition and year built come from three ORION refreshes "
            "joined into eight tax years (2014, 2015-2018, 2024-2026), each to the "
            "parcel export carrying its roll. The rating is CDU, the composite, "
            "through 2014 and its physical-condition component after, when the "
            "DOR retired the composite by copying it into its components; it is "
            "the principal dwelling's on the parcel.",
        ],
        "files": files,
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2, default=str)
    files["meta.json"] = {"bytes": os.path.getsize(os.path.join(out_dir, "meta.json"))}
    # The release manifest last, over everything written above.
    manifest.build(out_dir)
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
