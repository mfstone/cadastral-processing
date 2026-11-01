"""Reference layers for orientation: road centerlines and lidar building
footprints, staged beside the parcels so they ride in the same tile pyramid.

Why the same pyramid: Cloudflare Pages caps a deployment at 20,000 files and
the parcel pyramid alone is 11,599. Roads exist in every tile, so a pyramid of
their own would double the count; as extra layers inside the parcel tiles they
cost bytes, not files. Buildings are written at z12 only (sub-pixel below it)
and overzoom from there, quantised to GDAL's 4096-unit extent, about 2.4 m.

Both sources are first-party downloads, so the page fetches nothing from a
third party at run time:

- Montana Transportation Framework, ``RoadCenterLine`` (Montana State Library,
  NENA v2 model), exported 2026-06-01: 257,674 segments. The label is composed
  from the NENA parts; a bare route number is prefixed from the legacy name
  (``I-90``, ``US 191``) or shown as ``Hwy 13``.
- Montana State Library lidar building footprints, all projects: 295,386
  footprints across 37 lidar project areas, 18,551 square miles, about an
  eighth of the state, so a parcel without a footprint may simply be outside
  a flown area. The project boundaries are exported alongside for that
  reason.

Road classes collapse to five draw classes:

| cls | NENA RoadClass | drawn |
|---|---|---|
| 1 | Primary (interstates, US highways) | widest, from z10 |
| 2 | Secondary (state highways) | from z10 |
| 3 | Local, Alley, Service Drive, Ramp | from z10, thin until z12 |
| 4 | Private | from z12, faint |
| 5 | Other, Vehicular Trail (forest and ranch tracks) | from z12, faint |

Walkways, stairways and parking lots (11 rows) are dropped.
"""

from __future__ import annotations

import json
import logging
import os
import time

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio

log = logging.getLogger("reference")

ROADS_CANDIDATES = [
    "/media/mstone/GeoData/MSDI/TransportationFramework_shp/RoadCenterLine.shp",
]
BUILDINGS_CANDIDATES = [
    "/media/mstone/GeoData/MSDI/LidarBuildingFootprints_AllProjects/LidarProjectsBuildingFootprints.gdb",
    "/home/mstone/Downloads/LidarBuildingFootprints_AllProjects/LidarProjectsBuildingFootprints.gdb",
]
LOC_DIR = "data/locator"
MT_STATE_PLANE = 6514  # NAD83(2011) / Montana, the horizontal part of both sources

CLASS = {"Primary": 1, "Secondary": 2, "Local": 3, "Alley": 3, "Service Drive": 3,
         "Ramp": 3, "Private": 4, "Other": 5, "Vehicular Trail": 5}
UNNAMED = {"", "UNNAMED", "DRIVEWAY", "UNKNOWN", "NO NAME"}


def _first(paths: list[str], what: str) -> str:
    for p in paths:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(f"{what}: none of {paths} exists")


def _road_names(df: pd.DataFrame) -> pd.Series:
    """Compose the label from the NENA parts.

    A bare route number in ``St_Name`` ("90", with ``St_PosTyp`` "Highway")
    becomes ``I-90`` or ``US 2`` when the legacy name says so, else ``Hwy 13``;
    the "Highway" type word is dropped for those, the directional kept.
    """
    col = {c: df[c].fillna("").astype(str).str.strip()
           for c in ("St_PreDir", "St_Name", "St_PosTyp", "St_PosDir")}
    legacy = df["LSt_Name"].fillna("").astype(str).str.upper().str.strip()
    numeric = col["St_Name"].str.fullmatch(r"\d+[A-Z]?").fillna(False)
    primary = df["RoadClass"].eq("Primary")
    inter = legacy.str.contains(r"^I[ -]?\d|INTERSTATE", regex=True)
    us = legacy.str.contains(r"^US[ -]?\d|\bU ?S ?HWY|^U S \d", regex=True)
    prefix = pd.Series(np.select([numeric & primary & inter, numeric & primary & us, numeric],
                                 ["I-", "US ", "Hwy "], ""), index=df.index, dtype="object")
    core = prefix + col["St_Name"]
    typ = col["St_PosTyp"].where(~numeric, "")  # "90 Highway" -> "I-90"
    name = (col["St_PreDir"] + " " + core + " " + typ + " " + col["St_PosDir"]).str.strip()
    name = name.str.replace(r"\s+", " ", regex=True)
    name[name.str.upper().isin(UNNAMED)] = ""
    return name


def stage_roads(work_dir: str, reuse: bool = False) -> tuple[str, dict]:
    out = f"{work_dir}/roads.fgb"
    hwy = f"{LOC_DIR}/highways.geojson"
    if reuse and os.path.exists(out) and os.path.exists(hwy):
        log.info("reusing staged roads %s", out)
        return out, {"reused": True}
    src = _first(ROADS_CANDIDATES, "road centerlines")
    t0 = time.time()
    g = pyogrio.read_dataframe(
        src, columns=["St_PreDir", "St_Name", "St_PosTyp", "St_PosDir", "LSt_Name",
                      "RoadClass", "SurfaceTyp"])
    n_in = len(g)
    g["cls"] = g["RoadClass"].map(CLASS)
    g = g[g["cls"].notna()].copy()
    g["cls"] = g["cls"].astype("int16")
    g["name"] = _road_names(g)
    g["pav"] = g["SurfaceTyp"].map({"Paved": 1, "Gravel": 0, "Dirt": 0}).fillna(-1).astype("int16")
    roads = g[["name", "cls", "pav", "geometry"]]
    log.info("roads: %s of %s segments kept, %.0f%% named, read %.0fs",
             f"{len(roads):,}", f"{n_in:,}", 100 * (roads["name"] != "").mean(),
             time.time() - t0)

    # Statewide highways for the zooms the tiles do not cover: primary and
    # secondary routes dissolved by name and simplified to 150 m.
    h = roads[roads["cls"] <= 2].copy()
    if h.crs is None or h.crs.to_epsg() != MT_STATE_PLANE:
        h = h.set_crs(MT_STATE_PLANE, allow_override=True)
    h = h.dissolve(by=["name", "cls"], as_index=False)[["name", "cls", "geometry"]]
    h["geometry"] = h.geometry.simplify(150, preserve_topology=False)
    h = h.to_crs(4326)
    os.makedirs(LOC_DIR, exist_ok=True)
    h.to_file(hwy, driver="GeoJSON", COORDINATE_PRECISION=5)
    log.info("highways: %s routes, %.1f MB", f"{len(h):,}", os.path.getsize(hwy) / 1e6)

    os.makedirs(work_dir, exist_ok=True)
    roads.to_crs(4326).to_file(out, driver="FlatGeobuf")
    qa = {"source": src, "segments_in": int(n_in), "segments_kept": int(len(roads)),
          "pct_named": round(100 * float((roads["name"] != "").mean()), 1),
          "by_class": {int(k): int(v) for k, v in roads["cls"].value_counts().sort_index().items()},
          "highway_routes": int(len(h)), "highways_bytes": os.path.getsize(hwy)}
    return out, qa


def stage_buildings(work_dir: str, reuse: bool = False) -> tuple[str, dict]:
    out = f"{work_dir}/buildings.fgb"
    cov = f"{LOC_DIR}/lidar_coverage.geojson"
    if reuse and os.path.exists(out) and os.path.exists(cov):
        log.info("reusing staged buildings %s", out)
        return out, {"reused": True}
    src = _first(BUILDINGS_CANDIDATES, "lidar building footprints")
    t0 = time.time()
    # The feature class is MultiPolygon ZM in a compound CRS (NAD83(2011)
    # Montana + NAVD88); only the horizontal part is wanted.
    b = pyogrio.read_dataframe(src, layer="BuildingFootprints", columns=["AVG_HEIGHT"],
                               force_2d=True)
    b = b.set_crs(MT_STATE_PLANE, allow_override=True)
    b["h"] = b["AVG_HEIGHT"].fillna(0).round(1).astype("float32")
    bld = b[["h", "geometry"]]
    log.info("buildings: %s footprints, read %.0fs", f"{len(bld):,}", time.time() - t0)
    bnd = pyogrio.read_dataframe(src, layer="BuildingFootprintBoundary",
                                 columns=["ProjectName", "SqMiles"], force_2d=True)
    bnd = bnd.set_crs(MT_STATE_PLANE, allow_override=True)
    bnd["geometry"] = bnd.geometry.simplify(200, preserve_topology=True)
    bnd = bnd.rename(columns={"ProjectName": "project", "SqMiles": "sq_miles"}).to_crs(4326)
    os.makedirs(LOC_DIR, exist_ok=True)
    bnd.to_file(cov, driver="GeoJSON", COORDINATE_PRECISION=4)
    os.makedirs(work_dir, exist_ok=True)
    bld.to_crs(4326).to_file(out, driver="FlatGeobuf")
    qa = {"source": src, "footprints": int(len(bld)), "projects": int(len(bnd)),
          "coverage_sq_miles": round(float(bnd["sq_miles"].sum())),
          "mean_height_m": round(float(b["AVG_HEIGHT"].mean()), 2)}
    return out, qa


def stage(work_dir: str, reuse: bool = False) -> dict[str, str]:
    """Stage both layers; returns ``{layer name: FlatGeobuf path}``."""
    roads, qa_r = stage_roads(work_dir, reuse)
    bld, qa_b = stage_buildings(work_dir, reuse)
    os.makedirs(LOC_DIR, exist_ok=True)
    if not (qa_r.get("reused") and qa_b.get("reused")):
        with open(f"{LOC_DIR}/reference_qa.json", "w") as fh:
            json.dump({"roads": qa_r, "buildings": qa_b}, fh, indent=1)
    return {"roads": roads, "buildings": bld}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    from . import tiles
    print(json.dumps(stage(tiles.WORK_DIR), indent=1))
