"""Stage 11: the DOR's building records as a witness to the ladder, and the
condition of the housing stock.

Everything the dashboard says about development rests on two columns of the
parcel layer: an assessed building value and a situs house number. Both are
inferred signals, and until this stage the only check between them was each
other. The ORION CAMA database carries what the appraiser actually recorded
for each dwelling -- the year it was built, its physical condition, its grade,
the permits issued against the property and the date it was last inspected --
and it is keyed on the same geocode. Three refreshes are on hand -- 2016-03-27
(tax years 2014-2016), 2018-06-21 (2016-2018) and 2026-06-24 (2024-2026) --
and each tax year is joined to the parcel export that carries its roll (see
:func:`_roll_year`), which gives eight points: 2014, 2015-2018 and 2024-2026.
Every point is a cross-section of the same kind, used two ways:

* **as a witness.** For every parcel the layer calls built, does the DOR hold a
  building record; for every parcel the layer calls platted-only, does it not.
  For a dwelling built in year Y, in which vintage did the ladder first show a
  building value, and did the address come first. For a lot first seen in the
  series, was its dwelling older than the lot. For a dormant lot, is there a
  dwelling on it after all. Each of those is a named test with a count on both
  sides, written to ``qa_cama.json`` and published through ``meta.json``.

* **as a measure.** The condition rating itself, which nothing in the parcel
  layer approximates, at township and county grain and on the parcel tiles.

**CDU through 2014, its components after.** The dictionary defines ``CDU`` as
the composite of condition, desirability and utility. It is filled on 412,439
of 412,440 dwellings for tax year 2014 and on a few dozen manufactured homes
in every year after; from 2015 its four components are filled instead --
``PhyCondition`` (physical deterioration), ``Utility``, ``PropDesirability``
and ``LocDesirability``, each on the DOR's scale: Unsound (1), Very Poor (3),
Poor (5), Fair (6), Average (7), Good (8), Very Good (9), Excellent (10). The
composite was retired at the 2015 reappraisal by copying it into the
components (it equals the 2015 physical condition on 80.6% of dwellings). So
the published rating is CDU where CDU is the filled field and PhyCondition
where that is, chosen per tax year by population and named in the QA as
``rating_field``; the seam is 2014 -> 2015.

A parcel with several dwellings reports its **principal** dwelling's condition
(the one with the largest depreciated cost, ties to the largest living area)
and its **earliest** year built -- the earliest is what the ladder should have
seen first. Manufactured homes not attached to real property are separate
ORION properties with their own geocodes that do not exist in the parcel layer;
they are counted in the join accounting and nowhere else.
"""

from __future__ import annotations

import glob
import json
import logging
import os

import numpy as np
import pandas as pd

from cadastral.schema import COUNTY_PREFIX
from . import commonarea  # noqa: F401  (documents the exclusion; see dormant())
from . import events as _events

log = logging.getLogger("timeseries.cama")

SNAP_DIR = "data/snapshots"
EVENT_DIR = "data/events"
LOC_DIR = "data/locator"
ORION_DIR = "orion_cache"          # the newest refresh; see ORION_CACHES
OUT_DIR = "data/cama"
STRUCT_DIR = "data/structures"      # stage 12, the address points; newest export only

# ORION Parquet caches, newest refresh first: a tax year is taken from the
# newest refresh that holds it (tax year 2016 is in both the 2016 and the 2018
# refresh; they agree on 99.4% of ratings).
ORION_CACHES = ("orion_cache", "orion_cache_2018", "orion_cache_2016")

# The DOR's rating scale, as an ordinal 0-7. The numbers in the labels are the
# DOR's own (the scale skips 2 and 4).
CONDITION_CODES = ["UN", "VP", "PR", "FR", "AV", "GD", "VG", "EX"]
CONDITION_LABELS = ["unsound (1)", "very poor (3)", "poor (5)", "fair (6)", "average (7)",
                    "good (8)", "very good (9)", "excellent (10)"]
COND_IDX = {c: i for i, c in enumerate(CONDITION_CODES)}
BELOW_AVERAGE = 3            # fair (6) and worse
# Year-built bins for the published tables.
YB_EDGES = [0, 1900, 1920, 1940, 1960, 1980, 2000, 2010, 2020, 9999]
YB_LABELS = ["pre-1900", "1900-19", "1920-39", "1940-59", "1960-79", "1980-99",
             "2000-09", "2010-19", "2020+"]
# Permit types that mean a new dwelling on the property.
NEW_DWELLING_PERMITS = ("RESIDENTIAL", "MANUFACTURED HOME", "MODULAR")
DORMANT_YEARS = 5
INSPECTION_RECENT_YEARS = 5


def _dates(snap_dir: str) -> list[str]:
    paths = sorted(glob.glob(os.path.join(snap_dir, "parcels_*.parquet")))
    return [os.path.basename(p)[len("parcels_"):-len(".parquet")] for p in paths]


def _year_of(date: str) -> int:
    return int(date[:4])


def _roll_year(date: str) -> int:
    """The tax-year roll whose building values an export carries.

    Measured against the DOR's year built (section 19 of FINDINGS): a dwelling
    built in Y is assessed on 1 January of Y+1, and the exports dated January
    and February still carry the previous year's values -- the 2017-01-30
    export holds 2.8% of the dwellings built in 2016, the 2018-01-10 export
    80%. So an export carries the roll of its own year from July on, and the
    previous year's before that. The export's TaxYear label says otherwise and
    is a label, not the value block.
    """
    y, m = int(date[:4]), int(date[5:7])
    return y if m >= 7 else y - 1


def discover_series(snap_dir: str, caches: tuple[str, ...] = ORION_CACHES) -> list[dict]:
    """Every tax year any cache holds, joined to the parcel export that carries
    its roll. Newest refresh wins a tax year held twice."""
    dates = _dates(snap_dir)
    by_roll: dict[int, int] = {}
    for i, d in enumerate(dates):
        by_roll[_roll_year(d)] = i          # the latest export carrying that roll
    pts: dict[int, dict] = {}
    for cache in caches:
        pp = os.path.join(cache, "property.parquet")
        if not os.path.exists(pp):
            continue
        refresh = None
        sp = os.path.join(cache, "systeminfo.parquet")
        if os.path.exists(sp):
            si = pd.read_parquet(sp)
            if len(si) and "RefreshDate" in si:
                refresh = str(si["RefreshDate"].iloc[0])[:10]
        for ty in sorted(pd.read_parquet(pp, columns=["TaxYear"])["TaxYear"].dropna().unique()):
            ty = int(ty)
            if ty in pts or ty not in by_roll:
                continue
            pts[ty] = {"tax_year": ty, "snap_idx": by_roll[ty], "date": dates[by_roll[ty]],
                       "cache": cache, "refresh_date": refresh}
    return [pts[k] for k in sorted(pts)]


# ---------------------------------------------------------------- ORION side
def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def _year_col(s: pd.Series) -> pd.Series:
    """A CAMA year column as a nullable int: 0 and absurd values become NA."""
    y = _num(s)
    y = y.where((y >= 1700) & (y <= 2100))
    return y


def building_records(orion_dir: str, ty: int) -> tuple[pd.DataFrame, dict]:
    """One row per ORION property for tax year ``ty``: the principal dwelling,
    the earliest structure, commercial and outbuilding counts, the final
    valuation, permits and the last inspection."""
    qa: dict = {"tax_year": ty}
    prop = pd.read_parquet(os.path.join(orion_dir, "property.parquet"),
                           columns=["PropertyID", "TaxYear", "GeoCodeSearch", "PropType",
                                    "PropSubCategory_Desc"])
    prop = prop[prop["TaxYear"] == ty].drop(columns="TaxYear")
    prop["parcel_id"] = prop["GeoCodeSearch"].astype(str)
    qa["properties"] = int(len(prop))
    dup = prop["parcel_id"].duplicated(keep=False)
    qa["properties_sharing_a_geocode"] = int(dup.sum())
    prop = prop.drop_duplicates("parcel_id", keep="first")

    # --- dwellings
    res = pd.read_parquet(os.path.join(orion_dir, "res.parquet"))
    res = res[res["TaxYear"] == ty].copy()
    qa["dwelling_rows"] = int(len(res))
    qa["dwelling_rows_with_cdu"] = int(res["CDU"].notna().sum())
    qa["dwelling_rows_with_phycondition"] = int(res["PhyCondition"].notna().sum())
    res["yb"] = _year_col(res["YearBuilt"])
    qa["dwelling_rows_with_year_built"] = int(res["yb"].notna().sum())
    for c in ("RCNLD", "SFLA", "PctGood", "PctComplete", "EffectiveYear", "YearRemod"):
        res[c] = _num(res[c])
    # The rating the DOR filled in this tax year: CDU through 2014, the
    # physical-condition component from 2015. Chosen by population, named.
    field = "PhyCondition" if qa["dwelling_rows_with_phycondition"] >= qa["dwelling_rows_with_cdu"] else "CDU"
    qa["rating_field"] = field
    res["cond"] = res[field].map(COND_IDX).fillna(-1).astype("int8")
    res["phy"] = res["PhyCondition"].map(COND_IDX).fillna(-1).astype("int8")
    res["util"] = res["Utility"].map(COND_IDX).fillna(-1).astype("int8")
    res["pdes"] = res["PropDesirability"].map(COND_IDX).fillna(-1).astype("int8")
    res["ldes"] = res["LocDesirability"].map(COND_IDX).fillna(-1).astype("int8")
    res["cdu"] = res["CDU"].map(COND_IDX).fillna(-1).astype("int8")
    res["is_mh"] = res["ResType"].isin(["MH", "MOB"]).to_numpy()     # MOB in the older refreshes
    res["is_condo_th"] = res["ResType"].isin(["Condominium", "Townhouse"]).to_numpy()
    res["partial"] = (res["PctComplete"].fillna(100) < 100).to_numpy()
    # Principal dwelling: largest depreciated cost, then largest living area.
    res = res.sort_values(["PropertyID", "RCNLD", "SFLA"], ascending=[True, False, False])
    principal = res.drop_duplicates("PropertyID", keep="first").set_index("PropertyID")
    g = res.groupby("PropertyID")
    dwell = pd.DataFrame({
        "n_dwell": g.size().astype("int16"),
        "yb_res": g["yb"].min(),
        "yb_res_max": g["yb"].max(),
        "any_mh": g["is_mh"].any(),
        "any_condo_th": g["is_condo_th"].any(),
        "any_partial": g["partial"].any(),
        "cond_min": g["cond"].min().astype("int8"),
    })
    for c in ("cond", "phy", "util", "pdes", "ldes", "cdu"):
        dwell[c] = principal[c].reindex(dwell.index).fillna(-1).astype("int8")
    dwell["grade"] = principal["Grade"].reindex(dwell.index).fillna("").astype(str)
    dwell["res_type"] = principal["ResType"].reindex(dwell.index).fillna("").astype(str)
    dwell["pct_good"] = principal["PctGood"].reindex(dwell.index).astype("float32")
    dwell["sfla"] = principal["SFLA"].reindex(dwell.index).astype("float32")
    dwell["eff_year"] = _year_col(principal["EffectiveYear"]).reindex(dwell.index)
    dwell["remod_year"] = _year_col(principal["YearRemod"]).reindex(dwell.index)
    qa["properties_with_dwelling"] = int(len(dwell))
    qa["properties_with_several_dwellings"] = int((dwell["n_dwell"] > 1).sum())

    # --- commercial buildings and outbuildings
    com = pd.read_parquet(os.path.join(orion_dir, "com.parquet"),
                          columns=["PropertyID", "TaxYear", "YearBuilt"])
    com = com[com["TaxYear"] == ty]
    com["yb"] = _year_col(com["YearBuilt"])
    gc_ = com.groupby("PropertyID")
    comm = pd.DataFrame({"n_com": gc_.size().astype("int16"), "yb_com": gc_["yb"].min()})
    oby = pd.read_parquet(os.path.join(orion_dir, "oby.parquet"),
                          columns=["PropertyID", "TaxYear", "YearBlt", "Value"])
    oby = oby[oby["TaxYear"] == ty]
    oby["yb"] = _year_col(oby["YearBlt"])
    oby["Value"] = _num(oby["Value"])
    go = oby.groupby("PropertyID")
    outb = pd.DataFrame({"n_oby": go.size().astype("int16"), "yb_oby": go["yb"].min(),
                         "oby_value": go["Value"].sum().astype("float32")})
    qa["properties_with_commercial"] = int(len(comm))
    qa["properties_with_outbuilding"] = int(len(outb))

    # --- final valuation
    fv = pd.read_parquet(os.path.join(orion_dir, "finalval.parquet"))
    fv = fv[fv["TaxYear"] == ty].drop_duplicates("PropertyID").set_index("PropertyID")
    fv = fv[["FinalLand", "FinalBuilding", "FinalTotal", "Method"]].rename(columns={
        "FinalLand": "final_land", "FinalBuilding": "final_building",
        "FinalTotal": "final_total", "Method": "val_method"})
    for c in ("final_land", "final_building", "final_total"):
        fv[c] = _num(fv[c])
    qa["properties_with_final_value"] = int(len(fv))

    # --- permits (undated by tax year; the whole record per property)
    pm = pd.read_parquet(os.path.join(orion_dir, "permit.parquet"),
                         columns=["PropertyID", "IssueDate", "Type", "Status"])
    pm["year"] = pd.to_datetime(pm["IssueDate"], errors="coerce").dt.year
    pm = pm[pm["year"].notna() & (pm["year"] >= 1900) & (pm["year"] <= ty + 1)]
    pm["new_dwelling"] = pm["Type"].fillna("").str.upper().isin(NEW_DWELLING_PERMITS)
    gp = pm.groupby("PropertyID")
    perm = pd.DataFrame({"n_permits": gp.size().astype("int16"),
                         "first_permit_year": gp["year"].min(),
                         "last_permit_year": gp["year"].max()})
    nd = pm[pm["new_dwelling"]].groupby("PropertyID")["year"]
    perm["first_dwelling_permit_year"] = nd.min().reindex(perm.index)
    perm["n_dwelling_permits"] = nd.size().reindex(perm.index).fillna(0).astype("int16")
    qa["permits_dated"] = int(len(pm))
    qa["permits_new_dwelling"] = int(pm["new_dwelling"].sum())

    # --- last inspection
    ip = os.path.join(orion_dir, "inspection.parquet")
    if os.path.exists(ip):
        ins = pd.read_parquet(ip)
        ins = ins[ins["TaxYear"] == ty].drop_duplicates("PropertyID").set_index("PropertyID")
        insp = pd.DataFrame({
            "last_insp_year": pd.to_datetime(ins["LastInspDate"], errors="coerce").dt.year,
            "n_inspections": _num(ins["n_inspections"]).fillna(0).astype("int16")})
    else:
        insp = pd.DataFrame(columns=["last_insp_year", "n_inspections"])
        log.warning("no inspection.parquet in %s", orion_dir)

    out = (prop.set_index("PropertyID")
           .join(dwell, how="left").join(comm, how="left").join(outb, how="left")
           .join(fv, how="left").join(perm, how="left").join(insp, how="left"))
    for c in ("n_dwell", "n_com", "n_oby", "n_permits", "n_dwelling_permits", "n_inspections"):
        out[c] = out[c].fillna(0).astype("int16")
    for c in ("cond", "phy", "util", "pdes", "ldes", "cdu", "cond_min"):
        out[c] = out[c].fillna(-1).astype("int8")
    for c in ("any_mh", "any_condo_th", "any_partial"):
        out[c] = out[c].fillna(False).astype(bool)
    out["yb_any"] = out[["yb_res", "yb_com", "yb_oby"]].min(axis=1)
    out["has_dwelling"] = out["n_dwell"] > 0
    out["has_structure"] = (out["n_dwell"] + out["n_com"] + out["n_oby"]) > 0
    out = out.reset_index()
    # Dwellings on properties that cannot be a parcel (manufactured homes not
    # attached to real property, personal property) are accounted here so the
    # join below is not read as a loss.
    sub = out.loc[out["has_dwelling"], "PropSubCategory_Desc"].fillna("").value_counts()
    qa["dwelling_properties_by_subcategory"] = {str(k): int(v) for k, v in sub.head(8).items()}
    return out, qa


# ---------------------------------------------------------------- ladder side
def ladder_history(snap_dir: str, dates: list[str]) -> pd.DataFrame:
    """Per parcel: the first vintage with a building value and the first with a
    house number, over the whole series. -1 = never."""
    first_built: dict[str, int] = {}
    first_addr: dict[str, int] = {}
    for j, date in enumerate(dates):
        df = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"),
                             columns=["parcel_id", "improved", "has_house_number"])
        b = df.loc[df["improved"].to_numpy() == 1, "parcel_id"]
        for pid in b[~b.isin(first_built.keys())]:
            first_built[pid] = j
        a = df.loc[df["has_house_number"].to_numpy(dtype=bool), "parcel_id"]
        for pid in a[~a.isin(first_addr.keys())]:
            first_addr[pid] = j
        log.info("  ladder history %s: %s first built, %s first addressed so far",
                 date, f"{len(first_built):,}", f"{len(first_addr):,}")
    fb = pd.Series(first_built, name="first_built_idx", dtype="int16")
    fa = pd.Series(first_addr, name="first_addr_idx", dtype="int16")
    hist = pd.concat([fb, fa], axis=1).fillna(-1).astype("int16")
    hist.index.name = "parcel_id"
    return hist.reset_index()


def creation_class(event_dir: str) -> pd.Series:
    """parcel_id -> class of its first creation event (lot_created,
    block_created, unit_created or first_mapping), over every interval. A
    parcel first seen when a county's data arrived is a first_mapping, not a
    new lot, and must not be tested as one."""
    parts = [pd.read_parquet(p, columns=["parcel_id", "event_class", "interval"])
             for p in sorted(glob.glob(os.path.join(event_dir, "events_*.parquet")))]
    ev = pd.concat(parts, ignore_index=True).sort_values("interval").drop_duplicates("parcel_id")
    return ev.set_index("parcel_id")["event_class"]


NEW_LOT = ("lot_created", "block_created")


# -------------------------------------------------------------------- joins
def parcel_frame(date: str, snap_dir: str, event_dir: str, loc_dir: str,
                 hist: pd.DataFrame, bld: pd.DataFrame, cls: pd.Series,
                 snap_idx: int | None = None) -> tuple[pd.DataFrame, dict]:
    """One snapshot's parcels with their ladder history and the DOR's building
    record, one row per parcel. The history is censored at ``snap_idx``: what
    the ladder showed after this export is not known to it."""
    qa: dict = {"date": date}
    p = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"),
                        columns=["parcel_id", "county", "county_n", "twp_code", "acres",
                                 "improved", "has_house_number", "dev_stage",
                                 "is_common_area", "is_condo", "build_value"])
    # first_idx is the start of the occurrence present at this point: a
    # geocode reissued after a gap is a new parcel from its return (events.py).
    occ = _events.load_occurrences(event_dir)
    at = snap_idx if snap_idx is not None else int(occ["last_idx"].max())
    p["first_idx"] = p["parcel_id"].map(_events.occurrence_start(occ, at)).fillna(-1).astype("int16")
    p = p.merge(hist, on="parcel_id", how="left")
    for c in ("first_built_idx", "first_addr_idx"):
        p[c] = p[c].fillna(-1).astype("int16")
        if snap_idx is not None:
            p.loc[p[c] > snap_idx, c] = -1
    p["creation"] = p["parcel_id"].map(cls).fillna("").astype(str)
    qa["creation_classes"] = {str(k): int(v) for k, v in p.loc[p["first_idx"] > 0, "creation"].value_counts().items()}
    units = pd.read_parquet(os.path.join(loc_dir, "spatial_unit.parquet"),
                            columns=["unit", "tr_key"])
    code_to_tr = units.drop_duplicates("unit").set_index("unit")["tr_key"]
    p["tr_key"] = (p["county"].fillna("") + p["twp_code"].fillna("")).map(code_to_tr)

    j = p.merge(bld.drop(columns=["GeoCodeSearch"]), on="parcel_id", how="left")
    qa["parcels"] = int(len(p))
    qa["parcels_matched_to_a_property"] = int(j["PropertyID"].notna().sum())
    qa["properties_unmatched_to_a_parcel"] = int(len(bld) - qa["parcels_matched_to_a_property"])
    unm = bld[~bld["parcel_id"].isin(p["parcel_id"])]
    qa["unmatched_properties_with_dwelling"] = int(unm["has_dwelling"].sum())
    qa["unmatched_dwelling_properties_by_subcategory"] = {
        str(k): int(v) for k, v in
        unm.loc[unm["has_dwelling"], "PropSubCategory_Desc"].fillna("").value_counts().head(6).items()}
    qa["unmatched_dwelling_properties_by_type"] = {
        str(k): int(v) for k, v in
        unm.loc[unm["has_dwelling"], "PropType"].fillna("").value_counts().head(8).items()}
    qa["unmatched_note"] = ("manufactured homes not attached to real property and condominium units "
                            "are DOR properties with their own geocodes that are not parcels")
    for c in ("n_dwell", "n_com", "n_oby", "n_permits", "n_dwelling_permits", "n_inspections"):
        j[c] = j[c].fillna(0).astype("int16")
    for c in ("cond", "phy", "util", "pdes", "ldes", "cdu", "cond_min"):
        j[c] = j[c].fillna(-1).astype("int8")
    for c in ("has_dwelling", "has_structure", "any_mh", "any_condo_th", "any_partial"):
        j[c] = j[c].fillna(False).astype(bool)
    j["improved"] = j["improved"].fillna(-1).astype("int8")
    # Stage 12: the Structures Framework's address points, joined where the
    # stage has run for this export (the newest; the framework is a monthly
    # export with no history, so earlier points carry zeros and are untested).
    sp = os.path.join(STRUCT_DIR, f"parcels_structures_{date}.parquet")
    addr_cols = ("n_addr_num", "n_addr_res", "n_addr_mh", "n_addr_unit")
    if os.path.exists(sp):
        st = pd.read_parquet(sp, columns=["parcel_id", *addr_cols])
        j = j.merge(st, on="parcel_id", how="left")
        j["addr_tested"] = True
        qa["structures"] = {"source": sp, "parcels_with_a_point": int(len(st))}
    else:
        for c in addr_cols:
            j[c] = 0
        j["addr_tested"] = False
    for c in addr_cols:
        j[c] = j[c].fillna(0).astype("int16")
    return j, qa


# ----------------------------------------------------------------- the tests
def _share(n: int, d: int) -> float | None:
    return round(100.0 * n / d, 3) if d else None


def _quant(s: pd.Series) -> dict:
    s = s.dropna()
    if not len(s):
        return {"n": 0}
    return {"n": int(len(s)), "mean": round(float(s.mean()), 3),
            "p10": float(s.quantile(0.10)), "p25": float(s.quantile(0.25)),
            "median": float(s.median()), "p75": float(s.quantile(0.75)),
            "p90": float(s.quantile(0.90))}


def witness(j: pd.DataFrame, dates: list[str], ty: int) -> dict:
    """Every named test, statewide. The county tables carry the same counts
    per county; this is the record that goes into meta.json."""
    yrs = np.array([_year_of(d) for d in dates])
    latest = len(dates) - 1
    off = ~j["is_common_area"].to_numpy(dtype=bool)
    known = j["improved"].to_numpy() >= 0
    base = j[off & known]
    out: dict = {"date": dates[latest], "tax_year": ty,
                 "parcels_tested": int(len(base)),
                 "parcels_common_area_excluded": int((~off).sum())}

    # 1. improvement witness: assessed value vs any DOR building record.
    imp = base["improved"].to_numpy() == 1
    st = base["has_structure"].to_numpy()
    dw = base["has_dwelling"].to_numpy()
    out["improvement_witness"] = {
        "built_both": int((imp & st).sum()), "layer_only": int((imp & ~st).sum()),
        "dor_only": int((~imp & st).sum()), "vacant_both": int((~imp & ~st).sum()),
        "agreement_pct": _share(int((imp == st).sum()), len(base)),
        "dor_only_with_dwelling": int((~imp & dw).sum()),
        "note": "layer_only: the parcel layer carries a building value and ORION holds no dwelling, "
                "commercial or outbuilding record for the property; dor_only: the reverse.",
    }
    # 1b. the value itself against the DOR's final building value.
    v = base[imp & base["final_building"].notna()]
    bv = v["build_value"].fillna(0).to_numpy()
    fb = v["final_building"].fillna(0).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(fb > 0, bv / fb, np.nan)
    out["building_value_witness"] = {
        "n": int(len(v)), "equal_within_1_dollar": int((np.abs(bv - fb) <= 1).sum()),
        "within_1_pct": int((np.abs(bv - fb) <= 0.01 * np.maximum(fb, 1)).sum()),
        "layer_higher_by_10_pct": int((bv > 1.1 * fb).sum()),
        "layer_lower_by_10_pct": int((bv < 0.9 * fb).sum()),
        "dor_zero_layer_positive": int((fb <= 0).sum()),
        "ratio": _quant(pd.Series(ratio)),
    }

    # 2. house-number witness: the stage-1 signal against a recorded dwelling.
    hn = base["has_house_number"].to_numpy(dtype=bool)
    out["house_number_witness"] = {
        "house_number_and_dwelling": int((hn & dw).sum()),
        "house_number_no_dwelling": int((hn & ~dw).sum()),
        "dwelling_no_house_number": int((~hn & dw).sum()),
        "neither": int((~hn & ~dw).sum()),
        "p_dwelling_given_house_number_pct": _share(int((hn & dw).sum()), int(hn.sum())),
        "p_dwelling_given_no_house_number_pct": _share(int((~hn & dw).sum()), int((~hn).sum())),
        "p_house_number_given_dwelling_pct": _share(int((hn & dw).sum()), int(dw.sum())),
    }

    # 2b. address-point witness (stage 12): the Structures Framework's points
    # against the parcel layer's house number and the DOR's dwelling record.
    if bool(base["addr_tested"].any()):
        pt = base["n_addr_num"].to_numpy() > 0
        rp = base["n_addr_res"].to_numpy() > 0
        mp = base["n_addr_mh"].to_numpy() > 0
        mh = base["any_mh"].to_numpy()
        out["address_point_witness"] = {
            "house_number_and_point": int((hn & pt).sum()),
            "house_number_no_point": int((hn & ~pt).sum()),
            "point_no_house_number": int((~hn & pt).sum()),
            "neither": int((~hn & ~pt).sum()),
            "agreement_pct": _share(int((hn == pt).sum()), len(base)),
            "p_point_given_house_number_pct": _share(int((hn & pt).sum()), int(hn.sum())),
            "p_house_number_given_point_pct": _share(int((hn & pt).sum()), int(pt.sum())),
            "dwelling_and_residential_point": int((dw & rp).sum()),
            "dwelling_no_residential_point": int((dw & ~rp).sum()),
            "residential_point_no_dwelling": int((~dw & rp).sum()),
            "p_residential_point_given_dwelling_pct": _share(int((dw & rp).sum()), int(dw.sum())),
            "dor_mh_with_mobile_home_point": int((mh & mp).sum()),
            "dor_mh_without": int((mh & ~mp).sum()),
            "mobile_home_point_no_dor_mh": int((~mh & mp).sum()),
            "note": "a numbered address point inside the parcel polygon; residential = MT_PlcType 101-103, "
                    "106, 107 or Place_Type residence; tested on the export the Structures Framework was "
                    "joined to, see qa_structures.json for the geocode and placement tests",
        }

    # 3. ladder timing: year built vs the roll the ladder first showed a value
    # in. A dwelling built in Y belongs to the Y+1 roll; "on time" is the first
    # export that carried that roll.
    roll = np.array([_roll_year(d) for d in dates])
    t = base[dw & base["yb_res"].notna()].copy()
    t = t[(t["yb_res"] >= 2004) & (t["yb_res"] <= yrs[latest] - 1)]
    fbi = t["first_built_idx"].to_numpy()
    fai = t["first_addr_idx"].to_numpy()
    yb = t["yb_res"].to_numpy()
    rl = np.where(fbi >= 0, roll[np.clip(fbi, 0, latest)], np.nan)
    d = rl - (yb + 1)                       # rolls after the one that should carry it
    addr_year = np.where(fai >= 0, yrs[np.clip(fai, 0, latest)], np.nan)
    alag = addr_year - yb
    never = fbi < 0
    out["ladder_timing"] = {
        "dwellings_built_2004_on": int(len(t)),
        "never_built_per_ladder": int(never.sum()),
        "earlier_structure": int((d < 0).sum()),
        "on_time": int((d == 0).sum()), "one_roll_late": int((d == 1).sum()),
        "two_or_more_rolls_late": int((d >= 2).sum()),
        "rolls_late": _quant(pd.Series(d)),
        "address_before_year_built": int((alag < 0).sum()),
        "address_never": int((fai < 0).sum()),
        "address_lag_years": _quant(pd.Series(alag)),
        "note": "a dwelling built in Y is on the Y+1 roll; an export carries its own year's roll "
                "from July and the previous year's before that (see _roll_year). 'on time' is the "
                "first export that could carry the dwelling; 'earlier structure' means a value stood "
                "on the parcel before the dwelling's year built. The January export of the following "
                "year carries the roll, so the missing 2012 and 2015 exports and the dead 2009-07-05 "
                "values cost no dwelling its on-time reading.",
    }
    by_year = []
    for y, g in t.assign(d=d, never=never, abefore=alag < 0).groupby("yb_res"):
        by_year.append({"year_built": int(y), "n": int(len(g)),
                        "never": int(g["never"].sum()),
                        "earlier": int((g["d"] < 0).sum()), "on_time": int((g["d"] == 0).sum()),
                        "late1": int((g["d"] == 1).sum()), "late2plus": int((g["d"] >= 2).sum()),
                        "address_before": int(g["abefore"].sum())})
    out["ladder_timing_by_year"] = by_year

    # 4. cohort dating: a lot first seen in the series whose dwelling is older,
    # by the class of the event that created it. Only a plat or a split is a
    # new lot; a first mapping is a county's data arriving.
    born_all = base[(base["first_idx"] > 0) & dw & base["yb_res"].notna()]
    by_class = {}
    for cname, mask in (("new_lot", born_all["creation"].isin(NEW_LOT)),
                        ("unit_created", born_all["creation"] == "unit_created"),
                        ("first_mapping", born_all["creation"] == "first_mapping"),
                        ("unclassified", born_all["creation"] == "")):
        g = born_all[mask]
        gy = yrs[g["first_idx"].to_numpy()]
        older = g["yb_res"].to_numpy() < gy - 1
        by_class[cname] = {"n": int(len(g)), "dwelling_older_than_lot": int(older.sum()),
                           "share_pct": _share(int(older.sum()), len(g))}
    out["cohort_dating"] = {
        "new_lots_with_dwelling": by_class["new_lot"]["n"],
        "dwelling_older_than_lot": by_class["new_lot"]["dwelling_older_than_lot"],
        "share_pct": by_class["new_lot"]["share_pct"],
        "by_creation_class": by_class,
        "note": "a dwelling at least two years older than the lot's first vintage means the lot "
                "was carved from an already-improved parcel. Counted over lots whose creation "
                "event is a plat or a split; a first mapping is coverage arriving and is shown apart.",
    }

    # 5. dormant witness.
    dorm = base[(base["dev_stage"] == 0) & (base["first_idx"] > 0) & (base["acres"] < 40)]
    stage1 = base[base["dev_stage"] == 1]
    out["dormant_witness"] = {
        "dormant_lots_under_40ac": int(len(dorm)),
        "with_dwelling": int(dorm["has_dwelling"].sum()),
        "with_any_structure": int(dorm["has_structure"].sum()),
        "with_dwelling_permit": int((dorm["n_dwelling_permits"] > 0).sum()),
        "addressed_not_built": int(len(stage1)),
        "addressed_not_built_with_dwelling": int(stage1["has_dwelling"].sum()),
        "addressed_not_built_with_structure": int(stage1["has_structure"].sum()),
    }

    # 6. permit witness: a new-dwelling permit on an unimproved parcel.
    pw = base[base["first_dwelling_permit_year"].notna()].copy()
    pw = pw[(pw["first_dwelling_permit_year"] >= 2004) & (pw["first_dwelling_permit_year"] <= yrs[latest] - 2)]
    py = pw["first_dwelling_permit_year"].to_numpy()
    # the last vintage strictly before the permit year
    prior = np.searchsorted(yrs, py, side="left") - 1
    fb2 = pw["first_built_idx"].to_numpy()
    unimproved_before = (fb2 < 0) | (fb2 > prior)
    pw = pw[unimproved_before]
    py = py[unimproved_before]
    fb2 = fb2[unimproved_before]
    prl = np.where(fb2 >= 0, roll[np.clip(fb2, 0, latest)], np.nan)
    pdl = prl - (py + 1)                    # rolls after the first that could carry the house
    out["permit_witness"] = {
        "new_dwelling_permits_on_unimproved_parcels": int(len(pw)),
        "built_by_next_roll": int((pdl <= 0).sum()), "second_roll": int((pdl == 1).sum()),
        "third_roll_or_later": int((pdl >= 2).sum()), "never": int(np.isnan(pdl).sum()),
        "rolls_late": _quant(pd.Series(pdl)),
        "note": "permits typed RESIDENTIAL, MANUFACTURED HOME or MODULAR, issued 2004 onward on a "
                "parcel the ladder had not yet called built; a house permitted in P is on the P+1 "
                "roll at the earliest, and the rolls are counted as in ladder_timing.",
    }

    # 7. condition against age, the plausibility check on the rating itself.
    rated = base[dw & (base["cond"] >= 0)]
    dec = pd.cut(rated["yb_res"], bins=YB_EDGES, labels=YB_LABELS, right=False)
    tab = pd.crosstab(dec, rated["cond"]).reindex(index=YB_LABELS, fill_value=0)
    out["condition_by_year_built"] = [
        {"bin": str(b), "n": int(tab.loc[b].sum()),
         "below_average_pct": _share(int(tab.loc[b, [c for c in tab.columns if c <= BELOW_AVERAGE]].sum()),
                                     int(tab.loc[b].sum()))}
        for b in YB_LABELS]
    pg = rated.groupby("cond")["pct_good"].mean()
    out["pct_good_by_condition"] = {CONDITION_CODES[int(k)]: round(float(v), 4) for k, v in pg.items()}
    out["pct_good_monotonic"] = bool(np.all(np.diff(pg.sort_index().to_numpy()) >= 0))
    out["condition_distribution"] = {CONDITION_CODES[i]: int((rated["cond"] == i).sum())
                                     for i in range(len(CONDITION_CODES))}
    out["dwellings_unrated"] = int((dw & (base["cond"] < 0)).sum())
    out["cdu_populated_on_parcels"] = int((base["cdu"] >= 0).sum())
    out["mobile_homes"] = int(base["any_mh"].sum())
    out["partially_complete"] = int(base["any_partial"].sum())
    out["partially_complete_by_stage"] = {
        str(int(k)): int(v) for k, v in base.loc[base["any_partial"], "dev_stage"].value_counts().items()}
    li = base.loc[dw, "last_insp_year"]
    out["inspection_recency"] = {
        "dwellings_with_inspection_date": int(li.notna().sum()),
        f"inspected_within_{INSPECTION_RECENT_YEARS}y": int((li >= ty - INSPECTION_RECENT_YEARS).sum()),
        "median_year": (int(li.median()) if li.notna().any() else None),
    }
    return out


def value_witness(snap_dir: str, orion_dir: str, ty: int, date: str) -> tuple[dict, pd.DataFrame | None]:
    """The parcel layer's building value against the DOR's final building
    value for one tax year. The refresh's current year is sparse until the
    reappraisal closes (65,298 rows for 2026 against 980,495 for 2025), so a
    year whose table holds under half of the refresh's fullest is skipped."""
    fv = pd.read_parquet(os.path.join(orion_dir, "finalval.parquet"),
                         columns=["PropertyID", "TaxYear", "FinalBuilding"])
    counts = fv["TaxYear"].value_counts()
    if counts.get(ty, 0) < 0.5 * counts.max():
        return {"tax_year": int(ty), "n": 0,
                "note": f"valuation table incomplete for tax year {ty} ({int(counts.get(ty, 0)):,} rows "
                        f"against {int(counts.max()):,} in the refresh's fullest year)"}, None
    prop = pd.read_parquet(os.path.join(orion_dir, "property.parquet"),
                           columns=["PropertyID", "TaxYear", "GeoCodeSearch"])
    prop = prop[prop["TaxYear"] == ty].drop_duplicates("GeoCodeSearch")
    prop["parcel_id"] = prop["GeoCodeSearch"].astype(str)
    f = fv[fv["TaxYear"] == ty].drop_duplicates("PropertyID")
    f["final_building"] = _num(f["FinalBuilding"])
    j = (pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"),
                         columns=["parcel_id", "build_value", "improved", "is_common_area", "county_n"])
         .merge(prop[["parcel_id", "PropertyID"]], on="parcel_id", how="inner")
         .merge(f[["PropertyID", "final_building"]], on="PropertyID", how="inner"))
    j = j[(j["improved"] >= 0) & ~j["is_common_area"].to_numpy(dtype=bool)]
    bv = j["build_value"].fillna(0).to_numpy()
    fb = j["final_building"].fillna(0).to_numpy()
    j["_eq"] = np.abs(bv - fb) <= 1
    jc = j[j["county_n"].notna()].copy()
    jc["county_n"] = jc["county_n"].astype("int16")
    per = pd.concat([jc.groupby("county_n")["_eq"].agg(value_n="size", value_equal="sum"),
                     jc.assign(county_n=0).groupby("county_n")["_eq"].agg(value_n="size", value_equal="sum")])
    per = per.reset_index()
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(fb > 0, bv / fb, np.nan)
    either = (bv > 0) | (fb > 0)
    return {
        "tax_year": int(ty), "date": date, "n": int(len(j)),
        "parcels_with_either_value": int(either.sum()),
        "equal_within_1_dollar": int((np.abs(bv - fb) <= 1).sum()),
        "equal_within_1_dollar_where_either_positive": int((either & (np.abs(bv - fb) <= 1)).sum()),
        "within_1_pct": int((np.abs(bv - fb) <= 0.01 * np.maximum(fb, 1)).sum()),
        "layer_positive_dor_zero": int(((bv > 0) & (fb <= 0)).sum()),
        "dor_positive_layer_zero": int(((fb > 0) & (bv <= 0)).sum()),
        "layer_higher_by_10_pct": int((bv > 1.1 * fb).sum() - ((bv > 0) & (fb <= 0)).sum()),
        "layer_lower_by_10_pct": int(((bv < 0.9 * fb) & (bv > 0)).sum()),
        "ratio_where_both_positive": _quant(pd.Series(ratio[(bv > 0) & (fb > 0)])),
        "note": "the parcel layer's TotalBuildingValue against ORION FinalVal.FinalBuilding for the "
                "same tax year, parcels matched on geocode; improved flag unknown (2009-07) and "
                "common areas excluded.",
    }, per


def transitions(prev: pd.DataFrame, cur: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """The same dwelling rated at two consecutive points: single-dwelling
    properties present in both, followed through PropertyID (ResID is re-keyed
    between tax years). Per county of the later frame, plus statewide, and the
    full 8 x 8 flow statewide for the QA record."""
    cols = ["PropertyID", "n_dwell", "cond", "yb_res", "county_n", "has_dwelling"]
    a = prev.loc[prev["has_dwelling"] & (prev["n_dwell"] == 1) & (prev["cond"] >= 0) & (prev["PropertyID"] > 0), cols]
    b = cur.loc[cur["has_dwelling"] & (cur["n_dwell"] == 1) & (cur["cond"] >= 0) & (cur["PropertyID"] > 0), cols]
    m = (a.drop_duplicates("PropertyID").set_index("PropertyID")[["cond", "yb_res"]]
         .join(b.drop_duplicates("PropertyID").set_index("PropertyID")[["cond", "yb_res", "county_n"]],
               lsuffix="_a", rsuffix="_b", how="inner"))
    m = m[m["county_n"].notna()].copy()
    m["county_n"] = m["county_n"].astype("int16")
    d = m["cond_b"].astype(int) - m["cond_a"].astype(int)
    m["_same"] = d == 0; m["_worse"] = d < 0; m["_better"] = d > 0
    m["_worse2"] = d <= -2; m["_better2"] = d >= 2
    m["_yb"] = (m["yb_res_a"] != m["yb_res_b"]) & m["yb_res_a"].notna() & m["yb_res_b"].notna()
    parts = []
    for fr in (m, m.assign(county_n=0)):
        g = fr.groupby("county_n")
        parts.append(pd.DataFrame({"n": g.size(), "same": g["_same"].sum(), "worse": g["_worse"].sum(),
                                   "better": g["_better"].sum(), "worse2plus": g["_worse2"].sum(),
                                   "better2plus": g["_better2"].sum(), "yb_changed": g["_yb"].sum()}))
    out = pd.concat(parts).sort_index()
    out.index.name = "county_n"
    flow = pd.crosstab(m["cond_a"], m["cond_b"]).reindex(index=range(8), columns=range(8), fill_value=0)
    qa = {"dwellings_followed": int(len(m)), "same": int(m["_same"].sum()), "worse": int(m["_worse"].sum()),
          "better": int(m["_better"].sum()), "year_built_changed": int(m["_yb"].sum()),
          "flow_rows_from_cols_to": flow.to_numpy().tolist()}
    return out.reset_index(), qa


# ----------------------------------------------------------------- tables
def _cond_counts(frame: pd.DataFrame, key: str) -> pd.DataFrame:
    dw = frame[frame["has_dwelling"]]
    t = pd.crosstab(dw[key], dw["cond"]).reindex(columns=range(-1, len(CONDITION_CODES)), fill_value=0)
    t.columns = ["n_cd_none"] + [f"n_cd{i}" for i in range(len(CONDITION_CODES))]
    yb = pd.cut(dw["yb_res"], bins=YB_EDGES, labels=range(len(YB_LABELS)), right=False)
    y = pd.crosstab(dw[key], yb).reindex(columns=range(len(YB_LABELS)), fill_value=0)
    y.columns = [f"n_yb{i}" for i in range(len(YB_LABELS))]
    g = dw.groupby(key)
    base = pd.DataFrame({
        "dwellings": g.size(), "rated": g["cond"].apply(lambda s: int((s >= 0).sum())),
        "yb_median": g["yb_res"].median(), "mh": g["any_mh"].sum(),
        "condo_th": g["any_condo_th"].sum(), "partial": g["any_partial"].sum(),
        "n_dwell_total": g["n_dwell"].sum(),
    })
    return base.join(t).join(y)


def _witness_counts(frame: pd.DataFrame, key: str, dates: list[str], ty: int) -> pd.DataFrame:
    yrs = np.array([_year_of(d) for d in dates])
    latest = len(dates) - 1
    f = frame[~frame["is_common_area"].to_numpy(dtype=bool) & (frame["improved"].to_numpy() >= 0)].copy()
    imp = f["improved"].to_numpy() == 1
    st = f["has_structure"].to_numpy()
    dw = f["has_dwelling"].to_numpy()
    hn = f["has_house_number"].to_numpy(dtype=bool)
    f["_imp"] = imp; f["_st"] = st; f["_dw"] = dw
    f["_both"] = imp & st; f["_layer_only"] = imp & ~st; f["_dor_only"] = ~imp & st
    f["_hn_dw"] = hn & dw; f["_hn_nodw"] = hn & ~dw; f["_nohn_dw"] = ~hn & dw
    dorm = (f["dev_stage"].to_numpy() == 0) & (f["first_idx"].to_numpy() > 0) & (f["acres"].to_numpy() < 40)
    f["_dorm"] = dorm; f["_dorm_dw"] = dorm & dw; f["_dorm_st"] = dorm & st
    f["_dorm_permit"] = dorm & (f["n_dwelling_permits"].to_numpy() > 0)
    s1 = f["dev_stage"].to_numpy() == 1
    f["_s1"] = s1; f["_s1_dw"] = s1 & dw
    roll = np.array([_roll_year(d) for d in dates])
    yb = f["yb_res"].to_numpy()
    tim = dw & ~np.isnan(yb) & (yb >= 2004) & (yb <= yrs[latest] - 1)
    fbi = f["first_built_idx"].to_numpy()
    dd = np.where(fbi >= 0, roll[np.clip(fbi, 0, latest)] - (yb + 1), np.nan)
    f["_tim"] = tim; f["_tim_never"] = tim & (fbi < 0)
    f["_tim_lag"] = np.where(tim & (fbi >= 0), dd, np.nan)
    f["_tim_ontime"] = tim & (dd <= 0)
    born = (f["first_idx"].to_numpy() > 0) & dw & ~np.isnan(yb) & f["creation"].isin(NEW_LOT).to_numpy()
    byear = yrs[np.clip(f["first_idx"].to_numpy(), 0, latest)]
    f["_born_dw"] = born; f["_born_older"] = born & (yb < byear - 1)
    li = f["last_insp_year"].to_numpy()
    f["_insp_recent"] = dw & (li >= ty - INSPECTION_RECENT_YEARS)
    fbv = f["final_building"].to_numpy()
    bv = f["build_value"].fillna(0).to_numpy()
    f["_val_n"] = imp & ~np.isnan(fbv)
    f["_val_eq"] = imp & ~np.isnan(fbv) & (np.abs(bv - np.nan_to_num(fbv)) <= 1)
    at = f["addr_tested"].to_numpy(dtype=bool)
    pt = f["n_addr_num"].to_numpy() > 0
    rp = f["n_addr_res"].to_numpy() > 0
    f["_addr_t"] = at
    f["_a_hn_pt"] = at & hn & pt; f["_a_hn_nopt"] = at & hn & ~pt; f["_a_pt_nohn"] = at & ~hn & pt
    f["_a_dw_res"] = at & dw & rp; f["_a_dw_nores"] = at & dw & ~rp; f["_a_res_nodw"] = at & ~dw & rp
    g = f.groupby(key)
    cols = {
        "parcels_tested": g.size(), "improved_layer": g["_imp"].sum(), "struct_dor": g["_st"].sum(),
        "agree_built": g["_both"].sum(), "layer_only": g["_layer_only"].sum(), "dor_only": g["_dor_only"].sum(),
        "hn_dwell": g["_hn_dw"].sum(), "hn_nodwell": g["_hn_nodw"].sum(), "nohn_dwell": g["_nohn_dw"].sum(),
        "dormant_lt40": g["_dorm"].sum(), "dormant_dwell": g["_dorm_dw"].sum(),
        "dormant_struct": g["_dorm_st"].sum(), "dormant_permit": g["_dorm_permit"].sum(),
        "stage1": g["_s1"].sum(), "stage1_dwell": g["_s1_dw"].sum(),
        "timing_n": g["_tim"].sum(), "timing_never": g["_tim_never"].sum(),
        "timing_ontime": g["_tim_ontime"].sum(), "timing_lag_median": g["_tim_lag"].median(),
        "born_dwell": g["_born_dw"].sum(), "born_older": g["_born_older"].sum(),
        "insp_recent": g["_insp_recent"].sum(),
        "value_n": g["_val_n"].sum(), "value_equal": g["_val_eq"].sum(),
        "addr_tested": g["_addr_t"].sum(), "addr_hn_pt": g["_a_hn_pt"].sum(), "addr_hn_nopt": g["_a_hn_nopt"].sum(),
        "addr_pt_nohn": g["_a_pt_nohn"].sum(), "addr_dw_res": g["_a_dw_res"].sum(),
        "addr_dw_nores": g["_a_dw_nores"].sum(), "addr_res_nodw": g["_a_res_nodw"].sum(),
    }
    return pd.DataFrame(cols)


def county_table(j: pd.DataFrame, dates: list[str], ty: int) -> pd.DataFrame:
    """Per county plus a statewide row (county_n 0), as the holdings cube does."""
    j = j[j["county_n"].notna()].copy()
    j["county_n"] = j["county_n"].astype("int16")
    parts = []
    for key_frame in (j, j.assign(county_n=0)):
        parts.append(_cond_counts(key_frame, "county_n").join(_witness_counts(key_frame, "county_n", dates, ty)))
    out = pd.concat(parts).sort_index()
    out.index.name = "county_n"
    return out.reset_index()


def township_table(j: pd.DataFrame, dates: list[str], ty: int) -> pd.DataFrame:
    jj = j[j["tr_key"].notna()].copy()
    # dominant county per township, for the county report's township ranking
    dom = (jj.groupby(["tr_key", "county_n"]).size().reset_index(name="n")
           .sort_values(["tr_key", "n"], ascending=[True, False]).drop_duplicates("tr_key")
           .set_index("tr_key")["county_n"])
    out = _cond_counts(jj, "tr_key").join(
        _witness_counts(jj, "tr_key", dates, ty)[["parcels_tested", "improved_layer", "struct_dor",
                                                   "agree_built", "layer_only", "dor_only",
                                                   "addr_tested", "addr_hn_pt", "addr_hn_nopt",
                                                   "addr_dw_res", "addr_dw_nores"]])
    out["county_n"] = dom.reindex(out.index).fillna(0).astype("int16")
    out.index.name = "tr_key"
    return out.reset_index()


def timing_table(j: pd.DataFrame, dates: list[str]) -> pd.DataFrame:
    """Year-built cohort x county: how soon the ladder saw the dwelling."""
    yrs = np.array([_year_of(d) for d in dates])
    latest = len(dates) - 1
    f = j[~j["is_common_area"].to_numpy(dtype=bool) & (j["improved"].to_numpy() >= 0)
          & j["has_dwelling"].to_numpy() & j["yb_res"].notna().to_numpy() & j["county_n"].notna().to_numpy()].copy()
    f = f[(f["yb_res"] >= 2004) & (f["yb_res"] <= yrs[latest] - 1)]
    roll = np.array([_roll_year(d) for d in dates])
    fbi = f["first_built_idx"].to_numpy()
    fai = f["first_addr_idx"].to_numpy()
    yb = f["yb_res"].to_numpy()
    d = np.where(fbi >= 0, roll[np.clip(fbi, 0, latest)] - (yb + 1), np.nan)
    alag = np.where(fai >= 0, yrs[np.clip(fai, 0, latest)] - yb, np.nan)
    f["_never"] = fbi < 0
    f["_le0"] = d < 0; f["_l1"] = d == 0; f["_l2"] = d == 1; f["_l3"] = d >= 2
    f["_abefore"] = alag < 0
    f["yb"] = f["yb_res"].astype("int16")
    f["county_n"] = f["county_n"].astype("int16")
    parts = []
    for fr in (f, f.assign(county_n=0)):
        g = fr.groupby(["county_n", "yb"])
        parts.append(pd.DataFrame({
            "dwellings": g.size(), "never": g["_never"].sum(), "earlier": g["_le0"].sum(),
            "on_time": g["_l1"].sum(), "late1": g["_l2"].sum(), "late2plus": g["_l3"].sum(),
            "address_before": g["_abefore"].sum()}))
    return pd.concat(parts).sort_index().reset_index()


def condition_by_decade(j: pd.DataFrame) -> pd.DataFrame:
    f = j[j["has_dwelling"].to_numpy() & (j["cond"].to_numpy() >= 0) & j["county_n"].notna().to_numpy()].copy()
    f["yb_bin"] = pd.cut(f["yb_res"], bins=YB_EDGES, labels=range(len(YB_LABELS)), right=False)
    f = f[f["yb_bin"].notna()]
    f["yb_bin"] = f["yb_bin"].astype("int8")
    f["county_n"] = f["county_n"].astype("int16")
    parts = []
    for fr in (f, f.assign(county_n=0)):
        parts.append(fr.groupby(["county_n", "yb_bin", "cond"]).size().rename("dwellings").reset_index())
    out = pd.concat(parts, ignore_index=True)
    out["cond"] = out["cond"].astype("int8")
    return out


# ------------------------------------------------------------------- main
def _compact(w: dict) -> dict:
    w = dict(w)
    w.pop("ladder_timing_by_year", None)        # published as cama_timing
    return w


def build(snap_dir: str = SNAP_DIR, event_dir: str = EVENT_DIR, loc_dir: str = LOC_DIR,
          caches: tuple[str, ...] = ORION_CACHES, out_dir: str = OUT_DIR) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    dates = _dates(snap_dir)
    series = discover_series(snap_dir, caches)
    if not series:
        raise SystemExit("no ORION cache covers any snapshot")
    log.info("series: %s", ", ".join(f"{p['tax_year']}->{p['date']} ({p['cache']})" for p in series))

    log.info("ladder history over %s vintages", len(dates))
    hist = ladder_history(snap_dir, dates)
    cls = creation_class(event_dir)

    keep = ["parcel_id", "county_n", "tr_key", "acres", "improved", "has_house_number", "dev_stage",
            "is_common_area", "first_idx", "creation", "first_built_idx", "first_addr_idx", "PropertyID",
            "PropType", "n_dwell", "yb_res", "yb_any", "cond", "phy", "cond_min", "util", "pdes", "ldes",
            "cdu", "grade", "res_type", "pct_good", "sfla", "eff_year", "remod_year", "any_mh",
            "any_condo_th", "any_partial", "n_com", "n_oby", "oby_value", "final_building",
            "final_land", "val_method", "n_permits", "n_dwelling_permits",
            "first_dwelling_permit_year", "last_permit_year", "last_insp_year", "n_inspections",
            "has_dwelling", "has_structure", "build_value",
            "n_addr_num", "n_addr_res", "n_addr_mh", "n_addr_unit", "addr_tested"]
    cty_parts, twp_parts, tim_parts, cbd_parts, tr_parts = [], [], [], [], []
    points, trans_qa = [], []
    prev = None
    for pt in series:
        ty, date, idx, cache = pt["tax_year"], pt["date"], pt["snap_idx"], pt["cache"]
        log.info("== tax year %s <- %s, export %s (snapshot %s)", ty, cache, date, idx)
        bld, bqa = building_records(cache, ty)
        j, jqa = parcel_frame(date, snap_dir, event_dir, loc_dir, hist, bld, cls, snap_idx=idx)
        pf = j[keep].copy()
        pf["PropertyID"] = pf["PropertyID"].fillna(0).astype("int64")
        pf.to_parquet(os.path.join(out_dir, f"parcels_cama_{date}.parquet"), index=False, compression="zstd")
        sub = dates[:idx + 1]
        w = witness(j, sub, ty)
        w.pop("building_value_witness", None)       # the in-frame one is the sparse join; replaced below
        w["building_value_witness"], value_by_county = value_witness(snap_dir, cache, ty, date)
        cty = county_table(j, sub, ty)
        if value_by_county is not None:
            cty = (cty.drop(columns=["value_n", "value_equal"])
                   .merge(value_by_county, on="county_n", how="left"))
        else:
            cty["value_n"] = 0
            cty["value_equal"] = 0
        cty[["value_n", "value_equal"]] = cty[["value_n", "value_equal"]].fillna(0).astype("int64")
        twp = township_table(j, sub, ty)
        tim = timing_table(j, sub)
        cbd = condition_by_decade(j)
        st = cty[cty["county_n"] == 0].iloc[0]
        assert int(st["dwellings"]) == int(j["has_dwelling"].sum()), f"{ty}: statewide dwellings do not reconcile"
        assert int(st["parcels_tested"]) == w["parcels_tested"], f"{ty}: witness base does not reconcile"
        for frame, sink in ((cty, cty_parts), (twp, twp_parts), (tim, tim_parts), (cbd, cbd_parts)):
            frame["s"] = np.int8(idx)
            sink.append(frame)
        if prev is not None:
            tr, tq = transitions(prev["j"], j)
            tr["s_from"] = np.int8(prev["idx"]); tr["s"] = np.int8(idx)
            tr_parts.append(tr)
            tq.update({"from_tax_year": prev["ty"], "to_tax_year": ty,
                       "from_rating_field": prev["field"], "to_rating_field": bqa["rating_field"]})
            trans_qa.append(tq)
            log.info("   transitions %s -> %s: %s followed, %.1f%% same, %.1f%% worse, %.1f%% better",
                     prev["ty"], ty, f"{tq['dwellings_followed']:,}",
                     100 * tq["same"] / max(1, tq["dwellings_followed"]),
                     100 * tq["worse"] / max(1, tq["dwellings_followed"]),
                     100 * tq["better"] / max(1, tq["dwellings_followed"]))
        iw = w["improvement_witness"]
        log.info("   improvement witness %.2f%% agreement; %s rated (%s); dormant with dwelling %s of %s",
                 iw["agreement_pct"], f"{int(st['rated']):,}", bqa["rating_field"],
                 f"{w['dormant_witness']['with_dwelling']:,}", f"{w['dormant_witness']['dormant_lots_under_40ac']:,}")
        points.append({"tax_year": ty, "date": date, "s": idx, "cache": cache,
                       "refresh_date": pt["refresh_date"], "rating_field": bqa["rating_field"],
                       "orion": bqa, "join": jqa, "witness": _compact(w)})
        prev = {"j": j, "idx": idx, "ty": ty, "field": bqa["rating_field"]}

    log.info("tables")
    cty = pd.concat(cty_parts, ignore_index=True)
    twp = pd.concat(twp_parts, ignore_index=True)
    tim = pd.concat(tim_parts, ignore_index=True)
    cbd = pd.concat(cbd_parts, ignore_index=True)
    tr = pd.concat(tr_parts, ignore_index=True) if tr_parts else pd.DataFrame(
        columns=["county_n", "n", "same", "worse", "better", "worse2plus", "better2plus", "yb_changed", "s_from", "s"])
    cty.to_parquet(os.path.join(out_dir, "cama_county.parquet"), index=False, compression="zstd")
    twp.to_parquet(os.path.join(out_dir, "cama_township.parquet"), index=False, compression="zstd")
    tim.to_parquet(os.path.join(out_dir, "cama_timing.parquet"), index=False, compression="zstd")
    cbd.to_parquet(os.path.join(out_dir, "cama_condition_decade.parquet"), index=False, compression="zstd")
    tr.to_parquet(os.path.join(out_dir, "cama_transitions.parquet"), index=False, compression="zstd")

    newest = points[-1]
    qa = {"date": newest["date"], "tax_year": newest["tax_year"],
          "series": [{k: p[k] for k in ("tax_year", "date", "s", "cache", "refresh_date", "rating_field")}
                     for p in points],
          "points": points, "transitions": trans_qa,
          "condition_codes": CONDITION_CODES, "condition_labels": CONDITION_LABELS,
          "year_built_bins": YB_LABELS,
          "rows": {"county": int(len(cty)), "township": int(len(twp)), "timing": int(len(tim)),
                   "condition_decade": int(len(cbd)), "transitions": int(len(tr))},
          "note": ("The DOR's condition rating is CDU, the composite, through tax year 2014 and its "
                   "physical-condition component from 2015, when the composite was retired by copying "
                   "it into the components; each point names its rating_field. Each tax year is joined "
                   "to the parcel export that carries its roll. Three refreshes, eight points; the gap "
                   "between 2018 and 2024 is no refresh on hand.")}
    with open(os.path.join(out_dir, "qa_cama.json"), "w") as fh:
        json.dump(qa, fh, indent=1, default=str)
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Stage 11: DOR building records as a witness and a measure")
    ap.add_argument("--snap-dir", default=SNAP_DIR)
    ap.add_argument("--event-dir", default=EVENT_DIR)
    ap.add_argument("--loc-dir", default=LOC_DIR)
    ap.add_argument("--orion-cache", nargs="+", default=list(ORION_CACHES),
                    help="ORION Parquet caches, newest refresh first")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    build(args.snap_dir, args.event_dir, args.loc_dir, tuple(args.orion_cache), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
