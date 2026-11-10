// engine.js — compile, link and run Crystal, with no environment of its own.
//
// Three WebAssembly modules run here and nothing else does any work:
//
//   1. compiler.wasm  the Crystal compiler (built by ../../build/crystal-wasm/),
//                     given the standard library as a filesystem and the user's
//                     source, emitting a wasm *object*;
//   2. lld.wasm       clang-wasm's lld, run as `wasm-ld`, linking that object
//                     against the sysroot libraries into a runnable module;
//   3. that module    the user's program, run for its output.
//
// The WASI host is the vendored `browser_wasi_shim` (../vendor/), which supplies
// the in-memory filesystem the compiler needs. Nothing in this file touches a
// browser API, so the same code runs in a page, in a worker and in Node.
import {
	ConsoleStdout,
	Directory,
	File,
	OpenFile,
	PreopenDirectory,
	WASI,
	wasi as wasiDefs
} from '../vendor/browser_wasi_shim/index.js';
import { GC_BOEHM, GC_NONE, instrumentGc, validateGc } from './gc.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// Crystal colourises its diagnostics, and those escape sequences would arrive in
// a page as literal "[4m" text. Build output is plain; a *program's* output is
// left alone, because a program may colourise on purpose.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text) => text.replace(ANSI, '');

// browser_wasi_shim grows a file by allocating exactly what the write needs and
// copying the old bytes in, on *every* write that lands past the end:
//
//   if (this.file_pos + len > this.file.size) {
//     const old = this.file.data;
//     this.file.data = new Uint8Array(Number(this.file_pos + len));
//     this.file.data.set(old);
//   }
//
// LLVM writes a wasm object in ~110k small positioned writes, so that is
// quadratic -- measured, 7.4 s of a 10.7 s compile was this one copy, 82% of the
// whole compile. Growing geometrically instead makes it linear: the same object
// now takes 1.4 s.
//
// The price is that a file's buffer is larger than its contents while it is being
// written, and the shim takes `data.byteLength` to *be* the file size. So the
// written length is tracked separately and files are trimmed back to it before
// anything reads them (see trimWrittenFiles) -- a reader that reads to EOF would
// otherwise see the spare capacity as trailing zeros.
//
// The vendored shim is left pristine; this is the one behaviour worth patching,
// so it is patched here where the reason is visible.
const writtenLength = new WeakMap();

// A file's *contents*, as opposed to the buffer they are held in.
const logicalLength = (file) => writtenLength.get(file.data) ?? file.data.byteLength;

function patchFileGrowth() {
	const write = OpenFile.prototype.fd_write;
	const pwrite = OpenFile.prototype.fd_pwrite;
	const seek = OpenFile.prototype.fd_seek;

	const grow = (file, needed) => {
		// Against the buffer's capacity -- not `file.size`, which is the contents.
		if (needed <= file.data.byteLength) return;
		const size = Math.max(needed, file.data.byteLength * 2, 1 << 16);
		const grown = new Uint8Array(size);
		grown.set(file.data);
		// The contents' length has to travel with the buffer, or the next write
		// would take this buffer's capacity to be the file's length and ratchet the
		// tracked length up to it.
		const carried = logicalLength(file);
		file.data = grown;
		writtenLength.set(grown, carried);
	};

	const record = (file, end) => {
		writtenLength.set(file.data, Math.max(logicalLength(file), end));
	};

	OpenFile.prototype.fd_write = function (data) {
		if (this.file.readonly) return write.call(this, data);
		const end = Number(this.file_pos + BigInt(data.byteLength));
		grow(this.file, end);
		this.file.data.set(data, Number(this.file_pos));
		this.file_pos += BigInt(data.byteLength);
		record(this.file, end);
		return { ret: 0, nwritten: data.byteLength };
	};

	OpenFile.prototype.fd_pwrite = function (data, offset) {
		if (this.file.readonly) return pwrite.call(this, data, offset);
		const end = Number(offset + BigInt(data.byteLength));
		grow(this.file, end);
		this.file.data.set(data, Number(offset));
		record(this.file, end);
		return { ret: 0, nwritten: data.byteLength };
	};

	// The shim seeks to `data.byteLength` for WHENCE_END, which is now the buffer
	// and not the file: seeking to the end would leave a gap of zeros.
	OpenFile.prototype.fd_seek = function (offset, whence) {
		if (whence !== wasiDefs.WHENCE_END) return seek.call(this, offset, whence);
		const target = BigInt(logicalLength(this.file)) + offset;
		if (target < 0n) return { ret: wasiDefs.ERRNO_INVAL, offset: 0n };
		this.file_pos = target;
		return { ret: 0, offset: this.file_pos };
	};

	// ...and `File#size` (what `stat` reports) has to be the contents too.
	Object.defineProperty(File.prototype, 'size', {
		get() {
			return BigInt(logicalLength(this));
		}
	});
}

function trimWrittenFiles(dir) {
	for (const entry of dir.contents.values()) {
		if (entry instanceof Directory) trimWrittenFiles(entry);
		else if (entry instanceof File) {
			const length = writtenLength.get(entry.data);
			if (length !== undefined && length < entry.data.byteLength) entry.data = entry.data.slice(0, length);
		}
	}
}

patchFileGrowth();

/** The name the compiled program sees as `PROGRAM_NAME`. */
export const PROGRAM_NAME = 'program';

// The compiler's own flags, mirroring ../../build/crystal-wasm/cross-compile.sh:
// the `without_*` flags drop compiler-only tooling and `use_pcre2` avoids a
// `pkg-config` shell-out (WASI has no processes). wasm exception handling is
// enabled by the compiler itself for a wasm target.
//
// argv[0] is the program name: Crystal's ARGV is *everything after it*, so the
// leading "crystal" is what makes "build" the command rather than the first flag.
// (clang-wasm's host inserts a program name for you; browser_wasi_shim, which
// this uses, does not.)
export const compilerArgs = (extra = []) => [
	'crystal', 'build', '--cross-compile', '--target=wasm32-unknown-wasi',
	'-Di_know_what_im_doing', '-Dwithout_playground', '-Dwithout_docs',
	'-Dwithout_interpreter', '-Duse_pcre2', '-Dwithout_mt',
	...extra,
	'-o', 'out.o.wasm', 'main.cr'
];

// The same link line clang's driver uses under `-fwasm-exceptions`, with the
// libraries mounted at `lib/` and `lib/eh/`. `lib/eh` comes first so `-lc++abi`
// and `-lunwind` resolve to the wasm-EH variants.
//
// `-lc++` is deliberately absent: the compiler's own cross-compile echo is
// `wasm-ld out.o.wasm -o out.o -lc`, and a Crystal program has no C++ in it --
// what it does need from the C++ runtime is the wasm EH personality and
// `_Unwind_*`, which are libc++abi and libunwind. Dropping it is 2.7 MB of the
// payload. If a program ever does need it, the linker says so by name.
//
// lld dispatches on argv[0], and this is a *generic* lld: without the leading
// "wasm-ld" it refuses to do anything. Every host this runs under takes the
// program name separately, so it is stripped when the line is handed over.
export const LINKER_ARGS = [
	'wasm-ld', '-m', 'wasm32',
	'-Llib/eh', '-Llib',
	'out.o.wasm',
	'-lpcre2-8', '-lc++abi', '-lunwind',
	'-lwasi-emulated-signal', '-lwasi-emulated-mman',
	'-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks',
	'-lc', 'lib/libclang_rt.builtins.a',
	'-o', 'out.wasm'
];

export function linkerArgs(gc = GC_NONE) {
	return gc === GC_BOEHM
		? [...LINKER_ARGS.slice(0, -2), '--fatal-warnings', '--stack-first', '-z', 'stack-size=1048576', '--export=__stack_pointer', '-lgc', ...LINKER_ARGS.slice(-2)]
		: LINKER_ARGS;
}

const asFile = (data) =>
	new File(typeof data === 'string' ? ENCODER.encode(data) : data);

// browser_wasi_shim's Directory is a Map of name -> File|Directory. Build the
// tree from flat paths; the returned Directory is what the preopen wraps, and
// its `contents` Map is shared, so files the guest writes show up in it too.
function buildTree(entries) {
	const root = new Directory(new Map());
	for (const [path, data] of entries) {
		const parts = path.split('/').filter(Boolean);
		const name = parts.pop();
		let dir = root;
		for (const part of parts) {
			let child = dir.contents.get(part);
			if (!(child instanceof Directory)) {
				child = new Directory(new Map());
				dir.contents.set(part, child);
			}
			dir = child;
		}
		dir.contents.set(name, asFile(data));
	}
	return root;
}

// A stdout/stderr that both streams text out as it arrives and keeps it.
function textSink(onText) {
	const decoder = new TextDecoder();
	let text = '';
	const fd = new ConsoleStdout((chunk) => {
		const decoded = decoder.decode(chunk, { stream: true });
		if (decoded) {
			text += decoded;
			onText?.(decoded);
		}
	});
	return {
		fd,
		flush() {
			const rest = decoder.decode();
			if (rest) {
				text += rest;
				onText?.(rest);
			}
		},
		get text() {
			return text;
		}
	};
}

/**
 * Run a WASI command module in this package's own host.
 *
 * @param {WebAssembly.Module|Uint8Array} moduleOrBytes
 * @param {object} options
 * @param {string[]} options.args
 * @param {Array<[string, string|Uint8Array]>} [options.entries]
 * @param {string} [options.stdin]
 * @param {string} [options.stage] - which stage this run is, so the caller can
 *   treat the compiler's chatter differently from the program's output: only the
 *   program's output keeps its colour.
 */
async function runCommand(moduleOrBytes, { args, env = [], entries = [], stdin = '', onStdout, onStderr, stage }) {
	const root = buildTree(entries);
	const stdout = textSink((text) => onStdout?.(stage === 'running' ? text : stripAnsi(text), stage));
	const stderr = textSink((text) => onStderr?.(stage === 'running' ? text : stripAnsi(text), stage));

	// fd 0 is a file holding the caller's stdin: a program that calls `gets`
	// reads it, and one that does not never looks. The compiler and the linker
	// are given the empty string -- neither reads stdin at all.
	const fds = [
		new OpenFile(new File(ENCODER.encode(stdin))),
		stdout.fd,
		stderr.fd,
		new PreopenDirectory('/', root.contents)
	];

	// `debug: false` is not the default: the shim enables its logging when the
	// option is undefined, which would put "wasi:" lines in the output.
	const wasi = new WASI(args, env, fds, { debug: false });
	const module =
		moduleOrBytes instanceof WebAssembly.Module
			? moduleOrBytes
			: await WebAssembly.compile(moduleOrBytes);
	const instance = await WebAssembly.instantiate(module, {
		wasi_snapshot_preview1: wasi.wasiImport
	});

	const exitCode = wasi.start(instance);
	stdout.flush();
	stderr.flush();

	// A file written above is still over-allocated; make its length exact before
	// anything can read it (including the next stage, which runs in another call).
	trimWrittenFiles(root);

	return { exitCode, stdout: stdout.text, stderr: stderr.text, root };
}

/**
 * Link `object` and the sysroot libraries with lld, through a toolchain the
 * caller already holds.
 *
 * A caller that runs C/C++ on the same page has a Clang runtime from
 * `@live-codes/clang-wasm`, and its lld is the same program this package ships --
 * so it links through that instead of fetching a second copy. The three things
 * this needs from the toolchain are the ones that API documents: the compiled lld
 * module, a WASI command runner, and a way to read a file back out.
 */
async function linkWithToolchain(toolchain, { object, libs, onStdout, onStderr, gc }) {
	const runtime = toolchain.runtime;
	const lld = await runtime.getModule(runtime.assetUrls.lld);

	const files = [{ path: 'out.o.wasm', contents: object }];
	for (const [path, bytes] of Object.entries(libs)) files.push({ path, contents: bytes });

	// `args` is argv *without* the program name, and lld dispatches on argv[0].
	const args = linkerArgs(gc);
	const command = await toolchain.runCommand(lld, {
		programName: args[0],
		args: args.slice(1),
		files,
		stdin: () => null
	});

	// The toolchain's own host collects output; surface it the same way ours does.
	if (command.stdout) onStdout?.(stripAnsi(command.stdout), 'linking');
	if (command.stderr) onStderr?.(stripAnsi(command.stderr), 'linking');

	return {
		wasm: command.exitCode === 0 ? command.readFile('out.wasm') : undefined,
		exitCode: command.exitCode,
		diagnostics: stripAnsi(command.stderr || command.stdout || '')
	};
}

/**
 * Compile, link and run a Crystal program.
 *
 * @param {object} options
 * @param {string} options.source - the program
 * @param {Record<string, string|Uint8Array>} [options.files] - further sources,
 *   written beside it, so a program can `require "./helper"` them
 * @param {object} options.assets - what the loader produced: `compiler` and `lld`
 *   as `WebAssembly.Module`, `stdlib` as `{ path: text }`, `libs` as
 *   `{ path: Uint8Array }`
 * @param {object} [options.toolchain] - a clang-wasm toolchain to link through
 * @param {string[]} [options.args] - the program's argv, after its own name
 * @param {string[]} [options.compileArgs] - extra compiler flags
 * @param {string} [options.stdin]
 * @param {'none'|'boehm-experimental'} [options.gc]
 * @param {(stage: string) => void} [options.onStage] - `compiling` | `linking` | `instrumenting` | `running`
 * @param {(text: string, stage: string) => void} [options.onStdout]
 * @param {(text: string, stage: string) => void} [options.onStderr]
 * @returns {Promise<{ wasm: Uint8Array, stdout: string, stderr: string, exitCode: number, phases: object }>}
 *   Throws with `{ stage, diagnostics }` set if a stage fails.
 */
export async function compileAndRun({
	source,
	files = {},
	assets,
	toolchain = null,
	args = [],
	compileArgs = [],
	gc = GC_NONE,
	stdin = '',
	onStage,
	onStdout,
	onStderr
}) {
	validateGc(gc, compileArgs);
	if (gc === GC_BOEHM && (!assets.binaryen || !assets.libs['lib/libgc.a'])) throw new Error('GC assets have not been loaded');
	const { compiler, lld, stdlib, libs } = assets;
	const phases = {};

	const at = (stage) => {
		onStage?.(stage);
		return performance.now();
	};

	// 1. compile -----------------------------------------------------------
	let started = at('compiling');
	const compilerEntries = [['main.cr', source]];
	for (const [path, contents] of Object.entries(files)) compilerEntries.push([path, contents]);
	for (const [path, text] of Object.entries(stdlib)) compilerEntries.push([`src/${path}`, text]);

	const compiled = await runCommand(compiler, {
		args: compilerArgs([...compileArgs, ...(gc === GC_BOEHM ? ['-Dwasm_gc_experimental'] : [])]),
		env: ['CRYSTAL_PATH=/src'],
		entries: compilerEntries,
		onStdout,
		onStderr,
		stage: 'compiling'
	});
	phases.compiling = performance.now() - started;

	const object = compiled.root.contents.get('out.o.wasm')?.data;
	if (compiled.exitCode !== 0 || !object) {
		// The compiler's own diagnostics are the useful message; this is the
		// heading over them.
		const error = new Error('compilation failed');
		error.stage = 'compiling';
		error.diagnostics = stripAnsi(compiled.stderr || compiled.stdout);
		throw error;
	}

	// 2. link --------------------------------------------------------------
	started = at('linking');
	let wasm;
	if (toolchain) {
		const linked = await linkWithToolchain(toolchain, { object, libs, onStdout, onStderr, gc });
		wasm = linked.wasm ?? undefined;
		if (linked.exitCode !== 0 || !wasm) {
			const error = new Error('linking failed');
			error.stage = 'linking';
			error.diagnostics = linked.diagnostics;
			throw error;
		}
	} else {
		const linkerEntries = [['out.o.wasm', object]];
		for (const [path, bytes] of Object.entries(libs)) linkerEntries.push([path, bytes]);

		const linked = await runCommand(lld, {
			args: linkerArgs(gc),
			entries: linkerEntries,
			onStdout,
			onStderr,
			stage: 'linking'
		});
		wasm = linked.root.contents.get('out.wasm')?.data;
		if (linked.exitCode !== 0 || !wasm) {
			const error = new Error('linking failed');
			error.stage = 'linking';
			error.diagnostics = stripAnsi(linked.stderr || linked.stdout);
			throw error;
		}
	}
	phases.linking = performance.now() - started;
	if (gc === GC_BOEHM) {
		started = at('instrumenting');
		wasm = instrumentGc(assets.binaryen, wasm);
		phases.instrumenting = performance.now() - started;
	}

	// 3. run ---------------------------------------------------------------
	started = at('running');
	const program = await runCommand(await WebAssembly.compile(wasm), {
		args: [PROGRAM_NAME, ...args],
		entries: [],
		stdin,
		onStdout,
		onStderr,
		stage: 'running'
	});
	phases.running = performance.now() - started;

	return { wasm, stdout: program.stdout, stderr: program.stderr, exitCode: program.exitCode, phases };
}

export { DECODER };
