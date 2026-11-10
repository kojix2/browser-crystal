import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { createCompiler } from '../src/index.node.js';
import { loadAssets } from '../src/loader.js';
import { resolveAssetSource } from '../src/assets.js';
import { packagedAssets } from '../src/packaged.node.js';
import { compileAndRun } from '../src/engine.js';
import { instrumentGc, validateGc } from '../src/gc.js';
import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory } from '../vendor/browser_wasi_shim/index.js';

const inflate = async (bytes) => new Uint8Array(gunzipSync(bytes));

describe('experimental Boehm GC', () => {
	let compiler;
	before(async () => { compiler = await createCompiler({ gc: 'boehm-experimental' }); });
	after(async () => { await compiler?.dispose(); });
	for (const fixture of ['gc-stress', 'gc-exceptions']) test(fixture, async () => {
		const result = await compiler.run(await readFile(new URL(`fixtures/${fixture}.cr`, import.meta.url), 'utf8'));
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.match(result.stdout, /PASS\n$/);
	});
	test('rejects conflicting per-run flags before compiling', async () => {
		const result = await compiler.run('puts 1', '', { compileArgs: ['-Dgc_none'] });
		assert.equal(result.ok, false);
		assert.equal(result.exitCode, null);
		assert.match(result.errors.join('\n'), /gc_none/);
	});
	test('keeps argument-evaluation roots alive during collection', async () => {
		const result = await compiler.run(`
@[NoInline]
def payload(i)
  "payload #{i} " + ("x" * 4096)
end
@[NoInline]
def collecting_argument
  3.times { GC.collect }
  100.times { "y" * 8192 }
  42
end
@[NoInline]
def consume(a, b, c, number)
  raise "a lost" unless a.starts_with?("payload 1 ")
  raise "b lost" unless b.starts_with?("payload 2 ")
  raise "c lost" unless c.starts_with?("payload 3 ")
  raise "bad number" unless number == 42
end
100.times { consume(payload(1), payload(2), payload(3), collecting_argument) }
puts "argument roots PASS"
`);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.stdout, 'argument roots PASS\n');
	});
});

describe('GC configuration', () => {
	test('rejects invalid modes and unmanaged instrumentation flags', () => {
		assert.throws(() => validateGc('boehm'), /gc must/);
		assert.throws(() => validateGc('none', ['--define=wasm_gc_experimental']), /Use gc:/);
		for (const args of [['-D', 'gc_none'], ['--define', 'gc_none'], ['--define=preview_mt'], ['--target=x86_64-linux-gnu']]) {
			assert.throws(() => validateGc('boehm-experimental', args));
		}
	});
	test('invalid options fail before downloading assets', async () => {
		await assert.rejects(createCompiler({ gc: 'invalid', baseUrl: 'https://invalid.example/' }), /gc must/);
	});
	test('GC-off loading never fetches optional GC assets', async () => {
		const source = resolveAssetSource({}, packagedAssets);
		const reads = [];
		const original = source.readAsset;
		source.readAsset = (name) => { reads.push(name); return original(name); };
		const loaded = await loadAssets({ source, inflate });
		assert.ok(reads.every((name) => !name.startsWith('gc/')));
		assert.equal(loaded.assets.binaryen, null);
	});
});

describe('GC pipeline', () => {
	let assets;
	before(async () => {
		({ assets } = await loadAssets({ source: resolveAssetSource({}, packagedAssets), inflate, gc: 'boehm-experimental' }));
	});
	test('spills an earlier call operand before a later collecting operand, including try_table', async () => {
		const binaryen = assets.binaryen;
		// A host collector checks active stack words, so stale words below the
		// current stack cannot accidentally make a broken spill pass succeed.
		const m = binaryen.parseText(`(module
 (import "env" "make" (func $make (result i32)))
 (import "env" "collect" (func $collect (result i32)))
 (memory (export "memory") 1)
 (global $__stack_pointer (export "__stack_pointer") (mut i32) (i32.const 65536))
 (tag $e (param i32))
 (func $use (param $p i32) (param i32) (result i32) (local.get $p))
 (func (export "run") (result i32)
  (block $caught (result i32)
   (try_table (catch $e $caught)
    (return (call $use (call $make) (call $collect))))
   (i32.const 0))))`);
		m.setFeatures(binaryen.Features.MutableGlobals | binaryen.Features.ExceptionHandling | binaryen.Features.Multivalue | binaryen.Features.ReferenceTypes);
		m.runPasses(['emit-target-features']);
		const debug = binaryen.getDebugInfo();
		binaryen.setDebugInfo(true);
		const original = m.emitBinary();
		binaryen.setDebugInfo(debug);
		m.dispose();
		let instance;
		let seen = false;
		({ instance } = await WebAssembly.instantiate(instrumentGc(binaryen, original), { env: {
			make: () => 0x12345678,
			collect: () => {
				const words = new Uint32Array(instance.exports.memory.buffer);
				seen = words.subarray(instance.exports.__stack_pointer.value / 4).includes(0x12345678);
				return 0;
			}
		} }));
		assert.equal(instance.exports.run(), 0x12345678);
		assert.equal(seen, true);
		assert.equal(instance.exports.__stack_pointer.value, 65536);
	});
	test('instruments after linking through an external toolchain', async () => {
		const stages = [];
		let linked = false;
		const toolchain = {
			runtime: { assetUrls: { lld: 'test:lld' }, getModule: async () => assets.lld },
			async runCommand(module, { files, programName, args }) {
				assert.ok(args.includes('-lgc'));
				assert.ok(args.includes('--fatal-warnings'));
				linked = true;
				const root = new Directory(new Map());
				for (const { path, contents } of files) {
					const parts = path.split('/');
					let dir = root;
					for (const part of parts.slice(0, -1)) {
						if (!dir.contents.has(part)) dir.contents.set(part, new Directory(new Map()));
						dir = dir.contents.get(part);
					}
					dir.contents.set(parts.at(-1), new File(contents));
				}
				let stdout = '', stderr = '';
				const wasi = new WASI([programName, ...args], [], [new OpenFile(new File(new Uint8Array())), new ConsoleStdout((s) => { stdout += s; }), new ConsoleStdout((s) => { stderr += s; }), new PreopenDirectory('/', root.contents)], { debug: false });
				const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
				const exitCode = wasi.start(instance);
				return { exitCode, stdout, stderr, readFile: (path) => {
					const file = root.contents.get(path);
					return file?.data.slice(0, Number(file.size));
				} };
			}
		};
		const result = await compileAndRun({ source: 'GC.collect\nputs GC.prof_stats.gc_no > 0', gc: 'boehm-experimental', assets, toolchain, onStage: (stage) => stages.push(stage) });
		assert.equal(linked, true);
		assert.equal(result.stdout, 'true\n');
		assert.deepEqual(stages, ['compiling', 'linking', 'instrumenting', 'running']);
	});
	test('a failed transformation never reaches execution', async () => {
		const stages = [];
		const broken = { ...assets, binaryen: { readBinary() { throw new Error('injected failure'); } } };
		await assert.rejects(compileAndRun({ source: 'puts "must not run"', gc: 'boehm-experimental', assets: broken, onStage: (stage) => stages.push(stage) }), /injected failure/);
		assert.ok(!stages.includes('running'));
	});
});
