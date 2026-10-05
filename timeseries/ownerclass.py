"""Owner legal form, as an ordered and auditable rule list.

Promoted from "nice to have" to load-bearing by measurement: owners matching a
government or tribal name pattern are **12.1% of parcels but 39.0% of mapped
acreage** in 2026, and the ten largest "elsewhere in Montana" owners by acreage
are all federal or state agencies. Any acreage-weighted ownership statistic that
does not separate public from private is simply wrong.

Deliberately a **rule list, not a fitted model.** A public dashboard asserting
that ownership composition changed needs a reader to be able to verify any single
parcel's classification by reading the rules, which a fitted model cannot offer.
Each parcel records which rule fired (`rule_id`), so the classification is
auditable row by row.

Precedence matters and is explicit: the first rule to match wins, so
``STATE OF MONTANA`` is government before ``MONTANA LAND CO`` can be read as an
entity, and ``... FAMILY TRUST LLC`` resolves as an entity rather than a trust.

Ground truth exists only for 2002-2011, via `OWNCLASS` / `GENDESCRIP`. Accuracy
measured there is an **upper bound**, never "the accuracy": the relationship
between name tokens and legal form is not stationary -- single-member LLCs
carrying family names are a 2010s phenomenon -- and there are no labels after
2011 against which to check the drift.

Measured on 2006 (662,394 labelled rows, 97.0% overall):

======================  =========  =========  ======
class                   support    precision  recall
======================  =========  =========  ======
federal                 59,665     0.84       0.94
state                   16,353     0.98       0.93
local_government         8,690     0.81       0.81
**tribal**              16,403     0.94       **0.40**
private (all forms)    561,283     0.99       0.99
======================  =========  =========  ======

**Tribal ownership cannot be detected from owner names and must not be reported
as if it could.** Recall is 0.40 because tribal land is frequently titled to
individual allottees or held in federal trust ("USA IN TRUST") rather than to a
tribe by name. Fixing this needs reservation boundaries, not more patterns. Until
then the tribal class is a floor, and its parcels largely fall into `individual`
and `federal`.

Ranch and farm names are a separate problem: a working ranch is as often a sole
proprietorship under a personal name as a registered company, so they are
flagged by :func:`ag_business_name` rather than forced into a legal form.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

CLASSES = ["federal", "state", "local_government", "tribal", "institution",
           "private_entity", "trust_estate", "individual", "indeterminate"]
CLASS_IDX = {c: i for i, c in enumerate(CLASSES)}
N_CLASSES = len(CLASSES)
PUBLIC_CLASSES = (0, 1, 2, 3)   # federal, state, local, tribal

# Ordered (rule_id, class, pattern). First match wins; rule_id is published so a
# classification can be traced to the exact rule that produced it.
RULES: list[tuple[int, str, str]] = [
    (10, "federal", r"\b(UNITED STATES|U S A|USA|US GOVERNMENT|USDA|USDI|"
                    r"FOREST SERVICE|US FOREST|NATIONAL FOREST|BUREAU OF LAND|"
                    r"BUREAU OF RECLAMATION|FISH (AND|&) WILDLIFE|NATIONAL PARK|"
                    r"NATIONAL WILDLIFE|CORPS OF ENGINEERS|DEPARTMENT OF DEFENSE|"
                    r"DEPT OF DEFENSE|AIR FORCE|POSTAL SERVICE|BLM|BUREAU OF INDIAN|"
                    r"DEPARTMENT OF AGRICULTURE|DEPT OF AGRICULTURE|"
                    r"DEPARTMENT OF (?:THE )?INTERIOR|DEPT OF (?:THE )?INTERIOR)\b"),
    (20, "tribal", r"\b(TRIBE|TRIBES|TRIBAL|CONFEDERATED|ASSINIBOINE|SIOUX|"
                   r"BLACKFEET|CROW NATION|NORTHERN CHEYENNE|SALISH|KOOTENAI|"
                   r"CHIPPEWA|CREE|GROS VENTRE|FORT BELKNAP|FORT PECK|"
                   r"INDIAN RESERVATION|INDIAN ALLOTMENT|ALLOTMENT|RESERVATION)\b"),
    (30, "state", r"\b(STATE OF MONTANA|STATE OF MT|MT STATE TRUST|MONTANA STATE|STATE HIGHWAY|"
                  r"DEPARTMENT OF NATURAL RESOURCE|DEPT OF NATURAL RESOURCE|DNRC|"
                  r"MONTANA DEPARTMENT|MONTANA DEPT|MONTANA FISH|FISH WILDLIFE (AND|&) PARKS|"
                  r"BOARD OF REGENTS|UNIVERSITY OF MONTANA|MONTANA UNIVERSITY|"
                  r"MONTANA TECH|MONTANA ARMY NATIONAL|"
                  r"(?:DEPT|DEPARTMENT) OF STATE LANDS|STATE LANDS)\b"),
    (40, "local_government", r"\b(COUNTY OF|CITY OF|TOWN OF|SCHOOL DISTRICT|"
                             r"SCHOOL DIST|CONSOLIDATED SCHOOL|ELEMENTARY DISTRICT|"
                             r"HIGH SCHOOL DISTRICT|IRRIGATION DISTRICT|"
                             r"CONSERVATION DISTRICT|WATER (AND|&) SEWER|"
                             r"RURAL FIRE|FIRE DISTRICT|CEMETERY DISTRICT|"
                             r"HOSPITAL DISTRICT|PORT AUTHORITY|HOUSING AUTHORITY|"
                             r"SILVER BOW|ANACONDA DEER LODGE)\b"),
    # County names used bare, e.g. "FLATHEAD COUNTY", "LEWIS AND CLARK COUNTY".
    (41, "local_government", r"\bCOUNTY\b(?!.*\b(?:RANCH|FARM|LAND CO|LLC|INC)\b)"),
    (50, "institution", r"\b(CHURCH|CATHEDRAL|PARISH|DIOCESE|SYNOD|CONGREGATION|"
                        r"LATTER DAY SAINTS|MINISTRIES|MISSION|TEMPLE|"
                        r"FOUNDATION|CONSERVANCY|LAND TRUST|NATURE CONSERVANCY|"
                        r"ROCKY MOUNTAIN ELK|DUCKS UNLIMITED|AUDUBON|"
                        r"CEMETERY|HOSPITAL|UNIVERSITY|COLLEGE|ACADEMY|"
                        r"BOY SCOUTS|GIRL SCOUTS|YMCA|SALVATION ARMY|"
                        r"HABITAT FOR HUMANITY|NON ?PROFIT)\b"),
    (60, "private_entity", r"\b(LLC|L L C|LLP|LP|PLLC|INC|INCORPORATED|CORP|"
                           r"CORPORATION|COMPANY|CO|LTD|LIMITED|PARTNERSHIP|"
                           r"PARTNERS|ASSOCIATES|ASSOCIATION|ENTERPRISES|"
                           r"HOLDINGS|PROPERTIES|INVESTMENTS|GROUP|VENTURES|"
                           r"BANK|CREDIT UNION|RAILWAY|RAILROAD|RY CO|"
                           r"TELEPHONE|ELECTRIC CO|POWER CO|PIPELINE|"
                           r"OIL|GAS CO|MINING CO|TIMBER CO|LUMBER|"
                           r"ASSOC|ASSN|COOP|CO OP|GRAZING ASSOC)\b"),
    (70, "trust_estate", r"\b(TRUST|TRUSTEE|TRUSTEES|ESTATE OF|LIFE ESTATE|"
                         r"REVOCABLE|IRREVOCABLE|LIVING TRUST|FAMILY TRUST)\b"),
]
_COMPILED = [(rid, CLASS_IDX[cls], re.compile(pat)) for rid, cls, pat in RULES]


def classify(name_norm: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """Return (class_idx, rule_id) arrays. Blank names are ``indeterminate``."""
    s = name_norm.fillna("").astype(str)
    n = len(s)
    cls = np.full(n, CLASS_IDX["individual"], dtype="int8")
    rid = np.zeros(n, dtype="int16")        # 0 = no rule fired -> individual
    unset = np.ones(n, dtype=bool)
    arr = s.to_numpy()
    for rule_id, class_idx, pat in _COMPILED:
        if not unset.any():
            break
        idx = np.flatnonzero(unset)
        hit = np.fromiter((pat.search(arr[i]) is not None for i in idx),
                          dtype=bool, count=len(idx))
        chosen = idx[hit]
        cls[chosen] = class_idx
        rid[chosen] = rule_id
        unset[chosen] = False
    blank = np.asarray(s.str.strip() == "", dtype=bool)
    cls[blank] = CLASS_IDX["indeterminate"]
    rid[blank] = -1
    return cls, rid


def is_public(cls: np.ndarray) -> np.ndarray:
    return np.isin(cls, PUBLIC_CLASSES)


# A working ranch is as often a sole proprietorship under a personal name as it
# is a registered company, so "S BAR B RANCH" cannot be assigned a legal form
# without guessing. Carried as a separate flag rather than forced into a class,
# which also makes it directly useful as a dashboard filter.
_AG_BUSINESS = re.compile(r"\b(RANCH|RANCHES|RANCHO|FARM|FARMS|LIVESTOCK|CATTLE|"
                          r"GRAZING|SHEEP|ANGUS|HEREFORD|FEEDLOT|DAIRY|ORCHARD|"
                          r"VINEYARD|TIMBER|FORESTRY)\b")


def ag_business_name(name_norm: pd.Series) -> np.ndarray:
    """Owner name carries an agricultural-operation token."""
    return np.asarray(name_norm.fillna("").astype(str).str.contains(_AG_BUSINESS, regex=True),
                      dtype=bool)


# ------------------------------------------------------------------ calibration
# OWNCLASS (2002-2011) is the only ground truth. Map its 17 values onto the
# classes above; Right of Way / Water / Undetermined have no counterpart and are
# excluded from the accuracy figures rather than forced into one.
OWNCLASS_TO_CLASS = {
    "USDA FOREST SERVICE": "federal", "USDI BUREAU OF LAND MANAGEMENT": "federal",
    "USDI FISH AND WILDLIFE SERVICE": "federal", "USDI NATIONAL PARK SERVICE": "federal",
    "USDI BUREAU OF RECLAMATION": "federal", "USDI BUREAU OF INDIAN AFFAIRS": "federal",
    "US GOVERNMENT": "federal", "US DEPARTMENT OF DEFENSE": "federal",
    "US DEPARTMENT OF AGRICULTURE": "federal", "US DEPARTMENT OF INTERIOR": "federal",
    "STATE GOVERNMENT": "state", "LOCAL GOVERNMENT": "local_government",
    "TRIBAL": "tribal",
}
EXCLUDE_FROM_CALIBRATION = {"RIGHT OF WAY", "WATER", "UNDETERMINED", ""}


def calibrate(df: pd.DataFrame) -> dict:
    """Confusion report against `OWNCLASS`, for a vintage that carries it."""
    truth_raw = df["owner_class"].fillna("").str.upper().str.strip()
    keep = ~truth_raw.isin(EXCLUDE_FROM_CALIBRATION)
    sub = df[keep]
    truth_lbl = truth_raw[keep].map(OWNCLASS_TO_CLASS)
    # Anything OWNCLASS calls private is private of some form; the rules split it
    # further, so collapse the predicted private forms when scoring that label.
    truth_lbl = truth_lbl.fillna("private")
    pred, _ = classify(sub["owner_name_norm"])
    pred_lbl = pd.Series([CLASSES[c] for c in pred], index=sub.index)
    pred_coarse = pred_lbl.map(lambda c: c if c in
                               ("federal", "state", "local_government", "tribal")
                               else "private")

    labels = ["federal", "state", "local_government", "tribal", "private"]
    rep = {}
    for lab in labels:
        tp = int(((truth_lbl == lab) & (pred_coarse == lab)).sum())
        fp = int(((truth_lbl != lab) & (pred_coarse == lab)).sum())
        fn = int(((truth_lbl == lab) & (pred_coarse != lab)).sum())
        rep[lab] = {
            "support": int((truth_lbl == lab).sum()),
            "precision": round(tp / max(1, tp + fp), 4),
            "recall": round(tp / max(1, tp + fn), 4),
        }
    rep["_overall_accuracy"] = round(float((truth_lbl == pred_coarse).mean()), 4)
    rep["_scored_rows"] = int(len(sub))
    rep["_excluded_rows"] = int((~keep).sum())
    rep["_note"] = ("accuracy measured on 2002-2011 labels is an upper bound; the "
                    "name-to-form relationship is not stationary and there are no "
                    "labels after 2011")
    return rep
