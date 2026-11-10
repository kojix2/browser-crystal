#!/bin/bash
# build-assets.sh — build the payload this package ships, into assets/crystal/.
#
#   bash packages/crystal-wasm/build-assets.sh     # run in the racket-build WSL distro
#
# Everything is gzipped and the loader inflates it itself (DecompressionStream in
# the page, zlib in Node), so no server configuration is needed and any static host
# works. Gzipped, the whole payload is ~22 MB, from ~68 MB raw. assets/ is
# gitignored; the receipts that pin these bytes are written at the end of this
# script and are committed.
#
#   compiler.wasm.gz   the wasm Crystal compiler (release, --strip-debug, wasm-opt -Oz)
#   lld.wasm.gz        clang-wasm's lld
#   stdlib.json.gz     the patched stdlib as { "path": "contents" }
#   lib/…​.a.gz         the libraries wasm-ld links against (with the eh/ variants)
#
# Sources: $OUT (the WSL build tree), clang-wasm's asset cache, and wasi-sdk-33.
set -uo pipefail

DIR=${DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
CLANG_WASM=${CLANG_WASM:-/mnt/d/DevWork/live-codes/clang-wasm}
OUT=${OUT:-/root/bc-crystal}
WASI_SDK=${WASI_SDK:-/opt/wasi-sdk-33}
PCRE_LIB=${PCRE_LIB:-/root/bc-pcre2/build}
NODE=${NODE:-node}
DEST="$DIR/assets/crystal"

SYSROOT="$WASI_SDK/share/wasi-sysroot/lib/wasm32-wasip1"
CLANG_RT="$WASI_SDK/lib/clang/22/lib/wasm32-unknown-wasip1"

mkdir -p "$DEST/lib/eh"
# Drop artifacts from an earlier, uncompressed run.
rm -f "$DEST/compiler.wasm" "$DEST/lld.wasm" "$DEST/stdlib.json"
find "$DEST/lib" -type f -name '*.a' -delete
gz() { gzip -9 -c "$1" > "$2"; }

echo "=== compiler ==="
# `wasm-opt -Oz` takes the module from 59 MB to 35.5 MB raw and 14.5 MB to 11.8 MB
# gzipped -- 40% of the bytes the browser has to compile, which is latency and
# memory. It rewrites the whole module (including libLLVM's and libc++'s code),
# which is why it is more effective than any Crystal-side flag.
#
# NOT `-all`: one of those passes emits a module V8 rejects ("unknown import
# kind 0x7e"). `-Oz --enable-exception-handling` alone is validated in V8.
#
# It also drops the `name` section, so the page's stack traces lose their
# function names. `link.sh`'s crystal.wasm keeps them; that is the artifact to
# debug the compiler with, this is the one to ship.
WASM_OPT="${WASM_OPT:-/opt/emsdk/upstream/bin/wasm-opt}"
if [ ! -x "$WASM_OPT" ]; then
  echo "wasm-opt not found at $WASM_OPT — set WASM_OPT= to emsdk's wasm-opt" >&2
  exit 1
fi
# `--one-caller-inline-max-function-size=1000` stops Binaryen folding a chain of
# single-caller functions into one giant one. Left unbounded it produced an 882 KB
# function that V8's Turbofan cannot compile ("Fatal process out of memory: Zone")
# -- only Node choked, and only at tier-up; capping it keeps the largest function at
# ~174 KB with no measurable size cost, and the module is otherwise unchanged.
"$WASM_OPT" -Oz --enable-exception-handling --one-caller-inline-max-function-size=1000 \
  "$OUT/crystal.wasm" -o "$DEST/compiler.wasm" || exit 1
gz "$DEST/compiler.wasm" "$DEST/compiler.wasm.gz"
rm -f "$DEST/compiler.wasm"
ls -l "$DEST/compiler.wasm.gz"

echo "=== lld ==="
# clang-wasm already publishes it gzipped; do not inflate and re-deflate it.
cp "$CLANG_WASM/.asset-cache/bin/lld.wasm.gz" "$DEST/lld.wasm.gz"
ls -l "$DEST/lld.wasm.gz"

echo "=== stdlib -> stdlib.json.gz ==="
python3 - "$OUT/src" "$DEST/stdlib.json" <<'PY'
import json, os, sys
root, out = sys.argv[1], sys.argv[2]
# `compiler/` is the compiler's own source: a program being compiled never
# requires it (the stdlib's prelude and library are all a program can reach), and
# it is 3.5 MB of the 9.5 MB -- over a third of the stdlib for nothing.
SKIP = ("compiler/",)
files = {}
for dirpath, _dirs, names in os.walk(root):
    for name in names:
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        if rel.startswith(SKIP):
            continue
        try:
            with open(full, encoding="utf-8") as fh:
                files[rel] = fh.read()
        except UnicodeDecodeError:
            continue  # not source; the compiler never opens it
with open(out, "w", encoding="utf-8") as fh:
    json.dump(files, fh, separators=(",", ":"))
print(f"{len(files)} files, {os.path.getsize(out) / 1e6:.1f} MB json")
PY
gz "$DEST/stdlib.json" "$DEST/stdlib.json.gz"
rm -f "$DEST/stdlib.json"
ls -l "$DEST/stdlib.json.gz"

echo "=== libraries ==="
copy() { gz "$1" "$DEST/$2.gz"; echo "  $2.gz <- $1"; }
copy "$SYSROOT/libc.a"                              "lib/libc.a"
copy "$SYSROOT/libwasi-emulated-signal.a"           "lib/libwasi-emulated-signal.a"
copy "$SYSROOT/libwasi-emulated-mman.a"             "lib/libwasi-emulated-mman.a"
copy "$SYSROOT/libwasi-emulated-getpid.a"           "lib/libwasi-emulated-getpid.a"
copy "$SYSROOT/libwasi-emulated-process-clocks.a"   "lib/libwasi-emulated-process-clocks.a"
# libc++abi and libunwind are the wasm EH runtime a Crystal program needs
# (personality, `_Unwind_*`); `libc++.a` is not shipped -- a Crystal program has
# no C++ in it, and it is 2.7 MB of the payload. See src/engine.js.
copy "$SYSROOT/eh/libc++abi.a"                      "lib/eh/libc++abi.a"
copy "$SYSROOT/eh/libunwind.a"                      "lib/eh/libunwind.a"
copy "$PCRE_LIB/libpcre2-8.a"                       "lib/libpcre2-8.a"
copy "$CLANG_RT/libclang_rt.builtins.a"             "lib/libclang_rt.builtins.a"

echo
echo "=== experimental GC ==="
GC_OUT=${GC_OUT:-/tmp/browser-crystal-gc}
GC_OUT="$GC_OUT" WASI_SDK="$WASI_SDK" bash "$DIR/../../build/crystal-wasm/build-gc.sh" || exit 1
python3 "$DIR/scripts/build-gc-assets.py" --libgc "$GC_OUT/build/libgc.a" --cache "$GC_OUT/downloads" --dest "$DEST" || exit 1

echo
echo "=== receipts ==="
# Pins exactly these bytes; every read is checked against them, so this is the step
# that says "these assets, and no others".
(cd "$DIR" && "$NODE" scripts/write-receipts.mjs) || exit 1

echo
echo "=== what the page fetches ==="
du -ch "$DEST"/compiler.wasm.gz "$DEST"/lld.wasm.gz "$DEST"/stdlib.json.gz "$DEST"/lib | tail -1
