#!/usr/bin/env python3
"""Fetch a checksum-pinned GC dependency into a build cache and print its path."""
import hashlib
import json
import pathlib
import sys
import urllib.request


def fetch(name, cache):
    dependencies = json.loads(pathlib.Path(__file__).with_name("gc-dependencies.json").read_text())
    dependency = dependencies[name]
    cache = pathlib.Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"{name}-{dependency.get('commit', dependency['version'])}.tar.gz"
    if not target.exists():
        temporary = target.with_suffix(".download")
        try:
            urllib.request.urlretrieve(dependency["url"], temporary)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != dependency["sha256"]:
                raise ValueError(f"{name}: download checksum mismatch")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    if hashlib.sha256(target.read_bytes()).hexdigest() != dependency["sha256"]:
        raise ValueError(f"{name}: cached archive checksum mismatch: {target}")
    return target


if __name__ == "__main__":
    print(fetch(sys.argv[1], sys.argv[2]))
