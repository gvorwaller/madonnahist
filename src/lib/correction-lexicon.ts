import { query } from '$lib/db';

function tokenize(text: string): string[] {
	return text
		.split(/[\s]+/)
		.map(t => t.replace(/^[^\wⒶ-ⓩ(]+|[^\wⒶ-ⓩ)]+$/g, ''))
		.filter(t => t.length > 0);
}

function charEditDistance(a: string, b: string): number {
	const al = a.toLowerCase();
	const bl = b.toLowerCase();
	const m = al.length;
	const n = bl.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = al[i - 1] === bl[j - 1]
				? dp[i - 1][j - 1]
				: 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
		}
	}
	return dp[m][n];
}

function isSimilar(a: string, b: string): boolean {
	if (a.toLowerCase() === b.toLowerCase()) return false;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen < 3) return false;
	const dist = charEditDistance(a, b);
	return dist <= Math.ceil(maxLen * 0.4);
}

function wordAlignByPosition(draft: string[], corrected: string[]): Array<[string | null, string | null]> {
	const m = draft.length;
	const n = corrected.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (draft[i - 1].toLowerCase() === corrected[j - 1].toLowerCase()) {
				dp[i][j] = dp[i - 1][j - 1];
			} else {
				dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	const aligned: Array<[string | null, string | null]> = [];
	let i = m, j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && draft[i - 1].toLowerCase() === corrected[j - 1].toLowerCase()) {
			aligned.push([draft[i - 1], corrected[j - 1]]);
			i--; j--;
		} else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
			aligned.push([draft[i - 1], corrected[j - 1]]);
			i--; j--;
		} else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
			aligned.push([null, corrected[j - 1]]);
			j--;
		} else {
			aligned.push([draft[i - 1], null]);
			i--;
		}
	}

	aligned.reverse();
	return aligned;
}

export async function populateLexicon(dayId: number, correctedText: string): Promise<number> {
	const draftRes = await query<{ draft_text: string }>(
		`SELECT ldr.draft_text
		   FROM calendar_days cd
		   JOIN llm_draft_runs ldr ON ldr.id = cd.latest_llm_draft_run_id
		  WHERE cd.id = $1`, [dayId]
	);
	if (!draftRes.rows[0] || !draftRes.rows[0].draft_text) return 0;

	const draftTokens = tokenize(draftRes.rows[0].draft_text);
	const corrTokens = tokenize(correctedText);
	if (draftTokens.length === 0 || corrTokens.length === 0) return 0;

	const aligned = wordAlignByPosition(draftTokens, corrTokens);

	let upserted = 0;
	for (const [draftTok, corrTok] of aligned) {
		if (!draftTok || !corrTok) continue;
		if (!isSimilar(draftTok, corrTok)) continue;

		await query(
			`INSERT INTO correction_lexicon (ocr_token, corrected_token, first_seen, last_seen)
			 VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE)
			 ON CONFLICT (ocr_token, corrected_token)
			 DO UPDATE SET frequency = correction_lexicon.frequency + 1,
			               last_seen = CURRENT_DATE`,
			[draftTok, corrTok]
		);
		upserted++;
	}

	return upserted;
}
