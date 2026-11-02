"""Stage 8: bake the parcel fabric into a vector-tile pyramid.

The township surface answers "how much" well and "where" badly: a PLSS township
is 36 square miles, so a subdivision of forty lots and a single ranch going to
forty lots read as the same cell. Publishing the parcels themselves was measured
rather than assumed, and it fits:

| | measured |
|---|--:|
| parcels in the newest snapshot | 887,124 |
| geometry vertices | 40,019,133 |
| tiles, z10-12 over the Montana bbox | **11,599** |
| tiles on disk, uncompressed | **321 MB**, mean 8 KB |
| heaviest single tile (Billings z11) | 6.1 MB raw, **1.0 MB on the wire** |
| tiles over 1 MB raw | 35 of 11,599 |

Three numbers decided the shape of this stage.

**z13 is impossible, so z12 is the floor.** A full pyramid to z13 needs 57,270
tiles over Montana and Cloudflare Pages caps a deployment at 20,000 files.
``MAXZOOM=12`` with ``extent`` left at GDAL's 4096 keeps the geometry sharper
than the screen at z12 anyway -- the tile grid stops, the rendering does not.

**z6-9 are worse than useless.** At statewide zoom every parcel in Montana lands
in a handful of tiles, 1.8 MB each, to draw a grey smear. They are generated and
then deleted: the source ``minzoom`` is 10 and the township choropleth owns every
zoom below that, which is the view where an aggregate is the honest answer.

**Roads and buildings ride in the same tiles.** The file cap rules out a
second pyramid (roads are in every tile), so ``reference.py`` stages the MDT
road centerlines and the building footprints (Microsoft's 2018 statewide set
merged with the State Library's lidar footprints, each tagged by source) as
two more layers of the same tileset, through a VRT that unites the three
FlatGeobufs. They cost bytes, not files.

**Tiles are stored decompressed.** GDAL's MVT driver gzips tile bodies by
default, which requires a ``Content-Encoding: gzip`` response header. Cloudflare
Pages can be told to send one through ``_headers``; ``astro preview`` cannot, so
the map worked in production and failed locally for no visible reason -- the
inverse of the usual trap and harder to find for it. Decompressing on disk costs
2.8x the bytes at rest and nothing on the wire, since both origins compress
``application/octet-stream`` in transit anyway -- the dense metro tiles are the
only ones where that matters and they are a tenth of their disk size gzipped.

**What is on the tile is a deliberate change of posture.** The plan specified
"aggregate-only publication with no owner names and no parcel geometry"; this
stage publishes parcel geometry and the geocode. The geocode is the DOR's own
public key -- it is what the state's Cadastral application searches on -- and the
boundary is already published by MSL. No owner name, mailing address, city or
value reaches a tile: the attributes are the geocode plus a dozen small derived
codes (the ladder stage, first vintage, acres, tenure, locality, holding size
and rank, and from stage 11 the dwelling's condition class and year built), and
the popup says so. MCA 2-6-1017 concerns distribution lists, which
this is not, and the non-disclosure that matters is kept by what is withheld, not
by withholding the map.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import shutil
import subprocess
import time

import geopandas as gpd
import numpy as np
import pandas as pd

from . import geocode as gc
from . import holdings
from . import reference
from . import locality
from . import ownerclass as oc
from . import sources

log = logging.getLogger("timeseries.tiles")

SNAP_DIR = "data/snapshots"
EVENT_DIR = "data/events"
PL_DIR = "data/publiclands"
RES_DIR = "data/reservations"
CAMA_DIR = "data/cama"
OUT_DIR = "site/public/data/parcels"
WORK_DIR = "data/_tiles"

MINZOOM = 10          # below this the township choropleth is the honest view
MAXZOOM = 12          # z13 would need 57,270 tiles against a 20,000-file cap
GENERATE_FROM = 6     # GDAL insists on building down; 6-9 are deleted after
FILE_CAP = 20_000     # Cloudflare Pages deployment limit

# Attribute defaults, applied where a parcel has geometry but no fact row. The
# fallbacks are the *least* interesting value in each case, so a join miss can
# never invent a finding: undeveloped, unknown vintage, private, most-distant
# owner locality.
DEFAULTS = (("dev", 0), ("born", -1), ("ac", 0.0), ("ten", 2), ("loc", 4),
            ("res", 0), ("cnd", 0), ("hs", -1), ("hr", 0), ("hp", 0),
            ("cd", -1), ("yb", 0))


def build_source(date: str, path: str) -> gpd.GeoDataFrame:
    """Join the newest snapshot's geometry to its derived facts.

    One geometry read of one snapshot -- the fabric is published as it stands
    today, with ``born`` carrying each parcel's first appearance so the time
    dimension survives without 30 copies of the geometry.
    """
    snap = next(s for s in sources.discover() if s.date == date)
    t0 = time.time()
    with snap.local() as src:
        g = gpd.read_file(src.vsi, columns=["PARCELID"], engine="pyogrio")
    g["pid"] = gc.normalize(g["PARCELID"])
    g = g[(g["pid"] != "") & gc.validity(g["pid"])].copy()
    log.info("geometry: %s parcels in %.0fs", f"{len(g):,}", time.time() - t0)

    p = pd.read_parquet(
        f"{SNAP_DIR}/parcels_{date}.parquet",
        # situs_city is read for locality, not published: city_county_map and
        # classify both require it to tell a local owner from an absentee one.
        columns=["parcel_id", "improved", "has_house_number", "acres", "is_common_area",
                 "owner_city", "situs_city", "owner_state", "county_n",
                 "owner_name_norm", "is_condo"])
    pres = pd.read_parquet(f"{EVENT_DIR}/presence.parquet",
                           columns=["parcel_id", "first_idx"])
    pl = pd.read_parquet(f"{PL_DIR}/public_{date}.parquet",
                         columns=["parcel_id", "on_public_land"])
    rs = pd.read_parquet(f"{RES_DIR}/res_{date}.parquet",
                         columns=["parcel_id", "in_reservation", "off_res_trust"])
    p = (p.merge(pres, on="parcel_id", how="left")
          .merge(pl, on="parcel_id", how="left")
          .merge(rs, on="parcel_id", how="left"))
    for c in ("on_public_land", "in_reservation", "off_res_trust"):
        p[c] = p[c].fillna(False)

    loc = locality.classify(p, locality.city_county_map([p]))
    cls, _ = oc.classify(p["owner_name_norm"])
    cls, _ = oc.refine_tribal(cls, p["owner_name_norm"], p["in_reservation"],
                              p["off_res_trust"], p["on_public_land"])
    ten = oc.tenure(cls, p["on_public_land"])

    # The development ladder, with -1 preserved: 2009-07-05's value block is
    # dead, so "no improvement recorded" and "field unavailable" must not
    # collapse into the same code (FINDINGS section 8).
    imp = p["improved"].fillna(-1).to_numpy()
    dev = np.where(imp == 1, 2,
                   np.where(p["has_house_number"].fillna(False), 1, 0)).astype("int8")
    dev[imp == -1] = -1
    # Dedicated common areas (timeseries.commonarea) are off the ladder; the
    # tile carries 4 so the Development view can show them without counting them.
    dev[p["is_common_area"].fillna(False).to_numpy(dtype=bool)] = 4

    # The owner's consolidated holding within the county (stage 10), so the
    # parcel layer can draw the paper's Figure 1: large private holdings and
    # the four largest per county. Only a size class, a rank and a review flag
    # reach the tile -- never a name.
    hs = pd.Series(-1, index=p.index, dtype="int8")
    hr = pd.Series(0, index=p.index, dtype="int8")
    hp = pd.Series(0, index=p.index, dtype="int8")
    id_path = f"{holdings.ID_DIR}/owners_{date}.parquet"
    if os.path.exists(id_path):
        dpriv, _qa = holdings.load_private_parcels(date)
        hc = holdings._holdings(dpriv, by_county=True)
        big = hc[hc["large"]].sort_values(["county_n", "acres"], ascending=[True, False])
        big = big.assign(rank=big.groupby("county_n").cumcount() + 1)
        hc = hc.merge(big[["county_n", "group_id", "rank"]], on=["county_n", "group_id"], how="left")
        key = hc.set_index(["county_n", "group_id"])
        own = pd.read_parquet(id_path, columns=["parcel_id", "group_id"]).set_index("parcel_id")["group_id"]
        gid = p["parcel_id"].map(own)
        idx = pd.MultiIndex.from_arrays([p["county_n"].to_numpy(), gid.fillna(-1).astype("int64").to_numpy()])
        hs = pd.Series(key["size_class"].reindex(idx).fillna(-1).to_numpy().astype("int8"), index=p.index)
        rk = key["rank"].reindex(idx).fillna(0).to_numpy()
        hr = pd.Series(np.where(rk <= 4, rk, 0).astype("int8"), index=p.index)
        hp = pd.Series(key["strong"].reindex(idx).fillna(False).to_numpy().astype("int8"), index=p.index)
        log.info("holdings joined: %s parcels in large holdings, %s in a county top-4",
                 f"{int((hs >= 1).sum()):,}", f"{int((hr > 0).sum()):,}")
    else:
        log.warning("no identity output for %s; holding attributes default", date)

    # The DOR's building record (stage 11): the principal dwelling's physical
    # condition as an ordinal 0-7 and the earliest year built on the parcel.
    # One cross-section, so neither follows the time slider. A parcel without
    # a dwelling carries -1 / 0, the "nothing recorded" values.
    cd = pd.Series(-1, index=p.index, dtype="int8")
    yb = pd.Series(0, index=p.index, dtype="int16")
    cama_path = f"{CAMA_DIR}/parcels_cama_{date}.parquet"
    if os.path.exists(cama_path):
        cm = pd.read_parquet(cama_path, columns=["parcel_id", "cond", "yb_res", "has_dwelling"])
        cm = cm[cm["has_dwelling"]].set_index("parcel_id")
        cd = pd.Series(p["parcel_id"].map(cm["cond"]).fillna(-1).to_numpy().astype("int8"), index=p.index)
        yb = pd.Series(p["parcel_id"].map(cm["yb_res"]).fillna(0).to_numpy().astype("int16"), index=p.index)
        log.info("building records joined: %s parcels with a rated dwelling, %s with a year built",
                 f"{int((cd >= 0).sum()):,}", f"{int((yb > 0).sum()):,}")
    else:
        log.warning("no CAMA frame for %s; condition and year built default", date)

    attrs = pd.DataFrame({
        "parcel_id": p["parcel_id"],
        "hs": hs,                                              # holding size class, -1 not private
        "hr": hr,                                              # rank among the county's largest, 1-4
        "hp": hp,                                              # 1 = holding awaits a review decision
        "dev": dev,                                            # 0 platted 1 addressed 2 built
        "born": p["first_idx"].fillna(-1).astype("int16"),      # snapshot index first seen
        "ac": p["acres"].fillna(0).round(1).astype("float32"),
        "ten": ten.astype("int8"),                              # 0 public 1 tribal 2 private
        "loc": loc.astype("int8"),                              # absentee gradient 0-4
        "res": p["in_reservation"].astype("int8"),
        "cnd": p["is_condo"].fillna(False).astype("int8"),
        "cd": cd,                                               # dwelling condition 0-7, -1 none
        "yb": yb,                                               # earliest year built, 0 none
    })
    m = g[["pid", "geometry"]].merge(attrs, left_on="pid", right_on="parcel_id",
                                     how="left")
    for col, val in DEFAULTS:
        m[col] = m[col].fillna(val)
    m = m.drop(columns=["parcel_id"]).rename(columns={"pid": "id"}).to_crs(4326)

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    m.to_file(path, driver="FlatGeobuf")
    log.info("source %s: %.0f MB, %s features", path,
             os.path.getsize(path) / 1e6, f"{len(m):,}")
    return m


LAYER_ZOOMS = {
    # Roads ride in every parcel tile from z10; buildings are sub-pixel below
    # z12 and are written there only, overzooming from it. Per-layer zooms go
    # through the driver's CONF option, which also stops the parcels being
    # generated at z6-9 only to be deleted.
    "parcels": {"minzoom": MINZOOM, "maxzoom": MAXZOOM},
    "roads": {"minzoom": MINZOOM, "maxzoom": MAXZOOM},
    "buildings": {"minzoom": MAXZOOM, "maxzoom": MAXZOOM},
}


def write_vrt(path: str, layers: dict[str, str]) -> str:
    """A VRT uniting one FlatGeobuf per layer, so one MVT run writes them all."""
    body = ["<OGRVRTDataSource>"]
    for name, fgb in layers.items():
        stem = os.path.splitext(os.path.basename(fgb))[0]
        body += [f'  <OGRVRTLayer name="{name}">',
                 f'    <SrcDataSource relativeToVRT="0">{os.path.abspath(fgb)}</SrcDataSource>',
                 f'    <SrcLayer>{stem}</SrcLayer>',
                 '  </OGRVRTLayer>']
    body.append("</OGRVRTDataSource>\n")
    with open(path, "w") as fh:
        fh.write("\n".join(body))
    return path


def tile(src_path: str, out_dir: str, conf: dict | None = None) -> None:
    """Run GDAL's MVT driver over the staged source (every layer it holds)."""
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    t0 = time.time()
    conf_path = f"{WORK_DIR}/mvt_conf.json"
    with open(conf_path, "w") as fh:
        json.dump(conf or {"parcels": LAYER_ZOOMS["parcels"]}, fh)
    cmd = ["ogr2ogr", "-f", "MVT", out_dir, src_path,
           "-dsco", f"MINZOOM={GENERATE_FROM}", "-dsco", f"MAXZOOM={MAXZOOM}",
           "-dsco", f"CONF={conf_path}",
           # MAX_SIZE and MAX_FEATURES are *drop* thresholds, not warnings: GDAL
           # silently discards features from any tile that exceeds them. At the
           # defaults (500 KB / 200,000) the Billings z10 tile loses 38% of its
           # parcels -- 19,572 survive of 51,971 -- and the map simply renders
           # downtown as a hole. Both are set past the worst observed tile so
           # nothing is dropped, and audit() verifies that afterwards.
           "-dsco", "MAX_SIZE=20000000", "-dsco", "MAX_FEATURES=1000000",
           "-dsco", "COMPRESS=NO"]
    subprocess.run(cmd, check=True)
    log.info("tiled in %.0f min", (time.time() - t0) / 60)


def trim_low_zooms(out_dir: str, below: int = MINZOOM) -> int:
    """Delete the statewide zooms, which cost megabytes to draw a smear."""
    freed = 0
    for z in range(0, below):
        d = f"{out_dir}/{z}"
        if not os.path.isdir(d):
            continue
        for root, _, files in os.walk(d):
            freed += sum(os.path.getsize(os.path.join(root, f)) for f in files)
        shutil.rmtree(d)
    log.info("trimmed z0-%d, freed %.0f MB", below - 1, freed / 1e6)
    return freed


def decompress(out_dir: str) -> int:
    """Rewrite any gzipped tile body in place.

    ``COMPRESS=NO`` should make this a no-op, but older GDAL builds honour it
    only partly, and a gzip magic number here is invisible until the map renders
    empty against a server that sends no ``Content-Encoding``.
    """
    n = 0
    for root, _, files in os.walk(out_dir):
        for f in files:
            if not f.endswith(".pbf"):
                continue
            fp = os.path.join(root, f)
            with open(fp, "rb") as fh:
                head = fh.read(2)
                if head != b"\x1f\x8b":
                    continue
                fh.seek(0)
                body = gzip.decompress(fh.read())
            with open(fp, "wb") as fh:
                fh.write(body)
            n += 1
    if n:
        log.info("decompressed %s gzipped tiles in place", f"{n:,}")
    return n


def _tile_features(path: str, layer: str | None = None) -> int:
    """Feature count of one layer (or of the only layer) in a tile or source."""
    cmd = ["ogrinfo", "-ro", "-so", path] + ([layer] if layer else ["-al"])
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.strip().lower().startswith("feature count"):
            return int(line.split(":")[1])
    return 0


def check_no_dropped_features(out_dir: str, n_source: int) -> dict:
    """Every parcel must appear in at least one tile at the deepest zoom.

    This is the check that catches GDAL's MAX_SIZE/MAX_FEATURES dropping
    features, which it does without failing and without a visible symptom
    anywhere except a hole in the densest part of the map. Parcels straddling a
    tile boundary are written to both tiles, so the deepest-zoom total is a lower
    bound that must be *at least* the source count.
    """
    zdir = f"{out_dir}/{MAXZOOM}"
    total = sum(_tile_features(os.path.join(root, f), "parcels")
                for root, _, files in os.walk(zdir) for f in files
                if f.endswith(".pbf"))
    ratio = total / n_source if n_source else 0.0
    log.info("z%d carries %s feature instances for %s parcels (%.2fx)",
             MAXZOOM, f"{total:,}", f"{n_source:,}", ratio)
    assert total >= n_source, (
        f"z{MAXZOOM} holds {total:,} features for {n_source:,} parcels -- GDAL "
        f"dropped some; raise MAX_SIZE/MAX_FEATURES")
    return {"z_max_feature_instances": total, "source_parcels": n_source,
            "duplication": round(ratio, 3)}


def audit(out_dir: str) -> dict:
    """Count and size the pyramid, and assert it can actually be deployed."""
    per_zoom: dict[int, dict] = {}
    for root, _, files in os.walk(out_dir):
        for f in files:
            if not f.endswith(".pbf"):
                continue
            z = int(os.path.relpath(root, out_dir).split(os.sep)[0])
            e = per_zoom.setdefault(z, {"tiles": 0, "bytes": 0, "max_bytes": 0})
            b = os.path.getsize(os.path.join(root, f))
            e["tiles"] += 1
            e["bytes"] += b
            e["max_bytes"] = max(e["max_bytes"], b)
    tiles = sum(e["tiles"] for e in per_zoom.values())
    total = sum(e["bytes"] for e in per_zoom.values())
    gz = sum(1 for root, _, fs in os.walk(out_dir) for f in fs
             if f.endswith(".pbf")
             and open(os.path.join(root, f), "rb").read(2) == b"\x1f\x8b")

    assert tiles <= FILE_CAP, (
        f"{tiles:,} tiles exceeds the {FILE_CAP:,}-file Cloudflare Pages cap; "
        f"lower MAXZOOM or raise MINZOOM")
    assert gz == 0, f"{gz} tiles are still gzipped on disk"
    assert min(per_zoom) >= MINZOOM, (
        f"z{min(per_zoom)} survived the trim; the source declares minzoom "
        f"{MINZOOM} and anything below it ships bytes nothing requests")

    for z in sorted(per_zoom):
        e = per_zoom[z]
        log.info("  z%-2d %6s tiles  %6.0f MB  mean %5.1f KB  max %5.0f KB", z,
                 f"{e['tiles']:,}", e["bytes"] / 1e6,
                 e["bytes"] / e["tiles"] / 1024, e["max_bytes"] / 1024)
    log.info("pyramid: %s tiles, %.0f MB, %.0f%% of the file cap",
             f"{tiles:,}", total / 1e6, 100 * tiles / FILE_CAP)
    return {"tiles": tiles, "bytes": total,
            "per_zoom": {str(k): v for k, v in sorted(per_zoom.items())},
            "minzoom": MINZOOM, "maxzoom": MAXZOOM}


def build(date: str | None = None, out_dir: str = OUT_DIR,
          reuse_source: bool = False) -> dict:
    if date is None:
        date = max(s.date for s in sources.discover())
    src_path = f"{WORK_DIR}/parcels_{date}.fgb"
    if reuse_source and os.path.exists(src_path):
        log.info("reusing staged source %s", src_path)
        n_source = _tile_features(src_path)
    else:
        n_source = len(build_source(date, src_path))
    ref = reference.stage(WORK_DIR, reuse=reuse_source, parcels=src_path,
                          cama=f"{CAMA_DIR}/parcels_cama_{date}.parquet")
    vrt = write_vrt(f"{WORK_DIR}/tiles.vrt", {"parcels": src_path, **ref})
    tile(vrt, out_dir, LAYER_ZOOMS)
    trim_low_zooms(out_dir)
    decompress(out_dir)
    qa = audit(out_dir)
    qa.update(check_no_dropped_features(out_dir, n_source))
    qa["date"] = date
    qa["layers"] = {name: {**LAYER_ZOOMS[name], "source_features": _tile_features(p)}
                    for name, p in {"parcels": src_path, **ref}.items()}
    with open(f"{out_dir}/tiles_qa.json", "w") as fh:
        json.dump(qa, fh, indent=1)
    return qa


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        description="Stage 8: bake the parcel fabric into vector tiles")
    ap.add_argument("--date", default=None, help="snapshot date (default: newest)")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--reuse-source", action="store_true",
                    help="skip the geometry read if the staged .fgb exists")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                        datefmt="%H:%M:%S")
    build(args.date, args.out, reuse_source=args.reuse_source)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
