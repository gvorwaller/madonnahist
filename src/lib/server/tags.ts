/**
 * Shared helpers for `day_tags` slugs — used by the correction editor's
 * addTag/removeTag actions (`src/routes/correct/day/[date]/+page.server.ts`)
 * and by the /app/search tag-filter query-param parsing. See
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md, Phase C.
 */

export const MAX_TAG_LABEL_LENGTH = 40;

/** lowercase, non-alphanumeric runs collapsed to a single hyphen, trimmed. */
export function slugifyTagLabel(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Validate a label before slugifying: non-empty, <= 40 chars once trimmed. */
export function isValidTagLabel(label: string): boolean {
	const trimmed = label.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_TAG_LABEL_LENGTH;
}

/** Validate a slug read back from a query param (e.g. /app/search?tag=). */
export function isValidTagSlug(slug: string): boolean {
	return slug.length > 0 && slug.length <= MAX_TAG_LABEL_LENGTH && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}
