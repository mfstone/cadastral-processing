"""When land was divided: new lots split from a parcel by a plat, an
amended plat or a certificate of survey.

The exports have no parent-child links, so a division is read by comparing
the same land between two exports, a -> b. A new lot (a lot or block created
between a and b) is DIVIDED land when

1. land was split where it sits: in its quarter-section, a parcel present at a
   is gone at b (retired) or is smaller at b (the remainder of a split keeps
   its geocode and loses area); and
2. its legal description names a division instrument that the parent land's
   descriptions at a did not:
   * a subdivision plat (a new plat, or a new phase of one): "plat";
   * an amended plat or replat ("AMD", "AMENDED", "6TH AM", "REPLAT"),
     which re-divides platted land: "amended";
   * a certificate of survey number ("C.O.S. 2-475", "COS #126735",
     "CS 21581"), the instrument of family-transfer and other exempt splits
     outside a plat: "cos".

Not counted: a parcel re-described with the same area (a field filled in, a
reformatted description: bookkeeping, not division); a new lot re-split
inside a plat its parent was already in, under no new amendment or survey;
a tract split with no instrument named; coverage arriving.

Whether a description names a subdivision: the subdivision field holds a plat
name (not "NONE", a short area code such as "KAL", a bare city name, or a
district), or the legal description names one ("... SUB", "SUBD",
"SUBDIVISION"), except a remainder ("SE4 LESS MARTIN SUBDIVISION") or "SUB
TRACT". A plat is identified by its name and phase.

Writes ``data/events/subdiv_{i}_{a}_{b}.parquet`` (parcel_id, township_key,
how) per interval, read by ``aggregate.flow_tables`` (the ``subdivided``
flow) and ``tiles`` (``sdx``: the export index at which a lot was divided
off).
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import os
import re

import numpy as np
import pandas as pd

log = logging.getLogger("timeseries.subdivisions")

EVENT_DIR = "data/events"
SNAP_DIR = "data/snapshots"
NEW_LOT = ("lot_created", "block_created")

# Words that make a subdivision-field value a plat name even when it is short.
_PLAT_WORD = re.compile(r"\b(?:SUB|SUBD|SUBDIV|SUBDIVISION|ADD|ADDN|ADDITION|TOWNSITE|TOWN SITE|PH|PHASE|PUD|"
                        r"ESTATES|PLAT|TRACTS|HOMESITES|HOME SITES|VILLAGE|HEIGHTS|ACRES|PARK|MEADOWS|RANCH)\b")
_JUNK = {"", "NONE", "N/A", "NA", "UNKNOWN", "UNK", "0", "-", "NULL", "NO SUBDIVISION", "NOT IN SUBDIVISION"}
# A subdivision named in the legal description.
_SUB_IN_LEGAL = re.compile(r"\bSUB(?:D|DIV|DIVISION|DIVISIONS)?\b\.?", re.IGNORECASE)
# "SUB TRACT", "SUB-TRACT": a sub-tract.
_SUB_TRACT = re.compile(r"\bSUB[\s-]+TRACTS?\b", re.IGNORECASE)
# A mention inside a remainder clause: "LESS <...> SUBD", up to the next comma.
_LESS_SUB = re.compile(r"\b(?:LESS|EXC|EXCEPT|EXCL)\b[^,;]*?\bSUB(?:D|DIV|DIVISION|DIVISIONS)?\b", re.IGNORECASE)


def _city_names() -> set[str]:
    """Bare place names that counties put in the subdivision field."""
    path = "site/public/data/cities.geojson"
    try:
        with open(path) as fh:
            gj = json.load(fh)
        return {str(f["properties"].get("name", "")).upper().strip() for f in gj["features"]} - {""}
    except (OSError, ValueError, KeyError):
        return set()


def plat_name(values: pd.Series, cities: set[str]) -> np.ndarray:
    """True where the subdivision field holds a plat name."""
    v = values.fillna("").astype(str).str.upper().str.strip()
    ok = ~v.isin(_JUNK) & ~v.isin(cities) & ~v.str.contains(r"\bDISTRICT\b")
    short = v.str.len() <= 4
    has_word = v.str.contains(_PLAT_WORD)
    # A short value is a plat name only with a plat word ("KAL ADD 1" is; "KAL" is not).
    return (ok & (~short | has_word)).to_numpy(dtype=bool)


def named_in_legal(legal: pd.Series) -> np.ndarray:
    """True where the legal description names a subdivision the parcel is in."""
    s = legal.fillna("").astype(str)
    cleaned = s.str.replace(_SUB_TRACT, " ", regex=True).str.replace(_LESS_SUB, " ", regex=True)
    return cleaned.str.contains(_SUB_IN_LEGAL).to_numpy(dtype=bool)


def in_subdivision(subdivision: pd.Series, legal: pd.Series, cities: set[str] | None = None) -> np.ndarray:
    cities = _city_names() if cities is None else cities
    return plat_name(subdivision, cities) | named_in_legal(legal)


_PUNCT = re.compile(r"[^A-Z0-9 ]+")
_SUB_TOKEN = re.compile(r"\b(?:SUB|SUBD|SUBDIV|SUBDIVISION|SUBDIVISIONS)\b")
_PHASE = re.compile(r"\b(?:PH|PHASE)\s*([0-9]+[A-Z]?|[IVX]+)\b")
# Section, township and range codes that precede a name in older descriptions.
_PLSS = re.compile(r"\b(?:S|SEC|SECTION)\s*\d+\b|\bT\s*\d+\s*[NS]\b|\bR\s*\d+\s*[EW]\b|\b\d+\s*[NSEW]\b|\b[NSEW]\d?\b")
_LOT_BLK = re.compile(r"\b(?:LOTS?|LT|BLK|BLOCK|TRACT|TR|UNIT|PARCEL)\s*[0-9A-Z-]*\b|\b\d+(?:\.\d+)?\s*(?:AC|ACRES?)\b|\(\d+\)")


def _core(text: str) -> str:
    """A subdivision's identity from a description: the words before SUB (or
    the plat name without lot and block), and its phase."""
    t = _PUNCT.sub(" ", text.upper())
    t = " ".join(t.split())
    if not t:
        return ""
    ph = _PHASE.search(t)
    m = _SUB_TOKEN.search(t)
    if m:
        words = _PLSS.sub(" ", _LOT_BLK.sub(" ", t[:m.start()])).split()
        core = " ".join(words[-5:])
    else:
        core = " ".join(_LOT_BLK.sub(" ", _PHASE.sub(" ", t)).split())
    return f"{core}|{ph.group(1)}" if ph else core


def sub_keys(subdivision: pd.Series, legal: pd.Series, cities: set[str]) -> np.ndarray:
    """Each parcel's subdivision identity, or "" when it is not in one."""
    field = subdivision.fillna("").astype(str)
    lg = legal.fillna("").astype(str)
    by_field = plat_name(field, cities)
    cleaned = lg.str.replace(_SUB_TRACT, " ", regex=True).str.replace(_LESS_SUB, " ", regex=True)
    by_legal = cleaned.str.contains(_SUB_IN_LEGAL).to_numpy(dtype=bool)
    out = np.full(len(field), "", dtype=object)
    fv, cv = field.to_numpy(), cleaned.to_numpy()
    for k in np.flatnonzero(by_field | by_legal):
        if by_field[k]:
            out[k] = _core(fv[k]) or "?"
        else:
            # The clause of the legal description that names the subdivision.
            clause = next((c for c in re.split(r"[,;]", cv[k]) if _SUB_IN_LEGAL.search(c)), cv[k])
            out[k] = _core(clause) or "?"
    return out


_AMEND = re.compile(r"\b(?:AMD|AMEND|AMENDED|AMENDMENT|REPLAT|RE-PLAT|RESUB|RESUBDIVISION|\d+(?:ST|ND|RD|TH)\s+AM|AM)\b")
_COS = re.compile(r"\b(?:C\s?\.?\s?O\s?\.?\s?S|COS|CS|CERT(?:IFICATE)?\s+OF\s+SURVEY)\s*\.?\s*(?:NO\.?|#)?\s*([0-9][0-9A-Z-]*)")
_AMEND_REF = re.compile(r"\b(\d+(?:ST|ND|RD|TH)?)\s+AM(?:D|ENDED)?\b|\bPLAT\s+([0-9A-Z-]+)\s+AM(?:D|ENDED)?\b")


def instruments(subdivision: pd.Series, legal: pd.Series, cert: pd.Series, cities: set[str]) -> pd.DataFrame:
    """Per parcel: its plat key, its amended-plat key and its survey numbers."""
    plat = sub_keys(subdivision, legal, cities)
    text = (subdivision.fillna("").astype(str) + " " + legal.fillna("").astype(str)).str.upper()
    amended = text.str.contains(_AMEND)
    # An amendment is identified by its plat and its reference ("6TH AM", "PLAT 2065 AM") where given.
    ref = text.str.extract(_AMEND_REF).fillna("").agg("".join, axis=1)
    am_key = np.where(amended.to_numpy(), pd.Series(plat).fillna("").to_numpy() + "|AM" + ref.to_numpy(), "")
    cos_text = (cert.fillna("").astype(str) + " " + legal.fillna("").astype(str)).str.upper()
    cos = cos_text.str.findall(_COS).map(lambda xs: frozenset(x.strip("-") for x in xs if x))
    return pd.DataFrame({"plat": plat, "amended": am_key, "cos": cos.to_numpy()}, index=subdivision.index)


def build(event_dir: str = EVENT_DIR, snap_dir: str = SNAP_DIR) -> dict:
    cities = _city_names()
    cols = ["parcel_id", "subdivision", "legal_desc", "cert_survey", "acres"]
    qa = {"intervals": [], "divided": 0, "plat": 0, "amended": 0, "cos": 0,
          "new_lots": 0, "no_split_in_quarter": 0, "no_new_instrument": 0}
    for f in glob.glob(os.path.join(event_dir, "subdiv_*.parquet")):
        os.remove(f)   # a previous rule's sidecars

    def load(date):
        d = pd.read_parquet(os.path.join(snap_dir, f"parcels_{date}.parquet"), columns=cols).drop_duplicates("parcel_id")
        d = d.reset_index(drop=True)
        return d.join(instruments(d["subdivision"], d["legal_desc"], d["cert_survey"], cities))

    prev_date, prev = None, None
    for epath in sorted(glob.glob(os.path.join(event_dir, "events_*.parquet"))):
        base = os.path.basename(epath)[:-len(".parquet")]
        _, idx, da, db = base.split("_")
        if prev_date != da:
            prev = load(da)
        cur = load(db)

        # The parent land: parcels at a that are gone at b, or smaller at b.
        acres_b = cur.set_index("parcel_id")["acres"]
        gone = ~prev["parcel_id"].isin(acres_b.index)
        shrunk = prev["parcel_id"].map(acres_b) < 0.95 * prev["acres"]
        par = prev[gone | shrunk.fillna(False)]
        par_q = par["parcel_id"].str.slice(0, 9)
        plats = set(zip(par_q, par["plat"]))
        amends = set(zip(par_q, par["amended"]))
        cos_by_q: dict = {}
        for q, c in zip(par_q, par["cos"]):
            cos_by_q.setdefault(q, set()).update(c)
        split_q = set(par_q)

        ev = pd.read_parquet(epath, columns=["parcel_id", "event_class"])
        new_ids = set(ev.loc[ev["event_class"].isin(NEW_LOT), "parcel_id"])
        new = cur[cur["parcel_id"].isin(new_ids)]
        q = new["parcel_id"].str.slice(0, 9).to_numpy()
        how = np.full(len(new), "", dtype=object)
        for k, (qq, p, am, cs) in enumerate(zip(q, new["plat"], new["amended"], new["cos"])):
            if qq not in split_q:
                continue
            if am and (qq, am) not in amends:
                how[k] = "amended"
            elif p and (qq, p) not in plats:
                how[k] = "plat"
            elif cs and not cs <= cos_by_q.get(qq, set()):
                how[k] = "cos"
        hit = how != ""
        out = pd.DataFrame({"parcel_id": new["parcel_id"].to_numpy()[hit], "how": how[hit]})
        out["township_key"] = out["parcel_id"].str.slice(0, 6)
        out.to_parquet(os.path.join(event_dir, f"subdiv_{idx}_{da}_{db}.parquet"), index=False)
        counts = out["how"].value_counts().to_dict()
        row = {"interval": int(idx), "a": da, "b": db, "new_lots": int(len(new)), "divided": int(hit.sum()),
               **{k: int(counts.get(k, 0)) for k in ("plat", "amended", "cos")},
               "no_split_in_quarter": int(sum(qq not in split_q for qq in q))}
        row["no_new_instrument"] = row["new_lots"] - row["divided"] - row["no_split_in_quarter"]
        qa["intervals"].append(row)
        for k in ("divided", "plat", "amended", "cos", "new_lots", "no_split_in_quarter", "no_new_instrument"):
            qa[k] += row[k]
        log.info("[%s] %s -> %s  new lots %6s  divided %6s (plat %5s, amended %4s, COS %5s)  no split %5s  no instrument %6s",
                 idx, da, db, f"{row['new_lots']:,}", f"{row['divided']:,}", f"{row['plat']:,}", f"{row['amended']:,}",
                 f"{row['cos']:,}", f"{row['no_split_in_quarter']:,}", f"{row['no_new_instrument']:,}")
        prev_date, prev = db, cur
    with open(os.path.join(event_dir, "qa_subdivisions.json"), "w") as fh:
        json.dump(qa, fh, indent=2)
    log.info("all intervals: %s of %s new lots divided (plat %s, amended %s, COS %s)",
             f"{qa['divided']:,}", f"{qa['new_lots']:,}", f"{qa['plat']:,}", f"{qa['amended']:,}", f"{qa['cos']:,}")
    return qa


def load_flags(event_dir: str = EVENT_DIR) -> dict[int, pd.DataFrame]:
    """The sidecars by interval index; empty when the stage has not run."""
    out = {}
    for p in glob.glob(os.path.join(event_dir, "subdiv_*.parquet")):
        idx = int(os.path.basename(p).split("_")[1])
        out[idx] = pd.read_parquet(p)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--events", default=EVENT_DIR)
    ap.add_argument("--snapshots", default=SNAP_DIR)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    build(args.events, args.snapshots)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
