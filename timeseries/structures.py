"""Stage 12: the Structures/Addresses Framework as a witness to the parcel
layer's address rung and to the DOR's dwellings.

The source is the Montana State Library's Structures Framework
(``SiteStructureAddressPoint``, NENA GIS Data Model v2), a monthly export of
the address points local governments assign plus theme points for schools,
hospitals and the like. The 2026-10-30 export holds 674,730 points: 662,696
address points and 12,034 structure points; 670,083 carry a house number,
655,022 a ``ParcelID`` (the DOR geocode, as the local government recorded it),
629,742 are placed on the structure itself (``Placement``), the rest at the
property access, by geocoding, or unknown. ``MT_PlcType`` is the state's own
structure classification (101 single-family dwelling, 102 multi-family, 107
mobile home, 104 storage, 601 school, ...); ``Place_Type`` is the RFC 4589
registry value, ``residence`` on 494,221.

Two joins, so the point can be tested against itself as well as against the
parcel layer: spatial containment in the newest export's parcel polygons, and
the ``ParcelID`` the local government recorded. Every test is a count on both
sides:

| test | one side | the other |
|---|---|---|
| address rung | parcel layer ``has_house_number`` | a numbered address point on the parcel |
| dwelling | DOR dwelling record (stage 11) | a residential point (MT_PlcType 101-103, 106, 107 or Place_Type residence) |
| geocode | the point's stated ``ParcelID`` | the parcel that contains the point |
| units | DOR dwelling count / condo-townhouse flag | points with a ``Unit`` on the parcel |
| manufactured home | DOR ``any_mh`` | a mobile-home point (107) |
| placement | ``Placement`` = Structure | the share of points that can witness a structure at all |

Outputs, keyed on the newest export date: ``points_{date}.parquet`` (one row
per point with both joins), ``parcels_structures_{date}.parquet`` (one row per
parcel with the counts stage 11 joins for the published witness), and
``qa_structures.json`` with the tests statewide and per county.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import time

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio

from . import geocode as gc
from . import sources

log = logging.getLogger("structures")

CANDIDATES = [
    "/media/mstone/GeoData/MSDI/StructuresFramework_shp/SiteStructureAddressPoint.shp",
    "/home/mstone/Downloads/StructuresFramework_shp/SiteStructureAddressPoint.shp",
]
SNAP_DIR = "data/snapshots"
CAMA_DIR = "data/cama"
TILE_WORK = "data/_tiles"
OUT_DIR = "data/structures"
MT_STATE_PLANE = 6514

RESIDENTIAL_TYPES = {101, 102, 103, 106, 107}
MOBILE_HOME = 107
COLUMNS = ["DiscrpAgID", "DateUpdate", "County", "Inc_Muni", "Add_Number", "AddNum_Suf", "Unit",
           "LandmkName", "Place_Type", "Placement", "MT_PlcType", "ParcelID", "DatasetTyp"]
PLACEMENT = {"Structure": 1, "Property Access": 2, "PropertyAccess": 2, "Parcel": 3, "Site": 4,
             "Geocoding": 5, "Unknown": 0, "": 0}


def _export_date(path: str) -> str:
    """The export date from the State Library's ``_ReadMe.txt`` beside the
    shapefile ("exported ... on 20261030"), else the file's own date."""
    readme = os.path.join(os.path.dirname(path), "_ReadMe.txt")
    if os.path.exists(readme):
        m = re.search(r"exported .*? on (\d{8})", open(readme, errors="replace").read())
        if m:
            return f"{m.group(1)[:4]}-{m.group(1)[4:6]}-{m.group(1)[6:]}"
    return time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(path)))


def _newest(paths: list[str]) -> str:
    """The most recent monthly export among the copies on hand."""
    have = [p for p in paths if os.path.exists(p)]
    if not have:
        raise FileNotFoundError(f"structures framework: none of {paths} exists")
    return max(have, key=_export_date)


def read_points(src: str) -> gpd.GeoDataFrame:
    t0 = time.time()
    d = pyogrio.read_dataframe(src, columns=COLUMNS)
    if d.crs is None or d.crs.to_epsg() != MT_STATE_PLANE:
        d = d.set_crs(MT_STATE_PLANE, allow_override=True)
    d["num"] = d["Add_Number"].fillna(0).astype("int64")
    d["has_num"] = d["num"] > 0
    d["unit"] = d["Unit"].fillna("").astype(str).str.strip() != ""
    d["plc"] = d["MT_PlcType"].fillna(0).astype("int32")
    d["res"] = d["plc"].isin(RESIDENTIAL_TYPES) | d["Place_Type"].fillna("").str.strip().eq("residence")
    d["mh"] = d["plc"] == MOBILE_HOME
    d["structure_data"] = d["DatasetTyp"].fillna("").str.strip().eq("Structure data")
    d["placement"] = d["Placement"].fillna("").astype(str).str.strip().map(PLACEMENT).fillna(0).astype("int8")
    d["pid_stated"] = gc.normalize(d["ParcelID"].fillna("").astype(str))
    d["stated_valid"] = gc.validity(d["pid_stated"]) & (d["pid_stated"] != "")
    d["updated"] = pd.to_datetime(d["DateUpdate"], errors="coerce").dt.year.fillna(0).astype("int16")
    d["agency"] = d["DiscrpAgID"].fillna("").astype(str)
    log.info("structures: %s points read in %.0fs; %s numbered, %s residential, %s with a stated geocode",
             f"{len(d):,}", time.time() - t0, f"{int(d['has_num'].sum()):,}",
             f"{int(d['res'].sum()):,}", f"{int(d['stated_valid'].sum()):,}")
    return d


def parcel_polygons(date: str) -> gpd.GeoDataFrame:
    """The newest export's parcel polygons, from the tile stage's staged copy
    when it exists (one read of 887k polygons), else from the export itself."""
    fgb = f"{TILE_WORK}/parcels_{date}.fgb"
    if os.path.exists(fgb):
        g = pyogrio.read_dataframe(fgb, columns=["id"]).rename(columns={"id": "parcel_id"})
    else:
        snap = next(s for s in sources.discover() if s.date == date)
        with snap.local() as src:
            g = gpd.read_file(src.vsi, columns=["PARCELID"], engine="pyogrio")
        g["parcel_id"] = gc.normalize(g["PARCELID"])
        g = g[(g["parcel_id"] != "") & gc.validity(g["parcel_id"])][["parcel_id", "geometry"]]
    return g.to_crs(MT_STATE_PLANE)


def join(points: gpd.GeoDataFrame, parcels: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    t0 = time.time()
    j = gpd.sjoin(points[["geometry"]], parcels[["parcel_id", "geometry"]], how="left", predicate="within")
    j = j[~j.index.duplicated(keep="first")]       # a point on a shared boundary: first parcel wins
    points = points.copy()
    points["pid_spatial"] = j["parcel_id"].reindex(points.index).fillna("")
    points["on_parcel"] = points["pid_spatial"] != ""
    known = set(parcels["parcel_id"])
    points["stated_exists"] = points["pid_stated"].isin(known)
    points["agree"] = points["on_parcel"] & points["stated_valid"] & (points["pid_spatial"] == points["pid_stated"])
    log.info("join: %s of %s points fall on a parcel (%.0fs)", f"{int(points['on_parcel'].sum()):,}",
             f"{len(points):,}", time.time() - t0)
    return points


def per_parcel(points: gpd.GeoDataFrame) -> pd.DataFrame:
    p = points[points["on_parcel"]]
    g = p.groupby("pid_spatial")
    out = pd.DataFrame({
        "n_addr": g.size(),
        "n_addr_num": g["has_num"].sum(),
        "n_addr_res": g["res"].sum(),
        "n_addr_unit": g["unit"].sum(),
        "n_addr_mh": g["mh"].sum(),
        "n_addr_structure": g["structure_data"].sum(),
        "n_addr_on_structure": g["placement"].apply(lambda s: int((s == 1).sum())),
        "n_addr_stated_here": g["agree"].sum(),
        "addr_updated": g["updated"].max(),
    }).reset_index().rename(columns={"pid_spatial": "parcel_id"})
    for c in out.columns:
        if c.startswith("n_addr"):
            out[c] = out[c].astype("int32")
    # points whose stated geocode names a parcel other than the one they sit on
    elsewhere = points[points["stated_valid"] & points["stated_exists"] & ~points["agree"]]
    out = out.merge(elsewhere.groupby("pid_stated").size().rename("n_addr_stated_elsewhere").reset_index()
                    .rename(columns={"pid_stated": "parcel_id"}), on="parcel_id", how="left")
    out["n_addr_stated_elsewhere"] = out["n_addr_stated_elsewhere"].fillna(0).astype("int32")
    return out


def _share(n: int, d: int) -> float | None:
    return round(100 * n / d, 2) if d else None


def tests(points: gpd.GeoDataFrame, parcels: pd.DataFrame, cama: pd.DataFrame, snap: pd.DataFrame) -> dict:
    """Statewide and per county. ``parcels`` is per_parcel(); ``cama`` stage
    11's frame for the same date; ``snap`` the export's parcel attributes."""
    f = snap.merge(parcels, on="parcel_id", how="left").merge(
        cama[["parcel_id", "has_dwelling", "n_dwell", "any_mh", "any_condo_th"]], on="parcel_id", how="left")
    for c in [c for c in f.columns if c.startswith("n_addr")]:
        f[c] = f[c].fillna(0).astype("int32")
    for c in ("has_dwelling", "any_mh", "any_condo_th"):
        f[c] = f[c].fillna(False).astype(bool)
    f["n_dwell"] = f["n_dwell"].fillna(0).astype("int32")
    f = f[~f["is_common_area"].fillna(False).astype(bool)]
    hn = f["has_house_number"].fillna(False).to_numpy(dtype=bool)
    pt = (f["n_addr_num"] > 0).to_numpy()
    dw = f["has_dwelling"].to_numpy()
    rp = (f["n_addr_res"] > 0).to_numpy()
    un = (f["n_addr_unit"] > 0).to_numpy()
    mh = (f["n_addr_mh"] > 0).to_numpy()
    multi = (f["n_dwell"] >= 2).to_numpy()

    def block(mask: np.ndarray) -> dict:
        m = mask
        n = int(m.sum())
        return {
            "parcels_tested": n,
            "address_rung": {
                "house_number_and_point": int((m & hn & pt).sum()),
                "house_number_no_point": int((m & hn & ~pt).sum()),
                "point_no_house_number": int((m & ~hn & pt).sum()),
                "neither": int((m & ~hn & ~pt).sum()),
                "agreement_pct": _share(int((m & (hn == pt)).sum()), n),
                "p_point_given_house_number_pct": _share(int((m & hn & pt).sum()), int((m & hn).sum())),
                "p_house_number_given_point_pct": _share(int((m & hn & pt).sum()), int((m & pt).sum())),
            },
            "dwelling": {
                "dwelling_and_residential_point": int((m & dw & rp).sum()),
                "dwelling_no_residential_point": int((m & dw & ~rp).sum()),
                "dwelling_no_point_at_all": int((m & dw & ~(f["n_addr"] > 0).to_numpy()).sum()),
                "residential_point_no_dwelling": int((m & ~dw & rp).sum()),
                "agreement_pct": _share(int((m & (dw == rp)).sum()), n),
                "p_residential_point_given_dwelling_pct": _share(int((m & dw & rp).sum()), int((m & dw).sum())),
            },
            "units": {
                "multi_dwelling_parcels": int((m & multi).sum()),
                "multi_dwelling_with_unit_points": int((m & multi & un).sum()),
                "unit_points_single_dwelling": int((m & un & (f["n_dwell"] == 1).to_numpy()).sum()),
                "unit_points_condo_townhouse": int((m & un & f["any_condo_th"].to_numpy()).sum()),
            },
            "manufactured_home": {
                "dor_mh_and_mobile_home_point": int((m & f["any_mh"].to_numpy() & mh).sum()),
                "dor_mh_no_mobile_home_point": int((m & f["any_mh"].to_numpy() & ~mh).sum()),
                "mobile_home_point_no_dor_mh": int((m & ~f["any_mh"].to_numpy() & mh).sum()),
            },
        }

    allm = np.ones(len(f), dtype=bool)
    out = {"statewide": block(allm)}
    # the point side, statewide
    p = points
    on = p["on_parcel"].to_numpy()
    sv = p["stated_valid"].to_numpy()
    se = p["stated_exists"].to_numpy()
    ag = p["agree"].to_numpy()
    out["geocode"] = {
        "points": int(len(p)),
        "on_a_parcel": int(on.sum()),
        "on_no_parcel": int((~on).sum()),
        "on_no_parcel_by_placement": {str(k): int(v) for k, v in
                                      p.loc[~on, "Placement"].fillna("").value_counts().head(6).items()},
        "stated_geocode_valid": int(sv.sum()),
        "stated_geocode_in_export": int((sv & se).sum()),
        "stated_geocode_not_in_export": int((sv & ~se).sum()),
        "stated_equals_containing_parcel": int(ag.sum()),
        "stated_names_another_parcel": int((sv & se & on & ~ag).sum()),
        "stated_but_point_on_no_parcel": int((sv & ~on).sum()),
        "agreement_pct_of_testable": _share(int(ag.sum()), int((sv & se & on).sum())),
    }
    out["placement"] = {str(k): int(v) for k, v in p["Placement"].fillna("").value_counts().items()}
    out["dataset_type"] = {str(k): int(v) for k, v in p["DatasetTyp"].fillna("").value_counts().items()}
    out["structure_types_top"] = {int(k): int(v) for k, v in p["plc"].value_counts().head(20).items()}
    out["updated_by_year"] = {int(k): int(v) for k, v in p["updated"].value_counts().sort_index().items() if k >= 2015}
    # per county, the two rungs and the geocode test
    rows = []
    pc = p[on].merge(snap[["parcel_id", "county_n"]], left_on="pid_spatial", right_on="parcel_id", how="left")
    geo_by = pc.groupby("county_n").agg(points=("agree", "size"), stated_valid=("stated_valid", "sum"),
                                        agree=("agree", "sum"), on_structure=("placement", lambda s: int((s == 1).sum())))
    for cn, grp in f.groupby("county_n"):
        m = (f["county_n"] == cn).to_numpy()
        b = block(m)
        g = geo_by.loc[cn] if cn in geo_by.index else None
        rows.append({"county_n": int(cn), "parcels_tested": b["parcels_tested"],
                     "hn_pt": b["address_rung"]["house_number_and_point"],
                     "hn_nopt": b["address_rung"]["house_number_no_point"],
                     "pt_nohn": b["address_rung"]["point_no_house_number"],
                     "dw_res": b["dwelling"]["dwelling_and_residential_point"],
                     "dw_nores": b["dwelling"]["dwelling_no_residential_point"],
                     "res_nodw": b["dwelling"]["residential_point_no_dwelling"],
                     "points": int(g["points"]) if g is not None else 0,
                     "stated_valid": int(g["stated_valid"]) if g is not None else 0,
                     "geocode_agree": int(g["agree"]) if g is not None else 0,
                     "on_structure": int(g["on_structure"]) if g is not None else 0})
    out["by_county"] = rows
    return out


def build(date: str | None = None, out_dir: str = OUT_DIR) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    if date is None:
        date = max(s.date for s in sources.discover())
    src = _newest(CANDIDATES)
    pts = read_points(src)
    polys = parcel_polygons(date)
    pts = join(pts, polys)
    del polys
    pp = per_parcel(pts)
    pp.to_parquet(f"{out_dir}/parcels_structures_{date}.parquet", index=False, compression="zstd")
    keep = pts[["num", "has_num", "unit", "plc", "res", "mh", "structure_data", "placement", "pid_spatial",
                "pid_stated", "stated_valid", "stated_exists", "agree", "updated", "agency"]].copy()
    ll = pts.geometry.to_crs(4326)
    keep["lon"] = ll.x.round(6).astype("float32"); keep["lat"] = ll.y.round(6).astype("float32")
    keep.to_parquet(f"{out_dir}/points_{date}.parquet", index=False, compression="zstd")

    snap = pd.read_parquet(f"{SNAP_DIR}/parcels_{date}.parquet",
                           columns=["parcel_id", "county_n", "has_house_number", "is_common_area", "improved"])
    cama_path = f"{CAMA_DIR}/parcels_cama_{date}.parquet"
    if os.path.exists(cama_path):
        cama = pd.read_parquet(cama_path, columns=["parcel_id", "has_dwelling", "n_dwell", "any_mh", "any_condo_th"])
    else:
        log.warning("no CAMA frame for %s; dwelling tests will be empty", date)
        cama = pd.DataFrame({"parcel_id": snap["parcel_id"], "has_dwelling": False, "n_dwell": 0,
                             "any_mh": False, "any_condo_th": False})
    qa = {"date": date, "source": src, "points": int(len(pts)),
          "export_date": _export_date(src),
          "last_update_in_data": str(pd.to_datetime(pts["DateUpdate"], errors="coerce").max().date()),
          "parcels_with_a_point": int(len(pp)),
          "note": ("residential point: MT_PlcType 101-103, 106, 107 or Place_Type residence; "
                   "the address rung is tested on parcels that are not common areas; "
                   "the geocode test compares the point's stated ParcelID with the parcel that contains it"),
          "tests": tests(pts, pp, cama, snap)}
    with open(f"{out_dir}/qa_structures.json", "w") as fh:
        json.dump(qa, fh, indent=1, default=str)
    t = qa["tests"]["statewide"]
    log.info("address rung agreement %.2f%% (P(point|house number) %.1f%%); dwelling agreement %.2f%% "
             "(P(residential point|dwelling) %.1f%%); geocode agrees on %s of %s testable points (%.2f%%)",
             t["address_rung"]["agreement_pct"], t["address_rung"]["p_point_given_house_number_pct"],
             t["dwelling"]["agreement_pct"], t["dwelling"]["p_residential_point_given_dwelling_pct"],
             f"{qa['tests']['geocode']['stated_equals_containing_parcel']:,}",
             f"{qa['tests']['geocode']['stated_geocode_in_export']:,}",
             qa["tests"]["geocode"]["agreement_pct_of_testable"] or 0)
    return qa


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Stage 12: structures/address points as a witness")
    ap.add_argument("--date", default=None, help="snapshot date (default: newest)")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    build(args.date, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
