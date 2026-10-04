"""Stage 1: the snapshot-independent spatial locator.

Two keys, one crosswalk, because they answer different questions:

* **analytic key** -- ``county + township_code`` (6 chars). 14-15 township codes
  appear under two county prefixes, and keying on the pair splits such a
  township into one unit per county, which is what makes county rollups
  reconcile exactly. 4,684 units observed in 2026.
* **display key** -- the PLSS township polygon, keyed by township/range. 4,191
  polygons, which is essentially the 4,170 distinct township/range pairs the
  parcels themselves reference.

The crosswalk between them is a **majority vote**. The 4-digit DOR township code
is not one-to-one with township/range (4,665 codes against 4,170 pairs in 2026),
but the ambiguity is attribute noise rather than genuine straddling: 189 of 248
ambiguous codes have a dominant township/range at >=99%, 245 at >=90%, none below
60%, and the worst offender's minority value is ``215W`` -- an impossible Montana
range. Measured error budget across the series: 0.047%-0.79% of rows.

No download is required. ``PLSSTownship`` ships *inside* the 2018 and 2019
cadastral geodatabases (4,191 features, EPSG:32100), so the authoritative survey
geometry is already on disk alongside the parcels.
"""

from __future__ import annotations

import logging
import os
import re

import numpy as np
import pandas as pd

from cadastral.schema import SQM_TO_ACRES, resolve_columns

from . import geocode as gc
from . import sources

log = logging.getLogger("timeseries.locator")

OUT_DIR = "data/locator"
# Vintages carrying the PLSSTownship feature class.
PLSS_SOURCE_DATES = ("2019-12-31", "2018-12-18", "2018-01-10")
PLSS_LAYER = "PLSSTownship"
# Vertex tolerance for the published geometry, in metres.
SIMPLIFY_TOLERANCE_M = 50.0

# Parcel attributes: "27 N" / "7.5 E". Fractional townships are real (PLSS
# TWNSHPFRAC/RANGEFRAC encode the half, e.g. label "13N 7.5E").
_TR_PART = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([NSEW])\s*$", re.IGNORECASE)
# Era-A concatenated form: "T2SR9WS4".
_TRS = re.compile(r"^T(\d+(?:\.\d+)?)\s*([NS])\s*R(\d+(?:\.\d+)?)\s*([EW])\s*S(\d+)",
                  re.IGNORECASE)


def _tr_label(twp_num: str, twp_dir: str, rng_num: str, rng_dir: str) -> str:
    """Canonical township/range key, e.g. ``013.0N007.5E``.

    Zero-padded and fixed-precision so that "7 E", "07E" and "7.0 E" collapse to
    one key rather than three.
    """
    try:
        t = float(twp_num)
        r = float(rng_num)
    except (TypeError, ValueError):
        return ""
    if not twp_dir or not rng_dir:
        return ""
    return f"{t:05.1f}{twp_dir.upper()}{r:05.1f}{rng_dir.upper()}"


def parse_parcel_tr(township: pd.Series | None, rng: pd.Series | None,
                    trs: pd.Series | None) -> pd.Series:
    """Township/range key from whichever PLSS attribute this era provides."""
    if township is not None and rng is not None:
        t = township.astype("string").fillna("").str.extract(_TR_PART)
        r = rng.astype("string").fillna("").str.extract(_TR_PART)
        return pd.Series(
            [_tr_label(a, b, c, d) for a, b, c, d in
             zip(t[0].to_numpy(), t[1].to_numpy(), r[0].to_numpy(), r[1].to_numpy())],
            index=township.index, dtype="object")
    if trs is not None:
        m = trs.astype("string").fillna("").str.extract(_TRS)
        return pd.Series(
            [_tr_label(a, b, c, d) for a, b, c, d in
             zip(m[0].to_numpy(), m[1].to_numpy(), m[2].to_numpy(), m[3].to_numpy())],
            index=trs.index, dtype="object")
    return pd.Series(dtype="object")


def build_code_crosswalk(root: str = sources.DEFAULT_ROOT,
                         valid_tr: set[str] | None = None) -> tuple[pd.DataFrame, dict]:
    """Majority-vote crosswalk: county + township code -> township/range.

    Votes are pooled over every usable snapshot, so a code mislabelled in one
    vintage is outvoted by the rest.

    *valid_tr* restricts the winner to township/range keys that actually exist in
    the PLSS survey, and this matters. Without it, ten units resolved to
    impossible keys -- range ``545E``, ``365E``, ``275W``, township ``75S``,
    none of which exist in Montana -- each on a dominant share of only 0.51-0.55.
    A corrupt attribute had outvoted a valid one by a hair. Votes for keys
    outside the survey are still counted and reported, never silently discarded.
    """
    tally: dict[tuple[str, str], int] = {}
    per_snapshot = []
    for snap in sources.usable(sources.discover(root)):
        with snap.local() as src:
            res = resolve_columns(list(src.info()["fields"]))
            cols = [res[k] for k in ("parcel_id", "township", "plss_range", "trs")
                    if res.get(k)]
            df = src.read(columns=list(dict.fromkeys(cols)))
        pid = gc.normalize(df[res["parcel_id"]])
        parts = gc.parse(pid)
        ok = parts["locatable"].to_numpy(dtype=bool)
        unit = (parts["county"] + parts["twp_code"])[ok]
        tr = parse_parcel_tr(
            df[res["township"]][ok] if res.get("township") else None,
            df[res["plss_range"]][ok] if res.get("plss_range") else None,
            df[res["trs"]][ok] if res.get("trs") else None,
        )
        good = (tr != "") & tr.notna()
        vc = pd.Series(list(zip(unit[good], tr[good]))).value_counts()
        for (u, t), n in vc.items():
            tally[(u, t)] = tally.get((u, t), 0) + int(n)
        per_snapshot.append({"date": snap.date, "rows": int(good.sum()),
                             "unresolved": int((~good).sum())})
        log.info("  votes %s: %s rows (%s without a T/R attribute)",
                 snap.date, f"{int(good.sum()):,}", f"{int((~good).sum()):,}")

    votes = pd.DataFrame([{"unit": u, "tr": t, "votes": n} for (u, t), n in tally.items()])
    total = votes.groupby("unit")["votes"].transform("sum")
    votes["share"] = votes["votes"] / total
    if valid_tr is not None:
        votes["tr_in_survey"] = votes["tr"].isin(valid_tr)
        # Prefer the most-voted key that exists in the survey; fall back to the
        # overall winner only for units with no valid candidate at all.
        valid_votes = votes[votes["tr_in_survey"]]
        winner = valid_votes.loc[valid_votes.groupby("unit")["votes"].idxmax()].copy()
        missing = set(votes["unit"]) - set(winner["unit"])
        if missing:
            fallback = votes[votes["unit"].isin(missing)]
            winner = pd.concat(
                [winner, fallback.loc[fallback.groupby("unit")["votes"].idxmax()]],
                ignore_index=True)
        winner["tr_in_survey"] = winner["tr"].isin(valid_tr)
    else:
        winner = votes.loc[votes.groupby("unit")["votes"].idxmax()].copy()
    winner = winner.rename(columns={"tr": "tr_key", "share": "dominant_share"})
    qa = {
        "units": int(len(winner)),
        "units_with_multiple_tr": int((votes.groupby("unit").size() > 1).sum()),
        "dominant_share_median": round(float(winner["dominant_share"].median()), 5),
        "dominant_share_min": round(float(winner["dominant_share"].min()), 5),
        "units_dominant_ge_99pct": int((winner["dominant_share"] >= 0.99).sum()),
        "units_dominant_lt_60pct": int((winner["dominant_share"] < 0.60).sum()),
        "minority_votes": int(votes["votes"].sum() - winner["votes"].sum()),
        "total_votes": int(votes["votes"].sum()),
        "votes_for_keys_outside_survey": (
            int(votes.loc[~votes["tr_in_survey"], "votes"].sum())
            if "tr_in_survey" in votes else None),
        "units_without_a_valid_tr": (int((~winner["tr_in_survey"]).sum())
                                     if "tr_in_survey" in winner else None),
        "per_snapshot": per_snapshot,
    }
    qa["minority_vote_pct"] = round(100.0 * qa["minority_votes"] / qa["total_votes"], 5)
    return winner[["unit", "tr_key", "votes", "dominant_share"]], qa


def load_plss(root: str = sources.DEFAULT_ROOT):
    """PLSS township polygons from whichever cadastral GDB still carries them."""
    import geopandas as gpd
    import pyogrio

    snaps = {s.date: s for s in sources.discover(root)}
    for date in PLSS_SOURCE_DATES:
        snap = snaps.get(date)
        if snap is None:
            continue
        with snap.local() as src:
            if PLSS_LAYER not in [str(r[0]) for r in pyogrio.list_layers(src.vsi)]:
                continue
            gdf = gpd.read_file(src.vsi, layer=PLSS_LAYER, engine="pyogrio")
        log.info("  PLSS townships from %s: %s features, %s", date, f"{len(gdf):,}", gdf.crs)
        gdf["tr_key"] = [
            _tr_label(f"{float(tn) + (0.5 if str(tf) == '2' else 0.0):g}", td,
                      f"{float(rn) + (0.5 if str(rf) == '2' else 0.0):g}", rd)
            for tn, tf, td, rn, rf, rd in zip(
                gdf["TWNSHPNO"], gdf["TWNSHPFRAC"], gdf["TWNSHPDIR"],
                gdf["RANGENO"], gdf["RANGEFRAC"], gdf["RANGEDIR"])
        ]
        return gdf
    raise RuntimeError(f"{PLSS_LAYER} not found in any of {PLSS_SOURCE_DATES}")


def build(root: str = sources.DEFAULT_ROOT, out_dir: str = OUT_DIR) -> dict:
    import geopandas as gpd

    os.makedirs(out_dir, exist_ok=True)
    log.info("PLSS township geometry (loaded first, to gate the vote)")
    plss = load_plss(root)
    valid_tr = set(plss.loc[plss["tr_key"] != "", "tr_key"])

    log.info("majority-vote crosswalk over every usable snapshot")
    xwalk, qa = build_code_crosswalk(root, valid_tr=valid_tr)
    xwalk.to_parquet(os.path.join(out_dir, "code_crosswalk.parquet"), index=False)
    dup = plss["tr_key"].duplicated().sum()
    plss = plss[plss["tr_key"] != ""].copy()

    # One polygon per township/range; dissolve the rare duplicate.
    poly = plss.dissolve(by="tr_key", aggfunc={"SHAPE_Area": "sum"}).reset_index()
    poly["land_km2"] = (poly.geometry.area / 1e6).astype("float32")
    poly["acres"] = (poly.geometry.area * SQM_TO_ACRES).astype("float32")
    rp = poly.geometry.representative_point()
    wgs = gpd.GeoSeries(rp, crs=poly.crs).to_crs(4326)
    poly["lon"] = wgs.x.astype("float64")
    poly["lat"] = wgs.y.astype("float64")
    poly["label"] = (poly["tr_key"].str.slice(0, 5).astype(float).map(lambda v: f"{v:g}")
                     + poly["tr_key"].str.slice(5, 6) + " "
                     + poly["tr_key"].str.slice(6, 11).astype(float).map(lambda v: f"{v:g}")
                     + poly["tr_key"].str.slice(11, 12))

    joined = xwalk.merge(poly[["tr_key", "land_km2", "acres", "lon", "lat", "label"]],
                         on="tr_key", how="left")
    joined["county_n"] = pd.to_numeric(joined["unit"].str.slice(0, 2), errors="coerce").astype("int8")
    joined["twp_code"] = joined["unit"].str.slice(2, 6)
    joined["located"] = joined["lon"].notna()
    joined.to_parquet(os.path.join(out_dir, "spatial_unit.parquet"), index=False)

    # The source carries ~125 vertices per township for what is essentially a
    # rectangle. Simplifying at 50 m takes 525,985 vertices to 24,833 and the
    # gzipped payload from 2,193 KB to 153 KB, for an area error of 0.0015%.
    simple = poly[["tr_key", "label", "land_km2", "geometry"]].copy()
    simple["geometry"] = simple.geometry.simplify(SIMPLIFY_TOLERANCE_M,
                                                 preserve_topology=True)
    area_err = abs(simple.geometry.area.sum() - poly.geometry.area.sum()) / poly.geometry.area.sum()
    gjson = simple.to_crs(4326)
    gpath = os.path.join(out_dir, "townships.geojson")
    gjson.to_file(gpath, driver="GeoJSON", coordinate_precision=5)
    full_path = os.path.join(out_dir, "townships_full.geojson")
    poly[["tr_key", "label", "geometry"]].to_crs(4326).to_file(full_path, driver="GeoJSON")

    qa.update({
        "plss_features": int(len(plss)),
        "plss_duplicate_tr_keys": int(dup),
        "plss_polygons": int(len(poly)),
        "units_located": int(joined["located"].sum()),
        "units_unlocated": int((~joined["located"]).sum()),
        "pct_located": round(100.0 * float(joined["located"].mean()), 4),
        "unlocated_samples": joined.loc[~joined["located"], ["unit", "tr_key"]]
                                   .head(10).to_dict("records"),
        "geojson_bytes": os.path.getsize(gpath),
        "geojson_full_bytes": os.path.getsize(full_path),
        "simplify_tolerance_m": SIMPLIFY_TOLERANCE_M,
        "simplify_area_error_pct": round(100.0 * float(area_err), 5),
        "total_land_km2": round(float(poly["land_km2"].sum()), 1),
    })
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Stage 1: build the spatial locator")
    ap.add_argument("--root", default=sources.DEFAULT_ROOT)
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    qa = build(args.root, args.out)
    with open(os.path.join(args.out, "qa_locator.json"), "w") as fh:
        json.dump(qa, fh, indent=2, default=str)
    log.info("units=%s located=%s (%.3f%%)  PLSS polygons=%s  land=%s km2  geojson=%s KB",
             f"{qa['units']:,}", f"{qa['units_located']:,}", qa["pct_located"],
             f"{qa['plss_polygons']:,}", f"{qa['total_land_km2']:,}",
             f"{qa['geojson_bytes'] // 1024:,}")
    log.info("majority vote: median dominant share %s, minority votes %s%%",
             qa["dominant_share_median"], qa["minority_vote_pct"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
