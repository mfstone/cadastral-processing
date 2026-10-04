"""Parcel-location tagging against Census tract / block-group geographies.

This answers *where the land is* (distinct from owner mailing location, handled
in :mod:`cadastral.owner_geo`). Each parcel is tagged by a representative
interior point so border geometry never yields an ambiguous join. Because an
owner can hold land across many block groups, the dissolved owner layer is NOT
given a single GEOID; instead an ``owner_geography_xwalk`` records each owner's
acreage split across block groups.
"""

from __future__ import annotations

import logging

import geopandas as gpd
import pandas as pd

log = logging.getLogger("cadastral.census")


class CensusGeographies:
    """Lazily-loaded, reprojected tract + block-group polygons."""

    def __init__(self, bg_path: str | None, tract_path: str | None, target_crs):
        self.bg_path = bg_path
        self.tract_path = tract_path
        self.target_crs = target_crs
        self._bg = None

    @property
    def bg(self) -> gpd.GeoDataFrame | None:
        if self._bg is None and self.bg_path:
            bg = gpd.read_file(self.bg_path, columns=["GEOID"])
            if bg.crs != self.target_crs:
                bg = bg.to_crs(self.target_crs)
            self._bg = bg.rename(columns={"GEOID": "BG_GEOID"})[["BG_GEOID", "geometry"]]
            log.info("  loaded %s block groups", f"{len(self._bg):,}")
        return self._bg


def tag_parcels(parcels: gpd.GeoDataFrame, census: CensusGeographies) -> gpd.GeoDataFrame:
    """Add ``BG_GEOID`` and ``TRACT_GEOID`` to parcels via point-in-polygon.

    The block-group GEOID's first 11 chars are its tract GEOID, so one spatial
    join suffices. Parcels whose representative point falls outside all block
    groups (border/water slivers) get null GEOIDs (logged).
    """
    parcels = parcels.copy()
    if census is None or census.bg is None:
        parcels["BG_GEOID"] = pd.NA
        parcels["TRACT_GEOID"] = pd.NA
        return parcels

    pts = parcels.geometry.representative_point()
    pt_gdf = gpd.GeoDataFrame(
        {"_row": range(len(parcels))}, geometry=pts, crs=parcels.crs
    )
    joined = gpd.sjoin(
        pt_gdf, census.bg, how="left", predicate="within"
    ).drop_duplicates("_row")
    bg = joined.set_index("_row")["BG_GEOID"].reindex(range(len(parcels)))
    parcels["BG_GEOID"] = bg.values
    parcels["TRACT_GEOID"] = parcels["BG_GEOID"].astype("string").str.slice(0, 11)

    n_null = int(parcels["BG_GEOID"].isna().sum())
    if n_null:
        log.info("  %s parcels had no block-group match (border/water)", f"{n_null:,}")
    return parcels


def owner_geography_xwalk(parcels: gpd.GeoDataFrame, owner_id: str,
                          acres_col: str = "ConsolAcres_parcel") -> pd.DataFrame:
    """Build OwnerID x BG_GEOID acreage crosswalk with within-owner percentages.

    ``acres_col`` should hold each parcel's own acreage (from projected area).
    """
    cols = [owner_id, "BG_GEOID", "TRACT_GEOID", acres_col]
    df = pd.DataFrame(parcels[[c for c in cols if c in parcels.columns]]).copy()
    if acres_col not in df.columns:
        df[acres_col] = 0.0
    grp = (
        df.groupby([owner_id, "BG_GEOID", "TRACT_GEOID"], dropna=False)
        .agg(parcel_count=(acres_col, "size"), total_acres=(acres_col, "sum"))
        .reset_index()
    )
    owner_tot = grp.groupby(owner_id)["total_acres"].transform("sum")
    grp["percent_owner_acres_in_bg"] = (
        (grp["total_acres"] / owner_tot.replace(0, pd.NA) * 100).round(2)
    )
    return grp.sort_values([owner_id, "total_acres"], ascending=[True, False]).reset_index(drop=True)
