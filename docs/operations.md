# Operations: environment, backups, release

## The environment
`requirements.txt` states the floor; `requirements-lock.txt` is the exact
environment the published bundle was built with (`pip freeze`), and the release
manifest records the Python, GDAL and library versions actually used. Rebuild it
with `python -m venv .venv && .venv/bin/pip install -r requirements-lock.txt`.
GDAL comes from the system (`pyogrio` reports the version in the manifest).

## What cannot be regenerated
Three things exist nowhere else and are backed up before anything else:

| What | Where | Why it matters |
|---|---|---|
| The 30 State Library archives (41 GB) | the archive root (`timeseries/sources.py`) | the State Library's FTP does not keep every vintage |
| The ORION data files (up to 9.6 GB) and the parquet caches | `orion_cache*/` | supplied by the DOR; the caches are a day of extraction |
| `owner_overrides.csv` | repo root (ignored by git while it holds names) | expert decisions a pipeline cannot reconstruct |

Everything under `data/` is reproducible from those three and the code.

## A release
1. Run the stages in order (README, "Taking in a new state export").
2. `python -m timeseries.publish` writes the bundle and `manifest.json` (release id, hashes).
3. `cd site && npm run build` regenerates the assistant prompt and the site; `npm run test:unit`.
4. Serve `dist` and run the smoke suite against it; then deploy (`npm run deploy` at the root), and run the smoke suite against the deployed origin, which is the only place the CSP and the tile compression can be checked.
5. Record the release id from the About tab with the deploy.

A Workers deploy is atomic: every asset is uploaded, then the version is
switched, so data, tiles and code never mix across releases. The basemap
archive on R2 is outside that guarantee and is versioned by file name.

## Dependency hygiene
`npm run audit` at the repo root audits the site's and the Worker's production
dependencies; `pip-audit -r requirements-lock.txt` does the same for Python.
Lockfiles are committed; a build is reproducible from them. A strict CSP does
not protect against a compromised build dependency, which is what the audit and
the manifest's code hash are for.
