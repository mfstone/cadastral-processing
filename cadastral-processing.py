#!/usr/bin/env python3
"""Montana cadastral parcel ownership-consolidation tool.

Reframes the manual QGIS+Excel+SQL "Cadastral Parcel Consolidation Methodology"
as a reproducible pipeline. The MVP path normalizes owner identity, flags
ambiguities, tags Census geography, and dissolves parcels into consolidated-owner
polygons. With ``--orion-cache`` it additionally uses the DOR ORION database
(authoritative canonical owner name/address, shared-PartyID bridging, co-owners,
deed/transfer history) to augment consolidation -- never to split it.

Run ``python cadastral-processing.py --help``. With no args it uses discovered
default paths and processes every county (MVP only unless --orion-cache given).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

import geopandas as gpd
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cadastral import census as census_mod
from cadastral import consolidate, dissolve, io_utils, normalize
from cadastral import orion as orion_mod
from cadastral import owner_geo, schema

DEFAULT_INPUT = "/media/mstone/GeoData/MSDI/MontanaCadastral_SHP/Montana_Cadastral/OWNERPARCEL.shp"
DEFAULT_TRACTS = "/media/mstone/GeoData/Census/tl_2025_30_tract/tl_2025_30_tract.shp"
DEFAULT_BG = "/media/mstone/GeoData/Census/tl_2025_30_bg/tl_2025_30_bg.shp"
DEFAULT_DOCTYPE_XWALK = os.path.join(os.path.dirname(__file__), "doctype_transfer_class.csv")

log = logging.getLogger("cadastral")


def owner_attrs(info: schema.SourceInfo, do_orion: bool) -> dict[str, str]:
    """result-column -> source-column carried through dissolve/summary."""
    a = {
        "OwnerName": "OwnerNameResolved",
        "GlobalOwnerID": "GlobalOwnerID",
        "OwnerCode": "OwnerCode",
        "county_code": "_county",
    }
    if do_orion:
        a.update({"PartyID": "PartyID", "owner_source": "owner_source",
                  "OwnerAddr": "canonical_addr_full"})
    else:
        for key, logical in (("OwnerAddr", "owner_address_1"), ("OwnerCity", "owner_city"),
                             ("OwnerState", "owner_state"), ("OwnerZip", "owner_zip")):
            col = info.col(logical)
            if col:
                a[key] = col
    a["owner_in_state"] = "owner_in_state"
    return a


def process_county(code, name, info, census, overrides, zip_xwalk, outdir,
                   do_dissolve, orion_cache, do_orion, ownership_mode,
                   doctype_xwalk, orion_tax_year="match"):
    """Full pipeline for one county; writes outputs; returns QA + accumulators."""
    log.info("County %s (%s)", code, name)
    gdf = io_utils.read_county(info, code)
    total = len(gdf)
    name_col = info.require("owner_name")

    # 1. separate null-PARCELID + null geometry --------------------------------
    work, rights = io_utils.split_null_parcelid(gdf, info)
    n_rights = len(rights)
    geom_ok = work.geometry.notna() & ~work.geometry.is_empty
    n_nogeom = int((~geom_ok).sum())
    work = work[geom_ok].copy()
    work["_pid"] = work[info.require("parcel_id")].astype(str)
    work["_county"] = int(code)

    # 2. geometry repair + per-parcel acres -----------------------------------
    work = dissolve.repair_geometry(work)
    work = dissolve.add_parcel_acres(work)

    # 3. normalize shapefile owner identity -----------------------------------
    work = normalize.add_normalized_fields(work, info)
    n_blank = int(work["owner_blank"].sum())

    # 4. ORION resolution (authoritative canonical owner + provenance) --------
    orion_res = None
    if do_orion:
        orion_res = orion_mod.resolve_parcels(work, orion_cache, name_col,
                                              tax_year_policy=orion_tax_year)
        work = work.join(orion_res)
    # resolved owner name: ORION canonical when matched, else shapefile
    if do_orion and "canonical_name" in work.columns:
        work["OwnerNameResolved"] = work["canonical_name"].where(
            work["canonical_name"].notna() & (work["owner_source"] != "unmatched"),
            work[name_col])
    else:
        work["OwnerNameResolved"] = work[name_col]

    # 5. consolidation: strict id -> review queue -> ORION-augmented groups ----
    work = consolidate.assign_strict_ids(work)
    review = consolidate.build_review_queue(work)
    work, autoresolved = consolidate.consolidate_orion(work, overrides, use_orion=do_orion)
    work = consolidate.assign_human_codes(work, "OwnerGroupID", "OwnerCode")

    # 6. census tag + 7. owner mailing-location -------------------------------
    work = census_mod.tag_parcels(work, census)
    n_nobg = int(work["BG_GEOID"].isna().sum()) if "BG_GEOID" in work else 0
    work = owner_geo.add_owner_location(work, zip_xwalk)

    # 8. multi-party interest + deeds -----------------------------------------
    interest = deeds_latest = deed_events = None
    if do_orion:
        pct = work.get("PercentOwnership")
        work["fractional_acres"] = work["ConsolAcres_parcel"] * (
            pd.to_numeric(pct, errors="coerce").fillna(100.0) / 100.0)
        interest = work[["_pid", "PropertyID", "TaxYear", "PartyID", "PercentOwnership",
                         "ConsolAcres_parcel", "fractional_acres", "owner_source"]].rename(
            columns={"_pid": "PARCELID", "ConsolAcres_parcel": "parcel_acres"})
        deed_events = orion_mod.load_deed_events(orion_cache, work["PropertyID"].dropna())
        _, _, deeds_latest = orion_mod.classify_deeds(deed_events, doctype_xwalk)
        if len(deeds_latest):
            work = work.merge(
                deeds_latest[["PropertyID", "latest_transfer_date",
                              "latest_transfer_doctype_desc", "tenure_years"]],
                on="PropertyID", how="left")

    n_owners = int(work["OwnerGroupID"].nunique())
    attrs = owner_attrs(info, do_orion)

    # outputs ------------------------------------------------------------------
    slug = io_utils.county_slug(code, name)
    gpkg = os.path.join(outdir, f"Cad_{slug}.gpkg")
    if os.path.exists(gpkg):
        os.remove(gpkg)

    io_utils.write_gpkg_layer(work, gpkg, "parcels_tagged")
    if n_rights:
        io_utils.write_gpkg_layer(rights, gpkg, "rights_of_way")

    acres_col = "fractional_acres" if (do_orion and ownership_mode == "fractional") \
        else "ConsolAcres_parcel"
    summ = dissolve.owner_summary(work, "OwnerGroupID", attrs, acres_col=acres_col)
    xwalk = census_mod.owner_geography_xwalk(work, "OwnerGroupID")
    io_utils.write_gpkg_layer(summ, gpkg, "owner_summary")
    io_utils.write_gpkg_layer(xwalk, gpkg, "owner_geography_xwalk")
    io_utils.write_gpkg_layer(review, gpkg, "review_queue")

    name_out = work[["_pid", "OwnerCode", "OwnerGroupID", "GlobalOwnerID",
                     "OwnerNameResolved", "BG_GEOID", "TRACT_GEOID"]].rename(
        columns={"_pid": "PARCELID"})
    io_utils.write_csv(name_out, os.path.join(outdir, f"Cad_{slug}_owner_join.csv"))
    io_utils.write_csv(review, os.path.join(outdir, f"Cad_{slug}_review_queue.csv"))
    io_utils.write_csv(summ, os.path.join(outdir, f"Cad_{slug}_owner_summary.csv"))

    if do_orion:
        io_utils.write_gpkg_layer(autoresolved, gpkg, "orion_autoresolved")
        io_utils.write_gpkg_layer(interest, gpkg, "parcel_owner_interest")
        io_utils.write_csv(interest, os.path.join(outdir, f"Cad_{slug}_parcel_owner_interest.csv"))
        io_utils.write_csv(autoresolved, os.path.join(outdir, f"Cad_{slug}_orion_autoresolved.csv"))
        if deed_events is not None and len(deed_events):
            io_utils.write_csv(deed_events, os.path.join(outdir, f"Cad_{slug}_deed_events.csv"))

    dissolved = None
    if do_dissolve:
        dissolved = dissolve.dissolve_owners(work, "OwnerGroupID", attrs)
        io_utils.write_gpkg_layer(dissolved, gpkg, "owners_dissolved")

    acc = work[["GlobalOwnerID", "_county", "ConsolAcres_parcel", "OwnerNameResolved"]].copy()
    acc = acc.rename(columns={"OwnerNameResolved": "OwnerName"})
    acc["county_name"] = name

    src_acres = float("nan")
    ta = info.col("total_acres")
    if ta:
        src_acres = float(pd.to_numeric(gdf[ta], errors="coerce").sum())
    qa = {"county_code": code, "county_name": name, "total": total,
          "rights_of_way": n_rights, "no_geometry": n_nogeom,
          "working_parcels": len(work), "blank_owner": n_blank,
          "owner_groups": n_owners, "review_rows": len(review),
          "no_bg_match": n_nobg, "source_acres": src_acres,
          "consol_acres": float(work["ConsolAcres_parcel"].sum())}
    if do_orion and orion_res is not None:
        vc = orion_res["owner_source"].value_counts()
        qa["orion_matched"] = int((orion_res["owner_source"] != "unmatched").sum())
        qa["orion_same_year"] = int(vc.get("orion_same_tax_year", 0))
        qa["orion_autoresolved"] = len(autoresolved)
    log.info("  -> %s parcels, %s owner groups, %s review rows%s",
             f"{len(work):,}", f"{n_owners:,}", f"{len(review):,}",
             f", {qa.get('orion_matched',0):,} ORION-matched" if do_orion else "")
    return {"qa": qa, "dissolved": dissolved, "acc": acc}


def statewide_merge(results, outdir):
    dissolveds = [r["dissolved"] for r in results if r.get("dissolved") is not None]
    if not dissolveds:
        log.info("statewide merge skipped (no dissolved layers)")
        return
    log.info("Statewide merge across %d counties", len(dissolveds))
    alld = gpd.GeoDataFrame(pd.concat(dissolveds, ignore_index=True), crs=dissolveds[0].crs)
    alld = dissolve.repair_geometry(alld)
    statewide = alld.dissolve(by="GlobalOwnerID", aggfunc={"OwnerName": "first"}, as_index=False)
    statewide["ConsolAcres"] = statewide.geometry.area * schema.SQM_TO_ACRES
    counts = alld.groupby("GlobalOwnerID")["ParcelCount"].sum().rename("ParcelCount")
    statewide = statewide.merge(counts, on="GlobalOwnerID", how="left")

    acc = pd.concat([r["acc"] for r in results], ignore_index=True)
    xwalk = (acc.groupby(["GlobalOwnerID", "_county", "county_name"])
             .agg(parcel_count=("ConsolAcres_parcel", "size"),
                  total_acres=("ConsolAcres_parcel", "sum"),
                  OwnerName=("OwnerName", "first")).reset_index()
             .rename(columns={"_county": "county_code"}))
    n_counties = xwalk.groupby("GlobalOwnerID")["county_code"].nunique().rename("n_counties")
    xwalk = xwalk.merge(n_counties, on="GlobalOwnerID", how="left")

    out = os.path.join(outdir, "Montana_consolidated.gpkg")
    if os.path.exists(out):
        os.remove(out)
    io_utils.write_gpkg_layer(statewide, out, "owners_dissolved_statewide")
    io_utils.write_gpkg_layer(xwalk, out, "owner_county_xwalk")
    io_utils.write_csv(xwalk, os.path.join(outdir, "Montana_owner_county_xwalk.csv"))
    log.info("  %s statewide owners; %s span >1 county",
             f"{len(statewide):,}", f"{int((n_counties > 1).sum()):,}")


def print_qa(results):
    df = pd.DataFrame([r["qa"] for r in results])
    if df.empty:
        return
    log.info("\n===== QA SUMMARY =====\n%s", df.to_string(index=False))
    bad = df[df["total"] != df["rights_of_way"] + df["no_geometry"] + df["working_parcels"]]
    if not bad.empty:
        log.warning("count reconciliation MISMATCH: %s", bad["county_code"].tolist())
    else:
        log.info("count reconciliation OK (total == rights_of_way + no_geometry + working)")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Montana cadastral ownership consolidation.")
    p.add_argument("--input", default=DEFAULT_INPUT)
    p.add_argument("--tracts", default=DEFAULT_TRACTS)
    p.add_argument("--bg", default=DEFAULT_BG)
    p.add_argument("--outdir", default=os.path.join(os.path.dirname(__file__), "data"))
    p.add_argument("--county", nargs="*", default=None, help="county code(s)/name(s); default all")
    p.add_argument("--overrides", default=None, help="owner_overrides.csv")
    p.add_argument("--zip-crosswalk", default=None)
    p.add_argument("--orion-cache", default=None, help="orion_cache dir (enables ORION)")
    p.add_argument("--orion-tax-year", default="match", help="match|latest|<year>")
    p.add_argument("--ownership-mode", choices=["primary", "fractional"], default="primary")
    p.add_argument("--doctype-xwalk", default=DEFAULT_DOCTYPE_XWALK)
    p.add_argument("--no-dissolve", action="store_true")
    p.add_argument("--no-statewide-merge", action="store_true")
    p.add_argument("--no-census", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
    os.makedirs(args.outdir, exist_ok=True)

    info = schema.inspect_source(args.input)
    schema.report(info)
    if info.missing_required:
        log.error("aborting: missing required fields")
        return 2

    census = None if args.no_census else census_mod.CensusGeographies(args.bg, args.tracts, info.crs)
    overrides = consolidate.load_overrides(args.overrides)
    zip_xwalk = owner_geo.load_zip_crosswalk(args.zip_crosswalk)

    do_orion = bool(args.orion_cache)
    orion_cache = orion_mod.OrionCache(args.orion_cache) if do_orion else None
    doctype_xwalk = orion_mod.load_doctype_crosswalk(args.doctype_xwalk) if do_orion else None
    if do_orion:
        log.info("ORION enabled (cache=%s, refresh=%s, mode=%s)",
                 args.orion_cache, orion_cache.refresh_date, args.ownership_mode)

    counties = io_utils.list_counties(info)
    name_by_code = dict(zip(counties["county_code"], counties["county_name"]))
    codes = io_utils.resolve_county_codes(info, args.county)
    log.info("processing %d county(ies): %s", len(codes), codes)

    results = []
    for code in codes:
        try:
            results.append(process_county(
                code, name_by_code.get(code, schema.county_name(code)), info, census,
                overrides, zip_xwalk, args.outdir, not args.no_dissolve,
                orion_cache, do_orion, args.ownership_mode, doctype_xwalk,
                args.orion_tax_year))
        except Exception:
            log.exception("county %s failed", code)

    print_qa(results)
    if not args.no_statewide_merge and not args.no_dissolve:
        statewide_merge(results, args.outdir)
    log.info("done. outputs in %s", args.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
