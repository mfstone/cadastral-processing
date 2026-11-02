"""A Montana basemap, light and dark, from the State Library's own frameworks.

The dashboard offers an OpenStreetMap basemap as an external option; this is
the in-house parallel, built from first-party data so a page can show streets,
water, places, buildings and addresses without fetching from a third party,
and packaged so it can be used outside this project: one PMTiles archive, two
MapLibre styles, the glyphs the styles need and a demo page, in ``dist/``.

Sources (all Montana State Library MSDI unless noted):

| layer | source | zooms |
|---|---|---|
| ``boundary`` | State boundary, ``CountyLines``, incorporated city limit lines | 4-13 |
| ``landuse`` | public lands by owner class (this project's dissolved layer) | 6-13 |
| ``water_major`` / ``water`` | NHD High Resolution waterbodies (lakes, reservoirs, wetlands, playas, ice) and areas (rivers, canals) | 4-9 / 10-13 |
| ``waterway_major`` / ``waterway`` | named streams (24K, named only), rivers of 40 miles or more at the low zooms | 5-8 / 9-13 |
| ``transportation_major`` / ``transportation`` | Transportation Framework road centerlines: primary and secondary routes dissolved by name at the low zooms, every road from z9 | 4-8 / 9-13 |
| ``building`` | the merged building footprints (Microsoft 2018 + lidar, see ``timeseries/reference.py``) | 13 |
| ``address`` | Structures Framework address points: house number and structure class | 13 |
| ``poi`` | Structures Framework named structures: schools, hospitals, churches, government, libraries, airports, fire and police | 11-13 |
| ``place`` | GNIS populated places (``MT_Names``) ranked by the incorporated cities layer, and county seats of nothing: county names | 4-13 |

Zoom 13 is the deepest level written; MapLibre overzooms from there, and at
13 the tile grid is 4.8 m per unit, finer than the footprints' own
generalisation. The low-zoom layers are separate layers rather than
per-feature zoom ranges because GDAL's MVT writer configures zoom per layer.

The archive is written by GDAL into MBTiles and converted to PMTiles by
``pmtiles_writer.py``; nothing outside the Python environment and GDAL is
required. Tippecanoe would generalise the low zooms better and is the
upgrade path if the archive is ever rebuilt with it on hand.

Run from the repository root::

    .venv/bin/python -m basemap.build            # stage, tile, package
    .venv/bin/python -m basemap.build --base /basemap   # styles for the dashboard

"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import time

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio

from timeseries import reference
from . import pmtiles_writer
from . import styles as style_mod

log = logging.getLogger("basemap")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MSDI = "/media/mstone/GeoData/MSDI"
WORK = os.path.join(ROOT, "basemap", "work")
DIST = os.path.join(ROOT, "basemap", "dist")
FONTS = os.path.join(ROOT, "site", "public", "fonts")
SP = 6514                    # NAD83(2011) / Montana, metres
MINZOOM, MAXZOOM = 4, 13
NAME = "mt-basemap"

SRC = {
    "roads": [f"{MSDI}/TransportationFramework_shp/RoadCenterLine.shp"],
    "highways": [f"{ROOT}/data/locator/highways.geojson"],
    "buildings": [f"{ROOT}/data/_tiles/buildings.fgb"],
    "addresses": ["/home/mstone/Downloads/StructuresFramework_shp/SiteStructureAddressPoint.shp",
                  f"{MSDI}/StructuresFramework_shp/SiteStructureAddressPoint.shp"],
    "waterbody": [f"{MSDI}/NHDH_MT_Shape_20231227/NHDH_MT_Shape_20231227/NHDWaterbody.shp"],
    "waterarea": [f"{MSDI}/NHDH_MT_Shape_20231227/NHDH_MT_Shape_20231227/NHDArea.shp"],
    "streams": [f"{MSDI}/NamedStreamsandLakes_SHP/Streams24K_NamedOnly.shp"],
    "counties": [f"{MSDI}/MontanaCounties_shp/County.shp"],
    "county_lines": [f"{MSDI}/MontanaCounties_shp/CountyLines.shp"],
    "state": [f"{MSDI}/MontanaStateBoundary_shp/StateofMontana.shp"],
    "cities": [f"{MSDI}/MontanaIncorporatedCitiesTowns_shp/MontanaIncorporatedCitiesTowns.shp"],
    "city_lines": [f"{MSDI}/MontanaIncorporatedCitiesTowns_shp/MontanaIncorporatedCitiesTowns_Lines.shp"],
    "names": [f"/vsizip/{MSDI}/MT_Names_shp.zip/MT_Names.shp"],
    "publiclands": [f"{ROOT}/data/locator/publiclands.geojson"],
}
LAYER_ZOOMS = {
    "boundary": (4, 13), "landuse": (6, 13),
    "water_major": (4, 9), "water": (10, 13),
    "waterway_major": (5, 8), "waterway": (9, 13),
    "transportation_major": (4, 8), "transportation": (9, 13),
    "building": (13, 13), "address": (13, 13), "poi": (11, 13), "place": (4, 13),
}
WATER_CLASS = {390: "lake", 436: "reservoir", 361: "playa", 466: "wetland", 378: "glacier"}
AREA_CLASS = {460: "river", 336: "canal"}
RIVER_MILES = 40
POI_TYPES = {"school": "school", "hospital": "hospital", "place-of-worship": "worship",
             "government": "government", "library": "library", "airport": "airport",
             "stadium": "stadium", "arena": "stadium", "theater": "theater", "hotel": "hotel",
             "prison": "prison", "train-station": "station", "bus-station": "station",
             "public": "public"}
POI_PLC = {301: "police", 302: "fire", 303: "fire", 401: "airport", 601: "school", 602: "college",
           201: "hospital", 501: "government", 509: "government"}
ONEWAY = {"B": 0, "FT": 1, "TF": -1}


def _first(key: str) -> str:
    for p in SRC[key]:
        if p.startswith("/vsizip/") or os.path.exists(p):
            return p
    raise FileNotFoundError(f"{key}: none of {SRC[key]} exists")


def _read(path: str, **kw) -> gpd.GeoDataFrame:
    """Read a source, horizontal part only, in the state plane."""
    g = pyogrio.read_dataframe(path, force_2d=True, **kw)
    crs = g.crs
    if crs is not None and crs.is_compound:
        crs = crs.sub_crs_list[0]
    if crs is None:
        g = g.set_crs(SP, allow_override=True)
    elif crs.to_epsg() != SP:
        g = g.set_crs(crs, allow_override=True).to_crs(SP)
    else:
        g = g.set_crs(SP, allow_override=True)
    return g


def _write(name: str, g: gpd.GeoDataFrame, cols: list[str]) -> tuple[str, dict]:
    out = f"{WORK}/{name}.fgb"
    g = g[cols + ["geometry"]]
    g = g[~g.geometry.is_empty & g.geometry.notna()]
    g.to_crs(4326).to_file(out, driver="FlatGeobuf")
    log.info("%-22s %9s features  %5.1f MB", name, f"{len(g):,}", os.path.getsize(out) / 1e6)
    return out, {"features": int(len(g)), "bytes": os.path.getsize(out)}


# ------------------------------------------------------------------ layers
def stage_boundary() -> tuple[str, dict]:
    st = _read(_first("state"))
    st = gpd.GeoDataFrame({"level": 4, "name": "Montana"}, index=st.index, geometry=st.geometry.boundary, crs=SP)
    cl = _read(_first("county_lines"))
    cl = gpd.GeoDataFrame({"level": 6, "name": ""}, index=cl.index, geometry=cl.geometry, crs=SP)
    ci = _read(_first("city_lines"))
    ci = ci[~ci["NAME"].fillna("").str.contains("Silver Bow|Deer Lodge")]
    ci = gpd.GeoDataFrame({"level": 8, "name": ci["NAME"].fillna("")}, geometry=ci.geometry, crs=SP)
    g = pd.concat([st, cl, ci], ignore_index=True)
    g["level"] = g["level"].astype("int16")
    return _write("boundary", gpd.GeoDataFrame(g, crs=SP), ["level", "name"])


def stage_landuse() -> tuple[str, dict]:
    g = gpd.read_file(_first("publiclands")).to_crs(SP)
    g = g.rename(columns={"cls": "class"})
    return _write("landuse", g, ["class"])


def stage_water() -> tuple[tuple[str, dict], tuple[str, dict]]:
    wb = _read(_first("waterbody"), columns=["ftype", "areasqkm", "gnis_name"])
    wb = wb[wb["ftype"].isin(WATER_CLASS)].copy()
    wb["class"] = wb["ftype"].map(WATER_CLASS)
    ar = _read(_first("waterarea"), columns=["ftype", "areasqkm", "gnis_name"])
    ar = ar[ar["ftype"].isin(AREA_CLASS)].copy()
    ar["class"] = ar["ftype"].map(AREA_CLASS)
    for g in (wb, ar):
        g["name"] = g["gnis_name"].fillna("").astype(str)
        g["geometry"] = g.geometry.buffer(0)
    major = pd.concat([wb[(wb["areasqkm"] >= 1.0) & wb["class"].isin(["lake", "reservoir"])],
                       ar[(ar["areasqkm"] >= 0.5) & (ar["class"] == "river")]], ignore_index=True)
    major = gpd.GeoDataFrame(major, crs=SP)
    major["geometry"] = major.geometry.simplify(60, preserve_topology=True)
    full = pd.concat([wb[wb["areasqkm"] >= 0.004], ar], ignore_index=True)
    return (_write("water_major", major, ["class", "name"]),
            _write("water", gpd.GeoDataFrame(full, crs=SP), ["class", "name"]))


def stage_waterway() -> tuple[tuple[str, dict], tuple[str, dict]]:
    st = _read(_first("streams"), columns=["gnis_name", "fcode", "Miles"])
    st = st[st["fcode"] != 55800].copy()          # artificial paths through lakes
    st["name"] = st["gnis_name"].fillna("").astype(str)
    st["class"] = np.where(st["fcode"] == 33600, "canal",
                           np.where(st["Miles"] >= RIVER_MILES, "river", "stream"))
    major = st[st["class"] == "river"].dissolve(by="name", as_index=False)[["name", "geometry"]]
    major["class"] = "river"
    major["geometry"] = major.geometry.simplify(80, preserve_topology=False)
    return (_write("waterway_major", gpd.GeoDataFrame(major, crs=SP), ["class", "name"]),
            _write("waterway", st, ["class", "name"]))


def _ref(name: pd.Series) -> pd.Series:
    """The route number a shield shows, from the composed road name."""
    m = name.str.extract(r"^(I-\d+[A-Z]?|US \d+[A-Z]?|Hwy \d+[A-Z]?)")[0]
    return m.fillna("")


def stage_transportation() -> tuple[tuple[str, dict], tuple[str, dict]]:
    hw = gpd.read_file(_first("highways")).to_crs(SP)
    hw["ref"] = _ref(hw["name"].fillna(""))
    hw["class"] = hw["cls"].astype("int16")
    major = _write("transportation_major", hw, ["class", "name", "ref"])
    g = pyogrio.read_dataframe(_first("roads"), columns=["St_PreDir", "St_Name", "St_PosTyp", "St_PosDir",
                                                         "LSt_Name", "RoadClass", "SurfaceTyp", "OneWay"])
    g = g.set_crs(SP, allow_override=True) if g.crs is None else g.to_crs(SP)
    g["class"] = g["RoadClass"].map(reference.CLASS)
    g = g[g["class"].notna()].copy()
    g["class"] = g["class"].astype("int16")
    g["name"] = reference._road_names(g)
    g["ref"] = _ref(g["name"])
    g["paved"] = g["SurfaceTyp"].map({"Paved": 1, "Gravel": 0, "Dirt": 0}).fillna(-1).astype("int16")
    g["oneway"] = g["OneWay"].map(ONEWAY).fillna(0).astype("int16")
    return major, _write("transportation", g, ["class", "name", "ref", "paved", "oneway"])


def stage_building() -> tuple[str, dict]:
    src = _first("buildings")
    g = pyogrio.read_dataframe(src)
    out = f"{WORK}/building.fgb"
    g = g[["src", "geometry"]]
    g.to_file(out, driver="FlatGeobuf")
    log.info("%-22s %9s features  %5.1f MB (from %s)", "building", f"{len(g):,}", os.path.getsize(out) / 1e6, src)
    return out, {"features": int(len(g)), "bytes": os.path.getsize(out), "source": src}


def stage_address_poi() -> tuple[tuple[str, dict], tuple[str, dict]]:
    src = _first("addresses")
    g = _read(src, columns=["Add_Number", "AddNum_Suf", "Unit", "LandmkName", "Place_Type",
                            "MT_PlcType", "DatasetTyp"])
    num = g["Add_Number"].fillna(0).astype("int64")
    suf = g["AddNum_Suf"].fillna("").astype(str).str.strip()
    g["num"] = np.where(num > 0, num.astype(str) + np.where(suf != "", " " + suf, ""), "")
    g["plc"] = g["MT_PlcType"].fillna(0).astype("int32")
    g["unit"] = (g["Unit"].fillna("").astype(str).str.strip() != "").astype("int16")
    addr = g[g["num"] != ""]
    a = _write("address", addr, ["num", "plc", "unit"])
    name = g["LandmkName"].fillna("").astype(str).str.strip()
    pt = g["Place_Type"].fillna("").astype(str).str.strip()
    cls = pd.Series(g["plc"].map(POI_PLC), index=g.index)
    cls = cls.fillna(pt.map(POI_TYPES))
    poi = g[(name != "") & cls.notna()].copy()
    poi["name"] = name[poi.index]
    poi["class"] = cls[poi.index]
    poi = poi.drop_duplicates(["name", "class"])
    p = _write("poi", poi, ["name", "class"])
    return a, p


def stage_place() -> tuple[str, dict]:
    nm = _read(_first("names"), columns=["Name", "Class", "County"])
    pp = nm[nm["Class"].fillna("") == "Populated Place"].copy()
    ci = pyogrio.read_dataframe(_first("cities"), columns=["NAME", "TYPE", "CLASS", "Acres"], read_geometry=False)
    inc = {str(r.NAME).strip().upper(): (str(r.TYPE), float(r.Acres)) for r in ci.itertuples()}
    inc["BUTTE"] = ("City", 20000.0)
    inc["ANACONDA"] = ("City", 5000.0)

    def rank(name: str) -> int:
        t = inc.get(name.strip().upper())
        if t is None:
            return 4
        typ, acres = t
        if acres >= 10000:
            return 1
        return 2 if typ == "City" else 3

    pp["name"] = pp["Name"].astype(str)
    pp["rank"] = pp["name"].map(rank).astype("int16")
    pp["class"] = np.where(pp["rank"] <= 2, "city", np.where(pp["rank"] == 3, "town", "hamlet"))
    pp = pp.sort_values("rank").drop_duplicates(["name", "County"])
    co = _read(_first("counties"), columns=["NAME"])
    co = gpd.GeoDataFrame({"name": co["NAME"].astype(str), "rank": np.int16(5), "class": "county"},
                          geometry=co.geometry.representative_point(), crs=SP)
    g = pd.concat([pp[["name", "rank", "class", "geometry"]], co], ignore_index=True)
    return _write("place", gpd.GeoDataFrame(g, crs=SP), ["name", "rank", "class"])


def stage_all() -> dict[str, tuple[str, dict]]:
    os.makedirs(WORK, exist_ok=True)
    out: dict[str, tuple[str, dict]] = {}
    out["boundary"] = stage_boundary()
    out["landuse"] = stage_landuse()
    out["water_major"], out["water"] = stage_water()
    out["waterway_major"], out["waterway"] = stage_waterway()
    out["transportation_major"], out["transportation"] = stage_transportation()
    out["building"] = stage_building()
    out["address"], out["poi"] = stage_address_poi()
    out["place"] = stage_place()
    return out


# ------------------------------------------------------------------ tiles
def write_vrt(layers: dict[str, str]) -> str:
    path = f"{WORK}/basemap.vrt"
    body = ["<OGRVRTDataSource>"]
    for name, fgb in layers.items():
        stem = os.path.splitext(os.path.basename(fgb))[0]
        body += [f'  <OGRVRTLayer name="{name}">',
                 f'    <SrcDataSource relativeToVRT="0">{os.path.abspath(fgb)}</SrcDataSource>',
                 f'    <SrcLayer>{stem}</SrcLayer>', '  </OGRVRTLayer>']
    body.append("</OGRVRTDataSource>\n")
    with open(path, "w") as fh:
        fh.write("\n".join(body))
    return path


def tile(vrt: str, mbtiles: str) -> float:
    if os.path.exists(mbtiles):
        os.remove(mbtiles)
    conf = f"{WORK}/conf.json"
    with open(conf, "w") as fh:
        json.dump({k: {"minzoom": a, "maxzoom": b} for k, (a, b) in LAYER_ZOOMS.items()}, fh)
    t0 = time.time()
    cmd = ["ogr2ogr", "-f", "MVT", mbtiles, vrt,
           "-dsco", "FORMAT=MBTILES", "-dsco", f"MINZOOM={MINZOOM}", "-dsco", f"MAXZOOM={MAXZOOM}",
           "-dsco", f"CONF={conf}", "-dsco", "SIMPLIFICATION=1.5", "-dsco", "SIMPLIFICATION_MAX_ZOOM=0.75",
           "-dsco", "MAX_SIZE=20000000", "-dsco", "MAX_FEATURES=2000000", "-dsco", "COMPRESS=YES",
           "-dsco", f"NAME={NAME}",
           "-dsco", "DESCRIPTION=Montana basemap from Montana State Library frameworks",
           "-dsco", f"TEMPORARY_DB={WORK}/tmp.db"]
    subprocess.run(cmd, check=True)
    return (time.time() - t0) / 60


# ------------------------------------------------------------------ package
DEMO = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Montana basemap</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.css">
<style>html,body,#map{margin:0;height:100%%}#ui{position:absolute;top:10px;left:10px;z-index:1;font:13px system-ui;background:#fff;padding:6px 8px;border-radius:4px}</style>
</head><body><div id="ui"><label>Theme <select id="theme"><option value="light">light</option><option value="dark">dark</option></select></label></div><div id="map"></div>
<script src="https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.js"></script>
<script src="https://unpkg.com/pmtiles@4.5.0/dist/pmtiles.js"></script>
<script>
const protocol = new pmtiles.Protocol(); maplibregl.addProtocol('pmtiles', protocol.tile);
const map = new maplibregl.Map({ container: 'map', style: 'styles/light.json', center: [-110.5, 46.9], zoom: 6, hash: true });
map.addControl(new maplibregl.NavigationControl());
document.getElementById('theme').onchange = (e) => map.setStyle(`styles/${e.target.value}.json`);
</script></body></html>
"""

README = """# Montana basemap

A street-level basemap of Montana built only from Montana State Library
frameworks, as one PMTiles archive and two MapLibre GL styles (light and
dark). No third-party tile service, no API key.

%(table)s

Files:

- `mt-basemap.pmtiles` -- zooms %(minz)d-%(maxz)d, %(tiles)s tiles, %(mb).0f MB. Overzooms past 13.
- `mt-basemap.mbtiles` -- the same tiles for QGIS or a tile server.
- `styles/light.json`, `styles/dark.json` -- MapLibre styles. Written for base
  URL `%(base)s`; re-run `python -m basemap.build --package-only --base <url>`
  to point them elsewhere.
- `fonts/` -- Noto Sans glyphs the styles reference (OFL).
- `index.html` -- a demo page (loads MapLibre and the pmtiles client from unpkg).
- `qa.json` -- feature counts per layer and the archive's structure.

Serving: PMTiles needs HTTP Range requests. Any plain file server with Range
works (Astro preview, nginx, S3, R2). Cloudflare Pages static assets do not
honour Range and cap files at 25 MB, so for a Pages site put the archive on R2.

Layers and attributes:

| layer | zooms | attributes |
|---|---|---|
| boundary | 4-13 | level (4 state, 6 county, 8 city limit), name |
| landuse | 6-13 | class (federal, state, local_government, other_public) |
| water_major, water | 4-9, 10-13 | class (lake, reservoir, river, canal, wetland, playa, glacier), name |
| waterway_major, waterway | 5-8, 9-13 | class (river, stream, canal), name |
| transportation_major, transportation | 4-8, 9-13 | class (1 primary ... 5 track), name, ref; roads also paved (1/0/-1), oneway (0, 1, -1) |
| building | 13 | src (1 Microsoft 2018 outside lidar areas, 2 lidar only, 3 both, 4 Microsoft 2018 unseen by lidar) |
| address | 13 | num, plc (MT structure class), unit (0/1) |
| poi | 11-13 | name, class |
| place | 4-13 | name, rank (1 largest cities ... 4 hamlet, 5 county), class |

Sources: Transportation Framework (road centerlines, June 2026); Structures
Framework (address points, %(addr_date)s); building footprints (Microsoft US
Building Footprints 2018 release, ODbL, merged with the State Library's lidar
footprints); NHD High Resolution (2023-12-27) and the named streams and lakes
layer; Montana counties, incorporated cities and towns, state boundary and
public lands (2026); GNIS place names (2024-08). Data licence: public domain
for the state data, ODbL for the Microsoft footprints.
"""


def package(base: str, layer_qa: dict, tile_qa: dict | None) -> dict:
    os.makedirs(f"{DIST}/styles", exist_ok=True)
    for theme in ("light", "dark"):
        with open(f"{DIST}/styles/{theme}.json", "w") as fh:
            json.dump(style_mod.build_style(theme, base, f"{NAME}.pmtiles"), fh, indent=1)
    if os.path.isdir(FONTS):
        if os.path.isdir(f"{DIST}/fonts"):
            shutil.rmtree(f"{DIST}/fonts")
        shutil.copytree(FONTS, f"{DIST}/fonts")
    with open(f"{DIST}/index.html", "w") as fh:
        fh.write(DEMO)
    qa = {"layers": {k: v for k, v in layer_qa.items()}, "zooms": [MINZOOM, MAXZOOM], "base": base}
    if tile_qa:
        qa["archive"] = tile_qa
    with open(f"{DIST}/qa.json", "w") as fh:
        json.dump(qa, fh, indent=1)
    addr_src = _first("addresses")
    rm = os.path.join(os.path.dirname(addr_src), "_ReadMe.txt")
    addr_date = "2026"
    if os.path.exists(rm):
        m = re.search(r"on (\d{4})(\d{2})(\d{2})", open(rm, errors="replace").read())
        if m:
            addr_date = "-".join(m.groups())
    table = "| layer | features |\n|---|--:|\n" + "\n".join(
        f"| {k} | {v['features']:,} |" for k, v in layer_qa.items())
    pm = f"{DIST}/{NAME}.pmtiles"
    with open(f"{DIST}/README.md", "w") as fh:
        fh.write(README % {"table": table, "minz": MINZOOM, "maxz": MAXZOOM,
                           "tiles": f"{tile_qa['tiles']:,}" if tile_qa else "?",
                           "mb": os.path.getsize(pm) / 1e6 if os.path.exists(pm) else 0,
                           "base": base, "addr_date": addr_date})
    return qa


def install_site(site_public: str, base: str = "/basemap") -> None:
    """Copy the archive and glyphs into the dashboard's public tree and render
    the styles for the site path, so the page fetches nothing third-party."""
    dst = os.path.join(site_public, "basemap")
    os.makedirs(os.path.join(dst, "styles"), exist_ok=True)
    shutil.copy(f"{DIST}/{NAME}.pmtiles", os.path.join(dst, f"{NAME}.pmtiles"))
    if os.path.isdir(f"{DIST}/fonts"):
        if os.path.isdir(os.path.join(dst, "fonts")):
            shutil.rmtree(os.path.join(dst, "fonts"))
        shutil.copytree(f"{DIST}/fonts", os.path.join(dst, "fonts"))
    for theme in ("light", "dark"):
        with open(os.path.join(dst, "styles", f"{theme}.json"), "w") as fh:
            json.dump(style_mod.build_style(theme, base, f"{NAME}.pmtiles"), fh, indent=1)
    shutil.copy(f"{DIST}/qa.json", os.path.join(dst, "qa.json"))
    log.info("installed into %s for base %s", dst, base)


def build(base: str, stage: bool = True, tiles: bool = True) -> dict:
    os.makedirs(DIST, exist_ok=True)
    if stage:
        staged = stage_all()
        with open(f"{WORK}/layers.json", "w") as fh:
            json.dump({k: {"path": p, **q} for k, (p, q) in staged.items()}, fh, indent=1)
    else:
        with open(f"{WORK}/layers.json") as fh:
            staged = {k: (v["path"], {kk: vv for kk, vv in v.items() if kk != "path"}) for k, v in json.load(fh).items()}
    layer_qa = {k: q for k, (p, q) in staged.items()}
    tile_qa = None
    mb = f"{DIST}/{NAME}.mbtiles"
    if tiles:
        vrt = write_vrt({k: p for k, (p, q) in staged.items()})
        minutes = tile(vrt, mb)
        log.info("tiled in %.0f min", minutes)
    if os.path.exists(mb):
        t0 = time.time()
        tile_qa = pmtiles_writer.mbtiles_to_pmtiles(mb, f"{DIST}/{NAME}.pmtiles", {
            "name": NAME, "attribution": "Montana State Library; Microsoft (ODbL)",
            "description": "Montana basemap from Montana State Library frameworks"})
        tile_qa["pmtiles_bytes"] = os.path.getsize(f"{DIST}/{NAME}.pmtiles")
        log.info("pmtiles: %s tiles, %.0f MB, %.0fs", f"{tile_qa['tiles']:,}", tile_qa["pmtiles_bytes"] / 1e6, time.time() - t0)
    return package(base, layer_qa, tile_qa)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build the Montana basemap package")
    ap.add_argument("--base", default=".", help="URL base the styles reference (default: relative)")
    ap.add_argument("--no-stage", action="store_true", help="reuse the staged layers in work/")
    ap.add_argument("--package-only", action="store_true", help="only rewrite styles, demo and README")
    ap.add_argument("--install-site", default=None, metavar="SITE_PUBLIC",
                    help="also copy the archive and styles into this site's public dir (served at /basemap)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    build(args.base, stage=not (args.no_stage or args.package_only), tiles=not args.package_only)
    if args.install_site:
        install_site(args.install_site)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
