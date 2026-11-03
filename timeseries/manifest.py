"""Stage 7b: the release manifest.

A publish is an identifiable analytical product, not a directory of files
that happen to be newer. The manifest beside ``meta.json`` says what the
bundle was made from -- the source archives, the pipeline commit, the code
and the review overrides -- and what it contains, file by file with a hash,
so that two releases can be compared and a changed figure traced to new
data, a changed rule or a corrected line of code. The release id is the hash
of the outputs; it appears in the About tab and in the Worker's health
answer.

Run by ``timeseries.publish`` at the end, or alone::

    python -m timeseries.manifest [--out site/public/data] [--hash-sources]

``--hash-sources`` reads every archive (41 GB) to hash it; without it the
archives are inventoried by name, size and modification time, which is what
a nightly check needs.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import os
import platform
import subprocess
import sys

log = logging.getLogger("timeseries.manifest")

OUT_DIR = "site/public/data"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE_DIRS = ("timeseries", "cadastral", "basemap")
OVERRIDES = "owner_overrides.csv"
QA_FILES = ("data/events/qa_intervals.json", "data/events/qa_presence.json", "data/coverage/qa_coverage.json",
            "data/ladder/qa_ladder.json", "data/facts/qa_facts.json", "data/facts/qa_holdings.json",
            "data/cama/qa_cama.json", "data/structures/qa_structures.json", "site/public/data/parcels/tiles_qa.json")


def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _git(*args: str) -> str | None:
    try:
        return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=20).stdout.strip() or None
    except Exception:  # noqa: BLE001 - git may be absent
        return None


def code_hash() -> str:
    """One hash over every pipeline source file, so a rule change shows even in a dirty tree."""
    h = hashlib.sha256()
    for d in CODE_DIRS:
        root = os.path.join(REPO, d)
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for f in sorted(files):
                if f.endswith(".py"):
                    p = os.path.join(dirpath, f)
                    h.update(os.path.relpath(p, REPO).encode())
                    h.update(sha256_file(p).encode())
    return h.hexdigest()[:16]


def environment() -> dict:
    env = {"python": platform.python_version(), "platform": platform.platform()}
    for mod in ("numpy", "pandas", "pyarrow", "geopandas", "shapely", "pyogrio"):
        try:
            env[mod] = __import__(mod).__version__
        except Exception:  # noqa: BLE001
            env[mod] = None
    try:
        import pyogrio
        env["gdal"] = pyogrio.__gdal_version_string__
    except Exception:  # noqa: BLE001
        env["gdal"] = None
    return env


def sources_inventory(root: str | None, hash_sources: bool) -> dict:
    try:
        from . import sources
        root = root or sources.DEFAULT_ROOT
    except Exception:  # noqa: BLE001
        pass
    if not root or not os.path.isdir(root):
        return {"root": root, "available": False, "archives": []}
    rows = []
    for f in sorted(os.listdir(root)):
        p = os.path.join(root, f)
        if not (f.lower().endswith(".zip") and os.path.isfile(p)):
            continue
        st = os.stat(p)
        row = {"name": f, "bytes": st.st_size, "mtime": _dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")}
        if hash_sources:
            row["sha256"] = sha256_file(p)
        rows.append(row)
    return {"root": root, "available": True, "hashed": hash_sources, "archives": rows}


def outputs_inventory(out_dir: str) -> tuple[dict, dict]:
    """Every published file with its hash; the tile tree as one aggregate."""
    files = {}
    tiles = {"files": 0, "bytes": 0}
    th = hashlib.sha256()
    for dirpath, dirs, names in os.walk(out_dir):
        dirs.sort()
        rel_dir = os.path.relpath(dirpath, out_dir)
        for f in sorted(names):
            p = os.path.join(dirpath, f)
            rel = f if rel_dir == "." else f"{rel_dir}/{f}"
            if rel.startswith("parcels/"):
                tiles["files"] += 1
                tiles["bytes"] += os.path.getsize(p)
                th.update(rel.encode())
                th.update(sha256_file(p).encode())
                continue
            if rel == "manifest.json":
                continue
            files[rel] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    tiles["sha256"] = th.hexdigest()
    return files, tiles


def build(out_dir: str = OUT_DIR, source_root: str | None = None, hash_sources: bool = False) -> dict:
    files, tiles = outputs_inventory(out_dir)
    rid = hashlib.sha256()
    for k in sorted(files):
        rid.update(k.encode())
        rid.update(files[k]["sha256"].encode())
    rid.update(tiles["sha256"].encode())
    overrides = os.path.join(REPO, OVERRIDES)
    qa = {}
    for rel in QA_FILES:
        p = os.path.join(REPO, rel)
        if os.path.exists(p):
            qa[rel] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    dirty = _git("status", "--porcelain")
    manifest = {
        "release": rid.hexdigest()[:16],
        "built_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "pipeline": {
            "git_commit": _git("rev-parse", "HEAD"),
            "git_branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(dirty),
            "code_hash": code_hash(),
        },
        "environment": environment(),
        "sources": sources_inventory(source_root, hash_sources),
        "overrides": ({"file": OVERRIDES, "sha256": sha256_file(overrides), "bytes": os.path.getsize(overrides)}
                      if os.path.exists(overrides) else None),
        "qa": qa,
        "outputs": files,
        "tiles": tiles,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    log.info("manifest: release %s, %d files, %d tiles, commit %s%s", manifest["release"], len(files),
             tiles["files"], (manifest["pipeline"]["git_commit"] or "?")[:8], " (dirty)" if dirty else "")
    return manifest


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Stage 7b: the release manifest")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--source-root", default=None)
    ap.add_argument("--hash-sources", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    m = build(args.out, args.source_root, args.hash_sources)
    print(json.dumps({k: m[k] for k in ("release", "pipeline", "tiles")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
