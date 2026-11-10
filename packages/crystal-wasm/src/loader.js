// loader.js — turn an asset source into what the engine needs.
//
// Every asset travels gzipped (the payload is 22 MB instead of 68 MB) and is
// inflated here. Which inflater is used is the caller's business -- the page has
// `DecompressionStream` and Node has `zlib` -- so it is handed in.
import { ASSET_RECEIPTS } from './asset-receipts.js';
import { GC_BOEHM, GC_NONE, loadBinaryen } from './gc.js';

const DECODER = new TextDecoder();

/** The assets the engine names directly; everything else is a library to link. */
const COMPILER = 'compiler.wasm.gz';
const LLD = 'lld.wasm.gz';
const STDLIB = 'stdlib.json.gz';

/**
 * Load, verify and prepare the compiler, the linker, the standard library and the
 * sysroot libraries.
 *
 * @param {object} options
 * @param {object} options.source - an asset source from `resolveAssetSource`
 * @param {(bytes: Uint8Array) => Promise<Uint8Array>} options.inflate
 * @param {(text: string) => void} [options.onStatus]
 * @param {(fraction: number) => void} [options.onProgress] - 0 to 1, by bytes
 * @param {boolean} [options.needLld] - false when a toolchain will do the linking,
 *   which is 7.8 MB of payload the caller does not have to fetch
 * @param {'none'|'boehm-experimental'} [options.gc] - optional program GC assets
 */
export async function loadAssets({ source, inflate, onStatus, onProgress, needLld = true, gc = GC_NONE }) {
	const names = Object.keys(ASSET_RECEIPTS);
	const libraries = names.filter((name) => name.startsWith('lib/'));
	const gcNames = gc === GC_BOEHM ? ['gc/libgc.a.gz', 'gc/binaryen.mjs.gz'] : [];
	for (const name of gcNames) if (!ASSET_RECEIPTS[name]) throw new Error(`Missing GC asset ${name}; rebuild the GC assets first`);
	const wanted = [COMPILER, ...(needLld ? [LLD] : []), STDLIB, ...libraries, ...gcNames];
	const total = wanted.reduce((sum, name) => sum + (ASSET_RECEIPTS[name]?.bytes ?? 0), 0);

	let loaded = 0;
	const read = async (name) => {
		const gzipped = await source.readAsset(name);
		loaded += gzipped.byteLength;
		onProgress?.(total ? Math.min(1, loaded / total) : 0);
		return inflate(gzipped);
	};

	onStatus?.(`the compiler (${megabytes(ASSET_RECEIPTS[COMPILER]?.bytes)})`);
	const compiler = await WebAssembly.compile(await read(COMPILER));

	let lld = null;
	if (needLld) {
		onStatus?.(`the linker (${megabytes(ASSET_RECEIPTS[LLD]?.bytes)})`);
		lld = await WebAssembly.compile(await read(LLD));
	}

	onStatus?.('the standard library');
	const stdlib = JSON.parse(DECODER.decode(await read(STDLIB)));

	onStatus?.('the sysroot');
	// The libraries are keyed the way the linker asks for them -- `lib/libc.a`, not
	// `lib/libc.a.gz` -- because those keys become paths in the linker's filesystem.
	const libs = {};
	for (const name of libraries) libs[name.replace(/\.gz$/, '')] = await read(name);
	let binaryen = null;
	if (gc === GC_BOEHM) {
		onStatus?.('the experimental garbage collector');
		libs['lib/libgc.a'] = await read('gc/libgc.a.gz');
		onStatus?.('GC instrumentation (Binaryen)');
		binaryen = await loadBinaryen(await read('gc/binaryen.mjs.gz'), source.runtimeUrl);
	}

	return {
		assets: { compiler, lld, stdlib, libs, binaryen },
		/** How many files came from each part of the payload, for a caller's report. */
		counts: { stdlib: Object.keys(stdlib).length, libs: Object.keys(libs).length }
	};
}

const megabytes = (bytes) => (bytes ? `${(bytes / 1e6).toFixed(1)} MB` : 'size unknown');
