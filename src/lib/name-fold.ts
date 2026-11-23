/**
 * Name folding shared by /admin/entities search and the duplicate matcher
 * (td-9432c1, td-c6e871). Pure, no imports.
 */

/** Lower case, accents and ligatures off: "Zoë" → "zoe", "ﬂ" → "fl". */
export function fold(s: string): string {
	return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Letters and digits only, any script: "K-Mart" → "kmart", "Pam Enoch" → "pamenoch". */
export function squash(s: string): string {
	return s.replace(/[^\p{L}\p{N}]/gu, '');
}

/** A–Z, or "#" for anything else (digits, symbols, letters like Ł or 東). Always one character. */
export function initialOf(name: string): string {
	const c = fold(name.trim()).toUpperCase().charAt(0);
	return c >= 'A' && c <= 'Z' ? c : '#';
}
