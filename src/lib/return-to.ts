/**
 * "Back to …" for a day opened from somewhere else (td-8a7e37).
 *
 * Find duplicates links each entry date to /correct/day/<date>?back=<where>,
 * so after fixing the day Gaylon can go straight back to the group he was
 * on. The correction page keeps `back` through Save, Skip, Flag and
 * Prev/Next, and shows it as a link.
 *
 * Only known pages are accepted (never an arbitrary URL), so the parameter
 * can't send anyone off-site.
 */

export interface BackLink {
	href: string;
	label: string;
}

const PAGES: { re: RegExp; label: string }[] = [
	{ re: /^\/admin\/entities\/cleanup(?:\?type=(?:person|place|event))?(?:#g-\d{1,12})?$/, label: 'Find duplicates' }
];

export function parseBack(raw: string | null | undefined): BackLink | null {
	if (!raw || raw.length > 200) return null;
	const page = PAGES.find((p) => p.re.test(raw));
	return page ? { href: raw, label: page.label } : null;
}

/** `path` with ?back=… (or &back=…) added when there is somewhere to go back to. */
export function withBack(path: string, back: BackLink | string | null | undefined): string {
	const href = typeof back === 'string' ? parseBack(back)?.href : back?.href;
	if (!href) return path;
	return `${path}${path.includes('?') ? '&' : '?'}back=${encodeURIComponent(href)}`;
}
