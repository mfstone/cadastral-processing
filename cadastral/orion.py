"""ORION ownership resolution from the Parquet cache produced by ``orion_etl.py``.

Data-shape facts (measured on the 2026 statewide DB, RefreshDate 2026-06-24):
- ``Owner`` has ~one row per (PropertyID, TaxYear); ``PrimaryOwner`` is True for
  all rows and multi-party properties are negligible -> PartyID per property.
- **PartyID is per owner-record, NOT a deduplicated legal entity.** The same name
  recurs under many PartyIDs (e.g. 149 "PV RANCH" parcels span 9 PartyIDs). So
  PartyID is used as a high-confidence *bridge* signal (parcels sharing a PartyID
  are definitely the same owner) and as the source of an *authoritative canonical
  name/address*, but never as the consolidation identity by itself.
- Co-owners are stored as additional ``PartyName`` rows (NameType "L Additional
  Legal Owners") under the same PartyID, not as extra ``Owner`` rows.

This module loads the cache, builds a per-PartyID profile (canonical name/address
+ all variants retained, never name x address cross-product), and resolves each
parcel to a PartyID with graded provenance.
"""

from __future__ import annotations

import json
import logging
import os

import pandas as pd

from . import normalize

log = logging.getLogger("cadastral.orion")

_ADDL_OWNER = "Additional Legal Owners"


class OrionCache:
    """Lazy reader over the orion_cache/*.parquet files."""

    def __init__(self, cache_dir: str):
        self.dir = cache_dir
        self._f: dict[str, pd.DataFrame] = {}
        self._profile: pd.DataFrame | None = None

    def _load(self, name: str, columns=None) -> pd.DataFrame:
        if name not in self._f:
            path = os.path.join(self.dir, f"{name}.parquet")
            self._f[name] = pd.read_parquet(path, columns=columns)
        return self._f[name]

    @property
    def refresh_date(self):
        try:
            return pd.read_parquet(os.path.join(self.dir, "systeminfo.parquet")).iloc[0, 0]
        except Exception:
            return None

    def owner(self):
        return self._load("owner")

    def property(self):
        return self._load("property")

    def partyname(self):
        return self._load("partyname")

    def partyaddr(self):
        return self._load("partyaddr")

    def deed(self):
        return self._load("deed")

    # -- per-PartyID canonical profile -------------------------------------
    def party_profile(self, party_ids=None) -> pd.DataFrame:
        """Build canonical profiles, optionally only for ``party_ids``.

        Filtering to the PartyIDs a county actually matched keeps this fast
        (a few thousand groups instead of ~800k).
        """
        if party_ids is None and self._profile is not None:
            return self._profile
        nm = self.partyname()
        ad = self.partyaddr()
        if party_ids is not None:
            ids = pd.Index(pd.unique(pd.Series(list(party_ids)).dropna()))
            nm = nm[nm["PartyID"].isin(ids)]
            ad = ad[ad["PartyID"].isin(ids)]

        # canonical name: prefer DefaultName==True; else first
        nm = nm.copy()
        nm["_def"] = nm["DefaultName"].fillna(False).astype(bool)
        nm_sorted = nm.sort_values(["PartyID", "_def"], ascending=[True, False])
        canon_name = nm_sorted.groupby("PartyID").first()["FullName"]

        names_grp = nm.groupby("PartyID")
        all_names = names_grp["FullName"].agg(
            lambda s: json.dumps(s.dropna().astype(str).tolist()))
        name_count = names_grp.size()
        desc = nm["NameType_Desc"].fillna("")
        has_alias = nm.assign(_a=desc.str.contains("AKA|FKA|Also Known|Formerly", case=False)) \
                      .groupby("PartyID")["_a"].any()
        coowners = nm[desc.str.contains(_ADDL_OWNER, case=False)] \
            .groupby("PartyID")["FullName"].agg(
                lambda s: json.dumps(s.dropna().astype(str).tolist()))

        # canonical address: prefer DefaultAddress==True
        ad = ad.copy()
        ad["_def"] = ad["DefaultAddress"].fillna(False).astype(bool)
        for c in ("Address1", "Address2", "Address3", "City", "State", "ZIP"):
            if c not in ad.columns:
                ad[c] = ""
        ad_sorted = ad.sort_values(["PartyID", "_def"], ascending=[True, False])
        canon_addr_rows = ad_sorted.groupby("PartyID").first()
        addr_count = ad.groupby("PartyID").size()

        prof = pd.DataFrame({"canonical_name": canon_name})
        prof["canonical_name_rule"] = "DefaultName"
        prof = prof.join(canon_addr_rows[["Address1", "Address2", "Address3",
                                          "City", "State", "ZIP"]], how="left")
        prof["canonical_address_rule"] = "DefaultAddress"
        prof["all_names_json"] = all_names
        prof["name_count"] = name_count
        prof["address_count"] = addr_count.reindex(prof.index)
        prof["has_aliases"] = has_alias.reindex(prof.index).fillna(False)
        prof["has_multiple_addresses"] = (prof["address_count"].fillna(0) > 1)
        prof["coowner_names_json"] = coowners.reindex(prof.index)
        if party_ids is None:
            self._profile = prof
        return prof


def _norm_one(series: pd.Series) -> pd.Series:
    return normalize.normalize_name(series)


def resolve_parcels(parcels: pd.DataFrame, cache: OrionCache,
                    name_col: str, tax_year_policy: str = "match") -> pd.DataFrame:
    """Resolve each parcel to an ORION PartyID + canonical owner + provenance.

    ``parcels`` must carry ``_pid`` (PARCELID str), ``PropertyID`` (int),
    ``TaxYear`` (int), and the shapefile owner name column ``name_col``.
    Returns a frame aligned to ``parcels.index`` with ORION columns.
    """
    refresh = cache.refresh_date
    owner = cache.owner()[["PropertyID", "TaxYear", "PartyID", "PercentOwnership"]]
    prop = cache.property()[["PropertyID", "TaxYear", "GeoCodeSearch"]]

    p = parcels[["PropertyID", "TaxYear"]].copy()
    p["PropertyID"] = pd.to_numeric(p["PropertyID"], errors="coerce").astype("Int64")
    p["TaxYear"] = pd.to_numeric(p["TaxYear"], errors="coerce").astype("Int64")
    p["_geo"] = parcels["_pid"].astype(str)
    p["orig_idx"] = parcels.index

    owner_i = owner.astype({"PropertyID": "Int64", "TaxYear": "Int64"})

    # 1) PropertyID + TaxYear (same year)
    m = p.merge(owner_i, on=["PropertyID", "TaxYear"], how="left")
    m["orion_match_method"] = m["PartyID"].notna().map(
        {True: "propertyid_taxyear", False: ""})
    m["orion_tax_year_used"] = m["TaxYear"].where(m["PartyID"].notna())

    # 2) geocode + TaxYear (same year) for the still-unmatched
    miss = m["PartyID"].isna()
    if miss.any():
        prop_i = prop.astype({"PropertyID": "Int64", "TaxYear": "Int64"})
        geo = (m.loc[miss, ["_geo", "TaxYear", "orig_idx"]]
               .merge(prop_i.rename(columns={"GeoCodeSearch": "_geo"}),
                      on=["_geo", "TaxYear"], how="left")
               .merge(owner_i, on=["PropertyID", "TaxYear"], how="left", suffixes=("", "_o")))
        got = geo.dropna(subset=["PartyID"]).drop_duplicates("orig_idx").set_index("orig_idx")
        idx = m.index[miss]
        sel = m.loc[idx, "orig_idx"].map(got["PartyID"])
        hit = sel.notna()
        m.loc[idx[hit.values], "PartyID"] = sel[hit].values
        m.loc[idx[hit.values], "PercentOwnership"] = \
            m.loc[idx, "orig_idx"].map(got["PercentOwnership"])[hit].values
        m.loc[idx[hit.values], "orion_match_method"] = "geocodesearch_taxyear"
        m.loc[idx[hit.values], "orion_tax_year_used"] = m.loc[idx[hit.values], "TaxYear"]

    # 3) PropertyID latest available year for the still-unmatched
    miss = m["PartyID"].isna()
    if miss.any() and tax_year_policy != "same_only":
        latest = (owner_i.sort_values("TaxYear")
                  .dropna(subset=["PartyID"]).groupby("PropertyID").last())
        idx = m.index[miss]
        ly = m.loc[idx, "PropertyID"].map(latest["PartyID"])
        hit = ly.notna()
        m.loc[idx[hit.values], "PartyID"] = ly[hit].values
        m.loc[idx[hit.values], "PercentOwnership"] = \
            m.loc[idx, "PropertyID"].map(latest["PercentOwnership"])[hit].values
        m.loc[idx[hit.values], "orion_match_method"] = "propertyid_latest"
        m.loc[idx[hit.values], "orion_tax_year_used"] = \
            m.loc[idx, "PropertyID"].map(latest["TaxYear"])[hit].values

    m["orion_match_method"] = m["orion_match_method"].replace("", "unmatched")
    m["tax_year_delta"] = (m["TaxYear"] - m["orion_tax_year_used"]).astype("Int64")

    # attach canonical name/address from per-PartyID profile (matched ids only)
    prof = cache.party_profile(party_ids=m["PartyID"].dropna().unique())
    j = m.join(prof, on="PartyID")
    addr_parts = (j[["Address1", "Address2", "Address3"]].fillna("")
                  .agg(" ".join, axis=1).str.strip())
    j["canonical_addr_full"] = (
        addr_parts + " " + j["City"].fillna("") + " " + j["State"].fillna("")
        + " " + j["ZIP"].fillna("").astype(str)).str.replace(r"\s+", " ", regex=True).str.strip()

    # agreement vs the shapefile-reported owner name (for verifying latest matches)
    sf_name_norm = _norm_one(parcels[name_col]).reindex(m["orig_idx"]).values
    can_name_norm = _norm_one(j["canonical_name"].fillna(""))
    j["orion_name_matches_parcel_name"] = (can_name_norm.values == sf_name_norm)

    # graded provenance
    same = j["orion_match_method"].isin(["propertyid_taxyear", "geocodesearch_taxyear"])
    latest = j["orion_match_method"] == "propertyid_latest"
    src = pd.Series("unmatched", index=j.index)
    src[same] = "orion_same_tax_year"
    src[latest & j["orion_name_matches_parcel_name"]] = "orion_latest_verified"
    src[latest & ~j["orion_name_matches_parcel_name"]] = "orion_historical_only"
    j["owner_source"] = src.values
    conf = pd.Series("none", index=j.index)
    conf[same] = "high"
    conf[src == "orion_latest_verified"] = "medium"
    conf[src == "orion_historical_only"] = "low"
    j["owner_source_confidence"] = conf.values
    j["orion_refresh_date"] = refresh

    out_cols = ["PartyID", "PercentOwnership", "orion_match_method",
                "orion_tax_year_used", "tax_year_delta", "orion_refresh_date",
                "canonical_name", "canonical_addr_full", "canonical_name_rule",
                "canonical_address_rule", "all_names_json", "coowner_names_json",
                "name_count", "address_count", "has_aliases",
                "has_multiple_addresses", "orion_name_matches_parcel_name",
                "owner_source", "owner_source_confidence"]
    res = j.set_index("orig_idx")[out_cols].reindex(parcels.index)
    n_match = int((res["owner_source"] != "unmatched").sum())
    log.info("  ORION matched %s/%s parcels (%.1f%%); refresh=%s",
             f"{n_match:,}", f"{len(parcels):,}", n_match / max(len(parcels), 1) * 100,
             refresh)
    return res


# --- deeds -----------------------------------------------------------------
def load_deed_events(cache: OrionCache, property_ids) -> pd.DataFrame:
    """Raw deed events for the given PropertyIDs (no classification)."""
    d = cache.deed()
    ids = set(int(x) for x in pd.Series(list(property_ids)).dropna().astype("int64"))
    d = d[d["PropertyID"].astype("int64").isin(ids)].copy()
    return d


def classify_deeds(deeds: pd.DataFrame, crosswalk: pd.DataFrame | None):
    """Join an editable DocType->transfer_class crosswalk; mark transfers.

    Returns (deed_events, probable_transfers, latest_transfer, owner_tenure).
    Without a crosswalk, every dated deed counts as a probable transfer.
    """
    d = deeds.copy()
    d["DeedDate"] = pd.to_datetime(d["DeedDate"], errors="coerce")

    def _doctype_key(s):  # normalize float/str/int DocType to a clean integer string
        return pd.to_numeric(s, errors="coerce").astype("Int64").astype(str)

    if crosswalk is not None and len(crosswalk):
        cw = crosswalk.copy()
        cw["_dt"] = _doctype_key(cw["DocType"])
        d["_dt"] = _doctype_key(d["DocType"])
        d = d.merge(cw[["_dt", "transfer_class", "include_for_tenure"]],
                    on="_dt", how="left").drop(columns="_dt")
        inc = d["include_for_tenure"].astype(str).str.lower().isin(["1", "true", "yes", "y"])
    else:
        d["transfer_class"] = "unclassified"
        inc = d["DeedDate"].notna()
    transfers = d[inc & d["DeedDate"].notna()].copy()
    latest = (transfers.sort_values("DeedDate").groupby("PropertyID").last()
              .reset_index()[["PropertyID", "DeedDate", "DocType", "DocType_Desc"]]
              .rename(columns={"DeedDate": "latest_transfer_date",
                               "DocType": "latest_transfer_doctype",
                               "DocType_Desc": "latest_transfer_doctype_desc"}))
    today = pd.Timestamp.now().normalize()
    latest["tenure_years"] = ((today - latest["latest_transfer_date"]).dt.days / 365.25).round(1)
    return d, transfers, latest


def load_doctype_crosswalk(path: str | None) -> pd.DataFrame | None:
    if not path or not os.path.exists(path):
        return None
    return pd.read_csv(path, dtype=str)
