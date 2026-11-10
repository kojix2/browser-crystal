# @live-codes/crystal-wasm

Run **Crystal** in the browser, on the Crystal compiler compiled to WebAssembly.

Three WebAssembly programs run, and no server is involved:

```
your Crystal source
  → compiler.wasm   the Crystal compiler, built for wasm32-wasip1   → wasm object
  → lld.wasm        LLVM's linker, run as `wasm-ld`                 → WASI module
  → that module     your program                                    → output
```

The standard library is fetched as data and handed to the compiler as a filesystem.
Nothing is uploaded, and no cross-origin isolation is required.

- **22 MB gzipped** of assets, loaded once and reused for every run.
- **Exceptions work**: `raise`/`rescue`/`ensure` on `wasm32-wasip1`, which is not true
  of upstream Crystal 1.22 and is the reason `build/crystal-wasm/` exists.
- **stdin and argv** go to the program; further source files can be compiled with it.
- **Experimental GC**: pass `gc: 'boehm-experimental'` to reclaim memory in generated
  programs. It adds about 2.7 MB of optional assets. See [GC setup and limits](docs/GC.md).

## Use

```bash
npm install @live-codes/crystal-wasm
```

```js
import { createCompiler } from '@live-codes/crystal-wasm';

const compiler = await createCompiler({
  baseUrl: new URL('/crystal/', location.href),   // where the assets are served from
  onStatus: (text) => console.log(text)
});

const result = await compiler.run(`
  begin
    raise "boom"
  rescue ex : Exception
    puts "caught: #{ex.message}"
  end
`, 'stdin\n', { args: ['--flag'] });

console.log(result.output, result.exitCode, result.errors);
await compiler.dispose();
```

### The assets have to be served

A browser cannot read a file inside an npm package, so the assets must live where the page can
fetch them — which is what a CDN already does. Nothing has to be copied: import the entry from
the same place and point `baseUrl` at the package's own assets.

```js
import { createCompiler } from 'https://cdn.jsdelivr.net/npm/@live-codes/crystal-wasm@0.1.0/src/index.js';

const compiler = await createCompiler({
  baseUrl: 'https://cdn.jsdelivr.net/npm/@live-codes/crystal-wasm@0.1.0/assets/crystal/'
});
```

Everything the page needs is in the package — the loader, the compile → link → run core, the
vendored WASI host, and the payload — and the assets are gzipped as they are, with no
content-encoding to configure, because the loader inflates them with `DecompressionStream`.
The CDN only has to serve them and send CORS headers, which jsDelivr does.

To serve them yourself instead, copy them out once and point `baseUrl` at your copy:

```bash
npx --package @live-codes/crystal-wasm crystal-wasm-copy-assets public/crystal
```

In **Node** there is nothing to copy — the assets that ship in the package are read off disk,
`baseUrl` is optional, and `createCompiler()` on its own is enough.

### Compiling a program

```js
const result = await compiler.run(code, input, options);
```

| option | |
| --- | --- |
| `code` | the Crystal program |
| `input` | stdin, given to the program once and then closed |
| `options.args` | the program's argv, after its own name |
| `options.files` | further sources, written beside the program, so it can `require "./helper"` them |
| `options.compileArgs` | extra `crystal build` flags |
| `options.onOutput` | the program's output as it is written |

and the result:

| field | |
| --- | --- |
| `ok` | whether it built and the program exited 0 |
| `stdout`, `stderr` | separately, and `output` as a terminal would have shown them |
| `errors` | the compiler's or the linker's diagnostics, colour stripped, empty when it built |
| `exitCode` | the program's, or `null` if it never ran |
| `compileMs`, `runMs` | how long the build took, and how long the program ran |

A failed build is a **result**, not a throw: check `errors`. Only a mistake in how the
compiler was *used* — a disposed compiler, a missing asset — throws.

### Sharing a Clang runtime

A page that also runs C or C++ through
[`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm) already
has an lld, and it is the same program this package ships. Pass its toolchain and the
7.8 MB linker is not fetched a second time:

```js
const toolchain = await createToolchain({ baseUrl: new URL('/clang/', location.href) });
const compiler = await createCompiler({ baseUrl, toolchain });
```

The toolchain stays yours — `dispose()` never releases it — and the sysroot libraries
still come from this package.

## Full API

### `createCompiler(options?)`

Loads the assets (a 35 MB wasm module among them), so it is `async` and worth reusing.

| option | |
| --- | --- |
| `baseUrl` | where the assets are served from. Required in a browser, optional in Node. |
| `toolchain` | a toolchain from `@live-codes/clang-wasm`'s `createToolchain()`, to link through |
| `compileArgs` | extra `crystal build` flags, for every run |
| `gc` | `'none'` (default) or `'boehm-experimental'`; fixed for this compiler instance |
| `args` | default program argv |
| `onProgress` | asset loading, 0 to 1 |
| `onLog` | the compiler's and the linker's own output, as `(text, { source, stream, stage })` |
| `onOutput` | the program's output as it is written, as `(text, 'out' \| 'err')` |
| `onStatus` | what is happening, for a status line |

Returns `{ run, dispose, assetSource, stats, gc }`.

### `compiler.run(code, input?, options?)`

As above. Throws only if the compiler has been disposed or was never usable.

### `await compiler.dispose()`

Releases the compiled assets. Idempotent, final, and it does not touch a toolchain that
was passed in.

## What does not work

- **GC is opt-in.** The default allocator never reclaims memory. The experimental
  mode supports collection and GC statistics; see [its limitations](docs/GC.md).
- **No threads, sockets or subprocesses** in the compiled program: WASI preview 1 has no
  processes, and the program gets an empty filesystem.
- **A fixed set of libraries**: `libc`, `libc++abi`, `libunwind`, PCRE2 and the WASI
  emulation archives. Anything else has to be linked in by hand.
- **Crystal is pinned at 1.22.0**: the wasm-EH codegen patch and the `llc` build step are tuned to it.

## Rebuilding the payload

`build-assets.sh` and `docs/ASSETS.md` — the assets are build outputs of
[the browser-crystal repository](https://github.com/live-codes/browser-crystal)
(`build/crystal-wasm/`, and the [`llvm-wasm`](https://github.com/live-codes/llvm-wasm) package the
compiler links against), and `scripts/write-receipts.mjs` pins
their bytes.

## Licence

MIT, with the third-party notices in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md):
Crystal, LLVM, wasi-libc, PCRE2 and the vendored WASI host.
