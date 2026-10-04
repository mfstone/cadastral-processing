"""Owner-of-record parsing: mailing state, co-ownership, legal form.

Three measured facts determine the shape of this module, and all three narrow
what the data can honestly support.

**A parcel has exactly one mailing address.** Of the 33,769 duplicated parcels
in the 2006 vintage, precisely 2 carry more than one distinct mailing state; in
2021, none do. So "share of owner *interests* with a California mailing
address" is not a distinct statistic from "share of *parcels*" -- it is the same
parcels re-weighted by how many names appear on the record. The published
denominators are therefore parcels and acres, and the interest table below
exists for counting co-owners and classifying legal form, **never for
location**.

**Co-ownership is expressed inside the owner string, not across rows.** 37.5%
of 2006 records and 32.3% of 2021 records contain an ``&``; duplicate rows are
exploded geometry, not co-owners.

**The second name field fell out of use, and it is ambiguous besides.**
``OWNR_NAM2`` is populated on 12.6% of 2006 parcels but 0.6% by 2021 -- a change
in how the schema was used, not a decline in joint ownership, so a co-owner
*count* must never be published as a trend.

Worse, ``OWNR_NAM1`` is only ``String(30)`` in the early era and long names
*overflow* into ``OWNR_NAM2`` as a continuation rather than a second party.
A field-width heuristic does not separate the two cases -- measured on 2006,
``MONTANA COLLEGE OF MINERAL`` + ``SCIENCE & TECHNOLOGY`` is plainly a
continuation at 26 characters, while ``CARLSON NATALIE & KYNNY (2/3)`` +
``VIRGIL A BORONI (1/3)`` is plainly a co-owner at 29. So the two fields are
joined with a **neutral space**, never with ``&``: a space is correct whichever
case applies, and because 2013+ carries the whole name in one 167-character
field, it also matches better across the 2011->2013 boundary than an invented
separator would. Consequently ``n_names_on_record`` counts only the
*unambiguous* ``&``/``AND`` separators actually present in the source text, and
is documented as a lower bound.

Mailing state needs an era-aware extractor. 2002 has a clean ``MAIL_STATE``;
2003-2011 fuse city, state and ZIP+4 into a fixed-width 27-character
``MAILCITY_S``; 2013 onward have ``OwnerState``. Measured on the fixed-width
window, characters 17-18 are a valid two-letter state 98.97% of the time --
indistinguishable from the 99.12% the *native* column achieves in 2013, so the
parse is exact rather than best-effort.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from cadastral.normalize import _clean, is_entity, normalize_name

# MAILCITY_S is FIXED-WIDTH, not delimited: city 1-16, state 17-18, ZIP+4 19-27.
# Splitting on whitespace breaks on every multi-word city ("BUTTE", "GREAT
# FALLS") and would corrupt the out-of-state series exactly where it matters.
MAILCITY_S_STATE = slice(16, 18)
MAILCITY_S_CITY = slice(0, 16)
MAILCITY_S_ZIP = slice(18, 27)

# Co-owner separators. _clean() has already normalised "&" to " & ".
_SPLIT = re.compile(r"\s+&\s+|\s+AND\s+")
_STATE_OK = re.compile(r"^[A-Z]{2}$")


def mailing_state(df: pd.DataFrame, res: dict) -> tuple[pd.Series, str]:
    """Owner mailing state plus the mechanism used, by era.

    Returns an upper-cased two-letter series ("" where unavailable) and a label
    naming which column it came from, so the mechanism travels with the number.
    """
    col = res.get("owner_state")
    if col and col in df.columns:
        s = df[col].astype("string").str.strip().str.upper().fillna("")
        return s.astype("object"), f"owner_state:{col}"

    col = res.get("mail_state")
    if col and col in df.columns:
        s = df[col].astype("string").str.strip().str.upper().fillna("")
        return s.astype("object"), f"mail_state:{col}"

    col = res.get("owner_citystatezip")
    if col and col in df.columns:
        raw = df[col].astype("string").fillna("")
        s = raw.str.slice(MAILCITY_S_STATE.start, MAILCITY_S_STATE.stop).str.strip().str.upper()
        return s.fillna("").astype("object"), f"mailcity_s_fixed_width:{col}"

    return pd.Series("", index=df.index, dtype="object"), "unavailable"


def mailing_city(df: pd.DataFrame, res: dict) -> pd.Series:
    """Owner mailing city, by era (the fixed-width window where applicable)."""
    for key in ("owner_city", "mail_city"):
        col = res.get(key)
        if col and col in df.columns:
            return df[col].astype("string").str.strip().str.upper().fillna("").astype("object")
    col = res.get("owner_citystatezip")
    if col and col in df.columns:
        raw = df[col].astype("string").fillna("")
        return (raw.str.slice(MAILCITY_S_CITY.start, MAILCITY_S_CITY.stop)
                .str.strip().str.upper().fillna("").astype("object"))
    return pd.Series("", index=df.index, dtype="object")


def state_is_valid(state: pd.Series) -> np.ndarray:
    return np.asarray(state.str.fullmatch(_STATE_OK, na=False), dtype=bool)


def record_fields(df: pd.DataFrame, res: dict) -> pd.DataFrame:
    """Per-parcel owner attributes, as they belong on ``parcel_snapshot``.

    ``n_names_on_record`` counts the names appearing on the owner of record and
    is an era-dependent quantity (see module docstring) -- useful as a
    cross-section, not as a trend.
    """
    name1_col = res.get("owner_name")
    name1 = (df[name1_col] if name1_col in df.columns else pd.Series("", index=df.index))
    name2_col = res.get("owner_name_2")
    name2 = (df[name2_col] if name2_col and name2_col in df.columns
             else pd.Series("", index=df.index))

    n1 = _clean(name1)
    n2 = _clean(name2)
    # Neutral space, not "&": see module docstring. Joining with "&" would
    # fabricate "MONTANA DEPARTMENT OF ENVIRONM & QUALITY" as two parties.
    combined = np.where(n2 != "", n1 + " " + n2, n1)
    combined = pd.Series(combined, index=df.index, dtype="object")

    state, mech = mailing_state(df, res)
    out = pd.DataFrame(index=df.index)
    out["owner_name_raw"] = n1
    out["owner_name_2_raw"] = n2
    out["owner_name_norm"] = normalize_name(combined)
    out["owner_blank"] = (out["owner_name_norm"] == "")
    out["n_names_on_record"] = _count_names(combined)      # lower bound
    out["owner_name_2_present"] = (n2 != "").to_numpy(dtype=bool)
    out["owner_is_entity"] = is_entity(out["owner_name_norm"]).to_numpy(dtype=bool)
    out["owner_state"] = state
    out["owner_state_valid"] = state_is_valid(state)
    out["owner_in_state"] = np.asarray(state == "MT", dtype=bool)
    out.attrs["state_mechanism"] = mech
    return out


def _count_names(combined: pd.Series) -> pd.Series:
    """Lower bound on the number of named parties on the record.

    Counts only the ``&``/``AND`` separators present in the source text. It
    cannot see a co-owner that overflowed into the second name field, because
    that case is indistinguishable from a truncated name (see module
    docstring). A lower bound with a known reason is publishable; a guess
    dressed up as a count is not.
    """
    n = combined.str.count(r"\s+&\s+|\s+AND\s+").fillna(0).astype("int16") + 1
    return n.where(combined != "", 0).astype("int16")


def split_interests(parcel_id: pd.Series, combined_norm: pd.Series) -> pd.DataFrame:
    """One row per named party on the owner of record.

    Deliberately does **not** repair the missing surname in forms like
    "SMITH JOHN R & SUSAN". Inferring one would be an analytical convention, and
    since these rows carry no independent mailing address the only thing the
    split buys is a count and a legal-form classification -- neither of which
    needs the surname. Adding a convention for no analytical gain is how a
    derived dataset starts lying.
    """
    frames = []
    parts = combined_norm.str.split(_SPLIT, regex=True)
    exploded = parts.explode()
    keep = exploded.notna() & (exploded.astype("string").str.strip() != "")
    exploded = exploded[keep]
    pid = parcel_id.reindex(exploded.index)
    seq = exploded.groupby(level=0).cumcount() if hasattr(exploded, "groupby") else None
    out = pd.DataFrame({
        "parcel_id": pid.to_numpy(),
        "name_norm": exploded.astype("object").str.strip().to_numpy(),
    })
    out["seq"] = out.groupby("parcel_id").cumcount().astype("int16")
    out["is_entity"] = is_entity(pd.Series(out["name_norm"])).to_numpy(dtype=bool)
    frames.append(out)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
