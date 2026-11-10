// Binaryen 132's Flatten pass rejects try_table. Materialize expression values
// without changing block results or exception destinations. In particular, a
// value evaluated before a collecting call must be read from a local AFTER the
// call, so SpillPointers' liveness analysis can see it.
//
// This consumes Binaryen's own folded text, including its tuple pseudo-types;
// it is not a parser for arbitrary user-supplied WAT. Unsupported instructions
// fail the build rather than emitting a module with incomplete root coverage.
const DECLARATIONS = new Set(['param', 'result', 'local', 'type', 'catch', 'catch_ref', 'catch_all', 'catch_all_ref']);

function parse(text) {
	const tokens = text.match(/;;[^\n]*|\(;[\s\S]*?;\)|\(|\)|\$?"(?:[^"\\]|\\[\s\S])*"|[^\s()]+/g);
	const stack = [];
	let root;
	for (const token of tokens) {
		if (token.startsWith(';;') || token.startsWith('(;')) continue;
		if (token === '(') {
			const node = [];
			if (stack.length) stack.at(-1).push(node);
			else if (root) throw new Error('Multiple Binaryen text modules');
			else root = node;
			stack.push(node);
		} else if (token === ')') {
			if (!stack.pop()) throw new Error('Unbalanced Binaryen text');
		} else {
			if (!stack.length) throw new Error('Invalid Binaryen text');
			stack.at(-1).push(token);
		}
	}
	if (stack.length || root?.[0] !== 'module') throw new Error('Invalid Binaryen module');
	return root;
}

function print(node) {
	const output = [];
	const stack = [node];
	while (stack.length) {
		const current = stack.pop();
		if (!Array.isArray(current)) { output.push(current); continue; }
		output.push('(');
		stack.push(')');
		for (let i = current.length - 1; i >= 0; i--) {
			stack.push(current[i]);
			if (i > 0) stack.push(' ');
		}
	}
	return output.join('');
}
const children = (node) => node.filter(Array.isArray);
const resultType = (node) => {
	const result = children(node).find((child) => child[0] === 'result');
	if (!result || result.length === 1) return null;
	return result.length === 2 ? result[1] : ['tuple', ...result.slice(1)];
};

export function flattenWithExceptions(text) {
	const tree = parse(text);
	const functions = new Map();
	const globals = new Map();
	const types = new Map();
	const declarations = children(tree);
	for (const node of declarations) {
		if (node[0] === 'type') types.set(node[1], resultType(node[2]));
		const decl = node[0] === 'import' ? node.at(-1) : node;
		if (decl[0] === 'func') functions.set(decl[1], resultType(decl));
		if (decl[0] === 'global') globals.set(decl[1], Array.isArray(decl[2]) ? decl[2][1] : decl[2]);
	}
	const exceptionFunctions = [];
	for (const fn of declarations.filter((node) => node[0] === 'func')) {
		let hasExceptions = false;
		const search = [fn];
		while (search.length && !hasExceptions) {
			const current = search.pop();
			hasExceptions = current[0] === 'try_table';
			for (const part of current) if (Array.isArray(part)) search.push(part);
		}
		exceptionFunctions.push(hasExceptions);
		if (!hasExceptions) {
			// This function stays in the original binary module and uses the
			// native Flatten pass. Only a stub is needed for symbol resolution
			// when parsing the exception-bearing functions below.
			const signature = fn.filter((part) => !Array.isArray(part) || DECLARATIONS.has(part[0]));
			fn.splice(0, fn.length, ...signature, ['unreachable']);
			continue;
		}
		const locals = new Map();
		let index = 0;
		for (const decl of children(fn).filter((node) => node[0] === 'param' || node[0] === 'local')) {
			if (typeof decl[1] === 'string' && decl[1].startsWith('$')) {
				locals.set(decl[1], decl[2]);
				locals.set(String(index++), decl[2]);
			} else for (const type of decl.slice(1)) locals.set(String(index++), type);
		}
		const added = [];
		const rewrittenNodes = new Map();
		const rewrite = (node) => {
			const rewritten = rewrittenNodes.get(node);
			if (!rewritten) throw new Error('Incomplete GC expression traversal');
			return rewritten;
		};
		let counter = 0;
		const temporary = (type) => {
			let name;
			do name = `$__crystal_gc_${counter++}`; while (locals.has(name));
			locals.set(name, type);
			added.push(['local', name, type]);
			return name;
		};
		const inline = ({ node, pre }) => pre.length ? ['block', ...(typeOf(node) ? [['result', ...expand(typeOf(node))]] : []), ...pre, node] : node;
		const expand = (type) => Array.isArray(type) && type[0] === 'tuple' ? type.slice(1) : [type];
		function typeOf(node) {
			const op = node[0];
			const lookup = (map, name) => {
				if (!map.has(name)) throw new Error(`Unknown GC flatten binding ${name}`);
				return map.get(name);
			};
			if (op === 'local.get' || op === 'local.tee') return lookup(locals, node[1]);
			if (op === 'global.get') return lookup(globals, node[1]);
			if (op === 'call') return lookup(functions, node[1]);
			if (op === 'call_indirect') return lookup(types, children(node).find((child) => child[0] === 'type')?.[1]);
			if (['block', 'loop', 'if', 'try', 'try_table'].includes(op)) return resultType(node);
			if (op === 'select') return typeOf(children(node)[0]);
			if (op === 'br_if') return children(node).length > 1 ? typeOf(children(node)[0]) : null;
			if (op === 'tuple.make') return ['tuple', ...children(node).map(typeOf)];
			if (op === 'tuple.extract') return expand(typeOf(children(node).at(-1)))[Number(node[2])];
			if (/^(i32|i64|f32|f64)\./.test(op)) {
				if (op.includes('.store')) return null;
				if (/\.(eqz|eq|ne|lt_[su]|gt_[su]|le_[su]|ge_[su]|lt|gt|le|ge)$/.test(op)) return 'i32';
				return op.slice(0, 3);
			}
			if (op === 'memory.size' || op === 'memory.grow' || op === 'ref.is_null' || op === 'ref.eq') return 'i32';
			if (op === 'ref.null') return node[1] === 'func' ? 'funcref' : node[1] === 'extern' ? 'externref' : 'exnref';
			if (['local.set', 'global.set', 'drop', 'return', 'br', 'br_table', 'unreachable', 'nop', 'memory.copy', 'memory.fill', 'memory.init', 'data.drop', 'throw', 'throw_ref', 'rethrow'].includes(op)) return null;
			throw new Error(`GC flatten does not support ${op}`);
		}
		function materialize(original) {
			let node = [...original];
			let pre = [];
			const op = node[0];
			if (DECLARATIONS.has(op)) return { node, pre };
			if (op === 'block') {
				// Splice preludes into the existing block. Wrapping every child in
				// another block doubles LLVM's already-deep nesting and overflows
				// Binaryen's text parser on a classic worker's native call stack.
				node = [];
				for (const part of original) {
					if (!Array.isArray(part) || DECLARATIONS.has(part[0])) node.push(part);
					else {
						const rewritten = rewrite(part);
						for (const statement of rewritten.pre) node.push(statement);
						node.push(rewritten.node);
					}
				}
			} else if (op === 'loop' || op === 'try_table' || op === 'try') {
				// Values reaching a catch destination remain block results. Never
				// move code across a try boundary or change a catch destination.
				node = node.map((part) => Array.isArray(part) && !DECLARATIONS.has(part[0]) ? inline(rewrite(part)) : part);
			} else if (op === 'if') {
				let condition = false;
				node = node.map((part) => {
					if (!Array.isArray(part) || DECLARATIONS.has(part[0])) return part;
					if (part[0] === 'then' || part[0] === 'else') return [part[0], ...part.slice(1).map((child) => inline(rewrite(child)))];
					if (condition) throw new Error('Unexpected Binaryen if');
					condition = true;
					const rewritten = rewrite(part);
					for (const statement of rewritten.pre) pre.push(statement);
					return rewritten.node;
				});
			} else {
				node = node.map((part) => {
					if (!Array.isArray(part) || DECLARATIONS.has(part[0])) return part;
					const rewritten = rewrite(part);
					for (const statement of rewritten.pre) pre.push(statement);
					return rewritten.node;
				});
			}
			const type = typeOf(node);
			if (type) {
				const name = temporary(type);
				pre.push(['local.set', name, node]);
				node = ['local.get', name];
			}
			return { node, pre };
		}
		const body = [];
		for (const node of fn) {
			if (!Array.isArray(node) || DECLARATIONS.has(node[0])) body.push(node);
			else {
				// LLVM emits deeply nested block trees. Traverse iteratively so
				// classic workers with a smaller JS stack work like window/Node.
				const work = [[node, false]];
				while (work.length) {
					const [current, visited] = work.pop();
					if (DECLARATIONS.has(current[0])) continue;
					if (visited) {
						if (current[0] !== 'then' && current[0] !== 'else') rewrittenNodes.set(current, materialize(current));
					} else {
						work.push([current, true]);
						for (let i = current.length - 1; i >= 0; i--) if (Array.isArray(current[i])) work.push([current[i], false]);
					}
				}
				body.push(inline(rewrite(node)));
			}
		}
		const firstInstruction = body.findIndex((node) => Array.isArray(node) && !DECLARATIONS.has(node[0]));
		body.splice(firstInstruction < 0 ? body.length : firstInstruction, 0, ...added);
		fn.splice(0, fn.length, ...body);
	}
	return { text: print(tree), exceptionFunctions };
}
