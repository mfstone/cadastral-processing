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
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    os.makedirs(args.out, exist_ok=True)
    polys = load_polygons(args.zip)

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
