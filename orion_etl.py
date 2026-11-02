#!/usr/bin/env python3
"""ORION CAMA database ETL -- profile + extract to normalized Parquet.

One-time setup stage (separate from the per-run cadastral pipeline). Connects to
a SQL Server instance hosting the attached ORION database, PROFILES it (the
authority gate: RefreshDate, tax years, row counts, key overlap with the parcel
layer), then EXPORTS the ownership/deed tables to normalized Parquet that the
pipeline reads -- so the 9.58 GB database is not needed per run.

Phase 3 adds the CAMA building records -- ``Res`` (dwellings and mobile homes),
``Com``, ``Oby``, ``Permit``, ``FinalVal`` and a per-property reduction of
``InspHistory`` -- which ``timeseries.cama`` uses as an independent witness to
the development ladder and as the source of the DOR's condition ratings.
Three refreshes have been exported, each to its own cache: 2016-03-27 (tax
years 2014-2016, ``orion_cache_2016``), 2018-06-21 (2016-2018,
``orion_cache_2018``) and 2026-06-24 (2024-2026, ``orion_cache``). The composite
``CDU`` column is filled on 412,439 of 412,440 dwellings for tax year 2014 and
on a few dozen manufactured homes in every year after; from tax year 2015 its
four components (``PhyCondition``, ``Utility``, ``PropDesirability``,
``LocDesirability``) are filled instead. The DOR retired the composite at the
2015 reappraisal by copying it into the components. Both are exported; the
pipeline picks the filled field per tax year.

The tables are exported NORMALIZED (one Parquet per ORION table); they are never
pre-joined, because a property has many parties and a party has many names AND
many addresses with no name<->address link -- a denormalized join would multiply
rows and fabricate name/address pairings.

Standing up SQL Server (documented; run once):
  cp Output.mdf <work>/ ; chmod 666 <work>/Output.mdf ; chmod 777 <work>
  docker run -d --name orion-mssql -e ACCEPT_EULA=Y \
    -e MSSQL_SA_PASSWORD=... -e MSSQL_PID=Developer -p 1433:1433 \
    -v <work>:/var/opt/mssql/orion mcr.microsoft.com/mssql/server:2022-latest
  # then attach:
  CREATE DATABASE Orion ON (FILENAME='/var/opt/mssql/orion/Output.mdf')
    FOR ATTACH_REBUILD_LOG;   -- no .ldf is shipped

Usage:
  ORION_SA_PASSWORD=... python orion_etl.py --parcels <shp> --cache orion_cache \
      [--profile] [--export] [--tax-years 2024 2025 2026]
  (default: both profile and export)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import warnings

import pandas as pd
import pymssql

warnings.filterwarnings("ignore", message="pandas only supports SQLAlchemy")
log = logging.getLogger("orion_etl")

# desired columns per table (intersected with columns actually present)
EXPORT_SPEC = {
    "property": ("Property", [
        "PropertyID", "TaxYear", "County", "GeoCode", "GeoCodeSearch",
        "PropCategory", "PropType", "PropSubCategory", "PropSubCategory_Desc",
        "TimestampChange"], "TaxYear"),
    "owner": ("Owner", [
        "PropertyID", "TaxYear", "PartyID", "PercentOwnership", "PrimaryOwner",
        "InterestType", "TimestampChange"], "TaxYear"),
    "partyname": ("PartyName", [
        "PartyNameID", "PartyID", "DefaultName", "FullName", "NameType",
        "NameType_Desc"], None),
    "partyaddr": ("PartyAddr", [
        "PartyAddrID", "PartyID", "DefaultAddress", "Address1", "Address2",
        "Address3", "City", "State", "ZIP", "PostalCode", "Country"], None),
    "deed": ("Deed", [
        "DeedID", "PropertyID", "Book", "Page", "DeedDate", "DocNumber",
        "DocType", "DocType_Desc", "RecordedDate"], None),
    "systeminfo": ("SystemInfo", ["RefreshDate"], None),
    # --- CAMA building records (Phase 3) -------------------------------
    "res": ("Res", [
        "ResID", "PropertyID", "TaxYear", "ResType", "Style", "Grade", "ClassCode",
        "YearBuilt", "EffectiveYear", "YearRemod", "StoryHeight", "SFLA",
        "Bedrooms", "FullBaths", "HalfBaths", "PctComplete",
        "CDU", "PhyCondition", "Utility", "PropDesirability", "LocDesirability",
        "Age", "PctGood", "RCN", "RCNLD"], "TaxYear"),
    "com": ("Com", [
        "ComID", "PropertyID", "TaxYear", "StructureType", "StructureType_Desc",
        "UnitsPerBldg", "IdenticalUnits", "Grade", "YearBuilt", "YearEffective",
        "YearRemod", "PctComplete", "RCNLD"], "TaxYear"),
    "oby": ("Oby", [
        "ObyID", "PropertyID", "TaxYear", "Type", "Description", "Description_Desc",
        "Grade", "YearBlt", "Qty", "Condition", "Area", "PctComplete", "Value"], "TaxYear"),
    "permit": ("Permit", [
        "PermitID", "PropertyID", "PermitNumber", "Status", "IssueDate", "Amount",
        "Type"], None),
    "finalval": ("FinalVal", [
        "PropertyID", "TaxYear", "FinalLand", "FinalBuilding", "FinalTotal",
        "Method"], "TaxYear"),
}

# Reductions written from a query rather than a column list. InspHistory
# re-lists a property's whole inspection record under every tax year (3.4 M
# rows for 2026 against 0.99 M properties), so only the latest date and the
# count per property-year are kept.
EXPORT_SQL = {
    "inspection": ("InspHistory",
                   "SELECT i.PropertyID, i.TaxYear, MAX(i.InspDate) AS LastInspDate, "
                   "COUNT(*) AS n_inspections FROM InspHistory i "
                   "CROSS JOIN (SELECT RefreshDate AS rd FROM SystemInfo) r "
                   # 63 rows in the 2026 refresh carry an inspection date after the
                   # refresh (years like 8014); a bound keeps them out of 'latest'.
                   "WHERE i.TaxYear IN ({years}) AND i.InspDate <= r.rd AND i.InspDate >= '1900-01-01' "
                   "GROUP BY i.PropertyID, i.TaxYear"),
}


def connect(args):
    return pymssql.connect(
        server=args.server, port=args.port, user=args.user,
        password=args.password, database=args.database,
        timeout=args.timeout, login_timeout=30)


def table_columns(cur, table: str) -> list[str]:
    cur.execute(
        "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(%s) ORDER BY column_id",
        (table,))
    return [r[0] for r in cur.fetchall()]


def profile(conn, parcels_path: str | None, cache: str) -> None:
    cur = conn.cursor()
    lines: list[str] = []

    def emit(s=""):
        lines.append(s)
        log.info(s)

    emit("===== ORION PROFILE =====")
    try:
        cur.execute("SELECT RefreshDate FROM SystemInfo")
        emit(f"SystemInfo.RefreshDate (DB vintage): {cur.fetchone()[0]}")
    except Exception as e:
        emit(f"SystemInfo.RefreshDate: UNAVAILABLE ({e})")

    emit("\n-- table row counts --")
    cur.execute("""SELECT t.name, SUM(p.rows) FROM sys.tables t
                   JOIN sys.partitions p ON t.object_id=p.object_id
                   WHERE p.index_id IN (0,1) GROUP BY t.name ORDER BY t.name""")
    present = set()
    for name, rows in cur.fetchall():
        present.add(name.lower())
        emit(f"  {name:<24} {int(rows or 0):>13,}")

    emit("\n-- required tables present? --")
    for _, (tbl, _, _) in EXPORT_SPEC.items():
        emit(f"  {tbl:<24} {'OK' if tbl.lower() in present else 'MISSING'}")

    for tbl in ("Property", "Owner"):
        try:
            cur.execute(f"SELECT DISTINCT TaxYear FROM {tbl} ORDER BY TaxYear")
            yrs = [r[0] for r in cur.fetchall()]
            emit(f"\n{tbl}.TaxYear distinct: {yrs}")
        except Exception as e:
            emit(f"\n{tbl}.TaxYear: ({e})")

    if parcels_path:
        emit("\n-- key overlap vs parcel layer (the authority gate) --")
        _overlap_report(conn, parcels_path, emit)

    if "res" in present:
        emit("\n-- building records (CAMA) --")
        try:
            cur.execute("""SELECT TaxYear, COUNT(*), COUNT(DISTINCT PropertyID),
                                  SUM(CASE WHEN CDU IS NULL THEN 0 ELSE 1 END),
                                  SUM(CASE WHEN PhyCondition IS NULL THEN 0 ELSE 1 END),
                                  SUM(CASE WHEN YearBuilt IS NULL OR YearBuilt=0 THEN 0 ELSE 1 END)
                           FROM Res GROUP BY TaxYear ORDER BY TaxYear""")
            for ty, n, props, cdu, cond, yb in cur.fetchall():
                emit(f"  Res {ty}: {n:,} dwellings on {props:,} properties; "
                     f"CDU populated {cdu:,}, PhyCondition populated {cond:,}, "
                     f"YearBuilt populated {yb:,}")
            for tbl, yc in (("Com", "YearBuilt"), ("Oby", "YearBlt")):
                cur.execute(f"""SELECT TaxYear, COUNT(*), COUNT(DISTINCT PropertyID),
                                      SUM(CASE WHEN {yc} IS NULL OR {yc}=0 THEN 0 ELSE 1 END)
                               FROM {tbl} GROUP BY TaxYear ORDER BY TaxYear""")
                for ty, n, props, yb in cur.fetchall():
                    emit(f"  {tbl} {ty}: {n:,} rows on {props:,} properties; {yc} populated {yb:,}")
            cur.execute("SELECT COUNT(*), COUNT(DISTINCT PropertyID), MIN(IssueDate), MAX(IssueDate) FROM Permit")
            n, props, lo, hi = cur.fetchone()
            emit(f"  Permit: {n:,} permits on {props:,} properties, issued {lo} .. {hi}")
        except Exception as e:
            emit(f"  building records: ({e})")

    os.makedirs(cache, exist_ok=True)
    out = os.path.join(cache, "orion_profile.txt")
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    log.info("wrote %s", out)


def _overlap_report(conn, parcels_path, emit):
    import pyogrio

    sf = pyogrio.read_dataframe(
        parcels_path, columns=["PARCELID", "PropertyID", "TaxYear"],
        read_geometry=False)
    for ty in sorted(sf["TaxYear"].dropna().unique()):
        if ty == 0:
            continue
        sub = sf[sf["TaxYear"] == ty]
        sf_pid = set(sub["PropertyID"].dropna().astype("int64")) - {0}
        sf_geo = set(sub["PARCELID"].dropna().astype(str))
        orp = pd.read_sql(
            f"SELECT PropertyID, GeoCodeSearch FROM Property WHERE TaxYear={int(ty)}", conn)
        o_pid = set(orp["PropertyID"].dropna().astype("int64"))
        o_geo = set(orp["GeoCodeSearch"].dropna().astype(str))
        mp = len(sf_pid & o_pid)
        mg = len(sf_geo & o_geo)
        n = len(sub)
        emit(f"  parcel TaxYear {int(ty)} (n={n:,}): "
             f"PropertyID match {mp:,} ({mp/max(n,1)*100:.1f}%), "
             f"GeoCodeSearch match {mg:,} ({mg/max(n,1)*100:.1f}%)")


def export(conn, cache: str, tax_years: list[int], only: list[str] | None = None) -> None:
    cur = conn.cursor()
    os.makedirs(cache, exist_ok=True)
    yr_in = ",".join(str(int(y)) for y in tax_years)
    for key, (tbl, want, yearcol) in EXPORT_SPEC.items():
        if only and key not in only:
            continue
        have = set(table_columns(cur, tbl))
        cols = [c for c in want if c in have]
        if not cols:
            log.warning("table %s: none of the desired columns present; skipping", tbl)
            continue
        sel = ", ".join(f"[{c}]" for c in cols)
        where = f" WHERE {yearcol} IN ({yr_in})" if (yearcol and yearcol in have) else ""
        sql = f"SELECT {sel} FROM [{tbl}]{where}"
        log.info("exporting %s ...", tbl)
        df = pd.read_sql(sql, conn)
        out = os.path.join(cache, f"{key}.parquet")
        df.to_parquet(out, index=False)
        log.info("  %-14s %s rows, %d cols -> %s", key, f"{len(df):,}", len(df.columns),
                 os.path.basename(out))
    for key, (tbl, sql) in EXPORT_SQL.items():
        if only and key not in only:
            continue
        log.info("exporting %s (reduced) ...", tbl)
        df = pd.read_sql(sql.format(years=yr_in), conn)
        out = os.path.join(cache, f"{key}.parquet")
        df.to_parquet(out, index=False)
        log.info("  %-14s %s rows, %d cols -> %s", key, f"{len(df):,}", len(df.columns),
                 os.path.basename(out))


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="ORION ETL: profile + Parquet export")
    p.add_argument("--server", default="127.0.0.1")
    p.add_argument("--port", type=int, default=1433)
    p.add_argument("--user", default="sa")
    p.add_argument("--password", default=os.environ.get("ORION_SA_PASSWORD"))
    p.add_argument("--database", default="Orion")
    p.add_argument("--timeout", type=int, default=0)
    p.add_argument("--parcels",
                   default="/media/mstone/GeoData/MSDI/MontanaCadastral_SHP/"
                           "Montana_Cadastral/OWNERPARCEL.shp")
    p.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "orion_cache"))
    p.add_argument("--tax-years", type=int, nargs="+", default=[2024, 2025, 2026])
    p.add_argument("--profile", action="store_true")
    p.add_argument("--export", action="store_true")
    p.add_argument("--only", nargs="+", default=None,
                   help="export only these keys of EXPORT_SPEC / EXPORT_SQL")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if not args.password:
        log.error("no password: set ORION_SA_PASSWORD or pass --password")
        return 2
    do_profile = args.profile or not (args.profile or args.export)
    do_export = args.export or not (args.profile or args.export)
    conn = connect(args)
    try:
        if do_profile:
            profile(conn, args.parcels, args.cache)
        if do_export:
            export(conn, args.cache, args.tax_years, args.only)
    finally:
        conn.close()
    log.info("ORION ETL done. cache: %s", args.cache)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
