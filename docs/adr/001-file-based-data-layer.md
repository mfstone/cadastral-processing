# ADR 001: Parquet files per stage and vintage, not a database server

**Status:** accepted (2026-10)

## Context
Twenty-nine statewide parcel exports (25.5 million parcel-snapshot rows) are read, normalised, compared and aggregated. The data is immutable once extracted, the workload is analytical, every stage must be reproducible from the archives, and the published results are far smaller than the inputs.

## Decision
Each stage reads and writes Parquet (zstd) per vintage; staged geometry is FlatGeobuf. No PostGIS, no enterprise geodatabase, no server. Reference layers are joined once per vintage and the result materialised.

## Alternatives weighed
PostGIS (set-based joins, spatial indexes, one system of record; a server to run, back up and migrate for a pipeline that is a pure function of files); an enterprise geodatabase under ArcGIS Enterprise (archiving and branch versioning; licensing, and archiving records transaction time, not the exports' effective dates, see ADR 004); DuckDB over the same files (kept as an *optional* query layer, not a store).

## Consequences
Zero infrastructure; reproducibility by re-running; column pruning and vectorised reads. No interactive query service and no transactional editing. If a client needs ad-hoc spatial queries over full-resolution data, PostGIS can be added as a consumer of these files without replacing them.
