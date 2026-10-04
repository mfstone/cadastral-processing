"""Step 0: the schema-drift probe that gates the whole pipeline.

Twenty-four years of a state agency's exports, four containers and a total
field rename in 2013 mean the design has to be checked against the data before
it hardens. This module answers five questions, each of which can invalidate
part of the plan:

1. **Do duplicate ``PARCELID``s carry differing owner names, or matching ones?**
   A multi-owner join and an exploded multipart geometry call for opposite
   de-duplication rules, and the choice moves every published number. This is
   the single most important unknown.
2. **Geocode length and structural validity** per snapshot -- tested against a
   positional hypothesis rather than blindly sliced.
3. **Does ``TRS`` / ``Township``+``Range``+``Section`` agree with the geocode's
   own parsed township and section?** An independent witness in every era; it
   validates the entire PLSS-primary spatial frame.
4. **Is there a parcel situs (site) city field?** If the Department of Revenue
   already answers "which city is this parcel in", prefer its answer to a
   quarter-section majority join against TIGER places.
5. **Area field null rates and distributions**, ``TotalAcres`` vs ``GISAcres``
   disagreement, the fixed-width ``MAILCITY_S`` parse rate, and per-county
   presence.

Results are written per snapshot so a long run is resumable and partial output
is still usable.
"""

from __future__ import annotations

import gc
import json
import logging
import os
import re
import time

import numpy as np
import pandas as pd
import pyogrio

from cadastral.schema import COUNTY_PREFIX, SQM_TO_ACRES, resolve_columns

from . import sources

log = logging.getLogger("timeseries.probe")

OUT_DIR = "data/probe"

# Logical fields the probe reads. Wider than the production extractor needs,
# but it runs once and its job is to find out what is actually there.
PROBE_FIELDS = [
    "parcel_id", "county_code", "county_code_alpha", "county_name",
    "owner_name", "owner_name_2",
    "owner_state", "owner_city", "owner_citystatezip", "mail_state", "mail_city",
    "area_sqm", "gis_acres", "total_acres",
    "trs", "township", "plss_range", "plss_section",
    "subdivision", "cert_survey", "build_value",
    "owner_class", "owner_gen_descrip", "owner_class_code",
    "tax_year", "rec_year", "card_no",
    "situs_city", "situs_citystatezip",
]

# The positional hypothesis from MSL's own documentation, e.g.
# 18 1082 07 1 01 01 0000 -> county, township-code, section, quarter, block,
# lot, unit. Quarter is NE=1 NW=2 SW=3 SE=4, with 0 seen for whole-section.
GEOCODE_RE = re.compile(
    r"^(\d{2})(\d{4})(\d{2})([0-9])([0-9A-Z]{2})([0-9A-Z]{2})([0-9A-Z]{4})$"
)
# The locating prefix on its own: county(2) township(4) section(2) quarter(1).
# Anything matching this can be placed, whatever the tail looks like.
GEOCODE_PREFIX_RE = re.compile(r"^(\d{2})(\d{4})(\d{2})([0-9])")
TRS_RE = re.compile(r"^T(\d+)\s*([NS])\s*R(\d+)\s*([EW])\s*S(\d+)", re.IGNORECASE)

MAX_SAMPLES = 5

# Literal stand-ins for "no value" seen in the parcel-id column. Structural
# validation catches the numeric filler patterns (e.g. 03888844444444444, whose
# section digits read 44) without enumeration; these are the non-numeric ones.
PID_SENTINELS = {"NA", "N/A", "NULL", "NONE", "NAN", "0", "UNKNOWN", "."}


def geocode_validity(pid_upper: pd.Series) -> tuple[pd.DataFrame, np.ndarray]:
    """Parse the locating prefix and return (parts, is_valid).

    Valid means: the first nine characters are county(2) township(4) section(2)
    quarter(1), the county is a real DOR code 1-56, the section is 1-36 and the
    quarter is 0-4. Everything else is quarantined and counted -- never coerced,
    and never silently dropped.
    """
    parts = pid_upper.str.extract(GEOCODE_PREFIX_RE)
    parts.columns = ["county", "twp_code", "section", "quarter"]
    county = pd.to_numeric(parts["county"], errors="coerce")
    section = pd.to_numeric(parts["section"], errors="coerce")
    quarter = pd.to_numeric(parts["quarter"], errors="coerce")
    ok = (
        np.asarray(parts["county"].notna(), dtype=bool)
        & np.asarray(county.between(1, 56).fillna(False), dtype=bool)
        & np.asarray(section.between(1, 36).fillna(False), dtype=bool)
        & np.asarray(quarter.between(0, 4).fillna(False), dtype=bool)
        & ~np.asarray(pid_upper.isin(PID_SENTINELS), dtype=bool)
    )
    return parts, ok


def _json_safe(obj):
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        v = float(obj)
        return None if (np.isnan(v) or np.isinf(v)) else v
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, dict):
        return {str(k): _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def _s(df: pd.DataFrame, col: str | None) -> pd.Series | None:
    """Trimmed, NA-free, numpy-backed string view -- or None if absent.

    Blank and null are treated identically everywhere in this probe, so NA is
    collapsed to "" here rather than at twenty call sites. That also keeps every
    downstream comparison on numpy bools: under pandas 3.0, ``&`` between a
    masked BooleanArray and an Arrow-backed boolean raises "boolean value of NA
    is ambiguous", and this is the one place to prevent it.
    """
    if not col or col not in df.columns:
        return None
    return df[col].astype("string").str.strip().fillna("").astype("object")


def _num(df: pd.DataFrame, col: str | None) -> pd.Series | None:
    if not col or col not in df.columns:
        return None
    return pd.to_numeric(df[col], errors="coerce").astype("float64")


def _describe_numeric(s: pd.Series | None, scale: float = 1.0) -> dict | None:
    if s is None:
        return None
    v = s * scale
    nn = v.notna()
    return {
        "present": int(nn.sum()),
        "null": int((~nn).sum()),
        "zero": int((v == 0).sum()),
        "negative": int((v < 0).sum()),
        "median": None if not nn.any() else float(v[nn].median()),
        "mean": None if not nn.any() else float(v[nn].mean()),
        "max": None if not nn.any() else float(v[nn].max()),
        "min": None if not nn.any() else float(v[nn].min()),
    }


# ---------------------------------------------------------------- question 1
def _q1_duplicate_anatomy(pid: pd.Series, owner: pd.Series | None,
                          owner2: pd.Series | None, area: pd.Series | None,
                          card: pd.Series | None) -> dict:
    """Why does a PARCELID repeat: co-owners, or exploded geometry?

    Counted over parcels with more than one row. "names differ" implies the
    layer is a parcel-to-owner join and collapsing it would destroy real
    co-ownership; "names identical" implies multipart geometry exploded to
    rows, where collapsing is pure gain.
    """
    counts = pid.value_counts()
    dup_ids = counts.index[counts > 1]
    out: dict = {
        "n_dup_parcel_ids": int(len(dup_ids)),
        "n_dup_rows": int(counts[counts > 1].sum() - len(dup_ids)),
        "max_rows_per_parcel": int(counts.max()) if len(counts) else 0,
    }
    if len(dup_ids) == 0 or owner is None:
        out["verdict"] = "no duplicates" if len(dup_ids) == 0 else "no owner column"
        return out

    mask = pid.isin(pd.Index(dup_ids))
    sub = pd.DataFrame({"pid": pid[mask], "owner": owner[mask].fillna("")})
    if owner2 is not None:
        sub["owner2"] = owner2[mask].fillna("")
    if area is not None:
        sub["area"] = area[mask]
    if card is not None:
        sub["card"] = card[mask].astype("string").fillna("")

    g = sub.groupby("pid", sort=False)
    n_owner_distinct = g["owner"].nunique()
    names_differ = int((n_owner_distinct > 1).sum())
    names_same = int((n_owner_distinct == 1).sum())
    out["parcels_with_differing_owner_name"] = names_differ
    out["parcels_with_identical_owner_name"] = names_same
    out["pct_differing"] = round(100.0 * names_differ / max(1, len(dup_ids)), 2)

    if "owner2" in sub:
        n2 = g["owner2"].nunique()
        out["parcels_with_differing_owner_name_2"] = int((n2 > 1).sum())
    if "area" in sub:
        spread = g["area"].agg(lambda x: float(x.max() - x.min()) if x.notna().any() else np.nan)
        out["parcels_with_differing_area"] = int((spread.fillna(0) > 0.01).sum())
    if "card" in sub:
        out["parcels_with_differing_card_no"] = int((g["card"].nunique() > 1).sum())

    # The verdict is what the de-dup rule turns on. A fraction of a percent is
    # noise, not a second mechanism, so the thresholds are banded rather than
    # testing for exactly zero.
    pct = out["pct_differing"]
    if pct < 1.0:
        out["verdict"] = "exploded_geometry"
    elif pct < 10.0:
        out["verdict"] = "predominantly_exploded_geometry"
    elif pct > 99.0:
        out["verdict"] = "owner_join"
    else:
        out["verdict"] = "mixed"
    out["verdict_detail"] = (
        f"{names_differ:,} of {len(dup_ids):,} duplicated parcels have differing owner "
        f"names ({pct}%); {out.get('parcels_with_differing_area', 0):,} have differing area"
    )

    samples = []
    for kind, ids in (("differing", n_owner_distinct.index[n_owner_distinct > 1]),
                      ("identical", n_owner_distinct.index[n_owner_distinct == 1])):
        for pid_val in list(ids)[:MAX_SAMPLES]:
            rows = sub[sub["pid"] == pid_val]
            samples.append({
                "kind": kind,
                "parcel_id": str(pid_val),
                "n_rows": int(len(rows)),
                "owners": [str(x) for x in rows["owner"].tolist()[:4]],
                "areas": ([None if pd.isna(a) else round(float(a), 2)
                           for a in rows["area"].tolist()[:4]] if "area" in rows else None),
            })
    out["samples"] = samples
    return out


# ---------------------------------------------------------------- question 2
def _q2_geocode(pid_nonblank: pd.Series) -> dict:
    lengths = pid_nonblank.str.len().value_counts().sort_index()
    out: dict = {
        "length_histogram": {int(k): int(v) for k, v in lengths.items()},
        "n": int(len(pid_nonblank)),
    }
    m = pid_nonblank.str.extract(GEOCODE_RE)
    parsed = m[0].notna()
    out["n_matches_positional_pattern"] = int(parsed.sum())
    out["pct_matches"] = round(100.0 * parsed.mean(), 4) if len(pid_nonblank) else 0.0
    # Separately: can it be LOCATED? Only the first 9 chars matter for that.
    pre = pid_nonblank.str.extract(GEOCODE_PREFIX_RE)
    locatable = pre[0].notna()
    out["n_locatable_prefix"] = int(locatable.sum())
    out["pct_locatable_prefix"] = round(100.0 * locatable.mean(), 4) if len(pid_nonblank) else 0.0
    out["n_locatable_but_nonconforming_tail"] = int((locatable & ~parsed).sum())
    out["tail_nonconforming_samples"] = [
        str(x) for x in pid_nonblank[locatable & ~parsed].head(MAX_SAMPLES).tolist()
    ]

    ok = m[parsed]
    if len(ok):
        county = pd.to_numeric(ok[0], errors="coerce")
        section = pd.to_numeric(ok[2], errors="coerce")
        quarter = pd.to_numeric(ok[3], errors="coerce")
        out["county_out_of_range_1_56"] = int((~county.between(1, 56)).sum())
        out["section_out_of_range_1_36"] = int((~section.between(1, 36)).sum())
        out["quarter_value_counts"] = {str(k): int(v) for k, v in
                                       ok[3].value_counts().sort_index().items()}
        out["quarter_out_of_range_0_4"] = int((~quarter.between(0, 4)).sum())
        out["n_nonzero_unit"] = int((ok[6] != "0000").sum())
        out["distinct_township_codes"] = int(ok[1].nunique())
        out["distinct_county_township"] = int((ok[0] + ok[1]).nunique())
        out["distinct_sections"] = int((ok[0] + ok[1] + ok[2]).nunique())
        out["distinct_quarter_sections"] = int((ok[0] + ok[1] + ok[2] + ok[3]).nunique())
        out["distinct_blocks"] = int((ok[0] + ok[1] + ok[2] + ok[3] + ok[4]).nunique())
        # A township code under two county prefixes is either a genuine
        # cross-county township or a code collision; they need opposite handling.
        per_code = ok.groupby(1)[0].nunique()
        out["township_codes_spanning_counties"] = int((per_code > 1).sum())

    bad = pid_nonblank[~parsed]
    out["nonconforming_samples"] = [str(x) for x in bad.head(MAX_SAMPLES * 2).tolist()]
    if len(bad):
        # For short forms: is the truncation upstream of position 9? If so the
        # quarter-section key is unrecoverable and those rows must be excluded.
        out["nonconforming_by_length"] = {
            int(k): int(v) for k, v in bad.str.len().value_counts().sort_index().items()
        }
        out["nonconforming_nonnumeric"] = int((~bad.str.fullmatch(r"\d+", na=False)).sum())
    return out


# ---------------------------------------------------------------- question 3
def _q3_plss_witness(pid_ok: pd.Series, trs: pd.Series | None,
                     twp: pd.Series | None, rng: pd.Series | None,
                     sec: pd.Series | None) -> dict:
    """Compare the geocode's parsed section/township with the row's own PLSS text."""
    out: dict = {}
    m = pid_ok.str.extract(GEOCODE_RE)
    code = m[1]
    geo_sec = pd.to_numeric(m[2], errors="coerce")

    tr_label = None
    if trs is not None and (trs != "").any():
        out["source"] = "TRS"
        parts = trs.str.extract(TRS_RE)
        got = parts[0].notna()
        out["trs_present"] = int((trs != "").sum())
        out["trs_parsed"] = int(got.sum())
        out["trs_parse_rate"] = round(100.0 * got.mean(), 3)
        out["trs_samples"] = [str(x) for x in trs[trs != ""].head(MAX_SAMPLES).tolist()]
        trs_sec = pd.to_numeric(parts[4], errors="coerce")
        cmp_mask = got & geo_sec.notna() & trs_sec.notna()
        if cmp_mask.any():
            agree = (trs_sec[cmp_mask] == geo_sec[cmp_mask])
            out["section_agreement_pct"] = round(100.0 * agree.mean(), 3)
            out["section_compared"] = int(cmp_mask.sum())
            out["section_disagree_samples"] = [
                {"parcel_id": str(p), "trs": str(t), "geocode_section": int(g)}
                for p, t, g in list(zip(pid_ok[cmp_mask][~agree].head(MAX_SAMPLES),
                                        trs[cmp_mask][~agree].head(MAX_SAMPLES),
                                        geo_sec[cmp_mask][~agree].head(MAX_SAMPLES)))
            ]
        tr_label = (parts[0].str.zfill(3) + parts[1].str.upper()
                    + parts[2].str.zfill(3) + parts[3].str.upper())
        tr_label = tr_label.str.replace(r"\s+", "", regex=True)
    elif twp is not None and sec is not None:
        out["source"] = "Township/Range/Section"
        t_sec = pd.to_numeric(sec, errors="coerce")
        cmp_mask = t_sec.notna() & geo_sec.notna()
        out["section_compared"] = int(cmp_mask.sum())
        if cmp_mask.any():
            agree = (t_sec[cmp_mask] == geo_sec[cmp_mask])
            out["section_agreement_pct"] = round(100.0 * agree.mean(), 3)
            out["section_disagree_samples"] = [
                {"parcel_id": str(p), "section_attr": str(a), "geocode_section": int(g)}
                for p, a, g in list(zip(pid_ok[cmp_mask][~agree].head(MAX_SAMPLES),
                                        sec[cmp_mask][~agree].head(MAX_SAMPLES),
                                        geo_sec[cmp_mask][~agree].head(MAX_SAMPLES)))
            ]
        out["township_samples"] = [str(x) for x in twp[twp != ""].head(MAX_SAMPLES).tolist()]
        out["range_samples"] = ([str(x) for x in rng[rng != ""].head(MAX_SAMPLES).tolist()]
                                if rng is not None else None)
        if rng is not None:
            # "27 N" and "27N" are the same township; normalise hard.
            _t = twp.str.upper().str.replace(r"\s+", "", regex=True)
            _r = rng.str.upper().str.replace(r"\s+", "", regex=True)
            tr_label = _t + "|" + _r
    else:
        out["source"] = None
        return out

    # Is the 4-digit township code a 1:1 stand-in for township+range?
    if tr_label is not None:
        ok = code.notna() & (tr_label != "|") & (tr_label != "")
        if ok.any():
            per_code = pd.DataFrame({"code": code[ok], "tr": tr_label[ok]}).groupby("code")["tr"].nunique()
            per_tr = pd.DataFrame({"code": code[ok], "tr": tr_label[ok]}).groupby("tr")["code"].nunique()
            out["distinct_codes"] = int(len(per_code))
            out["distinct_tr_pairs"] = int(len(per_tr))
            out["codes_mapping_to_multiple_tr"] = int((per_code > 1).sum())
            out["tr_pairs_mapping_to_multiple_codes"] = int((per_tr > 1).sum())
            out["code_tr_is_one_to_one"] = bool((per_code <= 1).all() and (per_tr <= 1).all())

            pair = pd.DataFrame({"code": code[ok], "tr": tr_label[ok]})
            amb = per_code.index[per_code > 1]
            if len(amb):
                sub = pair[pair["code"].isin(pd.Index(amb))]
                tally = sub.groupby(["code", "tr"]).size().rename("n").reset_index()
                tot = tally.groupby("code")["n"].transform("sum")
                tally["share"] = tally["n"] / tot
                dom = tally.loc[tally.groupby("code")["n"].idxmax()]
                # The real error budget is the MINORITY rows -- the ones a
                # majority vote would reassign -- not every row that happens to
                # sit under an ambiguous code.
                minority = int(len(sub) - dom["n"].sum())
                out["ambiguous_code_dominant_share"] = {
                    "n_ambiguous_codes": int(len(amb)),
                    "rows_under_ambiguous_codes": int(len(sub)),
                    "minority_rows": minority,
                    "pct_minority_of_all_rows": round(100.0 * minority / max(1, int(ok.sum())), 4),
                    "dominant_share_median": round(float(dom["share"].median()), 4),
                    "dominant_share_min": round(float(dom["share"].min()), 4),
                    "codes_with_dominant_ge_99pct": int((dom["share"] >= 0.99).sum()),
                    "codes_with_dominant_ge_90pct": int((dom["share"] >= 0.90).sum()),
                    "codes_with_dominant_lt_60pct": int((dom["share"] < 0.60).sum()),
                }
                worst = dom.nsmallest(MAX_SAMPLES, "share")
                out["ambiguous_code_samples"] = [
                    {"code": str(r.code), "dominant_tr": str(r.tr),
                     "dominant_share": round(float(r.share), 3),
                     "n_distinct_tr": int(per_code[r.code])}
                    for r in worst.itertuples()
                ]
    return out


# ---------------------------------------------------------------- question 4
def _q4_situs(df: pd.DataFrame, res: dict, owner_csz: pd.Series | None,
              owner_city: pd.Series | None = None) -> dict:
    out: dict = {"fields_present": {}}
    for logical in ("situs_number", "situs_street", "situs_city", "situs_zip",
                    "situs_addr_1", "situs_addr_2", "situs_citystatezip"):
        col = res.get(logical)
        s = _s(df, col)
        if s is None:
            continue
        nonblank = (s != "")
        out["fields_present"][logical] = {
            "column": col,
            "non_blank": int(nonblank.sum()),
            "pct_non_blank": round(100.0 * nonblank.mean(), 2),
            "distinct": int(s[nonblank].nunique()),
            "samples": [str(x) for x in s[nonblank].head(MAX_SAMPLES).tolist()],
        }
    # If a situs city and the owner mailing city both exist, how often do they
    # differ? A high rate confirms situs really is the parcel's own location.
    city = _s(df, res.get("situs_city"))
    if city is None and res.get("situs_citystatezip"):
        csz = _s(df, res["situs_citystatezip"])
        city = csz.str.split(",").str[0].str.strip() if csz is not None else None
    own_city = None
    if owner_csz is not None:
        own_city = owner_csz.str.slice(0, 16).str.strip()   # fixed-width era
    elif owner_city is not None:
        own_city = owner_city.str.strip()
    if city is not None and own_city is not None:
        both = (city != "") & (own_city != "")
        if both.any():
            out["situs_vs_owner_city"] = {
                "compared": int(both.sum()),
                "pct_differ": round(100.0 * (city[both].str.upper() != own_city[both].str.upper()).mean(), 2),
            }
    return out


# ---------------------------------------------------------------- question 5
def _q5_area_and_state(df: pd.DataFrame, res: dict, parcel_mask=None) -> dict:
    out: dict = {}
    area_sqm = _num(df, res.get("area_sqm"))
    gis = _num(df, res.get("gis_acres"))
    tot = _num(df, res.get("total_acres"))
    out["area_sqm_as_acres"] = _describe_numeric(area_sqm, SQM_TO_ACRES)
    out["gis_acres"] = _describe_numeric(gis)
    out["total_acres"] = _describe_numeric(tot)
    out["area_field_columns"] = {
        "area_sqm": res.get("area_sqm"), "gis_acres": res.get("gis_acres"),
        "total_acres": res.get("total_acres"),
    }
    # Chosen parcel-area field, by the plan's per-era preference.
    chosen = gis if gis is not None else (area_sqm * SQM_TO_ACRES if area_sqm is not None else None)
    out["chosen_area_field"] = ("gis_acres" if gis is not None
                               else ("area_sqm" if area_sqm is not None else None))
    if chosen is not None:
        out["chosen_total_acres_millions"] = round(float(chosen.sum()) / 1e6, 4)
        out["chosen_sliver_lt_0_001_acre"] = int((chosen > 0).sum() - (chosen >= 0.001).sum())
    if gis is not None and area_sqm is not None:
        a = area_sqm * SQM_TO_ACRES
        both = gis.notna() & a.notna() & (gis > 0)
        if both.any():
            ratio = (a[both] / gis[both])
            out["gis_vs_area_sqm_ratio"] = {
                "compared": int(both.sum()),
                "median": round(float(ratio.median()), 6),
                "pct_within_1pct": round(100.0 * ratio.between(0.99, 1.01).mean(), 3),
            }
    if tot is not None and chosen is not None:
        both = tot.notna() & chosen.notna() & (chosen > 0)
        if both.any():
            out["total_acres_vs_chosen"] = {
                "compared": int(both.sum()),
                "pct_total_acres_zero": round(100.0 * (tot[both] == 0).mean(), 2),
                "median_ratio_where_nonzero": (
                    round(float((tot[both][tot[both] > 0] / chosen[both][tot[both] > 0]).median()), 4)
                    if (tot[both] > 0).any() else None),
            }

    # Which per-parcel aggregation rule is right? Duplicate rows turn out to be
    # exploded multipart geometry (same owner, different polygon part), so SUM
    # is the faithful rule and MAX silently loses the other parts. Reported for
    # every snapshot because the gap IS the denormalization artifact.
    if parcel_mask is not None and chosen is not None and "_pid_for_area" in df:
        ac = chosen[parcel_mask]
        key = df.loc[parcel_mask, "_pid_for_area"]
        grp = pd.DataFrame({"k": key, "ac": ac}).groupby("k")["ac"]
        s_tot, m_tot = float(grp.sum().sum()), float(grp.max().sum())
        out["aggregation_rule"] = {
            "parcels": int(grp.ngroups),
            "sum_rule_Macres": round(s_tot / 1e6, 4),
            "max_rule_Macres": round(m_tot / 1e6, 4),
            "max_rule_loses_Macres": round((s_tot - m_tot) / 1e6, 4),
            "max_rule_loses_pct": round(100.0 * (s_tot - m_tot) / s_tot, 4) if s_tot else None,
        }

    # Owner mailing state, by the era's own mechanism.
    st_col, mech = res.get("owner_state"), "owner_state"
    state = _s(df, st_col)
    if state is None and res.get("mail_state"):
        state, mech = _s(df, res["mail_state"]), "mail_state"
    if state is None and res.get("owner_citystatezip"):
        csz = _s(df, res["owner_citystatezip"])
        # Fixed-width, NOT delimited: city 1-16, state 17-18, ZIP+4 19-27.
        state, mech = csz.str.slice(16, 18).str.strip(), "mailcity_s_fixed_width"
    if state is not None:
        if parcel_mask is not None:
            state = state[parcel_mask]
        out["owner_state_denominator"] = (
            "rows with a non-blank PARCELID" if parcel_mask is not None else "all rows")
        state = state.str.upper()
        valid = np.asarray(state.str.fullmatch(r"[A-Z]{2}", na=False), dtype=bool)
        is_mt = np.asarray(state == "MT", dtype=bool)
        vc = state[valid].value_counts()
        out["owner_state"] = {
            "mechanism": mech,
            "valid_two_letter_pct": round(100.0 * float(valid.mean()), 4),
            "n_valid": int(valid.sum()),
            "pct_MT": round(100.0 * float(is_mt.mean()), 3),
            "pct_out_of_state": round(100.0 * float((valid & ~is_mt).mean()), 3),
            "top_states": {str(k): int(v) for k, v in vc.head(12).items()},
        }
    return out


# ------------------------------------------------------------------ per-snap
def probe_snapshot(snap: sources.Snapshot) -> dict:
    """Probe one snapshot, staging the container first where that is needed."""
    t0 = time.time()
    with snap.local() as src:
        return _probe_open(src, snap, t0)


def _probe_open(snap: sources.Snapshot, orig: sources.Snapshot, t0: float) -> dict:
    info = snap.info()
    columns = list(info.get("fields", []))
    res = resolve_columns(columns)

    want = [res[f] for f in PROBE_FIELDS if res.get(f)]
    want = list(dict.fromkeys(want))
    df = snap.read(columns=want)
    t_read = time.time() - t0

    rec: dict = {
        "date": snap.date, "era": snap.era, "container": snap.container,
        "layer": snap.layer, "vsi": orig.vsi, "zip_bytes": orig.zip_bytes,
        "staged": snap.vsi != orig.vsi,
        "excluded": snap.excluded, "exclude_reason": snap.exclude_reason,
        "read_seconds": round(t_read, 1),
        "crs": str(info.get("crs")), "geometry_type": str(info.get("geometry_type")),
        "feature_count": int(info.get("features", 0)),
        "n_columns": len(columns), "columns": columns,
        "resolved": {k: v for k, v in res.items() if v},
        "unresolved_probe_fields": [f for f in PROBE_FIELDS if not res.get(f)],
    }

    pid_col = res.get("parcel_id")
    if not pid_col:
        rec["fatal"] = "no parcel_id column"
        return rec

    pid = _s(df, pid_col)
    blank = (pid == "")
    nonblank = pid[~blank]
    nonblank_u = nonblank.str.upper()
    _parts, valid = geocode_validity(nonblank_u)
    valid_ids = nonblank[valid]
    rec["counts"] = {
        "rows": int(len(df)),
        "parcel_id_blank_or_null": int(blank.sum()),
        "pct_blank": round(100.0 * blank.mean(), 3),
        "parcel_id_non_blank": int(len(nonblank)),
        "parcel_id_distinct": int(nonblank.nunique()),
        "duplicate_rows": int(len(nonblank) - nonblank.nunique()),
        # the analysable subset, after structural quarantine
        "parcel_id_quarantined": int((~valid).sum()),
        "parcel_id_valid": int(len(valid_ids)),
        "parcel_id_valid_distinct": int(valid_ids.nunique()),
        "duplicate_rows_valid": int(len(valid_ids) - valid_ids.nunique()),
        "quarantined_samples": [str(x) for x in nonblank_u[~valid].head(MAX_SAMPLES * 2).tolist()],
        "quarantined_value_counts": {
            str(k): int(v) for k, v in nonblank_u[~valid].value_counts().head(8).items()
        },
    }

    # Do the null-PARCELID rows retain county? Decides whether their accounting
    # can be per-county or must stay statewide.
    cc = _s(df, res.get("county_code")) if res.get("county_code") else None
    if cc is None and res.get("county_code_alpha"):
        cc = _s(df, res["county_code_alpha"])
    if cc is not None and blank.any():
        ccb = cc[blank]
        has_county = (ccb != "")
        rec["null_parcelid_rows"] = {
            "n": int(blank.sum()),
            "county_present": int(has_county.sum()),
            "pct_county_present": round(100.0 * has_county.mean(), 2),
            "distinct_counties": int(ccb[has_county].nunique()),
        }

    rec["q1_duplicate_anatomy"] = _q1_duplicate_anatomy(
        valid_ids,
        _s(df, res.get("owner_name")).reindex(valid_ids.index) if res.get("owner_name") else None,
        _s(df, res.get("owner_name_2")).reindex(valid_ids.index) if res.get("owner_name_2") else None,
        (_num(df, res.get("gis_acres")) if res.get("gis_acres") else _num(df, res.get("area_sqm"))
         ).reindex(valid_ids.index) if (res.get("gis_acres") or res.get("area_sqm")) else None,
        _s(df, res.get("card_no")).reindex(valid_ids.index) if res.get("card_no") else None,
    )

    rec["q2_geocode"] = _q2_geocode(nonblank_u)

    conforming = nonblank_u[nonblank_u.str.fullmatch(GEOCODE_RE, na=False)]
    rec["q3_plss_witness"] = _q3_plss_witness(
        conforming,
        _s(df, res.get("trs")).reindex(conforming.index) if res.get("trs") else None,
        _s(df, res.get("township")).reindex(conforming.index) if res.get("township") else None,
        _s(df, res.get("plss_range")).reindex(conforming.index) if res.get("plss_range") else None,
        _s(df, res.get("plss_section")).reindex(conforming.index) if res.get("plss_section") else None,
    )

    owner_csz = _s(df, res.get("owner_citystatezip")) if res.get("owner_citystatezip") else None
    rec["q4_situs"] = _q4_situs(df, res, owner_csz,
                                owner_city=_s(df, res.get("owner_city")))
    # hand the valid-parcel key to Q5 so it can test the aggregation rule
    df["_pid_for_area"] = pid
    valid_row_mask = pd.Series(False, index=df.index)
    valid_row_mask.loc[valid_ids.index] = True
    rec["q5_area_and_state"] = _q5_area_and_state(df, res, parcel_mask=valid_row_mask)

    # County presence, against the authoritative DOR 1..56 crosswalk.
    if cc is not None:
        if res.get("county_code") and float(cc.str.fullmatch(r"\d+", na=False).mean()) > 0.5:
            codes = pd.to_numeric(cc, errors="coerce").dropna().astype(int)
            present = sorted(set(codes.unique().tolist()))
            rec["counties"] = {
                "mechanism": "numeric COUNTYCD",
                "n_distinct": len(present),
                "present": present,
                "missing_from_1_56": [c for c in range(1, 57) if c not in set(present)],
                "unexpected": [c for c in present if c not in COUNTY_PREFIX],
            }
        else:
            abbr = sorted({x for x in cc.unique().tolist() if x})
            known = {v[1] for v in COUNTY_PREFIX.values()}
            rec["counties"] = {
                "mechanism": "alpha COUNTYCODE",
                "n_distinct": len(abbr),
                "present": abbr,
                "missing_abbr": sorted(known - set(abbr)),
                "unexpected": sorted(set(abbr) - known),
            }

    # Attributes the event classifier and the v2 owner-form work depend on.
    extras: dict = {}
    for logical in ("subdivision", "cert_survey"):
        s = _s(df, res.get(logical))
        if s is not None:
            nb = (s != "")
            extras[logical] = {"column": res[logical], "non_blank": int(nb.sum()),
                               "pct_non_blank": round(100.0 * nb.mean(), 2),
                               "distinct": int(s[nb].nunique()),
                               "samples": [str(x) for x in s[nb].head(MAX_SAMPLES).tolist()]}
    bv = _num(df, res.get("build_value"))
    if bv is not None:
        extras["build_value"] = {"column": res["build_value"], "null": int(bv.isna().sum()),
                                 "gt_zero": int((bv > 0).sum()),
                                 "pct_gt_zero": round(100.0 * (bv > 0).mean(), 2),
                                 "median_where_gt_zero": (None if not (bv > 0).any()
                                                          else float(bv[bv > 0].median()))}
    for logical in ("owner_class", "owner_gen_descrip", "owner_class_code",
                    "res_prop_ind", "tax_year", "rec_year", "property_type"):
        col = res.get(logical)
        s = _s(df, col)
        if s is None:
            continue
        vc = s.value_counts()
        extras[logical] = {"column": col, "distinct": int(vc.size),
                           "top": {str(k): int(v) for k, v in vc.head(20).items()}}
    rec["attributes"] = extras

    del df
    gc.collect()
    rec["total_seconds"] = round(time.time() - t0, 1)
    return rec


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Step 0 schema-drift probe over all cadastral snapshots")
    ap.add_argument("--root", default=sources.DEFAULT_ROOT)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--only", nargs="*", help="limit to these snapshot dates (ISO)")
    ap.add_argument("--force", action="store_true", help="re-probe snapshots already done")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    os.makedirs(args.out, exist_ok=True)

    snaps = sources.discover(args.root)
    sources.write_manifest(snaps, os.path.join(args.out, "manifest.json"))
    if args.only:
        snaps = [s for s in snaps if s.date in set(args.only)]

    for i, snap in enumerate(snaps, 1):
        dest = os.path.join(args.out, f"probe_{snap.date}.json")
        if os.path.exists(dest) and not args.force:
            log.info("[%2d/%d] %s  already probed, skipping", i, len(snaps), snap.date)
            continue
        log.info("[%2d/%d] %s  era %s  %s%s", i, len(snaps), snap.date, snap.era,
                 snap.container, f" layer={snap.layer}" if snap.layer else "")
        try:
            rec = probe_snapshot(snap)
        except Exception as exc:  # a bad snapshot must not stop the run
            log.exception("  FAILED %s", snap.date)
            rec = {"date": snap.date, "era": snap.era, "error": repr(exc)}
        with open(dest, "w") as fh:
            json.dump(_json_safe(rec), fh, indent=2)
        c = rec.get("counts", {})
        log.info("    rows=%s distinct=%s dup=%s blank=%s  %ss  -> %s",
                 f"{c.get('rows', 0):,}", f"{c.get('parcel_id_distinct', 0):,}",
                 f"{c.get('duplicate_rows', 0):,}", f"{c.get('parcel_id_blank_or_null', 0):,}",
                 rec.get("total_seconds"), os.path.basename(dest))
        if "q1_duplicate_anatomy" in rec:
            log.info("    Q1 verdict: %s", rec["q1_duplicate_anatomy"].get("verdict"))
    log.info("probe complete; %d records in %s", len(snaps), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
