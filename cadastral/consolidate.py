"""Entity resolution: owner-code assignment, review queue, override loop.

Identity model
--------------
The conservative rule merges parcels **iff** they share the full normalized
identity key ``(name_norm, addr_norm, city_norm, state_norm, zip5)``.

Three stable identifiers are produced:

* ``StrictOwnerID`` -- deterministic hash of the identity key. Stable across
  runs and row order (unlike sequential numbering), and globally unique so it
  doubles as the statewide key before overrides.
* ``OwnerGroupID``  -- county-scoped final group after applying overrides.
* ``GlobalOwnerID`` -- statewide final group after applying overrides; lets an
  owner who holds land in several counties consolidate across them.

Ambiguous cases are never auto-merged; they are emitted to a review queue for
human adjudication, and the resulting ``owner_overrides.csv`` is applied on a
subsequent run.
"""

from __future__ import annotations

import hashlib
import logging

import numpy as np
import pandas as pd

from . import normalize

log = logging.getLogger("cadastral.consolidate")

IDENTITY_COLS = ["name_norm", "addr_norm", "city_norm", "state_norm", "zip5"]


def _hash_key(*parts: str) -> str:
    raw = "".join("" if p is None else str(p) for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def assign_strict_ids(df: pd.DataFrame) -> pd.DataFrame:
    """Add ``StrictOwnerID`` from a stable hash of the identity key.

    Blank-owner parcels (no name) are *not* merged with one another: each gets a
    per-parcel identity seeded with its parcel id, preserving the methodology's
    preference for errors of omission.
    """
    df = df.copy()
    for c in IDENTITY_COLS:
        if c not in df.columns:
            df[c] = ""
    keys = df[IDENTITY_COLS].fillna("").agg("".join, axis=1)

    # blank owners: make each parcel its own identity so they never collapse
    if "owner_blank" in df.columns and "_pid" in df.columns:
        blank = df["owner_blank"].fillna(False)
        keys = keys.where(~blank, "BLANK" + df["_pid"].astype(str))

    df["StrictOwnerID"] = keys.map(lambda k: _hash_key(k))
    return df


def build_review_queue(df: pd.DataFrame) -> pd.DataFrame:
    """Flag ambiguous identity situations for manual adjudication.

    Issue types (mirroring the methodology's CHECK / FALSE analysis):

    * ``same_name_diff_address`` -- one normalized name spanning >1 address
      (the doc's "matching owner name with multiple addresses"). An
      ``entity_hint`` marks business/agency/trust names that are *likely* the
      same legal owner (but are still kept separate under conservative rules).
    * ``same_address_diff_name`` -- one address spanning >1 name.
    * ``generic_address``        -- General Delivery / blank address used as a
      key; reviewer should confirm before any merge.

    Returns one row per (issue_type, StrictOwnerID) candidate with context.
    """
    rows: list[dict] = []
    work = df[~df.get("owner_blank", pd.Series(False, index=df.index)).fillna(False)]

    # same name, different address
    g = work.groupby("name_norm")
    for name, idx in g.groups.items():
        if not name:
            continue
        sub = work.loc[idx]
        addrs = sub[["addr_norm", "city_norm", "state_norm", "zip5"]].drop_duplicates()
        if len(addrs) > 1:
            entity = bool(sub["is_entity"].any())
            for sid, ssub in sub.groupby("StrictOwnerID"):
                a = ssub.iloc[0]
                rows.append({
                    "issue_type": "same_name_diff_address",
                    "StrictOwnerID": sid,
                    "name_norm": name,
                    "addr_norm": a["addr_norm"],
                    "city_norm": a["city_norm"],
                    "state_norm": a["state_norm"],
                    "zip5": a["zip5"],
                    "parcel_count": int(len(ssub)),
                    "n_variants": int(len(addrs)),
                    "entity_hint": "likely_same_entity" if entity else "",
                })

    # same address, different name
    work2 = work[~work["addr_generic"].fillna(False)]
    addr_key = work2[["addr_norm", "city_norm", "state_norm", "zip5"]].agg("|".join, axis=1)
    work2 = work2.assign(_akey=addr_key)
    for akey, sub in work2.groupby("_akey"):
        if not akey.strip("|"):
            continue
        names = sub["name_norm"].dropna().unique()
        if len(names) > 1:
            for sid, ssub in sub.groupby("StrictOwnerID"):
                a = ssub.iloc[0]
                rows.append({
                    "issue_type": "same_address_diff_name",
                    "StrictOwnerID": sid,
                    "name_norm": a["name_norm"],
                    "addr_norm": a["addr_norm"],
                    "city_norm": a["city_norm"],
                    "state_norm": a["state_norm"],
                    "zip5": a["zip5"],
                    "parcel_count": int(len(ssub)),
                    "n_variants": int(len(names)),
                    "entity_hint": "",
                })

    # generic / general-delivery addresses
    gen = work[work["addr_generic"].fillna(False)]
    for sid, ssub in gen.groupby("StrictOwnerID"):
        a = ssub.iloc[0]
        rows.append({
            "issue_type": "generic_address",
            "StrictOwnerID": sid,
            "name_norm": a["name_norm"],
            "addr_norm": a["addr_norm"],
            "city_norm": a["city_norm"],
            "state_norm": a["state_norm"],
            "zip5": a["zip5"],
            "parcel_count": int(len(ssub)),
            "n_variants": 1,
            "entity_hint": "",
        })

    cols = ["issue_type", "StrictOwnerID", "name_norm", "addr_norm", "city_norm",
            "state_norm", "zip5", "parcel_count", "n_variants", "entity_hint"]
    if not rows:
        return pd.DataFrame(columns=cols)
    out = pd.DataFrame(rows)[cols]
    return out.sort_values(["issue_type", "name_norm", "addr_norm"]).reset_index(drop=True)


def load_overrides(path: str | None) -> pd.DataFrame:
    """Load owner_overrides.csv (expanded schema, consumed by consolidate_orion).

    Columns: override_action, source_owner_id, target_owner_group_id, PartyID,
    PARCELID, PropertyID, CountyPrefix, TaxYear, reason, reviewer, review_date.
    Actions: merge, split, force_orion, force_heuristic, suppress_orion,
    exclude_from_consolidation. The legacy schema
    (source_owner_code/corrected_owner_group_id) is auto-migrated to merge rows.
    """
    if not path:
        return pd.DataFrame(columns=_OVERRIDE_COLS)
    df = pd.read_csv(path, dtype=str).fillna("")
    if "source_owner_code" in df.columns and "override_action" not in df.columns:
        df = df.rename(columns={"source_owner_code": "source_owner_id",
                                "corrected_owner_group_id": "target_owner_group_id"})
        df["override_action"] = "merge"
    for c in _OVERRIDE_COLS:
        if c not in df.columns:
            df[c] = ""
    log.info("  loaded %d override rows from %s", len(df), path)
    return df[_OVERRIDE_COLS]


def apply_overrides(df: pd.DataFrame, overrides: pd.DataFrame) -> pd.DataFrame:
    """Resolve final ``GlobalOwnerID`` (and county ``OwnerGroupID``).

    Without overrides, both default to ``StrictOwnerID`` / its county scoping.
    Overrides remap every member ``StrictOwnerID`` to the corrected group.
    """
    df = df.copy()
    mapping: dict[str, str] = {}
    if overrides is not None and len(overrides):
        for _, r in overrides.iterrows():
            src = str(r["source_owner_code"]).strip()
            grp = str(r["corrected_owner_group_id"]).strip()
            if src and grp:
                mapping[src] = grp
    df["GlobalOwnerID"] = df["StrictOwnerID"].map(lambda s: mapping.get(s, s))

    # county-scoped final group id (county prefix + global id)
    if "_county" in df.columns:
        df["OwnerGroupID"] = (
            df["_county"].astype(str).str.zfill(2) + "-" + df["GlobalOwnerID"]
        )
    else:
        df["OwnerGroupID"] = df["GlobalOwnerID"]
    return df


# ===========================================================================
# ORION-augmented consolidation
# ===========================================================================
# ORION strictly *augments* the MVP grouping: the shapefile (name+address) key
# is always an edge, so consolidation can only grow, never split (regression-safe
# vs the MVP). ORION adds two more edge types -- shared PartyID (a DOR
# owner-record; high confidence) and shared canonical (DOR-standard) name+address.
# PartyID is NOT used as the identity itself because it is per owner-record, not a
# deduplicated entity (the same name recurs under many PartyIDs).

_OVERRIDE_COLS = ["override_action", "source_owner_id", "target_owner_group_id",
                  "PartyID", "PARCELID", "PropertyID", "CountyPrefix", "TaxYear",
                  "reason", "reviewer", "review_date"]


class _UF:
    """Tiny union-find over integer positions."""

    def __init__(self, n: int):
        self.p = list(range(n))

    def find(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def _union_by_key(uf: _UF, keys: pd.Series, mask: pd.Series | None = None) -> None:
    """Union all positions that share a non-empty key (optionally within mask)."""
    s = keys.reset_index(drop=True)
    if mask is not None:
        m = mask.reset_index(drop=True).fillna(False).to_numpy()
    else:
        m = np.ones(len(s), dtype=bool)
    buckets: dict[object, int] = {}
    for pos, (k, ok) in enumerate(zip(s, m)):
        if not ok or k is None or (isinstance(k, float) and pd.isna(k)) or k == "":
            continue
        if k in buckets:
            uf.union(buckets[k], pos)
        else:
            buckets[k] = pos


def add_canonical_norms(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize ORION canonical name/address into comparison keys."""
    df = df.copy()
    if "canonical_name" in df.columns:
        df["canon_name_norm"] = normalize.normalize_name(df["canonical_name"].fillna(""))
    else:
        df["canon_name_norm"] = ""
    if "canonical_addr_full" in df.columns:
        df["canon_addr_norm"] = normalize.normalize_address([df["canonical_addr_full"].fillna("")])
    else:
        df["canon_addr_norm"] = ""
    return df


def _match_override_rows(df: pd.DataFrame, row: pd.Series) -> pd.Series:
    """Boolean mask of parcels an override row targets (most specific wins)."""
    def _numkey(s):  # normalize float/int/str ids to a clean integer string
        return pd.to_numeric(s, errors="coerce").astype("Int64").astype(str)

    mask = pd.Series(True, index=df.index)
    matched_any = False
    # string id columns
    val = str(row.get("PARCELID", "") or "").strip()
    if val and "_pid" in df.columns:
        mask &= df["_pid"].astype(str) == val
        matched_any = True
    # numeric id columns (coerce both sides to avoid 1158605.0 vs 1158605)
    for col in ("PropertyID", "PartyID"):
        val = str(row.get(col, "") or "").strip()
        if val and col in df.columns:
            mask &= _numkey(df[col]) == _numkey(pd.Series([val]))[0]
            matched_any = True
    src = str(row.get("source_owner_id", "") or "").strip()
    if src:
        hit = pd.Series(False, index=df.index)
        if "StrictOwnerID" in df.columns:
            hit |= df["StrictOwnerID"].astype(str) == src
        if "PartyID" in df.columns:
            hit |= _numkey(df["PartyID"]) == _numkey(pd.Series([src]))[0]
        mask &= hit
        matched_any = True
    return mask if matched_any else pd.Series(False, index=df.index)


def consolidate_orion(df: pd.DataFrame, overrides: pd.DataFrame | None = None,
                      use_orion: bool = True):
    """Assign GlobalOwnerID by union-find over shapefile / PartyID / canonical
    edges, honoring expanded overrides. Returns (df, autoresolved_report)."""
    df = df.copy().reset_index(drop=True)
    n = len(df)
    if "StrictOwnerID" not in df.columns:
        df = assign_strict_ids(df)
    if use_orion:
        df = add_canonical_norms(df)

    # per-row override flags
    suppress_orion = pd.Series(False, index=df.index)
    exclude = pd.Series(False, index=df.index)
    merge_target = pd.Series("", index=df.index, dtype=object)
    if overrides is not None and len(overrides):
        for _, r in overrides.iterrows():
            action = str(r.get("override_action", "") or "").strip().lower()
            m = _match_override_rows(df, r)
            if not m.any():
                continue
            if action in ("suppress_orion", "force_heuristic"):
                suppress_orion |= m
            elif action == "exclude_from_consolidation":
                exclude |= m
            elif action in ("merge", "force_orion", "split"):
                tgt = str(r.get("target_owner_group_id", "") or "").strip()
                if tgt:
                    merge_target[m] = tgt
                if action == "split":   # split: isolate, then merge re-groups via tgt
                    exclude |= m & (merge_target == "")

    uf = _UF(n)
    not_blank = ~df.get("owner_blank", pd.Series(False, index=df.index)).fillna(False)
    active = not_blank & ~exclude

    # edge 1: shapefile MVP identity (always) -> guarantees >= MVP grouping
    _union_by_key(uf, df["StrictOwnerID"], active)
    if use_orion:
        orion_ok = active & ~suppress_orion
        # edge 2: shared PartyID (DOR owner-record; high confidence)
        _union_by_key(uf, df.get("PartyID"), orion_ok)
        # edge 3: shared canonical name+address
        canon_key = (df["canon_name_norm"].fillna("") + "||" + df["canon_addr_norm"].fillna(""))
        canon_key = canon_key.where(df["canon_name_norm"].fillna("") != "", "")
        _union_by_key(uf, canon_key, orion_ok)
    # edge 4: explicit merge overrides
    _union_by_key(uf, merge_target, merge_target != "")

    roots = np.array([uf.find(i) for i in range(n)])

    # stable GlobalOwnerID = hash of sorted member StrictOwnerIDs per component
    df["_root"] = roots
    comp_gid: dict[int, str] = {}
    auto_rows = []
    for root, grp in df.groupby("_root"):
        sids = sorted(grp["StrictOwnerID"].unique())
        gid = "G" + _hash_key("|".join(sids))
        comp_gid[root] = gid
        if use_orion and len(sids) > 1:  # ORION/override bridged distinct MVP groups
            auto_rows.append({
                "GlobalOwnerID": gid,
                "n_merged_strict_ids": len(sids),
                "names": " | ".join(sorted(set(grp.get("canonical_name",
                          grp.get("name_norm", pd.Series([], dtype=str))).fillna("").astype(str)))[:6]),
                "partyids": " | ".join(sorted(set(grp.get("PartyID", pd.Series([], dtype=str))
                          .dropna().astype(str)))[:8]),
                "parcel_count": int(len(grp)),
            })

    # blank / excluded parcels: each its own owner (errors of omission)
    singleton = (~active)
    gid_series = df["_root"].map(comp_gid)
    gid_series[singleton] = "G" + df.loc[singleton, "StrictOwnerID"].astype(str)
    df["GlobalOwnerID"] = gid_series

    if "_county" in df.columns:
        df["OwnerGroupID"] = df["_county"].astype(str).str.zfill(2) + "-" + df["GlobalOwnerID"]
    else:
        df["OwnerGroupID"] = df["GlobalOwnerID"]
    df = df.drop(columns=["_root"])

    auto = pd.DataFrame(auto_rows) if auto_rows else pd.DataFrame(
        columns=["GlobalOwnerID", "n_merged_strict_ids", "names", "partyids", "parcel_count"])
    if use_orion:
        log.info("  ORION/override bridged %d multi-id owner groups", len(auto))
    return df, auto


def assign_human_codes(df: pd.DataFrame, id_col: str, code_col: str,
                       reserve_blank: bool = True) -> pd.DataFrame:
    """Attach a stable, human-friendly 9-digit sequential code per owner id.

    Codes are assigned in sorted-id order so they are reproducible. ``000000000``
    is reserved (per the methodology) when ``reserve_blank``.
    """
    df = df.copy()
    uniq = sorted(df[id_col].dropna().unique())
    start = 1 if reserve_blank else 0
    codes = {uid: f"{i + start:09d}" for i, uid in enumerate(uniq)}
    df[code_col] = df[id_col].map(codes)
    return df
