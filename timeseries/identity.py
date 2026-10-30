"""Stage 8: owner identity per snapshot -- the document's consolidation rule,
with every judgment it leaves to a human carried as a flag.

The rule comes from the online supplement to Haggerty, Epstein, Gosnell, Rose
& Stone (2022), *Society & Natural Resources* 35(6) -- the "Montana Cadastral
Parcel Consolidation Methodology" in ``docs/reference``. Read literally, its
identity is the **mailing address**: every unique address gets a code, and an
owner unit is everything mailed to one address. Names are the *check*, not the
key. ``CombMatch`` is FALSE only where the same name appears at different
addresses, and the resolution table says what to do with those: a company,
trust or married couple at several addresses is one entity and is merged; a
single individual's name at several addresses "may be two different people"
and needs evidence from the ORION party table or a deed. General Delivery
addresses are checked rather than merged, and a token test (first two name
components equal, codes different) catches spelling variants for review.

Three tiers are produced so that no published number has to pretend the manual
step happened:

* ``strict``   -- name AND address identical. The floor; what
                  ``cadastral/consolidate.py`` calls ``StrictOwnerID``.
* ``document`` -- the rule above, automated as far as it can honestly go:
                  address-keyed, name bridges for entities and couples, name
                  fallback where the address cannot key an owner. **This is the
                  tier every statistic is computed on.**
* ``maximal``  -- document tier plus every pending flag accepted, scoped to the
                  county (the paper's unit). Not a claim about ownership; the
                  upper bound a reviewer could reach, so a holding can be shown
                  as a range.

One deliberate departure, recorded because it is a choice. Addresses that host
many unrelated names -- a law firm, a registered agent, a property manager --
are exactly where an address key manufactures a fake mega-owner (the earlier
Gallatin script produced a 12,580-parcel "owner" this way). An address with
more than :data:`HUB_MAX_NAMES` distinct names is therefore keyed as
(name, address) rather than address alone, and flagged ``hub_address``; the
document's manual pass would have had to resolve these one by one. Everything
else follows the document.

For the vintages the ORION cache covers (2024-2026), parcels sharing a DOR
PartyID are joined too: that is the evidence the document tells a reviewer to
fetch, applied automatically and marked ``orion_bridged``.

Outputs, under ``data/identity``:

* ``owners_<date>.parquet``  -- one row per parcel: tier ids, flags, provenance
* ``groups_<date>.parquet``  -- one row per document-tier group: size, names,
                                review status, pending links
"""

from __future__ import annotations

import hashlib
import json
import logging
import os

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

log = logging.getLogger("timeseries.identity")

SNAP_DIR = "data/snapshots"
OUT_DIR = "data/identity"

# An address hosting more distinct owner names than HUB_FLAG_NAMES is flagged for
# review (the Gallatin script's MANY_NAMES_SAME_ADDRESS threshold). Above
# HUB_SPLIT_NAMES it is treated as a mail drop rather than an owner and keyed
# by (name, address). Measured on 2018-01-10: 7,045 addresses carry more than 3
# names, the median of them carries 4 and three quarters carry 5 or fewer --
# a family's post-office box, which the document merges. Splitting at 3 keyed
# 15.6% of private parcels by name and under-merged against Table 1.
HUB_FLAG_NAMES = 3
HUB_SPLIT_NAMES = 5
# Token-check groups larger than this are flagged but do not contribute edges
# to the maximal tier: "SMITH JOHN" across a whole county is a review list, not
# a plausible single owner, and a bound built from it would be meaningless.
TOKEN_EDGE_MAX_KEYS = 10

# Per-parcel flag bits. Pending flags (a reviewer must decide) are the first
# group; provenance flags (how the row was merged) the second.
F_SAME_NAME_DIFF_ADDR = 1      # individual's name at >1 address, NOT merged
F_TOKEN_CHECK = 2              # first two name tokens match another group
F_GENERAL_DELIVERY = 4         # keyed by name because the address is GD
F_HUB_ADDRESS = 8              # address hosts > HUB_MAX_NAMES names
F_BLANK_ADDRESS = 16           # keyed by name because the address is blank
F_CARE_OF = 32                 # line 1 is a mail-to instruction
F_BLANK_OWNER = 64             # no owner name on the record
F_ENTITY_BRIDGE = 128          # merged across addresses by a company/trust name
F_COUPLE_BRIDGE = 256          # merged across addresses by a multi-party name
F_OVERRIDE_MERGE = 512         # merged by owner_overrides.csv
F_ORION_BRIDGE = 2048          # merged because parcels share a DOR PartyID (ORION)
F_REVIEWED_KEPT = 4096         # a reviewer looked and kept it separate (owner_overrides.csv keep)
PENDING_MASK = F_SAME_NAME_DIFF_ADDR | F_TOKEN_CHECK | F_GENERAL_DELIVERY | F_HUB_ADDRESS

# ORION (DOR CAMA) ships one owner record per property-year; parcels sharing a
# PartyID are the same owner record, which is the evidence the document sends a
# reviewer to fetch ("Property Party Query from ORION Database"). The cache
# covers tax years 2024-2026 and joins the parcel geocode at 99.5-99.7%.
ORION_TAXYEAR = {"2024-12-31": 2024, "2025-12-31": 2025, "2026-09-04": 2026}

# Token-only pending flags are a weaker review signal than a shared individual
# name, a General Delivery key or a crowded address, so they get their own
# status rather than swelling "flagged".
REVIEW_STATUS = ["clean", "auto_entity", "token_check", "flagged", "reviewed_merged", "orion_bridged",
                 "reviewed_kept"]
STRONG_PENDING = F_SAME_NAME_DIFF_ADDR | F_GENERAL_DELIVERY | F_HUB_ADDRESS
MERGED_BY = ["single", "address", "entity_name", "couple_name", "override"]

OWNER_COLS = ["parcel_id", "county_n", "acres", "owner_name_norm", "owner_blank",
              "owner_is_entity", "n_names_on_record", "owner_city", "owner_state",
              "owner_zip5", "owner_addr_norm", "owner_addr_generic", "owner_addr_careof"]


def _h64(s: pd.Series) -> np.ndarray:
    return pd.util.hash_pandas_object(s.fillna("").astype(str), index=False).to_numpy(dtype="uint64")


def _components(n: int, edges: list[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    """Connected-component label per node over the union of edge lists."""
    if not edges:
        return np.arange(n, dtype="int32")
    rows = np.concatenate([a for a, _ in edges]) if edges else np.array([], dtype="int64")
    cols = np.concatenate([b for _, b in edges]) if edges else np.array([], dtype="int64")
    if len(rows) == 0:
        return np.arange(n, dtype="int32")
    m = coo_matrix((np.ones(len(rows), dtype="int8"), (rows, cols)), shape=(n, n))
    _, labels = connected_components(m, directed=False)
    return labels.astype("int32")


def _star_edges(group_of: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """Edges joining every node that shares a value of *group_of* (a star per value)."""
    g = group_of.reset_index(drop=True)
    # Vectorised star: connect each node to the first node carrying the same value.
    order = np.argsort(g.to_numpy(), kind="stable")
    vals = g.to_numpy()[order]
    starts = np.r_[True, vals[1:] != vals[:-1]]
    head_idx = order[np.maximum.accumulate(np.where(starts, np.arange(len(vals)), 0))]
    a = order[~starts]
    b = head_idx[~starts]
    return a.astype("int64"), b.astype("int64")


def load_overrides(path: str | None) -> pd.DataFrame:
    """Accept the expanded owner_overrides.csv of ``cadastral/consolidate.py``.

    ``merge`` rows join every ``source_owner_id`` sharing one
    ``target_owner_group_id``; ``keep`` rows record that a reviewer looked at
    the id and kept it separate, which clears its pending flags from the
    maximal tier and marks it ``reviewed_kept``. Ids may be a strict id, a
    base-key id or a document group hash (all are published in
    ``owners_<date>`` / ``groups_<date>``)."""
    if not path or not os.path.exists(path):
        return pd.DataFrame(columns=["override_action", "source_owner_id", "target_owner_group_id"])
    df = pd.read_csv(path, dtype=str).fillna("")
    if "source_owner_code" in df.columns and "override_action" not in df.columns:
        df = df.rename(columns={"source_owner_code": "source_owner_id",
                                "corrected_owner_group_id": "target_owner_group_id"})
        df["override_action"] = "merge"
    for c in ("override_action", "source_owner_id", "target_owner_group_id"):
        if c not in df.columns:
            df[c] = ""
    return df


def orion_party_map(date: str, cache_dir: str | None) -> pd.Series | None:
    """parcel_id -> PartyID for a snapshot the ORION cache covers, else None."""
    if not cache_dir or date not in ORION_TAXYEAR:
        return None
    pp = os.path.join(cache_dir, "property.parquet")
    op = os.path.join(cache_dir, "owner.parquet")
    if not (os.path.exists(pp) and os.path.exists(op)):
        return None
    ty = ORION_TAXYEAR[date]
    pr = pd.read_parquet(pp, columns=["PropertyID", "TaxYear", "GeoCodeSearch"])
    pr = pr[pr["TaxYear"] == ty]
    ow = pd.read_parquet(op, columns=["PropertyID", "TaxYear", "PartyID"])
    ow = ow[ow["TaxYear"] == ty].drop_duplicates("PropertyID")
    j = pr.merge(ow, on="PropertyID", how="inner")
    j["parcel_id"] = j["GeoCodeSearch"].astype(str)
    j = j.drop_duplicates("parcel_id")
    return j.set_index("parcel_id")["PartyID"]


def resolve(df: pd.DataFrame, overrides: pd.DataFrame | None = None,
            party: pd.Series | None = None) -> tuple[pd.DataFrame, dict]:
    """Assign the three tiers and the flags to one snapshot's parcels.

    Returns the per-parcel frame and a QA dict. ``df`` must carry
    :data:`OWNER_COLS`. ``party`` (parcel_id -> PartyID) adds the ORION edge.
    """
    d = df[OWNER_COLS].copy().reset_index(drop=True)
    n = len(d)
    qa: dict = {"parcels": int(n)}

    name = d["owner_name_norm"].fillna("").astype(str)
    blank_name = d["owner_blank"].fillna(False).to_numpy(dtype=bool) | (name == "").to_numpy()
    addr = d["owner_addr_norm"].fillna("").astype(str)
    generic = d["owner_addr_generic"].fillna(False).to_numpy(dtype=bool)
    gd = generic & (addr != "").to_numpy()
    blank_addr = generic & (addr == "").to_numpy()
    careof = d["owner_addr_careof"].fillna(False).to_numpy(dtype=bool)
    loc = (d["owner_city"].fillna("") + "|" + d["owner_state"].fillna("") + "|"
           + d["owner_zip5"].fillna("")).astype(str)
    addr_key = addr + "|" + loc
    name_key = name + "|" + loc

    # --- strict tier: name AND address (the floor) --------------------------
    strict_key = name + "||" + addr_key
    strict_key = strict_key.where(~blank_name, "P|" + d["parcel_id"].astype(str))
    d["strict_id"] = _h64(strict_key)

    # --- hub addresses -------------------------------------------------------
    usable_addr = ~generic
    names_at_addr = (pd.Series(name[usable_addr & ~blank_name].to_numpy())
                     .groupby(addr_key[usable_addr & ~blank_name].to_numpy()).nunique())
    hub_addrs = set(names_at_addr[names_at_addr > HUB_SPLIT_NAMES].index)
    many_addrs = set(names_at_addr[names_at_addr > HUB_FLAG_NAMES].index)
    is_hub = addr_key.isin(hub_addrs).to_numpy() & usable_addr
    is_many = addr_key.isin(many_addrs).to_numpy() & usable_addr
    qa["hub_addresses_split"] = int(len(hub_addrs))
    qa["hub_addresses_flagged"] = int(len(many_addrs))
    qa["parcels_at_split_hubs"] = int(is_hub.sum())
    qa["parcels_at_flagged_hubs"] = int(is_many.sum())

    # --- document tier base key ----------------------------------------------
    base = pd.Series("A|" + addr_key, dtype="object")
    base[is_hub] = "H|" + name[is_hub] + "|" + addr_key[is_hub]
    fallback = generic & ~blank_name
    base[fallback] = "N|" + name_key[fallback]
    singleton = generic & blank_name
    base[singleton] = "P|" + d.loc[singleton, "parcel_id"].astype(str)
    d["base_key"] = base
    d["base_id"] = _h64(base)

    flags = np.zeros(n, dtype="int16")
    flags[gd] |= F_GENERAL_DELIVERY
    flags[blank_addr & ~blank_name] |= F_BLANK_ADDRESS
    flags[is_many] |= F_HUB_ADDRESS
    flags[careof] |= F_CARE_OF
    flags[blank_name] |= F_BLANK_OWNER

    # node index per base key
    codes, uniques = pd.factorize(base, sort=False)
    n_nodes = len(uniques)
    qa["base_keys"] = int(n_nodes)
    node_of_parcel = codes.astype("int64")

    # --- name bridges (document tier) ---------------------------------------
    # A name appearing under more than one base key is the document's FALSE
    # case. Entities and multi-party names merge; a lone individual's name is
    # a pending flag only.
    entity = d["owner_is_entity"].fillna(False).to_numpy(dtype=bool)
    couple = (d["n_names_on_record"].fillna(0).to_numpy() >= 2) & ~entity
    mergeable = (entity | couple) & ~blank_name
    pairs = pd.DataFrame({"name": name, "node": node_of_parcel, "county": d["county_n"].to_numpy(),
                          "entity": entity, "couple": couple, "blank": blank_name}).drop_duplicates(["name", "node"])
    multi = pairs[~pairs["blank"]].groupby("name")["node"].transform("nunique") > 1
    multi_pairs = pairs[~pairs["blank"]][multi]
    doc_edges = []
    merged_by = np.zeros(n, dtype="int8")          # 0 single/none yet
    bridge_flags = np.zeros(n_nodes, dtype="int16")
    if len(multi_pairs):
        mp = multi_pairs[multi_pairs["entity"] | multi_pairs["couple"]]
        if len(mp):
            a, b = _star_edges(mp["name"].reset_index(drop=True))
            nodes = mp["node"].to_numpy()
            doc_edges.append((nodes[a], nodes[b]))
            ent_nodes = mp.loc[mp["entity"], "node"].unique()
            cpl_nodes = mp.loc[mp["couple"] & ~mp["entity"], "node"].unique()
            bridge_flags[ent_nodes] |= F_ENTITY_BRIDGE
            bridge_flags[cpl_nodes] |= F_COUPLE_BRIDGE
        pending_name = multi_pairs[~(multi_pairs["entity"] | multi_pairs["couple"])]
        pend_nodes = pending_name["node"].unique()
        bridge_flags[pend_nodes] |= F_SAME_NAME_DIFF_ADDR
        qa["names_bridged_entity"] = int(mp.loc[mp["entity"], "name"].nunique()) if len(mp) else 0
        qa["names_bridged_couple"] = int(mp.loc[mp["couple"] & ~mp["entity"], "name"].nunique()) if len(mp) else 0
        qa["names_pending_individual"] = int(pending_name["name"].nunique())
    else:
        pending_name = multi_pairs

    # --- overrides -------------------------------------------------------------
    ovr_edges = []
    kept_nodes = np.zeros(n_nodes, dtype=bool)
    if overrides is not None and len(overrides):
        id_to_node: dict[str, list[int]] = {}
        for col in ("strict_id", "base_id"):
            for k, v in zip(d[col].astype(str).to_numpy(), node_of_parcel):
                id_to_node.setdefault(k, []).append(int(v))
        act = overrides["override_action"].str.lower().str.strip()
        keep = overrides[act == "keep"]
        for src in keep["source_owner_id"].astype(str):
            for v in id_to_node.get(src, []):
                kept_nodes[v] = True
        if kept_nodes.any():
            bridge_flags[kept_nodes] |= F_REVIEWED_KEPT
            qa["override_keep_nodes"] = int(kept_nodes.sum())
        m = overrides[act == "merge"]
        if len(m):
            rows = []
            for src, tgt in zip(m["source_owner_id"].astype(str), m["target_owner_group_id"].astype(str)):
                for v in id_to_node.get(src, []):
                    if tgt:
                        rows.append((tgt, v))
            if rows:
                t = pd.DataFrame(rows, columns=["tgt", "node"]).drop_duplicates()
                a, b = _star_edges(t["tgt"].reset_index(drop=True))
                nodes = t["node"].to_numpy()
                ovr_edges.append((nodes[a], nodes[b]))
                bridge_flags[t["node"].unique()] |= F_OVERRIDE_MERGE
            qa["override_merge_rows_applied"] = int(len(rows))

    # --- ORION bridge: parcels sharing a DOR owner record -------------------
    orion_edges = []
    if party is not None:
        pid = d["parcel_id"].astype(str).map(party)
        okp = pid.notna().to_numpy() & ~blank_name
        qa["orion_matched"] = int(pid.notna().sum())
        pairs_o = pd.DataFrame({"party": pid[okp].astype("int64").to_numpy(),
                                "node": node_of_parcel[okp]}).drop_duplicates()
        multi_o = pairs_o[pairs_o.groupby("party")["node"].transform("nunique") > 1]
        if len(multi_o):
            a, b = _star_edges(multi_o["party"].reset_index(drop=True))
            nodes = multi_o["node"].to_numpy()
            orion_edges.append((nodes[a], nodes[b]))
            bridge_flags[multi_o["node"].unique()] |= F_ORION_BRIDGE
        qa["orion_parties_bridging"] = int(multi_o["party"].nunique()) if len(multi_o) else 0

    comp = _components(n_nodes, doc_edges + ovr_edges + orion_edges)
    group_id = comp[node_of_parcel]
    # Group hashes are known only now; an override that names a group hash is
    # resolved on this second pass, so a reviewer can work from the dashboard.
    if overrides is not None and len(overrides):
        gh0 = (pd.DataFrame({"g": group_id, "k": d["base_key"]}).drop_duplicates()
               .sort_values(["g", "k"]).groupby("g")["k"].agg("|".join)
               .map(lambda x: hashlib.sha1(x.encode("utf-8")).hexdigest()[:16]))
        hash_to_nodes: dict[str, list[int]] = {}
        g_of_node = pd.Series(group_id, index=node_of_parcel).groupby(level=0).first()
        for node, g in g_of_node.items():
            hash_to_nodes.setdefault(gh0[g], []).append(int(node))
        act = overrides["override_action"].str.lower().str.strip()
        extra = []
        for src, tgt in zip(overrides.loc[act == "merge", "source_owner_id"].astype(str),
                            overrides.loc[act == "merge", "target_owner_group_id"].astype(str)):
            for v in hash_to_nodes.get(src, []):
                if tgt:
                    extra.append((tgt, v))
        for src in overrides.loc[act == "keep", "source_owner_id"].astype(str):
            for v in hash_to_nodes.get(src, []):
                kept_nodes[v] = True
        if extra:
            t = pd.DataFrame(extra, columns=["tgt", "node"]).drop_duplicates()
            a, b = _star_edges(t["tgt"].reset_index(drop=True))
            nodes = t["node"].to_numpy()
            ovr_edges.append((nodes[a], nodes[b]))
            bridge_flags[t["node"].unique()] |= F_OVERRIDE_MERGE
            comp = _components(n_nodes, doc_edges + ovr_edges + orion_edges)
            group_id = comp[node_of_parcel]
            qa["override_merge_rows_by_hash"] = int(len(extra))
        if kept_nodes.any():
            bridge_flags[kept_nodes] |= F_REVIEWED_KEPT
            qa["override_keep_nodes"] = int(kept_nodes.sum())
    d["group_id"] = group_id.astype("int32")
    qa["document_groups"] = int(comp.max() + 1) if n_nodes else 0

    # --- token check (pending, county-scoped) --------------------------------
    toks = name.str.split()
    two = toks.map(lambda t: " ".join(t[:2]) if isinstance(t, list) and len(t) >= 2 else "")
    tk = pd.DataFrame({"tok": two.to_numpy(), "county": d["county_n"].to_numpy(),
                       "grp": group_id, "blank": blank_name, "node": node_of_parcel})
    tk = tk[(tk["tok"] != "") & ~tk["blank"]].drop_duplicates(["tok", "county", "grp"])
    tk["key"] = tk["tok"] + "|" + tk["county"].astype(str)
    sizes = tk.groupby("key")["grp"].transform("nunique")
    tok_multi = tk[sizes > 1]
    token_nodes = tok_multi["node"].unique()
    bridge_flags[token_nodes] |= F_TOKEN_CHECK
    qa["token_check_groups"] = int(tok_multi["key"].nunique())

    # --- maximal tier: pending edges accepted, within county -------------------
    max_edges = list(doc_edges + ovr_edges + orion_edges)
    if len(pending_name):
        pn = pending_name.assign(key=pending_name["name"] + "|" + pending_name["county"].astype(str))
        pn = pn[~kept_nodes[pn["node"].to_numpy()]]
        pn = pn.drop_duplicates(["key", "node"])
        pn = pn[pn.groupby("key")["node"].transform("nunique") > 1]
        if len(pn):
            a, b = _star_edges(pn["key"].reset_index(drop=True))
            nodes = pn["node"].to_numpy()
            max_edges.append((nodes[a], nodes[b]))
    small = tok_multi[sizes.loc[tok_multi.index] <= TOKEN_EDGE_MAX_KEYS]
    small = small[~kept_nodes[small["node"].to_numpy()]]
    if len(small):
        a, b = _star_edges(small["key"].reset_index(drop=True))
        nodes = small["node"].to_numpy()
        max_edges.append((nodes[a], nodes[b]))
    comp_max = _components(n_nodes, max_edges)
    d["group_max"] = comp_max[node_of_parcel].astype("int32")
    qa["maximal_groups"] = int(comp_max.max() + 1) if n_nodes else 0

    # --- flags and provenance ------------------------------------------------
    flags |= bridge_flags[node_of_parcel]
    d["flags"] = flags
    # merged_by: how this parcel came to share its group with any other parcel
    grp_size = pd.Series(group_id).map(pd.Series(group_id).value_counts()).to_numpy()
    node_size = pd.Series(node_of_parcel).map(pd.Series(node_of_parcel).value_counts()).to_numpy()
    merged_by[:] = 0
    merged_by[(node_size > 1)] = 1                                   # by address (or name fallback)
    merged_by[(grp_size > node_size) & ((flags & F_COUPLE_BRIDGE) > 0)] = 3
    merged_by[(grp_size > node_size) & ((flags & F_ENTITY_BRIDGE) > 0)] = 2
    merged_by[(grp_size > node_size) & ((flags & F_OVERRIDE_MERGE) > 0)] = 4
    d["merged_by"] = merged_by

    # stable group hash from the sorted member base keys
    gh = (pd.DataFrame({"g": group_id, "k": d["base_key"]}).drop_duplicates()
          .sort_values(["g", "k"]).groupby("g")["k"].agg("|".join))
    gh = gh.map(lambda s: hashlib.sha1(s.encode("utf-8")).hexdigest()[:16])
    d["group_hash"] = pd.Series(group_id).map(gh).to_numpy()

    qa["parcels_flagged_pending"] = int(((flags & PENDING_MASK) > 0).sum())
    qa["parcels_general_delivery"] = int((flags & F_GENERAL_DELIVERY > 0).sum())
    qa["parcels_blank_owner"] = int(blank_name.sum())
    qa["parcels_care_of"] = int(careof.sum())
    return d, qa


def group_table(d: pd.DataFrame) -> pd.DataFrame:
    """One row per document-tier group, with the review status the dashboard shows."""
    d = d.copy()
    d["_ac"] = d["acres"].fillna(0).astype("float64")
    base = d.groupby("group_id").agg(
        group_hash=("group_hash", "first"),
        n_parcels=("parcel_id", "size"),
        acres=("_ac", "sum"),
        n_counties=("county_n", "nunique"),
        n_base_keys=("base_id", "nunique"),
        n_names=("owner_name_norm", "nunique"),
        is_entity=("owner_is_entity", "max"),
        flags=("flags", lambda s: int(np.bitwise_or.reduce(s.to_numpy().astype("int32")))),
    )
    # display name = the name carrying the most acreage in the group
    na = d.groupby(["group_id", "owner_name_norm"])["_ac"].sum().reset_index()
    na = na.sort_values(["group_id", "_ac"], ascending=[True, False]).drop_duplicates("group_id")
    base["display_name"] = na.set_index("group_id")["owner_name_norm"]
    aa = d.groupby(["group_id", "owner_addr_norm", "owner_city", "owner_state", "owner_zip5"])["_ac"].sum().reset_index()
    aa = aa.sort_values(["group_id", "_ac"], ascending=[True, False]).drop_duplicates("group_id").set_index("group_id")
    for c in ("owner_addr_norm", "owner_city", "owner_state", "owner_zip5"):
        base[c.replace("owner_", "display_")] = aa[c]
    # maximal-tier reach: acres the group would hold if every pending flag were accepted
    mx = d.groupby("group_max")["_ac"].sum()
    gm = d.drop_duplicates("group_id").set_index("group_id")["group_max"]
    base["acres_if_merged"] = gm.map(mx)
    links = d.drop_duplicates(["group_id", "group_max"]).groupby("group_max")["group_id"].nunique()
    base["pending_links"] = (gm.map(links) - 1).clip(lower=0).astype("int32")
    f = base["flags"].to_numpy().astype("int32")
    status = np.zeros(len(base), dtype="int8")
    status[(f & (F_ENTITY_BRIDGE | F_COUPLE_BRIDGE)) > 0] = 1
    status[(f & F_ORION_BRIDGE) > 0] = 5
    status[(f & F_TOKEN_CHECK) > 0] = 2
    status[(f & STRONG_PENDING) > 0] = 3
    status[(f & F_REVIEWED_KEPT) > 0] = 6
    status[(f & F_OVERRIDE_MERGE) > 0] = 4
    base["review_status"] = status
    return base.reset_index()


def run_snapshot(date: str, snap_dir: str = SNAP_DIR, out_dir: str = OUT_DIR,
                 overrides: pd.DataFrame | None = None, orion_cache: str | None = None) -> dict:
    df = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"), columns=OWNER_COLS)
    party = orion_party_map(date, orion_cache)
    d, qa = resolve(df, overrides, party)
    qa["orion_used"] = party is not None
    qa["date"] = date
    g = group_table(d)
    os.makedirs(out_dir, exist_ok=True)
    keep = ["parcel_id", "county_n", "acres", "strict_id", "base_id", "group_id", "group_hash",
            "group_max", "flags", "merged_by"]
    d[keep].to_parquet(os.path.join(out_dir, f"owners_{date}.parquet"), index=False, compression="zstd")
    g.to_parquet(os.path.join(out_dir, f"groups_{date}.parquet"), index=False, compression="zstd")
    qa["groups_flagged"] = int((g["review_status"] == 3).sum())
    qa["groups_token_check"] = int((g["review_status"] == 2).sum())
    qa["groups_auto_entity"] = int((g["review_status"] == 1).sum())
    qa["groups_orion_bridged"] = int((g["review_status"] == 5).sum())
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse
    import glob

    ap = argparse.ArgumentParser(description="Stage 8: owner identity per snapshot")
    ap.add_argument("--snapshots", default=SNAP_DIR)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--overrides", default="owner_overrides.csv")
    ap.add_argument("--orion-cache", default="orion_cache",
                    help="ORION Parquet cache; adds the shared-PartyID edge for 2024-2026")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    ovr = load_overrides(args.overrides)
    if len(ovr):
        log.info("overrides: %d rows from %s", len(ovr), args.overrides)
    dates = sorted(os.path.basename(p)[len("parcels_"):-len(".parquet")]
                   for p in glob.glob(os.path.join(args.snapshots, "parcels_*.parquet")))
    if args.only:
        dates = [d for d in dates if d in set(args.only)]
    qa_all = []
    for i, date in enumerate(dates, 1):
        dest = os.path.join(args.out, f"owners_{date}.parquet")
        if os.path.exists(dest) and not args.force:
            log.info("[%2d/%d] %s already resolved", i, len(dates), date)
            continue
        qa = run_snapshot(date, args.snapshots, args.out, ovr,
                          args.orion_cache if os.path.isdir(args.orion_cache) else None)
        qa_all.append(qa)
        log.info("[%2d/%d] %s  parcels=%s  base_keys=%s  groups=%s  maximal=%s  "
                 "flagged=%s  hubs split/flagged=%s/%s  entity-bridged names=%s  orion parties=%s",
                 i, len(dates), date, f"{qa['parcels']:,}", f"{qa['base_keys']:,}",
                 f"{qa['document_groups']:,}", f"{qa['maximal_groups']:,}",
                 f"{qa['parcels_flagged_pending']:,}", qa["hub_addresses_split"],
                 qa["hub_addresses_flagged"], qa.get("names_bridged_entity", 0),
                 qa.get("orion_parties_bridging", "-"))
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "qa_identity.json"), "w") as fh:
        json.dump(qa_all, fh, indent=2, default=str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
