import { flattenWithExceptions } from './gc-flatten.js';

export const GC_NONE = 'none';
export const GC_BOEHM = 'boehm-experimental';

export function validateGc(gc, compileArgs = []) {
	if (gc !== GC_NONE && gc !== GC_BOEHM) throw new Error('gc must be "none" or "boehm-experimental"');
	if (!Array.isArray(compileArgs) || compileArgs.some((arg) => typeof arg !== 'string')) throw new Error('compileArgs must be an array of strings');
	const defines = [];
	for (let i = 0; i < compileArgs.length; i++) {
		const arg = compileArgs[i];
		if (arg === '-D' || arg === '--define') defines.push(compileArgs[++i]);
		else if (arg.startsWith('-D')) defines.push(arg.slice(2));
		else if (arg.startsWith('--define=')) defines.push(arg.slice(9));
		if (gc === GC_BOEHM && (arg === '--target' || arg.startsWith('--target='))) {
			const target = arg === '--target' ? compileArgs[++i] : arg.slice(9);
			if (!/^wasm32-(unknown-)?(wasi|wasip1)$/.test(target ?? '')) throw new Error('Boehm GC requires a wasm32-wasi target');
		}
	}
	if (gc === GC_NONE && defines.includes('wasm_gc_experimental')) throw new Error('Use gc: "boehm-experimental" to enable the GC link and instrumentation stages');
	if (gc === GC_BOEHM && defines.some((flag) => ['gc_none', 'preview_mt', 'execution_context'].includes(flag))) throw new Error('Boehm GC requires single-threaded compilation without gc_none');
}

/** Load only checksum-verified code, with no eval or runtime npm resolution. */
export async function loadBinaryen(bytes, runtimeUrl) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	const { default: initialize } = await import(`data:text/javascript;base64,${btoa(binary)}`);
	return initialize(runtimeUrl);
}

/** Whole-linked-module instrumentation covers library callbacks as well. */
export function instrumentGc(binaryen, wasm) {
	let module;
	let exceptionModule;
	let step = 'reading the linked module';
	try {
		module = binaryen.readBinary(wasm);
		const features = module.getFeatures();
		step = 'reading the expression tree';
		const text = module.emitText();
		if (text.includes('(try_table')) {
			step = 'flattening exception code';
			const flattened = flattenWithExceptions(text);
			step = 'parsing flattened exception code';
			exceptionModule = binaryen.parseText(flattened.text);
			exceptionModule.setFeatures(features);
			let definition = 0;
			for (let i = 0; i < module.getNumFunctions(); i++) {
				const fn = module.getFunctionByIndex(i);
				const original = binaryen.getFunctionInfo(fn);
				if (!original.body) continue; // imported function
				if (!flattened.exceptionFunctions[definition++]) {
					module.runPassesOnFunction(fn, ['flatten']);
					continue;
				}
				const replacement = binaryen.getFunctionInfo(exceptionModule.getFunction(original.name));
				for (const type of replacement.vars.slice(original.vars.length)) binaryen._BinaryenFunctionAddVar(fn, type);
				binaryen.Function.setBody(fn, module.copyExpression(replacement.body));
			}
			if (definition !== flattened.exceptionFunctions.length) throw new Error('GC function definitions changed during flattening');
			exceptionModule.dispose();
			exceptionModule = null;
		} else module.runPasses(['flatten']);
		step = 'spilling live pointers';
		module.runPasses(['spill-pointers']);
		step = 'validating the instrumented module';
		if (!module.validate()) throw new Error('Binaryen rejected GC instrumentation');
		const transformed = module.emitBinary();
		if (!WebAssembly.validate(transformed)) throw new Error('The host rejected the GC-instrumented module');
		return transformed;
	} catch (cause) {
		const error = new Error(`GC instrumentation failed while ${step}: ${cause?.message ?? 'Binaryen could not transform this module'}`, { cause });
		error.stage = 'instrumenting';
		throw error;
	} finally {
		exceptionModule?.dispose();
		module?.dispose();
	}
}
