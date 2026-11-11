/**
 * Back-navigation memory for the family viewer (V3 Slice 1, plan
 * docs/2026-11-05-family-viewer-v3-redesign-plan.md, CODEX #10).
 *
 * Pages that link deeper append `?from=<encoded /app path + query>` so the
 * next page's Back link returns to where the reader actually was (a search
 * with its query, a person page, a month), not always to Today.
 *
 * `backTarget()` is the single validator: only same-site `/app` paths are
 * accepted. Anything else — absolute URLs, protocol-relative `//host`,
 * backslashes (some browsers treat `/\host` as `//host`), control
 * characters, or a non-/app path — falls back to the given default.
 */

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

const MAX_FROM_LENGTH = 1000;

export function backTarget(from: string | null | undefined, fallback = '/app'): string {
	if (!from || from.length > MAX_FROM_LENGTH) return fallback;
	if (from.includes('\\') || from.startsWith('//')) return fallback;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(from)) return fallback;
	if (!/^\/app(\/|\?|$)/.test(from)) return fallback;
	return from;
}

/** `href` plus `?from=<from>` (or `&from=` when href already has a query). */
export function withFrom(href: string, from: string): string {
	const sep = href.includes('?') ? '&' : '?';
	return `${href}${sep}from=${encodeURIComponent(from)}`;
}

/** Current page as a `from` value: path plus query, so search results survive. */
export function currentFrom(url: URL): string {
	const params = new URLSearchParams(url.search);
	// Never nest from= inside from= (it would grow on every hop).
	params.delete('from');
	const qs = params.toString();
	return url.pathname + (qs ? `?${qs}` : '');
}

function monthName(m: number): string | null {
	return m >= 1 && m <= 12 ? MONTHS[m - 1] : null;
}

/** Human label for a validated back target, e.g. "March 1976" or "Search results". */
export function backLabel(href: string): string {
	const path = href.split('?')[0];
	let m: RegExpExecArray | null;

	if ((m = /^\/app\/day\/(\d{4})-(\d{2})-(\d{2})$/.exec(path))) {
		const name = monthName(Number(m[2]));
		return name ? `${name} ${Number(m[3])}, ${m[1]}` : 'Back';
	}
	if ((m = /^\/app\/month\/(\d{4})-(\d{2})$/.exec(path))) {
		const name = monthName(Number(m[2]));
		return name ? `${name} ${m[1]}` : 'The month';
	}
	if ((m = /^\/app\/year\/(\d{4})$/.exec(path))) return m[1];
	if (path.startsWith('/app/book/')) return 'The book';
	if (path === '/app/browse' || path === '/app/timeline') return 'Timeline';
	if (path === '/app/search') return 'Search results';
	if (path === '/app/people') return 'People';
	if (path === '/app/places') return 'Places';
	if (path === '/app/stories') return 'Stories';
	if (path.startsWith('/app/stories/')) return 'The story';
	if (path.startsWith('/app/person/') || path.startsWith('/app/place/')) return 'Back';
	if (path === '/app') return 'On this day';
	return 'Back';
}

export { MONTHS };
