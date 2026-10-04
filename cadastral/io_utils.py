"""IO helpers: county enumeration, chunked reads, GeoPackage/CSV writers."""

from __future__ import annotations

import logging
import os

import geopandas as gpd
import pandas as pd
import pyogrio

from .schema import SourceInfo

log = logging.getLogger("cadastral.io")


def list_counties(info: SourceInfo) -> pd.DataFrame:
    """Return distinct (county_code, county_name, parcel_count), sorted by code."""
    cc = info.require("county_code")
    cols = [cc]
    cn = info.col("county_name")
    if cn:
        cols.append(cn)
    df = pyogrio.read_dataframe(info.path, columns=cols, read_geometry=False)
    grp = df.groupby(cc, dropna=False)
    out = grp.size().reset_index(name="parcel_count")
    if cn:
        names = grp[cn].first().reset_index()
        out = out.merge(names, on=cc)
        out = out.rename(columns={cn: "county_name"})
    else:
        out["county_name"] = ""
    out = out.rename(columns={cc: "county_code"})
    return out.sort_values("county_code").reset_index(drop=True)


def resolve_county_codes(info: SourceInfo, selectors: list[str] | None) -> list[int]:
    """Translate user --county selectors (codes or names) into county codes.

    None/empty -> all counties.
    """
    counties = list_counties(info)
    if not selectors:
        return counties["county_code"].tolist()
    chosen: list[int] = []
    for sel in selectors:
        sel = str(sel).strip()
        if sel.isdigit():
            code = int(sel)
            if code in set(counties["county_code"]):
                chosen.append(code)
            else:
                log.warning("county code %s not found; skipping", code)
            continue
        # name (case-insensitive contains)
        hit = counties[counties["county_name"].str.casefold().str.contains(sel.casefold(), na=False)]
        if hit.empty:
            log.warning("county name %r not matched; skipping", sel)
        else:
            chosen.extend(hit["county_code"].tolist())
    # de-dup, preserve order
    seen, ordered = set(), []
    for c in chosen:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def read_county(info: SourceInfo, county_code: int) -> gpd.GeoDataFrame:
    """Read all parcels for one county via a pyogrio attribute filter."""
    cc = info.require("county_code")
    where = f"{cc} = {int(county_code)}"
    gdf = pyogrio.read_dataframe(info.path, where=where)
    log.info("  read %s parcels for county %s", f"{len(gdf):,}", county_code)
    return gdf


def split_null_parcelid(gdf: gpd.GeoDataFrame, info: SourceInfo):
    """Split into (working parcels, rights_of_way) on null/empty PARCELID."""
    pid = info.require("parcel_id")
    s = gdf[pid].astype("string").str.strip()
    null_mask = s.isna() | (s == "")
    row = gdf[~null_mask].copy()
    null_rows = gdf[null_mask].copy()
    return row, null_rows


def county_slug(county_code: int, county_name: str | None) -> str:
    name = (county_name or "").strip()
    if name:
        name = "".join(ch if ch.isalnum() else "_" for ch in name)
        return f"{int(county_code):02d}_{name}"
    return f"{int(county_code):02d}"


def write_gpkg_layer(gdf, path: str, layer: str) -> None:
    """Write/overwrite a single layer into a GeoPackage (geometry or table)."""
    if gdf is None or len(gdf) == 0:
        log.info("    (skip empty layer %s)", layer)
        return
    append = os.path.exists(path)
    has_geom = isinstance(gdf, gpd.GeoDataFrame) and gdf.geometry.notna().any()
    if has_geom:
        gdf.to_file(path, layer=layer, driver="GPKG", mode=("a" if append else "w"))
    else:
        # aspatial attribute table inside the GeoPackage
        df = pd.DataFrame(gdf).copy()
        if "geometry" in df.columns:
            df = df.drop(columns="geometry")
        pyogrio.write_dataframe(df, path, layer=layer, driver="GPKG", append=append)
    log.info("    wrote layer %-22s (%s rows)", layer, f"{len(gdf):,}")


def write_csv(df: pd.DataFrame, path: str) -> None:
    if df is None or len(df) == 0:
        log.info("    (skip empty csv %s)", os.path.basename(path))
        return
    df.to_csv(path, index=False)
    log.info("    wrote csv   %-22s (%s rows)", os.path.basename(path), f"{len(df):,}")
