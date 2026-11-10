#!/usr/bin/env python3
"""Package the collector, lazy Binaryen factory and GC-aware standard library.

This also upgrades an existing payload without rebuilding the compiler. All
inputs are local except the checksum-pinned Binaryen archive downloaded once.
"""
import argparse
import gzip
import importlib.util
import json
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[3]
BUILD = ROOT / "build/crystal-wasm"
sys.path.insert(0, str(BUILD))
from gc_patches import patch_stdlib, DEPENDENCIES

spec = importlib.util.spec_from_file_location("fetch_gc", BUILD / "fetch-gc-dependency.py")
fetch_gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_gc)


def compressed(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(contents, compresslevel=9, mtime=0))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--libgc", type=Path, required=True)
    parser.add_argument("--cache", default="/tmp/browser-crystal-gc/downloads")
    parser.add_argument("--dest", type=Path, default=ROOT / "packages/crystal-wasm/assets/crystal")
    args = parser.parse_args()
    # Verify and read all dependencies before modifying the payload.
    archive = fetch_gc.fetch("binaryen", args.cache)
    with tarfile.open(archive) as tar:
        source = tar.extractfile("package/index.js").read().decode()
        license_text = tar.extractfile("package/LICENSE").read()
    collector_archive = fetch_gc.fetch("bdwgc", args.cache)
    with tarfile.open(collector_archive) as tar:
        collector_license = tar.extractfile(f"bdwgc-{DEPENDENCIES['bdwgc']['commit']}/LICENSE").read()
    # The pinned distribution ends in one ESM export. Move its top-level await
    # inside an async factory so even a classic LiveCodes worker can load it.
    # runtimeUrl keeps createRequire valid when loaded from a verified data URL.
    import re
    source, count = re.subn(r"export\{([\w$]+) as default\};\s*$", r"return \1;", source)
    if count != 1:
        raise ValueError("Binaryen ESM wrapper changed")
    source = source.replace("import.meta.url", "runtimeUrl")
    factory = "export default async function(runtimeUrl) {\n" + source + "\n}\n"
    library = args.libgc.read_bytes()
    stdlib_path = args.dest / "stdlib.json.gz"
    stdlib = patch_stdlib(json.loads(gzip.decompress(stdlib_path.read_bytes())))
    compressed(args.dest / "gc/binaryen.mjs.gz", factory.encode())
    compressed(args.dest / "gc/libgc.a.gz", library)
    compressed(stdlib_path, json.dumps(stdlib, separators=(",", ":")).encode())
    notices = ROOT / "packages/crystal-wasm/vendor/gc"
    notices.mkdir(parents=True, exist_ok=True)
    (notices / "BINARYEN-LICENSE").write_bytes(license_text)
    (notices / "BDWGC-LICENSE").write_bytes(collector_license)
    print(f"GC assets: {args.dest / 'gc'} (Binaryen {DEPENDENCIES['binaryen']['version']})")


if __name__ == "__main__":
    main()
