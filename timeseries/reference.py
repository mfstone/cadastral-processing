"""Reference layers for orientation: road centerlines and building footprints,
staged beside the parcels so they ride in the same tile pyramid.

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
- Building footprints from two sets, merged. Microsoft's computer-generated
  US Building Footprints, 2018-07-17 release, as redistributed by the State
  Library (ODbL): 762,288 polygons statewide, 7 invalid, no attributes, and
  a vintage the metadata cannot state because Bing imagery is a composite.
  Measured against the appraiser's year built (stage 11) the set carries 90%
  of dwellings built before 2015 and 11% of those built 2018 or later, which
  dates the imagery to about 2014-2015. The State Library's lidar building
  footprints: 295,386 across 37 project areas, 18,346 square miles, an eighth
  of the state, flown 2016-2023. Where both exist the lidar geometry is kept
  and the 2018 polygon it intersects is dropped; a 2018 polygon inside a
  flown area that no lidar footprint touches is kept and tagged, since it is
  either gone by the flight or missed by it. ``src``: 1 = the 2018 set
  outside the flown areas, 2 = lidar only, 3 = lidar confirmed by the 2018
  set, 4 = the 2018 set unseen by lidar. The lidar ``AVG_HEIGHT`` is not
  carried: it is feet in most projects, metres in the two 2023 projects,
  ground elevation in Sanders and null in the five Phase 1 projects. The
  project boundaries are exported alongside so a viewer can tell "not
  flown" from "no building".

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
MS_CANDIDATES = [
    "/media/mstone/GeoData/MSDI/Montana_Building_Footprints/Montana_Building_Footprints.shp",
    "/home/mstone/Downloads/Montana_Building_Footprints/Montana_Building_Footprints.shp",
]
SRC_MS, SRC_LIDAR, SRC_BOTH, SRC_MS_UNSEEN = 1, 2, 3, 4
SHED_M2 = 40   # size floor used in the QA counts only: below it the lidar sees sheds the imagery model does not
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


def _read_lidar(src: str) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """The lidar footprints and their project boundaries, horizontal only.

    The feature class is MultiPolygon ZM in a compound CRS (NAD83(2011)
    Montana + NAVD88); only the horizontal part is wanted.
    """
    li = pyogrio.read_dataframe(src, layer="BuildingFootprints", columns=["area_sq_m"], force_2d=True)
    li = li.set_crs(MT_STATE_PLANE, allow_override=True)
    li["geometry"] = li.geometry.buffer(0)
    bnd = pyogrio.read_dataframe(src, layer="BuildingFootprintBoundary",
                                 columns=["ProjectName", "SqMiles"], force_2d=True)
    bnd = bnd.set_crs(MT_STATE_PLANE, allow_override=True)
    bnd["geometry"] = bnd.geometry.buffer(0)
    return li, bnd.rename(columns={"ProjectName": "project", "SqMiles": "sq_miles"})


def coverage_test(bld: gpd.GeoDataFrame, parcels_fgb: str, cama_path: str) -> dict:
    """The footprints against the appraiser's dwellings, counts on both sides.

    The dwelling side is stage 11's frame: a parcel whose DOR property carries
    a residential building record on the roll the tiles are built from. The
    footprint side is the merged layer. Year built dates the 2018 set's
    imagery, which its metadata cannot.
    """
    par = pyogrio.read_dataframe(parcels_fgb, columns=["id"]).to_crs(MT_STATE_PLANE)
    pts = gpd.GeoDataFrame({"src": bld["src"].to_numpy()},
                           geometry=bld.geometry.representative_point(), crs=MT_STATE_PLANE)
    j = gpd.sjoin(pts, par[["id", "geometry"]], how="inner", predicate="within")
    j = j[~j.index.duplicated(keep="first")]
    off_parcel = int(len(pts) - len(j))
    j["is2018"] = j["src"].isin([SRC_MS, SRC_BOTH, SRC_MS_UNSEEN])
    j["islidar"] = j["src"].isin([SRC_LIDAR, SRC_BOTH])
    g = j.groupby("id")[["is2018", "islidar"]].any()

    cm = pd.read_parquet(cama_path, columns=["parcel_id", "county_n", "has_dwelling", "yb_res"])
    cm = cm[cm["has_dwelling"]].set_index("parcel_id")
    dw = par[par["id"].isin(cm.index)][["id"]].copy()
    dw["yb"] = dw["id"].map(cm["yb_res"]).fillna(0).astype(int)
    dw["county_n"] = dw["id"].map(cm["county_n"]).astype(int)
    dw["fp"] = dw["id"].isin(g.index)
    dw["fp2018"] = dw["id"].map(g["is2018"]).fillna(False).astype(bool)
    dw["fplidar"] = dw["id"].map(g["islidar"]).fillna(False).astype(bool)

    def pct(col, mask=None):
        d = dw if mask is None else dw[mask]
        return round(100 * float(d[col].mean()), 1) if len(d) else None

    out = {"dwelling_parcels": int(len(dw)),
           "with_footprint": int(dw["fp"].sum()), "pct": pct("fp"),
           "with_2018": int(dw["fp2018"].sum()), "pct_2018": pct("fp2018"),
           "with_lidar": int(dw["fplidar"].sum()), "pct_lidar": pct("fplidar"),
           "pct_2018_built_before_2015": pct("fp2018", dw["yb"].between(1, 2014)),
           "pct_2018_built_2015_2017": pct("fp2018", dw["yb"].between(2015, 2017)),
           "pct_2018_built_2018_on": pct("fp2018", dw["yb"] >= 2018),
           "footprints_on_no_parcel": off_parcel,
           # per county: dwelling parcels, with any footprint, with a 2018 one, with a lidar one
           "by_county": {int(c): [int(len(d)), int(d["fp"].sum()), int(d["fp2018"].sum()), int(d["fplidar"].sum())]
                         for c, d in dw.groupby("county_n")}}
    log.info("footprint coverage: %s of %s dwelling parcels (%.1f%%); 2018 set %.1f%%, lidar %.1f%%",
             f"{out['with_footprint']:,}", f"{out['dwelling_parcels']:,}", out["pct"], out["pct_2018"], out["pct_lidar"])
    return out


def stage_buildings(work_dir: str, reuse: bool = False, parcels: str | None = None,
                    cama: str | None = None) -> tuple[str, dict]:
    """Merge the 2018 set with the lidar footprints and tag each by source."""
    out = f"{work_dir}/buildings.fgb"
    cov = f"{LOC_DIR}/lidar_coverage.geojson"
    if reuse and os.path.exists(out) and os.path.exists(cov):
        log.info("reusing staged buildings %s", out)
        return out, {"reused": True}
    ms_src = _first(MS_CANDIDATES, "Microsoft 2018 building footprints")
    li_src = _first(BUILDINGS_CANDIDATES, "lidar building footprints")
    t0 = time.time()
    ms = pyogrio.read_dataframe(ms_src, columns=[]).to_crs(MT_STATE_PLANE)
    n_ms = len(ms)
    n_invalid = int((~ms.geometry.is_valid).sum())
    ms["geometry"] = ms.geometry.buffer(0)
    ms = ms[~ms.geometry.is_empty].copy()
    li, bnd = _read_lidar(li_src)
    log.info("footprints: %s from the 2018 set (%s invalid), %s from lidar, read %.0fs",
             f"{n_ms:,}", n_invalid, f"{len(li):,}", time.time() - t0)

    # Which 2018 footprints lie inside a flown area, and which touch a lidar one.
    mpts = gpd.GeoDataFrame(geometry=ms.geometry.representative_point(), crs=MT_STATE_PLANE)
    inside = gpd.sjoin(mpts, bnd[["geometry"]], how="inner", predicate="within").index.unique()
    ms["in_lidar"] = ms.index.isin(inside)
    pairs = gpd.sjoin(ms[["geometry"]], li[["geometry"]], how="inner", predicate="intersects")
    ms_hit = ms.index.isin(pairs.index.unique())
    li_hit = li.index.isin(pairs["index_right"].unique())
    li["src"] = np.where(li_hit, SRC_BOTH, SRC_LIDAR)
    ms["src"] = np.where(ms["in_lidar"], SRC_MS_UNSEEN, SRC_MS)
    keep = ms[~ms_hit]   # a 2018 footprint the lidar also saw is drawn from the lidar geometry
    bld = gpd.GeoDataFrame(pd.concat([keep[["src", "geometry"]], li[["src", "geometry"]]], ignore_index=True),
                           geometry="geometry", crs=MT_STATE_PLANE)
    bld["src"] = bld["src"].astype("int16")
    big_ms = ms["area_m2"] = ms.geometry.area
    qa = {"source_2018": ms_src, "source_lidar": li_src,
          "footprints_2018": int(n_ms), "invalid_2018": n_invalid,
          "footprints_lidar": int(len(li)), "projects": int(len(bnd)),
          "coverage_sq_miles": round(float(bnd.geometry.union_all().area / 2.589988e6)),
          "pairs": int(len(pairs)),
          "pct_2018_in_flown_area_seen_by_lidar": round(100 * float(ms_hit[ms["in_lidar"].to_numpy()].mean()), 1),
          "pct_2018_in_flown_area_seen_by_lidar_over_40m2":
              round(100 * float(ms_hit[(ms["in_lidar"] & (big_ms >= SHED_M2)).to_numpy()].mean()), 1),
          "pct_lidar_seen_in_2018": round(100 * float(li_hit.mean()), 1),
          "pct_lidar_seen_in_2018_over_40m2": round(100 * float(li_hit[(li["area_sq_m"] >= SHED_M2).to_numpy()].mean()), 1),
          "lidar_under_40m2": int((li["area_sq_m"] < SHED_M2).sum()),
          "published": int(len(bld)),
          "by_src": {int(k): int(v) for k, v in bld["src"].value_counts().sort_index().items()}}
    # The 2018 footprint the lidar also saw: dropped as a duplicate, counted here.
    qa["dropped_2018_duplicates"] = int(ms_hit.sum())
    if parcels and cama and os.path.exists(parcels) and os.path.exists(cama):
        qa["coverage"] = coverage_test(bld, parcels, cama)
    else:
        log.warning("no parcel source or CAMA frame given; footprint coverage not tested")

    bnd = bnd.copy()
    bnd["geometry"] = bnd.geometry.simplify(200, preserve_topology=True)
    os.makedirs(LOC_DIR, exist_ok=True)
    bnd[["project", "sq_miles", "geometry"]].to_crs(4326).to_file(cov, driver="GeoJSON", COORDINATE_PRECISION=4)
    os.makedirs(work_dir, exist_ok=True)
    bld.to_crs(4326).to_file(out, driver="FlatGeobuf")
    log.info("buildings: %s published (%s), %.0fs", f"{len(bld):,}",
             ", ".join(f"src {k}: {v:,}" for k, v in qa["by_src"].items()), time.time() - t0)
    return out, qa


def stage(work_dir: str, reuse: bool = False, parcels: str | None = None,
          cama: str | None = None) -> dict[str, str]:
    """Stage both layers; returns ``{layer name: FlatGeobuf path}``.

    ``parcels`` (the staged parcel FlatGeobuf) and ``cama`` (stage 11's parcel
    frame for the same date) switch on the footprint coverage test.
    """
    roads, qa_r = stage_roads(work_dir, reuse)
    bld, qa_b = stage_buildings(work_dir, reuse, parcels, cama)
    os.makedirs(LOC_DIR, exist_ok=True)
    if not (qa_r.get("reused") and qa_b.get("reused")):
        with open(f"{LOC_DIR}/reference_qa.json", "w") as fh:
            json.dump({"roads": qa_r, "buildings": qa_b}, fh, indent=1)
    return {"roads": roads, "buildings": bld}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    from . import tiles
    print(json.dumps(stage(tiles.WORK_DIR), indent=1))
