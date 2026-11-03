# ADR 006: In-house basemap as one PMTiles archive, served from object storage

**Status:** accepted (2026-11)

## Context
The page should make no third-party request by default; the State Library's frameworks (roads, water, places, buildings, address points) are first-party data.

## Decision
Twelve State Library layers are written to one PMTiles archive (130 MB) by an in-house writer, with two styles and vendored glyphs. The archive needs HTTP Range, which Workers static assets and Pages ignore, so it is excluded from the asset upload (`.assetsignore`) and served from R2 in production; the basemap menu falls back to outlines only when the archive is absent.

## Alternatives weighed
Esri or OpenFreeMap basemaps (third-party requests, kept as an opt-in); raster tiles (no labels at parcel scale); exploding the archive into files (too many for the cap at z13).

## Consequences
A second origin for one file, with CORS. The writer is custom: `basemap/check_pmtiles.mjs` reads the archive back with the official `pmtiles` client, and the check must stay broad enough to catch a writer regression.
