"""python -m unittest timeseries.test_publish_withheld -- names withheld on request."""
import os
import tempfile
import unittest

import pandas as pd

from timeseries.publish import WITHHELD_LABEL, withhold_names


class Withheld(unittest.TestCase):
    def setUp(self):
        self.top = pd.DataFrame({
            "county_n": [6, 6, 31, 6],
            "display_name": ["SMITH JOHN A", "Example  Ranch LLC", "SMITH JOHN A", "OTHER OWNER"],
            "display_city": ["BOZEMAN", "BELGRADE", "HELENA", "BUTTE"],
            "display_state": ["MT", "MT", "MT", "MT"],
        })
        fd, self.path = tempfile.mkstemp(suffix=".csv")
        os.close(fd)

    def tearDown(self):
        os.unlink(self.path)

    def write(self, text):
        with open(self.path, "w") as f:
            f.write(text)

    def test_no_list_changes_nothing(self):
        out, n = withhold_names(self.top, path=self.path + ".missing")
        self.assertEqual(n, 0)
        self.assertListEqual(list(out["display_name"]), list(self.top["display_name"]))

    def test_every_county_and_one_county(self):
        self.write("name,county_n\nsmith john a,\nEXAMPLE RANCH LLC,6\n")
        out, n = withhold_names(self.top, path=self.path)
        self.assertEqual(n, 3)
        self.assertListEqual(list(out["display_name"]), [WITHHELD_LABEL] * 3 + ["OTHER OWNER"])
        self.assertListEqual(list(out["display_city"]), ["", "", "", "BUTTE"])
        self.assertEqual(self.top.loc[0, "display_name"], "SMITH JOHN A")  # input untouched

    def test_county_scoped_entry_spares_other_counties(self):
        self.write("name,county_n\nSMITH JOHN A,31\n")
        out, n = withhold_names(self.top, path=self.path)
        self.assertEqual(n, 1)
        self.assertEqual(out.loc[0, "display_name"], "SMITH JOHN A")
        self.assertEqual(out.loc[2, "display_name"], WITHHELD_LABEL)


if __name__ == "__main__":
    unittest.main()
