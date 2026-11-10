import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { after, before, describe, test } from 'node:test';
import { createCompiler } from '../src/index.node.js';

const html = await readFile(new URL('../../../public/index.html', import.meta.url), 'utf8');
const literal = html.match(/const SAMPLES = (\[[\s\S]*?\n\]);/)?.[1];
if (!literal) throw new Error('Cannot find the demo samples');
const samples = runInNewContext(literal);

describe('all demo samples with and without GC', () => {
	let plain, gc;
	before(async () => {
		plain = await createCompiler();
		gc = await createCompiler({ gc: 'boehm-experimental' });
	});
	after(async () => { await plain?.dispose(); await gc?.dispose(); });
	for (const sample of samples) test(sample.title, async () => {
		const input = '5\n10\n20\n30\n40\n50\n';
		const expected = await plain.run(sample.source, input);
		const result = await gc.run(sample.source, input);
		assert.equal(expected.ok, true, JSON.stringify(expected));
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.stdout, expected.stdout);
		assert.equal(result.stderr, expected.stderr);
	});
});
