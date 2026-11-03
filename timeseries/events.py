"""Stage 3: parcel lineage and inferred cadastral events.

The whole of lineage -- creation, retirement, persistence and resurrection --
falls out of one compact structure. For every parcel id ever observed, record a
**presence bitmap**: bit *i* set when the parcel appears in snapshot *i*. One
``uint64`` per parcel holds 64 vintages (29 are in use), so the union of all
vintages (~1.3 M ids) is a few megabytes, and every lineage question becomes a
bit test:

====================  ==============================================
created at interval i  bit *i* set, bit *i-1* clear
retired at interval i  bit *i-1* set, bit *i* clear
persisted              both set
resurrected            the set bits are not one contiguous run
lifespan               last set bit - first set bit
====================  ==============================================

Resurrection matters because the Department of Revenue reissues lot numbers,
and an identifier is not a parcel. A geocode that returns after a gap may be a
different piece of land under an old name, so the model carries **occurrences**:
each contiguous run of set bits is one occurrence with its own first and last
snapshot (``occurrences.parquet``). The first snapshot of an occurrence is a
creation, and the interval that sees it classifies it like any other, with
``reused_id`` saying the name has a past and the published confidence left for
the acreage test to decide. Everything downstream that dates a parcel -- the
absorption cohorts, the dormant inventory, the ``born`` attribute on the tiles,
the building-record witness -- reads the occurrence that contains the snapshot
in question (:func:`occurrence_start`), never the identifier's first-ever
appearance. Pairwise set algebra cannot see any of this; the bitmap gets it free.

Events are **inferred**, and the vocabulary says so. A new lot number inside an
existing block is not necessarily a legally defined subdivision -- it may be a
certificate of survey, a boundary-line adjustment, a tax split, a replat or a
correction. "Subdivision" is reserved for events corroborated by a subdivision
or certificate-of-survey attribute, and everything else is reported as parcel
creation with a published confidence tier.

Both directions are modelled. Consolidation is a first-class class, because net
fragmentation -- not gross creation -- is the quantity the Ranchland Dynamics
thesis is about.
"""

from __future__ import annotations

import logging
import os

import numpy as np
import pandas as pd

from . import sources

log = logging.getLogger("timeseries.events")

IN_DIR = "data/snapshots"
OUT_DIR = "data/events"

# Snapshots the bitmap can hold; the dtype below must match. 29 are in use.
BITMAP_BITS = 64

# Acreage within a quarter-section is "conserved" inside this band. A genuine
# division of land conserves area; a re-digitisation or a coverage gain does not.
CONSERVED_LO, CONSERVED_HI = 0.95, 1.05

EVENT_CLASSES = ("lot_created", "block_created", "unit_created",
                 "first_mapping", "parcels_merged")
CONFIDENCE = ("high", "medium", "low")

# Columns the event stage needs from a parcel snapshot.
NEED = ["parcel_id", "acres", "owner_hash", "owner_state", "owner_in_state",
        "improved", "subdivision", "cert_survey", "county", "twp_code",
        "section", "quarter", "block", "lot", "unit", "is_condo"]


def _path(date: str, in_dir: str = IN_DIR) -> str:
    return os.path.join(in_dir, f"parcels_{date}.parquet")


def load_snapshot(date: str, in_dir: str = IN_DIR, columns=None) -> pd.DataFrame:
    df = pd.read_parquet(_path(date, in_dir), columns=columns or NEED)
    for part in ("county", "twp_code", "section", "quarter", "block", "lot", "unit"):
        if part in df.columns:
            df[part] = df[part].fillna("").astype("object")
    return df


def keys(df: pd.DataFrame) -> pd.DataFrame:
    """Add the nested spatial keys the classifier compares against."""
    out = df
    out["township_key"] = out["county"] + out["twp_code"]
    out["section_key"] = out["township_key"] + out["section"]
    out["quarter_key"] = out["section_key"] + out["quarter"]
    out["block_key"] = out["quarter_key"] + out["block"]
    out["lot_key"] = out["block_key"] + out["lot"]
    return out


# ------------------------------------------------------------------ presence
def build_presence(dates: list[str], in_dir: str = IN_DIR) -> tuple[pd.DataFrame, pd.DataFrame]:
    """One row per parcel id ever seen, with a bitmap of the snapshots it is in,
    and one row per occurrence: a contiguous run of snapshots the id was in.

    Vectorised: a parcel id is unique within a snapshot, so each contributes a
    distinct power of two and ``np.bitwise_or.at`` folds 25.5 M (id, snapshot)
    pairs into one ``uint64`` per parcel in a single pass. Runs are found on
    the unpacked bit matrix: a run starts where a bit is set and its
    predecessor is not, and ends where a bit is set and its successor is not.
    """
    n = len(dates)
    if n > BITMAP_BITS:
        raise RuntimeError(f"{n} snapshots exceeds the {BITMAP_BITS}-bit bitmap width; "
                           "widen BITMAP_BITS and the dtype before adding vintages")
    if n > BITMAP_BITS - 8:
        log.warning("presence bitmap: %d of %d bits in use; plan the widening", n, BITMAP_BITS)
    frames = []
    for i, date in enumerate(dates):
        ids = pd.read_parquet(_path(date, in_dir), columns=["parcel_id"])["parcel_id"]
        frames.append(pd.DataFrame({"parcel_id": ids,
                                    "bit": np.uint64(1) << np.uint64(i)}))
    allv = pd.concat(frames, ignore_index=True)
    del frames
    log.info("  presence: %s (id, snapshot) pairs over %d snapshots",
             f"{len(allv):,}", n)

    codes, uniques = pd.factorize(allv["parcel_id"], sort=False)
    bm = np.zeros(len(uniques), dtype="uint64")
    np.bitwise_or.at(bm, codes, allv["bit"].to_numpy(dtype="uint64"))
    del allv, codes

    idx = np.arange(n, dtype="uint64")
    present = ((bm[:, None] >> idx[None, :]) & np.uint64(1)).astype(bool)
    seen = present.any(axis=1)
    first = np.where(seen, present.argmax(axis=1), -1).astype("int8")
    last = np.where(seen, n - 1 - present[:, ::-1].argmax(axis=1), -1).astype("int8")
    n_present = present.sum(axis=1).astype("int8")
    span = (last.astype("int16") - first.astype("int16") + 1)
    pad = np.zeros((len(present), 1), dtype=bool)
    starts = present & ~np.concatenate([pad, present[:, :-1]], axis=1)
    ends = present & ~np.concatenate([present[:, 1:], pad], axis=1)
    n_occ = starts.sum(axis=1).astype("int8")
    # The occurrence that holds the last set bit is the id's current life.
    occ_first = np.where(seen, n - 1 - starts[:, ::-1].argmax(axis=1), -1).astype("int8")
    pres = pd.DataFrame({
        "parcel_id": np.asarray(uniques),
        "bitmap": bm,
        "first_idx": first,
        "last_idx": last,
        "n_present": n_present,
        "n_occurrences": n_occ,
        "occ_first_idx": occ_first,
        # A contiguous run has exactly `span` bits set. Anything else has a gap,
        # meaning the geocode was retired and later reissued by DOR -- which
        # would otherwise read as a fresh parcel creation.
        "resurrected": (n_present.astype("int16") != span) & (first >= 0),
    })
    ri, sj = np.nonzero(starts)
    _, ej = np.nonzero(ends)
    occ = pd.DataFrame({
        "parcel_id": np.asarray(uniques)[ri],
        "occurrence": pd.Series(ri).groupby(ri).cumcount().to_numpy().astype("int8"),
        "first_idx": sj.astype("int8"),
        "last_idx": ej.astype("int8"),
    })
    return pres, occ


def load_occurrences(event_dir: str = OUT_DIR) -> pd.DataFrame:
    """The occurrence table written beside the presence bitmap."""
    return pd.read_parquet(os.path.join(event_dir, "occurrences.parquet"))


def occurrence_start(occ: pd.DataFrame, snap_idx: int) -> pd.Series:
    """parcel_id -> the first snapshot of the occurrence present at ``snap_idx``.

    This, not ``first_idx``, is the creation date of the parcel a snapshot
    shows under that geocode: an identifier reissued after a gap names a new
    parcel from its return.
    """
    sel = occ[(occ["first_idx"] <= snap_idx) & (occ["last_idx"] >= snap_idx)]
    return sel.set_index("parcel_id")["first_idx"]


# ------------------------------------------------------------- classification
def classify_interval(a: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
    """Classify the parcels present in *b* but absent from *a*.

    Order matters: a new unit shares the whole block+lot prefix, so it must be
    tested before a new lot, which in turn must be tested before a new block.
    """
    a_quarters = set(a["quarter_key"].to_numpy())
    a_blocks = set(a["block_key"].to_numpy())
    a_lots = set(a["lot_key"].to_numpy())
    a_ids = set(a["parcel_id"].to_numpy())

    new = b[~b["parcel_id"].isin(a_ids)].copy()
    if new.empty:
        new["event_class"] = pd.Series(dtype="object")
        return new

    qk = new["quarter_key"].to_numpy()
    bk = new["block_key"].to_numpy()
    lk = new["lot_key"].to_numpy()
    unit = new["unit"].fillna("").to_numpy()

    in_q = np.fromiter((x in a_quarters for x in qk), dtype=bool, count=len(qk))
    in_b = np.fromiter((x in a_blocks for x in bk), dtype=bool, count=len(bk))
    in_l = np.fromiter((x in a_lots for x in lk), dtype=bool, count=len(lk))

    cls = np.full(len(new), "block_created", dtype=object)
    cls[in_b] = "lot_created"
    cls[in_l & (unit != "0000")] = "unit_created"
    cls[~in_q] = "first_mapping"          # the quarter-section was empty: coverage
    new["event_class"] = cls
    return new


def quarter_acreage(a: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
    """Per quarter-section acreage and parcel counts at both endpoints.

    The acreage ratio is the independent discriminator that separates a real
    division of land from a coverage gain or a re-digitisation, with no geometry
    and no assumption:

    ======================  ==========================================
    parcels up, acres flat   real division
    parcels up, acres up     first mapping / coverage gain
    parcels up, acres down   re-digitised or boundary adjustment
    parcels flat, acres move re-digitisation, no ownership change
    ======================  ==========================================
    """
    ga = a.groupby("quarter_key").agg(n_a=("parcel_id", "size"), ac_a=("acres", "sum"))
    gb = b.groupby("quarter_key").agg(n_b=("parcel_id", "size"), ac_b=("acres", "sum"))
    q = ga.join(gb, how="outer").fillna(0.0)
    q["n_a"] = q["n_a"].astype("int32")
    q["n_b"] = q["n_b"].astype("int32")
    with np.errstate(divide="ignore", invalid="ignore"):
        q["acres_ratio"] = np.where(q["ac_a"] > 0, q["ac_b"] / q["ac_a"], np.nan)
    q["conserved"] = q["acres_ratio"].between(CONSERVED_LO, CONSERVED_HI)
    return q.reset_index()


def assign_confidence(new: pd.DataFrame, q: pd.DataFrame,
                      a: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
    """Attach the acreage ratio and a published confidence tier to each event.

    high    acres conserved, more than one new parcel in the block, and a
            subdivision or certificate-of-survey name that was absent at t
    medium  acres conserved
    low     everything else
    """
    qmap = q.set_index("quarter_key")
    new = new.merge(qmap[["acres_ratio", "conserved", "n_a", "n_b"]],
                    left_on="quarter_key", right_index=True, how="left")

    children = new.groupby("block_key")["parcel_id"].transform("size")
    new["n_new_in_block"] = children.astype("int32")

    a_names = set(a.loc[a["subdivision"] != "", "subdivision"].to_numpy())
    a_cos = set(a.loc[a["cert_survey"] != "", "cert_survey"].to_numpy())
    sub = new["subdivision"].fillna("").to_numpy()
    cos = new["cert_survey"].fillna("").to_numpy()
    new_name = np.fromiter(
        ((s != "" and s not in a_names) or (c != "" and c not in a_cos)
         for s, c in zip(sub, cos)), dtype=bool, count=len(new))
    new["corroborating_name"] = new_name

    conserved = new["conserved"].fillna(False).to_numpy(dtype=bool)
    conf = np.full(len(new), "low", dtype=object)
    conf[conserved] = "medium"
    conf[conserved & (new["n_new_in_block"].to_numpy() > 1) & new_name] = "high"
    # A first mapping is a coverage artifact, not an event; never promote it.
    conf[new["event_class"].to_numpy() == "first_mapping"] = "low"
    new["confidence"] = conf
    # "Subdivision" is reserved for the corroborated cases.
    new["is_subdivision"] = new_name & (new["event_class"].to_numpy() != "first_mapping")
    return new


def find_merges(a: pd.DataFrame, b: pd.DataFrame, q: pd.DataFrame) -> pd.DataFrame:
    """Consolidation: several parcels at t become fewer at t+1, area conserved."""
    b_ids = set(b["parcel_id"].to_numpy())
    gone = a[~a["parcel_id"].isin(b_ids)]
    if gone.empty:
        return pd.DataFrame(columns=["block_key", "n_retired", "acres_retired",
                                     "n_a", "n_b", "acres_ratio", "conserved"])
    per_block = gone.groupby("block_key").agg(n_retired=("parcel_id", "size"),
                                              acres_retired=("acres", "sum"))
    b_blocks = b.groupby("block_key").agg(n_b_block=("parcel_id", "size"))
    a_blocks = a.groupby("block_key").agg(n_a_block=("parcel_id", "size"))
    m = per_block.join(a_blocks).join(b_blocks).fillna(0)
    # A merge leaves the block smaller but still occupied, with area conserved.
    m["quarter_key"] = m.index.to_series().str[:9]
    m = m.merge(q.set_index("quarter_key")[["acres_ratio", "conserved", "n_a", "n_b"]],
                left_on="quarter_key", right_index=True, how="left")
    merged = m[(m["n_b_block"] > 0) & (m["n_b_block"] < m["n_a_block"])
               & m["conserved"].fillna(False)]
    return merged.reset_index()


def process_interval(date_a: str, date_b: str, idx: int, in_dir: str = IN_DIR,
                     out_dir: str = OUT_DIR, seen: set | None = None) -> dict:
    """One interval. ``seen`` holds every parcel id present in a snapshot
    BEFORE ``date_a``, so a creation can be marked as the return of a reissued
    identifier (``reused_id``)."""
    a = keys(load_snapshot(date_a, in_dir))
    b = keys(load_snapshot(date_b, in_dir))
    days = (pd.Timestamp(date_b) - pd.Timestamp(date_a)).days

    q = quarter_acreage(a, b)
    new = classify_interval(a, b)
    new = assign_confidence(new, q, a, b) if not new.empty else new
    if not new.empty:
        new["reused_id"] = new["parcel_id"].isin(seen).to_numpy() if seen else np.zeros(len(new), dtype=bool)
    merges = find_merges(a, b, q)

    a_ids = set(a["parcel_id"].to_numpy())
    b_ids = set(b["parcel_id"].to_numpy())
    persisted_ids = a_ids & b_ids
    pa = a[a["parcel_id"].isin(persisted_ids)].set_index("parcel_id").sort_index()
    pb = b[b["parcel_id"].isin(persisted_ids)].set_index("parcel_id").sort_index()

    owner_changed = (pa["owner_hash"].to_numpy() != pb["owner_hash"].to_numpy())
    st_a = pa["owner_state"].fillna("").to_numpy()
    st_b = pb["owner_state"].fillna("").to_numpy()
    state_changed = (st_a != st_b) & (st_a != "") & (st_b != "")

    trans = pd.DataFrame({
        "parcel_id": pa.index.to_numpy(),
        "township_key": pa["township_key"].to_numpy(),
        "quarter_key": pa["quarter_key"].to_numpy(),
        "acres": pb["acres"].to_numpy(),
        "owner_changed": owner_changed,
        "state_from": st_a, "state_to": st_b,
        "state_changed": state_changed,
        # A transfer is an owner change; a mailing-address edit on the SAME owner
        # is an address change. Conflating them would inflate every claim about
        # out-of-state buying.
        "transfer_to_other_state": state_changed & owner_changed,
        "address_change_only": state_changed & ~owner_changed,
        "improved_from": pa["improved"].to_numpy(),
        "improved_to": pb["improved"].to_numpy(),
    })
    trans["interval"] = idx

    os.makedirs(out_dir, exist_ok=True)
    keep = ["parcel_id", "township_key", "quarter_key", "block_key", "lot_key",
            "acres", "event_class", "confidence", "is_subdivision",
            "corroborating_name", "acres_ratio", "n_new_in_block",
            "subdivision", "cert_survey", "improved", "is_condo", "reused_id"]
    ev = new[[c for c in keep if c in new.columns]].copy() if not new.empty else pd.DataFrame(columns=keep)
    ev["interval"] = idx
    epath = os.path.join(out_dir, f"events_{idx:02d}_{date_a}_{date_b}.parquet")
    ev.to_parquet(epath, index=False, compression="zstd")
    tpath = os.path.join(out_dir, f"transitions_{idx:02d}_{date_a}_{date_b}.parquet")
    trans.to_parquet(tpath, index=False, compression="zstd")

    # Area conservation beyond the median: the tails say how often a
    # quarter-section's acreage moved, and by how much, where events were read.
    qq = q[(q["ac_a"] > 0) & (q["n_a"] > 0)]
    ratio = qq["acres_ratio"].to_numpy(dtype="float64")
    dev = np.abs(ratio - 1.0)
    evq = set(new["quarter_key"].to_numpy()) if not new.empty else set()
    inev = qq["quarter_key"].isin(evq).to_numpy()
    conservation = {
        "quarters": int(len(ratio)),
        "p10": round(float(np.percentile(ratio, 10)), 4) if len(ratio) else None,
        "p90": round(float(np.percentile(ratio, 90)), 4) if len(ratio) else None,
        "p99": round(float(np.percentile(ratio, 99)), 4) if len(ratio) else None,
        "within_1pct": round(float((dev <= 0.01).mean()), 4) if len(ratio) else None,
        "within_5pct": round(float((dev <= 0.05).mean()), 4) if len(ratio) else None,
        "event_quarters": int(inev.sum()),
        "event_quarters_conserved": (round(float(qq.loc[inev, "conserved"].mean()), 4)
                                     if inev.any() else None),
    }
    cls_counts = (ev["event_class"].value_counts().to_dict() if "event_class" in ev else {})
    conf_counts = (ev["confidence"].value_counts().to_dict() if "confidence" in ev else {})
    qa = {
        "interval": idx, "date_a": date_a, "date_b": date_b, "days": days,
        "years": round(days / 365.25, 4),
        "parcels_a": int(len(a)), "parcels_b": int(len(b)),
        "created": int(len(ev)), "retired": int(len(a_ids - b_ids)),
        "persisted": int(len(persisted_ids)),
        "classes": {str(k): int(v) for k, v in cls_counts.items()},
        "confidence": {str(k): int(v) for k, v in conf_counts.items()},
        "is_subdivision": int(ev["is_subdivision"].sum()) if "is_subdivision" in ev else 0,
        "merge_blocks": int(len(merges)),
        "owner_changed": int(owner_changed.sum()),
        "owner_change_pct": round(100.0 * float(owner_changed.mean()), 3) if len(pa) else None,
        "owner_change_pct_per_year": (round(100.0 * float(owner_changed.mean()) / (days / 365.25), 3)
                                      if len(pa) and days else None),
        "state_changed": int(state_changed.sum()),
        "transfer_to_other_state": int(trans["transfer_to_other_state"].sum()),
        "address_change_only": int(trans["address_change_only"].sum()),
        "to_CA": int(((st_b == "CA") & state_changed & owner_changed).sum()),
        "from_CA": int(((st_a == "CA") & state_changed & owner_changed).sum()),
        "quarter_acres_ratio_median": (round(float(q.loc[q["ac_a"] > 0, "acres_ratio"].median()), 5)
                                       if (q["ac_a"] > 0).any() else None),
        "area_conservation": conservation,
        "reused_ids": int(ev["reused_id"].sum()) if "reused_id" in ev and len(ev) else 0,
        "acres_a": float(a["acres"].sum()), "acres_b": float(b["acres"].sum()),
        "event_file": epath, "transition_file": tpath,
    }
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Stage 3: lineage and inferred events")
    ap.add_argument("--in-dir", default=IN_DIR)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--root", default=sources.DEFAULT_ROOT)
    ap.add_argument("--presence", action="store_true", help="also build the presence bitmap")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    snaps = sources.usable(sources.discover(args.root))
    dates = [s.date for s in snaps if os.path.exists(_path(s.date, args.in_dir))]
    log.info("%d extracted snapshots -> %d intervals", len(dates), len(dates) - 1)
    os.makedirs(args.out, exist_ok=True)

    qa_all = []
    seen: set = set()
    for i, (da, db) in enumerate(zip(dates, dates[1:])):
        qa = process_interval(da, db, i, args.in_dir, args.out, seen=seen)
        qa_all.append(qa)
        # Every id in snapshot i is "seen" for the intervals after it.
        seen.update(pd.read_parquet(_path(da, args.in_dir), columns=["parcel_id"])["parcel_id"].to_numpy())
        log.info("[%2d] %s -> %s (%4dd)  created=%s retired=%s  subdiv=%s  "
                 "owner-chg=%s%%/yr  ratio=%s",
                 i, da, db, qa["days"], f"{qa['created']:,}", f"{qa['retired']:,}",
                 f"{qa['is_subdivision']:,}", qa["owner_change_pct_per_year"],
                 qa["quarter_acres_ratio_median"])
        with open(os.path.join(args.out, "qa_intervals.json"), "w") as fh:
            json.dump(qa_all, fh, indent=2, default=str)

    if args.presence:
        pres, occ = build_presence(dates, args.in_dir)
        ppath = os.path.join(args.out, "presence.parquet")
        pres.to_parquet(ppath, index=False, compression="zstd")
        occ.to_parquet(os.path.join(args.out, "occurrences.parquet"), index=False, compression="zstd")
        pqa = {
            "snapshots": len(dates), "bitmap_bits": BITMAP_BITS,
            "parcel_ids": int(len(pres)), "occurrences": int(len(occ)),
            "resurrected_ids": int(pres["resurrected"].sum()),
            "reused_id_creations": int(sum(q.get("reused_ids", 0) for q in qa_all)),
            "note": "an identifier that returns after a gap is a new occurrence, counted as a "
                    "creation from its return; cohorts, dormant ages and the tiles' `born` "
                    "read the occurrence that contains the snapshot in question",
        }
        with open(os.path.join(args.out, "qa_presence.json"), "w") as fh:
            json.dump(pqa, fh, indent=2)
        log.info("presence: %s parcels, %s occurrences, %s resurrected ids, %s KB",
                 f"{len(pres):,}", f"{len(occ):,}", f"{int(pres['resurrected'].sum()):,}",
                 f"{os.path.getsize(ppath) // 1024:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
