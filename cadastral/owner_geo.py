"""Owner *mailing-location* enrichment.

Distinct from parcel-location tagging: this characterizes *where the owner is
based* from their mailing address, supporting absentee / out-of-state ownership
analysis. The core (ZIP5, state, in-state flag) needs no external data. An
optional HUD/Census ZIP->county crosswalk adds ``owner_county_fips`` when
supplied.
"""

from __future__ import annotations

import logging

import pandas as pd

log = logging.getLogger("cadastral.owner_geo")

HOME_STATE = "MT"


def add_owner_location(df: pd.DataFrame, zip_crosswalk: pd.DataFrame | None = None) -> pd.DataFrame:
    """Add owner mailing-location fields derived from normalized owner address.

    Adds: ``owner_zip5``, ``owner_state``, ``owner_in_state`` and, if a
    crosswalk is given, ``owner_county_fips``. Relies on the normalized
    ``zip5``/``state_norm`` columns from :mod:`cadastral.normalize`.
    """
    df = df.copy()
    df["owner_zip5"] = df.get("zip5", pd.Series("", index=df.index)).fillna("")
    df["owner_state"] = df.get("state_norm", pd.Series("", index=df.index)).fillna("")
    df["owner_in_state"] = df["owner_state"].eq(HOME_STATE)

    if zip_crosswalk is not None and len(zip_crosswalk):
        xwalk = zip_crosswalk.copy()
        xwalk["zip5"] = xwalk["zip5"].astype(str).str.zfill(5)
        m = dict(zip(xwalk["zip5"], xwalk["county_fips"].astype(str)))
        df["owner_county_fips"] = df["owner_zip5"].map(m)
    else:
        df["owner_county_fips"] = pd.NA
    return df


def load_zip_crosswalk(path: str | None) -> pd.DataFrame | None:
    """Load a HUD/Census ZIP->county crosswalk.

    Accepts a CSV with at least ZIP and county-FIPS columns; column names are
    matched loosely (``zip``/``zip5`` and ``county``/``geoid``/``fips``).
    """
    if not path:
        return None
    raw = pd.read_csv(path, dtype=str)
    lower = {c.lower(): c for c in raw.columns}
    zip_col = next((lower[k] for k in ("zip5", "zip", "zip_code", "zipcode") if k in lower), None)
    fips_col = next((lower[k] for k in ("county_fips", "county", "geoid", "fips", "countyfips")
                     if k in lower), None)
    if zip_col is None or fips_col is None:
        log.warning("zip crosswalk %s lacks recognizable zip/county columns; ignoring", path)
        return None
    out = raw[[zip_col, fips_col]].rename(columns={zip_col: "zip5", fips_col: "county_fips"})
    out = out.dropna().drop_duplicates("zip5")
    log.info("  loaded %d zip->county rows", len(out))
    return out
