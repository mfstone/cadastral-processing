"""Render the probe's per-snapshot JSON as one cross-snapshot markdown report.

The point of a field-by-field comparison across 24 years is to make drift
visible at a glance, so this is deliberately a wide table per question rather
than a per-snapshot dump.
"""

from __future__ import annotations

import glob
import json
import os

OUT_DIR = "data/probe"


def _load(out_dir: str) -> list[dict]:
    recs = []
    for path in sorted(glob.glob(os.path.join(out_dir, "probe_*.json"))):
        with open(path) as fh:
            recs.append(json.load(fh))
    return [r for r in recs if "error" not in r]


def _n(v, width=0, comma=True):
    if v is None:
        return "-".rjust(width)
    s = f"{v:,}" if comma and isinstance(v, int) else str(v)
    return s.rjust(width) if width else s


def _table(rows: list[list[str]], header: list[str], align: list[str] | None = None) -> str:
    align = align or ["---"] * len(header)
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(align) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def build(out_dir: str = OUT_DIR) -> str:
    recs = _load(out_dir)
    if not recs:
        return "_no probe records_"
    L: list[str] = ["# Step 0 probe report", ""]
    L.append(f"{len(recs)} snapshots probed. "
             f"Read time total: {sum(r.get('read_seconds', 0) for r in recs):.0f}s.")
    L.append("")

    # ---- counts and the accounting identity
    L += ["## Counts and the accounting identity", "",
          "`rows == blank + quarantined + valid` must hold for every snapshot.", ""]
    rows = []
    for r in recs:
        c = r.get("counts", {})
        ident = (c.get("rows") == c.get("parcel_id_blank_or_null", 0)
                 + c.get("parcel_id_quarantined", 0) + c.get("parcel_id_valid", 0))
        rows.append([
            r["date"], r["era"], r["container"],
            _n(c.get("rows")), _n(c.get("parcel_id_blank_or_null")),
            _n(c.get("parcel_id_quarantined")), _n(c.get("parcel_id_valid")),
            _n(c.get("parcel_id_valid_distinct")), _n(c.get("duplicate_rows_valid")),
            "OK" if ident else "**FAIL**",
            f"{r.get('read_seconds', 0):.0f}s",
        ])
    L.append(_table(rows, ["date", "era", "cont", "rows", "blank", "quarantined",
                           "valid rows", "valid parcels", "dup rows", "identity", "read"]))
    L.append("")

    # ---- Q1
    L += ["## Q1 Why does PARCELID repeat?", "",
          "The de-dup rule turns on this. *Differing* owner names mean a "
          "parcel-to-owner join whose collapse would destroy co-ownership; "
          "*identical* names with differing area mean exploded multipart "
          "geometry, where the parts must be summed.", ""]
    rows = []
    for r in recs:
        q = r.get("q1_duplicate_anatomy", {})
        rows.append([
            r["date"], _n(q.get("n_dup_parcel_ids")), _n(q.get("max_rows_per_parcel")),
            _n(q.get("parcels_with_differing_owner_name")),
            _n(q.get("parcels_with_identical_owner_name")),
            f"{q.get('pct_differing', '-')}", _n(q.get("parcels_with_differing_area")),
            f"**{q.get('verdict', '-')}**",
        ])
    L.append(_table(rows, ["date", "dup parcels", "max rows/parcel", "owner differs",
                           "owner identical", "% differ", "area differs", "verdict"]))
    L.append("")

    # ---- aggregation rule
    L += ["## The area aggregation rule", "",
          "If duplicates are exploded geometry then SUM is faithful and MAX "
          "drops the other parts. The gap is era-correlated, so choosing MAX "
          "would publish a spurious acreage trend.", ""]
    rows = []
    for r in recs:
        a = (r.get("q5_area_and_state", {}) or {}).get("aggregation_rule") or {}
        rows.append([r["date"], _n(a.get("parcels")), a.get("sum_rule_Macres", "-"),
                     a.get("max_rule_Macres", "-"), a.get("max_rule_loses_Macres", "-"),
                     a.get("max_rule_loses_pct", "-")])
    L.append(_table(rows, ["date", "parcels", "SUM Macres", "MAX Macres",
                           "MAX loses (Macres)", "MAX loses %"]))
    L.append("")

    # ---- Q2
    L += ["## Q2 Geocode structure", "",
          "`locatable` = first 9 chars parse as county(2) township(4) section(2) "
          "quarter(1) with county 1-56, section 1-36, quarter 0-4.", ""]
    rows = []
    for r in recs:
        q = r.get("q2_geocode", {})
        lens = q.get("length_histogram", {})
        rows.append([
            r["date"], ",".join(f"{k}:{v:,}" for k, v in sorted(lens.items())[:3]),
            f"{q.get('pct_locatable_prefix', '-')}", _n(q.get("distinct_township_codes")),
            _n(q.get("distinct_sections")), _n(q.get("distinct_quarter_sections")),
            _n(q.get("distinct_blocks")), _n(q.get("n_nonzero_unit")),
            _n(q.get("township_codes_spanning_counties")),
        ])
    L.append(_table(rows, ["date", "length histogram", "% locatable", "twp codes",
                           "sections", "qtr-sections", "blocks", "non-zero unit",
                           "codes spanning counties"]))
    L.append("")

    # ---- Q3
    L += ["## Q3 PLSS witness: does the row's own T/R/S agree with the geocode?", "",
          "An independent check on the positional hypothesis, available in "
          "every era (`TRS` 2002-2011, `Township`/`Range`/`Section` 2013+). "
          "`minority rows` is the error budget a majority vote would reassign.", ""]
    rows = []
    for r in recs:
        q = r.get("q3_plss_witness", {})
        d = q.get("ambiguous_code_dominant_share") or {}
        rows.append([
            r["date"], str(q.get("source")), f"{q.get('trs_parse_rate', '-')}",
            f"{q.get('section_agreement_pct', '-')}", _n(q.get("distinct_codes")),
            _n(q.get("distinct_tr_pairs")), _n(q.get("codes_mapping_to_multiple_tr")),
            _n(d.get("minority_rows")), f"{d.get('pct_minority_of_all_rows', '-')}",
            f"{d.get('dominant_share_median', '-')}",
        ])
    L.append(_table(rows, ["date", "source", "TRS parse %", "section agree %",
                           "codes", "T/R pairs", "ambiguous codes", "minority rows",
                           "% minority", "median dominant share"]))
    L.append("")

    # ---- Q4
    L += ["## Q4 Is there a parcel situs (site) city?", "",
          "If the Department of Revenue already says which city a parcel is in, "
          "that beats a quarter-section majority join against TIGER places. "
          "`% differ` is against the owner's mailing city -- a high value "
          "confirms the field really is the parcel's own location.", ""]
    rows = []
    for r in recs:
        q = r.get("q4_situs", {})
        fp = q.get("fields_present", {})
        best = fp.get("situs_city") or fp.get("situs_citystatezip") or {}
        cmp_ = q.get("situs_vs_owner_city") or {}
        rows.append([
            r["date"], str(best.get("column", "-")),
            f"{best.get('pct_non_blank', '-')}", _n(best.get("distinct")),
            f"{cmp_.get('pct_differ', '-')}",
            ", ".join(str(x) for x in (best.get("samples") or [])[:2]),
        ])
    L.append(_table(rows, ["date", "column", "% non-blank", "distinct",
                           "% differ from owner city", "samples"]))
    L.append("")

    # ---- Q5
    L += ["## Q5 Area fields and owner mailing state", "",
          "`TotalAcres` is agricultural acreage only in the early era, so the "
          "parcel-area field is per-era. Owner-state shares are over valid "
          "parcels, not raw rows.", ""]
    rows = []
    for r in recs:
        q = r.get("q5_area_and_state", {})
        st = q.get("owner_state", {}) or {}
        tv = q.get("total_acres_vs_chosen") or {}
        top = list(st.get("top_states", {}).items())
        ca = dict(top).get("CA")
        rows.append([
            r["date"], str(q.get("chosen_area_field")),
            q.get("chosen_total_acres_millions", "-"),
            f"{tv.get('pct_total_acres_zero', '-')}",
            str(st.get("mechanism", "-")), f"{st.get('valid_two_letter_pct', '-')}",
            f"{st.get('pct_MT', '-')}", f"{st.get('pct_out_of_state', '-')}",
            _n(ca),
        ])
    L.append(_table(rows, ["date", "area field", "total Macres", "% TotalAcres zero",
                           "state mechanism", "% valid state", "% MT", "% out-of-state",
                           "CA parcels"]))
    L.append("")

    # ---- coverage / counties
    L += ["## County presence", ""]
    rows = []
    for r in recs:
        c = r.get("counties", {}) or {}
        npid = r.get("null_parcelid_rows", {}) or {}
        missing = c.get("missing_from_1_56") or c.get("missing_abbr") or []
        rows.append([
            r["date"], str(c.get("mechanism", "-")), _n(c.get("n_distinct")),
            (", ".join(str(m) for m in missing) if missing else "none"),
            (", ".join(str(m) for m in (c.get("unexpected") or [])) or "none"),
            f"{npid.get('pct_county_present', '-')}",
        ])
    L.append(_table(rows, ["date", "mechanism", "counties", "missing from 1-56",
                           "unexpected", "% null-PID rows with county"]))
    L.append("")

    # ---- attribute availability
    L += ["## Attribute availability", "",
          "Which corroborating attributes exist in which era -- this decides "
          "which confidence tiers and which v2 features are reachable.", ""]
    rows = []
    for r in recs:
        a = r.get("attributes", {}) or {}
        sub = a.get("subdivision") or {}
        cos = a.get("cert_survey") or {}
        bv = a.get("build_value") or {}
        rows.append([
            r["date"],
            f"{sub.get('pct_non_blank', '-')}", _n(sub.get("distinct")),
            f"{cos.get('pct_non_blank', '-')}", _n(cos.get("distinct")),
            f"{bv.get('pct_gt_zero', '-')}",
            "yes" if a.get("owner_class") else "-",
            "yes" if a.get("res_prop_ind") else "-",
        ])
    L.append(_table(rows, ["date", "subdiv % non-blank", "subdiv distinct",
                           "COS % non-blank", "COS distinct", "% improvement value",
                           "OWNCLASS", "RESPROPIND"]))
    L.append("")

    # ---- unresolved fields
    L += ["## Unresolved probe fields per snapshot", ""]
    rows = []
    for r in recs:
        u = r.get("unresolved_probe_fields", [])
        rows.append([r["date"], str(r.get("n_columns")), str(len(u)),
                     ", ".join(u) if u else "none"])
    L.append(_table(rows, ["date", "columns", "n unresolved", "unresolved"]))
    L.append("")
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Render the Step 0 probe report")
    ap.add_argument("--dir", default=OUT_DIR)
    ap.add_argument("--out", default=os.path.join(OUT_DIR, "PROBE_REPORT.md"))
    args = ap.parse_args(argv)
    text = build(args.dir)
    with open(args.out, "w") as fh:
        fh.write(text + "\n")
    print(f"wrote {args.out} ({len(text):,} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
