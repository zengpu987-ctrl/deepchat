/**
 * Load the chat-mode browser bundle outside a browser.
 *
 * The bundle is a plain script that calls `window.__ModuleLoader__.load(...)`
 * with a factory; this helper provides the globals that factory touches
 * (window, document, navigator), a stub React whose component functions can be
 * invoked directly, and a `require` that answers only `react`. It returns the
 * module the factory produced plus the render helper, so a check script
 * exercises the shipped file rather than a copy of it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** The chat-mode package directory, the default target of {@link loadClient}. */
export const pkgDir = join(here, '..', 'chat-mode');

/**
 * Install the browser-shaped globals the bundle needs.
 * @returns the collected document/style state.
 */
function installGlobals() {
	const styleTags = [];
	globalThis.document = {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
		head: { appendChild: (tag) => styleTags.push(tag) },
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	if (globalThis.navigator?.clipboard === undefined) {
		Object.defineProperty(globalThis, 'navigator', {
			value: { clipboard: { writeText: async () => {} } },
			configurable: true,
			writable: true,
		});
	}
	let entry;
	globalThis.window = {
		/* Timers stay real but never hold the process open, so a bundle's poller
		   cannot turn an offline check into a hang. */
		setTimeout: (callback, delay) => {
			const handle = globalThis.setTimeout(callback, delay);
			handle.unref?.();
			return handle;
		},
		clearTimeout: (handle) => globalThis.clearTimeout(handle),
		setInterval: (callback, delay) => {
			const handle = globalThis.setInterval(callback, delay);
			handle.unref?.();
			return handle;
		},
		clearInterval: (handle) => globalThis.clearInterval(handle),
		__ModuleLoader__: {
			load(candidate) {
				entry = candidate;
			},
		},
	};
	return { styleTags, entry: () => entry };
}

/** A minimal React whose component functions can be invoked directly. */
export function createReactStub() {
	let cursor = { index: 0, slots: [] };
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
		Fragment: Symbol('Fragment'),
		memo: (fn) => fn,
		useState: (initial) => {
			const index = cursor.index++;
			if (!(index in cursor.slots)) cursor.slots[index] = typeof initial === 'function' ? initial() : initial;
			return [cursor.slots[index], () => {}];
		},
		useRef: (initial) => {
			const index = cursor.index++;
			if (!(index in cursor.slots)) cursor.slots[index] = { current: initial };
			return cursor.slots[index];
		},
		useEffect: () => {},
	};
	return { React, reset: () => { cursor = { index: 0, slots: [] }; } };
}

/**
 * Load one plugin's browser bundle outside a browser.
 * @param directory - package directory name under the workspace, defaulting to `chat-mode`.
 * @returns the module the factory returned, plus rendering support.
 */
export function loadClient(directory = 'chat-mode') {
	const target = join(here, '..', directory);
	const globals = installGlobals();
	const reactStub = createReactStub();
	const source = readFileSync(join(target, 'client.js'), 'utf8');
	// eslint-disable-next-line no-eval
	eval(source);
	const entry = globals.entry();
	if (entry === undefined) throw new Error('client.js did not register a module');
	const module = entry.factory((specifier) => {
		if (specifier === 'react') return reactStub.React;
		throw new Error(`unexpected require: ${specifier}`);
	});

	/**
	 * Collect the text one rendered tree produces.
	 * @param component - a component function from the bundle.
	 * @param props - props to render with.
	 * @returns the concatenated text nodes.
	 */
	function renderToText(component, props) {
		const out = [];
		const walk = (node) => {
			if (node === null || node === undefined || node === false || node === true) return;
			if (Array.isArray(node)) {
				for (const child of node) walk(child);
				return;
			}
			if (typeof node === 'string' || typeof node === 'number') {
				out.push(String(node));
				return;
			}
			if (typeof node.type === 'function') {
				reactStub.reset();
				walk(node.type(node.props));
				return;
			}
			if (typeof node.type === 'symbol') {
				for (const child of node.children ?? []) walk(child);
				return;
			}
			for (const child of node.children ?? []) walk(child);
		};
		reactStub.reset();
		walk(component(props));
		return out.join('\n');
	}

	return { module, reactStub, renderToText, styleTags: globals.styleTags };
}

/**
 * A fake `localStorage` with a configurable quota, so persistence checks can
 * exercise trimming and quota failures.
 * @param limit - maximum total characters accepted.
 * @returns the storage object plus its backing map.
 */
export function createMemoryStorage(limit = Number.MAX_SAFE_INTEGER) {
	const map = new Map();
	const used = () => [...map.entries()].reduce((total, [key, value]) => total + key.length + value.length, 0);
	return {
		map,
		storage: {
			getItem: (key) => (map.has(key) ? map.get(key) : null),
			setItem: (key, value) => {
				const next = { ...Object.fromEntries(map), [key]: String(value) };
				const size = Object.entries(next).reduce((total, [k, v]) => total + k.length + v.length, 0);
				if (size > limit) {
					const error = new Error('QuotaExceededError');
					error.name = 'QuotaExceededError';
					throw error;
				}
				map.set(key, String(value));
			},
			removeItem: (key) => {
				map.delete(key);
			},
			get size() {
				return used();
			},
		},
	};
}
