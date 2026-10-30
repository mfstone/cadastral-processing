"""Stage 9: public land by AREA overlap, per parcel.

:mod:`timeseries.publiclands` answers "is this parcel public" with the parcel's
representative point, which is exact for a parcel wholly inside or outside a
public polygon and that is nearly every parcel. The holdings stage needs the
rest answered too: a parcel straddling a Forest Service boundary must not
contribute its federal acres to a private holding, and the requirement is that
public land is removed by **location**, never by owner name alone.

So each parcel is intersected with the public-lands layer and carries its
``public_fraction``. The point method's label and the area method's label are
compared; every disagreement is a review item (``tenure_source_conflict``).

Cost is kept down by never intersecting what need not be intersected: a parcel
*within* a public polygon is public by construction (area = its own), and only
parcels that intersect without being within -- the straddlers -- go through
``intersection``. Those are clipped to the parcel's bounding box first, because
a Forest Service polygon can carry hundreds of thousands of vertices and a
rectangle clip is linear.

The canonical layer is the MSL ``PUBLICLANDS.shp`` shipped with the current
cadastral (31,099 polygons); the SSD copy used by stage 5 has 31,091. One
vintage, applied to every snapshot -- historical tenure is approximate and is
labelled as such wherever it appears.
"""

from __future__ import annotations

import json
import logging
import os

import numpy as np
import pandas as pd

from cadastral.schema import SQM_TO_ACRES

from . import geocode as gc
from . import publiclands as pl
from . import sources

log = logging.getLogger("timeseries.tenure_area")

PL_SHP = "/media/mstone/GeoData/MSDI/MontanaCadastral_SHP/Montana_Cadastral/PUBLICLANDS.shp"
OUT_DIR = "data/tenure"
# A parcel at or above this public fraction leaves the private universe (choice,
# labelled in docs/holdings_definitions.md). Below it, only the non-public acres
# count toward a private holding.
PUBLIC_FRACTION_CUT = 0.5


def load_polygons(path: str = PL_SHP):
    import geopandas as gpd
    import shapely

    if os.path.exists(path):
        gdf = gpd.read_file(path, engine="pyogrio")
        src = path
    else:
        log.warning("canonical layer %s not mounted; falling back to the SSD zip", path)
        gdf = pl.load_polygons()
        src = pl.PL_ZIP
    gdf["pl_class"] = gdf["OWNER"].map(pl.OWNER_TO_CLASS).fillna("other_public")
    bad = ~shapely.is_valid(gdf.geometry.to_numpy())
    if bad.any():
        gdf.loc[bad, "geometry"] = shapely.make_valid(gdf.loc[bad, "geometry"].to_numpy())
    log.info("public lands: %s polygons from %s (%d repaired), crs=%s",
             f"{len(gdf):,}", src, int(bad.sum()), gdf.crs.to_epsg())
    return gdf[["OWNER", "pl_class", "geometry"]].reset_index(drop=True)


def overlap_snapshot(snap: sources.Snapshot, polys) -> tuple[pd.DataFrame, dict]:
    import geopandas as gpd
    import shapely

    with snap.local() as src:
        g = gpd.read_file(src.vsi, columns=["PARCELID"], engine="pyogrio")
    if g.crs != polys.crs:
        g = g.to_crs(polys.crs)
    import time
    t0 = time.time()
    geoms = g.geometry.to_numpy()
    bad = ~shapely.is_valid(geoms)
    if bad.any():
        geoms = geoms.copy()
        geoms[bad] = shapely.make_valid(geoms[bad])
    area = shapely.area(geoms)
    parr = polys.geometry.to_numpy().copy()
    shapely.prepare(parr)
    tree = shapely.STRtree(parr)
    pclass = polys["pl_class"].to_numpy()
    t1 = time.time()

    # One predicate pass: every (parcel, public polygon) pair that intersects.
    ix_p, ix_q = tree.query(geoms, predicate="intersects")
    t2 = time.time()
    # Of those, the pairs where the parcel lies wholly inside the polygon need
    # no overlay: public area is the parcel's own area.
    inside_pair = shapely.within(geoms[ix_p], parr[ix_q])
    wi_p, wi_q = ix_p[inside_pair], ix_q[inside_pair]
    sp, sq = ix_p[~inside_pair], ix_q[~inside_pair]
    t3 = time.time()

    # Straddlers: a real overlay. GEOS OverlayNG clips the larger input to the
    # other's envelope before noding, so a parcel against a Forest Service
    # polygon costs what the parcel's neighbourhood costs, not the forest.
    inter = np.zeros(len(sp), dtype="float64")
    if len(sp):
        inter = shapely.area(shapely.intersection(geoms[sp], parr[sq]))
    t4 = time.time()
    log.info("    %s: prep %.0fs, intersects %.0fs (%s pairs), within %.0fs (%s inside), "
             "overlay %.0fs (%s straddling pairs)", snap.date, t1 - t0, t2 - t1,
             f"{len(ix_p):,}", t3 - t2, f"{int(inside_pair.sum()):,}", t4 - t3, f"{len(sp):,}")

    inside = np.zeros(len(geoms), dtype=bool)
    inside[wi_p] = True
    pub_area = np.zeros(len(geoms), dtype="float64")
    np.add.at(pub_area, sp, inter)
    np.add.at(pub_area, wi_p, area[wi_p])
    pub_area = np.minimum(pub_area, area)      # overlapping public polygons cannot exceed the parcel

    # dominant class: the public polygon contributing the most area
    contrib = pd.DataFrame({"p": np.r_[wi_p, sp], "cls": pclass[np.r_[wi_q, sq]],
                            "a": np.r_[area[wi_p], inter]})
    dom = (contrib.groupby(["p", "cls"])["a"].sum().reset_index()
           .sort_values(["p", "a"], ascending=[True, False]).drop_duplicates("p").set_index("p"))
    n_polys = contrib.groupby("p").size()

    pid = gc.normalize(g["PARCELID"])
    out = pd.DataFrame({
        "parcel_id": pid.to_numpy(),
        "geom_acres": area * SQM_TO_ACRES,
        "public_acres": pub_area * SQM_TO_ACRES,
    })
    out["pl_class_area"] = pd.Series(np.arange(len(geoms))).map(dom["cls"]).fillna("").to_numpy()
    out["n_public_polys"] = pd.Series(np.arange(len(geoms))).map(n_polys).fillna(0).to_numpy(dtype="int16")
    out = out[out["parcel_id"] != ""]
    # exploded multipart rows: sum the parts, keep the dominant class of the largest
    agg = out.groupby("parcel_id", sort=False).agg(
        geom_acres=("geom_acres", "sum"), public_acres=("public_acres", "sum"),
        n_public_polys=("n_public_polys", "max"))
    cls = (out.sort_values("public_acres", ascending=False).drop_duplicates("parcel_id")
           .set_index("parcel_id")["pl_class_area"])
    agg["pl_class_area"] = cls
    agg["public_fraction"] = np.where(agg["geom_acres"] > 0,
                                      agg["public_acres"] / agg["geom_acres"], 0.0).astype("float32")
    agg["public_by_area"] = (agg["public_fraction"] >= PUBLIC_FRACTION_CUT).to_numpy()
    agg = agg.reset_index()
    agg["geom_acres"] = agg["geom_acres"].astype("float32")
    agg["public_acres"] = agg["public_acres"].astype("float32")
    qa = {"date": snap.date, "parcels": int(len(agg)), "parcel_rows": int(len(geoms)),
          "invalid_repaired": int(bad.sum()),
          "within_public": int(inside.sum()), "straddling_pairs": int(len(sp)),
          "public_by_area": int(agg["public_by_area"].sum()),
          "partial_public": int(((agg["public_fraction"] > 0) & (agg["public_fraction"] < 1)).sum()),
          "public_acres_total": float(agg["public_acres"].sum()),
          "straddle_public_acres": float((inter * SQM_TO_ACRES).sum())}
    return agg, qa


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Stage 9: public land by area overlap per parcel")
    ap.add_argument("--root", default=sources.DEFAULT_ROOT)
    ap.add_argument("--layer", default=PL_SHP)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    os.makedirs(args.out, exist_ok=True)
    polys = load_polygons(args.layer)
    # One vintage of the layer serves every snapshot and its Edit_Date field is
    # empty, so the file date is the only provenance there is; carry it.
    import time
    layer_path = args.layer if os.path.exists(args.layer) else pl.PL_ZIP
    layer_meta = {"layer_source": layer_path,
                  "layer_file_date": time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(layer_path))),
                  "layer_polygons": int(len(polys))}
    snaps = sources.usable(sources.discover(args.root))
    if args.only:
        snaps = [s for s in snaps if s.date in set(args.only)]
    qa_all = []
    for i, snap in enumerate(snaps, 1):
        dest = os.path.join(args.out, f"area_{snap.date}.parquet")
        if os.path.exists(dest) and not args.force:
            log.info("[%2d/%d] %s already done", i, len(snaps), snap.date)
            continue
        df, qa = overlap_snapshot(snap, polys)
        qa.update(layer_meta)
        df.to_parquet(dest, index=False, compression="zstd")
        qa_all.append(qa)
        log.info("[%2d/%d] %s  within=%s straddle-pairs=%s  public-by-area=%s  partial=%s  "
                 "public acres=%.2fM (straddle %.0f)", i, len(snaps), snap.date,
                 f"{qa['within_public']:,}", f"{qa['straddling_pairs']:,}",
                 f"{qa['public_by_area']:,}", f"{qa['partial_public']:,}",
                 qa["public_acres_total"] / 1e6, qa["straddle_public_acres"])
    with open(os.path.join(args.out, "qa_tenure_area.json"), "w") as fh:
        json.dump(qa_all, fh, indent=2, default=str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
