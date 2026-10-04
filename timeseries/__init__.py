"""Longitudinal (multi-vintage) cadastral analysis.

Separate from the ``cadastral`` package, which is parcel-grain, geometry-heavy,
county-at-a-time and entity-resolving. This pipeline is attribute-only,
statewide, snapshot-at-a-time and explicitly *not* entity-resolving.

Derived data model -- everything published is an aggregation over exactly four
entities and nothing else:

    parcel_snapshot          one row per (snapshot, parcel)
    owner_interest_snapshot  one row per (snapshot, parcel, normalized interest)
    change_event             one row per inferred cadastral event
    spatial_unit             the snapshot-independent locator

See ``~/.claude/plans/i-have-a-cadastral-enchanted-pearl.md``.
"""

__all__ = ["sources"]
