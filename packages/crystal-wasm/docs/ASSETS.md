# The assets

`assets/crystal/` is the payload this package loads: 12 base files, ~23 MB gzipped,
plus 2 optional GC files (~2.7 MB). The generated assets are committed in this
checkout and pinned by
`src/asset-receipts.js`, which `scripts/write-receipts.mjs` writes from the bytes on
disk. Every read is checked against those receipts, so a stale copy, a truncated
download or a host serving something else is reported rather than compiled.

## What is in it

| file | raw | gzipped | |
| --- | --- | --- | --- |
| `compiler.wasm.gz` | 36.1 MB | 11.89 MB | the Crystal compiler: `opt -O3` + `llc`, `--strip-debug`, `wasm-opt -Oz` |
| `lld.wasm.gz` | 21 MB | 7.8 MB | clang-wasm's lld, already gzipped there |
| `stdlib.json.gz` | 6.7 MB | 1.45 MB | the patched standard library, 1462 files as `{ "path": "contents" }` |
| `lib/libc.a.gz` | 2.7 MB | 1.1 MB | wasi-libc |
| `lib/eh/libc++abi.a.gz`, `lib/eh/libunwind.a.gz` | 1.8 MB | 0.48 MB | the wasm exception-handling runtime |
| `lib/libclang_rt.builtins.a.gz` | 0.5 MB | 0.13 MB | compiler builtins |
| `lib/libpcre2-8.a.gz` | 0.4 MB | 0.11 MB | PCRE2, for `Regex` |
| `lib/libwasi-emulated-{signal,mman,getpid,process-clocks}.a.gz` | 0.05 MB | 0.01 MB | what wasi-libc emulates |
| `gc/binaryen.mjs.gz` | 14.8 MB | 2.63 MB | lazy Binaryen factory, loaded only with experimental GC |
| `gc/libgc.a.gz` | 0.3 MB | 0.064 MB | single-threaded WASI collector, loaded only with experimental GC |

The libraries are keyed the way the linker asks for them (`lib/libc.a`), because those
names become paths in the linker's filesystem — see `src/loader.js`.
GC source pins, rebuilding and validation are documented in [GC.md](GC.md).

## Rebuilding

```bash
npm run demo:assets          # from the repository root — Linux or WSL, ~10 minutes
```

`build-assets.sh` needs the WSL build tree (`$OUT=/root/bc-crystal`, with `crystal.wasm`
linked), wasi-sdk 33, PCRE2 built for wasm, clang-wasm's asset cache (for `lld.wasm.gz`),
emsdk's `wasm-opt`, and Python 3. It ends by running `write-receipts.mjs`, which rewrites
`src/asset-receipts.js` — **commit that file**: a receipt is only useful if it is the one
the released package shipped with.

Useful knobs: `OUT`, `WASI_SDK`, `PCRE_LIB`, `CLANG_WASM`, `WASM_OPT`, `NODE`, and `DIR`
(where the script thinks it lives).

To re-pin without rebuilding — for instance after replacing one library by hand — run:

```bash
node scripts/write-receipts.mjs
```

## Why it is shaped this way

Four decisions did most of the work, and they are recorded because each was measured:

- **`wasm-opt -Oz --enable-exception-handling`** takes the linked compiler from 60 MB to
  36.1 MB raw (11.89 MB gzipped). It also passes
  `--one-caller-inline-max-function-size=1000`, without which Binaryen folds a chain of
  single-caller functions into one 882 KB function that V8's Turbofan cannot compile (a
  `Zone` OOM in Node, which Chrome tolerates). **Never `-all`**: one of those passes emits a
  module V8 rejects with `unknown import kind 0x7e`, which Binaryen's own validator
  accepts — so a variant has to be validated in V8 to be trusted.
- **`-Wl,--strip-debug`** at link time: 79 → 59 MB. The `name` section is kept on purpose,
  because named wasm stack traces are how the compiler is debugged; the *shipped* module
  loses them anyway, to `wasm-opt`.
- **gzip**, inflated by the loader (`DecompressionStream` in a page, `zlib` in Node): no
  server configuration, so any static host works.
- **Nothing that is not needed**: `libc++.a` is absent (a Crystal program has no C++ in
  it), and the standard library ships without `compiler/` — the compiler's own source,
  which a compiled program can never require, and over a third of the standard library's
  bytes.

## What is not here

- **The Windows/Linux build tree** — `build/crystal-wasm/` in the
  [browser-crystal repository](https://github.com/live-codes/browser-crystal), which is where the
  compiler and this payload come from. The libLLVM it links against is built by the
  [`llvm-wasm`](https://github.com/live-codes/llvm-wasm) repository — a build-time dependency of the
  compiler, not something a page loads.
- **The `browser_wasi_shim` host** — vendored under `../vendor/`, because it is code, not
  an asset.
