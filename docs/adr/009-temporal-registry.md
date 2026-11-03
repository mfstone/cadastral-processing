# ADR 009: Every input's observation and effective time declared in a registry and shipped

**Status:** accepted (2026-11)

## Context
The series combines sources observed at different times: 29 parcel exports on their own dates; a 2026 public-lands layer applied to every year; building records from three refreshes carrying eight tax years; address points with no history. A contemporary classification applied to historical records answers a different question from a historical observation, and a caveat on one card is not a model.

## Decision
`timeseries/temporal.py` declares, per input: observation time, effective period, what it applies to, and the inference it supports. The publish stage ships the registry in `meta.temporal`; the About tab, the reports and the assistant's instructions read it. The public-lands entry states that tenure by area is a contemporary classification of historical parcels.

## Alternatives weighed
A bitemporal database (unnecessary for a file pipeline); caveats only (what existed; not enforceable or discoverable).

## Consequences
Each stage can be read against the registry for accidental combinations. A time-aware public-lands series (historical acquisitions) would become a new entry, not a new pipeline.
