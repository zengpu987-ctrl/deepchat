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
	});
}
