#!/usr/bin/env node
// Serve the repository (npm start) and launch a Chromium browser with an isolated
// profile and --remote-debugging-port=9223, then run npm run test:browser here.
// Uses Node's WebSocket API; no browser automation dependency is required.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const baseUrl = process.env.GC_TEST_BASE_URL ?? 'http://127.0.0.1:8127/';
const cdpUrl = process.env.GC_TEST_CDP_URL ?? 'http://127.0.0.1:9223/';
const html = await readFile(new URL('../../../public/index.html', import.meta.url), 'utf8');
const samples = runInNewContext(html.match(/const SAMPLES = (\[[\s\S]*?\n\]);/)[1]);
const fixtures = await Promise.all(['gc-stress', 'gc-exceptions'].map(async (name) => ({ name, source: await readFile(new URL(`../test/fixtures/${name}.cr`, import.meta.url), 'utf8') })));
const targets = await (await fetch(new URL('json/list', cdpUrl))).json();
const target = targets.find((entry) => entry.type === 'page');
assert.ok(target, 'Open a page in the dedicated test browser');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
const pending = new Map();
const events = new Map();
socket.addEventListener('message', ({ data }) => {
	const message = JSON.parse(data);
	if (message.id) {
		const callback = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) callback?.reject(new Error(JSON.stringify(message.error)));
		else callback?.resolve(message.result);
	} else {
		events.get(message.method)?.(message.params);
		if (message.method === 'Runtime.consoleAPICalled' && message.params.args[0]?.value?.startsWith?.('GC browser:')) console.log(message.params.args[0].value);
	}
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++sequence;
	pending.set(id, { resolve, reject });
	socket.send(JSON.stringify({ id, method, params }));
});
try {
	await send('Page.enable');
	await send('Runtime.enable');
	const loaded = new Promise((resolve) => events.set('Page.loadEventFired', resolve));
	await send('Page.navigate', { url: baseUrl });
	await loaded;
	const result = await send('Runtime.evaluate', {
		awaitPromise: true,
		returnByValue: true,
		timeout: 300000,
		expression: `(async () => {
 const base = ${JSON.stringify(baseUrl)};
 const root = new URL('packages/crystal-wasm/', base);
 const {createCompiler} = await import(new URL('src/index.js', root));
 const baseUrl = new URL('assets/crystal/', root).href;
 const samples = ${JSON.stringify(samples)};
 const fixtures = ${JSON.stringify(fixtures)};
 const loadStart = performance.now();
 const plain = await createCompiler({baseUrl});
 const plainLoaded = performance.now();
 const gc = await createCompiler({baseUrl, gc:'boehm-experimental'});
 const gcLoaded = performance.now();
 const rows = [];
 for (const sample of ${process.env.GC_TEST_IIFE_ONLY ? '[]' : 'samples'}) {
   const expected = await plain.run(sample.source, '5\\n10\\n20\\n30\\n40\\n50\\n');
   const actual = await gc.run(sample.source, '5\\n10\\n20\\n30\\n40\\n50\\n');
   if (!expected.ok || !actual.ok || expected.output !== actual.output) throw Error(sample.title+': '+JSON.stringify({expected,actual}));
   rows.push({sample:sample.title, plainMs:expected.compileMs, gcMs:actual.compileMs, gcRunMs:actual.runMs});
   console.log('GC browser: '+sample.title+' PASS');
 }
 for (const fixture of ${process.env.GC_TEST_IIFE_ONLY ? '[]' : 'fixtures'}) {
   const actual = await gc.run(fixture.source);
   if (!actual.ok || !actual.stdout.endsWith('PASS\\n')) throw Error(fixture.name+': '+JSON.stringify(actual));
   console.log('GC browser: '+fixture.name+' PASS');
 }
 await plain.dispose(); await gc.dispose();
 const classic = await new Promise((resolve,reject) => {
   const code = 'importScripts('+JSON.stringify(new URL('dist/crystal-wasm.global.js', root).href)+');'+
     '(async()=>{const c=await crystalWasm.createCompiler('+JSON.stringify({baseUrl,gc:'boehm-experimental'})+');'+
     'const r=await c.run('+JSON.stringify(fixtures[1].source)+');await c.dispose();postMessage(r)})().catch(e=>postMessage({error:String(e)}));';
   const url = URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
   const worker = new Worker(url);
   const timer = setTimeout(()=>{worker.terminate();URL.revokeObjectURL(url);reject(Error('IIFE worker timeout'))},120000);
   worker.onmessage = ({data})=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve(data)};
   worker.onerror = (e)=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);reject(Error(e.message))};
 });
 if (!classic.ok) throw Error('IIFE worker: '+JSON.stringify(classic));
 console.log('GC browser: classic IIFE worker PASS');
 return {crossOriginIsolated, userAgent:navigator.userAgent, plainLoadMs:Math.round(plainLoaded-loadStart),gcLoadMs:Math.round(gcLoaded-plainLoaded),rows,classic};
})()`
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	assert.equal(result.result.value.crossOriginIsolated, false);
	console.log(JSON.stringify(result.result.value, null, 2));
} finally {
	socket.close();
}
