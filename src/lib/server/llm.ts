/**
 * App-side text-completion helper for Phase G ("Ask the archive" ad hoc
 * narrative queries — docs/2026-07-21-next-phases-search-viewer-narrative-plan.md,
 * td-84c7fa).
 *
 * Deliberately NOT a re-export of backend/workers/lib/llm.ts: that module
 * (and backend/workers/lib/spaces.ts's getApiKey, which it calls) reads
 * through the WORKER's own db pool (backend/workers/lib/db.ts), which the
 * SvelteKit app cannot import — different pool, different lifecycle, and
 * pulling worker code into the app bundle is exactly the kind of coupling
 * cs.md warns against. This is a small, app-only mirror of just the piece
 * Phase G needs synchronously from a request handler: completeText().
 * completeJson() is not needed — /admin/ask has no structured-output use.
 *
 * Credential resolution mirrors src/lib/ingest/spaces-upload.ts's pattern
 * for DO Spaces: private_data.api_credentials via credentialService (the
 * APP db pool, $lib/db — see src/lib/credentials.ts), not
 * backend/workers/lib/spaces.ts's getApiKey (worker pool). ANTHROPIC_API_KEY
 * env var is a fallback, same credential/key names and precedence as the
 * worker's getApiKey('anthropic', 'API_KEY', 'ANTHROPIC_API_KEY') — checked
 * against backend/workers/lib/llm.ts before writing this file.
 *
 * Model resolution: MADONNAHIST_ENRICHMENT_MODEL env var, default
 * 'claude-sonnet-5' — same env var name and default as
 * backend/workers/lib/llm.ts's getEnrichmentModel(), since both paths
 * should use the same model choice unless an operator deliberately splits
 * them.
 *
 * Stub mode: MADONNAHIST_LLM_STUB=1 short-circuits before any network call
 * and returns MADONNAHIST_LLM_STUB_TEXT (or a fixed deterministic string) —
 * every automated test runs stubbed, since ANTHROPIC_API_KEY is
 * deliberately blanked in the Claude Code Bash environment (see
 * ~/.claude/CLAUDE.md). Because this module runs inside the long-lived
 * dev/prod server process (not a spawned worker child process like
 * scripts/test-narratives.mjs uses), the stub env vars must be set BEFORE
 * the server process starts — there is no per-request override available.
 * scripts/test-ask.mjs documents this requirement in its header.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import { credentialService } from '$lib/credentials';

const DEFAULT_MODEL = 'claude-sonnet-5';

let cachedClient: Anthropic | undefined;

function log(msg: string) {
	console.log(`[ASK-LLM] ${msg}`);
}

export function isStubMode(): boolean {
	return env.MADONNAHIST_LLM_STUB === '1';
}

function stubPlainText(): string {
	return env.MADONNAHIST_LLM_STUB_TEXT ?? '[stub narrative text — MADONNAHIST_LLM_STUB=1]';
}

export function getAskModel(): string {
	return env.MADONNAHIST_ENRICHMENT_MODEL ?? DEFAULT_MODEL;
}

async function getClient(): Promise<Anthropic> {
	if (cachedClient) return cachedClient;

	// credentialService.getCredential() returns null (not a thrown error) when
	// the row is absent — different failure shape than the worker's
	// getApiKey(), which throws and catches internally, but the same
	// DB-first / env-fallback precedence.
	const dbKey = await credentialService.getCredential('anthropic', 'API_KEY');
	const apiKey = dbKey ?? env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error(
			'Missing credential: anthropic/API_KEY not in private_data.api_credentials and ANTHROPIC_API_KEY not set'
		);
	}
	cachedClient = new Anthropic({ apiKey });
	return cachedClient;
}

/**
 * Plain-text completion — no JSON shape enforced, no retry-on-parse-failure
 * logic (mirrors backend/workers/lib/llm.ts's completeText, minus the
 * worker-specific model-id commentary). Used synchronously by the
 * /admin/ask `ask` action; callers should expect this to take several
 * seconds to tens of seconds for a real (non-stub) call — see the timeout
 * caution in src/routes/admin/ask/+page.server.ts.
 */
export async function completeText(system: string, user: string, maxTokens = 2048): Promise<string> {
	if (isStubMode()) {
		const raw = stubPlainText();
		log(`STUB mode — returning canned text (${raw.length} chars)`);
		return raw;
	}

	const client = await getClient();
	const model = getAskModel();
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
