"""Snapshot discovery: absorb every container and layer-name quirk, once.

The 30 MSL archives drift in four ways that no downstream stage should ever
have to know about:

* **container** -- flat shapefile (2002-2016), FileGDB only (2017-2020), FileGDB
  *plus* a fully redundant shapefile (2021-2025), shapefile again (2026).
* **nesting depth** -- ``Cadastral20021220.shp`` at the zip root, but
  ``MTCadastral_GDB/StatewideV10.gdb`` in 2018-01 and
  ``Montana_Parcels/Montana_Parcels.shp`` in 2026.
* **container name** -- ``StatewideParcel.gdb`` -> ``StatewideV10.gdb`` ->
  ``Montana_Parcels.gdb`` -> ``Montana_Parcels_YYYYMMDD.gdb``.
* **layer name** -- ``OwnerParcel`` -> ``Montana_OwnerParcels_20221231`` ->
  ``OwnerParcel_20251231``.

Reading strategy differs by container, and the difference is not cosmetic.

**Shapefiles read in place through ``/vsizip/``** -- the DBF is one member read
start to finish, so inflating it on the fly costs nothing. A statewide era-A
attribute read is 16-35 s.

**Geodatabases must be staged to local disk first.** A ``.gdb`` is a directory
of many members and the driver seeks across them, which ``/vsizip/`` can only
serve by re-inflating the deflate stream from its last checkpoint. Measured on
the 2017 vintage: 78 GB of logical reads against a 539 MB dataset, 2.66 GB/s of
re-inflation with zero additional disk traffic, and no sign of finishing after
ten minutes. :meth:`Snapshot.local` unpacks the ``.gdb`` to scratch, which turns
the same read into seconds. Use it for every read; it is a no-op for
shapefiles.
"""

from __future__ import annotations

import contextlib
import dataclasses
import datetime as _dt
import json
import logging
import os
import re
import shutil
import tempfile
import zipfile

import pyogrio

log = logging.getLogger("timeseries.sources")

DEFAULT_ROOT = "/media/mstone/Extreme SSD/Cadastral"
# Scratch for staged geodatabases; one at a time, ~0.5 GB each.
STAGE_DIR = os.environ.get("CADASTRAL_STAGE_DIR", "data/_stage")
ZIP_RE = re.compile(r"^Cadastral(\d{8})\.zip$", re.IGNORECASE)

# 2002 lacks the five most populous counties -- Silver Bow, Yellowstone,
# Missoula, Gallatin, Flathead -- i.e. exactly where parcels get created, so it
# is excluded from every comparison rather than merely flagged.
EXCLUDED_SNAPSHOTS = {"2002-12-20"}
COUNTIES_MISSING_2002 = [1, 3, 4, 6, 7]

# Known-absent vintages. Confirmed absent upstream on MSL's FTP as well, so
# there is nothing to re-download; events spanning them are "observed during
# 2011-2013" / "2014-2016" and never attributed to a calendar year.
MISSING_YEARS = (2012, 2015)

_PARCEL_LAYER_RE = re.compile(r"parcel", re.IGNORECASE)
_NOT_PARCEL_RE = re.compile(r"plss|township(?!.*parcel)", re.IGNORECASE)


def era_of(date: str) -> str:
    """Structural era, which is what determines field names and area units."""
    if date <= "2016-01-12":
        return "A"   # flat shapefile
    if date <= "2020-12-31":
        return "B"   # FileGDB only
    if date <= "2025-12-31":
        return "C"   # FileGDB + redundant shapefile
    return "D"       # shapefile, nested


@dataclasses.dataclass
class Snapshot:
    """One cadastral vintage, resolved to a directly readable GDAL path."""

    date: str                 # ISO, from the filename
    zip_path: str
    zip_bytes: int
    era: str
    container: str            # "gdb" | "shp"
    inner_path: str           # path inside the zip
    layer: str | None         # layer name (geodatabases only)
    vsi: str                  # the /vsizip/ URI to hand to GDAL/pyogrio
    alt_container: str | None = None   # the redundant copy, where one exists
    excluded: bool = False
    exclude_reason: str = ""

    @property
    def year(self) -> int:
        return int(self.date[:4])

    # pyogrio takes path_or_buffer positional-only, and the layer kwarg is only
    # meaningful for geodatabases, so both reads are wrapped here. No caller
    # should ever have to know whether this vintage is a shapefile or a GDB.
    def info(self) -> dict:
        """Header-level metadata: fields, CRS, feature count. Near-instant."""
        return pyogrio.read_info(self.vsi, layer=self.layer)

    def read(self, columns: list[str] | None = None, **kwargs):
        """Attribute-only read. Geometry is never requested by default."""
        kwargs.setdefault("read_geometry", False)
        return pyogrio.read_dataframe(self.vsi, layer=self.layer, columns=columns, **kwargs)

    def list_layers(self) -> list[str]:
        return [str(row[0]) for row in pyogrio.list_layers(self.vsi)]

    @contextlib.contextmanager
    def local(self, workdir: str | None = None):
        """Yield a snapshot whose path is cheap to read, cleaning up after.

        A no-op for shapefiles. For geodatabases, unpacks just this ``.gdb``
        subtree to scratch and yields a clone pointing at it -- see the module
        docstring for why reading a GDB through ``/vsizip/`` does not work.
        """
        if self.container != "gdb":
            yield self
            return
        workdir = workdir or STAGE_DIR
        os.makedirs(workdir, exist_ok=True)
        tmp = tempfile.mkdtemp(prefix=f"cad_{self.date}_", dir=workdir)
        try:
            prefix = self.inner_path.rstrip("/") + "/"
            with zipfile.ZipFile(self.zip_path) as zf:
                members = [n for n in zf.namelist() if n.startswith(prefix)]
                if not members:
                    raise RuntimeError(f"{self.zip_path}: nothing under {prefix!r}")
                log.info("    staging %d .gdb members to scratch", len(members))
                zf.extractall(tmp, members)
            yield dataclasses.replace(self, vsi=os.path.join(tmp, self.inner_path))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def _pick_parcel_layer(vsi_gdb: str) -> str:
    """Choose the parcel feature class from a geodatabase.

    2018-2019 also ship a ``PLSSTownship`` layer (4,191 features, pure survey
    grid), so "the only layer" is not a safe assumption. Prefer a name
    containing "parcel"; fall back to the largest layer by feature count.
    """
    layers = [str(row[0]) for row in pyogrio.list_layers(vsi_gdb)]
    if not layers:
        raise RuntimeError(f"no layers in {vsi_gdb}")
    named = [n for n in layers if _PARCEL_LAYER_RE.search(n) and not _NOT_PARCEL_RE.search(n)]
    if len(named) == 1:
        return named[0]
    candidates = named or [n for n in layers if not _NOT_PARCEL_RE.search(n)] or layers
    if len(candidates) == 1:
        return candidates[0]
    counts = {n: int(pyogrio.read_info(vsi_gdb, layer=n).get("features", 0)) for n in candidates}
    best = max(counts, key=counts.get)
    log.debug("layer choice in %s: %s from %s", vsi_gdb, best, counts)
    return best


def _resolve_one(zip_path: str, date: str, prefer: str = "gdb") -> Snapshot:
    names = zipfile.ZipFile(zip_path).namelist()
    gdbs = sorted({n.split(".gdb/")[0] + ".gdb" for n in names if ".gdb/" in n})
    shps = sorted(n for n in names if n.lower().endswith(".shp"))

    use_gdb = bool(gdbs) and (prefer == "gdb" or not shps)
    if use_gdb:
        inner, container = gdbs[0], "gdb"
        alt = shps[0] if shps else None
    elif shps:
        inner, container = shps[0], "shp"
        alt = gdbs[0] if gdbs else None
    else:
        raise RuntimeError(f"{zip_path}: no .shp and no .gdb")

    vsi = f"/vsizip/{zip_path}/{inner}"
    # Layer discovery touches only the GDB catalogue, which is small enough to
    # read through /vsizip/ even though a full attribute scan is not.
    layer = _pick_parcel_layer(vsi) if container == "gdb" else None
    excluded = date in EXCLUDED_SNAPSHOTS
    return Snapshot(
        date=date,
        zip_path=zip_path,
        zip_bytes=os.path.getsize(zip_path),
        era=era_of(date),
        container=container,
        inner_path=inner,
        layer=layer,
        vsi=vsi,
        alt_container=alt,
        excluded=excluded,
        exclude_reason=(
            "missing the 5 most populous counties (Silver Bow, Yellowstone, "
            "Missoula, Gallatin, Flathead)" if excluded else ""
        ),
    )


def discover(root: str = DEFAULT_ROOT, prefer: str = "gdb") -> list[Snapshot]:
    """Resolve every ``Cadastral<YYYYMMDD>.zip`` under *root*, oldest first.

    ``prefer="gdb"`` takes the geodatabase for 2021-2025, whose shapefile copy
    is byte-for-byte redundant (identical feature counts): untruncated field
    names and half the I/O.
    """
    found: list[Snapshot] = []
    for entry in sorted(os.listdir(root)):
        m = ZIP_RE.match(entry)
        if not m:
            continue
        raw = m.group(1)
        date = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
        found.append(_resolve_one(os.path.join(root, entry), date, prefer=prefer))
    if not found:
        raise RuntimeError(f"no Cadastral<YYYYMMDD>.zip archives under {root!r}")
    return found


def usable(snapshots: list[Snapshot]) -> list[Snapshot]:
    """Snapshots that may enter a comparison (i.e. everything but 2002)."""
    return [s for s in snapshots if not s.excluded]


def intervals(snapshots: list[Snapshot]) -> list[tuple[Snapshot, Snapshot]]:
    """Consecutive pairs over the usable series.

    Real day counts are the only honest denominator: seven calendar years carry
    two snapshots and two years carry none, so no pair is "one year" by default.
    """
    use = usable(snapshots)
    return list(zip(use, use[1:]))


def days_between(a: Snapshot, b: Snapshot) -> int:
    d0 = _dt.date.fromisoformat(a.date)
    d1 = _dt.date.fromisoformat(b.date)
    return (d1 - d0).days


def calendar_year_series(snapshots: list[Snapshot]) -> list[Snapshot]:
    """One snapshot per calendar year -- the closest to that year's end.

    Headline maps use this; the full series stays available for investigation.
    """
    best: dict[int, Snapshot] = {}
    for s in usable(snapshots):
        cur = best.get(s.year)
        if cur is None or s.date > cur.date:
            best[s.year] = s
    return [best[y] for y in sorted(best)]


def write_manifest(snapshots: list[Snapshot], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = {
        "generated": _dt.datetime.now().isoformat(timespec="seconds"),
        "root": os.path.dirname(snapshots[0].zip_path) if snapshots else None,
        "n_snapshots": len(snapshots),
        "n_usable": len(usable(snapshots)),
        "missing_years": list(MISSING_YEARS),
        "snapshots": [dataclasses.asdict(s) for s in snapshots],
    }
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2)
    log.info("wrote manifest %s (%d snapshots)", path, len(snapshots))


def load_manifest(path: str) -> list[Snapshot]:
    with open(path) as fh:
        payload = json.load(fh)
    return [Snapshot(**rec) for rec in payload["snapshots"]]
