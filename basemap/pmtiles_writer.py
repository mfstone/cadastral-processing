"""Write a PMTiles v3 archive from an MBTiles file, with no dependency beyond
the standard library.

PMTiles is a single-file, cloud-optimised container for a tile pyramid: a
127-byte header, a root directory, optional leaf directories, a JSON metadata
blob and the tile bodies, all addressed by byte range so a client needs only
HTTP Range requests. The format is the one the ``pmtiles`` JavaScript library
and QGIS read; the writer here follows the published v3 specification:

- tile ids are Hilbert-curve positions, offset by the number of tiles in all
  shallower zooms, so a directory sorted by id is also spatially clustered;
- a directory is a varint-packed list of (tile id delta, run length, length,
  offset) columns, gzip-compressed; the root must fit in 16,384 bytes, so a
  large pyramid gets leaf directories the root points at (run length 0);
- identical tile bodies are stored once and addressed twice;
- the tile bodies keep MBTiles' gzip encoding, which the header declares.

Only what this project needs is implemented: MVT tiles in, one archive out.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sqlite3
import struct
from dataclasses import dataclass

HEADER_LEN = 127
ROOT_MAX = 16_384
COMPRESSION = {"none": 1, "gzip": 2}
TILE_TYPE_MVT = 1


@dataclass
class Entry:
    tile_id: int
    offset: int
    length: int
    run_length: int = 1


def zxy_to_id(z: int, x: int, y: int) -> int:
    """Hilbert tile id as the PMTiles reference implementations compute it."""
    acc = sum(4 ** t for t in range(z))
    n = 1 << z
    tx, ty, d = x, y, 0
    s = n >> 1
    while s > 0:
        rx = 1 if tx & s else 0
        ry = 1 if ty & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                tx = n - 1 - tx
                ty = n - 1 - ty
            tx, ty = ty, tx
        s >>= 1
    return acc + d


def _varint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def serialize_directory(entries: list[Entry]) -> bytes:
    """Columnar varint encoding: count, id deltas, run lengths, lengths, offsets."""
    out = bytearray(_varint(len(entries)))
    last = 0
    for e in entries:
        out += _varint(e.tile_id - last)
        last = e.tile_id
    for e in entries:
        out += _varint(e.run_length)
    for e in entries:
        out += _varint(e.length)
    for i, e in enumerate(entries):
        if i > 0 and e.offset == entries[i - 1].offset + entries[i - 1].length:
            out += _varint(0)
        else:
            out += _varint(e.offset + 1)
    return bytes(out)


def _gz(b: bytes) -> bytes:
    return gzip.compress(b, compresslevel=9, mtime=0)


def build_directories(entries: list[Entry]) -> tuple[bytes, bytes, int]:
    """Root bytes, leaf bytes and the leaf count; leaves only when the root
    would not fit in 16 KB."""
    root = _gz(serialize_directory(entries))
    if len(root) <= ROOT_MAX:
        return root, b"", 0
    leaf_size = 4096
    while True:
        leaves = bytearray()
        root_entries = []
        for i in range(0, len(entries), leaf_size):
            chunk = entries[i:i + leaf_size]
            ser = _gz(serialize_directory(chunk))
            root_entries.append(Entry(chunk[0].tile_id, len(leaves), len(ser), 0))
            leaves += ser
        root = _gz(serialize_directory(root_entries))
        if len(root) <= ROOT_MAX:
            return root, bytes(leaves), len(root_entries)
        leaf_size *= 2


def _header(fields: dict) -> bytes:
    return struct.pack(
        "<7sBQQQQQQQQQQQBBBBBBiiiiBii",
        b"PMTiles", 3,
        fields["root_offset"], fields["root_length"],
        fields["meta_offset"], fields["meta_length"],
        fields["leaf_offset"], fields["leaf_length"],
        fields["data_offset"], fields["data_length"],
        fields["addressed"], fields["entries"], fields["contents"],
        1 if fields["clustered"] else 0,
        COMPRESSION["gzip"], fields["tile_compression"], TILE_TYPE_MVT,
        fields["min_zoom"], fields["max_zoom"],
        int(round(fields["bounds"][0] * 1e7)), int(round(fields["bounds"][1] * 1e7)),
        int(round(fields["bounds"][2] * 1e7)), int(round(fields["bounds"][3] * 1e7)),
        fields["center_zoom"], int(round(fields["center"][0] * 1e7)), int(round(fields["center"][1] * 1e7)))


def mbtiles_to_pmtiles(mbtiles: str, out: str, metadata_extra: dict | None = None) -> dict:
    """Convert; returns a QA dict with counts and section sizes."""
    db = sqlite3.connect(mbtiles)
    meta = dict(db.execute("SELECT name, value FROM metadata").fetchall())
    rows = db.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles").fetchall()
    # GDAL's MBTiles tiles are gzip bodies; detect from the first one.
    tile_gzip = bool(rows) and rows[0][3][:2] == b"\x1f\x8b"

    keyed = []
    for z, x, row, data in rows:
        y = (1 << z) - 1 - row            # TMS -> XYZ
        keyed.append((zxy_to_id(z, x, y), bytes(data)))
    keyed.sort(key=lambda t: t[0])
    db.close()

    data = bytearray()
    seen: dict[bytes, tuple[int, int]] = {}
    entries: list[Entry] = []
    for tid, body in keyed:
        h = hashlib.blake2b(body, digest_size=16).digest()
        if h in seen:
            off, ln = seen[h]
        else:
            off, ln = len(data), len(body)
            data += body
            seen[h] = (off, ln)
        entries.append(Entry(tid, off, ln, 1))

    root, leaves, n_leaves = build_directories(entries)
    zooms = sorted({z for z, *_ in rows})
    bounds = [float(v) for v in meta.get("bounds", "-116.05,44.36,-104.04,49.0").split(",")]
    center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
    md = {"name": meta.get("name", "basemap"), "format": "pbf",
          "description": meta.get("description", ""), "attribution": meta.get("attribution", "")}
    try:
        md.update(json.loads(meta.get("json", "{}")))     # vector_layers, tilestats
    except json.JSONDecodeError:
        pass
    if metadata_extra:
        md.update(metadata_extra)
    md_bytes = _gz(json.dumps(md, separators=(",", ":")).encode())

    root_offset = HEADER_LEN
    meta_offset = root_offset + len(root)
    leaf_offset = meta_offset + len(md_bytes)
    data_offset = leaf_offset + len(leaves)
    hdr = _header({
        "root_offset": root_offset, "root_length": len(root),
        "meta_offset": meta_offset, "meta_length": len(md_bytes),
        "leaf_offset": leaf_offset, "leaf_length": len(leaves),
        "data_offset": data_offset, "data_length": len(data),
        "addressed": len(entries), "entries": len(entries), "contents": len(seen),
        "clustered": True, "tile_compression": COMPRESSION["gzip" if tile_gzip else "none"],
        "min_zoom": zooms[0] if zooms else 0, "max_zoom": zooms[-1] if zooms else 0,
        "bounds": bounds, "center_zoom": min(zooms[-1], 7) if zooms else 0, "center": center})
    assert len(hdr) == HEADER_LEN
    with open(out, "wb") as fh:
        fh.write(hdr); fh.write(root); fh.write(md_bytes); fh.write(leaves); fh.write(data)
    return {"tiles": len(entries), "unique_tiles": len(seen), "zooms": zooms,
            "root_bytes": len(root), "leaf_dirs": n_leaves, "leaf_bytes": len(leaves),
            "tile_bytes": len(data), "tile_compression": "gzip" if tile_gzip else "none",
            "vector_layers": [v.get("id") for v in md.get("vector_layers", [])]}


if __name__ == "__main__":
    import sys
    print(json.dumps(mbtiles_to_pmtiles(sys.argv[1], sys.argv[2]), indent=1))
