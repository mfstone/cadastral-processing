"""Reservation boundaries and off-reservation trust land.

`MontanaReservations_shp.zip` carries two layers: the seven Montana reservations
(8.39 M acres) and off-reservation trust land (174 k acres), both EPSG:6514.

**A reservation boundary is jurisdictional, not a form of ownership**, and
conflating the two would be the single easiest error to make with this layer.
Reservations contain large amounts of fee land in non-tribal ownership, the
legacy of allotment-era parcelling, and the proportion varies enormously:

=================  ============  =============
reservation        tribal trust  fee / private
=================  ============  =============
Rocky Boy's               99.9%           0.0%
Northern Cheyenne         97.9%           2.1%
Fort Belknap              91.9%           4.7%
Blackfeet                 67.0%          32.6%
Crow                      64.0%          34.0%
Flathead                  62.7%          33.4%
**Fort Peck**           **40.5%**      **59.3%**
=================  ============  =============

So `reservation` is published as its own dimension alongside tenure, never
folded into it. The crosstab of the two is the checkerboard, and tracking it
across 29 vintages is what makes land buy-back visible.

The layer also independently validates the name-based tribal classification:
**95.4% of name-classified tribal parcels fall inside a reservation boundary**
and a further 542 sit on off-reservation trust land, leaving 395 of 20,238
(2.0%) in neither.
"""

from __future__ import annotations

import json
import logging
import os

import pandas as pd

from . import geocode as gc
from . import sources

log = logging.getLogger("timeseries.reservations")

RES_ZIP = "/media/mstone/Extreme SSD/Cadastral/MontanaReservations_shp.zip"
RES_INNER = "MontanaReservations_shp/MontanaReservations.shp"
OFF_INNER = "MontanaReservations_shp/OffReservationTrustLand.shp"
OUT_DIR = "data/reservations"


def load_layers(zip_path: str = RES_ZIP):
    import geopandas as gpd

    res = gpd.read_file(f"/vsizip/{zip_path}/{RES_INNER}", engine="pyogrio")
    off = gpd.read_file(f"/vsizip/{zip_path}/{OFF_INNER}", engine="pyogrio")
    res = res[["NAME", "TRIBE_NAME", "geometry"]].copy()
    res["NAME"] = res["NAME"].astype(str).str.strip()
    # The tribe name carries trailing CRLF in the source.
    res["TRIBE_NAME"] = (res["TRIBE_NAME"].astype(str)
                         .str.replace(r"\s+", " ", regex=True).str.strip())
    off = off[["NAME", "geometry"]].rename(columns={"NAME": "OFF_NAME"}).copy()
    off["OFF_NAME"] = off["OFF_NAME"].astype(str).str.strip()
    log.info("reservations: %d (%s), off-reservation trust: %d",
             len(res), ", ".join(res["NAME"]), len(off))
    return res, off


# The boundary overlay is annotation, drawn as an outline so a reader can see
# that a cluster of tribal-trust parcels sits inside a reservation. It is never
# measured off, so 100 m takes 43,392 source vertices to 2,304 -- a tenth of a
# pixel at the zoom where the outline is 1 px wide. Acres are computed from the
# *unsimplified* geometry, because they are quoted in the hover label.
OVERLAY_SIMPLIFY_M = 100.0
OVERLAY_PRECISION = 5


def _title(s: pd.Series) -> pd.Series:
    """Title-case without `str.title`, which renders ROCKY BOY'S as Rocky Boy'S."""
    return s.str.split().apply(
        lambda ws: " ".join(w[:1].upper() + w[1:].lower() for w in ws))


def export_overlay(res, path: str) -> dict:
    """Write the reservation boundary reference overlay."""
    from cadastral.schema import SQM_TO_ACRES

    g = res.copy()
    g["acres"] = g.geometry.area * SQM_TO_ACRES
    g["geometry"] = g.geometry.simplify(OVERLAY_SIMPLIFY_M, preserve_topology=True)
    g["NAME"] = _title(g["NAME"])
    g = (g.rename(columns={"NAME": "name", "TRIBE_NAME": "tribe"})
          [["name", "tribe", "acres", "geometry"]].to_crs(4326))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    g.to_file(path, driver="GeoJSON", coordinate_precision=OVERLAY_PRECISION)
    from shapely import get_num_coordinates
    qa = {"features": len(g), "acres": float(g["acres"].sum()),
          "vertices": int(get_num_coordinates(g.geometry).sum()),
          "bytes": os.path.getsize(path)}
    log.info("overlay %s: %d reservations, %.2fM acres, %s vertices, %.2f MB",
             path, qa["features"], qa["acres"] / 1e6, f"{qa['vertices']:,}",
             qa["bytes"] / 1e6)
    return qa


def join_snapshot(snap: sources.Snapshot, res, off) -> pd.DataFrame:
    import geopandas as gpd

    with snap.local() as src:
        g = gpd.read_file(src.vsi, columns=["PARCELID"], engine="pyogrio")
    pts = g[["PARCELID"]].copy()
    pts["geometry"] = g.geometry.representative_point()
    pts = gpd.GeoDataFrame(pts, geometry="geometry", crs=g.crs).to_crs(res.crs)

    a = gpd.sjoin(pts, res, how="left", predicate="within")
    a = a[~a.index.duplicated(keep="first")]
    b = gpd.sjoin(pts, off, how="left", predicate="within")
    b = b[~b.index.duplicated(keep="first")]

    out = pd.DataFrame({
        "parcel_id": gc.normalize(a["PARCELID"]).to_numpy(),
        "reservation": a["NAME"].fillna("").to_numpy(),
        "tribe": a["TRIBE_NAME"].fillna("").to_numpy(),
        "off_res_trust": b["OFF_NAME"].notna().to_numpy(),
    })
    out = out[out["parcel_id"] != ""].drop_duplicates("parcel_id")
    out["in_reservation"] = out["reservation"] != ""
    return out


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Reservation / trust-land spatial flags")
    ap.add_argument("--root", default=sources.DEFAULT_ROOT)
    ap.add_argument("--zip", default=RES_ZIP)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--overlay", default="data/locator/reservations.geojson",
                    help="where to write the map reference overlay")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    os.makedirs(args.out, exist_ok=True)
    res, off = load_layers(args.zip)
    export_overlay(res, args.overlay)

    snaps = sources.usable(sources.discover(args.root))
    if args.only:
        snaps = [s for s in snaps if s.date in set(args.only)]
    qa_all = []
    for i, snap in enumerate(snaps, 1):
        dest = os.path.join(args.out, f"res_{snap.date}.parquet")
        if os.path.exists(dest) and not args.force:
            log.info("[%2d/%d] %s already joined", i, len(snaps), snap.date)
            continue
        df = join_snapshot(snap, res, off)
        df.to_parquet(dest, index=False, compression="zstd")
        qa = {"date": snap.date, "parcels": int(len(df)),
              "in_reservation": int(df["in_reservation"].sum()),
              "off_res_trust": int(df["off_res_trust"].sum()),
              "by_reservation": df.loc[df["in_reservation"], "reservation"]
                                  .value_counts().to_dict()}
        qa_all.append(qa)
        log.info("[%2d/%d] %s  %s in reservations, %s on off-reservation trust",
                 i, len(snaps), snap.date, f"{qa['in_reservation']:,}", f"{qa['off_res_trust']:,}")
    with open(os.path.join(args.out, "qa_reservations.json"), "w") as fh:
        json.dump(qa_all, fh, indent=2, default=str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
