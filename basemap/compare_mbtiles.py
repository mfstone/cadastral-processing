#!/usr/bin/env python3
"""Compare the PMTiles archive with the MBTiles it was written from.

    node basemap/check_pmtiles.mjs basemap/dist/mt-basemap.pmtiles --hashes > /tmp/hashes.txt
    python basemap/compare_mbtiles.py basemap/work/<source>.mbtiles /tmp/hashes.txt

Every `z/x/y sha1` line the reader printed is looked up in the MBTiles
(TMS rows, so y is flipped) and the inflated bodies must hash the same: the
in-house writer and the official reader agree on the bytes, tile by tile.
"""
import gzip, hashlib, sqlite3, sys

mb, hashes = sys.argv[1], sys.argv[2]
db = sqlite3.connect(mb)
same = diff = missing = 0
for line in open(hashes):
    parts = line.split()
    if len(parts) != 2 or "/" not in parts[0]:
        continue
    z, x, y = (int(v) for v in parts[0].split("/"))
    tms_y = (1 << z) - 1 - y
    row = db.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                     (z, x, tms_y)).fetchone()
    if not row:
        missing += 1
        continue
    body = row[0]
    if body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    if hashlib.sha1(body).hexdigest() == parts[1]:
        same += 1
    else:
        diff += 1
        print(f"differs: {parts[0]}")
print(f"{same} same, {diff} differ, {missing} missing from the MBTiles")
sys.exit(1 if diff or missing else 0)
