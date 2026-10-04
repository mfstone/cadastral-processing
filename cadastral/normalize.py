"""Owner name and mailing-address normalization.

These functions produce *normalized* keys used for entity resolution while the
raw source values are always preserved alongside. Normalization is deliberately
conservative (the methodology prefers errors of omission): it standardizes
whitespace, case, punctuation, common abbreviations, and PO-box spellings, but
never collapses distinct tokens or reorders names.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# regexes (compiled once)
# ---------------------------------------------------------------------------
_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[.,;:/\\\"'`*#]+")          # drop noise punctuation (keep & and -)
_PO_BOX = re.compile(r"\bP\.?\s*O\.?\s*BOX\b", re.I)
_AMP = re.compile(r"\s*&\s*")
_NONALNUM_EDGE = re.compile(r"^[^0-9A-Z&]+|[^0-9A-Z&]+$")

# street-suffix standardization (light; only unambiguous ones)
_SUFFIX = {
    "STREET": "ST", "AVENUE": "AVE", "ROAD": "RD", "DRIVE": "DR",
    "LANE": "LN", "BOULEVARD": "BLVD", "COURT": "CT", "HIGHWAY": "HWY",
    "PLACE": "PL", "CIRCLE": "CIR", "TERRACE": "TER", "PARKWAY": "PKWY",
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "APARTMENT": "APT", "SUITE": "STE", "UNIT": "UNIT",
}

# tokens marking a non-individual (business / agency / trust) owner.
_ENTITY_TOKENS = {
    "LLC", "INC", "CO", "CORP", "CORPORATION", "COMPANY", "LP", "LLP", "LTD",
    "PLLC", "PC", "TRUST", "TRUSTEE", "ESTATE", "ASSOC", "ASSOCIATION",
    "PARTNERSHIP", "PARTNERS", "RANCH", "RANCHES", "FARMS", "FARM",
    "LIVESTOCK", "CATTLE", "LAND", "PROPERTIES", "HOLDINGS", "ENTERPRISES",
    "CHURCH", "DISTRICT", "SCHOOL", "CITY", "TOWN", "COUNTY", "STATE",
    "UNITED", "USA", "USDA", "USDI", "BUREAU", "FOREST", "SERVICE",
    "GOVERNMENT", "DEPARTMENT", "TRIBE", "TRIBAL", "NATION", "BANK",
    "FEDERAL", "MONTANA", "CONSERVANCY", "FOUNDATION", "MINING", "COOP",
}

_GENERIC_ADDR = re.compile(r"\bGENERAL\s+DELIVERY\b", re.I)


def _clean(s: pd.Series) -> pd.Series:
    """Upper, strip, collapse whitespace, drop noise punctuation."""
    s = s.fillna("").astype(str).str.upper()
    s = s.str.replace(_PUNCT, " ", regex=True)
    s = s.str.replace(_AMP, " & ", regex=True)
    s = s.str.replace(_WS, " ", regex=True).str.strip()
    return s


def normalize_name(s: pd.Series) -> pd.Series:
    """Normalize an owner-name column to a comparison key."""
    out = _clean(s)
    # trim leading/trailing non-alphanumerics that survived
    out = out.str.replace(_NONALNUM_EDGE, "", regex=True).str.strip()
    return out


def normalize_address(parts: list[pd.Series]) -> pd.Series:
    """Concatenate + normalize the street-address line(s) into one key.

    ``parts`` is the ordered list of available address columns
    (address_1/2/3). Missing columns should be passed as empty series.
    """
    joined = None
    for p in parts:
        p = _clean(p)
        joined = p if joined is None else (joined + " " + p).str.strip()
    if joined is None:
        joined = pd.Series([""], dtype="object")
    joined = joined.str.replace(_PO_BOX, "PO BOX", regex=True)
    # standardize street suffix tokens
    def _std(tok: str) -> str:
        return _SUFFIX.get(tok, tok)

    joined = joined.map(
        lambda v: " ".join(_std(t) for t in v.split()) if isinstance(v, str) else v
    )
    joined = joined.str.replace(_WS, " ", regex=True).str.strip()
    return joined


def normalize_city(s: pd.Series) -> pd.Series:
    return _clean(s)


def normalize_state(s: pd.Series) -> pd.Series:
    out = _clean(s)
    # keep first 2 alpha chars when a valid 2-letter code; else as-is
    return out.str.replace(r"[^A-Z]", "", regex=True).str.slice(0, 2)


def zip5(s: pd.Series) -> pd.Series:
    """Extract the leading 5-digit ZIP from a possibly ZIP+4 / messy field."""
    digits = s.fillna("").astype(str).str.replace(r"\D", "", regex=True)
    return digits.str.slice(0, 5)


def is_entity(name_norm: pd.Series) -> pd.Series:
    """Heuristic: True where the normalized name looks like a business/agency/trust."""
    toks = name_norm.str.split()

    def _hit(parts) -> bool:
        if not isinstance(parts, list):
            return False
        return any(t in _ENTITY_TOKENS for t in parts)

    return toks.map(_hit)


def is_generic_address(addr_norm: pd.Series) -> pd.Series:
    """True where the address is a General Delivery / non-discriminating address."""
    blank = addr_norm.fillna("").str.strip() == ""
    gen = addr_norm.fillna("").str.contains(_GENERIC_ADDR)
    return blank | gen


def add_normalized_fields(df: pd.DataFrame, info) -> pd.DataFrame:
    """Attach normalized identity columns to a parcel DataFrame.

    Adds: name_norm, addr_norm, city_norm, state_norm, zip5, is_entity,
    addr_generic, owner_blank. Raw source columns are left untouched.
    ``info`` is a :class:`cadastral.schema.SourceInfo`.
    """
    df = df.copy()
    name_col = info.require("owner_name")
    df["name_norm"] = normalize_name(df[name_col])

    # secondary owner-name field (historical OWNR_NAM2) folded in if present
    n2 = info.col("owner_name_2")
    if n2 and n2 in df.columns:
        extra = normalize_name(df[n2])
        df["name_norm"] = (df["name_norm"] + " " + extra).str.replace(_WS, " ", regex=True).str.strip()

    addr_cols = [info.col(k) for k in ("owner_address_1", "owner_address_2", "owner_address_3")]
    parts = [df[c] if (c and c in df.columns) else pd.Series([""] * len(df), index=df.index)
             for c in addr_cols]
    df["addr_norm"] = normalize_address(parts)

    city_col = info.col("owner_city")
    df["city_norm"] = normalize_city(df[city_col]) if city_col else ""
    state_col = info.col("owner_state")
    df["state_norm"] = normalize_state(df[state_col]) if state_col else ""
    zip_col = info.col("owner_zip")
    df["zip5"] = zip5(df[zip_col]) if zip_col else ""

    df["is_entity"] = is_entity(df["name_norm"])
    df["addr_generic"] = is_generic_address(df["addr_norm"])
    df["owner_blank"] = df["name_norm"].str.strip() == ""
    return df
