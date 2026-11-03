# ADR 002: Precomputed tables published as static files; analysis in the browser

**Status:** accepted (2026-10)

## Context
The dashboard's questions are a stable set: ladder shares, tenure, locality, size classes, churn, thresholds, holdings. None needs a query a browser cannot run over a few megabytes.

## Decision
The pipeline publishes a 22.5 MB bundle of Parquet tables (township and county grain, delta-coded stock tables) that the page reads whole with hyparquet and reshapes into typed arrays; every rate and share is computed in the browser from counts and the interval's real day count. The site is static output served with a strict CSP.

## Alternatives weighed
A REST API over PostGIS (server, latency, cost, a second codebase); ArcGIS Online hosted layers and Dashboards (credits, named users, no custom cartography); GeoParquet for geometry in the browser (measured at 310 MB gzip statewide: rejected).

## Consequences
Near-zero hosting cost, a global cache, no secrets in the site. Analytics are bounded by what fits in a browser; the published tables carry marginals, not the joint cube, so one category dimension at a time. The assistant (ADR 008) is the first component with a server, and it is a proxy, not a query service.
