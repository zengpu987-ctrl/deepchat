import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Host half of the chat-mode bundle.
 *
 * Chat mode is a plain conversation with a DeepSeek model: no Session, no
 * tools, no agent loop. The browser cannot make that call itself — the
 * provider credential is Host-only — so this half registers one same-origin
 * route under the authenticated `/api` channel, `/api/chat-mode/stream`, which
 * validates the request, turns uploaded images into durable attachment
 * references, streams the model answer back as Server-Sent Events, and ends
 * the provider stream when the page goes away.
 *
 * The whole route is one call: the caller names a registered provider, a model,
 * an optional reasoning effort, and the conversation so far. Nothing here
 * reads Settings, a Session, or the filesystem, so the panel cannot become a
 * general proxy.
 */

/** Services this Host half needs before it activates. */
export const inject = ['llm'];
/** The exact route the Chat panel calls, under the authenticated `/api` channel. */
const STREAM_PATH = '/api/chat-mode/stream';
/** Image generation routes under the same authenticated `/api` channel. */
const IMAGE_PATH = '/api/chat-mode/image';
const IMAGE_STATUS_PATH = '/api/chat-mode/image/status';
/** The free, no-key fallback. It is opt-in/AUTO only when Harness has no image model. */
const FREE_IMAGE_ENDPOINT = 'https://image.pollinations.ai/prompt/';
/** Accepted image dimensions (the catalog's own size vocabulary). */
const IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
/** Longest prompt accepted by the image route. */
const MAX_IMAGE_PROMPT = 2000;
/** Image generation modes: a prompt prefix plus the quality given to the Harness tool. */
const IMAGE_MODES = {
	auto: { prefix: '', quality: 'medium', label: 'Auto' },
	photo: { prefix: 'Photorealistic photograph, natural light, 50mm lens, fine detail, realistic textures.', quality: 'high', label: 'Photo' },
	illustration: { prefix: 'Editorial illustration, clean shapes, harmonious palette, subtle grain, high detail.', quality: 'medium', label: 'Illustration' },
	poster: { prefix: 'Graphic poster design, bold composition, strong typographic space, high contrast, print-ready.', quality: 'high', label: 'Poster' },
	fast: { prefix: '', quality: 'low', label: 'Fast' },
	hd: { prefix: 'Highly detailed, crisp, professional, high resolution.', quality: 'high', label: 'HD' },
};
/** Image media types the attachment service accepts. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Longest accepted image, so one message cannot pin an unbounded buffer. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Longest accepted text part, matching what one chat turn may carry. */
const MAX_TEXT_CHARS = 400_000;
/** Longest accepted conversation, so a malformed caller cannot stream forever. */
const MAX_MESSAGES = 200;
/** System prompt used when the row configures none. */
const DEFAULT_SYSTEM_PROMPT =
	'You are DeepSeek, a helpful assistant. Answer the user in the language they write in, '
	+ 'use Markdown when it makes the answer clearer, and say plainly when you do not know.';

/**
 * Answer one request with a JSON failure the panel words in its own language.
 * @param status - HTTP status code.
 * @param code - stable machine code the panel switches on.
 * @param message - detail for the log and the fallback message.
 * @returns the failure response.
 */
function failure(status, code, message) {
	return Response.json({ error: { code, message } }, { status });
}

/** Read one string field, trimmed, or `undefined` when absent or not a string. */
function textField(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * Validate a caller-supplied model route.
 * @param body - decoded request body.
 * @returns the accepted route, or the failure response to return instead.
 */
function readRoute(body) {
	const provider = textField(body?.provider);
	const model = textField(body?.model);
	if (provider === undefined) return { error: failure(400, 'provider-missing', 'provider is required') };
	if (model === undefined) return { error: failure(400, 'model-missing', 'model is required') };
	const reasoningEffort = textField(body?.reasoningEffort);
	return { route: { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } } };
}

/**
 * Turn one uploaded image part into a durable attachment block, or report why
 * it cannot be used.
 * @param part - one `image` part of a user message.
 * @param attachments - the mounted attachment service.
 * @returns the image block, or an error message.
 */
async function imageBlock(part, attachments) {
	const mediaType = part.mediaType;
	if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) {
		return { error: `unsupported image media type: ${String(mediaType)}` };
	}
	if (typeof part.data !== 'string' || part.data === '') return { error: 'image part has no data' };
	if (part.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8) return { error: 'image is too large' };
	if (attachments === undefined) return { error: 'image attachments are unavailable in this profile' };
	let bytes;
	try {
		bytes = Buffer.from(part.data, 'base64');
	} catch {
		return { error: 'image data is not base64' };
	}
	if (bytes.byteLength === 0) return { error: 'image data is empty' };
	if (bytes.byteLength > MAX_IMAGE_BYTES) return { error: 'image is too large' };
	try {
		const saved = await attachments.saveImages([{
			data: bytes,
			mediaType,
			...(textField(part.name) === undefined ? {} : { name: part.name }),
		}]);
		const ref = saved[0];
		return ref === undefined ? { error: 'image was refused' } : { block: { type: 'image', attachment: ref } };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Project the caller's conversation onto request messages: text passes through,
 * base64 images become durable references, and assistant turns receive the
 * model source the adapter requires.
 * @param raw - caller-supplied messages.
 * @param route - validated provider/model route.
 * @param attachments - the mounted attachment service, when present.
 * @returns request messages, or the failure response to return instead.
 */
async function buildMessages(raw, route, attachments) {
	if (!Array.isArray(raw) || raw.length === 0) return { error: failure(400, 'messages-missing', 'messages are required') };
	if (raw.length > MAX_MESSAGES) return { error: failure(400, 'messages-too-many', 'too many messages') };
	const messages = [];
	for (const message of raw) {
		const role = message?.role;
		if (role !== 'user' && role !== 'assistant') continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		const content = [];
		let chars = 0;
		for (const part of parts) {
			if (part?.type === 'text') {
				if (typeof part.text !== 'string' || part.text === '') continue;
				chars += part.text.length;
				if (chars > MAX_TEXT_CHARS) return { error: failure(413, 'text-too-long', 'message text is too long') };
				content.push({ type: 'text', text: part.text });
				continue;
			}
			if (part?.type === 'image' && role === 'user') {
				const admitted = await imageBlock(part, attachments);
				if (admitted.error !== undefined) return { error: failure(422, 'image-rejected', admitted.error) };
				content.push(admitted.block);
			}
		}
		if (content.length === 0) continue;
		messages.push(role === 'assistant'
			? { role: 'assistant', content, source: { kind: 'model', provider: route.provider, model: route.model } }
			: { role: 'user', content });
	}
	if (messages.length === 0) return { error: failure(400, 'messages-empty', 'no usable message content') };
	return { messages };
}

/**
 * Serialize one model stream as Server-Sent Events the panel reads incrementally.
 * @param ctx - the Host plugin context.
 * @param options - validated generation request.
 * @returns the streaming response.
 */
function streamAnswer(ctx, options) {
	const encoder = new TextEncoder();
	const body = new ReadableStream({
		async start(controller) {
			/** Write one frame; a disconnected page stops the provider stream. */
			const frame = (payload) => {
				if (options.signal.aborted) return false;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
					return true;
				} catch {
					return false;
				}
			};
			try {
				for await (const chunk of ctx.llm.stream(options.request)) {
					if (chunk.type === 'text-delta' && chunk.text !== '') frame({ type: 'text', text: chunk.text });
					else if (chunk.type === 'reasoning-delta' && chunk.text !== '') frame({ type: 'reasoning', text: chunk.text });
					else if (chunk.type === 'usage') frame({ type: 'usage', usage: chunk.usage });
					else if (chunk.type === 'finish') {
						const reason = chunk.reason ?? { kind: 'stop' };
						if (reason.kind === 'error' || reason.kind === 'aborted') {
							frame({
								type: 'error',
								code: reason.failure?.code ?? reason.kind,
								message: reason.failure?.message ?? (reason.kind === 'aborted' ? 'stopped' : 'model call failed'),
								...(reason.status === undefined ? {} : { status: reason.status }),
							});
						} else {
							frame({ type: 'finish', reason: reason.kind });
						}
					}
				}
			} catch (error) {
				frame({ type: 'error', code: 'chat-mode/stream-failed', message: error instanceof Error ? error.message : String(error) });
			} finally {
				try {
					controller.close();
				} catch {
					/* the page already went away */
				}
			}
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
		},
	});
}

/**
 * Serve one chat turn.
 * @param ctx - the Host plugin context.
 * @param systemPrompt - system prompt for every turn.
 * @param request - the Fetch-shaped request from the authenticated `/api` channel.
 * @returns the SSE answer, or a JSON failure.
 */
async function serve(ctx, systemPrompt, request) {
	if (request.method !== 'POST') return failure(405, 'method', 'POST is required');
	let body;
	try {
		body = await request.json();
	} catch {
		return failure(400, 'body', 'body is not JSON');
	}
	const read = readRoute(body);
	if (read.error !== undefined) return read.error;
	const route = read.route;
	const built = await buildMessages(body.messages, route, ctx.get('attachments'));
	if (built.error !== undefined) return built.error;
	return streamAnswer(ctx, {
		signal: request.signal,
		request: {
			...route,
			messages: built.messages,
			system: systemPrompt,
			signal: request.signal,
		},
	});
}

/** Word a JSON image failure the panel can switch on. */
function imageFailure(status, code, message) {
	return Response.json({ error: { code, message } }, { status });
}

/** Normalize a caller-supplied image mode. */
function imageMode(value) {
	return typeof value === 'string' && IMAGE_MODES[value] !== undefined ? value : 'auto';
}

/** Normalize a caller-supplied image size; poster defaults to portrait. */
function imageSize(value, mode) {
	if (typeof value === 'string' && IMAGE_SIZES.has(value)) return value;
	return mode === 'poster' ? '1024x1536' : '1024x1024';
}

/** Normalize a caller-supplied image count. */
function imageCount(value) {
	const count = Number(value);
	return Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1;
}

/** Put the mode's visual direction in front of the user's own prompt. */
function imagePrompt(mode, prompt) {
	const prefix = IMAGE_MODES[mode]?.prefix ?? '';
	return prefix === '' ? prompt : `${prefix} ${prompt}`;
}

/** The workspace root the image tool and free fallback write into. */
function imageWorkspace(ctx) {
	const workingDirectory = ctx.get('workingDirectory');
	const configured = typeof workingDirectory?.defaultDirectory === 'string' ? workingDirectory.defaultDirectory.trim() : '';
	return configured === '' ? process.cwd() : configured;
}

/** Sniff a generated file's media type from its first bytes. */
function sniffImageMediaType(bytes) {
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.length > 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
	if (bytes.length > 6 && bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
	return 'image/png';
}

/** Read one generated file back as a browser-safe data URL. */
async function imageFromFile(cwd, relativePath) {
	const absolute = resolve(cwd, relativePath);
	const bytes = await readFile(absolute);
	const mediaType = sniffImageMediaType(bytes);
	return {
		path: relativePath,
		mediaType,
		bytes: bytes.byteLength,
		dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
	};
}

/** Read the CLI/plugin mirror to decide whether Harness image generation is configured. */
function imageStatusOf(ctx) {
	let harnessConfigured = false;
	let harnessAvailable = false;
	try {
		const tools = ctx.get('tools');
		harnessAvailable = tools?.get('image_generate') !== undefined;
	} catch {
		harnessAvailable = false;
	}
	try {
		const path = join(homedir(), '.dsh', 'gen-image.config.json');
		const config = JSON.parse(readFileSync(path, 'utf8'));
		const providers = Array.isArray(config?.providers) ? config.providers : [];
		const selected = typeof config?.selection?.modelId === 'string' ? config.selection.modelId.trim() : '';
		harnessConfigured = harnessAvailable && providers.length > 0 && selected !== '';
	} catch {
		harnessConfigured = false;
	}
	return {
		hostRoute: true,
		harnessAvailable,
		harnessConfigured,
		defaultEngine: harnessConfigured ? 'harness' : 'free',
		free: { available: true, provider: 'pollinations.ai', requiresNetwork: true },
	};
}

/** Serve the image-generation capability/status card. */
async function serveImageStatus(ctx, request) {
	if (request.method !== 'POST') return imageFailure(405, 'method', 'POST is required');
	return Response.json(imageStatusOf(ctx));
}

/** Generate through the already-registered `image_generate` tool, without the agent loop. */
async function generateWithHarness(ctx, prompt, mode, size, signal, cwd) {
	const definition = ctx.get('tools')?.get('image_generate');
	if (definition === undefined) throw new Error('image_generate is not available; install dsh-media-gen first');
	const args = { prompt: imagePrompt(mode, prompt), size, quality: IMAGE_MODES[mode]?.quality ?? 'medium' };
	const toolSignal = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : signal;
	const value = await definition.execute(args, {
		callId: randomUUID(),
		name: 'image_generate',
		arguments: args,
		agent: { id: 'chat-mode-image', session: { header: { cwd } } },
		signal: toolSignal,
		deferContext() {},
		concludeTurn() {},
	});
	const paths = Array.isArray(value?.paths) ? value.paths.filter((item) => typeof item === 'string' && item !== '') : [];
	if (paths.length === 0) throw new Error('image_generate returned no saved image path');
	const images = [];
	for (const path of paths) images.push(await imageFromFile(cwd, path));
	return { images, provider: value?.provider, model: value?.model, paths };
}

/** Generate through the no-key Pollinations fallback and save bytes locally when possible. */
async function generateWithFree(prompt, mode, size, count, signal, cwd) {
	const [width, height] = size.split('x').map((value) => Number(value));
	const model = mode === 'fast' ? 'turbo' : 'flux';
	const images = [];
	const paths = [];
	for (let index = 0; index < count; index += 1) {
		const seed = Math.floor(Math.random() * 1_000_000_000);
		const url = `${FREE_IMAGE_ENDPOINT}${encodeURIComponent(imagePrompt(mode, prompt))}?width=${width}&height=${height}&nologo=true&seed=${seed}&model=${model}`;
		const timeout = AbortSignal.timeout(180_000);
		const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
		const response = await fetch(url, { signal: combined, headers: { accept: 'image/*' } });
		if (!response.ok) throw new Error(`free image service answered HTTP ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength === 0) throw new Error('free image service returned an empty image');
		if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('free image is larger than 20 MB');
		const mediaType = sniffImageMediaType(bytes);
		let savedPath;
		try {
			const directory = join(cwd, 'generate', 'image');
			await mkdir(directory, { recursive: true });
			const name = `image-free-${new Date().toISOString().replace(/[:.]/g, '-')}-${index}.${mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'}`;
			await writeFile(join(directory, name), bytes);
			savedPath = join('generate', 'image', name);
			paths.push(savedPath);
		} catch {
			savedPath = undefined;
		}
		images.push({
			...(savedPath === undefined ? {} : { path: savedPath }),
			mediaType,
			bytes: bytes.byteLength,
			dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
		});
	}
	return { images, provider: 'pollinations.ai', model, paths };
}

/** Serve one text-to-image request. */
async function serveImage(ctx, request) {
	if (request.method !== 'POST') return imageFailure(405, 'method', 'POST is required');
	let body;
	try {
		body = await request.json();
	} catch {
		return imageFailure(400, 'body', 'body is not JSON');
	}
	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	if (prompt === '') return imageFailure(400, 'prompt', 'prompt is required');
	if (prompt.length > MAX_IMAGE_PROMPT) return imageFailure(400, 'prompt-too-long', `prompt is longer than ${MAX_IMAGE_PROMPT} characters`);
	const mode = imageMode(body?.mode);
	const size = imageSize(body?.size, mode);
	const count = imageCount(body?.count);
	const requestedEngine = body?.engine === 'harness' || body?.engine === 'free' ? body.engine : 'auto';
	const status = imageStatusOf(ctx);
	const engine = requestedEngine === 'auto' ? status.defaultEngine : requestedEngine;
	const cwd = imageWorkspace(ctx);
	const started = Date.now();
	try {
		if (engine === 'harness') {
			const images = [];
			const paths = [];
			let provider;
			let model;
			for (let index = 0; index < count; index += 1) {
				const generated = await generateWithHarness(ctx, prompt, mode, size, request.signal, cwd);
				provider = generated.provider ?? provider;
				model = generated.model ?? model;
				images.push(...generated.images);
				paths.push(...generated.paths);
			}
			return Response.json({
				ok: true, engine: 'harness', mode, size, count, prompt: imagePrompt(mode, prompt),
				provider, model, paths, images, elapsedMs: Date.now() - started,
			});
		}
		const generated = await generateWithFree(prompt, mode, size, count, request.signal, cwd);
		return Response.json({
			ok: true, engine: 'free', mode, size, count, prompt: imagePrompt(mode, prompt),
			provider: generated.provider, model: generated.model, paths: generated.paths,
			images: generated.images, elapsedMs: Date.now() - started,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = /尚未选择生图模型|not configured|no provider|no model|not available/i.test(message)
			? 'image-not-configured' : 'image-failed';
		return imageFailure(code === 'image-not-configured' ? 409 : 502, code, message);
	}
}

/**
 * Register the Chat panel's streaming route.
 * @param ctx - the Host plugin context.
 * @param config - the Loader row's configuration.
 */
export function apply(ctx, config) {
	const configured = typeof config?.systemPrompt === 'string' ? config.systemPrompt.trim() : '';
	const systemPrompt = configured === '' ? DEFAULT_SYSTEM_PROMPT : configured;
	ctx.inject(['connection'], (connectionCtx) => {
		connectionCtx.effect(
			() => connectionCtx.connection.fetch.register({
				path: STREAM_PATH,
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: (request) => serve(connectionCtx, systemPrompt, request),
			}),
			'chat-mode: stream route',
		);
		connectionCtx.effect(
			() => connectionCtx.connection.fetch.register({
				path: IMAGE_STATUS_PATH,
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: (request) => serveImageStatus(connectionCtx, request),
			}),
			'chat-mode: image status route',
		);
		connectionCtx.effect(
			() => connectionCtx.connection.fetch.register({
				path: IMAGE_PATH,
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: (request) => serveImage(connectionCtx, request),
			}),
			'chat-mode: image route',
		);
	});
}
