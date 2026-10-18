/**
 * Offline integration check for the chat-mode bundle, run before each install.
 *
 * It loads the real Host half with a fake `ctx.llm`, captures the registered
 * `/api/chat-mode/stream` route, then runs the real browser half against a stub
 * React, a memory `localStorage`, and a `fetch` that points at that route.
 * Passing proves the two halves agree on the wire shape, that PDF and notebook
 * extraction produce usable text, and that conversation history survives a
 * reload — all against the shipped files rather than a copy.
 *
 * Usage: node tools/chat-mode-check.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { loadClient, createMemoryStorage, pkgDir } from './chat-mode-load.mjs';

const failures = [];
/** Record one expectation. */
function check(condition, label, detail) {
	if (condition) {
		console.log(`  ok  ${label}`);
		return;
	}
	failures.push(label);
	console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

//#region host half
const hostChunks = [
	{ type: 'reasoning-delta', index: 0, text: 'Thinking about it. ' },
	{ type: 'text-delta', index: 1, text: 'Hello ' },
	{ type: 'text-delta', index: 1, text: '**world**' },
	{ type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } },
	{ type: 'finish', reason: { kind: 'stop' } },
];
let recordedCall = null;
const savedImages = [];
const hostRoutes = [];
const fakeAttachments = {
	async saveImages(inputs) {
		savedImages.push(...inputs);
		return inputs.map((input, index) => ({
			attachmentId: `sha256:${index}`,
			mediaType: input.mediaType,
			bytes: input.data.byteLength,
			width: 2,
			height: 2,
		}));
	},
};
const hostCtx = {
	llm: {
		async *stream(options) {
			recordedCall = options;
			for (const chunk of hostChunks) yield chunk;
		},
	},
	get: (name) => (name === 'attachments' ? fakeAttachments : undefined),
	effect: (fn) => fn(),
	inject: (_deps, callback) => callback(hostCtx),
	connection: {
		fetch: {
			register(route) {
				hostRoutes.push(route);
				return () => {};
			},
		},
	},
};
const hostModule = await import(join(pkgDir, 'index.js'));
hostModule.apply(hostCtx, {});
check(hostRoutes.length === 1, 'host half registers exactly one route');
const route = hostRoutes[0];
check(route?.path === '/api/chat-mode/stream' && route.methods[0] === 'POST', 'route is POST /api/chat-mode/stream');
//#endregion

//#region bundle loading
const { module, reactStub, styleTags } = loadClient();
check(module.PKG === '@local/dsh-chat-mode', 'client bundle registers its factory under the package id');
check(module.internal !== undefined, 'client bundle exposes its internals for checks');
const { internal } = module;

const zhKeys = Object.keys(internal.zh).sort();
const enKeys = Object.keys(internal.en).sort();
check(zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]), 'zh and en key sets match', zhKeys.filter((key) => !enKeys.includes(key)).join(','));

const { React } = reactStub;
/** Render one component to text with a snapshot selector hook. */
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

const catalogFixture = {
	ok: true,
	value: {
		default: { provider: 'deepseek-account', model: 'deepseek-flash' },
		routableProviders: ['deepseek-account'],
		groups: [{
			id: 'deepseek-account',
			name: 'DeepSeek Account',
			models: [
				{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
				{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } },
			],
		}],
		failures: [],
	},
};

/**
 * Register the browser half against one storage, the way the page does.
 * @param storage - the Web Storage object the panel should use.
 * @returns the panel registration, its props, and the controller actions.
 */
function boot(storage) {
	globalThis.window.localStorage = storage;
	const registrations = [];
	const dictionaries = new Set();
	const fakeContext = {
		locale: {
			bind: () => (key) => key,
			register: (ns) => {
				dictionaries.add(ns);
				return () => {};
			},
		},
		remote: {
			session: {
				modelCatalog: async () => catalogFixture,
			},
		},
		effect: (fn) => fn(),
		slots: {
			inject: (key, callback) => {
				const produced = callback();
				if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
					let step = produced.next();
					while (!step.done) step = produced.next();
					return () => {};
				}
				return produced;
			},
			register: (options, component) => {
				registrations.push({ options, component });
				return () => {};
			},
		},
	};
	module.apply(fakeContext);
	const panel = registrations.find((row) => row.options.name === 'main' && row.options.key === 'chat');
	const props = panel.options.inject();
	const store = props.hooks.chat;
	return { registrations, panel, props, store, t: (key) => key, dictionaries };
}
//#endregion

//#region file classification and notebooks
const { internal: tool } = module;
check(tool.classifyFile({ name: 'paper.pdf', type: 'application/pdf' }) === 'pdf', 'a .pdf is classified as a PDF');
check(tool.classifyFile({ name: 'report.PDF', type: '' }) === 'pdf', 'a PDF is recognised by extension when the type is missing');
check(tool.classifyFile({ name: 'notebook.nb', type: '' }) === 'text', 'a .nb notebook is classified as text');
check(tool.classifyFile({ name: 'solver.wl', type: '' }) === 'text', 'a .wl package is classified as text');
check(tool.classifyFile({ name: 'shot.png', type: 'image/png' }) === 'image', 'a PNG is classified as an image');
check(tool.classifyFile({ name: 'archive.zip', type: 'application/zip' }) === 'unsupported', 'an unknown binary is unsupported');

const notebook = [
	'Notebook[{',
	'Cell[BoxData[RowBox[{"Plot", "[", RowBox[{"Sin", "[", "x", "]"}], ",", RowBox[{"{", RowBox[{"x", ",", "0", ",", "10"}], "}"}], "]"}]], "Input"],',
	'Cell["A short note about the plot.", "Text"],',
	'Cell[BoxData[RowBox[{"Integrate", "[", RowBox[{SuperscriptBox["x", "2"], ",", "x"}], "]"}]], "Input"],',
	'Cell[BoxData["2"], "Output"]',
	'}]',
].join('\n');
const notebookText = tool.mathematicaToText(notebook, 'nb', (key) => key).text;
check(/Plot\[Sin\[x\]\s*,\s*\{x\s*,\s*0\s*,\s*10\s*\}\s*\]/.test(notebookText), 'notebook input cells are flattened to code', notebookText.slice(0, 160));
check(/Integrate\[x\s*2\s*,\s*x\s*\]/.test(notebookText), 'boxed superscripts keep their operands', notebookText);
check(notebookText.includes('A short note about the plot.'), 'notebook text cells are kept');
check(!notebookText.includes('Output'), 'notebook output cells are left out');
check(notebookText.includes('nbSummary'), 'the notebook reports how many cells it extracted');
check(tool.mathematicaToText('f[x_] := x^2', 'wl', (key) => key).text === 'f[x_] := x^2', 'a .wl package passes through unchanged');
check(tool.mathematicaToText('Notebook[{"nothing"}]', 'nb', (key) => key).note === 'raw', 'an unparsable notebook falls back to its raw text');
//#endregion

//#region pdf extraction
/** Build a small PDF whose content stream is deflated. */
function buildPdf({ objects, root = '1 0 R' }) {
	let out = '%PDF-1.7\n';
	for (const [number, body] of Object.entries(objects)) out += `${number} 0 obj\n${body}\nendobj\n`;
	out += `trailer\n<< /Root ${root} /Size ${Object.keys(objects).length + 1} >>\n%%EOF\n`;
	return Uint8Array.from(out, (character) => character.charCodeAt(0) & 0xff);
}
const flush = (text) => {
	const bytes = deflateSync(Buffer.from(text, 'latin1'));
	let out = '';
	for (let index = 0; index < bytes.length; index += 1) out += String.fromCharCode(bytes[index]);
	return out;
};

const simpleContent = 'BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj ET\nBT /F1 12 Tf 72 700 Td [(Kerned) -300 (text)] TJ ET';
const simplePdf = buildPdf({
	objects: {
		1: '<< /Type /Catalog /Pages 2 0 R >>',
		2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
		4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		6: `<< /Length ${flush(simpleContent).length} /Filter /FlateDecode >>\nstream\n${flush(simpleContent)}\nendstream`,
	},
});
const simple = await tool.extractPdfText(simplePdf);
check(simple.pages === 1, 'a one-page PDF reports one page', String(simple.pages));
check(simple.text.includes('Hello PDF world'), 'a literal string is extracted', simple.text);
check(simple.text.includes('Kerned text'), 'a TJ array is joined', simple.text);

const cjkContent = 'BT /F1 12 Tf 72 720 Td <48656C6C6F> Tj ET';
const cmap = 'begincmap\n1 beginbfchar\n<0048> <0048>\n<0065> <0065>\n<006C> <006C>\n<006F> <006F>\nendbfchar\nendcmap';
const identityContent = 'BT /F1 12 Tf 72 720 Td <4F60597D> Tj ET';
const cjkCmap = 'begincmap\n1 beginbfchar\n<4F60> <4F60>\n<597D> <597D>\nendbfchar\nendcmap';
const cjkPdf = buildPdf({
	objects: {
		1: '<< /Type /Catalog /Pages 2 0 R >>',
		2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
		4: '<< /Type /Font /Subtype /Type0 /BaseFont /Test /ToUnicode 5 0 R >>',
		5: `<< /Length ${cjkCmap.length} >>\nstream\n${cjkCmap}\nendstream`,
		6: `<< /Length ${identityContent.length} >>\nstream\n${identityContent}\nendstream`,
	},
});
const cjk = await tool.extractPdfText(cjkPdf);
check(cjk.text.trim() === '你好', 'a composite font is decoded through its /ToUnicode CMap', JSON.stringify(cjk.text));

const hexSimple = buildPdf({
	objects: {
		1: '<< /Type /Catalog /Pages 2 0 R >>',
		2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		3: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
		4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		6: `<< /Length ${cjkContent.length} >>\nstream\n${cjkContent}\nendstream`,
	},
});
check((await tool.extractPdfText(hexSimple)).text.includes('Hello'), 'hex strings are decoded');

const encryptedPdf = buildPdf({
	objects: {
		1: '<< /Type /Catalog /Pages 2 0 R >>',
		2: '<< /Type /Pages /Kids [] /Count 0 >>',
		9: '<< /Filter /Standard >>',
	},
});
const encrypted = await tool.extractPdfText(encryptedPdf).catch(() => ({ note: 'threw' }));
check(encrypted.note !== 'encrypted', 'an ordinary PDF is not reported as encrypted', encrypted.note);
const trulyEncrypted = await tool.extractPdfText(new TextEncoder().encode('%PDF-1.7\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n'));
check(trulyEncrypted.note === 'encrypted', 'an encrypted PDF is reported as such', trulyEncrypted.note);
const notPdf = await tool.extractPdfText(new TextEncoder().encode('just text'));
check(notPdf.note === 'not-pdf', 'a file without a PDF header is refused', notPdf.note);

const vectorSample = '/System/Library/Frameworks/Automator.framework/Resources/Log_Status_Error.pdf';
if (existsSync(vectorSample)) {
	const extracted = await tool.extractPdfText(new Uint8Array(readFileSync(vectorSample)));
	check(extracted.text === '' && extracted.note === 'no-text', 'a textless vector PDF reports no text instead of noise', `${extracted.text.length}/${extracted.note}`);
}
/* Real documents, when the machine has any: point DSH_TEST_CORPUS at a folder
   of your own PDFs, or drop the check by leaving it unset. */
const corpusDirectory = process.env.DSH_TEST_CORPUS ?? join(homedir(), 'Downloads');
const realSamples = existsSync(corpusDirectory)
	? readdirSync(corpusDirectory, { recursive: true }).filter((name) => String(name).toLowerCase().endsWith('.pdf')).slice(0, 3).map((name) => join(corpusDirectory, String(name)))
	: [];
let cleanDocuments = 0;
let noisyDocuments = 0;
for (const file of realSamples) {
	const extracted = await tool.extractPdfText(new Uint8Array(readFileSync(file)));
	const noise = (extracted.text.match(/[\ufffd\u0080-\u009f]/g) ?? []).length;
	if (noise > 0) noisyDocuments += 1;
	if (extracted.text.length > 200) cleanDocuments += 1;
}
if (realSamples.length > 0) {
	check(noisyDocuments === 0, `no sampled document decodes into noise (${realSamples.length} sampled)`, `${noisyDocuments} noisy`);
	check(cleanDocuments > 0, 'at least one sampled document yields a text layer', `${cleanDocuments}/${realSamples.length}`);
} else {
	console.log('  ..  no PDF corpus found; set DSH_TEST_CORPUS to sample real documents');
}
//#endregion

//#region history plus an end-to-end turn
const memoryCalls = [];
globalThis.fetch = async (url, init) => {
	const target = String(url);
	if (target.includes('/api/superman/api')) {
		const body = JSON.parse(init.body);
		memoryCalls.push(body);
		if (body.action === 'store') return Response.json({ ok: true, value: { item: { id: `mem-${memoryCalls.length}`, name: body.name, category: 'other' } } });
		if (body.action === 'recall') return Response.json({ ok: true, value: { digest: '【记忆体 Superman｜命中 1 项】\n- [PDF] 旧资料.pdf：…', matches: [{ id: 'old', kind: 'item', name: '旧资料.pdf', category: 'pdf', score: 3, snippet: '' }] } });
		if (body.action === 'note') return Response.json({ ok: true, value: { note: body.note } });
		return Response.json({ ok: true, value: { items: [], notes: [], stats: {}, root: '/tmp/superman' } });
	}
	const absolute = target.startsWith('http') ? target : `http://127.0.0.1:19387${target}`;
	return route.fetch(new Request(absolute, init));
};

const storage = createMemoryStorage();
const first = boot(storage.storage);
check(first.store.getSnapshot().conversations.length === 0, 'a fresh profile starts with no conversations');
check(first.store.getSnapshot().activeId === null, 'a fresh profile has no active conversation');
check(styleTags.length > 0, 'the panel registers its stylesheet');

await first.props.loadCatalog();
check(first.store.getSnapshot().catalog.status === 'ready', 'the catalog loads');
check(first.store.getSnapshot().selection?.reasoningEffort === 'high', 'the model default becomes the effort');

const textFile = new File(['# Notes\nline one'], 'notes.md', { type: 'text/markdown' });
const notebookFile = new File([notebook], 'analysis.nb', { type: '' });
const imageFile = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
const pdfFile = new File([simplePdf], 'paper.pdf', { type: 'application/pdf' });
await first.props.addFiles([textFile, notebookFile, imageFile, pdfFile]);
const attached = first.store.getSnapshot().attachments;
check(attached.length === 4, 'text, notebook, image, and PDF all attach', `${attached.length}`);
check(attached[1].text.includes('nbSummary'), 'the notebook attachment reports its cell count', attached[1].text.slice(0, 60));
check(attached[3].text.includes('Hello PDF world'), 'the PDF attachment carries extracted text');
check(attached[3].detail?.includes('pdfPages'), 'the PDF chip reports its page count', attached[3].detail);
check(attached[2].thumb === undefined, 'an image thumbnail is skipped where canvas drawing is unavailable');

first.props.setDraft('Summarise everything.');
await first.props.send();
const answered = first.store.getSnapshot();
const answer = answered.messages.at(-1);
check(answer.text === 'Hello **world**' && answer.status === 'done', 'the streamed answer lands in the thread');
const firstUserText = (recordedCall.messages[0].content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
check((recordedCall.messages[0].content?.[0]?.text ?? '').includes('记忆体 Superman'), 'the question carries what the memory recalled');
check(firstUserText.includes('# Notes'), 'the text attachment is inlined');
const plotLine = firstUserText.split('\n').find((line) => line.includes('Plot')) ?? '';
check(plotLine.includes('Plot[Sin[x]') && plotLine.includes('10'), 'the notebook is inlined as code', JSON.stringify(plotLine));
check(firstUserText.includes('Hello PDF world'), 'the PDF text is inlined');
check(recordedCall.messages[0].content.at(-1).type === 'image', 'the image rides as an image part');
check(memoryCalls.some((call) => call.action === 'store' && call.name === 'notes.md'), 'the uploaded text file is stored in the memory');
check(memoryCalls.some((call) => call.action === 'store' && call.name === 'paper.pdf' && call.text.includes('Hello PDF world')), 'the PDF reaches the memory with its extracted text');
check(memoryCalls.some((call) => call.action === 'store' && call.name === 'analysis.nb'), 'the notebook reaches the memory too');
check(memoryCalls.some((call) => call.action === 'recall'), 'the memory is asked what relates to the question');
check(memoryCalls.some((call) => call.action === 'note' && call.note.kind === 'conversation' && call.note.id.startsWith('chat:')), 'the finished turn is mirrored into the memory as a conversation record');
check(answered.conversations.length === 1, 'the turn created one conversation');
check(answered.conversations[0].title === 'Summarise everything.', 'the conversation takes its title from the first question', answered.conversations[0].title);
check(storage.map.get('dsh.chat-mode.history.v1')?.includes('Hello PDF world') === true, 'the conversation is written to storage');

await first.props.openConversation(answered.conversations[0].id);
first.props.setDraft('And a follow-up.');
await first.props.send();
check(recordedCall.messages.length === 3, 'the follow-up resends the whole conversation', String(recordedCall.messages.length));
const recalls = memoryCalls.filter((call) => call.action === 'recall').length;
first.props.toggleMemory();
first.props.setDraft('Does this still recall?');
await first.props.send();
check(memoryCalls.filter((call) => call.action === 'recall').length === recalls, 'turning the memory off stops the recall calls');
check(recordedCall.messages[1].source?.kind === 'model', 'history assistant turns carry a model source');

await first.props.newConversation();
const fresh = first.store.getSnapshot();
check(fresh.messages.length === 0 && fresh.activeId === null, 'a new chat empties the thread');
check(fresh.conversations.length === 1, 'the previous conversation stays in the list');

const reopened = boot(storage.storage);
const restored = reopened.store.getSnapshot();
check(restored.conversations.length === 1, 'a reload restores the conversation list', String(restored.conversations.length));
check(restored.messages.length === 6, 'a reload restores the last open conversation', String(restored.messages.length));
check(restored.messages[0].attachments[3].text.includes('Hello PDF world'), 'restored attachments keep their extracted text');
check(restored.messages[0].attachments[2].data === undefined && restored.messages[0].attachments[2].pruned === true, 'restored images keep only a thumbnail');
const resent = tool.wireMessages(restored.messages.slice(0, 1), (key) => key);
check(resent[0].content.some((part) => part.type === 'text' && part.text.includes('imageUnavailable')), 'a pruned image is replaced by an explicit note');
await reopened.props.loadCatalog();
check(reopened.store.getSnapshot().selection !== null, 'the restored model selection survives the catalog check');

reopened.props.setDraft('Continue the old chat.');
await reopened.props.send();
check(reopened.store.getSnapshot().messages.length === 8, 'the reopened conversation keeps growing', String(reopened.store.getSnapshot().messages.length));

const panelText = renderToText(reopened.panel.component, {
	...reopened.props,
	t: (key) => key,
	useChat: (selector) => selector(reopened.store.getSnapshot()),
});
check(panelText.includes('history'), 'the rendered panel shows the history column');
check(panelText.includes('newChat'), 'the rendered panel offers a new chat');
const firstTitle = reopened.store.getSnapshot().conversations[0]?.title ?? '';
check(firstTitle !== '' && panelText.includes(firstTitle), 'the rendered history lists the conversation', firstTitle);
check(panelText.includes('DeepSeek-V41-Flash') && panelText.includes('High'), 'the rendered composer shows the current model and effort', panelText.slice(-160));

const target = reopened.store.getSnapshot().conversations[0].id;
reopened.props.deleteConversation(target);
check(reopened.store.getSnapshot().conversations.length === 0, 'deleting a conversation removes it');
check(JSON.parse(storage.map.get('dsh.chat-mode.history.v1')).conversations.length === 0, 'the deletion is written to storage');

const tiny = createMemoryStorage(900);
const trimmed = tool.writeHistory(tiny.storage, [
	{ id: 'a', title: 'a', updatedAt: 1, messages: [{ id: '1', role: 'user', text: 'x'.repeat(600) }] },
	{ id: 'b', title: 'b', updatedAt: 2, messages: [{ id: '2', role: 'user', text: 'y'.repeat(600) }] },
], 'b');
check(trimmed.ok === false && trimmed.conversations.length === 1, 'an over-quota write drops the oldest conversation', `${trimmed.ok}/${trimmed.conversations.length}`);
check(tool.readHistory(tiny.storage).conversations.length === 1, 'the dropped list is what the reader sees');
check(tool.readHistory({ getItem: () => 'not json' }).conversations.length === 0, 'corrupt storage degrades to an empty list');

//#endregion

//#region memory durability: images, chatstate notes, OCR
/* A stateful in-process stand-in for the Superman memory. It answers the same
   command bodies the shipped client posts, keeps the notes and items it was
   given, and serves stored bytes back through the file route, so a picture
   pruned out of `localStorage` can genuinely come back. */
const CHATSTATE_PREFIX = 'chatstate:';
const memoryEngine = {
	notes: new Map(),
	storeItems: [],
	itemCount: 0,
	/** Set to true when `list` must pretend the memory knows nothing. */
	silentList: false,
	/** 'bytes' serves stored content, 'missing' answers 404, 'throw' rejects. */
	fileBehaviour: 'bytes',
	/** 'ok' recognises text, anything else fails like an absent companion. */
	ocrBehaviour: 'ok',
	ocrCalls: [],
	fileRequests: [],
};
const notesOf = (id) => [...memoryEngine.notes.values()].filter((note) => note.id === id);
/** Let the pending promise chain of one client action settle. */
async function tick(rounds = 6) {
	for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
/** Build one `chatstate:` note exactly as `rememberConversation` writes it. */
function chatStateNote(id, { title, updatedAt, messages, selection = null }) {
	return { id: `${CHATSTATE_PREFIX}${id}`, kind: 'conversation', title, updatedAt, source: 'chat', tags: [], text: JSON.stringify({ v: 1, title, updatedAt, selection, messages }) };
}
/** The two conversation records a merge test starts from. */
const mergeFixture = (ids) => ({
	older: { id: ids.note, title: 'from the memory', updatedAt: 100, messages: [{ role: 'user', text: 'memory copy' }] },
	newer: { id: ids.note, title: 'from the memory, newer', updatedAt: 900, messages: [{ role: 'user', text: 'memory copy newer' }, { role: 'assistant', text: 'memory answer' }] },
	local: (record, updatedAt, text) => ({ id: record.id, title: 'local copy', updatedAt, selection: null, messages: [{ id: `m-${record.id}`, role: 'user', text }] }),
});

/** The fetch the rest of the suite was using, restored after the timeout probe. */
const memoryFetch = async (url, init) => {
	const target = String(url);
	const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
	if (target.includes('/api/superman/api')) {
		memoryCalls.push(body);
		switch (body.action) {
			case 'store': {
				memoryEngine.itemCount += 1;
				const item = { id: `mem-item-${memoryEngine.itemCount}`, name: body.name, mime: body.mime, category: 'other' };
				memoryEngine.storeItems.push({ ...item, base64: body.base64, text: body.text });
				return Response.json({ ok: true, value: { item } });
			}
			case 'note': {
				memoryEngine.notes.set(`${body.note.id}:${memoryEngine.notes.size}`, body.note);
				return Response.json({ ok: true, value: { note: body.note } });
			}
			case 'recall':
				return Response.json({ ok: true, value: { digest: '', matches: [] } });
			default:
				return Response.json({ ok: true, value: { items: [], notes: memoryEngine.silentList ? [] : [...memoryEngine.notes.values()], stats: {}, root: '/tmp/superman' } });
		}
	}
	if (target.includes('/api/superman/file')) {
		memoryEngine.fileRequests.push(target);
		if (memoryEngine.fileBehaviour === 'throw') throw new Error('memory file route is down');
		if (memoryEngine.fileBehaviour === 'missing') return new Response('not found', { status: 404 });
		const wanted = new URL(target, 'http://127.0.0.1:19387').searchParams.get('id');
		const item = [...memoryEngine.storeItems].reverse().find((row) => row.id === wanted) ?? null;
		if (item === null || typeof item.base64 !== 'string') return new Response('not found', { status: 404 });
		return new Response(Uint8Array.from(Buffer.from(item.base64, 'base64')));
	}
	if (target.includes('/api/superman-ocr/api')) {
		memoryEngine.ocrCalls.push(body);
		if (memoryEngine.ocrBehaviour !== 'ok') return new Response('no ocr companion', { status: 404 });
		return Response.json({ ok: true, value: { text: 'Recognised scanned text', pages: 2 } });
	}
	const absolute = target.startsWith('http') ? target : `http://127.0.0.1:19387${target}`;
	return route.fetch(new Request(absolute, init));
};
globalThis.fetch = memoryFetch;

/* Image bytes the memory hands back: the upload itself is the source of truth,
   so the round trip proves the restoration rather than a fixture. */
const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngBase64 = Buffer.from(pngBytes).toString('base64');
/** The text parts of a recorded outgoing turn, joined. */
function sentText(call) {
	return call.messages.flatMap((message) => message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}
const chatStateIds = { note: 'c-memory-1', local: 'c-memory-2' };

memoryEngine.silentList = true;
const pictureStorage = createMemoryStorage();
const pictureFirst = boot(pictureStorage.storage);
await tick();
await pictureFirst.props.loadCatalog();
const pictureFile = new File([pngBytes], 'shot.png', { type: 'image/png' });
await pictureFirst.props.addFiles([pictureFile]);
const pictureId = pictureFirst.store.getSnapshot().attachments[0]?.memoryId ?? '';
check(typeof pictureId === 'string' && pictureId !== '', 'a stored image attachment records the memory item id', String(pictureId));
check(pictureFirst.store.getSnapshot().attachments[0]?.data === pngBase64, 'the live attachment still carries its bytes');
pictureFirst.props.setDraft('Look at the picture.');
await pictureFirst.props.send();
const savedPicture = tool.readHistory(pictureStorage.storage).conversations.at(-1)?.messages[0]?.attachments[0];
check(savedPicture?.memoryId === pictureId, 'the memory id survives the save half of the round trip', String(savedPicture?.memoryId));
check(savedPicture?.data === undefined && savedPicture?.pruned === true, 'the stored copy keeps only the memory id and its thumbnail flag');

memoryEngine.silentList = true;
const pictureAgain = boot(pictureStorage.storage);
await tick();
await pictureAgain.props.loadCatalog();
const reloadedPicture = pictureAgain.store.getSnapshot().messages[0]?.attachments[0];
check(reloadedPicture?.memoryId === pictureId, 'the memory id survives the load half of the round trip', String(reloadedPicture?.memoryId));
check(reloadedPicture?.data === undefined, 'the reloaded image has no bytes of its own');
pictureAgain.props.setDraft('What was in that picture?');
await pictureAgain.props.send();
check(memoryEngine.fileRequests.some((request) => request.includes(`/api/superman/file?id=${encodeURIComponent(pictureId)}`)), 'sending asks the memory for the pruned image by id', memoryEngine.fileRequests.join(' '));
/* The Host half turns a wire image into a durable attachment block, so the
   block existing at all proves the client sent base64 bytes rather than an
   "unavailable" note, and the byte count pins it to the original picture. */
const sentImage = recordedCall.messages[0].content.find((part) => part.type === 'image');
check(sentImage?.attachment?.bytes === pngBytes.length, 'the outgoing turn carries the original image bytes', JSON.stringify(sentImage ?? null));
check(sentImage?.attachment?.mediaType === 'image/png', 'the recovered image keeps its media type', String(sentImage?.attachment?.mediaType));
check(!sentText(recordedCall).includes('imageUnavailable'), 'no image-unavailable note is sent when the bytes come back');
const pictureAnswer = pictureAgain.store.getSnapshot().messages.at(-1);
check(pictureAnswer.status === 'done' && pictureAnswer.text === 'Hello **world**', 'the restored turn still completes normally');

memoryEngine.fileBehaviour = 'missing';
const missingAgain = boot(pictureStorage.storage);
await tick();
await missingAgain.props.loadCatalog();
missingAgain.props.setDraft('The picture route is gone.');
await missingAgain.props.send();
const missingImages = recordedCall.messages[0].content.filter((part) => part.type === 'image');
check(missingImages.length === 0, 'a 404 from the file route leaves no image part', String(missingImages.length));
check(sentText(recordedCall).includes('imageUnavailable'), 'a 404 emits the image-unavailable note');
check(missingAgain.store.getSnapshot().messages.at(-1)?.status === 'done', 'the turn is still sent when the image cannot be recovered');

memoryEngine.fileBehaviour = 'throw';
const throwingAgain = boot(pictureStorage.storage);
await tick();
await throwingAgain.props.loadCatalog();
throwingAgain.props.setDraft('The picture route throws.');
await throwingAgain.props.send();
check(sentText(recordedCall).includes('imageUnavailable'), 'a throwing file route falls back to the same note');
check(throwingAgain.store.getSnapshot().messages.at(-1)?.status === 'done', 'a throwing file route does not stop the turn');
memoryEngine.fileBehaviour = 'bytes';

memoryEngine.silentList = true;
const noteStorage = createMemoryStorage();
const noteClient = boot(noteStorage.storage);
await tick();
await noteClient.props.loadCatalog();
noteClient.props.setDraft('Keep this conversation.');
await noteClient.props.send();
await tick(); /* the note mirror runs on the send path, just after the answer */
const noteId = noteClient.store.getSnapshot().activeId;
const proseNotes = notesOf(`chat:${noteId}`);
const stateNotes = notesOf(`${CHATSTATE_PREFIX}${noteId}`);
check(proseNotes.length === 1 && typeof proseNotes[0].text === 'string' && proseNotes[0].text.includes('Keep this conversation.'), 'rememberConversation posts the prose note for recall');
check(stateNotes.length === 1, 'rememberConversation posts a chatstate payload beside it', String(stateNotes.length));
const statePayload = stateNotes[0] === undefined ? null : JSON.parse(stateNotes[0].text);
check(statePayload?.v === 1, 'the chatstate payload declares version 1', String(statePayload?.v));
check(statePayload?.title === 'Keep this conversation.', 'the chatstate payload carries the conversation title', statePayload?.title);
const snapMessages = noteClient.store.getSnapshot().messages;
check(statePayload?.messages.length === snapMessages.length, 'the payload has one entry per message', `${statePayload?.messages.length}/${snapMessages.length}`);
check(statePayload?.messages.some((message) => message.role === 'assistant' && message.text === 'Hello **world**'), 'the payload keeps the assistant answer under its own role');
check(statePayload?.selection?.model === 'deepseek-flash', 'the payload keeps the model selection');

/* Enough prose that the payload would be far past the memory's note cap. */
const longMessages = [];
for (let index = 0; index < 40; index += 1) {
	longMessages.push({ id: `long-${index}`, role: 'user', text: `Question ${index}: ${'q'.repeat(400)}` });
	longMessages.push({ id: `long-${index}-a`, role: 'assistant', text: `Answer ${index}: ${'a'.repeat(400)}` });
}
const longStorage = createMemoryStorage();
const longSeed = tool.writeHistory(longStorage.storage, [{ id: 'c-long', title: 'A very long conversation', updatedAt: 10, selection: null, messages: longMessages }], 'c-long');
check(longSeed.ok === true, 'the long conversation seeds the local cache', `${longSeed.ok}/${longSeed.conversations[0]?.messages.length}`);
memoryEngine.silentList = true;
const longClient = boot(longStorage.storage);
await tick();
await longClient.props.loadCatalog();
longClient.props.setDraft('One more turn on a long thread.');
await longClient.props.send();
await tick();
const longId = longClient.store.getSnapshot().activeId;
const longAnswer = longClient.store.getSnapshot().messages.at(-1);
check(longAnswer?.status === 'done' && longAnswer.text !== '', 'a restored turn without attachments or reasoning still sends cleanly', `${longAnswer?.status}/${longAnswer?.error ?? ''}`);
const longNote = notesOf(`${CHATSTATE_PREFIX}${longId}`)[0];
const longText = longNote?.text ?? '';
check(longText.length > 0 && longText.length <= 7900, 'a long conversation still fits the memory note cap', String(longText.length));
let longPayload = null;
try {
	longPayload = JSON.parse(longText);
} catch {
	longPayload = null;
}
check(longPayload !== null && longText === JSON.stringify(longPayload), 'the capped payload is whole JSON, never truncated mid-object');
check(longPayload?.messages.length < longClient.store.getSnapshot().messages.length, 'capping drops the oldest turns', `${longPayload?.messages.length} of ${longClient.store.getSnapshot().messages.length}`);
/* The payload is built at the end of `send`: the newest question is kept, and
   a still-streaming (empty) assistant row is never written into the JSON. When
   the answer has already landed, it follows the question it answers. */
const longTail = longPayload?.messages ?? [];
const newest = longTail.findLastIndex((message) => message.role === 'user' && message.text.includes('One more turn on a long thread.'));
check(newest !== -1 && newest >= longTail.length - 2, 'the newest question survives the memory-note cap', JSON.stringify(longTail.slice(-2)));
check(longTail.length > 0 && longTail.at(-1).text.trim() !== '', 'no empty streaming row is written into the payload');
check(longPayload?.messages.every((message) => message.text !== '' && (message.role === 'user' || message.role === 'assistant')) === true, 'every entry in the payload is a real turn');
check(longPayload?.messages.some((message) => message.text.includes('Question 0')) === false, 'the oldest turns are the ones dropped');

memoryEngine.silentList = false;
memoryEngine.notes.clear();
memoryEngine.notes.set(`${CHATSTATE_PREFIX}${chatStateIds.note}:0`, chatStateNote(chatStateIds.note, {
	title: 'Written on another port',
	updatedAt: 5000,
	selection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
	messages: [
		{ role: 'user', text: 'A question from the other browser.', attachments: [] },
		{ role: 'assistant', text: 'An answer the local origin never saw.', attachments: [] },
	],
}));
const freshOrigin = createMemoryStorage();
const freshClient = boot(freshOrigin.storage);
await tick();
const freshState = freshClient.store.getSnapshot();
check(freshState.conversations.length === 1, 'a fresh origin restores the memory conversation into the list', `${freshState.conversations.length}`);
check(freshState.conversations[0]?.id === chatStateIds.note, 'the restored list entry keeps the memory conversation id', String(freshState.conversations[0]?.id));
check(freshOrigin.map.get('dsh.chat-mode.history.v1')?.includes('Written on another port') === true, 'the restored conversation is cached in localStorage');
const restoredStatus = freshState.memoryStatus ?? '';
check(restoredStatus.includes('memoryRestored'), 'memoryStatus reports the restoration through the memoryRestored key', restoredStatus);
const restoredThread = tool.readHistory(freshOrigin.storage).conversations[0]?.messages ?? [];
check(restoredThread.length === 2 && restoredThread[1]?.text === 'An answer the local origin never saw.', 'the restored messages keep their roles and text', JSON.stringify(restoredThread).slice(0, 80));
const restoredSelection = tool.readHistory(freshOrigin.storage).conversations[0]?.selection;
check(restoredSelection?.model === 'deepseek-flash', 'the restored conversation keeps its model selection', JSON.stringify(restoredSelection));

/* The panel's translator is the identity in this harness, so the status is
   `memoryRestored` with its placeholder filled; the dictionaries themselves are
   checked for the sentence that key stands for. */
const memoryRestoredKey = internal.zh.memoryRestored;
check(typeof memoryRestoredKey === 'string' && typeof internal.en.memoryRestored === 'string', 'the memoryRestored key exists in both dictionaries');
check(memoryRestoredKey.includes('{n}') && internal.en.memoryRestored.includes('{n}'), 'the memoryRestored sentence takes the restoration count', `${memoryRestoredKey} / ${internal.en.memoryRestored}`);
check(restoredStatus.startsWith('memoryRestored'), 'the status is built from the memoryRestored sentence', restoredStatus);

memoryEngine.notes.clear();
memoryEngine.notes.set(`${CHATSTATE_PREFIX}${chatStateIds.note}:0`, chatStateNote(chatStateIds.note, {
	title: 'from the memory, newer',
	updatedAt: 900,
	messages: [{ role: 'user', text: 'memory copy newer' }, { role: 'assistant', text: 'memory answer' }],
}));
const olderLocal = mergeFixture(chatStateIds).local(chatStateIds, 100, 'this local copy is the older one');
const newerLocal = mergeFixture(chatStateIds).local({ id: chatStateIds.local }, 5000, 'this local copy is the newer one');
const mergeStorage = createMemoryStorage();
tool.writeHistory(mergeStorage.storage, [olderLocal, newerLocal], chatStateIds.local);
const mergeClient = boot(mergeStorage.storage);
await tick();
const mergeRecord = tool.readHistory(mergeStorage.storage).conversations.find((record) => record.id === chatStateIds.note);
check(mergeRecord?.updatedAt === 900 && mergeRecord?.messages[1]?.text === 'memory answer', 'an older local copy is upgraded from the memory', JSON.stringify(mergeRecord?.messages));
const keptRecord = tool.readHistory(mergeStorage.storage).conversations.find((record) => record.id === chatStateIds.local);
check(keptRecord?.title === 'local copy' && keptRecord?.updatedAt === 5000, 'a newer local copy is not overwritten by the memory', JSON.stringify(keptRecord?.messages));
check(mergeClient.store.getSnapshot().conversations.length === 2, 'the merged list still holds both conversations', String(mergeClient.store.getSnapshot().conversations.length));

memoryEngine.notes.clear();
memoryEngine.notes.set(`${CHATSTATE_PREFIX}broken:0`, { id: `${CHATSTATE_PREFIX}broken`, text: '{"v":1,"title":"cut off","messages":' });
memoryEngine.notes.set(`${CHATSTATE_PREFIX}wrong:0`, { id: `${CHATSTATE_PREFIX}wrong`, text: JSON.stringify({ v: 9, title: 'wrong version', messages: [] }) });
const brokenStorage = createMemoryStorage();
const brokenClient = boot(brokenStorage.storage);
let brokenThrew = null;
try {
	await tick();
} catch (error) {
	brokenThrew = error;
}
check(brokenThrew === null, 'a malformed chatstate payload does not throw', String(brokenThrew));
check(brokenClient.store.getSnapshot().conversations.length === 0, 'the list still renders when the memory hands back a broken payload', String(brokenClient.store.getSnapshot().conversations.length));
check(brokenStorage.map.get('dsh.chat-mode.history.v1') === undefined || tool.readHistory(brokenStorage.storage).conversations.length === 0, 'nothing broken is cached locally');

/* A page with no content stream: no text layer, so only OCR can read it. */
const scannedPdf = buildPdf({
	objects: {
		1: '<< /Type /Catalog /Pages 2 0 R >>',
		2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		3: '<< /Type /Page /Parent 2 0 R /Resources << >> >>',
	},
});
const scanned = await tool.extractPdfText(scannedPdf);
check(scanned.text.trim() === '', 'the scanned fixture really has no text layer', JSON.stringify(scanned.text));

memoryEngine.silentList = true;
memoryEngine.ocrBehaviour = 'ok';
memoryEngine.ocrCalls.length = 0;
const ocrStorage = createMemoryStorage();
const ocrClient = boot(ocrStorage.storage);
await tick();
await ocrClient.props.loadCatalog();
const scannedFile = new File([scannedPdf], 'scan.pdf', { type: 'application/pdf' });
await ocrClient.props.addFiles([scannedFile]);
const ocrAttachment = ocrClient.store.getSnapshot().attachments[0];
check(ocrAttachment?.kind === 'text' && ocrAttachment.text.startsWith('pdfOcr'), 'a textless PDF is inlined with the pdfOcr marker', String(ocrAttachment?.text?.slice(0, 60)));
check(ocrAttachment?.text.includes('Recognised scanned text'), 'the scanned page keeps the recognised text');
check(memoryEngine.ocrCalls.length === 1, 'the OCR companion is asked exactly once', String(memoryEngine.ocrCalls.length));
const ocrBody = memoryEngine.ocrCalls[0] ?? {};
check(ocrBody.action === 'ocr' && ocrBody.base64 === Buffer.from(scannedPdf).toString('base64'), 'the OCR request carries the PDF bytes as base64', String(ocrBody.base64?.slice(0, 24)));
check(ocrBody.name === 'scan.pdf', 'the OCR request carries the file name', String(ocrBody.name));
check(memoryCalls.some((call) => call.action === 'store' && call.name === 'scan.pdf' && call.text.includes('Recognised scanned text')), 'the recognised text is what gets stored in the memory');
check(ocrClient.store.getSnapshot().notice === null, 'a recognised scan reports nothing skipped');

memoryEngine.ocrBehaviour = 'failed';
memoryEngine.ocrCalls.length = 0;
const noOcrStorage = createMemoryStorage();
const noOcrClient = boot(noOcrStorage.storage);
await tick();
await noOcrClient.props.loadCatalog();
let noOcrThrew = null;
try {
	await noOcrClient.props.addFiles([new File([scannedPdf], 'scan.pdf', { type: 'application/pdf' })]);
} catch (error) {
	noOcrThrew = error;
}
check(noOcrThrew === null, 'a failing OCR route does not throw out of the composer', String(noOcrThrew));
check(noOcrClient.store.getSnapshot().attachments.length === 0, 'a failing OCR route attaches nothing', String(noOcrClient.store.getSnapshot().attachments.length));
check((noOcrClient.store.getSnapshot().notice ?? '').includes('pdfNoText'), 'a failing OCR route keeps the no-text-layer skip message', String(noOcrClient.store.getSnapshot().notice));
check(memoryCalls.filter((call) => call.action === 'store' && call.name === 'scan.pdf' && String(call.text ?? '').includes('Recognised')).length === 1, 'a failed scan is not stored as recognised text');
memoryEngine.ocrBehaviour = 'ok';

/* The 8-second memory timeout, driven deterministically: the check owns
   `window.setTimeout` while the upload runs, records the delay the client
   registered, and fires that callback itself, which aborts the request the way
   a stalled memory would. Nothing waits on the wall clock. The stalled route is
   the upload's own `store` command, because a text upload never touches the
   file route. */
const hangingSignal = { value: null };
let hangArmed = false;
const hangClient = boot(createMemoryStorage().storage);
await tick();
await hangClient.props.loadCatalog();
const realSetTimeout = globalThis.window.setTimeout;
const realClearTimeout = globalThis.window.clearTimeout;
const restoreTimers = [];
globalThis.window.setTimeout = (callback, delay) => {
	restoreTimers.push({ callback, delay });
	return { unref() {} };
};
globalThis.window.clearTimeout = () => {};
const hangingFetch = async (url, init) => {
	const target = String(url);
	const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
	if (hangArmed && body?.action === 'store') {
		hangArmed = false;
		hangingSignal.value = init?.signal ?? null;
		/* A memory that accepts the upload and then never answers. */
		return new Promise((resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		});
	}
	return memoryFetch(url, init);
};
/* A macrotask boundary, repeated a bounded number of times: the client's own
   continuation after a `fetch` settles needs real event-loop turns, and this
   uses `setImmediate` so the patched client timer stays out of the way. */
const settle = async (rounds = 8) => {
	for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
hangClient.props.setDraft('Remember this file.');
globalThis.fetch = hangingFetch;
hangArmed = true;
try {
	/* The upload is deliberately not awaited: its own timer is the only escape. */
	const stalledUpload = hangClient.props.addFiles([new File(['stalled upload body'], 'stalled.txt', { type: 'text/plain' })]);
	await settle();
	void stalledUpload;
} finally {
	globalThis.window.setTimeout = realSetTimeout;
	globalThis.window.clearTimeout = realClearTimeout;
}
check(hangingSignal.value !== null, 'the stalled upload is waiting on the memory and never answered');
check(restoreTimers.some((entry) => entry.delay === 8000), 'the memory command arms an 8-second timer', restoreTimers.map((entry) => entry.delay).join(','));
check(hangingSignal.value?.aborted === false, 'the stalled request is still live before the timer fires');
for (const entry of restoreTimers) entry.callback();
check(hangingSignal.value?.aborted === true, 'the timer aborts the stalled memory request');
await settle();
globalThis.fetch = memoryFetch;
const stalledStatus = hangClient.store.getSnapshot().memoryStatus ?? '';
check(stalledStatus.includes('memoryFailed'), 'a stalled memory surfaces as a write failure', stalledStatus);
check(stalledStatus.includes('memorySaved') === false, 'a stalled memory reports nothing saved', stalledStatus);
//#endregion

//#region failure paths
hostCtx.llm.stream = async function* stream() {
	yield { type: 'finish', reason: { kind: 'error', failure: { code: 'provider-down', message: 'provider is down' } } };
};
const failing = boot(createMemoryStorage().storage);
await failing.props.loadCatalog();
failing.props.setDraft('Will this fail?');
await failing.props.send();
const failedAnswer = failing.store.getSnapshot().messages.at(-1);
check(failedAnswer.status === 'error' && failedAnswer.error === 'provider is down', 'a provider failure reaches the panel as an error');
check((await route.fetch(new Request('http://127.0.0.1:19387/api/chat-mode/stream'))).status === 405, 'the route still refuses a non-POST request');
//#endregion

console.log('');
if (failures.length > 0) {
	console.log(`${failures.length} check(s) failed`);
	for (const failure of failures) console.log(` - ${failure}`);
	process.exit(1);
}
console.log('all checks passed');
