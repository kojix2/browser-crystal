// Where the assets come from, and how they are read.
//
// Two sources behind one shape, because everything downstream only needs "where
// are the files" and "give me this one":
//
//   hosted   - a base URL: the assets are fetched from wherever the page is
//              served from, which is the only thing a browser can do with files
//              that live inside an npm package.
//   packaged - the assets that ship inside this package, on disk. Only reachable
//              through the `node` condition, because a browser cannot read a file
//              inside an npm package.
//
// Every read is checked against the pinned receipts, so a stale asset, a truncated
// download or a host serving something else is named rather than compiled.
import { ASSET_RECEIPTS } from './asset-receipts.js';

/** sha256 of some bytes, as hex, using whatever the platform provides. */
export async function sha256Hex(bytes) {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error(
			'Verifying the compiler assets needs crypto.subtle: a secure context in the browser, or ' +
				'Node 20 and later.'
		);
	}
	const digest = await subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Check bytes against the pinned receipt for that asset — its length first, so a
 * truncated file is named without hashing it.
 *
 * @param {string} name - the asset's name in `ASSET_RECEIPTS`
 * @param {Uint8Array} bytes
 */
export async function verifyReceipt(name, bytes) {
	const receipt = ASSET_RECEIPTS[name];
	if (!receipt) throw new Error(`No pinned receipt for the compiler asset ${name}`);
	if (bytes.byteLength !== receipt.bytes) {
		throw new Error(
			`The compiler asset ${name} is ${bytes.byteLength} bytes, expected ${receipt.bytes}`
		);
	}
	const digest = await sha256Hex(bytes);
	if (digest !== receipt.sha256) {
		throw new Error(
			`The compiler asset ${name} failed SHA-256 verification: expected ${receipt.sha256}, got ${digest}`
		);
	}
	return bytes;
}

/**
 * Resolve how to reach the assets.
 *
 * @param {object} options - the caller's options; `baseUrl` is what decides
 * @param {object|null} packaged - the on-disk source, or null where there is no filesystem
 */
export function resolveAssetSource(options, packaged) {
	if (options.baseUrl != null && options.baseUrl !== '') return createHostedSource(options);
	if (!packaged) {
		throw new Error(
			'baseUrl is required here. The assets that ship in this package can only be read where ' +
				'there is a filesystem, and a browser cannot reach a file inside an npm package - copy ' +
				'them somewhere your page can fetch with `npx --package @live-codes/crystal-wasm ' +
				'crystal-wasm-copy-assets <dir>` and pass that directory as baseUrl.'
		);
	}
	return createPackagedSource(packaged);
}

const resolveBaseUrl = (value) => {
	let resolved;
	try {
		resolved = new URL(String(value), typeof location === 'undefined' ? undefined : location.href);
	} catch (error) {
		throw new Error(
			`baseUrl must be an absolute http(s) URL, or relative to the page in a browser: ${error.message}`,
			{ cause: error }
		);
	}
	if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
		throw new Error('baseUrl must use HTTP(S).');
	}
	if (!resolved.pathname.endsWith('/')) resolved.pathname += '/';
	return resolved;
};

function createHostedSource(options) {
	const baseUrl = resolveBaseUrl(options.baseUrl);
	return {
		kind: 'hosted',
		key: baseUrl.href,
		description: baseUrl.href,
		baseUrl: baseUrl.href,
		runtimeUrl: new URL('gc/binaryen.mjs', baseUrl).href,
		async readAsset(name) {
			const url = new URL(name, baseUrl);
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Failed to load the compiler asset ${url}: ${response.status}. ` +
						'Build them with `packages/crystal-wasm/build-assets.sh` and serve that directory.'
				);
			}
			return verifyReceipt(name, new Uint8Array(await response.arrayBuffer()));
		}
	};
}

function createPackagedSource(packaged) {
	return {
		kind: 'packaged',
		key: `packaged\u0000${packaged.root.href}`,
		description: `the assets packaged with this library (${packaged.root.href})`,
		baseUrl: null,
		runtimeUrl: new URL('gc/binaryen.mjs', packaged.root).href,
		readAsset: async (name) => verifyReceipt(name, await packaged.readFile(name))
	};
}

export { ASSET_RECEIPTS };
