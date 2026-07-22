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
