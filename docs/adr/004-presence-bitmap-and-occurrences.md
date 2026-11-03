# ADR 004: Lineage from a presence bitmap; a geocode's life is a sequence of occurrences

**Status:** accepted; revised 2026-11 (64-bit width, occurrences, `reused_id`)

## Context
Parcel lineage across 29 vintages (creation, retirement, persistence, resurrection) must be cheap to compute over 1.3 million identifiers. The Department of Revenue retires geocodes and reissues them, so an identifier is not a parcel.

## Decision
One `uint64` per identifier, bit *i* set when it appears in snapshot *i* (64 vintages of room; 29 used; the stage refuses to run past the width and warns at 56). Each contiguous run of set bits is an **occurrence** with its own first and last snapshot. A creation is the first snapshot of an occurrence; the interval that sees it classifies it like any other and marks `reused_id` when the identifier has a past. Everything that dates a parcel (absorption cohorts, dormant ages, the tiles' `born`, the building-record witness) reads the occurrence that contains the snapshot in question.

## Alternatives weighed
Geometry diffing between vintages (expensive, and it cannot see a reissued number either); event tables from the DOR (not available); a variable-length bitset (more durable than 64 bits; deferred until the horizon is in sight). Parent-child lineage inferred from geometry and acreage conservation is the natural next step and would live on the `change_event` entity.

## Consequences
Lineage questions are bit tests. The reissued-identifier count is published in `meta.lineage` and stated as a caveat. The model still does not reconstruct historical geometry (ADR 005).
