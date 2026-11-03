# Architectural decision records

One file per decision that shaped the system, in the order they were made.
Each says what was decided, what it was weighed against, why, and what it
costs. A decision is revisited by adding a record that supersedes it, never
by editing the old one. The white paper (`~/Source/white-papers/montana-cadastral-wp`)
narrates the same decisions; these are the citable short form.

| # | Decision | Status |
|---|---|---|
| [001](001-file-based-data-layer.md) | Parquet files per stage and vintage, not a database server | accepted |
| [002](002-static-publication.md) | Precomputed tables published as static files; analysis in the browser | accepted |
| [003](003-parcel-tiles-as-mvt-tree.md) | Parcels as a `{z}/{x}/{y}` MVT tree, z10 to 12, attributes baked in | accepted |
| [004](004-presence-bitmap-and-occurrences.md) | Lineage from a presence bitmap; a geocode's life is a sequence of occurrences | accepted (revised 2026-11) |
| [005](005-contemporary-fabric.md) | The newest parcel fabric carries historical attributes; no historical geometry | accepted, with the limitation stated on the map |
| [006](006-basemap-pmtiles-on-r2.md) | In-house basemap as one PMTiles archive, served from object storage | accepted |
| [007](007-vanilla-front-end.md) | Astro, vanilla modules, MapLibre, in-house SVG charts; no framework | accepted |
| [008](008-assistant-in-page-tools.md) | Assistant: tools run in the page, the Worker is a pinned proxy; no MCP | accepted |
| [009](009-temporal-registry.md) | Every input's observation and effective time declared in a registry and shipped | accepted |
| [010](010-release-manifest.md) | Every publish carries a manifest with hashes of inputs, code and outputs | accepted |
