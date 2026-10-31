"""Incorporated city and town limits, as a map reference overlay.

Source: MSDI *Montana Incorporated Cities and Towns* (the GeoData copy, file
date 2026-05-21; ``LAST_UPDAT`` runs 2009-08-24 to 2026-05-06), 127 polygons in
EPSG:6514. The two consolidated city-counties, Butte-Silver Bow and
Anaconda-Deer Lodge, are the whole county and would only redraw the county
line, so they are left out; the layer's ``TYPE`` field names them.

The overlay is annotation, never measured off. City limits are small and
intricate next to a reservation, so the simplification is 20 m rather than
the reservation overlay's 100 m: under a pixel at z12, where a limit is 2 px
wide, and the file stays well under a megabyte.
"""

from __future__ import annotations

import logging
import os

import pandas as pd

from timeseries.reservations import OVERLAY_PRECISION

log = logging.getLogger("timeseries.cities")

CITIES_SHP = ("/media/mstone/GeoData/MSDI/MontanaIncorporatedCitiesTowns_shp/"
              "MontanaIncorporatedCitiesTowns.shp")
OVERLAY = "data/locator/cities.geojson"
CITY_SIMPLIFY_M = 20.0


def export_overlay(path: str = CITIES_SHP, out: str = OVERLAY) -> dict:
    """Write the city-limits reference overlay (WGS84 GeoJSON)."""
    import geopandas as gpd
    from shapely import get_num_coordinates

    g = gpd.read_file(path, engine="pyogrio")
    consolidated = g["TYPE"].astype(str).str.contains("Consolidated", na=False)
    dropped = g.loc[consolidated, "NAME"].tolist()
    g = g[~consolidated].copy()
    g["acres"] = pd.to_numeric(g["Acres"], errors="coerce").fillna(0.0)
    g["incorporated"] = pd.to_numeric(g["YEAR"], errors="coerce").fillna(0).astype(int)
    g["geometry"] = g.geometry.simplify(CITY_SIMPLIFY_M, preserve_topology=True)
    g = (g.rename(columns={"NAME": "name", "TYPE": "type", "COUNTYNAME": "county"})
          [["name", "type", "county", "incorporated", "acres", "geometry"]]
          .sort_values("name").to_crs(4326))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    if os.path.exists(out):
        os.remove(out)
    g.to_file(out, driver="GeoJSON", coordinate_precision=OVERLAY_PRECISION)
    qa = {"features": int(len(g)), "dropped_consolidated": dropped,
          "acres": float(g["acres"].sum()),
          "vertices": int(get_num_coordinates(g.geometry).sum()),
          "bytes": os.path.getsize(out), "source": path}
    log.info("overlay %s: %d cities and towns (%s left out), %s vertices, %.2f MB",
             out, qa["features"], ", ".join(dropped) or "none", f"{qa['vertices']:,}",
             qa["bytes"] / 1e6)
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="City-limits reference overlay")
    ap.add_argument("--shp", default=CITIES_SHP)
    ap.add_argument("--overlay", default=OVERLAY)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    qa = export_overlay(args.shp, args.overlay)
    with open(os.path.splitext(args.overlay)[0] + "_qa.json", "w") as fh:
        json.dump(qa, fh, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
