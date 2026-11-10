# Third-party notices

The code in this package is MIT (see [LICENSE](./LICENSE)). What it *ships* is other
people's work compiled: a Crystal compiler, a linker, a C runtime and a regular
expression library, all built for `wasm32-wasip1`. Those are listed here, as are the
two pieces of code that are redistributed verbatim.

## In `assets/crystal/`

| component | version | licence | what it is |
| --- | --- | --- | --- |
| **Crystal compiler and standard library** | 1.22.0 | Apache-2.0 | `compiler.wasm` is the compiler's own source, cross-compiled for wasm (patched — see [the browser-crystal repository](https://github.com/live-codes/browser-crystal) `build/crystal-wasm/apply-patches.py`). `stdlib.json` is its standard library as source. |
| **LLVM** | 20.1.8 | Apache-2.0 WITH LLVM-exception | Linked into `compiler.wasm` (libLLVM, built for wasm by the [`llvm-wasm`](https://github.com/live-codes/llvm-wasm) pipeline). |
| **wasi-libc** | as shipped with wasi-sdk 33 | MIT OR Apache-2.0 WITH LLVM-exception | `lib/libc.a`, the WASI emulation archives, and `lib/libclang_rt.builtins.a`. |
| **libc++abi and libunwind** | as shipped with wasi-sdk 33 | Apache-2.0 WITH LLVM-exception | `lib/eh/*.a` — the wasm exception-handling runtime a compiled program needs (the personality function and `_Unwind_*`). `libc++.a` itself is not shipped: a Crystal program is not C++. |
| **lld (LLVM's linker)** | 22, from [clang-wasm](https://github.com/live-codes/clang-wasm) | Apache-2.0 WITH LLVM-exception | `lld.wasm`, run as `wasm-ld` to link the object the compiler emits. |
| **PCRE2** | 10.42 | BSD-3-Clause | `lib/libpcre2-8.a`, built for wasm32 — Crystal's `Regex` is a binding to it. |
| **BDWGC (Boehm GC)** | 8.3.0-dev, commit `2aeff7b59a932039f24e988bb2251e8a8f6f3a11` | MIT-style | `gc/libgc.a`, built for single-threaded WASI. License: `vendor/gc/BDWGC-LICENSE`. |
| **Binaryen JavaScript distribution** | 132.0.0 | Apache-2.0 | `gc/binaryen.mjs`, wrapped in an async initialization factory; `import.meta.url` is supplied by the host. Loaded only in experimental GC mode. License: `vendor/gc/BINARYEN-LICENSE`. |

## In `vendor/browser_wasi_shim/`

`@bjorn3/browser_wasi_shim` **v0.4.2**, MIT OR Apache-2.0 — the WASI host and in-memory
filesystem the compiler runs against, vendored verbatim with its licence files
(`vendor/browser_wasi_shim/LICENSE-MIT`, `LICENSE-APACHE`). Its one behaviour worth
changing — it grows a file by reallocating on every write past the end, which makes
writing an object file quadratic — is patched *around*, in `src/engine.js`, so this copy
stays exactly as published.

## Build-time only (not distributed)

The payload is produced with **wasi-sdk 33** (clang 22 and its sysroot), **Python 3** for
the standard library archive, and **wasm-opt** from Emscripten (Binaryen, Apache-2.0) for
size. The build tools themselves are not redistributed; the separate Binaryen
runtime distribution used for GC instrumentation is listed above.
