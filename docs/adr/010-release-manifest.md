# ADR 010: Every publish carries a manifest with hashes of inputs, code and outputs

**Status:** accepted (2026-11)

## Context
A revised rule can change a 2005 figure without any 2005 source changing. Without a record of what a bundle was made from, two releases cannot be told apart or compared.

## Decision
`timeseries/manifest.py` writes `manifest.json` beside `meta.json`: a release id (hash of the outputs), the pipeline commit and a hash over the source files, the environment (Python, GDAL, library versions), the archive inventory, the review overrides' hash, the QA files' hashes, and every output's size and hash with the tile tree as one aggregate. The About tab shows the release id.

## Alternatives weighed
Relying on git history (does not cover a dirty tree, the archives or the overrides); a data catalog service (a server for a file pipeline).

## Consequences
A release is identifiable and comparable. Publication is atomic by construction on Workers: a deploy uploads every asset and switches the version at once, so data, tiles and code cannot be served from mixed releases; the R2-hosted basemap is the one object outside that guarantee and is versioned by name.
