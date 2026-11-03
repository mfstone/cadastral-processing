# ADR 003: Parcels as a `{z}/{x}/{y}` MVT tree, z10 to 12, attributes baked in

**Status:** accepted (2026-10); the z10-11 simplification and the content-type fix are measured follow-ups

## Context
887,124 parcels, 35.3 million vertices. The static host caps assets at 20,000 files and 25 MiB each and does not honour HTTP Range.

## Decision
GDAL writes a plain directory of MVT files for zooms 10 to 12 (11,683 files); zooms 6 to 9 are discarded because the township choropleth is the honest unit there. The analytic attributes (ladder stage, tenure, locality, acres, first-seen snapshot, holding class, condition, year built) are baked into the tiles so styling is a paint expression with no client join.

## Alternatives weighed
PMTiles (one file; needs Range, which the host ignores); GeoJSON or GeoParquet in the browser (too large); tiles with a client-side attribute join (slower repaint, a second payload).

## Consequences
Attribute changes rebuild the tiles (5 to 10 minutes). The `Content-Type` must be one Cloudflare compresses (`application/x-protobuf`), or the tiles ship uncompressed; fixed 2026-11. Low-zoom simplification halves z10 and z11 with feature counts unchanged (measured 2026-11-02); to be applied through GDAL's `SIMPLIFICATION` option in `tiles.py` once the deployed compression check passes, since the wire-size fix is the larger lever.
