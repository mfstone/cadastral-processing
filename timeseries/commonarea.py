"""Dedicated common areas: open space, parks, HOA and condominium tracts.

A subdivision plat sets aside tracts that are never meant to carry a house:
dedicated open space, parks, drainage and detention lots, well sites, the
condominium master lot. They are parcels, they sit at stage 0 of the
development ladder for ever, and left in they inflate dormant inventory and
depress every absorption curve. Measured on the 2026 vintage, 7.7% of the
platted-only subdivision lots under 40 acres are such tracts; in Flathead,
Missoula and Gallatin counties, a fifth to a quarter.

No single field marks them, so three signals are combined, each measured on
the 2026 and 2006 vintages:

1. **The DOR property type is Non-Valued** (``NV - Non-Valued Property`` from
   2013, ``non-valued property`` in the earlier era) **and the parcel lies in
   a named subdivision**: the department's own mark for a tract that carries
   no assessed value. 5.9% of platted-only lots in 2026. Outside a
   subdivision the same mark means centrally assessed property: of the 1,642
   Non-Valued parcels with no subdivision in 2026, 81% belong to NorthWestern
   Energy, BNSF, Avista, the telephone cooperatives and the ditch companies,
   so the signal is confined to platted ground.
2. **The owner is an owners' association or condominium master, or the owner
   field names the tract itself** (``WESTGATE SUB PARK``, ``SPIRIT HILLS SUB
   PARK AREA``): the earlier era writes the tract's name into the owner field
   when no party holds it. 2.9% of platted-only lots in 2026. A company whose
   name merely contains the words (``WIDE OPEN SPACES LLC``, ``PARKLAND USA
   CORPORATION``) is a party, not a tract, and is left alone.
3. **The legal description names the tract** (``OPEN SPACE``, ``COMMON AREA``,
   ``PARK D``, ``DRAINAGE``, ``OUTLOT``, ``LOT OS-C``) **and the parcel carries
   no assessed building.** The description is read with the subdivision's own
   name removed, because Trail Creek Addition, Floral Park and Parkland West
   are names, not tracts. A phrase that follows an appurtenance word (``PLUS
   OPEN SPACE``, ``1/24 INT COMMON AREA``, ``2.5% COMMON AREA INTEREST``)
   marks a lot that *owns a share* of a common area, which is a home, not a
   park, and is left alone. With both guards the legal signal alone touches
   0.3% of built lots in 2026 and 0.4% in 2006; without the building guard
   it flagged a residence for every two tracts.

``common_area_src`` is a bitmask naming the signals that fired, so the QA and
the dashboard can say why; ``is_common_area`` is any bit.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

SRC_LEGAL = 1        # legal description names the tract, and no building is assessed
SRC_NONVALUED = 2    # DOR property type Non-Valued
SRC_ASSOCIATION = 4  # owners' association, condo master, road or water users' association
SRC_TRACT_OWNER = 8  # the owner field carries the tract's own name
SOURCES = {SRC_LEGAL: "legal", SRC_NONVALUED: "nonvalued",
           SRC_ASSOCIATION: "association", SRC_TRACT_OWNER: "tract_owner"}

# Tract descriptors. PARK only as a descriptor ("PARK D", "PARK AREA", "PARK IN
# BLK", a trailing "PARK"), never as part of a name; TRAIL is not here at all,
# because it names subdivisions far more often than easements.
PHRASE = re.compile(
    r"OPEN SPACE|COMMON (?:AREA|ELEMENT|OPEN|GROUND)|OPEN AREA|GREEN ?BELT|GREEN ?SPACE"
    r"|PARK ?LANDS?\b|HOMEOWNERS? PARK|PUBLIC PARK|DEDICATED PARK|CITY PARK|PARK AREA"
    r"|\bPARK [A-Z]\b|PARK IN BLK|\bPARK$|DRAINAGE|DETENTION|STORM ?WATER|OUTLOT|OUT LOT"
    r"|WELL SITE|UTILITY (?:LOT|SITE|ACC)|\bBUFFER\b|PLAYGROUND|TOT LOT|RECREATION (?:AREA|LOT)"
    r"|\bLOT OS\b|\bOS-?[A-Z0-9]{1,3}\b|PRIVATE ROAD|NAT(?:URAL)? AREA")
# A lot that owns a share of a common area: the phrase follows an appurtenance word.
APPURTENANT = re.compile(
    r"(?:PLUS|INCLUDING|INCL|WITH|W/|AND|&|TOGETHER WITH|UND(?:IV(?:IDED)?)? ?INT(?:EREST)?(?: IN)?"
    r"|INT ?IN|INTEREST IN|SHARE OF|SHARE IN|PORTION OF|PT OF|PART OF|%|\d+/\d+(?: INT)?(?: IN)?)"
    r"\s*(?:OF )?(?:THE )?(?:PRIVATE )?(?:COMMON|OPEN|PARK|GREEN)"
    r"|COMMON (?:AREA|ELEMENT)S? INTEREST|COMMON INTEREST|INT ?IN COMMON")
ASSOCIATION = re.compile(
    r"HOMEOWNER|HOME OWNER|\bHOA\b|OWNERS ASSOC|OWNERS ASSN|PROPERTY OWNERS|LANDOWNERS ASSOC"
    r"|LAND OWNERS ASSOC|CONDO MASTER|CONDOMINIUM ASSOC|MASTER ASSOC|\bPOA\b|ROAD ASSOC|WATER USERS")
TRACT_OWNER = re.compile(
    r"OPEN SPACE|OPEN SP\b|COMMON AREA|PARK AREA|SUB PARK|\bPARKLAND|HOMEOWNERS? PARK|COMMON ELEMENT")
NONVALUED = re.compile(r"NON.?VALUED", re.IGNORECASE)
# An owner that is a company, not a tract that nobody holds.
COMPANY = re.compile(
    r"\b(?:LLC|L L C|INC|CORP|CORPORATION|LTD|CO|COMPANY|PROPERTIES|HOLDINGS|TRUST|TRUSTEE"
    r"|LP|LLP|LLLP|PARTNERSHIP|ENTERPRISES)\b")
_WS = re.compile(r"\s+")


def _norm(s: pd.Series) -> pd.Series:
    return s.astype("string").fillna("").str.upper().str.replace(_WS, " ", regex=True).str.strip()


def classify(legal: pd.Series, subdivision: pd.Series, property_type: pd.Series,
             owner_name_norm: pd.Series, improved: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """Per-parcel ``(is_common_area, common_area_src)``.

    ``improved`` is the extract's 1 / 0 / -1 column; only an assessed building
    (1) suppresses the legal signal, so an unknown vintage still gets it.
    The Non-Valued signal needs a subdivision name; the tract-owner signal
    needs an owner that is not a company.
    """
    leg = _norm(legal)
    sub = _norm(subdivision)
    stripped = pd.Series(
        [l.replace(sn, " ") if sn else l for l, sn in zip(leg.to_numpy(), sub.to_numpy())],
        index=leg.index, dtype="object")
    built = np.asarray(improved, dtype="int8") == 1
    legal_hit = (stripped.str.contains(PHRASE, regex=True).to_numpy(dtype=bool)
                 & ~stripped.str.contains(APPURTENANT, regex=True).to_numpy(dtype=bool)
                 & ~built)
    own = _norm(owner_name_norm)
    assoc = own.str.contains(ASSOCIATION, regex=True).to_numpy(dtype=bool)
    tract = (own.str.contains(TRACT_OWNER, regex=True).to_numpy(dtype=bool)
             & ~own.str.contains(COMPANY, regex=True).to_numpy(dtype=bool))
    in_sub = (sub != "").to_numpy(dtype=bool)
    nonval = (_norm(property_type).str.contains(NONVALUED, regex=True).to_numpy(dtype=bool)
              & in_sub)

    src = np.zeros(len(leg), dtype="int8")
    src[legal_hit] |= SRC_LEGAL
    src[nonval] |= SRC_NONVALUED
    src[assoc] |= SRC_ASSOCIATION
    src[tract] |= SRC_TRACT_OWNER
    return src > 0, src


def summarize(parcels: pd.DataFrame) -> dict:
    """QA block for one snapshot: counts by signal and the share of platted lots."""
    src = parcels["common_area_src"].to_numpy(dtype="int8")
    flag = src > 0
    acres = parcels["acres"].fillna(0).to_numpy(dtype="float64")
    lot = ((parcels["subdivision"].fillna("") != "").to_numpy(dtype=bool)
           & (acres < 40) & (parcels["dev_stage"].to_numpy() == 0))
    built = parcels["dev_stage"].to_numpy() == 2
    out = {"common_area_parcels": int(flag.sum()),
           "common_area_acres": float(acres[flag].sum()),
           "common_area_by_source": {name: int((src & bit).astype(bool).sum())
                                     for bit, name in SOURCES.items()},
           "platted_lots_lt40": int(lot.sum()),
           "pct_common_area_of_platted_lots_lt40": (
               round(100.0 * float(flag[lot].mean()), 3) if lot.any() else None),
           "pct_common_area_of_built": round(100.0 * float(flag[built].mean()), 3) if built.any() else None}
    return out
