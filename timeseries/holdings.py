"""Stage 10: large private holdings and their concentration.

Definitions are those of Haggerty, Epstein, Gosnell, Rose & Stone (2022) and
are written out in ``docs/holdings_definitions.md``; anything beyond the paper
is labelled a choice there. In short:

* a **holding** is the consolidated private acreage of one owner group within
  one county (the paper's unit); a statewide holding per group is published
  beside it, never in place of it;
* **private** excludes public domain and tribal trust, with public domain
  decided by *location* -- the area-overlap stage where it has run, the
  representative-point stage otherwise -- and a straddling parcel contributes
  only its non-public acres;
* **large** is 640 acres or more;
* the concentration measures are the paper's: acres and owners in large
  holdings, their mean, the four-property ratio CLO4, the top-four acreage and
  the gap between the two largest holdings.

Every figure is computed on the document tier of :mod:`timeseries.identity`
and bracketed by the maximal tier, so the manual review the method requires is
*shown* as a range rather than silently assumed. Holdings that rest on a
pending review flag are counted and reported as provisional.
"""

from __future__ import annotations

import json
import logging
import os

import numpy as np
import pandas as pd

from cadastral.schema import COUNTY_PREFIX

from . import identity as I
from . import ownerclass as oc

log = logging.getLogger("timeseries.holdings")

SNAP_DIR = "data/snapshots"
ID_DIR = "data/identity"
TEN_DIR = "data/tenure"
PL_DIR = "data/publiclands"
RES_DIR = "data/reservations"
OUT_DIR = "data/facts"

LARGE_ACRES = 640.0
# Holding-size classes (choice): section, four sections, ~16 sections, beyond.
SIZE_EDGES = [0.0, 640.0, 2560.0, 10000.0, 50000.0, np.inf]
SIZE_LABELS = ["lt640", "640_2560", "2560_10k", "10k_50k", "gt50k"]
TOP_N = 10
LORENZ_PCTS = [1, 5, 10, 25, 50]
STATE_KEY = 0          # county_n used for the statewide rows
F_TENURE_CONFLICT = 1024   # point and area methods disagree on public status


def _gini(x: np.ndarray) -> float:
    x = np.sort(np.asarray(x, dtype="float64"))
    n = len(x)
    if n == 0 or x.sum() <= 0:
        return float("nan")
    cum = np.cumsum(x)
    return float((n + 1 - 2 * (cum / cum[-1]).sum()) / n)


def _top_shares(x: np.ndarray, pcts: list[int]) -> dict[int, float]:
    """Share of total held by the largest p% of holdings (at least one)."""
    x = np.sort(np.asarray(x, dtype="float64"))[::-1]
    tot = x.sum()
    out = {}
    for p in pcts:
        k = max(1, int(np.ceil(len(x) * p / 100.0)))
        out[p] = float(x[:k].sum() / tot) if tot > 0 else float("nan")
    return out


def load_private_parcels(date: str, snap_dir: str = SNAP_DIR, id_dir: str = ID_DIR,
                         ten_dir: str = TEN_DIR, pl_dir: str = PL_DIR,
                         res_dir: str = RES_DIR) -> tuple[pd.DataFrame, dict]:
    """Parcels of one snapshot with tenure decided and private acres attached."""
    p = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"),
                        columns=["parcel_id", "county_n", "acres", "owner_name_norm",
                                 "owner_blank", "owner_state"])
    o = pd.read_parquet(os.path.join(id_dir, f"owners_{date}.parquet"),
                        columns=["parcel_id", "group_id", "group_max", "flags"])
    d = p.merge(o, on="parcel_id", how="left")
    qa: dict = {"date": date, "parcels": int(len(d))}
    d["flags"] = d["flags"].fillna(0).astype("int32")
    d["group_id"] = d["group_id"].fillna(-1).astype("int32")
    d["group_max"] = d["group_max"].fillna(-1).astype("int32")

    pl_path = os.path.join(pl_dir, f"public_{date}.parquet")
    if os.path.exists(pl_path):
        pl = pd.read_parquet(pl_path, columns=["parcel_id", "on_public_land"]).set_index("parcel_id")
        onpl = d["parcel_id"].map(pl["on_public_land"]).fillna(False).to_numpy(dtype=bool)
    else:
        onpl = np.zeros(len(d), dtype=bool)
        log.warning("  %s: no point public-land join", date)
    res_path = os.path.join(res_dir, f"res_{date}.parquet")
    if os.path.exists(res_path):
        rs = pd.read_parquet(res_path).set_index("parcel_id")
        in_res = d["parcel_id"].map(rs["in_reservation"]).fillna(False).to_numpy(dtype=bool)
        off_tr = d["parcel_id"].map(rs["off_res_trust"]).fillna(False).to_numpy(dtype=bool)
    else:
        in_res = np.zeros(len(d), dtype=bool)
        off_tr = np.zeros(len(d), dtype=bool)
    cls, _ = oc.classify(d["owner_name_norm"])
    cls, _re = oc.refine_tribal(cls, d["owner_name_norm"], in_res, off_tr, onpl)
    # Tenure by name alone (agency names the layer misses, tribal trust); the
    # locational decision is made below by whichever method is on hand.
    ten_name = oc.tenure(cls, np.zeros(len(d), dtype=bool))
    tribal = ten_name == oc.TENURE.index("tribal_trust")
    public_name = ten_name == oc.TENURE.index("public_domain")

    ta_path = os.path.join(ten_dir, f"area_{date}.parquet")
    if os.path.exists(ta_path):
        ta = pd.read_parquet(ta_path, columns=["parcel_id", "public_fraction", "public_by_area"]).set_index("parcel_id")
        frac = d["parcel_id"].map(ta["public_fraction"]).fillna(0.0).to_numpy(dtype="float64")
        public_area = d["parcel_id"].map(ta["public_by_area"]).fillna(False).to_numpy(dtype=bool)
        qa["tenure_method"] = "area_overlap"
        # The area method decides location (docs/holdings_definitions.md); the
        # point label is compared and every disagreement is carried as a flag,
        # so a holding built on a disputed parcel shows up in the Review view.
        public_loc = public_area
        conflict = (public_area != onpl)
        d.loc[conflict, "flags"] = d.loc[conflict, "flags"] | F_TENURE_CONFLICT
        qa["tenure_conflicts"] = int(conflict.sum())
        qa["tenure_conflicts_private"] = int((conflict & ~public_area & ~public_name & ~tribal).sum())
    else:
        frac = np.where(onpl, 1.0, 0.0)
        public_loc = onpl.copy()
        qa["tenure_method"] = "representative_point"
    # Public by location, or by a public agency name the layer missed (the
    # 2,439 school districts and airport authorities), or tribal.
    non_private = public_loc | public_name | tribal | d["owner_blank"].fillna(False).to_numpy(dtype=bool)
    d["private"] = ~non_private
    acres = d["acres"].fillna(0).to_numpy(dtype="float64")
    d["private_acres"] = np.where(d["private"], acres * (1.0 - np.clip(frac, 0, 1)), 0.0)
    qa["private_parcels"] = int(d["private"].sum())
    qa["private_acres"] = float(d["private_acres"].sum())
    qa["acres_removed_from_straddlers"] = float((acres * np.clip(frac, 0, 1))[d["private"].to_numpy()].sum())
    qa["tribal_reclassified"] = int(_re.sum())
    return d, qa


def _holdings(d: pd.DataFrame, by_county: bool) -> pd.DataFrame:
    """One row per (county, group): the holding, with its review and tier bounds."""
    keys = ["county_n", "group_id"] if by_county else ["group_id"]
    mkeys = ["county_n", "group_max"] if by_county else ["group_max"]
    pv = d[d["private"] & (d["group_id"] >= 0)].copy()
    pv["_strong"] = (pv["flags"] & I.STRONG_PENDING) > 0
    pv["_token"] = (pv["flags"] & I.F_TOKEN_CHECK) > 0
    pv["_conflict"] = (pv["flags"] & F_TENURE_CONFLICT) > 0
    pv["_oos"] = (pv["owner_state"].fillna("") != "MT") & (pv["owner_state"].fillna("") != "")
    pv["_oos_acres"] = np.where(pv["_oos"], pv["private_acres"], 0.0)
    h = pv.groupby(keys).agg(
        acres=("private_acres", "sum"), n_parcels=("parcel_id", "size"),
        strong=("_strong", "max"), token=("_token", "max"), conflict=("_conflict", "max"),
        oos_acres=("_oos_acres", "sum"), group_max=("group_max", "first"),
    ).reset_index()
    mx = pv.groupby(mkeys)["private_acres"].sum().rename("acres_if_merged").reset_index()
    h = h.merge(mx, on=mkeys, how="left")
    h["oos"] = h["oos_acres"] > 0.5 * h["acres"]
    h["large"] = h["acres"] >= LARGE_ACRES
    h["size_class"] = np.digitize(h["acres"].to_numpy(), SIZE_EDGES[1:], right=False).astype("int8")
    if not by_county:
        h["county_n"] = STATE_KEY
    return h


def _metrics(h: pd.DataFrame, key_col: str = "county_n") -> pd.DataFrame:
    rows = []
    for key, g in h.groupby(key_col):
        a = g["acres"].to_numpy(dtype="float64")
        big = g[g["large"]].sort_values("acres", ascending=False)
        ba = big["acres"].to_numpy(dtype="float64")
        # maximal tier: large holdings when every pending flag is accepted
        gm = g.drop_duplicates("group_max")["acres_if_merged"].to_numpy(dtype="float64")
        gm_big = gm[gm >= LARGE_ACRES]
        shares = _top_shares(a, LORENZ_PCTS)
        row = {
            key_col: int(key),
            "private_acres": float(a.sum()), "private_owners": int(len(a)),
            "large_acres": float(ba.sum()), "large_owners": int(len(ba)),
            "large_mean": float(ba.mean()) if len(ba) else 0.0,
            "top4_acres": float(ba[:4].sum()), "top1_acres": float(ba[0]) if len(ba) else 0.0,
            "top2_acres": float(ba[1]) if len(ba) > 1 else 0.0,
            "clo4": float(ba[:4].sum() / ba.sum()) if ba.sum() > 0 else float("nan"),
            "large_acres_max": float(gm_big.sum()), "large_owners_max": int(len(gm_big)),
            "large_oos_acres": float(big.loc[big["oos"], "acres"].sum()),
            "large_oos_owners": int(big["oos"].sum()),
            "large_provisional": int(big["strong"].sum()),
            "large_provisional_acres": float(big.loc[big["strong"], "acres"].sum()),
            "large_token": int(big["token"].sum()),
            "large_conflict": int(big["conflict"].sum()),
            "gini_private": _gini(a),
        }
        row["gap_1_2"] = row["top1_acres"] - row["top2_acres"]
        for p in LORENZ_PCTS:
            row[f"top{p}pct_share"] = shares[p]
        for i, lab in enumerate(SIZE_LABELS):
            sub = g[g["size_class"] == i]
            row[f"n_{lab}"] = int(len(sub))
            row[f"ac_{lab}"] = float(sub["acres"].sum())
        rows.append(row)
    return pd.DataFrame(rows)


def _top(h: pd.DataFrame, groups: pd.DataFrame, n: int = TOP_N) -> pd.DataFrame:
    big = h[h["large"]].sort_values(["county_n", "acres"], ascending=[True, False])
    big = big.groupby("county_n").head(n).copy()
    big["rank"] = big.groupby("county_n").cumcount() + 1
    gi = groups.set_index("group_id")[["group_hash", "display_name", "display_city", "display_state",
                                       "is_entity", "review_status", "n_names", "pending_links"]]
    big = big.join(gi, on="group_id")
    return big[["county_n", "rank", "group_id", "group_hash", "display_name", "display_city",
                "display_state", "acres", "acres_if_merged", "n_parcels", "is_entity",
                "review_status", "n_names", "pending_links", "strong", "token", "conflict", "oos"]]


def run_snapshot(date: str, **dirs) -> tuple[dict, dict[str, pd.DataFrame]]:
    d, qa = load_private_parcels(date, **{k: v for k, v in dirs.items() if k in
                                           ("snap_dir", "id_dir", "ten_dir", "pl_dir", "res_dir")})
    groups = pd.read_parquet(os.path.join(dirs.get("id_dir", ID_DIR), f"groups_{date}.parquet"))
    hc = _holdings(d, by_county=True)
    hs = _holdings(d, by_county=False)
    mc = _metrics(hc)
    ms = _metrics(hs)
    top = pd.concat([_top(hc, groups), _top(hs, groups)], ignore_index=True)
    for t in (mc, ms, top):
        t["snapshot"] = date
    # review summary among large holdings, per county and statewide (county_n 0)
    st = groups.set_index("group_id")["review_status"]
    rv = pd.concat([hc[hc["large"]], hs[hs["large"]]], ignore_index=True).join(st, on="group_id")
    rv = (rv.groupby(["county_n", "review_status"]).agg(owners=("group_id", "size"), acres=("acres", "sum"))
          .reset_index())
    rv["snapshot"] = date
    qa.update({"large_owners_13county_sum": None,
               "state_large_owners": int(ms["large_owners"].iloc[0]),
               "state_large_acres": float(ms["large_acres"].iloc[0]),
               "state_large_owners_max": int(ms["large_owners_max"].iloc[0]),
               "state_private_acres": float(ms["private_acres"].iloc[0]),
               "county_rows": int(len(mc))})
    return qa, {"county": mc, "state": ms, "top": top, "review": rv}


def main(argv: list[str] | None = None) -> int:
    import argparse
    import glob

    ap = argparse.ArgumentParser(description="Stage 10: large private holdings and concentration")
    ap.add_argument("--snapshots", default=SNAP_DIR)
    ap.add_argument("--identity", default=ID_DIR)
    ap.add_argument("--tenure", default=TEN_DIR)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    dates = sorted(os.path.basename(p)[len("owners_"):-len(".parquet")]
                   for p in glob.glob(os.path.join(args.identity, "owners_*.parquet")))
    if args.only:
        dates = [d for d in dates if d in set(args.only)]
    acc: dict[str, list] = {"county": [], "state": [], "top": [], "review": []}
    qa_all = []
    for i, date in enumerate(dates, 1):
        qa, tabs = run_snapshot(date, snap_dir=args.snapshots, id_dir=args.identity, ten_dir=args.tenure)
        for k, v in tabs.items():
            acc[k].append(v)
        qa_all.append(qa)
        st = tabs["state"].iloc[0]
        log.info("[%2d/%d] %s  private %.2fM ac in %s owners; large: %s owners / %.2fM ac "
                 "(max tier %s / %.2fM); CLO4 statewide %.3f; tenure=%s conflicts=%s",
                 i, len(dates), date, st["private_acres"] / 1e6, f"{int(st['private_owners']):,}",
                 f"{int(st['large_owners']):,}", st["large_acres"] / 1e6,
                 f"{int(st['large_owners_max']):,}", st["large_acres_max"] / 1e6, st["clo4"],
                 qa["tenure_method"], qa.get("tenure_conflicts", "-"))
    os.makedirs(args.out, exist_ok=True)
    for k, frames in acc.items():
        if frames:
            df = pd.concat(frames, ignore_index=True)
            df.to_parquet(os.path.join(args.out, f"holdings_{k}.parquet"), index=False)
            log.info("  wrote holdings_%s.parquet: %s rows", k, f"{len(df):,}")
    with open(os.path.join(args.out, "qa_holdings.json"), "w") as fh:
        json.dump(qa_all, fh, indent=2, default=str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
