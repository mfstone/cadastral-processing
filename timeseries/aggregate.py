"""Stage 6: aggregate the four entities into publishable fact tables.

Everything published is an aggregation over ``parcel_snapshot``,
``owner_interest_snapshot``, ``change_event`` and ``spatial_unit`` -- nothing
else. Adding a research question later means writing a new aggregation here, not
a new pipeline.

Two spatial keys, because they answer different questions. The **analytic** key
is county + township code, which makes county rollups reconcile exactly; the
**display** key is the PLSS township polygon (``tr_key``). The locator crosswalk
maps one to the other, so a township straddling a county line contributes to
both counties and is drawn once.

A unit with no township/range attribute in *any* snapshot gets no display key.
Those parcels are bucketed under ``UNASSIGNED`` rather than dropped, so the
township grain reconciles exactly with the county grain -- 45 to 68 parcels per
snapshot, which is immaterial in magnitude but must still be *accounted*, since
a silently short total is indistinguishable from a correct one.

Nothing derivable is shipped. No rates (ship counts plus the interval's real day
count and divide in the client), no shares, no acres-per-parcel. A shipped
derivable is how a payload bloats, and a rate hides the denominator that makes it
interpretable.
"""

from __future__ import annotations

import glob
import json
import logging
import os

import numpy as np
import pandas as pd

from . import locality
from . import ownerclass as oc

log = logging.getLogger("timeseries.aggregate")

SNAP_DIR = "data/snapshots"
EVENT_DIR = "data/events"
COVER_DIR = "data/coverage"
LOC_DIR = "data/locator"
OUT_DIR = "data/facts"

# Parcel-size classes in acres. Bin 0 is reserved for unknown/zero so that a
# null area neither vanishes nor inflates the smallest real class; the minimum
# observed area is 3.6e-7 acres, so slivers are counted, not binned.
SIZE_EDGES = [0.0, 1.0, 5.0, 20.0, 40.0, 160.0, 640.0, np.inf]
SIZE_LABELS = ["unknown", "lt1", "1_5", "5_20", "20_40", "40_160", "160_640", "gt640"]

# Origin buckets at township grain, to keep the row narrow. The full ~55-state
# matrix is published at county grain, where it costs nothing.
TOP_STATES = ["CA", "WA", "TX", "CO", "FL", "AZ", "ID", "UT", "WY"]

# Display key for parcels whose unit never carried a township/range attribute.
UNASSIGNED = "UNASSIGNED"


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


def size_bin(acres: pd.Series) -> np.ndarray:
    """Bin index 0..7; 0 means unknown or non-positive."""
    a = acres.to_numpy(dtype="float64")
    out = np.zeros(len(a), dtype="int8")
    good = np.isfinite(a) & (a > 0)
    out[good] = np.digitize(a[good], SIZE_EDGES[1:], right=True) + 1
    return np.clip(out, 0, 7)


def state_bucket(state: pd.Series) -> np.ndarray:
    """0 = MT, 1..9 = TOP_STATES, 10 = other US, 11 = unknown/invalid."""
    s = state.fillna("").to_numpy()
    valid = np.fromiter((len(x) == 2 and x.isalpha() for x in s), dtype=bool, count=len(s))
    out = np.full(len(s), 11, dtype="int8")
    out[valid] = 10
    out[s == "MT"] = 0
    for i, st in enumerate(TOP_STATES, start=1):
        out[s == st] = i
    return out


def _counts(frame: pd.DataFrame, key: str, col: str, n: int, prefix: str) -> pd.DataFrame:
    """Pivot a small integer category into fixed-width count columns."""
    t = frame.pivot_table(index=key, columns=col, values="_one", aggfunc="sum",
                          fill_value=0)
    t = t.reindex(columns=range(n), fill_value=0)
    t.columns = [f"{prefix}{i}" for i in range(n)]
    return t.astype("int32")


def build_city_county(snap_dir: str, dates: list[str]) -> pd.Series:
    """City-to-county map for the absentee gradient, pooled over snapshots."""
    frames = []
    for d in dates:
        frames.append(pd.read_parquet(os.path.join(snap_dir, f"parcels_{d}.parquet"),
                                      columns=["situs_city", "county_n"]))
    return locality.city_county_map(frames)


def stock_tables(snap_dir: str, units: pd.DataFrame,
                 city_county: pd.Series) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Per-snapshot stock at township (display) and county grain.

    Also emits a township x snapshot x owner-state table, which is what lets the
    dashboard filter on any specific owner origin rather than only the handful of
    buckets that fit in a fixed-width row.
    """
    code_to_tr = units.set_index("unit")["tr_key"]
    twp_rows, cty_rows, state_rows, twp_state_rows = [], [], [], []
    for path in sorted(glob.glob(os.path.join(snap_dir, "parcels_*.parquet"))):
        date = os.path.basename(path)[len("parcels_"):-len(".parquet")]
        df = pd.read_parquet(path, columns=[
            "county", "twp_code", "section", "quarter", "county_n", "acres",
            "owner_state", "improved", "is_condo", "owner_is_entity", "subdivision",
            "owner_city", "situs_city", "owner_name_norm", "dev_stage", "is_ag",
            "ag_acres", "has_situs_addr", "has_house_number"])
        loc_code = locality.classify(df, city_county)
        cls_code, _rule = oc.classify(df["owner_name_norm"])
        ag_biz = oc.ag_business_name(df["owner_name_norm"])
        unit = df["county"].fillna("") + df["twp_code"].fillna("")
        f = pd.DataFrame({
            "unit": unit,
            "tr_key": unit.map(code_to_tr),
            "county_n": df["county_n"],
            "acres": df["acres"].astype("float64"),
            "qk": unit + df["section"].fillna("") + df["quarter"].fillna(""),
            "sz": size_bin(df["acres"]),
            "sb": state_bucket(df["owner_state"]),
            "improved": df["improved"].astype("int8"),
            "is_condo": df["is_condo"].to_numpy(dtype=bool),
            "is_entity": df["owner_is_entity"].to_numpy(dtype=bool),
            "named_subdiv": (df["subdivision"].fillna("") != "").to_numpy(dtype=bool),
            "state": df["owner_state"].fillna(""),
            "loc": loc_code,
            "oc": cls_code,
            "dev": _dev_stage(df),   # derived, see _dev_stage
            "is_ag": df["is_ag"].to_numpy(dtype=bool),
            "ag_acres": df["ag_acres"].astype("float64"),
            "ag_biz": ag_biz,
            "is_public": oc.is_public(cls_code),
            "has_addr": df["has_situs_addr"].to_numpy(dtype=bool),
            "has_num": df["has_house_number"].to_numpy(dtype=bool),
        })
        f["_one"] = 1
        # dev_stage uses -1 for "unknown", which cannot index a pivot column.
        f["dev_idx"] = f["dev"].replace({-1: 3}).astype("int8")

        # Unmappable units are bucketed, never dropped, so the two grains agree.
        f["tr_key"] = f["tr_key"].fillna(UNASSIGNED)
        for key, sink in (("tr_key", twp_rows), ("county_n", cty_rows)):
            sub = f[f[key].notna()]
            base = sub.groupby(key).agg(
                parcels=("_one", "sum"), acres=("acres", "sum"),
                quarters=("qk", "nunique"), n_condo=("is_condo", "sum"),
                n_entity=("is_entity", "sum"), n_named_subdiv=("named_subdiv", "sum"),
                n_improved=("improved", lambda s: int((s == 1).sum())),
                n_unimproved=("improved", lambda s: int((s == 0).sum())),
                n_improve_unknown=("improved", lambda s: int((s == -1).sum())),
                n_ag=("is_ag", "sum"), ag_acres=("ag_acres", "sum"),
                n_ag_business=("ag_biz", "sum"), n_public=("is_public", "sum"),
                n_with_addr=("has_addr", "sum"), n_with_house_number=("has_num", "sum"),
                acres_public=("acres", lambda s: 0.0),
            )
            # Public/private acreage split: 13.2% of parcels hold 40.2% of the
            # acreage, so no acreage statistic is meaningful without it.
            pubac = sub.groupby([key, "is_public"])["acres"].sum().unstack(fill_value=0.0)
            base["acres_public"] = pubac.get(True, 0.0)
            base["acres_private"] = pubac.get(False, 0.0)
            szc = _counts(sub, key, "sz", 8, "n_sz")
            sza = sub.pivot_table(index=key, columns="sz", values="acres",
                                  aggfunc="sum", fill_value=0.0)
            sza = sza.reindex(columns=range(8), fill_value=0.0)
            sza.columns = [f"ac_sz{i}" for i in range(8)]
            sbc = _counts(sub, key, "sb", 12, "n_st")
            locc = _counts(sub, key, "loc", locality.N_LEVELS, "n_loc")
            loca = sub.pivot_table(index=key, columns="loc", values="acres",
                                  aggfunc="sum", fill_value=0.0)
            loca = loca.reindex(columns=range(locality.N_LEVELS), fill_value=0.0)
            loca.columns = [f"ac_loc{i}" for i in range(locality.N_LEVELS)]
            occ = _counts(sub, key, "oc", oc.N_CLASSES, "n_oc")
            devc = _counts(sub, key, "dev_idx", 4, "n_dev")
            deva = sub.pivot_table(index=key, columns="dev_idx", values="acres",
                                  aggfunc="sum", fill_value=0.0)
            deva = deva.reindex(columns=range(4), fill_value=0.0)
            deva.columns = [f"ac_dev{i}" for i in range(4)]
            out = (base.join(szc).join(sza.astype("float32")).join(sbc)
                   .join(locc).join(loca.astype("float32")).join(occ)
                   .join(devc).join(deva.astype("float32")).reset_index())
            out["snapshot"] = date
            sink.append(out)

        # Full state matrix, county grain only.
        sm = (f[f["state"] != ""].groupby(["county_n", "state"])
              .agg(parcels=("_one", "sum"), acres=("acres", "sum")).reset_index())
        sm["snapshot"] = date
        state_rows.append(sm)

        # Township x owner-state, so any specific origin can be selected. Kept
        # long and sparse: most townships draw owners from a handful of states.
        ts = (f[(f["state"] != "") & f["tr_key"].notna()]
              .groupby(["tr_key", "state"])
              .agg(parcels=("_one", "sum"), acres=("acres", "sum"),
                   private_parcels=("is_public", lambda s: int((~s).sum()))).reset_index())
        ts["snapshot"] = date
        twp_state_rows.append(ts)
        log.info("  stock %s", date)

    return (pd.concat(twp_rows, ignore_index=True),
            pd.concat(cty_rows, ignore_index=True),
            pd.concat(state_rows, ignore_index=True),
            pd.concat(twp_state_rows, ignore_index=True))


def flow_tables(event_dir: str, units: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Per-interval flow at township and county grain."""
    code_to_tr = units.set_index("unit")["tr_key"]
    twp, cty = [], []
    for epath in sorted(glob.glob(os.path.join(event_dir, "events_*.parquet"))):
        base = os.path.basename(epath)[:-len(".parquet")]
        parts = base.split("_")
        idx, da, db = int(parts[1]), parts[2], parts[3]
        ev = pd.read_parquet(epath)
        tpath = os.path.join(event_dir, f"transitions_{idx:02d}_{da}_{db}.parquet")
        tr = pd.read_parquet(tpath)

        for key, sink in (("tr_key", twp), ("county_n", cty)):
            if ev.empty:
                sink.append(pd.DataFrame())
                continue
            e = ev.copy()
            e["unit"] = e["township_key"]
            e["tr_key"] = e["unit"].map(code_to_tr).fillna(UNASSIGNED)
            e["county_n"] = pd.to_numeric(e["unit"].str.slice(0, 2), errors="coerce")
            e["_one"] = 1
            sub = e[e[key].notna()]
            g = sub.groupby(key)
            agg = g.agg(
                created=("_one", "sum"), acres_created=("acres", "sum"),
                lot_created=("event_class", lambda s: int((s == "lot_created").sum())),
                block_created=("event_class", lambda s: int((s == "block_created").sum())),
                unit_created=("event_class", lambda s: int((s == "unit_created").sum())),
                first_mapping=("event_class", lambda s: int((s == "first_mapping").sum())),
                conf_high=("confidence", lambda s: int((s == "high").sum())),
                conf_medium=("confidence", lambda s: int((s == "medium").sum())),
                is_subdivision=("is_subdivision", "sum"),
            )
            t = tr.copy()
            t["unit"] = t["township_key"]
            t["tr_key"] = t["unit"].map(code_to_tr).fillna(UNASSIGNED)
            t["county_n"] = pd.to_numeric(t["unit"].str.slice(0, 2), errors="coerce")
            ts = t[t[key].notna()].groupby(key).agg(
                persisted=("owner_changed", "size"),
                owner_changed=("owner_changed", "sum"),
                transfers_out_of_state=("transfer_to_other_state", "sum"),
                address_change_only=("address_change_only", "sum"),
                to_CA=("state_to", lambda s: 0), )
            # to/from CA need the transfer mask, so compute separately.
            tt = t[t[key].notna()]
            ca = tt.groupby(key).apply(
                lambda d: pd.Series({
                    "to_CA": int(((d["state_to"] == "CA") & d["transfer_to_other_state"]).sum()),
                    "from_CA": int(((d["state_from"] == "CA") & d["transfer_to_other_state"]).sum()),
                }), include_groups=False)
            ts = ts.drop(columns=["to_CA"]).join(ca)
            out = agg.join(ts, how="outer").fillna(0).reset_index()
            out["interval"] = idx
            sink.append(out)
        log.info("  flow interval %02d %s -> %s", idx, da, db)
    return (pd.concat([x for x in twp if len(x)], ignore_index=True),
            pd.concat([x for x in cty if len(x)], ignore_index=True))


def build(out_dir: str = OUT_DIR) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    units = pd.read_parquet(os.path.join(LOC_DIR, "spatial_unit.parquet"))
    all_dates = sorted(os.path.basename(p)[len("parcels_"):-len(".parquet")]
                       for p in glob.glob(os.path.join(SNAP_DIR, "parcels_*.parquet")))
    log.info("city-to-county map for the absentee gradient")
    city_county = build_city_county(SNAP_DIR, all_dates[-6:])
    log.info("  %d cities mapped", len(city_county))
    log.info("stock tables")
    twp_stock, cty_stock, state_stock, twp_state = stock_tables(SNAP_DIR, units, city_county)
    log.info("flow tables")
    twp_flow, cty_flow = flow_tables(EVENT_DIR, units)

    cov_snap = pd.read_parquet(os.path.join(COVER_DIR, "coverage_snapshot.parquet"))
    cov_iv = pd.read_parquet(os.path.join(COVER_DIR, "coverage_interval.parquet"))
    cty_stock = cty_stock.merge(
        cov_snap[["county_n", "snapshot", "coverage_ok", "n_indicators_failed"]],
        on=["county_n", "snapshot"], how="left")
    cty_flow = cty_flow.merge(
        cov_iv[["county_n", "interval", "comparable", "first_mapping_share"]],
        on=["county_n", "interval"], how="left")

    # A township inherits its county's gate; where it straddles, the stricter wins.
    u = units[["unit", "tr_key", "county_n"]].dropna()
    tr_cty = u.groupby("tr_key")["county_n"].apply(list)
    cov_lookup = cov_snap.set_index(["county_n", "snapshot"])["coverage_ok"]
    twp_stock["coverage_ok"] = [
        all(bool(cov_lookup.get((c, s), False)) for c in tr_cty.get(t, []))
        if t in tr_cty.index else False
        for t, s in zip(twp_stock["tr_key"], twp_stock["snapshot"])]
    iv_lookup = cov_iv.set_index(["county_n", "interval"])["comparable"]
    twp_flow["comparable"] = [
        all(bool(iv_lookup.get((c, i), False)) for c in tr_cty.get(t, []))
        if t in tr_cty.index else False
        for t, i in zip(twp_flow["tr_key"], twp_flow["interval"])]

    # Tier-1 invariant: the two grains must agree, snapshot by snapshot.
    a = twp_stock.groupby("snapshot")["parcels"].sum()
    b = cty_stock.groupby("snapshot")["parcels"].sum()
    bad = {s_: (int(a[s_]), int(b[s_])) for s_ in a.index if int(a[s_]) != int(b.get(s_, -1))}
    if bad:
        raise AssertionError(f"township/county parcel totals disagree: {bad}")
    log.info("  invariant OK: township and county parcel totals agree in all %d snapshots",
             len(a))
    n_unassigned = int(twp_stock.loc[twp_stock["tr_key"] == UNASSIGNED, "parcels"].sum())

    files = {}
    for name, df in (("stock_township", twp_stock), ("stock_county", cty_stock),
                     ("stock_county_state", state_stock),
                     ("stock_township_state", twp_state),
                     ("flow_township", twp_flow), ("flow_county", cty_flow)):
        p = os.path.join(out_dir, f"{name}.parquet")
        df.to_parquet(p, index=False, compression="zstd")
        files[name] = {"rows": int(len(df)), "cols": int(df.shape[1]),
                       "bytes": os.path.getsize(p)}
        log.info("  %-20s %8s rows x %3d cols  %6s KB", name, f"{len(df):,}",
                 df.shape[1], f"{os.path.getsize(p) // 1024:,}")

    qa = {"files": files,
          "size_labels": SIZE_LABELS,
          "locality_levels": locality.LEVELS,
          "owner_classes": oc.CLASSES,
          "dev_stages": ["platted_only", "addressed_not_built", "built", "unknown"],
          "owner_class_calibration": oc.calibrate(
              pd.read_parquet(os.path.join(SNAP_DIR, "parcels_2006-07-14.parquet"),
                              columns=["owner_name_norm", "owner_class", "acres"])),
          "cities_mapped": int(len(city_county)),
          "state_buckets": ["MT"] + TOP_STATES + ["other_us", "unknown"],
          "township_units": int(twp_stock["tr_key"].nunique()),
          "counties": int(cty_stock["county_n"].nunique()),
          "snapshots": int(cty_stock["snapshot"].nunique()),
          "intervals": int(cty_flow["interval"].nunique()),
          "total_bytes": sum(f["bytes"] for f in files.values()),
          "unassigned_parcel_snapshots": n_unassigned,
          "grain_invariant": "township and county parcel totals agree per snapshot"}
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Stage 6: aggregate to fact tables")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    qa = build(args.out)
    with open(os.path.join(args.out, "qa_facts.json"), "w") as fh:
        json.dump(qa, fh, indent=2, default=str)
    log.info("facts: %s townships x %s snapshots, %s counties, %s intervals, %s KB total",
             f"{qa['township_units']:,}", qa["snapshots"], qa["counties"],
             qa["intervals"], f"{qa['total_bytes'] // 1024:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
