/**
 * Browser half of the chat-mode bundle.
 *
 * Two entries join the sidebar's global panel list — `Harness` (the shipped
 * agent conversation, panel key `conversation`) and `Chat` (this plugin's own
 * `main` panel) — so the left column switches between the agent and a plain
 * conversation. The Chat panel imitates ChatGPT: a centered thread column, a
 * rounded composer with an attachment button, a model picker, a thinking-effort
 * picker, and a send button that becomes Stop while an answer streams.
 *
 * The page never calls a provider itself: it posts the conversation to the
 * Host half's same-origin `/api/chat-mode/stream` route and renders the
 * Server-Sent Events that come back. Only React from the boot module table and
 * theme tokens are used, so the panel follows the app's language and both themes.
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-chat-mode',
	factory: (require) => {
		const React = require('react');
		/** This package's name, used for the style tag's ownership marker. */
		const PKG = '@local/dsh-chat-mode';
		/** Dictionary namespace owned by this plugin. */
		const NS = 'chatMode';
		/** Sidebar entry id of the Chat panel; the same id keys the layout's `main` entry. */
		const CHAT_PANEL_ID = 'chat';
		/** Sidebar entry id of the shipped agent panel, which owns the `conversation` main key. */
		const HARNESS_PANEL_ID = 'conversation';
		/** The Host half's streaming route, under the authenticated `/api` channel. */
		const STREAM_URL = '/api/chat-mode/stream';
		/** The Superman memory's command route, from the sibling bundle. */
		const MEMORY_API = '/api/superman/api';
		/** Where the composer's "remember" switch is kept. */
		const MEMORY_SWITCH_KEY = 'dsh.chat-mode.memory';
		/** The memory's byte route, for fetching back what history only kept a thumbnail of. */
		const MEMORY_FILE = '/api/superman/file';
		/** The optional OCR companion bundle, for PDFs whose text layer is empty. */
		const OCR_API = '/api/superman-ocr/api';
		/** How long one OCR run may take; a scanned document is slow on purpose. */
		const OCR_TIMEOUT_MS = 600000;
		/** The note id prefix under which the memory keeps a restorable conversation. */
		const MEMORY_CONVERSATION_PREFIX = 'chatstate:';
		/** How long a memory command may take before it is treated as unavailable. */
		const MEMORY_TIMEOUT_MS = 8000;
		/** Characters of a conversation payload the memory's note cap allows. */
		const MEMORY_PAYLOAD_CHARS = 7900;
		/** Longest transcript synced to the memory per conversation. */
		const MAX_NOTE_CHARS = 8000;
		/** Required services (cordis fiber inject). */
		const inject = ['slots', 'locale', 'remote', 'remote.session'];
		/** How many files one turn may carry. */
		const MAX_ATTACHMENTS = 6;
		/** Longest image accepted, matching the Host half's own bound. */
		const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
		/** Longest text extracted from one file before it is clipped. */
		const MAX_TEXT_CHARS = 200_000;
		/** Longest PDF accepted before extraction is skipped. */
		const MAX_PDF_BYTES = 40 * 1024 * 1024;
		/** Longest decoded single stream the PDF reader keeps in memory. */
		const MAX_PDF_STREAM_BYTES = 8 * 1024 * 1024;
		/** Where the conversation list lives: this origin's own storage. */
		const HISTORY_KEY = 'dsh.chat-mode.history.v1';
		/** Stored-list format version; a mismatch starts an empty list. */
		const HISTORY_VERSION = 1;
		/** How many conversations are kept. */
		const MAX_CONVERSATIONS = 40;
		/** How many messages of one conversation are kept. */
		const MAX_STORED_MESSAGES = 200;
		/** Character budget of one stored conversation list. */
		const MAX_STORED_CHARS = 3_500_000;
		/** Characters of one attachment's text that survive a reload. */
		const MAX_STORED_ATTACHMENT_CHARS = 40_000;
		/** Longest stored reasoning trace. */
		const MAX_STORED_REASONING_CHARS = 20_000;
		/** Thumbnail edge, in pixels, kept for an image attachment. */
		const THUMB_EDGE = 160;
		/** Longest stored conversation title. */
		const TITLE_CHARS = 48;
		/** Extensions treated as text even when the browser reports no text media type. */
		const TEXT_EXTENSIONS = new Set([
			'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml',
			'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'html', 'htm', 'svg', 'css', 'scss', 'less',
			'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'kt',
			'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'm', 'mm', 'sh', 'bash', 'zsh',
			'fish', 'ps1', 'bat', 'sql', 'graphql', 'proto', 'tex', 'srt', 'vtt', 'diff', 'patch',
			// Mathematica: packages, scripts, and plain-text notebooks all read as text.
			'nb', 'wl', 'wls', 'ma', 'mt', 'mth',
		]);
		/** Extensions read as saved web pages, whose tags are stripped before inlining. */
		const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);
		/** Extensions read as Mathematica sources, so the attachment reports itself as such. */
		const MATHEMATICA_EXTENSIONS = new Set(['nb', 'wl', 'wls', 'ma', 'mt', 'mth']);
		/** Media types the Host half accepts for image parts. */
		const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

		//#region helpers
		/**
		 * Mint one local identifier for a message or attachment.
		 * @param prefix - short tag making the id readable while debugging.
		 * @returns a process-unique id.
		 */
		function uid(prefix) {
			return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		}

		/**
		 * Create a snapshot store shaped for the renderer's selector Hooks:
		 * `getSnapshot` returns the same reference until `update` publishes a new one.
		 * @param initial - the first snapshot.
		 * @returns the store.
		 */
		function createStore(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				update(mutate) {
					const draft = { ...snapshot };
					mutate(draft);
					snapshot = draft;
					for (const listener of [...listeners]) listener();
				},
			};
		}

		/**
		 * Replace one message object, keeping every other reference stable so only
		 * the streaming row re-renders.
		 * @param draft - the snapshot being edited.
		 * @param id - message id to replace.
		 * @param patch - pure message-to-message function.
		 */
		function patchMessage(draft, id, patch) {
			draft.messages = draft.messages.map((message) => (message.id === id ? patch(message) : message));
		}

		/**
		 * Human-readable byte size for an attachment chip.
		 * @param bytes - stored byte length.
		 * @returns a short label such as `12.4 KB`.
		 */
		function formatBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}

		/**
		 * Whether a picked file should be inlined as text rather than attached as
		 * bytes; unknown binary content stays unsupported.
		 * @param file - the picked file.
		 * @returns whether its text is worth sending.
		 */
		function isTextual(file) {
			const type = (file.type || '').toLowerCase();
			if (type.startsWith('text/')) return true;
			if (['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/sql'].includes(type)) return true;
			const extension = extensionOf(file.name);
			return extension !== '' && TEXT_EXTENSIONS.has(extension);
		}

		/**
		 * Lower-case extension of a file name, without its dot.
		 * @param name - the file name.
		 * @returns the extension, or an empty string.
		 */
		function extensionOf(name) {
			const lowered = (name || '').toLowerCase();
			const dot = lowered.lastIndexOf('.');
			return dot === -1 || dot === lowered.length - 1 ? '' : lowered.slice(dot + 1);
		}

		/**
		 * Decide how one picked file is read: as an image part, an extracted PDF
		 * text, an inlined text file, or nothing at all.
		 * @param file - the picked file.
		 * @returns one of `image`, `pdf`, `text`, `unsupported`.
		 */
		function classifyFile(file) {
			const type = (file.type || '').toLowerCase();
			const extension = extensionOf(file.name);
			if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image';
			if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
			return isTextual(file) ? 'text' : 'unsupported';
		}

		/**
		 * Describe one attachment's size, page or character count for its chip.
		 * @param parts - whichever details apply.
		 * @returns a compact detail string, or undefined.
		 */
		function detailOf(parts) {
			const pieces = [];
			if (Number.isFinite(parts.bytes)) pieces.push(formatBytes(parts.bytes));
			if (typeof parts.encoding === 'string' && parts.encoding !== '' && parts.encoding !== 'utf-8') pieces.push(parts.encoding.toUpperCase());
			if (Number.isFinite(parts.pages) && parts.pages > 0) pieces.push(`${parts.pages} ${parts.pageWord}`);
			else if (Number.isFinite(parts.characters) && parts.characters > 0) pieces.push(`${Math.round(parts.characters / 1000)}k ${parts.characterWord}`);
			return pieces.length === 0 ? undefined : pieces.join(' · ');
		}

		/**
		 * Encode bytes as canonical base64.
		 * @param bytes - the payload.
		 * @returns base64 without a data-url prefix.
		 */
		function base64FromBytes(bytes) {
			let binary = '';
			const step = 0x8000;
			for (let index = 0; index < bytes.length; index += step) {
				binary += String.fromCharCode(...bytes.subarray(index, index + step));
			}
			return btoa(binary);
		}

		/**
		 * Answer one Superman memory command.
		 * @param body - the command body, per `superman/API.md`.
		 * @returns the command's value, or undefined when the memory is unavailable.
		 */
		async function memoryCommand(body) {
			const controller = new AbortController();
			const timer = window.setTimeout(() => controller.abort(), MEMORY_TIMEOUT_MS);
			try {
				const response = await fetch(MEMORY_API, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				const payload = await response.json();
				if (payload?.ok !== true) return undefined;
				return payload.value;
			} catch {
				return undefined;
			} finally {
				window.clearTimeout(timer);
			}
		}

		/**
		 * Recover the original bytes of one image the memory stored, for a history
		 * entry that only carries a thumbnail.
		 * @param image - the restored attachment.
		 * @returns the same attachment, with `data` when the memory still has it.
		 */
		async function restoreImage(image) {
			if (typeof image.data === 'string') return image;
			if (typeof image.memoryId !== 'string' || image.memoryId === '') return image;
			try {
				const response = await fetch(`${MEMORY_FILE}?id=${encodeURIComponent(image.memoryId)}`);
				if (!response.ok) return image;
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.length === 0) return image;
				return { ...image, data: base64FromBytes(bytes) };
			} catch {
				return image;
			}
		}

		/**
		 * Read a scanned PDF with the optional OCR companion bundle. Silent when that
		 * bundle is not installed, so Chat keeps working without it.
		 * @param bytes - the PDF bytes.
		 * @param name - the file name, for the OCR tool's logs.
		 * @returns the recognised text and page count, or null.
		 */
		async function readByOcr(bytes, name) {
			const controller = new AbortController();
			const timer = window.setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
			try {
				const response = await fetch(OCR_API, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ action: 'ocr', base64: base64FromBytes(bytes), name }),
					signal: controller.signal,
				});
				const payload = await response.json();
				if (payload?.ok !== true || typeof payload.value?.text !== 'string') return null;
				const text = payload.value.text.trim();
				if (text === '') return null;
				return { text, pages: Number(payload.value.pages ?? 0) };
			} catch {
				return null;
			} finally {
				window.clearTimeout(timer);
			}
		}

		/**
		 * Fill in what history pruned, before the turn is sent: images come back from
		 * the memory, so an old conversation can be continued instead of being told
		 * that its pictures are gone.
		 * @param history - the conversation, oldest first.
		 * @returns the conversation with every recoverable image restored.
		 */
		async function hydrate(history) {
			const restored = [];
			for (const message of history) {
				const missing = (message.attachments ?? []).filter((item) => item.kind === 'image' && typeof item.data !== 'string');
				if (message.role !== 'user' || missing.length === 0) {
					restored.push(message);
					continue;
				}
				const attachments = [];
				for (const item of message.attachments ?? []) {
					attachments.push(item.kind === 'image' ? await restoreImage(item) : item);
				}
				restored.push({ ...message, attachments });
			}
			return restored;
		}

		/**
		 * Read the Host half's SSE response frame by frame.
		 * @param body - the response body stream.
		 * @param onEvent - called once per decoded `data:` payload.
		 */
		async function readFrames(body, onEvent) {
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf('\n\n');
				while (index !== -1) {
					const frame = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					for (const line of frame.split('\n')) {
						if (!line.startsWith('data:')) continue;
						const payload = line.slice(5).trim();
						if (payload === '') continue;
						try {
							onEvent(JSON.parse(payload));
						} catch {
							/* a truncated frame is dropped; the next one still arrives */
						}
					}
					index = buffer.indexOf('\n\n');
				}
			}
		}

		/**
		 * Project one turn onto the messages the Host half expects: text parts
		 * inline, images as base64 with their media type. Attachments restored from
		 * history say so instead of sending content they no longer hold.
		 * @param history - the conversation, oldest first.
		 * @param t - translator for the restored-attachment notes.
		 * @returns wire messages without empty content.
		 */
		function wireMessages(history, t, digest) {
			const messages = [];
			for (const message of history) {
				const text = typeof message.text === 'string' ? message.text : '';
				if (message.role === 'user') {
					const content = [];
					const notes = [];
					const attachments = Array.isArray(message.attachments) ? message.attachments : [];
					const files = attachments.filter((item) => item.kind === 'text');
					const images = attachments.filter((item) => item.kind === 'image');
					if (files.length > 0) {
						const blocks = files.map((item) => `<file name="${item.name}">\n${typeof item.text === 'string' ? item.text : ''}\n</file>`).join('\n\n');
						content.push({ type: 'text', text: text === '' ? blocks : `${blocks}\n\n${text}` });
					} else if (text !== '') {
						content.push({ type: 'text', text });
					}
					for (const file of files) if (file.truncated === true) notes.push(t('textTruncated').replace('{name}', file.name));
					for (const image of images) {
						if (typeof image.data === 'string') content.push({ type: 'image', mediaType: image.mediaType, name: image.name, data: image.data });
						else notes.push(t('imageUnavailable').replace('{name}', image.name));
					}
					if (notes.length > 0) content.push({ type: 'text', text: notes.join('\n') });
					if (content.length > 0) messages.push({ role: 'user', content });
					continue;
				}
				if (text !== '') messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
			}
			/* Whatever the memory recalled rides in front of the question it answers. */
			if (typeof digest === 'string' && digest !== '' && messages.length > 0) {
				const last = messages[messages.length - 1];
				if (last.role === 'user') last.content.unshift({ type: 'text', text: digest });
			}
			return messages;
		}

		//#endregion

		//#region latex
		/**
		 * LaTeX math to MathML.
		 *
		 * The answers are LaTeX, and the page has no math library to import, so a
		 * subset of TeX is parsed here and emitted as MathML, which the browser lays
		 * out natively with the system math font. Everything the parser does not
		 * know degrades to the words it was spelled with instead of raw backslashes.
		 */

		/** Greek letters and letter-like symbols. */
		const TEX_LETTERS = {
			alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ',
			eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
			xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
			upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
			Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
			Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
			aleph: 'ℵ', beth: 'ℶ', hbar: 'ℏ', ell: 'ℓ', wp: '℘', Re: 'ℜ', Im: 'ℑ', imath: 'ı', jmath: 'ȷ',
			emptyset: '∅', varnothing: '∅', angle: '∠', triangle: '△', top: '⊤', bot: '⊥',
			infty: '∞', partial: '∂', nabla: '∇', Box: '□', Diamond: '◇', prime: '′', degree: '°',
		};
		/** Binary operators, relations, arrows, and delimiters that map to one glyph. */
		const TEX_SYMBOLS = {
			pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
			oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘', odot: '⊙', dagger: '†', ddagger: '‡',
			cap: '∩', cup: '∪', sqcap: '⊓', sqcup: '⊔', vee: '∨', wedge: '∧', setminus: '∖', smallsetminus: '∖',
			uplus: '⊎', amalg: '⨿', wr: '≀', diamond: '⋄', bigtriangleup: '△', bigtriangledown: '▽',
			le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡', sim: '∼', simeq: '≃',
			approx: '≈', cong: '≅', propto: '∝', ll: '≪', gg: '≫', subset: '⊂', supset: '⊃',
			subseteq: '⊆', supseteq: '⊇', subsetneq: '⊊', sqsubset: '⊏', sqsubseteq: '⊑', in: '∈',
			ni: '∋', notin: '∉', owns: '∋', prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰',
			perp: '⊥', parallel: '∥', mid: '∣', nmid: '∤', models: '⊨', vdash: '⊢', dashv: '⊣',
			forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', lor: '∨',
			to: '→', gets: '←', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Leftarrow: '⇐',
			Rightarrow: '⇒', Leftrightarrow: '⇔', mapsto: '↦', longrightarrow: '⟶', longleftarrow: '⟵',
			longleftrightarrow: '⟷', Longrightarrow: '⟹', Longleftarrow: '⟸', Longleftrightarrow: '⟺',
			uparrow: '↑', downarrow: '↓', updownarrow: '↕', Uparrow: '⇑', Downarrow: '⇓', Updownarrow: '⇕',
			nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖', hookrightarrow: '↪', hookleftarrow: '↩',
			ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…', dotsb: '⋯',
			langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
			lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']', vert: '|', Vert: '‖', lVert: '‖', rVert: '‖',
			backslash: '\\', colon: ':', therefore: '∴', because: '∵',
			clubsuit: '♣', diamondsuit: '♢', heartsuit: '♡', spadesuit: '♠', flat: '♭', natural: '♮', sharp: '♯',
			surd: '√', checkmark: '✓', S: '§', P: '¶', copyright: '©', pounds: '£', euro: '€',
			bracevert: '|', lgroup: '⟮', rgroup: '⟯', lmoustache: '⎰', rmoustache: '⎱',
		};
		/** Operators that take limits above and below in display style. */
		const TEX_BIG_OPERATORS = new Set([
			'sum', 'prod', 'coprod', 'int', 'oint', 'iint', 'iiint', 'bigcup', 'bigcap', 'bigvee', 'bigwedge',
			'bigoplus', 'bigotimes', 'bigodot', 'biguplus', 'bigsqcup',
		]);
		/** The glyph each big operator draws. */
		const TEX_BIG_OPERATOR_GLYPHS = {
			sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', oiint: '∯',
			bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀', bigoplus: '⨁', bigotimes: '⨂',
			bigodot: '⨀', biguplus: '⨄', bigsqcup: '⨆',
		};
		/** Named functions set upright, with limits when the name is a limit. */
		const TEX_FUNCTIONS = new Set([
			'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
			'coth', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'lim', 'limsup', 'liminf', 'max', 'min', 'sup',
			'inf', 'gcd', 'deg', 'arg', 'ker', 'hom', 'Pr', 'mod', 'bmod',
		]);
		/** Functions whose scripts sit under and over the name. */
		const TEX_LIMIT_FUNCTIONS = new Set(['lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'Pr']);
		/** Accents drawn above their argument. */
		const TEX_ACCENTS = {
			hat: 'ˆ', widehat: 'ˆ', bar: '¯', overline: '¯', vec: '⃗', tilde: '˜', widetilde: '˜',
			dot: '˙', ddot: '¨', acute: '´', grave: '`', check: 'ˇ', breve: '˘', mathring: '˚',
			overbrace: '⏞', underline: '_',
		};
		/** Horizontal spacing commands, in em. */
		const TEX_SPACES = {
			',': '0.167em', ':': '0.222em', ';': '0.278em', '!': '-0.167em', ' ': '0.25em',
			quad: '1em', qquad: '2em', thinspace: '0.167em', medspace: '0.222em', thickspace: '0.278em',
			enspace: '0.5em', negthinspace: '-0.167em', negmedspace: '-0.222em', negthickspace: '-0.278em',
		};
		/** Delimiter commands that may follow `\left` or `\right`. */
		const TEX_DELIMITERS = {
			'(': '(', ')': ')', '[': '[', ']': ']', '\\{': '{', '\\}': '}', '{': '{', '}': '}',
			'|': '|', '.': '', '\\|': '‖', '\\vert': '|', '\\Vert': '‖', '\\lvert': '|', '\\rvert': '|',
			'\\lVert': '‖', '\\rVert': '‖', '\\langle': '⟨', '\\rangle': '⟩', '\\lceil': '⌈',
			'\\rceil': '⌉', '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lbrace': '{', '\\rbrace': '}',
			'\\lbrack': '[', '\\rbrack': ']', '\\uparrow': '↑', '\\downarrow': '↓', '\\updownarrow': '↕',
			'\\Uparrow': '⇑', '\\Downarrow': '⇓', '\\Updownarrow': '⇕',
		};
		/** Environments rendered as a table of rows and cells. */
		const TEX_TABLE_ENVIRONMENTS = new Map([
			['matrix', 'matrix'], ['pmatrix', 'pmatrix'], ['bmatrix', 'bmatrix'], ['Bmatrix', 'Bmatrix'],
			['vmatrix', 'vmatrix'], ['Vmatrix', 'Vmatrix'], ['cases', 'cases'], ['array', 'matrix'],
			['aligned', 'aligned'], ['align', 'aligned'], ['align*', 'aligned'], ['alignedat', 'aligned'],
			['gather', 'gathered'], ['gathered', 'gathered'], ['split', 'aligned'], ['smallmatrix', 'matrix'],
			['subarray', 'matrix'], ['matrix*', 'matrix'],
		]);
		/** Variants requested by text-style commands, as Unicode alphabet offsets. */
		const TEX_ALPHABETS = {
			mathbf: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce, exceptions: {} },
			boldsymbol: { upper: 0x1d468, lower: 0x1d482, digit: 0x1d7ce, exceptions: {} },
			mathit: { upper: 0x1d434, lower: 0x1d44e, digit: 0x1d7ce, exceptions: { h: 0x210e } },
			mathbb: {
				upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8,
				exceptions: { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 },
			},
			mathcal: {
				upper: 0x1d49c, lower: 0x1d4b6, digit: 0x1d7ce,
				exceptions: {
					B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b,
					e: 0x212f, g: 0x210a, o: 0x2134,
				},
			},
			mathfrak: {
				upper: 0x1d504, lower: 0x1d51e, digit: 0x1d7ce,
				exceptions: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
			},
			mathsf: { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2, exceptions: {} },
			mathtt: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6, exceptions: {} },
		};

		/** Escape one text run for MathML output. */
		function escapeMathText(text) {
			return String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
		}

		/** Map one character onto the requested Unicode mathematical alphabet. */
		function alphabetCharacter(variant, character) {
			const alphabet = TEX_ALPHABETS[variant];
			if (alphabet === undefined) return character;
			const code = character.codePointAt(0);
			if (alphabet.exceptions[character] !== undefined) return String.fromCodePoint(alphabet.exceptions[character]);
			if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(alphabet.upper + code - 0x41);
			if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(alphabet.lower + code - 0x61);
			if (code >= 0x30 && code <= 0x39) return String.fromCodePoint(alphabet.digit + code - 0x30);
			return character;
		}

		/** Apply one alphabet variant to every code point of a text run. */
		function applyVariant(variant, text) {
			return [...text].map((character) => alphabetCharacter(variant, character)).join('');
		}

		/** Whether one code point is a digit or a decimal separator. */
		function isNumberText(text) {
			return /^[0-9.,]+$/.test(text);
		}

		/**
		 * Emit one identifier, number, or operator. Letters of any script become
		 * identifiers (so a lone Greek letter is italic, as in TeX), numbers become
		 * numbers, and everything else is an operator.
		 */
		function emitAtom(text) {
			if (text === '') return '';
			if (/^\p{L}+$/u.test(text)) return `<mi>${escapeMathText(text)}</mi>`;
			if (isNumberText(text)) return `<mn>${escapeMathText(text)}</mn>`;
			return `<mo>${escapeMathText(text)}</mo>`;
		}

		/** Emit a node list. */
		function emitNodes(nodes) {
			if (nodes.length === 0) return '<mrow></mrow>';
			if (nodes.length === 1) return nodes[0];
			return `<mrow>${nodes.join('')}</mrow>`;
		}

		/** Split a TeX string into tokens the parser walks. */
		function texTokens(source) {
			return [...source];
		}

		/** Whether a character ends a group, an alignment cell, or a row. */
		function isTexBoundary(source, index, stop) {
			const character = source[index];
			if (character === '}' && stop !== undefined && stop.has('}')) return true;
			if (character === '&' && stop !== undefined && stop.has('&')) return true;
			if (character === '\\' && source[index + 1] === '\\' && stop !== undefined && stop.has('\\\\')) return true;
			if (character === '\\' && source.startsWith('\\right', index) && stop !== undefined && stop.has('\\right')) return true;
			if (character === '\\' && source.startsWith('\\end', index) && stop !== undefined && stop.has('\\end')) return true;
			return false;
		}

		/**
		 * Read one mandatory or optional group.
		 * @param source - the whole expression.
		 * @param index - index of the opening character.
		 * @param opener - `{` or `[`.
		 * @returns the group's source text and the index just past it.
		 */
		function readGroup(source, index, opener = '{') {
			const closer = opener === '{' ? '}' : ']';
			let depth = 0;
			for (let cursor = index; cursor < source.length; cursor += 1) {
				const character = source[cursor];
				if (character === '\\') {
					cursor += 1;
					continue;
				}
				if (character === opener) depth += 1;
				else if (character === closer) {
					depth -= 1;
					if (depth === 0) return { body: source.slice(index + 1, cursor), next: cursor + 1 };
				}
			}
			return { body: source.slice(index + 1), next: source.length };
		}

		/** Read one argument: a group, a command, or a single character. */
		function readArgument(source, index) {
			let cursor = index;
			while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
			if (source[cursor] === '{') return readGroup(source, cursor, '{');
			if (source[cursor] === '\\') {
				const found = /^\\[A-Za-z]+/.exec(source.slice(cursor));
				if (found !== null) return { body: found[0], next: cursor + found[0].length, literal: true };
				return { body: source.slice(cursor, cursor + 2), next: cursor + 2, literal: true };
			}
			return { body: source.slice(cursor, cursor + 1), next: cursor + 1, literal: true };
		}

		/**
		 * Parse a TeX math string into MathML.
		 * @param source - the LaTeX between the delimiters.
		 * @param display - whether the expression is a display block.
		 * @returns the `<math>` markup.
		 */
		function texToMathML(source, display) {
			const state = { source, index: 0 };
			const nodes = parseTexList(state, undefined);
			const body = nodes.length === 0 ? '<mrow></mrow>' : emitNodes(nodes);
			return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display ? 'block' : 'inline'}">${body}</math>`;
		}

		/**
		 * Parse a run of TeX until a boundary the caller owns.
		 * @param state - source and cursor.
		 * @param stop - boundary markers that end this run.
		 * @returns emitted MathML nodes.
		 */
		function parseTexList(state, stop) {
			const nodes = [];
			const source = state.source;
			while (state.index < source.length) {
				if (isTexBoundary(source, state.index, stop)) break;
				const node = parseTexNode(state, stop);
				if (node === undefined) continue;
				attachScripts(state, node, nodes);
			}
			return nodes;
		}

		/** Attach a following `^` or `_` to the last node, or to an empty base. */
		function attachScripts(state, node, nodes) {
			let sup;
			let sub;
			const source = state.source;
			for (;;) {
				let cursor = state.index;
				while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
				if (source[cursor] !== '^' && source[cursor] !== '_') break;
				const marker = source[cursor];
				const argument = readArgument(source, cursor + 1);
				state.index = argument.next;
				const rendered = `<mrow>${parseTexList({ source: argument.body, index: 0 }, undefined).join('') || emitAtom(argument.body)}</mrow>`;
				if (marker === '^') sup = rendered;
				else sub = rendered;
			}
			if (sup === undefined && sub === undefined) {
				nodes.push(node);
				return;
			}
			nodes.push(buildScript(node, sub, sup));
		}

		/** Combine a base with its sub- and superscripts. */
		function buildScript(base, sub, sup) {
			if (sub !== undefined && sup !== undefined) return `<msubsup>${base}${sub}${sup}</msubsup>`;
			if (sub !== undefined) return `<msub>${base}${sub}</msub>`;
			return `<msup>${base}${sup}</msup>`;
		}

		/** Combine a base with under- and overscripts. */
		function buildLimits(base, under, over) {
			if (under !== undefined && over !== undefined) return `<munderover>${base}${under}${over}</munderover>`;
			if (under !== undefined) return `<munder>${base}${under}</munder>`;
			if (over !== undefined) return `<mover>${base}${over}</mover>`;
			return base;
		}

		/**
		 * Parse one TeX atom, consuming its arguments.
		 * @param state - source and cursor.
		 * @param stop - boundary markers owned by the caller.
		 * @returns one MathML node, or undefined when nothing was consumed.
		 */
		function parseTexNode(state, stop) {
			const source = state.source;
			const character = source[state.index];
			if (character === undefined) return undefined;
			if (/\s/.test(character)) {
				state.index += 1;
				return undefined;
			}
			if (character === '{') {
				const group = readGroup(source, state.index, '{');
				state.index = group.next;
				return emitNodes(parseTexList({ source: group.body, index: 0 }, undefined));
			}
			if (character === '}') {
				state.index += 1;
				return undefined;
			}
			if (character !== '\\') {
				state.index += 1;
				if (/[0-9.]/.test(character)) {
					let number = character;
					while (state.index < source.length && /[0-9.]/.test(source[state.index])) {
						number += source[state.index];
						state.index += 1;
					}
					return emitAtom(number);
				}
				return emitAtom(character);
			}
			/* A control sequence. */
			const name = /^\\([A-Za-z]+|.)/.exec(source.slice(state.index));
			if (name === null) {
				state.index += 1;
				return undefined;
			}
			const command = name[1];
			state.index += name[0].length;
			return commandNode(state, command, stop);
		}

		/**
		 * Render one control sequence.
		 * @param state - source and cursor, already past the command.
		 * @param command - the command name without its backslash.
		 * @param stop - boundary markers owned by the caller.
		 * @returns one MathML node, or undefined.
		 */
		function commandNode(state, command, stop) {
			const source = state.source;
			if (TEX_LETTERS[command] !== undefined) return emitAtom(TEX_LETTERS[command]);
			if (TEX_SYMBOLS[command] !== undefined) {
				const symbol = TEX_SYMBOLS[command];
				return /^[+\-=<>]$|^[±×÷⋅∘∗∪∩∧∨⊕⊗≤≥≠≈≡∼∝∈∉⊂⊃⊆⊇→←↔⇒⇐⇔↦]$/.test(symbol)
					? `<mo>${escapeMathText(symbol)}</mo>`
					: `<mi>${escapeMathText(symbol)}</mi>`;
			}
			if (TEX_SPACES[command] !== undefined) return `<mspace width="${TEX_SPACES[command]}"></mspace>`;
			if (TEX_BIG_OPERATORS.has(command)) {
				const symbol = TEX_BIG_OPERATOR_GLYPHS[command] ?? '∫';
				return `<mo largeop="true" movablelimits="true">${escapeMathText(symbol)}</mo>`;
			}
			if (TEX_FUNCTIONS.has(command)) {
				const name = command === 'bmod' ? 'mod' : command;
				return TEX_LIMIT_FUNCTIONS.has(name)
					? `<mo movablelimits="true" separator="false">${escapeMathText(name)}</mo>`
					: `<mi>${escapeMathText(name)}</mi>`;
			}
			if (command === 'frac' || command === 'dfrac' || command === 'tfrac' || command === 'cfrac') {
				const numerator = readArgument(source, state.index);
				state.index = numerator.next;
				const denominator = readArgument(source, state.index);
				state.index = denominator.next;
				return `<mfrac>${groupMarkup(numerator.body)}${groupMarkup(denominator.body)}</mfrac>`;
			}
			if (command === 'binom' || command === 'dbinom' || command === 'tbinom') {
				const top = readArgument(source, state.index);
				state.index = top.next;
				const bottom = readArgument(source, state.index);
				state.index = bottom.next;
				return `<mrow><mo>(</mo><mfrac linethickness="0">${groupMarkup(top.body)}${groupMarkup(bottom.body)}</mfrac><mo>)</mo></mrow>`;
			}
			if (command === 'sqrt') {
				let cursor = state.index;
				while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
				let index;
				if (source[cursor] === '[') {
					const optional = readGroup(source, cursor, '[');
					index = groupMarkup(optional.body);
					cursor = optional.next;
				}
				const body = readArgument(source, cursor);
				state.index = body.next;
				return index === undefined
					? `<msqrt>${groupMarkup(body.body)}</msqrt>`
					: `<mroot>${groupMarkup(body.body)}${index}</mroot>`;
			}
			if (TEX_ACCENTS[command] !== undefined) {
				const body = readArgument(source, state.index);
				state.index = body.next;
				const accent = TEX_ACCENTS[command];
				const inner = groupMarkup(body.body);
				if (command === 'underline' || command === 'underbrace') {
					return `<munder accentunder="true"><mrow>${inner}</mrow><mo>${escapeMathText(accent)}</mo></munder>`;
				}
				if (accent === '⃗') return `<mover accent="true"><mrow>${inner}</mrow><mo>→</mo></mover>`;
				return `<mover accent="true"><mrow>${inner}</mrow><mo>${escapeMathText(accent)}</mo></mover>`;
			}
			if (command === 'overline') {
				const body = readArgument(source, state.index);
				state.index = body.next;
				return `<mover accent="true"><mrow>${groupMarkup(body.body)}</mrow><mo>¯</mo></mover>`;
			}
			if (TEX_ALPHABETS[command] !== undefined) {
				const body = readArgument(source, state.index);
				state.index = body.next;
				const plain = texPlainText(body.body);
				return `<mi>${escapeMathText(applyVariant(command, plain))}</mi>`;
			}
			if (command === 'mathrm' || command === 'textrm' || command === 'text' || command === 'textnormal'
				|| command === 'operatorname' || command === 'mbox' || command === 'textup') {
				const body = readArgument(source, state.index);
				state.index = body.next;
				return `<mtext>${escapeMathText(texPlainText(body.body))}</mtext>`;
			}
			if (command === 'textbf' || command === 'textit' || command === 'textsf' || command === 'texttt') {
				const body = readArgument(source, state.index);
				state.index = body.next;
				const variant = { textbf: 'mathbf', textit: 'mathit', textsf: 'mathsf', texttt: 'mathtt' }[command];
				return `<mi>${escapeMathText(applyVariant(variant, texPlainText(body.body)))}</mi>`;
			}
			if (command === 'left') return parseLeftRight(state);
			if (command === 'right') return undefined;
			if (command === 'begin') return parseEnvironment(state);
			if (command === 'end') {
				const name = readArgument(source, state.index);
				state.index = name.next;
				return undefined;
			}
			if (command === 'limits' || command === 'nolimits' || command === 'displaystyle' || command === 'textstyle'
				|| command === 'scriptstyle' || command === 'scriptscriptstyle' || command === 'nonumber'
				|| command === 'notag' || command === 'label' || command === 'tag' || command === 'hspace'
				|| command === 'vspace' || command === 'phantom') {
				if (command === 'label' || command === 'tag' || command === 'hspace' || command === 'vspace') {
					readArgument(source, state.index);
					const argument = readArgument(source, state.index);
					state.index = argument.next;
				}
				return undefined;
			}
			if (command === 'not') {
				const argument = readArgument(source, state.index);
				state.index = argument.next;
				return `<menclose notation="updiagonalstrike"><mrow>${groupMarkup(argument.body)}</mrow></menclose>`;
			}
			if (command === 'pmod' || command === 'mod') {
				const body = readArgument(source, state.index);
				state.index = body.next;
				return `<mrow><mo>(</mo><mi>mod</mi><mspace width="0.278em"></mspace><mrow>${groupMarkup(body.body)}</mrow><mo>)</mo></mrow>`;
			}
			if (command === 'boxed') {
				const body = readArgument(source, state.index);
				state.index = body.next;
				return `<menclose notation="box"><mrow>${groupMarkup(body.body)}</mrow></menclose>`;
			}
			if (command === 'overset' || command === 'stackrel') {
				const over = readArgument(source, state.index);
				state.index = over.next;
				const base = readArgument(source, state.index);
				state.index = base.next;
				return `<mover>${groupMarkup(base.body)}${groupMarkup(over.body)}</mover>`;
			}
			if (command === 'underset') {
				const under = readArgument(source, state.index);
				state.index = under.next;
				const base = readArgument(source, state.index);
				state.index = base.next;
				return `<munder>${groupMarkup(base.body)}${groupMarkup(under.body)}</munder>`;
			}
			if (command === 'overrightarrow' || command === 'overleftarrow') {
				const body = readArgument(source, state.index);
				state.index = body.next;
				return `<mover accent="true"><mrow>${groupMarkup(body.body)}</mrow><mo>${command === 'overrightarrow' ? '→' : '←'}</mo></mover>`;
			}
			if (command === 'textcolor' || command === 'color' || command === 'class' || command === 'style') {
				let cursor = state.index;
				while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
				if (source[cursor] === '{') {
					const skipped = readGroup(source, cursor, '{');
					cursor = skipped.next;
				}
				state.index = cursor;
				return undefined;
			}
			if (command === 'substack') {
				const body = readArgument(source, state.index);
				state.index = body.next;
				const rows = body.body.split('\\\\').map((row) => `<mtr><mtd>${groupMarkup(row)}</mtd></mtr>`).join('');
				return `<mtable>${rows}</mtable>`;
			}
			if (command === 'hline' || command === 'hfill' || command === 'noalign') return undefined;
			if (command === '\\') return undefined;
			if (command === 'prime') return '<mo>′</mo>';
			/* Unknown: show the words rather than the backslash. */
			return `<mi>${escapeMathText(command)}</mi>`;
		}

		/** Render one group body as MathML, parsing it when it holds markup. */
		function groupMarkup(body) {
			if (body === undefined || body === '') return '<mrow></mrow>';
			const nodes = parseTexList({ source: body, index: 0 }, undefined);
			return nodes.length === 0 ? `<mi>${escapeMathText(body)}</mi>` : emitNodes(nodes);
		}

		/** The plain text inside a text-mode argument, with escapes resolved. */
		function texPlainText(body) {
			return body
				.replace(/\\([%&_#$@{}])/g, '$1')
				.replace(/\\textbackslash/g, '\\')
				.replace(/\\[A-Za-z]+\s?/g, '')
				.replace(/[{}]/g, '')
				.replace(/\s+/g, ' ')
				.trim();
		}

		/** Read one delimiter after `\left` or `\right`. */
		function readDelimiter(source, index) {
			let cursor = index;
			while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
			const character = source[cursor];
			if (character === undefined) return { glyph: '', next: cursor };
			if (character === '\\') {
				const name = /^\\([A-Za-z]+|.)/.exec(source.slice(cursor));
				if (name === null) return { glyph: '', next: cursor + 1 };
				const glyph = TEX_DELIMITERS[name[0]] ?? TEX_DELIMITERS[`\\${name[1]}`] ?? TEX_SYMBOLS[name[1]] ?? '';
				return { glyph, next: cursor + name[0].length };
			}
			return { glyph: TEX_DELIMITERS[character] ?? character, next: cursor + 1 };
		}

		/** Parse a `\left ... \right` pair into a stretchy-delimited row. */
		function parseLeftRight(state) {
			const left = readDelimiter(state.source, state.index);
			state.index = left.next;
			const inner = parseTexList(state, new Set(['\\right']));
			const right = state.source.startsWith('\\right', state.index)
				? readDelimiter(state.source, state.index + '\\right'.length)
				: { glyph: '', next: state.index };
			state.index = right.next;
			const open = left.glyph === '' ? '' : `<mo stretchy="true" fence="true" form="prefix">${escapeMathText(left.glyph)}</mo>`;
			const close = right.glyph === '' ? '' : `<mo stretchy="true" fence="true" form="postfix">${escapeMathText(right.glyph)}</mo>`;
			return `<mrow>${open}${emitNodes(inner)}${close}</mrow>`;
		}

		/** Parse a `\begin{env} ... \end{env}` block into an mtable. */
		function parseEnvironment(state) {
			const name = readArgument(state.source, state.index);
			state.index = name.next;
			const kind = TEX_TABLE_ENVIRONMENTS.get(name.body.trim()) ?? 'matrix';
			const source = state.source;
			const endMarker = `\\end{${name.body.trim()}}`;
			const endIndex = source.indexOf(endMarker, state.index);
			const body = endIndex === -1 ? source.slice(state.index) : source.slice(state.index, endIndex);
			state.index = endIndex === -1 ? source.length : endIndex + endMarker.length;
			const rows = body.split('\\\\').map((row) => row.trim()).filter((row) => row !== '');
			const cells = rows.map((row) => row.split('&').map((cell) => cell.trim()));
			const rendered = cells.map((row) => `<mtr>${row.map((cell) => `<mtd>${groupMarkup(cell)}</mtd>`).join('')}</mtr>`).join('');
			const table = `<mtable>${rendered}</mtable>`;
			if (kind === 'pmatrix') return `<mrow><mo>(</mo>${table}<mo>)</mo></mrow>`;
			if (kind === 'bmatrix') return `<mrow><mo>[</mo>${table}<mo>]</mo></mrow>`;
			if (kind === 'Bmatrix') return `<mrow><mo>{</mo>${table}<mo>}</mo></mrow>`;
			if (kind === 'vmatrix') return `<mrow><mo>|</mo>${table}<mo>|</mo></mrow>`;
			if (kind === 'Vmatrix') return `<mrow><mo>‖</mo>${table}<mo>‖</mo></mrow>`;
			if (kind === 'cases') return `<mrow><mo>{</mo>${table}</mrow>`;
			return table;
		}

		/**
		 * One rendered math expression.
		 * @param props - the TeX source, whether it is display math, and whether the
		 * wrapper must stay inline (a paragraph must not contain a block element).
		 * @returns the math element.
		 */
		function MathNode({ tex, display, inline }) {
			if (typeof tex !== 'string' || tex.trim() === '') return null;
			const element = inline === true ? 'span' : 'div';
			let markup;
			try {
				markup = texToMathML(tex, display === true);
			} catch {
				return React.createElement(element, { className: 'cm_mathFallback' }, tex);
			}
			return React.createElement(element, {
				className: display === true ? 'cm_math cm_mathBlock' : 'cm_math',
				'aria-label': tex,
				dangerouslySetInnerHTML: { __html: markup },
			});
		}
		//#endregion

		//#region decoding
		/**
		 * Decoding uploaded text.
		 *
		 * `File.text()` assumes UTF-8, so a GBK notebook, a Big5 source file, or a
		 * UTF-16 export arrived as mojibake — and a binary file arrived as noise.
		 * The bytes are decoded here instead: a byte-order mark wins, strict UTF-8
		 * wins next, then UTF-16 without a mark, then each CJK encoding, each
		 * candidate scored on how much of it reads as text. A file whose best
		 * reading is still noise is reported as binary rather than inlined.
		 */

		/** Legacy encodings worth trying when the bytes are not valid UTF-8. */
		const TEXT_ENCODINGS = ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'];

		/** Read one saved web page as the text it shows. */
		function htmlToText(source) {
			return source
				.replace(/<!--[\s\S]*?-->/g, ' ')
				.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
				.replace(/<br\s*\/?>/gi, '\n')
				.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table)>/gi, '\n')
				.replace(/<li\b[^>]*>/gi, '- ')
				.replace(/<[^>]*>/g, ' ')
				.replace(/&nbsp;|&#160;/g, ' ')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#39;|&apos;/g, "'")
				.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
				.replace(/&amp;/g, '&')
				.replace(/[ \t]{2,}/g, ' ')
				.replace(/\n{3,}/g, '\n\n')
				.split('\n')
				.map((line) => line.trim())
				.join('\n')
				.trim();
		}

		/** How much of one candidate decoding reads as real text, per character. */
		function textPlausibility(text) {
			if (text === '') return 0;
			let score = 0;
			let characters = 0;
			for (const character of text) {
				characters += 1;
				const code = character.codePointAt(0);
				if (code === 9 || code === 10 || code === 13) continue;
				if (code === 0xfffd || code < 32 || (code >= 0x7f && code <= 0x9f)) {
					score -= 6;
					continue;
				}
				if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
					score += 3;
					continue;
				}
				if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
					score += 2;
					continue;
				}
				if (code >= 32 && code <= 126) {
					score += 1;
					continue;
				}
				if (code >= 0x2000 && code <= 0x206f) {
					score += 1;
					continue;
				}
				if (code >= 0xa0 && code <= 0x2af) {
					score -= 1;
					continue;
				}
			}
			return score / Math.max(1, characters);
		}

		/** Decode bytes with one label, or undefined when they are not valid there. */
		function decodeStrict(bytes, label, skip = 0) {
			try {
				return new TextDecoder(label, { fatal: true }).decode(skip === 0 ? bytes : bytes.subarray(skip));
			} catch {
				return undefined;
			}
		}

		/**
		 * Decode one uploaded text file with the encoding it was actually written in.
		 * @param bytes - the file's bytes.
		 * @returns the text, the encoding used, and whether the bytes are binary.
		 */
		function decodeUploadText(bytes) {
			if (bytes.length === 0) return { text: '', encoding: 'utf-8', binary: false };
			if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
				return { text: decodeStrict(bytes, 'utf-8', 3) ?? '', encoding: 'utf-8', binary: false };
			}
			if (bytes[0] === 0xff && bytes[1] === 0xfe) {
				return { text: decodeStrict(bytes, 'utf-16le', 2) ?? '', encoding: 'utf-16le', binary: false };
			}
			if (bytes[0] === 0xfe && bytes[1] === 0xff) {
				return { text: decodeStrict(bytes, 'utf-16be', 2) ?? '', encoding: 'utf-16be', binary: false };
			}
			const utf8 = decodeStrict(bytes, 'utf-8');
			if (utf8 !== undefined && !utf8.includes('\u0000')) {
				const plausibility = textPlausibility(utf8);
				if (plausibility >= 0) return { text: utf8, encoding: 'utf-8', binary: false };
			}
			/* NUL bytes mean UTF-16 without a mark, or a binary file. */
			const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
			let evenNulls = 0;
			let oddNulls = 0;
			for (let index = 0; index < sample.length; index += 1) {
				if (sample[index] !== 0) continue;
				if (index % 2 === 0) evenNulls += 1;
				else oddNulls += 1;
			}
			if (evenNulls + oddNulls > sample.length / 8) {
				const little = oddNulls >= evenNulls;
				const text = decodeStrict(bytes, little ? 'utf-16le' : 'utf-16be') ?? '';
				if (text !== '' && textPlausibility(text) >= 0.4) {
					return { text, encoding: little ? 'utf-16le' : 'utf-16be', binary: false };
				}
				return { text: '', encoding: 'binary', binary: true };
			}
			let best = { text: undefined, encoding: 'binary', score: Number.NEGATIVE_INFINITY };
			for (const label of TEXT_ENCODINGS) {
				const text = decodeStrict(bytes, label);
				if (text === undefined) continue;
				const score = textPlausibility(text);
				if (score > best.score) best = { text, encoding: label, score };
			}
			if (best.text === undefined) return { text: '', encoding: 'binary', binary: true };
			if (best.score < 0.1) return { text: '', encoding: 'binary', binary: true };
			return { text: best.text, encoding: best.encoding, binary: false };
		}
		//#endregion

		//#region markdown
		/**
		 * Markdown and math rendering for answers.
		 *
		 * Answers are Markdown with LaTeX math. Blocks (fences, headings, lists,
		 * quotes, tables, display math) are recognized first, then inline spans
		 * (code, bold, italic, links, inline math). Anything unrecognized stays the
		 * text it was, so a half-streamed answer still reads.
		 */

		/** Escape one text run for HTML output inside a math block. */
		function escapeHtml(text) {
			return String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
		}

		/** Whether inline dollar math holds an expression rather than a price. */
		function looksLikeMath(body) {
			const trimmed = body.trim();
			if (trimmed === '') return false;
			if (/^[\d.,\s%]+$/.test(trimmed)) return false;
			if (/\\[A-Za-z]+/.test(trimmed)) return true;
			if (/[\^_{}=]/.test(trimmed)) return true;
			if (/^[A-Za-z]\s*[-+*/<>]\s*[A-Za-z0-9]+$/.test(trimmed)) return true;
			if (/^[A-Za-z]{1,4}\([^)]*\)$/.test(trimmed)) return true;
			if (/^[A-Za-z]\d*$/.test(trimmed)) return true;
			return trimmed.length <= 2 && /^[A-Za-z]+$/.test(trimmed);
		}

		/**
		 * Render one line's inline spans.
		 * @param text - the line.
		 * @param keyPrefix - node key prefix, unique per block.
		 * @returns React nodes.
		 */
		function renderInline(text, keyPrefix) {
			const nodes = [];
			const pattern = /(`+)([\s\S]*?)\1|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|\*([^*\n]+?)\*|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;
			let cursor = 0;
			let key = 0;
			let match = pattern.exec(text);
			while (match !== null) {
				if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
				const push = (element) => nodes.push(element);
				if (match[1] !== undefined) {
					push(React.createElement('code', { className: 'cm_inlineCode', key: `${keyPrefix}i${key++}` }, match[2].replace(/^\n|\n$/g, '')));
				} else if (match[3] !== undefined || match[4] !== undefined) {
					push(React.createElement(MathNode, { key: `${keyPrefix}m${key++}`, tex: match[3] ?? match[4], display: true, inline: true }));
				} else if (match[5] !== undefined || match[6] !== undefined) {
					const body = match[5] ?? match[6];
					if (looksLikeMath(body)) push(React.createElement(MathNode, { key: `${keyPrefix}m${key++}`, tex: body, display: false, inline: true }));
					else nodes.push(match[0]);
				} else if (match[7] !== undefined) {
					push(React.createElement('strong', { key: `${keyPrefix}b${key++}` }, match[7]));
				} else if (match[8] !== undefined) {
					push(React.createElement('del', { key: `${keyPrefix}s${key++}` }, match[8]));
				} else if (match[9] !== undefined) {
					push(React.createElement('em', { key: `${keyPrefix}e${key++}` }, match[9]));
				} else if (match[10] !== undefined) {
					push(React.createElement('a', { className: 'cm_link', key: `${keyPrefix}a${key++}`, href: match[11], target: '_blank', rel: 'noopener noreferrer' }, match[10] === '' ? match[11] : match[10]));
				} else if (match[12] !== undefined) {
					push(React.createElement('a', { className: 'cm_link', key: `${keyPrefix}a${key++}`, href: match[12], target: '_blank', rel: 'noopener noreferrer' }, match[12]));
				}
				cursor = pattern.lastIndex;
				match = pattern.exec(text);
			}
			if (cursor < text.length) nodes.push(text.slice(cursor));
			return nodes;
		}

		/** Render one paragraph body, keeping its own line breaks. */
		function paragraph(lines, key) {
			const nodes = [];
			lines.forEach((line, index) => {
				if (index > 0) nodes.push(React.createElement('br', { key: `br${index}` }));
				nodes.push(...renderInline(line, `p${key}-${index}-`));
			});
			return React.createElement('p', { className: 'cm_p', key }, nodes);
		}

		/** Render one fenced code block. */
		function codeBlock(language, body, key) {
			return React.createElement(
				'div',
				{ className: 'cm_codeBlock', key },
				language === '' ? null : React.createElement('div', { className: 'cm_codeLang' }, language),
				React.createElement('pre', { className: 'cm_code' }, React.createElement('code', null, body)),
			);
		}

		/** Render one `| a | b |` table. */
		function tableBlock(rows, key) {
			const header = rows[0];
			const body = rows.slice(1);
			const cell = (text, cellKey, tag) => React.createElement(tag, { key: cellKey, className: 'cm_tableCell' }, renderInline(text.trim(), `${cellKey}-`));
			return React.createElement(
				'div',
				{ className: 'cm_tableWrap', key },
				React.createElement(
					'table',
					{ className: 'cm_table' },
					React.createElement('thead', null, React.createElement('tr', null, header.map((text, index) => cell(text, `h${index}`, 'th')))),
					body.length === 0 ? null : React.createElement('tbody', null, body.map((row, rowIndex) => React.createElement(
						'tr',
						{ key: `r${rowIndex}` },
						header.map((_, index) => cell(row[index] ?? '', `c${rowIndex}-${index}`, 'td')),
					))),
				),
			);
		}

		/** Split one table row into its cells. */
		function tableCells(line) {
			return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
		}

		/**
		 * Render one answer as Markdown blocks.
		 * @param text - the accumulated answer text.
		 * @returns renderable React nodes.
		 */
		function renderRich(text) {
			const source = String(text ?? '');
			const lines = source.split('\n');
			const blocks = [];
			let index = 0;
			let key = 0;
			while (index < lines.length) {
				const line = lines[index];
				if (line.trim() === '') {
					index += 1;
					continue;
				}
				const fence = /^\s*(```+|~~~+)\s*([^\s`]*)\s*$/.exec(line);
				if (fence !== null) {
					const opener = fence[1][0].repeat(3);
					const body = [];
					index += 1;
					while (index < lines.length && !lines[index].trimStart().startsWith(opener)) {
						body.push(lines[index]);
						index += 1;
					}
					if (index < lines.length) index += 1;
					blocks.push(codeBlock(fence[2], body.join('\n'), key++));
					continue;
				}
				if (/^\s*\$\$/.test(line) || /^\s*\\\[/.test(line)) {
					const dollars = /^\s*\$\$/.test(line);
					const open = dollars ? '$$' : '\\[';
					const close = dollars ? '$$' : '\\]';
					let body = line.trim();
					if (body.startsWith(open)) body = body.slice(open.length);
					const inlineEnd = body.indexOf(close);
					if (inlineEnd !== -1) {
						body = body.slice(0, inlineEnd);
						index += 1;
					} else {
						const collected = [body];
						index += 1;
						while (index < lines.length && lines[index].indexOf(close) === -1) {
							collected.push(lines[index]);
							index += 1;
						}
						if (index < lines.length) {
							collected.push(lines[index].slice(0, lines[index].indexOf(close)));
							index += 1;
						}
						body = collected.join('\n');
					}
					blocks.push(React.createElement('div', { className: 'cm_mathWrap', key: key++ }, React.createElement(MathNode, { tex: body, display: true })));
					continue;
				}
				const bareEnvironment = /^\s*\\begin\{([A-Za-z*]+)\}/.exec(line);
				if (bareEnvironment !== null) {
					const endMarker = `\\end{${bareEnvironment[1]}}`;
					const collected = [line];
					index += 1;
					while (index < lines.length && !collected.join('\n').includes(endMarker)) {
						collected.push(lines[index]);
						index += 1;
					}
					blocks.push(React.createElement('div', { className: 'cm_mathWrap', key: key++ }, React.createElement(MathNode, { tex: collected.join('\n'), display: true })));
					continue;
				}
				if (/^\s*\\[A-Za-z]+/.test(line) && /[{^_\\]/.test(line)) {
					const collected = [line];
					index += 1;
					while (index < lines.length && /^\s*\\[A-Za-z]+/.test(lines[index]) && /[{^_\\]/.test(lines[index])) {
						collected.push(lines[index]);
						index += 1;
					}
					blocks.push(React.createElement('div', { className: 'cm_mathWrap', key: key++ }, React.createElement(MathNode, { tex: collected.join('\n'), display: true })));
					continue;
				}
				const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
				if (heading !== null) {
					const level = Math.min(6, heading[1].length);
					blocks.push(React.createElement(`h${level}`, { className: `cm_h cm_h${level}`, key: key++ }, renderInline(heading[2], `h${key}-`)));
					index += 1;
					continue;
				}
				if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
					blocks.push(React.createElement('hr', { className: 'cm_hr', key: key++ }));
					index += 1;
					continue;
				}
				if (/^\s*>/.test(line)) {
					const quoted = [];
					while (index < lines.length && /^\s*>/.test(lines[index])) {
						quoted.push(lines[index].replace(/^\s*>\s?/, ''));
						index += 1;
					}
					blocks.push(React.createElement('blockquote', { className: 'cm_quote', key: key++ }, renderRich(quoted.join('\n'))));
					continue;
				}
				const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
				if (bullet !== null) {
					const ordered = /\d/.test(bullet[1]);
					const items = [];
					while (index < lines.length) {
						const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
						if (item === null) break;
						const parts = [item[2]];
						index += 1;
						while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) {
							parts.push(lines[index].trim());
							index += 1;
						}
						items.push(React.createElement('li', { className: 'cm_li', key: `li${key}-${items.length}` }, renderInline(parts.join(' '), `li${key}-${items.length}-`)));
					}
					blocks.push(React.createElement(ordered ? 'ol' : 'ul', { className: 'cm_list', key: key++ }, items));
					continue;
				}
				if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
					const rows = [];
					rows.push(tableCells(line));
					index += 2;
					while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
						rows.push(tableCells(lines[index]));
						index += 1;
					}
					blocks.push(tableBlock(rows, key++));
					continue;
				}
				const paragraphLines = [];
				while (index < lines.length && lines[index].trim() !== ''
					&& !/^\s*(```+|~~~+|\$\$|\\\[|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[index])) {
					paragraphLines.push(lines[index]);
					index += 1;
				}
				if (paragraphLines.length === 0) {
					paragraphLines.push(lines[index]);
					index += 1;
				}
				blocks.push(paragraph(paragraphLines, key++));
			}
			return blocks;
		}
		//#endregion

		//#region pdf
		/**
		 * PDF text extraction for uploaded documents.
		 *
		 * The page has no PDF library to import, so this reads the file itself: it
		 * walks the object table, decodes the streams it needs with the platform's
		 * `DecompressionStream`, maps glyph codes through each font's `/ToUnicode`
		 * CMap, and replays the text operators of every page's content stream.
		 *
		 * Every step is tolerant: an unsupported filter, a composite font without a
		 * CMap, or a damaged object loses only what it covers, and a document whose
		 * text cannot be recovered reports that instead of inventing it (a scanned
		 * PDF has no text layer at all).
		 */

		/** Map every byte to the same code unit, so string offsets stay byte offsets. */
		function byteString(bytes) {
			let out = '';
			const step = 0x8000;
			for (let index = 0; index < bytes.length; index += step) {
				out += String.fromCharCode.apply(null, bytes.subarray(index, index + step));
			}
			return out;
		}

		/** Turn a one-byte-per-character string back into bytes. */
		function bytesOf(text) {
			const out = new Uint8Array(text.length);
			for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
			return out;
		}

		/** Decode bytes that carry single-byte text in the encoding PDFs usually use. */
		function singleByteText(bytes) {
			try {
				return new TextDecoder('windows-1252').decode(bytes);
			} catch {
				return byteString(bytes);
			}
		}

		/** How much of a candidate decoding reads as CJK script. */
		function cjkRatio(text) {
			if (text === '') return 0;
			let cjk = 0;
			for (const character of text) {
				const code = character.codePointAt(0);
				if (code >= 0x3400 && code <= 0x9fff || code >= 0xf900 && code <= 0xfaff || code >= 0x3040 && code <= 0x30ff) cjk += 1;
			}
			return cjk / [...text].length;
		}

		/**
		 * Decode one CMap-less font's bytes. Some producers embed Chinese text in a
		 * font declared `WinAnsiEncoding`, where the bytes are really GBK; when most
		 * bytes are high and a CJK decoding reads as real script, that decoding wins.
		 * @param bytes - the drawn bytes.
		 * @returns the decoded text.
		 */
		function decodeSingleByte(bytes) {
			const plain = singleByteText(bytes);
			if (bytes.length < 6) return plain;
			let high = 0;
			for (const byte of bytes) if (byte >= 0x80) high += 1;
			if (high / bytes.length <= 0.6) return plain;
			for (const label of ['gbk', 'big5', 'shift_jis']) {
				try {
					const candidate = new TextDecoder(label).decode(bytes);
					if (candidate !== plain && cjkRatio(candidate) > 0.5 && cjkRatio(candidate) > cjkRatio(plain)) return candidate;
				} catch {
					/* this build does not know the label */
				}
			}
			return plain;
		}

		/**
		 * Inflate zlib or raw deflate bytes with the platform's own decoder.
		 *
		 * PDF streams routinely carry padding after the compressed data, which the
		 * platform decoder reports as trailing junk and rejects. Reading the stream
		 * by hand keeps everything it produced before that point, which is the
		 * complete decoded data.
		 * @param bytes - the stored stream bytes.
		 * @returns the decoded bytes, or undefined when the framing is wrong.
		 */
		async function inflateBytes(bytes) {
			if (typeof DecompressionStream !== 'function') return undefined;
			for (const format of ['deflate', 'deflate-raw']) {
				let reader;
				try {
					reader = new Response(bytes).body.pipeThrough(new DecompressionStream(format)).getReader();
				} catch {
					continue;
				}
				const chunks = [];
				let total = 0;
				try {
					for (;;) {
						const { value, done } = await reader.read();
						if (done === true) break;
						if (value === undefined) continue;
						total += value.length;
						if (total > MAX_PDF_STREAM_BYTES) {
							await reader.cancel();
							break;
						}
						chunks.push(value);
					}
				} catch {
					/* trailing junk after the compressed data: everything read so far is the stream */
				}
				if (total > 0) {
					const out = new Uint8Array(total);
					let offset = 0;
					for (const chunk of chunks) {
						out.set(chunk, offset);
						offset += chunk.length;
					}
					return out;
				}
			}
			return undefined;
		}

		/** Decode `/ASCII85Decode` bytes. */
		function ascii85Bytes(text) {
			const body = text.replace(/^\s*<~/, '').replace(/~>\s*$/, '');
			const out = [];
			let group = [];
			const flush = () => {
				let value = 0;
				for (const digit of group) value = value * 85 + digit;
				out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
				group = [];
			};
			for (const character of body) {
				if (character === 'z' && group.length === 0) {
					out.push(0, 0, 0, 0);
					continue;
				}
				const digit = character.charCodeAt(0) - 33;
				if (digit < 0 || digit > 84) continue;
				group.push(digit);
				if (group.length === 5) flush();
			}
			if (group.length > 1) {
				while (group.length < 5) group.push(84);
				flush();
			}
			return new Uint8Array(out);
		}

		/** Decode `/ASCIIHexDecode` bytes. */
		function asciiHexBytes(text) {
			const clean = text.replace(/[^0-9A-Fa-f]/g, '');
			const out = new Uint8Array(Math.floor(clean.length / 2));
			for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
			return out;
		}

		/** Apply the filters a stream declares, in reverse (decode) order. */
		async function decodeStream(raw, filters) {
			let data = raw;
			for (const filter of [...filters].reverse()) {
				if (filter === 'FlateDecode' || filter === 'Fl') {
					const next = await inflateBytes(data);
					if (next === undefined) return undefined;
					data = next;
					continue;
				}
				if (filter === 'ASCII85Decode' || filter === 'A85') {
					data = ascii85Bytes(byteString(data));
					continue;
				}
				if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
					data = asciiHexBytes(byteString(data));
					continue;
				}
				return undefined;
			}
			if (filters.length === 0 && data.length > 2 && data[0] === 0x78) {
				const next = await inflateBytes(data);
				if (next !== undefined) return next;
			}
			return data;
		}

		/** The index just past one literal string `(...)`. */
		function skipLiteral(text, index) {
			let depth = 0;
			for (let cursor = index; cursor < text.length; cursor += 1) {
				const character = text[cursor];
				if (character === '\\') {
					cursor += 1;
					continue;
				}
				if (character === '(') depth += 1;
				else if (character === ')') {
					depth -= 1;
					if (depth === 0) return cursor + 1;
				}
			}
			return text.length;
		}

		/** The index just past the balanced `<<...>>`, `[...]`, or `(...)` at `index`. */
		function balancedEnd(text, index) {
			const opener = text[index];
			if (opener === '(') return skipLiteral(text, index);
			if (opener === '<' && text[index + 1] !== '<') {
				const stop = text.indexOf('>', index);
				return stop === -1 ? text.length : stop + 1;
			}
			const pair = opener === '[' ? [index, '[', ']'] : [index, '<<', '>>'];
			let depth = 0;
			for (let cursor = pair[0]; cursor < text.length - (pair[2].length - 1); cursor += 1) {
				const character = text[cursor];
				if (pair[2] === '>>') {
					if (character === '<' && text[cursor + 1] === '<') {
						depth += 1;
						cursor += 1;
						continue;
					}
					if (character === '>' && text[cursor + 1] === '>') {
						depth -= 1;
						cursor += 1;
						if (depth === 0) return cursor + 1;
					}
					continue;
				}
				if (character === '(') {
					cursor = skipLiteral(text, cursor) - 1;
					continue;
				}
				if (character === '<' && text[cursor + 1] === '<') {
					cursor = balancedEnd(text, cursor) - 1;
					continue;
				}
				if (character === '[') depth += 1;
				else if (character === ']') {
					depth -= 1;
					if (depth === 0) return cursor + 1;
				}
			}
			return text.length;
		}

		/**
		 * The one complete value that follows a dictionary key: a nested dictionary,
		 * an array, a literal string, a name, a reference, or a number. Reading only
		 * the token keeps the keys that follow it out of the value.
		 * @param dict - the dictionary's text.
		 * @param key - the key to read, without its slash.
		 * @returns the value text, or undefined when the key is absent.
		 */
		function valueAt(dict, key) {
			const found = new RegExp(`/${key}(?![A-Za-z0-9])`).exec(dict);
			if (found === null) return undefined;
			const rest = dict.slice(found.index + found[0].length);
			let index = 0;
			while (index < rest.length && /\s/.test(rest[index])) index += 1;
			const head = rest[index];
			if (head === undefined) return undefined;
			if (head === '<' || head === '[' || head === '(') return rest.slice(index, balancedEnd(rest, index));
			if (head === '/') {
				const name = /^\/[^\s/<>[\]()]+/.exec(rest.slice(index));
				return name === null ? undefined : name[0];
			}
			const reference = /^\d+\s+\d+\s+R(?![0-9])/.exec(rest.slice(index));
			if (reference !== null) return reference[0];
			const number = /^[+-]?[\d.]+/.exec(rest.slice(index));
			return number === null ? undefined : number[0];
		}

		/** A name value (`/Foo`) of one dictionary key. */
		function nameAt(dict, key) {
			const value = valueAt(dict, key);
			const found = value === undefined ? null : /^\/([^\s/<>[\]()]+)/.exec(value);
			return found === null ? undefined : found[1];
		}

		/** A direct-number value of one dictionary key. */
		function numberAt(dict, key) {
			const value = valueAt(dict, key);
			const found = value === undefined ? null : /^(\d+)/.exec(value);
			return found === null ? undefined : Number(found[1]);
		}

		/** An indirect reference (`12 0 R`) value of one dictionary key. */
		function refAt(dict, key) {
			const value = valueAt(dict, key);
			const found = value === undefined ? null : /^(\d+)\s+\d+\s+R(?![0-9])/.exec(value);
			return found === null ? undefined : Number(found[1]);
		}

		/** Every indirect reference inside one array-shaped dictionary value. */
		function refsAt(dict, key) {
			const value = valueAt(dict, key);
			if (value === undefined) return [];
			const body = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
			const refs = [];
			const pattern = /(\d+)\s+\d+\s+R(?![0-9])/g;
			let match = pattern.exec(body);
			while (match !== null) {
				refs.push(Number(match[1]));
				match = pattern.exec(body);
			}
			return refs;
		}

		/** The `<<...>>` body of one dictionary key, when it is inline. */
		function inlineDictAt(dict, key) {
			const value = valueAt(dict, key);
			return value !== undefined && value.startsWith('<<') && value.endsWith('>>') ? value.slice(2, -2) : undefined;
		}

		/** Filter names declared by a dictionary's `/Filter`, in declared order. */
		function filtersAt(dict) {
			const value = valueAt(dict, 'Filter');
			if (value === undefined) return [];
			const names = value.match(/\/([A-Za-z0-9]+)/g);
			return names === null ? [] : names.map((name) => name.slice(1));
		}

		/** Whether a stream holds raster data rather than page content. */
		function looksLikeImage(dict) {
			if (nameAt(dict, 'Subtype') === 'Image') return true;
			return filtersAt(dict).some((filter) => ['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode'].includes(filter));
		}

		/**
		 * Walk one PDF's object table.
		 * @param structure - the file as one-byte-per-character text.
		 * @returns objects in file order, each with its dictionary text and raw stream bytes.
		 */
		function scanObjects(structure) {
			const objects = [];
			const pattern = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
			let cursor = 0;
			let match = pattern.exec(structure);
			while (match !== null) {
				if (match.index < cursor) {
					match = pattern.exec(structure);
					continue;
				}
				const bodyStart = match.index + match[0].length;
				const endObject = structure.indexOf('endobj', bodyStart);
				const streamAt = structure.indexOf('stream', bodyStart);
				const hasStream = streamAt !== -1 && (endObject === -1 || streamAt < endObject) && structure.slice(bodyStart, streamAt).includes('>>');
				const dictEnd = hasStream ? streamAt : (endObject === -1 ? structure.length : endObject);
				const dict = structure.slice(bodyStart, dictEnd);
				let raw;
				let after = dictEnd;
				if (hasStream) {
					let dataStart = streamAt + 'stream'.length;
					if (structure[dataStart] === '\r') dataStart += 1;
					if (structure[dataStart] === '\n') dataStart += 1;
					/* An indirect `/Length 12 0 R` cannot be read here, so `endstream` locates the data. */
					const declared = refAt(dict, 'Length') === undefined ? numberAt(dict, 'Length') : undefined;
					const stop = structure.indexOf('endstream', dataStart);
					let length = declared === undefined ? -1 : declared;
					if (length < 0 || dataStart + length > structure.length || (stop !== -1 && dataStart + length > stop)) {
						length = stop === -1 ? structure.length - dataStart : stop - dataStart;
					}
					raw = bytesOf(structure.slice(dataStart, dataStart + length));
					after = dataStart + length;
				}
				objects.push({ number: Number(match[1]), dict, raw });
				cursor = after;
				match = pattern.exec(structure);
			}
			return objects;
		}

		/** Decode a UTF-16BE hex string from a CMap. */
		function unicodeFromHex(hex) {
			let out = '';
			for (let index = 0; index + 3 < hex.length + 1; index += 4) {
				const chunk = hex.slice(index, index + 4);
				if (chunk.length < 4) break;
				out += String.fromCharCode(Number.parseInt(chunk, 16));
			}
			return out === '' ? String.fromCharCode(Number.parseInt(hex, 16) || 0) : out;
		}

		/** Parse one `/ToUnicode` CMap into a code-to-text map. */
		function parseCMap(text) {
			const map = new Map();
			const characters = /beginbfchar([\s\S]*?)endbfchar/g;
			let block = characters.exec(text);
			while (block !== null) {
				const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
				let match = pair.exec(block[1]);
				while (match !== null) {
					map.set(Number.parseInt(match[1], 16), unicodeFromHex(match[2]));
					match = pair.exec(block[1]);
				}
				block = characters.exec(text);
			}
			const ranges = /beginbfrange([\s\S]*?)endbfrange/g;
			block = ranges.exec(text);
			while (block !== null) {
				const range = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
				let match = range.exec(block[1]);
				while (match !== null) {
					const low = Number.parseInt(match[1], 16);
					const high = Number.parseInt(match[2], 16);
					if (match[3] !== undefined) {
						const base = unicodeFromHex(match[3]);
						const last = base.charCodeAt(base.length - 1);
						for (let code = low; code <= high && code - low < 65536; code += 1) {
							map.set(code, base.slice(0, -1) + String.fromCharCode(last + (code - low)));
						}
					} else if (match[4] !== undefined) {
						const entries = match[4].match(/<[0-9A-Fa-f]+>/g) ?? [];
						entries.forEach((entry, offset) => {
							map.set(low + offset, unicodeFromHex(entry.slice(1, -1)));
						});
					}
					match = range.exec(block[1]);
				}
				block = ranges.exec(text);
			}
			return map;
		}

		/** Read one literal string `(...)` that starts at `index`. */
		function readLiteralString(content, index) {
			const bytes = [];
			let depth = 1;
			let cursor = index + 1;
			while (cursor < content.length) {
				const character = content[cursor];
				if (character === '\\') {
					const next = content[cursor + 1];
					cursor += 2;
					if (next === 'n') bytes.push(10);
					else if (next === 'r') bytes.push(13);
					else if (next === 't') bytes.push(9);
					else if (next === 'b') bytes.push(8);
					else if (next === 'f') bytes.push(12);
					else if (next === '\n') continue;
					else if (next === '\r') {
						if (content[cursor] === '\n') cursor += 1;
					} else if (next >= '0' && next <= '7') {
						let octal = next;
						while (octal.length < 3 && content[cursor] >= '0' && content[cursor] <= '7') {
							octal += content[cursor];
							cursor += 1;
						}
						bytes.push(Number.parseInt(octal, 8) & 0xff);
					} else bytes.push((next ?? '').charCodeAt(0) & 0xff);
					continue;
				}
				if (character === '(') depth += 1;
				else if (character === ')') {
					depth -= 1;
					if (depth === 0) return { bytes: new Uint8Array(bytes), next: cursor + 1 };
				}
				bytes.push(character.charCodeAt(0) & 0xff);
				cursor += 1;
			}
			return { bytes: new Uint8Array(bytes), next: content.length };
		}

		/** Read one hexadecimal string `<...>` that starts at `index`. */
		function readHexString(content, index) {
			const stop = content.indexOf('>', index);
			const body = stop === -1 ? content.slice(index + 1) : content.slice(index + 1, stop);
			const clean = body.replace(/[^0-9A-Fa-f]/g, '');
			const padded = clean.length % 2 === 0 ? clean : `${clean}0`;
			const bytes = new Uint8Array(padded.length / 2);
			for (let offset = 0; offset < bytes.length; offset += 1) bytes[offset] = Number.parseInt(padded.slice(offset * 2, offset * 2 + 2), 16);
			return { bytes, next: stop === -1 ? content.length : stop + 1 };
		}

		/** Decode one drawn string through the active font's CMap. */
		function decodeCodes(bytes, font) {
			if (font !== undefined && font.cmap !== undefined) {
				let out = '';
				if (font.twoByte === true) {
					for (let index = 0; index + 1 < bytes.length; index += 2) {
						out += font.cmap.get((bytes[index] << 8) | bytes[index + 1]) ?? '';
					}
				} else {
					for (const code of bytes) out += font.cmap.get(code) ?? '';
				}
				return out;
			}
			if (font !== undefined && font.twoByte === true) return '';
			return decodeSingleByte(bytes);
		}

		/**
		 * Replay one content stream's text operators.
		 * @param content - the decoded stream as one-byte-per-character text.
		 * @param fontFor - resolves one resource font name to its decoding facts.
		 * @returns the text the stream draws.
		 */
		function contentText(content, fontFor) {
			const out = [];
			let font;
			let stack = [];
			let index = 0;
			let lastY;
			const newline = () => {
				if (out.length > 0 && out[out.length - 1] !== '\n') out.push('\n');
			};
			while (index < content.length) {
				const character = content[index];
				if (character === '%') {
					const stop = content.indexOf('\n', index);
					index = stop === -1 ? content.length : stop + 1;
					continue;
				}
				if (character === '(') {
					const read = readLiteralString(content, index);
					stack.push({ bytes: read.bytes });
					index = read.next;
					continue;
				}
				if (character === '<' && content[index + 1] === '<') {
					index = balancedEnd(content, index);
					continue;
				}
				if (character === '<') {
					const read = readHexString(content, index);
					stack.push({ bytes: read.bytes });
					index = read.next;
					continue;
				}
				if (character === '[') {
					stack.push('[');
					index += 1;
					continue;
				}
				if (character === ']') {
					const items = [];
					while (stack.length > 0 && stack[stack.length - 1] !== '[') items.unshift(stack.pop());
					if (stack.length > 0) stack.pop();
					stack.push(items);
					index += 1;
					continue;
				}
				if (character === '/') {
					const found = /^\/([^\s/<>[\]()]+)/.exec(content.slice(index));
					stack.push({ name: found === null ? '' : found[1] });
					index += found === null ? 1 : found[0].length;
					continue;
				}
				if (character >= '0' && character <= '9' || character === '+' || character === '-' || character === '.') {
					const found = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(content.slice(index));
					if (found !== null) {
						stack.push(Number(found[0]));
						index += found[0].length;
						continue;
					}
					index += 1;
					continue;
				}
				const operator = /^[A-Za-z'"*]+/.exec(content.slice(index));
				if (operator === null) {
					index += 1;
					continue;
				}
				index += operator[0].length;
				const op = operator[0];
				if (op === 'ID') {
					const stop = content.indexOf('EI', index);
					index = stop === -1 ? content.length : stop + 2;
					stack = [];
					continue;
				}
				if (op === 'Tf') {
					const name = stack.find((value) => value !== null && typeof value === 'object' && value.name !== undefined);
					font = name === undefined ? undefined : fontFor(name.name);
				} else if (op === 'Tj' || op === "'" || op === '"') {
					if (op !== 'Tj') newline();
					const value = stack.filter((item) => item !== null && typeof item === 'object' && item.bytes !== undefined).pop();
					if (value !== undefined) out.push(decodeCodes(value.bytes, font));
				} else if (op === 'TJ') {
					const array = stack[stack.length - 1];
					if (Array.isArray(array)) {
						for (const item of array) {
							if (typeof item === 'number') {
								if (item <= -180) out.push(' ');
								continue;
							}
							if (item !== null && typeof item === 'object' && item.bytes !== undefined) out.push(decodeCodes(item.bytes, font));
						}
					}
				} else if (op === 'Td' || op === 'TD') {
					const numbers = stack.filter((item) => typeof item === 'number');
					const ty = numbers[numbers.length - 1];
					if (op === 'TD' || (ty !== undefined && ty !== 0)) newline();
				} else if (op === 'T*') {
					newline();
				} else if (op === 'Tm') {
					const numbers = stack.filter((item) => typeof item === 'number');
					const ty = numbers[numbers.length - 1];
					if (ty !== undefined && ty !== lastY) {
						newline();
						lastY = ty;
					}
				} else if (op === 'BT' || op === 'ET') newline();
				stack = [];
			}
			return out.join('');
		}

		/** Resolve the font resource names one page declares, walking up its parents. */
		function resourceFontsOf(page, byNumber) {
			let current = page;
			for (let hop = 0; hop < 8 && current !== undefined; hop += 1) {
				const dict = current.dict;
				const resources = inlineDictAt(dict, 'Resources') ?? (() => {
					const ref = refAt(dict, 'Resources');
					return ref === undefined ? undefined : byNumber.get(ref)?.dict;
				})();
				const fontDict = resources === undefined ? undefined : inlineDictAt(resources, 'Font');
				if (fontDict !== undefined) {
					const map = new Map();
					const pattern = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R(?![0-9])/g;
					let match = pattern.exec(fontDict);
					while (match !== null) {
						map.set(match[1], Number(match[2]));
						match = pattern.exec(fontDict);
					}
					return map;
				}
				const parent = refAt(dict, 'Parent');
				current = parent === undefined ? undefined : byNumber.get(parent);
			}
			return undefined;
		}

		/** Whether one extracted line is mostly decoding noise rather than text. */
		function looksLikeNoise(line) {
			if (line.length < 4) return false;
			let bad = 0;
			for (const character of line) {
				const code = character.codePointAt(0);
				if (code === 0xfffd || code >= 0x80 && code <= 0x9f || code < 32) bad += 1;
			}
			return bad / line.length > 0.4;
		}

		/** Tidy one page's extracted text, dropping lines that decoded into noise. */
		function cleanupPdfText(text) {
			const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim());
			const out = [];
			for (const line of lines) {
				if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
				if (looksLikeNoise(line)) continue;
				out.push(line);
			}
			while (out.length > 0 && out[out.length - 1] === '') out.pop();
			return out.join('\n');
		}

		/** How much of a candidate extraction reads as human text. */
		function textRatio(text) {
			if (text === '') return 0;
			let good = 0;
			for (const character of text) {
				const code = character.codePointAt(0);
				if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || (code >= 0x2000 && code <= 0x206f) || (code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) good += 1;
			}
			return good / [...text].length;
		}

		/**
		 * Read the objects one `/Type /ObjStm` stream contains.
		 * @param text - the decoded stream.
		 * @param dict - the stream's dictionary.
		 * @returns the contained objects, with their dictionary text.
		 */
		function objStmObjects(text, dict) {
			const count = numberAt(dict, 'N');
			const first = numberAt(dict, 'First');
			if (count === undefined || first === undefined) return [];
			const header = text.slice(0, first).match(/\d+/g) ?? [];
			const entries = [];
			for (let index = 0; index + 1 < header.length && entries.length < count; index += 2) {
				entries.push({ number: Number(header[index]), offset: Number(header[index + 1]) });
			}
			const objects = [];
			for (const [index, entry] of entries.entries()) {
				const start = first + entry.offset;
				const stop = index + 1 < entries.length ? first + entries[index + 1].offset : text.length;
				if (start < first || stop <= start) continue;
				objects.push({ number: entry.number, dict: text.slice(start, stop), raw: undefined });
			}
			return objects;
		}

		/**
		 * Report what the reader saw in one PDF, for diagnosis only.
		 * @param bytes - the whole file.
		 * @returns counts of the objects, streams, CMaps, fonts, and pages it found.
		 */
		async function pdfDiagnostics(bytes) {
			const structure = byteString(bytes);
			const objects = scanObjects(structure);
			const decoded = new Map();
			for (const object of objects) {
				if (object.raw === undefined || looksLikeImage(object.dict)) continue;
				const result = await decodeStream(object.raw, filtersAt(object.dict));
				if (result === undefined || result.length === 0 || result.length > MAX_PDF_STREAM_BYTES) continue;
				decoded.set(object.number, result);
			}
			const cmapNumbers = new Set();
			for (const [number, data] of decoded) {
				const text = byteString(data);
				if (text.includes('beginbfchar') || text.includes('beginbfrange')) cmapNumbers.add(number);
			}
			const cmaps = cmapNumbers.size;
			const failures = [];
			for (const object of objects) {
				if (object.raw === undefined || looksLikeImage(object.dict) || decoded.has(object.number)) continue;
				if (failures.length < 4) failures.push({ number: object.number, filters: filtersAt(object.dict).join('+'), raw: object.raw.length, head: [...object.raw.slice(0, 3)].join(',') });
			}
			const fonts = objects.filter((object) => nameAt(object.dict, 'Type') === 'Font' || object.dict.includes('/BaseFont')).length;
			const pages = objects.filter((object) => nameAt(object.dict, 'Type') === 'Page').length;
			const withText = objects.filter((object) => nameAt(object.dict, 'Type') === 'Page' && refsAt(object.dict, 'Contents').length > 0).length;

			return { header: structure.slice(0, 8), objects: objects.length, streams: objects.filter((object) => object.raw !== undefined).length, decoded: decoded.size, cmaps, fonts, pages, withText, failures };
		}

		/**
		 * Extract the text of one PDF.
		 * @param bytes - the whole file.
		 * @returns the text, its page count, or the reason it is unavailable.
		 */
		async function extractPdfText(bytes) {
			const structure = byteString(bytes);
			if (!structure.includes('%PDF-')) return { text: '', note: 'not-pdf' };
			if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(structure)) return { text: '', note: 'encrypted' };
			const objects = scanObjects(structure);
			if (objects.length === 0) return { text: '', note: 'unreadable' };
			const decoded = new Map();
			for (const object of objects) {
				if (object.raw === undefined || looksLikeImage(object.dict)) continue;
				const result = await decodeStream(object.raw, filtersAt(object.dict));
				if (result === undefined || result.length === 0 || result.length > MAX_PDF_STREAM_BYTES) continue;
				decoded.set(object.number, result);
			}
			const cmaps = new Map();
			for (const [number, data] of decoded) {
				const text = byteString(data);
				if (text.includes('beginbfchar') || text.includes('beginbfrange')) cmaps.set(number, parseCMap(text));
			}
			const merged = new Map();
			for (const map of cmaps.values()) for (const [code, value] of map) if (!merged.has(code)) merged.set(code, value);
			/* Many modern files keep their page and font dictionaries inside object streams. */
			const contained = [];
			for (const object of objects) {
				const data = decoded.get(object.number);
				if (data === undefined || nameAt(object.dict, 'Type') !== 'ObjStm') continue;
				contained.push(...objStmObjects(byteString(data), object.dict));
			}
			const byNumber = new Map();
			const fonts = new Map();
			for (const object of [...objects, ...contained]) {
				byNumber.set(object.number, object);
				if (nameAt(object.dict, 'Type') === 'Font' || object.dict.includes('/BaseFont')) {
					const toUnicode = refAt(object.dict, 'ToUnicode');
					fonts.set(object.number, {
						twoByte: nameAt(object.dict, 'Subtype') === 'Type0',
						cmap: toUnicode === undefined ? undefined : cmaps.get(toUnicode),
					});
				}
			}
			const pages = [];
			for (const object of [...objects, ...contained]) {
				if (nameAt(object.dict, 'Type') !== 'Page') continue;
				const resourceFonts = resourceFontsOf(object, byNumber);
				const fontFor = (name) => {
					const declared = resourceFonts?.get(name);
					const own = declared === undefined ? undefined : fonts.get(declared);
					if (own !== undefined) return own;
					return { twoByte: false };
				};
				const pieces = [];
				for (const ref of refsAt(object.dict, 'Contents')) {
					const data = decoded.get(ref);
					if (data === undefined) continue;
					const text = cleanupPdfText(contentText(byteString(data), fontFor));
					if (text !== '') pieces.push(text);
				}
				const text = pieces.join('\n');
				if (text !== '') pages.push(text);
			}
			if (pages.length === 0) {
				/* No usable page tree: replay every stream that draws text, through the merged CMap. */
				const fontFor = () => ({ twoByte: true, cmap: merged.size === 0 ? undefined : merged });
				for (const object of objects) {
					const data = decoded.get(object.number);
					if (data === undefined) continue;
					const content = byteString(data);
					if (!content.includes('BT') || !content.includes('Tj') && !content.includes('TJ')) continue;
					const text = cleanupPdfText(contentText(content, fontFor));
					if (text !== '') pages.push(text);
				}
			}
			const text = pages.join('\n\n');
			if (text.trim().length < 2) return { text: '', note: 'no-text', pages: pages.length };
			if (textRatio(text) < 0.75) return { text: '', note: 'unreadable', pages: pages.length };
			return { text, pages: pages.length };
		}
		//#endregion

		//#region notebooks
		/**
		 * Mathematica notebooks and sources.
		 *
		 * A `.nb` file is a text file of nested `Cell[...]` expressions whose input
		 * cells hold box markup (`RowBox[{"Plot", "[", ...}]`). Sending the raw file
		 * wastes the budget on styling boxes, so the input and prose cells are
		 * flattened into the code and text they display. Packages and scripts
		 * (`.wl`, `.wls`, `.m`) are ordinary source text and pass through unchanged.
		 */

		/** Slice the balanced `[...]`, `{...}`, or `(...)` that starts at `open`. */
		function balancedSlice(source, open) {
			const opener = source[open];
			const closer = opener === '[' ? ']' : opener === '{' ? '}' : ')';
			let depth = 0;
			let quoted = false;
			for (let cursor = open; cursor < source.length; cursor += 1) {
				const character = source[cursor];
				if (quoted) {
					if (character === '\\') {
						cursor += 1;
						continue;
					}
					if (character === '"') quoted = false;
					continue;
				}
				if (character === '"') {
					quoted = true;
					continue;
				}
				if (character === opener) depth += 1;
				else if (character === closer) {
					depth -= 1;
					if (depth === 0) return { body: source.slice(open + 1, cursor), end: cursor + 1 };
				}
			}
			return { body: source.slice(open + 1), end: source.length };
		}

		/** Split one cell body into its top-level arguments. */
		function topLevelArguments(body) {
			const parts = [];
			let depth = 0;
			let start = 0;
			let quoted = false;
			for (let cursor = 0; cursor < body.length; cursor += 1) {
				const character = body[cursor];
				if (quoted) {
					if (character === '\\') {
						cursor += 1;
						continue;
					}
					if (character === '"') quoted = false;
					continue;
				}
				if (character === '"') {
					quoted = true;
					continue;
				}
				if (character === '(' || character === '[' || character === '{') depth += 1;
				else if (character === ')' || character === ']' || character === '}') depth -= 1;
				else if (character === ',' && depth === 0) {
					parts.push(body.slice(start, cursor));
					start = cursor + 1;
				}
			}
			parts.push(body.slice(start));
			return parts.map((part) => part.trim()).filter((part) => part !== '');
		}

		/** Flatten Mathematica box markup into the text it displays. */
		function boxToCode(box) {
			let out = '';
			let cursor = 0;
			while (cursor < box.length) {
				const character = box[cursor];
				if (character === '"') {
					let value = '';
					let index = cursor + 1;
					while (index < box.length) {
						const inner = box[index];
						if (inner === '\\') {
							const next = box[index + 1];
							value += next === 'n' ? '\n' : next === 't' ? '\t' : next === '"' ? '"' : next === '\\' ? '\\' : next ?? '';
							index += 2;
							continue;
						}
						if (inner === '"') break;
						value += inner;
						index += 1;
					}
					out += value;
					cursor = index + 1;
					continue;
				}
				if (character === '\\' && box[cursor + 1] === '[') {
					const stop = box.indexOf(']', cursor);
					const name = stop === -1 ? '' : box.slice(cursor + 2, stop);
					out += /^[0-9A-Fa-f]{4}$/.test(name) ? String.fromCharCode(Number.parseInt(name, 16)) : '';
					cursor = stop === -1 ? box.length : stop + 1;
					continue;
				}
				if (character === ']' || character === '}') out += ' ';
				cursor += 1;
			}
			return out.replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').trim();
		}

		/**
		 * Read a Mathematica notebook or source as text.
		 * @param source - the file's text.
		 * @param extension - its lower-case extension.
		 * @param t - translator for the section headings.
		 * @returns the text to inline plus what it was built from.
		 */
		function mathematicaToText(source, extension, t) {
			if (extension !== 'nb') return { text: source };
			const input = [];
			const prose = [];
			let cursor = 0;
			let characters = 0;
			while (input.length + prose.length < 400 && characters < MAX_TEXT_CHARS) {
				const at = source.indexOf('Cell[', cursor);
				if (at === -1) break;
				const cell = balancedSlice(source, at + 'Cell'.length);
				cursor = cell.end;
				const args = topLevelArguments(cell.body);
				if (args.length === 0) continue;
				const style = /^"([^"]*)"$/.exec(args[args.length - 1])?.[1];
				const content = boxToCode((style === undefined ? args : args.slice(0, -1)).join(', '));
				if (content === '') continue;
				characters += content.length;
				if (style === 'Input' || style === 'Code' || style === 'Program' || style === 'InputOnly') input.push(content);
				else if (['Text', 'Title', 'Section', 'Subsection', 'Subsubsection', 'Item', 'ItemParagraph', 'Chapter'].includes(style)) prose.push(content);
			}
			if (input.length === 0 && prose.length === 0) return { text: source, note: 'raw' };
			const blocks = [`(${t('nbSummary').replace('{n}', String(input.length))})`];
			if (input.length > 0) blocks.push(`## ${t('nbInputs')}`, '```wolfram', input.join('\n\n'), '```');
			if (prose.length > 0) blocks.push(`## ${t('nbProse')}`, prose.join('\n\n'));
			return { text: blocks.join('\n'), cells: input.length + prose.length };
		}
		//#endregion

		//#region history
		/**
		 * Conversation history kept in this origin's own storage.
		 *
		 * Storage holds one JSON document: the conversation list, each with its
		 * messages and its model selection. The active conversation also lives in
		 * the panel's store, so a reload can reopen it; text attachments keep their
		 * extracted text (capped) and images keep a small thumbnail, so an old turn
		 * still reads correctly after a restart.
		 */

		/** The Web Storage object, or an in-memory stand-in when it is unavailable. */
		function historyStorage() {
			try {
				const probe = '__dsh_chat_mode_probe__';
				window.localStorage.setItem(probe, '1');
				window.localStorage.removeItem(probe);
				return window.localStorage;
			} catch {
				const map = new Map();
				return {
					getItem: (key) => (map.has(key) ? map.get(key) : null),
					setItem: (key, value) => {
						map.set(key, String(value));
					},
					removeItem: (key) => {
						map.delete(key);
					},
				};
			}
		}

		/** Whether one parsed record looks like a stored conversation. */
		function isStoredConversation(value) {
			return value !== null && typeof value === 'object' && typeof value.id === 'string' && Array.isArray(value.messages);
		}

		/**
		 * Rebuild one stored attachment into the shape the chips render. Records
		 * written by an older bundle, or truncated by a quota write, may miss any
		 * of these fields; a missing one must not take the panel down.
		 * @param item - the stored attachment.
		 * @param messageId - the message that owns it, for a fallback id.
		 * @param index - its position in the message, for a fallback id.
		 * @returns the normalized attachment, or null when it is unusable.
		 */
		function normalizeStoredAttachment(item, messageId, index) {
			if (item === null || typeof item !== 'object') return null;
			const kind = item.kind === 'image' ? 'image' : 'text';
			const id = typeof item.id === 'string' && item.id !== '' ? item.id : `${messageId}-a${index}`;
			const name = typeof item.name === 'string' && item.name !== '' ? item.name : (kind === 'image' ? 'image' : 'file');
			const base = {
				id,
				name,
				kind,
				bytes: Number.isFinite(item.bytes) ? item.bytes : 0,
				...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
				...(typeof item.memoryId === 'string' && item.memoryId !== '' ? { memoryId: item.memoryId } : {}),
			};
			if (kind === 'text') {
				return {
					...base,
					text: typeof item.text === 'string' ? item.text : '',
					...(item.truncated === true ? { truncated: true } : {}),
				};
			}
			return {
				...base,
				mediaType: typeof item.mediaType === 'string' && item.mediaType !== '' ? item.mediaType : 'image/png',
				...(typeof item.thumb === 'string' ? { thumb: item.thumb } : {}),
				...(typeof item.data === 'string' ? { data: item.data } : {}),
				pruned: item.data === undefined,
			};
		}

		/**
		 * Rebuild one stored message into the shape the thread renders.
		 * @param message - the stored message.
		 * @param index - its position in the conversation.
		 * @returns the normalized message, or null when it is unusable.
		 */
		function normalizeStoredMessage(message, index) {
			if (message === null || typeof message !== 'object') return null;
			const id = typeof message.id === 'string' && message.id !== ''
				? message.id
				: `m-restored-${Date.now().toString(36)}-${index}`;
			const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
				.map((item, position) => normalizeStoredAttachment(item, id, position))
				.filter((item) => item !== null);
			return {
				id,
				role: message.role === 'user' ? 'user' : 'assistant',
				text: typeof message.text === 'string' ? message.text : '',
				...(typeof message.reasoning === 'string' && message.reasoning !== '' ? { reasoning: message.reasoning } : {}),
				...(typeof message.status === 'string' ? { status: message.status } : {}),
				...(typeof message.error === 'string' ? { error: message.error } : {}),
				attachments,
			};
		}

		/**
		 * Normalize a whole restored conversation.
		 * @param messages - whatever the record carried.
		 * @returns messages the thread can render.
		 */
		function normalizeStoredMessages(messages) {
			return (Array.isArray(messages) ? messages : [])
				.map((message, index) => normalizeStoredMessage(message, index))
				.filter((message) => message !== null);
		}

		/**
		 * Read the stored conversation list.
		 * @param storage - the storage object.
		 * @returns the conversations, oldest first, and the last active id.
		 */
		function readHistory(storage) {
			try {
				const raw = storage.getItem(HISTORY_KEY);
				if (raw === null) return { conversations: [], activeId: null };
				const parsed = JSON.parse(raw);
				if (parsed?.version !== HISTORY_VERSION || !Array.isArray(parsed.conversations)) return { conversations: [], activeId: null };
				return {
					conversations: parsed.conversations.filter(isStoredConversation),
					activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
				};
			} catch {
				return { conversations: [], activeId: null };
			}
		}

		/**
		 * Write the conversation list, dropping the oldest entries until it fits.
		 * @param storage - the storage object.
		 * @param conversations - the whole list, oldest first.
		 * @param activeId - the conversation that was open.
		 * @returns whether the list survived intact, and what was actually stored.
		 */
		function writeHistory(storage, conversations, activeId) {
			let list = conversations.slice(-MAX_CONVERSATIONS);
			let intact = list.length === conversations.length;
			for (let attempt = 0; attempt < 6; attempt += 1) {
				const payload = JSON.stringify({ version: HISTORY_VERSION, activeId, conversations: list });
				if (payload.length <= MAX_STORED_CHARS || list.length <= 1) {
					try {
						storage.setItem(HISTORY_KEY, payload);
						return { ok: intact, conversations: list };
					} catch {
						/* the quota refuses it; drop more and try again */
					}
				}
				if (list.length <= 1) return { ok: false, conversations: list };
				list = list.slice(1);
				intact = false;
			}
			return { ok: false, conversations: list };
		}

		/** The title a conversation takes from its first user turn. */
		function titleOf(messages, fallback) {
			for (const message of messages) {
				if (message.role !== 'user') continue;
				const raw = typeof message.text === 'string' ? message.text : '';
				const text = raw.trim().replace(/\s+/g, ' ');
				if (text !== '') return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS)}…` : text;
				const named = message.attachments?.[0]?.name;
				if (named !== undefined) return named;
			}
			return fallback;
		}

		/** One attachment as it is stored, with its bulky payload capped. */
		function storedAttachment(item) {
			const base = {
				id: item.id,
				name: item.name,
				kind: item.kind,
				bytes: item.bytes,
				...(item.detail === undefined ? {} : { detail: item.detail }),
				...(typeof item.memoryId === 'string' && item.memoryId !== '' ? { memoryId: item.memoryId } : {}),
			};
			if (item.kind === 'text') {
				const text = typeof item.text === 'string' ? item.text : '';
				return {
					...base,
					text: text.slice(0, MAX_STORED_ATTACHMENT_CHARS),
					...(text.length > MAX_STORED_ATTACHMENT_CHARS ? { truncated: true } : {}),
				};
			}
			return {
				...base,
				mediaType: item.mediaType,
				...(typeof item.thumb === 'string' ? { thumb: item.thumb } : {}),
				pruned: true,
			};
		}

		/** One message as it is stored. */
		function storedMessage(message) {
			return {
				id: message.id,
				role: message.role,
				text: typeof message.text === 'string' ? message.text : '',
				...(typeof message.reasoning === 'string' && message.reasoning !== ''
					? { reasoning: message.reasoning.slice(0, MAX_STORED_REASONING_CHARS) }
					: {}),
				...(message.status === undefined ? {} : { status: message.status }),
				...(message.error === undefined || message.error === null ? {} : { error: message.error }),
				attachments: (message.attachments ?? []).map(storedAttachment),
			};
		}

		/** The list projection the history column renders. */
		function conversationSummaries(conversations) {
			return conversations.map((conversation) => ({
				id: conversation.id,
				title: conversation.title,
				updatedAt: conversation.updatedAt,
			})).sort((left, right) => right.updatedAt - left.updatedAt);
		}

		/** A compact age label for one conversation. */
		function relativeTime(timestamp, t) {
			const delta = Date.now() - timestamp;
			if (delta < 60_000) return t('timeNow');
			if (delta < 3_600_000) return t('timeMinutes').replace('{n}', String(Math.max(1, Math.round(delta / 60_000))));
			const date = new Date(timestamp);
			const today = new Date();
			if (date.toDateString() === today.toDateString()) {
				return t('timeToday').replace('{time}', `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
			}
			if (date.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return t('timeYesterday');
			return `${date.getMonth() + 1}/${date.getDate()}`;
		}

		/** A small JPEG thumbnail of one image, or undefined when drawing is unavailable. */
		async function makeThumbnail(blob) {
			try {
				if (typeof createImageBitmap !== 'function' || typeof document.createElement !== 'function') return undefined;
				const bitmap = await createImageBitmap(blob);
				const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(bitmap.width * scale));
				canvas.height = Math.max(1, Math.round(bitmap.height * scale));
				canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				bitmap.close?.();
				return canvas.toDataURL('image/jpeg', 0.65);
			} catch {
				return undefined;
			}
		}
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			panelHarness: 'Harness 模式',
			panelChat: 'DeepChat',
			title: 'DeepChat',
			brand: 'DeepChat',
			newChat: '新聊天',
			recent: '最近',
			searchChat: '搜索聊天',
			searchPlaceholder: '搜索聊天',
			searchEmpty: '没有找到对话',
			emptyTitle: '我们应该做些什么？',
			emptyIntro: '直接提问，或先上传文件。这里不调用工具，只和 DeepSeek 模型对话。',
			suggestion1: '用三句话解释什么是协程',
			suggestion2: '帮我写一封英文辞职邮件',
			suggestion3: '把这段 SQL 优化一下：SELECT * FROM orders WHERE user_id = 42',
			suggestion4: '总结一下量子纠缠的直觉理解',
			placeholder: '随心输入',
			send: '发送',
			stop: '停止生成',
			attach: '上传文件',
			defaultWorkspace: '默认工作区',
			thisComputer: '此计算机',
			workspaceTitle: '工作区',
			workspaceHint: '没有找到 Harness 的工作区列表，请打开 Harness 侧边栏再试。',
			removeFile: '移除附件',
			modelLabel: '模型',
			syncModels: '同步模型',
			effortLabel: '思考强度',
			chooseEffort: '选择强度',
			resetEffort: '恢复默认强度',
			boostEffort: '最高强度',
			effortDefault: '默认',
			thinking: '思考过程',
			thinkingDone: '已深度思考',
			thinkingNow: '正在思考…',
			stopped: '已停止',
			emptyAnswer: '模型没有返回内容，请重试。',
			noModel: '还没有可用的模型，请先在设置里登录或配置模型。',
			catalogFailed: '模型目录读取失败',
			retry: '重试',
			tooManyFiles: `一次最多上传 ${MAX_ATTACHMENTS} 个文件。`,
			imageTooLarge: '图片超过 8 MB，已跳过。',
			unsupported: '不支持的文件类型，已跳过：',
			emptyFile: '空文件已跳过：',
			clipped: '内容过长，已截断：',
			binaryFile: '这是二进制文件，无法作为文本读取，已跳过：',
			memory: '记忆体',
			memoryOn: '这会话会回忆记忆体（点击关闭）',
			memoryOff: '这会话不回忆记忆体（点击开启）',
			memorySaved: '已存入记忆体 {n} 项',
			memoryRestored: '已从记忆体恢复 {n} 个会话',
			memoryFailed: '记忆体写入失败（Superman 插件可能未启用）',
			memoryRecalled: '记忆体命中 {n} 项，已作为上下文',
			attached: '附件',
			you: '你',
			copy: '复制',
			copied: '已复制',
			dropHint: '松开即可上传文件',
			dropTitle: '上传到对话',
			history: '对话',
			historyEmpty: '还没有对话记录',
			historyShow: '显示对话记录',
			historyHide: '隐藏对话记录',
			historyDelete: '删除这条对话',
			groupToday: '今天',
			groupYesterday: '昨天',
			groupEarlier: '更早',
			more: '更多',
			deleteChat: '删除',
			timeNow: '刚刚',
			timeMinutes: '{n} 分钟前',
			timeToday: '今天 {time}',
			timeYesterday: '昨天',
			storageFailed: '对话记录写入失败：浏览器存储已满，最早的记录会被丢弃。',
			accountLabel: 'DeepSeek 账号',
			help: '帮助',
			aboutBody: 'DeepChat 是 DeepSeek Harness 的对话页；模型、插件与设置在 Harness 里管理。',
			openHarnessSettings: '打开 Harness 设置',
			settingsHint: '请先打开 Harness 的侧边栏，再点「设置」。',
			stateOn: '开',
			stateOff: '关',
			disclaimer: 'DeepChat 也可能会犯错，请核查重要信息。',
			crashTitle: 'DeepChat 遇到了一个问题',
			crashBody: '面板在渲染时出错，页面本身仍然可用。可以重新加载，或清空本地对话记录后重试。',
			reload: '重新加载',
			resetChat: '清空对话记录并重载',
			nbSummary: 'Mathematica 笔记本：已提取 {n} 个输入单元',
			nbInputs: '输入单元',
			nbProse: '文本单元',
			nbRaw: '笔记本结构未能解析，以下为原始文件内容',
			pdfPages: '页',
			pdfNoText: '这个 PDF 没有可提取的文字（可能是扫描件），可以改为上传页面截图。',
			pdfEncrypted: '这个 PDF 有密码保护，无法读取文字。',
			pdfUnreadable: '这个 PDF 的文字无法解析。',
			pdfTooLarge: 'PDF 超过 40 MB，已跳过。',
			pdfSparse: '（这份 PDF 每页能提取到的文字很少，可能是扫描件或文字已转曲；如果内容不完整，请上传页面截图）',
			pdfOcr: '（这份 PDF 没有文本层，以下内容由本机 OCR 识别，可能有错字）',
			imageUnavailable: '[图片 "{name}" 是更早一轮上传的，原图已不在本地缓存中，如需再次查看请重新上传]',
			textTruncated: '[附件 "{name}" 的历史内容在本地只保留了一部分]',
			chars: '字',
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			panelHarness: 'Harness mode',
			panelChat: 'DeepChat',
			title: 'DeepChat',
			brand: 'DeepChat',
			newChat: 'New chat',
			recent: 'Recent',
			searchChat: 'Search chats',
			searchPlaceholder: 'Search chats',
			searchEmpty: 'No chats found',
			emptyTitle: 'What should we build?',
			emptyIntro: 'Ask a question, or attach a file first. This mode calls no tools — it is a plain conversation with a DeepSeek model.',
			suggestion1: 'Explain coroutines in three sentences',
			suggestion2: 'Write a short resignation email',
			suggestion3: 'Optimize this SQL: SELECT * FROM orders WHERE user_id = 42',
			suggestion4: 'Give me an intuition for quantum entanglement',
			placeholder: 'Type anything',
			send: 'Send',
			stop: 'Stop generating',
			attach: 'Upload files',
			defaultWorkspace: 'Default workspace',
			thisComputer: 'This computer',
			workspaceTitle: 'Workspace',
			workspaceHint: 'No workspace list found. Open the Harness sidebar and try again.',
			removeFile: 'Remove attachment',
			modelLabel: 'Model',
			syncModels: 'Sync models',
			effortLabel: 'Thinking effort',
			chooseEffort: 'Choose effort',
			resetEffort: 'Reset to default effort',
			boostEffort: 'Boost effort',
			effortDefault: 'Default',
			thinking: 'Thinking',
			thinkingDone: 'Thought for a while',
			thinkingNow: 'Thinking…',
			stopped: 'Stopped',
			emptyAnswer: 'The model returned nothing. Try again.',
			noModel: 'No model is available yet. Sign in or configure one in Settings first.',
			catalogFailed: 'Could not read the model catalog',
			retry: 'Retry',
			tooManyFiles: `At most ${MAX_ATTACHMENTS} files per message.`,
			imageTooLarge: 'Image is larger than 8 MB and was skipped.',
			unsupported: 'Unsupported file type, skipped: ',
			emptyFile: 'Empty file skipped: ',
			clipped: 'Content was too long and was truncated: ',
			binaryFile: 'This is a binary file and cannot be read as text, so it was skipped: ',
			memory: 'Memory',
			memoryOn: 'This chat recalls the memory (click to turn off)',
			memoryOff: 'This chat does not recall the memory (click to turn on)',
			memorySaved: '{n} item(s) saved to the memory',
			memoryRestored: '{n} conversation(s) restored from the memory',
			memoryFailed: 'The memory could not be saved to (the Superman plugin may be off)',
			memoryRecalled: 'The memory matched {n} item(s); they were added as context',
			attached: 'Attachments',
			you: 'You',
			copy: 'Copy',
			copied: 'Copied',
			dropHint: 'Drop to upload',
			dropTitle: 'Upload to the conversation',
			history: 'Chats',
			historyEmpty: 'No conversations yet',
			historyShow: 'Show chat history',
			historyHide: 'Hide chat history',
			historyDelete: 'Delete this conversation',
			groupToday: 'Today',
			groupYesterday: 'Yesterday',
			groupEarlier: 'Earlier',
			more: 'More',
			deleteChat: 'Delete',
			timeNow: 'Just now',
			timeMinutes: '{n} min ago',
			timeToday: 'Today {time}',
			timeYesterday: 'Yesterday',
			storageFailed: 'Chat history could not be saved: this origin’s storage is full, so the oldest conversations are dropped.',
			accountLabel: 'DeepSeek account',
			help: 'Help',
			aboutBody: 'DeepChat is the conversation page of DeepSeek Harness; models, plugins, and settings are managed in Harness.',
			openHarnessSettings: 'Open Harness settings',
			settingsHint: 'Open the Harness sidebar, then use Settings.',
			stateOn: 'On',
			stateOff: 'Off',
			disclaimer: 'DeepChat can make mistakes. Check important info.',
			crashTitle: 'DeepChat hit a problem',
			crashBody: 'The panel failed while rendering; the rest of the page still works. Reload, or clear the local chat history and try again.',
			reload: 'Reload',
			resetChat: 'Clear chat history and reload',
			nbSummary: 'Mathematica notebook: {n} input cells extracted',
			nbInputs: 'Input cells',
			nbProse: 'Text cells',
			nbRaw: 'The notebook structure could not be parsed, so the raw file follows',
			pdfPages: 'pages',
			pdfNoText: 'This PDF has no extractable text (it may be a scan); upload page images instead.',
			pdfEncrypted: 'This PDF is password protected, so its text cannot be read.',
			pdfUnreadable: 'The text of this PDF could not be parsed.',
			pdfTooLarge: 'The PDF is larger than 40 MB and was skipped.',
			pdfSparse: '(This PDF has very little extractable text per page — it may be a scan or have outlined text; upload page images if content is missing.)',
			pdfOcr: '(This PDF has no text layer; the text below was recognised on this machine by OCR and may contain errors.)',
			imageUnavailable: '[image "{name}" was uploaded in an earlier turn and is no longer cached locally; upload it again to look at it once more]',
			textTruncated: '[only part of the earlier content of "{name}" is kept locally]',
			chars: 'chars',
		};
		//#endregion

		//#region controller
		/**
		 * Own the panel's conversations, attachments, and model route. One
		 * controller lives per slot entry, so switching panels keeps the thread,
		 * and the conversation list is mirrored into this origin's storage.
		 * @param ctx - the browser plugin context.
		 * @param t - translator bound to this plugin's namespace.
		 * @returns the store, the actions the panel calls, and the disposer.
		 */
		function createChat(ctx, t) {
			const store = createStore({
				messages: [],
				draft: '',
				attachments: [],
				selection: null,
				catalog: { status: 'idle', groups: [], failures: [], error: null },
				busy: false,
				notice: null,
				conversations: [],
				activeId: null,
				historyOpen: true,
				historyFailed: false,
				memoryOn: true,
				memoryStatus: null,
			});
			/** The composer's "remember" switch, kept per browser. */
			let memoryOn = true;
			try {
				memoryOn = window.localStorage.getItem(MEMORY_SWITCH_KEY) !== 'off';
			} catch {
				memoryOn = true;
			}
			const storage = historyStorage();
			/** The stored conversation list, oldest first; the open one is rebuilt on save. */
			let stored = [];
			/** The open conversation's id, or null while it is still empty. */
			let activeId = null;
			/** Coalesced store updates, so one token burst is one render. */
			let queue = [];
			let timer = null;
			/** The in-flight request, when an answer is streaming. */
			let request = null;
			/** Set while the controller is disposed, so a late frame changes nothing. */
			let disposed = false;
			/** Account of what was skipped while reading picked files. */
			let skipped = [];
			/** Pending history write. */
			let saveTimer = null;
			/** Whether the open conversation changed since the last write. */
			let unsaved = false;
			/** Memory upload counters for the composer's status line. */
			let memoryStored = 0;
			let memoryFailed = 0;
			/** How many conversations the memory handed back last time history was read. */
			let memoryRestored = 0;
			/** How many memory entries the last question recalled. */
			let recalledCount = 0;

			/** Publish every queued edit as one snapshot. */
			function drain() {
				timer = null;
				if (disposed || queue.length === 0) {
					queue = [];
					return;
				}
				const batch = queue;
				queue = [];
				store.update((draft) => {
					for (const mutate of batch) mutate(draft);
				});
			}

			/**
			 * Queue one snapshot edit; publishing waits at most one frame.
			 * @param mutate - draft editor.
			 */
			function schedule(mutate) {
				queue.push(mutate);
				if (timer === null) timer = window.setTimeout(drain, 24);
			}

			/** Publish immediately, for edits that end an interaction. */
			function flush() {
				if (timer !== null) {
					window.clearTimeout(timer);
					timer = null;
				}
				drain();
			}

			//#region history bookkeeping

			/** Publish the conversation list the history column renders. */
			function publishList() {
				store.update((draft) => {
					draft.conversations = conversationSummaries(stored);
					draft.activeId = activeId;
				});
			}

			/** Record the open conversation into the stored list and write it out. */
			function persist() {
				if (saveTimer !== null) {
					window.clearTimeout(saveTimer);
					saveTimer = null;
				}
				if (!unsaved || activeId === null || disposed) return;
				unsaved = false;
				const state = store.getSnapshot();
				const index = stored.findIndex((item) => item.id === activeId);
				const record = {
					id: activeId,
					title: titleOf(state.messages, t('newChat')),
					createdAt: index === -1 ? Date.now() : stored[index].createdAt,
					updatedAt: Date.now(),
					selection: state.selection,
					messages: state.messages.map(storedMessage),
				};
				const next = index === -1 ? [...stored, record] : stored.map((item, at) => (at === index ? record : item));
				const written = writeHistory(storage, next, activeId);
				stored = written.conversations;
				store.update((draft) => {
					draft.conversations = conversationSummaries(stored);
					draft.historyFailed = !written.ok;
				});
			}

			/** Ask for a write once the current interaction settles. */
			function persistSoon() {
				unsaved = true;
				if (saveTimer !== null) return;
				saveTimer = window.setTimeout(persist, 600);
			}

			/**
			 * Load the stored list and reopen the conversation that was open. The
			 * origin's `localStorage` is the fast copy; the memory is the durable one,
			 * so a conversation written on another port or in another browser is merged
			 * back in and cached locally.
			 */
			function restore() {
				store.update((draft) => {
					draft.memoryOn = memoryOn;
				});
				const loaded = readHistory(storage);
				stored = loaded.conversations;
				const wanted = loaded.activeId !== null && stored.some((item) => item.id === loaded.activeId)
					? loaded.activeId
					: (stored.length === 0 ? null : stored[stored.length - 1].id);
				if (wanted !== null) {
					const record = stored.find((item) => item.id === wanted);
					activeId = wanted;
					store.update((draft) => {
						draft.messages = normalizeStoredMessages(record.messages);
						draft.activeId = wanted;
						if (record.selection !== undefined && record.selection !== null) draft.selection = record.selection;
					});
				}
				publishList();
				void mergeMemoryHistory();
			}

			/**
			 * Add the conversations only the memory knows about — written on another
			 * port, in another browser, or before this origin's storage was cleared —
			 * to the list that is already on screen, and cache them locally.
			 */
			async function mergeMemoryHistory() {
				const fromMemory = await readMemoryConversations();
				if (fromMemory.length === 0) return;
				const byId = new Map(stored.map((item) => [item.id, item]));
				let adopted = 0;
				for (const record of fromMemory) {
					const local = byId.get(record.id);
					if (local === undefined || (record.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
						/* Every conversation the memory contributed counts, whether it filled a
						   gap on a fresh origin or replaced an older local copy. */
						adopted += 1;
						byId.set(record.id, record);
					}
				}
				if (byId.size === stored.length && adopted === 0) return;
				stored = [...byId.values()].sort((left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0));
				writeHistory(storage, stored, activeId);
				if (activeId !== null) {
					const record = stored.find((item) => item.id === activeId);
					if (record !== undefined && record.messages.length > store.getSnapshot().messages.length) {
						store.update((draft) => {
							draft.messages = normalizeStoredMessages(record.messages);
						});
					}
				}
				publishList();
				if (adopted > 0) {
					memoryRestored = adopted;
					store.update((draft) => {
						draft.memoryStatus = t('memoryRestored').replace('{n}', String(adopted));
					});
				}
			}

			/** Open a fresh, still empty conversation, keeping the previous one. */
			function newConversation() {
				persist();
				activeId = null;
				unsaved = false;
				if (request !== null) request.abort();
				store.update((draft) => {
					draft.messages = [];
					draft.draft = '';
					draft.attachments = [];
					draft.notice = null;
					draft.busy = false;
					draft.activeId = null;
				});
			}

			/**
			 * Reopen one stored conversation.
			 * @param id - the conversation to open.
			 */
			function openConversation(id) {
				if (id === activeId) return;
				persist();
				const record = stored.find((item) => item.id === id);
				if (record === undefined) return;
				activeId = id;
				unsaved = false;
				if (request !== null) request.abort();
				store.update((draft) => {
					draft.messages = normalizeStoredMessages(record.messages);
					draft.draft = '';
					draft.attachments = [];
					draft.notice = null;
					draft.busy = false;
					draft.activeId = id;
					if (record.selection !== undefined && record.selection !== null) draft.selection = record.selection;
				});
			}

			/**
			 * Forget one conversation.
			 * @param id - the conversation to delete.
			 */
			function deleteConversation(id) {
				const wasActive = id === activeId;
				if (wasActive && request !== null) request.abort();
				const next = stored.filter((item) => item.id !== id);
				const written = writeHistory(storage, next, wasActive ? null : activeId);
				stored = written.conversations;
				if (wasActive) activeId = null;
				unsaved = false;
				store.update((draft) => {
					draft.conversations = conversationSummaries(stored);
					draft.historyFailed = !written.ok;
					if (wasActive) {
						draft.messages = [];
						draft.draft = '';
						draft.attachments = [];
						draft.notice = null;
						draft.busy = false;
						draft.activeId = null;
					}
				});
			}

			/** Show or hide the history column. */
			function toggleHistory() {
				store.update((draft) => {
					draft.historyOpen = !draft.historyOpen;
				});
			}
			//#endregion

			/** Every model the catalog advertises, flattened with its provider. */
			function modelsOf(groups) {
				const models = [];
				for (const group of groups) {
					for (const model of group.models) models.push({ provider: group.id, providerName: group.name, model });
				}
				return models;
			}

			/** The catalog's own default when it is routable, otherwise the first model. */
			function preferredSelection(catalog) {
				const flat = modelsOf(catalog.groups ?? []);
				if (flat.length === 0) return null;
				const preferred = catalog.default;
				const match = preferred === undefined
					? undefined
					: flat.find((entry) => entry.provider === preferred.provider && entry.model.id === preferred.model);
				const chosen = match ?? flat[0];
				return {
					provider: chosen.provider,
					model: chosen.model.id,
					...(chosen.model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: chosen.model.reasoning.defaultEffort }),
				};
			}

			/** Whether one selection is still advertised by the live catalog. */
			function isRoutable(selection, catalog) {
				if (selection === null) return false;
				return modelsOf(catalog.groups ?? []).some((entry) => entry.provider === selection.provider && entry.model.id === selection.model);
			}

			/**
			 * Load the model catalog. A plain call fills an empty catalog; the
			 * panel's sync control passes `force` to re-read it after the Host
			 * has added, removed, or changed a model.
			 * @param options - `force: true` refreshes an already-loaded catalog.
			 */
			async function loadCatalog(options) {
				const force = options?.force === true;
				const status = store.getSnapshot().catalog.status;
				if (status === 'loading' || (!force && status === 'ready')) return;
				store.update((draft) => {
					draft.catalog = { ...draft.catalog, status: 'loading', error: null };
				});
				try {
					const response = await ctx.remote.session.modelCatalog();
					if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
					const value = response.value;
					store.update((draft) => {
						draft.catalog = {
							status: 'ready',
							groups: value.groups ?? [],
							failures: value.failures ?? [],
							error: null,
						};
						/* A restored conversation keeps its model when the catalog still offers it. */
						if (!isRoutable(draft.selection, value)) draft.selection = preferredSelection(value);
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					store.update((draft) => {
						draft.catalog = { ...draft.catalog, status: 'error', error: message };
					});
				}
			}

			/** Replace the draft text. */
			function setDraft(text) {
				store.update((draft) => {
					draft.draft = text;
				});
			}

			/**
			 * Choose a provider/model route, moving the effort to that model's own
			 * default so an unsupported effort is never sent.
			 * @param provider - provider route id.
			 * @param model - exact model id.
			 */
			function chooseModel(provider, model) {
				store.update((draft) => {
					const entry = modelsOf(draft.catalog.groups).find((item) => item.provider === provider && item.model.id === model);
					const defaultEffort = entry?.model.reasoning?.defaultEffort;
					draft.selection = {
						provider,
						model,
						...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
					};
				});
				persist();
			}

			/**
			 * Choose the reasoning effort for the current model.
			 * @param effort - effort id, or an empty string for the adapter default.
			 */
			function chooseEffort(effort) {
				store.update((draft) => {
					if (draft.selection === null) return;
					const next = { provider: draft.selection.provider, model: draft.selection.model };
					draft.selection = effort === '' ? next : { ...next, reasoningEffort: effort };
				});
				persist();
			}

			/** Explain why one PDF produced no text. */
			function pdfReason(note) {
				if (note === 'encrypted') return t('pdfEncrypted');
				if (note === 'no-text') return t('pdfNoText');
				if (note === 'not-pdf') return t('unsupported');
				return t('pdfUnreadable');
			}

			/**
			 * Put one upload into the Superman memory, without blocking the composer.
			 * @param input - name, media type, bytes, and any text already extracted.
			 */
			async function remember(input) {
				const value = await memoryCommand({
					action: 'store',
					name: input.name,
					mime: input.mime,
					base64: base64FromBytes(input.bytes),
					source: 'chat',
					origin: activeId ?? undefined,
					text: input.text,
				});
				memoryFailed += value === undefined ? 1 : 0;
				memoryStored += value === undefined ? 0 : 1;
				store.update((draft) => {
					draft.memoryStatus = memoryFailed > 0 ? t('memoryFailed') : t('memorySaved').replace('{n}', String(memoryStored));
				});
				return typeof value?.item?.id === 'string' ? value.item.id : undefined;
			}

			/**
			 * Mirror the open conversation into the memory twice: once as prose, so
			 * recall can find it, and once as a restorable payload, so the history
			 * survives a cleared origin, another port or another browser.
			 */
			async function rememberConversation() {
				const state = store.getSnapshot();
				if (state.activeId === null || state.messages.length === 0) return;
				const parts = [];
				for (const message of state.messages) {
					const body = (message.text ?? '').trim();
					if (body !== '') parts.push(`${message.role === 'user' ? t('you') : 'DeepSeek'}：${body}`);
				}
				const text = parts.join('\n\n');
				const title = titleOf(state.messages, t('newChat'));
				const tags = state.selection === null ? [] : [state.selection.model];
				await memoryCommand({
					action: 'note',
					note: {
						id: `chat:${state.activeId}`,
						kind: 'conversation',
						title,
						text: text.length > MAX_NOTE_CHARS ? text.slice(-MAX_NOTE_CHARS) : text,
						source: 'chat',
						tags,
					},
				});
				await memoryCommand({
					action: 'note',
					note: {
						id: `${MEMORY_CONVERSATION_PREFIX}${state.activeId}`,
						kind: 'conversation',
						title,
						text: restorablePayload(state, title),
						source: 'chat',
						tags,
					},
				});
			}

			/**
			 * Serialise a conversation small enough for one memory note, dropping the
			 * oldest turns until it fits. Attachments keep their names and sizes, the
			 * text of a file keeps a readable excerpt, and an image keeps the memory id
			 * that can bring its bytes back.
			 * @param state - the live snapshot.
			 * @param title - the conversation title.
			 * @returns the JSON payload.
			 */
			function restorablePayload(state, title) {
				const payload = {
					v: 1,
					title,
					updatedAt: Date.now(),
					selection: state.selection ?? null,
					messages: state.messages
						.filter((message) => message.status !== 'streaming')
						.filter((message) => (typeof message.text === 'string' && message.text.trim() !== '') || (message.attachments ?? []).length > 0)
						.map((message) => ({
							role: message.role,
							text: typeof message.text === 'string' ? message.text : '',
							attachments: (message.attachments ?? []).map((item) => ({
								name: item.name,
								kind: item.kind,
								bytes: item.bytes,
								mediaType: item.mediaType ?? null,
								thumb: item.thumb ?? null,
								detail: item.detail ?? null,
								memoryId: item.memoryId ?? null,
								...(item.kind === 'text' ? { text: (item.text ?? '').slice(0, 2000) } : {}),
							})),
						})),
				};
				let json = JSON.stringify(payload);
				while (json.length > MEMORY_PAYLOAD_CHARS && payload.messages.length > 1) {
					payload.messages.shift();
					json = JSON.stringify(payload);
				}
				if (json.length > MEMORY_PAYLOAD_CHARS) {
					for (const message of payload.messages) message.text = message.text.slice(0, 600);
					json = JSON.stringify(payload);
				}
				return json;
			}

			/**
			 * Read the conversations the memory kept, so history outlives the origin's
			 * `localStorage`.
			 * @returns the restorable conversations, oldest first.
			 */
			async function readMemoryConversations() {
				const value = await memoryCommand({ action: 'list' });
				const notes = Array.isArray(value?.notes) ? value.notes : [];
				const out = [];
				for (const note of notes) {
					if (typeof note?.id !== 'string' || !note.id.startsWith(MEMORY_CONVERSATION_PREFIX)) continue;
					if (typeof note.text !== 'string') continue;
					let payload;
					try {
						payload = JSON.parse(note.text);
					} catch {
						continue;
					}
					if (payload?.v !== 1 || !Array.isArray(payload.messages)) continue;
					out.push({
						id: note.id.slice(MEMORY_CONVERSATION_PREFIX.length),
						title: typeof payload.title === 'string' ? payload.title : note.title,
						updatedAt: Number(payload.updatedAt ?? note.updatedAt ?? Date.now()),
						selection: payload.selection ?? null,
						messages: payload.messages.map(restoredMessage),
					});
				}
				return out;
			}

			/** One message parsed back out of a memory payload. */
			function restoredMessage(input) {
				return {
					id: uid('m'),
					role: input?.role === 'assistant' ? 'assistant' : 'user',
					text: typeof input?.text === 'string' ? input.text : '',
					attachments: (Array.isArray(input?.attachments) ? input.attachments : []).map((item) => ({
						id: uid('a'),
						name: String(item?.name ?? ''),
						kind: item?.kind === 'image' ? 'image' : 'text',
						bytes: Number(item?.bytes ?? 0),
						...(typeof item?.mediaType === 'string' ? { mediaType: item.mediaType } : {}),
						...(typeof item?.thumb === 'string' ? { thumb: item.thumb } : {}),
						...(typeof item?.detail === 'string' ? { detail: item.detail } : {}),
						...(typeof item?.memoryId === 'string' && item.memoryId !== '' ? { memoryId: item.memoryId } : {}),
						...(typeof item?.text === 'string' ? { text: item.text } : {}),
					})),
				};
			}

			/**
			 * Ask the memory what relates to this question.
			 * @param question - the draft and recent context.
			 * @returns the digest to prepend, or an empty string.
			 */
			async function recall(question) {
				if (!memoryOn || question.trim() === '') return '';
				const value = await memoryCommand({ action: 'recall', q: question.slice(0, 600) });
				if (value === undefined || typeof value.digest !== 'string') return '';
				recalledCount = value.matches?.length ?? 0;
				return value.digest;
			}

			/** Turn the memory off or on, remembering the choice. */
			function toggleMemory() {
				memoryOn = !memoryOn;
				try {
					window.localStorage.setItem(MEMORY_SWITCH_KEY, memoryOn ? 'on' : 'off');
				} catch {
					/* a browser that refuses storage still keeps the switch for this session */
				}
				store.update((draft) => {
					draft.memoryOn = memoryOn;
					draft.memoryStatus = null;
				});
			}

			/**
			 * Read picked files into attachments, reporting what was skipped.
			 * @param files - a FileList or array of picked files.
			 */
			async function addFiles(files) {
				const picked = [...(files ?? [])];
				if (picked.length === 0) return;
				skipped = [];
				const next = [...store.getSnapshot().attachments];
				for (const file of picked) {
					if (next.length >= MAX_ATTACHMENTS) {
						skipped.push(t('tooManyFiles'));
						break;
					}
					if (file.size === 0) {
						skipped.push(`${t('emptyFile')}${file.name}`);
						continue;
					}
					const kind = classifyFile(file);
					const bytes = new Uint8Array(await file.arrayBuffer());
					if (kind === 'image') {
						const mediaType = (file.type || '').toLowerCase();
						if (!IMAGE_TYPES.has(mediaType)) {
							skipped.push(`${t('unsupported')}${file.name}`);
							continue;
						}
						if (file.size > MAX_IMAGE_BYTES) {
							skipped.push(`${file.name}: ${t('imageTooLarge')}`);
							continue;
						}
						const attachment = {
							id: uid('img'),
							name: file.name,
							kind: 'image',
							mediaType,
							bytes: file.size,
							data: base64FromBytes(bytes),
							thumb: await makeThumbnail(file),
							detail: formatBytes(file.size),
						};
						next.push(attachment);
						const storedId = await remember({ name: file.name, mime: mediaType, bytes });
						if (storedId !== undefined) attachment.memoryId = storedId;
						continue;
					}
					if (kind === 'pdf') {
						if (file.size > MAX_PDF_BYTES) {
							skipped.push(`${file.name}: ${t('pdfTooLarge')}`);
							continue;
						}
						let extracted = await extractPdfText(bytes);
						let recognised = false;
						if (extracted.text.trim() === '') {
							const seen = await readByOcr(bytes, file.name);
							if (seen === null) {
								skipped.push(`${file.name}: ${pdfReason(extracted.note)}`);
								continue;
							}
							extracted = { text: seen.text, pages: seen.pages, note: 'ocr' };
							recognised = true;
						}
						const clipped = extracted.text.length > MAX_TEXT_CHARS;
						const sparse = !recognised && extracted.pages >= 3 && extracted.text.length / extracted.pages < 60;
						const marker = recognised ? `${t('pdfOcr')}\n\n` : sparse ? `${t('pdfSparse')}\n\n` : '';
						next.push({
							id: uid('pdf'),
							name: file.name,
							kind: 'text',
							bytes: file.size,
							text: `${marker}${clipped ? extracted.text.slice(0, MAX_TEXT_CHARS) : extracted.text}`,
							detail: detailOf({ bytes: file.size, pages: extracted.pages, pageWord: t('pdfPages') }),
						});
						if (clipped) skipped.push(`${t('clipped')}${file.name}`);
						void remember({ name: file.name, mime: 'application/pdf', bytes, text: extracted.text });
						continue;
					}
					if (kind === 'text') {
						const extension = extensionOf(file.name);
						const decoded = decodeUploadText(bytes);
						if (decoded.binary) {
							skipped.push(`${t('binaryFile')}${file.name}`);
							continue;
						}
						const raw = decoded.text;
						if (raw.trim() === '') {
							skipped.push(`${t('emptyFile')}${file.name}`);
							continue;
						}
						const converted = MATHEMATICA_EXTENSIONS.has(extension)
							? mathematicaToText(raw, extension, t)
							: HTML_EXTENSIONS.has(extension) ? { text: htmlToText(raw) } : { text: raw };
						const clipped = converted.text.length > MAX_TEXT_CHARS;
						next.push({
							id: uid(extension === 'nb' ? 'nb' : 'txt'),
							name: file.name,
							kind: 'text',
							bytes: file.size,
							text: clipped ? converted.text.slice(0, MAX_TEXT_CHARS) : converted.text,
							detail: detailOf({ bytes: file.size, encoding: decoded.encoding, characters: converted.text.length, characterWord: t('chars') }),
						});
						if (clipped) skipped.push(`${t('clipped')}${file.name}`);
						void remember({ name: file.name, mime: file.type || '', bytes, text: converted.text });
						continue;
					}
					skipped.push(`${t('unsupported')}${file.name}`);
				}
				store.update((draft) => {
					draft.attachments = next;
					draft.notice = skipped.length === 0 ? null : skipped.join(' ');
				});
			}

			/**
			 * Drop one attachment.
			 * @param id - attachment id.
			 */
			function removeAttachment(id) {
				store.update((draft) => {
					draft.attachments = draft.attachments.filter((item) => item.id !== id);
				});
			}

			/** Stop the answer that is currently streaming. */
			function stop() {
				if (request !== null) request.abort();
			}

			/** Send the draft and stream the answer into a new assistant row. */
			async function send() {
				const state = store.getSnapshot();
				if (state.busy) return;
				if (state.selection === null) {
					store.update((draft) => {
						draft.notice = t('noModel');
					});
					return;
				}
				const text = state.draft.trim();
				if (text === '' && state.attachments.length === 0) return;
				if (activeId === null) activeId = uid('c');
				const user = { id: uid('u'), role: 'user', text, attachments: state.attachments };
				const answerId = uid('a');
				const history = [...state.messages, user];
				store.update((draft) => {
					draft.messages = [...history, { id: answerId, role: 'assistant', text: '', reasoning: '', status: 'streaming', error: null, attachments: [] }];
					draft.draft = '';
					draft.attachments = [];
					draft.notice = null;
					draft.busy = true;
					draft.activeId = activeId;
				});
				unsaved = true;
				const abort = new AbortController();
				request = abort;
				try {
					const digest = await recall(`${text}\n${state.messages.slice(-2).map((message) => message.text).join('\n')}`);
					if (digest !== '') {
						store.update((draft) => {
							draft.memoryStatus = t('memoryRecalled').replace('{n}', String(recalledCount));
						});
					}
					const response = await fetch(STREAM_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ ...state.selection, messages: wireMessages(await hydrate(history), t, digest) }),
						signal: abort.signal,
					});
					if (!response.ok) {
						let detail = `HTTP ${response.status}`;
						try {
							const parsed = await response.json();
							if (typeof parsed?.error?.message === 'string') detail = parsed.error.message;
						} catch {
							/* the status alone is the failure */
						}
						throw new Error(detail);
					}
					if (response.body === null) throw new Error(t('emptyAnswer'));
					await readFrames(response.body, (event) => {
						if (event.type === 'text') {
							schedule((draft) => patchMessage(draft, answerId, (message) => ({ ...message, text: message.text + event.text })));
							return;
						}
						if (event.type === 'reasoning') {
							schedule((draft) => patchMessage(draft, answerId, (message) => ({ ...message, reasoning: message.reasoning + event.text })));
							return;
						}
						if (event.type === 'error') {
							schedule((draft) => patchMessage(draft, answerId, (message) => ({ ...message, status: 'error', error: event.message })));
						}
					});
					schedule((draft) => {
						patchMessage(draft, answerId, (message) => {
							if (message.status === 'error') return message;
							if (message.text === '' && message.reasoning === '') return { ...message, status: 'error', error: t('emptyAnswer') };
							return { ...message, status: 'done' };
						});
						draft.busy = false;
					});
				} catch (error) {
					const aborted = abort.signal.aborted;
					const message = error instanceof Error ? error.message : String(error);
					schedule((draft) => {
						patchMessage(draft, answerId, (item) => (aborted
							? { ...item, status: 'stopped' }
							: { ...item, status: 'error', error: message }));
						draft.busy = false;
					});
				} finally {
					request = null;
					flush();
					persist();
					void rememberConversation();
				}
			}

			restore();

			return {
				store,
				dispose() {
					persist();
					disposed = true;
					if (request !== null) request.abort();
					if (timer !== null) window.clearTimeout(timer);
				},
				actions: {
					loadCatalog,
					refreshCatalog: () => loadCatalog({ force: true }),
					send,
					stop,
					newConversation,
					openConversation,
					deleteConversation,
					toggleHistory,
					toggleMemory,
					addFiles,
					removeAttachment,
					setDraft,
					chooseModel,
					chooseEffort,
				},
			};
		}
		//#endregion

		//#region components
		/** The DeepChat mark: a rounded chat glyph used in the rail and landing. */
		function BrandMark({ size = 26 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_brandMark', width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
				React.createElement('rect', { x: 1.2, y: 1.2, width: 21.6, height: 21.6, rx: 6.4, fill: 'currentColor' }),
				React.createElement('path', {
					d: 'M6.6 11.4c1.7-2.9 3.5-4.3 5.4-4.3 2.7 0 4.8 2 4.8 4.3s-2.1 4.3-4.8 4.3c-1.8 0-3.6-1.4-5.4-4.3Z',
					fill: 'var(--cm-mark-cut, #fff)',
				}),
				React.createElement('circle', { cx: 12.1, cy: 10.8, r: 0.9, fill: 'currentColor' }),
			);
		}

		/** Sidebar glyph for the agent (Harness) panel. */
		function HarnessPanelIcon({ size = 18 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('rect', { x: 3, y: 4.6, width: 18, height: 14.8, rx: 3.2, stroke: 'currentColor', strokeWidth: 1.5 }),
				React.createElement('path', { d: 'M7.4 10.2 9.8 12.4 7.4 14.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				React.createElement('path', { d: 'M12.3 14.8h4.3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
			);
		}

		/** Sidebar glyph for the DeepChat panel. */
		function ChatPanelIcon({ size = 18 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M20.2 12.1c0 3.6-3.6 6.5-8.1 6.5-.9 0-1.8-.1-2.6-.4l-4 1.6 1-3.2c-1.5-1.2-2.4-2.8-2.4-4.5 0-3.6 3.6-6.5 8-6.5s8.1 2.9 8.1 6.5Z',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinejoin: 'round',
				}),
			);
		}

		/** The rail glyph: a rounded panel with its left column marked. */
		function RailIcon({ size = 18 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('rect', { x: 3.2, y: 4.2, width: 17.6, height: 15.6, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
				React.createElement('path', { d: 'M9.6 4.6v14.8', stroke: 'currentColor', strokeWidth: 1.6 }),
			);
		}

		/** New chat: a pencil writing on a line (ChatGPT's compose glyph). */
		function PencilIcon({ size = 18 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M4.2 19.8h4.1L19.6 8.5a2.35 2.35 0 0 0-3.3-3.3L5 16.5v3.3Z',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinejoin: 'round',
				}),
				React.createElement('path', { d: 'M13.1 7.2 16.8 11', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
			);
		}

		/** Search glyph. */
		function SearchIcon({ size = 18 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('circle', { cx: 10.8, cy: 10.8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.7 }),
				React.createElement('path', { d: 'm15.4 15.4 4.2 4.2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
			);
		}

		/** Plus glyph for the composer's attachment control. */
		function PlusIcon({ size = 20 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M12 5.2v13.6M5.2 12h13.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
			);
		}

		/** Paperclip glyph for the attachment control. */
		function ClipIcon({ size = 20 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M18.2 11.4 11.6 18a4.1 4.1 0 0 1-5.8-5.8l7.3-7.3a2.9 2.9 0 0 1 4.1 4.1l-7.3 7.3a1.7 1.7 0 0 1-2.4-2.4l6.4-6.4',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			);
		}

		/** Up arrow for the send button. */
		function ArrowUpIcon({ size = 18 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M12 19V5.6M12 5.6 6.4 11.2M12 5.6l5.6 5.6', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			);
		}

		/** Filled square for the stop button. */
		function StopIcon({ size = 14 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
				React.createElement('rect', { x: 2.6, y: 2.6, width: 8.8, height: 8.8, rx: 1.4, fill: 'currentColor' }),
			);
		}

		/** Copy glyph for an assistant answer. */
		function CopyIcon({ size = 16 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('rect', { x: 9, y: 9, width: 10.6, height: 10.6, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.6 }),
				React.createElement('path', { d: 'M14.8 6.4V6a2.4 2.4 0 0 0-2.4-2.4H6A2.4 2.4 0 0 0 3.6 6v6.4A2.4 2.4 0 0 0 6 14.8h.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
			);
		}

		/** Check glyph confirming a copy. */
		function CheckIcon({ size = 16 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'm5.4 12.6 4.2 4.2 9-9.4', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			);
		}

		/** Refresh glyph for the model-catalog sync control. */
		function RefreshIcon({ size = 16 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M19.6 12a7.6 7.6 0 1 1-2.2-5.3M19.6 4.4v4.9h-4.9',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			);
		}

		/** Three ascending bars: the thinking-effort gauge. */
		function GaugeIcon({ size = 14 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M5 15.5v-3.2M10 15.5V9.4M15 15.5V5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
			);
		}

		/** The Codex-style cloud mark used above the empty-state greeting. */
		function CloudIcon({ size = 64 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 64 64', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M18.2 46.2a10.8 10.8 0 0 1-1.3-21.5 15.2 15.2 0 0 1 28.7-4.3 10.4 10.4 0 0 1 1.6 20.6',
					stroke: 'currentColor',
					strokeWidth: 2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
				React.createElement('path', {
					d: 'm25.4 32.8 5 5-5 5M33.4 42.8h6.4',
					stroke: 'currentColor',
					strokeWidth: 2.2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			);
		}

		/** Folder glyph for the composer's workspace chip. */
		function FolderIcon({ size = 14 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M2.8 6.2a1.6 1.6 0 0 1 1.6-1.6h3l1.7 1.8h6.5a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6V6.2Z',
					stroke: 'currentColor',
					strokeWidth: 1.4,
					strokeLinejoin: 'round',
				}),
			);
		}

		/** Monitor glyph for the composer's computer chip. */
		function MonitorIcon({ size = 14 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('rect', { x: 2.6, y: 3.6, width: 14.8, height: 10.2, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.4 }),
				React.createElement('path', { d: 'M7 16.4h6M10 13.8v2.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
			);
		}

		/** Lightning bolt above the effort slider. */
		function BoltIcon({ size = 18 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M11.2 2.8 4.6 11h4.6l-.4 6.2L15.4 9h-4.6l.4-6.2Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
			);
		}

		/** Counter-clockwise arrow resetting the effort to the model default. */
		function ResetIcon({ size = 16 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: 'M4.2 9.2a6 6 0 1 1 1.4 5.1M4.2 4.4v4.8h4.8',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			);
		}

		/** Question mark for the rail's help control. */
		function HelpIcon({ size = 17 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('circle', { cx: 10, cy: 10, r: 7.3, stroke: 'currentColor', strokeWidth: 1.5 }),
				React.createElement('path', { d: 'M8.1 7.5a2 2 0 1 1 2.8 1.9c-.6.3-.9.7-.9 1.4v.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
				React.createElement('circle', { cx: 10, cy: 14, r: 0.8, fill: 'currentColor' }),
			);
		}

		/**
		 * The Codex-style brand row: it names the app, shows the current model,
		 * and opens the model menu when clicked.
		 */
		function ModelMenu({ t, selected, options, disabled, onSelect, open, onOpenChange }) {
			const root = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) onOpenChange(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') onOpenChange(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);
			const value = selected === null ? '' : JSON.stringify([selected.provider, selected.model]);
			const current = options.find((option) => option.value === value);
			const items = [];
			for (let index = 0; index < options.length; index += 1) {
				const option = options[index];
				if (option.group !== undefined && (index === 0 || options[index - 1].group !== option.group)) {
					items.push(React.createElement('div', { key: `g-${option.group}`, className: 'cm_menuGroup' }, option.group));
				}
				items.push(React.createElement(
					'button',
					{
						key: option.value,
						type: 'button',
						role: 'menuitemradio',
						'aria-checked': option.value === value,
						className: option.value === value ? 'cm_menuItem cm_menuItemActive' : 'cm_menuItem',
						onClick: () => {
							onOpenChange(false);
							onSelect(option.value);
						},
					},
					React.createElement('span', { className: 'cm_menuCheck' }, option.value === value ? '✓' : ''),
					React.createElement(
						'span',
						{ className: 'cm_menuText' },
						React.createElement('span', { className: 'cm_menuLabel' }, option.label),
						option.description === undefined ? null : React.createElement('span', { className: 'cm_menuDesc' }, option.description),
					),
				));
			}
			return React.createElement(
				'div',
				{ className: 'cm_brandWrap', ref: root },
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'cm_brandBtn',
						disabled,
						title: t('modelLabel'),
						'aria-haspopup': 'menu',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => onOpenChange(!open),
					},
					React.createElement(BrandMark, { size: 26 }),
					React.createElement(
						'span',
						{ className: 'cm_brandText' },
						React.createElement('span', { className: 'cm_brandName' }, t('brand')),
						React.createElement('span', { className: 'cm_brandModel' }, current === undefined ? t('modelLabel') : current.label),
					),
					React.createElement(Chevron, { up: open }),
				),
				open
					? React.createElement('div', { className: 'cm_menu cm_brandMenu', role: 'menu', 'aria-label': t('modelLabel') }, items)
					: null,
			);
		}

		/**
		 * The Codex-style thinking-effort popover: a purple gradient drag bar
		 * above the "选择强度" control, with the current level and a reset button.
		 */
		function EffortPopup({ t, efforts, value, fallback, modelName, onChange, onReset, onOpenModel, onBoost, isBoosted }) {
			const [open, setOpen] = React.useState(false);
			const root = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);
			let index = efforts.findIndex((effort) => effort.id === value);
			if (index < 0) index = efforts.findIndex((effort) => effort.id === fallback);
			if (index < 0) index = 0;
			const current = efforts[index] ?? efforts[0];
			const label = current?.name ?? t('effortDefault');
			const fill = efforts.length <= 1 ? 100 : (index / (efforts.length - 1)) * 100;
			return React.createElement(
				'div',
				{ className: 'cm_effortPop', ref: root },
				React.createElement(
					'button',
					{
						type: 'button',
						className: open ? 'cm_effortBtn cm_effortBtnOn' : 'cm_effortBtn',
						title: t('effortLabel'),
						'aria-haspopup': 'dialog',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen((value_) => !value_),
					},
					React.createElement('span', null, t('chooseEffort')),
					React.createElement(Chevron, { up: open }),
				),
				open
					? React.createElement(
							'div',
							{ className: 'cm_effortCard', role: 'dialog', 'aria-label': t('effortLabel') },
							React.createElement(
								'div',
								{ className: 'cm_effortHead' },
								React.createElement(
									'button',
									{
										type: 'button',
										className: isBoosted ? 'cm_effortBolt cm_effortBoltOn' : 'cm_effortBolt',
										title: t('boostEffort'),
										'aria-label': t('boostEffort'),
										'aria-pressed': isBoosted ? 'true' : 'false',
										onClick: () => onBoost(),
									},
									React.createElement(BoltIcon, { size: 18 }),
								),
								React.createElement('span', { className: 'cm_effortName' }, label),
								React.createElement(
									'button',
									{ type: 'button', className: 'cm_effortReset', title: t('resetEffort'), 'aria-label': t('resetEffort'), onClick: () => onReset() },
									React.createElement(ResetIcon, { size: 16 }),
								),
							),
							React.createElement(
								'button',
								{ type: 'button', className: 'cm_effortModelBtn', title: t('modelLabel'), onClick: () => { setOpen(false); onOpenModel(); } },
								React.createElement('span', null, modelName),
								React.createElement(Chevron, { up: false }),
							),
							React.createElement(
								'div',
								{ className: 'cm_sliderWrap' },
								React.createElement(
									'div',
									{ className: 'cm_slider', style: { '--cm-fill': `${fill}%` } },
									React.createElement(
										'div',
										{ className: 'cm_sliderTrack' },
										React.createElement('div', { className: 'cm_sliderFill' }),
									),
									React.createElement('input', {
										type: 'range',
										className: 'cm_gradientSlider',
										min: 0,
										max: Math.max(0, efforts.length - 1),
										step: 1,
										value: index,
										'aria-label': t('effortLabel'),
										'aria-valuetext': label,
										disabled: efforts.length <= 1,
										onChange: (event) => {
											const next = efforts[Number(event.target.value)];
											if (next !== undefined) onChange(next.id);
										},
									}),
								),
							),
						)
					: null,
			);
		}

		/** Small chevron used by the pickers. */
		function Chevron({ up }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
				React.createElement('path', {
					d: up ? 'M2.5 7.5 6 4l3.5 3.5' : 'M2.5 4.5 6 8l3.5-3.5',
					stroke: 'currentColor',
					strokeWidth: 1.4,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					fill: 'none',
				}),
			);
		}

		/** Sparkle glyph standing for the memory. */
		function SparkleIcon({ size = 16 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M12 3.4c.6 4.6 2.6 6.6 7.2 7.2-4.6.6-6.6 2.6-7.2 7.2-.6-4.6-2.6-6.6-7.2-7.2 4.6-.6 6.6-2.6 7.2-7.2Z', fill: 'currentColor' }),
				React.createElement('path', { d: 'M18.6 15.4c.3 2 1.1 2.8 3 3.1-1.9.3-2.7 1.1-3 3.1-.3-2-1.1-2.8-3-3.1 1.9-.3 2.7-1.1 3-3.1Z', fill: 'currentColor', opacity: .55 }),
			);
		}

		/** Three dots for a conversation row's menu. */
		function MoreIcon({ size = 16 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
				React.createElement('circle', { cx: 5.4, cy: 12, r: 1.55, fill: 'currentColor' }),
				React.createElement('circle', { cx: 12, cy: 12, r: 1.55, fill: 'currentColor' }),
				React.createElement('circle', { cx: 18.6, cy: 12, r: 1.55, fill: 'currentColor' }),
			);
		}

		/** Trash glyph for the delete menu item. */
		function TrashIcon({ size = 15 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M4.6 6.6h14.8M9.4 6.4V4.8h5.2v1.6M6.6 6.8l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			);
		}

		/** Close glyph for the crash card's reload control. */
		function CloseIcon({ size = 16 }) {
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'm6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
			);
		}

		/** Bulb, code, compass, and pen glyphs for the landing cards. */
		function CardIcon({ kind, size = 18 }) {
			if (kind === 1) {
				return React.createElement(
					'svg',
					{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
					React.createElement('path', { d: 'M12 3.4a6.1 6.1 0 0 0-3.6 11l.7 2.3h5.8l.7-2.3A6.1 6.1 0 0 0 12 3.4Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
					React.createElement('path', { d: 'M9.6 20.2h4.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
				);
			}
			if (kind === 2) {
				return React.createElement(
					'svg',
					{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
					React.createElement('path', { d: 'm9 7.4-5.2 4.8L9 17M15 7.4 20.2 12 15 17', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				);
			}
			if (kind === 3) {
				return React.createElement(
					'svg',
					{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
					React.createElement('circle', { cx: 12, cy: 12, r: 8.4, stroke: 'currentColor', strokeWidth: 1.5 }),
					React.createElement('path', { d: 'm15.6 8.4-2 5.2-5.2 2 2-5.2 5.2-2Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
				);
			}
			return React.createElement(
				'svg',
				{ className: 'cm_svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M4.4 19.6h3.9L19.4 8.5a2.25 2.25 0 0 0-3.2-3.2L5.2 16.4v3.2Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
			);
		}

		/**
		 * One pill control with a popup list, the shape ChatGPT uses for its
		 * model menu.
		 * @param props - label, current value, options, and the selection callback.
		 * @returns the picker element.
		 */
		function Picker({ label, value, options, onSelect, disabled, className, below }) {
			const [open, setOpen] = React.useState(false);
			const root = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);
			const current = options.find((option) => option.value === value);
			const menuClass = below ? 'cm_menu cm_menuBelow' : 'cm_menu';
			return React.createElement(
				'div',
				{ className: className === undefined ? 'cm_picker' : `cm_picker ${className}`, ref: root },
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'cm_pill',
						disabled,
						title: label,
						'aria-label': label,
						'aria-haspopup': 'menu',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen((value_) => !value_),
					},
					React.createElement('span', { className: 'cm_pillLabel' }, current === undefined ? label : current.label),
					React.createElement(Chevron, { up: !below && open }),
				),
				open
					? React.createElement(
							'div',
							{ className: menuClass, role: 'menu', 'aria-label': label },
							options.length === 0
								? React.createElement('div', { className: 'cm_menuEmpty' }, label)
								: options.map((option, index) => React.createElement(
										React.Fragment,
										{ key: option.value },
										option.group !== undefined && (index === 0 || options[index - 1].group !== option.group)
											? React.createElement('div', { className: 'cm_menuGroup' }, option.group)
											: null,
										React.createElement(
											'button',
											{
												type: 'button',
												role: 'menuitemradio',
												'aria-checked': option.value === value,
												className: option.value === value ? 'cm_menuItem cm_menuItemActive' : 'cm_menuItem',
												onClick: () => {
													setOpen(false);
													onSelect(option.value);
												},
											},
											React.createElement('span', { className: 'cm_menuCheck' }, option.value === value ? '✓' : ''),
											React.createElement(
												'span',
												{ className: 'cm_menuText' },
												React.createElement('span', { className: 'cm_menuLabel' }, option.label),
												option.description === undefined
													? null
													: React.createElement('span', { className: 'cm_menuDesc' }, option.description),
											),
										),
									)),
						)
					: null,
			);
		}

		/**
		 * ChatGPT-style drag control for the model's thinking effort. The stops
		 * are the efforts the model itself advertises; dragging publishes that
		 * effort through the same `chooseEffort` action the old menu used.
		 */
		function EffortSlider({ t, efforts, value, fallback, onChange }) {
			let index = efforts.findIndex((effort) => effort.id === value);
			if (index < 0) index = efforts.findIndex((effort) => effort.id === fallback);
			if (index < 0) index = 0;
			const selected = efforts[index] ?? efforts[0];
			const label = selected?.name ?? t('effortDefault');
			const fill = efforts.length <= 1 ? 100 : (index / (efforts.length - 1)) * 100;
			return React.createElement(
				'div',
				{ className: 'cm_effort', title: `${t('effortLabel')}: ${label}` },
				React.createElement('span', { className: 'cm_effortIcon', 'aria-hidden': 'true' }, React.createElement(GaugeIcon, { size: 14 })),
				React.createElement('input', {
					type: 'range',
					className: 'cm_slider',
					min: 0,
					max: Math.max(0, efforts.length - 1),
					step: 1,
					value: index,
					style: { '--cm-fill': `${fill}%` },
					'aria-label': t('effortLabel'),
					'aria-valuetext': label,
					disabled: efforts.length <= 1,
					onChange: (event) => {
						const next = efforts[Number(event.target.value)];
						if (next !== undefined) onChange(next.id);
					},
				}),
				React.createElement('span', { className: 'cm_effortValue' }, label),
			);
		}

		/**
		 * The composer's workspace chip. It lists the workspaces the Harness
		 * sidebar exposes and switches by clicking the matching sidebar row, so
		 * the chip is real even though the DeepChat page has no workspace service
		 * of its own.
		 */
		function WorkspaceMenu({ t, name, onSelect }) {
			const [open, setOpen] = React.useState(false);
			const [names, setNames] = React.useState([]);
			const root = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);
			const toggle = () => {
				if (open) {
					setOpen(false);
					return;
				}
				const found = [];
				for (const element of document.querySelectorAll('button[aria-label]')) {
					const match = /^工作区“(.+)”的操作$/.exec(element.getAttribute('aria-label') || '');
					if (match !== null && !found.includes(match[1])) found.push(match[1]);
				}
				setNames(found);
				setOpen(true);
			};
			const switchTo = (target) => {
				setOpen(false);
				if (target === name) return;
				const row = [...document.querySelectorAll('[role="treeitem"]')]
					.find((element) => (element.textContent || '').trim() === target);
				if (row === undefined) {
					window.alert(t('workspaceHint'));
					return;
				}
				row.click();
				onSelect(target);
			};
			return React.createElement(
				'div',
				{ className: 'cm_workspaceWrap', ref: root },
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'cm_contextChip cm_contextChipButton',
						title: t('workspaceTitle'),
						'aria-haspopup': 'menu',
						'aria-expanded': open ? 'true' : 'false',
						onClick: toggle,
					},
					React.createElement(FolderIcon, { size: 14 }),
					React.createElement('span', null, name),
					React.createElement(Chevron, { up: open }),
				),
				open
					? React.createElement(
							'div',
							{ className: 'cm_workspaceCard', role: 'menu', 'aria-label': t('workspaceTitle') },
							React.createElement('div', { className: 'cm_workspaceTitle' }, t('workspaceTitle')),
							names.length === 0
								? React.createElement('div', { className: 'cm_workspaceEmpty' }, t('workspaceHint'))
								: names.map((candidate) => React.createElement(
										'button',
										{
											key: candidate,
											type: 'button',
											role: 'menuitemradio',
											'aria-checked': candidate === name,
											className: candidate === name ? 'cm_workspaceItem cm_workspaceItemActive' : 'cm_workspaceItem',
											onClick: () => switchTo(candidate),
										},
										React.createElement('span', { className: 'cm_workspaceCheck' }, candidate === name ? '✓' : ''),
										React.createElement('span', null, candidate),
									)),
						)
					: null,
			);
		}

		/** The rail avatar's account card: model, memory state, Harness settings. */
		function AccountMenu({ t, modelName, memoryOn, onOpenSettings }) {
			const [open, setOpen] = React.useState(false);
			const root = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);
			return React.createElement(
				'div',
				{ className: 'cm_accountWrap', ref: root },
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'cm_accountBtn',
						title: t('accountLabel'),
						'aria-label': t('accountLabel'),
						'aria-haspopup': 'dialog',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen((value) => !value),
					},
					React.createElement('span', { className: 'cm_accountAvatar', 'aria-hidden': 'true' }, 'DS'),
				),
				open
					? React.createElement(
							'div',
							{ className: 'cm_accountCard', role: 'dialog', 'aria-label': t('accountLabel') },
							React.createElement('div', { className: 'cm_accountTitle' }, t('accountLabel')),
							React.createElement('div', { className: 'cm_accountMeta' }, modelName),
							React.createElement('div', { className: 'cm_accountMeta' }, `${t('memory')} · ${memoryOn ? t('stateOn') : t('stateOff')}`),
							React.createElement(
								'button',
								{ type: 'button', className: 'cm_accountAction', onClick: () => { setOpen(false); onOpenSettings(); } },
								t('openHarnessSettings'),
							),
						)
					: null,
			);
		}

		/** One attachment chip inside a user bubble or the composer. */
		function AttachmentChip({ item, t, onRemove, compact }) {
			const preview = item.kind === 'image'
				? (typeof item.data === 'string' ? `data:${item.mediaType};base64,${item.data}` : item.thumb)
				: undefined;
			const glyph = item.kind === 'image' ? 'IMG' : extensionOf(item.name) === 'nb' ? 'NB' : 'TXT';
			return React.createElement(
				'div',
				{ className: compact ? 'cm_chip cm_chipCompact' : 'cm_chip' },
				preview === undefined
					? React.createElement('span', { className: 'cm_chipGlyph', 'aria-hidden': 'true' }, glyph)
					: React.createElement('img', { className: 'cm_chipImage', src: preview, alt: item.name }),
				React.createElement(
					'span',
					{ className: 'cm_chipBody' },
					React.createElement('span', { className: 'cm_chipName', title: item.name }, item.name),
					React.createElement('span', { className: 'cm_chipMeta' }, item.detail ?? formatBytes(item.bytes)),
				),
				onRemove === undefined
					? null
					: React.createElement(
							'button',
							{ type: 'button', className: 'cm_chipRemove', title: t('removeFile'), 'aria-label': `${t('removeFile')}: ${item.name}`, onClick: () => onRemove(item.id) },
							React.createElement(CloseIcon, { size: 12 }),
						),
			);
		}

		/** Render an answer's Markdown, falling back to plain text if a block throws. */
		function safeRich(text) {
			try {
				return renderRich(text);
			} catch (error) {
				try {
					console.error('[deepchat] answer rendering failed:', error);
				} catch {
					/* logging is best effort */
				}
				return React.createElement('pre', { className: 'cm_textFallback' }, text);
			}
		}

		/** One turn in the thread; memoized so only the streaming row re-renders. */
		const MessageRow = React.memo(function MessageRow({ message, t }) {
			const [copied, setCopied] = React.useState(false);
			const attachments = Array.isArray(message.attachments) ? message.attachments : [];
			const text = typeof message.text === 'string' ? message.text : '';
			if (message.role === 'user') {
				return React.createElement(
					'div',
					{ className: 'cm_row cm_userRow' },
					React.createElement(
						'div',
						{ className: 'cm_userStack' },
						attachments.length === 0
							? null
							: React.createElement(
									'div',
									{ className: 'cm_chipRow' },
									attachments.map((item) => React.createElement(AttachmentChip, { key: item.id, item, t, compact: true })),
								),
						text === ''
							? null
							: React.createElement('div', { className: 'cm_bubble' }, text),
					),
				);
			}
			const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
			const streaming = message.status === 'streaming';
			const copy = async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				} catch {
					/* the clipboard is unavailable without a user gesture */
				}
			};
			return React.createElement(
				'div',
				{ className: 'cm_row cm_assistantRow' },
				React.createElement(
					'div',
					{ className: 'cm_body' },
					reasoning === ''
						? null
						: React.createElement(
								'details',
								{ className: 'cm_reason', open: streaming && text === '' },
								React.createElement(
									'summary',
									{ className: 'cm_reasonSummary' },
									streaming && text === '' ? t('thinkingNow') : t('thinkingDone'),
								),
								React.createElement('div', { className: 'cm_reasonBody' }, reasoning),
							),
					streaming && text === ''
						? React.createElement('div', { className: 'cm_typing' }, React.createElement('span', null), React.createElement('span', null), React.createElement('span', null))
						: safeRich(text),
					message.status === 'stopped' ? React.createElement('div', { className: 'cm_badge' }, t('stopped')) : null,
					message.status === 'error'
						? React.createElement('div', { className: 'cm_error' }, message.error ?? t('emptyAnswer'))
						: null,
					!streaming && text !== ''
						? React.createElement(
								'div',
								{ className: 'cm_actions' },
								React.createElement(
									'button',
									{
										type: 'button',
										className: 'cm_action',
										title: copied ? t('copied') : t('copy'),
										'aria-label': copied ? t('copied') : t('copy'),
										onClick: copy,
									},
									copied ? React.createElement(CheckIcon) : React.createElement(CopyIcon),
								),
							)
						: null,
				),
			);
		});

		/** One conversation row in the rail, with ChatGPT's hover menu. */
		function ConversationRow({ conversation, active, t, onOpen, onDelete }) {
			const [open, setOpen] = React.useState(false);
			const root = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);
			return React.createElement(
				'div',
				{ className: active ? 'cm_chatItem cm_chatItemActive' : 'cm_chatItem', ref: root },
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'cm_chatOpen',
						title: conversation.title,
						onClick: () => onOpen(conversation.id),
					},
					conversation.title,
				),
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'cm_chatMore',
						title: t('more'),
						'aria-label': `${t('more')}: ${conversation.title}`,
						'aria-haspopup': 'menu',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen((value) => !value),
					},
					React.createElement(MoreIcon),
				),
				open
					? React.createElement(
							'div',
							{ className: 'cm_chatMenu', role: 'menu' },
							React.createElement(
								'button',
								{
									type: 'button',
									role: 'menuitem',
									className: 'cm_chatMenuItem',
									onClick: () => {
										setOpen(false);
										onDelete(conversation.id);
									},
								},
								React.createElement(TrashIcon),
								React.createElement('span', null, t('deleteChat')),
							),
						)
					: null,
			);
		}

		/** The day bucket a conversation belongs to in the rail. */
		function groupOf(timestamp, t) {
			const date = new Date(timestamp);
			const now = new Date();
			if (date.toDateString() === now.toDateString()) return t('groupToday');
			if (date.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return t('groupYesterday');
			return t('groupEarlier');
		}

		/** ChatGPT-like blank state: the mark, the greeting, and four cards. */
		function Landing({ t, onPick, composer }) {
			const prompts = [t('suggestion1'), t('suggestion2'), t('suggestion3'), t('suggestion4')];
			return React.createElement(
				'div',
				{ className: 'cm_landingInner' },
				React.createElement(
					'div',
					{ className: 'cm_empty' },
					React.createElement('div', { className: 'cm_emptyMark', 'aria-hidden': 'true' }, React.createElement(BrandMark, { size: 44 })),
					React.createElement('h1', { className: 'cm_emptyTitle' }, t('emptyTitle')),
				),
				composer,
				React.createElement(
					'div',
					{ className: 'cm_cards' },
					prompts.map((prompt, index) => React.createElement(
						'button',
						{ key: prompt, type: 'button', className: 'cm_card', onClick: () => onPick(prompt) },
						React.createElement('span', { className: 'cm_cardIcon', 'aria-hidden': 'true' }, React.createElement(CardIcon, { kind: index })),
						React.createElement('span', { className: 'cm_cardText' }, prompt),
					)),
				),
			);
		}

		/**
		 * The fallback a render error lands in: the panel explains itself and
		 * offers a reload or a history reset instead of blanking the page.
		 */
		function PanelCrash({ error, t }) {
			const message = error instanceof Error ? error.message : String(error);
			const reload = () => {
				try {
					window.location.reload();
				} catch {
					/* nothing else can be done without a page */
				}
			};
			const reset = () => {
				try {
					window.localStorage.removeItem(HISTORY_KEY);
					window.localStorage.removeItem(MEMORY_SWITCH_KEY);
				} catch {
					/* storage may be unavailable */
				}
				reload();
			};
			return React.createElement(
				'div',
				{ className: 'cm_crash', role: 'alert' },
				React.createElement('div', { className: 'cm_crashMark', 'aria-hidden': 'true' }, React.createElement(BrandMark, { size: 44 })),
				React.createElement('h2', { className: 'cm_crashTitle' }, t('crashTitle')),
				React.createElement('p', { className: 'cm_crashBody' }, t('crashBody')),
				React.createElement('pre', { className: 'cm_crashDetail' }, message),
				React.createElement(
					'div',
					{ className: 'cm_crashActions' },
					React.createElement('button', { type: 'button', className: 'cm_crashPrimary', onClick: reload }, t('reload')),
					React.createElement('button', { type: 'button', className: 'cm_crashGhost', onClick: reset }, t('resetChat')),
				),
			);
		}

		/** The React error boundary; a plain pass-through on the offline stub. */
		const PanelBoundary = typeof React.Component === 'function'
			? class PanelBoundary extends React.Component {
					constructor(props) {
						super(props);
						this.state = { error: null };
					}

					static getDerivedStateFromError(error) {
						return { error };
					}

					componentDidCatch(error) {
						try {
							console.error('[deepchat] panel render failed:', error);
						} catch {
							/* logging is best effort */
						}
					}

					render() {
						if (this.state.error === null) return this.props.children;
						return React.createElement(PanelCrash, { error: this.state.error, t: this.props.t });
					}
				}
			: function PanelBoundary(props) {
					return props.children ?? null;
				};

		/**
		 * The DeepChat panel: a ChatGPT-shaped rail, a centered thread, and a
		 * composer that lands in the middle of an empty chat.
		 * @param props - slot props (translator, the chat Hook, and the controller's actions).
		 * @returns the panel element.
		 */
		function ChatPanel(props) {
			let body;
			try {
				body = useChatPanelBody(props);
			} catch (error) {
				return React.createElement(PanelCrash, { error, t: props.t });
			}
			return React.createElement(PanelBoundary, { t: props.t, children: body });
		}

		/**
		 * The panel body. Errors thrown here are caught by the wrapper above and
		 * shown as the crash card instead of taking the page down with them.
		 * @param props - slot props.
		 * @returns the panel section.
		 */
		function useChatPanelBody(props) {
			const {
				t, useChat, loadCatalog, send, stop, newConversation, openConversation, deleteConversation,
				toggleHistory, toggleMemory, addFiles, removeAttachment, setDraft, chooseModel, chooseEffort, refreshCatalog,
			} = props;
			const state = useChat((snapshot) => snapshot);
			const scrollRef = React.useRef(null);
			const textareaRef = React.useRef(null);
			const fileRef = React.useRef(null);
			const [dragging, setDragging] = React.useState(false);
			const [searching, setSearching] = React.useState(false);
			const [search, setSearch] = React.useState('');
			const [syncingModels, setSyncingModels] = React.useState(false);
			const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
			const [workspaceName, setWorkspaceName] = React.useState(t('defaultWorkspace'));
			React.useEffect(() => {
				loadCatalog();
			}, [loadCatalog]);
			/* Follow the Host's model directory: a model added, removed, or
			   re-described in Harness shows up without reopening the panel. */
			const busyRef = React.useRef(false);
			busyRef.current = state.busy;
			const catalogSyncedAt = React.useRef(Date.now());
			React.useEffect(() => {
				const maybeRefresh = () => {
					if (busyRef.current) return;
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
					if (Date.now() - catalogSyncedAt.current < 30_000) return;
					catalogSyncedAt.current = Date.now();
					refreshCatalog();
				};
				const onVisibility = () => {
					if (typeof document === 'undefined' || document.visibilityState === 'visible') maybeRefresh();
				};
				document.addEventListener('visibilitychange', onVisibility);
				window.addEventListener('focus', maybeRefresh);
				const timer = window.setInterval(maybeRefresh, 90_000);
				return () => {
					document.removeEventListener('visibilitychange', onVisibility);
					window.removeEventListener('focus', maybeRefresh);
					window.clearInterval(timer);
				};
			}, [refreshCatalog]);
			const last = state.messages.length === 0 ? null : state.messages[state.messages.length - 1];
			const signature = last === null
				? ''
				: `${state.messages.length}:${(typeof last.text === 'string' ? last.text : '').length}:${(typeof last.reasoning === 'string' ? last.reasoning : '').length}`;
			React.useEffect(() => {
				const node = scrollRef.current;
				if (node === null) return;
				if (node.scrollHeight - node.scrollTop - node.clientHeight < 200) node.scrollTop = node.scrollHeight;
			}, [signature, state.activeId]);
			React.useEffect(() => {
				const node = textareaRef.current;
				if (node === null) return;
				node.style.height = 'auto';
				node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
			}, [state.draft]);
			const selection = state.selection;
			const groups = state.catalog.groups;
			const modelOptions = [];
			for (const group of groups) {
				for (const model of group.models) {
					modelOptions.push({
						value: JSON.stringify([group.id, model.id]),
						label: model.name,
						group: group.name,
						...(model.description === undefined ? {} : { description: model.description }),
					});
				}
			}
			const selectedModel = selection === null
				? undefined
				: groups.flatMap((group) => group.models.map((model) => ({ group: group.id, model })))
					.find((entry) => entry.group === selection.provider && entry.model.id === selection.model)?.model;
			const efforts = selectedModel?.reasoning?.efforts ?? [];
			const effortDefault = selectedModel?.reasoning?.defaultEffort ?? '';
			const effortValue = selection?.reasoningEffort || effortDefault;
			const canSend = !state.busy && (state.draft.trim() !== '' || state.attachments.length > 0) && selection !== null;
			const submit = () => {
				if (state.busy) {
					stop();
					return;
				}
				if (canSend) send();
			};
			const onKeyDown = (event) => {
				if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing === true) return;
				event.preventDefault();
				submit();
			};
			const onDrop = (event) => {
				event.preventDefault();
				setDragging(false);
				if (event.dataTransfer?.files?.length > 0) addFiles(event.dataTransfer.files);
			};
			const manualSync = () => {
				if (syncingModels) return;
				setSyncingModels(true);
				Promise.resolve(refreshCatalog()).finally(() => {
					window.setTimeout(() => setSyncingModels(false), 350);
				});
			};
			const openHarnessSettings = () => {
				const trigger = document.querySelector('button[aria-label="设置"]')
					?? [...document.querySelectorAll('button, [role="button"]')]
						.find((element) => /^(设置|Settings)$/.test(`${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`.trim()));
				if (trigger === undefined || trigger === null) {
					window.alert(t('settingsHint'));
					return;
				}
				trigger.click();
			};

			const filteredConversations = state.conversations.filter((conversation) => {
				if (search.trim() === '') return true;
				return conversation.title.toLowerCase().includes(search.trim().toLowerCase());
			});
			let effortIndex = efforts.findIndex((effort) => effort.id === effortValue);
			if (effortIndex < 0) effortIndex = efforts.findIndex((effort) => effort.id === effortDefault);
			if (effortIndex < 0) effortIndex = 0;
			const effortLabelText = efforts[effortIndex]?.name ?? t('effortDefault');
			const modelNameText = selectedModel?.name ?? t('modelLabel');

			const rail = React.createElement(
				'aside',
				{ className: state.historyOpen ? 'cm_rail' : 'cm_rail cm_railHidden', 'aria-label': t('history') },
				React.createElement(
					'div',
					{ className: 'cm_railTop', 'data-window-drag': true },
					React.createElement(ModelMenu, {
						t,
						selected: selection,
						options: modelOptions,
						disabled: modelOptions.length === 0,
						open: modelMenuOpen,
						onOpenChange: setModelMenuOpen,
						onSelect: (value) => {
							const [provider, model] = JSON.parse(value);
							chooseModel(provider, model);
						},
					}),
					React.createElement(
						'div',
						{ className: 'cm_railTools' },
						React.createElement(
							'button',
							{
								type: 'button',
								className: 'cm_iconBtn',
								title: t('searchChat'),
								'aria-label': t('searchChat'),
								'aria-pressed': searching ? 'true' : 'false',
								onClick: () => {
									setSearching(!searching);
									if (searching) setSearch('');
								},
							},
							React.createElement(SearchIcon, { size: 17 }),
						),
						React.createElement(
							'button',
							{
								type: 'button',
								className: state.catalog.status === 'loading' || syncingModels ? 'cm_iconBtn cm_spin' : 'cm_iconBtn',
								title: t('syncModels'),
								'aria-label': t('syncModels'),
								disabled: state.catalog.status === 'loading' || syncingModels,
								onClick: manualSync,
							},
							React.createElement(RefreshIcon),
						),
						React.createElement(
							'button',
							{ type: 'button', className: 'cm_iconBtn', title: t('historyHide'), 'aria-label': t('historyHide'), onClick: () => toggleHistory() },
							React.createElement(RailIcon, { size: 17 }),
						),
					),
				),
				React.createElement(
					'div',
					{ className: 'cm_railBody' },
					React.createElement(
						'button',
						{ type: 'button', className: 'cm_newChatBtn', onClick: () => newConversation() },
						React.createElement(PencilIcon, { size: 16 }),
						React.createElement('span', null, t('newChat')),
					),
					searching
						? React.createElement('input', {
								className: 'cm_search',
								value: search,
								placeholder: t('searchPlaceholder'),
								'aria-label': t('searchChat'),
								onChange: (event) => setSearch(event.target.value),
								onKeyDown: (event) => {
									if (event.key !== 'Escape') return;
									setSearch('');
									setSearching(false);
								},
							})
						: null,
					React.createElement('span', { className: 'cm_srOnly' }, t('history')),
					React.createElement('div', { className: 'cm_recentLabel' }, t('recent')),
					React.createElement(
						'div',
						{ className: 'cm_railList' },
						filteredConversations.length === 0
							? React.createElement('p', { className: 'cm_railEmpty' }, search.trim() === '' ? t('historyEmpty') : t('searchEmpty'))
							: filteredConversations.map((conversation) => React.createElement(ConversationRow, {
									key: conversation.id,
									conversation,
									active: conversation.id === state.activeId,
									t,
									onOpen: openConversation,
									onDelete: deleteConversation,
								})),
					),
				),
				React.createElement(
					'div',
					{ className: 'cm_railFoot' },
					React.createElement(
						'button',
						{ type: 'button', className: 'cm_footerIcon', title: t('help'), 'aria-label': t('help'), onClick: () => window.alert(t('aboutBody')) },
						React.createElement(HelpIcon, { size: 17 }),
					),
					React.createElement(AccountMenu, {
						t,
						modelName: modelNameText,
						memoryOn: state.memoryOn,
						onOpenSettings: openHarnessSettings,
					}),
				),
			);

			const effortPopup = efforts.length === 0
				? null
				: React.createElement(EffortPopup, {
						t,
						efforts,
						value: effortValue,
						fallback: effortDefault,
						modelName: modelNameText,
						onChange: chooseEffort,
						onReset: () => chooseEffort(effortDefault || efforts[0]?.id || ''),
						onOpenModel: () => {
							if (!state.historyOpen) toggleHistory();
							setModelMenuOpen(true);
						},
						onBoost: () => {
							if (efforts.length === 0) return;
							const maximum = efforts[efforts.length - 1];
							const already = effortIndex === efforts.length - 1;
							chooseEffort(already ? (effortDefault || efforts[0]?.id || maximum.id) : maximum.id);
						},
						isBoosted: efforts.length > 1 && effortIndex === efforts.length - 1,
					});

			const composer = React.createElement(
				'div',
				{ className: state.messages.length === 0 ? 'cm_composerWrap' : 'cm_composerWrap cm_composerWrapDocked' },
				state.memoryStatus === null
					? null
					: React.createElement('div', { className: 'cm_memoryStatus' }, state.memoryStatus),
				React.createElement(
					'div',
					{ className: 'cm_composer' },
					React.createElement(
						'div',
						{ className: 'cm_contextRow' },
						React.createElement(WorkspaceMenu, { t, name: workspaceName, onSelect: setWorkspaceName }),
						React.createElement('span', { className: 'cm_contextChip', title: t('thisComputer') }, React.createElement(MonitorIcon, { size: 14 }), React.createElement('span', null, t('thisComputer'))),
					),
					state.attachments.length === 0
						? null
						: React.createElement(
								'div',
								{ className: 'cm_chipRow cm_chipRowComposer' },
								state.attachments.map((item) => React.createElement(AttachmentChip, { key: item.id, item, t, onRemove: removeAttachment })),
							),
					React.createElement('textarea', {
						className: 'cm_input',
						ref: textareaRef,
						rows: 1,
						value: state.draft,
						placeholder: t('placeholder'),
						'aria-label': t('placeholder'),
						onChange: (event) => setDraft(event.target.value),
						onKeyDown,
						onPaste: (event) => {
							const files = [...(event.clipboardData?.files ?? [])];
							if (files.length > 0) {
								event.preventDefault();
								addFiles(files);
							}
						},
					}),
					React.createElement(
						'div',
						{ className: 'cm_toolbar' },
						React.createElement(
							'button',
							{
								type: 'button',
								className: 'cm_roundBtn',
								title: t('attach'),
								'aria-label': t('attach'),
								disabled: state.attachments.length >= MAX_ATTACHMENTS,
								onClick: () => fileRef.current?.click(),
							},
							React.createElement(PlusIcon, { size: 20 }),
						),
						React.createElement('input', {
							type: 'file',
							multiple: true,
							ref: fileRef,
							className: 'cm_fileInput',
							tabIndex: -1,
							'aria-hidden': 'true',
							onChange: (event) => {
								addFiles(event.target.files);
								event.target.value = '';
							},
						}),
						React.createElement(
							'button',
							{
								type: 'button',
								className: state.memoryOn ? 'cm_pillAction cm_pillActionOn' : 'cm_pillAction',
								title: state.memoryOn ? t('memoryOn') : t('memoryOff'),
								'aria-label': t('memory'),
								'aria-pressed': state.memoryOn ? 'true' : 'false',
								onClick: () => toggleMemory(),
							},
							React.createElement(SparkleIcon, { size: 15 }),
							React.createElement('span', null, t('memory')),
							React.createElement('span', { className: state.memoryOn ? 'cm_pillDot cm_pillDotOn' : 'cm_pillDot', 'aria-hidden': 'true' }),
						),
						React.createElement('span', { className: 'cm_srOnly' }, `${modelNameText} ${effortLabelText}`),
						React.createElement('div', { className: 'cm_spacer' }),
						effortPopup,
						React.createElement(
							'button',
							{
								type: 'button',
								className: state.busy ? 'cm_send cm_sendStop' : 'cm_send',
								title: state.busy ? t('stop') : t('send'),
								'aria-label': state.busy ? t('stop') : t('send'),
								disabled: !state.busy && !canSend,
								onClick: submit,
							},
							state.busy ? React.createElement(StopIcon) : React.createElement(ArrowUpIcon),
						),
					),
				),
				React.createElement('p', { className: 'cm_disclaimer' }, t('disclaimer')),
			);

			const thread = state.messages.length === 0
				? null
				: React.createElement(
						'div',
						{ className: 'cm_scroll', ref: scrollRef },
						React.createElement(
							'div',
							{ className: 'cm_thread' },
							state.catalog.status === 'error'
								? React.createElement(
										'div',
										{ className: 'cm_notice cm_noticeError' },
										`${t('catalogFailed')}: ${state.catalog.error ?? ''}`,
										React.createElement('button', { type: 'button', className: 'cm_link', onClick: () => loadCatalog() }, t('retry')),
									)
								: null,
							state.historyFailed ? React.createElement('div', { className: 'cm_notice cm_noticeError' }, t('storageFailed')) : null,
							state.messages.map((message) => React.createElement(MessageRow, { key: message.id, message, t })),
							state.notice === null ? null : React.createElement('div', { className: 'cm_notice' }, state.notice),
						),
					);

			const hero = React.createElement(
				'div',
				{ className: 'cm_landingHero' },
				React.createElement('span', { className: 'cm_heroIcon', 'aria-hidden': 'true' }, React.createElement(CloudIcon, { size: 64 })),
				React.createElement('h1', { className: 'cm_heroTitle' }, t('emptyTitle')),
			);

			const column = React.createElement(
				'div',
				{ className: 'cm_main' },
				state.historyOpen
					? null
					: React.createElement(
							'button',
							{ type: 'button', className: 'cm_railReopen', title: t('historyShow'), 'aria-label': t('historyShow'), onClick: () => toggleHistory() },
							React.createElement(RailIcon, { size: 17 }),
						),
				state.messages.length === 0
					? React.createElement('div', { className: 'cm_landing' }, hero, composer)
					: React.createElement(React.Fragment, null, thread, composer),
			);

			return React.createElement(
				'section',
				{
					className: dragging ? 'cm_root cm_dragging' : 'cm_root',
					'data-chat-mode': true,
					'aria-busy': state.busy,
					onDragOver: (event) => {
						event.preventDefault();
						setDragging(true);
					},
					onDragLeave: (event) => {
						if (event.currentTarget.contains(event.relatedTarget)) return;
						setDragging(false);
					},
					onDrop,
				},
				rail,
				column,
				dragging
					? React.createElement(
							'div',
							{ className: 'cm_drop' },
							React.createElement('div', { className: 'cm_dropCard' }, React.createElement('strong', null, t('dropTitle')), React.createElement('span', null, t('dropHint'))),
						)
					: null,
			);
		}
		//#endregion

		//#region styles
		const css = [
			/* ChatGPT-shaped palette, scoped to the panel: the page must never depend
			   on a theme token that a skin may have set transparent. */
			'.cm_root{--cm-bg:#fff;--cm-rail:#f9f9f9;--cm-text:#0d0d0d;--cm-text-soft:#5d5d5d;--cm-text-faint:#8f8f8f;--cm-line:rgba(13,13,13,.09);--cm-hover:rgba(13,13,13,.05);--cm-active:rgba(13,13,13,.085);--cm-bubble:#f4f4f4;--cm-card:#fff;--cm-code:#f6f6f6;--cm-menu:#fff;--cm-send-bg:#0d0d0d;--cm-send-fg:#fff;--cm-shadow:0 12px 36px rgba(0,0,0,.09),0 2px 8px rgba(0,0,0,.04);--cm-mark-cut:var(--cm-bg);box-sizing:border-box;height:100%;min-height:0;color:var(--cm-text);background:var(--cm-bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;flex-direction:row;display:flex;position:relative;overflow:hidden}',
			'[data-ds-dark-theme] .cm_root{--cm-bg:#212121;--cm-rail:#171717;--cm-text:#ececec;--cm-text-soft:#b4b4b4;--cm-text-faint:#8f8f8f;--cm-line:rgba(255,255,255,.09);--cm-hover:rgba(255,255,255,.06);--cm-active:rgba(255,255,255,.1);--cm-bubble:#303030;--cm-card:#303030;--cm-code:#2a2a2a;--cm-menu:#2f2f2f;--cm-send-bg:#fff;--cm-send-fg:#0d0d0d;--cm-shadow:0 12px 36px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.28)}',
			'.cm_root *{box-sizing:border-box}',
			'.cm_svg{display:block;flex:none}',
			'.cm_brandMark{display:block;flex:none}',
			'.cm_rail{--cm-mark-cut:var(--cm-rail);background:var(--cm-rail);border-right:1px solid var(--cm-line);flex-direction:column;flex:none;width:260px;min-height:0;display:flex;position:relative}',
			'.cm_railHidden{display:none}',
			'.cm_railTop{flex:none;align-items:center;gap:6px;padding:12px 10px 8px;display:flex}',
			'[data-platform=darwin] .cm_railTop{padding-top:calc(12px + var(--dsh-frame-top-clearance,0px))}',
			'.cm_brand{align-items:center;gap:9px;flex:1;min-width:0;padding-left:6px;display:flex}',
			'.cm_brandName{color:var(--cm-text);white-space:nowrap;font-size:15.5px;font-weight:600;line-height:22px}',
			'.cm_iconBtn{border:0;border-radius:8px;background:0 0;color:var(--cm-text-soft);cursor:pointer;flex:none;justify-content:center;align-items:center;width:32px;height:32px;padding:0;display:flex}',
			'.cm_iconBtn:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_iconBtn:disabled{cursor:default;opacity:.4}',
			'.cm_railBody{flex-direction:column;flex:1;gap:2px;min-height:0;padding:4px 10px 10px;display:flex;overflow:hidden}',
			'.cm_railNew,.cm_railAction{border:0;border-radius:9px;background:0 0;color:var(--cm-text);cursor:pointer;align-items:center;gap:10px;width:100%;height:38px;padding:0 10px;font:inherit;font-size:14px;line-height:20px;text-align:left;display:flex}',
			'.cm_railNew{font-weight:500}',
			'.cm_railNew:hover,.cm_railAction:hover,.cm_railActionOn{background:var(--cm-hover)}',
			'.cm_railAction{color:var(--cm-text-soft)}',
			'.cm_search{border:1px solid var(--cm-line);border-radius:9px;background:var(--cm-card);width:100%;height:36px;margin:2px 0;color:var(--cm-text);outline:0;padding:0 11px;font:inherit;font-size:13.5px}',
			'.cm_search::placeholder{color:var(--cm-text-faint)}',
			'.cm_search:focus{border-color:var(--cm-text-faint)}',
			'.cm_srOnly{clip:rect(0 0 0 0);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}',
			'.cm_railList{flex-direction:column;flex:1;min-height:0;margin-top:4px;display:flex;overflow-y:auto;scrollbar-width:thin}',
			'.cm_railEmpty{color:var(--cm-text-faint);margin:8px 10px;font-size:13px;line-height:19px}',
			'.cm_railGroup{flex-direction:column;display:flex}',
			'.cm_groupLabel{color:var(--cm-text-faint);padding:14px 10px 6px;font-size:12px;font-weight:500;line-height:16px}',
			'.cm_chatItem{border-radius:9px;align-items:center;display:flex;position:relative}',
			'.cm_chatItem:hover{background:var(--cm-hover)}',
			'.cm_chatItemActive,.cm_chatItemActive:hover{background:var(--cm-active)}',
			'.cm_chatOpen{border:0;background:0 0;color:var(--cm-text);text-align:left;text-overflow:ellipsis;white-space:nowrap;border-radius:9px;flex:1;min-width:0;padding:8px 10px;font:inherit;font-size:13.5px;line-height:19px;cursor:pointer;overflow:hidden}',
			'.cm_chatMore{border:0;border-radius:7px;background:0 0;color:var(--cm-text-soft);cursor:pointer;opacity:0;flex:none;justify-content:center;align-items:center;width:26px;height:26px;margin-right:4px;padding:0;display:flex}',
			'.cm_chatItem:hover .cm_chatMore,.cm_chatMore:focus-visible{opacity:1}',
			'.cm_chatMore:hover{background:var(--cm-active);color:var(--cm-text)}',
			'.cm_chatMenu{background:var(--cm-menu);border:1px solid var(--cm-line);border-radius:12px;box-shadow:var(--cm-shadow);z-index:30;min-width:150px;padding:4px;position:absolute;top:calc(100% - 2px);right:4px}',
			'.cm_chatMenuItem{border:0;border-radius:8px;background:0 0;color:var(--cm-text);cursor:pointer;align-items:center;gap:8px;width:100%;padding:7px 9px;font:inherit;font-size:13px;line-height:18px;text-align:left;display:flex}',
			'.cm_chatMenuItem:hover{background:var(--cm-hover)}',
			'.cm_railFoot{flex:none;border-top:1px solid var(--cm-line);flex-direction:column;gap:2px;padding:8px 10px 10px;display:flex}',
			'.cm_memRow{border:0;border-radius:9px;background:0 0;color:var(--cm-text-soft);cursor:pointer;align-items:center;gap:9px;width:100%;height:36px;padding:0 10px;font:inherit;font-size:13.5px;line-height:19px;text-align:left;display:flex}',
			'.cm_memRow:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_memRowOn{color:var(--cm-text)}',
			'.cm_memLabel{flex:1}',
			'.cm_memDot{border:1.4px solid var(--cm-text-faint);border-radius:999px;flex:none;width:13px;height:13px}',
			'.cm_memRowOn .cm_memDot{border-color:var(--cm-text);background:var(--cm-text);box-shadow:inset 0 0 0 3px var(--cm-rail)}',
			'.cm_account{border-radius:9px;align-items:center;gap:9px;padding:7px 8px;display:flex}',
			'.cm_accountAvatar{background:var(--cm-text);color:var(--cm-bg);border-radius:999px;flex:none;justify-content:center;align-items:center;width:26px;height:26px;font-size:10px;font-weight:600;display:flex}',
			'.cm_accountName{color:var(--cm-text-soft);text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;line-height:19px;overflow:hidden}',
			'.cm_main{background:var(--cm-bg);flex-direction:column;flex:1;min-width:0;min-height:0;display:flex;position:relative}',
			'.cm_topbar{flex:none;align-items:center;gap:4px;height:54px;padding:0 14px;display:flex}',
			'[data-platform=darwin] .cm_topbar{padding-top:var(--dsh-frame-top-clearance,0px)}',
			'.cm_picker{flex:none;position:relative}',
			'.cm_pickerTop .cm_pill{color:var(--cm-text);height:36px;padding:0 10px;font-size:16px;font-weight:600}',
			'.cm_pickerTop .cm_pill:hover:not(:disabled){background:var(--cm-hover)}',
			'.cm_pill{border:0;border-radius:9px;background:0 0;cursor:pointer;align-items:center;gap:5px;max-width:260px;display:flex;font:inherit;line-height:20px}',
			'.cm_pill:hover:not(:disabled){background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_pill:disabled{cursor:default;opacity:.45}',
			'.cm_pillLabel{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
			'.cm_spacer{flex:1}',
			'.cm_topNew{border:0;border-radius:9px;background:0 0;color:var(--cm-text-soft);cursor:pointer;flex:none;justify-content:center;align-items:center;width:36px;height:36px;padding:0;display:flex}',
			'.cm_topNew:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_syncBtn{width:32px;height:32px}',
			'.cm_spin .cm_svg{animation:cm_spin 1s linear infinite}',
			'@keyframes cm_spin{to{transform:rotate(360deg)}}',
			'@media (prefers-reduced-motion:reduce){.cm_spin .cm_svg{animation:none}}',
			'.cm_landing{flex:1;min-height:0;justify-content:center;align-items:center;padding:24px 24px 7vh;display:flex;overflow-y:auto}',
			'.cm_landingInner{flex-direction:column;align-items:center;gap:26px;width:100%;max-width:768px;margin:0 auto;display:flex}',
			'.cm_empty{text-align:center;flex-direction:column;align-items:center;gap:16px;display:flex}',
			'.cm_emptyMark{color:var(--cm-text);justify-content:center;align-items:center;display:flex}',
			'.cm_emptyTitle{margin:0;color:var(--cm-text);font-size:30px;font-weight:500;line-height:38px;letter-spacing:-.2px}',
			'.cm_cards{grid-template-columns:1fr 1fr;gap:10px;width:100%;max-width:680px;display:grid}',
			'.cm_card{border:1px solid var(--cm-line);border-radius:14px;background:0 0;color:var(--cm-text-soft);cursor:pointer;text-align:left;align-items:flex-start;gap:10px;padding:12px 14px;font:inherit;font-size:13.5px;line-height:19px;display:flex}',
			'.cm_card:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_cardIcon{color:var(--cm-text-faint);flex:none;margin-top:1px}',
			'.cm_card:hover .cm_cardIcon{color:var(--cm-text-soft)}',
			'.cm_cardText{min-width:0}',
			'.cm_scroll{flex:1;min-height:0;padding:0 24px;overflow-y:auto;scrollbar-width:thin}',
			'.cm_thread{flex-direction:column;gap:26px;width:100%;max-width:768px;margin:0 auto;padding:16px 0 32px;display:flex}',
			'.cm_row{min-width:0;display:flex}',
			'.cm_userRow{justify-content:flex-end}',
			'.cm_userStack{flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:78%;display:flex}',
			'.cm_bubble{background:var(--cm-bubble);border-radius:24px;color:var(--cm-text);white-space:pre-wrap;word-break:break-word;max-width:100%;padding:10px 18px;font-size:15.5px;line-height:24px}',
			'.cm_assistantRow{width:100%}',
			'.cm_body{flex-direction:column;gap:10px;flex:1;min-width:0;color:var(--cm-text);font-size:16px;line-height:28px;display:flex;overflow-wrap:anywhere}',
			'.cm_textFallback{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit;font-size:16px;line-height:28px}',
			'.cm_text{white-space:pre-wrap;word-break:break-word;font-size:16px;line-height:28px}',
			'.cm_p{white-space:pre-wrap;word-break:break-word;margin:0;font-size:16px;line-height:28px}',
			'.cm_body>:first-child{margin-top:0}',
			'.cm_h{margin:20px 0 6px;color:var(--cm-text);font-weight:600;line-height:1.35}',
			'.cm_h1{font-size:24px}.cm_h2{font-size:20px}.cm_h3{font-size:17px}.cm_h4,.cm_h5,.cm_h6{color:var(--cm-text);font-size:16px}',
			'.cm_list{margin:6px 0;padding-left:24px;flex-direction:column;gap:4px;display:flex}',
			'.cm_li{font-size:16px;line-height:28px}',
			'.cm_quote{border-left:2px solid var(--cm-line);color:var(--cm-text-soft);margin:8px 0;padding:2px 0 2px 14px}',
			'.cm_hr{border:0;border-top:1px solid var(--cm-line);margin:18px 0}',
			'.cm_inlineCode{background:var(--cm-code);border-radius:5px;padding:1.5px 5px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13.5px}',
			'.cm_tableWrap{margin:10px 0;overflow-x:auto}',
			'.cm_table{border-collapse:collapse;font-size:14.5px;line-height:22px}',
			'.cm_tableCell{border:1px solid var(--cm-line);text-align:left;padding:6px 12px;vertical-align:top}',
			'.cm_table th.cm_tableCell{background:var(--cm-code);font-weight:600}',
			'.cm_mathWrap{margin:10px 0;overflow-x:auto;justify-content:center;display:flex}',
			'.cm_math{font-family:"STIX Two Math","Latin Modern Math","Cambria Math",STIXGeneral,"Times New Roman",serif;color:var(--cm-text);font-size:1.06em;line-height:1.35}',
			'math{font-family:inherit}',
			'.cm_mathBlock{display:block;overflow-x:auto;max-width:100%;padding:2px 0}',
			'.cm_mathFallback{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:13.5px;word-break:break-all}',
			'.cm_link{color:var(--cm-text);text-decoration:underline;text-decoration-color:var(--cm-text-faint);text-underline-offset:2px;word-break:break-all}',
			'.cm_link:hover{text-decoration-color:var(--cm-text)}',
			'.cm_codeBlock{border:1px solid var(--cm-line);border-radius:14px;overflow:hidden;background:var(--cm-code)}',
			'.cm_codeLang{color:var(--cm-text-soft);background:var(--cm-code);border-bottom:1px solid var(--cm-line);padding:7px 14px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:12px;line-height:17px}',
			'.cm_code{background:var(--cm-code);color:var(--cm-text);margin:0;padding:14px;overflow-x:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13.5px;line-height:21px}',
			'.cm_reason{color:var(--cm-text-soft);font-size:14px;line-height:22px}',
			'.cm_reasonSummary{cursor:pointer;list-style:none;align-items:center;gap:6px;width:max-content;display:flex}',
			'.cm_reasonSummary::-webkit-details-marker{display:none}',
			'.cm_reasonSummary:before{content:"";border-bottom:1.4px solid;border-right:1.4px solid;width:5px;height:5px;margin-left:2px;transform:rotate(-45deg);transition:transform .12s}',
			'.cm_reason[open] .cm_reasonSummary:before{transform:rotate(45deg)}',
			'.cm_reasonBody{white-space:pre-wrap;word-break:break-word;border-left:2px solid var(--cm-line);margin:8px 0 0;padding:2px 0 2px 12px;max-height:320px;overflow:auto}',
			'.cm_typing{align-items:center;gap:5px;height:28px;display:flex}',
			'.cm_typing span{background:var(--cm-text-faint);border-radius:999px;width:7px;height:7px;animation:cm_pulse 1.1s ease-in-out infinite}',
			'.cm_typing span:nth-child(2){animation-delay:.15s}',
			'.cm_typing span:nth-child(3){animation-delay:.3s}',
			'@keyframes cm_pulse{0%,80%,100%{opacity:.28;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}',
			'@media (prefers-reduced-motion:reduce){.cm_typing span{animation:none}}',
			'.cm_badge{border:1px solid var(--cm-line);border-radius:999px;color:var(--cm-text-soft);align-self:flex-start;padding:1px 9px;font-size:12px;line-height:18px}',
			'.cm_error{color:#d93025;word-break:break-word;font-size:14px;line-height:22px}',
			'.cm_actions{gap:2px;margin-top:-2px;display:flex}',
			'.cm_action{border:0;border-radius:7px;background:0 0;color:var(--cm-text-faint);cursor:pointer;justify-content:center;align-items:center;width:28px;height:28px;padding:0;display:flex}',
			'.cm_action:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_link{color:var(--cm-text-soft);cursor:pointer;background:0 0;border:0;border-radius:6px;padding:2px 5px;font:inherit;font-size:12.5px;line-height:18px}',
			'.cm_link:hover{color:var(--cm-text);background:var(--cm-hover)}',
			'.cm_notice{color:var(--cm-text-soft);border:1px solid var(--cm-line);border-radius:12px;align-items:center;gap:8px;padding:8px 12px;font-size:13px;line-height:19px;display:flex}',
			'.cm_noticeError{color:#d93025;border-color:color-mix(in srgb,#d93025 35%,transparent)}',
			'.cm_chipRow{flex-wrap:wrap;gap:8px;justify-content:flex-end;display:flex}',
			'.cm_chipRowComposer{justify-content:flex-start;margin-bottom:2px}',
			'.cm_chip{border:1px solid var(--cm-line);border-radius:12px;background:var(--cm-card);align-items:center;gap:9px;min-width:0;max-width:250px;padding:6px 8px;display:flex}',
			'.cm_chipCompact{background:var(--cm-card)}',
			'.cm_chipImage{border-radius:7px;object-fit:cover;flex:none;width:28px;height:28px}',
			'.cm_chipGlyph{border-radius:7px;background:var(--cm-code);color:var(--cm-text-soft);flex:none;justify-content:center;align-items:center;width:28px;height:28px;font-size:9px;font-weight:600;display:flex}',
			'.cm_chipBody{flex-direction:column;flex:1;min-width:0;display:flex}',
			'.cm_chipName{color:var(--cm-text);text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:17px;overflow:hidden}',
			'.cm_chipMeta{color:var(--cm-text-faint);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}',
			'.cm_chipRemove{color:var(--cm-text-faint);cursor:pointer;background:0 0;border:0;border-radius:999px;flex:none;justify-content:center;align-items:center;width:20px;height:20px;padding:0;display:flex}',
			'.cm_chipRemove:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_composerWrap{flex:none;background:linear-gradient(180deg,transparent,var(--cm-bg) 30%);padding:10px 24px 18px}',
			'.cm_composerWrapLanding{background:0 0;width:100%;max-width:768px;margin:0 auto;padding:0}',
			'.cm_composerWave{background:0 0}',
			'.cm_composer{background:var(--cm-card);border:1px solid var(--cm-line);border-radius:28px;box-shadow:var(--cm-shadow);flex-direction:column;width:100%;max-width:768px;margin:0 auto;padding:10px 10px 9px 16px;display:flex}',
			'.cm_composer:focus-within{border-color:var(--cm-line)}',
			'.cm_input{border:0;outline:0;background:0 0;width:100%;max-height:200px;min-height:30px;color:var(--cm-text);resize:none;padding:5px 0 2px;font:inherit;font-size:16px;line-height:24px;overflow-y:auto}',
			'.cm_input::placeholder{color:var(--cm-text-faint)}',
			'.cm_root textarea:focus-visible,.cm_root input:focus-visible{outline:none!important}',
			'.cm_effort{align-items:center;gap:7px;flex:0 1 190px;min-width:124px;height:34px;padding:0 7px;display:flex}',
			'.cm_effortIcon{color:var(--cm-text-faint);flex:none;display:flex}',
			'.cm_slider{flex:1;min-width:64px;height:18px;margin:0;background:0 0;-webkit-appearance:none;appearance:none;cursor:pointer;--cm-fill:50%}',
			'.cm_slider:disabled{cursor:default;opacity:.55}',
			'.cm_slider::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(90deg,var(--cm-text) 0 var(--cm-fill),var(--cm-line) var(--cm-fill) 100%)}',
			'.cm_slider::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:999px;background:var(--cm-bg);border:2px solid var(--cm-text);margin-top:-5px;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform .1s}',
			'.cm_slider:hover::-webkit-slider-thumb{transform:scale(1.08)}',
			'.cm_slider:focus,.cm_slider:focus-visible{outline:none}',
			'.cm_effortValue{color:var(--cm-text-soft);flex:none;min-width:42px;text-align:right;font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.cm_toolbar{align-items:center;gap:4px;display:flex}',
			'.cm_roundBtn{border:1px solid var(--cm-line);border-radius:999px;background:0 0;color:var(--cm-text);cursor:pointer;flex:none;justify-content:center;align-items:center;width:34px;height:34px;padding:0;display:flex}',
			'.cm_roundBtn:hover:not(:disabled){background:var(--cm-hover)}',
			'.cm_roundBtn:disabled{cursor:default;opacity:.4}',
			'.cm_fileInput{display:none}',
			'.cm_send{border:0;border-radius:999px;background:var(--cm-send-bg);color:var(--cm-send-fg);cursor:pointer;flex:none;justify-content:center;align-items:center;width:36px;height:36px;padding:0;display:flex}',
			'.cm_send:hover:not(:disabled){opacity:.86}',
			'.cm_send:disabled{cursor:default;opacity:.25}',
			'.cm_sendStop{background:var(--cm-send-bg)}',
			'.cm_disclaimer{color:var(--cm-text-faint);text-align:center;margin:9px 0 0;font-size:11.5px;line-height:16px}',
			'.cm_memoryStatus{color:var(--cm-text-faint);text-align:center;margin:0 auto 6px;max-width:768px;font-size:11.5px;line-height:16px}',
			'.cm_menu{background:var(--cm-menu);border:1px solid var(--cm-line);border-radius:14px;box-shadow:var(--cm-shadow);z-index:30;flex-direction:column;gap:1px;width:max-content;min-width:250px;max-width:min(360px,80vw);max-height:320px;padding:5px;display:flex;position:absolute;bottom:calc(100% + 8px);left:0;overflow-y:auto}',
			'.cm_menuBelow{top:calc(100% + 6px);bottom:auto}',
			'.cm_menuGroup{color:var(--cm-text-faint);padding:8px 10px 4px;font-size:11.5px;line-height:16px}',
			'.cm_menuItem{border:0;border-radius:8px;background:0 0;color:var(--cm-text);text-align:left;cursor:pointer;align-items:flex-start;gap:6px;width:100%;padding:7px 8px;font:inherit;font-size:13.5px;line-height:19px;display:flex}',
			'.cm_menuItem:hover,.cm_menuItemActive{background:var(--cm-hover)}',
			'.cm_menuCheck{color:var(--cm-text);flex:none;width:12px;font-size:12px;line-height:19px}',
			'.cm_menuText{flex-direction:column;flex:1;min-width:0;display:flex}',
			'.cm_menuLabel{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
			'.cm_menuDesc{color:var(--cm-text-faint);white-space:normal;font-size:11.5px;line-height:16px}',
			'.cm_menuEmpty{color:var(--cm-text-faint);padding:8px 10px;font-size:13px}',
			'.cm_drop{background:color-mix(in srgb,var(--cm-bg) 78%,transparent);z-index:40;justify-content:center;align-items:center;display:flex;position:absolute;inset:0}',
			'.cm_dropCard{border:1.5px dashed var(--cm-text-faint);border-radius:20px;background:var(--cm-card);color:var(--cm-text);flex-direction:column;align-items:center;gap:6px;padding:30px 44px;font-size:14px;line-height:21px;display:flex}',
			'.cm_crash{background:var(--cm-bg);color:var(--cm-text);flex-direction:column;justify-content:center;align-items:center;gap:10px;height:100%;padding:32px;text-align:center;display:flex}',
			'.cm_crashMark{color:var(--cm-text);margin-bottom:6px}',
			'.cm_crashTitle{margin:0;font-size:22px;font-weight:600;line-height:30px}',
			'.cm_crashBody{color:var(--cm-text-soft);margin:0;max-width:520px;font-size:14px;line-height:21px}',
			'.cm_crashDetail{color:var(--cm-text-faint);background:var(--cm-code);border-radius:10px;max-width:min(620px,90%);padding:10px 12px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:12px;line-height:18px;text-align:left;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}',
			'.cm_crashActions{gap:10px;margin-top:8px;display:flex}',
			'.cm_crashPrimary{border:0;border-radius:999px;background:var(--cm-send-bg);color:var(--cm-send-fg);cursor:pointer;height:38px;padding:0 18px;font:inherit;font-size:14px}',
			'.cm_crashGhost{border:1px solid var(--cm-line);border-radius:999px;background:0 0;color:var(--cm-text);cursor:pointer;height:38px;padding:0 18px;font:inherit;font-size:14px}',
			'.cm_crashGhost:hover{background:var(--cm-hover)}',
			'.cm_root :focus-visible{outline:2px solid var(--cm-text);outline-offset:2px}',
			'.cm_root ::-webkit-scrollbar{width:10px;height:10px}',
			'.cm_root ::-webkit-scrollbar-thumb{background:var(--cm-line);border-radius:999px}',
			'@media (max-width:980px){.cm_rail{position:absolute;inset:0 auto 0 0;z-index:20;box-shadow:var(--cm-shadow);width:min(280px,84vw)}.cm_railHidden{display:none}.cm_railTop{padding-top:calc(12px + var(--dsh-frame-top-clearance,0px))}}',
			'@media (max-width:720px){.cm_cards{grid-template-columns:1fr}.cm_emptyTitle{font-size:26px;line-height:34px}.cm_scroll,.cm_composerWrap,.cm_landing{padding-left:16px;padding-right:16px}.cm_thread{gap:22px}.cm_userStack{max-width:88%}}',
			/* ── Codex-shaped shell: warm gray rail, white canvas, wide composer ── */
			'.cm_root{--cm-rail:#f7f7f7;--cm-bg:#fff;--cm-send-bg:#2563eb;--cm-send-fg:#fff;--cm-purple:#7c3aed;--cm-purple-soft:#c4b5fd;--cm-card:#fff;--cm-menu:#fff;--cm-line:rgba(0,0,0,.08);--cm-hover:rgba(0,0,0,.045);--cm-active:rgba(0,0,0,.07);--cm-text:#1d1d1f;--cm-text-soft:#6e6e73;--cm-text-faint:#8e8e93;--cm-shadow:0 18px 48px rgba(0,0,0,.12),0 2px 8px rgba(0,0,0,.05);--cm-mark-cut:var(--cm-bg)}',
			'[data-ds-dark-theme] .cm_root{--cm-rail:#171717;--cm-bg:#212121;--cm-send-bg:#3b82f6;--cm-send-fg:#fff;--cm-purple:#c4b5fd;--cm-purple-soft:#a78bfa;--cm-card:#2a2a2a;--cm-menu:#2f2f2f;--cm-line:rgba(255,255,255,.09);--cm-hover:rgba(255,255,255,.06);--cm-active:rgba(255,255,255,.1);--cm-text:#ececec;--cm-text-soft:#b4b4b4;--cm-text-faint:#8e8e93;--cm-mark-cut:var(--cm-rail)}',
			'.cm_rail{width:300px;background:var(--cm-rail);border-right:1px solid var(--cm-line);--cm-mark-cut:var(--cm-rail)}',
			'.cm_railTop{align-items:flex-start;gap:6px;padding:14px 10px 8px}',
			'[data-platform=darwin] .cm_railTop{padding-top:calc(14px + var(--dsh-frame-top-clearance,0px))}',
			'.cm_brandWrap{flex:1;min-width:0;position:relative}',
			'.cm_brandBtn{align-items:center;gap:9px;width:100%;min-width:0;padding:4px 6px;border:0;border-radius:10px;background:0 0;color:var(--cm-text);font:inherit;text-align:left;cursor:pointer;display:flex}',
			'.cm_brandBtn:hover:not(:disabled){background:var(--cm-hover)}',
			'.cm_brandBtn:disabled{cursor:default;opacity:.6}',
			'.cm_brandText{flex-direction:column;flex:1;min-width:0;display:flex}',
			'.cm_brandName{white-space:nowrap;font-size:15px;font-weight:600;line-height:20px}',
			'.cm_brandModel{text-overflow:ellipsis;white-space:nowrap;color:var(--cm-text-faint);font-size:11px;line-height:15px;overflow:hidden}',
			'.cm_railTools{flex:none;align-items:center;gap:1px;padding-top:2px;display:flex}',
			'.cm_railTools .cm_iconBtn{width:28px;height:28px;border-radius:8px}',
			'.cm_brandMenu{top:calc(100% + 8px);bottom:auto;left:0;right:auto;width:300px;min-width:240px;max-width:calc(100vw - 32px)}',
			'.cm_railBody{gap:0;padding:4px 10px 10px}',
			'.cm_newChatBtn{align-items:center;gap:10px;width:100%;height:38px;padding:0 10px;border:0;border-radius:9px;background:0 0;color:var(--cm-text);font:inherit;font-size:14px;font-weight:500;text-align:left;cursor:pointer;display:flex}',
			'.cm_newChatBtn:hover{background:var(--cm-hover)}',
			'.cm_search{height:34px;margin:4px 0 2px;border-radius:9px;font-size:13px}',
			'.cm_recentLabel{color:var(--cm-text-faint);padding:16px 10px 6px;font-size:12px;font-weight:500;line-height:16px}',
			'.cm_railList{gap:1px;margin-top:0}',
			'.cm_chatItem{border-radius:9px}',
			'.cm_chatOpen{padding:8px 10px;font-size:13.5px}',
			'.cm_railFoot{justify-content:space-between;align-items:center;border-top:1px solid var(--cm-line);padding:10px 14px 14px;display:flex}',
			'.cm_footerIcon{color:var(--cm-text-faint);cursor:pointer;background:0 0;border:0;border-radius:9px;justify-content:center;align-items:center;width:30px;height:30px;padding:0;display:flex}',
			'.cm_footerIcon:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_accountAvatar{width:28px;height:28px;font-size:10px}',
			'.cm_main{background:var(--cm-bg)}',
			'.cm_railReopen{color:var(--cm-text-soft);z-index:30;cursor:pointer;background:var(--cm-card);border:1px solid var(--cm-line);border-radius:9px;justify-content:center;align-items:center;width:32px;height:32px;display:flex;position:absolute;top:12px;left:12px;box-shadow:0 2px 8px rgba(0,0,0,.06)}',
			'.cm_landing{flex:1;min-height:0;padding:0;display:flex;flex-direction:column;overflow:hidden}',
			'.cm_landingHero{flex:1;min-height:0;flex-direction:column;justify-content:center;align-items:center;gap:20px;padding:24px 24px 10px;display:flex}',
			'.cm_heroIcon{color:#c7c7cc;display:flex}',
			'[data-ds-dark-theme] .cm_heroIcon{color:#5f5f63}',
			'.cm_heroTitle{color:var(--cm-text);text-align:center;letter-spacing:-.2px;margin:0;font-size:30px;font-weight:500;line-height:38px}',
			'.cm_composerWrap{flex:none;width:100%;padding:0 24px 26px;background:0 0}',
			'.cm_composerWrapDocked{background:linear-gradient(180deg,transparent,var(--cm-bg) 38%);padding-top:10px}',
			'.cm_composer{background:var(--cm-card);border:1px solid var(--cm-line);border-radius:26px;box-shadow:0 12px 32px rgba(0,0,0,.06),0 2px 6px rgba(0,0,0,.03);flex-direction:column;width:100%;max-width:980px;margin:0 auto;padding:12px 14px 10px;display:flex}',
			'[data-ds-dark-theme] .cm_composer{box-shadow:0 12px 32px rgba(0,0,0,.35)}',
			'.cm_contextRow{flex-wrap:wrap;align-items:center;gap:4px;padding:1px 2px 7px;display:flex}',
			'.cm_contextChip{color:var(--cm-text-soft);align-items:center;gap:6px;height:26px;padding:0 8px;border-radius:8px;font-size:12px;line-height:16px;display:flex}',
			'.cm_contextChip .cm_svg{color:var(--cm-text-faint)}',
			'.cm_input{color:var(--cm-text);background:0 0;border:0;outline:0;width:100%;min-height:30px;max-height:220px;padding:3px 2px 8px;font:inherit;font-size:16px;line-height:24px;resize:none}',
			'.cm_toolbar{align-items:center;gap:6px;padding-top:1px;display:flex}',
			'.cm_roundBtn{color:var(--cm-text-soft);cursor:pointer;background:0 0;border:0;border-radius:999px;flex:none;justify-content:center;align-items:center;width:34px;height:34px;padding:0;display:flex}',
			'.cm_roundBtn:hover:not(:disabled){background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_pillAction{color:var(--cm-text-soft);white-space:nowrap;cursor:pointer;background:0 0;border:1px solid var(--cm-line);border-radius:999px;align-items:center;gap:7px;height:32px;padding:0 12px;font:inherit;font-size:12.5px;line-height:18px;display:flex}',
			'.cm_pillAction:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_pillActionOn{color:var(--cm-text);background:var(--cm-hover)}',
			'.cm_effortPop{flex:none;position:relative}',
			'.cm_effortBtn{color:var(--cm-text-soft);white-space:nowrap;cursor:pointer;background:0 0;border:1px solid var(--cm-line);border-radius:999px;align-items:center;gap:5px;height:32px;padding:0 12px;font:inherit;font-size:12.5px;line-height:18px;display:flex}',
			'.cm_effortBtn:hover,.cm_effortBtnOn{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_effortCard{background:var(--cm-menu);border:1px solid var(--cm-line);border-radius:20px;box-shadow:0 22px 60px rgba(0,0,0,.18),0 4px 12px rgba(0,0,0,.06);z-index:40;width:340px;max-width:calc(100vw - 40px);padding:15px 16px 18px;position:absolute;bottom:calc(100% + 10px);right:0}',
			'.cm_effortHead{grid-template-columns:24px 1fr 24px;align-items:center;gap:4px;display:grid}',
			'.cm_effortBolt{color:var(--cm-text-faint);justify-content:flex-start;align-items:center;display:flex}',
			'.cm_effortName{color:var(--cm-purple);text-align:center;font-size:17px;font-weight:600;line-height:24px}',
			'.cm_effortReset{color:var(--cm-text-faint);cursor:pointer;background:0 0;border:0;border-radius:7px;justify-content:center;align-items:center;width:24px;height:24px;padding:0;display:flex}',
			'.cm_effortReset:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_effortModel{color:var(--cm-text-faint);justify-content:center;align-items:center;gap:2px;margin-top:3px;font-size:12px;line-height:16px;display:flex}',
			'.cm_sliderWrap{padding:16px 0 0}',
			'.cm_gradientSlider{-webkit-appearance:none;appearance:none;cursor:pointer;background:0 0;width:100%;height:24px;margin:0}',
			'.cm_gradientSlider::-webkit-slider-runnable-track{height:22px;border-radius:999px;background:radial-gradient(circle at 58% 32%,rgba(255,255,255,.95) 0 1.4px,transparent 1.9px),radial-gradient(circle at 76% 66%,rgba(255,255,255,.8) 0 1.1px,transparent 1.7px),radial-gradient(circle at 43% 68%,rgba(255,255,255,.75) 0 1.3px,transparent 1.8px),linear-gradient(90deg,#c4b5fd 0%,#a78bfa 38%,#8b5cf6 70%,#7c3aed 100%)}',
			'.cm_gradientSlider::-webkit-slider-thumb{-webkit-appearance:none;width:26px;height:26px;border-radius:999px;background:#fff;border:0;margin-top:-2px;box-shadow:0 2px 8px rgba(76,29,149,.35)}',
			'.cm_gradientSlider:focus,.cm_gradientSlider:focus-visible{outline:none}',
			'.cm_gradientSlider:hover::-webkit-slider-thumb{transform:scale(1.04)}',
			'.cm_send{width:38px;height:38px;background:var(--cm-send-bg);color:var(--cm-send-fg)}',
			'.cm_send:hover:not(:disabled){opacity:.9}',
			'.cm_send:disabled{opacity:.3}',
			'.cm_sendStop{background:var(--cm-send-bg);color:#fff}',
			'.cm_disclaimer{margin:10px 0 0;font-size:11.5px}',
			'.cm_memoryStatus{margin-bottom:8px}',
			'.cm_scroll{padding:0 28px}',
			'.cm_thread{max-width:820px;gap:24px;padding:28px 0 32px}',
			'@media (max-width:1080px){.cm_rail{width:270px}.cm_composerWrap{padding-left:18px;padding-right:18px}.cm_scroll{padding-left:18px;padding-right:18px}}',
			'@media (max-width:900px){.cm_rail{position:absolute;inset:0 auto 0 0;z-index:20;width:min(300px,86vw);box-shadow:var(--cm-shadow)}.cm_effortCard{width:min(320px,calc(100vw - 32px))}}',
			'@media (max-width:720px){.cm_heroTitle{font-size:26px;line-height:34px}.cm_contextChip{font-size:11.5px}.cm_composer{padding:10px 10px 9px}}',
			/* ── interactive workspace/account controls + animated effort fill ── */
			'.cm_root{--cm-track-empty:#fff}',
			'[data-ds-dark-theme] .cm_root{--cm-track-empty:#3a3a3a}',
			'.cm_contextChipButton{cursor:pointer;background:transparent;border:0;font:inherit}',
			'.cm_contextChipButton:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_pillDot{width:7px;height:7px;border-radius:999px;border:1.5px solid var(--cm-text-faint);flex:none;margin-left:1px}',
			'.cm_pillDotOn{background:var(--cm-purple);border-color:var(--cm-purple)}',
			'.cm_effortBolt{color:var(--cm-text-faint);cursor:pointer;background:0 0;border:0;border-radius:7px;justify-content:flex-start;align-items:center;width:24px;height:24px;padding:0;display:flex}',
			'.cm_effortBolt:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_effortBoltOn{color:var(--cm-purple)}',
			'.cm_effortModelBtn{color:var(--cm-text-faint);cursor:pointer;background:0 0;border:0;border-radius:6px;justify-content:center;align-items:center;gap:2px;margin-top:3px;padding:2px 6px;font:inherit;font-size:12px;line-height:16px;display:flex}',
			'.cm_effortModelBtn:hover{background:var(--cm-hover);color:var(--cm-text)}',
			'.cm_slider{height:26px;position:relative;--cm-fill:0%}',
			'.cm_sliderTrack{position:absolute;top:2px;left:0;right:0;height:22px;border-radius:999px;background:var(--cm-track-empty);box-shadow:inset 0 0 0 1px var(--cm-line);overflow:hidden}',
			'.cm_sliderFill{position:absolute;top:0;bottom:0;left:0;width:var(--cm-fill);border-radius:999px;background:linear-gradient(90deg,#c4b5fd,#a78bfa,#8b5cf6,#7c3aed);background-size:200% 100%;animation:cm_flow 3.2s linear infinite;box-shadow:0 0 12px rgba(124,58,237,.45);transition:width .08s linear}',
			'.cm_sliderFill::after{content:"";position:absolute;inset:0;background-image:radial-gradient(circle at 20% 40%,rgba(255,255,255,.95) 0 1.2px,transparent 1.7px),radial-gradient(circle at 65% 65%,rgba(255,255,255,.8) 0 1px,transparent 1.5px),radial-gradient(circle at 85% 30%,rgba(255,255,255,.85) 0 1.2px,transparent 1.7px);background-size:70px 100%,110px 100%,150px 100%;animation:cm_sparkle 4.5s linear infinite;opacity:.9}',
			'@keyframes cm_flow{0%{background-position:0% 50%}100%{background-position:200% 50%}}',
			'@keyframes cm_sparkle{0%{background-position:0 0,0 0,0 0}100%{background-position:140px 0,-220px 0,260px 0}}',
			'.cm_gradientSlider{position:absolute;inset:0;z-index:2;width:100%;height:26px;margin:0;background:transparent}',
			'.cm_gradientSlider::-webkit-slider-runnable-track{height:26px;background:transparent}',
			'.cm_gradientSlider::-webkit-slider-thumb{-webkit-appearance:none;width:26px;height:26px;border-radius:999px;background:#fff;border:1px solid var(--cm-line);margin-top:0;box-shadow:0 2px 8px rgba(76,29,149,.35)}',
			'.cm_gradientSlider:focus,.cm_gradientSlider:focus-visible{outline:none}',
			'.cm_workspaceWrap{position:relative}',
			'.cm_workspaceCard{position:absolute;left:0;bottom:calc(100% + 8px);z-index:40;width:230px;background:var(--cm-menu);border:1px solid var(--cm-line);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.16);padding:5px}',
			'.cm_workspaceTitle{color:var(--cm-text-faint);font-size:11px;line-height:15px;padding:7px 9px 5px}',
			'.cm_workspaceItem{color:var(--cm-text);cursor:pointer;background:0 0;border:0;border-radius:8px;align-items:center;gap:7px;width:100%;height:32px;padding:0 9px;font:inherit;font-size:13px;text-align:left;display:flex}',
			'.cm_workspaceItem:hover,.cm_workspaceItemActive{background:var(--cm-hover)}',
			'.cm_workspaceCheck{flex:none;width:12px;color:var(--cm-purple)}',
			'.cm_workspaceEmpty{color:var(--cm-text-faint);padding:8px 9px 10px;font-size:12px;line-height:17px}',
			'.cm_accountWrap{position:relative}',
			'.cm_accountBtn{cursor:pointer;background:0 0;border:0;border-radius:999px;padding:0;display:flex}',
			'.cm_accountBtn:hover{box-shadow:0 0 0 3px var(--cm-hover)}',
			'.cm_accountCard{position:absolute;left:0;bottom:calc(100% + 10px);z-index:40;width:240px;background:var(--cm-menu);border:1px solid var(--cm-line);border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.16);padding:12px}',
			'.cm_accountTitle{color:var(--cm-text);padding:2px 4px 6px;font-size:13px;font-weight:600;line-height:18px}',
			'.cm_accountMeta{color:var(--cm-text-faint);padding:0 4px 4px;font-size:11.5px;line-height:16px}',
			'.cm_accountAction{color:var(--cm-text);cursor:pointer;background:var(--cm-hover);border:0;border-radius:8px;width:100%;height:32px;margin-top:6px;font:inherit;font-size:12.5px}',
			'.cm_accountAction:hover{background:var(--cm-active)}',
		].join('');
		//#endregion


		//#region plugin body
		/**
		 * Register the two sidebar mode entries, the Chat panel, the dictionaries,
		 * and the styles.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				'chat-mode: dictionaries',
			);
			ctx.effect(() => {
				const selector = `style[data-plugin-css="${PKG}/chat-mode.css"]`;
				document.querySelector(selector)?.remove();
				const tag = document.createElement('style');
				tag.dataset.plugin = PKG;
				tag.dataset.pluginCss = `${PKG}/chat-mode.css`;
				tag.textContent = css;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, 'chat-mode: styles');
			const chat = createChat(ctx, t);
			ctx.effect(() => () => chat.dispose(), 'chat-mode: chat controller');
			ctx.slots.inject('main', () => ctx.slots.register({
				name: 'main',
				key: CHAT_PANEL_ID,
				locale: NS,
				inject: () => ({
					hooks: { chat: chat.store },
					...chat.actions,
				}),
			}, ChatPanel));
			ctx.slots.inject('sidebar.panellist', function* () {
				yield ctx.slots.register({
					name: 'sidebar.panellist',
					id: HARNESS_PANEL_ID,
					order: -20,
					label: () => t('panelHarness'),
					locale: NS,
				}, HarnessPanelIcon);
				yield ctx.slots.register({
					name: 'sidebar.panellist',
					id: CHAT_PANEL_ID,
					order: -10,
					label: () => t('panelChat'),
					locale: NS,
				}, ChatPanelIcon);
			});
		}
		//#endregion

		/** Helpers the offline check script drives directly; the page never reads them. */
		const internal = {
			extractPdfText,
			pdfDiagnostics,
			texToMathML,
			renderRich,
			decodeUploadText,
			textPlausibility,
			htmlToText,
			htmlToText,
			mathematicaToText,
			classifyFile,
			wireMessages,
			readHistory,
			writeHistory,
			storedMessage,
			titleOf,
			conversationSummaries,
			zh,
			en,
		};
		return { PKG, NS, CHAT_PANEL_ID, HARNESS_PANEL_ID, inject, apply, internal };
	},
});
