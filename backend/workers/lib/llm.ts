/**
 * Text-only Anthropic helper for the enrichment worker (Phase D/E of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
 *
 * Model resolution: MADONNAHIST_ENRICHMENT_MODEL env var, default
 * 'claude-sonnet-5'. The OCR worker's pinned 'claude-sonnet-4-6' (image
 * cleanup) stays as-is — this is a separate, text-only call path.
 *
 * @anthropic-ai/sdk v0.98.0's `Model` type union does not list
 * 'claude-sonnet-5' as a literal, but it ends in `| (string & {})`, so any
 * string typechecks and is passed through to the API verbatim — no SDK
 * bump is required for this to compile or to make the wire request. Actual
 * API-side acceptance of that model id cannot be verified from this
 * environment: ANTHROPIC_API_KEY is deliberately blanked in the Claude Code
 * Bash environment (~/.claude/CLAUDE.md), so every automated test run uses
 * MADONNAHIST_LLM_STUB=1 instead of a live call.
 *
 * Stub mode: when MADONNAHIST_LLM_STUB=1, completeJson() never touches the
 * network. It returns MADONNAHIST_LLM_STUB_JSON parsed as JSON if set, else
 * an empty-arrays canned response. completeText() likewise never touches the
 * network and returns MADONNAHIST_LLM_STUB_TEXT if set, else a deterministic
 * canned string. This is the only path exercised by scripts/test-enrichment.mjs
 * and scripts/test-narratives.mjs. Real calls need zero code changes — unset
 * the stub var and a live key resolves via getApiKey() same as ocr-worker.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './spaces.js';
import { findNarrativeModel, type NarrativeModel } from '../../../src/lib/narrative-models.js';

const DEFAULT_MODEL = 'claude-sonnet-5';

function log(msg: string) {
	console.log(`[LLM] ${msg}`);
}

let cachedClient: Anthropic | undefined;

async function getClient(): Promise<Anthropic> {
	if (cachedClient) return cachedClient;
	const apiKey = await getApiKey('anthropic', 'API_KEY', 'ANTHROPIC_API_KEY');
	cachedClient = new Anthropic({ apiKey });
	return cachedClient;
}

export function getEnrichmentModel(): string {
	return process.env.MADONNAHIST_ENRICHMENT_MODEL ?? DEFAULT_MODEL;
}

export function isStubMode(): boolean {
	return process.env.MADONNAHIST_LLM_STUB === '1';
}

function stubResponseText(): string {
	return process.env.MADONNAHIST_LLM_STUB_JSON ?? JSON.stringify({ entities: [], tags: [] });
}

function stubPlainText(): string {
	return process.env.MADONNAHIST_LLM_STUB_TEXT ?? '[stub narrative text — MADONNAHIST_LLM_STUB=1]';
}

/** Strip ```json ... ``` / ``` ... ``` fences a model may add despite instructions not to. */
function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Strict-JSON completion wrapper. `system` describes the task and the exact
 * JSON shape expected; this function appends an explicit "JSON only" rule,
 * makes the call, strips any stray code fences, and JSON.parses the result.
 * On a parse failure it retries once (a fresh call, same prompt) before
 * throwing — callers should treat a thrown error as a job failure, not
 * retry internally themselves.
 */
export async function completeJson<T = unknown>(
	system: string,
	user: string,
	maxTokens = 2048
): Promise<T> {
	if (isStubMode()) {
		const raw = stubResponseText();
		log(`STUB mode — returning canned response (${raw.length} chars)`);
		return JSON.parse(raw) as T;
	}

	const client = await getClient();
	const model = getEnrichmentModel();
	const strictSystem =
		`${system}\n\n` +
		'Output ONLY a single valid JSON value — no markdown code fences, no commentary, ' +
		'no leading or trailing text. The entire response must be parseable by JSON.parse() as-is.';

	async function attempt(): Promise<string> {
		const response = await client.messages.create({
			model,
			max_tokens: maxTokens,
			system: strictSystem,
			messages: [{ role: 'user', content: user }]
		});
		return response.content
			.filter((b): b is Anthropic.TextBlock => b.type === 'text')
			.map((b) => b.text)
			.join('\n')
			.trim();
	}

	let text = stripCodeFences(await attempt());
	try {
		return JSON.parse(text) as T;
	} catch (firstErr) {
		log(`JSON parse failed on first attempt (${(firstErr as Error).message}); retrying once`);
		text = stripCodeFences(await attempt());
		try {
			return JSON.parse(text) as T;
		} catch (secondErr) {
			throw new Error(
				`completeJson: response was not valid JSON after retry: ${(secondErr as Error).message}. Raw (truncated): ${text.slice(0, 300)}`
			);
		}
	}
}

/**
 * Plain-text completion wrapper for narrative generation (Phase E) — no JSON
 * shape enforced, no retry-on-parse-failure logic (there is nothing to
 * parse). Returns the model's text response trimmed of surrounding
 * whitespace. Callers needing a specific model id back (e.g. to record in
 * narrative_summaries.generated_by) should read getEnrichmentModel()
 * themselves; this function does not return the model id.
 */
export async function completeText(system: string, user: string, maxTokens = 2048): Promise<string> {
	if (isStubMode()) {
		const raw = stubPlainText();
		log(`STUB mode — returning canned text (${raw.length} chars)`);
		return raw;
	}

	const client = await getClient();
	const model = getEnrichmentModel();
	const response = await client.messages.create({
		model,
		max_tokens: maxTokens,
		system,
		messages: [{ role: 'user', content: user }]
	});
	return response.content
		.filter((b): b is Anthropic.TextBlock => b.type === 'text')
		.map((b) => b.text)
		.join('\n')
		.trim();
}

// ─── Year narratives: several providers (td-f1f49b) ───

export interface NarrativeCompletion {
	text: string;
	inputTokens: number | null;
	outputTokens: number | null;
}

// Thinking tokens count against max_tokens on Opus 5.5 (thinking is always
// on) and against maxOutputTokens on Gemini, so the 2048 the old
// completeText() used would cut a narrative short.
const NARRATIVE_MAX_TOKENS = 16000;
const GEMINI_MAX_OUTPUT_TOKENS = 32768;
const GEMINI_TIMEOUT_MS = 180_000;

/**
 * One year-narrative completion on whichever registered model was asked for.
 * Throws on anything other than a complete, non-empty answer (a refusal, a
 * cut-off, a blocked prompt), so the job fails visibly instead of saving a
 * partial narrative.
 *
 * Stub mode (MADONNAHIST_LLM_STUB=1): returns MADONNAHIST_LLM_STUB_TEXT with
 * "[model=<id>]" appended so tests can tell candidates apart; with
 * MADONNAHIST_LLM_STUB_ECHO=1 it also appends the full system and user
 * prompts, so tests can check what reached the model.
 */
export async function completeNarrative(opts: {
	model: string;
	system: string;
	user: string;
}): Promise<NarrativeCompletion> {
	const model = findNarrativeModel(opts.model);
	if (!model) throw new Error(`model not offered for narratives: ${JSON.stringify(opts.model)}`);

	if (isStubMode()) {
		let text = `${stubPlainText()} [model=${model.id}]`;
		if (process.env.MADONNAHIST_LLM_STUB_ECHO === '1') {
			text += `\n\n[[SYSTEM]]\n${opts.system}\n\n[[USER]]\n${opts.user}`;
		}
		log(`STUB mode — narrative via ${model.id} (${text.length} chars)`);
		return { text, inputTokens: opts.system.length + opts.user.length, outputTokens: text.length };
	}

	return model.provider === 'google'
		? completeGemini(model, opts.system, opts.user)
		: completeAnthropic(model, opts.system, opts.user);
}

async function completeAnthropic(model: NarrativeModel, system: string, user: string): Promise<NarrativeCompletion> {
	const client = await getClient();
	// Streamed so a long thinking pass can't hit the SDK's non-streaming
	// request timeout; finalMessage() gives the complete response.
	const message = await client.messages
		.stream({
			model: model.id,
			max_tokens: NARRATIVE_MAX_TOKENS,
			...(model.effort ? { output_config: { effort: model.effort } } : {}),
			system,
			messages: [{ role: 'user', content: user }]
		})
		.finalMessage();

	if (message.stop_reason !== 'end_turn') {
		const detail =
			message.stop_reason === 'refusal' && message.stop_details
				? ` (${message.stop_details.category ?? 'no category'})`
				: '';
		throw new Error(`${model.id} stopped with stop_reason=${message.stop_reason}${detail}`);
	}
	const text = message.content
		.filter((b): b is Anthropic.TextBlock => b.type === 'text')
		.map((b) => b.text)
		.join('\n')
		.trim();
	if (!text) throw new Error(`${model.id} returned no text`);
	return { text, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}

interface GeminiPart {
	text?: string;
	thought?: boolean;
}
interface GeminiResponse {
	candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
	promptFeedback?: { blockReason?: string };
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

async function completeGemini(model: NarrativeModel, system: string, user: string): Promise<NarrativeCompletion> {
	const apiKey = await getApiKey('google_gemini', 'API_KEY', 'GEMINI_API_KEY');
	// Key goes in a header, never the URL, so a failed request can't leak it
	// into PM2 logs or job_runs.last_error.
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:generateContent`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: system }] },
				contents: [{ role: 'user', parts: [{ text: user }] }],
				generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS }
			}),
			signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
		}
	);
	if (!res.ok) {
		throw new Error(`${model.id} HTTP ${res.status}${await geminiErrorCodes(res)}`);
	}
	const data = (await res.json()) as GeminiResponse;
	const cand = data.candidates?.[0];
	if (!cand) {
		throw new Error(`${model.id} returned no candidates (blockReason=${data.promptFeedback?.blockReason ?? 'none'})`);
	}
	if (cand.finishReason !== 'STOP') {
		throw new Error(`${model.id} stopped with finishReason=${cand.finishReason ?? 'missing'}`);
	}
	// Thinking models can return their reasoning as parts marked thought:true;
	// only the answer parts belong in a family narrative.
	const text = (cand.content?.parts ?? [])
		.filter((p) => typeof p.text === 'string' && !p.thought)
		.map((p) => p.text as string)
		.join('')
		.trim();
	if (!text) throw new Error(`${model.id} returned no text`);
	const u = data.usageMetadata;
	return {
		text,
		inputTokens: u?.promptTokenCount ?? null,
		// Same basis as Anthropic's output_tokens, which includes thinking.
		// Unknown (null) when Google sent neither count, not 0.
		outputTokens:
			u && (u.candidatesTokenCount != null || u.thoughtsTokenCount != null)
				? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
				: null
	};
}

/**
 * A failed Gemini call's error goes into job_runs.last_error and onto the
 * admin page, so keep only Google's machine codes (e.g. " PERMISSION_DENIED
 * API_KEY_INVALID"), never the free-text body, which can echo request details.
 */
async function geminiErrorCodes(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as {
			error?: { status?: unknown; details?: Array<{ reason?: unknown }> };
		};
		const codes = [body.error?.status, ...(body.error?.details ?? []).map((d) => d.reason)].filter(
			(c): c is string => typeof c === 'string' && /^[A-Z0-9_]{1,64}$/.test(c)
		);
		return codes.length > 0 ? ` ${codes.join(' ')}` : '';
	} catch {
		return '';
	}
}
