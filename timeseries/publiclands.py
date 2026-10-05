"""Public land by location rather than by owner name.

`MTPublicLands_SHP.zip` (31,091 polygons, EPSG:6514, 33.54 M acres across 19
owner categories) gives a **locational** answer to "is this parcel public",
which is independent of how the owner happens to be named. That independence is
the point: the two methods agree on 97.1% of parcels in 2026, and each
disagreement bucket is informative.

* **Spatial public, name private** (2,439 parcels) -- genuine misses by the name
  rules: ``MONTANA HISTORICAL SOCIETY``, ``ST MT DEPT OF NATURAL RESOURCES``,
  ``GALLATIN AIRPORT AUTHORITY``, ``GREAT FALLS PUBLIC SCHOOLS``.
* **Name public, spatial private** (23,681 parcels, 5.57 M acres) -- almost
  entirely **tribal trust land**: ``USA IN TRUST`` 5,279, ``USA IN TRUST FOR
  CROW TRIBE`` 3,922, Fort Peck 1,164, Fort Belknap 1,114. Correctly absent from
  a *public lands* layer, because trust land is not public domain.

So the two sources are not rivals; they answer different questions, and the
published taxonomy needs three categories rather than two:

======================  ======================================================
category                source
======================  ======================================================
public domain           this layer -- authoritative, and names the agency
tribal trust            owner name (``USA IN TRUST``, tribe names)
private                 neither
======================  ======================================================

It also settles the Washington DC problem. Of 1,965 parcels with a DC mailing
address, 85.3% sit on mapped public land and 94.4% are public by one source or
the other; the 111 that are neither are genuine private owners.

**One vintage, applied to every year.** The layer is a single 2026 snapshot, so
a 2003 parcel is being tested against today's public-land boundaries. Land does
change hands through acquisition and exchange, so the historical flag is an
approximation and is labelled as such.

Method: parcel representative point within a public-land polygon. Cheap -- about
12 seconds per snapshot, all 29 in roughly six minutes -- and unambiguous for
parcels wholly inside or outside, which is nearly all of them (only 2 points in
2026 fell inside more than one polygon).
"""

from __future__ import annotations

import json
import logging
import os

import numpy as np
import pandas as pd

from . import geocode as gc
from . import sources

log = logging.getLogger("timeseries.publiclands")

PL_ZIP = "/media/mstone/Extreme SSD/Cadastral/MTPublicLands_SHP.zip"
PL_INNER = "Montana_PublicLands/Montana_PublicLands.shp"
OUT_DIR = "data/publiclands"

# The layer's 19 OWNER strings, grouped to the published classes. Tribal is
# deliberately absent: this layer carries no trust land.
OWNER_TO_CLASS = {
    "US Forest Service": "federal",
    "US Bureau of Land Management": "federal",
    "National Park Service": "federal",
    "US Fish and Wildlife Service": "federal",
    "US Bureau of Reclamation": "federal",
    "US Department of Agriculture": "federal",
    "US Department of Defense": "federal",
    "US Army Corps of Engineers": "federal",
    "US Government": "federal",
    "Montana State Trust Lands": "state",
    "Montana Fish, Wildlife, and Parks": "state",
    "State of Montana": "state",
    "Montana Department of Corrections": "state",
    "Montana University System": "state",
    "Montana Department of Natural Resources and Conservation": "state",
    "Montana Department of Transportation": "state",
    "County Government": "local_government",
    "City Government": "local_government",
    "Local Government": "local_government",
}


def load_polygons(zip_path: str = PL_ZIP):
    import geopandas as gpd

    uri = f"/vsizip/{zip_path}/{PL_INNER}"
    gdf = gpd.read_file(uri, engine="pyogrio")
    gdf["pl_class"] = gdf["OWNER"].map(OWNER_TO_CLASS).fillna("other_public")
    log.info("public lands: %s polygons, %.2fM acres, crs=%s",
             f"{len(gdf):,}", gdf["Acreage"].sum() / 1e6, gdf.crs.to_epsg())
    return gdf[["OWNER", "pl_class", "geometry"]]


# The overlay is *reference*, not analysis. Nothing is measured off it: the
# analytical public-land flag comes from `join_snapshot` below, a full-resolution
# point-in-polygon against every one of the 31,091 source polygons. So reducing
# the drawn layer cannot move a published number -- only the wash.
#
# What it must keep is the school-trust checkerboard. Sections 16 and 36 of each
# township are state land, so ~9,000 of those polygons are a 640-acre grid that
# is one of the most recognisable facts about Montana land tenure, and the
# reason the dissolved layer carries 1,095,567 vertices in the first place.
#
# Measured, dissolved to 4 classes, at coordinate precision 4 (~11 m):
#
#   | filter   | simplify | vertices | raw     | wire    | acreage kept |
#   |----------|---------:|---------:|--------:|--------:|-------------:|
#   | none     |     none | 1,095,567|       - |       - |      100.00% |
#   | >=40 ac  |     60 m |  213,810 | 5.22 MB | 0.89 MB |       99.66% |
#   | >=40 ac  |    250 m |  162,198 | 3.99 MB | 0.69 MB |       99.66% |
#   | >=40 ac  |    500 m |  121,372 | 3.03 MB | 0.56 MB |       99.66% |
#
# 60 m is chosen, not the cheaper rows: it is ~1 px at z10 and ~4.6 px at z12,
# where the boundary sits beside crisp parcel edges and a visibly wrong edge
# would cost more trust than 2 MB is worth. The layer is off by default, lazily
# fetched, and measured at **1.7 s** from click to painted -- there is no load
# problem here to solve. The 40-acre floor drops 46% of the polygons for 0.34%
# of the acreage and leaves every school-trust section standing.
OVERLAY_MIN_ACRES = 40.0
OVERLAY_SIMPLIFY_M = 60.0
OVERLAY_PRECISION = 4


def export_overlay(polys, path: str) -> dict:
    """Write the dissolved, simplified reference overlay."""
    import geopandas as gpd

    from cadastral.schema import SQM_TO_ACRES

    keep = polys[(polys.geometry.area * SQM_TO_ACRES) >= OVERLAY_MIN_ACRES]
    g = keep.dissolve(by="pl_class", as_index=False)[["pl_class", "geometry"]]
    g["geometry"] = g.geometry.simplify(OVERLAY_SIMPLIFY_M, preserve_topology=True)
    g = g.rename(columns={"pl_class": "cls"}).to_crs(4326)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    g.to_file(path, driver="GeoJSON", coordinate_precision=OVERLAY_PRECISION)
    from shapely import get_num_coordinates
    qa = {"features": len(g), "vertices": int(get_num_coordinates(g.geometry).sum()),
          "bytes": os.path.getsize(path), "polygons_kept": int(len(keep)),
          "polygons_source": int(len(polys))}
    log.info("overlay %s: %d classes from %s of %s polygons, %s vertices, %.2f MB",
             path, qa["features"], f"{len(keep):,}", f"{len(polys):,}",
             f"{qa['vertices']:,}", qa["bytes"] / 1e6)
    return qa


def join_snapshot(snap: sources.Snapshot, polys) -> pd.DataFrame:
    """Representative point of each parcel against the public-land polygons."""
    import geopandas as gpd

    with snap.local() as src:
        g = gpd.read_file(src.vsi, columns=["PARCELID"], engine="pyogrio")
    pts = g[["PARCELID"]].copy()
    pts["geometry"] = g.geometry.representative_point()
    pts = gpd.GeoDataFrame(pts, geometry="geometry", crs=g.crs)
    if pts.crs != polys.crs:
        pts = pts.to_crs(polys.crs)
    j = gpd.sjoin(pts, polys, how="left", predicate="within")
    # A point inside two polygons would duplicate the row; keep the first.
    j = j[~j.index.duplicated(keep="first")]
    pid = gc.normalize(j["PARCELID"])
    out = pd.DataFrame({
        "parcel_id": pid.to_numpy(),
        "pl_owner": j["OWNER"].fillna("").to_numpy(),
        "pl_class": j["pl_class"].fillna("").to_numpy(),
    })
    out = out[out["parcel_id"] != ""].drop_duplicates("parcel_id")
    out["on_public_land"] = out["pl_class"] != ""
    return out


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Spatial public-land flag per parcel")
    ap.add_argument("--root", default=sources.DEFAULT_ROOT)
    ap.add_argument("--zip", default=PL_ZIP)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--overlay", default="data/locator/publiclands.geojson",
                    help="where to write the map reference overlay")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    os.makedirs(args.out, exist_ok=True)
    polys = load_polygons(args.zip)
    export_overlay(polys, args.overlay)

    snaps = sources.usable(sources.discover(args.root))
    if args.only:
        snaps = [s for s in snaps if s.date in set(args.only)]
    qa_all = []
    for i, snap in enumerate(snaps, 1):
        dest = os.path.join(args.out, f"public_{snap.date}.parquet")
        if os.path.exists(dest) and not args.force:
            log.info("[%2d/%d] %s already joined", i, len(snaps), snap.date)
            continue
        df = join_snapshot(snap, polys)
        df.to_parquet(dest, index=False, compression="zstd")
        qa = {"date": snap.date, "parcels": int(len(df)),
              "on_public_land": int(df["on_public_land"].sum()),
              "pct_public": round(100.0 * float(df["on_public_land"].mean()), 3),
              "by_class": df.loc[df["on_public_land"], "pl_class"].value_counts().to_dict()}
        qa_all.append(qa)
        log.info("[%2d/%d] %s  %s of %s parcels on public land (%.2f%%)", i, len(snaps),
                 snap.date, f"{qa['on_public_land']:,}", f"{qa['parcels']:,}", qa["pct_public"])
    with open(os.path.join(args.out, "qa_publiclands.json"), "w") as fh:
        json.dump(qa_all, fh, indent=2, default=str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
