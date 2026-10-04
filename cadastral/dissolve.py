"""Geometry repair, area recompute, and dissolve by owner id."""

from __future__ import annotations

import logging

import geopandas as gpd
import pandas as pd
from shapely import make_valid

from .schema import SQM_TO_ACRES

log = logging.getLogger("cadastral.dissolve")


def repair_geometry(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Make geometries valid so dissolve/union won't fail.

    Uses shapely ``make_valid`` and a ``buffer(0)`` fallback. Counts and logs
    how many were invalid.
    """
    gdf = gdf.copy()
    invalid = ~gdf.geometry.is_valid
    n = int(invalid.sum())
    if n:
        log.info("  repairing %s invalid geometries", f"{n:,}")
        fixed = gdf.geometry[invalid].apply(make_valid)
        still_bad = ~fixed.is_valid
        if still_bad.any():
            fixed.loc[still_bad] = fixed.loc[still_bad].buffer(0)
        gdf.loc[invalid, gdf.geometry.name] = fixed
    return gdf


def add_parcel_acres(gdf: gpd.GeoDataFrame, col: str = "ConsolAcres_parcel") -> gpd.GeoDataFrame:
    """Compute per-parcel acreage from projected geometry area (sq m -> acres)."""
    gdf = gdf.copy()
    gdf[col] = gdf.geometry.area * SQM_TO_ACRES
    return gdf


def dissolve_owners(parcels: gpd.GeoDataFrame, by: str,
                    attrs: dict[str, str] | None = None) -> gpd.GeoDataFrame:
    """Dissolve parcels into one polygon per owner id.

    ``attrs`` maps result columns to representative source columns carried via
    ``first``. Adds ``ParcelCount`` and ``ConsolAcres`` (from the dissolved
    geometry, the authoritative consolidated area).
    """
    attrs = attrs or {}
    keep = [by] + [c for c in attrs.values() if c in parcels.columns]
    sub = parcels[keep + [parcels.geometry.name]].copy()

    agg = {c: "first" for c in attrs.values() if c in parcels.columns}
    dissolved = sub.dissolve(by=by, aggfunc=agg, as_index=False)

    counts = parcels.groupby(by).size().rename("ParcelCount")
    dissolved = dissolved.merge(counts, on=by, how="left")
    dissolved["ConsolAcres"] = dissolved.geometry.area * SQM_TO_ACRES

    # tidy column names from the attr map
    rename = {v: k for k, v in attrs.items() if v in dissolved.columns and v != k}
    if rename:
        dissolved = dissolved.rename(columns=rename)
    log.info("  dissolved %s parcels -> %s owners", f"{len(parcels):,}", f"{len(dissolved):,}")
    return dissolved


def owner_summary(parcels: pd.DataFrame, owner_id: str, attrs: dict[str, str],
                  acres_col: str = "ConsolAcres_parcel") -> pd.DataFrame:
    """Non-spatial per-owner rollup: parcel count, acres, representative attrs."""
    base = parcels.groupby(owner_id).agg(
        ParcelCount=(owner_id, "size"),
        TotalAcres=(acres_col, "sum"),
    ).reset_index()
    reps = parcels.groupby(owner_id).first().reset_index()
    rep_cols = [owner_id] + [c for c in attrs.values() if c in reps.columns]
    reps = reps[rep_cols].rename(columns={v: k for k, v in attrs.items() if v in reps.columns})
    out = base.merge(reps, on=owner_id, how="left")
    return out.sort_values("TotalAcres", ascending=False).reset_index(drop=True)
