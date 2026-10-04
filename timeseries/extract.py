"""Stage 2: attribute-only extraction to the parcel and interest grains.

One ``/vsizip/`` pass per snapshot, geometry never requested, through the
container-aware alias map. Produces the first two of the four entities the whole
pipeline is built on:

* ``parcel_snapshot`` -- one row per (snapshot, valid parcel)
* ``owner_interest_snapshot`` -- one row per (snapshot, parcel, named party)

Three measured decisions are baked in here, each of which would otherwise
corrupt every downstream number.

**Acres are SUMMED across duplicate rows, not maxed.** Duplicate ``PARCELID``s
are exploded multipart geometry -- the same owner with a different polygon part
(``MUHE DANIEL`` appears five times with areas 284.96 / 457.64 / 585.33 /
1220.22). Measured across 2006: 33,767 of 33,769 duplicated parcels have an
*identical* owner name and a *differing* area; only 2 differ by owner. Taking
the maximum discards the remaining parts -- 0.53% of state acreage in 2006 and
0% in 2026 -- and because duplication decays from 87,095 rows to zero across
the series, that error would masquerade as a rising-acreage trend.

**Structural quarantine precedes all counting.** The parcel-id column carries
``NA`` (14,323 rows in 2006) and families of repeated-digit filler
(``03888844444444444``, ``03555555555550000``). A range check on county,
section and quarter catches them all; the accounting identity
``rows == blank + quarantined + valid`` is asserted per snapshot.

**The per-era area field is the parcel's own area.** ``AREA`` in square metres
(2002-2011), ``Shape_Area`` (2013-2014), ``GISAcres`` (2016+). ``TotalAcres`` is
agricultural acreage only -- zero on 67.8% of 2006 parcels -- and using it would
corrupt every fragmentation statistic.

One vintage needs a geometry fallback. The 2004-07-16 export carries an
``AREA`` column that is **entirely zero** (833,537 rows, maximum 0.0), while
2005-02-01 has a sensible median of 13,865 m². Rather than special-case a date,
:func:`_acres` reports how usable the attribute field is and the extractor
falls back to computing area from geometry whenever it is degenerate -- a rule
that catches the same failure in any vintage. That fallback is the only place in
the pipeline that reads geometry.
"""

from __future__ import annotations

import logging
import os

import numpy as np
import pandas as pd

from cadastral.schema import SQM_TO_ACRES, resolve_columns

from . import geocode as gc
from . import owners as ow
from . import sources

log = logging.getLogger("timeseries.extract")

OUT_DIR = "data/snapshots"

# Logical fields the extractor needs. Narrow on purpose: eight to eleven
# columns per snapshot rather than the forty the layer carries.
EXTRACT_FIELDS = [
    "parcel_id", "county_code", "county_code_alpha",
    "owner_name", "owner_name_2",
    "owner_state", "owner_city", "owner_citystatezip", "mail_state", "mail_city",
    "gis_acres", "area_sqm",
    "subdivision", "cert_survey", "property_type", "build_value",
    "owner_class", "owner_gen_descrip", "res_prop_ind",
    "situs_city", "situs_citystatezip",
    "trs", "township", "plss_range", "plss_section",
]


# Below this share of strictly-positive values the attribute area field is
# treated as unusable and geometry is read instead.
MIN_USABLE_AREA_SHARE = 0.5
# A numeric field whose strictly-positive share falls below this is treated as
# dead for the vintage rather than as a measurement of zero. The 2009-07-05
# export carries all three value columns entirely zero across 908,662 rows
# while its neighbours sit at 46-47%, so computing improved = (value > 0) there
# would publish a spurious 0%-improved snapshot.
MIN_DEGENERATE_SHARE = 0.01


def _acres(df: pd.DataFrame, res: dict) -> tuple[pd.Series, str]:
    """Parcel area in acres, from the era's own field.

    ``GISAcres`` is preferred where present; measured on 2026 it reproduces
    ``Shape_Area`` x SQM_TO_ACRES to eleven decimal places, so the two are the
    same measurement under different units.
    """
    col = res.get("gis_acres")
    if col and col in df.columns:
        return pd.to_numeric(df[col], errors="coerce").astype("float64"), f"gis_acres:{col}"
    col = res.get("area_sqm")
    if col and col in df.columns:
        a = pd.to_numeric(df[col], errors="coerce").astype("float64") * SQM_TO_ACRES
        return a, f"area_sqm:{col}"
    return pd.Series(np.nan, index=df.index, dtype="float64"), "unavailable"


def _usable_share(a: pd.Series) -> float:
    if len(a) == 0:
        return 0.0
    return float((a.fillna(0) > 0).mean())


def _acres_from_geometry(snap: sources.Snapshot, n_expected: int) -> pd.Series:
    """Compute parcel acres from geometry, for a vintage whose area field is dead.

    Read in the same FID order as the attribute pass, so positional alignment
    holds. The CRS is asserted to be projected metres (EPSG:32100 through 2020,
    EPSG:6514 from 2021 -- both Montana State Plane in metres) rather than
    assumed, because an unprojected area would be silently meaningless.
    """
    from pyproj import CRS

    info = snap.info()
    crs = CRS.from_user_input(info["crs"])
    unit = (getattr(crs.axis_info[0], "unit_name", "") or "").lower()
    if crs.is_geographic or unit not in ("metre", "meter", "metres", "meters"):
        raise RuntimeError(f"{snap.date}: CRS {crs.name!r} is not projected metres; "
                           "cannot derive acres from geometry")
    gdf = snap.read(columns=[], read_geometry=True)
    if len(gdf) != n_expected:
        raise RuntimeError(f"{snap.date}: geometry pass returned {len(gdf):,} rows, "
                           f"attribute pass had {n_expected:,}; cannot align positionally")
    log.info("    area field degenerate -> derived acres from geometry (%s, %s)",
             crs.name, f"{len(gdf):,} features")
    return pd.Series(gdf.geometry.area.to_numpy() * SQM_TO_ACRES, index=range(len(gdf)),
                     dtype="float64")


def _hash64(s: pd.Series) -> pd.Series:
    """Stable 64-bit hash of a normalized string, for cross-snapshot identity.

    Used to detect owner change without shipping or storing names in any
    published artefact.
    """
    return pd.util.hash_pandas_object(s.fillna(""), index=False).astype("uint64")


def _first_str(series: pd.Series) -> pd.Series:
    return series.fillna("").astype("object")


def extract_snapshot(snap: sources.Snapshot, out_dir: str = OUT_DIR) -> dict:
    """Read one snapshot and write its parcel and interest tables.

    Staged through :meth:`sources.Snapshot.local`, which is a no-op for
    shapefiles and unpacks the subtree for geodatabases -- reading a ``.gdb``
    through ``/vsizip/`` thrashes the deflate stream and does not finish.
    """
    with snap.local() as src:
        return _extract_open(src, snap, out_dir)


def _extract_open(snap: sources.Snapshot, orig: sources.Snapshot, out_dir: str) -> dict:
    info = snap.info()
    columns = list(info.get("fields", []))
    res = resolve_columns(columns)
    if not res.get("parcel_id"):
        raise RuntimeError(f"{snap.date}: no parcel_id column")

    want = list(dict.fromkeys(res[f] for f in EXTRACT_FIELDS if res.get(f)))
    df = snap.read(columns=want)

    pid = gc.normalize(df[res["parcel_id"]])
    parts = gc.parse(pid)
    blank = np.asarray(pid == "", dtype=bool)
    locatable = parts["locatable"].to_numpy(dtype=bool)
    valid = locatable & ~blank
    quarantined = (~blank) & ~locatable

    qa = {
        "date": snap.date, "era": snap.era, "container": snap.container,
        "layer": snap.layer, "crs": str(info.get("crs")),
        "staged": snap.vsi != orig.vsi,
        "rows": int(len(df)), "blank": int(blank.sum()),
        "quarantined": int(quarantined.sum()), "valid_rows": int(valid.sum()),
        "quarantined_top": {str(k): int(v) for k, v in
                            pid[quarantined].value_counts().head(8).items()},
    }
    # The identity must close before anything is written.
    assert qa["rows"] == qa["blank"] + qa["quarantined"] + qa["valid_rows"], (
        f"{snap.date}: accounting identity failed: {qa}")

    acres_all, acres_mech = _acres(df, res)
    usable = _usable_share(acres_all)
    if usable < MIN_USABLE_AREA_SHARE:
        qa["area_field_usable_share"] = round(usable, 6)
        qa["area_field_degenerate"] = acres_mech
        acres_all = _acres_from_geometry(snap, len(df)).set_axis(df.index)
        acres_mech = f"geometry_fallback(was {acres_mech})"
    qa["area_mechanism"] = acres_mech
    qa["area_usable_share"] = round(_usable_share(acres_all), 6)
    # Rights-of-way and water: no assessment record, but real mapped acreage,
    # which the coverage model needs. Kept as an aggregate, never as parcels.
    qa["blank_pid_acres"] = float(np.nansum(acres_all.to_numpy()[blank]))
    qa["quarantined_acres"] = float(np.nansum(acres_all.to_numpy()[quarantined]))

    v = pd.DataFrame(index=df.index[valid])
    v["parcel_id"] = pid[valid]
    for part in ("county", "twp_code", "section", "quarter", "block", "lot", "unit"):
        v[part] = parts.loc[valid, part].fillna("").astype("object")
    v["acres"] = acres_all[valid]
    v["is_condo"] = gc.is_condo_unit(parts.loc[valid])

    rec = ow.record_fields(df.loc[valid], res)
    qa["state_mechanism"] = rec.attrs.get("state_mechanism")
    v = v.join(rec)

    for logical, name in (("subdivision", "subdivision"), ("cert_survey", "cert_survey"),
                          ("property_type", "property_type"), ("situs_city", "situs_city"),
                          ("owner_class", "owner_class"), ("res_prop_ind", "res_prop_ind"),
                          ("owner_gen_descrip", "owner_gen_descrip")):
        col = res.get(logical)
        v[name] = (_first_str(df.loc[valid, col].astype("string").str.strip())
                   if col and col in df.columns else "")
    # Situs city may only exist as "CITY, ST ZIP" in the later eras.
    if (not res.get("situs_city")) and res.get("situs_citystatezip"):
        csz = df.loc[valid, res["situs_citystatezip"]].astype("string").fillna("")
        v["situs_city"] = csz.str.split(",").str[0].str.strip().str.upper().astype("object")

    bv_col = res.get("build_value")
    v["build_value"] = (pd.to_numeric(df.loc[valid, bv_col], errors="coerce").astype("float64")
                        if bv_col and bv_col in df.columns else np.nan)
    bv_share = _usable_share(v["build_value"])
    qa["build_value_column"] = bv_col
    qa["build_value_usable_share"] = round(bv_share, 6)
    qa["improvement_available"] = bool(bv_col) and bv_share >= MIN_DEGENERATE_SHARE

    # ---- collapse the exploded parts to one row per parcel
    grouped = v.groupby("parcel_id", sort=False)
    n_parts = grouped.size().rename("n_parts")
    owner_variants = grouped["owner_name_norm"].nunique().rename("owner_variants")

    agg = {
        "acres": ("acres", "sum"),                 # the measured rule: SUM
        "build_value": ("build_value", "max"),     # parcel-level, repeated per part
        "is_condo": ("is_condo", "max"),
    }
    first_cols = ["county", "twp_code", "section", "quarter", "block", "lot", "unit",
                  "owner_name_raw", "owner_name_norm", "owner_blank",
                  "n_names_on_record", "owner_name_2_present",
                  "owner_is_entity", "owner_state",
                  "owner_state_valid", "owner_in_state", "subdivision", "cert_survey",
                  "property_type", "situs_city", "owner_class", "owner_gen_descrip",
                  "res_prop_ind"]
    for c in first_cols:
        agg[c] = (c, "first")
    parcels = grouped.agg(**agg)
    parcels = parcels.join(n_parts).join(owner_variants)
    parcels = parcels.reset_index()

    qa["parcels"] = int(len(parcels))
    qa["duplicate_rows_collapsed"] = int(qa["valid_rows"] - qa["parcels"])
    qa["parcels_with_multiple_parts"] = int((parcels["n_parts"] > 1).sum())
    qa["parcels_with_differing_owner_across_parts"] = int((parcels["owner_variants"] > 1).sum())
    qa["acres_sum_rule"] = float(parcels["acres"].sum())
    qa["acres_max_rule"] = float(grouped["acres"].max().sum())
    qa["max_rule_loses_acres"] = qa["acres_sum_rule"] - qa["acres_max_rule"]
    qa["acres_null"] = int(parcels["acres"].isna().sum())

    parcels["snapshot"] = snap.date
    parcels["owner_hash"] = _hash64(parcels["owner_name_norm"])
    # int8 with -1 = unknown, so a dead value block reads as "no data" rather
    # than as "nothing is improved".
    if qa["improvement_available"]:
        parcels["improved"] = (parcels["build_value"].fillna(0) > 0).astype("int8")
    else:
        parcels["improved"] = np.int8(-1)
        log.info("    improvement value unavailable (usable share %.4f) -> improved = -1",
                 bv_share)

    # Narrow dtypes; no nullable dtypes anywhere, sentinels instead.
    parcels["county_n"] = pd.to_numeric(parcels["county"], errors="coerce").fillna(-1).astype("int8")
    parcels["section_n"] = pd.to_numeric(parcels["section"], errors="coerce").fillna(-1).astype("int8")
    parcels["quarter_n"] = pd.to_numeric(parcels["quarter"], errors="coerce").fillna(-1).astype("int8")
    parcels["acres"] = parcels["acres"].astype("float32")
    parcels["build_value"] = parcels["build_value"].fillna(-1.0).astype("float64")
    parcels["n_parts"] = parcels["n_parts"].astype("int16")
    parcels["owner_variants"] = parcels["owner_variants"].astype("int16")

    os.makedirs(out_dir, exist_ok=True)
    ppath = os.path.join(out_dir, f"parcels_{snap.date}.parquet")
    parcels.to_parquet(ppath, index=False, compression="zstd")
    qa["parcel_file"] = ppath
    qa["parcel_file_bytes"] = os.path.getsize(ppath)

    interests = ow.split_interests(parcels["parcel_id"], parcels["owner_name_norm"])
    interests["snapshot"] = snap.date
    ipath = os.path.join(out_dir, f"interests_{snap.date}.parquet")
    interests.to_parquet(ipath, index=False, compression="zstd")
    qa["interests"] = int(len(interests))
    qa["interest_file_bytes"] = os.path.getsize(ipath)

    del df, v, parcels, interests
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Stage 2: extract parcel + interest grains")
    ap.add_argument("--root", default=sources.DEFAULT_ROOT)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--include-excluded", action="store_true",
                    help="also extract 2002 (missing its five most populous counties)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    snaps = sources.discover(args.root)
    if not args.include_excluded:
        snaps = sources.usable(snaps)
    if args.only:
        snaps = [s for s in snaps if s.date in set(args.only)]

    os.makedirs(args.out, exist_ok=True)
    qa_all = []
    for i, snap in enumerate(snaps, 1):
        dest = os.path.join(args.out, f"parcels_{snap.date}.parquet")
        qpath = os.path.join(args.out, f"qa_{snap.date}.json")
        if os.path.exists(dest) and os.path.exists(qpath) and not args.force:
            log.info("[%2d/%d] %s already extracted", i, len(snaps), snap.date)
            with open(qpath) as fh:
                qa_all.append(json.load(fh))
            continue
        log.info("[%2d/%d] %s era %s", i, len(snaps), snap.date, snap.era)
        qa = extract_snapshot(snap, args.out)
        with open(qpath, "w") as fh:
            json.dump(qa, fh, indent=2, default=str)
        qa_all.append(qa)
        log.info("    parcels=%s  acres=%.4fM  SUM-MAX=%.0f ac  multipart=%s  "
                 "owner-differs=%s  %s KB",
                 f"{qa['parcels']:,}", qa["acres_sum_rule"] / 1e6,
                 qa["max_rule_loses_acres"], f"{qa['parcels_with_multiple_parts']:,}",
                 qa["parcels_with_differing_owner_across_parts"],
                 f"{qa['parcel_file_bytes'] // 1024:,}")
    with open(os.path.join(args.out, "qa_all.json"), "w") as fh:
        json.dump(qa_all, fh, indent=2, default=str)
    log.info("extracted %d snapshots -> %s", len(qa_all), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
