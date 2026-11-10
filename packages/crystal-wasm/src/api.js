// One implementation, two entry points: `index.js` for anywhere without a
// filesystem, and `index.node.js` for Node, which can also read the assets that
// ship in this package. The two things that differ between those environments --
// where the assets come from, and how gzip is inflated -- are handed in rather
// than guessed at.
import { resolveAssetSource } from './assets.js';
import { compileAndRun, stripAnsi } from './engine.js';
import { loadAssets } from './loader.js';
import { GC_NONE, validateGc } from './gc.js';

export function createApi({ packaged, inflate }) {
	/**
	 * Create a compiler. Loading the assets happens here rather than on the first
	 * `run()`, so a wrong URL or a missing file is reported where it can still be
	 * acted on -- and `onStatus` has something to say while a 22 MB payload loads.
	 *
	 * A compiler holds the compiled assets (a 35 MB module among them), so a caller
	 * that has finished with one should `dispose()` it rather than leave it.
	 *
	 * @param {object} [options]
	 * @param {string} [options.baseUrl] - where the assets are served from. Required
	 *   anywhere without a filesystem; in Node it can be omitted to use the assets
	 *   in this package. See `docs/ASSETS.md`.
	 * @param {object} [options.toolchain] - a toolchain from `@live-codes/clang-wasm`'s
	 *   `createToolchain()`, for a caller that already holds one. Its lld links what
	 *   this compiler emits, so a page running C/C++ alongside Crystal links with the
	 *   lld it already has instead of fetching a second copy. It stays the caller's:
	 *   `dispose()` never releases it, and the sysroot libraries still come from here.
	 * @param {string[]} [options.compileArgs] - extra `crystal build` flags.
	 * @param {'none'|'boehm-experimental'} [options.gc='none'] - GC for generated programs.
	 * @param {string[]} [options.args] - default program argv.
	 * @param {(fraction: number) => void} [options.onProgress] - asset loading, 0 to 1.
	 * @param {(text: string, what: {source: string, stream: string, stage: string}) => void}
	 *   [options.onLog] - the compiler's and the linker's own output. `source` is
	 *   `crystal` or `wasm-ld`; `stream` is `out` or `err`; `stage` is the stage that
	 *   produced it. A caller that shows the program's output to a user usually wants
	 *   none of this except a compiler warning about their code -- see `run()`'s
	 *   `errors`.
	 * @param {(text: string, stream: 'out'|'err') => void} [options.onOutput] - the
	 *   program's output as it is written, for a caller that wants to show a slow
	 *   program while it runs. The result carries the whole of it either way, and is
	 *   what a caller should draw from when the run ends.
	 * @param {(text: string) => void} [options.onStatus] - what is happening, for a
	 *   status line.
	 */
	async function createCompiler(options = {}) {
		const gc = options.gc ?? GC_NONE;
		validateGc(gc, options.compileArgs);
		const source = resolveAssetSource(options, packaged);
		const onLog = options.onLog ?? (() => {});
		const onStatus = options.onStatus ?? (() => '');
		const callersToolchain = options.toolchain ? assertToolchain(options.toolchain) : null;

		const loaded = await loadAssets({
			source,
			inflate,
			onStatus,
			onProgress: options.onProgress,
			// A caller's toolchain links for us, and its lld is the same program this
			// package would ship -- so that 7.8 MB is not fetched.
			needLld: !callersToolchain,
			gc
		});

		let assets = loaded.assets;
		let disposed = false;

		// The compiler's and the linker's output, tagged with where it came from, so
		// the caller can decide what deserves to be seen. Nothing is buffered here:
		// `run()` is the one that has to keep the diagnostics.
		const log = (stage) => (text, stream) =>
			onLog(text, {
				source: stage === 'compiling' ? 'crystal' : stage === 'linking' ? 'wasm-ld' : stage === 'instrumenting' ? 'binaryen' : 'program',
				stream,
				stage
			});

		return {
			/** Where the assets came from, for an error message a user can act on. */
			assetSource: source.description,

			/** What the payload contained: how many standard library files, how many libraries. */
			stats: loaded.counts,
			gc,

			/**
			 * Compile and run a program.
			 *
			 * @param {string} code - the Crystal program.
			 * @param {string|Uint8Array} [input] - stdin, given to the program once and
			 *   then closed. A program that calls `gets` reads it.
			 * @param {object} [runOptions] - per-run overrides: `args`, `compileArgs`,
			 *   `files`, `onOutput`.
			 * @param {string[]} [runOptions.args] - the program's argv, after its own name.
			 * @param {Record<string, string|Uint8Array>} [runOptions.files] - further
			 *   sources, written beside the program, so it can `require "./helper"` them.
			 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, output: string,
			 *   errors: string[], exitCode: number|null, compileMs: number, runMs: number|null}>}
			 *   `output` is stdout and stderr in the order the program wrote them.
			 *   `errors` holds the compiler's or the linker's diagnostics, already
			 *   stripped of colour, and is empty when it built; `exitCode` is null when
			 *   the program never ran.
			 */
			async run(code, input = '', runOptions = {}) {
				if (disposed) throw new Error('This compiler has been disposed.');
				if (typeof code !== 'string') {
					throw new Error('run() needs the program source as its first argument.');
				}

				const started = performance.now();
				const stdout = [];
				const stderr = [];
				const order = [];
				const onOutput = runOptions.onOutput ?? options.onOutput ?? (() => {});
				const collect = (into, stream) => (text) => {
					into.push(text);
					order.push(text);
					if (stream === 'running') onOutput(text, into === stdout ? 'out' : 'err');
				};

				try {
					const result = await compileAndRun({
						source: code,
						files: runOptions.files ?? {},
						assets,
						toolchain: callersToolchain,
						args: runOptions.args ?? options.args ?? [],
						compileArgs: runOptions.compileArgs ?? options.compileArgs ?? [],
						gc,
						stdin: typeof input === 'string' ? input : new TextDecoder().decode(input),
						onStage: onStatus,
						onStdout: (text, stage) => {
							if (stage === 'running') collect(stdout, stage)(text);
							else log(stage)(text, 'out');
						},
						onStderr: (text, stage) => {
							if (stage === 'running') collect(stderr, stage)(text);
							else log(stage)(text, 'err');
						}
					});

					return {
						ok: result.exitCode === 0,
						stdout: stdout.join(''),
						stderr: stderr.join(''),
						// What a terminal would have shown: both streams in the order they were written.
						output: order.join(''),
						errors: [],
						exitCode: result.exitCode,
						// `compileMs` is the whole build -- the compiler plus the link, which
						// is what a caller waiting for a result is actually waiting for.
						compileMs: Math.round(result.phases.compiling + result.phases.linking + (result.phases.instrumenting ?? 0)),
						runMs: Math.round(result.phases.running)
					};
				} catch (error) {
					// A failed build's own words are the message, already stripped of colour;
					// our sentence is only there to say what failed when they are silent.
					const diagnostics = stripAnsi(error?.diagnostics ?? '').trim();
					const what = error?.stage === 'linking' ? 'Linking' : error?.stage === 'instrumenting' ? 'GC instrumentation' : 'Compilation';
					const errors = diagnostics
						? diagnostics.split('\n')
						: [error?.stage === 'instrumenting'
							? stripAnsi(error.message)
							: `${what} failed: ${stripAnsi(error?.message ?? String(error))}`];
					return {
						ok: false,
						stdout: '',
						stderr: '',
						output: '',
						errors,
						exitCode: null,
						// How long the build got before it failed; the program never ran.
						compileMs: Math.round(performance.now() - started),
						runMs: null
					};
				}
			},

			/**
			 * Release what this compiler holds: the compiled compiler, the linker and the
			 * standard library. A toolchain passed in through `toolchain` is not touched,
			 * because it belongs to the caller and other languages may be compiling
			 * through it. Calling this twice is a no-op, and `run()` afterwards throws.
			 */
			async dispose() {
				if (disposed) return;
				disposed = true;
				assets = null;
			}
		};
	}

	return { createCompiler };
}

function assertToolchain(toolchain) {
	const runtime = toolchain?.runtime;
	if (typeof toolchain?.runCommand !== 'function' || typeof runtime?.getModule !== 'function' || !runtime?.assetUrls?.lld) {
		throw new Error(
			'toolchain must be a toolchain from @live-codes/clang-wasm\'s createToolchain(): this needs ' +
				'its runCommand(), and its runtime\'s getModule() and assetUrls.lld to reach the linker.'
		);
	}
	return toolchain;
}
