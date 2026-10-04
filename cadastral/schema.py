"""Schema-alias resolution and source validation.

The cadastral data ships under several schemas: the shapefile truncates field
names to 10 chars (``OwnerAddre``, ``OwnerZipCo``, ``CareOfTaxp``), the MSL
metadata uses full labels (``OwnerAddress1``, ``OwnerZipCode``,
``CareOfTaxpayer``), and historical exports used ``OWNR_NAM1``/``OWNCLASS``.
Everything downstream addresses columns by *logical* name and resolves to the
actual column present via :data:`FIELD_ALIASES`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import pyogrio

log = logging.getLogger("cadastral.schema")

# logical field -> ordered candidate column names (first match wins)
FIELD_ALIASES: dict[str, list[str]] = {
    "parcel_id": ["PARCELID", "ParcelID", "Parcel_ID"],
    "county_code": ["COUNTYCD", "CountyCd", "COUNTY_CD"],
    "county_name": ["CountyName", "COUNTYNAME", "COUNTY"],
    "owner_name": ["OwnerName", "OWNR_NAM1", "OWNERNAME"],
    "owner_name_2": ["OWNR_NAM2", "OwnerName2"],
    "owner_address_1": ["OwnerAddress1", "OwnerAddre", "OwnerAdd_1", "MAIL_ADDR"],
    "owner_address_2": ["OwnerAddress2", "OwnerAdd_2"],
    "owner_address_3": ["OwnerAddress3", "OwnerAdd_3"],
    "owner_city": ["OwnerCity", "MAILCITY", "OWNERCITY"],
    "owner_state": ["OwnerState", "OWNERSTATE"],
    "owner_zip": ["OwnerZipCode", "OwnerZipCo", "OWNERZIP"],
    "owner_citystatezip": ["MAILCITY_S", "CityStateZ"],
    "care_of": ["CareOfTaxpayer", "CareOfTaxp"],
    "dba_name": ["DbaName", "DBANAME"],
    "owner_class": ["OWNCLASS", "OwnClass"],          # historical only
    "property_type": ["PropType", "PROPTYPE"],
    "total_acres": ["TotalAcres", "TOTALACRES"],
    "gis_acres": ["GISAcres", "GISACRES"],
}

# logical fields the pipeline cannot run without
REQUIRED = ["parcel_id", "county_code", "owner_name"]

# Albers-equal-area-ish acre conversion handled in dissolve; here we just
# expose the meters->acres factor for callers that already work in a meter CRS.
SQM_TO_ACRES = 0.00024710538146717

# Formal county crosswalk from CountyNumber.pdf: prefix == shapefile COUNTYCD ==
# the first two digits of PARCELID/GeoCodeSearch == ORION County (zero-padded).
COUNTY_PREFIX = {
    1: ("Silver Bow", "SB"), 2: ("Cascade", "CS"), 3: ("Yellowstone", "YE"),
    4: ("Missoula", "MS"), 5: ("Lewis and Clark", "LC"), 6: ("Gallatin", "GA"),
    7: ("Flathead", "FL"), 8: ("Fergus", "FE"), 9: ("Powder River", "PR"),
    10: ("Carbon", "CA"), 11: ("Phillips", "PH"), 12: ("Hill", "HI"),
    13: ("Ravalli", "RA"), 14: ("Custer", "CU"), 15: ("Lake", "LA"),
    16: ("Dawson", "DW"), 17: ("Roosevelt", "RO"), 18: ("Beaverhead", "BE"),
    19: ("Chouteau", "CH"), 20: ("Valley", "VA"), 21: ("Toole", "TO"),
    22: ("Big Horn", "BH"), 23: ("Musselshell", "MU"), 24: ("Blaine", "BL"),
    25: ("Madison", "MA"), 26: ("Pondera", "PO"), 27: ("Richland", "RI"),
    28: ("Powell", "PW"), 29: ("Rosebud", "RS"), 30: ("Deer Lodge", "DL"),
    31: ("Teton", "TE"), 32: ("Stillwater", "ST"), 33: ("Treasure", "TR"),
    34: ("Sheridan", "SH"), 35: ("Sanders", "SA"), 36: ("Judith Basin", "JB"),
    37: ("Daniels", "DA"), 38: ("Glacier", "GL"), 39: ("Fallon", "FA"),
    40: ("Sweet Grass", "SG"), 41: ("McCone", "MC"), 42: ("Carter", "CR"),
    43: ("Broadwater", "BR"), 44: ("Wheatland", "WH"), 45: ("Prairie", "PI"),
    46: ("Granite", "GR"), 47: ("Meagher", "ME"), 48: ("Liberty", "LI"),
    49: ("Park", "PA"), 50: ("Garfield", "GF"), 51: ("Jefferson", "JE"),
    52: ("Wibaux", "WI"), 53: ("Golden Valley", "GV"), 54: ("Mineral", "MI"),
    55: ("Petroleum", "PE"), 56: ("Lincoln", "LN"),
}


def county_name(code: int) -> str:
    rec = COUNTY_PREFIX.get(int(code)) if code is not None else None
    return rec[0] if rec else ""


@dataclass
class SourceInfo:
    """Resolved metadata about a vector source."""

    path: str
    crs: object
    feature_count: int
    columns: list[str]
    geometry_type: str
    resolved: dict[str, str | None] = field(default_factory=dict)
    missing_required: list[str] = field(default_factory=list)

    @property
    def is_projected_meters(self) -> bool:
        crs = self.crs
        try:
            if crs is None or crs.is_geographic:
                return False
            axis = crs.axis_info[0]
            unit = (getattr(axis, "unit_name", "") or "").lower()
            return unit in ("metre", "meter", "metres", "meters")
        except Exception:  # pragma: no cover - defensive
            return False

    def col(self, logical: str) -> str | None:
        """Return the actual column name for a logical field, or None."""
        return self.resolved.get(logical)

    def require(self, logical: str) -> str:
        name = self.resolved.get(logical)
        if name is None:
            raise KeyError(f"required logical field {logical!r} not found in {self.path}")
        return name


def resolve_columns(columns: list[str]) -> dict[str, str | None]:
    """Map each logical field to the first matching actual column (or None).

    Matching is case-insensitive so e.g. ``OWNERNAME`` resolves ``owner_name``.
    """
    lower = {c.lower(): c for c in columns}
    out: dict[str, str | None] = {}
    for logical, candidates in FIELD_ALIASES.items():
        actual = None
        for cand in candidates:
            if cand in columns:
                actual = cand
                break
            if cand.lower() in lower:
                actual = lower[cand.lower()]
                break
        out[logical] = actual
    return out


def inspect_source(path: str) -> SourceInfo:
    """Read header-level metadata for a vector source without loading geometry."""
    info = pyogrio.read_info(path)
    columns = list(info.get("fields", []))
    crs = None
    crs_raw = info.get("crs")
    if crs_raw:
        from pyproj import CRS

        crs = CRS.from_user_input(crs_raw)
    resolved = resolve_columns(columns)
    missing = [k for k in REQUIRED if resolved.get(k) is None]
    return SourceInfo(
        path=path,
        crs=crs,
        feature_count=int(info.get("features", 0)),
        columns=columns,
        geometry_type=str(info.get("geometry_type", "")),
        resolved=resolved,
        missing_required=missing,
    )


def report(info: SourceInfo) -> None:
    """Log a human-readable inspection report and warn on schema/CRS issues."""
    log.info("Source: %s", info.path)
    log.info("  geometry: %s | features: %s", info.geometry_type, f"{info.feature_count:,}")
    crs_name = info.crs.name if info.crs is not None else "UNKNOWN"
    log.info("  CRS: %s", crs_name)
    if not info.is_projected_meters:
        log.warning(
            "  CRS is not a projected/metre system; area in acres may be wrong. "
            "Provide a meter-based CRS or expect reprojection."
        )
    present = {k: v for k, v in info.resolved.items() if v}
    log.info("  resolved %d/%d logical fields", len(present), len(FIELD_ALIASES))
    unresolved = [k for k, v in info.resolved.items() if v is None]
    if unresolved:
        log.info("  unresolved (optional unless required): %s", ", ".join(unresolved))
    if info.missing_required:
        log.error("  MISSING REQUIRED fields: %s", ", ".join(info.missing_required))
