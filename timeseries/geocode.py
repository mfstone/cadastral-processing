"""The DOR geocode: parsing, structural validation, and the spatial keys.

Montana's 17-character geocode is positionally hierarchical, which is what lets
the whole pipeline locate parcels from attributes alone and detect parcel
creation without diffing geometry::

    18 1082 07 1 01 01 0000
    │  │    │  │ │  │  └── Unit     condominium / several taxable improvements
    │  │    │  │ │  └───── Lot      "each contiguous individual ownership"
    │  │    │  │ └──────── Block    "a city block, a survey or a farm tract"
    │  │    │  └────────── Quarter  NE=1 NW=2 SW=3 SE=4 (0 = whole section)
    │  │    └───────────── Section  1 sq mi
    │  └────────────────── Township code (township and range together)
    └───────────────────── County   DOR number 1-56 (population rank, not FIPS)

Two measured facts shape this module.

**Only the first nine characters need to be numeric.** 4,654 of 887,264 geocodes
in the 2026 vintage carry a letter in the block/lot/unit tail (for example
``5229573420101F001``, ``5638262430446000A``, and a few lowercase such as
``4208582542001b473``). Their locating prefix is intact, so rejecting them would
discard perfectly placeable parcels.

**Validation must be structural, not a sentinel list.** The parcel-id column
also carries literal stand-ins (``NA`` appears 14,323 times in 2006, all in
Flathead County, with no owner and 1.28 M acres) and families of repeated-digit
filler (``03888844444444444``, ``03555555555550000``, ``03666666666666666`` …).
A range check on county, section and quarter catches every numeric filler
pattern without anyone having to enumerate it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Full positional form. The tail is alphanumeric by observation, not by design.
GEOCODE_RE = (
    r"^(?P<county>\d{2})(?P<twp_code>\d{4})(?P<section>\d{2})(?P<quarter>\d)"
    r"(?P<block>[0-9A-Z]{2})(?P<lot>[0-9A-Z]{2})(?P<unit>[0-9A-Z]{4})$"
)
# The locating prefix alone: anything matching this can be placed on the map,
# whatever its tail looks like.
GEOCODE_PREFIX_RE = (
    r"^(?P<county>\d{2})(?P<twp_code>\d{4})(?P<section>\d{2})(?P<quarter>\d)"
)

# Non-numeric stand-ins for "no value". The numeric filler patterns are caught
# structurally by the range checks below and are deliberately not listed.
PID_SENTINELS = frozenset({"NA", "N/A", "NULL", "NONE", "NAN", "0", "UNKNOWN", ".", "-"})

PREFIX_LEN = 9


def normalize(pid: pd.Series) -> pd.Series:
    """Trim, upper-case and NA-fill a raw parcel-id column.

    NA becomes "" so that every downstream comparison stays on numpy bools:
    under pandas 3.0, combining a masked BooleanArray with an Arrow-backed
    boolean raises "boolean value of NA is ambiguous".
    """
    return pid.astype("string").str.strip().str.upper().fillna("").astype("object")


def parse(pid_norm: pd.Series) -> pd.DataFrame:
    """Parse a normalized geocode series into its seven positional groups.

    Returns a frame indexed like *pid_norm* with the seven components plus
    ``locatable`` (prefix parses and ranges check out) and ``tail_ok`` (the full
    17-character form parses too).
    """
    pre = pid_norm.str.extract(GEOCODE_PREFIX_RE)
    full = pid_norm.str.extract(GEOCODE_RE)

    county_n = pd.to_numeric(pre["county"], errors="coerce")
    section_n = pd.to_numeric(pre["section"], errors="coerce")
    quarter_n = pd.to_numeric(pre["quarter"], errors="coerce")

    locatable = (
        np.asarray(pre["county"].notna(), dtype=bool)
        & np.asarray(county_n.between(1, 56).fillna(False), dtype=bool)
        & np.asarray(section_n.between(1, 36).fillna(False), dtype=bool)
        & np.asarray(quarter_n.between(0, 4).fillna(False), dtype=bool)
        & ~np.asarray(pid_norm.isin(PID_SENTINELS), dtype=bool)
    )

    out = pd.DataFrame(index=pid_norm.index)
    for part in ("county", "twp_code", "section", "quarter"):
        out[part] = pre[part]
    for part in ("block", "lot", "unit"):
        out[part] = full[part]
    out["locatable"] = locatable
    out["tail_ok"] = np.asarray(full["county"].notna(), dtype=bool) & locatable
    return out


def validity(pid_norm: pd.Series) -> np.ndarray:
    """Boolean mask of geocodes that can be placed and counted."""
    return parse(pid_norm)["locatable"].to_numpy(dtype=bool)


# ---------------------------------------------------------------- spatial keys
#
# The township key is deliberately county + code (6 chars), not the bare 4-char
# code. 14-15 township codes appear under two county prefixes; keying on the
# pair splits such a township into one unit per county, which is both the
# conservative reading and the one that makes county rollups reconcile exactly.
# Measured in 2026: 4,670 bare codes, 4,684 county+code units.

def township_key(parts: pd.DataFrame) -> pd.Series:
    return parts["county"] + parts["twp_code"]


def section_key(parts: pd.DataFrame) -> pd.Series:
    return parts["county"] + parts["twp_code"] + parts["section"]


def quarter_key(parts: pd.DataFrame) -> pd.Series:
    return parts["county"] + parts["twp_code"] + parts["section"] + parts["quarter"]


def block_key(parts: pd.DataFrame) -> pd.Series:
    return quarter_key(parts) + parts["block"]


def lot_key(parts: pd.DataFrame) -> pd.Series:
    return block_key(parts) + parts["lot"]


def is_condo_unit(parts: pd.DataFrame) -> np.ndarray:
    """Non-zero unit digits: a condominium or multi-improvement parcel.

    Kept as its own column because such parcels carry ~0 acres, and without
    separating them a condo boom in Missoula or Whitefish reads as land
    fragmentation in the size-class bins.
    """
    unit = parts["unit"].fillna("0000")
    return np.asarray((unit != "0000") & parts["unit"].notna(), dtype=bool)


KEY_BUILDERS = {
    "township": township_key,
    "section": section_key,
    "quarter": quarter_key,
    "block": block_key,
    "lot": lot_key,
}
