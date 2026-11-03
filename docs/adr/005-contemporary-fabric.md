# ADR 005: The newest parcel fabric carries historical attributes; no historical geometry

**Status:** accepted, with the limitation stated on the map and in the About tab

## Context
Drawing parcels at every vintage would need 29 geometry pyramids. The time dimension at parcel depth is wanted for one thing: seeing where division happened and when.

## Decision
The tiles carry today's parcels with `born` (the snapshot their current occurrence first appeared). At an earlier vintage the parcels that did not yet exist are outlined by the period they first appeared; nothing is hidden, because a parent that was fully subdivided is not in the fabric and hiding its children would leave a hole.

## Alternatives weighed
Historical geometry for selected vintages (a representative few would improve interpretability; deferred as a roadmap item); hiding later parcels (misleading holes).

## Consequences
The map is a contemporary spatial representation of historical change, and says so: the parcel key states it, the caveats state it, and the paper states it above the About tab. Township and county grain carry the true historical series.
