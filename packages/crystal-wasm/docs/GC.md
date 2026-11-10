# Experimental Boehm GC

Enable collection in generated programs when creating the compiler:

```js
const compiler = await createCompiler({ baseUrl, gc: 'boehm-experimental' });
const result = await compiler.run(`
  GC.collect
  puts GC.stats.heap_size
  puts GC.prof_stats.gc_no
`);
await compiler.dispose();
```

The default is `gc: 'none'`. The setting belongs to the compiler instance;
`run()` does not change it. GC mode selects the runtime, link flags and final
instrumentation together. Passing `-Dwasm_gc_experimental` manually with GC off,
or `gc_none`, thread flags or a non-WASI target with GC on, is rejected. A failed
transformation returns a failed build and never executes the linked module.

This is a single-threaded Boehm collector inside Wasm linear memory. It collects
the generated program; the Crystal compiler itself still uses its original
allocator. Reclaimed blocks can be reused, but `WebAssembly.Memory` does not
shrink. No server compilation or cross-origin isolation is needed.

## Compile, link, instrument, run

The compiler still uses `--cross-compile` to emit an object. The conditional
`gc.cr` patch selects Boehm only for `wasm_gc_experimental`; WASI bindings use the
pinned library version without spawning `pkg-config` or linking pthreads.

The host links the whole module against `gc/libgc.a.gz`, with fatal linker
warnings, a 1 MiB linear stack, and `--stack-first`. Stack-first puts static data
after the stack, matching this BDWGC port's `STACKBOTTOM = &__global_base` and
data roots from `__global_base` to `__heap_base`. The stack pointer's name and
export are retained through instrumentation. The same link settings apply to
the built-in lld and a caller-supplied Clang toolchain.

Boehm cannot scan Wasm locals or operand-stack values. The host materializes
values in locals, then runs Binaryen's `spill-pointers` on the complete linked
module, including C libraries and callbacks. This ordering covers earlier
arguments that remain live while a later argument collects (Binaryen issue
[#9307](https://github.com/WebAssembly/binaryen/issues/9307)).

Binaryen 132's standard `flatten` pass does not support `try_table`. Functions
containing it use `src/gc-flatten.js`: an iterative traversal of Binaryen's own
folded text that preserves block result types, exception destinations and
evaluation order while materializing values. Their transformed bodies and extra
locals are copied back into the original module. Other functions use Binaryen's
standard pass and are represented by stubs during text parsing, avoiding a native
stack overflow on deeply nested compiler-generated functions in classic workers.
Unsupported instructions fail the build. The transformation
preserves the input feature set; enabling every Binaryen feature would allow
encodings that the browser does not support. Both Binaryen and the host validate
the final binary before it is executed or returned by the engine.

`onStatus` gains an `instrumenting` stage, and `compileMs` includes it. Existing
result fields remain the same. The internal engine's `wasm` result contains the
instrumented binary.

## Assets and rebuilding

GC adds two optional, checksum-verified assets: Binaryen 132.0.0 (2.63 MB gzipped)
and BDWGC (0.064 MB gzipped). GC-off loading fetches neither. The Binaryen ESM
distribution is wrapped in a lazy async factory so Node, browser ESM and classic
IIFE workers use the same implementation. The verified, inflated factory is
imported using a `data:` module URL. A host with a Content Security Policy must
allow that module source in `script-src` when enabling GC.

Source URLs, versions, commit and SHA-256 hashes are pinned in
`build/crystal-wasm/gc-dependencies.json` in the repository. BDWGC is development
version 8.3.0 at `2aeff7b59a932039f24e988bb2251e8a8f6f3a11`. Builds disable
threads, parallel marking, thread-local allocation, dynamic loading and unmapping.
License files ship in `vendor/gc/`.

The full `build-assets.sh` pipeline includes GC. To upgrade an existing payload
without rebuilding the compiler, run from the repository root:

```sh
export WASI_SDK=/path/to/wasi-sdk-33
export GC_OUT=/tmp/browser-crystal-gc
bash build/crystal-wasm/build-gc.sh
python3 packages/crystal-wasm/scripts/build-gc-assets.py \
  --libgc "$GC_OUT/build/libgc.a" --cache "$GC_OUT/downloads"
node packages/crystal-wasm/scripts/write-receipts.mjs
npm run build:iife --prefix packages/crystal-wasm
npm test
```

The packaging step also patches the existing standard-library archive. It is
idempotent and refuses source drift. Downloaded archives are verified even on
cache hits. Commit the generated assets, receipts, license files and IIFE
together. Builds require CMake, Python 3, the WASI SDK and network access on the
first run; runtime use does not require npm resolution or external commands.

## Validation and current limits

The tests run the existing API cases and all eight demo samples in both modes,
check stack roots during argument evaluation, and exercise both linker paths
and transformation failure handling. The stress fixture allocates at least
256 MiB cumulatively under an 8 MiB GC heap cap, checks automatic collections,
and retains local, global, array, Hash and closure roots. The exception fixture
checks 1,000 nested rescues and rethrows with GC in handlers and ensure blocks,
and verifies that the linear stack position returns to its baseline each time.

Browser validation uses an isolated Chromium instance with a debugging port:

```sh
npm start
# In another terminal, launch Chromium with --headless=new,
# --remote-debugging-port=9223 and a temporary --user-data-dir.
npm run test:browser --prefix packages/crystal-wasm
```

`GC_TEST_BASE_URL` and `GC_TEST_CDP_URL` override the default local ports 8127
and 9223. The check requires `crossOriginIsolated === false`, compares all eight
samples, runs both stress fixtures, and runs the exception fixture in a classic
Worker through the IIFE entry.

A pre-existing compiler limitation remains in both modes: an exception
propagating through an inner `ensure` can bypass an enclosing rescue. This also
affects re-raising from a `rescue` that has its own `ensure`. The GC tests
separately cover rethrows and ensure blocks in supported combinations. This
change does not rebuild the compiler's exception code generator.

On 2026-11-10, macOS arm64 / Node 26.13.0 passed all 37 tests. Headless Chromium
157 passed all browser checks with `crossOriginIsolated === false`, including
the classic IIFE worker. Observed timings in that validation run were:

| measurement | GC off | experimental GC |
| --- | --- | --- |
| compiler creation | 578 ms | 1,504 ms |
| median build time across eight demo samples | 566 ms | 1,372 ms |
| build-time range across those samples | 496–1,102 ms | 1,114–1,994 ms |

Build timings include linking and instrumentation. These are local observations
from one validation run, with Node tests running concurrently, rather than a
performance guarantee. The GC exception fixture took 211 ms to execute in the
classic worker; the GC stress fixture completed within its 8 MiB heap cap. The
source build script was also run with WASI SDK 33 and reproduced the same
`libgc.a` bytes as the initial validation build. The compiler binary was not
rebuilt.
