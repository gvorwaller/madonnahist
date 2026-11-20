/**
 * Models offered for year narratives (td-f1f49b,
 * docs/2026-11-20-narrative-models-guidance-plan.md).
 *
 * Pure data with no imports, so both the SvelteKit app (to validate what the
 * admin asked for) and the enrichment worker (to know how to call it) can
 * import it; the worker reaches it by relative path, as it already does for
 * src/lib/server/tags.ts.
 *
 * Changing a model id here is a code change plus deploy, on purpose: model
 * choice for family-visible writing shouldn't drift with an env var.
 */

export type NarrativeProvider = 'anthropic' | 'google';
export type NarrativeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface NarrativeModel {
	id: string;
	label: string;
	provider: NarrativeProvider;
	/** Anthropic only. Opus 5.5 defaults to 'medium', so it is set explicitly. */
	effort?: NarrativeEffort;
}

export const NARRATIVE_MODELS: readonly NarrativeModel[] = [
	{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', effort: 'high' },
	// Gemini 3.1 Pro (preview id per Google's Gemini 3 developer guide, Nov
	// 2026). Confirm with GET /v1beta/models when the key is set up.
	{ id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google' }
];

export const DEFAULT_NARRATIVE_MODEL = 'claude-opus-5-5';

export type NarrativeMode = 'fresh' | 'revise';

export function isNarrativeMode(s: unknown): s is NarrativeMode {
	return s === 'fresh' || s === 'revise';
}

export function findNarrativeModel(id: unknown): NarrativeModel | null {
	return NARRATIVE_MODELS.find((m) => m.id === id) ?? null;
}

/** model_name of a draft saved from the admin's own edit (provider 'human'). */
export const HAND_EDIT_MODEL_NAME = 'hand-edit';

/** Display label for a stored model name; older names fall through as-is. */
export function narrativeModelLabel(id: string): string {
	if (id === HAND_EDIT_MODEL_NAME) return 'Edited by hand';
	return findNarrativeModel(id)?.label ?? id;
}

/** Cap for both the house style and a year's notes. */
export const MAX_GUIDANCE_LENGTH = 6000;

/**
 * Cap for a year's narrative text: a hand edit can't exceed it, and a
 * revision's base text (the current text) is checked against it both when
 * queued and by the worker. A narrative is a few thousand characters.
 */
export const MAX_NARRATIVE_LENGTH = 50_000;

/** Normalize line endings and outer whitespace; callers enforce the cap. */
export function cleanGuidance(raw: string): string {
	return raw.replace(/\r\n?/g, '\n').trim();
}
