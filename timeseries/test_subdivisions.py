"""python -m unittest timeseries.test_subdivisions -- the in-a-subdivision test,
on legal descriptions and field values taken from the exports."""
import unittest

import pandas as pd

from timeseries.subdivisions import _core, in_subdivision, instruments, named_in_legal, plat_name

CITIES = {"COLUMBIA FALLS", "KALISPELL"}


class LegalDescription(unittest.TestCase):
    def check(self, text, expected):
        self.assertEqual(bool(named_in_legal(pd.Series([text]))[0]), expected, text)

    def test_named_subdivisions_count(self):
        self.check("CAMERON TOWNSITE MINOR SUBD. LOT 1      1.00 AC.", True)
        self.check("GALLATIN PARK SUB             E2  SEC 36 1S 5E  .466AC                LOT 7  BLK3", True)
        self.check("S18, T1 N, R59 E, C.O.S. 289, LOT 10 CALAMITY JANE SUBDIVISION", True)
        self.check("S34, T02 S, R22 E, C.O.S. 389342, PARCEL TR 3-C1, ACRES 10.006, IN FOOS SUBD", True)

    def test_remainders_and_sub_tracts_do_not(self):
        self.check("S14, T33 N, R41 E, ACRES 120.01, SE4 LESS MARTIN SUBDIVISION (24)", False)
        self.check("S07, T28 N, R40 E,  Acres 19.34, PT SW4NE4, LESS SCOTTISH HILLS ESTATES SUBD (24)", False)
        self.check("SUB TRACT IN NW4 SE4", False)

    def test_tracts_surveys_and_aliquots_do_not(self):
        for t in ("TR 1B IN N2NW4", "S30, T16 N, R25 W, C.O.S. 672B, PARCEL 4, ACRES 20.351",
                  "S17, T11 S, R06 W, ACRES 66, PT OF S2NE4 & NW4SE4", "", None):
            self.check(t, False)

    def test_a_remainder_does_not_hide_a_second_subdivision(self):
        self.check("LOT 3 ELK SUBD, LESS N 10 FT, S2 LESS MARTIN SUBD", True)


class SubdivisionField(unittest.TestCase):
    def test_plat_names_count_codes_and_placeholders_do_not(self):
        vals = pd.Series(["WEST POST SUB PH 4", "THOMPSON FALLS ORIG TOWNSITE", "KAL ADD 1", "PRONGHORN MEADOWS PUD NBHD 002",
                          "NONE", "KAL", "WFSH", "COLUMBIA FALLS", "", None])
        self.assertEqual(plat_name(vals, CITIES).tolist(),
                         [True, True, True, True, False, False, False, False, False, False])

    def test_either_source_is_enough(self):
        got = in_subdivision(pd.Series(["", "ELK GROVE SUB PH1", "NONE"]),
                             pd.Series(["LOT 2 RAINBOW SUBD", "", "TR 5HAB IN NE4NE4"]), CITIES)
        self.assertEqual(got.tolist(), [True, True, False])


class Instruments(unittest.TestCase):
    def test_plats_amendments_and_surveys(self):
        t = instruments(
            pd.Series(["DIAMOND C LINKS SUB COS 1448 6TH AM", "", "", "MOCCASIN LIGHTING DISTRICT", "WEST POST SUB PH 4"]),
            pd.Series(["", "S06, T03 S, R24 E, 310 CORNER SUBD LT 1 PLAT 2065 AM", "S30, T09 N, R01 E, C.O.S. 2-475, ACRES 4",
                       "ALL 24-19-9 (645.807 AC)", "S06, T02 S, R06 E, WEST POST SUB PH 4, BLOCK 3, Lot 12"]),
            pd.Series(["", "", "", "", ""]), set())
        self.assertEqual(t["amended"].tolist()[:2], ["DIAMOND C LINKS|AM6TH", "310 CORNER|AM2065"])
        self.assertEqual(t["cos"].tolist()[2], frozenset({"2-475"}))
        self.assertEqual(t["plat"].tolist()[3:], ["", "WEST POST|4"])

    def test_a_plat_reads_the_same_in_the_field_and_the_legal_description(self):
        self.assertEqual(_core("WEST POST SUB PH 4"), _core(" WEST POST SUB PH 4"))
        self.assertEqual(_core("S06 T02S R06E GALLATIN PARK SUB LOT 7"), _core("GALLATIN PARK SUB"))


if __name__ == "__main__":
    unittest.main()
