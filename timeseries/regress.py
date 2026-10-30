"""Regression against Table 1 of Haggerty et al. (2022).

The paper's homogenization included a manual pass we cannot replay, so this
reports the residual per cell for each tier rather than asserting equality. A
document-tier residual below the maximal-tier reach, with the paper inside the
bracket, is the expected shape; a county outside it is the thing to look at.

Reads ``data/facts/holdings_county.parquet``; writes
``data/facts/regression_table1.csv`` and prints the summary.
"""

from __future__ import annotations

import os

import pandas as pd

from cadastral.schema import COUNTY_PREFIX

FACT_DIR = "data/facts"

# county -> (total_acres, large05, large18, owners05, owners18, mean05, mean18)
TABLE1 = {
    "Beaverhead": (3566341, 1016370, 1000755, 201, 184, 5057, 5439),
    "Carbon": (1317043, 500292, 485788, 216, 207, 2316, 2347),
    "Fergus": (2783889, 1813265, 1917110, 662, 627, 2739, 3058),
    "Golden Valley": (751440, 681994, 639469, 139, 123, 4906, 5199),
    "Madison": (2305561, 892681, 903931, 241, 238, 3704, 3798),
    "Meagher": (1530928, 921716, 916188, 150, 136, 6145, 6737),
    "Park": (1799453, 649744, 642201, 214, 202, 3036, 3179),
    "Petroleum": (1062205, 570196, 578113, 118, 114, 4832, 5071),
    "Phillips": (3308105, 1512138, 1526557, 373, 329, 4053, 4639),
    "Stillwater": (1147180, 752043, 757024, 305, 280, 2466, 2704),
    "Sweet Grass": (1198785, 780220, 773337, 227, 219, 3437, 3531),
    "Valley": (3155397, 1300854, 1319475, 464, 446, 2804, 2958),
    "Wheatland": (912591, 735919, 735520, 147, 142, 5006, 5180),
}
CANDIDATES = {"2005": ["2005-02-01", "2005-07-21"], "2018": ["2018-01-10", "2018-12-18"]}
NAME_TO_CODE = {v[0]: k for k, v in COUNTY_PREFIX.items()}


def build(fact_dir: str = FACT_DIR) -> pd.DataFrame:
    c = pd.read_parquet(os.path.join(fact_dir, "holdings_county.parquet"))
    rows = []
    for year, dates in CANDIDATES.items():
        for date in dates:
            sub = c[c["snapshot"] == date]
            if sub.empty:
                continue
            for county, t in TABLE1.items():
                code = NAME_TO_CODE[county]
                r = sub[sub["county_n"] == code]
                if r.empty:
                    continue
                r = r.iloc[0]
                t_ac = t[1] if year == "2005" else t[2]
                t_n = t[3] if year == "2005" else t[4]
                t_mean = t[5] if year == "2005" else t[6]
                rows.append({
                    "year": year, "snapshot": date, "county": county,
                    "T1_large_acres": t_ac, "doc_large_acres": r["large_acres"],
                    "max_large_acres": r["large_acres_max"],
                    "T1_owners": t_n, "doc_owners": r["large_owners"], "max_owners": r["large_owners_max"],
                    "T1_mean": t_mean, "doc_mean": r["large_mean"],
                    "acres_resid_pct": 100 * (r["large_acres"] - t_ac) / t_ac,
                    "acres_resid_max_pct": 100 * (r["large_acres_max"] - t_ac) / t_ac,
                    "owners_resid_pct": 100 * (r["large_owners"] - t_n) / t_n,
                    "owners_resid_max_pct": 100 * (r["large_owners_max"] - t_n) / t_n,
                    "clo4": r["clo4"], "provisional_large": r["large_provisional"],
                })
    return pd.DataFrame(rows)


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Regression against Table 1 (Haggerty et al. 2022)")
    ap.add_argument("--facts", default=FACT_DIR)
    args = ap.parse_args(argv)
    df = build(args.facts)
    if df.empty:
        print("no 2005/2018 rows in holdings_county.parquet")
        return 1
    out = os.path.join(args.facts, "regression_table1.csv")
    df.to_csv(out, index=False)
    pd.set_option("display.width", 200)
    for date, sub in df.groupby("snapshot"):
        tot_ac = sub["T1_large_acres"].sum()
        print(f"\n=== {date}: {len(sub)} counties ===")
        print(sub[["county", "T1_large_acres", "doc_large_acres", "acres_resid_pct", "acres_resid_max_pct",
                   "T1_owners", "doc_owners", "owners_resid_pct", "owners_resid_max_pct", "T1_mean", "doc_mean"]]
              .round(1).to_string(index=False))
        print(f"  total large acres: paper {tot_ac:,.0f}  document {sub['doc_large_acres'].sum():,.0f} "
              f"({100 * (sub['doc_large_acres'].sum() - tot_ac) / tot_ac:+.1f}%)  "
              f"maximal {sub['max_large_acres'].sum():,.0f} "
              f"({100 * (sub['max_large_acres'].sum() - tot_ac) / tot_ac:+.1f}%)")
        print(f"  total large owners: paper {sub['T1_owners'].sum():,}  document {sub['doc_owners'].sum():,}  "
              f"maximal {sub['max_owners'].sum():,}")
        inside = ((sub["doc_large_acres"] <= sub["T1_large_acres"] + 1) & (sub["T1_large_acres"] <= sub["max_large_acres"] + 1)).sum()
        print(f"  counties where the paper's acreage lies inside [document, maximal]: {inside}/{len(sub)}")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
