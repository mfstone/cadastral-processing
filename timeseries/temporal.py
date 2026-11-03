"""The time each input speaks for.

Three times are distinct and are kept distinct here:

* **observation** -- when the source was captured or exported;
* **effective** -- the period the represented condition holds for;
* **processing** -- when this pipeline took the record in (the release
  manifest carries that).

They are not interchangeable, and the dashboard combines sources with very
different ones: 29 parcel exports observed on their own dates, a public-lands
layer observed once in 2026 and applied to every year, building records from
three refreshes each carrying several tax years. Each entry below says what
its source can legitimately support, and the publish stage ships the list so
the About tab, the reports and the assistant's instructions all say the same
thing. The point is the one case that matters most: a classification observed
today and applied to the past is a *contemporary* classification of
historical records, and a series built on it answers "how were the parcels
inside what is public land today classified in year Y", not "how much land
was public in year Y".
"""

from __future__ import annotations

DATASETS: list[dict] = [
    {
        "key": "cadastral",
        "name": "Montana Cadastral Framework parcel exports",
        "provider": "Montana State Library, from Department of Revenue records",
        "observation": "each export date, 2003-12-22 to 2026-09-04 (29 used; 2002 excluded)",
        "effective": "the export date; a January or February export carries the previous year's assessment roll",
        "applies_to": "its own vintage",
        "inference": "observed: the series is the exports compared vintage to vintage",
        "used_by": ["extract", "events", "aggregate", "ladder", "identity", "holdings"],
    },
    {
        "key": "publiclands",
        "name": "Montana Public Lands layer (MTPublicLands)",
        "provider": "Montana State Library",
        "observation": "2026",
        "effective": "2026",
        "applies_to": "every vintage",
        "inference": "contemporary classification applied retrospectively: public domain by area overlap is "
                     "today's public-land boundary applied to every year's parcels, so the tenure series says "
                     "how the parcels inside what is public land today were classified, not how much land was "
                     "public in a given year; land that changed hands between the public and private domains "
                     "during the series is classified by its 2026 status throughout",
        "used_by": ["publiclands", "tenure_area", "holdings"],
    },
    {
        "key": "reservations",
        "name": "Reservation boundaries",
        "provider": "Montana State Library",
        "observation": "2026",
        "effective": "treated as stable over the series",
        "applies_to": "every vintage",
        "inference": "jurisdiction, not ownership, and time-invariant for this purpose",
        "used_by": ["reservations", "aggregate"],
    },
    {
        "key": "orion",
        "name": "Department of Revenue ORION appraisal records",
        "provider": "Montana Department of Revenue",
        "observation": "three refreshes: 2016-03-27, 2018-06-21, 2026-06-24",
        "effective": "tax years 2014, 2015-2018 and 2024-2026, each joined to the parcel export that carries its roll",
        "applies_to": "eight points; nothing between 2018 and 2024",
        "inference": "observed at the tax year; a condition rating is as current as the dwelling's last inspection, "
                     "and the rating field changes at the 2014/2015 seam",
        "used_by": ["cama", "identity (party bridge, 2024-2026 only)"],
    },
    {
        "key": "structures",
        "name": "Structures Framework address points",
        "provider": "Montana State Library",
        "observation": "exported 2026-10-30",
        "effective": "2026",
        "applies_to": "the newest export only",
        "inference": "contemporary; the framework has no history, so only the newest point carries the witness",
        "used_by": ["structures", "cama"],
    },
    {
        "key": "footprints",
        "name": "Building footprints: Microsoft 2018 release; State Library lidar, 37 project areas",
        "provider": "Microsoft (ODbL), Montana State Library",
        "observation": "2018 release (imagery about 2014-2015); lidar as flown",
        "effective": "as captured",
        "applies_to": "the map only",
        "inference": "reference display; enters no analytic",
        "used_by": ["reference", "tiles"],
    },
    {
        "key": "roads",
        "name": "Transportation Framework road centerlines",
        "provider": "Montana State Library, Department of Transportation",
        "observation": "June 2026",
        "effective": "2026",
        "applies_to": "the map only",
        "inference": "reference display; enters no analytic",
        "used_by": ["reference", "tiles"],
    },
    {
        "key": "cities",
        "name": "Incorporated city limits",
        "provider": "Montana State Library",
        "observation": "2026",
        "effective": "2026",
        "applies_to": "the situs-city to county map behind the absentee gradient, and the map",
        "inference": "contemporary limits applied to every vintage's situs city; the city name on a parcel "
                     "is the vintage's own, the county it maps to is today's",
        "used_by": ["locality", "cities"],
    },
    {
        "key": "plss",
        "name": "PLSS townships",
        "provider": "Montana State Library (2018 and 2019 geodatabases)",
        "observation": "2018-2019",
        "effective": "the survey grid, time-invariant",
        "applies_to": "every vintage",
        "inference": "stable: a township is the same polygon in every year",
        "used_by": ["locator", "geocode", "aggregate"],
    },
    {
        "key": "haggerty2022",
        "name": "Haggerty, Epstein, Gosnell, Rose and Stone (2022), Table 1",
        "provider": "Society & Natural Resources 35(6)",
        "observation": "published 2022",
        "effective": "the 2005 and 2018 vintages for 13 counties",
        "applies_to": "the regression check only",
        "inference": "benchmark: the test is whether the paper's figure lies between the document and maximal tiers",
        "used_by": ["regress"],
    },
]


def registry() -> list[dict]:
    return [dict(d) for d in DATASETS]
