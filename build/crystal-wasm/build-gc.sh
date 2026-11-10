#!/usr/bin/env bash
# Build the pinned, single-threaded WASI collector with the compiler's WASI SDK.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WASI_SDK=${WASI_SDK:-/opt/wasi-sdk-33}
GC_OUT=${GC_OUT:-/tmp/browser-crystal-gc}
archive=$(python3 "$HERE/fetch-gc-dependency.py" bdwgc "$GC_OUT/downloads")
mkdir -p "$GC_OUT/src"
tar -xzf "$archive" -C "$GC_OUT/src" --strip-components=1
cmake -S "$GC_OUT/src" -B "$GC_OUT/build" \
  -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk.cmake" \
  -DCMAKE_BUILD_TYPE=Release -DGC_BUILD_SHARED_LIBS=OFF \
  -Denable_threads=OFF -Denable_parallel_mark=OFF \
  -Denable_thread_local_alloc=OFF -Denable_dynamic_loading=OFF \
  -Denable_munmap=OFF -Denable_docs=OFF -Dbuild_cord=OFF -DBUILD_TESTING=OFF
cmake --build "$GC_OUT/build" --parallel
echo "WASI collector: $GC_OUT/build/libgc.a"
